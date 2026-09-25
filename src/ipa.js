'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const AdmZip = require('adm-zip');
const plist = require('plist');
const bplist = require('bplist-parser');

// 解析任意 plist（自动识别二进制 bplist00 与 XML）。
function parseAnyPlist(buf) {
  if (buf && buf.length >= 8 && buf.slice(0, 6).toString('latin1') === 'bplist') {
    return bplist.parseBuffer(buf)[0];
  }
  return plist.parse(buf.toString('utf8'));
}

// 流式下载到文件，带进度回调 onProgress({received,total,percent,speed})。
function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const doReq = (u, redirects) => {
      const parsed = new URL(u);
      const lib = parsed.protocol === 'http:' ? http : https;
      const req = lib.get(parsed, {
        headers: {
          'User-Agent': 'Configurator/2.18 (Macintosh; OS X 15.4.1; 24E263) AppleWebKit/0621.1.15.11.10',
          'Apple-Download-Type': 'buy',
          Accept: '*/*',
          'Accept-Language': 'zh-CN,zh-Hans;q=0.9',
        },
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirects > 8) return reject(new Error('重定向过多'));
          return doReq(new URL(res.headers.location, parsed).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('下载失败 HTTP ' + res.statusCode));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        let lastT = Date.now();
        let lastB = 0;
        const out = fs.createWriteStream(destPath);
        res.on('data', (chunk) => {
          received += chunk.length;
          const now = Date.now();
          if (onProgress && now - lastT >= 300) {
            const speed = ((received - lastB) / (now - lastT)) * 1000;
            onProgress({ received, total, percent: total ? received / total : 0, speed });
            lastT = now; lastB = received;
          }
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => {
          if (onProgress) onProgress({ received, total, percent: 1, speed: 0 });
          resolve({ received, total });
        }));
        out.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(120000, () => req.destroy(new Error('下载超时')));
    };
    doReq(url, 0);
  });
}

