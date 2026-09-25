'use strict';
/*
 * rescue-core.js — 绝版软件拯救核心。
 *
 * 输入：一个（或多个）IPA 文件——我们工具下载的 IPA 里 iTunesMetadata.plist 自带
 *   itemId(adamId) + softwareVersionExternalIdentifiers（该 app 全部历史版本 id），
 *   下载渠道无关的第三方 IPA 也能从 Info.plist 拿 bundleId 再反查。
 * 行为：对提取到的每个版本 id 逐个向苹果请求下载（撤包后的版本也能拉），
 *   按 <备份目录>/<APP名_adamId>/[iOSx完美兼容版]名_版本_商店版本号.ipa 落盘，
 *   记录到 manifest_rescue.db（独立于主备份任务）。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { EventEmitter } = require('events');
const AdmZip = require('adm-zip');
const { parseAnyPlist, patchIpa } = require('./ipa');
const { StoreClient, PRICING_BUY } = require('./store');
const { machineGUID } = require('./guid');
const { eraForVersion } = require('./iosmap');
const { appFolder } = require('./manifestdb');
const { countryToStorefront } = require('./storefront');
const { lookupByBundle } = require('./lookup');

const DL_HEADERS = {
  'User-Agent': 'Configurator/2.18 (Macintosh; OS X 15.4.1; 24E263) AppleWebKit/0621.1.15.11.10',
  'Apple-Download-Type': 'buy',
  Accept: '*/*',
};

function safeName(s) { return String(s || 'app').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim() || 'app'; }

