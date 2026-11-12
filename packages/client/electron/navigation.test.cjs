const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { entryURL, allowsNavigation, hardenContents, isAllowedExternalURL } = require('./navigation.cjs');
const { DEFAULT_API_ORIGIN, apiOrigin } = require('./config.cjs');
const { readFileSync } = require('node:fs');
const nodePath = require('node:path');

const file = 'app://tendril/index.html';

function entry(options = {}) {
  return entryURL({ packaged: false, smoke: false, ...options });
}

test('production uses only the local entry, ignoring development environment', () => {
  assert.equal(entry({ packaged: true, devURL: 'https://example.com' }), file);
  assert.equal(entry(), file);
  assert.equal(entry({ smoke: true }), `${file}?mode=sandbox`);
});

test('development accepts only HTTP loopback without credentials', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    assert.equal(entry({ devURL: `http://${host}:5173/` }), `http://${host}:5173/`);
  }
  for (const devURL of [
    'https://example.com', 'http://example.com', 'http://localhost.evil.test:5173',
    'http://user:password@localhost:5173', 'file:///etc/passwd', 'javascript:alert(1)',
    'data:text/html,test', 'http://0.0.0.0:5173', 'not a URL',
  ]) {
    assert.throws(() => entry({ devURL }));
  }
  assert.equal(entry({ devURL: 'http://localhost:5173/?mode=live', smoke: true }),
    'http://localhost:5173/?mode=sandbox');
});

test('navigation allows only the entry and anchors, not neighboring local files or pages', () => {
  const sandbox = entry({ smoke: true });
  assert.equal(allowsNavigation(`${sandbox}#help`, sandbox), true);
  for (const destination of [file, `${file}?mode=live`, `${file}?mode=sandbox`, `${file}?mode=campaign`,
    `${file}?mode=daily`, `${file}?mode=live&ranked=1`, `${file}?mode=live&ranked=0`, `${file}?mode=campaign&lesson=first-crop`,
    `${file}?mode=challenge&id=d-2026-12-01`, `${file}?mode=challenge&id=s-2026-W49`, `${file}?mode=challenge&id=week`, `${file}?mode=challenge&id=x-aB3dE9xQ`, `${file}?mode=challenge&id=x-a_b-E9xQ`]) {
    assert.equal(allowsNavigation(destination, sandbox), true);
  }
  for (const destination of [
    `${file}?mode=evil`, `${file}?mode=sandbox&mode=live`, `${file}?arbitrary=true`,
    `${file}?mode=sandbox&ranked=1`, `${file}?mode=live&ranked=2`, `${file}?mode=live&ranked=1&ranked=1`,
    `${file}?mode=live&lesson=x`, `${file}?mode=campaign&lesson=../../x`, `${file}?mode=live&ranked=1&url=x`,
    `${file}?mode=challenge`, `${file}?mode=challenge&id=../x`, `${file}?mode=challenge&id=d-1&id=d-2`, `${file}?mode=live&id=d-2026-12-01`,
    `${file}?mode=challenge&id=d-1&ranked=1`, `${file}?mode=challenge&id=${'d-' + 'a'.repeat(41)}`,
    'app://tendril/package.json', 'app://other/index.html', 'file:///index.html',
    'https://example.com', 'file://remote/index.html', 'javascript:alert(1)',
    'data:text/html,test', 'about:blank', 'not a URL',
  ]) {
    assert.equal(allowsNavigation(destination, sandbox), false, destination);
  }
  const dev = entry({ devURL: 'http://localhost:5173/' });
  assert.equal(allowsNavigation(`${dev}#help`, dev), true);
  assert.equal(allowsNavigation(`${dev}?mode=sandbox`, dev), true);
  for (const destination of ['http://localhost:5174/', 'http://127.0.0.1:5173/',
    'http://localhost:5173/other', 'http://localhost:5173/?url=https://example.com']) {
    assert.equal(allowsNavigation(destination, dev), false);
  }
});

