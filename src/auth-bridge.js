'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function bridgePath() {
  const name = process.platform === 'win32' ? 'authbridge.exe' : 'authbridge';
  const candidates = [
    process.env.IPADOWN_AUTH_BRIDGE,
    path.join(process.resourcesPath || '', 'authbridge', name),
    path.join(__dirname, '..', '..', 'authbridge', name),
    path.join(__dirname, '..', 'build', 'authbridge', name),
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('缺少 ipatool 登录组件；请重新安装应用或运行 npm run build:auth');
  return found;
}

function login(input) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(bridgePath(), [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch (error) { reject(error); return; }
    let output = '';
    let errorOutput = '';
    const timer = setTimeout(() => child.kill(), 5 * 60 * 1000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { errorOutput += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(errorOutput.trim() || `ipatool 登录组件退出：${code}`)); return; }
      try { resolve(JSON.parse(output)); }
      catch (_) { reject(new Error('ipatool 登录组件未返回有效结果')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

module.exports = { login, bridgePath };
