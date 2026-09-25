'use strict';
const { request } = require('./http');

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36';

async function getJSON(url) {
  const res = await request(url, { headers: { 'User-Agent': BROWSER_UA }, timeout: 30000 });
  return JSON.parse(res.body.toString('utf8'));
}

function slim(r) {
  return {
    trackId: r.trackId,
    bundleId: r.bundleId,
    name: r.trackName,
    seller: r.sellerName,
    version: r.version,
    price: r.price,
    currency: r.currency,
    icon: r.artworkUrl100 || r.artworkUrl60,
    description: r.description,
    minOS: r.minimumOsVersion,
    fileSize: r.fileSizeBytes,
    genres: r.genres,
    versionIds: r.softwareVersionExternalIdentifiers || [],
  };
}

// 按 appid 查询。
async function lookup(appId, country) {
  const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(appId)}&country=${encodeURIComponent(country)}`;
  const d = await getJSON(url);
  if (!d.resultCount) throw new Error(`未查询到 appid=${appId}（国家 ${country}）`);
  return slim(d.results[0]);
}

// 按包名查询。
async function lookupByBundle(bundleId, country) {
  const url = `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(bundleId)}&country=${encodeURIComponent(country)}`;
  const d = await getJSON(url);
  if (!d.resultCount) throw new Error(`未查询到包名=${bundleId}`);
  return slim(d.results[0]);
}

// 关键词搜索。
async function search(term, country, limit) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&country=${encodeURIComponent(country)}&entity=software&limit=${limit || 20}`;
  const d = await getJSON(url);
  return (d.results || []).map(slim);
}

// 历史版本：返回 [{id, version}]。优先官方 softwareVersionExternalIdentifiers，回退第三方。
async function versionHistory(appId, country) {
  try {
    const info = await lookup(appId, country || 'US');
    if (info.versionIds && info.versionIds.length) {
      return info.versionIds.map((id) => ({ id: String(id), version: '' }));
    }
  } catch (_) { /* ignore */ }
  try {
    const d = await getJSON('https://api.timbrd.com/apple/app-version/index.php?id=' + encodeURIComponent(appId));
    if (Array.isArray(d) && d.length) {
      return d
        .filter((x) => x && x.external_identifier != null)
        .map((x) => ({ id: String(x.external_identifier), version: x.bundle_version || '' }));
    }
  } catch (_) { /* ignore */ }
  return [];
}

module.exports = { lookup, lookupByBundle, search, versionHistory };
