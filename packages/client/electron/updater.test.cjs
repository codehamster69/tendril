const assert = require('node:assert/strict');
const { test } = require('node:test');
const { updateMode, parseVersion, isNewer, releasePageURL, latestFromAPI } = require('./updater.cjs');

test('only packaged Windows and AppImage builds install updates themselves', () => {
  const base = { packaged: true, smoke: false, appImage: undefined };
  assert.equal(updateMode({ ...base, platform: 'win32' }), 'install');
  assert.equal(updateMode({ ...base, platform: 'linux', appImage: '/home/p/Tendril.AppImage' }), 'install');
  assert.equal(updateMode({ ...base, platform: 'linux' }), 'notify'); // .deb
  assert.equal(updateMode({ ...base, platform: 'darwin' }), 'notify'); // unsigned macOS
  assert.equal(updateMode({ ...base, platform: 'win32', packaged: false }), 'off');
  assert.equal(updateMode({ ...base, platform: 'win32', smoke: true }), 'off');
});

test('versions compare numerically and ignore anything that is not a plain release', () => {
  assert.deepEqual(parseVersion('v0.1.10'), [0, 1, 10]);
  assert.equal(parseVersion('0.2.0-beta.1'), null);
  assert.equal(parseVersion('latest'), null);
  assert.equal(isNewer('v0.1.10', '0.1.9'), true);
  assert.equal(isNewer('0.2.0', '0.1.99'), true);
  assert.equal(isNewer('1.0.0', '0.9.9'), true);
  assert.equal(isNewer('0.1.1', '0.1.1'), false);
  assert.equal(isNewer('0.1.0', '0.1.1'), false);
  assert.equal(isNewer('v0.3.0-rc.1', '0.1.1'), false);
  assert.equal(isNewer(undefined, '0.1.1'), false);
});

test('the release page is always on this repository', () => {
  assert.equal(releasePageURL('0.2.0'), 'https://github.com/codehamster69/tendril/releases/tag/v0.2.0');
  for (const bad of [null, '../../evil', 'https://evil.test', '1.2']) {
    assert.equal(releasePageURL(bad), 'https://github.com/codehamster69/tendril/releases/latest');
  }
});

test('the GitHub API answer yields a version only for a published release', () => {
  assert.equal(latestFromAPI({ tag_name: 'v0.2.0', draft: false, prerelease: false }), '0.2.0');
  assert.equal(latestFromAPI({ tag_name: 'v0.2.0', prerelease: true }), null);
  assert.equal(latestFromAPI({ tag_name: 'v0.2.0', draft: true }), null);
  assert.equal(latestFromAPI({ message: 'API rate limit exceeded' }), null);
  assert.equal(latestFromAPI(null), null);
});