function diskFreeMB(dir) {
  try { const st = fs.statfsSync(dir); return Math.floor(st.bavail * st.bsize / 1048576); }
  catch (_) { return 1000000; }
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

// 与主备份相同的 8 线程 Range 分片下载器
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
      c.busy = true;
      const to = c.e;
      try {
        let tries = 0;
        for (;;) {
          try {
            const res = await streamGet(url, Object.assign({}, opts.dlHeaders, { Range: `bytes=${c.s + c.got}-${to}` }));
            if (res.statusCode !== 206 && !(res.statusCode === 200 && c.s + c.got === 0)) throw new Error('分片 HTTP ' + res.statusCode);
            await new Promise((resolve, reject) => {
              res.on('data', (d) => {
                fs.writeSync(fd, d, 0, d.length, c.s + c.got);
                c.got += d.length; done += d.length;
                if (c.got > c.e - c.s + 1) { reject(new Error('分片越界')); res.destroy(); }
              });
              res.on('end', resolve);
              res.on('error', reject);
            });
            if (c.got < c.e - c.s + 1) throw new Error('分片提前结束');
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

// 从 IPA 提取身份与版本列表
function extractFromIpa(absPath) {
  const zip = new AdmZip(absPath);
  let appDir = '';
  for (const e of zip.getEntries()) {
    const m = e.entryName.match(/^Payload\/([^/]+\.app)\//);
    if (m) { appDir = 'Payload/' + m[1]; break; }
  }
  if (!appDir) throw new Error('不是有效 IPA（无 Payload/*.app）');

  let info = {};
  try { info = parseAnyPlist(zip.getEntry(appDir + '/Info.plist').getData()) || {}; } catch (_) { }
  let meta = {};
  const mdEntry = zip.getEntry('iTunesMetadata.plist');
  if (mdEntry) { try { meta = parseAnyPlist(mdEntry.getData()) || {}; } catch (_) { } }

  const adamId = String(meta.itemId || meta.itemID || info.itemId || '');
  const versionIds = (meta.softwareVersionExternalIdentifiers || []).map(String);
  return {
    path: absPath,
    adamId,
    bundleId: info.CFBundleIdentifier || meta.softwareVersionBundleId || '',
    name: meta.bundleDisplayName || info.CFBundleDisplayName || info.CFBundleName || path.basename(absPath).replace(/\.ipa$/i, ''),
    version: info.CFBundleShortVersionString || meta.bundleShortVersionString || '',
    versionIds,
    curVersionId: String(meta.softwareVersionExternalIdentifier || ''),
    hasItunesMetadata: !!mdEntry,
  };
}

// 从单独的 plist 文件提取身份与版本列表（不用整个 IPA）：
//   · iTunesMetadata.plist —— itemId + softwareVersionExternalIdentifiers 全量版本 id，最好用
//   · Info.plist —— 只有 bundleId，走公开接口反查 adamId（撤包 App 多半查不到，尽力而为）
async function extractFromPlist(absPath) {
  const pl = parseAnyPlist(fs.readFileSync(absPath)) || {};
  let adamId = String(pl.itemId || pl.itemID || '');
  let versionIds = (pl.softwareVersionExternalIdentifiers || []).map(String);
  let name = pl.bundleDisplayName || pl.userName || '';
  let version = pl.bundleShortVersionString || '';
  let bundleId = pl.softwareVersionBundleId || '';
  if (!versionIds.length && pl.softwareVersionExternalIdentifier) versionIds = [String(pl.softwareVersionExternalIdentifier)];
  if (!adamId) { // Info.plist 形态
    bundleId = bundleId || pl.CFBundleIdentifier || '';
    name = name || pl.CFBundleDisplayName || pl.CFBundleName || '';
    version = version || pl.CFBundleShortVersionString || '';
    if (bundleId) {
      for (const cc of ['CN', 'JP', 'US', 'HK', 'TW']) {
        try {
          const info = await lookupByBundle(bundleId, cc);
          if (info && info.trackId) { adamId = String(info.trackId); name = name || info.name || ''; break; }
        } catch (_) { /* 下一商店 */ }
      }
    }
  }
  if (!adamId) { // 反查失败 → 返回待补 adamId 的条目，由用户在 GUI 手动填写
    if (!bundleId && !name && !versionIds.length) throw new Error('plist 无法识别（无 itemId / bundleId / 版本列表）');
    return {
      path: absPath, adamId: '', bundleId,
      name: name || path.basename(absPath).replace(/\.plist$/i, ''),
      version, versionIds, curVersionId: String(pl.softwareVersionExternalIdentifier || ''),
      hasItunesMetadata: !!pl.softwareVersionExternalIdentifiers,
      needAdamId: true,
    };
  }
  return {
    path: absPath, adamId, bundleId,
    name: name || path.basename(absPath).replace(/\.plist$/i, ''),
    version, versionIds,
    curVersionId: String(pl.softwareVersionExternalIdentifier || ''),
    hasItunesMetadata: !!pl.softwareVersionExternalIdentifiers,
  };
}

class RescueEngine extends EventEmitter {
  // opts: {session, out, threads=8, mdb, maxVersions=0(全部), retries=3}
  constructor(opts) {
    super();
    this.o = Object.assign({
      session: null, out: '',
      threads: 8, maxVersions: 0, retries: 3, chunkRetries: 3,
      concurrency: 8,          // 同时下载的版本任务数（跨 app/跨版本）
      minFreeMB: 0,            // 绝版软件为用户手动指定拯救，不做磁盘水位限制（0=不启用）
      criticalFreeMB: 0,
    }, opts || {});
    this.stopped = false;
    this.aborted = false;
    this.stats = { ok: 0, bad: 0, skip: 0 };
  }

  log(m) { this.emit('log', m); }

  async initSession() {
    const sess = this.o.session;
    if (!sess?.passwordToken) throw new Error('请先登录 Apple ID');
    this.sess = sess;
    // 多商店客户端：主会话商店排最前，再轮询 CN/US/HK/TW——
    // 撤包 App 常只在部分商店有售，JP 会话直接下载会报 NoSalableAdamId。
    const mainCC = sess.country || 'JP';
    const order = [mainCC, 'CN', 'US', 'HK', 'TW'].filter((cc, i, a) => a.indexOf(cc) === i);
    this.clients = order.map((cc) => {
      const c = new StoreClient(machineGUID());
      c.importSession(Object.assign({}, sess, { storefront: '', country: cc }));
      return { cc, c };
    });
    this.client = this.clients[0].c; // 兼容旧引用（listVersions 等）
    this.log(`已使用当前账号会话: ${sess.appleId}；商店轮询: ${order.join(' → ')}`);
    this._sfOK = new Map();  // adamId -> 命中的商店 cc
    this._bought = new Set(); // adamId|cc 已补购
    // 清扫上次中断残留的 .dl_*.part（不做分片续传，直接丢弃）
    try {
      for (const f of fs.readdirSync(this.o.out)) {
        if (/^\.dl_.*\.part$/.test(f)) fs.unlinkSync(path.join(this.o.out, f));
      }
    } catch (_) { }
  }

  // 取直链（带授权兜底）：逐商店尝试 download，授权类错误（NoSalableAdamId/9610）
  // 先 buyProduct 免费补购（撤包 App 苹果新 API 仍接受）再重试；命中商店缓存给后续版本复用。
  async fetchWithLicense(item, vid) {
    const cached = this._sfOK.get(item.adamId);
    const list = cached
      ? this.clients.filter((x) => x.cc === cached).concat(this.clients.filter((x) => x.cc !== cached))
      : this.clients;
    let lastErr = null;
    for (const { cc, c } of list) {
      try {
        const info = await c.download(item.adamId, vid);
        if (!cached) { this._sfOK.set(item.adamId, cc); this.log(`${item.name} 在 ${cc} 商店可下载`); }
        return { c, info };
      } catch (e) {
        lastErr = e;
        const s = String(e.message || '');
        if (!/NoSalableAdamId|9610|未购买|purchase/i.test(s)) throw e; // 非授权类错误（版本本身不可用/网络）直接抛出
        const bkey = item.adamId + '|' + cc;
        if (!this._bought.has(bkey)) {
          this._bought.add(bkey);
          try {
            await c.buy(item.adamId, vid, PRICING_BUY);
            this.log(`${item.name} 在 ${cc} 商店补购成功`);
          } catch (be) {
            this.log(`${item.name} 在 ${cc} 商店补购失败: ${String(be.message || '').slice(0, 80)}`);
          }
          try {
            const info = await c.download(item.adamId, vid);
            this._sfOK.set(item.adamId, cc);
            this.log(`${item.name} 补购后在 ${cc} 商店可下载`);
            return { c, info };
          } catch (e2) { lastErr = e2; }
        }
      }
    }
    throw new Error(`${(lastErr && lastErr.message) || '取直链失败'}（已轮询 ${list.length} 个商店并尝试补购）`);
  }

  stop() { this.stopped = true; this.aborted = true; }

  async waitForSpace(label) {
    if (!this._waiting) {
      const free = diskFreeMB(this.o.out);
      if (free >= this.o.minFreeMB) return true;
      this._waiting = true;
      this.emit('dl-wait', { free, minFree: this.o.minFreeMB });
      this.log(`⏸ 磁盘剩余 ${free}MB < ${this.o.minFreeMB}MB，暂停（${label}）`);
    }
    for (;;) {
      if (this.stopped) return false;
      await new Promise((r) => setTimeout(r, 3000));
      const free = diskFreeMB(this.o.out);
      if (free >= this.o.minFreeMB) {
        this._waiting = false;
        this.emit('dl-resume', { free });
        this.log(`▶ 磁盘释放至 ${free}MB，恢复`);
        return true;
      }
    }
  }

  // 解析一个 app 的待下载版本列表（含 --max 截断）
  async resolveIds(item) {
    const o = this.o;
    let ids = (item.versionIds || []).map(String).filter(Boolean).sort((a, b) => Number(a) - Number(b));
    if (!ids.length && item.curVersionId) ids = [item.curVersionId];
    if (!ids.length) {
      // iTunesMetadata 里没有版本列表 → 逐商店试官方接口
      let got = false;
      for (const { cc, c } of this.clients) {
        try {
          const lv = await c.listVersions(item.adamId);
          ids = lv.ids; got = true;
          this.log(`${item.name} 在 ${cc} 商店拿到 ${ids.length} 个版本`);
          this._sfOK.set(item.adamId, cc);
          break;
        } catch (e) { /* 下一商店 */ }
      }
      if (!got) { this.emit('rs-fail', { adamId: item.adamId, name: item.name, vid: '', error: '无版本列表且全部商店接口失败' }); return []; }
    }
    if (o.maxVersions > 0 && ids.length > o.maxVersions) {
      this.log(`${item.name} 共 ${ids.length} 个版本，按上限只处理最新 ${o.maxVersions} 个`);
      ids = ids.slice(-o.maxVersions);
    }
    return ids;
  }

  // 单个 (app, 版本) 任务：跳过判定 + 下载
  async doVersion(item, vid) {
    const o = this.o;
    const mdb = o.mdb;
    if (this._dropApp && this._dropApp.has(item.adamId)) return; // adamId 已判定不存在，剩余版本不再浪费请求
    const done = mdb.getBucket(item.adamId, 'v' + vid);
    const doneFile = done && done.file && done.status === 'done'
      && fs.existsSync(path.join(o.out, done.file));
    if (doneFile || this._scanHas(vid)) {
      const rel = doneFile ? done.file : this._scanGet(vid);
      if (!done || done.status !== 'done' || done.file !== rel) mdb.setBucket(item.adamId, 'v' + vid, { status: 'done', versionId: vid, file: rel });
      this.stats.skip++;
      this.emit('stats', { ...this.stats });
      this.emit('rs-skip', { adamId: item.adamId, name: item.name, vid, rel });
      return;
    }
    await this.downloadVersion(item, vid);
  }

  // 拯救多个 app：全局并发池（默认 8 槽），同 app 的多个版本也并行下载
  async rescueAll(items, concurrency) {
    const o = this.o;
    const N = Math.max(1, concurrency || o.concurrency || 8);
    const tasks = [];
    this._pendingApps = new Map(); // adamId -> {item, left}
    for (const item of items) {
      const ids = await this.resolveIds(item);
      if (!ids.length) continue;
      o.mdb.upsertApp(item.adamId, { name: item.name, storefrontId: '' });
      this.emit('rs-plan', { adamId: item.adamId, name: item.name, count: ids.length });
      this._pendingApps.set(item.adamId, { item, left: ids.length });
      for (const vid of ids) tasks.push({ item, vid });
    }
    this.log(`并发拯救：${tasks.length} 个版本任务 × ${N} 线程`);
    let idx = 0;
    const self = this;
    const worker = async () => {
      for (;;) {
        if (self.stopped) return;
        const i = idx++;
        if (i >= tasks.length) return;
        const { item, vid } = tasks[i];
        try { await self.doVersion(item, vid); }
        catch (e) {
          self.stats.bad++;
          self.emit('rs-fail', { adamId: item.adamId, name: item.name, vid, error: e.message });
        }
        const p = self._pendingApps.get(item.adamId);
        if (p && --p.left <= 0) {
          self._pendingApps.delete(item.adamId);
          self.emit('rs-app-done', { adamId: item.adamId, name: item.name });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(N, tasks.length || 1) }, worker));
  }

  // 兼容旧接口：拯救单个 app（内部走并发池，同 app 版本并行）
  async rescue(item) {
    await this.rescueAll([item]);
  }

  _scanHas(vid) { this._scan(); return this._files.has(vid); }
  _scanGet(vid) { this._scan(); return this._files.get(vid); }
  _scan() {
    if (this._files) return;
    this._files = new Map();
    try {
      for (const base of [this.o.out]) {
        if (!fs.existsSync(base)) continue;
        for (const f of fs.readdirSync(base)) {
          const m = f.match(/_(\d{6,})\.ipa$/);
          if (m) this._files.set(m[1], f);
          const full = path.join(base, f);
          if (fs.statSync(full).isDirectory()) {
            for (const g of fs.readdirSync(full)) {
              const m2 = g.match(/_(\d{6,})\.ipa$/);
              if (m2) this._files.set(m2[1], f + '/' + g);
            }
          }
        }
      }
    } catch (_) { }
  }

  async downloadVersion(item, vid) {
    const o = this.o;
    const mdb = o.mdb;
    const short = `${item.name || item.adamId} #${vid}`;
    if (!(await this.waitForSpace(short))) return;

    const tmp = path.join(o.out, `.dl_${item.adamId}_${vid}.ipa`);
    for (let attempt = 1; attempt <= o.retries && !this.stopped; attempt++) {
      let info = null; let client = null;
      try {
        const r = await this.fetchWithLicense(item, vid);
        info = r.info; client = r.c;
        await new Promise((r2) => setTimeout(r2, 250 + Math.random() * 250));
      } catch (apiErr) {
        // 撤包版本拉不到（全部商店+补购都试过）→ 记录失败，继续下一个版本
        mdb.setBucket(item.adamId, 'v' + vid, { status: 'failed', versionId: vid, error: '取直链: ' + apiErr.message });
        this.stats.bad++;
        this.emit('stats', { ...this.stats });
        this.emit('rs-fail', { adamId: item.adamId, name: item.name, vid, error: apiErr.message });
        this.log(`${short} ✗ 拉取失败: ${apiErr.message}`);
        // 授权类失败（adamId 不存在/不可购）→ 停掉该 app 剩余版本，让用户改填 adamId
        if (/NoSalableAdamId|9610|未购买|purchase|不存在/i.test(String(apiErr.message))) {
          if (!this._needIdAsked) this._needIdAsked = new Set();
          if (!this._needIdAsked.has(item.adamId)) {
            this._needIdAsked.add(item.adamId);
            if (!this._dropApp) this._dropApp = new Set();
            this._dropApp.add(item.adamId);
            this.log(`${item.name || item.adamId} 的 adamId ${item.adamId} 疑似不存在（全部商店+补购失败）→ 等待用户改填`);
            this.emit('rs-need-id', { adamId: item.adamId, name: item.name, error: String(apiErr.message).slice(0, 120), versionIds: item.versionIds || [] });
          }
        }
        return;
      }
      if (attempt > 1) this.log(`${short} 传输重试 ${attempt}/${o.retries}`);
      try {
        await rangedDownload(info.url, tmp, {
          threads: o.threads, chunkRetries: o.chunkRetries, dlHeaders: DL_HEADERS, aborted: this.aborted,
          getFree: () => diskFreeMB(o.out), criticalFree: o.criticalFreeMB || 0,
        }, (doneB, tot, speed) => {
          this.emit('rs-progress', { key: `${item.adamId}|${vid}`, adamId: item.adamId, name: item.name, vid, done: doneB, total: tot, speed });
        });
        const meta = patchIpa(tmp, info, (client || this.client).account, {});
        const name = safeName(meta.displayName || info.name || item.name || item.adamId);
        const ver = safeName(meta.shortVersion || info.version || vid);
        const era = eraForVersion(vid) || {};
        const prefix = era.ios ? `[${era.ios}完美兼容版]` : '[历史版]';
        const fname = `${prefix}${name}_${ver}_${vid}.ipa`;
        const folder = appFolder(item.name || meta.displayName, item.adamId);
        const dir = path.join(o.out, folder);
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, fname);
        const rel = folder + '/' + fname;
        if (fs.existsSync(dest)) { try { fs.unlinkSync(tmp); } catch (_) { } }
        else fs.renameSync(tmp, dest);
        if (!this._files) this._files = new Map();
        this._files.set(vid, rel);
        mdb.setBucket(item.adamId, 'v' + vid, {
          status: 'done', versionId: vid, file: rel, version: meta.shortVersion || '',
          minOS: meta.minOS || '', bundleId: meta.bundleId || '', size: fs.statSync(dest).size,
          era: era.ios ? `${era.ios} ${era.date}` : '',
        });
        this.stats.ok++;
        this.emit('stats', { ...this.stats });
        this.emit('rs-done', {
          adamId: item.adamId, name: item.name, vid, rel, abs: dest,
          version: meta.shortVersion || '', minOS: meta.minOS || '', size: fs.statSync(dest).size,
        });
        this.log(`${item.name || item.adamId} ✓ ${rel} (v${meta.shortVersion} minOS ${meta.minOS || '?'})`);
        return;
      } catch (e) {
        if (attempt >= o.retries) {
          mdb.setBucket(item.adamId, 'v' + vid, { status: 'failed', versionId: vid, error: '下载: ' + e.message });
          this.stats.bad++;
          this.emit('stats', { ...this.stats });
          this.emit('rs-fail', { adamId: item.adamId, name: item.name, vid, error: e.message });
          this.log(`${short} 重试${o.retries}次仍失败: ${e.message}`);
        }
      }
    }
  }
}

module.exports = { RescueEngine, extractFromIpa, extractFromPlist };
