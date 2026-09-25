const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic } = require('./fsutil');

const MANIFEST_NAME = '.pocketdump-manifest.json';
const META_KEY = '__meta';
// Uploads stream into this folder inside the destination (same drive, so
// the final move is an instant rename) and are moved out once complete.
const TMP_DIR_NAME = '.pocketdump-tmp';
const MAX_TEXT_LENGTH = 10_000;
const THUMBNAIL_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif',
  '.mov', '.mp4', '.m4v', '.avi', '.mkv', '.wmv'
]);

// --- Dedupe manifest ---
// Kept in memory once read and written back shortly after changes, instead
// of re-reading and re-writing the whole JSON file for every single upload.
const manifestCache = new Map(); // folder -> { manifest, saveTimer }

function manifestEntry(folder) {
  let entry = manifestCache.get(folder);
  if (!entry) {
    let manifest = {};
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(folder, MANIFEST_NAME), 'utf8'));
    } catch {
      // No manifest yet, or unreadable — start fresh.
    }
    entry = { manifest, saveTimer: null };
    manifestCache.set(folder, entry);
  }
  return entry;
}

function loadManifest(folder) {
  return manifestEntry(folder).manifest;
}

function writeManifestNow(folder) {
  const entry = manifestCache.get(folder);
  if (!entry) return;
  clearTimeout(entry.saveTimer);
  entry.saveTimer = null;
  try {
    writeFileAtomic(path.join(folder, MANIFEST_NAME), JSON.stringify(entry.manifest));
  } catch (err) {
    console.error('Could not save the duplicate index:', err);
  }
}

function saveManifestSoon(folder) {
  const entry = manifestEntry(folder);
  if (entry.saveTimer) return;
  entry.saveTimer = setTimeout(() => writeManifestNow(folder), 500);
}

function flushManifests() {
  for (const folder of manifestCache.keys()) writeManifestNow(folder);
}

