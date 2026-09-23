const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const QRCode = require('qrcode');
const { autoUpdater } = require('electron-updater');
const { Bonjour } = require('bonjour-service');
const { startServer, stopServer, rebuildIndex } = require('./server');
const { getOrCreateCert } = require('./cert');

const PORT = 8989;
const HTTPS_PORT = 8990;
const MDNS_HOST = 'pocketdump.local';
let mainWindow;
let tray = null;
let isQuitting = false;
let updateDownloaded = false;
let destinationFolder = null;
let sourceFolder = null;
let serverInstance = null;
let bonjourInstance = null;
let mdnsAvailable = false;

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings), 'utf8');
}

// Auto-update via electron-updater + GitHub Releases. A manual check from
// the renderer always reports back (found/not found/error); the periodic
// background check stays silent unless it actually finds something, so it
// doesn't nag.
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-downloaded', (info) => {
  updateDownloaded = true;
  rebuildTrayMenu();
  dialog.showMessageBox({
    type: 'info',
    title: 'PocketDump update ready',
    message: `PocketDump ${info.version} has been downloaded.`,
    detail: 'Restart now to install it, or it will install automatically the next time PocketDump quits.',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1
  }).then(({ response }) => {
    if (response === 0) autoUpdater.quitAndInstall();
  });
});

autoUpdater.on('error', (err) => {
  console.error('autoUpdater error:', err);
});

function checkForUpdates(manual) {
  if (!manual) {
    autoUpdater.checkForUpdates().catch(() => {});
    return;
  }
  const cleanup = () => {
    autoUpdater.off('update-not-available', onNotAvailable);
    autoUpdater.off('update-available', cleanup);
    autoUpdater.off('error', onError);
  };
  const onNotAvailable = () => {
    cleanup();
    dialog.showMessageBox({ type: 'info', title: 'PocketDump', message: "You're up to date." });
  };
  const onError = (err) => {
    cleanup();
    dialog.showMessageBox({
      type: 'error',
      title: 'Update check failed',
      message: 'Could not check for updates.',
      detail: String((err && err.message) || err)
    });
  };
  autoUpdater.once('update-not-available', onNotAvailable);
  autoUpdater.once('update-available', cleanup);
  autoUpdater.once('error', onError);
  autoUpdater.checkForUpdates().catch(() => {});
}

function notifyFolder() {
  mainWindow.webContents.send('folder-info', { folder: destinationFolder });
}

function notifySourceFolder() {
  mainWindow.webContents.send('source-folder-info', { folder: sourceFolder });
}

function listIPv4Candidates() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        candidates.push({ name, address: addr.address });
      }
    }
  }
  return candidates;
}

