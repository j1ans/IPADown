'use strict';
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { toStandardPng, pngMeta } = require('./cgbi');
const { parseAnyPlist } = require('./ipa');

// 从 IPA 提取图标（原生），返回 data URI 或 ''。
// 严格优先级：① Info.plist 声明的图标名  ② 标准 iOS 图标文件名白名单  ③ 退路
function extractIcon(zip, appDir, info) {
  const rootPrefix = appDir + '/';
  // 收集 .app 根层的所有 png
  const pngs = [];
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const n = e.entryName;
    if (!n.startsWith(rootPrefix)) continue;
    const rel = n.slice(rootPrefix.length);
    if (rel.indexOf('/') >= 0) continue; // 仅根层
    if (!/\.png$/i.test(rel)) continue;
    pngs.push({ entry: e, size: e.header.size, base: rel.replace(/\.png$/i, '') });
  }
  if (!pngs.length) return '';

  // ① 声明的图标名（去 .png，小写）
  const declared = [];
  const add = (a) => { if (Array.isArray(a)) for (const x of a) if (typeof x === 'string') declared.push(x.replace(/\.png$/i, '').toLowerCase()); };
  const ic = info && info.CFBundleIcons;
  if (ic && ic.CFBundlePrimaryIcon) add(ic.CFBundlePrimaryIcon.CFBundleIconFiles);
  const icPad = info && info['CFBundleIcons~ipad'];
  if (icPad && icPad.CFBundlePrimaryIcon) add(icPad.CFBundlePrimaryIcon.CFBundleIconFiles);
  add(info && info.CFBundleIconFiles);
  if (typeof (info && info.CFBundleIconFile) === 'string') declared.push(info.CFBundleIconFile.replace(/\.png$/i, '').toLowerCase());

  // 声明名严格匹配：base === 名 / 名@2x / 名@3x / 名~ipad …（不能是 名XXX 的误伤）
  const matchDeclared = (base) => {
    const b = base.toLowerCase();
    return declared.some((nm) => b === nm || b.startsWith(nm + '@') || b.startsWith(nm + '~'));
  };
  // ② 标准 iOS 图标文件名
  const STD = /^(appicon.*|icon|icon-?\d{2,3}|icon-?small(-50)?|itunesartwork)(@[23]x)?(~(iphone|ipad))?$/i;

  let pool = pngs.filter((p) => declared.length && matchDeclared(p.base));
  if (!pool.length) pool = pngs.filter((p) => STD.test(p.base));
  // ③ 退路：base 以 icon/appicon 开头（避免 Emoticon/xxx_icon 这类误伤）
  if (!pool.length) pool = pngs.filter((p) => /^(app)?icon/i.test(p.base));
  if (!pool.length) return '';

  // 读每个候选的 PNG 头：优先非隔行（隔行 Adam7 无法直接转，会花屏），再按分辨率从大到小
  for (const p of pool) { p.data = p.entry.getData(); const m = pngMeta(p.data); p.interlace = m ? m.interlace : 0; }
  pool.sort((a, b) => (a.interlace - b.interlace) || (b.size - a.size));
  // 依次尝试，跳过转换失败（隔行/非RGBA8）的，取第一个成功的
  for (const p of pool) {
    try {
      const png = toStandardPng(p.data);
      return 'data:image/png;base64,' + png.toString('base64');
    } catch (e) { /* 试下一个候选 */ }
  }
  return '';
}

// 解析文件名里的兼容标签 [iOSx完美兼容版] / [iOSx最佳兼容版]
function parseTag(fileName) {
  const m = fileName.match(/^\[(iOS[\d.]+)(完美兼容版|最佳兼容版)\]/);
  return m ? { ios: m[1], kind: m[2] } : null;
}

// 扫描目录下所有 ipa
function scanFile(full) {
    const f = path.basename(full);
    let stat;
    try { stat = fs.statSync(full); } catch (e) { return null; }
    const rec = {
      file: f, path: full, sizeMB: Math.round(stat.size / 1048576 * 10) / 10,
      name: f.replace(/\.ipa$/i, ''), bundleId: '', version: '', minOS: '',
      icon: '', tag: parseTag(f), error: '', appId: '',
    };
    try {
      const zip = new AdmZip(full);
      const metadataEntry = zip.getEntry('iTunesMetadata.plist');
      if (metadataEntry) {
        try {
          const metadata = parseAnyPlist(metadataEntry.getData());
          rec.appId = String(metadata.itemId || metadata.salableAdamId || metadata.adamId || '');
        } catch (_) { /* Older IPAs may have no readable metadata. */ }
      }
      let appDir = '';
      for (const e of zip.getEntries()) {
        const m = e.entryName.match(/^Payload\/([^/]+\.app)\//);
        if (m) { appDir = 'Payload/' + m[1]; break; }
      }
      if (appDir) {
        const infoEntry = zip.getEntry(appDir + '/Info.plist');
        const info = infoEntry ? parseAnyPlist(infoEntry.getData()) : {};
        rec.name = info.CFBundleDisplayName || info.CFBundleName || rec.name;
        rec.bundleId = info.CFBundleIdentifier || '';
        rec.version = info.CFBundleShortVersionString || info.CFBundleVersion || '';
        rec.minOS = info.MinimumOSVersion || '';
        rec.icon = extractIcon(zip, appDir, info);
      } else {
        rec.error = '非有效 IPA';
      }
    } catch (e) {
      rec.error = e.message;
    }
    return rec;
}

function scan(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.ipa$/i.test(f))
    .map((f) => scanFile(path.join(dir, f))).filter(Boolean);
}

module.exports = { scan, scanFile, extractIcon, parseTag };
