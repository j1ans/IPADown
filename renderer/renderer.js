'use strict';
const $ = (id) => document.getElementById(id);
let STATE = { settings: {}, countries: [], iosTargets: [], account: null };

function log(msg, kind) {
  const el = $('log');
  const t = new Date().toLocaleTimeString();
  el.textContent += `[${t}] ${kind ? '[' + kind + '] ' : ''}${msg}\n`;
  el.scrollTop = el.scrollHeight;
}
function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(i ? 1 : 0) + ' ' + u[i];
}
// 国家下拉：value=code，显示中文名（CN/US/JP 已在数据层置顶）。
function fillCountries(sel, current) {
  sel.innerHTML = '';
  const display = window.i18n.language === 'en' ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
  for (const c of STATE.countries) {
    const o = document.createElement('option');
    o.value = c.code; o.textContent = display ? display.of(c.code) : c.name;
    if (c.code === current) o.selected = true;
    sel.appendChild(o);
  }
}
// 地区跟随账号：把所有地区选择器同步到 cc。
function setRegion(cc) {
  if (!cc) return;
  ['loginCountry', 'searchCountry', 'batchCountry', 'setCountry'].forEach((id) => {
    const el = $(id); if (el) el.value = cc;
  });
}
function setAccountUI() {
  $('accountSwitch').value = STATE.account?.appleId || '';
  if (STATE.account) {
    const cn = window.i18n.language === 'en' ? new Intl.DisplayNames(['en'], { type: 'region' }).of(STATE.account.country) : (STATE.countries.find((c) => c.code === STATE.account.country) || {}).name || STATE.account.country;
    $('accountText').textContent = `${STATE.account.appleId} · ${cn} (${STATE.account.storefront})`;
    $('accountText').classList.remove('muted');
    $('logoutBtn').classList.remove('hidden');
  } else {
    $('accountText').textContent = window.i18n.language === 'en' ? 'Not signed in' : '未登录';
    $('accountText').classList.add('muted');
    $('logoutBtn').classList.add('hidden');
  }
}

// ---- Tabs ----
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $('tab-' + t.dataset.tab).classList.add('active');
  });
});
function switchTab(name) { document.querySelector(`.tab[data-tab="${name}"]`).click(); }
function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

// ---- Init ----
async function init() {
  const info = await window.api.init();
  STATE.countries = info.countries;
  STATE.iosTargets = info.iosTargets;
  STATE.settings = info.settings;
  STATE.account = info.account;
  $('guidText').textContent = info.guid || '(未获取到网卡 MAC)';

  // 默认地区：已登录则跟账号，否则用设置
  const region = (info.account && info.account.country) || info.settings.country;
  ['loginCountry', 'searchCountry', 'batchCountry', 'setCountry'].forEach((id) => fillCountries($(id), region));

  // 批量下载模式
  const bt = $('batchTarget');
  bt.innerHTML = '<option value="">最新版</option>'
    + '<option value="all">★ 每个系统完美兼容版各一个（下完读 Info.plist 校准版本号）</option>';
  STATE.iosTargets.slice().reverse().forEach((t) => {
    const o = document.createElement('option'); o.value = t.num; o.textContent = `仅 ${t.label} 完美兼容版`;
    bt.appendChild(o);
  });

  $('setDir').value = info.settings.downloadDir;
  $('setToolsDir').value = info.settings.toolDir || '';
  $('setAutoBuy').checked = !!info.settings.autoBuy;
  $('setNoUpdate').checked = !!info.settings.noUpdate;
  $('dlNoUpdate').checked = !!info.settings.noUpdate;

  refreshAccounts(info.accounts);
  setAccountUI();
  log('就绪。GUID=' + (info.guid || 'N/A'));
}

