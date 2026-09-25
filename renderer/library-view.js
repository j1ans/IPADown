(function (root) {
  'use strict';
  function compareVersion(a, b) {
    const left = String(a || '0').split('.').map(Number);
    const right = String(b || '0').split('.').map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const diff = (left[i] || 0) - (right[i] || 0);
      if (diff) return diff;
    }
    return 0;
  }
  function compatible(rec, system) {
    return !system || !rec.minOS || compareVersion(rec.minOS, system) <= 0;
  }
  function appKey(rec) {
    return rec.appId ? 'id:' + rec.appId : rec.bundleId ? 'bundle:' + rec.bundleId.toLowerCase() : 'file:' + rec.path;
  }
  function tagSystem(rec) {
    const match = rec.tag && String(rec.tag.ios).match(/iOS(\d+)/i);
    return match ? Number(match[1]) : 0;
  }
  function perfectFor(rec, system) {
    return !!(rec && system && tagSystem(rec) === Number(String(system).split('.')[0]) && compatible(rec, system));
  }
  function buildGroups(records, system) {
    const apps = new Map();
    const idsByBundle = new Map(records.filter((r) => r.bundleId && r.appId)
      .map((r) => [r.bundleId.toLowerCase(), r.appId]));
    for (const record of records) {
      const key = record.appId ? 'id:' + record.appId
        : record.bundleId && idsByBundle.has(record.bundleId.toLowerCase())
          ? 'id:' + idsByBundle.get(record.bundleId.toLowerCase()) : appKey(record);
      if (!apps.has(key)) apps.set(key, []);
      apps.get(key).push(record);
    }
    const target = Number(String(system || '').split('.')[0]);
    const output = [];
    for (const [key, files] of apps) {
      // One IPA per app version. Prefer a tagged copy, then the larger package.
      const versions = new Map();
      for (const file of files) {
        const ver = file.version || 'file:' + file.path;
        const old = versions.get(ver);
        const score = (r) => (target && tagSystem(r) === target ? 10 : 0) + (r.tag ? 1 : 0);
        if (!old || score(file) > score(old) || (score(file) === score(old) && file.sizeMB > old.sizeMB)) versions.set(ver, file);
      }
      const unique = [...versions.values()].sort((a, b) => compareVersion(b.version, a.version) || a.path.localeCompare(b.path));
      const supported = unique.filter((r) => compatible(r, system));
      const exact = supported.filter((r) => r.tag && tagSystem(r) === target);
      const preferred = exact[0] || supported[0] || null;
      output.push({ key, app: unique[0], preferred, supported: supported.filter((r) => r !== preferred), incompatible: unique.filter((r) => !compatible(r, system)), files: unique.length });
    }
    return output.sort((a, b) => (a.app.name || '').localeCompare(b.app.name || '', 'zh'));
  }
  const api = { buildGroups, compareVersion, compatible, perfectFor, appKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.libraryView = api;
})(typeof window === 'undefined' ? globalThis : window);
