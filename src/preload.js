'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 安全桥：渲染层只能调用白名单 API，无法直接 require Node。
contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('app:init'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  chooseDir: () => ipcRenderer.invoke('dialog:chooseDir'),
  chooseFile: (extensions) => ipcRenderer.invoke('dialog:chooseFile', extensions),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),

  listAccounts: () => ipcRenderer.invoke('account:list'),
  getAccount: (id) => ipcRenderer.invoke('account:get', id),
  removeAccount: (id) => ipcRenderer.invoke('account:remove', id),

  login: (p) => ipcRenderer.invoke('auth:login', p),
  switchAccount: (id) => ipcRenderer.invoke('auth:switch', id),
  logout: () => ipcRenderer.invoke('auth:logout'),

  search: (p) => ipcRenderer.invoke('store:search', p),
  lookup: (p) => ipcRenderer.invoke('store:lookup', p),
  versions: (p) => ipcRenderer.invoke('store:versions', p),
  buy: (p) => ipcRenderer.invoke('store:buy', p),
  download: (p) => ipcRenderer.invoke('store:download', p),
  batchBuy: (p) => ipcRenderer.invoke('store:batchBuy', p),
  batchDownload: (p) => ipcRenderer.invoke('store:batchDownload', p),

  onProgress: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('download:progress', fn);
    return () => ipcRenderer.removeListener('download:progress', fn);
  },
  onBatchProgress: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('batch:progress', fn);
    return () => ipcRenderer.removeListener('batch:progress', fn);
  },

  // 已购记录
  purchasesAccounts: () => ipcRenderer.invoke('purchases:accounts'),
  purchasesCursor: (p) => ipcRenderer.invoke('purchases:cursor', p),
  purchasesAppend: (p) => ipcRenderer.invoke('purchases:append', p),
  purchasesFinish: (p) => ipcRenderer.invoke('purchases:finish', p),
  purchasesState: (p) => ipcRenderer.invoke('purchases:state', p || {}),
  purchasesSave: (p) => ipcRenderer.invoke('purchases:save', p),
  purchasesSetLabel: (p) => ipcRenderer.invoke('purchases:setLabel', p),
  purchasesClear: (p) => ipcRenderer.invoke('purchases:clear', p || {}),
  purchasesExportCsv: (p) => ipcRenderer.invoke('purchases:exportCsv', p),

  // 安装软件
  libScan: (p) => ipcRenderer.invoke('lib:scan', p || {}),
  devStatus: () => ipcRenderer.invoke('dev:status'),
  devInstall: (p) => ipcRenderer.invoke('dev:install', p),
  onInstallProgress: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('install:progress', fn);
    return () => ipcRenderer.removeListener('install:progress', fn);
  },

  // 本地 IPA 备份
  bkuInit: () => ipcRenderer.invoke('bku:init'),
  bkuStart: (p) => ipcRenderer.invoke('bku:start', p || {}),
  bkuStop: () => ipcRenderer.invoke('bku:stop'),
  bkuState: () => ipcRenderer.invoke('bku:state'),
  onBkuEv: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('bku:ev', fn);
    return () => ipcRenderer.removeListener('bku:ev', fn);
  },
  rescueSend: (p) => ipcRenderer.invoke('rs:send', p),
  rescuePick: () => ipcRenderer.invoke('rs:pick'),
  onRescueEv: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('rs:ev', fn);
    return () => ipcRenderer.removeListener('rs:ev', fn);
  },
});
