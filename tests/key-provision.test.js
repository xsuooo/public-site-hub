const assert = require('node:assert/strict');
const test = require('node:test');

const { createKeyProvisionService } = require('../key-provision.js');
const utils = require('../site-utils.js');
const storage = require('../storage.js');

function makeHarness({ sites: initialSites, scanResult, createResult, verifyResult } = {}) {
  let sites = structuredClone(initialSites || [{
    id: 'site-1',
    domain: 'example.com',
    type: 'newapi',
    keys: []
  }]);
  let scanCalls = 0;
  let createCalls = 0;
  let saveCalls = 0;

  const service = createKeyProvisionService({
    loadSites: async () => structuredClone(sites),
    saveSites: async (next) => {
      saveCalls += 1;
      sites = structuredClone(next);
      return structuredClone(sites);
    },
    readSession: async () => ({ tabId: 17, token: 'session-token' }),
    verify: async () => (verifyResult || { ok: true, userId: '1' }),
    scan: async () => {
      scanCalls += 1;
      return typeof scanResult === 'function' ? scanResult() : (scanResult || { keys: [], tokenListState: 'empty' });
    },
    create: async () => {
      createCalls += 1;
      return typeof createResult === 'function'
        ? createResult()
        : (createResult || { ok: true, created: true, key: { name: '公益站收藏', key: 'sk-created-0123456789' } });
    },
    merge: async (site, keys) => {
      const known = new Set((site.keys || []).map((key) => key.key));
      for (const raw of keys || []) {
        if (!raw?.key || known.has(raw.key)) continue;
        site.keys.push({
          id: `key-${site.keys.length + 1}`,
          name: raw.name || '令牌',
          key: raw.key,
          isDefault: site.keys.length === 0
        });
        known.add(raw.key);
      }
      return site;
    }
  });

  return {
    service,
    getSites: () => structuredClone(sites),
    calls: () => ({ scanCalls, createCalls, saveCalls })
  };
}

test('stored complete Key short-circuits automatic provisioning', async () => {
  const h = makeHarness({
    sites: [{ id: 'site-1', domain: 'example.com', type: 'newapi', keys: [{ key: 'sk-stored-0123456789', isDefault: true }] }]
  });

  const result = await h.service.ensureSiteKey('site-1');

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'existing');
  assert.deepEqual(h.calls(), { scanCalls: 0, createCalls: 0, saveCalls: 0 });
});

test('automatic provisioning imports a readable existing Key without creating another', async () => {
  const h = makeHarness({
    scanResult: {
      keys: [{ name: '已有令牌', key: 'sk-existing-0123456789' }],
      trustedKeys: [{ name: '已有令牌', key: 'sk-existing-0123456789' }],
      tokenListState: 'with-tokens'
    }
  });

  const result = await h.service.ensureSiteKey('site-1');

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'imported');
  assert.equal(h.calls().createCalls, 0);
  assert.equal(h.getSites()[0].keys[0].key, 'sk-existing-0123456789');
  assert.equal(h.getSites()[0].keys[0].isDefault, true);
});

test('a non-NewAPI site can still import a trusted existing Key without attempting creation', async () => {
  const h = makeHarness({
    sites: [{ id: 'site-1', domain: 'example.com', type: 'sub2api', keys: [] }],
    scanResult: {
      keys: [{ name: '已有令牌', key: 'sk-sub2-0123456789' }],
      trustedKeys: [{ name: '已有令牌', key: 'sk-sub2-0123456789' }],
      tokenListState: 'with-tokens'
    }
  });

  const result = await h.service.ensureSiteKey('site-1');

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'imported');
  assert.equal(h.calls().createCalls, 0);
});

test('an account-identity mismatch fails closed before scanning or creating a Key', async () => {
  const h = makeHarness({
    verifyResult: { ok: false, code: 'account_mismatch', error: '当前页面的登录账号不一致' }
  });

  const result = await h.service.ensureSiteKey('site-1');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'account_mismatch');
  assert.deepEqual(h.calls(), { scanCalls: 0, createCalls: 0, saveCalls: 0 });
});