function refreshAccounts(list) {
  const dl = $('accountList'); dl.innerHTML = '';
  for (const a of list) { const o = document.createElement('option'); o.value = a.appleId; dl.appendChild(o); }
  const current = STATE.account?.appleId || '';
  const sel = $('accountSwitch');
  sel.innerHTML = `<option value="">${window.i18n.language === 'en' ? 'Switch account' : '切换账号'}</option>`;
  for (const a of list) { const option = document.createElement('option'); option.value = a.appleId; option.textContent = a.appleId; sel.appendChild(option); }
  sel.value = current;
}

$('accountSwitch').addEventListener('change', async () => {
  const id = $('accountSwitch').value;
  if (!id || id === STATE.account?.appleId) return;
  const result = await window.api.switchAccount(id);
  if (result.ok) {
    STATE.account = result.account;
    setAccountUI(); setRegion(result.account.country);
  } else {
    $('loginAppleId').value = id;
    const saved = await window.api.getAccount(id);
    $('loginPassword').value = saved?.password || '';
    switchTab('login');
    $('loginHint').textContent = result.error;
  }
});

// 选择已存账号时自动填密码 + 地区跟账号走
$('loginAppleId').addEventListener('change', async () => {
  const a = await window.api.getAccount($('loginAppleId').value.trim());
  if (a) { $('loginPassword').value = a.password; setRegion(a.country); }
});

// ---- Login ----
$('loginBtn').addEventListener('click', async () => {
  const hint = $('loginHint'); hint.className = 'hint'; hint.textContent = '登录中…';
  $('loginBtn').disabled = true;
  const r = await window.api.login({
    appleId: $('loginAppleId').value.trim(),
    password: $('loginPassword').value,
    code: $('loginCode').value.trim(),
    country: $('loginCountry').value,
    remember: $('loginRemember').checked,
  });
  $('loginBtn').disabled = false;
  if (r.ok) {
    STATE.account = r.account; setAccountUI();
    setRegion(r.account.country);              // 地区跟账号走
    hint.className = 'hint ok'; hint.textContent = '登录成功';
    log(`登录成功：${r.account.appleId} dsid=${r.account.dsPersonId} storefront=${r.account.storefront} 地区=${r.account.country}`);
    refreshAccounts(await window.api.listAccounts());
  } else if (r.need2FA) {
    // 需要二次验证：苹果已把验证码推送到受信任设备
    hint.className = 'hint'; hint.textContent = '⚠ ' + r.error;
    const codeEl = $('loginCode');
    codeEl.focus();
    codeEl.style.borderColor = 'var(--accent)';
    log('需要二次验证：请查看你的 iPhone/Mac/iPad 上弹出的 6 位验证码，填入后再次点击登录', 'WARN');
  } else {
    hint.className = 'hint err'; hint.textContent = r.error;
    log('登录失败：' + r.error, 'ERR');
  }
});
$('forgetBtn').addEventListener('click', async () => {
  const id = $('loginAppleId').value.trim(); if (!id) return;
  await window.api.removeAccount(id);
  refreshAccounts(await window.api.listAccounts());
  $('loginHint').textContent = '已删除 ' + id;
});
$('logoutBtn').addEventListener('click', async () => {
  await window.api.logout(); STATE.account = null; setAccountUI(); log('已退出登录');
});

// ---- Search ----
async function doSearch() {
  const term = $('searchTerm').value.trim(); if (!term) return;
  const hint = $('searchHint'); hint.className = 'hint'; hint.textContent = '搜索中…';
  const r = await window.api.search({ term, country: $('searchCountry').value, limit: 24 });
  if (!r.ok) { hint.className = 'hint err'; hint.textContent = r.error; return; }
  hint.textContent = `共 ${r.list.length} 条`;
  renderResults(r.list);
}
async function doLookup() {
  const term = $('searchTerm').value.trim(); if (!term) return;
  const hint = $('searchHint'); hint.className = 'hint'; hint.textContent = '查询中…';
  const r = await window.api.lookup({ idOrBundle: term, country: $('searchCountry').value });
  if (!r.ok) { hint.className = 'hint err'; hint.textContent = r.error; return; }
  hint.textContent = '查询成功';
  renderResults([r.info]);
}
$('searchBtn').addEventListener('click', doSearch);
$('lookupBtn').addEventListener('click', doLookup);
$('searchTerm').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

