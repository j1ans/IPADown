'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'build', 'authbridge');
fs.mkdirSync(output, { recursive: true });
const binary = path.join(output, process.platform === 'win32' ? 'authbridge.exe' : 'authbridge');
const result = spawnSync('go', ['build', '-o', binary, '.'], {
  cwd: path.join(root, 'authbridge'), stdio: 'inherit', windowsHide: true,
});
if (result.error) throw new Error(`Go compiler is required to build the authentication bridge: ${result.error.message}`);
if (result.status !== 0) process.exit(result.status || 1);
console.log(`Built ${binary}`);
