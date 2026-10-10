const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path   = require('path');
const { spawn, execFile } = require('child_process');
const fs     = require('fs');
const net    = require('net');
const crypto = require('crypto');
const Store  = require('electron-store');

const store = new Store();

// ── Ports ──────────────────────────────────────────────────────────────────
// On a multi-user server (RDS/Terminal Server) each session needs its own
// ports. These are resolved to free ports at startup via assignPorts().
let FRONTEND_PORT = 3000;
let BACKEND_PORT  = 8000;
let PG_PORT       = 5433;

function findFreePort(start) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => findFreePort(start + 1).then(resolve, reject));
    server.listen(start, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const PG_STATE_FILE = path.join(app.getPath('userData'), '.pg_port');

function isPortListening(port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error',   () => { sock.destroy(); resolve(false); });
    setTimeout(() => { sock.destroy(); resolve(false); }, 500);
  });
}

function isOurPostgresRunning() {
  // pg_ctl status -D DATA_DIR exits 0 and prints "server is running" only if
  // the Postgres process was started with that exact data directory — safe even
  // on multi-user RDS where other users may have their own Postgres instances.
  return new Promise((resolve) => {
    const pgctl = path.join(PG_DIR, 'bin', process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl');
    execFile(pgctl, ['status', '-D', DATA_DIR], (err, stdout) => {
      resolve(!err && stdout.includes('server is running'));
    });
  });
}

async function assignPorts() {
  // If our Postgres from a previous (crashed/abrupt) session is still running,
  // reuse its port instead of starting a new instance on a different port.
  try {
    const saved = fs.readFileSync(PG_STATE_FILE, 'utf8').trim();
    const savedPort = parseInt(saved, 10);
    if (savedPort && await isPortListening(savedPort) && await isOurPostgresRunning()) {
      log(`Reusing existing Postgres on port ${savedPort} from previous session`);
      PG_PORT       = savedPort;
      BACKEND_PORT  = await findFreePort(8000);
      FRONTEND_PORT = await findFreePort(3000);
      log(`Ports assigned — PG: ${PG_PORT} (reused), Backend: ${BACKEND_PORT}, Frontend: ${FRONTEND_PORT}`);
      return;
    }
  } catch (_) {}

  PG_PORT       = await findFreePort(5432);
  BACKEND_PORT  = await findFreePort(8000);
  FRONTEND_PORT = await findFreePort(3000);
  fs.writeFileSync(PG_STATE_FILE, String(PG_PORT));
  log(`Ports assigned — PG: ${PG_PORT}, Backend: ${BACKEND_PORT}, Frontend: ${FRONTEND_PORT}`);
}

// ── Resource paths (works both in dev and packaged) ────────────────────────
const RESOURCES = app.isPackaged
  ? path.join(process.resourcesPath)
  : path.join(__dirname, '..', 'vendor');

const BACKEND_DIR  = path.join(RESOURCES, 'backend');
const FRONTEND_DIR = path.join(RESOURCES, 'frontend');
const PG_DIR       = path.join(RESOURCES, 'postgres');
const DATA_DIR     = path.join(app.getPath('userData'), 'pgdata');
const VC_REDIST    = path.join(RESOURCES, 'vc_redist.x64.exe');


require('dotenv').config({
  path: app.isPackaged ? path.join(RESOURCES, '.env') : path.join(__dirname, '..', '.env'),
});
const SUPABASE_URL      = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const MAIL_RELAY_SECRET = process.env.MAIL_RELAY_SECRET || '';

// ── Process handles ────────────────────────────────────────────────────────
let pgProc          = null;
let backendProc     = null;
let frontendProc    = null;
let mainWindow      = null;
let appQuitting     = false;
let backOverlayWin  = null;

// ── Logging ────────────────────────────────────────────────────────────────
// babyai.log lives in plain sight on the client's machine (userData folder)
// and can carry internal diagnostics (stack traces, file paths, setup
// details) that shouldn't be casually readable by anyone who opens it.
//
// Deliberately PUBLIC-key (not password/shared-secret) encryption: this
// constant below is safe to ship inside the app because a public key can
// only ENCRYPT, never decrypt — unlike an earlier version of this that used
// a shared password baked into a bundled .env file, which anyone with
// access to the installed app's files could read and use to decrypt their
// own log. The matching PRIVATE key lives only on the developer's own
// machine (~/.babyai-secrets/log-private-key.pem, never committed, never
// shipped) — see scripts/decrypt-log.js.
//
// Hybrid RSA+AES per line (RSA alone can't encrypt arbitrary-length data):
// a fresh random AES-256 key encrypts the line, then the AES key itself is
// RSA-encrypted with the public key below. Each line is fully independent
// (own AES key + IV) so appending never disturbs earlier entries and a
// truncated last line from a crash can't corrupt the whole file.
const LOG_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnmMM9nasdGvhgnGk9W0A
dNgDtfKIt39HINydJL5SqWYu2xmeoKmnVdhWIrRi+l0Zsm3/0oFN3j8X62Xj1Hdv
SRpGxg/qngdGxgV7YD6VEhn4A88qCYhctckIHmczE3XnfSEetswuHAuO9HE3Npof
XCCdBfLi9e7kZzrEQgxFsYeTxthTFultwQB4MfR9qT5iHnOC3j4Vqna0CWT+OiF8
z4B9aSF1jrdWFa1EaPMDE6NC4WzyUvKKqSAWs38D6Ob9CYsVrGw9VQDhfbh0roKw
HcsrhQqT5H4mv4R1esw+wq+NXlWTaYiL+cq8CetCuV0lGaUptORLNH6o10c1aNS0
/wIDAQAB
-----END PUBLIC KEY-----`;

const logFile = path.join(app.getPath('userData'), 'babyai.log');

function log(msg) {
  const line   = `[${new Date().toISOString()}] ${msg}`;
  // Encryption temporarily disabled — writing plain-text lines for now.
  // Re-enable by restoring the block below (scripts/decrypt-log.js already
  // passes plain lines through, so mixed files stay readable).
  // const aesKey = crypto.randomBytes(32);
  // const iv     = crypto.randomBytes(12);
  // const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  // const ct     = Buffer.concat([cipher.update(line, 'utf8'), cipher.final()]);
  // const tag    = cipher.getAuthTag();
  // const encAesKey = crypto.publicEncrypt(
  //   { key: LOG_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
  //   aesKey,
  // );
  // fs.appendFileSync(
  //   logFile,
  //   `${encAesKey.toString('base64')}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}\n`,
  // );
  fs.appendFileSync(logFile, `${line}\n`);
  console.log(msg);
}

// ── Create main window ─────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:           1280,
    height:          800,
    minWidth:        1024,
    minHeight:       680,
    titleBarStyle:   'hiddenInset',
    backgroundColor: '#fafaf8',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
    show: false,
  });

  // Browser-style back navigation (Alt+Left, mouse back button) — needed
  // because external pages (e.g. Google's OAuth screen) have no back button
  // of their own and the window chrome doesn't expose one either.
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.alt && input.key === 'ArrowLeft') {
      if (mainWindow.webContents.canGoBack()) mainWindow.webContents.goBack();
    }
  });
  mainWindow.webContents.on('app-command', (_event, cmd) => {
    if (cmd === 'browser-backward' && mainWindow.webContents.canGoBack()) {
      mainWindow.webContents.goBack();
    }
  });

  // The keyboard/mouse shortcuts above aren't discoverable, so a user who
  // lands on Google's OAuth email page has no visible way back into the app.
  // A small floating back button, pinned over the main window, fixes that.
  setupBackOverlay(mainWindow);

  // Rewrite hardcoded port 8000/3000 in the pre-built frontend bundle to the
  // actual dynamically-assigned ports for this session. NEXT_PUBLIC_* vars are
  // baked in at build time, so on multi-user machines (RDS) the second user's
  // frontend would otherwise hit the first user's backend on the default port.
  const { session } = require('electron');
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://localhost:*/*', 'http://127.0.0.1:*/*'] },
    (details, callback) => {
      let url = details.url;
      // Rewrite any backend port variant (8000 default, 8001 dev) to the actual assigned port
      url = url.replace(/(?:127\.0\.0\.1|localhost):800[0-9]/, `127.0.0.1:${BACKEND_PORT}`)
               .replace(/(?:127\.0\.0\.1|localhost):3000/,     `127.0.0.1:${FRONTEND_PORT}`);
      callback(url !== details.url ? { redirectURL: url } : {});
    }
  );

  // When BACKEND_PORT ≠ 8000 the redirect above is cross-origin (port change),
  // and Chromium's security rules strip the Authorization header before the
  // redirected request is sent. Restore it from the electron-store token so
  // authenticated endpoints still receive a Bearer token.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['http://127.0.0.1:*/*', 'http://localhost:*/*'] },
    (details, callback) => {
      const isBackend = details.url.includes(`127.0.0.1:${BACKEND_PORT}`) ||
                        details.url.includes(`localhost:${BACKEND_PORT}`);
      const alreadyHasAuth = Object.keys(details.requestHeaders)
        .some(k => k.toLowerCase() === 'authorization');

      if (isBackend && !alreadyHasAuth) {
        const token = _decryptToken(store.get('auth_access_token', null));
        if (token) details.requestHeaders['Authorization'] = `Bearer ${token}`;
      }
      callback({ requestHeaders: details.requestHeaders });
    }
  );

  // Show loading screen first
  mainWindow.loadFile(path.join(__dirname, 'loading.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

// ── Floating back button overlay ───────────────────────────────────────────
// A tiny always-on-top child window pinned to the main window's top-left
// corner. It shows whenever there's navigation history to go back to (i.e.
// whenever the user has been sent to an external page like Google/Supabase
// OAuth) and stays hidden while browsing the app itself.
function setupBackOverlay(win) {
  backOverlayWin = new BrowserWindow({
    width:            48,
    height:           48,
    parent:           win,
    frame:            false,
    transparent:      true,
    resizable:        false,
    movable:          false,
    minimizable:      false,
    maximizable:      false,
    focusable:        false,
    skipTaskbar:      true,
    alwaysOnTop:      true,
    hasShadow:        false,
    show:             false,
    webPreferences: {
      preload:          path.join(__dirname, 'back-overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });
  backOverlayWin.loadFile(path.join(__dirname, 'back-overlay.html'));
  backOverlayWin.setIgnoreMouseEvents(false);

  function positionOverlay() {
    if (!backOverlayWin || backOverlayWin.isDestroyed()) return;
    const bounds = win.getContentBounds();
    backOverlayWin.setBounds({ x: bounds.x + 10, y: bounds.y + 10, width: 48, height: 48 });
  }

  function isOnExternalPage() {
    try {
      const hostname = new URL(win.webContents.getURL()).hostname;
      return hostname !== 'localhost' && hostname !== '127.0.0.1';
    } catch {
      return false;
    }
  }

  function refreshVisibility() {
    if (!backOverlayWin || backOverlayWin.isDestroyed()) return;
    if (isOnExternalPage() && win.webContents.canGoBack()) {
      positionOverlay();
      backOverlayWin.showInactive();
    } else {
      backOverlayWin.hide();
    }
  }

  win.on('move', positionOverlay);
  win.on('resize', positionOverlay);
  win.webContents.on('did-navigate', refreshVisibility);
  win.webContents.on('did-navigate-in-page', refreshVisibility);
  win.webContents.on('did-finish-load', refreshVisibility);

  win.on('closed', () => {
    if (backOverlayWin && !backOverlayWin.isDestroyed()) backOverlayWin.close();
    backOverlayWin = null;
  });
}

ipcMain.on('nav-go-back', () => {
  if (mainWindow && mainWindow.webContents.canGoBack()) mainWindow.webContents.goBack();
});

// ── Communications (Email) settings ────────────────────────────────────────
// WhatsApp credentials moved to admin-managed (see babyAI-backend's
// /admin/clients/{id}/whatsapp endpoints) — an admin sets access token,
// phone number ID, admin number, and support phone up on the client's
// behalf now, so none of that is read from local settings anymore.
const COMM_SETTINGS_KEYS = [
  'email_host',
  'email_port',
  'email_user',
  'email_password',        // sensitive — stored encrypted
  'email_from',
];

function readCommSettings() {
  const ENCRYPTED_KEYS = new Set(['email_password']);
  const s = {};
  for (const key of COMM_SETTINGS_KEYS) {
    if (ENCRYPTED_KEYS.has(key)) {
      try {
        const b64 = store.get(key);
        s[key] = b64 && safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(Buffer.from(b64, 'base64'))
          : (b64 || '');
      } catch { s[key] = ''; }
    } else {
      s[key] = store.get(key, '');
    }
  }
  return s;
}

// The renderer must never receive the real access token — readCommSettings()
// returns the decrypted value for internal use only (startBackend() needs
// the real value to pass to the Python backend's env). What the Settings UI
// gets back is redacted to a blank string plus a flag saying whether one is
// already saved, so there's no way to view a previously-saved token through
// the app (Settings page, React state, or dev tools) — only overwrite it.
// The frontend bundle has NEXT_PUBLIC_API_URL baked in at build time
// (127.0.0.1:8000). When 8000 is taken the backend lands on another port
// and the onBeforeRequest rewrite redirects every API call there — but a
// cross-port redirect makes Chromium send "Origin: null", which the
// backend's CORS rejects (every preflight 400s). Handing the frontend the
// real URL up front (read synchronously by preload.js on each page load)
// lets it call the right port directly, with no redirect at all.
ipcMain.on('get-backend-url', (event) => {
  event.returnValue = `http://127.0.0.1:${BACKEND_PORT}`;
});

