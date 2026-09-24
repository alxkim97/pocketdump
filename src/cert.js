const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');

const KEY_FILE = 'https-key.pem';
const CERT_FILE = 'https-cert.pem';
const META_FILE = 'https-cert-meta.json';

// getUserMedia (needed for the live camera view) only works on a "secure
// context" — HTTPS, or localhost. A LAN IP over plain HTTP doesn't qualify,
// so PocketDump runs a second HTTPS listener alongside the normal HTTP one,
// backed by a self-signed cert covering the PC's current LAN addresses.
// The cert is cached in userData and only regenerated when the addresses it
// needs to cover change (e.g. a new WiFi network), so the phone doesn't have
// to re-trust it on every launch.
async function getOrCreateCert(certDir, addresses) {
  const keyPath = path.join(certDir, KEY_FILE);
  const certPath = path.join(certDir, CERT_FILE);
  const metaPath = path.join(certDir, META_FILE);

  const wanted = new Set(['localhost', '127.0.0.1', ...addresses]);

  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const covered = new Set(meta.addresses || []);
    const stillCovered = [...wanted].every((addr) => covered.has(addr));
    if (stillCovered) {
      return {
        key: fs.readFileSync(keyPath, 'utf8'),
        cert: fs.readFileSync(certPath, 'utf8')
      };
    }
  } catch {
    // No cached cert yet, or it's unreadable — fall through and generate one.
  }

  const altNames = [...wanted].map((addr) =>
    /^\d+\.\d+\.\d+\.\d+$/.test(addr) ? { type: 7, ip: addr } : { type: 2, value: addr }
  );

  const notBeforeDate = new Date();
  const notAfterDate = new Date(notBeforeDate);
  notAfterDate.setFullYear(notAfterDate.getFullYear() + 10);
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'PocketDump' }], {
    notBeforeDate,
    notAfterDate,
    keySize: 2048,
    algorithm: 'sha256', // iOS rejects SHA-1-signed server certs on modern versions
    extensions: [{ name: 'subjectAltName', altNames }]
  });

  fs.writeFileSync(keyPath, pems.private, 'utf8');
  fs.writeFileSync(certPath, pems.cert, 'utf8');
  fs.writeFileSync(metaPath, JSON.stringify({ addresses: [...wanted] }), 'utf8');

  return { key: pems.private, cert: pems.cert };
}

module.exports = { getOrCreateCert };
