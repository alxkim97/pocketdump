const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, screen, Notification, clipboard, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { autoUpdater } = require('electron-updater');
const { Bonjour } = require('bonjour-service');
const { startServer, stopServer, cleanupTemp, flushManifests } = require('./server');
const { getOrCreateCert } = require('./cert');
const { writeFileAtomic } = require('./fsutil');

const PORT = 8989;
const HTTPS_PORT = 8990;
const MDNS_HOST = 'pocketdump.local';
// bonjour-service probes for ~1s before announcing; generous margin for
// slow or busy networks.
const MDNS_PROBE_TIMEOUT_MS = 5000;
// How often a PC that lost the pocketdump.local name checks whether the
// holder has gone away (and takes the name over if so), and how often every
// PC re-asks the network which other PocketDump PCs are around.
const MDNS_TAKEOVER_CHECK_MS = 30_000;
const PEER_REFRESH_MS = 30_000;
// Separate service type every PocketDump PC announces under its own unique
// name, so the phone can list all of them — pocketdump.local itself can only
// ever point at one.
const PEER_SERVICE_TYPE = 'pocketdump';
let mainWindow;
let tray = null;
let isQuitting = false;
let updateDownloaded = false;
let destinationFolder = null;
let sourceFolder = null;
let serverInstance = null;
let bonjourInstance = null;
let mdnsAvailable = false;
let mdnsProbeTimer = null;
let mdnsTakeoverTimer = null;
let mdnsTakeoverChecking = false;
let peerBrowser = null;
let peerRefreshTimer = null;
// Other PocketDump PCs seen on the network, keyed by their pcId.
const peers = new Map();
let currentAddress = null;

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const MAX_TEXTS = 50;
const THUMBNAIL_CACHE_SIZE = 300;
// Uploads arriving within this long of each other count as one batch for
// the "files received" notification.
const BATCH_NOTIFY_DELAY_MS = 4000;

// Read once and kept in memory — the server consults settings (pairing
// tokens, outbox) on every request.
let settingsCache = null;

function loadSettings() {
  if (!settingsCache) {
    try {
      settingsCache = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    } catch {
      settingsCache = {};
    }
  }
  return settingsCache;
}

function saveSettings(settings) {
  settingsCache = settings;
  writeFileAtomic(SETTINGS_PATH, JSON.stringify(settings));
}

function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// --- Pairing ---
// The PC shows a 4-digit PIN (also baked into its QR code). A phone that
// enters it gets a random token; only a hash of it is stored here.
function newPin() {
  return String(crypto.randomInt(0, 10_000)).padStart(4, '0');
}

