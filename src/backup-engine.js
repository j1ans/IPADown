'use strict';
/*
 * backup-engine.js — 已购 App Store 老 iOS 版本备份引擎（事件驱动，供 GUI/CLI 共用）。
 *
 * 职责：过滤购买记录 → 会话导入 → iOS1-13 分桶选版 → 多线程分片下载 →
 *       patch IPA（注入 iTunesMetadata+sinf，读 Info.plist 版本/minOS）→ manifest.db 落盘。
 * 每完成一个文件 emit('dl-done')，文件保存在本机备份目录。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { EventEmitter } = require('events');

const { StoreClient } = require('./store');
const { machineGUID } = require('./guid');
const { readTables } = require('./sqliteread');
const { lookup } = require('./lookup');
const { bestCompatibleFor, eraForVersion } = require('./iosmap');
const { patchIpa } = require('./ipa');
const { STOREFRONTS } = require('./storefront');

const DL_HEADERS = {
  'User-Agent': 'Configurator/2.18 (Macintosh; OS X 15.4.1; 24E263) AppleWebKit/0621.1.15.11.10',
  'Apple-Download-Type': 'buy',
  Accept: '*/*',
};
const SF2CC = new Map(Object.entries(STOREFRONTS).map(([cc, sf]) => [String(sf), cc]));

function safeName(s) { return String(s || 'app').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim() || 'app'; }

// 磁盘剩余空间（MB）。
function diskFreeMB(dir) {
  try { const st = fs.statfsSync(dir); return Math.floor(st.bavail * st.bsize / 1048576); }
  catch (_) { return 1000000; } // 拿不到就不设限
}

function streamGet(urlStr, headers, redirects) {
  return new Promise((resolve, reject) => {
    if ((redirects || 0) > 8) return reject(new Error('重定向过多'));
    const u = new URL(urlStr);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(u, { headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(streamGet(new URL(res.headers.location, u).toString(), headers, (redirects || 0) + 1));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('连接超时')));
  });
}

// 多线程 Range 分片下载；失败/中断丢弃 .part（账号级断点由 manifest 承担）
async function rangedDownload(url, dest, opts, onProgress) {
  const partPath = dest + '.part';
  const probe = await streamGet(url, Object.assign({}, opts.dlHeaders, { Range: 'bytes=0-0' }));
  let total = 0; let ranged = false;
  if (probe.statusCode === 206) {
    const m = String(probe.headers['content-range'] || '').match(/\/(\d+)$/);
    if (m) { total = Number(m[1]); ranged = true; }
    probe.resume();
  } else if (probe.statusCode === 200) {
    total = parseInt(probe.headers['content-length'] || '0', 10);
    probe.resume();
  } else {
    probe.resume();
    throw new Error('下载探测失败 HTTP ' + probe.statusCode);
  }
  if (!total) throw new Error('拿不到文件大小');

  const N = ranged ? opts.threads : 1;
  const size = Math.ceil(total / N);
  const chunks = [];
  for (let i = 0; i < N; i++) {
    const s = i * size; const e = Math.min(total - 1, s + size - 1);
    if (s > e) break;
    chunks.push({ s, e, got: 0 });
  }

  const fd = fs.openSync(partPath, 'w');
  fs.ftruncateSync(fd, total);
  let done = 0;
  const startT = Date.now(); let startB = 0;
  const speedTimer = setInterval(() => {
    if (onProgress) onProgress(done, total, (done - startB) / Math.max(0.001, (Date.now() - startT) / 1000));
  }, 500);
  let fatal = null;
  const cleanup = () => { try { fs.closeSync(fd); } catch (_) { } try { fs.unlinkSync(partPath); } catch (_) { } };

  const worker = async () => {
    while (!fatal && !opts.aborted) {
      const c = chunks.find((x) => x.got < x.e - x.s + 1 && !x.busy);
      if (!c) return;
      // 危急水位保护：磁盘快满时暂停分片。
      if (opts.getFree && opts.criticalFree) {
        while (!opts.aborted && opts.getFree() < opts.criticalFree) {
          await new Promise((r) => setTimeout(r, 2000));
        }
        if (opts.aborted) { fatal = new Error('已停止'); return; }
      }
      c.busy = true;
      const to = c.e;
      try {
        let tries = 0;
        for (;;) {
          try {
            const res = await streamGet(url, Object.assign({}, opts.dlHeaders, {
              Range: `bytes=${c.s + c.got}-${to}`,
            }));
            if (res.statusCode !== 206 && !(res.statusCode === 200 && c.s + c.got === 0)) {
              throw new Error('分片 HTTP ' + res.statusCode);
            }
            await new Promise((resolve, reject) => {
              res.on('data', (d) => {
                fs.writeSync(fd, d, 0, d.length, c.s + c.got);
                c.got += d.length; done += d.length;
                if (c.got > c.e - c.s + 1) { reject(new Error('分片越界')); res.destroy(); }
              });
              res.on('end', resolve);
              res.on('error', reject);
            });
            if (c.got < c.e - c.s + 1) throw new Error('分片提前结束 ' + c.got + '/' + (c.e - c.s + 1));
            break;
          } catch (e) {
            tries++;
            if (tries > opts.chunkRetries) throw e;
            await new Promise((r) => setTimeout(r, 1000 * tries));
          }
        }
      } catch (e) { fatal = e; }
      c.busy = false;
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(opts.threads, chunks.length) }, worker));
  } finally {
    clearInterval(speedTimer);
  }
  if (fatal) { cleanup(); throw fatal; }
  if (opts.aborted) { cleanup(); throw new Error('已停止'); }
  if (done !== total) { cleanup(); throw new Error(`下载不完整 ${done}/${total}`); }
  fs.closeSync(fd);
  fs.renameSync(partPath, dest);
  if (onProgress) onProgress(total, total, 0);
  return total;
}

