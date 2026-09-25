const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('pocketdump', {
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  chooseSourceFolder: () => ipcRenderer.invoke('choose-source-folder'),
  openSourceFolder: () => ipcRenderer.invoke('open-source-folder'),
  selectNetwork: (address) => ipcRenderer.invoke('select-network', address),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  getPcInfo: () => ipcRenderer.invoke('get-pc-info'),
  setNickname: (nickname) => ipcRenderer.invoke('set-nickname', nickname),
  getPairingInfo: () => ipcRenderer.invoke('get-pairing-info'),
  resetPairing: () => ipcRenderer.invoke('reset-pairing'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  getOutbox: () => ipcRenderer.invoke('get-outbox'),
  // Dropped files only carry their real path via webUtils in the preload.
  addOutboxFiles: (files) => ipcRenderer.invoke('add-outbox-files', Array.from(files, (f) => webUtils.getPathForFile(f))),
  chooseOutboxFiles: () => ipcRenderer.invoke('choose-outbox-files'),
  removeOutboxItem: (id) => ipcRenderer.invoke('remove-outbox-item', id),
  clearOutbox: () => ipcRenderer.invoke('clear-outbox'),
  getTexts: () => ipcRenderer.invoke('get-texts'),
  sendText: (text) => ipcRenderer.invoke('send-text', text),
  clearTexts: () => ipcRenderer.invoke('clear-texts'),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  openLink: (url) => ipcRenderer.invoke('open-link', url),
  onServerInfo: (callback) => ipcRenderer.on('server-info', (_event, info) => callback(info)),
  onFolderInfo: (callback) => ipcRenderer.on('folder-info', (_event, info) => callback(info)),
  onSourceFolderInfo: (callback) => ipcRenderer.on('source-folder-info', (_event, info) => callback(info)),
  onUploadEvent: (callback) => ipcRenderer.on('upload-event', (_event, info) => callback(info)),
  onPairingInfo: (callback) => ipcRenderer.on('pairing-info', (_event, info) => callback(info)),
  onOutboxUpdated: (callback) => ipcRenderer.on('outbox-updated', (_event, items) => callback(items)),
  onTextsUpdated: (callback) => ipcRenderer.on('texts-updated', (_event, texts) => callback(texts))
});