function getPairing() {
  const settings = loadSettings();
  if (settings.pin && Array.isArray(settings.devices)) return { pin: settings.pin, devices: settings.devices };
  const pairing = { pin: settings.pin || newPin(), devices: settings.devices || [] };
  saveSettings({ ...settings, ...pairing });
  return pairing;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function isValidToken(token) {
  const tokenHash = hashToken(token);
  return getPairing().devices.some((d) => d.tokenHash === tokenHash);
}

function pairDevice(pin, deviceName) {
  const pairing = getPairing();
  const expected = Buffer.from(pairing.pin);
  const given = Buffer.from(pin);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  const token = crypto.randomBytes(24).toString('base64url');
  const devices = [...pairing.devices, { tokenHash: hashToken(token), name: deviceName || 'iPhone', pairedAt: Date.now() }];
  saveSettings({ ...loadSettings(), devices });
  sendToWindow('pairing-info', getPairingInfo());
  return token;
}

function getPairingInfo() {
  const { pin, devices } = getPairing();
  return { pin, deviceCount: devices.length };
}

// --- Send to iPhone (outbox) ---
function getOutbox() {
  return (loadSettings().outbox || []).flatMap((item) => {
    try {
      const stat = fs.statSync(item.path);
      return stat.isFile() ? [{ ...item, size: stat.size }] : [];
    } catch {
      return []; // Moved or deleted on the PC since it was added.
    }
  });
}

function saveOutbox(outbox) {
  saveSettings({ ...loadSettings(), outbox });
  sendToWindow('outbox-updated', getOutbox());
}

function addToOutbox(filePaths) {
  const outbox = loadSettings().outbox || [];
  const known = new Set(outbox.map((item) => item.path));
  const added = [];
  for (const filePath of filePaths) {
    if (!filePath || known.has(filePath)) continue;
    try {
      if (!fs.statSync(filePath).isFile()) continue; // folders aren't supported
    } catch {
      continue;
    }
    known.add(filePath);
    added.push({ id: crypto.randomUUID(), path: filePath, name: path.basename(filePath), addedAt: Date.now() });
  }
  saveOutbox([...added, ...outbox]);
}

function removeOutboxItem(id) {
  saveOutbox((loadSettings().outbox || []).filter((item) => item.id !== id));
}

// --- Text & links ---
function getTexts() {
  return loadSettings().texts || [];
}

function addText(text, from) {
  const entry = { id: crypto.randomUUID(), text, from, at: Date.now() };
  const texts = [entry, ...getTexts()].slice(0, MAX_TEXTS);
  saveSettings({ ...loadSettings(), texts });
  sendToWindow('texts-updated', texts);
  if (from === 'phone') notifyText(text);
  return entry;
}

// --- Thumbnails ---
// Windows' own shell thumbnails, so HEIC and videos work wherever Explorer
// can preview them. Cached by path + modified time.
const thumbnailCache = new Map();

async function getThumbnail(filePath) {
  let key;
  try {
    key = `${filePath}|${fs.statSync(filePath).mtimeMs}`;
  } catch {
    return null;
  }
  if (thumbnailCache.has(key)) {
    const cached = thumbnailCache.get(key);
    thumbnailCache.delete(key);
    thumbnailCache.set(key, cached);
    return cached;
  }
  let jpeg = null;
  try {
    const image = await nativeImage.createThumbnailFromPath(filePath, { width: 240, height: 240 });
    if (!image.isEmpty()) jpeg = image.toJPEG(75);
  } catch {
    // No preview available for this file.
  }
  thumbnailCache.set(key, jpeg);
  if (thumbnailCache.size > THUMBNAIL_CACHE_SIZE) thumbnailCache.delete(thumbnailCache.keys().next().value);
  return jpeg;
}

// --- Windows notifications ---
let batchCounts = { saved: 0, duplicate: 0, lastFolder: null };
let batchTimer = null;

function showNotification(options, onClick) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title: 'PocketDump', ...options });
  if (onClick) notification.on('click', onClick);
  notification.show();
}

function noteUploadForNotification(result) {
  if (result.status === 'saved') {
    batchCounts.saved += 1;
    batchCounts.lastFolder = result.folder;
  } else {
    batchCounts.duplicate += 1;
  }
  clearTimeout(batchTimer);
  batchTimer = setTimeout(() => {
    const { saved, duplicate, lastFolder } = batchCounts;
    batchCounts = { saved: 0, duplicate: 0, lastFolder: null };
    const parts = [];
    if (saved) parts.push(`${saved} file${saved === 1 ? '' : 's'} received`);
    if (duplicate) parts.push(`${duplicate} already on PC`);
    const folderToOpen = saved && lastFolder ? path.join(destinationFolder, lastFolder) : destinationFolder;
    showNotification({ body: `${parts.join(', ')}. Click to open the folder.` }, () => {
      if (folderToOpen) shell.openPath(folderToOpen);
    });
  }, BATCH_NOTIFY_DELAY_MS);
}

function notifyText(text) {
  const preview = text.length > 120 ? `${text.slice(0, 117)}…` : text;
  showNotification({ title: 'Text from iPhone', body: `${preview}\nClick to copy.` }, () => {
    clipboard.writeText(text);
  });
}

// Stable random id for this PC, so the phone can remember which PC it last
// picked even if that PC's IP address changes.
function getPcId() {
  const settings = loadSettings();
  if (settings.pcId) return settings.pcId;
  const pcId = crypto.randomUUID();
  saveSettings({ ...settings, pcId });
  return pcId;
}

