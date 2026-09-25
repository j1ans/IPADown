'use strict';

let OWNED = [];
let ownedFiltered = [];
const ownedSelected = new Set();
const rapState = { liveDsid: '', viewDsid: '', name: '', email: '', crawling: false, checking: false, stopRequested: false, autoStarted: new Set(), pages: 0 };
const IOS_APP = /IOSApp|iPadApp|UniversalApp/i;
const ROW_HEIGHT = 49;

function rapStatus(message, good) {
  $('rapStatus').textContent = message;
  $('rapStatus').className = 'dev-info ' + (good ? 'connected' : 'muted');
}
function rapDot(on) { $('rapDot').className = 'dev-dot ' + (on ? 'on' : 'off'); }
function onRapHost() {
  try { return new URL($('rapWebview').getURL()).hostname === 'reportaproblem.apple.com'; }
  catch (_) { return false; }
}

async function renderAccounts() {
  const result = await window.api.purchasesAccounts();
  const accounts = result.accounts || [];
  if (rapState.liveDsid && !accounts.some((a) => a.dsid === rapState.liveDsid)) {
    accounts.unshift({ dsid: rapState.liveDsid, appleId: rapState.email, name: rapState.name, count: 0 });
  }
  const wrap = $('rapAccounts');
  wrap.replaceChildren();
  if (!accounts.length) { wrap.innerHTML = '<div class="rap-empty">登录后会自动抓取购买记录</div>'; return; }
  if (!rapState.viewDsid) rapState.viewDsid = rapState.liveDsid || accounts[0].dsid;
  for (const a of accounts) {
    const el = document.createElement('div');
    el.className = 'rap-acct' + (a.dsid === rapState.viewDsid ? ' active' : '') + (a.dsid === rapState.liveDsid ? ' live' : '');
    el.innerHTML = `<div class="ra-row"><div class="ra-id" title="${esc(a.dsid)}">${esc(a.label || a.name || a.appleId || a.dsid)}</div><span class="ra-edit" title="重命名">✎</span></div><div class="ra-sub">${esc(a.appleId || a.dsid)} · ${a.count || 0} 个 App${a.dsid === rapState.liveDsid ? ' · 当前登录' : ''}</div>`;
    el.querySelector('.ra-id').addEventListener('click', () => selectOwnedAccount(a.dsid));
    el.querySelector('.ra-edit').addEventListener('click', () => {
      const name = prompt('账号显示名称', a.label || '');
      if (name !== null) window.api.purchasesSetLabel({ dsid: a.dsid, label: name.trim() }).then(renderAccounts);
    });
    wrap.appendChild(el);
  }
}

async function selectOwnedAccount(dsid) {
  rapState.viewDsid = dsid;
  ownedSelected.clear();
  const result = await window.api.purchasesState({ dsid });
  renderOwned(result.table || [], true);
  await renderAccounts();
}

function ownedRow(a) {
  const ios = IOS_APP.test(a.type || '');
  const id = String(a.adamId);
  return `<tr><td>${ios ? `<input type="checkbox" class="ownChk" data-id="${esc(id)}" ${ownedSelected.has(id) ? 'checked' : ''}>` : ''}</td>`
    + `<td>${a.artworkURL ? `<img loading="lazy" src="${esc(a.artworkURL)}">` : ''}</td>`
    + `<td class="oid">${esc(id)}</td><td class="onm" title="${esc(a.name)}">${esc(a.name)}</td>`
    + `<td class="odev" title="${esc(a.dev)}">${esc(a.dev)}</td>`
    + `<td><span class="otype ${ios ? 'ios' : ''}">${esc(a.type)}</span></td>`
    + `<td>${esc(a.storefrontId)}</td><td>${esc((a.pliDate || '').slice(0, 10))}</td>`
    + `<td>${ios ? `<button class="btn owndl" data-id="${esc(id)}" data-nm="${esc(a.name)}">下载</button>` : ''}</td></tr>`;
}

function renderOwnedViewport() {
  const wrap = document.querySelector('#tab-owned .owned-table-wrap');
  const visible = Math.ceil(wrap.clientHeight / ROW_HEIGHT) + 16;
  const start = Math.max(0, Math.floor(wrap.scrollTop / ROW_HEIGHT) - 8);
  const end = Math.min(ownedFiltered.length, start + visible);
  const top = start * ROW_HEIGHT, bottom = (ownedFiltered.length - end) * ROW_HEIGHT;
  $('ownedBody').innerHTML = `<tr class="owned-spacer"><td colspan="9" style="height:${top}px"></td></tr>`
    + ownedFiltered.slice(start, end).map(ownedRow).join('')
    + `<tr class="owned-spacer"><td colspan="9" style="height:${bottom}px"></td></tr>`;
}

