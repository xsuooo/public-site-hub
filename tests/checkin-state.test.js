const assert = require('node:assert/strict');
const test = require('node:test');
const utils = require('../site-utils.js');
const storage = require('../storage.js');

test('normalizeCheckinSyncMeta normalizes persisted run metadata', () => {
  assert.deepEqual(
    storage.normalizeCheckinSyncMeta({
      lastRunAt: '100',
      requested: 4,
      sent: 2,
      verified: 1,
      failed: -3,
      skipped: 1
    }),
    {
      lastRunAt: 100,
      requested: 4,
      sent: 2,
      verified: 1,
      failed: 0,
      skipped: 1
    }
  );
});

test('normalizeCheckinSyncMeta resets invalid counters and empty lastRunAt', () => {
  assert.deepEqual(
    storage.normalizeCheckinSyncMeta({
      lastRunAt: '',
      requested: 'invalid',
      sent: -1,
      verified: null,
      failed: undefined,
      skipped: Number.NaN
    }),
    {
      lastRunAt: null,
      requested: 0,
      sent: 0,
      verified: 0,
      failed: 0,
      skipped: 0
    }
  );
});

test('normalizeCheckinSyncMeta accepts only finite nonnegative integer metadata', () => {
  assert.deepEqual(
    storage.normalizeCheckinSyncMeta({
      lastRunAt: '123.9',
      requested: Infinity,
      sent: 'Infinity',
      verified: 1.9,
      failed: '2.7'
    }),
    {
      lastRunAt: null,
      requested: 0,
      sent: 0,
      verified: 1,
      failed: 2,
      skipped: 0
    }
  );
  assert.equal(storage.normalizeCheckinSyncMeta({ lastRunAt: Infinity }).lastRunAt, null);
  assert.equal(storage.normalizeCheckinSyncMeta({ lastRunAt: -1 }).lastRunAt, null);
});

test('normalizeSite migrates legacy check-in state', () => {
  const sent = utils.normalizeSite({
    domain: 'sent.example.com',
    checkinOptIn: true,
    syncedToCheckinAt: 100
  });
  assert.equal(sent.checkinSync.status, 'sent');
  assert.equal(sent.checkinSync.lastSuccessAt, 100);

  const pending = utils.normalizeSite({ domain: 'pending.example.com', checkinOptIn: true });
  assert.equal(pending.checkinSync.status, 'pending');

  const idle = utils.normalizeSite({ domain: 'idle.example.com', syncedToCheckinAt: 100 });
  assert.equal(idle.checkinSync.status, 'idle');

  const optedOut = utils.normalizeSite({
    domain: 'history.example.com',
    checkinSync: { status: 'failed', lastAttemptAt: 50, lastError: 'timeout' }
  });
  assert.equal(optedOut.checkinSync.status, 'idle');
  assert.equal(optedOut.checkinSync.lastAttemptAt, 50);
  assert.deepEqual(optedOut.checkinSync.lastError, { code: 'unknown', message: 'timeout' });
});

test('fingerprint ignores credentials, balance and notes', () => {
  const site = {
    domain: 'fingerprint.example.com',
    name: 'Fingerprint',
    type: 'newapi',
    pageUrl: 'https://fingerprint.example.com/',
    category: 'gongyi'
  };
  assert.equal(
    utils.checkinFingerprint(site),
    utils.checkinFingerprint({ ...site, keys: [{ key: 'secret' }], balance: '10', note: 'changed' })
  );
  assert.equal(utils.normalizeCheckinError('x'.repeat(300)).message.length, 200);
});

test('fingerprint normalizes public helper inputs', () => {
  assert.equal(
    utils.checkinFingerprint({
      domain: 'HTTPS://EXAMPLE.COM/path',
      name: ' Name ',
      pageUrl: ' https://example.com/page ',
      category: '公益站'
    }),
    utils.checkinFingerprint({
      domain: 'example.com',
      name: 'Name',
      pageUrl: 'https://example.com/page',
      category: 'gongyi',
      type: 'auto'
    })
  );
});

test('verified state becomes stale only when fingerprint fields change', () => {
  const original = utils.normalizeSite({
    domain: 'verified.example.com',
    name: 'Original',
    type: 'newapi',
    category: 'gongyi',
    checkinOptIn: true
  });
  const verified = {
    ...original,
    balance: '$1.00',
    balanceUpdatedAt: 10,
    checkinSync: {
      status: 'verified',
      fingerprint: utils.checkinFingerprint(original),
      lastVerifiedAt: 10
    }
  };

  assert.equal(utils.normalizeSite({ ...verified, name: 'Changed' }).checkinSync.status, 'stale');
  assert.equal(utils.normalizeSite({ ...verified, balance: '$2.00' }).checkinSync.status, 'verified');
});