// 在 zip 中定位 Payload/<App>.app 目录名。
function findAppDir(zip) {
  for (const e of zip.getEntries()) {
    const m = e.entryName.match(/^Payload\/([^/]+\.app)\//);
    if (m) return 'Payload/' + m[1];
  }
  throw new Error('压缩包内未找到 Payload/*.app，可能不是有效 IPA');
}

// 给原始 IPA 注入 iTunesMetadata.plist 与 sinf（使其可被侧载安装）。
// info：store.download() 返回值；account：登录账号；opts.noUpdate：免更新模式。
function patchIpa(ipaPath, info, account, opts = {}) {
  if (!account || !account.appleId || !account.dsPersonId) {
    throw new Error('缺少已授权的 Apple ID / DSID，不能打包个人购买版 IPA');
  }
  const zip = new AdmZip(ipaPath);
  const appDir = findAppDir(zip); // e.g. Payload/Foo.app
  const appName = appDir.replace(/^Payload\//, '').replace(/\.app$/, '');

  // 1) 读取 Info.plist 取 CFBundleExecutable，以及准确的显示名/版本号
  let executable = appName;
  let displayName = '';
  let shortVersion = '';
  let bundleId = '';
  let minOS = '';
  const infoEntry = zip.getEntry(appDir + '/Info.plist');
  if (infoEntry) {
    try {
      const infoPl = parseAnyPlist(infoEntry.getData());
      if (infoPl) {
        if (infoPl.CFBundleExecutable) executable = infoPl.CFBundleExecutable;
        displayName = infoPl.CFBundleDisplayName || infoPl.CFBundleName || '';
        shortVersion = infoPl.CFBundleShortVersionString || infoPl.CFBundleVersion || '';
        bundleId = infoPl.CFBundleIdentifier || '';
        minOS = infoPl.MinimumOSVersion || '';
      }
    } catch (_) { /* 用 appName 兜底 */ }
  }

  // 2) 保留原包已有的购买元数据，再合并商店响应与当前账号的购买凭据。
  // Apple 的 iTunesMetadata 使用 appleId 和 downloadInfo.accountInfo；
  // apple-id / userName 不是对应字段，会让第三方工具无法识别个人购买来源。
  let originalMd = {};
  const originalEntry = zip.getEntry('iTunesMetadata.plist');
  if (originalEntry) {
    try { originalMd = parseAnyPlist(originalEntry.getData()) || {}; } catch (_) { /* ignore */ }
  }
  const md = Object.assign({}, originalMd, info.metadata || {});
  delete md['apple-id'];
  delete md.userName;
  const dsid = Number(account.dsPersonId);
  if (!Number.isSafeInteger(dsid) || dsid <= 0) throw new Error('账号 DSID 无效，无法写入购买元数据');
  const purchaseDate = opts.purchaseDate ? new Date(opts.purchaseDate) : null;
  const validDate = purchaseDate && !Number.isNaN(purchaseDate.getTime());
  const existingInfo = md['com.apple.iTunesStore.downloadInfo'] || {};
  const sf = account.storefrontHeader || account.storefront || '';
  md.appleId = account.appleId;
  md['com.apple.iTunesStore.downloadInfo'] = Object.assign({}, existingInfo, {
    accountInfo: {
      AccountStoreFront: sf,
      AppleID: account.appleId,
      DSPersonID: dsid,
      DownloaderID: 0,
      FamilyID: 0,
      PurchaserID: dsid,
    },
  });
  if (validDate) {
    md.purchaseDate = purchaseDate;
    md['com.apple.iTunesStore.downloadInfo'].purchaseDate = purchaseDate.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  if (opts.noUpdate) md.softwareVersionExternalIdentifier = 999888777; // 免更新
  zip.addFile('iTunesMetadata.plist', Buffer.from(plist.build(md)));

  // 3) 写入 sinf。优先按 SC_Info/Manifest.plist 的 SinfPaths 分发，否则 <exec>.sinf
  const sinfs = (info.sinfs || []).slice().sort((a, b) => a.id - b.id);
  let sinfPaths = null;
  const manifestEntry = zip.getEntry(appDir + '/SC_Info/Manifest.plist');
  if (manifestEntry) {
    try {
      const mf = parseAnyPlist(manifestEntry.getData());
      if (mf && Array.isArray(mf.SinfPaths)) sinfPaths = mf.SinfPaths;
    } catch (_) { /* ignore */ }
  }
  if (sinfPaths && sinfPaths.length) {
    sinfs.forEach((s, i) => {
      const rel = sinfPaths[i] || sinfPaths[0];
      zip.addFile(appDir + '/' + rel, s.data);
    });
  } else {
    sinfs.forEach((s) => {
      zip.addFile(appDir + '/SC_Info/' + executable + '.sinf', s.data);
    });
  }

  zip.writeZip(ipaPath); // 原地回写
  // 以 Info.plist 为准的准确名称/版本（下载响应里的可能不准）
  return {
    appName, executable, sinfCount: sinfs.length,
    displayName: displayName || appName,
    shortVersion, bundleId, minOS,
  };
}

// 安全文件名。
function safeName(s) {
  return String(s || 'app').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim() || 'app';
}

// 下载 + 后处理完整流程。
// opts.compatTag: 文件名方括号里的「最佳兼容」标签（如 "iOS12"），空则不加方括号。
async function downloadAndPatch(info, account, destDir, opts, onProgress) {
  opts = opts || {};
  fs.mkdirSync(destDir, { recursive: true });
  // 先用临时名下载，patch 后再按 Info.plist 准确信息重命名
  const tmp = path.join(destDir, `.dl_${safeName(info.name || 'app')}_${Date.now()}.ipa.part`);
  await downloadFile(info.url, tmp, onProgress);
  const meta = patchIpa(tmp, info, account, opts);

  // 以 Info.plist 为准命名；下载响应里的 name/version 可能不准
  const name = safeName(meta.displayName || info.name || account.appleId);
  const ver = safeName(meta.shortVersion || info.version || info.versionId || 'latest');
  const bracket = opts.compatTag ? `[${opts.compatTag}最佳兼容版]` : '';
  let fname = `${bracket}${name}_${ver}.ipa`;
  let dest = path.join(destDir, fname);
  // 避免覆盖
  if (fs.existsSync(dest)) {
    fname = `${bracket}${name}_${ver}_${info.versionId || Date.now()}.ipa`;
    dest = path.join(destDir, fname);
  }
  fs.renameSync(tmp, dest);
  return { path: dest, fileName: fname, ...meta };
}

module.exports = { downloadFile, patchIpa, downloadAndPatch, parseAnyPlist };