function renderOwned(table, resetScroll = false) {
  if (table) OWNED = table;
  const q = $('ownedSearch').value.trim().toLowerCase();
  ownedFiltered = q ? OWNED.filter((a) => (a.name || '').toLowerCase().includes(q)
    || (a.dev || '').toLowerCase().includes(q) || String(a.adamId).includes(q)) : OWNED;
  if (resetScroll) document.querySelector('#tab-owned .owned-table-wrap').scrollTop = 0;
  renderOwnedViewport();
  $('ownedStat').textContent = `共 ${OWNED.length} 个 App（iOS ${OWNED.filter((a) => IOS_APP.test(a.type || '')).length}）`
    + (q ? ` · 筛选 ${ownedFiltered.length}` : '') + (ownedSelected.size ? ` · 已选 ${ownedSelected.size}` : '');
}

async function rapLoginInPage() {
  if (!onRapHost()) return { ok: false, error: '请在右侧打开报告问题网页' };
  return $('rapWebview').executeJavaScript(`(async () => {
    const response = await fetch('/api/login', { credentials: 'same-origin',
      headers: { 'x-apple-rap2-api': '3.0.0' } });
    if (!response.ok) return { ok: false, error: '登录接口 HTTP ' + response.status };
    const data = await response.json();
    return data.dsid && data.token
      ? { ok: true, dsid: String(data.dsid), name: data.name || '', email: data.email || '', token: data.token }
      : { ok: false, error: '登录接口未返回账号 ID 或令牌' };
  })()`, true);
}

async function rapSearchPage(identity, batchId) {
  const body = JSON.stringify(batchId ? { dsid: identity.dsid, batchId } : { dsid: identity.dsid });
  const script = `(async () => {
    const response = await fetch('/api/purchase/search', { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-apple-rap2-api': '3.0.0',
        'x-apple-xsrf-token': ${JSON.stringify(identity.token)} },
      body: ${JSON.stringify(body)} });
    if (!response.ok) return { ok: false, error: '购买记录接口 HTTP ' + response.status };
    const data = await response.json();
    return Array.isArray(data.purchases)
      ? { ok: true, purchases: data.purchases, nextBatchId: data.nextBatchId || null }
      : { ok: false, error: '购买记录接口未返回 purchases' };
  })()`;
  return $('rapWebview').executeJavaScript(script, true);
}

