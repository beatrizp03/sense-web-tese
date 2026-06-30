const { app, BrowserWindow } = require("electron");
const fs = require('fs');
const path = require('path');
const { ipcMain, dialog } = require("electron");
const { spawn } = require('child_process');

const ChunkedDataWriter = require('./src/ChunkedDataWriter');
const { BufferManager } = require('./dist/BufferManager.js');
const { onChunkReady } = require('./dist/StorageSubscriber.js');
const { SessionManager } = require('./src/SessionManager.js');
const PerformanceLogger = require('./src/PerformanceLogger.js');
const AnnotationLogger = require('./src/AnnotationLogger.js');

const SESSION_SETTINGS_HISTORY_FILE = 'session-settings-history.json';
const MAX_SESSION_SETTINGS_HISTORY = 5;
const PYTHON_ANALYSIS_WORKER = path.join(__dirname, 'python', 'analysis_worker.py');

let busyReason = null;

// One annotation event-log per session folder, created lazily on first event.
const annotationLoggers = new Map();
function getAnnotationLogger(sessionFolder) {
  if (!sessionFolder || typeof sessionFolder !== 'string') return null;
  let logger = annotationLoggers.get(sessionFolder);
  if (!logger) {
    logger = new AnnotationLogger(path.join(sessionFolder, 'annotation-log.csv'));
    annotationLoggers.set(sessionFolder, logger);
  }
  return logger;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch =>
    ch === '&' ? '&amp;' :
    ch === '<' ? '&lt;' :
    ch === '>' ? '&gt;' :
    ch === '"' ? '&quot;' : '&#39;'
  );
}

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

function normalizeAnalysisRange(range) {
  if (!range || typeof range !== 'object') return undefined;
  const startSec = Number(range.startSec);
  const endSec = Number(range.endSec);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return undefined;
  const start = Math.max(0, startSec);
  if (endSec <= start) return undefined;
  return { startSec: start, endSec };
}

function normalizeAnalysisSegment(value) {
  const segment = Number(value);
  if (!Number.isFinite(segment)) return undefined;
  const index = Math.trunc(segment);
  return index >= 1 ? index : undefined;
}

function normalizeEmgWindow(windowMs, stepMs) {
  const window = Number(windowMs);
  if (!Number.isFinite(window) || window <= 0) return undefined;
  let step = Number(stepMs);
  if (!Number.isFinite(step) || step <= 0) step = window / 2;
  if (step > window) step = window;
  return { emgWindowMs: window, emgWindowStepMs: step };
}

// ECG/PPG HRV/PRV window length and step (seconds).
function normalizeHrvWindow(windowSec, stepSec) {
  const window = Number(windowSec);
  if (!Number.isFinite(window) || window <= 0) return undefined;
  let step = Number(stepSec);
  if (!Number.isFinite(step) || step <= 0) step = window;
  if (step > window) step = window;
  return { hrvWindowSec: window, hrvWindowStepSec: step };
}