test('empty token list requires explicit allowCreate before creating a Key', async () => {
  const h = makeHarness({
    scanResult: { keys: [], tokenListState: 'empty' }
  });

  const denied = await h.service.ensureSiteKey('site-1');
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'create_confirmation_required');
  assert.equal(denied.needsCreateConfirm, true);
  assert.equal(h.calls().createCalls, 0);
  assert.equal(h.getSites()[0].keys.length, 0);

  const result = await h.service.ensureSiteKey('site-1', { allowCreate: true });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'created');
  assert.equal(h.calls().createCalls, 1);
  assert.equal(h.getSites()[0].keys[0].key, 'sk-created-0123456789');
});

test('automatic provisioning creates exactly one Key only after a readable empty token list', async () => {
  const h = makeHarness({
    scanResult: { keys: [], tokenListState: 'empty' }
  });

  const result = await h.service.ensureSiteKey('site-1', { allowCreate: true });

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'created');
  assert.equal(h.calls().createCalls, 1);
  assert.equal(h.getSites()[0].keys[0].key, 'sk-created-0123456789');
});

test('masked, unavailable, or unsupported token states never create a Key', async () => {
  for (const scanResult of [
    { keys: [{ name: '掩码令牌', key: '', suffix: 'abcdef' }], tokenListState: 'with-tokens' },
    { keys: [], tokenListState: 'unavailable' },
    { keys: [], tokenListState: 'unsupported' }
  ]) {
    const h = makeHarness({ scanResult });
    const result = await h.service.ensureSiteKey('site-1');
    assert.equal(result.ok, false);
    assert.equal(h.calls().createCalls, 0);
    assert.equal(h.getSites()[0].keys.length, 0);
  }
});

test('an untrusted page-text Key is never saved or used to authorize creation', async () => {
  const h = makeHarness({
    scanResult: {
      keys: [{ name: '页面示例', key: 'sk-example-0123456789' }],
      trustedKeys: [],
      tokenListState: 'unavailable'
    }
  });

  const result = await h.service.ensureSiteKey('site-1');

  assert.equal(result.ok, false);
  assert.equal(h.calls().createCalls, 0);
  assert.equal(h.calls().saveCalls, 0);
  assert.equal(h.getSites()[0].keys.length, 0);
});

test('a created but unreadable Key is never saved as a placeholder', async () => {
  const h = makeHarness({
    createResult: {
      ok: false,
      created: true,
      code: 'created_key_unreadable',
      error: '令牌已创建，但站点没有返回完整 Key'
    }
  });

  const result = await h.service.ensureSiteKey('site-1', { allowCreate: true });

  assert.equal(result.ok, false);
  assert.equal(result.created, true);
  assert.equal(h.getSites()[0].keys.length, 0);
});

test('a site-domain edit during automatic import never saves the Key to the new address', async () => {
  let reads = 0;
  let saved = false;
  const service = createKeyProvisionService({
    loadSites: async () => {
      reads += 1;
      return [{
        id: 'site-1',
        domain: reads === 1 ? 'original.example' : 'changed.example',
        type: 'newapi',
        keys: []
      }];
    },
    saveSites: async () => {
      saved = true;
      return [];
    },
    readSession: async () => ({ tabId: 17, token: 'session-token' }),
    verify: async () => ({ ok: true, userId: '1' }),
    scan: async () => ({
      trustedKeys: [{ name: '已有令牌', key: 'sk-existing-0123456789' }],
      tokenListState: 'with-tokens'
    }),
    create: async () => ({ ok: true, key: { key: 'sk-never-created-0123456789' } }),
    merge: async (site, keys) => ({ ...site, keys })
  });

  const result = await service.ensureSiteKey('site-1');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'site_domain_changed');
  assert.equal(saved, false);
});

