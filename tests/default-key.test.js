const assert = require('node:assert/strict');
const test = require('node:test');
const utils = require('../site-utils.js');

test('automatic Key paths reject common masked token values', () => {
  for (const value of [
    'sk-**************abcd',
    'sk-••••••••••••abcd',
    'sk-............abcd',
    'sk-…abcd'
  ]) {
    assert.equal(utils.isCompleteApiKey(value), false);
  }
  assert.equal(utils.isCompleteApiKey('sk-real-0123456789abcd'), true);
});

test('ensureDefaultKeys marks first when none default', () => {
  const keys = utils.ensureDefaultKeys([
    { id: '1', name: 'a', key: 'k1', isDefault: false },
    { id: '2', name: 'b', key: 'k2', isDefault: false }
  ]);
  assert.equal(keys[0].isDefault, true);
  assert.equal(keys[1].isDefault, false);
});

test('ensureDefaultKeys keeps only one default', () => {
  const keys = utils.ensureDefaultKeys([
    { id: '1', name: 'a', key: 'k1', isDefault: true },
    { id: '2', name: 'b', key: 'k2', isDefault: true }
  ]);
  assert.equal(keys.filter((k) => k.isDefault).length, 1);
  assert.equal(keys[0].isDefault, true);
});

test('getDefaultKey prefers isDefault', () => {
  const site = utils.normalizeSite({
    domain: 'a.example.com',
    keys: [
      { name: 'old', key: 'sk-old-0123456789abcd', isDefault: false },
      { name: 'main', key: 'sk-main-0123456789abcd', isDefault: true }
    ]
  });
  assert.equal(utils.getDefaultKey(site).key, 'sk-main-0123456789abcd');
  assert.equal(utils.getDefaultKeyValue(site), 'sk-main-0123456789abcd');
});

test('getDefaultKey never falls back to a masked or incomplete value', () => {
  const site = utils.normalizeSite({
    domain: 'masked-only.example.com',
    keys: [{ name: '旧掩码', key: 'sk-**************abcd', isDefault: true }]
  });
  assert.equal(utils.getDefaultKey(site), null);
  assert.equal(utils.getDefaultKeyValue(site), '');
});

test('getDefaultKey repairs legacy masked defaults by preferring a complete stored Key', () => {
  const site = utils.normalizeSite({
    domain: 'masked.example.com',
    keys: [
      { name: '旧掩码', key: 'sk-**************abcd', isDefault: true },
      { name: '可用', key: 'sk-real-0123456789abcd', isDefault: false }
    ]
  });

  assert.equal(utils.getDefaultKeyValue(site), 'sk-real-0123456789abcd');
});

test('normalizeSite assigns default to single imported key', () => {
  const site = utils.normalizeSite({ domain: 'b.example.com', apiKey: 'sk-x' });
  assert.equal(site.keys.length, 1);
  assert.equal(site.keys[0].isDefault, true);
});
