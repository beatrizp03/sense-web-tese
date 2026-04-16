const { app, BrowserWindow } = require("electron");
const fs = require('fs');
const path = require('path');
const { ipcMain, dialog } = require("electron");

// Use external modules
const ChunkedDataWriter = require('./src/ChunkedDataWriter');
const { BufferManager } = require('./dist/BufferManager.js');
const { onChunkReady } = require('./dist/StorageSubscriber.js');
// SessionManager for manifest/session logic
const { SessionManager } = require('./src/SessionManager.js');

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
      // CRITICAL: Prevent Chromium from throttling timers/storage when window is backgrounded
      backgroundThrottling: false,
    },
  });

  // Intercept window close to warn if acquisition is running
  win.on('close', (e) => {
    if (sessionFolder && sampleWriter) {
      e.preventDefault();
      win.webContents.send('show-close-warning');
    }
  });
  //win.webContents.openDevTools({ mode: "detach" });

  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error("did-fail-load", { code, desc, url });
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error("render-process-gone", details);
  });
  win.webContents.on("console-message", (event) => {
    // Electron >= v24: event is WebContentsConsoleMessageEventParams
    // https://www.electronjs.org/docs/latest/breaking-changes/#webcontentsconsole-message-event
    console.log("[renderer]", event.message);
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

  // IPC handler to flush BufferManager chunk (e.g., on pause/stop)
  ipcMain.on('flush-chunk', (_event, { final }) => {
    if (bufferManager && typeof bufferManager.flushChunk === 'function') {
      bufferManager.flushChunk(!!final);
    }
  });

  // IPC handler to read a chunk file by path (from renderer)
  ipcMain.handle('read-chunk-file', async (_event, filePath) => {
    try {
      // If filePath is not absolute, resolve relative to session folder
      let absPath = filePath;
      if (!path.isAbsolute(filePath)) {
        const folder = sessionFolder || lastSessionFolder;
        absPath = path.join(folder, filePath);
      }
      const data = fs.readFileSync(absPath, 'utf-8');
      return JSON.parse(data);
    } catch (e) {
      console.error('[read-chunk-file] Failed to read chunk file:', filePath, e);
      return null;
    }
  });

  ipcMain.on('confirm-close', (event, shouldClose) => {
    if (shouldClose) {
      console.log('[main] User confirmed close. Finalizing session and exiting.');  
      if (sampleWriter) sampleWriter.finalizeSession();
      sessionFolder = undefined;
      BrowserWindow.getAllWindows().forEach(win => win.destroy());
    }
  });

  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// BufferManager/StorageSubscriber for main-process acquisition
let bufferManager = null;
let segmentNumber = 1;
let sessionFolder = undefined;
let lastSessionFolder = undefined;
let sampleWriter = undefined;

ipcMain.handle('start-acquisition', async (_event, startTime) => {
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
  lastSessionFolder = sessionFolder;
  let chunkSize = 10000;
  sampleWriter = new ChunkedDataWriter({
    chunkSize,
    outputDir: sessionFolder,
    baseFilename: `sample${segmentNumber}`
  });
  // Instantiate BufferManager for this session
  bufferManager = new BufferManager({ chunkSize });
  // Subscribe StorageSubscriber to BufferManager for chunk writing
  bufferManager.subscribeStorage(chunk => {
    onChunkReady(chunk, (chunkToWrite) => {
      const start = Date.now();
      const chunkIndex = sampleWriter.chunkIndex || 0;
      const segment = segmentNumber;
      const final = !!chunkToWrite.final;
      try {
        sampleWriter.writeChunk(chunkToWrite, (filename) => {
          // Now guaranteed the file is flushed and closed
          if (filename && fs.existsSync(filename)) {
            SessionManager.appendChunkRecord(filename, segment, final);
            console.log(`[main] Chunk ${chunkIndex} for segment ${segment} written to ${filename} (final: ${final}).`);
            console.log(`[main] manifest.chunks.length: ${SessionManager.manifest ? SessionManager.manifest.chunks.length : 'N/A'}`);
            const saveTime = Date.now() - start;
            BrowserWindow.getAllWindows().forEach(win => {
              win.webContents.send('chunk-write-complete', { saveTime, chunkIndex, segment, final, filename });
            });
            if (bufferManager && typeof bufferManager.updateChunkThreshold === 'function') {
              bufferManager.updateChunkThreshold(saveTime);
            }
          } else {
            console.error(`[main] Chunk file missing or empty: ${filename}`);
          }
        });
      } catch (err) {
        console.error('[main] Error writing chunk:', err);
      }
    });
  });
  if (process.env.BUFFER_MANAGER_LOGS === '1') {
    console.log(`[electron] Acquisition started. Folder: ${sessionFolder}, baseFilename: sample${segmentNumber}`);
  }
  return sessionFolder;
});

// IPC: Receive frames from renderer and ingest into BufferManager
ipcMain.on('send-frame', (_event, frame) => {
  if (bufferManager) {
    bufferManager.ingest(frame);
  }
});

// IPC handlers for session/manifest management
ipcMain.handle('createSession', (_event, meta) => {
  SessionManager.createSession(meta);
});

ipcMain.handle('registerSegment', (_event, segmentInfo) => {
  SessionManager.registerSegment(segmentInfo);
});

ipcMain.handle('updateSessionMeta', (_event, patch) => {
  SessionManager.updateSessionMeta(patch);
});

ipcMain.handle('updateSegmentEndedAt', (_event, index, endedAt) => {
  SessionManager.updateSegmentEndedAt(index, endedAt);
});

ipcMain.handle('setChannelNames', (_event, names) => {
  SessionManager.setChannelNames(names);
});

ipcMain.handle('finalizeSession', (_event, endedAt) => {
  SessionManager.finalizeSession(endedAt);
});

// IPC handler to finalize chunk on acquisition error
ipcMain.handle('acquisition-error', async (_event, errorMsg) => {
  if (sampleWriter) {
    sampleWriter.finalizeChunk();
    // Update session.json manifest if available
    if (sessionFolder) {
      const manifestPath = path.join(sessionFolder, 'session.json');
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        console.log('[main] Updated session manifest after acquisition error.');
      } catch (e) {
        console.error('[main] Failed to update session manifest after acquisition error:', e);
      }
    }
    console.log('[main] Finalized chunk due to acquisition error:', errorMsg);
  }
});

// Handle manifest/session.json updates from renderer
ipcMain.on('update-session-manifest', (_event, manifest) => {
  if (!sessionFolder) return;
  const manifestPath = path.join(sessionFolder, 'session.json');
  try {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  } catch (e) {
    console.error('[update-session-manifest] Failed to write manifest:', e);
  }
});

// Handler to load all chunk files and manifest for summary/export
ipcMain.handle('load-all-chunks', async () => {
  const folder = sessionFolder || lastSessionFolder;
  if (!folder) return { segments: [], meta: null };
  try {
    const manifestPath = path.join(folder, 'session.json');
    const meta = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    // Find all chunk files in the session folder
    const files = fs.readdirSync(folder)
      .filter(f => /^sample\d+_chunk\d+\.json$/.test(f))
      .sort((a, b) => {
        // Extract sample and chunk numbers
        const matchA = a.match(/^sample(\d+)_chunk(\d+)\.json$/);
        const matchB = b.match(/^sample(\d+)_chunk(\d+)\.json$/);
        if (!matchA || !matchB) return a.localeCompare(b);
        const sampleA = parseInt(matchA[1], 10);
        const chunkA = parseInt(matchA[2], 10);
        const sampleB = parseInt(matchB[1], 10);
        const chunkB = parseInt(matchB[2], 10);
        if (sampleA !== sampleB) return sampleA - sampleB;
        return chunkA - chunkB;
      });
    // Group files by sample number (segment)
    const segmentMap = new Map();
    for (const f of files) {
      const match = f.match(/^sample(\d+)_chunk(\d+)\.json$/);
      if (!match) continue;
      const sampleNum = parseInt(match[1], 10);
      const chunkData = JSON.parse(fs.readFileSync(path.join(folder, f), 'utf-8'));
      const frames = Array.isArray(chunkData.frames) ? chunkData.frames : (Array.isArray(chunkData) ? chunkData : []);
      if (!segmentMap.has(sampleNum)) segmentMap.set(sampleNum, []);
      segmentMap.get(sampleNum).push(frames);
    }
    // For each segment, concatenate all its chunk frames in order
    const segments = Array.from(segmentMap.keys()).sort((a, b) => a - b).map(sampleNum => {
      return segmentMap.get(sampleNum).flat();
    });
    return { segments, meta };
  } catch (e) {
    console.error('[load-all-chunks] Failed to load session:', e);
    return { segments: [], meta: null };
  }
});

// Listen for buffer size updates from renderer
ipcMain.on('set-buffer-size', (_event, size) => {
  if (sampleWriter && typeof size === 'number' && sampleWriter.chunkSize !== size) {
    sampleWriter.chunkSize = size;
    if (process.env.BUFFER_MANAGER_LOGS === '1') {
      console.log(`[electron] Updated chunk size: ${size}`);
    }
  }
  if (bufferManager && typeof size === 'number') {
    bufferManager.setChunkSize(size);
    if (process.env.BUFFER_MANAGER_LOGS === '1') {
      console.log(`[electron] Updated BufferManager chunk size: ${size}`);
    }
  }
});

// Listen for session finalization from renderer
ipcMain.on('finalize-session', () => {
  if (sampleWriter) {
    sampleWriter.finalizeSession();
    segmentNumber++;
    // Save last session folder before resetting
    lastSessionFolder = sessionFolder;
    sessionFolder = undefined;
  }
});

// IPC handler for read-session-manifest to allow renderer to read session.json from disk
ipcMain.handle('read-session-manifest', async (_event, sessionPath) => {
  try {
    const manifest = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
    return manifest;
  } catch (e) {
    console.error('[read-session-manifest] Failed to read manifest:', e);
    throw e;
  }
});

// Example: Flush remaining samples on app exit
app.on('before-quit', () => {
  try {
    if (sampleWriter) {
      sampleWriter.finalizeSession();
      // Wait briefly to ensure file handles are closed
      const wait = ms => new Promise(res => setTimeout(res, ms));
      wait(200);
    }
    // If you have a serial port or device, close it here
    if (global.device && typeof global.device.close === 'function') {
      try {
        global.device.close();
      } catch (err) {
        console.error('[main] Error closing device:', err);
      }
    }
  } catch (err) {
    console.error('[main] Error during before-quit cleanup:', err);
  }
});