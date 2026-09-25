'use strict';
(function () {
  const el = (id) => document.getElementById(id);
  const addLog = (line) => {
    const box = el('backupLog');
    box.textContent += `${new Date().toLocaleTimeString()}  ${line}\n`;
    box.scrollTop = box.scrollHeight;
  };
  let ready = false;
  document.querySelector('[data-tab="backup"]').addEventListener('click', async () => {
    if (ready) return;
    ready = true;
    const result = await window.api.bkuInit();
    el('backupOutput').value = result.out;
    const info = await window.api.init();
    el('backupEmail').value = info.account?.appleId || '';
    window.api.bkuState();
  });
  el('backupDbPick').addEventListener('click', async () => { el('backupDb').value = await window.api.chooseFile(['sqlite', 'db']); });
  el('backupStart').addEventListener('click', async () => {
    const info = await window.api.init();
    const opts = { dbPath: el('backupDb').value, email: info.account?.appleId || '' };
    el('backupEmail').value = opts.email;
    if (!opts.dbPath || !opts.email) { el('backupStatus').textContent = window.i18n.t('backupRequired'); return; }
    el('backupStart').disabled = true;
    const result = await window.api.bkuStart(opts);
    if (!result.ok) { el('backupStatus').textContent = result.error; el('backupStart').disabled = false; }
  });
  el('backupStop').addEventListener('click', () => window.api.bkuStop());
  window.api.onBkuEv((event) => {
    switch (event.type) {
      case 'init-ok': addLog(`${window.i18n.t('outputDir')}: ${event.out}`); break;
      case 'start-ok': el('backupStop').disabled = false; el('backupStatus').textContent = window.i18n.t('running'); break;
      case 'running': el('backupStart').disabled = event.running; el('backupStop').disabled = !event.running; break;
      case 'stats': el('backupStats').textContent = `${event.appsDone || 0}/${event.appsTotal || 0} apps · ${event.ok || 0} OK · ${event.bad || 0} errors`; break;
      case 'dl-progress': if (event.total) el('backupStatus').textContent = `${event.name || event.adamId} · ${Math.round(event.done / event.total * 100)}%`; break;
      case 'dl-done': addLog(`✓ ${event.name || event.adamId} ${event.bucket || ''}`); break;
      case 'dl-fail': addLog(`✕ ${event.name || event.adamId}: ${event.error || ''}`); break;
      case 'log': addLog(event.msg || ''); break;
      case 'start-err': addLog(event.error || 'Error'); el('backupStart').disabled = false; el('backupStop').disabled = true; break;
      case 'done': el('backupStart').disabled = false; el('backupStop').disabled = true; el('backupStatus').textContent = window.i18n.t('completed'); break;
    }
  });
})();
