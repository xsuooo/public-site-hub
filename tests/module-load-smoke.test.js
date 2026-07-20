const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

const LOAD_ORDER = [
  'message-contract.js',
  'site-utils.js',
  'permissions.js',
  'site-tabs.js',
  'balance-format.js',
  'page-scrape.js',
  'tab-api-key.js',
  'balance.js',
  'import-export.js',
  'storage.js',
  'detect.js',
  'balance-refresh.js',
  'key-provision.js',
  'key-import.js'
];

test('module load order files all exist on disk', () => {
  for (const file of LOAD_ORDER) {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} should exist`);
  }
  assert.ok(fs.existsSync(path.join(root, 'background.js')));
});

test('classic script graph boots without throw and exposes core APIs', () => {
  const chrome = {
    storage: {
      local: {
        get(_keys, callback) { callback({}); },
        set(_data, callback) { callback(); }
      }
    },
    permissions: {
      contains(_details, callback) { callback(false); },
      request(_details, callback) { callback(false); }
    },
    runtime: {
      lastError: null,
      getManifest: () => ({ version: '1.0' })
    },
    scripting: {
      executeScript: async () => [{ result: { ok: false, error: 'no tab' } }]
    }
  };

  const context = vm.createContext({
    URL,
    console,
    setTimeout,
    clearTimeout,
    chrome,
    self: null
  });
  context.self = context;

  for (const file of LOAD_ORDER) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    vm.runInContext(source, context, { filename: file });
  }

  assert.equal(typeof context.ensureSiteAccess, 'function');
  assert.equal(typeof context.PublicSiteMessageContract?.validateRuntimeMessage, 'function');
  assert.equal(typeof context.countUnauthorizedSites, 'function');
  assert.equal(typeof context.ensureSiteTab, 'function');
  assert.equal(typeof context.openFailedBalanceSites, 'function');
  assert.equal(typeof context.formatBalanceValue, 'function');
  assert.equal(typeof context.classifyBalanceError, 'function');
  assert.equal(typeof context.scrapeTabBalanceAndKeys, 'function');
  assert.equal(typeof context.createTabApiKey, 'function');
  assert.equal(typeof context.fetchSiteBalance, 'function');
  assert.equal(typeof context.refreshSiteBalance, 'function');
  assert.equal(typeof context.refreshAllBalances, 'function');
  assert.equal(typeof context.stopBalanceRefresh, 'function');
  assert.equal(typeof context.retryFailedBalances, 'function');
  assert.equal(typeof context.createKeyProvisionService, 'function');
  assert.equal(typeof context.ensureSiteKey, 'function');
  assert.equal(typeof context.tryAutoImportKeys, 'function');
  assert.equal(typeof context.buildExportConfig, 'function');
  assert.equal(typeof context.normalizeSite, 'function');
  assert.equal(context.formatBalanceValue(1000000, 'quota'), '$2.00');
  assert.equal(context.classifyBalanceError('HTTP 401').code, 'not_logged_in');
});

test('background importScripts list matches the smoke load order', () => {
  const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  const block = background.match(/importScripts\(\s*([\s\S]*?)\);/);
  assert.ok(block, 'importScripts block should exist');
  const listed = [...block[1].matchAll(/['"]([^'"]+\.js)['"]/g)].map((match) => match[1]);
  assert.deepEqual(listed, LOAD_ORDER);
});
