const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  parseArgs,
  resolveBrowsers,
  profileIsSafeToRemove
} = require('../scripts/smoke-extension.js');

test('runtime smoke reserves branded Chrome Stable for manual acceptance', () => {
  assert.throws(
    () => resolveBrowsers('chrome'),
    /Chrome Stable automation is not a release gate/
  );
  assert.throws(
    () => resolveBrowsers('all'),
    /Chrome Stable automation is not a release gate/
  );
});

test('runtime smoke accepts an explicit compatible Chromium path', () => {
  const executable = process.execPath;
  const [browser] = resolveBrowsers(executable);
  assert.equal(browser.executable, path.resolve(executable));
  assert.equal(browser.kind, path.basename(executable, path.extname(executable)));
});

test('runtime smoke argument and profile guards remain deterministic', () => {
  const options = parseArgs(['--browser=edge', '--timeout-ms=5000', '--headed']);
  assert.equal(options.browser, 'edge');
  assert.equal(options.timeoutMs, 5000);
  assert.equal(options.headed, true);
  assert.equal(profileIsSafeToRemove(path.join(require('node:os').tmpdir(),
    'public-site-hub-smoke-fixture')), true);
  assert.equal(profileIsSafeToRemove(path.resolve('public-site-hub-smoke-fixture')), false);
});