ipcMain.handle('get-comm-settings', () => {
  const s = readCommSettings();
  return { ...s, email_password: '', email_password_set: !!s.email_password };
});

// The backend only reads EMAIL_* from its process env once, at spawn time
// (see startBackend()) — an OS process's env can't be changed after it's
// running. So saving new comm settings has to restart just the
// backend child process for them to take effect; previously this required
// restarting the whole app (which also respawns Postgres/frontend for no
// reason). Waits for the old process to actually exit before respawning so
// the new one doesn't fail to bind BACKEND_PORT (EADDRINUSE).
function restartBackend() {
  return new Promise((resolve) => {
    if (!backendProc) { startBackend().then(resolve).catch(resolve); return; }
    const proc = backendProc;
    let settled = false;
    const onDone = () => { if (settled) return; settled = true; startBackend().then(resolve).catch(resolve); };
    proc.once('close', onDone);
    killTree(proc);
    // Fallback in case 'close' never fires (e.g. taskkill already reaped it)
    setTimeout(onDone, 5000);
  });
}

ipcMain.handle('set-comm-settings', async (_, settings) => {
  const ENCRYPTED_KEYS  = new Set(['email_password']);
  const KEEP_IF_BLANK   = new Set(['email_password']);
  for (const key of COMM_SETTINGS_KEYS) {
    const val = settings[key] ?? '';
    if (KEEP_IF_BLANK.has(key) && !val) continue;
    if (ENCRYPTED_KEYS.has(key)) {
      try {
        if (safeStorage.isEncryptionAvailable()) {
          store.set(key, safeStorage.encryptString(val).toString('base64'));
        } else {
          store.set(key, val);
        }
      } catch (e) { log(`set-comm-settings error for ${key}: ${e.message}`); }
    } else {
      store.set(key, val);
    }
  }
  await restartBackend();
  return true;
});

