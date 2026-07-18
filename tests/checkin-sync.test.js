const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const utils = require('../site-utils.js');

Object.assign(globalThis, utils);
const syncModule = require('../checkin-sync.js');

const NOW = 1000;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsync() {
  await new Promise((resolve) => setImmediate(resolve));
}

function makeSite(id, overrides = {}) {
  return utils.normalizeSite({
    id,
    domain: `${id}.example.com`,
    name: id.toUpperCase(),
    checkinOptIn: true,
    checkinSync: { status: 'pending' },
    ...overrides
  });
}

function makeHarness({
  sites = [makeSite('a')],
  pingResult = { ok: true, id: 'target', version: '2.0.0', capabilities: {} },
  importResult = { ok: true },
  readResult = { ok: true, sites: [] }
} = {}) {
  let storedSites = sites;
  let meta = null;
  const calls = {
    ping: 0,
    importSites: 0,
    importArgs: [],
    readSites: 0,
    saveSites: 0,
    saveSnapshots: [],
    saveMeta: 0
  };
  const service = syncModule.createCheckinSyncService({
    now: () => NOW,
    loadSites: async () => storedSites,
    saveSites: async (next) => {
      calls.saveSites += 1;
      calls.saveSnapshots.push(structuredClone(next));
      storedSites = next;
      return storedSites;
    },
    saveMeta: async (next) => {
      calls.saveMeta += 1;
      meta = next;
      return meta;
    },
    ping: async () => {
      calls.ping += 1;
      return pingResult;
    },
    importSites: async (...args) => {
      calls.importSites += 1;
      calls.importArgs.push(args);
      return importResult;
    },
    readSites: async () => {
      calls.readSites += 1;
      return readResult;
    }
  });
  return {
    service,
    calls,
    getSites: () => storedSites,
    replaceSites: (next) => { storedSites = next; },
    getMeta: () => meta
  };
}

test('old receiver records sent state and compatibility timestamps', async () => {
  const untouched = makeSite('b', { checkinSync: { status: 'verified', lastVerifiedAt: 25 } });
  const h = makeHarness({ sites: [makeSite('a'), untouched] });
  const result = await h.service.syncByIds(['a']);
  const site = h.getSites()[0];

  assert.equal(result.ok, true);
  assert.equal(result.partial, false);
  assert.equal(site.checkinSync.status, 'sent');
  assert.equal(site.checkinSync.lastAttemptAt, NOW);
  assert.equal(site.checkinSync.lastSuccessAt, NOW);
  assert.equal(site.syncedToCheckinAt, NOW);
  assert.equal(site.checkinSync.fingerprint, utils.checkinFingerprint(site));
  assert.equal(site.checkinSync.targetVersion, '2.0.0');
  assert.deepEqual(h.getMeta(), {
    lastRunAt: NOW, requested: 1, sent: 1, verified: 0, failed: 0, skipped: 0
  });
  assert.equal(h.calls.importArgs.length, 1);
  assert.equal(h.calls.importArgs[0][0], 'target');
  assert.deepEqual(h.calls.importArgs[0][1].map((target) => target.id), ['a']);
  assert.equal(h.calls.saveSnapshots[0][0].checkinSync.status, 'pending');
  assert.equal(h.calls.saveSnapshots[0][0].checkinSync.lastAttemptAt, NOW);
  assert.equal(h.calls.saveSnapshots[0][0].checkinSync.lastError, null);
  assert.deepEqual(h.calls.saveSnapshots[0][1], untouched);
});

test('read-back confirmation accepts nested sites and records verified', async () => {
  const h = makeHarness({
    pingResult: { ok: true, id: 'target', version: '2.1.0', capabilities: { readSites: true } },
    readResult: { success: true, data: { sites: [{ domain: 'A.EXAMPLE.COM' }] } }
  });
  const result = await h.service.syncByIds(['a']);
  const site = h.getSites()[0];

  assert.equal(result.ok, true);
  assert.equal(site.checkinSync.status, 'verified');
  assert.equal(site.checkinSync.lastVerifiedAt, NOW);
  assert.equal(site.checkinSync.lastSuccessAt, NOW);
  assert.equal(site.syncedToCheckinAt, NOW);
  assert.equal(result.summary.verified, 1);
});

