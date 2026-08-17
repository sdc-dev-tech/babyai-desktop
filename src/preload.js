const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('babyai', {
  openLog:          ()         => ipcRenderer.send('open-log'),
  openExternal:     (url)      => ipcRenderer.send('open-external', url),
  platform:         process.platform,
  openFolderDialog: ()         => ipcRenderer.invoke('open-folder-dialog'),
  storeChatKey:     (hexKey)   => ipcRenderer.invoke('chat-key-store', hexKey),
  loadChatKey:      ()         => ipcRenderer.invoke('chat-key-load'),
  getCommSettings:  ()         => ipcRenderer.invoke('get-comm-settings'),
  setCommSettings:  (settings) => ipcRenderer.invoke('set-comm-settings', settings),
  saveAuthTokens:   (tokens)   => ipcRenderer.invoke('save-auth-tokens', tokens),
  loadAuthTokens:   ()         => ipcRenderer.invoke('load-auth-tokens'),
  clearAuthTokens:  ()         => ipcRenderer.invoke('clear-auth-tokens'),
});
