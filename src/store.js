'use strict';
const plist = require('plist');
const { CookieJar, request } = require('./http');
const authBridge = require('./auth-bridge');
const { countryToStorefront } = require('./storefront');

// Store purchase and download requests use the Configurator user agent.
const USER_AGENT = 'Configurator/2.18 (Macintosh; OS X 15.4.1; 24E263) AppleWebKit/0621.1.15.11.10';

const URL_DOWNLOAD = 'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=';
const URL_BUY = 'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/buyProduct';

const PRICING_BUY = 'STDQ';     // 购买
const PRICING_UPDATE = 'SWUPD'; // 标记/更新（降低登录频率）

class StoreClient {
  constructor(guid, loginWithBridge = authBridge.login) {
    this.guid = guid;
    this.loginWithBridge = loginWithBridge;
    this.jar = new CookieJar();
    this.account = null; // {appleId, dsPersonId, passwordToken, storefront, firstName, lastName, country}
  }

  baseHeaders(kind = 'purchase') {
    const h = {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-apple-plist',
      Accept: '*/*',
      'Accept-Language': 'zh-cn',
    };
    const a = this.account;
    // 登录(authenticate)阶段还没有 dsid/token，必须省略这些头，
    // 否则 Node http 会因 "undefined" 头值抛错。
    if (a && a.dsPersonId) {
      h['X-Dsid'] = a.dsPersonId;
      h['iCloud-Dsid'] = a.dsPersonId;
    }
    if (kind !== 'download' && a && a.passwordToken) h['X-Token'] = a.passwordToken;
    if (kind !== 'download' && a && a.storefront) h['X-Apple-Store-Front'] = a.storefrontHeader || a.storefront;
    return h;
  }

  storeURL(url) {
    const pod = /^\d+$/.test(String(this.account?.pod || '')) ? this.account.pod : '';
    return pod ? url.replace('https://buy.itunes.apple.com/', `https://p${pod}-buy.itunes.apple.com/`) : url;
  }

  // Purchase and download endpoints return XML plist responses.
  async _send(url, body, kind) {
    const res = await request(url, { method: 'POST', headers: this.baseHeaders(kind), jar: this.jar }, body);
    const text = res.body.toString('utf8');
    let parsed;
    try {
      parsed = plist.parse(text);
    } catch (e) {
      throw new Error(`Apple 商店返回 HTTP ${res.status}，响应不是 plist；请检查账号会话并稍后重试`);
    }
    return { res, data: parsed || {} };
  }

  // ipatool v2.6 uses Apple's bag-selected endpoint and SAP-signed XML plist.
  // The Go bridge receives credentials on stdin and returns only this session.
  async authenticate(appleId, password, code, country) {
    if (!this.account) {
      this.account = { appleId, storefront: countryToStorefront(country), country: (country || '').toUpperCase() };
    }
    const result = await this.loginWithBridge({ appleId, password, code: code || '', guid: this.guid, cookies: this.jar.header() });
    if (result.cookies) this.jar.setRaw(result.cookies);
    if (!result.ok) {
      const error = new Error(result.need2FA ? '需要二次验证：请在受信任设备上获取 6 位验证码' : (result.error || '登录失败'));
      error.need2FA = !!result.need2FA;
      throw error;
    }
    if (!result.dsPersonId || !result.passwordToken) throw new Error('登录响应缺少账户令牌');
    const fullStorefront = result.storefront || countryToStorefront(country);
    const acc = {
      appleId: result.appleId || appleId,
      dsPersonId: String(result.dsPersonId),
      passwordToken: result.passwordToken,
      country: (country || '').toUpperCase(),
      storefront: String(fullStorefront).split('-')[0],
      storefrontHeader: fullStorefront,
      firstName: result.name || '', lastName: '', pod: result.pod || '',
    };
    this.account = acc;
    return acc;
  }

  setAccount(acc) { this.account = acc; }
  logout() { this.account = null; this.jar.clear(); }

  // Restore the local session encrypted by the operating system.
  // sess: {appleId, dsPersonId, passwordToken, storefront, country, cookies, name}
  importSession(sess) {
    const acc = {
      appleId: sess.appleId || '',
      dsPersonId: String(sess.dsPersonId || ''),
      passwordToken: sess.passwordToken || '',
      storefront: sess.storefront || (sess.country ? countryToStorefront(sess.country) : ''),
      storefrontHeader: sess.storefrontHeader || sess.storefront || '',
      country: (sess.country || '').toUpperCase(),
      firstName: sess.firstName || sess.name || '', lastName: sess.lastName || '', pod: sess.pod || '',
    };
    this.jar.clear();
    if (sess.cookies) this.jar.setRaw(sess.cookies);
    this.account = acc;
    return acc;
  }

