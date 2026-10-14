const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('goldfish', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  on: (channel, fn) => ipcRenderer.on(channel, (_e, ...args) => fn(...args)),
  pathOf: file => webUtils.getPathForFile(file),
  platform: process.platform,
})
