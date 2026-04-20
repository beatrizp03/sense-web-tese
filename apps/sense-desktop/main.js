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
const PerformanceLogger = require('./src/PerformanceLogger.js');
const SESSION_SETTINGS_HISTORY_FILE = 'session-settings-history.json';
const MAX_SESSION_SETTINGS_HISTORY = 5;

function getSessionSettingsHistoryPath() {
  return path.join(app.getPath('userData'), SESSION_SETTINGS_HISTORY_FILE);
}

function normalizeSessionSettingsHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && typeof item === 'object' && item.settings)
    .slice(0, MAX_SESSION_SETTINGS_HISTORY);
}

function getSettingsFingerprint(settings) {
  if (!settings || typeof settings !== 'object') return '';
  const channels = Array.isArray(settings.channels)
    ? [...settings.channels].map(String).sort()
    : [];

  return JSON.stringify({
    deviceType: settings.deviceType ?? null,
    communication: settings.communication ?? null,
    baudRate: settings.baudRate ?? null,
    samplingRate: settings.samplingRate ?? null,
    channels
  });
}

function loadSessionSettingsHistoryFromDisk() {
  try {
    const historyPath = getSessionSettingsHistoryPath();
    if (!fs.existsSync(historyPath)) return [];
    const data = fs.readFileSync(historyPath, 'utf-8');
    return normalizeSessionSettingsHistory(JSON.parse(data));
  } catch (error) {
    console.error('[main] Failed to load session settings history:', error);
    return [];
  }
}

function saveSessionSettingsHistoryToDisk(history) {
  try {
    const historyPath = getSessionSettingsHistoryPath();
    const normalized = normalizeSessionSettingsHistory(history);
    fs.writeFileSync(historyPath, JSON.stringify(normalized, null, 2));
    return normalized;
  } catch (error) {
    console.error('[main] Failed to save session settings history:', error);
    return [];
  }
}

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

  // IPC handler to log a named event (with optional duration) from the renderer
  ipcMain.on('log-perf-event', (_event, { name, durationMs }) => {
    if (perfLogger) perfLogger.logEvent(name, durationMs);
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
let perfLogger = null;

ipcMain.handle('start-acquisition', async (_event, startTime) => {
  // Only create session folder if not already set (first acquisition)
  if (!sessionFolder) {
    sessionFolder = path.join(__dirname, 'data', startTime.replace(/[:.]/g, '-'));
    segmentNumber = 1;
    // Start performance logging once per session (not on each resume)
    perfLogger = new PerformanceLogger(path.join(sessionFolder, 'performance.csv'), 1000);
    perfLogger.start();
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

ipcMain.handle('load-session-settings-history', () => {
  return loadSessionSettingsHistoryFromDisk();
});

ipcMain.handle('save-session-settings-snapshot', (_event, snapshot) => {
  if (!snapshot || typeof snapshot !== 'object') {
    return loadSessionSettingsHistoryFromDisk();
  }

  const history = loadSessionSettingsHistoryFromDisk();
  const fingerprint = getSettingsFingerprint(snapshot.settings);
  const alreadyExists = history.some(item => getSettingsFingerprint(item.settings) === fingerprint);
  if (alreadyExists) {
    return history;
  }

  const nextHistory = [snapshot, ...history]
    .filter((item, index, all) => {
      const key = `${item.id}-${item.savedAt}`;
      return all.findIndex(candidate => `${candidate.id}-${candidate.savedAt}` === key) === index;
    })
    .slice(0, MAX_SESSION_SETTINGS_HISTORY);

  return saveSessionSettingsHistoryToDisk(nextHistory);
});

ipcMain.handle('finalizeSession', (_event, endedAt) => {
  SessionManager.finalizeSession(endedAt);
  // Acquisition is fully saved — clear the close guard so the window can close normally
  if (sampleWriter) {
    sampleWriter.finalizeSession();
    sampleWriter = undefined;
  }
  // Keep perfLogger running for CSV/PDF exports on summary page
  lastSessionFolder = sessionFolder;
  sessionFolder = undefined;
});

// Called when live.tsx unmounts (navigation away or page close).
// If the session was not properly finalized (user left without pressing Stop),
// this resets main-process state so the next start-acquisition creates a new folder.
ipcMain.on('reset-session', () => {
  if (!sessionFolder) return; // already clean (finalizeSession was called normally)
  console.log('[main] Session abandoned — resetting state for next acquisition');
  if (sampleWriter) {
    sampleWriter.finalizeSession();
    sampleWriter = undefined;
  }
  if (perfLogger) { perfLogger.stop(); perfLogger = null; }
  bufferManager = null;
  lastSessionFolder = sessionFolder;
  sessionFolder = undefined;
  segmentNumber = 1;
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

// Handler to load manifest for summary page — no frame data, just session.json
ipcMain.handle('load-all-chunks', async () => {
  const folder = sessionFolder || lastSessionFolder;
  if (!folder) return { meta: null };
  try {
    const manifestPath = path.join(folder, 'session.json');
    const meta = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    return { meta };
  } catch (e) {
    console.error('[load-all-chunks] Failed to load session manifest:', e);
    return { meta: null };
  }
});

// Load only the last N frames from a specific sample number's chunks (for PDF preview)
ipcMain.handle('load-preview-frames', async (_event, { sampleNum, frameCount }) => {
  const folder = sessionFolder || lastSessionFolder;
  if (!folder) return [];
  try {
    const files = fs.readdirSync(folder)
      .filter(f => new RegExp(`^sample${sampleNum}_chunk\\d+\\.json$`).test(f))
      .sort((a, b) => {
        const nA = parseInt(a.match(/chunk(\d+)/)[1], 10);
        const nB = parseInt(b.match(/chunk(\d+)/)[1], 10);
        return nA - nB;
      });
    const frames = [];
    // Read from the end until we have enough frames for the preview
    for (let i = files.length - 1; i >= 0 && frames.length < frameCount; i--) {
      const chunkData = JSON.parse(fs.readFileSync(path.join(folder, files[i]), 'utf-8'));
      const chunkFrames = Array.isArray(chunkData.frames) ? chunkData.frames : (Array.isArray(chunkData) ? chunkData : []);
      frames.unshift(...chunkFrames);
    }
    return frames.slice(-frameCount);
  } catch (e) {
    console.error('[load-preview-frames] Failed:', e);
    return [];
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
      if (perfLogger) {
        perfLogger.stop();
        perfLogger = null;
      }
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