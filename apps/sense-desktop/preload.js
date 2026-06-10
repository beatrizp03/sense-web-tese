const { contextBridge, ipcRenderer } = require('electron');
const { SerialPort } = require('serialport');

const openPorts = new Map();

const serialBuffers = {};
const serialDataHandlers = new Map();
const serialCloseHandlers = new Map();
const serialErrorHandlers = new Map();
const closingPorts = new Set();

function cleanupPortState(path, port) {
  const target = port || openPorts.get(path);
  if (target) {
    const onData = serialDataHandlers.get(path);
    if (onData) {
      target.off("data", onData);
      serialDataHandlers.delete(path);
    }
    const onClose = serialCloseHandlers.get(path);
    if (onClose) {
      target.off("close", onClose);
      serialCloseHandlers.delete(path);
    }
    const onError = serialErrorHandlers.get(path);
    if (onError) {
      target.off("error", onError);
      serialErrorHandlers.delete(path);
    }
  } else {
    serialDataHandlers.delete(path);
    serialCloseHandlers.delete(path);
    serialErrorHandlers.delete(path);
  }
  openPorts.delete(path);
  serialBuffers[path] = Buffer.alloc(0);
  closingPorts.delete(path);
}

async function getBtNames() {
  return new Promise((resolve, reject) => {
    const { exec } = require('child_process');
    const ps =
      'Get-PnpDevice -Class Bluetooth | ' +
      'Select-Object -Property InstanceId,FriendlyName | ' +
      'ConvertTo-Json';
    exec(`powershell -Command "${ps}"`, { windowsHide: true }, (err, stdout) => {
      if (err) {
        return reject(err);
      }
      try {
        const list = JSON.parse(stdout);
        const map = new Map();
        (Array.isArray(list) ? list : [list]).forEach(d => {
          if (d.InstanceId && d.FriendlyName) {
            map.set(d.InstanceId.toLowerCase(), d.FriendlyName);
          }
        });
        console.log('bt devices from powershell', map);
        resolve(map);
      } catch (e) {
        reject(e);
      }
    });
  });
}

function clearRingBuffer() {
  for (const path in serialBuffers) {
    serialBuffers[path] = Buffer.alloc(0);
  }
}

async function listPorts() {
  clearRingBuffer(); // Always clear buffer before listing ports
  
  let ports = await SerialPort.list();
  
  ports = ports
    .map(p => {
      const portPath = p.path ?? p.comName ?? p.name;
      if (!portPath) {
        console.log('dropping port entry without usable path', p);
        return null;
      }
      return { original: p, path: portPath };
    })
    .filter(x => x !== null)
    .map(x => x.original);

  let btNames = new Map();
  try {
    btNames = await getBtNames();
  } catch (e) {
    // if Bluetooth lookup fails, just continue with generic names
    console.log('could not query BT names', e.message);
  }

 const btList = [];
  for (const [inst, fn] of btNames) {
    const m = inst.match(/dev_([0-9a-f]{12})/i);
    if (m) {
      btList.push({ address: m[1].toLowerCase(), name: fn });
    }
  }
  console.log('parsed bluetooth addresses', btList);
  return ports.map(p => {
    // re-compute the normalized path here just in case
    const portPath = p.path ?? p.comName ?? p.name;
    let name = p.friendlyName || p.manufacturer || portPath;
    console.log('examining port', portPath, 'pnpId', p.pnpId);

    // try to match against parsed addresses first
    if (p.pnpId) {
      const pid = p.pnpId.toLowerCase();
      for (const bt of btList) {
        if (pid.includes(bt.address)) {
          name = bt.name;
          break;
        }
      }
    }

    // fallback to simple substring matching against the instance id string
    if (p.pnpId) {
      for (const [inst, fn] of btNames) {
        if (inst.includes(p.pnpId.toLowerCase()) || p.pnpId.toLowerCase().includes(inst)) {
          name = fn;
          break;
        }
      }
    }

    if (/bluetooth/i.test(name) || (p.pnpId && /bthenum/i.test(p.pnpId))) {
      name = `Bluetooth: ${name}`;
    }
    console.log('port', portPath, 'labelled', name);
    return { path: portPath, friendlyName: name };
  });
}

