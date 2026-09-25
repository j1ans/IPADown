'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const { machineGUID } = require('./guid');
const { StoreClient, PRICING_BUY, PRICING_UPDATE } = require('./store');
const lookup = require('./lookup');
const ipa = require('./ipa');
const { Config } = require('./config');
const { countryList } = require('./storefront');
const iosmap = require('./iosmap');
const device = require('./device');
const { PurchaseDB } = require('./purchasedb');
const fs = require('fs');

let win = null;
let config = null;
let guid = '';
const client = () => store; // 单会话客户端
let store = null;
let purchaseDB = null;
let runtimePassword = '';
function workerSession() {
  if (!store?.account?.passwordToken) return null;
  const account = store.account;
  return { ...account, cookies: store.jar.header(), password: runtimePassword || config.getAccount(account.appleId)?.password || '' };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 850,
    minWidth: 900,
    minHeight: 600,
    title: 'ipaDown',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // 已购记录：内置 webview 登录 reportaproblem.apple.com
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // F12 切换开发者工具
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
}

// Backup and rescue engines run as Node processes for the SQLite native ABI.
// 引擎跑在独立 node 子进程（src/backup-daemon.js），行 JSON 通信——
// better-sqlite3 原生模块按系统 Node 编译，不能直接在 Electron ABI 里 require。
const { spawn } = require('child_process');
function spawnWorker(file, args = [], options = {}) {
  const packaged = app.isPackaged;
  const workerRoot = path.join(process.resourcesPath, 'worker');
  const executable = packaged ? path.join(workerRoot, process.platform === 'win32' ? 'node.exe' : 'node') : 'node';
  const entry = packaged ? path.join(workerRoot, 'src', path.basename(file)) : file;
  return spawn(executable, [entry, ...args], {
    windowsHide: true,
    ...options,
  });
}

let BKU_OUT = '';
let bdaemon = null;
let bkuLastStart = null; // 挂机守护：记住最近一次 start 的参数，daemon 意外退出后自动续跑

function bsend(type, data) {
  if (win && !win.isDestroyed()) win.webContents.send('bku:ev', Object.assign({ type }, data || {}));
}

function startDaemon() {
  if (bdaemon && !bdaemon.killed) return bdaemon;
  bdaemon = spawnWorker(path.join(__dirname, 'backup-daemon.js'), [], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  bdaemon.stdout.setEncoding('utf8');
  bdaemon.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'done' || ev.type === 'start-err') bkuLastStart = null;
        bsend(ev.type, ev);
      } catch (_) { /* 跳过坏行 */ }
    }
  });
  bdaemon.stderr.setEncoding('utf8');
  bdaemon.stderr.on('data', (d) => {
    try { fs.appendFileSync(path.join(BKU_OUT, 'ipabackup.log'), d); } catch (_) { }
  });
  bdaemon.on('error', (error) => bsend('start-err', { error: error.message }));
  bdaemon.on('exit', () => {
    bdaemon = null;
    bsend('log', { msg: '后台进程退出' });
    bsend('done', {});
    // 挂机守护：任务进行中进程意外挂掉 → 5 秒后自动重启续跑（断点由 manifest 承接）
    if (bkuLastStart) {
      setTimeout(() => {
        if (!bdaemon && bkuLastStart && win && !win.isDestroyed()) {
          bsend('log', { msg: '⟳ 检测到后台进程退出，自动重启续跑…' });
          dsend({ cmd: 'init', out: BKU_OUT });
          dsend({ cmd: 'start', opts: bkuLastStart });
        }
      }, 5000);
    }
  });
  return bdaemon;
}

function dsend(obj) {
  const d = startDaemon();
  try { d.stdin.write(JSON.stringify(obj) + '\n'); } catch (_) { }
}

ipcMain.handle('bku:init', () => { dsend({ cmd: 'init', out: BKU_OUT }); return { ok: true, out: BKU_OUT }; });
ipcMain.handle('bku:stop', () => { bkuLastStart = null; dsend({ cmd: 'stop' }); return { ok: true }; });
ipcMain.handle('bku:state', () => { dsend({ cmd: 'state' }); return { ok: true }; });
ipcMain.handle('bku:start', (_e, p) => {
  const session = workerSession();
  if (!session) return { ok: false, error: '请先登录 Apple ID' };
  bkuLastStart = { ...(p || {}), session };
  dsend({ cmd: 'start', opts: bkuLastStart });
  return { ok: true };
});

