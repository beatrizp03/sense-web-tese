const { contextBridge, ipcRenderer } = require('electron');
const { SerialPort } = require('serialport');

// Keep track of open ports by path so we can operate on them later
const openPorts = new Map();
// Only expose secure bridge APIs, no buffering or business logic
const serialBuffers = {};
const serialDataHandlers = new Map();

// run a PowerShell command to enumerate Bluetooth devices and
// return a map from instance ID to friendly name. this allows us to
// cross-reference the COM ports with their user‑visible names.
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

// Clears all serialBuffers for device connection reset
function clearRingBuffer() {
  for (const path in serialBuffers) {
    serialBuffers[path] = Buffer.alloc(0);
  }
}

async function listPorts() {
  clearRingBuffer(); // Always clear buffer before listing ports
  
  let ports = await SerialPort.list();
  console.log('serial ports', ports);

  // normalize each entry to a usable string path; some drivers put the
  // COM path in `comName` or just `name`. drop anything where we can't
  // derive a path.
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

  // convert map to array of address/name pairs so we can match on
  // the bluetooth MAC that appears in both the instance ID and the pnpId.
  const btList = [];
  for (const [inst, fn] of btNames) {
    const m = inst.match(/dev_([0-9a-f]{12})/i);
    if (m) {
      btList.push({ address: m[1].toLowerCase(), name: fn });
    }
  }
  console.log('parsed bluetooth addresses', btList);

  // return only path and friendlyName for display. mark any entries that
  // appear to be Bluetooth so the user has some hint, and if we have a
  // matching friendly name from the BT subsystem prefer it.
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

  // simply show the chooser; the renderer can treat the returned path as the
  // COM port to open. this avoids flaky handshake attempts and works
  // reliably with Bluetooth SPP devices such as the ScientISST board.
  const response = await ipcRenderer.invoke(
    'show-port-dialog',
    ports.map(p => p.friendlyName)
  );
  if (response === -1) {
    throw new Error('Cancelled');
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

  // Attach one data listener per port
  const onData = (chunk) => {
    serialBuffers[path] = Buffer.concat([serialBuffers[path], chunk]);
  };
  serialDataHandlers.set(path, onData);
  port.on("data", onData);

  port.removeAllListeners("error");
  port.removeAllListeners("close");

  return new Promise((resolve, reject) => {
    port.open((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function readSerialPort(path, bytes, timeout) {
  // Only consume from serialBuffers[path], never attach listeners here
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
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
  const port = openPorts.get(path);
  if (!port) {
    serialBuffers[path] = Buffer.alloc(0);
    serialDataHandlers.delete(path);
    return;
  }
  // Remove listeners
  const onData = serialDataHandlers.get(path);
  if (onData) {
    port.off("data", onData);
    serialDataHandlers.delete(path);
  }
  port.removeAllListeners("error");
  port.removeAllListeners("close");
  await new Promise((resolve, reject) => {
    port.close(err => err ? reject(err) : resolve());
  });
  openPorts.delete(path);
  serialBuffers[path] = Buffer.alloc(0);
}

contextBridge.exposeInMainWorld('electronAPI', {
  // Transport-safe bridge methods
  listSerialPorts: listPorts,
  requestPort: choosePort,
  writeSerialPort: async (path, data) => {
    const port = ensurePort(path);
    return new Promise((resolve, reject) => {
      port.write(Buffer.from(data), err => {
        if (err) reject(err);
        else resolve();
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
  startAcquisition: (startTime) => ipcRenderer.send('start-acquisition', startTime),
  stopAcquisition: () => ipcRenderer.send('stop-acquisition'),
  writeChunk: (chunk) => ipcRenderer.send('write-chunk', chunk),
  finalizeSession: () => ipcRenderer.send('finalize-session'),
  flushSamples: (finalize) => ipcRenderer.send('flush-samples', finalize),
  setBufferSize: (size) => ipcRenderer.send('set-buffer-size', size),
  // Listen for chunk write completion (saveTime)
  onChunkWriteComplete: (cb) => {
    ipcRenderer.on('chunk-write-complete', (_event, saveTime) => cb(saveTime));
    return () => ipcRenderer.removeAllListeners('chunk-write-complete');
  },
  openSerialPort,
  readSerialPort,
  closeSerialPort,
  clearRingBuffer
});