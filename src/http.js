'use strict';
const https = require('https');
const http = require('http');
const { URL } = require('url');

// 极简 Cookie Jar：跨请求保存/附带 Cookie（登录后下载/购买需要）。
class CookieJar {
  constructor() { this.cookies = new Map(); }
  setFromHeaders(headers) {
    const sc = headers['set-cookie'];
    if (!sc) return;
    for (const line of sc) {
      const kv = line.split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) this.cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }
  // Restore a previously encrypted local session's cookies.
  setRaw(cookieStr) {
    if (!cookieStr) return;
    for (const part of String(cookieStr).split(';')) {
      const kv = part.trim();
      const i = kv.indexOf('=');
      if (i > 0) this.cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }
  header() {
    const parts = [];
    for (const [k, v] of this.cookies) parts.push(`${k}=${v}`);
    return parts.join('; ');
  }
  clear() { this.cookies.clear(); }
}

// 发送一次 HTTP(S) 请求。opts: {method, headers, jar}; body 为 string/Buffer。
function request(urlStr, opts = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'http:' ? http : https;
    const headers = Object.assign({}, opts.headers || {});
    if (opts.jar) {
      const c = opts.jar.header();
      if (c) headers['Cookie'] = c;
    }
    if (body != null && headers['Content-Length'] == null) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = lib.request(
      u,
      { method: opts.method || 'GET', headers, timeout: opts.timeout || 60000 },
      (res) => {
        if (opts.jar) opts.jar.setFromHeaders(res.headers);
        // 跟随重定向（下载直链常见 30x）
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && !opts.noRedirect) {
          res.resume();
          const next = new URL(res.headers.location, u).toString();
          request(next, opts, [307, 308].includes(res.statusCode) ? body : null)
            .then(resolve, reject);
          return;
        }
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

module.exports = { CookieJar, request };
