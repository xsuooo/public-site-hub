const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const { RUNTIME_FILES } = require('../scripts/build-extension.js');

function read(relativePath) {
  return fs.readFileSync(path.join(root, ...relativePath.split('/')), 'utf8');
}

test('runtime sources contain no ordinary debug logging', () => {
  const textFiles = RUNTIME_FILES.filter((file) => /\.(?:js|html|css|json)$/.test(file));
  for (const file of textFiles) {
    const source = read(file);
    assert.doesNotMatch(source, /console\.(?:log|debug|info)\s*\(/, file);
  }
});

test('retired modules and one-time split scripts stay removed', () => {
  const retiredPaths = [
    'bridge.js',
    'checkin-sync.js',
    'scripts/split-balance-format.js',
    'scripts/split-balance-refresh.js',
    'scripts/split-key-import.js',
    'scripts/split-page-scrape.js',
    'scripts/split-tab-api-key.js'
  ];
  for (const relativePath of retiredPaths) {
    assert.equal(fs.existsSync(path.join(root, ...relativePath.split('/'))), false, relativePath);
  }
});
