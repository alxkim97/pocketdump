const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MANIFEST_NAME = '.pocketdump-manifest.json';
const META_KEY = '__meta';

function loadManifest(folder) {
  const manifestPath = path.join(folder, MANIFEST_NAME);
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return {};
  }
}

function saveManifest(folder, manifest) {
  const manifestPath = path.join(folder, MANIFEST_NAME);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
}

function dateFolderName(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// file.originalname comes straight from the client and is otherwise
// attacker-controlled (e.g. "../../../Startup/evil.exe") — strip it down
// to a bare filename before it ever touches the filesystem.
function sanitizeFileName(name) {
  const base = path.basename(String(name || ''));
  if (!base || base === '.' || base === '..') return `file-${Date.now()}`;
  return base;
}

function uniqueFilePath(dir, fileName) {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let candidate = fileName;
  let counter = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base}-${counter}${ext}`;
    counter += 1;
  }
  return path.join(dir, candidate);
}

function startServer({ port, getDestinationFolder, onUpload }) {
  const app = express();
  const upload = multer({ storage: multer.memoryStorage() });

  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'mobile', 'upload.html'));
  });

  app.post('/upload', upload.single('file'), (req, res) => {
    const destinationFolder = getDestinationFolder();
    if (!destinationFolder) {
      return res.status(400).json({ error: 'No destination folder selected on PC yet.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file received.' });
    }

    const file = req.file;
    const safeName = sanitizeFileName(file.originalname);
    const lastModified = Number(req.body.lastModified) || Date.now();
    const hash = crypto.createHash('sha1').update(file.buffer).digest('hex');
    const manifest = loadManifest(destinationFolder);

    let result;
    if (manifest[hash]) {
      result = { name: safeName, status: 'duplicate', size: file.size };
    } else {
      const folderName = dateFolderName(lastModified);
      const targetDir = path.join(destinationFolder, folderName);
      fs.mkdirSync(targetDir, { recursive: true });

      const targetPath = uniqueFilePath(targetDir, safeName);
      fs.writeFileSync(targetPath, file.buffer);

      manifest[hash] = {
        path: path.relative(destinationFolder, targetPath),
        name: safeName,
        size: file.size,
        lastModified
      };

      result = { name: safeName, status: 'saved', folder: folderName, size: file.size };
    }

    manifest[META_KEY] = { lastSyncAt: Date.now() };
    saveManifest(destinationFolder, manifest);

    if (onUpload) onUpload(result);
    res.json(result);
  });

  // Lets the phone show "last synced X ago" and pre-skip files it already
  // sent, without uploading the full file just to discover that via hash.
  app.get('/sync-info', (req, res) => {
    const destinationFolder = getDestinationFolder();
    if (!destinationFolder) {
      return res.json({ lastSyncAt: null, count: 0, signatures: [] });
    }

    const manifest = loadManifest(destinationFolder);
    const meta = manifest[META_KEY] || {};
    const signatures = [];
    let count = 0;

    for (const [key, value] of Object.entries(manifest)) {
      if (key === META_KEY) continue;
      count += 1;
      if (value && typeof value === 'object' && value.name && value.size != null && value.lastModified != null) {
        signatures.push(`${value.name}|${value.size}|${value.lastModified}`);
      }
    }

    res.json({ lastSyncAt: meta.lastSyncAt || null, count, signatures });
  });

  // Catches uploads interrupted mid-transfer (e.g. the phone's screen locks
  // and Safari drops the connection) so they fail quietly instead of crashing
  // the app with an unhandled "Request aborted" error.
  app.use((err, req, res, next) => {
    if (req.aborted) return;
    if (!res.headersSent) res.status(400).json({ error: 'Upload interrupted.' });
  });

  const server = app.listen(port);
  return server;
}

function stopServer(server) {
  server.close();
}

// Walks the destination folder and rebuilds the dedupe manifest from scratch,
// keyed by content hash. Useful after manually moving/renaming files, since
// the manifest otherwise only tracks files PocketDump itself has written.
function rebuildIndex(folder) {
  const existing = loadManifest(folder);
  const manifest = {};
  if (existing[META_KEY]) manifest[META_KEY] = existing[META_KEY];
  let count = 0;

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === MANIFEST_NAME) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        const buffer = fs.readFileSync(fullPath);
        const hash = crypto.createHash('sha1').update(buffer).digest('hex');
        const stat = fs.statSync(fullPath);
        manifest[hash] = {
          path: path.relative(folder, fullPath),
          name: entry.name,
          size: stat.size,
          lastModified: stat.mtimeMs
        };
        count += 1;
      }
    }
  }

  walk(folder);
  saveManifest(folder, manifest);
  return count;
}

module.exports = { startServer, stopServer, rebuildIndex };
