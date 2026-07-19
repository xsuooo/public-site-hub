const test = require('node:test');
const assert = require('node:assert/strict');

const utils = require('../site-utils.js');
Object.assign(globalThis, {
  normalizeSite: utils.normalizeSite,
  dedupeSitesByDomain: utils.dedupeSitesByDomain,
  dedupeSitesByOrigin: utils.dedupeSitesByOrigin,
  originForSite: utils.originForSite,
  normalizeHttpsUrl: utils.normalizeHttpsUrl,
  categoryLabel: utils.categoryLabel,
  maskKey: utils.maskKey
});
const {
  buildExportConfig,
  buildCheckinExportConfig,
  adaptImportConfig,
  parseImportText,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_SITES
} = require('../import-export.js');

test('native export and both native import paths preserve check-in synchronization state', () => {
  const site = utils.normalizeSite({
    id: 'site-sync',
    domain: 'sync.example.com',
    name: 'Sync Example',
    checkinOptIn: true,
    syncedToCheckinAt: 123456,
    checkinSync: {
      status: 'failed',
      lastAttemptAt: 123000,
      lastError: { code: 'timeout', message: 'temporary failure' }
    }
  });

  const exported = buildExportConfig([site]);
  assert.equal(exported.sites[0].checkinOptIn, true);
  assert.equal(exported.sites[0].syncedToCheckinAt, 123456);
  assert.deepEqual(exported.sites[0].checkinSync, site.checkinSync);
  assert.notEqual(exported.sites[0].checkinSync, site.checkinSync);

  const adapted = adaptImportConfig(exported).sites[0];
  assert.equal(adapted.checkinOptIn, true);
  assert.equal(adapted.syncedToCheckinAt, 123456);
  assert.equal(adapted.checkinSync.status, 'failed');
  assert.equal(adapted.checkinSync.lastAttemptAt, 123000);

  const parsed = parseImportText(JSON.stringify(exported)).sites[0];
  assert.equal(parsed.checkinOptIn, true);
  assert.equal(parsed.syncedToCheckinAt, 123456);
  assert.equal(parsed.checkinSync.status, 'failed');
  assert.equal(parsed.checkinSync.lastError.message, 'temporary failure');
});

test('native export preserves tags while check-in export omits them', () => {
  const site = utils.normalizeSite({
    domain: 'tagged.example.com',
    tags: ['常用', 'Claude']
  });
  const native = buildExportConfig([site]);
  assert.deepEqual(native.sites[0].tags, ['常用', 'Claude']);
  assert.deepEqual(parseImportText(JSON.stringify(native)).sites[0].tags, ['常用', 'Claude']);
  assert.doesNotMatch(JSON.stringify(buildCheckinExportConfig([site])), /常用|Claude/);
});

test('safe share export excludes credentials, notes, tags, runtime state and deep URLs', () => {
  const site = utils.normalizeSite({
    domain: 'mask.example.com',
    baseUrl: 'https://mask.example.com:8443',
    pageUrl: 'https://mask.example.com:8443/console/private-path',
    note: 'private note',
    tags: ['private-tag'],
    balance: '$99',
    balanceStatus: { status: 'failed', lastError: { message: 'secret status' } },
    keys: [{ name: 'main', key: 'sk-secret-full-key-value-abcdef', isDefault: true }]
  });
  const full = buildExportConfig([site]);
  const redacted = buildExportConfig([site], { redactKeys: true });
  assert.equal(full.redacted, undefined);
  assert.equal(full.sites[0].keys[0].key, 'sk-secret-full-key-value-abcdef');
  assert.equal(redacted.redacted, true);
  assert.equal(redacted.redaction, 'share_safe');
  assert.equal(redacted.sites[0].baseUrl, 'https://mask.example.com:8443/');
  assert.equal(redacted.sites[0].pageUrl, 'https://mask.example.com:8443/');
  assert.equal(redacted.sites[0].keys, undefined);
  assert.doesNotMatch(JSON.stringify(redacted), /sk-secret-full-key-value-abcdef/);
  assert.doesNotMatch(JSON.stringify(redacted), /private-note|private-tag|secret status|console\/private-path|balance/);
});

test('redacted native backups are rejected instead of restoring masked credentials', () => {
  assert.throws(
    () => parseImportText(JSON.stringify({
      app: 'public-site-hub',
      version: 1,
      redacted: true,
      redaction: 'keys_masked',
      sites: [{ domain: 'masked.example.com', keys: [{ key: 'sk-••••', redacted: true }] }]
    })),
    /脱敏.*不能.*恢复/
  );
});

test('native export removes query strings and hash fragments from site URLs', () => {
  const site = utils.normalizeSite({
    domain: 'query.example.com',
    baseUrl: 'https://query.example.com/?token=secret',
    pageUrl: 'https://query.example.com/console?code=secret#private'
  });
  const exported = buildExportConfig([site]);
  assert.equal(exported.sites[0].baseUrl, 'https://query.example.com');
  assert.equal(exported.sites[0].pageUrl, 'https://query.example.com/console');
  assert.doesNotMatch(JSON.stringify(exported), /token=secret|code=secret|private/);
});

test('check-in export contains no API keys or internal synchronization state', () => {
  const exported = buildCheckinExportConfig([utils.normalizeSite({
    domain: 'safe.example.com',
    name: 'Safe Example',
    apiKey: 'sk-secret-api-key',
    keys: [{ name: 'default', key: 'sk-secret-list-key', isDefault: true }],
    checkinOptIn: true,
    syncedToCheckinAt: 789,
    checkinSync: { status: 'failed', lastError: { message: 'secret state' } }
  })]);
  const json = JSON.stringify(exported);

  assert.doesNotMatch(json, /sk-secret/);
  assert.doesNotMatch(json, /"keys"|"apiKey"|"checkinSync"|"syncedToCheckinAt"/);
});

