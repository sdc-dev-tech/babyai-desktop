const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('babyai', {
  openLog:      ()       => ipcRenderer.send('open-log'),
  openExternal: (url)    => ipcRenderer.send('open-external', url),
  saveSetup:    (config) => ipcRenderer.send('setup-complete', config),
  platform:     process.platform,
});