test('read-back can partially verify a batch', async () => {
  const h = makeHarness({
    sites: [makeSite('a'), makeSite('b')],
    pingResult: { ok: true, id: 'target', capabilities: { readSites: true } },
    readResult: { ok: true, sites: [{ domain: 'a.example.com' }] }
  });
  const result = await h.service.syncByIds(['a', 'b']);
  const [a, b] = h.getSites();

  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.equal(a.checkinSync.status, 'verified');
  assert.equal(b.checkinSync.status, 'failed');
  assert.deepEqual(b.checkinSync.lastError, {
    code: 'verify_failed', message: '目标扩展中未找到该站点'
  });
  assert.deepEqual(result.summary, {
    lastRunAt: NOW, requested: 2, sent: 0, verified: 1, failed: 1, skipped: 0
  });
});

test('ping and import failures persist stable errors without overwriting success evidence', async (t) => {
  for (const scenario of [
    { name: 'ping', pingResult: { ok: false, code: 'extension_disabled', error: '未启用' } },
    { name: 'import', importResult: { success: false, code: 'no_response', error: '无响应' } }
  ]) {
    await t.test(scenario.name, async () => {
      const oldFingerprint = 'old-fingerprint';
      const site = makeSite('a', {
        syncedToCheckinAt: 50,
        checkinSync: {
          status: 'sent', lastSuccessAt: 50, lastVerifiedAt: 40, fingerprint: oldFingerprint
        }
      });
      const h = makeHarness({ sites: [site], ...scenario });
      const result = await h.service.syncByIds(['a']);
      const failed = h.getSites()[0];

      assert.equal(result.ok, false);
      assert.deepEqual(h.service.failedIds(h.getSites()), ['a']);
      assert.equal(failed.checkinSync.status, 'failed');
      assert.equal(failed.checkinSync.lastSuccessAt, 50);
      assert.equal(failed.checkinSync.lastVerifiedAt, 40);
      assert.equal(failed.checkinSync.fingerprint, oldFingerprint);
      assert.deepEqual(failed.checkinSync.lastError, {
        code: scenario.name === 'ping' ? 'extension_disabled' : 'no_response',
        message: scenario.name === 'ping' ? '未启用' : '无响应'
      });
      assert.deepEqual(result.results.map((item) => item.id), ['a']);
      assert.equal(result.summary.failed, 1);
    });
  }
});

test('thrown ping and import errors persist stable failures without erasing prior evidence', async (t) => {
  for (const stage of ['ping', 'import']) {
    await t.test(stage, async () => {
      let sites = [makeSite('a', {
        syncedToCheckinAt: 50,
        checkinSync: {
          status: 'verified',
          lastSuccessAt: 50,
          lastVerifiedAt: 45,
          targetVersion: '1.5.0',
          fingerprint: 'old-fingerprint'
        }
      })];
      let meta;
      const service = syncModule.createCheckinSyncService({
        now: () => NOW,
        loadSites: async () => sites,
        saveSites: async (next) => { sites = next; return sites; },
        saveMeta: async (next) => { meta = next; return meta; },
        ping: async () => {
          if (stage === 'ping') throw new Error('ping exploded');
          return { ok: true, id: 'target', version: '2.0.0', capabilities: {} };
        },
        importSites: async () => { throw new Error('import exploded'); },
        readSites: async () => ({ ok: true, sites: [] })
      });

      const result = await service.syncByIds(['a']);
      const failed = sites[0];
      assert.equal(result.ok, false);
      assert.equal(failed.checkinSync.status, 'failed');
      assert.deepEqual(failed.checkinSync.lastError, {
        code: 'unknown',
        message: `${stage} exploded`
      });
      assert.equal(failed.syncedToCheckinAt, 50);
      assert.equal(failed.checkinSync.lastSuccessAt, 50);
      assert.equal(failed.checkinSync.lastVerifiedAt, 45);
      assert.equal(failed.checkinSync.targetVersion, '1.5.0');
      assert.equal(failed.checkinSync.fingerprint, 'old-fingerprint');
      assert.equal(meta.failed, 1);
    });
  }
});

test('read failure marks every target verify_failed', async () => {
  const h = makeHarness({
    sites: [makeSite('a'), makeSite('b')],
    pingResult: { ok: true, id: 'target', capabilities: { readSites: true } },
    readResult: { ok: false, error: '回读超时' }
  });
  const result = await h.service.syncByIds(['a', 'b']);

  assert.equal(result.ok, false);
  assert.equal(result.summary.failed, 2);
  for (const site of h.getSites()) {
    assert.equal(site.checkinSync.status, 'failed');
    assert.deepEqual(site.checkinSync.lastError, { code: 'verify_failed', message: '回读超时' });
  }
});

