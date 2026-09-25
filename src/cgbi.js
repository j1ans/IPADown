'use strict';
const zlib = require('zlib');

// 把 Apple 的 CgBI 私有 PNG（App Store IPA 里的图标）转成标准 PNG。
// CgBI 特征：含 "CgBI" chunk；IDAT 是无 zlib 头的 raw deflate；
// 像素为 BGRA 且 alpha 预乘。转换：inflateRaw → 反滤波 → 交换R/B + 反预乘 → 标准 PNG。

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    CRC_TABLE[n] = c >>> 0;
  }
  return CRC_TABLE;
}
function crc32(buf) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// 反 PNG 滤波，返回原始像素（stride=width*bpp 行）。bpp 固定 4（RGBA8）。
function defilter(data, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = data[pos++];
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const raw = data[pos++];
      const a = x >= bpp ? out[rowStart + x - bpp] : 0;
      const b = y > 0 ? out[prevStart + x] : 0;
      const c = (y > 0 && x >= bpp) ? out[prevStart + x - bpp] : 0;
      let val;
      switch (filter) {
        case 0: val = raw; break;
        case 1: val = raw + a; break;
        case 2: val = raw + b; break;
        case 3: val = raw + ((a + b) >> 1); break;
        case 4: val = raw + paeth(a, b, c); break;
        default: val = raw;
      }
      out[rowStart + x] = val & 0xff;
    }
  }
  return out;
}

// 是否为 CgBI PNG
function isCgBI(buf) {
  if (!buf || buf.length < 16 || !buf.slice(0, 8).equals(SIG)) return false;
  // 第一个 chunk 类型在偏移 12..16
  return buf.slice(12, 16).toString('latin1') === 'CgBI';
}

// 读取 PNG 头信息：{width,height,bitDepth,colorType,interlace,cgbi}
function pngMeta(buf) {
  if (!buf || buf.length < 8 || !buf.slice(0, 8).equals(SIG)) return null;
  const cgbi = buf.slice(12, 16).toString('latin1') === 'CgBI';
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.slice(p + 4, p + 8).toString('latin1');
    if (type === 'IHDR') {
      const d = buf.slice(p + 8, p + 8 + len);
      return { width: d.readUInt32BE(0), height: d.readUInt32BE(4), bitDepth: d[8], colorType: d[9], interlace: d[12], cgbi };
    }
    p += 12 + len;
  }
  return null;
}

// 主转换：返回标准 PNG Buffer；若不是 CgBI 原样返回。
function toStandardPng(buf) {
  if (!isCgBI(buf)) return buf;
  let width = 0; let height = 0; let bitDepth = 8; let colorType = 6; let interlaceByte = 0;
  const idat = [];
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.slice(p + 4, p + 8).toString('latin1');
    const data = buf.slice(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlaceByte = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + len;
  }
  if (!width || !height) return buf;
  if (interlaceByte !== 0) throw new Error('interlaced CgBI 不支持'); // 调用方改选非隔行图标
  if (bitDepth !== 8 || colorType !== 6) throw new Error('非 RGBA8 CgBI 不支持');
  const bpp = 4; // CgBI 图标均为 RGBA8
  const raw = zlib.inflateRawSync(Buffer.concat(idat));
  const px = defilter(raw, width, height, bpp);
  // BGRA 预乘 → RGBA 直通
  for (let i = 0; i < px.length; i += 4) {
    const b = px[i]; const r = px[i + 2]; const a = px[i + 3];
    let R = r; let G = px[i + 1]; let B = b;
    if (a > 0 && a < 255) { R = Math.min(255, Math.round(r * 255 / a)); G = Math.min(255, Math.round(px[i + 1] * 255 / a)); B = Math.min(255, Math.round(b * 255 / a)); }
    px[i] = R; px[i + 1] = G; px[i + 2] = B; // a 不变
  }
  // 重新加 filter 0 并标准 deflate
  const stride = width * bpp;
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 0;
    px.copy(filtered, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const compressed = zlib.deflateSync(filtered, { level: 6 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { toStandardPng, isCgBI, pngMeta };