function renderResults(list) {
  const wrap = $('results'); wrap.innerHTML = '';
  for (const app of list) {
    const div = document.createElement('div'); div.className = 'app';
    const price = app.price ? `${app.price} ${app.currency || ''}` : '免费';
    div.innerHTML = `
      <img src="${app.icon || ''}" onerror="this.style.visibility='hidden'" />
      <div class="meta">
        <div class="name" title="${esc(app.name)}">${esc(app.name)}</div>
        <div class="sub">${esc(app.seller || '')}</div>
        <div class="sub">v${esc(app.version || '?')} · ${price} · id ${app.trackId}</div>
        <div class="sub">${esc(app.bundleId || '')}</div>
        <div class="acts">
          <button class="btn primary" data-act="dl">下载</button>
          <button class="btn" data-act="ver">历史版本</button>
          <button class="btn ghost" data-act="batch">加入批量</button>
        </div>
      </div>`;
    div.querySelector('[data-act="dl"]').addEventListener('click', () => {
      $('dlAppId').value = app.trackId; $('dlVersionId').value = '';
      switchTab('download'); log(`已选择 ${app.name} (id ${app.trackId})`);
    });
    div.querySelector('[data-act="ver"]').addEventListener('click', () => {
      $('dlAppId').value = app.trackId; switchTab('download'); loadVersions();
    });
    div.querySelector('[data-act="batch"]').addEventListener('click', () => {
      const ta = $('batchList');
      ta.value = (ta.value.trim() ? ta.value.trim() + '\n' : '') + app.trackId;
      log(`已加入批量：${app.name} (${app.trackId})`);
    });
    wrap.appendChild(div);
  }
}

// ---- Versions ----
async function loadVersions() {
  const appId = $('dlAppId').value.trim(); if (!appId) return;
  log('获取历史版本…');
  const r = await window.api.versions({ appId, country: $('searchCountry').value });
  const sel = $('dlVersionSelect');
  if (!r.ok || !r.ids.length) { sel.classList.add('hidden'); log('未获取到历史版本（仅能下当前版）' + (r.error ? '：' + r.error : ''), 'WARN'); return; }
  // 版本下拉（已按版本号从大到小排序），版本号来自 timbrd 合并
  sel.innerHTML = '<option value="">最新版本</option>';
  r.ids.forEach((v, i) => {
    const o = document.createElement('option'); o.value = v.id;
    const era = [v.ios, v.date].filter(Boolean).join(' · ');
    o.textContent = `${v.version ? 'v' + v.version + ' · ' : ''}${v.bestFor ? '★' + v.bestFor + '完美兼容 · ' : ''}${era ? era + ' · ' : ''}id ${v.id}${i === 0 ? ' (最新)' : ''}`;
    sel.appendChild(o);
  });
  sel.classList.remove('hidden');
  sel.onchange = () => { $('dlVersionId').value = sel.value; };
  const srcName = r.source === 'timbrd' ? 'timbrd 第三方' : '苹果官方+timbrd 合并';
  log(`共 ${r.ids.length} 个版本（来源：${srcName}），其中完美兼容版 ${(r.best || []).length} 个`);
}
$('dlVersionsBtn').addEventListener('click', loadVersions);


// ---- Buy (single) ----
$('buyBtn').addEventListener('click', async () => {
  const appId = $('dlAppId').value.trim(); if (!appId) return;
  log('请求购买/获取…');
  const r = await window.api.buy({ appId, versionId: $('dlVersionId').value.trim(), update: $('dlNoUpdate').checked });
  if (r.ok) log('购买/获取成功 ✔'); else log('购买失败：' + r.error, 'ERR');
});

