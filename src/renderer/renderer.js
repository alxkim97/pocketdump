const chooseFolderBtn = document.getElementById('choose-folder');
const openFolderBtn = document.getElementById('open-folder');
const folderPathEl = document.getElementById('folder-path');
const chooseSourceFolderBtn = document.getElementById('choose-source-folder');
const openSourceFolderBtn = document.getElementById('open-source-folder');
const sourceFolderPathEl = document.getElementById('source-folder-path');
const qrEl = document.getElementById('qr');
const serverUrlEl = document.getElementById('server-url');
const networkSelectEl = document.getElementById('network-select');
const networkHintEl = document.getElementById('network-hint');
const connectionHelpEl = document.getElementById('connection-help');
const statusDotEl = document.getElementById('status-dot');
const statusTextEl = document.getElementById('status-text');
const uploadLogEl = document.getElementById('upload-log');
const themeToggleBtn = document.getElementById('theme-toggle');
const footerTextEl = document.getElementById('app-footer-text');
const checkUpdatesBtn = document.getElementById('check-updates-btn');
const pcHostnameEl = document.getElementById('pc-hostname');
const nicknameInputEl = document.getElementById('nickname-input');
const saveNicknameBtn = document.getElementById('save-nickname');
const nicknameStatusEl = document.getElementById('nickname-status');

window.pocketdump.getPcInfo().then(({ hostname, nickname }) => {
  pcHostnameEl.textContent = hostname;
  nicknameInputEl.value = nickname;
});

async function saveNickname() {
  const { nickname } = await window.pocketdump.setNickname(nicknameInputEl.value);
  nicknameInputEl.value = nickname;
  nicknameStatusEl.textContent = nickname
    ? `Saved — your iPhone will show "${nickname}" next time it opens PocketDump.`
    : 'Nickname cleared — your iPhone will show the Windows name.';
}

saveNicknameBtn.addEventListener('click', saveNickname);
nicknameInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveNickname();
});

function showFolder(folder) {
  if (folder) {
    folderPathEl.textContent = folder;
    openFolderBtn.style.display = 'inline';
  } else {
    folderPathEl.textContent = 'No folder selected yet';
    openFolderBtn.style.display = 'none';
  }
}

chooseFolderBtn.addEventListener('click', async () => {
  const folder = await window.pocketdump.chooseFolder();
  showFolder(folder);
});

openFolderBtn.addEventListener('click', () => {
  window.pocketdump.openFolder();
});

window.pocketdump.onFolderInfo(({ folder }) => {
  showFolder(folder);
});

function showSourceFolder(folder) {
  if (folder) {
    sourceFolderPathEl.textContent = folder;
    openSourceFolderBtn.style.display = 'inline';
  } else {
    sourceFolderPathEl.textContent = 'No folder shared yet';
    openSourceFolderBtn.style.display = 'none';
  }
}

chooseSourceFolderBtn.addEventListener('click', async () => {
  const folder = await window.pocketdump.chooseSourceFolder();
  showSourceFolder(folder);
});

openSourceFolderBtn.addEventListener('click', () => {
  window.pocketdump.openSourceFolder();
});

window.pocketdump.onSourceFolderInfo(({ folder }) => {
  showSourceFolder(folder);
});

// --- Pairing ---
const pairingPinEl = document.getElementById('pairing-pin');
const pairingCountEl = document.getElementById('pairing-count');
const resetPairingBtn = document.getElementById('reset-pairing');

function showPairingInfo({ pin, deviceCount }) {
  pairingPinEl.textContent = pin;
  pairingCountEl.textContent = deviceCount
    ? `${deviceCount} phone${deviceCount === 1 ? '' : 's'} paired`
    : 'No phones paired yet';
  resetPairingBtn.style.display = deviceCount ? 'inline' : 'none';
}

window.pocketdump.getPairingInfo().then(showPairingInfo);
window.pocketdump.onPairingInfo(showPairingInfo);

resetPairingBtn.addEventListener('click', async () => {
  if (!confirm('Unpair every phone and make a new PIN? Each phone will need to scan the QR code or enter the new PIN again.')) return;
  showPairingInfo(await window.pocketdump.resetPairing());
});

// --- Send to iPhone (outbox) ---
const outboxCardEl = document.getElementById('outbox-card');
const outboxListEl = document.getElementById('outbox-list');
const clearOutboxBtn = document.getElementById('clear-outbox');

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function renderOutbox(items) {
  outboxListEl.innerHTML = '';
  items.forEach((item) => {
    const li = document.createElement('li');
    const main = document.createElement('span');
    main.className = 'item-main';
    main.textContent = item.name;
    const meta = document.createElement('span');
    meta.className = 'item-meta';
    meta.textContent = formatSize(item.size);
    main.appendChild(meta);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'plain';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => window.pocketdump.removeOutboxItem(item.id));
    li.append(main, remove);
    outboxListEl.appendChild(li);
  });
  clearOutboxBtn.style.display = items.length ? 'inline' : 'none';
}

window.pocketdump.getOutbox().then(renderOutbox);
window.pocketdump.onOutboxUpdated(renderOutbox);
document.getElementById('choose-outbox').addEventListener('click', () => window.pocketdump.chooseOutboxFiles());
clearOutboxBtn.addEventListener('click', () => window.pocketdump.clearOutbox());

