const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  MESSAGE_TYPES,
  MAX_ID_LENGTH,
  MAX_TEXT_BYTES,
  MAX_SITE_IDS,
  validateRuntimeMessage,
  validateRuntimeSender
} = require('../message-contract.js');

const EXPECTED_MESSAGE_TYPES = [
  'listSites',
  'getPrefs',
  'savePrefs',
  'saveCurrentTab',
  'detectSite',
  'detectAndSave',
  'batchDetectAndSave',
  'redetectSite',
  'upsertSite',
  'updateSite',
  'removeSite',
  'removeSites',
  'addKey',
  'removeKey',
  'setDefaultKey',
  'refreshBalance',
  'refreshAllBalances',
  'stopBalanceRefresh',
  'retryFailedBalances',
  'openFailedBalanceSites',
  'getBalanceRefreshProgress',
  'export',
  'requestUnauthorizedSiteAccess',
  'getOrphanedSiteAccess',
  'removeOrphanedSiteAccess',
  'getDiagnostics',
  'import',
  'previewImport',
  'getLatestSiteBackup',
  'listSiteBackups',
  'deleteSiteBackup',
  'clearSiteBackups',
  'restoreSiteBackup',
  'openUrl',
  'openTokenPage',
  'pushToCheckin',
  'retryFailedCheckin',
  'getCheckinStatus',
  'setCheckinOptIn',
  'pingCheckin',
  'formatClientSnippet',
  'ensureSiteKey',
  'importKeysFromPage'
];

test('message contract enumerates every background message exactly once', () => {
  assert.equal(MESSAGE_TYPES.length, 43);
  assert.equal(new Set(MESSAGE_TYPES).size, MESSAGE_TYPES.length);
  assert.deepEqual(MESSAGE_TYPES, EXPECTED_MESSAGE_TYPES);
  for (const type of MESSAGE_TYPES) {
    assert.equal(validateRuntimeMessage({ type }).code === 'unknown_message', false, type);
  }
});

test('message contract stays in sync with the background dispatcher', () => {
  const background = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  const dispatchedTypes = [...background.matchAll(/case '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(dispatchedTypes, MESSAGE_TYPES);
});

test('message contract rejects malformed and unknown messages', () => {
  for (const message of [null, [], 'listSites', {}, { type: 1 }]) {
    assert.equal(validateRuntimeMessage(message).code, 'invalid_message');
  }
  assert.equal(validateRuntimeMessage({ type: 'doesNotExist' }).code, 'unknown_message');
});

test('message contract enforces required clean bounded identifiers', () => {
  for (const message of [
    { type: 'removeSite' },
    { type: 'removeSite', id: '' },
    { type: 'removeSite', id: 'site\n' },
    { type: 'removeSite', id: 'x'.repeat(MAX_ID_LENGTH + 1) },
    { type: 'removeKey', siteId: 'site-1' },
    { type: 'setDefaultKey', siteId: 'site-1', keyId: '\u0000key' }
  ]) {
    assert.equal(validateRuntimeMessage(message).code, 'invalid_message');
  }
  assert.equal(validateRuntimeMessage({
    type: 'setDefaultKey', siteId: 'site-1', keyId: 'key-1'
  }).ok, true);
  assert.equal(validateRuntimeMessage({
    type: 'openTokenPage', id: 'site-1', background: true
  }).ok, true);
  assert.equal(validateRuntimeMessage({
    type: 'openTokenPage', id: 'site-1', background: 'true'
  }).code, 'invalid_message');
});

test('message contract limits identifier arrays to 1000 clean entries', () => {
  assert.equal(validateRuntimeMessage({
    type: 'refreshAllBalances',
    siteIds: Array.from({ length: MAX_SITE_IDS }, (_, index) => `site-${index}`)
  }).ok, true);
  assert.equal(validateRuntimeMessage({
    type: 'refreshAllBalances',
    siteIds: Array.from({ length: MAX_SITE_IDS + 1 }, (_, index) => `site-${index}`)
  }).code, 'invalid_message');
  assert.equal(validateRuntimeMessage({
    type: 'removeSites', ids: ['site-1', 'bad\tid']
  }).code, 'invalid_message');
});

test('message contract limits UTF-8 text and import configuration to 2 MB', () => {
  const oversized = 'x'.repeat(MAX_TEXT_BYTES + 1);
  assert.equal(validateRuntimeMessage({ type: 'import', text: oversized }).code, 'message_too_large');
  assert.equal(validateRuntimeMessage({
    type: 'previewImport', config: { payload: oversized }
  }).code, 'message_too_large');
  assert.equal(validateRuntimeMessage({
    type: 'detectSite', input: oversized
  }).code, 'message_too_large');
});

test('message contract rejects non-record and cyclic import configuration', () => {
  assert.equal(validateRuntimeMessage({ type: 'import', config: [] }).code, 'invalid_message');
  const config = {};
  config.self = config;
  assert.equal(validateRuntimeMessage({ type: 'import', config }).code, 'invalid_message');
});

test('message contract validates the runtime sender against the extension id', () => {
  assert.equal(validateRuntimeSender({ id: 'extension-id' }, 'extension-id').ok, true);
  assert.equal(validateRuntimeSender({ id: 'other-extension' }, 'extension-id').code, 'untrusted_sender');
  assert.equal(validateRuntimeSender({}, 'extension-id').code, 'untrusted_sender');
  assert.equal(validateRuntimeSender({}, '').ok, true);
});