class BackupEngine extends EventEmitter {
  // opts: {session, dbPath, email, out, iosFrom, iosTo, apps, threads,
  //        dayLimit, appFilter, limit, refresh, mdb}
  constructor(opts) {
    super();
    this.o = Object.assign({
      session: null, dbPath: '', email: '', out: '',
      iosFrom: 1, iosTo: 13,
      apps: 8, threads: 8,
      dayLimit: 100, appFilter: '', limit: 0, refresh: false,
      retries: 3, chunkRetries: 3,
      minFreeMB: 0,
      criticalFreeMB: 2048,  // 下载中途危急水位（分片暂停）
    }, opts || {});
    this.stopped = false;
    this.aborted = false;
    this.stats = { appsTotal: 0, appsDone: 0, ok: 0, bad: 0 };
  }

  log(msg) { this.emit('log', msg); }

  // 过滤购买记录（同 CLI 规则）
  buildAppList() {
    const tables = readTables(this.o.dbPath);
    const acc = (tables.accounts || []).find((x) => String(x.email).toLowerCase() === String(this.o.email).toLowerCase());
    if (!acc) throw new Error('accounts 表里找不到 ' + this.o.email);
    const dsid = String(acc.dsid);
    const li = (tables.line_items || []).filter((x) =>
      String(x.dsid) === dsid && String(x.line_item_type) === 'IOSApp');
    const dayApps = new Map();
    for (const x of li) {
      const d = String(x.pli_date || '').slice(0, 10);
      if (!d) continue;
      if (!dayApps.has(d)) dayApps.set(d, new Set());
      dayApps.get(d).add(String(x.adam_id));
    }
    const bulkSet = new Set([...dayApps.entries()].filter(([, s]) => s.size > this.o.dayLimit).map(([d]) => d));
    const keep = new Map();
    for (const x of li) {
      const d = String(x.pli_date || '').slice(0, 10);
      const id = String(x.adam_id || '');
      if (!id || id === '0') continue;
      // 批量购买日不整日剔除：只保留 ≤9 位 appid 的老 app（批量扫的 10 位新软件仍过滤）
      if (bulkSet.has(d) && id.length > 9) continue;
      if (!keep.has(id)) keep.set(id, { adamId: id, name: x.name || '', storefrontId: String(x.storefront_id || ''), pliDate: d });
    }
    return { account: acc, bulkDays: [...bulkSet], apps: [...keep.values()].sort((a, b) => (Number(a.adamId) || 0) - (Number(b.adamId) || 0)) };
  }

  stop() { this.stopped = true; this.aborted = true; }