test('no eligible targets saves an honest empty summary without transport calls', async () => {
  const h = makeHarness({ sites: [makeSite('a', { checkinOptIn: false })] });
  const result = await h.service.syncByIds(['a', 'missing', 'a']);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'no_targets');
  assert.deepEqual(result.summary, {
    lastRunAt: NOW, requested: 0, sent: 0, verified: 0, failed: 0, skipped: 2
  });
  assert.equal(h.calls.ping, 0);
  assert.equal(h.calls.importSites, 0);
  assert.equal(h.calls.readSites, 0);
});

test('summarizeCheckinResults counts statuses and clamps skipped', () => {
  assert.deepEqual(syncModule.summarizeCheckinResults([
    { ok: true, status: 'sent' },
    { ok: true, status: 'verified' },
    { ok: false, status: 'failed' }
  ], NOW, -2), {
    lastRunAt: NOW, requested: 3, sent: 1, verified: 1, failed: 1, skipped: 0
  });
});

test('createCheckinActions opts in syncOne and selects batch actions exactly', async () => {
  const sites = [
    makeSite('idle', { checkinSync: { status: 'idle' } }),
    makeSite('pending', { checkinSync: { status: 'pending' } }),
    makeSite('failed', { checkinSync: { status: 'failed', lastError: 'x' } }),
    makeSite('stale', { checkinSync: { status: 'stale', fingerprint: 'old' } }),
    makeSite('verified', { checkinSync: { status: 'verified' } }),
    makeSite('off', { checkinOptIn: false })
  ];
  const batches = [];
  const updates = [];
  const service = {
    syncByIds: async (ids) => { batches.push(ids); return { ok: true, ids }; },
    failedIds: (list) => list.filter((site) => site.checkinOptIn && site.checkinSync?.status === 'failed').map((site) => site.id)
  };
  const handle = syncModule.createCheckinActions(service, {
    loadSites: async () => sites,
    updateSite: async (id, patch) => { updates.push({ id, patch }); }
  });

  await handle('syncOne', { id: 'off' });
  await handle('syncEligible');
  await handle('retryFailed');

  assert.deepEqual(updates, [{ id: 'off', patch: { checkinOptIn: true } }]);
  assert.deepEqual(batches, [
    ['off'],
    ['pending', 'failed', 'stale'],
    ['failed']
  ]);
  assert.deepEqual(await handle('unknown'), {
    ok: false, code: 'unknown_action', error: '未知签到操作'
  });
});

test('syncOne persists opt-in before starting synchronization', async () => {
  const events = [];
  const handle = syncModule.createCheckinActions({
    syncByIds: async () => { events.push('sync'); return { ok: true }; },
    failedIds: () => []
  }, {
    loadSites: async () => [{ id: 'a', checkinOptIn: false, checkinSync: { status: 'idle' } }],
    updateSite: async () => { events.push('update'); }
  });

  await handle('syncOne', { id: 'a' });
  assert.deepEqual(events, ['update', 'sync']);
});

test('syncOne reports a missing site without syncing', async () => {
  let called = false;
  const handle = syncModule.createCheckinActions({
    syncByIds: async () => { called = true; },
    failedIds: () => []
  }, {
    loadSites: async () => [],
    updateSite: async () => {}
  });

  assert.deepEqual(await handle('syncOne', { id: 'missing' }), {
    ok: false, code: 'site_not_found', error: '站点不存在'
  });
  assert.equal(called, false);
});

test('browser-style loading exposes the default action and public API without touching chrome', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'checkin-sync.js'), 'utf8');
  const browserSelf = {
    checkinFingerprint: () => 'fingerprint',
    loadSites: async () => [],
    saveSites: async (sites) => sites,
    saveCheckinSyncMeta: async (meta) => meta,
    pingCheckin: async () => ({ ok: false }),
    importCheckinSites: async () => ({ ok: false }),
    readCheckinSites: async () => ({ ok: false }),
    updateSiteById: async () => null
  };
  const context = vm.createContext({ self: browserSelf });
  Object.defineProperty(context, 'chrome', {
    configurable: true,
    get() { throw new Error('chrome must not be accessed while loading'); }
  });

  vm.runInContext(source, context, { filename: 'checkin-sync.js' });

  assert.equal(typeof browserSelf.handleCheckinAction, 'function');
  assert.equal(typeof browserSelf.summarizeCheckinResults, 'function');
  assert.equal(typeof browserSelf.createCheckinSyncService, 'function');
  assert.equal(typeof browserSelf.createCheckinActions, 'function');
});

