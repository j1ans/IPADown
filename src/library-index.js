'use strict';
// Runs in system Node so better-sqlite3 uses the same ABI as the backup engine.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { scanFile } = require('./library');

function ipaFiles(root) {
  if (!root || !fs.existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) pending.push(full);
      else if (ent.isFile() && /\.ipa$/i.test(ent.name)) files.push(full);
    }
  }
  return files;
}

function scanIndexed(dir, dbFile) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new Database(dbFile);
  try {
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS ipa_files (
      path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime INTEGER NOT NULL,
      app_id TEXT NOT NULL DEFAULT '', bundle_id TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', record TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ipa_app ON ipa_files(app_id, version);
    CREATE INDEX IF NOT EXISTS idx_ipa_bundle ON ipa_files(bundle_id, version);
    CREATE INDEX IF NOT EXISTS idx_ipa_name ON ipa_files(name);
    `);
    const prefix = dir.replace(/[\\/]$/, '') + path.sep;
    const cached = db.prepare('SELECT path, size, mtime FROM ipa_files WHERE path >= ? AND path < ?').all(prefix, prefix + '\uffff');
    const old = new Map(cached.map((r) => [r.path, r]));
    const put = db.prepare(`INSERT INTO ipa_files(path,size,mtime,app_id,bundle_id,version,name,record)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET
      size=excluded.size,mtime=excluded.mtime,app_id=excluded.app_id,
      bundle_id=excluded.bundle_id,version=excluded.version,name=excluded.name,record=excluded.record`);
    const del = db.prepare('DELETE FROM ipa_files WHERE path=?');
    const files = ipaFiles(dir);
    const changed = [];
    for (const file of files) {
      const st = fs.statSync(file);
      const prev = old.get(file);
      if (!prev || prev.size !== st.size || prev.mtime !== Math.trunc(st.mtimeMs)) changed.push([file, st]);
      old.delete(file);
    }
    // IPA parsing is costly; writes are batched, and unchanged files never reopen.
    const update = db.transaction(() => {
      for (const [file, st] of changed) {
        const rec = scanFile(file);
        if (rec) put.run(file, st.size, Math.trunc(st.mtimeMs), rec.appId || '', rec.bundleId || '', rec.version || '', rec.name || '', JSON.stringify(rec));
      }
      for (const file of old.keys()) del.run(file);
    });
    update();
    const list = db.prepare('SELECT record FROM ipa_files WHERE path >= ? AND path < ? ORDER BY name COLLATE NOCASE, app_id, version DESC')
      .all(prefix, prefix + '\uffff').map((r) => JSON.parse(r.record));
    return { list, indexed: changed.length, total: list.length };
  } finally { db.close(); }
}

if (path.basename(process.argv[1] || '') === 'library-index.js') {
  try { process.stdout.write(JSON.stringify(scanIndexed(process.argv[2], process.argv[3]))); }
  catch (e) { process.stderr.write(e.stack || String(e)); process.exitCode = 1; }
}
module.exports = { scanIndexed };
