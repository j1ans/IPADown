'use strict';
const os = require('os');

// 复刻原 exe：取本机第一块有效网卡 MAC，去分隔符转大写作为 GUID。
// 原程序调用 GetAdaptersInfo，这里用 Node os.networkInterfaces() 等价实现。
function machineGUID() {
  const ifaces = os.networkInterfaces();
  let fallback = '';
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name]) {
      const mac = (ni.mac || '').replace(/:/g, '').toUpperCase();
      if (!mac || mac === '000000000000' || mac.length !== 12) continue;
      // 优先非内网回环、IPv4 已分配的网卡
      if (!ni.internal) return mac;
      if (!fallback) fallback = mac;
    }
  }
  if (fallback) return fallback;
  throw new Error('未找到可用网卡 MAC 地址，无法生成 GUID');
}

module.exports = { machineGUID };