test('verified state without fingerprint is backfilled for later stale detection', () => {
  const verified = utils.normalizeSite({
    domain: 'backfill.example.com',
    name: 'Before',
    checkinOptIn: true,
    checkinSync: { status: 'verified' }
  });
  assert.equal(verified.checkinSync.fingerprint, utils.checkinFingerprint(verified));
  assert.equal(utils.normalizeSite({ ...verified, name: 'After' }).checkinSync.status, 'stale');
});

test('deriveSiteHealth prioritizes sync state and recognizes healthy sites', () => {
  const now = Date.now();
  const base = {
    domain: 'health.example.com',
    keys: [{ key: 'sk-test-complete-key', isDefault: true }],
    balance: '$1.00',
    balanceUpdatedAt: now,
    balanceStatus: { status: 'ok', lastSuccessAt: now },
    checkinOptIn: true
  };
  assert.equal(utils.deriveSiteHealth({ ...base, checkinSync: { status: 'failed' } }).level, 'failed');
  assert.equal(utils.deriveSiteHealth({ ...base, checkinSync: { status: 'pending' } }).level, 'needsAttention');
  assert.equal(utils.deriveSiteHealth({ ...base, checkinSync: { status: 'verified' } }).level, 'healthy');
});

test('balance status drives health while Key remains optional', () => {
  const now = Date.now();
  const base = {
    domain: 'balance-health.example.com',
    keys: [{ key: 'sk-test-complete-key', isDefault: true }],
    balance: '$1.00',
    balanceUpdatedAt: now,
    balanceStatus: { status: 'ok', lastSuccessAt: now }
  };
  assert.equal(utils.deriveSiteHealth({
    ...base,
    balanceStatus: { status: 'failed', lastAttemptAt: now, lastError: 'timeout' }
  }).level, 'failed');
  assert.equal(utils.deriveSiteHealth({
    ...base,
    balanceStatus: { status: 'ok', lastSuccessAt: now - utils.BALANCE_STALE_AFTER_MS - 1 }
  }).label, '余额待刷新');
  assert.equal(utils.deriveSiteHealth({
    ...base,
    keys: []
  }).level, 'healthy');
  assert.equal(utils.deriveSiteHealth({
    ...base,
    keys: [],
    balanceStatus: { status: 'idle' },
    balance: null,
    balanceUpdatedAt: null
  }).label, '需要处理');
});

test('checkinStatusMeta exposes shared labels and actions', () => {
  assert.equal(utils.checkinStatusMeta('sent').label, '已发送');
  assert.equal(utils.checkinStatusMeta('verified').label, '已同步');
  assert.equal(utils.checkinStatusMeta('failed').action, '重新同步');
});

test('filterSitesByHealth returns a copy or matching health level', () => {
  const sites = [
    { domain: 'ok.example.com', keys: [{ key: 'x' }], balance: '1', checkinSync: { status: 'verified' } },
    { domain: 'bad.example.com', checkinSync: { status: 'failed' } }
  ];
  const all = utils.filterSitesByHealth(sites, 'all');
  assert.deepEqual(all, sites);
  assert.notEqual(all, sites);
  assert.deepEqual(utils.filterSitesByHealth(sites, 'failed').map((site) => site.domain), ['bad.example.com']);
  const unknown = utils.filterSitesByHealth(sites, 'unexpected');
  assert.deepEqual(unknown, sites);
  assert.notEqual(unknown, sites);
});

test('checkinFingerprint strips query and hash even on normalize fallback', () => {
  const fingerprint = utils.checkinFingerprint({
    domain: 'other.example.com',
    name: 'other',
    type: 'auto',
    category: 'gongyi',
    // pageUrl host 与 domain 不一致时 normalizeHttpsUrl 返回 null，走回退分支。
    pageUrl: 'https://leak.example.com/path?token=secret#frag'
  });
  assert.doesNotMatch(fingerprint, /token=secret/);
  assert.doesNotMatch(fingerprint, /#frag/);
  assert.match(fingerprint, /https:\/\/leak\.example\.com\/path/);
});