// ── Chat key material — stored encrypted in OS keychain via safeStorage ────
// Key is stored as a hex string so it survives the encrypt/decrypt round-trip
// through safeStorage (which works on Buffer/Uint8Array, not raw bytes).
const CHAT_KEY_STORE_KEY = 'chat_key_material';

ipcMain.handle('chat-key-store', (_, hexKey) => {
  if (!safeStorage.isEncryptionAvailable()) return false;
  try {
    const encrypted = safeStorage.encryptString(hexKey);
    store.set(CHAT_KEY_STORE_KEY, encrypted.toString('base64'));
    return true;
  } catch (e) {
    log(`chat-key-store error: ${e.message}`);
    return false;
  }
});

ipcMain.handle('chat-key-load', () => {
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const b64 = store.get(CHAT_KEY_STORE_KEY);
    if (!b64) return null;
    return safeStorage.decryptString(Buffer.from(b64, 'base64'));
  } catch (e) {
    log(`chat-key-load error: ${e.message}`);
    return null;
  }
});

// ── Auth token persistence (survives frontend port changes) ───────────────
// localStorage is tied to origin (scheme+host+port). If the frontend gets a
// different port on restart the old tokens are invisible → 401. We mirror
// them in electron-store so we can re-inject on every page load.
//
// Encrypted the same way email_password is (safeStorage,
// OS-keychain-backed) — a raw session/refresh token is a live login, worth
// the same protection as those. _decryptToken() falls back to returning the
// raw value on a decode failure so an existing install's already-stored
// PLAINTEXT token (from before this) keeps working until it's next
// overwritten by save-auth-tokens, rather than forcing every open session
// to re-login on update.
function _encryptToken(val) {
  if (!val) return val;
  return safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(val).toString('base64')
    : val;
}
function _decryptToken(raw) {
  if (!raw || !safeStorage.isEncryptionAvailable()) return raw;
  try { return safeStorage.decryptString(Buffer.from(raw, 'base64')); }
  catch { return raw; }
}

ipcMain.handle('save-auth-tokens', (_, { accessToken, refreshToken, user } = {}) => {
  if (accessToken)  store.set('auth_access_token',  _encryptToken(accessToken));
  if (refreshToken) store.set('auth_refresh_token', _encryptToken(refreshToken));
  if (user)         store.set('auth_user',          JSON.stringify(user));
  return true;
});

ipcMain.handle('load-auth-tokens', () => ({
  accessToken:  _decryptToken(store.get('auth_access_token',  null)),
  refreshToken: _decryptToken(store.get('auth_refresh_token', null)),
  user:         (() => { try { return JSON.parse(store.get('auth_user', 'null')); } catch { return null; } })(),
}));

// Synchronous version used by preload.js to inject tokens before React boots.
// ipcRenderer.sendSync() requires ipcMain.on (not ipcMain.handle).
ipcMain.on('get-auth-tokens-sync', (event) => {
  event.returnValue = {
    accessToken:  _decryptToken(store.get('auth_access_token',  null)),
    refreshToken: _decryptToken(store.get('auth_refresh_token', null)),
  };
});

ipcMain.handle('clear-auth-tokens', () => {
  store.delete('auth_access_token');
  store.delete('auth_refresh_token');
  store.delete('auth_user');
  return true;
});

ipcMain.handle('get-tour-completed', () => store.get('tour_completed', false));

ipcMain.handle('set-tour-completed', (_, completed) => {
  store.set('tour_completed', !!completed);
  return true;
});

