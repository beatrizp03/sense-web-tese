const { app, BrowserWindow } = require("electron");

// serial/USB only; BLE experimental code was removed to simplify the
// desktop build.  Port enumeration is handled via the native bridge.

// Helps with common Windows GPU/renderer launch issues
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("disable-features", "OutOfBlinkCors");
// Required for Web Serial / Web Bluetooth APIs inside Electron
app.commandLine.appendSwitch("enable-experimental-web-platform-features");

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
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

  const { ipcMain, dialog } = require("electron");

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