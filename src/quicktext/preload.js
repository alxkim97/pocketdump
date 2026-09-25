const { contextBridge, ipcRenderer } = require('electron');

// Minimal, single-purpose bridge for this popup — it only ever sends one
// piece of text and then closes, so it doesn't need the main window's
// full preload API surface.
contextBridge.exposeInMainWorld('quickText', {
  send: (text) => ipcRenderer.invoke('quick-text-send', text)
});
