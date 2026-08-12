const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const QRCode = require('qrcode');
const { startServer, stopServer, rebuildIndex } = require('./server');

const PORT = 8989;
let mainWindow;
let destinationFolder = null;
let sourceFolder = null;
let serverInstance = null;

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
  const url = `http://${address}:${PORT}`;
  const qrDataUrl = await QRCode.toDataURL(url);
  return { url, qrDataUrl, address };
}

async function sendServerInfo(address) {
  const candidates = listIPv4Candidates();
  const info = await buildServerInfo(address);
  mainWindow.webContents.send('server-info', { ...info, candidates });
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

  // Start listening immediately so the QR code is connectable right away;
  // /upload returns a friendly error until a destination folder is chosen,
  // and /browse + /file do the same until a source folder is shared.
  serverInstance = startServer({
    port: PORT,
    getDestinationFolder: () => destinationFolder,
    getSourceFolder: () => sourceFolder,
    onUpload: (info) => mainWindow.webContents.send('upload-event', info)
  });

  const candidates = listIPv4Candidates();
  const best = pickBestCandidate(candidates);
  await sendServerInfo(best.address);
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

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (serverInstance) stopServer(serverInstance);
  if (process.platform !== 'darwin') app.quit();
});
