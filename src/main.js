const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path   = require('path');
const { spawn, execFile } = require('child_process');
const fs     = require('fs');
const Store  = require('electron-store');

const store = new Store();

// ── Ports ──────────────────────────────────────────────────────────────────
const FRONTEND_PORT = 3000;
const BACKEND_PORT  = 8000;
const PG_PORT       = 5433; // avoid clash with any existing local postgres

// ── Resource paths (works both in dev and packaged) ────────────────────────
const RESOURCES = app.isPackaged
  ? path.join(process.resourcesPath)
  : path.join(__dirname, '..', 'vendor');

const BACKEND_DIR  = path.join(RESOURCES, 'backend');
const FRONTEND_DIR = path.join(RESOURCES, 'frontend');
const PG_DIR       = path.join(RESOURCES, 'postgres');
const DATA_DIR     = path.join(app.getPath('userData'), 'pgdata');

// ── Process handles ────────────────────────────────────────────────────────
let pgProc       = null;
let backendProc  = null;
let frontendProc = null;
let mainWindow   = null;

// ── Logging ────────────────────────────────────────────────────────────────
const logFile = path.join(app.getPath('userData'), 'babyai.log');
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(logFile, line);
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

  // Show loading screen first
  mainWindow.loadFile(path.join(__dirname, 'loading.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

// ── Init Postgres data directory ───────────────────────────────────────────
async function initPostgres() {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(path.join(DATA_DIR, 'PG_VERSION'))) {
      log('Postgres data dir already initialised');
      return resolve();
    }

    log('Initialising Postgres data directory...');
    fs.mkdirSync(DATA_DIR, { recursive: true });

    const initdb = path.join(PG_DIR, 'bin', process.platform === 'win32' ? 'initdb.exe' : 'initdb');
    const proc   = execFile(initdb, ['-D', DATA_DIR, '-U', 'postgres', '--auth=trust', '--encoding=UTF8'], (err) => {
      if (err) { log(`initdb error: ${err.message}`); return reject(err); }
      log('Postgres data directory initialised');
      resolve();
    });
    proc.stdout?.on('data', d => log(`initdb: ${d}`));
    proc.stderr?.on('data', d => log(`initdb err: ${d}`));
  });
}

// ── Start Postgres ─────────────────────────────────────────────────────────
async function startPostgres() {
  await initPostgres();
  return new Promise((resolve, reject) => {
    log(`Starting Postgres on port ${PG_PORT}...`);
    const pg = path.join(PG_DIR, 'bin', process.platform === 'win32' ? 'postgres.exe' : 'postgres');
    pgProc = spawn(pg, ['-D', DATA_DIR, '-p', String(PG_PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });

    pgProc.stdout.on('data', d => log(`pg: ${d}`));
    pgProc.stderr.on('data', d => {
      const s = d.toString();
      log(`pg: ${s}`);
      if (s.includes('database system is ready')) resolve();
    });
    pgProc.on('error', reject);

    // Timeout fallback — postgres usually starts in <3s
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
      DATABASE_URL: `postgresql://postgres@localhost:${PG_PORT}/postgres`,
      PORT:         String(BACKEND_PORT),
      HOST:         '127.0.0.1',
    };

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
    backendProc.on('error', reject);

    setTimeout(resolve, 8000);
  });
}

// ── Start Next.js frontend ─────────────────────────────────────────────────
async function startFrontend() {
  return new Promise((resolve, reject) => {
    log('Starting Next.js frontend...');

    const node = process.platform === 'win32' ? 'node.exe' : 'node';
    const env  = {
      ...process.env,
      PORT:                   String(FRONTEND_PORT),
      NEXT_PUBLIC_API_URL:    `http://127.0.0.1:${BACKEND_PORT}`,
      HOSTNAME:               '127.0.0.1',
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

  log(`Loading app at http://localhost:${FRONTEND_PORT}`);
  mainWindow.loadURL(`http://localhost:${FRONTEND_PORT}`);
}

// ── App lifecycle ──────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  createWindow();

  try {
    await startPostgres();
    await startBackend();
    await startFrontend();
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

app.on('before-quit', () => {
  log('Shutting down services...');
  frontendProc?.kill();
  backendProc?.kill();
  if (pgProc) {
    const pgctl = path.join(PG_DIR, 'bin', process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl');
    execFile(pgctl, ['-D', DATA_DIR, 'stop', '-m', 'fast'], () => {
      pgProc?.kill();
    });
  }
});

// ── IPC: open log file location ────────────────────────────────────────────
ipcMain.on('open-log', () => shell.showItemInFolder(logFile));