test('check-in export reduces sensitive deep URLs to the site root while native export remains complete', () => {
  const site = utils.normalizeSite({
    domain: 'safe.example.com',
    name: 'Safe Example',
    pageUrl: 'https://safe.example.com/console/sk-path-secret/checkin?token=sk-query-secret#private',
    keys: [{ key: 'sk-key-secret' }]
  });
  const exported = buildCheckinExportConfig([site]);
  const json = JSON.stringify(exported);

  assert.equal(exported.sites[0].pageUrl, 'https://safe.example.com/');
  assert.doesNotMatch(json, /sk-path-secret|sk-query-secret|sk-key-secret|token=|#private/);
  assert.equal(buildExportConfig([site]).sites[0].pageUrl, 'https://safe.example.com/console/sk-path-secret/checkin');
});

test('check-in export rejects unsafe or cross-domain page URLs and falls back to the site origin', () => {
  for (const pageUrl of [
    'http://safe.example.com/private?token=sk-secret',
    'https://evil.example.net/private?token=sk-secret',
    'not a url sk-secret'
  ]) {
    const exported = buildCheckinExportConfig([{ domain: 'safe.example.com', name: 'Safe', pageUrl }]);
    assert.equal(exported.sites[0].pageUrl, 'https://safe.example.com/');
    assert.doesNotMatch(JSON.stringify(exported), /sk-secret|evil\.example\.net/);
  }
});

test('check-in format round-trip preserves relay category through adapt and parse', () => {
  const exported = buildCheckinExportConfig([utils.normalizeSite({
    domain: 'relay.example.com',
    name: 'Relay',
    category: 'relay'
  })]);
  assert.equal(adaptImportConfig(exported).sites[0].category, 'relay');
  assert.equal(parseImportText(JSON.stringify(exported)).sites[0].category, 'relay');
});

test('unsupported JSON is rejected instead of becoming an empty import', () => {
  assert.throws(() => parseImportText(JSON.stringify({ unrelated: true })), /不支持的导入格式/);
});

test('import parsing rejects oversized payloads and excessive source entries', () => {
  const oversized = JSON.stringify({
    app: 'public-site-hub',
    sites: [{ domain: 'large.example.com', note: 'x'.repeat(MAX_IMPORT_BYTES) }]
  });
  assert.throws(() => parseImportText(oversized), /超过 2 MB 上限/);

  const tooMany = Array.from({ length: MAX_IMPORT_SITES + 1 }, (_, index) => ({
    domain: `site-${index}.example.invalid`
  }));
  assert.throws(
    () => parseImportText(JSON.stringify({ app: 'public-site-hub', sites: tooMany })),
    /最多导入 1000 个站点/
  );
});

test('import parsing reports invalid entries separately from valid duplicate sites', () => {
  const parsed = parseImportText(JSON.stringify({
    app: 'public-site-hub',
    version: 1,
    sites: [
      { domain: 'one.example.com', name: 'One' },
      { domain: 'one.example.com', name: 'One duplicate' },
      { name: 'missing domain' },
      null
    ]
  }));

  assert.equal(parsed.sourceCount, 4);
  assert.equal(parsed.skipped, 2);
  assert.equal(parsed.sites.length, 2);
  assert.deepEqual(parsed.sites.map((site) => site.domain), [
    'one.example.com',
    'one.example.com'
  ]);
});

test('all-api-hub import skips malformed accounts without discarding valid accounts', () => {
  const parsed = parseImportText(JSON.stringify({
    accounts: {
      accounts: [
        null,
        { site_url: 'https://valid.example.com', site_name: 'Valid' }
      ]
    }
  }));

  assert.equal(parsed.format, 'all-api-hub');
  assert.equal(parsed.sourceCount, 2);
  assert.equal(parsed.skipped, 1);
  assert.equal(parsed.sites.length, 1);
  assert.equal(parsed.sites[0].domain, 'valid.example.com');
});

test('same hostname sibling ports remain separate and duplicate import accounts merge keys by Origin', () => {
  const parsed = parseImportText(JSON.stringify({
    accounts: {
      accounts: [
        { site_url: 'https://port.example.com', token: 'sk-port-one-complete-12345' },
        { site_url: 'https://port.example.com:8443', token: 'sk-port-two-complete-12345' },
        { site_url: 'https://port.example.com:8443', tokens: [null, { name: 'second', token: 'sk-port-three-complete-12345' }] }
      ]
    }
  }));
  assert.equal(parsed.sites.length, 3);
  assert.deepEqual(parsed.sites.map((site) => utils.siteIdentity(site)), [
    'https://port.example.com',
    'https://port.example.com:8443',
    'https://port.example.com:8443'
  ]);
  const merged = utils.mergeSites([], parsed.sites, { preferIncoming: true });
  assert.equal(merged.length, 2);
  assert.equal(merged.find((site) => site.baseUrl.endsWith(':8443'))?.keys.length, 2);
});

test('All API Hub null token entries are ignored without throwing', () => {
  const parsed = parseImportText(JSON.stringify({
    accounts: { accounts: [{ site_url: 'https://null-token.example.com', tokens: [null, 'bad', { token: 'sk-valid-null-123456' }] }] }
  }));
  assert.equal(parsed.sites.length, 1);
  assert.equal(parsed.sites[0].keys.length, 1);
  assert.equal(parsed.sites[0].keys[0].key, 'sk-valid-null-123456');
});
