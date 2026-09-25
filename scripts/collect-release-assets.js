'use strict';
const fs = require('fs');
const path = require('path');

const [platform, arch] = process.argv.slice(2);
const extensions = { win: '.exe', linux: '.AppImage', mac: '.dmg' };
const extension = extensions[platform];
if (!extension || !['x64', 'arm64'].includes(arch)) {
  throw new Error('Usage: node scripts/collect-release-assets.js <win|linux|mac> <x64|arm64>');
}

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const matches = fs.readdirSync(dist).filter((name) => name.endsWith(extension) && fs.statSync(path.join(dist, name)).isFile());
if (matches.length !== 1) throw new Error(`Expected one ${extension} installer in dist, found ${matches.length}: ${matches.join(', ')}`);

const version = require(path.join(root, 'package.json')).version;
const destination = path.join(root, 'release-assets');
fs.mkdirSync(destination, { recursive: true });
const name = `ipaDown-${version}-${platform}-${arch}${extension}`;
fs.copyFileSync(path.join(dist, matches[0]), path.join(destination, name));
console.log(name);