// ── Init Postgres data directory ───────────────────────────────────────────
// Per-user service name so multiple Windows accounts on the same machine
// (RDS / fast-user-switching) each get an isolated service and don't step
// on each other's running postgres instance.
const { userInfo, totalmem } = require('os');
const _winUser     = (process.platform === 'win32' ? userInfo().username : 'local')
                       .replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20);
const PG_SVC_NAME  = `babyAI-postgres-${_winUser}`;

function runCmd(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout?.on('data', d => log(`[${cmd}]: ${d}`));
    p.stderr?.on('data', d => log(`[${cmd}] err: ${d}`));
    p.on('error', (e) => { log(`[${cmd}] error: ${e.message}`); resolve(1); });
    p.on('close', resolve);
  });
}

// Install VC++ Redistributable silently — needed by bundled Postgres DLLs on clean Windows machines
async function installVcRedist() {
  if (process.platform !== 'win32') return;
  if (!fs.existsSync(VC_REDIST)) {
    log('vc_redist.x64.exe not found — skipping');
    return;
  }
  log('Installing Visual C++ Redistributable (required by Postgres)...');
  await new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(VC_REDIST, ['/install', '/quiet', '/norestart'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      log(`vc_redist install skipped: ${e.message}`);
      return resolve();
    }
    proc.on('error', (e) => { log(`vc_redist error: ${e.message}`); resolve(); });
    proc.on('close', (code) => {
      // 0 = success, 3010 = success (reboot suggested), 1638 = already installed
      if (code === 0 || code === 3010 || code === 1638) {
        log(`VC++ Redistributable ready (code ${code})`);
      } else {
        log(`vc_redist exited with code ${code}`);
      }
      resolve();
    });
  });
}

async function runInitdb() {
  const initdb = path.join(PG_DIR, 'bin', process.platform === 'win32' ? 'initdb.exe' : 'initdb');
  const pgEnv = {
    ...process.env,
    PATH: `${path.join(PG_DIR, 'bin')};${path.join(PG_DIR, 'lib')};${process.env.PATH || ''}`,
  };
  return new Promise((resolve, reject) => {
    const proc = spawn(initdb, ['-D', DATA_DIR, '-U', 'postgres', '--auth=trust', '--encoding=UTF8'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: pgEnv,
    });
    proc.stdout?.on('data', d => log(`initdb: ${d}`));
    proc.stderr?.on('data', d => log(`initdb err: ${d}`));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        log('Postgres data directory initialised');
        setPgConfPort();
        tunePgConf();
        resolve();
      } else {
        reject(Object.assign(new Error(`initdb exited with code ${code}`), { exitCode: code }));
      }
    });
  });
}

function tunePgConf() {
  // initdb ships extremely conservative defaults (shared_buffers=128MB,
  // work_mem=4MB) regardless of the machine's real RAM — fine for a toy
  // install, but this backend runs real analytical queries (multi-CTE
  // joins, sorts, window functions over tens of thousands of rows) against
  // this same local Postgres. Confirmed live: a 4MB work_mem forced one
  // such query's heaviest join into a disk-friendly merge-join+sort
  // instead of a much faster in-memory hash join — and this isn't one
  // slow page, every page's queries pay the same tax.
  //
  // work_mem is per sort/hash operation PER CONNECTION, not a global cap,
  // so it can't just scale with RAM alone — the pool allows up to 20
  // concurrent connections (api/db.py), and switching companies mid-load
  // can roughly double how many queries are in flight at once. Sizing it
  // off total RAM without bounding for that would risk the opposite
  // failure: enough concurrent memory-hungry queries to push the OS into
  // swapping, which is worse than any single query spilling to disk.
  //
  // So this bounds the worst case explicitly: assume up to REALISTIC_CONCURRENCY
  // connections busy at once (below the hard pool max of 20, covering the
  // "switched company mid-load" burst without assuming every connection
  // is saturated simultaneously) each running a query with up to
  // OPS_PER_QUERY memory-consuming sort/hash nodes (credit-risk's CTEs are
  // the worst case we've seen), and caps total work_mem usage to WORK_MEM_BUDGET_FRACTION
  // of RAM — leaving the rest for shared_buffers, the OS, and the rest of
  // this all-in-one desktop app (Electron + Next.js + the Python backend
  // itself all run on the same machine).
  const conf = path.join(DATA_DIR, 'postgresql.conf');
  if (!fs.existsSync(conf)) return;

  const totalMb = Math.floor(totalmem() / (1024 * 1024));
  const REALISTIC_CONCURRENCY    = 12;   // see comment above — below the pool's hard max of 20
  const OPS_PER_QUERY            = 4;    // assumed concurrent sort/hash nodes per query, worst case
  const WORK_MEM_BUDGET_FRACTION = 0.25; // of total RAM, for the worst-case total across all connections

  const workMemMb = Math.min(64, Math.max(8, Math.floor(
    (totalMb * WORK_MEM_BUDGET_FRACTION) / (REALISTIC_CONCURRENCY * OPS_PER_QUERY)
  )));
  // shared_buffers is a one-time fixed allocation at Postgres startup, not
  // per-query/per-connection — safe to size independently of the work_mem
  // concurrency math above.
  const sharedBuffersMb = Math.min(1024, Math.max(128, Math.floor(totalMb * 0.15)));
  // effective_cache_size is a planner HINT (how much OS disk cache to
  // assume is available for cost estimation), not a real allocation — safe
  // to size generously.
  const effectiveCacheMb = Math.min(4096, Math.max(512, Math.floor(totalMb * 0.5)));
  // maintenance_work_mem is used for one-off operations (CREATE INDEX,
  // VACUUM, the materialized-view rebuilds a sync triggers) — these don't
  // run with the same per-request concurrency as normal queries, so this
  // can be more generous than work_mem.
  const maintenanceWorkMemMb = Math.min(256, Math.max(64, Math.floor(totalMb * 0.05)));

  const settings = {
    shared_buffers:       `${sharedBuffersMb}MB`,
    effective_cache_size: `${effectiveCacheMb}MB`,
    work_mem:             `${workMemMb}MB`,
    maintenance_work_mem: `${maintenanceWorkMemMb}MB`,
  };

  let text = fs.readFileSync(conf, 'utf8');
  for (const [key, value] of Object.entries(settings)) {
    const re = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
    text = re.test(text) ? text.replace(re, `${key} = ${value}`) : text + `\n${key} = ${value}\n`;
  }
  fs.writeFileSync(conf, text);
  log(`Tuned postgresql.conf for ${totalMb}MB host RAM: shared_buffers=${sharedBuffersMb}MB, `
    + `effective_cache_size=${effectiveCacheMb}MB, work_mem=${workMemMb}MB, `
    + `maintenance_work_mem=${maintenanceWorkMemMb}MB`);
}