// Anywhere in the window accepts a drop (so a near miss doesn't make the
// window navigate to the file); the card lights up while dragging.
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth += 1;
  outboxCardEl.classList.add('dragging');
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) outboxCardEl.classList.remove('dragging');
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  outboxCardEl.classList.remove('dragging');
  if (e.dataTransfer.files.length) window.pocketdump.addOutboxFiles(e.dataTransfer.files);
});

// --- Text & links ---
const textInputEl = document.getElementById('text-input');
const textListEl = document.getElementById('text-list');
const clearTextsBtn = document.getElementById('clear-texts');

function formatTime(ts) {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function renderTexts(texts) {
  textListEl.innerHTML = '';
  texts.forEach((entry) => {
    const li = document.createElement('li');
    const main = document.createElement('span');
    main.className = 'item-main';
    main.textContent = entry.text;
    const meta = document.createElement('span');
    meta.className = 'item-meta';
    meta.textContent = `${entry.from === 'phone' ? 'From iPhone' : 'Sent to iPhone'} · ${formatTime(entry.at)}`;
    main.appendChild(meta);
    li.appendChild(main);
    if (/^https?:\/\/\S+$/i.test(entry.text)) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'plain';
      open.textContent = 'Open';
      open.addEventListener('click', () => window.pocketdump.openLink(entry.text));
      li.appendChild(open);
    }
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      await window.pocketdump.copyText(entry.text);
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
    });
    li.appendChild(copy);
    textListEl.appendChild(li);
  });
  clearTextsBtn.style.display = texts.length ? 'inline' : 'none';
}

async function sendText() {
  const text = textInputEl.value.trim();
  if (!text) return;
  await window.pocketdump.sendText(text);
  textInputEl.value = '';
}

window.pocketdump.getTexts().then(renderTexts);
window.pocketdump.onTextsUpdated(renderTexts);
document.getElementById('send-text').addEventListener('click', sendText);
textInputEl.addEventListener('keydown', (e) => {
  // Enter sends; Shift+Enter adds a line.
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendText();
  }
});
clearTextsBtn.addEventListener('click', () => window.pocketdump.clearTexts());

window.pocketdump.onServerInfo(({ url, qrDataUrl, address, candidates }) => {
  qrEl.src = qrDataUrl;
  serverUrlEl.textContent = url;

  if (candidates && candidates.length) {
    networkSelectEl.innerHTML = '';
    candidates.forEach((c) => {
      const option = document.createElement('option');
      option.value = c.address;
      option.textContent = c.address === 'mdns' ? c.name : `${c.address} (${c.name})`;
      if (c.address === address) option.selected = true;
      networkSelectEl.appendChild(option);
    });
    // pocketdump.local isn't available (name taken or mDNS failed), so the
    // QR is an IP that may not be the right one — show the choices.
    if (!candidates.some((c) => c.address === 'mdns')) connectionHelpEl.open = true;
  }
  updateNetworkHint();
});

// One plain-language line explaining whichever choice is selected.
function updateNetworkHint() {
  const value = networkSelectEl.value;
  if (!value) {
    networkHintEl.textContent = '';
  } else if (value === 'mdns') {
    networkHintEl.textContent = "Finds this PC by name, so the link keeps working even if the PC's address changes. Your iPhone must be on the same WiFi.";
  } else {
    networkHintEl.textContent = `Connects straight to this PC's address (${value}). Use it if the name link won't load — it may stop working if your router gives the PC a new address.`;
  }
}

networkSelectEl.addEventListener('change', () => {
  updateNetworkHint();
  window.pocketdump.selectNetwork(networkSelectEl.value);
});

let idleTimer = null;
window.pocketdump.onUploadEvent((item) => {
  statusDotEl.classList.add('active');
  statusTextEl.textContent = item.status === 'saved'
    ? `Receiving… ${item.name} → ${item.folder}`
    : `Receiving… ${item.name} (already on PC, skipped)`;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    statusDotEl.classList.remove('active');
    statusTextEl.textContent = 'Idle — waiting for your iPhone';
  }, 2500);

  const li = document.createElement('li');
  li.className = item.status;
  li.textContent = item.status === 'saved'
    ? `${item.name} → ${item.folder}`
    : `${item.name} (already imported, skipped)`;
  uploadLogEl.prepend(li);
});

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggleBtn.textContent = theme === 'dark' ? '☀️' : '🌙';
  themeToggleBtn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
}

// Follows Windows' light/dark setting until the toggle is used once.
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const storedTheme = localStorage.getItem('pocketdump-theme');
applyTheme(storedTheme || (systemDark.matches ? 'dark' : 'light'));
systemDark.addEventListener('change', (e) => {
  if (!localStorage.getItem('pocketdump-theme')) applyTheme(e.matches ? 'dark' : 'light');
});

themeToggleBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('pocketdump-theme', next);
  applyTheme(next);
});

window.pocketdump.getAppInfo().then(({ version, credit }) => {
  footerTextEl.textContent = `PocketDump v${version} · Built by ${credit}`;
});

checkUpdatesBtn.addEventListener('click', () => {
  window.pocketdump.checkForUpdates();
});
