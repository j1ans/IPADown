'use strict';

// App Store 版本号(external_identifier/versionId)随时间单调递增。
// 下表为用户提供的「版本号阈值 → 发布时间 → 对应 iOS 世代/设备」锚点，
// 用于把任意版本号映射到大致发布时间与 iOS 世代，并计算「最佳兼容版」。
const ANCHORS = [
  { id: 17191,     date: '2008-07-02', ios: 'iOS2',    iosNum: 2,  device: 'iPhone 3G' },
  { id: 1804602,   date: '2009-06-24', ios: 'iOS3',    iosNum: 3,  device: 'iPhone 3GS' },
  { id: 1996524,   date: '2009-10-01', ios: 'iOS3',    iosNum: 3,  device: '' },
  { id: 2243141,   date: '2010-02-11', ios: 'iOS3.2',  iosNum: 3.2, device: 'iPad 1' },
  { id: 2479772,   date: '2010-04-01', ios: 'iOS3',    iosNum: 3,  device: '' },
  { id: 2694492,   date: '2010-06-15', ios: 'iOS4',    iosNum: 4,  device: 'iPhone 4' },
  { id: 3493095,   date: '2011-03-10', ios: 'iOS4.3',  iosNum: 4.3, device: 'iPad 2' },
  { id: 4375195,   date: '2011-10-12', ios: 'iOS5',    iosNum: 5,  device: 'iPhone 4s' },
  { id: 6811179,   date: '2012-03-07', ios: 'iOS5.1',  iosNum: 5.1, device: 'iPad 3' },
  { id: 10631785,  date: '2012-09-19', ios: 'iOS6',    iosNum: 6,  device: 'iPhone 5' },
  { id: 16765251,  date: '2013-09-09', ios: 'iOS7',    iosNum: 7,  device: 'iPhone 5s' },
  { id: 691954036, date: '2014-09-09', ios: 'iOS8',    iosNum: 8,  device: 'iPhone 6' },
  { id: 813149787, date: '2015-09-16', ios: 'iOS9',    iosNum: 9,  device: 'iPhone 6s' },
  { id: 818235653, date: '2016-09-08', ios: 'iOS10',   iosNum: 10, device: 'iPhone 7' },
  { id: 823376582, date: '2017-09-07', ios: 'iOS11',   iosNum: 11, device: 'iPhone 8' },
  { id: 827835179, date: '2018-09-12', ios: 'iOS12',   iosNum: 12, device: 'iPhone XS' },
  { id: 832677291, date: '2019-09-11', ios: 'iOS13',   iosNum: 13, device: 'iPhone 11' },
  { id: 837795168, date: '2020-09-16', ios: 'iOS14',   iosNum: 14, device: 'iPad Air 4' },
  { id: 838141530, date: '2020-10-13', ios: 'iOS14.1', iosNum: 14.1, device: 'iPhone 12' },
  { id: 844035757, date: '2021-09-16', ios: 'iOS15',   iosNum: 15, device: 'iPhone 13' },
  { id: 852042907, date: '2022-09-08', ios: 'iOS16',   iosNum: 16, device: 'iPhone 14' },
];

// 主要 iOS 世代锚点（每代第一个阈值），用于「最佳兼容」分桶。
const IOS_MAJORS = [
  { ios: 'iOS2', iosNum: 2, threshold: 17191 },
  { ios: 'iOS3', iosNum: 3, threshold: 1804602 },
  { ios: 'iOS4', iosNum: 4, threshold: 2694492 },
  { ios: 'iOS5', iosNum: 5, threshold: 4375195 },
  { ios: 'iOS6', iosNum: 6, threshold: 10631785 },
  { ios: 'iOS7', iosNum: 7, threshold: 16765251 },
  { ios: 'iOS8', iosNum: 8, threshold: 691954036 },
  { ios: 'iOS9', iosNum: 9, threshold: 813149787 },
  { ios: 'iOS10', iosNum: 10, threshold: 818235653 },
  { ios: 'iOS11', iosNum: 11, threshold: 823376582 },
  { ios: 'iOS12', iosNum: 12, threshold: 827835179 },
  { ios: 'iOS13', iosNum: 13, threshold: 832677291 },
  { ios: 'iOS14', iosNum: 14, threshold: 837795168 },
  { ios: 'iOS15', iosNum: 15, threshold: 844035757 },
  { ios: 'iOS16', iosNum: 16, threshold: 852042907 },
];

// 给定版本号，返回它所处的发布时间/iOS 世代（最后一个 ≤ id 的锚点）。
function eraForVersion(versionId) {
  const id = parseInt(versionId, 10);
  if (!id || isNaN(id)) return null;
  let hit = ANCHORS[0];
  for (const a of ANCHORS) {
    if (id >= a.id) hit = a; else break;
  }
  // 比最早锚点还小
  if (id < ANCHORS[0].id) return { id, date: '≤2008', ios: 'iOS1/2', iosNum: 1, device: '' };
  return { id, date: hit.date, ios: hit.ios, iosNum: hit.iosNum, device: hit.device };
}

// 一行可读标签：iOS12 · 2018-09-12 · iPhone XS
function eraLabel(versionId) {
  const e = eraForVersion(versionId);
  if (!e) return '';
  return [e.ios, e.date, e.device].filter(Boolean).join(' · ');
}

// 在一组版本号中，为「目标 iOS 主版本号 targetNum」挑最佳兼容版：
// 即发布时间仍在「下一代 iOS 阈值」之前的最新版本（最大 id）。
// 这样它是该设备/iOS 上还能装的最后一个版本。
function bestCompatibleFor(targetNum, versionIds) {
  const majorIdx = IOS_MAJORS.findIndex((m) => m.iosNum === targetNum);
  if (majorIdx < 0) return null;
  const next = IOS_MAJORS[majorIdx + 1];
  const upper = next ? next.threshold : Infinity; // 下一代阈值
  const ids = versionIds.map((v) => parseInt(v, 10)).filter((n) => n && !isNaN(n)).sort((a, b) => a - b);
  let pick = null;
  for (const id of ids) {
    if (id < upper) pick = id; else break;
  }
  // 该 iOS 世代没有任何可兼容版本（App 那时还不存在）→ 返回 null，调用方丢弃该桶
  return pick == null ? null : String(pick);
}

// 给单个版本号生成「最佳兼容」标签文本（用于文件名方括号）：如 iOS12
function compatTag(versionId) {
  const e = eraForVersion(versionId);
  return e ? e.ios : '未知';
}

// 可选目标 iOS 列表（供批量「最佳兼容」下拉）。
function iosTargets() {
  return IOS_MAJORS.map((m) => ({ num: m.iosNum, label: m.ios }));
}

module.exports = { ANCHORS, IOS_MAJORS, eraForVersion, eraLabel, bestCompatibleFor, compatTag, iosTargets };
