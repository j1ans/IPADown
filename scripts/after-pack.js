'use strict';
const fs = require('fs');
const path = require('path');

// Better-sqlite3 is built for the host Node ABI. Keep the worker runtime and
// production modules outside app.asar so packaged backup/index jobs can run.
module.exports = async (context) => {
  const project = context.packager.projectDir;
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, fs.readdirSync(context.appOutDir).find((name) => name.endsWith('.app')), 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const worker = path.join(resources, 'worker');
  fs.mkdirSync(worker, { recursive: true });
  const nodeBinary = path.join(worker, process.platform === 'win32' ? 'node.exe' : 'node');
  fs.copyFileSync(process.execPath, nodeBinary);
  if (process.platform !== 'win32') fs.chmodSync(nodeBinary, 0o755);
  fs.cpSync(path.join(project, 'src'), path.join(worker, 'src'), { recursive: true });
  const lock = require(path.join(project, 'package-lock.json'));
  for (const [entry, info] of Object.entries(lock.packages)) {
    if (!entry.startsWith('node_modules/') || info.dev) continue;
    const from = path.join(project, entry);
    if (!fs.existsSync(from)) continue;
    const to = path.join(worker, entry);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
  }
};
