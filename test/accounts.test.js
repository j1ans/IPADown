'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Config } = require('../src/config');

const storage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'kwallet',
  encryptString: (value) => Buffer.from('sealed:' + value),
  decryptString: (value) => value.toString().replace(/^sealed:/, ''),
};

test('saved accounts keep separate encrypted sessions and switch without copying credentials', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipadown-accounts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = new Config(dir, storage);
  for (const id of ['a@example.test', 'b@example.test']) {
    config.saveAccount(id, 'secret-' + id, 'US');
    config.saveSession(id, { appleId: id, dsPersonId: id, passwordToken: 'token-' + id });
  }
  config.setActiveAccount('a@example.test');
  const reopened = new Config(dir, storage);
  assert.equal(reopened.getSession().appleId, 'a@example.test');
  assert.equal(reopened.getSession('b@example.test').passwordToken, 'token-b@example.test');
  assert.equal(reopened.getAccount('a@example.test').password, 'secret-a@example.test');
  const disk = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  assert.ok(!disk.includes('secret-a@example.test'));
  assert.ok(!disk.includes('token-b@example.test'));
  reopened.clearSession('a@example.test');
  assert.equal(reopened.getSession('a@example.test'), null);
  assert.ok(reopened.getSession('b@example.test'));
});
