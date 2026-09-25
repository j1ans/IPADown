'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');
const plist = require('plist');
const { scanIndexed } = require('../src/library-index');
const { buildGroups, perfectFor } = require('../renderer/library-view');

function addIpa(dir, name, version, minimum, appId) {
  const zip = new AdmZip();
  zip.addFile('Payload/QQ.app/Info.plist', Buffer.from(plist.build({
    CFBundleDisplayName: 'QQ', CFBundleIdentifier: 'com.example.qq',
    CFBundleShortVersionString: version, MinimumOSVersion: minimum,
  })));
  zip.addFile('iTunesMetadata.plist', Buffer.from(plist.build({ itemId: appId })));
  zip.writeZip(path.join(dir, name));
}

test('indexed scan reuses unchanged IPA metadata and groups by App ID', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ipadown-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = path.join(root, 'files');
  const nested = path.join(files, 'QQ');
  fs.mkdirSync(nested, { recursive: true });
  addIpa(nested, '[iOS6完美兼容版]QQ-1.ipa', '1.0', '6.0', 12345);
  addIpa(nested, 'QQ-copy.ipa', '1.0', '6.0', 12345);
  addIpa(nested, 'QQ-2.ipa', '2.0', '6.0', 12345);
  addIpa(nested, 'QQ-3.ipa', '3.0', '7.0', 12345);
  const db = path.join(root, 'index.sqlite');
  const first = scanIndexed(files, db);
  assert.equal(first.indexed, 4);
  assert.equal(first.list.length, 4);
  assert.equal(first.list[0].appId, '12345');
  assert.equal(scanIndexed(files, db).indexed, 0);
  const groups = buildGroups(first.list, '6.1');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].preferred.version, '1.0');
  assert.ok(groups[0].preferred.tag);
  assert.equal(perfectFor(groups[0].preferred, '6.1'), true);
  assert.deepEqual(groups[0].supported.map((r) => r.version), ['2.0']);
  assert.deepEqual(groups[0].incompatible.map((r) => r.version), ['3.0']);
  const newerDevice = buildGroups(first.list, '8.4');
  assert.equal(newerDevice[0].preferred.version, '3.0');
  assert.equal(perfectFor(newerDevice[0].preferred, '8.4'), false);
  fs.unlinkSync(path.join(nested, 'QQ-copy.ipa'));
  assert.equal(scanIndexed(files, db).total, 3);
});
