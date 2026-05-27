const { app, BrowserWindow } = require("electron");
const fs = require('fs');
const path = require('path');
const { ipcMain, dialog } = require("electron");
const { spawn } = require('child_process');

// Use external modules
const ChunkedDataWriter = require('./src/ChunkedDataWriter');
const { BufferManager } = require('./dist/BufferManager.js');
const { onChunkReady } = require('./dist/StorageSubscriber.js');
// SessionManager for manifest/session logic
const { SessionManager } = require('./src/SessionManager.js');
const PerformanceLogger = require('./src/PerformanceLogger.js');
const SESSION_SETTINGS_HISTORY_FILE = 'session-settings-history.json';
const MAX_SESSION_SETTINGS_HISTORY = 5;
const PYTHON_ANALYSIS_WORKER = path.join(__dirname, 'python', 'analysis_worker.py');

// Renderer-reported busy reason: blocks reload shortcuts and warns before unload.
// null = idle; otherwise a short string like "recording" or "analyzing".
let busyReason = null;

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
  const channelSignalKinds = settings.channelSignalKinds && typeof settings.channelSignalKinds === 'object'
    ? Object.entries(settings.channelSignalKinds)
      .filter(([key, value]) => channels.includes(String(key)) && typeof value === 'string' && value.length > 0)
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
    : [];
  const channelSignalAxes = settings.channelSignalAxes && typeof settings.channelSignalAxes === 'object'
    ? Object.entries(settings.channelSignalAxes)
      .filter(([key, value]) => channels.includes(String(key)) && typeof value === 'string' && value.length > 0)
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
    : [];

  return JSON.stringify({
    deviceType: settings.deviceType ?? null,
    communication: settings.communication ?? null,
    baudRate: settings.baudRate ?? null,
    samplingRate: settings.samplingRate ?? null,
    channels,
    channelSignalKinds,
    channelSignalAxes
  });
}

function normalizeSignalKindsPayload(signalKinds) {
  if (!signalKinds || typeof signalKinds !== 'object') return {};

  return Object.fromEntries(
    Object.entries(signalKinds)
      .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
      .map(([channel, value]) => [String(channel), value.trim().toLowerCase()])
  );
}

function normalizeSignalAxesPayload(signalAxes) {
  if (!signalAxes || typeof signalAxes !== 'object') return {};

  return Object.fromEntries(
    Object.entries(signalAxes)
      .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
      .map(([channel, value]) => [String(channel), value.trim().toLowerCase()])
      .filter(([, value]) => value === 'x' || value === 'y' || value === 'z')
  );
}

function normalizeLibraryPreference(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'neurokit' || text === 'neurokit2' || text === 'nk') return 'neurokit';
  if (text === 'biosppy' || text === 'bio') return 'biosppy';
  return 'auto';
}

function normalizeSignalKindLibraries(map) {
  if (!map || typeof map !== 'object') return {};
  return Object.fromEntries(
    Object.entries(map)
      .map(([kind, library]) => [String(kind).trim().toLowerCase(), normalizeLibraryPreference(library)])
      .filter(([kind, library]) => kind && (library === 'neurokit' || library === 'biosppy'))
  );
}

function normalizeExcludedChannels(list) {
  if (!Array.isArray(list)) return [];
  const seen = [];
  for (const item of list) {
    if (typeof item === 'string' && item.trim() && !seen.includes(item.trim())) {
      seen.push(item.trim());
    }
  }
  return seen;
}

