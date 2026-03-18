const { app, BrowserWindow } = require("electron");
const fs = require('fs');
const path = require('path');
const { ipcMain, dialog } = require("electron");

// Use external ChunkedDataWriter module
const ChunkedDataWriter = require('./src/ChunkedDataWriter');

// serial/USB only; BLE experimental code was removed to simplify the
// desktop build.  Port enumeration is handled via the native bridge.

// Helps with common Windows GPU/renderer launch issues
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("disable-features", "OutOfBlinkCors");
// Required for Web Serial / Web Bluetooth APIs inside Electron
app.commandLine.appendSwitch("enable-experimental-web-platform-features");

console.log(`FRAME_TIMING_LOGS: ${process.env.FRAME_TIMING_LOGS}`);
console.log(`BUFFER_MANAGER_LOGS: ${process.env.BUFFER_MANAGER_LOGS}`);

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: true,
      // If sandbox initialization is the problem, this avoids it
      sandbox: false,
      // enable experimental APIs like Web Serial / Web Bluetooth
      experimentalFeatures: true,
      // you can also explicitly enable blink features if needed
      // enableBlinkFeatures: "Serial,WebBluetooth",
      // preload script exposes serial helpers
      preload: require("path").join(__dirname, "preload.js"),
    },
  });

  win.webContents.openDevTools({ mode: "detach" });

  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error("did-fail-load", { code, desc, url });
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error("render-process-gone", details);
  });
  win.webContents.on("console-message", (_e, _level, message) => {
    console.log("[renderer]", message);
  });

  const url = process.env.SENSE_WEB_URL || "http://127.0.0.1:3000";
  win.loadURL(url);

  win.once("ready-to-show", () => win.show());
}

app.whenReady().then(() => {
  const { session } = require("electron");

  // allow web contents to request serial (and bluetooth if ever used)
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === "serial" || permission === "bluetooth") return callback(true);
    callback(false);
  });

  // show a simple chooser dialog for ports
  ipcMain.handle("show-port-dialog", async (_event, buttons) => {
    const { response } = await dialog.showMessageBox({
      type: "question",
      message: "Select a connection (Bluetooth/serial)",
      buttons,
      cancelId: -1
    });
    return response;
  });

  // Listen for new samples from renderer process
  // IPC handler for chunk writing
  ipcMain.on('write-chunk', (_event, chunk) => {
    if (sampleWriter) {
      const start = Date.now();
      sampleWriter.writeChunk(chunk);
      const saveTime = Date.now() - start;
      // Send saveTime back to renderer
      _event.sender.send('chunk-write-complete', saveTime);
    } else {
      console.error('[main] sampleWriter is undefined!');
    }
  });

  function parseBlePayload(buf) {
    // BLE notifications deliver raw bytes from the device. the
    // ScientISST hardware uses exactly the same framing protocol whether
    // we read it over serial or BLE, so the application-side code already
    // knows how to make sense of these bytes. the existing
    // `ScientISSTFrameReader` (see packages/sense-api/src/future/readers)
    // implements the parser used by sense-web-v2.
    //
    // here we simply timestamp and forward the unmodified byte stream
    // to the renderer, leaving interpretation to whatever transport or
    // frame reader the UI chooses to use.
    return { ts: Date.now(), bytes: [...buf] };
  }

  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Example: Instantiate ChunkedDataWriter in Electron main process
// IPC handler to get current buffer size
// Create a new subfolder named by recording start time (ISO string)
let sampleWriter = undefined;
let segmentNumber = 1;
let sessionFolder = undefined;

ipcMain.on('start-acquisition', (_event, startTime) => {
  // Only create session folder if not already set (first acquisition)
  if (!sessionFolder) {
    sessionFolder = path.join(__dirname, 'data', startTime.replace(/[:.]/g, '-'));
    segmentNumber = 1;
  } else {
    // On resume, finalize previous writer before incrementing segmentNumber
    if (sampleWriter) {
      sampleWriter.finalizeChunk();
    }
    segmentNumber++;
  }
  let chunkSize = 10000;
  sampleWriter = new ChunkedDataWriter({
    chunkSize,
    outputDir: sessionFolder,
    baseFilename: `sample${segmentNumber}`
  });
  if (process.env.BUFFER_MANAGER_LOGS === '1') {
    console.log(`[electron] Acquisition started. Folder: ${sessionFolder}, baseFilename: sample${segmentNumber}`);
  }
});

// Listen for buffer size updates from renderer
ipcMain.on('set-buffer-size', (_event, size) => {
  if (sampleWriter && typeof size === 'number') {
    sampleWriter.chunkSize = size;
    if (process.env.BUFFER_MANAGER_LOGS === '1') {
      console.log(`[electron] Updated chunk size: ${size}`);
    }
  }
});

// Listen for session finalization from renderer
ipcMain.on('finalize-session', () => {
  if (sampleWriter) {
    sampleWriter.finalizeSession();
    segmentNumber++;
    // Reset sessionFolder for next acquisition
    sessionFolder = undefined;
  }
});

// Example: Add a sample (replace with your actual sample acquisition logic)
// This should be called whenever you acquire a new sample from the device
// Remove onNewSample and any frame-by-frame batching logic

// Example: Flush remaining samples on app exit
app.on('before-quit', () => {
  if (sampleWriter) {
    sampleWriter.finalizeSession();
  }
});