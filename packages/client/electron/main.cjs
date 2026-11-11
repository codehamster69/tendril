const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');
const { statSync } = require('node:fs');
const { entryURL, hardenContents } = require('./navigation.cjs');

const smoke = process.env.TENDRIL_ELECTRON_SMOKE === '1';
app.enableSandbox();

// Only the explicit smoke flag changes mode. No renderer bridge or arbitrary
// test URL is exposed, and smoke saves never overwrite the player's profile.
if (smoke && process.env.TENDRIL_ELECTRON_SMOKE_USER_DATA) {
  const profile = process.env.TENDRIL_ELECTRON_SMOKE_USER_DATA;
  if (!path.isAbsolute(profile) || !statSync(profile).isDirectory()) {
    throw new Error('Smoke user data must be an existing absolute directory');
  }
  app.setPath('userData', profile);
}

async function createWindow() {
  const entry = entryURL({
    indexPath: path.join(__dirname, '..', 'dist', 'index.html'),
    devURL: process.env.VITE_DEV_URL,
    packaged: app.isPackaged,
    smoke,
  });
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#14171c',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  });
  hardenContents(win.webContents, entry);
  await win.loadURL(entry);
}

function failStartup(error) {
  console.error('Desktop startup failed:', error);
  app.exit(1);
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on('will-download', (event) => event.preventDefault());
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow().catch(failStartup);
  });
}).catch(failStartup);
app.on('window-all-closed', () => app.quit());
