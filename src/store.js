'use strict';
const plist = require('plist');
const { CookieJar, request } = require('./http');
const { countryToStorefront } = require('./storefront');

// 复刻原 exe 的 Configurator 伪装 UA。
const USER_AGENT = 'Configurator/2.18 (Macintosh; OS X 15.4.1; 24E263) AppleWebKit/0621.1.15.11.10';

const URL_AUTH = 'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate?guid=';
const URL_DOWNLOAD = 'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct?guid=';
const URL_BUY = 'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/buyProduct';

const PRICING_BUY = 'STDQ';     // 购买
const PRICING_UPDATE = 'SWUPD'; // 标记/更新（降低登录频率）

// 失败码/消息常量（取自 ipatool constants.go）
const FAILURE_INVALID_CREDENTIALS = '-5000';
const CUSTOMER_MESSAGE_BAD_LOGIN = 'MZFinance.BadLogin.Configurator_message'; // 该值出现且 failureType 为空 = 需要 2FA

// 复刻原 exe 的请求体格式：单引号字典字面量 {'k':'v','k2':'v2'}（按插入顺序）。
// 这是 Apple 这几个端点唯一接受的格式（实测 plist/form 会被 403）。
function buildLiteralBody(obj) {
  const parts = [];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    parts.push(`'${k}':'${String(v)}'`);
  }
  return '{' + parts.join(',') + '}';
}

class StoreClient {
  constructor(guid) {
    this.guid = guid;
    this.jar = new CookieJar();
    this.account = null; // {appleId, dsPersonId, passwordToken, storefront, firstName, lastName, country}
  }

  baseHeaders() {
    const h = {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
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
    if (a && a.passwordToken) h['X-Token'] = a.passwordToken;
    if (a && a.storefront) h['X-Apple-Store-Front'] = a.storefront;
    return h;
  }

  // 发送已构造好的请求体字符串，解析 XML plist 响应。
  // 经 Frida 抓原版 + 实测确认：
  //   · authenticate 用字典字面量 {'k':'v'} 体（Node 发标准 plist 会 403）
  //   · volumeStoreDownloadProduct / buyProduct 用标准 XML plist 体（抓包原版即如此）
  async _send(url, body) {
    const res = await request(url, { method: 'POST', headers: this.baseHeaders(), jar: this.jar }, body);
    const text = res.body.toString('utf8');
    let parsed;
    try {
      parsed = plist.parse(text);
    } catch (e) {
      const hint = res.status === 403 ? '（被苹果服务器拒绝，请稍后重试或更换网络/地区）' : '';
      throw new Error(`解析响应失败 (HTTP ${res.status})${hint}: ${e.message}`);
    }
    return { res, data: parsed || {} };
  }

  // 登录。code 为 2FA 验证码（无则留空）。
  // 流程对齐 ipatool：attempt 1→4 循环重试；2FA 通过
  // failureType=="" && customerMessage=="MZFinance.BadLogin.Configurator_message" 识别。
  // 请求体仍用原 exe 的字典字面量格式（本环境实测唯一可用）。
  async authenticate(appleId, password, code, country) {
    if (!this.account) {
      this.account = { appleId, storefront: countryToStorefront(country), country: (country || '').toUpperCase() };
    }
    const cleanCode = (code || '').replace(/\s/g, '');
    let lastStatus = 0;
    for (let attempt = cleanCode ? 2 : 1; attempt <= 4; attempt++) {
      // 2FA：密码后接验证码（ipatool 同款做法）
      const pass = cleanCode ? password + cleanCode : password;
      const dict = {
        appleId, attempt: String(attempt), createSession: 'true',
        guid: this.guid, password: pass, rmp: '0', why: 'signIn',
      };
      const { res, data } = await this._send(URL_AUTH + this.guid, buildLiteralBody(dict));
      lastStatus = res.status;
      const ft = data.failureType != null ? String(data.failureType) : '';
      const cm = data.customerMessage || '';

      // 需要二次验证：苹果已把验证码推送到你的受信任设备
      if (ft === '' && !cleanCode && cm === CUSTOMER_MESSAGE_BAD_LOGIN) {
        const e = new Error('需要二次验证：验证码已发送到你的 Apple 设备，请输入 6 位验证码');
        e.need2FA = true;
        throw e;
      }
      // 账号被封
      if (ft === '' && cm === 'Your account is disabled.') {
        throw new Error('账号已被禁用，请前往 appleid.apple.com 解锁');
      }
      // 首次 -5000（账密/路由）→ 重试下一 attempt（修复"连续登录两次"闪退问题）
      if (attempt === 1 && ft === FAILURE_INVALID_CREDENTIALS) continue;
      // 其它明确失败
      if (ft !== '') {
        throw new Error('登录失败: ' + (cm || ft));
      }
      // 成功
      const dsid = data.dsPersonId != null ? String(data.dsPersonId) : '';
      const token = data.passwordToken || '';
      if (dsid && token) {
        const acc = {
          appleId, dsPersonId: dsid, passwordToken: token,
          country: (country || '').toUpperCase(),
          storefront: countryToStorefront(country),
          firstName: '', lastName: '', pod: '',
        };
        const info = data.accountInfo || {};
        if (info.appleId) acc.appleId = info.appleId;
        if (info.address) { acc.firstName = info.address.firstName || ''; acc.lastName = info.address.lastName || ''; }
        const sf = res.headers['x-set-apple-store-front'];
        if (sf) acc.storefront = String(sf).split('-')[0];
        if (res.headers['pod']) acc.pod = String(res.headers['pod']);
        this.account = acc;
        return acc;
      }
      // 既无失败也无会话 → 继续下一次尝试
    }
    throw new Error(`登录失败：尝试多次仍未成功（HTTP ${lastStatus}），请检查账号密码或稍后再试`);
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
      firstName: sess.name || '', lastName: '', pod: '',
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
    const dict = { guid: this.guid, salableAdamId: String(appId) };
    if (versionId && versionId !== '0') dict.externalVersionId = String(versionId);
    const { res, data } = await this._send(URL_DOWNLOAD + this.guid, plist.build(dict));
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
    const body = plist.build({ guid: this.guid, salableAdamId: String(appId) });
    const { res, data } = await this._send(URL_DOWNLOAD + this.guid, body);
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
    const { res, data } = await this._send(URL_BUY, plist.build(dict));
    if (res.status >= 400 || data.failureType) {
      throw new Error(`购买失败(${res.status}): ` + (data.customerMessage || data.failureType));
    }
    if (data.status != null && String(data.status) !== '0') {
      throw new Error('购买返回状态 ' + data.status);
    }
    if (!data || Object.keys(data).length === 0) throw new Error(`购买响应为空 (HTTP ${res.status})，无法确认授权`);
    return true;
  }
}

module.exports = { StoreClient, PRICING_BUY, PRICING_UPDATE };
