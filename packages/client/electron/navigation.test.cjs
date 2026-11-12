const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { entryURL, allowsNavigation, hardenContents } = require('./navigation.cjs');

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
  for (const destination of [file, `${file}?mode=live`, `${file}?mode=sandbox`]) {
    assert.equal(allowsNavigation(destination, sandbox), true);
  }
  for (const destination of [
    `${file}?mode=evil`, `${file}?mode=sandbox&mode=live`, `${file}?arbitrary=true`,
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