let rdaemon = null;
function rsend(event) { if (win && !win.isDestroyed()) win.webContents.send('rs:ev', event); }
function rescueDaemon() {
  if (rdaemon && !rdaemon.killed) return rdaemon;
  rdaemon = spawnWorker(path.join(__dirname, 'rescue-daemon.js'), [], { stdio: ['pipe', 'pipe', 'pipe'] });
  let pending = '';
  rdaemon.stdout.setEncoding('utf8');
  rdaemon.stdout.on('data', (chunk) => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      try { rsend(JSON.parse(line)); } catch (_) { /* malformed event */ }
    }
  });
  rdaemon.stderr.setEncoding('utf8');
  rdaemon.stderr.on('data', (chunk) => rsend({ type: 'log', text: chunk.trim() }));
  rdaemon.on('error', (error) => rsend({ type: 'start-err', error: error.message }));
  rdaemon.on('exit', () => { rdaemon = null; rsend({ type: 'done' }); });
  return rdaemon;
}
ipcMain.handle('rs:send', (_e, obj) => {
  const command = obj || {};
  if (command.cmd === 'init') command.out = BKU_OUT;
  if (command.cmd === 'start') {
    command.session = workerSession();
    if (!command.session) return { ok: false, error: '请先登录 Apple ID' };
  }
  rescueDaemon().stdin.write(JSON.stringify(command) + '\n');
  return { ok: true };
});
ipcMain.handle('rs:pick', async () => {
  const result = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'IPA, ZIP, plist', extensions: ['ipa', 'zip', 'plist'] }] });
  return result.canceled ? [] : result.filePaths;
});
ipcMain.handle('dialog:chooseFile', async (_e, extensions) => {
  const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'File', extensions: Array.isArray(extensions) ? extensions : ['*'] }] });
  return result.canceled ? '' : result.filePaths[0];
});

app.whenReady().then(() => {
  config = new Config(app.getPath('userData'), safeStorage);
  try { guid = machineGUID(); } catch (e) { guid = ''; }
  store = new StoreClient(guid);
  const saved = config.getSession();
  if (saved?.dsPersonId && saved?.passwordToken) {
    store.importSession(saved);
    runtimePassword = config.getAccount(saved.appleId)?.password || '';
  }
  purchaseDB = new PurchaseDB(path.join(app.getPath('userData'), 'purchases.json'));
  BKU_OUT = path.join(app.getPath('userData'), 'ipa-backups');
  // libimobiledevice 工具目录：应用自带 tools/ + 用户设置覆盖
  device.setToolDirs([
    config.getSettings().toolDir,
    path.join(__dirname, '..', 'tools', 'libimobiledevice'),
    path.join(process.resourcesPath || '', 'tools', 'libimobiledevice'),
  ]);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (bdaemon) bdaemon.kill();
  if (rdaemon) rdaemon.kill();
  if (process.platform !== 'darwin') app.quit();
});

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

// 版本号比较（降序：大版本在前）。无版本号时回退按 version-id 降序。
function cmpVersionDesc(a, b) {
  if (a.version && b.version) {
    const ta = a.version.split('.'); const tb = b.version.split('.');
    const n = Math.max(ta.length, tb.length);
    for (let i = 0; i < n; i++) {
      const d = (parseInt(tb[i], 10) || 0) - (parseInt(ta[i], 10) || 0);
      if (d) return d;
    }
  }
  return (Number(b.id) || 0) - (Number(a.id) || 0);
}

// 计算「每个 iOS 世代的完美兼容版」：官方 id 全集 + timbrd 版本号。
async function computeBest(appId, cc) {
  let appleIds = [];
  if (store.account) { try { const r = await store.listVersions(appId); appleIds = r.ids.map(String); } catch (_) { /* ignore */ } }
  let tb = [];
  try { tb = await lookup.versionHistory(appId, cc); } catch (_) { /* ignore */ }
  const verMap = new Map(tb.map((x) => [String(x.id), x.version || '']));
  const allIds = appleIds.length ? appleIds : tb.map((x) => String(x.id));
  const seen = new Set(); const best = [];
  for (const t of iosmap.iosTargets()) {
    const id = iosmap.bestCompatibleFor(t.num, allIds);
    if (id && !seen.has(id)) {
      seen.add(id);
      const era = iosmap.eraForVersion(id) || {};
      best.push({ ios: t.label, num: t.num, id, version: verMap.get(id) || '', date: era.date || '' });
    }
  }
  return best;
}

