'use strict';
const fs = require('fs');
const path = require('path');
const { RescueEngine, extractFromIpa, extractFromPlist } = require('./rescue-core');
const { ManifestDB } = require('./manifestdb');

const send = (event) => process.stdout.write(JSON.stringify(event) + '\n');
let output = '';
let engine = null;
let db = null;

async function handle(msg) {
  try {
    if (msg.cmd === 'init') {
      output = msg.out;
      fs.mkdirSync(output, { recursive: true });
      db = new ManifestDB(path.join(output, 'manifest_rescue.db'));
      send({ type: 'init-ok', out: output });
    } else if (msg.cmd === 'analyze') {
      const items = [];
      for (const file of msg.paths || []) {
        try {
          const item = /\.plist$/i.test(file) ? await extractFromPlist(file) : extractFromIpa(file);
          items.push({ ok: true, path: file, ...item });
        } catch (e) { items.push({ ok: false, path: file, error: e.message }); }
      }
      send({ type: 'analyzed', items });
    } else if (msg.cmd === 'start') {
      if (engine) return send({ type: 'start-err', error: '搜救任务正在运行' });
      if (!db || !msg.session?.passwordToken) throw new Error('请先登录 Apple ID');
      const items = (msg.items || []).map((x) => ({ adamId: String(x.adamId), name: x.name || '', versionIds: x.versionIds || [], curVersionId: x.curVersionId || '' }));
      if (!items.length) throw new Error('请先添加 IPA 或 plist');
      engine = new RescueEngine({ out: output, mdb: db, session: msg.session, maxVersions: Number(msg.maxVersions) || 0 });
      for (const type of ['stats', 'rs-plan', 'rs-progress', 'rs-done', 'rs-skip', 'rs-fail', 'rs-app-done', 'rs-need-id', 'dl-wait', 'dl-resume']) {
        engine.on(type, (data) => send({ type, ...data }));
      }
      engine.on('log', (text) => send({ type: 'log', text }));
      const running = engine;
      (async () => {
        try { await running.initSession(); await running.rescueAll(items); send({ type: 'done', ...running.stats }); }
        catch (e) { send({ type: 'start-err', error: e.message }); }
        finally { engine = null; }
      })();
      send({ type: 'start-ok', count: items.length });
    } else if (msg.cmd === 'stop') {
      if (engine) engine.stop();
    } else if (msg.cmd === 'state') {
      send({ type: 'running', running: !!engine });
    } else if (msg.cmd === 'quit') {
      if (engine) engine.stop();
      process.exit(0);
    }
  } catch (e) { send({ type: 'start-err', error: e.message }); }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    try { handle(JSON.parse(line)); } catch (_) { /* malformed command */ }
  }
});