async function crawlOwnedPages(identity) {
  let pages = 0, count = 0, batchId = null, newTop = '';
  const seen = new Set();
  try {
    const cursor = await window.api.purchasesCursor({ dsid: identity.dsid });
    const stopAt = cursor.topPurchaseId || '';
    while (!rapState.stopRequested) {
      if (!onRapHost()) throw new Error('登录网页已离开报告问题网站');
      const page = await rapSearchPage(identity, batchId);
      if (rapState.stopRequested) break;
      if (!page || !page.ok) throw new Error((page && page.error) || '购买记录接口无响应');
      if (!newTop && page.purchases.length) newTop = String(page.purchases[0].purchaseId);
      const records = [];
      let hit = false;
      for (const purchase of page.purchases) {
        if (stopAt && String(purchase.purchaseId) === stopAt) { hit = true; break; }
        records.push(purchase);
      }
      const saved = await window.api.purchasesAppend({ dsid: identity.dsid, email: identity.email,
        name: identity.name, purchases: records });
      if (!saved.ok) throw new Error(saved.error);
      pages++;
      count += records.length;
      rapStatus(`抓取中：${pages} 页、${count} 条记录、${saved.total} 个 App`, true);
      if (pages % 5 === 0 && rapState.viewDsid === identity.dsid) {
        const state = await window.api.purchasesState({ dsid: identity.dsid });
        renderOwned(state.table);
        renderAccounts();
      }
      if (hit || !page.nextBatchId) {
        const done = await window.api.purchasesFinish({ dsid: identity.dsid, newTop });
        if (!done.ok) throw new Error(done.error);
        rapStatus(`完成：${pages} 页、${count} 条记录，共 ${done.total} 个 App`, true);
        await selectOwnedAccount(identity.dsid);
        break;
      }
      if (seen.has(page.nextBatchId)) throw new Error('购买记录分页游标重复');
      seen.add(page.nextBatchId);
      batchId = page.nextBatchId;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    if (rapState.stopRequested) rapStatus('抓取已停止，已抓记录已保存', false);
  } catch (err) { rapStatus(`抓取失败：${err.message}`, false); }
  finally {
    rapState.crawling = false;
    $('rapCrawlBtn').textContent = '重新抓取（增量）';
    renderAccounts();
  }
}

async function startOwnedCrawl(identity) {
  if (rapState.crawling) return false;
  try {
    identity = identity || await rapLoginInPage();
    if (!identity.ok) { rapStatus(identity.error || '请先登录', false); return false; }
    rapState.crawling = true;
    rapState.stopRequested = false;
    rapState.liveDsid = identity.dsid;
    rapState.viewDsid = identity.dsid;
    rapState.name = identity.name;
    rapState.email = identity.email;
    $('rapCrawlBtn').textContent = '停止抓取';
    crawlOwnedPages(identity);
    return true;
  } catch (err) { rapStatus(`无法读取登录状态：${err.message}`, false); return false; }
}

async function rapCheckLogin() {
  if (rapState.checking || rapState.crawling || !onRapHost()) return;
  rapState.checking = true;
  try {
    const result = await rapLoginInPage();
    if (!result.ok) {
      rapDot(false);
      $('rapCrawlBtn').disabled = true;
      rapStatus(`无法读取登录状态：${result.error}`, false);
      return;
    }
    rapDot(true);
    $('rapCrawlBtn').disabled = false;
    rapState.liveDsid = result.dsid;
    rapState.name = result.name;
    rapState.email = result.email;
    rapStatus(`已登录：${result.name || result.email || result.dsid}（${result.dsid}）`, true);
    await renderAccounts();
    if (!rapState.autoStarted.has(result.dsid) && await startOwnedCrawl(result)) rapState.autoStarted.add(result.dsid);
  } catch (err) { rapStatus(`无法读取登录状态：${err.message}`, false); }
  finally { rapState.checking = false; }
}

$('rapWebview').addEventListener('did-stop-loading', rapCheckLogin);
$('rapWebview').addEventListener('did-navigate', rapCheckLogin);
$('rapLoginBtn').addEventListener('click', () => $('rapWebview').loadURL('https://reportaproblem.apple.com/'));
$('rapCrawlBtn').addEventListener('click', async () => {
  if (rapState.crawling) rapState.stopRequested = true;
  else await startOwnedCrawl();
});
$('rapToggleWv').addEventListener('click', () => {
  const card = $('rapWvCard');
  const show = card.style.display === 'none';
  card.style.display = show ? '' : 'none';
  $('rapToggleWv').textContent = show ? '隐藏登录窗' : '显示登录窗';
});
document.querySelector('#tab-owned .owned-table-wrap').addEventListener('scroll', renderOwnedViewport);
let searchTimer;
$('ownedSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => renderOwned(null, true), 120); });
$('ownedBody').addEventListener('change', (e) => {
  if (!e.target.matches('.ownChk')) return;
  if (e.target.checked) ownedSelected.add(e.target.dataset.id);
  else ownedSelected.delete(e.target.dataset.id);
  renderOwned();
});
$('ownedBody').addEventListener('click', (e) => {
  const button = e.target.closest('.owndl');
  if (!button) return;
  $('dlAppId').value = button.dataset.id;
  $('dlVersionId').value = '';
  switchTab('download');
  log(`从已购记录选择 ${button.dataset.nm} (${button.dataset.id})`);
});
$('ownedBody').addEventListener('error', (e) => {
  if (e.target.tagName === 'IMG') e.target.style.visibility = 'hidden';
}, true);
$('ownedChkAll').addEventListener('change', (e) => {
  for (const a of ownedFiltered) if (IOS_APP.test(a.type || '')) {
    if (e.target.checked) ownedSelected.add(String(a.adamId));
    else ownedSelected.delete(String(a.adamId));
  }
  renderOwned();
});
$('ownedSelAll').addEventListener('click', () => { $('ownedChkAll').checked = true; $('ownedChkAll').dispatchEvent(new Event('change')); });
$('ownedToBatch').addEventListener('click', () => {
  if (!ownedSelected.size) { log('未选中任何 App', 'WARN'); return; }
  const ids = new Set($('batchList').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  for (const id of ownedSelected) ids.add(id);
  $('batchList').value = [...ids].join('\n');
  switchTab('batch');
  log(`已添加 ${ownedSelected.size} 个已购 App 到批量下载`);
});
$('ownedClear').addEventListener('click', async () => {
  if (!rapState.viewDsid) return;
  const result = await window.api.purchasesClear({ dsid: rapState.viewDsid });
  ownedSelected.clear();
  renderOwned(result.table, true);
  renderAccounts();
  rapStatus('已清空该账号记录', false);
});
$('ownedExport').addEventListener('click', async () => {
  const result = await window.api.purchasesExportCsv({ rows: OWNED });
  if (result.ok) log('已导出：' + result.path);
});
document.querySelector('.tab[data-tab="owned"]').addEventListener('click', async () => {
  await renderAccounts();
  if (rapState.viewDsid) await selectOwnedAccount(rapState.viewDsid);
  await rapCheckLogin();
});