  async start() {
    const o = this.o;
    fs.mkdirSync(o.out, { recursive: true });
    // 清扫残留 .part（含 APP 子文件夹）
    try {
      const dirs = [''];
      for (const d of fs.readdirSync(o.out, { withFileTypes: true })) if (d.isDirectory()) dirs.push(d.name);
      for (const d of dirs) {
        for (const f of fs.readdirSync(path.join(o.out, d))) {
          if (/^\.dl_.*\.part$/.test(f)) fs.unlinkSync(path.join(o.out, d, f));
        }
      }
    } catch (_) { }

    this.log(`读取购买库: ${o.dbPath}`);
    const { account, bulkDays, apps } = this.buildAppList();
    this.log(`账号 ${account.email} 过滤后 ${apps.length} 个 app；批量日(${bulkDays.join(', ')})仅保留 ≤9 位 appid 的老 app`);

    let work = apps;
    if (o.appFilter) {
      const want = new Set(String(o.appFilter).split(',').map((s) => s.trim()));
      work = apps.filter((a) => want.has(a.adamId));
      if (!work.length) work = [...want].map((id) => ({ adamId: id, name: '', storefrontId: '', pliDate: '' }));
    }
    if (o.limit > 0) work = work.slice(0, o.limit);
    this.stats.appsTotal = work.length;
    this.emit('stats', { ...this.stats });
    if (!work.length) { this.emit('done', { ...this.stats }); return; }

    const sess = o.session;
    if (!sess?.passwordToken) throw new Error('请先登录 Apple ID');
    this.client = new StoreClient(machineGUID());
    this.client.importSession(sess);
    this.log(`已使用当前账号会话: ${sess.appleId}`);

    this.haveFiles = new Map(); // versionId -> 相对路径
    try {
      const roots = [o.out];
      for (const base of roots) {
        if (!fs.existsSync(base)) continue;
        const dirs = [''];
        try { for (const d of fs.readdirSync(base, { withFileTypes: true })) if (d.isDirectory()) dirs.push(d.name); } catch (_) { }
        for (const d of dirs) {
          for (const f of fs.readdirSync(path.join(base, d))) {
            const m = f.match(/_(\d{6,})\.ipa$/);
            if (m) this.haveFiles.set(m[1], (d ? d + '/' : '') + f);
          }
        }
      }
    } catch (_) { }

    const apiGap = () => new Promise((r) => setTimeout(r, 250 + Math.random() * 250));
    const reauth = async () => {
      if (!sess.password) throw new Error('会话已过期，请在主界面重新登录');
      this.log('会话失效，尝试重新登录…');
      const c2 = new StoreClient(machineGUID());
      const acc = await c2.authenticate(sess.appleId, sess.password, '', sess.country);
      this.client = c2;
      this.log('重新登录成功');
    };
    const isAuthError = (e) => /2034|token|登录|未登录|5000/.test(String(e && e.message || ''));
    this.fetchDownload = async (adamId, versionId) => {
      try { return await this.client.download(adamId, versionId); }
      catch (e) {
        if (isAuthError(e)) { await reauth(); return await this.client.download(adamId, versionId); }
        throw e;
      } finally { await apiGap(); }
    };

    let idx = 0;
    const runner = async () => {
      for (;;) {
        if (this.stopped) return;
        const i = ++idx;
        if (i > this.stats.appsTotal) return;
        const a = work[i - 1];
        try { await this.processApp(a, i); }
        catch (e) { this.stats.bad++; this.emit('dl-fail', { adamId: a.adamId, name: a.name, bucket: '-', error: '处理异常: ' + e.message }); }
        this.stats.appsDone++;
        this.emit('stats', { ...this.stats });
      }
    };
    await Promise.all(Array.from({ length: Math.min(o.apps, work.length) }, () => runner()));
    this.emit('done', { ...this.stats });
  }

