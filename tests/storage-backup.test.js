const assert = require('node:assert/strict');
const test = require('node:test');

const memory = {};
globalThis.chrome = {
  storage: {
    local: {
      get(keys, callback) {
        const picked = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) picked[key] = memory[key];
        callback(picked);
      },
      set(patch, callback) {
        Object.assign(memory, patch);
        callback();
      }
    }
  },
  runtime: {}
};

const utils = require('../site-utils.js');
Object.assign(globalThis, utils);
const storage = require('../storage.js');

test('replace-import snapshots can restore prior sites and retain a safety snapshot', async () => {
  memory.sites = [];
  memory.siteBackups = [];
  const original = [{ domain: 'before.example.com', keys: [{ key: 'sk-before-complete-key' }] }];
  await storage.saveSites(original);
  const backup = await storage.createSiteBackup(await storage.loadSites(), 'before-replace-import');
  await storage.importSites([{ domain: 'after.example.com', keys: [{ key: 'sk-after-complete-key' }] }], { mode: 'replace' });

  const restored = await storage.restoreSiteBackup(backup.id);
  assert.deepEqual(restored.sites.map((site) => site.domain), ['before.example.com']);
  assert.equal(restored.restored.id, backup.id);
  assert.equal(restored.safetyBackup.siteCount, 1);
  assert.equal((await storage.getLatestSiteBackup()).id, restored.safetyBackup.id);
});

test('replaceSitesWithBackup captures the latest queued site edit', async () => {
  memory.siteBackups = [];
  memory.sites = [utils.normalizeSite({
    id: 'site-1',
    domain: 'before.example.com',
    note: 'old'
  })];

  const edit = storage.updateSiteById('site-1', { note: 'latest edit' });
  const replace = storage.replaceSitesWithBackup([
    { domain: 'after.example.com' }
  ]);
  const [, result] = await Promise.all([edit, replace]);

  await storage.restoreSiteBackup(result.backup.id);
  assert.equal(memory.sites[0].note, 'latest edit');
});

test('loading backups physically removes expired secret snapshots', async () => {
  memory.siteBackups = [{
    id: 'expired',
    reason: 'manual',
    createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
    sites: [{
      domain: 'expired.example.com',
      keys: [{ key: 'sk-expired-secret-value' }]
    }]
  }];

  assert.deepEqual(await storage.listSiteBackups(), []);
  assert.deepEqual(memory.siteBackups, []);
  assert.doesNotMatch(JSON.stringify(memory), /sk-expired-secret-value/);
});

test('backup management can list and clear local recovery snapshots', async () => {
  memory.siteBackups = [];
  memory.sites = [{ domain: 'backup.example.com', keys: [{ key: 'sk-backup-0123456789' }] }];
  await storage.createSiteBackup(await storage.loadSites(), 'manual');
  assert.equal((await storage.listSiteBackups()).length, 1);
  await storage.clearSiteBackups();
  assert.deepEqual(await storage.listSiteBackups(), []);
});

test('empty import is rejected before it can replace stored sites', async () => {
  await assert.rejects(
    storage.importSites([], { mode: 'replace' }),
    /没有可用站点/
  );
});

test('balance refresh progress clamps invalid counters and preserves the current site', () => {
  assert.deepEqual(
    storage.normalizeBalanceRefreshProgress({
      status: 'running', total: 3, completed: 9, succeeded: 2, failed: 99,
      currentSiteName: 'Example Site', startedAt: 100
    }),
    {
      status: 'running', total: 3, completed: 3, succeeded: 2, failed: 1,
      currentSiteName: 'Example Site', startedAt: 100
    }
  );
});

test('balance refresh progress preserves resumable pending site IDs', () => {
  assert.deepEqual(
    storage.normalizeBalanceRefreshProgress({
      status: 'interrupted', total: 3, completed: 1, succeeded: 1, failed: 0,
      pendingSiteIds: ['two', 'two', '', 3], interruptedAt: 200
    }),
    {
      status: 'interrupted', total: 3, completed: 1, succeeded: 1, failed: 0,
      pendingSiteIds: ['two', '3'], interruptedAt: 200
    }
  );
});

test('balance refresh progress preserves stop state and run identity', () => {
  assert.deepEqual(
    storage.normalizeBalanceRefreshProgress({
      status: 'stopped', total: 4, completed: 1, succeeded: 1, failed: 0,
      pendingSiteIds: ['two', 'three', 'four'],
      runId: ' balance_run_1 ',
      stopRequestedAt: 300,
      stoppedAt: 400
    }),
    {
      status: 'stopped', total: 4, completed: 1, succeeded: 1, failed: 0,
      pendingSiteIds: ['two', 'three', 'four'],
      runId: 'balance_run_1',
      stopRequestedAt: 300,
      stoppedAt: 400
    }
  );
});

