'use strict';
(function () {
  const el = (id) => document.getElementById(id);
  const items = [];
  const addLog = (line) => {
    const box = el('rescueLog');
    box.textContent += `${new Date().toLocaleTimeString()}  ${line}\n`;
    box.scrollTop = box.scrollHeight;
  };
  let ready = false;
  document.querySelector('[data-tab="rescue"]').addEventListener('click', () => {
    if (ready) return;
    ready = true;
    window.api.rescueSend({ cmd: 'init' });
    window.api.rescueSend({ cmd: 'state' });
  });
  el('rescueAdd').addEventListener('click', async () => {
    const paths = await window.api.rescuePick();
    if (paths.length) window.api.rescueSend({ cmd: 'analyze', paths });
  });
  el('rescueStart').addEventListener('click', async () => {
    el('rescueStart').disabled = true;
    const result = await window.api.rescueSend({ cmd: 'start', items: items.slice(), maxVersions: Number(el('rescueMax').value) || 0 });
    if (!result.ok) { el('rescueStatus').textContent = result.error; el('rescueStart').disabled = false; }
  });
  el('rescueStop').addEventListener('click', () => window.api.rescueSend({ cmd: 'stop' }));
  window.api.onRescueEv((event) => {
    switch (event.type) {
      case 'init-ok': addLog(`${window.i18n.t('outputDir')}: ${event.out}`); break;
      case 'analyzed':
        for (const item of event.items || []) {
          if (!item.ok) { addLog(`✕ ${item.path}: ${item.error}`); continue; }
          if (items.some((x) => x.adamId === item.adamId)) continue;
          items.push(item);
          const card = document.createElement('div'); card.className = 'rescue-item';
          card.textContent = `${item.name || item.adamId} · ${item.adamId} · ${(item.versionIds || []).length} versions`;
          el('rescueItems').appendChild(card);
        }
        el('rescueCount').textContent = window.i18n.t('rescueCount', { count: items.length });
        el('rescueStart').disabled = !items.length;
        break;
      case 'start-ok': el('rescueStop').disabled = false; el('rescueStatus').textContent = window.i18n.t('running'); break;
      case 'running': el('rescueStart').disabled = event.running || !items.length; el('rescueStop').disabled = !event.running; break;
      case 'stats': el('rescueStats').textContent = `${event.ok || 0} OK · ${event.bad || 0} errors · ${event.skip || 0} skipped`; break;
      case 'rs-done': addLog(`✓ ${event.name || event.adamId} ${event.vid || ''}`); break;
      case 'rs-fail': addLog(`✕ ${event.name || event.adamId}: ${event.error || ''}`); break;
      case 'rs-need-id': addLog(`${event.name || event.adamId}: ${event.error || 'App ID unavailable'}`); break;
      case 'log': addLog(event.text || event.msg || ''); break;
      case 'start-err': addLog(event.error || 'Error'); el('rescueStart').disabled = false; el('rescueStop').disabled = true; break;
      case 'done': el('rescueStart').disabled = false; el('rescueStop').disabled = true; el('rescueStatus').textContent = window.i18n.t('completed'); break;
    }
  });
})();
