const express = require('express');
const multer = require('multer');
const fs = require('fs');
const http = require('http');
const https = require('https');
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

// Resolves a client-supplied relative path against `base` and refuses
// anything that escapes it (e.g. "../../Windows/System32") before it's
// ever passed to fs. Returns null for anything unsafe.
function resolveSafePath(base, relPath) {
  const target = path.resolve(base, relPath || '.');
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

function isPrivateIPv4(host) {
  return /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

// Only another PocketDump page may call this PC from a different origin —
// i.e. the phone page served by a different PocketDump PC, reached as
// pocketdump.local or a LAN IP on the PocketDump ports. Any other website
// open on the phone still can't read this PC's shared folder.
function isPocketDumpOrigin(origin, ports) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (!ports.includes(url.port)) return false;
  return url.hostname === 'pocketdump.local' || isPrivateIPv4(url.hostname);
}

function startServer({ port, httpsPort, certOptions, appVersion, getDestinationFolder, getSourceFolder, getPcInfo, getPeers, onUpload }) {
  const app = express();
  const upload = multer({ storage: multer.memoryStorage() });
  const pocketDumpPorts = [String(port), String(httpsPort)];

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && isPocketDumpOrigin(origin, pocketDumpPorts)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'GET, POST');
        res.set('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '');
        // Chromium-based browsers ask this before a public-looking page may
        // reach a LAN address; Safari ignores it.
        res.set('Access-Control-Allow-Private-Network', 'true');
        return res.sendStatus(204);
      }
    }
    next();
  });

  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'mobile', 'index.html'));
  });

  // Lets the mobile page discover the HTTPS port for the live-camera view
  // without hardcoding it in two places.
  app.get('/config', (req, res) => {
    res.json({ port, httpsPort: certOptions ? httpsPort : null, version: appVersion || null });
  });

  // Who this PC is — its Windows name and the nickname set in the PC app.
  // The phone asks every PC directly, so a nickname change shows up on the
  // next page load without waiting on the network announcements.
  app.get('/whoami', (req, res) => {
    res.json({ ...getPcInfo(), version: appVersion || null });
  });

  // Every PocketDump PC this one knows about on the network, itself first.
  app.get('/peers', (req, res) => {
    res.json({ peers: getPeers() });
  });

  // Serves the self-signed CA cert for the phone to download and install as
  // a trusted profile — the one-time step that unlocks the live camera view
  // (getUserMedia needs a secure context, which a plain-HTTP LAN address
  // isn't). Served over the plain HTTP listener so there's no trust
  // chicken-and-egg problem fetching it in the first place.
  app.get('/cert', (req, res) => {
    if (!certOptions) return res.status(404).json({ error: 'HTTPS is not set up.' });
    res.set('Content-Type', 'application/x-x509-ca-cert');
    res.set('Content-Disposition', 'attachment; filename="pocketdump-ca.pem"');
    res.send(certOptions.cert);
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

  // Lets the phone list the contents of the folder the PC is sharing, one
  // level at a time, so it can be browsed like a file picker.
  app.get('/browse', (req, res) => {
    const sourceFolder = getSourceFolder();
    if (!sourceFolder) {
      return res.status(400).json({ error: 'No folder shared from PC yet.' });
    }

    const target = resolveSafePath(sourceFolder, req.query.dir);
    if (!target) return res.status(400).json({ error: 'Invalid path.' });

    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      return res.status(404).json({ error: 'Folder not found.' });
    }
    if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a folder.' });

    const entries = fs
      .readdirSync(target, { withFileTypes: true })
      .filter((entry) => entry.name !== MANIFEST_NAME && !entry.name.startsWith('.'))
      .map((entry) => {
        const entryPath = path.join(target, entry.name);
        const relPath = path.relative(sourceFolder, entryPath).split(path.sep).join('/');
        if (entry.isDirectory()) {
          return { name: entry.name, type: 'dir', path: relPath };
        }
        const entryStat = fs.statSync(entryPath);
        return { name: entry.name, type: 'file', path: relPath, size: entryStat.size };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    const relDir = path.relative(sourceFolder, target).split(path.sep).join('/');
    res.json({ dir: relDir, entries });
  });

  // Streams a single file from the shared folder down to the phone as an
  // attachment, so Safari saves it instead of trying to open it inline.
  app.get('/file', (req, res) => {
    const sourceFolder = getSourceFolder();
    if (!sourceFolder) {
      return res.status(400).json({ error: 'No folder shared from PC yet.' });
    }

    const target = resolveSafePath(sourceFolder, req.query.path);
    if (!target) return res.status(400).json({ error: 'Invalid path.' });

    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      return res.status(404).json({ error: 'File not found.' });
    }
    if (!stat.isFile()) return res.status(400).json({ error: 'Not a file.' });

    res.download(target);
  });

  // Catches uploads interrupted mid-transfer (e.g. the phone's screen locks
  // and Safari drops the connection) so they fail quietly instead of crashing
  // the app with an unhandled "Request aborted" error.
  app.use((err, req, res, next) => {
    if (req.aborted) return;
    if (!res.headersSent) res.status(400).json({ error: 'Upload interrupted.' });
  });

  const httpServer = http.createServer(app).listen(port);
  const httpsServer = certOptions ? https.createServer(certOptions, app).listen(httpsPort) : null;
  return { httpServer, httpsServer };
}

function stopServer({ httpServer, httpsServer }) {
  if (httpServer) httpServer.close();
  if (httpsServer) httpsServer.close();
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