// Tailscale, WSL, Hyper-V, and other virtual/VPN adapters create addresses
// that look local but aren't reachable from a phone on the home WiFi.
function isLikelyVirtualOrVPN({ name, address }) {
  if (/tailscale|vpn|wsl|hyper-v|vethernet|virtual|zerotier|hamachi|wireguard/i.test(name)) {
    return true;
  }
  // Tailscale's CGNAT range: 100.64.0.0 - 100.127.255.255
  const [a, b] = address.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

function pickBestCandidate(candidates) {
  const real = candidates.filter((c) => !isLikelyVirtualOrVPN(c));
  return (
    real.find((c) => /^192\.168\./.test(c.address)) ||
    real.find((c) => /^10\./.test(c.address)) ||
    real.find((c) => /^172\.(1[6-9]|2\d|3[01])\./.test(c.address)) ||
    real[0] ||
    candidates[0] ||
    { name: 'loopback', address: '127.0.0.1' }
  );
}

async function buildServerInfo(address) {
  const host = address === 'mdns' ? MDNS_HOST : address;
  const url = `http://${host}:${PORT}`;
  const qrDataUrl = await QRCode.toDataURL(url);
  return { url, qrDataUrl, address };
}

async function sendServerInfo(address) {
  const candidates = listIPv4Candidates();
  // Offered first, ahead of specific IPs, when mDNS is up — this is the
  // address that keeps working across networks/PCs without a fresh QR scan.
  if (mdnsAvailable) {
    candidates.unshift({ name: `Recommended — works on any network (${MDNS_HOST})`, address: 'mdns' });
  }
  const info = await buildServerInfo(address);
  mainWindow.webContents.send('server-info', { ...info, candidates });
}

function startMdns() {
  try {
    bonjourInstance = new Bonjour({}, (err) => {
      console.error('mDNS error:', err);
    });
    bonjourInstance.publish({ name: 'PocketDump', type: 'http', port: PORT, host: MDNS_HOST });
    mdnsAvailable = true;
  } catch (err) {
    console.error('Could not start mDNS — pocketdump.local will be unavailable:', err);
    mdnsAvailable = false;
  }
}

function stopMdns() {
  if (!bonjourInstance) return;
  // Grab a stable reference before clearing the module-level one — the
  // unpublishAll callback fires asynchronously, after bonjourInstance has
  // already been reset to null, so closing over that variable directly
  // would call .destroy() on null.
  const instance = bonjourInstance;
  bonjourInstance = null;
  instance.unpublishAll(() => instance.destroy());
}

function rebuildTrayMenu() {
  const startAtLogin = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open PocketDump', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: startAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
      }
    },
    { type: 'separator' },
    updateDownloaded
      ? { label: 'Restart to Install Update', click: () => { isQuitting = true; autoUpdater.quitAndInstall(); } }
      : { label: 'Check for Updates', click: () => checkForUpdates(true) },
    { type: 'separator' },
    { label: 'Quit PocketDump', click: () => { isQuitting = true; app.quit(); } }
  ]));
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'assets', 'icon.ico'));
  tray.setToolTip('PocketDump');
  rebuildTrayMenu();
  tray.on('click', () => { mainWindow.show(); mainWindow.focus(); });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 740,
    // Left resizable during creation so the auto-sizing below can actually
    // take effect — setContentSize() on an already non-resizable window is
    // unreliable on Windows. Locked down with setResizable(false) once the
    // real size is set.
    resizable: true,
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Closing the window just hides it — the server keeps running in the
  // background (tray icon) so the phone can keep sending files without the
  // window needing to stay open. Only the tray's "Quit" actually exits.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  await mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  const settings = loadSettings();
  if (settings.destinationFolder && fs.existsSync(settings.destinationFolder)) {
    destinationFolder = settings.destinationFolder;
  }
  if (settings.sourceFolder && fs.existsSync(settings.sourceFolder)) {
    sourceFolder = settings.sourceFolder;
  }
  notifyFolder();
  notifySourceFolder();

  // The window's height needs to fit whichever state is currently showing —
  // a returning user with folders already chosen sees two extra "Open
  // folder" / "Rebuild index" rows that an empty-state layout doesn't have,
  // so a fixed guess drifts out of sync with the content. Measuring the
  // actual rendered height and sizing to it stays correct regardless.
  // The short wait lets the renderer finish handling the folder-info IPC
  // messages just sent above before layout is measured. Falls back to the
  // constructor's default height if measurement fails for any reason —
  // never worth leaving the window unshown over a sizing nicety.
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const contentHeight = await mainWindow.webContents.executeJavaScript('document.body.scrollHeight');
    const maxHeight = screen.getPrimaryDisplay().workAreaSize.height - 60;
    const targetHeight = Math.min(Math.ceil(contentHeight), maxHeight);
    mainWindow.setContentSize(480, targetHeight);
  } catch (err) {
    console.error('Could not auto-size window to content:', err);
  }
  mainWindow.setResizable(false);

  // Always start hidden in the tray — whether launched by "Start with
  // Windows" or opened by hand — instead of popping the window on top of
  // whatever the user is doing. Open it from the tray icon when it's
  // actually wanted.

  startMdns();

  // Self-signed cert for the HTTPS listener the live camera view needs
  // (getUserMedia requires a secure context). Covers every LAN address this
  // PC currently has, plus the mDNS hostname if that's up too — otherwise
  // opening the live camera via pocketdump.local would fail with a
  // hostname-mismatch error even though the cert itself is trusted. Doesn't
  // need regenerating — and re-trusting on the phone — unless the set of
  // addresses changes (e.g. a new network).
  let certOptions = null;
  try {
    const certAddresses = listIPv4Candidates().map((c) => c.address);
    if (mdnsAvailable) certAddresses.push(MDNS_HOST);
    certOptions = getOrCreateCert(app.getPath('userData'), certAddresses);
  } catch (err) {
    console.error('Could not set up HTTPS cert — live camera view will be unavailable:', err);
  }

  // Start listening immediately so the QR code is connectable right away;
  // /upload returns a friendly error until a destination folder is chosen,
  // and /browse + /file do the same until a source folder is shared.
  serverInstance = startServer({
    port: PORT,
    httpsPort: HTTPS_PORT,
    certOptions,
    appVersion: app.getVersion(),
    getDestinationFolder: () => destinationFolder,
    getSourceFolder: () => sourceFolder,
    onUpload: (info) => mainWindow.webContents.send('upload-event', info)
  });

  const candidates = listIPv4Candidates();
  const best = pickBestCandidate(candidates);
  await sendServerInfo(mdnsAvailable ? 'mdns' : best.address);
}

