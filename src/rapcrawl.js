'use strict';
const { net } = require('electron');

// reportaproblem.apple.com 后台爬虫。
// 关键：用 Electron net + useSessionCookies 直接走 webview 的 persist:rap 分区会话，
// Cookie 读写都在同一个共享 jar 里——dqsid(一次性令牌)轮换自动写回分区，
// 与登录页 SPA 共用同一份最新会话，不会互相作废（否则会 400 UNAUTHORIZED）。
const BASE = 'https://reportaproblem.apple.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function req(ses, method, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const r = net.request({ method, url: BASE + pathname, session: ses, useSessionCookies: true });
    r.setHeader('User-Agent', UA);
    r.setHeader('Accept', 'application/json, text/plain, */*');
    r.setHeader('Accept-Language', 'zh-CN,zh;q=0.9');
    r.setHeader('x-apple-rap2-api', '3.0.0');
    r.setHeader('Referer', BASE + '/');
    if (headers) for (const k of Object.keys(headers)) r.setHeader(k, headers[k]);
    const chunks = [];
    r.on('response', (res) => {
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

// 探测登录态 + 拿 xsrf token（走共享会话）。
async function login(ses) {
  const res = await req(ses, 'GET', '/api/login');
  let d = null;
  try { d = JSON.parse(res.body); } catch (e) { /* idmsa 跳转的 HTML */ }
  if (res.status !== 200 || !d || !d.dsid || !d.token) {
    return { ok: false, status: res.status, bodyHead: (res.body || '').replace(/\s+/g, ' ').slice(0, 140) };
  }
  return { ok: true, dsid: String(d.dsid), token: d.token, name: d.name || '', email: d.email || '' };
}

// 全量/增量爬取。stopAt：爬到该 purchaseId 即停。
async function crawl(ses, stopAt, onProgress) {
  const lg = await login(ses);
  if (!lg.ok) return { ok: false, error: `会话探测失败 (HTTP ${lg.status})：${lg.bodyHead || ''}` };
  const { dsid, token } = lg;
  let batchId = null; const all = []; let newTop = ''; let pages = 0;
  while (true) {
    const body = JSON.stringify(batchId ? { dsid, batchId } : { dsid });
    const res = await req(ses, 'POST', '/api/purchase/search', { 'Content-Type': 'application/json', 'x-apple-xsrf-token': token, Origin: BASE }, body);
    if (res.status !== 200) return { ok: false, error: `search HTTP ${res.status}：${(res.body || '').slice(0, 120)}`, dsid, name: lg.name, email: lg.email };
    let d;
    try { d = JSON.parse(res.body); } catch (e) { return { ok: false, error: '响应解析失败', dsid, name: lg.name, email: lg.email }; }
    const purchases = d.purchases || [];
    if (!newTop && purchases.length) newTop = purchases[0].purchaseId;
    let hit = false;
    for (const p of purchases) {
      if (stopAt && p.purchaseId === stopAt) { hit = true; break; }
      all.push(p);
    }
    pages++;
    if (onProgress) onProgress({ pages, count: all.length });
    if (hit || !d.nextBatchId) break;
    batchId = d.nextBatchId;
    await new Promise((r) => setTimeout(r, 120));
  }
  return { ok: true, dsid, name: lg.name, email: lg.email, purchases: all, newTop };
}

module.exports = { login, crawl };
