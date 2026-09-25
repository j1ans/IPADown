'use strict';
const path = require('path');
const fs = require('fs');
const { BackupEngine } = require('./backup-engine');
const { ManifestDB } = require('./manifestdb');

const send = (event) => process.stdout.write(JSON.stringify(event) + '\n');
let engine = null;
let db = null;
let output = '';

async function handle(message) {
  try {
    if (message.cmd === 'init') {
      output = message.out;
      fs.mkdirSync(output, { recursive: true });
      db = new ManifestDB(path.join(output, 'manifest.db'));
      send({ type: 'init-ok', out: output });
    } else if (message.cmd === 'state') {
      send({ type: 'running', running: !!engine });
    } else if (message.cmd === 'start') {
      if (engine) return send({ type: 'start-err', error: '备份任务正在运行' });
      if (!db) throw new Error('请先初始化备份目录');
      const opts = message.opts || {};
      if (!opts.session?.passwordToken || !opts.dbPath || !opts.email) throw new Error('请登录并选择购买记录数据库');
      engine = new BackupEngine({ ...opts, out: output, mdb: db });
      for (const type of ['stats', 'dl-progress', 'dl-done', 'dl-skip', 'dl-fail', 'dl-wait', 'dl-resume']) {
        engine.on(type, (data) => send({ type, ...data }));
      }
      engine.on('log', (msg) => send({ type: 'log', msg }));
      engine.on('done', (data) => { send({ type: 'done', ...data }); engine = null; });
      const running = engine;
      running.start().catch((error) => { send({ type: 'start-err', error: error.message }); engine = null; });
      send({ type: 'start-ok' });
    } else if (message.cmd === 'stop') {
      if (engine) engine.stop();
    } else if (message.cmd === 'quit') {
      if (engine) engine.stop();
      process.exit(0);
    }
  } catch (error) { send({ type: 'start-err', error: error.message }); }
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
