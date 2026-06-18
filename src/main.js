const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path   = require('path');
const { spawn, execFile } = require('child_process');
const fs     = require('fs');
const net    = require('net');
const Store  = require('electron-store');

const store = new Store();

// ── Setup window ───────────────────────────────────────────────────────────
function createSetupWindow() {
  const win = new BrowserWindow({
    width:           520,
    height:          560,
    resizable:       false,
    titleBarStyle:   'hiddenInset',
    backgroundColor: '#fafaf8',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });
  win.loadFile(path.join(__dirname, 'setup.html'));
  return win;
}

function isSetupComplete() {
  return store.get('setup_done', false);
}

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
const PG_SVC_NAME = 'babyAI-postgres';

function runCmd(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout?.on('data', d => log(`[${cmd}]: ${d}`));
    p.stderr?.on('data', d => log(`[${cmd}] err: ${d}`));
    p.on('error', (e) => { log(`[${cmd}] error: ${e.message}`); resolve(1); });
    p.on('close', resolve);
  });
}

async function initPostgres() {
  if (fs.existsSync(path.join(DATA_DIR, 'PG_VERSION'))) {
    log('Postgres data dir already initialised');
    return;
  }
  if (fs.existsSync(DATA_DIR)) {
    log('Removing incomplete pgdata dir before reinit...');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  log('Initialising Postgres data directory...');
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const initdb = path.join(PG_DIR, 'bin', process.platform === 'win32' ? 'initdb.exe' : 'initdb');
  await new Promise((resolve, reject) => {
    const pgEnv = {
      ...process.env,
      PATH: `${path.join(PG_DIR, 'bin')};${path.join(PG_DIR, 'lib')};${process.env.PATH || ''}`,
    };
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
        // Write port into postgresql.conf so pg_ctl runservice picks it up
        const conf = path.join(DATA_DIR, 'postgresql.conf');
        fs.appendFileSync(conf, `\nport = ${PG_PORT}\n`);
        log(`Set port = ${PG_PORT} in postgresql.conf`);
        resolve();
      } else {
        reject(new Error(`initdb exited with code ${code}`));
      }
    });
  });
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

async function startPostgresWindows() {
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

  if (createCode === 0) {
    const cfgCode = await runCmd('sc', ['config', PG_SVC_NAME, 'obj=', 'NT AUTHORITY\\NetworkService']);
    log(`sc config NetworkService exited with code ${cfgCode}`);
    if (cfgCode !== 0) {
      const cfgCode2 = await runCmd('sc', ['config', PG_SVC_NAME, 'obj=', 'NT AUTHORITY\\LocalService']);
      log(`sc config LocalService exited with code ${cfgCode2}`);
    }

    const dacl = 'D:(A;;CCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;RPWPCR;;;WD)';
    const sdCode = await runCmd('sc', ['sdset', PG_SVC_NAME, dacl]);
    log(`sc sdset exited with code ${sdCode}`);
  }

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
      waitForPort(PG_PORT, 30000).then(resolve);
    });
    proc.on('error', () => waitForPort(PG_PORT, 30000).then(resolve));
  });
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
      DATABASE_URL:              `postgresql://postgres@localhost:${PG_PORT}/postgres`,
      PORT:                      String(BACKEND_PORT),
      HOST:                      '127.0.0.1',
      ANTHROPIC_API_KEY:         store.get('anthropic_key', ''),
      SUPABASE_URL:              'https://hnfkplodhuycahrxqxde.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhuZmtwbG9kaHV5Y2FocnhxeGRlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTQyNjI2NSwiZXhwIjoyMDk1MDAyMjY1fQ.64U7rIeS7GhpiSOdyuPcIi_iUM9T5ahfeT4ypGo0Abk',
      ENCRYPTION_KEY:            'Rs_5lb70Js44x4KGRylpKnRBZ21usGdoSKQQe1f-KMk=',
      MDB_TOOLS_DIR:             path.join(RESOURCES, 'mdbtools'),
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
      // Supabase — server-side vars not baked at build time, must be injected at runtime
      NEXT_PUBLIC_SUPABASE_URL:  'https://hnfkplodhuycahrxqxde.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhuZmtwbG9kaHV5Y2FocnhxeGRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0MjYyNjUsImV4cCI6MjA5NTAwMjI2NX0.4XdKy-0Txh7uVqKGdT9VA-Jn1PnqzuetqhfHrNSBg0s',
      SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhuZmtwbG9kaHV5Y2FocnhxeGRlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTQyNjI2NSwiZXhwIjoyMDk1MDAyMjY1fQ.64U7rIeS7GhpiSOdyuPcIi_iUM9T5ahfeT4ypGo0Abk',
      // SMTP — for confirmation emails
      SMTP_HOST: 'smtp.gmail.com',
      SMTP_PORT: '587',
      SMTP_USER: 'sales.saraldyes@gmail.com',
      SMTP_PASS: 'qdrk mvhu mazh frqq',
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
// ── IPC: setup complete ────────────────────────────────────────────────────
ipcMain.on('setup-complete', async (event, config) => {
  store.set('anthropic_key', config.anthropic_key || '');
  store.set('data_path',     config.data_path     || '');
  store.set('setup_done',    true);

  // Close setup window and boot the app
  const setupWin = BrowserWindow.fromWebContents(event.sender);
  setupWin?.close();

  createWindow();
  try {
    await installAccessDatabaseEngine();
    await startPostgres();
    await startBackend();
    await startFrontend();
    await waitAndLoad();
  } catch (err) {
    log(`Startup error: ${err}`);
    dialog.showErrorBox('Startup failed', `babyAI could not start:\n\n${err.message}\n\nCheck log: ${logFile}`);
  }
});

// ── IPC: open external URL ─────────────────────────────────────────────────
ipcMain.on('open-external', (_, url) => shell.openExternal(url));

app.whenReady().then(async () => {
  if (!isSetupComplete()) {
    // First run — show setup screen
    createSetupWindow();
    return;
  }

  // Already set up — boot straight into the app
  createWindow();
  try {
    await installAccessDatabaseEngine();
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
  if (process.platform === 'win32') {
    spawn('net', ['stop', PG_SVC_NAME], { stdio: 'ignore' });
  } else if (pgProc) {
    const pgctl = path.join(PG_DIR, 'bin', 'pg_ctl');
    execFile(pgctl, ['-D', DATA_DIR, 'stop', '-m', 'fast'], () => pgProc?.kill());
  }
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