// ---- Download (single) ----
$('downloadBtn').addEventListener('click', async () => {
  const appId = $('dlAppId').value.trim();
  if (!appId) { log('请填写 App ID', 'WARN'); return; }
  if (!STATE.account) { log('请先登录', 'WARN'); switchTab('login'); return; }
  $('downloadBtn').disabled = true;
  $('progressWrap').classList.remove('hidden');
  setProgress(0, '准备中…');
  const r = await window.api.download({ appId, versionId: $('dlVersionId').value.trim() });
  $('downloadBtn').disabled = false;
  if (r.ok) {
    setProgress(1, '完成');
    log(`下载完成 ✔ ${r.result.fileName}（${r.result.displayName} v${r.result.shortVersion || '?'}，sinf ${r.result.sinfCount}，可侧载）`);
    log('文件位置：' + r.result.path);
    await window.api.showItem(r.result.path);
  } else {
    log('下载失败：' + r.error, 'ERR');
    $('progressText').textContent = '失败：' + r.error;
  }
});
function setProgress(pct, text) {
  $('progressFill').style.width = Math.round((pct || 0) * 100) + '%';
  $('progressPct').textContent = Math.round((pct || 0) * 100) + '%';
  if (text) $('progressText').textContent = text;
}
window.api.onProgress((d) => {
  if (d.stage === 'download' && d.total) {
    setProgress(d.percent, `下载中 ${fmtBytes(d.received)} / ${fmtBytes(d.total)} · ${fmtBytes(d.speed)}/s`);
  } else if (d.text) {
    $('progressText').textContent = d.text; log(d.text);
  }
});

// ---- Batch ----
function parseBatch() {
  return $('batchList').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((line) => {
    const [appId, versionId] = line.split(/[,，\s]+/);
    return { appId: (appId || '').trim(), versionId: (versionId || '').trim() };
  }).filter((x) => x.appId);
}
function renderBatchRows(items) {
  const wrap = $('batchRows'); wrap.innerHTML = '';
  items.forEach((it, i) => {
    const row = document.createElement('div'); row.className = 'brow'; row.id = 'brow-' + i;
    row.innerHTML = `<span class="st">·</span><span class="id">${esc(it.appId)}${it.versionId ? '@' + esc(it.versionId) : ''}</span><span class="msg muted">等待…</span>`;
    wrap.appendChild(row);
  });
}
function updateBatchRow(i, status, msg, label) {
  let row = $('brow-' + i);
  if (!row) { // 动态创建（完美兼容/最佳兼容模式下行数会展开）
    row = document.createElement('div'); row.className = 'brow'; row.id = 'brow-' + i;
    row.innerHTML = `<span class="st">·</span><span class="id">${esc(label || ('#' + i))}</span><span class="msg muted">…</span>`;
    $('batchRows').appendChild(row);
  }
  row.className = 'brow ' + (status || '');
  const st = row.querySelector('.st');
  st.textContent = status === 'ok' ? '✔' : status === 'fail' ? '✘' : status === 'skip' ? '⊘' : status === 'doing' ? '⟳' : '·';
  if (msg != null) { const m = row.querySelector('.msg'); m.textContent = msg; m.classList.remove('muted'); }
}
window.api.onBatchProgress((d) => {
  let msg = '';
  if (d.status === 'doing') {
    msg = d.percent != null && d.total
      ? `下载中 ${fmtBytes(d.received)}/${fmtBytes(d.total)} · ${fmtBytes(d.speed)}/s`
      : (d.text || '处理中…');
  } else if (d.status === 'ok') {
    msg = d.kind === 'buy' ? '购买/获取成功' : ('完成 → ' + (d.file || ''));
  } else if (d.status === 'skip') {
    msg = '⊘ ' + (d.text || '已跳过');
  } else if (d.status === 'fail') {
    msg = '失败：' + (d.error || '');
  }
  updateBatchRow(d.index, d.status, msg, d.appId);
});