test('a sibling-port edit during automatic import never saves the old Origin Key', async () => {
  let reads = 0;
  let saved = false;
  const service = createKeyProvisionService({
    loadSites: async () => {
      reads += 1;
      return [{
        id: 'site-1',
        domain: 'port-race.example.com',
        baseUrl: reads === 1
          ? 'https://port-race.example.com:8443'
          : 'https://port-race.example.com:9443',
        type: 'newapi',
        keys: []
      }];
    },
    saveSites: async () => {
      saved = true;
      return [];
    },
    readSession: async () => ({ tabId: 17, token: 'session-token' }),
    verify: async () => ({ ok: true, userId: '1' }),
    scan: async () => ({
      trustedKeys: [{ name: '已有令牌', key: 'sk-port-race-existing-12345' }],
      tokenListState: 'with-tokens'
    }),
    create: async () => ({ ok: true, key: { key: 'sk-never-created-port-race' } }),
    merge: async (site, keys) => ({ ...site, keys })
  });

  const result = await service.ensureSiteKey('site-1');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'site_domain_changed');
  assert.equal(saved, false);
});

test('concurrent requests for one site share a single create operation', async () => {
  let release;
  const created = new Promise((resolve) => { release = resolve; });
  const h = makeHarness({
    createResult: async () => {
      await created;
      return { ok: true, created: true, key: { name: '公益站收藏', key: 'sk-once-0123456789' } };
    }
  });

  const first = h.service.ensureSiteKey('site-1', { allowCreate: true });
  const second = h.service.ensureSiteKey('site-1', { allowCreate: true });
  release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(h.calls().createCalls, 1);
  assert.equal(h.getSites()[0].keys.length, 1);
});

test('site deletion is rejected while automatic Key creation holds the shared lock', async () => {
  const initial = [
    utils.normalizeSite({ id: 'site-1', domain: 'locked.example.com', type: 'newapi', keys: [] }),
    utils.normalizeSite({ id: 'site-2', domain: 'other.example.com', type: 'newapi', keys: [] })
  ];
  let memory = { sites: structuredClone(initial) };
  globalThis.chrome = {
    runtime: {},
    storage: {
      local: {
        get(_keys, callback) { callback(memory); },
        set(patch, callback) {
          memory = { ...memory, ...structuredClone(patch) };
          callback();
        }
      }
    }
  };
  Object.assign(globalThis, utils);

  let signalCreateStarted;
  let releaseCreate;
  const createStarted = new Promise((resolve) => { signalCreateStarted = resolve; });
  const createGate = new Promise((resolve) => { releaseCreate = resolve; });
  const service = createKeyProvisionService({
    loadSites: storage.loadSites,
    saveSites: storage.saveSites,
    mutateSites: storage.mutateSites,
    tryAcquireSiteOperation: storage.tryAcquireSiteOperation,
    readSession: async () => ({ tabId: 17, token: 'session-token' }),
    verify: async () => ({ ok: true, userId: '1' }),
    scan: async () => ({ trustedKeys: [], tokenListState: 'empty' }),
    create: async () => {
      signalCreateStarted();
      await createGate;
      return { ok: true, created: true, key: { name: '公益站收藏', key: 'sk-locked-created-0123456789' } };
    },
    merge: async (site, keys) => ({ ...site, keys: [...(site.keys || []), ...keys] })
  });

  const creating = service.ensureSiteKey('site-1', { allowCreate: true });
  await createStarted;

  await assert.rejects(
    storage.removeSiteById('site-1'),
    (error) => error?.code === 'site_operation_busy'
  );
  await assert.rejects(
    storage.removeSitesByIds(['site-1', 'site-2']),
    (error) => error?.code === 'site_operation_busy'
  );
  assert.deepEqual((await storage.loadSites()).map((site) => site.id).sort(), ['site-1', 'site-2']);

  releaseCreate();
  const created = await creating;
  assert.equal(created.ok, true);
  assert.equal(created.outcome, 'created');
  assert.equal((await storage.loadSites()).find((site) => site.id === 'site-1').keys.length, 1);

  const remaining = await storage.removeSiteById('site-1');
  assert.deepEqual(remaining.map((site) => site.id), ['site-2']);
});
