const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('babyai', {
  openLog:          ()       => ipcRenderer.send('open-log'),
  openExternal:     (url)    => ipcRenderer.send('open-external', url),
  platform:         process.platform,
  openFolderDialog: ()       => ipcRenderer.invoke('open-folder-dialog'),
});