$('batchBuyBtn').addEventListener('click', async () => {
  if (!STATE.account) { log('请先登录', 'WARN'); switchTab('login'); return; }
  const items = parseBatch(); if (!items.length) { $('batchHint').textContent = '列表为空'; return; }
  await window.api.setSettings({ country: $('batchCountry').value });
  renderBatchRows(items);
  $('batchHint').textContent = `批量购买 ${items.length} 个…`;
  const r = await window.api.batchBuy({ items: items.map((x) => x.appId), update: $('batchUpdate').checked });
  const ok = (r.results || []).filter((x) => x.ok).length;
  $('batchHint').className = 'hint ok'; $('batchHint').textContent = `完成：成功 ${ok} / ${items.length}`;
});

$('batchDownloadBtn').addEventListener('click', async () => {
  if (!STATE.account) { log('请先登录', 'WARN'); switchTab('login'); return; }
  const items = parseBatch(); if (!items.length) { $('batchHint').textContent = '列表为空'; return; }
  await window.api.setSettings({ country: $('batchCountry').value });
  const target = $('batchTarget').value;
  // 'all'/指定iOS 模式会把每个 App 展开成多行，行数未知 → 清空，按进度动态生成
  if (target) { $('batchRows').innerHTML = ''; } else { renderBatchRows(items); }
  const modeTxt = target === 'all' ? '（每个系统完美兼容版各一个）' : (target ? '（指定 iOS 完美兼容版）' : '');
  $('batchHint').className = 'hint'; $('batchHint').textContent = `批量下载 ${items.length} 个 App${modeTxt}…`;
  $('batchDownloadBtn').disabled = true;
  const r = await window.api.batchDownload({ items, targetIos: target });
  $('batchDownloadBtn').disabled = false;
  const ok = (r.results || []).filter((x) => x.ok).length;
  $('batchHint').className = 'hint ok'; $('batchHint').textContent = `完成：成功 ${ok} / ${r.total || items.length}`;
  log(`批量下载完成：成功 ${ok}/${items.length}`);
});

// ---- Settings ----
$('chooseDirBtn').addEventListener('click', async () => {
  const dir = await window.api.chooseDir(); if (dir) $('setDir').value = dir;
});
$('openDirBtn').addEventListener('click', () => window.api.openPath($('setDir').value));
$('chooseToolsBtn').addEventListener('click', async () => { const dir = await window.api.chooseDir(); if (dir) $('setToolsDir').value = dir; });
$('saveSettingsBtn').addEventListener('click', async () => {
  const s = await window.api.setSettings({
    downloadDir: $('setDir').value,
    country: $('setCountry').value,
    toolDir: $('setToolsDir').value,
    autoBuy: $('setAutoBuy').checked,
    noUpdate: $('setNoUpdate').checked,
  });
  STATE.settings = s;
  $('dlNoUpdate').checked = !!s.noUpdate;
  const h = $('setHint'); h.className = 'hint ok'; h.textContent = '已保存';
  setTimeout(() => (h.textContent = ''), 1500);
});

// ---- 安装到设备（App 资源库） ----
let LIB = { list: [], device: null, installed: [], dir: '', loaded: false };
function cmpVer(a, b) { // a>b → 正
  const pa = (a || '0').split('.'); const pb = (b || '0').split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0); if (d) return d; }
  return 0;
}
function verLE(a, b) { // a <= b ?
  const pa = (a || '0').split('.'); const pb = (b || '0').split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0); if (d) return d < 0; }
  return true;
}
function isCompat(rec, devVer) { return !rec.minOS || !devVer || verLE(rec.minOS, devVer); }
function ilog(msg, kind) { const el = $('installLog'); el.textContent += `[${new Date().toLocaleTimeString()}] ${kind ? '[' + kind + '] ' : ''}${msg}\n`; el.scrollTop = el.scrollHeight; }