async function choosePort() {
  const ports = await listPorts();
  if (ports.length === 0) {
    throw new Error('No serial ports available');
  }

  const response = await ipcRenderer.invoke(
    'show-port-dialog',
    ports.map(p => p.friendlyName)
  );
  if (response === -1) {
    throw new Error('Cancelled');
  }
  // Notify main process of the selected port so it can persist the friendly name
  try {
    ipcRenderer.send('port-selected', ports[response]);
  } catch (e) {
    // ignore notification errors
  }
  return ports[response].path;
}

function ensurePort(path, baudRate = 9600) {
  if (!path) throw new Error("ensurePort called without a valid path");

  const existing = openPorts.get(path);
  if (existing) return existing;

  const port = new SerialPort({ path, baudRate, autoOpen: false });
  openPorts.set(path, port);
  return port;
}

async function openSerialPort(path, options = {}) {
  const baudRate = Number(options.baudRate ?? 9600);
  if (!Number.isFinite(baudRate)) throw new Error(`Invalid baudRate: ${options.baudRate}`);

  // Clean up any existing port
  const existing = openPorts.get(path);
  if (existing) {
    await closeSerialPort(path);
  }

  const port = new SerialPort({ path, baudRate, autoOpen: false });
  openPorts.set(path, port);
  serialBuffers[path] = Buffer.alloc(0);
  closingPorts.delete(path);

  // Attach one data listener per port
  const onData = (chunk) => {
    serialBuffers[path] = Buffer.concat([serialBuffers[path], chunk]);
  };
  const onClose = () => cleanupPortState(path, port);
  const onError = () => cleanupPortState(path, port);
  serialDataHandlers.set(path, onData);
  serialCloseHandlers.set(path, onClose);
  serialErrorHandlers.set(path, onError);
  port.on("data", onData);
  port.on("close", onClose);
  port.on("error", onError);

  return new Promise((resolve, reject) => {
    port.open((err) => {
      if (err) {
        cleanupPortState(path, port);
        if (/1167/.test(err.message || "")) {
          reject(new Error(`Opening ${path} failed: device is disconnected or unavailable (Windows 1167)`));
          return;
        }
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function readSerialPort(path, bytes, timeout) {
  // Only consume from serialBuffers[path], never attach listeners here
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (closingPorts.has(path)) {
        reject(new Error(`Read aborted: port ${path} is closing`));
        return;
      }
      const buf = serialBuffers[path] || Buffer.alloc(0);
      if (buf.length >= bytes) {
        const out = buf.slice(0, bytes);
        serialBuffers[path] = buf.slice(bytes);
        resolve(new Uint8Array(out));
      } else if (Date.now() - start > timeout) {
        // Return whatever is available
        const out = buf;
        serialBuffers[path] = Buffer.alloc(0);
        resolve(new Uint8Array(out));
      } else {
        setTimeout(check, 2);
      }
    };
    check();
  });
}

async function closeSerialPort(path) {
  closingPorts.add(path);
  const port = openPorts.get(path);
  try {
    if (port && port.isOpen) {
      await new Promise((resolve, reject) => {
        port.close(err => {
          if (!err) {
            resolve();
            return;
          }
          if (/port is not open/i.test(err.message || "")) {
            resolve();
            return;
          }
          reject(err);
        });
      });
    }
  } finally {
    cleanupPortState(path, port);
  }
}

contextBridge.exposeInMainWorld('electronAPI', {  
  readChunkFile: async (filePath) => {
    return await ipcRenderer.invoke('read-chunk-file', filePath);
  },
  listSerialPorts: listPorts,
  requestPort: choosePort,
  writeSerialPort: async (path, data) => {
    const port = ensurePort(path);
    return new Promise((resolve, reject) => {
      port.write(Buffer.from(data), err => {
        if (err) {
          if (/port is not open/i.test(err.message || "")) {
            cleanupPortState(path, port);
          }
          reject(err);
          return;
        }
        resolve();
      });
    });
  },
  onSerialData: (path, cb) => {
    const port = ensurePort(path);
    const handler = chunk => cb(new Uint8Array(chunk));
    port.on('data', handler);
    return () => port.off('data', handler);
  },
  // Acquisition/session control
  startAcquisition: async (startTime) => {
    return await ipcRenderer.invoke('start-acquisition', startTime);
  },
  stopAcquisition: () => ipcRenderer.send('stop-acquisition'),
  // Remove legacy writeChunk and flushSamples APIs
  finalizeSession: (endedAt) => ipcRenderer.invoke('finalizeSession', endedAt),
  // Session/manifest management
  createSession: (meta) => ipcRenderer.invoke('createSession', meta),
  registerSegment: (segmentInfo) => ipcRenderer.invoke('registerSegment', segmentInfo),
  updateSessionMeta: (patch) => ipcRenderer.invoke('updateSessionMeta', patch),
  updateSegmentEndedAt: (index, endedAt) => ipcRenderer.invoke('updateSegmentEndedAt', index, endedAt),
  setChannelNames: (names) => ipcRenderer.invoke('setChannelNames', names),
  // New: flush BufferManager chunk in main process
  flushChunk: (final = false) => ipcRenderer.send('flush-chunk', { final }),
  setBufferSize: (size) => ipcRenderer.send('set-buffer-size', size),
  // Send a frame to main process BufferManager
  sendFrame: (frame) => ipcRenderer.send('send-frame', frame),
  // Listen for chunk write completion (info object)
  onChunkWriteComplete: (cb) => {
    ipcRenderer.on('chunk-write-complete', (_event, info) => cb(info));
    return () => ipcRenderer.removeAllListeners('chunk-write-complete');
  },
  updateSessionManifest: (manifest) => ipcRenderer.send('update-session-manifest', manifest),
  loadAllChunks: async () => {
    return await ipcRenderer.invoke('load-all-chunks');
  },
  loadPreviewFrames: async (sampleNum, frameCount) => {
    return await ipcRenderer.invoke('load-preview-frames', { sampleNum, frameCount });
  },
  decimateSession: async (sessionFolder, targetPoints, segment) => {
    return await ipcRenderer.invoke('decimate-session', sessionFolder, targetPoints, segment);
  },
  openSerialPort,
  readSerialPort,
  closeSerialPort,
  clearRingBuffer,
  readSessionManifest: async (sessionPath) => {
    return await ipcRenderer.invoke('read-session-manifest', sessionPath);
  },
  selectAnalysisSessionFolder: async () => {
    return await ipcRenderer.invoke('select-analysis-session-folder');
  },
  runPostHocAnalysis: async (payload = {}) => {
    return await ipcRenderer.invoke('run-posthoc-analysis', payload);
  },
  cancelPostHocAnalysis: async (payload = {}) => {
    return await ipcRenderer.invoke('cancel-posthoc-analysis', payload);
  },
  onAnalysisProgress: (callback) => {
    ipcRenderer.on('analysis-progress', (_event, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('analysis-progress');
  },
  readPostHocAnalysisResult: async (sessionFolderPath, subdir) => {
    return await ipcRenderer.invoke('read-posthoc-analysis-result', sessionFolderPath, subdir);
  },
  acquisitionError: async (sessionPath) => {
    return await ipcRenderer.invoke('acquisition-error', sessionPath);
  },
  onShowCloseWarning: (callback) => {
    ipcRenderer.on('show-close-warning', callback);
    return () => ipcRenderer.removeAllListeners('show-close-warning');
  },
  confirmClose: (shouldClose) => ipcRenderer.send('confirm-close', shouldClose),
  resetSession: () => ipcRenderer.send('reset-session'),
  logPerfEvent: (name, durationMs) => ipcRenderer.send('log-perf-event', { name, durationMs }),
  stopPerfLoggerIfPending: (status) => ipcRenderer.invoke('stop-perf-logger-if-pending', status),
  loadSessionSettingsHistory: () => ipcRenderer.invoke('load-session-settings-history'),
  saveSessionSettingsSnapshot: (snapshot) => ipcRenderer.invoke('save-session-settings-snapshot', snapshot),
  clearSessionSettingsHistory: () => ipcRenderer.invoke('clear-session-settings-history'),
  setBusy: (reason) => ipcRenderer.send('set-busy', reason || null)
});
