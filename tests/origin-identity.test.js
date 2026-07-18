const test = require('node:test');
const assert = require('node:assert/strict');

const utils = require('../site-utils.js');

test('Origin identity distinguishes default HTTPS from an explicit sibling port', () => {
  const standard = utils.normalizeSite({
    id: 'same-id',
    domain: 'identity.example.com',
    baseUrl: 'https://identity.example.com'
  });
  const sibling = utils.normalizeSite({
    id: 'same-id',
    domain: 'identity.example.com',
    baseUrl: 'https://identity.example.com:8443'
  });

  assert.notEqual(utils.siteIdentity(standard), utils.siteIdentity(sibling));
  assert.equal(utils.dedupeSitesByOrigin([standard, sibling]).length, 2);
  const merged = utils.mergeSites([standard], [sibling], { preferIncoming: true });
  assert.equal(merged.length, 2);
  assert.equal(new Set(merged.map((site) => site.id)).size, 2);
  assert.equal(merged.find((site) => utils.siteIdentity(site) === 'https://identity.example.com').id, 'same-id');
  assert.notEqual(merged.find((site) => utils.siteIdentity(site) === 'https://identity.example.com:8443').id, 'same-id');
});

test('a newer incoming sibling Origin cannot take ownership of an existing site id', () => {
  const existing = utils.normalizeSite({
    id: 'stable-owner',
    domain: 'owner.example.com',
    baseUrl: 'https://owner.example.com',
    updatedAt: 1
  });
  const incoming = utils.normalizeSite({
    id: 'stable-owner',
    domain: 'owner.example.com',
    baseUrl: 'https://owner.example.com:8443',
    updatedAt: 999999
  });
  const merged = utils.mergeSites([existing], [incoming], { preferIncoming: true });
  assert.equal(merged.find((site) => utils.siteIdentity(site) === 'https://owner.example.com').id, 'stable-owner');
  assert.notEqual(merged.find((site) => utils.siteIdentity(site) === 'https://owner.example.com:8443').id, 'stable-owner');
});

test('same Origin merges keys while retaining a single stable id', () => {
  const first = utils.normalizeSite({
    id: 'stable-id',
    domain: 'merge.example.com',
    baseUrl: 'https://merge.example.com',
    keys: [{ key: 'sk-merge-first-complete-12345' }]
  });
  const second = utils.normalizeSite({
    id: 'other-id',
    domain: 'merge.example.com',
    baseUrl: 'https://merge.example.com/path',
    keys: [{ key: 'sk-merge-second-complete-12345' }]
  });
  const [merged] = utils.mergeSites([first], [second], { preferIncoming: true });
  assert.equal(merged.id, 'stable-id');
  assert.deepEqual(merged.keys.map((key) => key.key).sort(), [
    'sk-merge-first-complete-12345',
    'sk-merge-second-complete-12345'
  ]);
});

test('declared domain wins over a cross-origin URL candidate', () => {
  const site = utils.normalizeSite({
    domain: 'safe.example.com',
    pageUrl: 'https://evil.example.net/private'
  });
  assert.equal(utils.siteIdentity(site), 'https://safe.example.com');
  assert.equal(site.pageUrl, 'https://safe.example.com');
});

test('raw object identity matches normalized identity when a legacy page URL carries the port', () => {
  const raw = {
    domain: 'legacy-identity.example.com',
    baseUrl: 'https://legacy-identity.example.com',
    pageUrl: 'https://legacy-identity.example.com:8443/user'
  };
  assert.equal(utils.siteIdentity(raw), 'https://legacy-identity.example.com:8443');
  assert.equal(utils.siteIdentity(raw), utils.siteIdentity(utils.normalizeSite(raw)));
});
