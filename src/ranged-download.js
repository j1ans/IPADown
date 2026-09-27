'use strict';
const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const HEADERS = {
  'User-Agent': 'Configurator/2.18 (Macintosh; OS X 15.4.1; 24E263) AppleWebKit/0621.1.15.11.10',
  'Apple-Download-Type': 'buy',
  Accept: '*/*',
  'Accept-Language': 'zh-CN,zh-Hans;q=0.9',
};

function response(url, headers, signal, redirects = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.get(parsed, { headers: { ...HEADERS, ...headers }, signal }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects >= 8) return reject(new Error('重定向过多'));
        return resolve(response(new URL(res.headers.location, parsed).toString(), headers, signal, redirects + 1));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('下载超时')));
  });
}

function progressReporter(onProgress, total) {
  let received = 0;
  let lastTime = Date.now();
  let lastBytes = 0;
  return {
    add(bytes) {
      received += bytes;
      const now = Date.now();
      if (onProgress && now - lastTime >= 300) {
        onProgress({ received, total, percent: total ? received / total : 0,
          speed: (received - lastBytes) * 1000 / (now - lastTime) });
        lastTime = now; lastBytes = received;
      }
    },
    finish() {
      if (onProgress) onProgress({ received, total: total || received, percent: 1, speed: 0 });
      return { received, total: total || received };
    },
  };
}

async function singleDownload(url, destPath, onProgress) {
  const res = await response(url, {});
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error('下载失败 HTTP ' + res.statusCode);
  }
  const total = Number(res.headers['content-length']) || 0;
  const progress = progressReporter(onProgress, total);
  let receivedBytes = 0;
  const file = await fs.promises.open(destPath, 'w');
  try {
    for await (const chunk of res) {
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
        offset += bytesWritten;
      }
      receivedBytes += chunk.length;
      progress.add(chunk.length);
    }
    if (total && receivedBytes !== total) throw new Error(`下载不完整 ${receivedBytes}/${total}`);
    return progress.finish();
  } finally {
    await file.close();
  }
}

async function rangedDownload(url, destPath, total, threads, onProgress) {
  const file = await fs.promises.open(destPath, 'w');
  const controller = new AbortController();
  const progress = progressReporter(onProgress, total);
  const count = Math.min(threads, total);
  const size = Math.ceil(total / count);
  let failure;
  try {
    await file.truncate(total);
    await Promise.all(Array.from({ length: count }, async (_, index) => {
      const start = index * size;
      const end = Math.min(total - 1, start + size - 1);
      if (start > end) return;
      let received = 0;
      for (let attempt = 0; attempt < 4 && !failure; attempt++) {
        const offset = start + received;
        try {
          const res = await response(url, { Range: `bytes=${offset}-${end}` }, controller.signal);
          const range = String(res.headers['content-range'] || '').match(/^bytes (\d+)-(\d+)\/(\d+)$/);
          if (res.statusCode !== 206 || !range || +range[1] !== offset || +range[2] !== end || +range[3] !== total) {
            res.destroy();
            const error = new Error(`分段响应无效 HTTP ${res.statusCode}`);
            error.rangeRejected = true;
            throw error;
          }
          for await (const chunk of res) {
            if (received + chunk.length > end - start + 1) throw new Error('分段超出预期大小');
            let written = 0;
            while (written < chunk.length) {
              const result = await file.write(chunk, written, chunk.length - written, start + received + written);
              written += result.bytesWritten;
            }
            received += chunk.length;
            progress.add(chunk.length);
          }
          if (received === end - start + 1) return;
          throw new Error('分段提前结束');
        } catch (err) {
          if (err.rangeRejected || attempt === 3) {
            failure = err;
            controller.abort();
          } else if (!failure) {
            await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 500));
          }
        }
      }
    }));
    if (failure) throw failure;
    return progress.finish();
  } finally {
    controller.abort();
    await file.close();
  }
}

async function downloadFile(url, destPath, onProgress, options = {}) {
  const threads = Math.max(1, Math.min(16, Number(options.threads) || 8));
  try {
    if (threads > 1) {
      const probe = await response(url, { Range: 'bytes=0-0' });
      const range = String(probe.headers['content-range'] || '').match(/^bytes 0-0\/(\d+)$/);
      const supportsRange = probe.statusCode === 206 && range && Number(range[1]) > 1;
      const status = probe.statusCode;
      probe.destroy();
      if (supportsRange) {
        try {
          return await rangedDownload(url, destPath, Number(range[1]), threads, onProgress);
        } catch (_) {
          await fs.promises.rm(destPath, { force: true });
          return await singleDownload(url, destPath, onProgress);
        }
      }
      if (status !== 200 && status !== 206) throw new Error('下载探测失败 HTTP ' + status);
    }
    return await singleDownload(url, destPath, onProgress);
  } catch (err) {
    await fs.promises.rm(destPath, { force: true }).catch(() => {});
    throw err;
  }
}

module.exports = { downloadFile };