function buildAnalysisRunConfig(options, signalKinds, signalAxes) {
  const opts = options || {};
  const range = normalizeAnalysisRange(opts.range);
  const segment = range ? normalizeAnalysisSegment(opts.segment) : undefined;
  const emgWindow = normalizeEmgWindow(opts.emgWindowMs, opts.emgWindowStepMs);
  const hrvWindow = normalizeHrvWindow(opts.hrvWindowSec, opts.hrvWindowStepSec);
  return {
    version: 1,
    libraryPreference: normalizeLibraryPreference(opts.edaMethod ?? opts.libraryPreference),
    signalKindLibraries: normalizeSignalKindLibraries(opts.signalKindLibraries),
    disableOutlierRemoval: opts.outlierRemoval === false,
    channelSignalKinds: signalKinds,
    channelSignalAxes: signalAxes,
    excludedChannels: normalizeExcludedChannels(opts.excludedChannels),
    ...(range ? { range } : {}),
    ...(segment ? { segment } : {}),
    ...(emgWindow ?? {}),
    ...(hrvWindow ?? {})
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

function isExternalHttpUrl(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

    const appUrl = process.env.SENSE_WEB_URL || "http://127.0.0.1:3000";
    try {
      if (parsed.origin === new URL(appUrl).origin) return false;
    } catch {
      // ignore malformed app url and fall through to host checks
    }
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function openExternalElectronWindow(url) {
  const externalWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  externalWindow.loadURL(url);
  externalWindow.on('closed', () => {
    // allow GC
  });
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

    const outputDir = options.outputSubdir
      ? path.join(sessionFolderPath, options.outputSubdir)
      : (options.outputDir || getAnalysisOutputDir(sessionFolderPath));
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
        const isCustomOutput = path.resolve(outputDir) !== path.resolve(getAnalysisOutputDir(sessionFolderPath));
        const resultPath = isCustomOutput ? workerResultPath : persistAnalysisResult(sessionFolderPath, parsed);
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

function readPersistedAnalysisResult(sessionFolderPath, subdir) {
  if (!sessionFolderPath) return null;
  const folderName = (typeof subdir === 'string' && subdir.trim()) ? subdir.trim() : 'analysis';
  const resultPath = path.join(sessionFolderPath, folderName, 'analysis.json');
  if (!fs.existsSync(resultPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
  } catch (error) {
    console.error('[main] Failed to read analysis result:', error);
    return null;
  }
}

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
      sandbox: false,
      experimentalFeatures: true,
      preload: require("path").join(__dirname, "preload.js"),
      backgroundThrottling: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttpUrl(url)) {
      openExternalElectronWindow(url);
      return { action: 'deny' };
    }

    return { action: 'allow' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!isExternalHttpUrl(url)) return;
    event.preventDefault();
    openExternalElectronWindow(url);
  });

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

  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error("did-fail-load", { code, desc, url });
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error("render-process-gone", details);
  });
  win.webContents.on("console-message", (event) => {
   console.log("[renderer]", event.message);
  });

  const url = process.env.SENSE_WEB_URL || "http://127.0.0.1:3000";
  win.loadURL(url);

  win.once("ready-to-show", () => win.show());
}