  // volumeStoreDownloadProduct：拿真实下载直链 + sinf + metadata。
  // versionId 为空/"0" 表示最新版。
  async download(appId, versionId) {
    if (!this.account) throw new Error('未登录');
    // 抓包确认：原版用标准 XML plist 体，键 guid / salableAdamId / externalVersionId
    const dict = { creditDisplay: '', guid: this.guid, salableAdamId: Number(appId), serialNumber: '0' };
    if (versionId && versionId !== '0') dict.externalVersionId = String(versionId);
    const { res, data } = await this._send(this.storeURL(URL_DOWNLOAD + this.guid), plist.build(dict), 'download');
    if (data.failureType || !data.songList || res.status >= 400) {
      const error = new Error(data.customerMessage ||
        `下载请求失败 (HTTP ${res.status})，请检查登录状态或 App 授权`);
      if (res.status < 400 && /not.?purchased|not.?owned|not.?licensed|purchase.?required|尚未购买|未购买|未拥有/i.test(error.message)) error.code = 'NOT_OWNED';
      throw error;
    }
    const song = (data.songList || [])[0];
    if (!song) throw new Error('响应未包含可下载项');
    const md = song.metadata || {};
    const sinfs = (song.sinfs || []).map((s) => ({
      id: typeof s.id === 'number' ? s.id : parseInt(s.id, 10) || 0,
      data: Buffer.isBuffer(s.sinf) ? s.sinf : Buffer.from(s.sinf || '', 'base64'),
    }));
    return {
      url: song.URL,
      bundleId: md.softwareVersionBundleId || '',
      name: md.bundleDisplayName || md['itemName'] || '',
      version: md.bundleShortVersionString || '',
      versionId: md.softwareVersionExternalIdentifier != null
        ? String(md.softwareVersionExternalIdentifier) : (versionId || ''),
      requestedVersionId: versionId || '0',
      sinfs,
      metadata: md,
    };
  }

  // 官方鉴权版本列表：读 volumeStoreDownloadProduct 响应里的
  // softwareVersionExternalIdentifiers（按账号 storefront，最全最准，同 ipatool ListVersions）。
  // 返回 [{id, latest}]，最新在末尾。
  async listVersions(appId) {
    if (!this.account) throw new Error('未登录');
    const body = plist.build({ creditDisplay: '', guid: this.guid, salableAdamId: Number(appId), serialNumber: '0' });
    const { res, data } = await this._send(this.storeURL(URL_DOWNLOAD + this.guid), body, 'download');
    if (res.status >= 400 || data.failureType) {
      throw new Error(data.customerMessage || ('获取版本失败 ' + data.failureType));
    }
    const song = (data.songList || [])[0] || {};
    const md = song.metadata || {};
    const ids = (md.softwareVersionExternalIdentifiers || []).map(String);
    const latest = md.softwareVersionExternalIdentifier != null ? String(md.softwareVersionExternalIdentifier) : (ids[ids.length - 1] || '');
    if (!ids.length) throw new Error('该响应未含版本列表（可能账号未拥有此 App）');
    return { ids, latest };
  }

  // buyProduct：购买/标记（免费 App price=0）。XML plist 体（同 download/ipatool）。
  async buy(appId, versionId, pricing) {
    if (!this.account) throw new Error('未登录');
    const dict = {
      appExtVrsId: versionId && versionId !== '0' ? String(versionId) : '0',
      hasAskedToFulfillPreorder: 'true',
      buyWithoutAuthorization: 'true',
      hasDoneAgeCheck: 'true',
      guid: this.guid,
      needDiv: '0',
      origPage: `Software-${appId}`,
      origPageLocation: 'Buy',
      price: '0',
      pricingParameters: pricing || PRICING_BUY,
      productType: 'C',
      salableAdamId: String(appId),
    };
    const { res, data } = await this._send(this.storeURL(URL_BUY), plist.build(dict));
    if (String(data.failureType || '') === '5002') return true; // License already exists.
    if (res.status >= 400 || data.failureType) {
      throw new Error(`购买失败(${res.status}): ` + (data.customerMessage || data.failureType));
    }
    if (data.status != null && String(data.status) !== '0') {
      throw new Error('购买返回状态 ' + data.status);
    }
    if (!data || Object.keys(data).length === 0) throw new Error(`购买响应为空 (HTTP ${res.status})，无法确认授权`);
    if (data.jingleDocType !== 'purchaseSuccess') {
      throw new Error(`购买响应未确认授权 (HTTP ${res.status})`);
    }
    return true;
  }
}

module.exports = { StoreClient, PRICING_BUY, PRICING_UPDATE };