// ---- IPC：所有耗时操作集中于主进程，渲染层只发指令 ----

ipcMain.handle('app:init', () => ({
  guid,
  countries: countryList(),       // [{code, name(中文)}]，CN/US/JP 置顶
  iosTargets: iosmap.iosTargets(), // 批量「最佳兼容」可选 iOS
  settings: config.getSettings(),
  accounts: config.listAccounts(),
  loggedIn: !!(store && store.account),
  account: store && store.account ? publicAccount(store.account) : null,
}));

ipcMain.handle('settings:get', () => config.getSettings());
ipcMain.handle('settings:set', (_e, s) => {
  const settings = config.setSettings(s);
  device.setToolDirs([settings.toolDir, path.join(__dirname, '..', 'tools', 'libimobiledevice'), path.join(process.resourcesPath || '', 'tools', 'libimobiledevice')]);
  return settings;
});

ipcMain.handle('dialog:chooseDir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
});

ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
ipcMain.handle('shell:showItem', (_e, p) => shell.showItemInFolder(p));

// ---- 安装软件（资源库 + 设备） ----
// 扫描下载目录的 IPA（含原生图标、版本、最低 iOS、兼容标签）
ipcMain.handle('lib:scan', async (_e, { dir } = {}) => {
  try {
    const d = dir || config.getSettings().downloadDir;
    const dbFile = path.join(app.getPath('userData'), 'ipa-library.sqlite');
    const result = await new Promise((resolve, reject) => {
      const child = spawnWorker(path.join(__dirname, 'library-index.js'), [d, dbFile], { stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks = []; const errors = [];
      child.stdout.on('data', (chunk) => chunks.push(chunk));
      child.stderr.on('data', (chunk) => errors.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code) reject(new Error(Buffer.concat(errors).toString('utf8') || `索引进程退出：${code}`));
        else { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } }
      });
    });
    return { ok: true, dir: d, ...result };
  } catch (err) { return { ok: false, error: err.message }; }
});

// 设备状态：工具是否就绪 + 已连接设备信息 + 已装应用
ipcMain.handle('dev:status', () => {
  const tools = device.toolStatus();
  if (!tools.ready) return { ok: true, toolsReady: false, tools };
  const udids = device.listDevices();
  if (!udids.length) return { ok: true, toolsReady: true, device: null };
  const info = device.deviceInfo(udids[0]);
  const apps = device.installedApps(udids[0]);
  return { ok: true, toolsReady: true, device: info, installed: apps.apps || [] };
});

// ---- 已购记录数据库（按 Apple ID 分账号） ----
// 账号列表（左侧边栏）
ipcMain.handle('purchases:accounts', () => ({ ok: true, accounts: purchaseDB.listAccounts() }));

