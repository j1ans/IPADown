'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { StoreClient } = require('../src/store');

test('SAP login preserves challenge cookies and stores the selected Store pod', async () => {
  const calls = [];
  const client = new StoreClient('A1B2C3D4E5F6', async (input) => {
    calls.push(input);
    if (!input.code) return { ok: false, need2FA: true, cookies: 'challenge=present' };
    return { ok: true, appleId: input.appleId, dsPersonId: '123', passwordToken: 'token',
      storefront: '143441-1,29', pod: '25', cookies: 'challenge=present; signed=yes' };
  });
  await assert.rejects(client.authenticate('test@example.test', 'password', '', 'US'), (error) => error.need2FA);
  const account = await client.authenticate('test@example.test', 'password', '123456', 'US');
  assert.equal(calls[1].code, '123456');
  assert.match(calls[1].cookies, /challenge=present/);
  assert.equal(account.storefrontHeader, '143441-1,29');
  assert.match(client.storeURL('https://buy.itunes.apple.com/path'), /^https:\/\/p25-buy/);
  assert.equal(client.baseHeaders()['Content-Type'], 'application/x-apple-plist');
  assert.match(client.jar.header(), /signed=yes/);
});

test('purchase rejects an empty or failed authorization response', async () => {
  const client = new StoreClient('guid');
  client.account = { appleId: 'test@example.test' };
  client._send = async () => ({ res: { status: 403 }, data: {} });
  await assert.rejects(client.buy('123'), /购买失败/);
  client._send = async () => ({ res: { status: 200 }, data: {} });
  await assert.rejects(client.buy('123'), /购买响应为空/);
  client._send = async () => ({ res: { status: 200 }, data: { status: 0, jingleDocType: 'purchaseSuccess' } });
  assert.equal(await client.buy('123'), true);
  client._send = async () => ({ res: { status: 200 }, data: { failureType: '5002' } });
  assert.equal(await client.buy('123'), true);
});
