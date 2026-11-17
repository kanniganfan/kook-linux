const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('overlayAPI', {
  onConfig: (cb) => ipcRenderer.on('OVERLAY_CONFIG', (_e, c) => cb(c)),
  onUsers: (cb) => ipcRenderer.on('OVERLAY_USERS', (_e, u) => cb(u)),
})
