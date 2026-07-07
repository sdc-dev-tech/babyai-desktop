const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('backOverlay', {
  goBack: () => ipcRenderer.send('nav-go-back'),
});