test('navigation, frames, redirects, webviews and all new windows are guarded', () => {
  const contents = new EventEmitter();
  let openWindow;
  contents.setWindowOpenHandler = (handler) => { openWindow = handler; };
  hardenContents(contents, file);
  for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
    let blocked = false;
    const event = { url: 'https://example.com', preventDefault() { blocked = true; } };
    contents.emit(name, event, event.url);
    assert.equal(blocked, true, name);
    blocked = false;
    event.url = `${file}#help`;
    contents.emit(name, event);
    assert.equal(blocked, false, name);
  }
  let blocked = false;
  contents.emit('will-attach-webview', { preventDefault() { blocked = true; } });
  assert.equal(blocked, true);
  for (const url of [file, 'https://example.com', 'javascript:alert(1)']) {
    assert.deepEqual(openWindow({ url }), { action: 'deny' });
  }
});

test('the app scheme serves only files inside the built client', () => {
  const { resolveRequest } = require('./app-protocol.cjs');
  const dist = '/srv/dist';
  assert.equal(resolveRequest(dist, 'app://tendril/'), '/srv/dist/index.html');
  assert.equal(resolveRequest(dist, 'app://tendril/assets/a.js'), '/srv/dist/assets/a.js');
  assert.equal(resolveRequest(dist, 'app://tendril/../secret'), '/srv/dist/secret'); // The URL parser already clamps dot segments.
  for (const url of ['app://tendril/..%2f..%2fetc/passwd', 'app://tendril/%2e%2e%2fsecret', 'app://other/index.html', 'file:///etc/passwd', 'nonsense']) {
    assert.equal(resolveRequest(dist, url), null, url);
  }
});

test('only the sign-in URL on the API origin may reach the system browser', () => {
  const api = 'https://tendril.hokora.xyz';
  const nonce = 'a'.repeat(48);
  assert.equal(isAllowedExternalURL(`${api}/api/auth/github?desktop=${nonce}`, api), true);
  assert.equal(isAllowedExternalURL(`${api}/api/auth/github?return=/play/&desktop=${nonce}`, api), true);
  for (const url of [
    `https://example.com/api/auth/github?desktop=${nonce}`,
    `https://tendril.hokora.xyz.evil.com/api/auth/github?desktop=${nonce}`,
    `https://evil.com/?https://tendril.hokora.xyz/api/auth/github?desktop=${nonce}`,
    `http://tendril.hokora.xyz/api/auth/github?desktop=${nonce}`,
    `https://tendril.hokora.xyz:8443/api/auth/github?desktop=${nonce}`,
    `https://user:pw@tendril.hokora.xyz/api/auth/github?desktop=${nonce}`,
    `https://tendril.hokora.xyz@evil.com/api/auth/github?desktop=${nonce}`,
    `https://tendril.hokora.xyz/api/auth/githubx?desktop=${nonce}`,
    `https://tendril.hokora.xyz/api/me?desktop=${nonce}`,
    `https://tendril.hokora.xyz/api/auth/github`,
    `https://tendril.hokora.xyz/api/auth/github?desktop=`,
    `https://tendril.hokora.xyz/api/auth/github?desktop=${nonce}&desktop=${nonce}`,
    `file:///etc/passwd`, 'javascript:alert(1)', 'data:text/html,x', 'app://tendril/index.html', 'not a URL', '', null, undefined, 42,
  ]) {
    assert.equal(isAllowedExternalURL(url, api), false, String(url));
  }
  assert.equal(isAllowedExternalURL(`${api}/api/auth/github?desktop=${nonce}`, 'http://tendril.hokora.xyz'), false);
});

test('the API origin is defined once and the renderer default matches it', () => {
  assert.equal(DEFAULT_API_ORIGIN, 'https://tendril.hokora.xyz');
  assert.equal(apiOrigin(''), DEFAULT_API_ORIGIN);
  assert.equal(apiOrigin('http://evil.test'), DEFAULT_API_ORIGIN);
  assert.equal(apiOrigin('https://staging.example.com/x'), 'https://staging.example.com');
  const renderer = readFileSync(nodePath.join(__dirname, '..', 'src', 'api-client.ts'), 'utf8');
  const match = renderer.match(/const DEFAULT_DESKTOP_API_ORIGIN = '([^']+)'/);
  assert.ok(match, 'renderer default constant not found');
  assert.equal(match[1], DEFAULT_API_ORIGIN);
  assert.ok(!renderer.includes('vercel.app'));
});