  async processApp(a, idx) {
    const o = this.o;
    const tag = `#${idx} ${a.name || a.adamId}`;
    const mdb = o.mdb;
    mdb.upsertApp(a.adamId, { name: a.name || '', storefrontId: a.storefrontId || '' });

    let ids = []; let latest = '';
    for (let t = 0; t < 2 && !ids.length && !this.stopped; t++) {
      try {
        const lv = await this.client.listVersions(a.adamId);
        ids = lv.ids; latest = lv.latest;
        await new Promise((r) => setTimeout(r, 250 + Math.random() * 250));
      } catch (e) {
        const isAuth = /2034|token|登录|未登录|5000/.test(String(e.message || ''));
        if (isAuth && t === 0) {
          try {
            const c2 = new StoreClient(machineGUID());
            if (!o.session.password) throw new Error('会话已过期，请在主界面重新登录');
            await c2.authenticate(o.session.appleId, o.session.password, '', o.session.country);
            this.client = c2;
            continue;
          } catch (_) { break; }
        }
        this.log(`${tag} (${a.adamId}) listVersions 失败: ${e.message}`);
        break;
      }
    }
    if (!ids.length) {
      try {
        const cc = SF2CC.get(a.storefrontId) || 'US';
        const info = await lookup(a.adamId, cc);
        ids = (info.versionIds || []).map(String);
        this.log(`${tag} (${a.adamId}) 用 lookup 兜底拿到 ${ids.length} 个版本`);
      } catch (_) { }
    }
    if (!ids.length) {
      await this.downloadBucket(a, 'latest-fallback', '0', '[最新版兜底]', tag);
      return;
    }
    mdb.upsertApp(a.adamId, { name: a.name || '', storefrontId: a.storefrontId || '', versionCount: ids.length });

    // 分桶：era 选版 + 最初版；同 versionId 只下一次
    const picks = new Map();
    for (let n = o.iosFrom; n <= o.iosTo; n++) {
      let pick = null;
      if (n === 1) {
        pick = ids.map(Number).filter((x) => x && x < 17191).sort((x, y) => x - y).pop() || null;
      } else {
        pick = bestCompatibleFor(n, ids);
      }
      if (pick) picks.set(String(pick), picks.get(String(pick)) || `iOS${n}`);
    }
    picks.set(String(ids[0]), picks.get(String(ids[0])) || 'initial');

    for (const [vid, bucket] of picks) {
      if (this.stopped) return;
      const done = mdb.getBucket(a.adamId, bucket);
      // 已完成且文件仍在盘上，跳过重复下载。
      const doneFile = done && done.file && done.status === 'done'
        && fs.existsSync(path.join(o.out, done.file));
      const existing = this.haveFiles.get(vid);
      if (!o.refresh && (doneFile || existing)) {
        const rel = doneFile ? done.file : existing;
        if (existing && (!done || done.status !== 'done' || done.file !== existing)) {
          mdb.setBucket(a.adamId, bucket, { status: 'done', versionId: vid, file: existing });
        }
        this.stats.ok++;
        this.emit('stats', { ...this.stats });
        this.emit('dl-skip', { adamId: a.adamId, name: a.name, bucket, rel });
        continue;
      }
      const prefix = bucket === 'initial' ? '[最初版]' : `[${bucket}完美兼容版]`;
      await this.downloadBucket(a, bucket, vid, prefix, tag);
    }
    // 最初版与其他桶同文件 → covered 引用
    const initVid = String(ids[0]);
    const init = mdb.getBucket(a.adamId, 'initial');
    if (!init || init.status !== 'done') {
      const names = [];
      for (let n = o.iosFrom; n <= o.iosTo; n++) names.push(`iOS${n}`);
      const cover = names.map((b) => mdb.getBucket(a.adamId, b)).find((r) => r && r.versionId === initVid && r.status === 'done');
      if (cover) {
        mdb.setBucket(a.adamId, 'initial', { status: 'covered', coveredBy: cover.bucket, versionId: initVid, file: cover.file, version: cover.version, minOS: cover.minOS });
      }
    }
  }

  async waitForSpace(short) {
    // 可选磁盘水位闸门。
    if (!this._spaceWaiting) {
      const free = diskFreeMB(this.o.out);
      if (free >= this.o.minFreeMB) return true;
      this._spaceWaiting = true;
      this.emit('dl-wait', { free, minFree: this.o.minFreeMB });
      this.log(`⏸ 磁盘剩余 ${free}MB < ${this.o.minFreeMB}MB，暂停下载（${short}）`);
    }
    for (;;) {
      if (this.stopped) return false;
      await new Promise((r) => setTimeout(r, 3000));
      const free = diskFreeMB(this.o.out);
      if (free >= this.o.minFreeMB) {
        this._spaceWaiting = false;
        this.emit('dl-resume', { free });
        this.log(`▶ 磁盘释放至 ${free}MB，恢复下载`);
        return true;
      }
    }
  }