function setDevDot(state) { $('devDot').className = 'dev-dot' + (state ? (' ' + state) : ''); }
async function loadInstall() {
  $('devInfo').textContent = window.i18n.t('deviceChecking'); $('devInfo').className = 'dev-info muted'; setDevDot('');
  const ds = await window.api.devStatus();
  if (!ds.ok) { $('devInfo').textContent = window.i18n.t('deviceFailed'); setDevDot('off'); LIB.device = null; }
  else if (!ds.toolsReady) { $('devInfo').innerHTML = `⚠ ${esc(window.i18n.language === 'en' ? 'Device tools missing' : '未找到设备工具')}<br><span class="small">${esc(ds.tools?.installHint || '')}</span>`; setDevDot('off'); LIB.device = null; }
  else if (!ds.device) { $('devInfo').innerHTML = `${esc(window.i18n.t('deviceMissing'))}<br><span class="muted small">${esc(window.i18n.t('deviceConnectHint'))}</span>`; setDevDot('off'); LIB.device = null; LIB.installed = []; }
  else {
    LIB.device = ds.device; LIB.installed = ds.installed || [];
    setDevDot('on');
    $('devInfo').className = 'dev-info connected';
    $('devInfo').innerHTML = `<b>${esc(ds.device.name)}</b><br>${esc(ds.device.productType)}<br>iOS <b>${esc(ds.device.productVersion)}</b><br><span class="muted small">${esc(window.i18n.t('deviceInstalledCount', { count: LIB.installed.length }))}</span>`;
  }
  $('libHint').textContent = window.i18n.t('scanning');
  const r = await window.api.libScan({});
  if (r.ok) { LIB.list = r.list; LIB.dir = r.dir; LIB.indexed = r.indexed; } else { ilog(window.i18n.t('scanFailed', { error: r.error }), 'ERR'); }
  renderLib();
}

function renderLib() {
  const grid = $('libGrid'); grid.innerHTML = '';
  const filter = (document.querySelector('input[name=libFilter]:checked') || {}).value || 'compat';
  const devVer = LIB.device && LIB.device.productVersion;
  const instMap = new Map(LIB.installed.map((a) => [a.bundleId, a.version]));
  const query = $('libSearch').value.trim().toLowerCase();
  const groups = window.libraryView.buildGroups(LIB.list, devVer).filter((g) => {
    if (filter !== 'all' && !g.preferred) return false;
    if (filter === 'perfect' && !window.libraryView.perfectFor(g.preferred, devVer)) return false;
    if ($('libHideInstalled').checked && instMap.has(g.app.bundleId)) return false;
    return !query || [g.app.name, g.app.bundleId, g.app.appId].some((x) => String(x || '').toLowerCase().includes(query));
  });
  $('libHint').textContent = window.i18n.t('libraryCount', { apps: groups.length, files: LIB.list.length, indexed: LIB.indexed || 0 });
  for (const group of groups) grid.appendChild(libApp(group, filter, devVer, instMap));
  if (!groups.length) grid.innerHTML = `<div class="empty-state">${esc(window.i18n.t('noApps'))}</div>`;
}

