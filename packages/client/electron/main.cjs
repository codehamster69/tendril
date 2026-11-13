const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const path = require('node:path');
const { appendFileSync, statSync } = require('node:fs');
const { entryURL, hardenContents, isAllowedExternalURL, isAllowedSiteURL } = require('./navigation.cjs');
const { apiOrigin } = require('./config.cjs');
const { registerScheme, serveApp } = require('./app-protocol.cjs');
const { setupUpdates } = require('./updater.cjs');

const smoke = process.env.TENDRIL_ELECTRON_SMOKE === '1';
app.enableSandbox();
registerScheme();

// Only the explicit smoke flag changes mode. No renderer bridge or arbitrary
// test URL is exposed, and smoke saves never overwrite the player's profile.
if (smoke && process.env.TENDRIL_ELECTRON_SMOKE_USER_DATA) {
  const profile = process.env.TENDRIL_ELECTRON_SMOKE_USER_DATA;
  if (!path.isAbsolute(profile) || !statSync(profile).isDirectory()) {
    throw new Error('Smoke user data must be an existing absolute directory');
  }
  app.setPath('userData', profile);
}

// Smoke runs record what would be opened instead of launching a browser.
function openExternal(url) {
  if (smoke) {
    const log = process.env.TENDRIL_ELECTRON_SMOKE_OPEN_LOG;
    if (log && path.isAbsolute(log)) appendFileSync(log, `${url}\n`);
    return;
  }
  void shell.openExternal(url);
}

let mainWindow = null;

async function createWindow() {
  const entry = entryURL({
    devURL: process.env.VITE_DEV_URL,
    packaged: app.isPackaged,
    smoke,
  });
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#14171c',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  });
  mainWindow = win;
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  hardenContents(win.webContents, entry);
  const origin = apiOrigin();
  const ipcHandler = (event, url) => {
    if (event.sender !== win.webContents) return;
    if (isAllowedExternalURL(url, origin) || isAllowedSiteURL(url, origin)) openExternal(url);
  };
  ipcMain.on('tendril:open-external', ipcHandler);
  win.on('closed', () => ipcMain.removeListener('tendril:open-external', ipcHandler));
  await win.loadURL(entry);
}

function failStartup(error) {
  console.error('Desktop startup failed:', error);
  app.exit(1);
}

app.whenReady().then(async () => {
  serveApp(path.join(__dirname, '..', 'dist'));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on('will-download', (event) => event.preventDefault());
  setupUpdates({ getWindow: () => mainWindow, smoke });
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow().catch(failStartup);
  });
}).catch(failStartup);
app.on('window-all-closed', () => app.quit());
