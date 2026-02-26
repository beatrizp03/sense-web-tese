const { contextBridge, ipcRenderer } = require('electron');
const { SerialPort } = require('serialport');

// Keep track of open ports by path so we can operate on them later
const openPorts = new Map();

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

async function listPorts() {
  const ports = await SerialPort.list();
  console.log('serial ports', ports);
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
    let name = p.friendlyName || p.manufacturer || p.path;
    console.log('examining port', p.path, 'pnpId', p.pnpId);

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
    console.log('port', p.path, 'labelled', name);
    return { path: p.path, friendlyName: name };
  });
}

async function choosePort() {
  const ports = await listPorts();
  if (ports.length === 0) {
    throw new Error('No serial ports available');
  }

  // try to automatically identify our board by opening each Bluetooth
  // serial port and performing the familiar ScientISST handshake. this
  // gives the desktop app a “bluetooth only” feel: the user does not need
  // to pick a COM number, they just power the board and click connect.
  for (const p of ports) {
    // only bother with ports that look like bluetooth adapters
    if (!/bluetooth/i.test(p.friendlyName)) continue;
    try {
      console.log(`scanning port ${p.path} (${p.friendlyName})`);
      const probe = new SerialPort(p.path, { baudRate: 9600, autoOpen: false });
      await new Promise((resolve, reject) => probe.open(err => (err ? reject(err) : resolve())));

      // perform the same initial sequence used by the library when
      // connecting: send 0x23 then 0x07 and wait for a zero‑terminated
      // string response. if we receive something we consider it our
      // device.
      await new Promise((resolve, reject) =>
        probe.write(Buffer.from([0x23]), err => (err ? reject(err) : resolve()))
      );
      await new Promise((resolve, reject) =>
        probe.write(Buffer.from([0x07]), err => (err ? reject(err) : resolve()))
      );

      const version = await new Promise((resolve, reject) => {
        let acc = Buffer.alloc(0);
        const onData = chunk => {
          acc = Buffer.concat([acc, chunk]);
          if (acc.includes(0x00)) {
            probe.off('data', onData);
            resolve(acc.toString('utf8'));
          }
        };
        probe.on('data', onData);
        setTimeout(() => {
          probe.off('data', onData);
          reject(new Error('timeout'));
        }, 1500);
      });

      await new Promise((resolve, reject) => probe.close(err => (err ? reject(err) : resolve())));

      console.log(`auto‑detected board on ${p.path}: version=${version}`);
      return p.path;
    } catch (e) {
      console.log(`port ${p.path} did not look like the board (${e.message})`);
      // ignore and try next
    }
  }

  // if autodetection failed, fall back to manual chooser
  const response = await ipcRenderer.invoke('show-port-dialog', ports.map(p => p.friendlyName));
  if (response === -1) {
    throw new Error('Cancelled');
  }
  return ports[response].path;
}

function ensurePort(path) {
  if (!openPorts.has(path)) {
    const port = new SerialPort(path, { autoOpen: false });
    openPorts.set(path, port);
  }
  return openPorts.get(path);
}

contextBridge.exposeInMainWorld('electronAPI', {
  listSerialPorts: listPorts,
  requestPort: choosePort,
  openSerialPort: async (path, options) => {
    const port = ensurePort(path);
    return new Promise((resolve, reject) => {
      port.update({ baudRate: options.baudRate }).open(err => {
        if (err) reject(err);
        else resolve();
      });
    });
  },
  writeSerialPort: async (path, data) => {
    const port = ensurePort(path);
    return new Promise((resolve, reject) => {
      port.write(Buffer.from(data), err => {
        if (err) reject(err);
        else resolve();
      });
    });
  },
  readSerialPort: async (path, bytes, timeout) => {
    const port = ensurePort(path);
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const onData = chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length >= bytes) {
          cleanup();
          resolve(new Uint8Array(buffer.slice(0, bytes)));
        }
      };
      const onError = err => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        port.off('data', onData);
        port.off('error', onError);
      };
      port.on('data', onData);
      port.on('error', onError);
      if (timeout > 0) {
        setTimeout(() => {
          cleanup();
          reject(new Error('timeout'));
        }, timeout);
      }
    });
  },
  closeSerialPort: async path => {
    const port = openPorts.get(path);
    if (!port) return;
    return new Promise((resolve, reject) => {
      port.close(err => {
        if (err) reject(err);
        else {
          openPorts.delete(path);
          resolve();
        }
      });
    });
  }
});