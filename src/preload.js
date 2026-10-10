const { contextBridge, ipcRenderer } = require('electron');

// ── Inject stored auth tokens before React boots ───────────────────────────
// did-finish-load fires AFTER React's useEffect, so any injection done there
// is too late — getSession() already ran against an empty localStorage.
// Preload runs synchronously before the page JS, so this is the right place.
try {
  const stored = ipcRenderer.sendSync('get-auth-tokens-sync');
  if (stored?.accessToken && !localStorage.getItem('access_token')) {
    localStorage.setItem('access_token', stored.accessToken);
    if (stored.refreshToken) localStorage.setItem('refresh_token', stored.refreshToken);
  }
} catch (_) { /* non-fatal — user will see sign-in screen */ }

// Real backend URL for this session (port can differ from the 8000 baked into
// the frontend bundle — see 'get-backend-url' in main.js). Read once per page
// load, synchronously, so api.ts can use it when it initialises.
let apiUrl = null;
try { apiUrl = ipcRenderer.sendSync('get-backend-url'); } catch (_) {}

contextBridge.exposeInMainWorld('babyai', {
  apiUrl,
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
  getTourCompleted: ()         => ipcRenderer.invoke('get-tour-completed'),
  setTourCompleted: (completed) => ipcRenderer.invoke('set-tour-completed', completed),
});