test('an in-flight sync preserves newer non-sync edits from storage', async () => {
  const importGate = deferred();
  const importStarted = deferred();
  const h = makeHarness({ importResult: importGate.promise });
  const syncing = h.service.syncByIds(['a']);

  while (h.calls.importSites < 1) await flushAsync();
  importStarted.resolve();
  await importStarted.promise;
  h.replaceSites(h.getSites().map((site) => site.id === 'a' ? {
    ...site,
    note: 'edited while syncing',
    keys: [{ name: 'new key', key: 'sk-new', isDefault: true }]
  } : site));
  importGate.resolve({ ok: true });
  await syncing;

  const site = h.getSites()[0];
  assert.equal(site.note, 'edited while syncing');
  assert.deepEqual(site.keys, [{ name: 'new key', key: 'sk-new', isDefault: true }]);
  assert.equal(site.checkinSync.status, 'sent');
});

test('concurrent syncs for different sites retain both final states', async () => {
  let sites = [makeSite('a'), makeSite('b')];
  const gates = [deferred(), deferred()];
  let importCount = 0;
  const service = syncModule.createCheckinSyncService({
    now: () => NOW,
    loadSites: async () => sites,
    saveSites: async (next) => { sites = next; return sites; },
    saveMeta: async (meta) => meta,
    ping: async () => ({ ok: true, id: 'target', capabilities: {} }),
    importSites: async () => gates[importCount++].promise,
    readSites: async () => ({ ok: true, sites: [] })
  });

  const first = service.syncByIds(['a']);
  const second = service.syncByIds(['b']);
  await flushAsync();
  if (importCount === 2) {
    gates[1].resolve({ ok: true });
    await flushAsync();
    gates[0].resolve({ ok: true });
  } else {
    gates[0].resolve({ ok: true });
    while (importCount < 2) await flushAsync();
    gates[1].resolve({ ok: true });
  }
  await Promise.all([first, second]);

  assert.deepEqual(sites.map((site) => [site.id, site.checkinSync.status]), [
    ['a', 'sent'],
    ['b', 'sent']
  ]);
});

test('repeated syncs for one site are serialized so an older request cannot finish last', async () => {
  let sites = [makeSite('a')];
  const gates = [deferred(), deferred()];
  const events = [];
  let pingCount = 0;
  let importCount = 0;
  let activeImports = 0;
  let maxActiveImports = 0;
  const service = syncModule.createCheckinSyncService({
    now: () => NOW + pingCount,
    loadSites: async () => sites,
    saveSites: async (next) => { sites = next; return sites; },
    saveMeta: async (meta) => meta,
    ping: async () => {
      pingCount += 1;
      return { ok: true, id: 'target', version: String(pingCount), capabilities: {} };
    },
    importSites: async () => {
      const index = importCount++;
      activeImports += 1;
      maxActiveImports = Math.max(maxActiveImports, activeImports);
      events.push(`start${index + 1}`);
      const result = await gates[index].promise;
      events.push(`end${index + 1}`);
      activeImports -= 1;
      return result;
    },
    readSites: async () => ({ ok: true, sites: [] })
  });

  const older = service.syncByIds(['a']);
  const newer = service.syncByIds(['a']);
  await flushAsync();
  if (importCount === 2) {
    gates[1].resolve({ ok: true });
    await flushAsync();
    gates[0].resolve({ ok: true });
  } else {
    gates[0].resolve({ ok: true });
    while (importCount < 2) await flushAsync();
    gates[1].resolve({ ok: true });
  }
  await Promise.all([older, newer]);

  assert.equal(maxActiveImports, 1);
  assert.deepEqual(events, ['start1', 'end1', 'start2', 'end2']);
  assert.equal(sites[0].checkinSync.targetVersion, '2');
});

test('explicit false success flags take precedence over contradictory true flags', async (t) => {
  for (const pingResult of [
    { ok: false, success: true, code: 'conflict', error: 'ok false' },
    { ok: true, success: false, code: 'conflict', error: 'success false' }
  ]) {
    await t.test(JSON.stringify(pingResult), async () => {
      const h = makeHarness({ pingResult });
      const result = await h.service.syncByIds(['a']);
      assert.equal(result.ok, false);
      assert.equal(h.getSites()[0].checkinSync.status, 'failed');
      assert.equal(h.calls.importSites, 0);
    });
  }
});
