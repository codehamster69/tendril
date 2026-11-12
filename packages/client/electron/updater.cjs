// Desktop updates from GitHub Releases.
//
// Windows (NSIS) and Linux AppImage builds update themselves through
// electron-updater: it reads latest.yml / latest-linux.yml from the newest
// release, downloads the installer, checks its sha512 and installs on restart.
// macOS builds are unsigned, and Squirrel.Mac refuses to apply an update that
// is not code signed, so macOS (and the .deb, which needs root to install)
// only checks the GitHub API and sends the player to the release page.
const { app, ipcMain, net, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OWNER = 'codehamster69';
const REPO = 'tendril';
const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases`;
const LATEST_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** 'install' when this build can replace itself, 'notify' when it can only point to the download, 'off' otherwise. */
function updateMode({ platform, packaged, appImage, smoke }) {
  if (!packaged || smoke) return 'off';
  if (platform === 'win32') return 'install';
  if (platform === 'linux' && appImage) return 'install';
  return 'notify';
}

/** Parses "v1.2.3" or "1.2.3"; pre-releases and anything else return null. */
function parseVersion(text) {
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(String(text ?? '').trim());
  return match ? match.slice(1).map(Number) : null;
}

/** True when `candidate` is a strictly newer release than `current`. */
function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The release page for a version on this repository, or the releases list. Never any other URL. */
function releasePageURL(version) {
  const parsed = parseVersion(version);
  return parsed ? `${RELEASES_URL}/tag/v${parsed.join('.')}` : `${RELEASES_URL}/latest`;
}

/** Reads the newest published release from a GitHub API response body. */
function latestFromAPI(body) {
  if (!body || typeof body !== 'object' || body.draft || body.prerelease) return null;
  const version = parseVersion(body.tag_name);
  return version ? version.join('.') : null;
}

/** This build's version. Unpackaged runs (electron electron/main.cjs) would otherwise report Electron's own version. */
function appVersion() {
  try {
    const { version } = require('../package.json');
    if (parseVersion(version)) return version;
  } catch { /* fall back to what Electron reports */ }
  return app.getVersion();
}

function settingsFile() {
  return path.join(app.getPath('userData'), 'update-settings.json');
}

function readSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return { auto: saved.auto !== false };
  } catch {
    return { auto: true };
  }
}

function writeSettings(settings) {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings)); } catch { /* read-only profile: keep it for this run */ }
}

/**
 * Starts update checks and answers the renderer's update requests.
 * `getWindow` returns the main window (or null); `smoke` disables all network checks.
 */
function setupUpdates({ getWindow, smoke }) {
  const mode = updateMode({ platform: process.platform, packaged: app.isPackaged, appImage: process.env.APPIMAGE, smoke });
  const settings = readSettings();
  let state = {
    version: appVersion(),
    platform: process.platform,
    mode,
    auto: settings.auto,
    status: 'idle', // idle | checking | current | available | downloading | ready | error
    latest: null,
    percent: 0,
    error: null,
    checkedAt: null,
  };
  let updater = null;
  let checking = false;

  const send = (patch) => {
    state = { ...state, ...patch };
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('tendril:update-state', state);
  };
  const fromWindow = (event) => {
    const win = getWindow();
    return Boolean(win && !win.isDestroyed() && event.sender === win.webContents);
  };

  if (mode === 'install') {
    ({ autoUpdater: updater } = require('electron-updater'));
    updater.logger = null;
    updater.autoDownload = settings.auto;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    updater.on('checking-for-update', () => send({ status: 'checking', error: null }));
    updater.on('update-not-available', () => send({ status: 'current', checkedAt: Date.now() }));
    updater.on('update-available', (info) => send({ status: updater.autoDownload ? 'downloading' : 'available', latest: info.version, percent: 0, checkedAt: Date.now() }));
    updater.on('download-progress', (progress) => send({ status: 'downloading', percent: Math.round(progress.percent ?? 0) }));
    updater.on('update-downloaded', (info) => send({ status: 'ready', latest: info.version, percent: 100 }));
    updater.on('error', (error) => send({ status: 'error', error: String(error?.message ?? error).slice(0, 200) }));
  }

  async function check() {
    if (mode === 'off' || checking || state.status === 'ready' || state.status === 'downloading') return;
    checking = true;
    try {
      if (updater) {
        await updater.checkForUpdates();
      } else {
        send({ status: 'checking', error: null });
        const response = await net.fetch(LATEST_API, { headers: { accept: 'application/vnd.github+json' } });
        if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
        const latest = latestFromAPI(await response.json());
        if (latest && isNewer(latest, state.version)) send({ status: 'available', latest, checkedAt: Date.now() });
        else send({ status: 'current', checkedAt: Date.now() });
      }
    } catch (error) {
      send({ status: 'error', error: String(error?.message ?? error).slice(0, 200) });
    } finally {
      checking = false;
    }
  }

  ipcMain.handle('tendril:update-get', (event) => (fromWindow(event) ? state : null));
  ipcMain.on('tendril:update-check', (event) => { if (fromWindow(event)) void check(); });
  ipcMain.on('tendril:update-download', (event) => {
    if (!fromWindow(event)) return;
    if (updater && state.status === 'available') {
      send({ status: 'downloading', percent: 0 });
      updater.downloadUpdate().catch((error) => send({ status: 'error', error: String(error?.message ?? error).slice(0, 200) }));
    } else if (!smoke) {
      void shell.openExternal(releasePageURL(state.latest));
    }
  });
  ipcMain.on('tendril:update-install', (event) => {
    if (fromWindow(event) && updater && state.status === 'ready') setImmediate(() => updater.quitAndInstall(true, true));
  });
  ipcMain.on('tendril:update-auto', (event, auto) => {
    if (!fromWindow(event) || typeof auto !== 'boolean') return;
    writeSettings({ auto });
    if (updater) updater.autoDownload = auto;
    send({ auto });
  });

  if (mode !== 'off') {
    setTimeout(() => void check(), FIRST_CHECK_MS).unref?.();
    setInterval(() => void check(), CHECK_EVERY_MS).unref?.();
  }
}

module.exports = { setupUpdates, updateMode, parseVersion, isNewer, releasePageURL, latestFromAPI };
