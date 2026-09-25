'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// 配置持久化：账号列表 + 设置，存于 userData/config.json。
class Config {
  constructor(userDataDir, safeStorage) {
    this.file = path.join(userDataDir, 'config.json');
    this.safeStorage = safeStorage;
    this.defaultDir = path.join(os.homedir(), 'Downloads', 'ipaDown');
    this.data = {
      accounts: [],
      activeAccountId: '',
      settings: {
        downloadDir: this.defaultDir,
        country: 'US',
        noUpdate: false,    // 免更新模式
        autoBuy: true,      // 下载前自动尝试购买（免费App）
      },
    };
    this.load();
    // 迁移旧版 userData/downloads 默认目录。
    const dd = this.data.settings.downloadDir || '';
    if (!dd || dd.endsWith(path.join('downloads')) || dd.indexOf(userDataDir) === 0) {
      this.data.settings.downloadDir = this.defaultDir;
      this.save();
    }
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = Object.assign(this.data, parsed);
      this.data.settings = Object.assign(
        { downloadDir: this.data.settings.downloadDir, country: 'US', noUpdate: false, autoBuy: true },
        parsed.settings || {}
      );
    } catch (_) { /* 首次运行 */ }
    // Remove legacy base64 passwords from disk; migrate when OS encryption exists.
    let changed = false;
    for (const account of this.data.accounts) {
      if (!account.password) continue;
      const value = Buffer.from(account.password, 'base64').toString('utf8');
      delete account.password;
      if (this.canEncrypt()) account.secret = this.encrypt(value);
      changed = true;
    }
    if (this.data.activeSession?.appleId) {
      const old = this.data.activeSession;
      const account = this.data.accounts.find((x) => x.appleId === old.appleId);
      if (account && old.secret) account.session = old.secret;
      this.data.activeAccountId = old.appleId;
      delete this.data.activeSession;
      changed = true;
    }
    if (changed) this.save();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(this.file, 0o600);
  }

  getSettings() { return this.data.settings; }
  setSettings(s) { this.data.settings = Object.assign(this.data.settings, s || {}); this.save(); return this.data.settings; }

  canEncrypt() {
    if (!this.safeStorage?.isEncryptionAvailable()) return false;
    return process.platform !== 'linux' || this.safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  }
  encrypt(value) { return this.safeStorage.encryptString(value).toString('base64'); }
  decrypt(value) {
    if (!value || !this.canEncrypt()) return '';
    try { return this.safeStorage.decryptString(Buffer.from(value, 'base64')); } catch (_) { return ''; }
  }
  listAccounts() {
    return this.data.accounts.map((a) => ({ appleId: a.appleId, country: a.country }));
  }
  getAccount(appleId) {
    const a = this.data.accounts.find((x) => x.appleId === appleId);
    if (!a) return null;
    return { appleId: a.appleId, country: a.country, password: this.decrypt(a.secret) };
  }
  saveAccount(appleId, password, country) {
    const idx = this.data.accounts.findIndex((x) => x.appleId === appleId);
    const rec = { ...(idx >= 0 ? this.data.accounts[idx] : {}), appleId, country };
    if (this.canEncrypt() && password) rec.secret = this.encrypt(password);
    if (idx >= 0) this.data.accounts[idx] = rec; else this.data.accounts.push(rec);
    this.save();
  }
  removeAccount(appleId) {
    this.data.accounts = this.data.accounts.filter((x) => x.appleId !== appleId);
    if (this.data.activeAccountId === appleId) this.data.activeAccountId = '';
    this.save();
  }
  saveSession(appleId, session) {
    const account = this.data.accounts.find((x) => x.appleId === appleId);
    if (account) account.session = this.canEncrypt() ? this.encrypt(JSON.stringify(session)) : '';
    this.data.activeAccountId = appleId;
    this.save();
  }
  getSession(appleId = this.data.activeAccountId) {
    const value = this.decrypt(this.data.accounts.find((x) => x.appleId === appleId)?.session);
    if (!value) return null;
    try { return JSON.parse(value); } catch (_) { return null; }
  }
  setActiveAccount(appleId) { this.data.activeAccountId = appleId; this.save(); }
  clearSession(appleId = this.data.activeAccountId) {
    const account = this.data.accounts.find((x) => x.appleId === appleId);
    if (account) delete account.session;
    if (this.data.activeAccountId === appleId) this.data.activeAccountId = '';
    this.save();
  }
}

module.exports = { Config };
