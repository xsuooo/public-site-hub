const assert = require('node:assert/strict');
const test = require('node:test');

const utils = require('../site-utils.js');
const storage = require('../storage.js');

function verifiedSite(overrides = {}) {
  const base = utils.normalizeSite({
    id: 'site-1',
    domain: 'example.com',
    name: 'Example',
    type: 'newapi',
    category: 'gongyi',
    checkinOptIn: true,
    syncedToCheckinAt: 1000,
    ...overrides
  });
  return utils.normalizeSite({
    ...base,
    checkinSync: {
      status: 'verified',
      fingerprint: utils.checkinFingerprint(base),
      lastSuccessAt: 1000,
      lastVerifiedAt: 1000
    }
  });
}

function useMemoryStorage(seed) {
  let data = { sites: seed };
  globalThis.chrome = {
    runtime: {},
    storage: {
      local: {
        get(_keys, callback) { callback(data); },
        set(patch, callback) {
          data = { ...data, ...patch };
          callback();
        }
      }
    }
  };
  return () => data;
}

test('upsert preserves implicit check-in fields and makes changed verified data stale', async () => {
  const prev = verifiedSite();
  useMemoryStorage([prev]);

  const sites = await storage.upsertSite({
    domain: prev.domain,
    name: 'Renamed',
    type: prev.type,
    category: prev.category,
    baseUrl: prev.baseUrl,
    pageUrl: prev.pageUrl
  });

  assert.equal(sites[0].checkinOptIn, true);
  assert.equal(sites[0].syncedToCheckinAt, 1000);
  assert.equal(sites[0].checkinSync.status, 'stale');
});

test('upsert preserves verified state when fingerprint fields are unchanged', async () => {
  const prev = verifiedSite();
  useMemoryStorage([prev]);

  const sites = await storage.upsertSite({
    domain: prev.domain,
    name: prev.name,
    type: prev.type,
    category: prev.category,
    baseUrl: prev.baseUrl,
    pageUrl: prev.pageUrl
  });

  assert.equal(sites[0].checkinOptIn, true);
  assert.equal(sites[0].checkinSync.status, 'verified');
  assert.equal(sites[0].checkinSync.lastVerifiedAt, 1000);
});

test('upsert allows an explicit checkinOptIn false to disable synchronization', async () => {
  useMemoryStorage([verifiedSite()]);

  const sites = await storage.upsertSite({
    domain: 'example.com',
    checkinOptIn: false
  });

  assert.equal(sites[0].checkinOptIn, false);
  assert.equal(sites[0].checkinSync.status, 'idle');
});

test('upsert allows an explicit checkinSync value to replace prior state', async () => {
  useMemoryStorage([verifiedSite()]);

  const sites = await storage.upsertSite({
    domain: 'example.com',
    checkinSync: {
      status: 'failed',
      lastAttemptAt: 2000,
      lastError: { code: 'import_failed', message: '导入失败' }
    }
  });

  assert.equal(sites[0].checkinOptIn, true);
  assert.equal(sites[0].checkinSync.status, 'failed');
  assert.equal(sites[0].checkinSync.lastAttemptAt, 2000);
  assert.equal(sites[0].checkinSync.lastError.code, 'import_failed');
});

test('upsert explicitly clears syncedToCheckinAt without migrating the old time to sent', async () => {
  useMemoryStorage([verifiedSite()]);

  const sites = await storage.upsertSite({
    domain: 'example.com',
    checkinSync: null,
    syncedToCheckinAt: null
  });

  assert.equal(sites[0].syncedToCheckinAt ?? null, null);
  assert.equal(sites[0].checkinOptIn, true);
  assert.equal(sites[0].checkinSync.status, 'pending');
});

test('concurrent site mutations retain both a manual edit and an added Key', async () => {
  const initial = utils.normalizeSite({
    id: 'site-1',
    domain: 'example.com',
    name: 'Example',
    note: '',
    keys: []
  });
  const read = useMemoryStorage([initial]);

  await Promise.all([
    storage.addKeyToSite('site-1', { name: 'Primary', key: 'sk-complete-key-value-123' }),
    storage.updateSiteById('site-1', { note: '保留这条备注' })
  ]);

  const [site] = read().sites;
  assert.equal(site.note, '保留这条备注');
  assert.deepEqual(site.keys.map((key) => key.key), ['sk-complete-key-value-123']);
});

test('concurrent preference patches retain both updates', async () => {
  const read = useMemoryStorage([]);

  await Promise.all([
    storage.savePrefs({ defaultCategory: 'relay' }),
    storage.savePrefs({ listCategoryFilter: 'relay' })
  ]);

  assert.equal(read().prefs.defaultCategory, 'relay');
  assert.equal(read().prefs.listCategoryFilter, 'relay');
});

test('same hostname on different explicit ports can coexist and keeps distinct Keys', async () => {
  useMemoryStorage([]);
  const first = await storage.upsertSite({
    id: 'same-id',
    domain: 'ports.example.com',
    baseUrl: 'https://ports.example.com',
    keys: [{ key: 'sk-default-port-complete-12345' }]
  });
  const second = await storage.upsertSite({
    id: 'same-id',
    domain: 'ports.example.com',
    baseUrl: 'https://ports.example.com:8443',
    keys: [{ key: 'sk-custom-port-complete-12345' }]
  });
  assert.equal(second.length, 2);
  assert.deepEqual(second.map((site) => utils.siteIdentity(site)).sort(), [
    'https://ports.example.com',
    'https://ports.example.com:8443'
  ]);
  assert.equal(new Set(second.map((site) => site.id)).size, 2);
  assert.equal(second.find((site) => utils.siteIdentity(site) === 'https://ports.example.com').id, 'same-id');
  assert.notEqual(second.find((site) => utils.siteIdentity(site) === 'https://ports.example.com:8443').id, 'same-id');
  assert.deepEqual(second.flatMap((site) => site.keys.map((key) => key.key)).sort(), [
    'sk-custom-port-complete-12345',
    'sk-default-port-complete-12345'
  ]);
});

test('editing an existing site cannot silently rebind its Origin and credentials', async () => {
  const site = utils.normalizeSite({
    id: 'immutable-origin',
    domain: 'immutable.example.com',
    baseUrl: 'https://immutable.example.com:8443',
    keys: [{ key: 'sk-immutable-origin-complete-12345' }]
  });
  useMemoryStorage([site]);
  await assert.rejects(
    storage.updateSiteById(site.id, { baseUrl: 'https://immutable.example.com:9443' }),
    /Origin.*直接修改/
  );
  assert.equal(utils.siteIdentity((await storage.loadSites())[0]), 'https://immutable.example.com:8443');
});
