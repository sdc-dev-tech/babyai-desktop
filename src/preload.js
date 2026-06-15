const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('babyai', {
  openLog: () => ipcRenderer.send('open-log'),
  platform: process.platform,
});