function getPcInfo() {
  return {
    id: getPcId(),
    hostname: os.hostname(),
    nickname: loadSettings().nickname || ''
  };
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

// The QR also carries this PC's id and pairing PIN (after the #, so it's
// never sent over the network): scanning it pairs the phone with this PC
// and picks it as the one to send to, with nothing to type.
async function buildServerInfo(address) {
  const host = address === 'mdns' ? MDNS_HOST : address;
  const url = `http://${host}:${PORT}`;
  const qrDataUrl = await QRCode.toDataURL(`${url}/#pair=${getPcId()}.${getPairing().pin}`);
  return { url, qrDataUrl, address };
}

async function sendServerInfo(address) {
  currentAddress = address;
  const candidates = listIPv4Candidates();
  // Offered first, ahead of specific IPs, when mDNS is up — this is the
  // address that keeps working across networks/PCs without a fresh QR scan.
  if (mdnsAvailable) {
    candidates.unshift({ name: `${MDNS_HOST} — name link (recommended)`, address: 'mdns' });
  }
  const info = await buildServerInfo(address);
  mainWindow.webContents.send('server-info', { ...info, candidates });
}

function startMdns() {
  try {
    bonjourInstance = new Bonjour({}, (err) => {
      console.error('mDNS error:', err);
    });
    mdnsAvailable = true;
    publishMdnsName();
    mdnsTakeoverTimer = setInterval(checkMdnsTakeover, MDNS_TAKEOVER_CHECK_MS);
    startPeerDiscovery();
  } catch (err) {
    console.error('Could not start mDNS — pocketdump.local will be unavailable:', err);
    mdnsAvailable = false;
  }
}

function publishMdnsName() {
  const service = bonjourInstance.publish({ name: 'PocketDump', type: 'http', port: PORT, host: MDNS_HOST });
  // If another device (or a second copy of PocketDump) already answers to
  // this name, bonjour-service just logs and gives up — 'up' never fires
  // and pocketdump.local would reach that other device or nothing. Treat a
  // missing 'up' as a conflict and stop offering the address.
  mdnsProbeTimer = setTimeout(onMdnsUnavailable, MDNS_PROBE_TIMEOUT_MS);
  service.once('up', () => {
    clearTimeout(mdnsProbeTimer);
    if (!mdnsAvailable) onMdnsAvailable();
  });
}

function refreshServerInfo(address) {
  // Nothing sent to the window yet — startup reads mdnsAvailable directly.
  if (!currentAddress || !mainWindow || mainWindow.isDestroyed()) return;
  sendServerInfo(address).catch((err) => console.error('Could not refresh server info:', err));
}

function onMdnsUnavailable() {
  console.error(`mDNS: ${MDNS_HOST} is already in use on this network — hiding it from the address list.`);
  mdnsAvailable = false;
  refreshServerInfo(currentAddress === 'mdns' ? pickBestCandidate(listIPv4Candidates()).address : currentAddress);
}

function onMdnsAvailable() {
  console.log(`mDNS: took over ${MDNS_HOST}.`);
  mdnsAvailable = true;
  refreshServerInfo(currentAddress);
}

// Asks the network who currently answers to pocketdump.local. Our own
// failed publish has already been torn down, so any answer is another PC.
function isMdnsNameTaken(timeoutMs) {
  return new Promise((resolve) => {
    const mdns = bonjourInstance.server.mdns;
    const onResponse = (packet) => {
      const answered = packet.answers.concat(packet.additionals)
        .some((rr) => rr.type === 'A' && String(rr.name).toLowerCase() === MDNS_HOST);
      if (answered) done(true);
    };
    const done = (taken) => {
      clearTimeout(timer);
      mdns.removeListener('response', onResponse);
      resolve(taken);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    mdns.on('response', onResponse);
    mdns.query({ questions: [{ name: MDNS_HOST, type: 'A' }] });
  });
}

// When the PC holding pocketdump.local quits, another PocketDump PC on the
// same network takes the name over, so the phone's single home-screen link
// keeps working. Checks with a plain query first rather than re-publishing
// blindly, which would log a conflict every time the holder is still there.
async function checkMdnsTakeover() {
  if (!bonjourInstance || mdnsAvailable || mdnsTakeoverChecking) return;
  mdnsTakeoverChecking = true;
  try {
    // A random pause first, so two PCs that noticed the holder leave at the
    // same moment don't both grab the name at once — the later one sees
    // the earlier one's claim and backs off.
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 5000));
    if (!bonjourInstance || mdnsAvailable) return;
    if (!(await isMdnsNameTaken(2000)) && bonjourInstance && !mdnsAvailable) publishMdnsName();
  } finally {
    mdnsTakeoverChecking = false;
  }
}