test('balance refresh progress rejects a stale conditional write', async () => {
  memory.balanceRefreshProgress = {
    status: 'completed', runId: 'run-new', total: 2, completed: 2, succeeded: 2, failed: 0
  };
  const rejected = await storage.saveBalanceRefreshProgress({
    status: 'interrupted', runId: 'run-old', total: 2, completed: 1,
    succeeded: 1, failed: 0, pendingSiteIds: ['two']
  }, {
    expectedRunId: 'run-old',
    expectedStatuses: ['running', 'stopping']
  });
  assert.equal(rejected.status, 'completed');
  assert.equal(rejected.runId, 'run-new');
  assert.equal(memory.balanceRefreshProgress.status, 'completed');
  assert.equal(memory.balanceRefreshProgress.runId, 'run-new');

  memory.balanceRefreshProgress = {
    status: 'running', runId: 'run-new', total: 2, completed: 1, succeeded: 1, failed: 0
  };
  const applied = await storage.saveBalanceRefreshProgress({
    status: 'stopped', runId: 'run-new', total: 2, completed: 1,
    succeeded: 1, failed: 0, pendingSiteIds: ['two'], stoppedAt: 500
  }, {
    expectedRunId: 'run-new',
    expectedStatuses: ['running', 'stopping']
  });
  assert.equal(applied.status, 'stopped');
  assert.equal(memory.balanceRefreshProgress.status, 'stopped');
});

test('balance refresh progress preserves a normalized task scope', () => {
  assert.deepEqual(
    storage.normalizeBalanceRefreshProgress({
      status: 'running',
      total: 2,
      completed: 0,
      scope: {
        kind: 'failed',
        siteIds: ['two', 'one', 'two', '']
      }
    }).scope,
    {
      kind: 'failed',
      siteIds: ['one', 'two']
    }
  );
});

test('site data migration records a schema version and normalizes legacy duplicates', async () => {
  memory.sites = [
    { domain: 'example.com', name: 'First' },
    { domain: 'example.com', name: 'Duplicate' }
  ];
  delete memory.siteDataMeta;

  const result = await storage.migrateSiteData();

  assert.equal(result.migrated, true);
  assert.equal(result.sites.length, 1);
  assert.equal(storage.SITE_DATA_SCHEMA_VERSION, 5);
  assert.equal(memory.siteDataMeta.schemaVersion, storage.SITE_DATA_SCHEMA_VERSION);
  assert.ok(memory.siteDataMeta.migratedAt);
  assert.ok(storage.SITE_DATA_MIGRATIONS[3]);
  assert.ok(storage.SITE_DATA_MIGRATIONS[4]);
});

test('site writes preserve the last migration timestamp', async () => {
  memory.sites = [];
  memory.siteDataMeta = { schemaVersion: 0 };

  await storage.migrateSiteData();
  const migratedAt = memory.siteDataMeta.migratedAt;
  await storage.saveSites([{ domain: 'meta.example.com' }]);

  assert.equal(memory.siteDataMeta.migratedAt, migratedAt);
});

test('ordered migrations advance from schema v2 to current version', async () => {
  memory.sites = [{ domain: 'legacy.example.com', name: 'Legacy' }];
  memory.siteDataMeta = { schemaVersion: 2, migratedAt: 10, updatedAt: 10 };

  const result = await storage.migrateSiteData();

  assert.equal(result.migrated, true);
  assert.equal(memory.siteDataMeta.schemaVersion, 5);
  assert.ok(memory.siteDataMeta.migratedAt >= 10);
  assert.equal(result.sites[0].domain, 'legacy.example.com');
  assert.ok(Array.isArray(result.sites[0].tags));
});

test('schema v4 migration strips sensitive URL query and hash fragments', async () => {
  memory.sites = [{
    domain: 'legacy-query.example.com',
    baseUrl: 'https://legacy-query.example.com/?token=secret',
    pageUrl: 'https://legacy-query.example.com/console?code=secret#private'
  }];
  memory.siteDataMeta = { schemaVersion: 3, migratedAt: 10, updatedAt: 10 };

  const result = await storage.migrateSiteData();

  assert.equal(result.meta.schemaVersion, 5);
  assert.equal(result.sites[0].baseUrl, 'https://legacy-query.example.com');
  assert.equal(result.sites[0].pageUrl, 'https://legacy-query.example.com/console');
});

test('schema migration preserves an explicit sibling port and records a raw rollback snapshot', async () => {
  memory.sites = [{
    id: 'legacy-port',
    domain: 'legacy-port.example.com',
    baseUrl: 'https://legacy-port.example.com',
    pageUrl: 'https://legacy-port.example.com:8443/console/personal',
    keys: [{ key: 'sk-legacy-port-complete-12345' }]
  }];
  memory.siteDataMeta = { schemaVersion: 4 };
  memory.siteBackups = [];

  const result = await storage.migrateSiteData();

  assert.equal(result.sites[0].baseUrl, 'https://legacy-port.example.com:8443');
  assert.equal(result.sites[0].pageUrl, 'https://legacy-port.example.com:8443');
  assert.ok((await storage.listSiteBackups()).some((item) => item.reason === 'before-schema-migration'));
});

test('normalizePrefs defaults preferUnlimitedAutoKey to false', () => {
  assert.equal(storage.normalizePrefs({}).preferUnlimitedAutoKey, false);
  assert.equal(storage.normalizePrefs({ preferUnlimitedAutoKey: true }).preferUnlimitedAutoKey, true);
  assert.equal(storage.normalizePrefs({ preferUnlimitedAutoKey: 'yes' }).preferUnlimitedAutoKey, false);
});