ipcMain.handle('purchases:cursor', (_e, { dsid }) => ({
  ok: true, topPurchaseId: purchaseDB.topPurchaseId(dsid),
}));
ipcMain.handle('purchases:append', (_e, { dsid, email, name, purchases }) => {
  try {
    if (!/^\d+$/.test(String(dsid || '')) || !Array.isArray(purchases) || purchases.length > 200)
      return { ok: false, error: '购买记录批次格式不正确' };
    const added = purchaseDB.merge(dsid, email || '', name || '', purchases);
    purchaseDB.stamp(dsid);
    purchaseDB.save();
    return { ok: true, added, total: Object.keys(purchaseDB.account(dsid).apps).length };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('purchases:finish', (_e, { dsid, newTop }) => {
  if (!/^\d+$/.test(String(dsid || ''))) return { ok: false, error: '账号 ID 不正确' };
  purchaseDB.setTop(dsid, newTop);
  purchaseDB.stamp(dsid);
  purchaseDB.save();
  return { ok: true, total: Object.keys(purchaseDB.account(dsid).apps).length };
});

// 指定账号的表格 + 增量游标
ipcMain.handle('purchases:state', (_e, { dsid } = {}) => ({
  ok: true,
  topPurchaseId: dsid ? purchaseDB.topPurchaseId(dsid) : '',
  table: dsid ? purchaseDB.tableFor(dsid) : [],
  accounts: purchaseDB.listAccounts(),
}));

// 渲染层在 webview 里捕获到页面自己的 search 响应后，调这个入库。
// 不在主进程发请求、不附加 CDP 调试器（避免被苹果反调试踢出）。
ipcMain.handle('purchases:save', (_e, { dsid, email, name, purchases, newTop }) => {
  try {
    if (!dsid) return { ok: false, error: '未取到账号 dsid' };
    const added = purchaseDB.merge(dsid, email || '', name || '', purchases || []);
    if (newTop) purchaseDB.setTop(dsid, newTop);
    purchaseDB.stamp(dsid);
    purchaseDB.save();
    return { ok: true, added, dsid, table: purchaseDB.tableFor(dsid), accounts: purchaseDB.listAccounts() };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('purchases:clear', (_e, { dsid } = {}) => {
  purchaseDB.clear(dsid);
  return { ok: true, table: dsid ? purchaseDB.tableFor(dsid) : [], accounts: purchaseDB.listAccounts() };
});

// 手动给账号重命名（不自动抓用户名）
ipcMain.handle('purchases:setLabel', (_e, { dsid, label }) => {
  purchaseDB.setLabel(dsid, label);
  purchaseDB.save();
  return { ok: true, accounts: purchaseDB.listAccounts() };
});

// 把某 appid 送到下载页（前端用）——这里仅占位，前端直接切 tab 填入
ipcMain.handle('purchases:exportCsv', async (_e, { rows }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: 'purchases.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
  if (r.canceled || !r.filePath) return { ok: false };
  const head = 'adamId,name,developer,type,storefront,isFree,date\n';
  const body = (rows || []).map((a) => [a.adamId, '"' + (a.name || '').replace(/"/g, '""') + '"', '"' + (a.dev || '').replace(/"/g, '""') + '"', a.type, a.storefrontId, a.isFree, a.pliDate].join(',')).join('\n');
  fs.writeFileSync(r.filePath, '﻿' + head + body, 'utf8');
  return { ok: true, path: r.filePath };
});

// 安装一批 IPA，进度走 install:progress 事件
ipcMain.handle('dev:install', async (_e, { files }) => {
  const udids = device.listDevices();
  if (!udids.length) return { ok: false, error: '未检测到已连接设备' };
  const udid = udids[0];
  const results = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const base = { index: i, total: files.length, file: path.basename(f) };
    send('install:progress', Object.assign({}, base, { status: 'doing', text: '安装中…' }));
    const r = await device.install(udid, f, (line) => send('install:progress', Object.assign({}, base, { status: 'doing', text: line })));
    results.push({ file: f, ok: r.ok, error: r.error });
    send('install:progress', Object.assign({}, base, { status: r.ok ? 'ok' : 'fail', text: r.ok ? '安装成功' : ('失败 ' + (r.error || 'code ' + r.code)) }));
  }
  return { ok: true, results };
});

// 账号管理
ipcMain.handle('account:list', () => config.listAccounts());
ipcMain.handle('account:get', (_e, id) => config.getAccount(id));
ipcMain.handle('account:remove', (_e, id) => {
  if (store.account?.appleId === id) { store.logout(); runtimePassword = ''; }
  config.removeAccount(id);
  return config.listAccounts();
});

ipcMain.handle('auth:switch', (_e, appleId) => {
  const session = config.getSession(appleId);
  if (!session?.passwordToken) return { ok: false, error: '此账号需要重新登录' };
  store.logout();
  store.importSession(session);
  runtimePassword = config.getAccount(appleId)?.password || '';
  config.setActiveAccount(appleId);
  return { ok: true, account: publicAccount(store.account) };
});

ipcMain.handle('auth:login', async (_e, { appleId, password, code, country, remember }) => {
  try {
    if (!guid) throw new Error('未能获取本机网卡 MAC，无法生成 GUID');
    // The 2FA reply must retain cookies from the challenge request.
    if (!code || store.account?.appleId !== appleId) store.logout();
    const acc = await store.authenticate(appleId, password, code, country || config.getSettings().country);
    runtimePassword = password;
    if (remember) {
      config.saveAccount(appleId, password, country || config.getSettings().country);
      config.saveSession(appleId, { ...acc, cookies: store.jar.header() });
    } else config.clearSession(appleId);
    config.setSettings({ country: acc.country || country });
    return { ok: true, account: publicAccount(acc) };
  } catch (err) {
    return { ok: false, error: err.message, need2FA: !!err.need2FA };
  }
});

ipcMain.handle('auth:logout', () => { store.logout(); runtimePassword = ''; config.clearSession(); return { ok: true }; });

ipcMain.handle('store:search', async (_e, { term, country, limit }) => {
  try {
    const list = await lookup.search(term, country || config.getSettings().country, limit || 20);
    return { ok: true, list };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('store:lookup', async (_e, { idOrBundle, country }) => {
  try {
    const cc = country || config.getSettings().country;
    const info = /^\d+$/.test(String(idOrBundle).trim())
      ? await lookup.lookup(idOrBundle, cc)
      : await lookup.lookupByBundle(idOrBundle, cc);
    return { ok: true, info };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('store:versions', async (_e, { appId, country }) => {
  try {
    const cc = country || config.getSettings().country;
    // ① 苹果官方·已鉴权：完整、准确的 version-id 全集（按 storefront），但只有 id 没有版本号
    let appleIds = [];
    if (store.account) {
      try { const r = await store.listVersions(appId); appleIds = r.ids.map(String); } catch (_) { /* ignore */ }
    }
    // ② timbrd 第三方：提供 id → 版本号(bundle_version) 映射（也作未登录时的回退列表）
    let tb = [];
    try { tb = await lookup.versionHistory(appId, cc); } catch (_) { /* ignore */ }
    const verMap = new Map(tb.map((x) => [String(x.id), x.version || '']));

    // 合并：以官方 id 全集为准，版本号取自 timbrd（两个 API 合并）
    let rawIds; let source;
    if (appleIds.length) {
      rawIds = appleIds.map((id) => ({ id, version: verMap.get(id) || '' }));
      source = 'apple+timbrd';
    } else {
      rawIds = tb.map((x) => ({ id: String(x.id), version: x.version || '' }));
      source = 'timbrd';
    }
    const allIds = rawIds.map((v) => v.id);
    // 每个 iOS 世代的「完美兼容版」= 该代仍能装的最新版本
    const bestMap = new Map(); // id -> iosLabel
    const best = [];
    for (const t of iosmap.iosTargets()) {
      const id = iosmap.bestCompatibleFor(t.num, allIds);
      // 该世代无任何可兼容版本（App 那时还不存在）→ 不加入
      if (id && !bestMap.has(id)) {
        bestMap.set(id, t.label);
        const era = iosmap.eraForVersion(id) || {};
        best.push({ ios: t.label, num: t.num, id, version: verMap.get(id) || '', date: era.date || '' });
      }
    }
    const enriched = rawIds.map((v) => {
      const era = iosmap.eraForVersion(v.id) || {};
      return { id: v.id, version: v.version, date: era.date || '', ios: era.ios || '', device: era.device || '', bestFor: bestMap.get(v.id) || '' };
    });
    enriched.sort(cmpVersionDesc); // 版本号从大到小
    return { ok: true, ids: enriched, source, best };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('store:buy', async (_e, { appId, versionId, update }) => {
  try {
    await store.buy(appId, versionId, update ? PRICING_UPDATE : PRICING_BUY);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

// 核心下载流程（单个/批量共用）：可选自动购买 → volumeStoreDownloadProduct → 注入 sinf/metadata。
// compatTag: 文件名方括号里的「最佳兼容」标签（如 iOS12），空则不加。
async function doDownload(appId, versionId, compatTag, onProgress) {
  if (!store.account) throw new Error('请先登录');
  const settings = config.getSettings();
  let info;
  try {
    info = await store.download(appId, versionId);
  } catch (e1) {
    if (settings.autoBuy && e1.code === 'NOT_OWNED') {
      if (onProgress) onProgress({ stage: 'buy', text: '账号未拥有，尝试自动获取…' });
      await store.buy(appId, versionId, settings.noUpdate ? PRICING_UPDATE : PRICING_BUY);
      info = await store.download(appId, versionId);
    } else {
      throw e1;
    }
  }
  const owned = purchaseDB.data.accounts[String(store.account.dsPersonId)]?.apps?.[String(appId)];
  return ipa.downloadAndPatch(
    info, store.account, settings.downloadDir,
    { noUpdate: settings.noUpdate, compatTag, purchaseDate: owned?.pliDate },
    onProgress
  );
}

// 单个下载，进度走 download:progress 事件。
ipcMain.handle('store:download', async (_e, { appId, versionId }) => {
  try {
    send('download:progress', { stage: 'request', text: '请求下载授权…' });
    // 指定了版本号时，按其所属 iOS 世代打「最佳兼容」标签
    const tag = versionId && versionId !== '0' ? iosmap.compatTag(versionId) : '';
    const result = await doDownload(appId, versionId, tag, (p) => send('download:progress', {
      stage: p.stage || 'download',
      text: p.text,
      percent: p.percent, received: p.received, total: p.total, speed: p.speed,
    }));
    send('download:progress', { stage: 'patch', text: '注入 iTunesMetadata / sinf 完成' });
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 批量购买：items=[appId,...]，逐个 buy。进度走 batch:progress。
ipcMain.handle('store:batchBuy', async (_e, { items, update }) => {
  if (!store.account) return { ok: false, error: '请先登录' };
  const results = [];
  for (let i = 0; i < items.length; i++) {
    const appId = String(items[i]).trim();
    if (!appId) continue;
    send('batch:progress', { kind: 'buy', index: i, total: items.length, appId, status: 'doing' });
    try {
      await store.buy(appId, '0', update ? PRICING_UPDATE : PRICING_BUY);
      results.push({ appId, ok: true });
      send('batch:progress', { kind: 'buy', index: i, total: items.length, appId, status: 'ok' });
    } catch (err) {
      results.push({ appId, ok: false, error: err.message });
      send('batch:progress', { kind: 'buy', index: i, total: items.length, appId, status: 'fail', error: err.message });
    }
  }
  return { ok: true, results };
});

// 批量下载：items=[{appId, versionId?}]。
// targetIos: '' = 最新版；'all' = 每个 App 的每个系统完美兼容版各一个；数字 = 指定 iOS 最佳兼容版。
ipcMain.handle('store:batchDownload', async (_e, { items, targetIos }) => {
  if (!store.account) return { ok: false, error: '请先登录' };
  const settings = config.getSettings();
  const targetNum = targetIos && targetIos !== 'all' ? Number(targetIos) : 0;

  // 先把输入展开成扁平工作清单 [{appId, versionId, tag, label}]
  const work = [];
  for (const it of items) {
    const appId = String(it.appId).trim();
    if (!appId) continue;
    const userVer = (it.versionId || '').trim();
    if (userVer && userVer !== '0') {
      work.push({ appId, versionId: userVer, tag: iosmap.compatTag(userVer), label: appId });
    } else if (targetIos === 'all') {
      // 每个系统完美兼容版各一个；无兼容版则跳过（不下最新版）
      let best = [];
      try { best = await computeBest(appId, settings.country); } catch (_) { /* ignore */ }
      if (!best.length) work.push({ appId, label: appId, skip: '无完美兼容版，已跳过' });
      for (const b of best) work.push({ appId, versionId: b.id, tag: b.ios, label: `${appId}·${b.ios}` });
    } else if (targetNum) {
      let best = [];
      try { best = await computeBest(appId, settings.country); } catch (_) { /* ignore */ }
      const pick = best.find((b) => b.num === targetNum);
      if (pick) work.push({ appId, versionId: pick.id, tag: pick.ios, label: `${appId}·${pick.ios}` });
      else work.push({ appId, label: appId, skip: `无 iOS${targetNum} 兼容版，已跳过` }); // 不兜底下最新版
    } else {
      work.push({ appId, versionId: '', tag: '', label: appId });
    }
  }

  const results = [];
  for (let i = 0; i < work.length; i++) {
    const w = work[i];
    const base = { kind: 'download', index: i, total: work.length, appId: w.label };
    if (w.skip) { // 无兼容版 → 跳过，不下载
      results.push({ appId: w.label, ok: false, skipped: true, error: w.skip });
      send('batch:progress', Object.assign({}, base, { status: 'skip', text: w.skip }));
      continue;
    }
    send('batch:progress', Object.assign({}, base, { status: 'doing', text: '下载中…' }));
    try {
      const result = await doDownload(w.appId, w.versionId, w.tag, (p) => send('batch:progress',
        Object.assign({}, base, { status: 'doing', percent: p.percent, received: p.received, total: p.total, speed: p.speed, text: p.text })));
      results.push({ appId: w.label, ok: true, file: result.fileName });
      send('batch:progress', Object.assign({}, base, { status: 'ok', file: result.fileName }));
    } catch (err) {
      results.push({ appId: w.label, ok: false, error: err.message });
      send('batch:progress', Object.assign({}, base, { status: 'fail', error: err.message }));
    }
  }
  return { ok: true, results, total: work.length };
});

function publicAccount(a) {
  return {
    appleId: a.appleId, dsPersonId: a.dsPersonId,
    storefront: a.storefront, country: a.country,
    firstName: a.firstName, lastName: a.lastName,
  };
}