function buildAnalysisRunConfig(options, signalKinds, signalAxes) {
  const opts = options || {};
  return {
    version: 1,
    libraryPreference: normalizeLibraryPreference(opts.edaMethod ?? opts.libraryPreference),
    signalKindLibraries: normalizeSignalKindLibraries(opts.signalKindLibraries),
    disableOutlierRemoval: opts.outlierRemoval === false,
    channelSignalKinds: signalKinds,
    channelSignalAxes: signalAxes,
    excludedChannels: normalizeExcludedChannels(opts.excludedChannels)
  };
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

function resolveAnalysisWorkerCommand(preferredExecutable) {
  const explicitExecutable = preferredExecutable || process.env.PYTHON_EXECUTABLE || process.env.PYTHON;
  if (explicitExecutable) {
    return { command: explicitExecutable, scriptArgs: [PYTHON_ANALYSIS_WORKER] };
  }

  if (app.isPackaged) {
    const frozenBinaryName = process.platform === 'win32' ? 'analysis_worker.exe' : 'analysis_worker';
    const frozenBinaryPath = path.join(process.resourcesPath, 'python', frozenBinaryName);
    if (fs.existsSync(frozenBinaryPath)) {
      return { command: frozenBinaryPath, scriptArgs: [] };
    }

    const bundledPythonName = process.platform === 'win32' ? 'python.exe' : 'python';
    const bundledPythonPath = path.join(process.resourcesPath, 'python', 'runtime', bundledPythonName);
    if (fs.existsSync(bundledPythonPath)) {
      return { command: bundledPythonPath, scriptArgs: [PYTHON_ANALYSIS_WORKER] };
    }

    throw new Error(
      'Post-hoc analysis worker is unavailable: no bundled Python runtime was found in this build. ' +
      `Expected either ${frozenBinaryPath} (PyInstaller-frozen worker) or ${bundledPythonPath} (embedded CPython). ` +
      'A packaged build must ship one of these — refusing to fall back to a system "python" on PATH.'
    );
  }

  // Dev / unpackaged runs: developers are expected to have Python available.
  return { command: 'python', scriptArgs: [PYTHON_ANALYSIS_WORKER] };
}

function getAnalysisOutputDir(sessionFolderPath) {
  return path.join(sessionFolderPath, 'analysis');
}

function persistAnalysisResult(sessionFolderPath, result) {
  const outputDir = getAnalysisOutputDir(sessionFolderPath);
  fs.mkdirSync(outputDir, { recursive: true });

  const resultPath = path.join(outputDir, 'analysis.json');
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));

  const manifestPath = path.join(sessionFolderPath, 'session.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      manifest.analysis = {
        lastRunAt: result.completedAt || new Date().toISOString(),
        resultPath: path.relative(sessionFolderPath, resultPath),
        worker: 'python-analysis-worker',
        signalKinds: result?.analysisConfig?.channelSignalKinds || {},
        signalAxes: result?.analysisConfig?.channelSignalAxes || {}
      };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    } catch (error) {
      console.error('[main] Failed to update manifest with analysis result:', error);
    }
  }

  return resultPath;
}

let activeAnalysisJob = null;

function cancelActiveAnalysisJob(reason) {
  if (!activeAnalysisJob) return false;
  activeAnalysisJob.cancel(reason);
  return true;
}

function runPythonAnalysisJob(sessionFolderPath, options = {}) {
  return new Promise((resolve, reject) => {
    if (!sessionFolderPath) {
      reject(new Error('runPythonAnalysisJob called without a session folder'));
      return;
    }

    if (activeAnalysisJob) {
      reject(new Error('An analysis is already running. Please wait for it to finish or cancel it before starting a new one.'));
      return;
    }

    let workerCommand;
    try {
      workerCommand = resolveAnalysisWorkerCommand(options.pythonExecutable);
    } catch (err) {
      reject(err);
      return;
    }

    const outputDir = options.outputDir || getAnalysisOutputDir(sessionFolderPath);
    fs.mkdirSync(outputDir, { recursive: true });

    const selectedSignalKinds = normalizeSignalKindsPayload(options.signalKinds);
    const selectedSignalAxes = normalizeSignalAxesPayload(options.signalAxes);
    const env = {
      ...process.env,
      PYTHONUNBUFFERED: '1'
    };

    const runConfig = buildAnalysisRunConfig(options, selectedSignalKinds, selectedSignalAxes);
    const configPath = path.join(outputDir, 'analysis-config.json');
    try {
      fs.writeFileSync(configPath, JSON.stringify(runConfig, null, 2));
    } catch (writeError) {
      reject(new Error(`Failed to write analysis config file: ${writeError.message}`));
      return;
    }

    const args = [
      ...workerCommand.scriptArgs,
      '--session-folder', sessionFolderPath,
      '--output-folder', outputDir,
      '--config', configPath
    ];

    const child = spawn(workerCommand.command, args, {
      windowsHide: true,
      env
    });

    const job = {
      child,
      sessionFolder: sessionFolderPath,
      outputDir,
      cancelled: false,
      cancelReason: null,
      startTime: Date.now(),
      cancel(reason) {
        if (this.cancelled) return;
        this.cancelled = true;
        this.cancelReason = reason || 'Cancelled';
        try {
          child.kill();
        } catch (err) {
          console.error('[main] Failed to kill analysis worker:', err);
        }
      }
    };
    activeAnalysisJob = job;

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      const trimmed = text.replace(/\r?\n$/, '');
      if (trimmed) console.log('[analysis-worker]', trimmed);

      // Parse and forward every progress event to renderer.
      for (const line of text.split(/\r?\n/)) {
        const progressMatch = line.match(/\[progress\]\s+(\d+)%\s+(.+)/i);
        if (!progressMatch) continue;

        const percentage = parseInt(progressMatch[1], 10);
        const phaseOrSignal = progressMatch[2].trim();
        if (BrowserWindow.getAllWindows().length > 0) {
          BrowserWindow.getAllWindows()[0].webContents.send('analysis-progress', {
            percentage,
            signalKind: phaseOrSignal,
            startTime: job.startTime
          });
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      const trimmed = text.replace(/\r?\n$/, '');
      if (trimmed) console.error('[analysis-worker]', trimmed);
    });

    child.on('error', (error) => {
      if (activeAnalysisJob === job) activeAnalysisJob = null;
      reject(error);
    });

    child.on('close', (code) => {
      if (activeAnalysisJob === job) activeAnalysisJob = null;

      if (job.cancelled) {
        try {
          if (job.outputDir && fs.existsSync(job.outputDir)) {
            fs.rmSync(job.outputDir, { recursive: true, force: true });
          }
        } catch (cleanupError) {
          console.error('[main] Failed to clean up cancelled analysis output:', cleanupError);
        }
      }

      if (job.cancelled) {
        const err = new Error(job.cancelReason);
        err.cancelled = true;
        reject(err);
        return;
      }

      if (code !== 0) {
        reject(new Error(`Python analysis failed with exit code ${code}: ${stderr || stdout || 'no output'}`));
        return;
      }

      try {
        const workerResultPath = path.join(outputDir, 'analysis.json');
        if (!fs.existsSync(workerResultPath)) {
          throw new Error(`Worker did not write analysis result file: ${workerResultPath}`);
        }

        const parsed = JSON.parse(fs.readFileSync(workerResultPath, 'utf-8'));
        const resultPath = persistAnalysisResult(sessionFolderPath, parsed);
        resolve({
          ...parsed,
          outputDir,
          resultPath
        });
      } catch (error) {
        reject(new Error(`Failed to read Python analysis result file: ${error.message}\nstdout: ${stdout}\nstderr: ${stderr}`));
      }
    });
  });
}

