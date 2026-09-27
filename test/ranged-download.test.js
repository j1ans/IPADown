'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { downloadFile } = require('../src/ranged-download');

const body = Buffer.alloc(1024 * 128);
for (let i = 0; i < body.length; i++) body[i] = i % 251;

async function fixture(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipadown-range-test-'));
  try {
    await run(`http://127.0.0.1:${server.address().port}/file`, path.join(dir, 'file.ipa'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('downloads eight independent ranges and assembles the original file', async () => {
  let active = 0;
  let maximum = 0;
  const seen = [];
  await fixture((req, res) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    assert.ok(match);
    const start = Number(match[1]);
    const end = Number(match[2]);
    seen.push([start, end]);
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${body.length}`,
      'Content-Length': end - start + 1,
    });
    if (start === 0 && end === 0) return res.end(body.subarray(0, 1));
    active++;
    maximum = Math.max(maximum, active);
    setTimeout(() => { active--; res.end(body.subarray(start, end + 1)); }, 20);
  }, async (url, dest) => {
    const result = await downloadFile(url, dest, null, { threads: 8 });
    assert.equal(result.received, body.length);
    assert.deepEqual(fs.readFileSync(dest), body);
  });
  assert.equal(seen.length, 9); // one probe and eight ranges
  assert.equal(maximum, 8);
});

test('uses one complete request when the server ignores Range', async () => {
  let requests = 0;
  await fixture((_req, res) => {
    requests++;
    res.writeHead(200, { 'Content-Length': body.length });
    res.end(body);
  }, async (url, dest) => {
    await downloadFile(url, dest, null, { threads: 8 });
    assert.deepEqual(fs.readFileSync(dest), body);
  });
  assert.equal(requests, 2); // probe and full download
});

test('falls back if range probe succeeds but download requests ignore Range', async () => {
  let rangedRequests = 0;
  let fullRequests = 0;
  await fixture((req, res) => {
    if (req.headers.range === 'bytes=0-0') {
      res.writeHead(206, { 'Content-Range': `bytes 0-0/${body.length}`, 'Content-Length': 1 });
      return res.end(body.subarray(0, 1));
    }
    if (req.headers.range) rangedRequests++;
    else fullRequests++;
    res.writeHead(200, { 'Content-Length': body.length });
    res.end(body);
  }, async (url, dest) => {
    await downloadFile(url, dest, null, { threads: 8 });
    assert.deepEqual(fs.readFileSync(dest), body);
  });
  assert.ok(rangedRequests > 0);
  assert.equal(fullRequests, 1);
});

test('retries an interrupted range from the last byte received', async () => {
  let interrupted = false;
  const requests = [];
  await fixture((req, res) => {
    const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
    const start = Number(first);
    const end = Number(last);
    requests.push([start, end]);
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${body.length}`,
      'Content-Length': end - start + 1,
    });
    if (start === 0 && end === 0) return res.end(body.subarray(0, 1));
    if (!interrupted) {
      interrupted = true;
      res.write(body.subarray(start, start + 1024));
      return res.destroy();
    }
    res.end(body.subarray(start, end + 1));
  }, async (url, dest) => {
    await downloadFile(url, dest, null, { threads: 4 });
    assert.deepEqual(fs.readFileSync(dest), body);
  });
  assert.ok(requests.length >= 6);
});