ipcMain.handle('select-network', async (_event, address) => {
  await sendServerInfo(address);
});

ipcMain.handle('choose-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) {
    return destinationFolder;
  }
  destinationFolder = result.filePaths[0];
  saveSettings({ ...loadSettings(), destinationFolder });
  return destinationFolder;
});

ipcMain.handle('open-folder', () => {
  if (destinationFolder) shell.openPath(destinationFolder);
});

ipcMain.handle('choose-source-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) {
    return sourceFolder;
  }
  sourceFolder = result.filePaths[0];
  saveSettings({ ...loadSettings(), sourceFolder });
  return sourceFolder;
});

ipcMain.handle('open-source-folder', () => {
  if (sourceFolder) shell.openPath(sourceFolder);
});

ipcMain.handle('rebuild-index', () => {
  if (!destinationFolder) {
    return { error: 'No destination folder selected yet.' };
  }
  const count = rebuildIndex(destinationFolder);
  return { count };
});

ipcMain.handle('get-app-info', () => ({
  version: app.getVersion(),
  credit: 'Alex Kim'
}));

ipcMain.handle('check-for-updates', () => {
  checkForUpdates(true);
});

// Only one copy may run: a second launch would try to bind the same ports
// (EADDRINUSE). Since the app now lives in the tray, clicking the icon again
// just brings the existing window forward instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  Menu.setApplicationMenu(null);

  // Default to starting with Windows, but only ever set this automatically
  // on the very first-ever launch — once the user has an explicit
  // openAtLogin state (on or off), respect it and never touch it again.
  // Skip entirely when running unpackaged (npm start): with no installed
  // .exe to point at, Electron would register the raw dev binary itself
  // (node_modules\electron\dist\electron.exe, no app path) as the startup
  // target, launching Electron's own blank placeholder window on every boot.
  if (app.isPackaged && !app.getLoginItemSettings().wasOpenedAtLogin && !app.getLoginItemSettings().openAtLogin) {
    app.setLoginItemSettings({ openAtLogin: true });
  }

  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow.show();
  });

  // Delay the first check past startup so it doesn't compete with the
  // window's initial load, then recheck periodically since the app may
  // stay open for a while without being relaunched.
  setTimeout(() => checkForUpdates(false), 10_000);
  setInterval(() => checkForUpdates(false), 4 * 60 * 60 * 1000);
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (!gotSingleInstanceLock) return;
  if (serverInstance) stopServer(serverInstance);
  stopMdns();
  if (process.platform !== 'darwin') app.quit();
});