// Every PC announces itself under its own unique name and listens for the
// others. The phone gets this list from whichever PC it's connected to via
// /peers, then asks each PC directly for its current name and nickname.
function startPeerDiscovery() {
  const pcId = getPcId();
  bonjourInstance.publish({
    name: `PocketDump-${pcId.slice(0, 8)}`,
    type: PEER_SERVICE_TYPE,
    port: PORT,
    txt: { id: pcId }
  });

  peerBrowser = bonjourInstance.find({ type: PEER_SERVICE_TYPE });
  const onPeer = (service) => {
    const id = service.txt && service.txt.id;
    if (!id || id === pcId) return;
    const addresses = [service.referer && service.referer.address, ...(service.addresses || [])]
      .filter((a) => a && /^\d+\.\d+\.\d+\.\d+$/.test(a));
    if (addresses.length === 0) return;
    peers.set(id, { id, address: addresses[0], port: service.port || PORT, fqdn: service.fqdn });
  };
  peerBrowser.on('up', onPeer);
  peerBrowser.on('srv-update', onPeer);
  peerBrowser.on('txt-update', onPeer);
  peerBrowser.on('down', (service) => {
    for (const [id, peer] of peers) {
      if (peer.fqdn === service.fqdn) peers.delete(id);
    }
  });
  // The browser only hears announcements as they happen; re-asking now and
  // then catches PCs whose announcement was missed.
  peerRefreshTimer = setInterval(() => peerBrowser && peerBrowser.update(), PEER_REFRESH_MS);
}

// This PC first, then every other PocketDump PC seen on the network. Entries
// can be stale (a PC that crashed without saying goodbye) — the phone checks
// each one is actually reachable before listing it.
function getPeers() {
  const self = { id: getPcId(), address: pickBestCandidate(listIPv4Candidates()).address, port: PORT, self: true };
  return [self, ...Array.from(peers.values(), ({ id, address, port }) => ({ id, address, port, self: false }))];
}

function stopMdns() {
  clearTimeout(mdnsProbeTimer);
  clearInterval(mdnsTakeoverTimer);
  clearInterval(peerRefreshTimer);
  if (peerBrowser) {
    peerBrowser.stop();
    peerBrowser = null;
  }
  if (!bonjourInstance) return;
  // Grab a stable reference before clearing the module-level one — the
  // unpublishAll callback fires asynchronously, after bonjourInstance has
  // already been reset to null, so closing over that variable directly
  // would call .destroy() on null.
  const instance = bonjourInstance;
  bonjourInstance = null;
  instance.unpublishAll(() => instance.destroy());
}

// Quick, window-free ways to send something from the tray — matches how
// the app is mostly used (tray-first, main window rarely opened).
async function sendFileFromTray() {
  const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
  if (!result.canceled) addToOutbox(result.filePaths);
}

let quickTextWindow = null;
function openQuickTextWindow() {
  if (quickTextWindow && !quickTextWindow.isDestroyed()) {
    quickTextWindow.show();
    quickTextWindow.focus();
    return;
  }
  quickTextWindow = new BrowserWindow({
    width: 380,
    height: 180,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    title: 'Quick Text to iPhone',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'quicktext', 'preload.js')
    }
  });
  quickTextWindow.setMenuBarVisibility(false);
  quickTextWindow.loadFile(path.join(__dirname, 'quicktext', 'index.html'));
  quickTextWindow.on('closed', () => { quickTextWindow = null; });
}

ipcMain.handle('quick-text-send', (event, text) => {
  const clean = String(text || '').trim().slice(0, 10_000);
  if (clean) addText(clean, 'pc');
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});