function libApp(group, filter, devVer, instMap) {
  const r = group.preferred || group.app;
  const el = document.createElement('article'); el.className = 'library-app';
  const versions = filter === 'perfect' ? [] : group.supported.concat(filter === 'all' ? group.incompatible : []);
  const installed = instMap.get(r.bundleId);
  const tag = window.libraryView.perfectFor(r, devVer) ? window.i18n.t('perfectVersion') : window.i18n.t('recommendedVersion');
  el.innerHTML = `<div class="library-app-head">
    ${r.icon ? `<img class="library-icon" src="${r.icon}" alt="" />` : '<div class="library-icon noicon">◈</div>'}
    <div class="library-identity"><h3>${esc(r.name)}</h3><p>${esc(r.bundleId || r.appId || r.file)}</p></div>
    <span class="version-count">${group.files} IPA</span></div>
    <div class="library-choice preferred">
      <label class="check"><input type="checkbox" class="libChk" data-path="${esc(r.path)}" ${group.preferred ? '' : 'disabled'} />
        <span><b>${esc(tag)}</b><small>v${esc(r.version || '?')} · iOS ${esc(r.minOS || '?')}+ · ${r.sizeMB} MB</small></span></label>
      ${installed ? `<span class="b inst">${esc(window.i18n.t('installed'))} v${esc(installed)}</span>` : ''}
    </div>
    ${versions.length ? `<details><summary>${esc(window.i18n.t('otherVersions', { count: versions.length }))}</summary><div class="version-list">${versions.map((v) => `<label class="library-choice check ${window.libraryView.compatible(v, devVer) ? '' : 'incompat'}"><input type="checkbox" class="libChk" data-path="${esc(v.path)}" ${window.libraryView.compatible(v, devVer) ? '' : 'disabled'} /><span>v${esc(v.version || '?')}<small>iOS ${esc(v.minOS || '?')}+ · ${v.sizeMB} MB</small></span></label>`).join('')}</div></details>` : ''}`;
  return el;
}

document.querySelectorAll('input[name=libFilter]').forEach((r) => r.addEventListener('change', renderLib));
$('libSearch').addEventListener('input', renderLib);
window.addEventListener('languagechange', () => {
  setAccountUI();
  const region = $('setCountry').value;
  ['loginCountry', 'searchCountry', 'batchCountry', 'setCountry'].forEach((id) => fillCountries($(id), region));
  if (LIB.loaded) renderLib();
});
$('libHideInstalled').addEventListener('change', renderLib);
$('devRefreshBtn').addEventListener('click', loadInstall);
$('libRescanBtn').addEventListener('click', loadInstall);
// 智能全选：每个 App 选「本机可装中版本最高」的一个（根据系统版本自动选兼容版）
$('libSelectCompat').addEventListener('click', () => {
  const devVer = LIB.device && LIB.device.productVersion;
  const pick = new Set(window.libraryView.buildGroups(LIB.list, devVer).map((g) => g.preferred?.path).filter(Boolean));
  let n = 0;
  document.querySelectorAll('.libChk').forEach((c) => {
    const on = pick.has(c.dataset.path) && !c.disabled; c.checked = on;
    if (on) n++;
  });
  $('libHint').textContent = window.i18n.t('smartSelected', { count: n });
});
$('libInstallSel').addEventListener('click', async () => {
  const files = Array.from(document.querySelectorAll('.libChk')).filter((c) => c.checked).map((c) => c.dataset.path);
  if (!files.length) { ilog('未选中任何 IPA', 'WARN'); return; }
  if (!LIB.device) { ilog('未连接设备，无法安装', 'WARN'); return; }
  $('libInstallSel').disabled = true;
  ilog(`开始安装 ${files.length} 个 IPA 到 ${LIB.device.name}…`);
  const r = await window.api.devInstall({ files });
  $('libInstallSel').disabled = false;
  if (!r.ok) { ilog('安装失败：' + r.error, 'ERR'); return; }
  const ok = (r.results || []).filter((x) => x.ok).length;
  ilog(`安装完成：成功 ${ok}/${files.length}`);
  loadInstall();
});
window.api.onInstallProgress((d) => { ilog(`(${d.index + 1}/${d.total}) ${d.file}: ${d.text || d.status}`); });
// 首次切到安装 tab 自动加载
document.querySelector('.tab[data-tab="install"]').addEventListener('click', () => {
  if (!LIB.loaded) { LIB.loaded = true; loadInstall(); }
});

init().catch((e) => log('初始化失败：' + e.message, 'ERR'));
