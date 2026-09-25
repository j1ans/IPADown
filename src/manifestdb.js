'use strict';
/*
 * manifestdb.js — manifest 的 SQLite 存储（better-sqlite3，同步、O(1) upsert）。
 * 替代旧 manifest.json（app 多了之后每次全量序列化太慢）。
 * 首次打开若发现旧 manifest.json 且库为空，自动导入并把 json 改名为 .migrated。
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// 每个 APP 一个文件夹：<safeName>_<adamId>，同 app 不同版本都放里面
function appFolder(name, adamId) {
  const safe = String(name || '').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim();
  return safe ? `${safe}_${adamId}` : String(adamId);
}

class ManifestDB {
  constructor(file) {
    this.file = file;
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS apps (
        adamId TEXT PRIMARY KEY,
        name TEXT DEFAULT '',
        storefrontId TEXT DEFAULT '',
        versionCount INTEGER DEFAULT 0,
        updatedAt TEXT DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS buckets (
        adamId TEXT NOT NULL,
        bucket TEXT NOT NULL,
        status TEXT NOT NULL,
        versionId TEXT DEFAULT '',
        file TEXT DEFAULT '',
        version TEXT DEFAULT '',
        minOS TEXT DEFAULT '',
        bundleId TEXT DEFAULT '',
        size INTEGER DEFAULT 0,
        era TEXT DEFAULT '',
        error TEXT DEFAULT '',
        coveredBy TEXT DEFAULT '',
        updatedAt TEXT DEFAULT '',
        PRIMARY KEY (adamId, bucket)
      );
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_buckets_status ON buckets(status, adamId);
      CREATE INDEX IF NOT EXISTS idx_buckets_file ON buckets(file);
      CREATE INDEX IF NOT EXISTS idx_buckets_bundle_version ON buckets(bundleId, version);`);
    this.stApp = this.db.prepare(`INSERT INTO apps (adamId,name,storefrontId,versionCount,updatedAt)
      VALUES (@adamId,@name,@storefrontId,@versionCount,@updatedAt)
      ON CONFLICT(adamId) DO UPDATE SET name=COALESCE(NULLIF(@name,''),name),
        storefrontId=COALESCE(NULLIF(@storefrontId,''),storefrontId),
        versionCount=MAX(versionCount,@versionCount), updatedAt=@updatedAt`);
    this.stBucket = this.db.prepare(`INSERT INTO buckets
      (adamId,bucket,status,versionId,file,version,minOS,bundleId,size,era,error,coveredBy,updatedAt)
      VALUES (@adamId,@bucket,@status,@versionId,@file,@version,@minOS,@bundleId,@size,@era,@error,@coveredBy,@updatedAt)
      ON CONFLICT(adamId,bucket) DO UPDATE SET status=@status,versionId=@versionId,file=@file,
        version=@version,minOS=@minOS,bundleId=@bundleId,size=@size,era=@era,error=@error,
        coveredBy=@coveredBy,updatedAt=@updatedAt`);
    this.qApp = this.db.prepare('SELECT * FROM apps WHERE adamId=?');
    this.qBucket = this.db.prepare('SELECT * FROM buckets WHERE adamId=? AND bucket=?');
    this.qCounts = this.db.prepare(`SELECT
      SUM(status IN ('done','covered')) AS ok, SUM(status NOT IN ('done','covered')) AS bad FROM buckets`);
    this._migrateJson(path.join(path.dirname(file), 'manifest.json'));
  }

  _migrateJson(jsonPath) {
    try {
      if (!fs.existsSync(jsonPath)) return;
      const n = this.db.prepare('SELECT COUNT(*) c FROM buckets').get().c;
      if (n > 0) return; // 库里已有数据，不重复导入
      const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const dir = path.dirname(jsonPath);
      const tx = this.db.transaction(() => {
        for (const [adamId, r] of Object.entries(j.apps || {})) {
          this.stApp.run({ adamId, name: r.name || '', storefrontId: r.storefrontId || '', versionCount: r.versionCount || 0, updatedAt: new Date().toISOString() });
          const folder = appFolder(r.name, adamId);
          for (const [bucket, b] of Object.entries(r.buckets || {})) {
            let file = b.file || '';
            // 统一整理：盘上文件挪进 APP 文件夹 + 命名补「_商店版本号.ipa」后缀
            if (b.status === 'done' && file && b.versionId) {
              const base = path.basename(file);
              const newName = new RegExp(`_${b.versionId}\\.ipa$`).test(base)
                ? base : base.replace(/\.ipa$/, `_${b.versionId}.ipa`);
              const rel = folder + '/' + newName;
              const newP = path.join(dir, rel);
              if (!fs.existsSync(newP)) {
                try {
                  fs.mkdirSync(path.join(dir, folder), { recursive: true });
                  fs.renameSync(path.join(dir, file), newP);
                  file = rel;
                } catch (_) { /* 挪不动就保留旧路径 */ }
              } else {
                file = rel;
                try { if (path.join(dir, file) !== path.join(dir, rel)) fs.unlinkSync(path.join(dir, file)); } catch (_) { }
                file = rel;
              }
            }
            this.stBucket.run({
              adamId, bucket, status: b.status || 'done', versionId: b.versionId || '',
              file, version: b.version || '', minOS: b.minOS || '',
              bundleId: b.bundleId || '', size: b.size || 0, era: b.era || '',
              error: b.error || '', coveredBy: b.coveredBy || '', updatedAt: new Date().toISOString(),
            });
          }
        }
      });
      tx();
      fs.renameSync(jsonPath, jsonPath + '.migrated');
      console.log(`[manifest] 已将 ${jsonPath} 迁移到 SQLite（${this.qCounts.get().ok || 0} 个桶），原 json 改名为 .migrated`);
    } catch (e) {
      console.error('[manifest] 迁移旧 json 失败（忽略，继续用空库）: ' + e.message);
    }
  }

  upsertApp(adamId, fields) {
    this.stApp.run({
      adamId: String(adamId), name: (fields && fields.name) || '',
      storefrontId: (fields && fields.storefrontId) || '',
      versionCount: (fields && fields.versionCount) || 0,
      updatedAt: new Date().toISOString(),
    });
  }

  getApp(adamId) {
    const r = this.qApp.get(String(adamId));
    if (!r) return null;
    return { name: r.name, storefrontId: r.storefrontId, versionCount: r.versionCount };
  }

  getBucket(adamId, bucket) {
    return this.qBucket.get(String(adamId), bucket) || null;
  }

  setBucket(adamId, bucket, o) {
    this.stBucket.run({
      adamId: String(adamId), bucket, status: o.status || 'done',
      versionId: String(o.versionId || ''), file: o.file || '', version: o.version || '',
      minOS: o.minOS || '', bundleId: o.bundleId || '', size: o.size || 0, era: o.era || '',
      error: (o.error || '').slice(0, 500), coveredBy: o.coveredBy || '',
      updatedAt: new Date().toISOString(),
    });
  }

  counts() {
    const r = this.qCounts.get() || {};
    return { okBuckets: r.ok || 0, badBuckets: r.bad || 0 };
  }

  close() { try { this.db.close(); } catch (_) { } }
}

module.exports = { ManifestDB, appFolder };