function rebuildTrayMenu() {
  const startAtLogin = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open PocketDump', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    { label: '📤 Send File to iPhone…', click: () => sendFileFromTray() },
    { label: '💬 Quick Text to iPhone…', click: () => openQuickTextWindow() },
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
    resizable: true,
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Both dimensions are now free to drag — the renderer's card layout is a
  // CSS grid that reflows into more columns as the window gets wider
  // (style.css), so widening it is a real alternative to scrolling, not
  // just empty space. Whatever size the user drags to is remembered below
  // and reused on the next launch. A generous minimum keeps a card from
  // ever getting too cramped to use; the maximum is the screen itself.
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  mainWindow.setMinimumSize(360, 300);
  mainWindow.setMaximumSize(workArea.width, workArea.height);
  let resizeSaveTimer = null;
  mainWindow.on('resize', () => {
    clearTimeout(resizeSaveTimer);
    resizeSaveTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const [width, height] = mainWindow.getContentSize();
      saveSettings({ ...loadSettings(), windowWidth: width, windowHeight: height });
    }, 500);
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
  cleanupTemp(destinationFolder);

  const maxHeight = screen.getPrimaryDisplay().workAreaSize.height - 60;
  const maxWidth = screen.getPrimaryDisplay().workAreaSize.width;
  if (settings.windowHeight && Number.isFinite(settings.windowHeight)) {
    // The user has already dragged the window to a size they like —
    // respect it instead of re-measuring and possibly shrinking it back
    // down (still re-clamped to the current screen, in case this launch is
    // on a smaller display than where it was last resized).
    const width = Math.min(Math.max(360, settings.windowWidth || 480), maxWidth);
    mainWindow.setContentSize(width, Math.min(Math.max(300, settings.windowHeight), maxHeight));
  } else {
    // First run (or no saved height yet): fit the window to whichever state
    // is currently showing — a returning user with folders already chosen
    // sees an extra "Open folder" row that an empty-state layout doesn't
    // have, so a fixed guess drifts out of sync with the content. Measuring
    // the actual rendered height and sizing to it stays correct regardless.
    // The short wait lets the renderer finish handling the folder-info IPC
    // messages just sent above before layout is measured. Falls back to the
    // constructor's default height if measurement fails for any reason —
    // never worth leaving the window unshown over a sizing nicety.
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const contentHeight = await mainWindow.webContents.executeJavaScript('document.body.scrollHeight');
      const targetHeight = Math.min(Math.ceil(contentHeight), maxHeight);
      mainWindow.setContentSize(480, targetHeight);
    } catch (err) {
      console.error('Could not auto-size window to content:', err);
    }
  }

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
    certOptions = await getOrCreateCert(app.getPath('userData'), certAddresses);
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
    getPcInfo,
    getPeers,
    auth: { isValidToken, pair: pairDevice },
    getOutbox,
    removeOutboxItem,
    getTexts,
    addText,
    getThumbnail,
    onUpload: (info) => {
      sendToWindow('upload-event', info);
      noteUploadForNotification(info);
    },
    // The phone side has no equivalent "receiving…" feedback for a PC→phone
    // transfer, and until now neither did the Status card here — a file
    // sent to the outbox just silently vanished once downloaded, with
    // nothing in the log to confirm it actually reached the phone.
    onOutboxSent: (item) => {
      sendToWindow('upload-event', { name: item.name, status: 'sent' });
    }
  });

  const candidates = listIPv4Candidates();
  const best = pickBestCandidate(candidates);
  await sendServerInfo(mdnsAvailable ? 'mdns' : best.address);
}

ipcMain.handle('toggle-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});

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
  cleanupTemp(destinationFolder);
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

ipcMain.handle('get-pairing-info', () => getPairingInfo());

// New PIN, and every phone paired so far has to pair again.
ipcMain.handle('reset-pairing', async () => {
  saveSettings({ ...loadSettings(), pin: newPin(), devices: [] });
  if (currentAddress) await sendServerInfo(currentAddress);
  return getPairingInfo();
});

ipcMain.handle('get-outbox', () => getOutbox());

ipcMain.handle('add-outbox-files', (_event, filePaths) => {
  addToOutbox(Array.isArray(filePaths) ? filePaths.map(String) : []);
});

ipcMain.handle('choose-outbox-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] });
  if (!result.canceled) addToOutbox(result.filePaths);
});

ipcMain.handle('remove-outbox-item', (_event, id) => removeOutboxItem(id));

ipcMain.handle('clear-outbox', () => saveOutbox([]));

ipcMain.handle('get-texts', () => getTexts());

ipcMain.handle('send-text', (_event, text) => {
  const clean = String(text || '').trim().slice(0, 10_000);
  if (clean) addText(clean, 'pc');
});

ipcMain.handle('clear-texts', () => {
  saveSettings({ ...loadSettings(), texts: [] });
  sendToWindow('texts-updated', []);
});

ipcMain.handle('copy-text', (_event, text) => clipboard.writeText(String(text || '')));

ipcMain.handle('open-link', (_event, url) => {
  if (/^https?:\/\//i.test(String(url))) shell.openExternal(String(url));
});

ipcMain.handle('get-pc-info', () => getPcInfo());

// Shown on every phone next to this PC's Windows name. Blank clears it.
ipcMain.handle('set-nickname', (_event, nickname) => {
  const clean = String(nickname || '').trim().slice(0, 40);
  saveSettings({ ...loadSettings(), nickname: clean });
  return getPcInfo();
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
  // Matches the installer's shortcut, so Windows attributes notifications
  // to PocketDump (not "Electron").
  app.setAppUserModelId('com.alexkim.pocketdump');

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
  // Also covers quitting to install an update, which may not get as far
  // as window-all-closed.
  flushManifests();
});

app.on('window-all-closed', () => {
  if (!gotSingleInstanceLock) return;
  if (serverInstance) stopServer(serverInstance);
  stopMdns();
  if (process.platform !== 'darwin') app.quit();
});