function readPersistedAnalysisResult(sessionFolderPath) {
  if (!sessionFolderPath) return null;
  const resultPath = path.join(sessionFolderPath, 'analysis', 'analysis.json');
  if (!fs.existsSync(resultPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
  } catch (error) {
    console.error('[main] Failed to read analysis result:', error);
    return null;
  }
}

// serial/USB only; BLE experimental code was removed to simplify the
// desktop build.  Port enumeration is handled via the native bridge.

// Helps with common Windows GPU/renderer launch issues
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("disable-features", "OutOfBlinkCors,CalculateNativeWinOcclusion");
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

  // Intercept window close to warn if acquisition or analysis is running
  win.on('close', (e) => {
    if ((sessionFolder && sampleWriter) || busyReason) {
      e.preventDefault();
      win.webContents.send('show-close-warning');
    }
  });

  win.webContents.on('before-input-event', (event, input) => {
    if (!busyReason) return;
    if (input.type !== 'keyDown') return;
    const key = (input.key || '').toLowerCase();
    const isReloadCombo =
      key === 'f5' ||
      (input.control && key === 'r') ||
      (input.control && input.shift && key === 'r');
    if (isReloadCombo) {
      event.preventDefault();
      console.log(`[main] blocked reload (${key}) while ${busyReason}`);
    }
  });

  win.webContents.on('will-prevent-unload', (event) => {
    if (!busyReason) return; // not busy → allow unload as usual
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Stay', 'Leave anyway'],
      defaultId: 0,
      cancelId: 0,
      title: 'Operation in progress',
      message: `${busyReason} in progress — leaving will discard live state.`,
      detail: 'Click "Stay" to remain on the page, or "Leave anyway" to reload/navigate (data already written to disk is safe).',
    });
    if (choice === 0) event.preventDefault(); // Stay → block unload
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

  ipcMain.handle("select-analysis-session-folder", async () => {
    const result = await dialog.showOpenDialog({
      title: "Select a session folder to analyze",
      properties: ["openDirectory", "dontAddToRecent"]
    });

    if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  // IPC handler to log a named event (with optional duration) from the renderer
  ipcMain.on('log-perf-event', (_event, { name, durationMs }) => {
    if (!perfLogger) return;

    perfLogger.logEvent(name, durationMs);

    if (name === 'csv_export') exportEventsCompleted.csv = true;
    if (name === 'pdf_export') exportEventsCompleted.pdf = true;

    // Keep logger alive after disconnect/finalize and stop only after
    // both export actions are triggered on summary.
    if (exportEventsCompleted.csv && exportEventsCompleted.pdf) {
      perfLogger.stop();
      perfLogger = null;
    }
  });

  ipcMain.handle('stop-perf-logger-if-pending', (_event, status = {}) => {
    const csvExported = Boolean(status.csvExported);
    const pdfExported = Boolean(status.pdfExported);

    if (!csvExported || !pdfExported) {
      if (perfLogger) {
        perfLogger.stop();
        perfLogger = null;
      }
    }

    return { stopped: !perfLogger };
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
let exportEventsCompleted = { csv: false, pdf: false };
// remember last selected port friendly name when user picks a port in renderer
let lastSelectedPortLabel = '';

ipcMain.handle('start-acquisition', async (_event, startTime) => {
  // Only create session folder if not already set (first acquisition)
  if (!sessionFolder) {
    if (perfLogger) {
      perfLogger.stop();
      perfLogger = null;
    }

    sessionFolder = path.join(__dirname, 'data', startTime.replace(/[:.]/g, '-'));
    segmentNumber = 1;
    exportEventsCompleted = { csv: false, pdf: false };
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
  try {
    if ((!meta || !meta.device || meta.device === '') && lastSelectedPortLabel) {
      meta = Object.assign({}, meta, { device: lastSelectedPortLabel });
    }
  } catch (e) {
    console.error('[createSession] inject error', e);
  }
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

ipcMain.handle('clear-session-settings-history', () => {
  try {
    const historyPath = getSessionSettingsHistoryPath();
    if (fs.existsSync(historyPath)) {
      fs.unlinkSync(historyPath);
    }
    return [];
  } catch (error) {
    console.error('[main] Failed to clear session settings history:', error);
    return [];
  }
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

ipcMain.on('port-selected', (_event, portEntry) => {
  try {
    if (!portEntry || !portEntry.path) return;
    let friendly = portEntry.friendlyName || portEntry.name || portEntry.path;
    if (typeof friendly === 'string') {
      // strip occasional "Bluetooth: " prefix so stored device is just the name
      friendly = friendly.replace(/^\s*Bluetooth:\s*/i, '').trim();
    }
    lastSelectedPortLabel = friendly || '';
    if (SessionManager && SessionManager.manifest) {
      SessionManager.manifest.device = friendly;
    }
  } catch (e) {
    console.error('[port-selected] Handler error:', e);
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
    // Missing file is an expected case (user picked a non-session folder);
    // return null so the renderer can show a friendly "re-import" message
    // instead of surfacing a raw IPC stack trace.
    if (e && e.code === 'ENOENT') {
      console.log('[read-session-manifest] no session.json at', sessionPath);
      return null;
    }
    console.error('[read-session-manifest] Failed to read manifest:', e);
    throw e;
  }
});

ipcMain.handle('run-posthoc-analysis', async (_event, payload = {}) => {
  const sessionFolderPath = payload.sessionFolder || sessionFolder || lastSessionFolder;
  if (!sessionFolderPath) {
    throw new Error('No session folder is available for analysis');
  }

  if (sampleWriter && sessionFolderPath === sessionFolder) {
    throw new Error('Post-hoc analysis is only available after the session is finalized');
  }

  try {
    return await runPythonAnalysisJob(sessionFolderPath, payload);
  } catch (error) {
    if (error?.cancelled) {
      console.log('[main] Analysis cancelled by user');
      return { cancelled: true };
    }
    throw error;
  }
});

ipcMain.handle('read-posthoc-analysis-result', async (_event, sessionFolderPath) => {
  const folder = sessionFolderPath || sessionFolder || lastSessionFolder;
  if (!folder) return null;
  return readPersistedAnalysisResult(folder);
});

ipcMain.handle('cancel-posthoc-analysis', (_event, payload = {}) => {
  if (!activeAnalysisJob) return { cancelled: false };

  const targetFolder = payload && typeof payload.sessionFolder === 'string' ? payload.sessionFolder : null;
  if (targetFolder && activeAnalysisJob.sessionFolder !== targetFolder) {
    return { cancelled: false };
  }

  const reason = (payload && typeof payload.reason === 'string' && payload.reason) || 'Cancelled by renderer';
  cancelActiveAnalysisJob(reason);
  return { cancelled: true };
});

// Example: Flush remaining samples on app exit
app.on('before-quit', () => {
  try {
    cancelActiveAnalysisJob('Application is quitting');
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