function setPgConfPort() {
  // Always overwrite the port line so concurrent RDS users each get their
  // own assigned port rather than re-using a port another session holds.
  const conf = path.join(DATA_DIR, 'postgresql.conf');
  if (!fs.existsSync(conf)) return;
  let text = fs.readFileSync(conf, 'utf8');
  text = text.replace(/^\s*port\s*=.*$/m, `port = ${PG_PORT}`);
  if (!/^\s*port\s*=/m.test(text)) text += `\nport = ${PG_PORT}\n`;
  fs.writeFileSync(conf, text);
  log(`Set port = ${PG_PORT} in postgresql.conf`);
}

async function getPgBinaryMajorVersion() {
  const postgres = path.join(PG_DIR, 'bin', process.platform === 'win32' ? 'postgres.exe' : 'postgres');
  return new Promise((resolve) => {
    let out = '';
    const proc = spawn(postgres, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    proc.stdout?.on('data', d => { out += d.toString(); });
    proc.on('close', () => {
      // e.g. "postgres (PostgreSQL) 16.2"
      const m = out.match(/(\d+)\.\d/);
      resolve(m ? parseInt(m[1], 10) : null);
    });
    proc.on('error', () => resolve(null));
  });
}

async function initPostgres() {
  if (fs.existsSync(path.join(DATA_DIR, 'PG_VERSION'))) {
    log('Postgres data dir already initialised');

    // Check for version mismatch — a new install may bundle a different PG major
    // version than the one that created the existing data directory.
    const dataDirVersion = parseInt(fs.readFileSync(path.join(DATA_DIR, 'PG_VERSION'), 'utf8').trim(), 10);
    const binaryVersion  = await getPgBinaryMajorVersion();
    log(`PG version check — data dir: ${dataDirVersion}, binary: ${binaryVersion}`);

    if (binaryVersion && dataDirVersion && binaryVersion !== dataDirVersion) {
      log(`PG version mismatch (data=${dataDirVersion}, binary=${binaryVersion}) — prompting user to reset`);
      const choice = await dialog.showMessageBox({
        type:    'warning',
        title:   'Database Reset Required',
        message: `Your database was created with PostgreSQL ${dataDirVersion}, but this version of babyAI uses PostgreSQL ${binaryVersion}.`,
        detail:  'The database needs to be reset. All data will be re-synced from your source files on next sync.',
        buttons: ['Reset Database', 'Quit'],
        defaultId: 0,
        cancelId:  1,
      });
      if (choice.response === 1) { app.quit(); return; }

      log('User confirmed reset — wiping data directory...');
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
      fs.mkdirSync(DATA_DIR, { recursive: true });
      await runInitdb();
      return;
    }

    setPgConfPort();
    tunePgConf();
    return;
  }
  if (fs.existsSync(DATA_DIR)) {
    log('Removing incomplete pgdata dir before reinit...');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  log('Initialising Postgres data directory...');
  fs.mkdirSync(DATA_DIR, { recursive: true });

  try {
    await runInitdb();
  } catch (err) {
    // 3221225781 = 0xC0000005 ACCESS_VIOLATION — missing VC++ runtime DLLs
    const isVcError = err.exitCode === 3221225781 || err.exitCode === 3221225794;
    if (isVcError) {
      log('initdb crashed (likely missing VC++ runtime) — installing vc_redist and retrying...');
      await installVcRedist();
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
      fs.mkdirSync(DATA_DIR, { recursive: true });
      await runInitdb();
    } else {
      throw err;
    }
  }
}

// ── Start Postgres ─────────────────────────────────────────────────────────
async function startPostgres() {
  await initPostgres();
  await grantNetworkServiceAccess();

  if (process.platform === 'win32') {
    return startPostgresWindows();
  } else {
    return startPostgresUnix();
  }
}

async function installAccessDatabaseEngine() {
  if (process.platform !== 'win32') return;
  const marker = path.join(app.getPath('userData'), '.access_engine_installed');
  if (fs.existsSync(marker)) { log('Access Database Engine already installed, skipping'); return; }

  const fetch = require('node-fetch');

  async function downloadInstaller(filename, urls) {
    const bundled = path.join(RESOURCES, filename);
    const isPlaceholder = fs.existsSync(bundled) && fs.statSync(bundled).size < 1024 * 100;
    if (fs.existsSync(bundled) && !isPlaceholder) return bundled;
    const downloadPath = path.join(app.getPath('userData'), filename);
    for (const url of urls) {
      try {
        log(`Trying: ${url}`);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.buffer();
        if (buf.length > 1024 * 1024) {
          fs.writeFileSync(downloadPath, buf);
          log(`Downloaded ${filename}: ${buf.length} bytes`);
          return downloadPath;
        }
      } catch (e) {
        log(`Download failed (${url}): ${e.message}`);
      }
    }
    return null;
  }

  // Try 64-bit first, fall back to 32-bit (needed if 32-bit Office is installed)
  let installer = await downloadInstaller('AccessDatabaseEngine_X64.exe', [
    'https://github.com/sdc-dev-tech/babyai-desktop/releases/download/resources/AccessDatabaseEngine_X64.exe',
    'https://download.microsoft.com/download/3/5/C/35C84C36-661A-44E3-BE3D-FDDE7CE6782C/accessdatabaseengine_X64.exe',
  ]);

  if (!installer) {
    log('64-bit download failed — trying 32-bit fallback...');
    installer = await downloadInstaller('AccessDatabaseEngine.exe', [
      'https://github.com/sdc-dev-tech/babyai-desktop/releases/download/resources/AccessDatabaseEngine.exe',
      'https://download.microsoft.com/download/3/5/C/35C84C36-661A-44E3-BE3D-FDDE7CE6782C/accessdatabaseengine.exe',
    ]);
  }

  if (!installer) {
    log('Could not obtain Access Database Engine installer — .bds sync may fail if driver not already installed');
    return;
  }

  log('Installing Microsoft Access Database Engine...');
  await new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(installer, ['/quiet', '/passive', '/norestart'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      log(`Access Database Engine install skipped (${e.message}) — .bds sync may fail if driver not installed`);
      return resolve();
    }
    proc.stdout?.on('data', d => log(`access-engine: ${d.toString().trim()}`));
    proc.stderr?.on('data', d => log(`access-engine err: ${d.toString().trim()}`));
    proc.on('error', (e) => {
      log(`Access Database Engine error: ${e.message} — .bds sync may fail if driver not installed`);
      resolve();
    });
    proc.on('close', (code) => {
      if (code === 0 || code === 3010) {
        log(`Access Database Engine installed (code ${code})`);
        fs.writeFileSync(marker, new Date().toISOString());
      } else {
        log(`Access Database Engine installer exited with code ${code} — may need manual install`);
      }
      resolve();
    });
  });
}

async function grantNetworkServiceAccess() {
  if (process.platform !== 'win32') return;
  log('Granting NetworkService access to postgres directories...');
  // NetworkService needs RX on the postgres binaries (pg_ctl.exe, postgres.exe, DLLs)
  // The install dir is under Administrator's AppData which NetworkService can't access by default
  await runCmd('icacls', [RESOURCES, '/grant', 'NetworkService:(OI)(CI)RX', '/T', '/Q']);
  // Full access to pgdata so postgres can write WAL, data files, lock files etc.
  await runCmd('icacls', [DATA_DIR, '/grant', 'NetworkService:(OI)(CI)F', '/T', '/Q']);
  log('NetworkService access granted');
}

async function startPostgresWindowsService() {
  const pgCtl = path.join(PG_DIR, 'bin', 'pg_ctl.exe');
  log(`pg_ctl.exe exists: ${fs.existsSync(pgCtl)}`);

  // Always stop + delete stale service so binPath stays correct for this install
  await runCmd('sc', ['stop', PG_SVC_NAME]);
  await runCmd('sc', ['delete', PG_SVC_NAME]);
  await new Promise(r => setTimeout(r, 2000)); // wait for SCM to finalise deletion

  // pg_ctl runservice handles Windows SCM protocol (SetServiceStatus etc.)
  // postgres.exe itself does NOT implement the SCM protocol — hence error 1053
  const binPath = `"${pgCtl}" runservice -N "${PG_SVC_NAME}" -D "${DATA_DIR}"`;
  log(`Creating service with binPath: ${binPath}`);

  const createCode = await runCmd('sc', [
    'create', PG_SVC_NAME,
    'binPath=', binPath,
    'start=', 'demand',
    'type=', 'own',
  ]);
  log(`sc create exited with code ${createCode}`);
  if (createCode !== 0) {
    log('sc create failed (likely not admin) — will fall back to direct spawn');
    return false;
  }

  const cfgCode = await runCmd('sc', ['config', PG_SVC_NAME, 'obj=', 'NT AUTHORITY\\NetworkService']);
  log(`sc config NetworkService exited with code ${cfgCode}`);
  if (cfgCode !== 0) {
    const cfgCode2 = await runCmd('sc', ['config', PG_SVC_NAME, 'obj=', 'NT AUTHORITY\\LocalService']);
    log(`sc config LocalService exited with code ${cfgCode2}`);
  }

  const dacl = 'D:(A;;CCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;RPWPCR;;;WD)';
  const sdCode = await runCmd('sc', ['sdset', PG_SVC_NAME, dacl]);
  log(`sc sdset exited with code ${sdCode}`);

  return new Promise((resolve) => {
    log(`Starting Postgres service ${PG_SVC_NAME}...`);
    const proc = spawn('sc', ['start', PG_SVC_NAME], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout?.on('data', d => log(`sc start: ${d}`));
    proc.stderr?.on('data', d => log(`sc start err: ${d}`));
    proc.on('close', async (code) => {
      log(`sc start exited with code ${code}`);
      if (code !== 0) {
        log('sc start failed, trying PowerShell Start-Service...');
        await runCmd('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Start-Service -Name '${PG_SVC_NAME}'`]);
      }
      // Give the service up to 20 s to bring Postgres up — pg_ctl runservice adds
      // extra latency vs direct spawn so 5 s was too tight on slower machines.
      const ready = await waitForPort(PG_PORT, 20000);
      if (ready !== false) {
        log('Service start confirmed on port');
        resolve(true);
      } else {
        log('Service started but port not responding after 20 s');
        resolve(false);
      }
    });
    proc.on('error', () => resolve(false));
  });
}

async function startPostgresWindowsDirect() {
  log('Starting Postgres directly (non-admin fallback)...');
  const pg = path.join(PG_DIR, 'bin', 'postgres.exe');
  const pgEnv2 = {
    ...process.env,
    PATH: `${path.join(PG_DIR, 'bin')};${path.join(PG_DIR, 'lib')};${process.env.PATH || ''}`,
  };
  return new Promise((resolve) => {
    pgProc = spawn(pg, ['-D', DATA_DIR, '-p', String(PG_PORT)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: pgEnv2,
    });
    pgProc.stdout?.on('data', d => log(`pg: ${d}`));
    let adminRejected = false;
    let fatalError    = false;
    pgProc.stderr?.on('data', d => {
      const s = d.toString();
      log(`pg: ${s}`);
      if (s.includes('database system is ready')) resolve();
      if (s.includes('administrative permissions')) adminRejected = true;
      // Unrecoverable errors — stop the restart loop and alert the user
      if (s.includes('incompatible with server') || s.includes('database files are incompatible') ||
          s.includes('could not open file') || s.includes('database system identifier differs')) {
        fatalError = true;
        log('postgres.exe fatal error detected — stopping restart loop');
        dialog.showMessageBox({
          type:    'error',
          title:   'Database Error',
          message: 'PostgreSQL could not start due to a database error.',
          detail:  s.trim() + '\n\nPlease reinstall babyAI or contact support.',
          buttons: ['OK'],
        });
      }
    });
    pgProc.on('error', (e) => { log(`postgres.exe spawn error: ${e.message}`); resolve(); });
    pgProc.on('close', (code) => {
      if (!appQuitting) {
        if (adminRejected) {
          // Running as Administrator — retry via the Windows service which runs
          // Postgres under NetworkService (an unprivileged account).
          log('postgres.exe rejected admin user — retrying via Windows service');
          startPostgresWindowsService()
            .then(ok => { if (!ok) log('Service retry also failed — Postgres unavailable'); })
            .catch(e => log(`Service retry error: ${e.message}`));
          return;
        }
        if (fatalError) {
          log('postgres.exe exited with fatal error — not restarting');
          return;
        }
        log(`postgres.exe exited unexpectedly (code ${code}) — restarting in 2s…`);
        setTimeout(() => startPostgresWindowsDirect().catch(e => log(`pg restart failed: ${e.message}`)), 2000);
      }
    });
    // Give it up to 10 s; resolve early if port becomes available
    waitForPort(PG_PORT, 10000).then(resolve);
  });
}

async function startPostgresWindows() {
  const serviceOk = await startPostgresWindowsService();
  if (serviceOk) return;
  log('Service approach failed — falling back to direct postgres.exe spawn');
  await startPostgresWindowsDirect();
  await waitForPort(PG_PORT, 20000);
}

function waitForPort(port, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const sock = net.createConnection({ port, host: '127.0.0.1' });
      sock.once('connect', () => { sock.destroy(); log(`Port ${port} is ready`); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() < deadline) setTimeout(attempt, 500);
        else { log(`Timed out waiting for port ${port}`); resolve(); }
      });
    }
    attempt();
  });
}

