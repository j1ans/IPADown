'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { StoreClient } = require('../src/store');

test('2FA attempt starts at 2 and preserves challenge session', async () => {
  const client = new StoreClient('guid');
  client.account = { appleId: 'test@example.test', storefront: '143441', country: 'US' };
  client.jar.setRaw('challenge=present');
  let payload = '';
  client._send = async (_url, body) => {
    payload = body;
    return { res: { status: 200, headers: {} }, data: { dsPersonId: '123', passwordToken: 'token' } };
  };
  await client.authenticate('test@example.test', 'password', '123456', 'US');
  assert.match(payload, /'attempt':'2'/);
  assert.match(payload, /'password':'password123456'/);
  assert.match(client.jar.header(), /challenge=present/);
});

test('purchase rejects an empty or failed authorization response', async () => {
  const client = new StoreClient('guid');
  client.account = { appleId: 'test@example.test' };
  client._send = async () => ({ res: { status: 403 }, data: {} });
  await assert.rejects(client.buy('123'), /购买失败/);
  client._send = async () => ({ res: { status: 200 }, data: {} });
  await assert.rejects(client.buy('123'), /购买响应为空/);
});
