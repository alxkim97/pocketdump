const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
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

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 760,
    resizable: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
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

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Delay the first check past startup so it doesn't compete with the
  // window's initial load, then recheck periodically since the app may
  // stay open for a while without being relaunched.
  setTimeout(() => checkForUpdates(false), 10_000);
  setInterval(() => checkForUpdates(false), 4 * 60 * 60 * 1000);
});

app.on('window-all-closed', () => {
  if (serverInstance) stopServer(serverInstance);
  stopMdns();
  if (process.platform !== 'darwin') app.quit();
});
