'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { RUNTIME_FILES } = require('../scripts/build-extension.js');
const {
  createInstance,
  maskKey,
  publicState,
  seedToken
} = require('../scripts/rc-fixture-server.js');

test('RC fixture exposes only fake Key tails in public state', () => {
  const sessionToken = 'rc-session-test-only-value';
  const instance = createInstance({
    port: 41731,
    index: 0,
    sessionToken,
    delayMs: 100
  });
  const fullKey = instance.tokens[0].key;
  const snapshot = publicState(instance, true);
  const json = JSON.stringify(snapshot);

  assert.equal(snapshot.tokenCount, 1);
  assert.equal(snapshot.tokens[0].tail, fullKey.slice(-6));
  assert.equal(json.includes(fullKey), false);
  assert.equal(json.includes(sessionToken), false);
  assert.equal(json.includes('Authorization'), false);
  assert.match(maskKey(fullKey), /^sk-\*{12}[A-Za-z0-9_-]{6}$/);
});

test('RC fixture instances start with isolated in-memory state', () => {
  const sessionToken = 'rc-session-shared-test-value';
  const seeded = createInstance({ port: 41731, index: 0, sessionToken, delayMs: 100 });
  const empty = createInstance({ port: 41732, index: 1, sessionToken, delayMs: 200 });

  assert.equal(seeded.tokens.length, 1);
  assert.equal(empty.tokens.length, 0);
  assert.equal(seeded.apiMutations, 0);
  assert.equal(empty.apiMutations, 0);

  seedToken(empty, 'created in test');
  empty.apiMutations += 1;
  assert.equal(empty.tokens.length, 1);
  assert.equal(empty.apiMutations, 1);
  assert.equal(seeded.tokens.length, 1);
});

test('RC fixture server is excluded from the extension runtime package', () => {
  assert.equal(RUNTIME_FILES.includes('scripts/rc-fixture-server.js'), false);
  assert.equal(RUNTIME_FILES.includes('package.json'), false);
});
