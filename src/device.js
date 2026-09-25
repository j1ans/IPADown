'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// libimobiledevice 命令行封装：识别设备 / 列已装应用 / 安装 IPA。
// 工具(idevice_id, ideviceinfo, ideviceinstaller)从以下位置解析：
//   1) 用户在设置里指定的目录  2) 应用自带 tools 目录  3) 系统 PATH
let TOOL_DIRS = [];

function setToolDirs(dirs) { TOOL_DIRS = (dirs || []).filter(Boolean); }

function exe(name) {
  const fn = process.platform === 'win32' ? name + '.exe' : name;
  const platformDirs = process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
    : process.platform === 'linux' ? ['/usr/local/bin', '/usr/bin', '/bin'] : [];
  for (const d of [...TOOL_DIRS, ...platformDirs]) {
    const p = path.join(d, fn);
    if (fs.existsSync(p)) return p;
  }
  return fn; // 退回 PATH
}

function run(name, args, timeout) {
  const r = spawnSync(exe(name), args, { encoding: 'utf8', timeout: timeout || 20000, windowsHide: true });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '', failed: r.error != null };
}

// 工具是否可用
function ready() {
  const r = run('idevice_id', ['-h'], 5000);
  return !r.failed; // 能启动即认为安装了
}

function toolStatus() {
  const names = ['idevice_id', 'ideviceinfo', 'ideviceinstaller'];
  const status = {};
  for (const n of names) {
    const r = run(n, ['-h'], 5000);
    status[n] = !r.failed;
  }
  status.ready = status.idevice_id && status.ideviceinfo && status.ideviceinstaller;
  status.exePath = exe('ideviceinstaller');
  status.installHint = process.platform === 'darwin'
    ? 'brew install libimobiledevice ideviceinstaller'
    : process.platform === 'linux'
      ? '安装 libimobiledevice-utils、ideviceinstaller 和 usbmuxd'
      : '检查随应用附带的 libimobiledevice 工具';
  return status;
}

function modernInstaller() {
  const result = run('ideviceinstaller', ['--help'], 5000);
  const help = result.out + result.err;
  return /ideviceinstaller\s+list|ideviceinstaller\s+install|Commands:/i.test(help);
}

// 列出已连接设备 UDID
function listDevices() {
  const r = run('idevice_id', ['-l']);
  if (r.failed) return [];
  return r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

// 设备信息：iOS 版本/型号/名称
function deviceInfo(udid) {
  const args = udid ? ['-u', udid] : [];
  const r = run('ideviceinfo', args);
  if (r.failed || r.code !== 0) return null;
  const info = {};
  for (const line of r.out.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) info[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  // Some older libimobiledevice builds omit keys in the full listing.
  for (const key of ['ProductVersion', 'DeviceName', 'ProductType']) {
    if (!info[key]) {
      const single = run('ideviceinfo', args.concat(['-k', key]));
      if (!single.failed && single.code === 0) info[key] = single.out.trim();
    }
  }
  return {
    udid: udid || info.UniqueDeviceID || '',
    name: (info.DeviceName || '').replace(/^"|"$/g, ''),
    productVersion: info.ProductVersion || '', // iOS 版本，如 12.5.7
    productType: info.ProductType || '',       // 型号标识，如 iPhone9,1
    buildVersion: info.BuildVersion || '',
  };
}

// 已安装的用户应用：返回 [{bundleId, version, name}]
// 注：使用旧式参数 -l -o list_user（该 Windows 构建为旧版 ideviceinstaller）
function installedApps(udid) {
  const base = udid ? ['-u', udid] : [];
  // Current ideviceinstaller uses subcommands; older Windows bundles use -l/-i.
  const modern = modernInstaller();
  let r = run('ideviceinstaller', base.concat(modern ? ['list', '--user', '--xml'] : ['-l', '-o', 'list_user', '-o', 'xml']));
  if (r.failed) return { ok: false, apps: [], error: 'ideviceinstaller 未就绪' };
  const apps = [];
  const xml = r.out;
  if (xml.indexOf('<plist') >= 0) {
    try {
      const plist = require('plist');
      const arr = plist.parse(xml);
      if (Array.isArray(arr)) {
        for (const a of arr) apps.push({ bundleId: a.CFBundleIdentifier || '', version: a.CFBundleShortVersionString || a.CFBundleVersion || '', name: a.CFBundleDisplayName || a.CFBundleName || '' });
      }
    } catch (e) { /* fall through */ }
  }
  if (!apps.length) {
    // 退回文本输出： "bundleId, \"version\", \"name\""
    r = run('ideviceinstaller', base.concat(modern ? ['list', '--user'] : ['-l', '-o', 'list_user']));
    for (const line of (r.out || '').split(/\r?\n/)) {
      if (/^CFBundleIdentifier/i.test(line)) continue; // 表头
      const m = line.match(/^([\w.\-]+)\s*,\s*"?([^",]*)"?\s*,\s*"?(.+?)"?\s*$/);
      if (m) apps.push({ bundleId: m[1], version: m[2].trim(), name: m[3].trim() });
    }
  }
  return { ok: true, apps };
}

let installSeq = 0;
// 安装 IPA，流式回调进度。（旧式 -i 参数）
// 注：ideviceinstaller 对中文路径会编码错乱（libzip zip_open 报错 18），
// 故先把 IPA 复制成纯 ASCII 临时名再安装，装完删除。
function install(udid, ipaPath, onLine) {
  return new Promise((resolve) => {
    const os = require('os');
    let target = ipaPath;
    let tmp = null;
    if (/[^\x00-\x7f]/.test(ipaPath)) { // 路径含非 ASCII 才复制
      try {
        tmp = path.join(os.tmpdir(), 'ipadown_install_' + (++installSeq) + '_' + process.pid + '.ipa');
        fs.copyFileSync(ipaPath, tmp);
        target = tmp;
      } catch (e) { tmp = null; target = ipaPath; }
    }
    const cleanup = () => { if (tmp) { try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ } } };
    const base = udid ? ['-u', udid] : [];
    const command = modernInstaller() ? ['install', target] : ['-i', target];
    const child = spawn(exe('ideviceinstaller'), base.concat(command), { windowsHide: true });
    let buf = '';
    const handle = (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (line && onLine) onLine(line);
      }
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('error', (e) => { cleanup(); resolve({ ok: false, error: e.message }); });
    child.on('close', (code) => {
      if (buf.trim() && onLine) onLine(buf.trim());
      cleanup();
      resolve({ ok: code === 0, code });
    });
  });
}

module.exports = { setToolDirs, ready, toolStatus, listDevices, deviceInfo, installedApps, install };
