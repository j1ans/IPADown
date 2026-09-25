'use strict';
const fs = require('fs');
const path = require('path');

// 已购记录本地数据库（JSON），按 Apple ID(dsid) 分账号存储、持久化。
// 来源：reportaproblem.apple.com 的 /api/purchase/search。
// 规则：只留独立 App（lineItemType 以 App 结尾），去掉应用内付费/订阅；
//       按 adamId 去重；输出按 adamId 从小到大排序。
// 增量：每账号记住上次最新 purchaseId（topPurchaseId），下次爬到它即停。
class PurchaseDB {
  constructor(file) {
    this.file = file;
    this.data = { accounts: {} }; // { [dsid]: {dsid, appleId, name, apps:{}, topPurchaseId, updatedAt} }
    this.load();
  }

  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // 兼容旧版单账号结构
      if (d && d.apps && !d.accounts) {
        this.data = { accounts: {} };
        if (d.dsid) this.data.accounts[d.dsid] = { dsid: d.dsid, appleId: '', name: '', apps: d.apps, topPurchaseId: d.topPurchaseId || '', updatedAt: d.updatedAt || '' };
      } else {
        this.data = Object.assign({ accounts: {} }, d);
      }
    } catch (_) { /* 首次 */ }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }

  account(dsid) {
    const k = String(dsid);
    if (!this.data.accounts[k]) this.data.accounts[k] = { dsid: k, appleId: '', name: '', apps: {}, topPurchaseId: '', updatedAt: '' };
    return this.data.accounts[k];
  }

  topPurchaseId(dsid) { const a = this.data.accounts[String(dsid)]; return a ? (a.topPurchaseId || '') : ''; }

  // 合并一批原始 purchases（search 返回，newest-first）到指定账号。返回新增 App 数。
  merge(dsid, appleId, name, rawPurchases) {
    const acc = this.account(dsid);
    if (appleId) acc.appleId = appleId;
    if (name) acc.name = name;
    let added = 0;
    for (const p of rawPurchases || []) {
      for (const pli of (p.plis || [])) {
        const type = pli.lineItemType || '';
        if (!/App$/.test(type)) continue; // 去掉应用内付费 / 订阅
        const id = String(pli.adamId || '');
        if (!id || id === '0') continue;
        const lc = pli.localizedContent || {};
        const prev = acc.apps[id];
        if (!prev) added++;
        acc.apps[id] = {
          adamId: id,
          name: lc.nameForDisplay || (prev && prev.name) || '',
          dev: lc.detailForDisplay || (prev && prev.dev) || '',
          artworkURL: ((lc.artworkURL || (prev && prev.artworkURL) || '')).replace('88x88', '120x120'),
          type,
          mediaType: lc.mediaType || (prev && prev.mediaType) || '',
          storefrontId: pli.storefrontId || (prev && prev.storefrontId) || '',
          isFree: pli.isFreePurchase != null ? !!pli.isFreePurchase : !!(prev && prev.isFree),
          amountPaid: pli.amountPaid || (prev && prev.amountPaid) || '',
          pliDate: (prev && prev.pliDate && prev.pliDate < (pli.pliDate || '')) ? prev.pliDate : (pli.pliDate || p.purchaseDate || (prev && prev.pliDate) || ''),
          purchaseId: (prev && prev.purchaseId) || p.purchaseId || '',
        };
      }
    }
    return added;
  }

  setTop(dsid, id) { if (id) this.account(dsid).topPurchaseId = String(id); }
  stamp(dsid, t) { this.account(dsid).updatedAt = t || new Date().toISOString(); }
  setLabel(dsid, label) { this.account(dsid).label = String(label || ''); }

  // 指定账号的表格，按 adamId 升序
  tableFor(dsid) {
    const a = this.data.accounts[String(dsid)];
    if (!a) return [];
    return Object.values(a.apps).sort((x, y) => (Number(x.adamId) || 0) - (Number(y.adamId) || 0));
  }

  // 账号列表（用于左侧边栏）
  listAccounts() {
    return Object.values(this.data.accounts).map((a) => ({
      dsid: a.dsid, appleId: a.appleId || '', name: a.name || '', label: a.label || '',
      count: Object.keys(a.apps || {}).length, updatedAt: a.updatedAt || '',
    })).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  clear(dsid) {
    if (dsid) delete this.data.accounts[String(dsid)];
    else this.data = { accounts: {} };
    this.save();
  }
}

module.exports = { PurchaseDB };
