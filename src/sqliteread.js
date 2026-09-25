'use strict';
const fs = require('fs');

// 极简只读 SQLite 解析器：只为读取「购买记录库」这类本地 .sqlite 文件，
// 不做写入、不加原生依赖（Electron 31 的 Node 20 尚无 node:sqlite）。
// 支持：表 b-tree（leaf/interior）、varint、record 序列化格式、溢出页、UTF-8 文本。
// 不支持：WAL 未合并数据（若有 -wal 文件则忽略之，读到的是已检查点内容）、WITHOUT ROWID 表。

function readVarint(buf, off) {
  let v = 0;
  for (let i = 0; i < 8; i++) {
    const b = buf[off + i];
    v = v * 128 + (b & 0x7f);
    if (!(b & 0x80)) return [v, i + 1];
  }
  return [v * 256 + buf[off + 8], 9]; // 第 9 字节贡献完整 8 位
}

// record 载荷 → JS 值数组（按列序）。serial type 见 SQLite 文档 §Record Format。
function decodeRecord(buf) {
  const [hdrLen, hdrUsed] = readVarint(buf, 0);
  const types = [];
  let p = hdrUsed;
  while (p < hdrLen) {
    const [t, n] = readVarint(buf, p);
    types.push(t); p += n;
  }
  const INT_SIZE = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 6, 6: 8 };
  const vals = [];
  let d = hdrLen;
  for (const t of types) {
    if (t === 0) vals.push(null);
    else if (INT_SIZE[t]) {
      const size = INT_SIZE[t];
      vals.push(size === 8 ? Number(buf.readBigInt64BE(d)) : buf.readIntBE(d, size));
      d += size;
    } else if (t === 7) { vals.push(buf.readDoubleBE(d)); d += 8; }
    else if (t === 8) vals.push(0);
    else if (t === 9) vals.push(1);
    else if (t >= 12 && t % 2 === 0) { const n = (t - 12) / 2; vals.push(buf.slice(d, d + n)); d += n; }
    else if (t >= 13) { const n = (t - 13) / 2; vals.push(buf.toString('utf8', d, d + n)); d += n; }
  }
  return vals;
}

// 从 CREATE TABLE 语句解析列名（够用于普通建表语句，不追求完整 SQL 语法）。
function parseColumns(sql) {
  const open = sql.indexOf('(');
  const close = sql.lastIndexOf(')');
  if (open < 0 || close <= open) return [];
  const body = sql.slice(open + 1, close);
  const parts = []; let depth = 0; let cur = ''; let quote = '';
  for (const ch of body) {
    if (quote) { cur += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  const SKIP = new Set(['PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN', 'CONSTRAINT']);
  const cols = [];
  for (const part of parts) {
    const m = /^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_$]*))/.exec(part.trim());
    if (!m) continue;
    const name = m[1] || m[2] || m[3] || m[4];
    if (SKIP.has(name.toUpperCase())) continue;
    cols.push(name);
  }
  return cols;
}

class SqliteFile {
  constructor(filePath) {
    this.buf = fs.readFileSync(filePath);
    const b = this.buf;
    if (b.length < 100 || b.toString('ascii', 0, 16) !== 'SQLite format 3\u0000') throw new Error('不是有效的 SQLite 文件');
    let ps = b.readUInt16BE(16);
    if (ps === 1) ps = 65536;
    this.pageSize = ps;
    this.usable = ps - b[20];
    this.maxLocal = this.usable - 35;                       // 表叶 X
    this.minLocal = Math.floor((this.usable - 12) * 32 / 255) - 23; // 表叶 M
  }

  // 表 b-tree 遍历：对每个 (rowid, payloadBuffer) 调 visit
  walkTable(pageNo, visit) {
    const buf = this.buf;
    const base = (pageNo - 1) * this.pageSize;
    const hdr = base + (pageNo === 1 ? 100 : 0);
    const type = buf[hdr];
    const nCells = buf.readUInt16BE(hdr + 3);
    if (type === 13) { // 叶页
      for (let i = 0; i < nCells; i++) {
        const cp = base + buf.readUInt16BE(hdr + 8 + i * 2);
        const [payloadLen, n1] = readVarint(buf, cp);
        const [, n2] = readVarint(buf, cp + n1);
        visit(cp + n1 + n2, payloadLen);
      }
    } else if (type === 5) { // 内部页
      for (let i = 0; i < nCells; i++) {
        const cp = base + buf.readUInt16BE(hdr + 12 + i * 2);
        this.walkTable(buf.readUInt32BE(cp), visit);
      }
      this.walkTable(buf.readUInt32BE(hdr + 8), visit); // 最右子页
    } else {
      throw new Error('意外的页类型 ' + type + '（可能是不支持的 WITHOUT ROWID 表）');
    }
  }

  // 取出 cell 的完整载荷（处理溢出页链）
  payloadAt(off, len) {
    if (len <= this.maxLocal) return this.buf.slice(off, off + len);
    let local = this.minLocal + ((len - this.minLocal) % (this.usable - 4));
    if (local > this.maxLocal) local = this.minLocal;
    const parts = [this.buf.slice(off, off + local)];
    let next = this.buf.readUInt32BE(off + local);
    let remaining = len - local;
    while (next && remaining > 0) {
      const pb = (next - 1) * this.pageSize;
      next = this.buf.readUInt32BE(pb);
      const take = Math.min(remaining, this.usable - 4);
      parts.push(this.buf.slice(pb + 4, pb + 4 + take));
      remaining -= take;
    }
    return Buffer.concat(parts);
  }
}

// 读出整个库：{ 表名: [ {列:值}, ... ] }
function readTables(filePath) {
  const db = new SqliteFile(filePath);
  const schemas = [];
  db.walkTable(1, (off, len) => { // 页 1 = sqlite_master
    const [type, name, , rootPage, sql] = decodeRecord(db.payloadAt(off, len));
    if (type === 'table' && rootPage) schemas.push({ name, rootPage, sql: String(sql || '') });
  });
  const out = {};
  for (const s of schemas) {
    const cols = parseColumns(s.sql);
    const rows = [];
    db.walkTable(s.rootPage, (off, len) => {
      const vals = decodeRecord(db.payloadAt(off, len));
      const row = {};
      cols.forEach((c, i) => { row[c] = vals[i] === undefined ? null : vals[i]; });
      rows.push(row);
    });
    out[s.name] = rows;
  }
  return out;
}

module.exports = { readTables };
