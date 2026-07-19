const test = require('node:test');
const assert = require('node:assert/strict');

const original = {
  mutateSites: globalThis.mutateSites,
  sameSiteDomain: globalThis.sameSiteDomain,
  recordBalanceSuccess: globalThis.recordBalanceSuccess,
  recordBalanceFailure: globalThis.recordBalanceFailure,
  isBalanceRefreshAttemptCurrent: globalThis.isBalanceRefreshAttemptCurrent
};

globalThis.sameSiteDomain = (a, b) => String(a) === String(b);
globalThis.recordBalanceSuccess = (site, result) => {
  site.balance = result.balance || null;
  site.balanceUpdatedAt = 1;
};
globalThis.recordBalanceFailure = (site, error, code) => {
  site.balanceStatus = { status: 'failed', lastError: { code, message: error } };
};

const { persistBalanceResult } = require('../key-import.js');

test('balance persistence ignores untrusted page-text keys', async () => {
  let snapshot = [{ id: 'site-1', domain: 'example.com', type: 'auto', keys: [] }];
  globalThis.mutateSites = async (mutator) => {
    snapshot = await mutator(snapshot);
    return snapshot;
  };

  const result = await persistBalanceResult(snapshot[0], {
    ok: true,
    balance: '$1.00',
    keys: [{ name: '页面示例', key: 'sk-page-example-0123456789' }],
    trustedKeys: [{ name: '真实令牌', key: 'sk-trusted-0123456789' }]
  });

  assert.equal(result.keys.length, 1);
  assert.equal(result.keys[0].key, 'sk-trusted-0123456789');
});

test('balance persistence rejects a result from an old sibling port', async () => {
  const originalSite = {
    id: 'site-port',
    domain: 'port-balance.example.com',
    baseUrl: 'https://port-balance.example.com:8443',
    type: 'newapi',
    keys: []
  };
  let snapshot = [{
    ...originalSite,
    baseUrl: 'https://port-balance.example.com:9443'
  }];
  globalThis.mutateSites = async (mutator) => {
    snapshot = await mutator(snapshot);
    return snapshot;
  };

  await persistBalanceResult(originalSite, { ok: true, balance: '$8.44' });

  assert.equal(snapshot[0].balance, undefined);
  assert.equal(snapshot[0].baseUrl, 'https://port-balance.example.com:9443');
});

test('balance persistence rejects a result whose attempt was replaced', async () => {
  let snapshot = [{
    id: 'site-attempt',
    domain: 'attempt-balance.example.com',
    baseUrl: 'https://attempt-balance.example.com',
    type: 'newapi',
    keys: [],
    balance: '$new'
  }];
  globalThis.mutateSites = async (mutator) => {
    snapshot = await mutator(snapshot);
    return snapshot;
  };
  globalThis.isBalanceRefreshAttemptCurrent = async () => false;

  const result = await persistBalanceResult(snapshot[0], {
    ok: true,
    balance: '$old'
  }, { attemptId: 'attempt-old' });

  assert.equal(result, null);
  assert.equal(snapshot[0].balance, '$new');
});

test.after(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
});