async function startPostgresUnix() {
  return new Promise((resolve, reject) => {
    log(`Starting Postgres on port ${PG_PORT}...`);
    const pg = path.join(PG_DIR, 'bin', 'postgres');
    const pgEnv2 = {
      ...process.env,
      PATH: `${path.join(PG_DIR, 'bin')};${path.join(PG_DIR, 'lib')};${process.env.PATH || ''}`,
    };
    pgProc = spawn(pg, ['-D', DATA_DIR, '-p', String(PG_PORT)], { stdio: ['ignore', 'pipe', 'pipe'], env: pgEnv2 });
    pgProc.stdout.on('data', d => log(`pg: ${d}`));
    pgProc.stderr.on('data', d => {
      const s = d.toString();
      log(`pg: ${s}`);
      if (s.includes('database system is ready')) resolve();
    });
    pgProc.on('error', reject);
    setTimeout(resolve, 5000);
  });
}

// ── Start Python backend ───────────────────────────────────────────────────
async function startBackend() {
  return new Promise((resolve, reject) => {
    log('Starting Python backend...');

    const exe = process.platform === 'win32'
      ? path.join(BACKEND_DIR, 'api.exe')
      : path.join(BACKEND_DIR, 'api');

    const env = {
      ...process.env,
      // 127.0.0.1, not 'localhost' — on Windows, resolving the literal
      // string "localhost" tries IPv6 (::1) first and times out before
      // falling back to IPv4, adding real latency to every new Postgres
      // connection. Explicit IPv4 skips that resolution step entirely.
      DATABASE_URL:              `postgresql://postgres@127.0.0.1:${PG_PORT}/postgres`,
      POSTGRES_HOST:             '127.0.0.1',
      POSTGRES_PORT:             String(PG_PORT),
      POSTGRES_DB:               'postgres',
      POSTGRES_USER:             'postgres',
      POSTGRES_PASSWORD:         '',
      PORT:                      String(BACKEND_PORT),
      HOST:                      '127.0.0.1',
      // stdout is a pipe here, so Python block-buffers print() output: sync
      // sub-steps showed up in delayed bursts and a predictions traceback was
      // lost entirely when the app was closed mid-buffer. Unbuffered writes
      // every line to babyai.log as it happens. (Model internals stay out of
      // the log regardless — see predictions._model_debug / BABYAI_MODEL_DEBUG.)
      PYTHONUNBUFFERED:          '1',
      ANTHROPIC_API_KEY:         store.get('anthropic_key', ''),
      // Public by design — same values as NEXT_PUBLIC_SUPABASE_URL/ANON_KEY
      // below, read from the local .env (see ../.env.example).
      // SUPABASE_SERVICE_ROLE_KEY deliberately does NOT appear here: the
      // backend scopes every Supabase call to the logged-in user's own JWT
      // (api/company_db.py's get_user_client()) and Row Level Security
      // enforces the boundary, instead of shipping a god-mode key to every
      // install. CHAT_USER_KEY / CONFIG_USER_KEY (chat + saved-credential
      // encryption) are absent for the same reason — both fall back to the
      // derive-chat-key / derive-config-key Edge Functions when unset, so
      // this process only ever ends up with ITS OWN user's derived key,
      // never the master secret. See api/chat_privacy.py, api/encryption.py.
      SUPABASE_URL:              SUPABASE_URL,
      SUPABASE_ANON_KEY:         SUPABASE_ANON_KEY,
      // communications_service.py sends customer emails (payment reminders,
      // invoice PDFs) through the same send-email relay app/lib/mailer.ts
      // uses for account emails, but authenticated with the logged-in
      // user's own Supabase JWT (forwarded per-request via
      // api/request_context.py) rather than a shared secret — no
      // MAIL_RELAY_SECRET needed in this process. See that function's
      // header comment.
      MDB_TOOLS_DIR:             path.join(RESOURCES, 'mdbtools'),
      // WhatsApp credentials are no longer sourced from local settings —
      // the backend fetches them per-request from Supabase, admin-assigned
      // (see babyAI-backend's api/whatsapp_config.py and
      // /admin/clients/{id}/whatsapp endpoints).
      ...((() => {
        const c = readCommSettings();
        return {
          // Email sender — when set, backend uses direct SMTP instead of relay
          ...(c.email_host && c.email_from ? {
            EMAIL_HOST:     c.email_host,
            EMAIL_PORT:     c.email_port || '587',
            EMAIL_USER:     c.email_user || c.email_from,
            EMAIL_PASSWORD: c.email_password,
            EMAIL_FROM:     c.email_from,
          } : {}),
        };
      })()),
    };

    log(`api.exe exists: ${fs.existsSync(exe)}`);
    log(`api.exe path: ${exe}`);

    backendProc = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });

    backendProc.stdout.on('data', d => {
      const s = d.toString();
      log(`api: ${s}`);
      if (s.includes('Application startup complete') || s.includes('Uvicorn running')) resolve();
    });
    backendProc.stderr.on('data', d => {
      const s = d.toString();
      log(`api err: ${s}`);
      if (s.includes('Application startup complete') || s.includes('Uvicorn running')) resolve();
    });
    backendProc.on('error', (e) => log(`api spawn error: ${e.message}`));
    backendProc.on('close', (code) => log(`api process exited with code ${code}`));

    setTimeout(resolve, 8000);
  });
}

