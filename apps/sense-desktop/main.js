const { app, BrowserWindow } = require("electron");
const fs = require('fs');
const path = require('path');
const { ipcMain, dialog } = require("electron");


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

/**
 * ChunkedDataWriter class
 * Automatically writes buffered samples to disk after reaching a chunk size.
 * Usage: create an instance, call addSample() for each new sample.
 */
class ChunkedDataWriter {
  deleteEmptyChunks() {
    const files = fs.readdirSync(this.outputDir);
    files.forEach(file => {
      if (file.startsWith(this.baseFilename + '_chunk') && file.endsWith('.json')) {
        const filePath = path.join(this.outputDir, file);
        const stats = fs.statSync(filePath);
        if (stats.size <= 3) {
          fs.unlinkSync(filePath);
          if (process.env.BUFFER_MANAGER_LOGS === '1') {
            console.log(`[electron] Deleted empty chunk file: ${filePath}`);
          }
        }
      }
    });
  }

  constructor(options) {
    this.chunkSize = options.chunkSize || 10000;
    this.outputDir = options.outputDir || path.join(__dirname, 'data');
    this.baseFilename = options.baseFilename || 'samples';

    this.buffer = [];
    this.chunkIndex = 0;

    // New: track the maximum flush size ever reached
    this.maxChunkSizeReached = 0;

    // Track whether current JSON file already has content
    this.currentChunkHasData = false;

    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }

    this.currentStream = this._createChunkStream();
    
    if (process.env.BUFFER_MANAGER_LOGS === '1') {
      console.log(`ChunkedDataWriter initialized. Chunk size: ${this.chunkSize}`);
    }
  }

  _createChunkStream() {
    const filename = path.join(
      this.outputDir,
      `${this.baseFilename}_chunk${this.chunkIndex}.json`
    );

    if (process.env.BUFFER_MANAGER_LOGS === '1') {
      console.log(
        `[electron : ${new Date().toISOString()}] [CREATE CHUNK FILE] Creating chunk file: ${filename}`
      );
    }

    const stream = fs.createWriteStream(filename, { flags: 'w' });
    stream.write('[\n');
    return stream;
  }

  _writeSamplesToCurrentChunk(samples) {
    for (const sample of samples) {
      if (this.currentChunkHasData) {
        this.currentStream.write(',\n');
      }
      this.currentStream.write(JSON.stringify(sample, null, 2));
      this.currentChunkHasData = true;
    }
  }

  _closeCurrentChunk() {
    if (this.currentStream) {
      this.currentStream.write('\n]');
      this.currentStream.end();
    }
  }

  _openNextChunk() {
    this.chunkIndex++;
    this.currentStream = this._createChunkStream();
    this.currentChunkHasData = false;
  }

  addSample(sample) {
    this.buffer.push(sample);

    if (this.buffer.length >= this.chunkSize) {
      this.flush(false);
    }
  }

  flush(finalize = false) {
    if (this.buffer.length === 0) {
      if (finalize && this.currentStream) {
        this._closeCurrentChunk();
      }
      return;
    }

    const flushSize = this.buffer.length;

    // New maximum reached
    if (flushSize > this.maxChunkSizeReached) {
      this.maxChunkSizeReached = flushSize;
    }

    if (process.env.BUFFER_MANAGER_LOGS === '1') {
      console.log(`[electron] Flushing ${flushSize} samples. maxChunkSizeReached=${this.maxChunkSizeReached}, finalize=${finalize}`);
    }

    // Always write current buffer into the current chunk first
    this._writeSamplesToCurrentChunk(this.buffer);
    this.buffer = [];

    // Only rotate chunk if buffer reached the known maximum chunk size
    // or if this is the final flush at session end
    if (flushSize >= this.maxChunkSizeReached) {
      this._closeCurrentChunk();

      if (!finalize) {
        this._openNextChunk();
      }
    } else if (finalize) {
      this._closeCurrentChunk();
    }
  }
}

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
  ipcMain.on('new-sample', (_event, sample) => {
    try {
        const test = JSON.stringify(sample);
        if (typeof sampleWriter !== 'undefined') {
            sampleWriter.addSample(sample);
        } else {
            console.error('[main] sampleWriter is undefined!');
        }
    } catch (err) {
        console.error('[main] Sample not serializable:', err, sample);
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
ipcMain.handle('get-buffer-size', () => {
  return sampleWriter.chunkSize;
});
// Create a new subfolder named by recording start time (ISO string)
let sampleWriter = undefined;

ipcMain.on('start-acquisition', (_event, startTime) => {
  const sessionFolder = path.join(__dirname, 'data', startTime.replace(/[:.]/g, '-'));
  let chunkSize = 10000;
  sampleWriter = new ChunkedDataWriter({
    chunkSize,
    outputDir: sessionFolder,
    baseFilename: 'samples'
  });
  if (process.env.BUFFER_MANAGER_LOGS === '1') {
    console.log(`[electron] Acquisition started. Folder: ${sessionFolder}`);
  }
});

// Listen for buffer size updates from renderer
ipcMain.on('set-buffer-size', (_event, newSize) => {
  if (typeof sampleWriter !== 'undefined' && sampleWriter) {
    if (typeof newSize === 'number' && newSize > 0) {
      sampleWriter.chunkSize = newSize;
      if (process.env.BUFFER_MANAGER_LOGS === '1') {
        console.log(`[electron] Buffer size updated to: ${newSize}`);
      }
    }
  } else {
    console.warn('[electron] Tried to set buffer size before acquisition started.');
  }
});

// Listen for flush command from renderer (session end)
ipcMain.on('flush-samples', (_event, finalize) => {
  console.log(`[electron] Flush command received. finalize=${finalize}`);
  if (sampleWriter) {
    sampleWriter.flush(finalize);
  }
});

// Example: Add a sample (replace with your actual sample acquisition logic)
// This should be called whenever you acquire a new sample from the device
function onNewSample(sample) {
    sampleWriter.addSample(sample);
}

// Example: Flush remaining samples on app exit
app.on('before-quit', () => {
  if (sampleWriter) {
    sampleWriter.flush(true);
    sampleWriter.deleteEmptyChunks();
  }
});