function dateFolderName(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// The phone page sends milliseconds; an iOS Shortcut sends the photo's
// creation date as text (ISO 8601, or iOS's "Sep 24, 2026 at 7:38 PM").
function parseLastModified(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = Date.parse(String(value || '').replace(' at ', ' '));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

// file.originalname comes straight from the client and is otherwise
// attacker-controlled (e.g. "../../../Startup/evil.exe") — strip it down
// to a bare filename before it ever touches the filesystem.
function sanitizeFileName(name) {
  const base = path.basename(String(name || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
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

function isInside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// Resolves a client-supplied relative path against `base` and refuses
// anything that escapes it (e.g. "../../Windows/System32") before it's
// ever passed to fs — including via a shortcut, symlink or junction inside
// the shared folder that points somewhere outside it. Returns null for
// anything unsafe; a path that doesn't exist is left for the caller to 404.
function resolveSafePath(base, relPath) {
  const target = path.resolve(base, relPath || '.');
  if (!isInside(base, target)) return null;
  try {
    if (!isInside(fs.realpathSync(base), fs.realpathSync(target))) return null;
  } catch {
    // Missing — the caller's stat reports it.
  }
  return target;
}

function isThumbable(name) {
  return THUMBNAIL_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// Multer storage that streams each upload straight to a temp file on disk
// while hashing it on the way through — nothing is held in memory, so a
// multi-GB video is no different from a photo.
function hashingDiskStorage(getTmpDir) {
  return {
    _handleFile(req, file, cb) {
      let finished = false;
      const done = (err, info) => {
        if (finished) return;
        finished = true;
        cb(err, info);
      };
      const dir = getTmpDir(req);
      fs.mkdir(dir, { recursive: true }, (mkdirErr) => {
        if (mkdirErr) return done(mkdirErr);
        const tmpPath = path.join(dir, `${crypto.randomUUID()}.part`);
        const hash = crypto.createHash('sha1');
        const out = fs.createWriteStream(tmpPath);
        let size = 0;
        // Windows won't delete a file that's still open, so wait for the
        // write stream to close first.
        const fail = (err) => {
          if (finished) return;
          file.stream.unpipe(out);
          const remove = () => fs.rm(tmpPath, { force: true }, () => done(err));
          if (out.closed) remove();
          else {
            out.once('close', remove);
            out.destroy();
          }
        };
        file.stream.on('data', (chunk) => {
          hash.update(chunk);
          size += chunk.length;
        });
        file.stream.on('error', fail);
        out.on('error', fail);
        // The phone dropping the connection mid-file (screen lock, WiFi
        // blip) doesn't always surface as a stream error — don't leave the
        // partial file behind.
        req.once('close', () => {
          if (!finished && !req.complete) fail(Object.assign(new Error('Request aborted'), { code: 'ECONNABORTED' }));
        });
        out.on('finish', () => done(null, { path: tmpPath, size, hash: hash.digest('hex') }));
        file.stream.pipe(out);
      });
    },
    _removeFile(req, file, cb) {
      fs.rm(file.path, { force: true }, () => cb(null));
    }
  };
}

// Leftovers from uploads cut off by a crash or power loss.
function cleanupTemp(folder) {
  if (!folder) return;
  fs.rm(path.join(folder, TMP_DIR_NAME), { recursive: true, force: true }, () => {});
}

function isPrivateIPv4(host) {
  return /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^169\.254\./.test(host)
    // Tailscale / CGNAT range, for reaching the PC over a tailnet.
    || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host);
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

// A request must name this PC the way a phone on the LAN would: a .local
// name, a LAN/loopback IP, or localhost. Blocks DNS rebinding, where a
// website points its own domain at this PC's IP to get around the
// browser's cross-origin rules.
function isAllowedHost(hostHeader) {
  const raw = String(hostHeader || '').toLowerCase();
  if (raw.startsWith('[')) return true; // IPv6 literal — can't come from a rebound domain
  const host = raw.replace(/:\d+$/, '');
  return host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local') || isPrivateIPv4(host);
}

function friendlyError(err) {
  switch (err && err.code) {
    case 'ENOSPC': return "The PC's disk is full.";
    case 'EACCES':
    case 'EPERM': return "PocketDump doesn't have permission to use that folder on the PC.";
    case 'ENOENT': return 'That folder no longer exists on the PC.';
    default: return `Something went wrong on the PC (${(err && (err.code || err.message)) || 'unknown error'}).`;
  }
}

// Wrong PINs: 5 per phone, then that phone waits 5 minutes. 20 across all
// phones within 10 minutes locks pairing for everyone for 5 minutes, so the
// 10,000 possible PINs can't be tried quickly from many addresses either.
function createPairingLimiter() {
  const perIp = new Map();
  let recent = [];
  let globalLockedUntil = 0;
  return {
    lockedFor(ip) {
      const now = Date.now();
      const entry = perIp.get(ip);
      const until = Math.max(globalLockedUntil, entry ? entry.lockedUntil : 0);
      return until > now ? Math.ceil((until - now) / 1000) : 0;
    },
    fail(ip) {
      const now = Date.now();
      const entry = perIp.get(ip) || { count: 0, lockedUntil: 0 };
      entry.count += 1;
      if (entry.count >= 5) {
        entry.count = 0;
        entry.lockedUntil = now + 5 * 60_000;
      }
      perIp.set(ip, entry);
      recent = recent.filter((t) => now - t < 10 * 60_000);
      recent.push(now);
      if (recent.length >= 20) {
        recent = [];
        globalLockedUntil = now + 5 * 60_000;
      }
    },
    succeed(ip) {
      perIp.delete(ip);
    }
  };
}

function startServer({
  port, httpsPort, certOptions, appVersion,
  getDestinationFolder, getSourceFolder, getPcInfo, getPeers,
  auth, getOutbox, removeOutboxItem, getTexts, addText, getThumbnail, onUpload
}) {
  const app = express();
  const upload = multer({
    storage: hashingDiskStorage((req) => path.join(req.destinationFolder, TMP_DIR_NAME))
  });
  const pocketDumpPorts = [String(port), String(httpsPort)];
  const pairingLimiter = createPairingLimiter();

  app.use((req, res, next) => {
    if (!isAllowedHost(req.headers.host)) return res.status(403).json({ error: 'Unknown host.' });
    next();
  });

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

  // Everything that reads or writes files needs a token the phone got by
  // entering this PC's pairing PIN (or scanning its QR code). Sent as ?t=
  // so plain links (downloads, thumbnails, an iOS Shortcut) work too.
  function requireAuth(req, res, next) {
    const token = req.query.t || req.get('X-PocketDump-Token');
    if (token && auth.isValidToken(String(token))) return next();
    res.status(401).json({ error: "This iPhone isn't paired with the PC yet.", needPairing: true });
  }

  function requireDestination(req, res, next) {
    const folder = getDestinationFolder();
    if (!folder) return res.status(400).json({ error: 'No destination folder selected on PC yet.' });
    req.destinationFolder = folder;
    next();
  }

  function requireSource(req, res, next) {
    const folder = getSourceFolder();
    if (!folder) return res.status(400).json({ error: 'No folder shared from PC yet.' });
    req.sourceFolder = folder;
    next();
  }

  app.get('/', (req, res) => {
    // Always re-check, so an updated PocketDump's page shows up right away
    // instead of a stale cached copy.
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, 'mobile', 'index.html'));
  });

  // Keeps the phone's screen awake during long uploads (iOS drops uploads
  // when the screen locks).
  app.get('/nosleep.js', (req, res) => {
    res.sendFile(require.resolve('nosleep.js/dist/NoSleep.min.js'));
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

  // Trades the PIN shown on the PC for a long-lived token the phone keeps.
  app.post('/pair', express.json({ limit: '10kb' }), (req, res) => {
    const ip = req.socket.remoteAddress || 'unknown';
    const wait = pairingLimiter.lockedFor(ip);
    if (wait) {
      return res.status(429).json({ error: `Too many wrong PINs — try again in ${Math.ceil(wait / 60)} min.` });
    }
    const body = req.body || {};
    const token = auth.pair(String(body.pin || ''), String(body.device || '').slice(0, 80));
    if (!token) {
      pairingLimiter.fail(ip);
      return res.status(403).json({ error: 'Wrong PIN — check the PocketDump window on the PC.' });
    }
    pairingLimiter.succeed(ip);
    res.json({ token, pc: getPcInfo() });
  });

  app.post('/upload', requireAuth, requireDestination, upload.single('file'), (req, res) => {
    const destinationFolder = req.destinationFolder;
    if (!req.file) {
      return res.status(400).json({ error: 'No file received.' });
    }

    const { path: tmpPath, hash, size } = req.file;
    const safeName = sanitizeFileName(req.file.originalname);
    const lastModified = parseLastModified(req.body.lastModified);
    const manifest = loadManifest(destinationFolder);

    // From here to the response is synchronous on purpose: with the phone
    // sending two files at once, no other upload can slip in between
    // picking a free filename and claiming it.
    let result;
    if (manifest[hash]) {
      fs.rmSync(tmpPath, { force: true });
      result = { name: safeName, status: 'duplicate', size };
    } else {
      const folderName = dateFolderName(lastModified);
      const targetDir = path.join(destinationFolder, folderName);
      let targetPath;
      try {
        fs.mkdirSync(targetDir, { recursive: true });
        targetPath = uniqueFilePath(targetDir, safeName);
        fs.renameSync(tmpPath, targetPath);
      } catch (err) {
        fs.rm(tmpPath, { force: true }, () => {});
        throw err;
      }
      // Keep the photo's own date on the PC copy, so Explorer's "Date
      // modified" sorts it where it belongs.
      try {
        fs.utimesSync(targetPath, new Date(), new Date(lastModified));
      } catch {
        // Cosmetic only.
      }

      manifest[hash] = {
        path: path.relative(destinationFolder, targetPath),
        name: safeName,
        size,
        lastModified
      };

      result = { name: safeName, status: 'saved', folder: folderName, size };
    }

    manifest[META_KEY] = { lastSyncAt: Date.now() };
    saveManifestSoon(destinationFolder);

    if (onUpload) onUpload(result);
    res.json(result);
  });

  // Lets the phone show "last synced X ago" and pre-skip files it already
  // sent, without uploading the full file just to discover that via hash.
  app.get('/sync-info', requireAuth, (req, res) => {
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
  app.get('/browse', requireAuth, requireSource, async (req, res, next) => {
    try {
      const sourceFolder = req.sourceFolder;
      const target = resolveSafePath(sourceFolder, req.query.dir);
      if (!target) return res.status(400).json({ error: 'Invalid path.' });

      let stat;
      try {
        stat = await fsp.stat(target);
      } catch {
        return res.status(404).json({ error: 'Folder not found.' });
      }
      if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a folder.' });

      const realBase = await fsp.realpath(sourceFolder);
      const dirents = (await fsp.readdir(target, { withFileTypes: true }))
        .filter((entry) => entry.name !== MANIFEST_NAME && !entry.name.startsWith('.'));

      // One unreadable entry (a broken shortcut, a locked system file)
      // is skipped rather than failing the whole listing.
      const entries = (await Promise.all(dirents.map(async (entry) => {
        const entryPath = path.join(target, entry.name);
        try {
          if (!isInside(realBase, await fsp.realpath(entryPath))) return null;
          const entryStat = await fsp.stat(entryPath);
          const relPath = path.relative(sourceFolder, entryPath).split(path.sep).join('/');
          if (entryStat.isDirectory()) return { name: entry.name, type: 'dir', path: relPath };
          if (!entryStat.isFile()) return null;
          return { name: entry.name, type: 'file', path: relPath, size: entryStat.size, thumb: isThumbable(entry.name) };
        } catch {
          return null;
        }
      })))
        .filter(Boolean)
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      const relDir = path.relative(sourceFolder, target).split(path.sep).join('/');
      res.json({ dir: relDir, entries });
    } catch (err) {
      next(err);
    }
  });

  // Streams a single file from the shared folder down to the phone as an
  // attachment, so Safari saves it instead of trying to open it inline.
  app.get('/file', requireAuth, requireSource, (req, res) => {
    const target = resolveSafePath(req.sourceFolder, req.query.path);
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

  async function sendThumbnail(res, filePath, next) {
    try {
      const jpeg = await getThumbnail(filePath);
      if (!jpeg) return res.sendStatus(404);
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'private, max-age=3600');
      res.send(jpeg);
    } catch (err) {
      next(err);
    }
  }

  app.get('/thumb', requireAuth, requireSource, (req, res, next) => {
    const target = resolveSafePath(req.sourceFolder, req.query.path);
    if (!target || !isThumbable(target)) return res.sendStatus(404);
    sendThumbnail(res, target, next);
  });

  // A whole shared folder (and everything under it) as one .zip. Stored
  // without compression — photos and videos are already compressed, so
  // squeezing them again only costs PC time for no size gain.
  app.get('/zip', requireAuth, requireSource, async (req, res, next) => {
    const sourceFolder = req.sourceFolder;
    const target = resolveSafePath(sourceFolder, req.query.dir);
    if (!target) return res.status(400).json({ error: 'Invalid path.' });
    try {
      if (!(await fsp.stat(target)).isDirectory()) return res.status(400).json({ error: 'Not a folder.' });
    } catch {
      return res.status(404).json({ error: 'Folder not found.' });
    }

    let realBase;
    try {
      realBase = await fsp.realpath(sourceFolder);
    } catch (err) {
      return next(err);
    }
    const zipName = `${path.basename(target) || 'PocketDump'}.zip`;
    const archive = archiver('zip', { store: true });
    archive.on('warning', (err) => console.error('zip warning:', err));
    archive.on('error', (err) => {
      console.error('zip error:', err);
      res.destroy(err);
    });
    res.on('close', () => {
      if (!res.writableFinished) archive.abort();
    });
    res.attachment(zipName);
    archive.pipe(res);

    async function addDir(dir) {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === MANIFEST_NAME) continue;
        const full = path.join(dir, entry.name);
        try {
          if (!isInside(realBase, await fsp.realpath(full))) continue;
          const stat = await fsp.stat(full);
          if (stat.isDirectory()) await addDir(full);
          else if (stat.isFile()) archive.file(full, { name: path.relative(target, full).split(path.sep).join('/') });
        } catch {
          // Unreadable — leave it out.
        }
      }
    }

    try {
      await addDir(target);
      await archive.finalize();
    } catch (err) {
      next(err);
    }
  });

  // Files dragged onto the PC window's "Send to iPhone" card.
  app.get('/outbox', requireAuth, (req, res) => {
    res.json({
      items: getOutbox().map(({ id, name, size }) => ({ id, name, size, thumb: isThumbable(name) }))
    });
  });

  function findOutboxItem(id) {
    return getOutbox().find((item) => item.id === id);
  }

  app.get('/outbox/file', requireAuth, (req, res) => {
    const item = findOutboxItem(String(req.query.id || ''));
    if (!item) return res.status(404).json({ error: 'That file is no longer offered by the PC.' });
    // Once the phone has actually received the file, it no longer needs to
    // sit in "Send to iPhone" — auto-clearing it here (rather than leaving
    // it for the user to remove by hand) keeps that list from just growing
    // forever. A failed/aborted transfer (err set) leaves the item in
    // place, so an interrupted download can be retried.
    res.download(item.path, item.name, (err) => {
      if (!err) removeOutboxItem(item.id);
    });
  });

  app.get('/outbox/thumb', requireAuth, (req, res, next) => {
    const item = findOutboxItem(String(req.query.id || ''));
    if (!item || !isThumbable(item.name)) return res.sendStatus(404);
    sendThumbnail(res, item.path, next);
  });

  // Text and links passed between phone and PC.
  app.get('/texts', requireAuth, (req, res) => {
    res.json({ texts: getTexts() });
  });

  app.post('/texts', requireAuth, express.json({ limit: '64kb' }), (req, res) => {
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.status(400).json({ error: 'Nothing to send.' });
    if (text.length > MAX_TEXT_LENGTH) return res.status(400).json({ error: 'That text is too long.' });
    res.json(addText(text, 'phone'));
  });

  // Uploads cut off mid-transfer (e.g. the phone's screen locks and Safari
  // drops the connection) fail quietly; anything else is logged and
  // reported in words the phone can show.
  app.use((err, req, res, next) => {
    if (req.aborted || /aborted/i.test(String(err && err.message))) {
      if (!res.headersSent) res.status(400).json({ error: 'Upload interrupted.' });
      return;
    }
    console.error(`PocketDump server error on ${req.method} ${req.path}:`, err);
    if (res.headersSent) return;
    res.status(500).json({ error: friendlyError(err) });
  });

  const httpServer = http.createServer(app).listen(port);
  const httpsServer = certOptions ? https.createServer(certOptions, app).listen(httpsPort) : null;
  return { httpServer, httpsServer };
}

function stopServer({ httpServer, httpsServer }) {
  flushManifests();
  if (httpServer) httpServer.close();
  if (httpsServer) httpsServer.close();
}

module.exports = { startServer, stopServer, cleanupTemp, flushManifests };