// ── Start Next.js frontend ─────────────────────────────────────────────────
async function startFrontend() {
  return new Promise((resolve, reject) => {
    log('Starting Next.js frontend...');

    // Use the Node binary bundled alongside the app (extraResources → node/)
    // Fallback to system node if not found (dev mode)
    const bundledNode = path.join(RESOURCES, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
    const node = fs.existsSync(bundledNode) ? bundledNode : process.execPath;
    log(`Using node: ${node}`);

    const env  = {
      ...process.env,
      PORT:                      String(FRONTEND_PORT),
      NEXT_PUBLIC_API_URL:       `http://127.0.0.1:${BACKEND_PORT}`,
      HOSTNAME:                  '127.0.0.1',
      // Public confirmation-page deployment — email verification links must
      // point here (not localhost) so they work when opened from any device.
      NEXT_PUBLIC_APP_URL:       'https://baby-ai-azure.vercel.app',
      // Supabase — anon key only, safe to be public (same value ships in
      // every Supabase web app's client bundle by design). The service-role
      // key used to be here too — removed. Admin operations (signup,
      // password reset OTP) now go through the `signup` Edge Function
      // instead (see app/lib/serverAuth.ts), which holds that key as a
      // Supabase Function secret, never shipped in this desktop build.
      NEXT_PUBLIC_SUPABASE_URL:  SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: SUPABASE_ANON_KEY,
      // No SMTP_* here on purpose — app/lib/mailer.ts only sends directly
      // when SMTP_PASS is present in its own env (true on the Vercel
      // deployment). Here, with SMTP_PASS unset, it relays through the
      // `send-email` Edge Function instead, authenticated with this one
      // rotatable secret rather than the real Gmail password. See
      // babyAI-backend/supabase/functions/send-email.
      MAIL_RELAY_SECRET:        MAIL_RELAY_SECRET,
    };

    // next start via bundled node
    frontendProc = spawn(node, [path.join(FRONTEND_DIR, 'server.js')], {
      env,
      cwd: FRONTEND_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    frontendProc.stdout.on('data', d => {
      const s = d.toString();
      log(`next: ${s}`);
      if (s.includes('started server') || s.includes('Ready')) resolve();
    });
    frontendProc.stderr.on('data', d => log(`next err: ${d}`));
    frontendProc.on('error', reject);

    setTimeout(resolve, 10000);
  });
}

// ── Poll until all services are up, then load app ─────────────────────────
async function waitAndLoad() {
  const fetch = require('node-fetch');
  const MAX   = 30;

  for (let i = 0; i < MAX; i++) {
    try {
      await fetch(`http://127.0.0.1:${BACKEND_PORT}/health`);
      log('Backend health check passed');
      break;
    } catch (_) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Token injection is handled in preload.js via ipcRenderer.sendSync —
  // it runs before any page JS so getSession() sees the token on first call.
  log(`Loading app at http://localhost:${FRONTEND_PORT}/start`);
  mainWindow.loadURL(`http://localhost:${FRONTEND_PORT}/start`);
}

// ── Status updates to loading screen ──────────────────────────────────────
function sendStatus(msg, pct) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript(
        `typeof setProgress === 'function' && setProgress(${pct}, ${JSON.stringify(msg)})`
      ).catch(() => {});
    }
  } catch (_) {}
}

// ── App lifecycle ──────────────────────────────────────────────────────────
// ── IPC: open external URL ─────────────────────────────────────────────────
ipcMain.on('open-external', (_, url) => shell.openExternal(url));

app.whenReady().then(async () => {
  createWindow();
  try {
    await assignPorts();
    sendStatus('Starting database…', 10);

    // Start Postgres, frontend, and Access DB Engine in parallel — they are independent.
    // Backend must wait for Postgres, so it runs sequentially after in the same promise chain.
    const [,] = await Promise.all([
      // Chain: Postgres → Backend (backend needs DB)
      (async () => {
        await startPostgres();
        sendStatus('Starting AI engine…', 50);
        await startBackend();
        sendStatus('Almost ready…', 80);
      })(),
      // Independent: Next.js frontend
      (async () => {
        sendStatus('Starting interface…', 10);
        await startFrontend();
      })(),
      // Independent: Access DB Engine install (non-fatal)
      installAccessDatabaseEngine().catch(e => log(`ADE install warning: ${e.message}`)),
    ]);

    sendStatus('Loading app…', 95);
    await waitAndLoad();
  } catch (err) {
    log(`Startup error: ${err}`);
    dialog.showErrorBox('Startup failed', `babyAI could not start:\n\n${err.message}\n\nCheck log: ${logFile}`);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function killTree(proc) {
  if (!proc) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' });
  } else {
    proc.kill('SIGTERM');
  }
}

async function clearStaleSyncLogs() {
  try {
    // Tell the backend to mark any running sync logs as failed before we kill it
    await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/setup/clear-stale-syncs`, {
      method: 'POST', signal: AbortSignal.timeout(3000),
    });
    log('Cleared stale sync logs on quit');
  } catch (_) { /* backend may already be dead — ignore */ }
}

app.on('before-quit', (event) => {
  if (appQuitting) return;
  event.preventDefault();
  appQuitting = true;
  log('Shutting down services...');
  clearStaleSyncLogs().finally(() => {
    killTree(frontendProc);
    killTree(backendProc);
    if (process.platform === 'win32') {
      spawn('net', ['stop', PG_SVC_NAME], { stdio: 'ignore' });
    } else if (pgProc) {
      const pgctl = path.join(PG_DIR, 'bin', 'pg_ctl');
      execFile(pgctl, ['-D', DATA_DIR, 'stop', '-m', 'fast'], () => pgProc?.kill());
    }
    app.exit(0);
  });
});

// ── IPC: open log file location ────────────────────────────────────────────
ipcMain.on('open-log', () => shell.showItemInFolder(logFile));

// ── IPC: native folder picker ──────────────────────────────────────────────
ipcMain.handle('open-folder-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Buzzy Data Folder',
  });
  return result.canceled ? null : result.filePaths[0];
});
