const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pocketdump', {
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  chooseSourceFolder: () => ipcRenderer.invoke('choose-source-folder'),
  openSourceFolder: () => ipcRenderer.invoke('open-source-folder'),
  selectNetwork: (address) => ipcRenderer.invoke('select-network', address),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  rebuildIndex: () => ipcRenderer.invoke('rebuild-index'),
  onServerInfo: (callback) => ipcRenderer.on('server-info', (_event, info) => callback(info)),
  onFolderInfo: (callback) => ipcRenderer.on('folder-info', (_event, info) => callback(info)),
  onSourceFolderInfo: (callback) => ipcRenderer.on('source-folder-info', (_event, info) => callback(info)),
  onUploadEvent: (callback) => ipcRenderer.on('upload-event', (_event, info) => callback(info))
});
