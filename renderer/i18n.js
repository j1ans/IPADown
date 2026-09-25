'use strict';
(function () {
  const en = {
    workspace: 'IPA workspace', navLogin: 'Account', navSearch: 'Discover', navDownload: 'Download IPA',
    navBatch: 'Batch jobs', navLibrary: 'Library & install', navOwned: 'Purchases', navBackup: 'IPA backup',
    navRescue: 'Rescue', navSettings: 'Settings', librarySearch: 'Search apps / App ID',
    librarySearchPlaceholder: 'Name, Bundle ID or App ID', backupTitle: 'IPA backup',
    backupIntro: 'Download owned apps in batches to a local folder.', secureSession: 'When you remember your account, the OS encrypts its credentials locally. Backup and rescue reuse your current session.',
    purchaseDb: 'Purchase SQLite database', accountEmail: 'Current account', outputDir: 'Output folder', deviceTools: 'Device tools folder (optional; searches system paths)',
    choose: 'Choose', startBackup: 'Start backup', stop: 'Stop', backupProgress: 'Backup progress',
    rescueTitle: 'Discontinued app rescue', rescueIntro: 'Extract version IDs from an old IPA or plist and try to recover earlier releases.',
    addFiles: 'Add IPA / plist', maxVersions: 'Versions per app (0 = all)', startRescue: 'Start rescue',
    rescueProgress: 'Rescue progress', scanning: 'Scanning IPA files…',
    libraryCount: '{apps} apps · {files} IPA files · {indexed} indexed this scan', noApps: 'No matching apps',
    perfectVersion: 'Perfect match', recommendedVersion: 'Recommended version', installed: 'Installed',
    otherVersions: '{count} other supported versions', backupRequired: 'Sign in and select a purchase database.',
    rescueCount: '{count} apps queued', running: 'Running…', completed: 'Completed',
  };
  const zh = {
    libraryCount: '{apps} 个应用 · {files} 个 IPA · 本次索引 {indexed} 个', noApps: '没有符合条件的应用',
    perfectVersion: '完美兼容版', recommendedVersion: '推荐版本', installed: '已安装',
    otherVersions: '下方其他可支持版本（{count}）', backupRequired: '请先登录并选择购买记录数据库。',
    rescueCount: '已加入 {count} 个应用',
    scanning: '正在扫描 IPA…', running: '运行中…', completed: '已完成', outputDir: '输出目录',
  };
  const staticEnglish = {
    '未登录': 'Not signed in', '退出': 'Sign out', 'Apple ID 登录': 'Sign in with Apple ID', '密码': 'Password',
    '二次验证码 (2FA，可空)': 'Two-factor code (optional)', '账号地区': 'Account region', '记住此账号': 'Remember this account',
    '登录': 'Sign in', '删除已存账号': 'Remove saved account',
    '说明': 'About', '搜索': 'Search', '精确查询': 'Exact lookup', '下载 IPA': 'Download IPA',
    '版本 ID（留空=最新）': 'Version ID (blank = latest)', '历史版本': 'Version history', '下载': 'Download',
    '仅购买/获取': 'Get license only', '免更新模式': 'No-update mode', '日志': 'Log',
    '批量购买 / 下载': 'Batch purchase / download', '批量下载': 'Batch download', '批量购买/获取': 'Get licenses',
    '下载模式（对列表里未写版本号的 App 生效）': 'Download mode for apps without a version ID',
    '地区（跟随账号，可改）': 'Region (can override account)', '用更新协议(SWUPD)': 'Use update protocol (SWUPD)',
    '设备': 'Device', '刷新设备': 'Refresh device', '重新扫描': 'Rescan', '筛选': 'Filter',
    '仅本机可装': 'Compatible with this device', '仅完美兼容版': 'Perfect matches only', '全部': 'All',
    '隐藏已安装': 'Hide installed', '智能全选（每App一个）': 'Select one per app', '安装选中': 'Install selected',
    '安装日志': 'Install log', '登录状态': 'Sign-in status', '登录 / 切换账号': 'Sign in / switch account',
    '账号': 'Account', '开始爬取（增量）': 'Sync purchases', '隐藏登录窗': 'Hide sign-in view',
    '全选 iOS': 'Select all iOS apps', '添加选中到批量下载': 'Add selected to batch', '导出 CSV': 'Export CSV',
    '清空此账号': 'Clear this account', '名称': 'Name', '开发者': 'Developer', '类型': 'Type',
    '地区': 'Region', '购买日期': 'Purchase date', '设置': 'Settings', '下载目录': 'Download folder',
    '选择…': 'Choose…', '打开': 'Open', '默认地区': 'Default region',
    '下载前自动尝试购买（免费 App）': 'Automatically get free apps before download',
    '默认免更新模式（softwareVersionExternalIdentifier=999888777）': 'Default no-update mode',
    '保存设置': 'Save settings',
  };
  const staticChinese = Object.fromEntries(Object.entries(staticEnglish).map(([cn, english]) => [english, cn]));
  const placeholderEnglish = {
    '关键词 / appid / 包名（如 pixiv、337248563、jp.pxv.pixiv）': 'Keyword / App ID / Bundle ID',
    '筛选：名称 / 开发者 / appid': 'Filter: name / developer / App ID', '密码': 'Password',
    '6 位验证码': '6-digit code', '如 337248563': 'e.g. 337248563', '0 = 最新': '0 = latest',
  };
  let language = localStorage.getItem('ipadown.language') || 'zh-CN';
  function t(key, params) {
    const template = ((language === 'en' ? en : zh)[key] || zh[key] || key);
    return template.replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''));
  }
  function translate() {
    document.documentElement.lang = language;
    document.querySelectorAll('[data-i18n]').forEach((element) => {
      const key = element.dataset.i18n;
      const value = language === 'en' ? en[key] : (zh[key] || element.dataset.originalText);
      if (!element.dataset.originalText) element.dataset.originalText = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim())?.textContent.trim() || '';
      if (!value) return;
      const textNode = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      if (textNode) textNode.textContent = value + ' ';
      else element.insertBefore(document.createTextNode(value + ' '), element.firstChild);
    });
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement.closest('script,style,[data-i18n]')) continue;
      const original = node.textContent.trim();
      const translated = language === 'en' ? staticEnglish[original] : staticChinese[original];
      if (translated) node.textContent = node.textContent.replace(original, translated);
    }
    document.querySelectorAll('input[placeholder]').forEach((input) => {
      const current = input.placeholder;
      if (input.dataset.i18nPlaceholder) input.placeholder = language === 'en' ? (en[input.dataset.i18nPlaceholder] || current) : '名称、Bundle ID 或 App ID';
      else input.placeholder = language === 'en' ? (placeholderEnglish[current] || current) : (Object.fromEntries(Object.entries(placeholderEnglish).map(([cn, english]) => [english, cn]))[current] || current);
    });
  }
  window.i18n = { t, get language() { return language; }, setLanguage(value) {
    language = value === 'en' ? 'en' : 'zh-CN';
    localStorage.setItem('ipadown.language', language);
    translate();
    window.dispatchEvent(new Event('languagechange'));
  } };
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('languageSelect').value = language;
    document.getElementById('languageSelect').addEventListener('change', (event) => window.i18n.setLanguage(event.target.value));
    translate();
  });
})();
