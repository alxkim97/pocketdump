const chooseFolderBtn = document.getElementById('choose-folder');
const openFolderBtn = document.getElementById('open-folder');
const folderPathEl = document.getElementById('folder-path');
const chooseSourceFolderBtn = document.getElementById('choose-source-folder');
const openSourceFolderBtn = document.getElementById('open-source-folder');
const sourceFolderPathEl = document.getElementById('source-folder-path');
const qrEl = document.getElementById('qr');
const serverUrlEl = document.getElementById('server-url');
const networkSelectEl = document.getElementById('network-select');
const statusDotEl = document.getElementById('status-dot');
const statusTextEl = document.getElementById('status-text');
const uploadLogEl = document.getElementById('upload-log');
const themeToggleBtn = document.getElementById('theme-toggle');
const footerEl = document.getElementById('app-footer');
const rebuildBtn = document.getElementById('rebuild-index');
const rebuildStatusEl = document.getElementById('rebuild-status');

function showFolder(folder) {
  if (folder) {
    folderPathEl.textContent = folder;
    openFolderBtn.style.display = 'inline';
    rebuildBtn.style.display = 'inline';
  } else {
    folderPathEl.textContent = 'No folder selected yet';
    openFolderBtn.style.display = 'none';
    rebuildBtn.style.display = 'none';
  }
}

chooseFolderBtn.addEventListener('click', async () => {
  const folder = await window.pocketdump.chooseFolder();
  showFolder(folder);
  rebuildStatusEl.textContent = '';
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

rebuildBtn.addEventListener('click', async () => {
  rebuildBtn.disabled = true;
  rebuildStatusEl.textContent = 'Scanning folder…';
  const result = await window.pocketdump.rebuildIndex();
  rebuildBtn.disabled = false;
  rebuildStatusEl.textContent = result.error
    ? result.error
    : `Indexed ${result.count} file(s) — duplicates will now be detected even if moved or renamed.`;
});

window.pocketdump.onServerInfo(({ url, qrDataUrl, address, candidates }) => {
  qrEl.src = qrDataUrl;
  serverUrlEl.textContent = url;

  if (candidates && candidates.length) {
    networkSelectEl.innerHTML = '';
    candidates.forEach((c) => {
      const option = document.createElement('option');
      option.value = c.address;
      option.textContent = `${c.address} (${c.name})`;
      if (c.address === address) option.selected = true;
      networkSelectEl.appendChild(option);
    });
  }
});

networkSelectEl.addEventListener('change', () => {
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

const storedTheme = localStorage.getItem('pocketdump-theme') || 'light';
applyTheme(storedTheme);

themeToggleBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('pocketdump-theme', next);
  applyTheme(next);
});

window.pocketdump.getAppInfo().then(({ version, credit }) => {
  footerEl.textContent = `PocketDump v${version} · Built by ${credit}`;
});
