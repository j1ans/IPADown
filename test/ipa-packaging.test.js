'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');
const plist = require('plist');
const { patchIpa } = require('../src/ipa');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipadown-ipa-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture.ipa');
  const zip = new AdmZip();
  zip.addFile('Payload/Test.app/Info.plist', Buffer.from(plist.build({
    CFBundleExecutable: 'Test',
    CFBundleIdentifier: 'example.test',
    CFBundleShortVersionString: '1.2',
    CFBundleVersion: '12',
  })));
  zip.addFile('iTunesMetadata.plist', Buffer.from(plist.build({
    'apple-id': 'obsolete@example.test',
    userName: 'obsolete',
    itemId: 123,
    softwareVersionBundleId: 'example.test',
  })));
  zip.writeZip(file);
  return file;
}

test('个人购买版 IPA 保留商店元数据并写入可识别的账号与 sinf', (t) => {
  const file = fixture(t);
  const sinf = Buffer.from('test-sinf');
  const meta = patchIpa(file, {
    metadata: { itemName: '测试应用', softwareVersionExternalIdentifier: 12345 },
    sinfs: [{ id: 1, data: sinf }],
  }, {
    appleId: 'owner@example.test',
    dsPersonId: '12345678901',
    storefront: '143462',
    storefrontHeader: '143462-1,29',
  }, { purchaseDate: '2025-11-25T16:26:24Z' });
  const zip = new AdmZip(file);
  const md = plist.parse(zip.readAsText('iTunesMetadata.plist'));
  const download = md['com.apple.iTunesStore.downloadInfo'];
  assert.equal(md.appleId, 'owner@example.test');
  assert.equal(md['apple-id'], undefined);
  assert.equal(md.userName, undefined);
  assert.equal(md.itemId, 123);
  assert.equal(md.itemName, '测试应用');
  assert.equal(md.softwareVersionExternalIdentifier, 12345);
  assert.equal(download.accountInfo.AppleID, 'owner@example.test');
  assert.equal(download.accountInfo.DSPersonID, 12345678901);
  assert.equal(download.accountInfo.PurchaserID, 12345678901);
  assert.equal(download.accountInfo.AccountStoreFront, '143462-1,29');
  assert.equal(md.purchaseDate.toISOString(), '2025-11-25T16:26:24.000Z');
  assert.equal(download.purchaseDate, '2025-11-25T16:26:24Z');
  assert.deepEqual(zip.readFile('Payload/Test.app/SC_Info/Test.sinf'), sinf);
  assert.equal(meta.bundleId, 'example.test');
  assert.equal(meta.shortVersion, '1.2');
});

test('缺少授权账号时拒绝产出无归属 IPA', (t) => {
  const file = fixture(t);
  assert.throws(() => patchIpa(file, { metadata: {}, sinfs: [] }, null), /缺少已授权/);
  const md = plist.parse(new AdmZip(file).readAsText('iTunesMetadata.plist'));
  assert.equal(md.appleId, undefined);
});
