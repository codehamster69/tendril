const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// The built client is served from a privileged custom scheme, never file://.
const APP_ENTRY = 'app://tendril/index.html';

function entryURL({ devURL, packaged, smoke }) {
  let entry = new URL(APP_ENTRY);
  // A packaged app never trusts a development URL from its environment.
  if (!packaged && devURL) {
    entry = new URL(devURL);
    if (entry.protocol !== 'http:' || !LOOPBACK_HOSTS.has(entry.hostname)
      || entry.username || entry.password) {
      throw new Error('VITE_DEV_URL must be an HTTP loopback URL without credentials');
    }
  }
  if (smoke) entry.searchParams.set('mode', 'sandbox');
  return entry.href;
}

function allowsNavigation(destination, entry) {
  try {
    const url = new URL(destination);
    const allowed = new URL(entry);
    // Preserve the app's live/sandbox link on the same entry document. No
    // arbitrary query parameters, pages, schemes or neighboring files qualify.
    const modes = url.searchParams.getAll('mode');
    if (modes.length > 1 || (modes.length === 1 && !['live', 'sandbox'].includes(modes[0]))) return false;
    url.searchParams.delete('mode');
    allowed.searchParams.delete('mode');
    url.hash = '';
    allowed.hash = '';
    return url.href === allowed.href;
  } catch {
    return false;
  }
}

function hardenContents(contents, entry) {
  const guard = (event, destination) => {
    if (!allowsNavigation(destination ?? event.url, entry)) event.preventDefault();
  };
  contents.on('will-navigate', guard);
  contents.on('will-frame-navigate', guard);
  contents.on('will-redirect', guard);
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

/**
 * The only URL the desktop app may hand to the system browser: the GitHub
 * sign-in route on the configured API origin, over https, with a desktop nonce.
 */
function isAllowedExternalURL(destination, apiOrigin) {
  try {
    if (typeof destination !== 'string') return false;
    const url = new URL(destination);
    const api = new URL(apiOrigin);
    if (url.protocol !== 'https:' || api.protocol !== 'https:') return false;
    if (url.origin !== api.origin || url.username || url.password) return false;
    if (url.pathname !== '/api/auth/github' && !url.pathname.startsWith('/api/auth/github/')) return false;
    const nonces = url.searchParams.getAll('desktop');
    return nonces.length === 1 && /^[A-Za-z0-9_-]{16,128}$/.test(nonces[0]);
  } catch {
    return false;
  }
}

module.exports = { entryURL, allowsNavigation, hardenContents, isAllowedExternalURL };