  async downloadBucket(a, bucket, versionId, prefix, tag) {
    const o = this.o;
    const mdb = o.mdb;
    const short = `${tag} ${bucket}`;
    // 磁盘水位闸门：空间不足时在此等待。
    if (!(await this.waitForSpace(short))) return;
    let info = null; let isFallback = false;
    try {
      info = await this.fetchDownload(a.adamId, versionId);
    } catch (apiErr) {
      if (versionId !== '0') {
        this.log(`${short} 版本 ${versionId} 拉取失败(${apiErr.message}) → 下载最新版兜底`);
        try { info = await this.fetchDownload(a.adamId, '0'); isFallback = true; }
        catch (e2) {
          mdb.setBucket(a.adamId, bucket, { status: 'failed', versionId, error: '取直链: ' + e2.message });
          this.stats.bad++;
          this.emit('stats', { ...this.stats });
          this.emit('dl-fail', { adamId: a.adamId, name: a.name, bucket, error: e2.message });
          this.log(`${short} 最新版直链也失败: ${e2.message}，记录后继续`);
          return;
        }
      } else {
        mdb.setBucket(a.adamId, bucket, { status: 'failed', versionId, error: '取直链: ' + apiErr.message });
        this.stats.bad++;
        this.emit('stats', { ...this.stats });
        this.emit('dl-fail', { adamId: a.adamId, name: a.name, bucket, error: apiErr.message });
        return;
      }
    }
    if (isFallback) { bucket = bucket + '-fallback'; prefix = '[最新版兜底]'; }
    const servedVid = String(info.versionId || (isFallback ? '0' : versionId));

    const tmp = path.join(o.out, `.dl_${a.adamId}_${servedVid}.ipa`);
    for (let attempt = 1; attempt <= o.retries && !this.stopped; attempt++) {
      if (attempt > 1) {
        try { info = await this.fetchDownload(a.adamId, isFallback ? '0' : versionId); } catch (_) { }
        this.log(`${short} 传输失败重试 ${attempt}/${o.retries}`);
      }
      try {
        await rangedDownload(info.url, tmp, {
          threads: o.threads, chunkRetries: o.chunkRetries, dlHeaders: DL_HEADERS, aborted: this.aborted,
          getFree: () => diskFreeMB(o.out), criticalFree: o.criticalFreeMB,
        }, (doneB, tot, speed) => {
          this.emit('dl-progress', { key: `${a.adamId}|${bucket}`, adamId: a.adamId, name: a.name, bucket, done: doneB, total: tot, speed });
        });

        const meta = patchIpa(tmp, info, this.client.account, { purchaseDate: a.pliDate });
        const name = safeName(meta.displayName || info.name || a.name || a.adamId);
        const ver = safeName(meta.shortVersion || info.version || servedVid);
        const fname = `${prefix}${name}_${ver}_${servedVid}.ipa`;
        const folder = require('./manifestdb').appFolder(a.name || meta.displayName, a.adamId);
        const dir = path.join(o.out, folder);
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, fname);
        const rel = folder + '/' + fname;
        if (fs.existsSync(dest)) {
          try { fs.unlinkSync(tmp); } catch (_) { }
        } else {
          fs.renameSync(tmp, dest);
        }
        this.haveFiles.set(servedVid, rel);
        const era = eraForVersion(servedVid);
        mdb.setBucket(a.adamId, bucket, {
          status: 'done', versionId: servedVid, file: rel, version: meta.shortVersion || '',
          minOS: meta.minOS || '', bundleId: meta.bundleId || '', size: fs.statSync(dest).size,
          era: era ? `${era.ios} ${era.date}` : '',
        });
        this.stats.ok++;
        this.emit('stats', { ...this.stats });
        this.emit('dl-done', {
          adamId: a.adamId, name: a.name, bucket, rel, abs: dest,
          version: meta.shortVersion || '', minOS: meta.minOS || '', versionId: servedVid, size: fs.statSync(dest).size,
        });
        this.log(`${tag} (${a.adamId}) ${bucket} ✓ ${rel} (v${meta.shortVersion} minOS ${meta.minOS || '?'})`);
        return;
      } catch (e) {
        if (attempt >= o.retries) {
          mdb.setBucket(a.adamId, bucket, { status: 'failed', versionId: servedVid, error: '下载: ' + e.message });
          this.stats.bad++;
          this.emit('stats', { ...this.stats });
          this.emit('dl-fail', { adamId: a.adamId, name: a.name, bucket, error: e.message });
          this.log(`${tag} (${a.adamId}) ${bucket} 重试${o.retries}次仍失败: ${e.message}，记录后继续`);
        }
      }
    }
  }
}

module.exports = { BackupEngine };
