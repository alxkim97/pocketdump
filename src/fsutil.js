const fs = require('fs');

// Writes to a temp file first and renames it over the real one, so a crash
// or power cut mid-write leaves the old file intact instead of a truncated
// one. Falls back to a plain write if the rename is refused (e.g. antivirus
// holding the file open on Windows).
function writeFileAtomic(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tmpPath, data, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch {
    fs.writeFileSync(filePath, data, 'utf8');
    fs.rm(tmpPath, { force: true }, () => {});
  }
}

module.exports = { writeFileAtomic };
