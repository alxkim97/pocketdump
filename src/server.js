const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MANIFEST_NAME = '.pocketdump-manifest.json';

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
    const hash = crypto.createHash('sha1').update(file.buffer).digest('hex');
    const manifest = loadManifest(destinationFolder);

    let result;
    if (manifest[hash]) {
      result = { name: file.originalname, status: 'duplicate', size: file.size };
    } else {
      const lastModified = Number(req.body.lastModified) || Date.now();
      const folderName = dateFolderName(lastModified);
      const targetDir = path.join(destinationFolder, folderName);
      fs.mkdirSync(targetDir, { recursive: true });

      const targetPath = uniqueFilePath(targetDir, file.originalname);
      fs.writeFileSync(targetPath, file.buffer);

      manifest[hash] = path.relative(destinationFolder, targetPath);
      saveManifest(destinationFolder, manifest);

      result = { name: file.originalname, status: 'saved', folder: folderName, size: file.size };
    }

    if (onUpload) onUpload(result);
    res.json(result);
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
  const manifest = {};
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
        manifest[hash] = path.relative(folder, fullPath);
        count += 1;
      }
    }
  }

  walk(folder);
  saveManifest(folder, manifest);
  return count;
}

module.exports = { startServer, stopServer, rebuildIndex };