app.whenReady().then(() => {
  const { session } = require("electron");

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === "serial" || permission === "bluetooth") return callback(true);
    callback(false);
  });

  // show a simple chooser dialog for ports
  ipcMain.handle("show-port-dialog", async (_event, buttons) => {
    const labels = Array.isArray(buttons) ? buttons.map(b => String(b)) : [];
    const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const items = labels
      .map((label, i) => `<div class="item" data-index="${i}">${escapeHtml(label)}</div>`)
      .join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>port-chooser</title>
<style>
  :root { color-scheme: dark; }
  html, body { height: 100%; }
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 12px; box-sizing: border-box; background: #1c1c1e; color: #f2f2f7; display: flex; flex-direction: column; }
  h1 { font-size: 14px; margin: 0 0 10px; font-weight: 600; }
  #filter { width: 100%; box-sizing: border-box; padding: 8px 10px; margin-bottom: 10px; border: 1px solid #3a3a3c; border-radius: 8px; background: #2c2c2e; color: #f2f2f7; font-size: 13px; outline: none; }
  #filter:focus { border-color: #0a84ff; }
  #list { flex: 1; min-height: 0; overflow-y: auto; border: 1px solid #3a3a3c; border-radius: 8px; }
  .item { padding: 10px 12px; font-size: 13px; cursor: pointer; border-bottom: 1px solid #2c2c2e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .item:last-child { border-bottom: none; }
  .item:hover { background: #0a84ff; color: #fff; }
  .empty { padding: 10px 12px; font-size: 13px; color: #8e8e93; }
  .actions { display: flex; justify-content: flex-end; margin-top: 10px; }
  button.cancel { padding: 8px 14px; border: 1px solid #3a3a3c; border-radius: 8px; background: #2c2c2e; color: #f2f2f7; font-size: 13px; cursor: pointer; }
  button.cancel:hover { background: #3a3a3c; }
</style></head>
<body>
  <h1>Select a connection (Bluetooth / serial)</h1>
  <input id="filter" type="text" placeholder="Filter…" autofocus>
  <div id="list">${items || '<div class="empty">No connections found.</div>'}</div>
  <div class="actions"><button class="cancel" id="cancel">Cancel</button></div>
  <script>
    var list = document.getElementById('list');
    var filter = document.getElementById('filter');
    function pick(i){ document.title = 'port-pick:' + i; }
    list.addEventListener('click', function(e){
      var el = e.target.closest && e.target.closest('.item');
      if (el) pick(el.getAttribute('data-index'));
    });
    document.getElementById('cancel').addEventListener('click', function(){ pick(-1); });
    document.addEventListener('keydown', function(e){ if (e.key === 'Escape') pick(-1); });
    filter.addEventListener('input', function(){
      var q = filter.value.toLowerCase();
      var rows = list.getElementsByClassName('item');
      for (var k = 0; k < rows.length; k++){
        rows[k].style.display = rows[k].textContent.toLowerCase().indexOf(q) === -1 ? 'none' : '';
      }
    });
  </script>
</body></html>`;

    let htmlPath = '';
    try {
      htmlPath = path.join(app.getPath('temp'), `sense-port-chooser-${process.pid}.html`);
      fs.writeFileSync(htmlPath, html, 'utf-8');
    } catch (e) {
      console.error('[show-port-dialog] Failed to write chooser HTML, falling back to message box:', e);
      const { response } = await dialog.showMessageBox(parent || undefined, {
        type: 'question',
        message: 'Select a connection (Bluetooth/serial)',
        buttons: labels,
        cancelId: -1
      });
      return response;
    }

    return await new Promise(resolve => {
      const chooser = new BrowserWindow({
        width: 440,
        height: 480,
        parent: parent || undefined,
        modal: !!parent,
        resizable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        show: false,
        title: 'Select a connection',
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
      });
      chooser.setMenuBarVisibility(false);

      let settled = false;
      const finish = (index) => {
        if (settled) return;
        settled = true;
        resolve(Number.isInteger(index) ? index : -1);
        try { fs.unlinkSync(htmlPath); } catch { /* best effort */ }
        if (!chooser.isDestroyed()) chooser.destroy();
      };

      const showOnce = () => {
        if (!chooser.isDestroyed() && !chooser.isVisible()) {
          chooser.show();
          chooser.focus();
        }
      };
      chooser.once('ready-to-show', showOnce);
      chooser.webContents.once('did-finish-load', showOnce);

      chooser.webContents.on('page-title-updated', (event, title) => {
        const match = /^port-pick:(-?\d+)$/.exec(title || '');
        if (match) {
          event.preventDefault();
          finish(parseInt(match[1], 10));
        }
      });
      chooser.on('closed', () => finish(-1));

      chooser.loadFile(htmlPath);
    });
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

    if (exportEventsCompleted.csv && exportEventsCompleted.pdf) {
      perfLogger.stop();
      perfLogger = null;
    }
  });

  ipcMain.on('log-annotation-event', (_event, payload = {}) => {
    try {
      const logger = getAnnotationLogger(payload.sessionFolder);
      if (logger) logger.logEvent(payload);
    } catch (err) {
      console.error('[log-annotation-event] Failed:', err);
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

  ipcMain.on('set-busy', (_event, reason) => {
    busyReason = reason || null;
  });

  ipcMain.on('confirm-close', (event, shouldClose) => {
    if (shouldClose) {
      console.log('[main] User confirmed close. Finalizing session and exiting.');
      if (sampleWriter) sampleWriter.finalizeSession();
      sessionFolder = undefined;
      busyReason = null;
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
  bufferManager = new BufferManager({ chunkSize });
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

ipcMain.on('reset-session', () => {
  if (!sessionFolder) return; 
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

ipcMain.handle('get-current-session-folder', async () => {
  return sessionFolder || lastSessionFolder || null;
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

function atomicWriteJson(filePath, value) {
  const tmpPath = `${filePath}.tmp`;
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}

function readJsonOrNull(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    console.error('[sidecar] Failed to read', filePath, e);
    return null;
  }
}

function deviceTypeLabel(deviceType) {
  if (deviceType === 'sense') return 'ScientISST Sense';
  if (deviceType === 'maker') return 'ScientISST Maker';
  return deviceType || '';
}

function buildSessionHeader(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  const startedAt = Number(manifest.startedAt);
  const hasStart = Number.isFinite(startedAt);
  return {
    sessionId: manifest.sessionId ?? null,
    startedAt: hasStart ? startedAt : null,
    iso8601: hasStart ? new Date(startedAt).toISOString() : '',
    sampleRate: Number(manifest.sampleRate) || null,
    device: {
      name: manifest.device || '',
      type: deviceTypeLabel(manifest.deviceType),
      firmwareVersion: manifest.firmwareVersion || ''
    }
  };
}

ipcMain.handle('read-session-annotations', async (_event, sessionFolder) => {
  return readJsonOrNull(path.join(sessionFolder, 'annotations.json'));
});

ipcMain.handle('write-session-annotations', async (_event, sessionFolder, data) => {
  try {
    const header = buildSessionHeader(readJsonOrNull(path.join(sessionFolder, 'session.json')));
    const payload = header ? { session: header, ...data } : data;
    atomicWriteJson(path.join(sessionFolder, 'annotations.json'), payload);
    return { ok: true };
  } catch (e) {
    console.error('[write-session-annotations] Failed to write annotations:', e);
    throw e;
  }
});

ipcMain.handle('read-session-labels', async (_event, sessionFolder) => {
  return readJsonOrNull(path.join(sessionFolder, 'labels.json'));
});

ipcMain.handle('write-session-labels', async (_event, sessionFolder, data) => {
  try {
    atomicWriteJson(path.join(sessionFolder, 'labels.json'), data);
    return { ok: true };
  } catch (e) {
    console.error('[write-session-labels] Failed to write labels:', e);
    throw e;
  }
});

ipcMain.handle('export-annotations-csv', async (_event, sessionFolder) => {
  try {
    const ann = readJsonOrNull(path.join(sessionFolder, 'annotations.json'));
    if (!ann || !Array.isArray(ann.annotations)) {
      return { ok: false, error: 'No annotations to export.' };
    }
    const manifest = readJsonOrNull(path.join(sessionFolder, 'session.json'));
    if (!manifest || !Array.isArray(manifest.channels) || manifest.channels.length === 0) {
      return { ok: false, error: 'Missing or unreadable session.json.' };
    }
    const labelsFile = readJsonOrNull(path.join(sessionFolder, 'labels.json'));
    const labelList = (labelsFile && Array.isArray(labelsFile.labels) ? labelsFile.labels
      : Array.isArray(ann.labels) ? ann.labels : []);
    const labelById = new Map(labelList.map(l => [l.id, l]));

    const channels = manifest.channels.map(String);
    const channelNames = (manifest.channelNames && typeof manifest.channelNames === 'object')
      ? manifest.channelNames : {};
    const sampleRate = Number(manifest.sampleRate) > 0 ? Number(manifest.sampleRate) : 1000;
    const segmentsMeta = Array.isArray(manifest.segments) ? manifest.segments : [];
    const allChunks = Array.isArray(manifest.chunks) ? manifest.chunks : [];

    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const chunkNo = (c) => Number(String(c && c.file).match(/chunk(\d+)/)?.[1] ?? 0);
    const bySegment = new Map();
    for (const c of allChunks) {
      const seg = Number(c.segment) || 1;
      if (!bySegment.has(seg)) bySegment.set(seg, []);
      bySegment.get(seg).push(c);
    }
    const segmentNumbers = [...bySegment.keys()].sort((a, b) => a - b);

    const annsBySegment = new Map();
    let annTotal = 0;
    for (const a of ann.annotations) {
      const seg = Number(a.segment) || 1;
      const sRaw = Number.isFinite(Number(a.sample)) ? Number(a.sample) : Math.round(Number(a.ti ?? a.t0) * sampleRate);
      const eRaw = Number.isFinite(Number(a.sampleEnd)) ? Number(a.sampleEnd) : Math.round(Number(a.tf ?? a.t1) * sampleRate);
      const label = labelById.get(a.labelId);
      const name = label ? label.name : (a.labelId != null ? String(a.labelId) : '');
      const text = a.note ? `${name} (${a.note})` : name;
      if (!annsBySegment.has(seg)) annsBySegment.set(seg, []);
      annsBySegment.get(seg).push({ s: Math.min(sRaw, eRaw), e: Math.max(sRaw, eRaw), text });
      annTotal++;
    }

    const headerChannels = channels.map(ch => {
      const nm = channelNames[ch];
      return (typeof nm === 'string' && nm.trim().length > 0) ? `${nm.trim()} - ${ch}` : ch;
    });

    const lines = [];
    for (const seg of segmentNumbers) {
      const segMeta = segmentsMeta.find(s => Number(s.index) === seg) || segmentsMeta[seg - 1];
      const startedAt = Number(segMeta && segMeta.startedAt) || 0;
      const metadata = {
        Device: deviceTypeLabel(manifest.deviceType),
        'Device name': manifest.device || '',
        Firmware: manifest.firmwareVersion || '',
        Channels: channels,
        'Sampling rate (Hz)': sampleRate,
        Segment: seg,
        'ISO 8601': new Date(startedAt).toISOString(),
        Timestamp: startedAt
      };
      lines.push('#' + JSON.stringify(metadata));
      lines.push('#NSeq,' + headerChannels.join(',') + ',annotation');

      const segAnns = annsBySegment.get(seg) || [];
      const segChunks = bySegment.get(seg).slice().sort((a, b) => chunkNo(a) - chunkNo(b));
      let frameIdx = 0;
      for (const c of segChunks) {
        const abs = path.isAbsolute(c.file) ? c.file : path.join(sessionFolder, c.file);
        const data = readJsonOrNull(abs);
        const frames = Array.isArray(data && data.frames) ? data.frames : (Array.isArray(data) ? data : []);
        for (let j = 0; j < frames.length; j++) {
          const f = frames[j];
          const row = [f.sequence];
          for (const ch of channels) row.push(f.channels ? f.channels[ch] : '');
          let labelText = '';
          if (segAnns.length > 0) {
            const hits = [];
            for (const an of segAnns) {
              if (frameIdx >= an.s && frameIdx <= an.e) hits.push(an.text);
            }
            labelText = hits.join('; ');
          }
          row.push(esc(labelText));
          lines.push(row.join(','));
          frameIdx++;
        }
      }
    }

    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const saveOptions = {
      title: 'Save signal + annotations CSV',
      defaultPath: path.join(sessionFolder, 'signal_with_annotations.csv'),
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    };
    const result = win
      ? await dialog.showSaveDialog(win, saveOptions)
      : await dialog.showSaveDialog(saveOptions);
    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true };
    }

    const csvPath = result.filePath;
    const tmpPath = `${csvPath}.tmp`;
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeSync(fd, lines.join('\n'));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, csvPath);
    return { ok: true, path: csvPath, count: annTotal };
  } catch (e) {
    console.error('[export-annotations-csv] Failed:', e);
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('decimate-session', async (_event, sessionFolderPath, targetPoints, segment) => {
  const target = Number(targetPoints) > 0 ? Number(targetPoints) : 2000;
  const folder = sessionFolderPath || sessionFolder || lastSessionFolder;
  if (!folder) return { sampleRate: 0, totalSamples: 0, series: {} };

  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'session.json'), 'utf-8'));
  const sampleRate = Number(manifest.sampleRate) || 1000;
  const channels = Array.isArray(manifest.channels) ? manifest.channels.map(String) : [];

  const selectedSegment = Number(segment) > 0 ? Number(segment) : null;

  const chunks = (Array.isArray(manifest.chunks) ? [...manifest.chunks] : [])
    .filter(c => selectedSegment === null || (Number(c?.segment) || 1) === selectedSegment)
    .sort((a, b) => {
      const sa = Number(a?.segment) || 0;
      const sb = Number(b?.segment) || 0;
      if (sa !== sb) return sa - sb;
      const ia = Number(String(a?.file).match(/chunk(\d+)/)?.[1] ?? 0);
      const ib = Number(String(b?.file).match(/chunk(\d+)/)?.[1] ?? 0);
      return ia - ib;
    });

 let estTotal = 0;
  const segList = Array.isArray(manifest.segments) ? manifest.segments : [];
  const segForEstimate = selectedSegment === null
    ? segList
    : (segList[selectedSegment - 1] ? [segList[selectedSegment - 1]] : []);
  for (const seg of segForEstimate) {
    const st = Number(seg?.startedAt);
    const en = Number(seg?.endedAt);
    if (Number.isFinite(st) && Number.isFinite(en) && en > st) {
      estTotal += Math.round(((en - st) / 1000) * sampleRate);
    }
  }
  const buckets = Math.max(1, Math.floor(target / 2));
  const bucketSamples = estTotal > 0 ? Math.max(1, Math.floor(estTotal / buckets)) : Math.max(1, sampleRate);

  const series = {};
  const state = {};
  for (const ch of channels) {
    series[ch] = [];
    state[ch] = { has: false, min: 0, max: 0, minIdx: 0, maxIdx: 0 };
  }

  const flush = ch => {
    const st = state[ch];
    if (!st.has) return;
    if (st.minIdx <= st.maxIdx) {
      series[ch].push([st.minIdx, st.min], [st.maxIdx, st.max]);
    } else {
      series[ch].push([st.maxIdx, st.max], [st.minIdx, st.min]);
    }
    st.has = false;
  };

  let globalIdx = 0;
  let currentBucket = 0;
  for (const chunk of chunks) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(
        path.isAbsolute(chunk.file) ? chunk.file : path.join(folder, chunk.file),
        'utf-8'
      ));
    } catch (e) {
      console.error('[decimate-session] Failed to read chunk', chunk.file, e);
      continue;
    }
    const frames = Array.isArray(data?.frames) ? data.frames : Array.isArray(data) ? data : [];
    for (const frame of frames) {
      const bucket = Math.floor(globalIdx / bucketSamples);
      if (bucket !== currentBucket) {
        for (const ch of channels) flush(ch);
        currentBucket = bucket;
      }
      for (const ch of channels) {
        const v = Number(frame?.channels?.[ch]);
        if (!Number.isFinite(v)) continue;
        const st = state[ch];
        if (!st.has) {
          st.has = true;
          st.min = v; st.max = v; st.minIdx = globalIdx; st.maxIdx = globalIdx;
        } else {
          if (v < st.min) { st.min = v; st.minIdx = globalIdx; }
          if (v > st.max) { st.max = v; st.maxIdx = globalIdx; }
        }
      }
      globalIdx++;
    }
  }
  for (const ch of channels) flush(ch);

  return { sampleRate, totalSamples: globalIdx, series };
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

ipcMain.handle('read-posthoc-analysis-result', async (_event, sessionFolderPath, subdir) => {
  const folder = sessionFolderPath || sessionFolder || lastSessionFolder;
  if (!folder) return null;
  return readPersistedAnalysisResult(folder, subdir);
});

ipcMain.handle('select-analysis-result-folder', async () => {
  const dialogResult = await dialog.showOpenDialog({
    title: 'Select an analysis result folder',
    properties: ['openDirectory', 'dontAddToRecent']
  });

  if (dialogResult.canceled || !Array.isArray(dialogResult.filePaths) || dialogResult.filePaths.length === 0) {
    return null;
  }

  const folderPath = dialogResult.filePaths[0];
  const folderName = path.basename(folderPath);
  const resultPath = path.join(folderPath, 'analysis.json');

  if (!fs.existsSync(resultPath)) {
    return { folderPath, folderName, result: null };
  }

  try {
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    return { folderPath, folderName, result };
  } catch (error) {
    console.error('[main] Failed to read selected analysis result:', error);
    return { folderPath, folderName, result: null, error: error.message };
  }
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

app.on('before-quit', () => {
  try {
    cancelActiveAnalysisJob('Application is quitting');
    if (sampleWriter) {
      sampleWriter.finalizeSession();
      if (perfLogger) {
        perfLogger.stop();
        perfLogger = null;
      }
      const wait = ms => new Promise(res => setTimeout(res, ms));
      wait(200);
    }
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