const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const backgroundSource = fs.readFileSync(
  path.join(__dirname, '..', 'background.js'),
  'utf8'
);

function loadBackground(overrides = {}) {
  const imported = [];
  const actionCalls = [];
  const updates = [];
  const events = [];
  const retained = [];
  const lifecycle = { installed: [], startup: [] };
  let messageListener;
  let contextMenuClickListener;
  const sites = overrides.sites || [{ id: 'site-1', checkinOptIn: true }];
  const prefs = overrides.prefs || { autoSyncCheckin: false };

  const context = {
    URL,
    console,
    setTimeout,
    clearTimeout,
    importScripts(...files) {
      imported.push(...files);
      for (const file of files) {
        // 单元测试只实装权限模块，其余仍靠 globals / 背景脚本自身
        if (
          file === 'site-utils.js'
          || file === 'permissions.js'
          || file === 'site-tabs.js'
          || file === 'balance-refresh.js'
          || file === 'key-import.js'
        ) {
          // key-provision 不自动实装：单测用 globals.createKeyProvisionService 注入
          const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
          vm.runInContext(source, context, { filename: file });
        }
      }
    },
    handleCheckinAction: async (action, message) => {
      events.push('sync');
      actionCalls.push([action, message]);
      return { ok: true, action };
    },
    pingCheckin: async () => ({ ok: false, code: 'extension_not_found' }),
    loadCheckinSyncMeta: async () => ({ lastRunAt: 123, failed: 2 }),
    loadSites: async () => sites,
    loadPrefs: async () => prefs,
    updateSiteById: async (id, patch) => {
      events.push('update');
      updates.push([id, patch]);
      return sites.map((site) => site.id === id ? { ...site, ...patch } : site);
    },
    chrome: {
      contextMenus: overrides.contextMenus || {
        create(_props, callback) { callback?.(); },
        removeAll(callback) { callback(); },
        onClicked: { addListener(listener) { contextMenuClickListener = listener; } }
      },
      runtime: {
        onInstalled: { addListener(listener) { lifecycle.installed.push(listener); } },
        onStartup: { addListener(listener) { lifecycle.startup.push(listener); } },
        onMessage: {
          addListener(listener) { messageListener = listener; }
        },
        getManifest: () => ({ version: '1.0' })
      },
      tabs: overrides.tabs || {
        query: async () => [],
        create: async () => ({}),
        remove: async () => undefined
      },
      permissions: overrides.permissions,
      alarms: overrides.alarms || undefined
    },
    ...overrides.globals
  };

  vm.createContext(context);
  vm.runInContext(backgroundSource, context, { filename: 'background.js' });

  async function dispatch(message) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('message response timed out')), 1000);
      const keepAlive = messageListener(message, {}, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });
      retained.push(keepAlive);
    });
  }

  return {
    imported,
    actionCalls,
    updates,
    events,
    retained,
    lifecycle,
    dispatch,
    context,
    contextMenuClick: (...args) => contextMenuClickListener?.(...args)
  };
}

test('loads checkin modules but check-in messages are hard-offline standalone', async () => {
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const app = loadBackground();

  assert.equal(app.imported.includes('checkin-sync.js'), false);
  assert.equal(app.imported.includes('bridge.js'), false);
  assert.ok(app.imported.includes('key-provision.js'));

  const standalone = {
    ok: false,
    code: 'checkin_standalone',
    error: '签到已独立，请在「公益站签到」中识别添加'
  };
  assert.deepEqual(plain(await app.dispatch({ type: 'pushToCheckin', id: 'site-1' })), standalone);
  assert.deepEqual(plain(await app.dispatch({ type: 'pushToCheckin' })), standalone);
  assert.deepEqual(plain(await app.dispatch({ type: 'retryFailedCheckin' })), standalone);
  assert.deepEqual(plain(await app.dispatch({ type: 'pingCheckin' })), standalone);

  const status = plain(await app.dispatch({ type: 'getCheckinStatus' }));
  assert.equal(status.ok, true);
  assert.equal(status.standalone, true);
  assert.equal(status.connection.code, 'checkin_standalone');
  assert.equal(status.meta, null);

  assert.equal(app.actionCalls.length, 0);
  assert.equal(app.retained.every((value) => value === true), true);
});

test('context-menu setup coalesces overlapping install and startup signals', () => {
  const removeCallbacks = [];
  const createdIds = [];
  const duplicateIds = [];
  const app = loadBackground({
    contextMenus: {
      removeAll(callback) { removeCallbacks.push(callback); },
      create(props, callback) {
        if (createdIds.includes(props.id)) duplicateIds.push(props.id);
        else createdIds.push(props.id);
        callback?.();
      },
      onClicked: { addListener() {} }
    }
  });

  assert.equal(removeCallbacks.length, 1, 'cold start should begin one menu reset');
  assert.equal(app.lifecycle.installed.length, 1);
  assert.equal(app.lifecycle.startup.length, 1);

  app.lifecycle.installed[0]();
  app.lifecycle.startup[0]();
  assert.equal(removeCallbacks.length, 1, 'overlapping lifecycle events must share the in-flight reset');

  removeCallbacks.shift()();
  assert.deepEqual(createdIds, ['public-site-hub-add']);
  assert.deepEqual(duplicateIds, []);
});

test('messages wait for startup migration and expired-backup cleanup', async () => {
  let releaseMigration;
  const migrationGate = new Promise((resolve) => { releaseMigration = resolve; });
  let listCalls = 0;
  let backupCleanupCalls = 0;
  const app = loadBackground({
    globals: {
      migrateSiteData: async () => migrationGate,
      loadSiteBackups: async () => {
        backupCleanupCalls += 1;
        return [];
      },
      loadSites: async () => {
        listCalls += 1;
        return [];
      }
    }
  });

  const response = app.dispatch({ type: 'listSites' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listCalls, 0, 'site reads must not race the startup migration');
  releaseMigration();

  const result = await response;
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.sites)), []);
  assert.equal(listCalls, 1);
  assert.equal(backupCleanupCalls, 1);
});

test('maintenance alarm performs daily recovery-snapshot cleanup', async () => {
  const created = [];
  let onAlarm = null;
  let cleanupCalls = 0;
  loadBackground({
    alarms: {
      create(name, options) { created.push([name, options]); },
      onAlarm: { addListener(listener) { onAlarm = listener; } }
    },
    globals: {
      migrateSiteData: async () => ({ migrated: false }),
      loadSiteBackups: async () => {
        cleanupCalls += 1;
        return [];
      }
    }
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created[0][0], 'public-site-hub-maintenance');
  assert.equal(created[0][1].periodInMinutes, 24 * 60);
  assert.equal(typeof onAlarm, 'function');
  assert.equal(cleanupCalls, 1, 'cold start should clean expired snapshots immediately');

  onAlarm({ name: 'unrelated' });
  onAlarm({ name: 'public-site-hub-maintenance' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleanupCalls, 2);
});

test('context-menu detection reuses the source tab only for the exact target origin', async () => {
  let clickListener = null;
  const detections = [];
  const requestedOrigins = [];

  loadBackground({
    sites: [],
    contextMenus: {
      removeAll(callback) { callback(); },
      create(_props, callback) { callback?.(); },
      onClicked: {
        addListener(listener) { clickListener = listener; }
      }
    },
    permissions: {
      request(details, callback) {
        requestedOrigins.push([...(details.origins || [])]);
        callback(true);
      },
      contains(_details, callback) { callback(true); }
    },
    globals: {
      detectSite: async (input, options = {}) => {
        const url = new URL(input);
        detections.push({ input, options: { ...options } });
        return {
          ok: true,
          domain: url.hostname,
          name: url.hostname,
          type: 'newapi',
          baseUrl: url.origin,
          pageUrl: `${url.origin}/`,
          summary: 'test detection'
        };
      },
      upsertSite: async (site) => [site],
      saveSites: async (sites) => sites,
      console: { log() {}, warn() {}, error() {} }
    }
  });

  assert.equal(typeof clickListener, 'function');

  async function invoke(info, tab) {
    const index = detections.length;
    clickListener(info, tab);
    for (let attempt = 0; attempt < 20 && detections.length === index; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(detections.length, index + 1, 'context-menu action should reach detection');
    return detections[index];
  }

  const crossPortLink = await invoke(
    { linkUrl: 'https://same.example.com:8443/target' },
    { id: 41, url: 'https://same.example.com:9443/source', title: 'Source' }
  );
  assert.equal(crossPortLink.options.tabId, null);
  assert.equal(crossPortLink.options.expectedOrigin, 'https://same.example.com:8443');

  const crossOriginSelection = await invoke(
    { selectionText: 'https://selected.example.com:8443/path' },
    { id: 42, url: 'https://source.example.com/page', title: 'Source' }
  );
  assert.equal(crossOriginSelection.options.tabId, null);

  const sameOriginLink = await invoke(
    { linkUrl: 'https://same.example.com:8443/other' },
    { id: 43, url: 'https://same.example.com:8443/source', title: 'Same origin' }
  );
  assert.equal(sameOriginLink.options.tabId, 43);

  const sameOriginSelection = await invoke(
    { selectionText: 'https://selected.example.com:8443/other' },
    { id: 44, url: 'https://selected.example.com:8443/source', title: 'Same origin' }
  );
  assert.equal(sameOriginSelection.options.tabId, 44);

  assert.deepEqual(requestedOrigins, [
    ['https://same.example.com:8443/*'],
    ['https://selected.example.com:8443/*'],
    ['https://same.example.com:8443/*'],
    ['https://selected.example.com:8443/*']
  ]);
});

test('background routes the explicit automatic Key action through the provision service', async () => {
  const calls = [];
  const app = loadBackground({
    globals: {
      saveSites: async (sites) => sites,
      createKeyProvisionService() {
        return {
          async ensureSiteKey(id, options) {
            calls.push([id, options]);
            return { ok: true, outcome: 'created', id };
          }
        };
      }
    }
  });

  const response = await app.dispatch({ type: 'ensureSiteKey', id: 'site-1', allowCreate: true });

  assert.equal(response.ok, true);
  assert.equal(response.outcome, 'created');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'site-1');
  assert.equal(calls[0][1]?.allowCreate, true);
});

test('redetectSite checks existing host access without requesting from the worker', async () => {
  const checked = [];
  const requested = [];
  let detectCalls = 0;
  const app = loadBackground({
    sites: [{ id: 'site-1', domain: 'example.com', pageUrl: 'https://example.com/', name: 'Ex' }],
    permissions: {
      contains(details, callback) {
        checked.push(details.origins);
        callback(true);
      },
      request(details, callback) {
        requested.push(details.origins);
        callback(true);
      }
    },
    globals: {
      detectSite: async () => {
        detectCalls += 1;
        return {
          ok: true,
          type: 'newapi',
          name: 'Ex',
          summary: 'ok',
          confidence: 'high',
          baseUrl: 'https://example.com',
          pageUrl: 'https://example.com/'
        };
      },
      applyDetectionToSite: (site, detection) => ({
        ...site,
        type: detection.type,
        name: detection.name || site.name
      })
    }
  });

  const response = await app.dispatch({ type: 'redetectSite', id: 'site-1' });
  assert.equal(response.ok, true);
  assert.equal(detectCalls, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(checked)), [['https://example.com/*']]);
  assert.deepEqual(requested, []);
});

test('redetectSite does not detect or request when host access is missing', async () => {
  let detectCalls = 0;
  let requestCalls = 0;
  const app = loadBackground({
    sites: [{ id: 'site-1', domain: 'example.com' }],
    permissions: {
      contains(_details, callback) { callback(false); },
      request() { requestCalls += 1; }
    },
    globals: {
      detectSite: async () => {
        detectCalls += 1;
        return { ok: true, type: 'newapi' };
      }
    }
  });

  const response = await app.dispatch({ type: 'redetectSite', id: 'site-1' });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'site_permission_required');
  assert.equal(detectCalls, 0);
  assert.equal(requestCalls, 0);
});

test('background detect refuses missing access without opening a permission prompt', async () => {
  const requested = [];
  const app = loadBackground({
    permissions: {
      contains(_details, callback) { callback(false); },
      request(details, callback) {
        requested.push(details.origins);
        callback(true);
      }
    },
    globals: {
      detectSite: async () => ({ ok: true, domain: 'example.com', type: 'newapi' })
    }
  });

  const response = await app.dispatch({ type: 'detectSite', input: 'https://example.com/path' });

  assert.equal(response.ok, false);
  assert.equal(response.code, 'site_permission_required');
  assert.deepEqual(requested, []);
});

test('page-session reading accepts both user and User storage conventions', () => {
  assert.match(backgroundSource, /localStorage\.getItem\('user'\)[\s\S]*?sessionStorage\.getItem\('user'\)[\s\S]*?localStorage\.getItem\('User'\)/);
  assert.match(backgroundSource, /canonicalOrigin[\s\S]*?if \(!canonicalOrigin\) return empty/);
});

test('page Key import stays bound to the selected tab and complete Origin', () => {
  const start = backgroundSource.indexOf("case 'importKeysFromPage'");
  const end = backgroundSource.indexOf('\n      default:', start);
  const source = backgroundSource.slice(start, end);
  assert.match(source, /readPageAuthSession\(site\.domain, siteOrigin\(site\), tabId\)/);
  assert.match(source, /persistScrapedKeys\([\s\S]*?site\.id,[\s\S]*?siteOrigin\(site\)/);
  assert.doesNotMatch(source, /persistScrapedKeys\([\s\S]*?site\.id,[\s\S]*?site\.domain,/);
});

test('automatic background Key import accepts only account-verified token API values', () => {
  const keyImportSource = fs.readFileSync(path.join(__dirname, '..', 'key-import.js'), 'utf8');
  const autoImport = keyImportSource.match(/async function tryAutoImportKeys\([^)]*\)\s*\{[\s\S]*?\n}/)?.[0];
  assert.ok(autoImport);
  assert.match(autoImport, /verifyNewApiTabAccount/);
  assert.match(autoImport, /const expectedOrigin\s*=\s*siteOriginFor\(site\)/);
  assert.match(autoImport, /verifyNewApiTabAccount\(session\.tabId, session, expectedOrigin\)/);
  assert.match(autoImport, /expectedOrigin/);
  assert.match(autoImport, /const keys = scraped\.trustedKeys \|\| \[\]/);
  assert.doesNotMatch(autoImport, /const keys = scraped\.keys/);
});

test('automatic Key wrappers bind every privileged tab operation to the stored site domain', () => {
  const keyImportSource = fs.readFileSync(path.join(__dirname, '..', 'key-import.js'), 'utf8');
  const start = keyImportSource.indexOf('const keyProvisionService');
  const end = keyImportSource.indexOf('async function ensureSiteKey', start);
  const provision = start >= 0 && end > start ? keyImportSource.slice(start, end) : '';
  assert.ok(provision, 'automatic Key provision service should exist');
  assert.match(provision, /verifyNewApiTabAccount\(tabId, session, siteOriginFor\(site\)\)/);
  assert.match(provision, /expectedOrigin:\s*siteOriginFor\(site\)/);
  assert.match(provision, /createTabApiKey\(tabId, site\.type \|\| 'auto'/);
  assert.match(provision, /preferUnlimitedAutoKey/);
  assert.match(provision, /remainQuota:\s*unlimitedQuota \? 0 : 5_000_000/);
});

test('background export only accepts explicit native and checkin formats', async () => {
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const calls = [];
  const app = loadBackground({
    globals: {
      buildExportConfig: (sites, options) => {
        calls.push(['native', sites, options]);
        return { native: true, redacted: options?.redactKeys === true };
      },
      buildCheckinExportConfig: (sites) => { calls.push(['checkin', sites]); return { checkin: true }; }
    }
  });

  assert.deepEqual(plain(await app.dispatch({ type: 'export', format: 'native' })), {
    ok: true, config: { native: true, redacted: false }, format: 'native', redacted: false
  });
  assert.deepEqual(plain(await app.dispatch({ type: 'export', format: 'native', redactKeys: true })), {
    ok: true, config: { native: true, redacted: true }, format: 'native', redacted: true
  });
  assert.deepEqual(plain(await app.dispatch({ type: 'export', format: 'checkin' })), {
    ok: true, config: { checkin: true }, format: 'checkin', redacted: false
  });
  for (const message of [{ type: 'export' }, { type: 'export', format: 'zip' }]) {
    assert.deepEqual(plain(await app.dispatch(message)), {
      ok: false,
      code: 'unsupported_export_format',
      error: '不支持的导出格式'
    });
  }
  assert.equal(calls[0][2]?.redactKeys, false);
  assert.equal(calls[1][2]?.redactKeys, true);
  assert.deepEqual(calls.map(([format]) => format), ['native', 'native', 'checkin']);
});

test('background serializes concurrent import requests', async () => {
  let active = 0;
  let maxConcurrent = 0;
  let releaseFirst;
  let signalFirstStarted;
  const firstStarted = new Promise((resolve) => { signalFirstStarted = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const runImport = async (sites) => {
        active += 1;
        maxConcurrent = Math.max(maxConcurrent, active);
        if (sites[0].id === 'first') {
          signalFirstStarted();
          await firstGate;
        }
        active -= 1;
        return sites;
  };
  const app = loadBackground({
    globals: {
      parseImportText: (text) => ({ sites: [{ id: text }], format: 'native' }),
      importSites: runImport,
      replaceSitesWithBackup: async (sites) => ({
        sites: await runImport(sites),
        backup: { id: 'backup-1', siteCount: 1 }
      })
    }
  });

  const first = app.dispatch({ type: 'import', text: 'first', mode: 'merge' });
  await firstStarted;
  const second = app.dispatch({ type: 'import', text: 'second', mode: 'replace' });
  releaseFirst();
  const responses = await Promise.all([first, second]);

  assert.equal(maxConcurrent, 1);
  assert.equal(responses[0].ok, true);
  assert.equal(responses[1].ok, true);
  assert.equal(responses[0].sites[0].id, 'first');
  assert.equal(responses[1].sites[0].id, 'second');
  assert.equal(responses[1].backup.id, 'backup-1');
});

test('background preserves site_operation_busy for single and batch deletion', async () => {
  const busyError = () => {
    const error = new Error('站点正在执行其他操作，请稍后再删除');
    error.code = 'site_operation_busy';
    return error;
  };
  const app = loadBackground({
    globals: {
      loadSites: async () => [{ id: 'site-1' }, { id: 'site-2' }],
      removeSiteById: async () => { throw busyError(); },
      removeSitesByIds: async () => { throw busyError(); }
    }
  });

  for (const message of [
    { type: 'removeSite', id: 'site-1' },
    { type: 'removeSites', ids: ['site-1', 'site-2'] }
  ]) {
    const response = await app.dispatch(message);
    assert.equal(response.ok, false);
    assert.equal(response.code, 'site_operation_busy');
    assert.match(response.error, /稍后再删除/);
  }
});

test('background replace import uses the atomic backup service', async () => {
  let atomicCalls = 0;
  let legacyCalls = 0;
  const app = loadBackground({
    globals: {
      parseImportText: () => ({
        sites: [{ id: 'replacement' }],
        format: 'native'
      }),
      importSites: async () => {
        legacyCalls += 1;
        return [];
      },
      replaceSitesWithBackup: async (sites) => {
        atomicCalls += 1;
        return {
          sites,
          backup: { id: 'backup-atomic', siteCount: 1 }
        };
      }
    }
  });

  const response = await app.dispatch({
    type: 'import',
    text: 'replacement',
    mode: 'replace'
  });

  assert.equal(response.ok, true);
  assert.equal(atomicCalls, 1);
  assert.equal(legacyCalls, 0);
  assert.equal(response.backup.id, 'backup-atomic');
});

test('background import queue continues after an earlier import throws', async () => {
  const calls = [];
  const app = loadBackground({
    globals: {
      parseImportText: (text) => ({ sites: [{ id: text }], format: 'native' }),
      importSites: async (sites) => {
        calls.push(sites[0].id);
        if (sites[0].id === 'first') throw new Error('first import failed');
        return sites;
      }
    }
  });

  const [first, second] = await Promise.all([
    app.dispatch({ type: 'import', text: 'first' }),
    app.dispatch({ type: 'import', text: 'second' })
  ]);

  assert.equal(first.ok, false);
  assert.match(first.error, /first import failed/);
  assert.equal(second.ok, true);
  assert.equal(second.sites[0].id, 'second');
  assert.deepEqual(calls, ['first', 'second']);
});

test('background import preview reports skipped and duplicate source entries', async () => {
  const app = loadBackground({
    sites: [{ id: 'current', domain: 'one.example.com' }],
    globals: {
      parseImportText: () => ({
        format: 'native',
        sourceCount: 4,
        skipped: 1,
        sites: [
          { id: 'one-a', domain: 'one.example.com' },
          { id: 'one-b', domain: 'one.example.com' },
          { id: 'two', domain: 'two.example.com' }
        ]
      })
    }
  });

  const response = await app.dispatch({ type: 'previewImport', text: '{}' });
  assert.equal(response.ok, true);
  assert.equal(response.sourceCount, 4);
  assert.equal(response.valid, 3);
  assert.equal(response.skipped, 1);
  assert.equal(response.duplicates, 1);
  assert.equal(response.incoming, 2);
  assert.equal(response.updating, 1);
  assert.equal(response.added, 1);
});

test('background import preview binds a site-data version and rejects stale commits', async () => {
  let importCalls = 0;
  let receivedOptions = null;
  const app = loadBackground({
    sites: [{ id: 'current', domain: 'one.example.com' }],
    globals: {
      loadSiteDataMeta: async () => ({ updatedAt: 42 }),
      parseImportText: () => ({
        format: 'native',
        sourceCount: 1,
        sites: [{ id: 'incoming', domain: 'two.example.com' }]
      }),
      importSites: async (sites, options) => {
        importCalls += 1;
        receivedOptions = options;
        return sites;
      }
    }
  });

  const preview = await app.dispatch({ type: 'previewImport', text: '{}' });
  assert.equal(preview.ok, true);
  assert.equal(preview.dataUpdatedAt, 42);

  const stale = await app.dispatch({
    type: 'import', text: '{}', mode: 'merge', previewUpdatedAt: 41
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'import_preview_stale');
  assert.equal(importCalls, 0);

  const committed = await app.dispatch({
    type: 'import', text: '{}', mode: 'merge', previewUpdatedAt: 42
  });
  assert.equal(committed.ok, true);
  assert.equal(receivedOptions.expectedUpdatedAt, 42);
});

test('background publishes per-site balance refresh progress and returns the final state', async () => {
  const updates = [];
  const app = loadBackground({
    sites: [
      { id: 'one', domain: 'one.example.com', name: 'One', type: 'newapi' },
      { id: 'two', domain: 'two.example.com', name: 'Two', type: 'newapi' }
    ],
    globals: {
      saveBalanceRefreshProgress: async (progress) => {
        updates.push({ ...progress });
        return progress;
      },
      fetchSiteBalance: async (site) => ({
        ok: site.id === 'one',
        balance: site.id === 'one' ? '$1.00' : null,
        usage: null,
        error: site.id === 'one' ? null : 'not logged in'
      }),
      saveSites: async (sites) => sites
    }
  });

  const response = await app.dispatch({ type: 'refreshAllBalances' });

  assert.equal(response.ok, true);
  assert.equal(response.progress.status, 'completed');
  assert.equal(response.progress.completed, 2);
  assert.equal(response.progress.succeeded, 1);
  assert.equal(response.progress.failed, 1);
  assert.equal(updates[0].status, 'running');
  assert.equal(updates.some((item) => item.currentSiteName === 'Two'), true);
  assert.equal(updates.at(-1).status, 'completed');
});

test('background grades balance failures and enforces per-site timeout', () => {
  const refreshSource = fs.readFileSync(path.join(__dirname, '..', 'balance-refresh.js'), 'utf8');
  assert.match(refreshSource, /SITE_BALANCE_TIMEOUT_MS\s*=\s*25000/);
  assert.match(refreshSource, /MAX_OWNED_TEMP_TABS\s*=\s*2/);
  assert.match(refreshSource, /function withTimeout\s*\(/);
  assert.match(refreshSource, /function classifySiteBalanceError\s*\(/);
  assert.match(refreshSource, /withTimeout\(\s*fetchSiteBalance/);
  assert.match(refreshSource, /async function refreshSiteBalance\s*\(/);
  assert.match(refreshSource, /async function retryFailedBalances\s*\(/);
  const keyImportSource = fs.readFileSync(path.join(__dirname, '..', 'key-import.js'), 'utf8');
  assert.match(keyImportSource, /recordBalanceFailure\(target, result\?\.error, result\?\.code\)/);
  assert.match(backgroundSource, /permissions\.js/);
  assert.match(backgroundSource, /site-tabs\.js/);
  assert.match(backgroundSource, /balance-refresh\.js/);
  assert.match(backgroundSource, /key-import\.js/);
  assert.doesNotMatch(backgroundSource, /async function refreshSiteBalance\s*\(/);
  assert.doesNotMatch(backgroundSource, /async function tryAutoImportKeys\s*\(/);
  assert.match(backgroundSource, /openFailedBalanceSites/);
  assert.match(backgroundSource, /tab-api-key\.js/);
  assert.match(backgroundSource, /page-scrape\.js/);
});

test('single-site balance fallback opens personal URLs on the saved explicit port', async () => {
  const created = [];
  const removed = [];
  const permissionChecks = [];
  const site = {
    id: 'port-site',
    domain: 'port.example.com',
    name: 'Port Site',
    type: 'newapi',
    baseUrl: 'https://port.example.com:8443',
    pageUrl: 'https://port.example.com:8443/console'
  };
  const sourceTab = {
    id: 7,
    url: 'https://port.example.com:8443/console',
    status: 'complete',
    active: true,
    currentWindow: true
  };

  const app = loadBackground({
    sites: [site],
    permissions: {
      contains(details, callback) {
        permissionChecks.push([...(details.origins || [])]);
        callback(true);
      },
      request() {
        throw new Error('balance worker must not request optional host access');
      }
    },
    tabs: {
      async query() { return [sourceTab]; },
      async get(tabId) {
        if (tabId === sourceTab.id) return sourceTab;
        return {
          id: tabId,
          url: created.find((entry) => entry.id === tabId)?.url || '',
          status: 'complete'
        };
      },
      async create({ url, active }) {
        const tab = { id: 100 + created.length, url, active, status: 'complete' };
        created.push(tab);
        return tab;
      },
      async remove(tabId) { removed.push(tabId); },
      onUpdated: { addListener() {}, removeListener() {} }
    },
    globals: {
      // Collapse retry sleeps while keeping the real hard-timeout timers dormant.
      setTimeout(callback, milliseconds) {
        if (Number(milliseconds) >= 10_000) return { milliseconds };
        queueMicrotask(callback);
        return { milliseconds };
      },
      clearTimeout() {},
      scrapeTabBalanceAndKeys: async () => ({
        ok: false,
        code: 'parse_failed',
        error: 'no balance field'
      }),
      fetchSiteBalance: async () => ({
        ok: false,
        code: 'parse_failed',
        error: 'no balance field'
      }),
      saveSites: async (sites) => sites
    }
  });

  const response = await app.dispatch({ type: 'refreshBalance', id: site.id });

  assert.equal(response.ok, false);
  assert.deepEqual(permissionChecks, [['https://port.example.com:8443/*']]);
  assert.equal(created.length, 1);
  assert.equal(created[0].url, 'https://port.example.com:8443/console/personal');
  assert.equal(created[0].url.startsWith('https://port.example.com/'), false);
  assert.ok(removed.includes(created[0].id));
});

test('retryFailedBalances only targets sites with failed balance status', async () => {
  const refreshed = [];
  const app = loadBackground({
    sites: [
      { id: 'ok', domain: 'ok.example.com', name: 'Ok', type: 'newapi', balanceStatus: { status: 'ok' } },
      { id: 'bad', domain: 'bad.example.com', name: 'Bad', type: 'newapi', balanceStatus: { status: 'failed' } },
      { id: 'never', domain: 'never.example.com', name: 'Never', type: 'newapi' }
    ],
    globals: {
      saveBalanceRefreshProgress: async (progress) => progress,
      fetchSiteBalance: async (site) => {
        refreshed.push(site.id);
        return { ok: true, balance: '$1.00', usage: null };
      },
      saveSites: async (sites) => sites,
      mutateSites: async (fn) => {
        const list = [
          { id: 'ok', domain: 'ok.example.com', name: 'Ok', type: 'newapi', balanceStatus: { status: 'ok' } },
          { id: 'bad', domain: 'bad.example.com', name: 'Bad', type: 'newapi', balanceStatus: { status: 'failed' } },
          { id: 'never', domain: 'never.example.com', name: 'Never', type: 'newapi' }
        ];
        await fn(list);
        return list;
      }
    }
  });

  const response = JSON.parse(JSON.stringify(await app.dispatch({ type: 'retryFailedBalances' })));
  assert.equal(response.ok, true);
  assert.deepEqual(refreshed, ['bad']);
  assert.match(response.message || '', /重试 1 个/);
});

test('background refuses permission mutation messages and never requests origins', async () => {
  const requested = [];
  const granted = new Set(['https://one.example.com/*']);
  const app = loadBackground({
    sites: [
      { id: 'one', domain: 'one.example.com', name: 'One' },
      {
        id: 'two',
        domain: 'two.example.com',
        baseUrl: 'https://two.example.com:8443',
        name: 'Two'
      }
    ],
    permissions: {
      contains(details, callback) {
        const origins = details.origins || [];
        callback(origins.every((origin) => granted.has(origin)));
      },
      request(details, callback) {
        const origins = details.origins || [];
        requested.push([...origins]);
        for (const origin of origins) granted.add(origin);
        callback(true);
      }
    }
  });

  const response = JSON.parse(JSON.stringify(await app.dispatch({ type: 'requestUnauthorizedSiteAccess' })));
  assert.equal(response.ok, false);
  assert.equal(response.code, 'foreground_permission_required');
  assert.deepEqual(requested, []);
});

test('getDiagnostics reports unauthorized site counts without requesting permission', async () => {
  const containsCalls = [];
  const app = loadBackground({
    sites: [
      { id: 'one', domain: 'one.example.com', name: 'One' },
      {
        id: 'two',
        domain: 'two.example.com',
        name: 'Two',
        balanceStatus: { status: 'failed', lastError: { code: 'not_logged_in', message: 'private' } }
      },
      {
        id: 'three',
        domain: 'three.example.com',
        name: 'Three',
        balanceStatus: { status: 'failed', lastError: { code: 'sk-private-code', message: 'private' } }
      }
    ],
    permissions: {
      contains(details, callback) {
        containsCalls.push(details.origins?.[0]);
        callback(details.origins?.[0] === 'https://one.example.com/*');
      },
      request(_details, callback) {
        // diagnostics must not request
        callback(false);
      }
    },
    globals: {
      loadSiteDataMeta: async () => ({ schemaVersion: 4, migratedAt: 1 }),
      isCompleteApiKey: () => true
    }
  });

  const response = await app.dispatch({ type: 'getDiagnostics' });
  const plain = JSON.parse(JSON.stringify(response));
  assert.equal(plain.ok, true);
  assert.equal(plain.diagnostics.siteCount, 3);
  assert.equal(plain.diagnostics.authorizedSiteCount, 1);
  assert.equal(plain.diagnostics.unauthorizedSiteCount, 2);
  assert.equal(plain.diagnostics.failedBalanceCount, 2);
  assert.deepEqual(plain.diagnostics.balanceErrorCodes, [
    { code: 'not_logged_in', count: 1 },
    { code: 'unknown', count: 1 }
  ]);
  assert.equal(plain.diagnostics.unauthorizedDomains, undefined);
  assert.equal(containsCalls.length, 3);
  assert.equal(containsCalls.includes('https://two.example.com/*'), true);
});

test('batch balance never requests in the worker and still processes already-authorized sites', async () => {
  const requested = [];
  const fetched = [];
  const app = loadBackground({
    sites: [
      { id: 'missing', domain: 'missing.example.com', name: 'Missing', type: 'newapi' },
      { id: 'granted', domain: 'granted.example.com', name: 'Granted', type: 'newapi' }
    ],
    permissions: {
      contains(details, callback) {
        const origin = details.origins?.[0] || '';
        callback(origin === 'https://granted.example.com/*');
      },
      request(details) {
        requested.push(details.origins?.[0]);
        throw new Error('service worker must never request optional host access');
      }
    },
    globals: {
      saveBalanceRefreshProgress: async (progress) => progress,
      fetchSiteBalance: async (site) => {
        fetched.push(site.id);
        return { ok: true, balance: '$1.00', usage: null };
      },
      saveSites: async (sites) => sites
    }
  });

  const response = await app.dispatch({ type: 'refreshAllBalances' });
  const plain = JSON.parse(JSON.stringify(response));

  assert.equal(plain.ok, true);
  assert.deepEqual(fetched, ['granted']);
  assert.deepEqual(requested, []);
  assert.equal(plain.results.filter((row) => row.ok).length, 1);
  assert.equal(plain.results.filter((row) => row.skipped).length, 1);
  assert.equal(plain.results.find((row) => row.id === 'missing').code, 'site_permission_required');
  assert.equal(plain.progress.succeeded, 1);
  assert.equal(plain.progress.skipped, 1);
  assert.equal(plain.progress.failed, 0);
});

test('background shares one in-flight full balance refresh', async () => {
  let calls = 0;
  let release;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const app = loadBackground({
    sites: [{ id: 'one', domain: 'one.example.com', name: 'One', type: 'newapi' }],
    globals: {
      saveBalanceRefreshProgress: async (progress) => progress,
      fetchSiteBalance: async () => {
        calls += 1;
        signalStarted();
        await gate;
        return { ok: true, balance: '$1.00', usage: null };
      },
      saveSites: async (sites) => sites
    }
  });

  const first = app.dispatch({ type: 'refreshAllBalances' });
  await started;
  const second = app.dispatch({ type: 'refreshAllBalances' });
  release();
  const [one, two] = await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.equal(one.progress.status, 'completed');
  assert.equal(two.progress.status, 'completed');
});

test('background stops a shared balance refresh after the current site and preserves pending work', async () => {
  let progress = { status: 'idle', total: 0, completed: 0, succeeded: 0, failed: 0 };
  const fetched = [];
  let releaseFirst;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const app = loadBackground({
    sites: [
      { id: 'one', domain: 'one.example.com', name: 'One', type: 'newapi' },
      { id: 'two', domain: 'two.example.com', name: 'Two', type: 'newapi' },
      { id: 'three', domain: 'three.example.com', name: 'Three', type: 'newapi' }
    ],
    globals: {
      loadBalanceRefreshProgress: async () => progress,
      saveBalanceRefreshProgress: async (next) => {
        progress = { ...next };
        return progress;
      },
      fetchSiteBalance: async (site) => {
        fetched.push(site.id);
        if (site.id === 'one') {
          signalStarted();
          await gate;
        }
        return { ok: true, balance: '$1.00', usage: null };
      },
      saveSites: async (sites) => sites
    }
  });

  const first = app.dispatch({ type: 'refreshAllBalances' });
  await started;
  const second = app.dispatch({ type: 'refreshAllBalances' });
  const runId = progress.runId;
  assert.match(runId, /^balance_/);

  const stop = await app.dispatch({ type: 'stopBalanceRefresh', runId });
  assert.equal(stop.ok, true);
  assert.equal(stop.accepted, true);
  assert.equal(stop.progress.status, 'stopping');
  assert.deepEqual(fetched, ['one']);

  releaseFirst();
  const [one, two] = await Promise.all([first, second]);
  for (const result of [one, two]) {
    assert.equal(result.ok, true);
    assert.equal(result.stopped, true);
    assert.equal(result.progress.status, 'stopped');
    assert.equal(result.progress.completed, 1);
    assert.equal(result.progress.succeeded, 1);
    assert.equal(result.progress.failed, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(result.progress.pendingSiteIds)), ['two', 'three']);
  }
  assert.deepEqual(fetched, ['one']);
});

test('a balance persistence failure produces exactly one failed result', async () => {
  let persistCalls = 0;
  const app = loadBackground({
    sites: [{ id: 'one', domain: 'one.example.com', name: 'One', type: 'newapi' }],
    globals: {
      console: { log() {}, warn() {}, error() {} },
      saveBalanceRefreshProgress: async (progress) => progress,
      fetchSiteBalance: async () => ({ ok: true, balance: '$1.00', usage: null }),
      mutateSites: async () => {
        persistCalls += 1;
        throw new Error('storage unavailable');
      },
      saveSites: async (sites) => sites
    }
  });
  const response = await app.dispatch({ type: 'refreshAllBalances' });
  assert.equal(response.ok, true);
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].id, 'one');
  assert.equal(response.results[0].ok, false);
  assert.equal(response.results[0].code, 'balance_persist_failed');
  assert.equal(response.progress.completed, 1);
  assert.equal(response.progress.succeeded, 0);
  assert.equal(response.progress.failed, 1);
  assert.equal(persistCalls, 1);
});

test('explicit balance refresh counts missing site ids as skipped', async () => {
  const app = loadBackground({
    sites: [{ id: 'one', domain: 'one.example.com', name: 'One', type: 'newapi' }],
    globals: {
      saveBalanceRefreshProgress: async (progress) => progress,
      fetchSiteBalance: async () => ({ ok: true, balance: '$1.00', usage: null }),
      saveSites: async (sites) => sites
    }
  });
  const response = await app.dispatch({
    type: 'refreshAllBalances',
    siteIds: ['one', 'gone']
  });
  assert.equal(response.ok, true);
  assert.equal(response.results.length, 1);
  assert.equal(response.progress.total, 2);
  assert.equal(response.progress.completed, 2);
  assert.equal(response.progress.succeeded, 1);
  assert.equal(response.progress.failed, 0);
  assert.equal(response.progress.skipped, 1);
});

test('a stale stop run id cannot stop the next balance refresh', async () => {
  let progress = { status: 'idle', total: 0, completed: 0, succeeded: 0, failed: 0 };
  const gates = [];
  const starts = [];
  const fetched = [];
  const app = loadBackground({
    sites: [
      { id: 'one', domain: 'one.example.com', name: 'One', type: 'newapi' },
      { id: 'two', domain: 'two.example.com', name: 'Two', type: 'newapi' }
    ],
    globals: {
      loadBalanceRefreshProgress: async () => progress,
      saveBalanceRefreshProgress: async (next) => {
        progress = { ...next };
        return progress;
      },
      fetchSiteBalance: async (site) => {
        fetched.push(site.id);
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        gates.push(release);
        starts.shift()?.();
        await gate;
        return { ok: true, balance: '$1.00', usage: null };
      },
      saveSites: async (sites) => sites
    }
  });

  const waitForStart = () => new Promise((resolve) => starts.push(resolve));
  const firstStarted = waitForStart();
  const first = app.dispatch({ type: 'refreshAllBalances' });
  await firstStarted;
  const oldRunId = progress.runId;
  await app.dispatch({ type: 'stopBalanceRefresh', runId: oldRunId });
  gates.shift()();
  const stopped = await first;
  assert.equal(stopped.progress.status, 'stopped');

  const secondStarted = waitForStart();
  const second = app.dispatch({ type: 'refreshAllBalances' });
  await secondStarted;
  const newRunId = progress.runId;
  assert.notEqual(newRunId, oldRunId);
  const stale = await app.dispatch({ type: 'stopBalanceRefresh', runId: oldRunId });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'balance_refresh_run_mismatch');
  assert.equal(stale.activeRunId, newRunId);
  gates.shift()();
  const completed = await second;
  assert.equal(completed.progress.status, 'completed');
  assert.deepEqual(fetched, ['one', 'two']);
});

test('stopping with no active balance refresh is an idempotent no-op', async () => {
  const app = loadBackground({
    globals: {
      loadBalanceRefreshProgress: async () => ({
        status: 'completed', total: 2, completed: 2, succeeded: 2, failed: 0
      })
    }
  });
  const response = await app.dispatch({ type: 'stopBalanceRefresh', runId: 'old-run' });
  assert.equal(response.ok, true);
  assert.equal(response.accepted, false);
  assert.equal(response.code, 'balance_refresh_not_running');
  assert.equal(response.progress.status, 'completed');
});

test('a worker restart converts an unfinished stopping state to interrupted', async () => {
  let progress = {
    status: 'stopping',
    runId: 'old-run',
    total: 3,
    completed: 1,
    succeeded: 1,
    failed: 0,
    pendingSiteIds: ['two', 'three']
  };
  const app = loadBackground({
    globals: {
      loadBalanceRefreshProgress: async () => progress,
      saveBalanceRefreshProgress: async (next) => {
        progress = { ...next };
        return progress;
      }
    }
  });
  const response = await app.dispatch({ type: 'getBalanceRefreshProgress' });
  assert.equal(response.ok, true);
  assert.equal(response.progress.status, 'interrupted');
  assert.deepEqual(JSON.parse(JSON.stringify(response.progress.pendingSiteIds)), ['two', 'three']);
});

test('failed-only retry does not attach to an active full refresh', async () => {
  let release;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const app = loadBackground({
    sites: [{
      id: 'failed',
      domain: 'failed.example.com',
      name: 'Failed',
      type: 'newapi',
      balanceStatus: { status: 'failed' }
    }],
    globals: {
      saveBalanceRefreshProgress: async (progress) => progress,
      fetchSiteBalance: async () => {
        signalStarted();
        await gate;
        return { ok: true, balance: '$1.00', usage: null };
      },
      saveSites: async (sites) => sites
    }
  });

  const full = app.dispatch({ type: 'refreshAllBalances' });
  await started;
  const retryPromise = app.dispatch({ type: 'retryFailedBalances' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  const retry = await retryPromise;

  assert.equal(retry.ok, false);
  assert.equal(retry.code, 'balance_refresh_busy');
  assert.equal(retry.activeScope.kind, 'all');

  await full;
});

test('background resumes only the pending sites after an interrupted balance refresh', async () => {
  let progress = {
    status: 'interrupted', total: 2, completed: 1, succeeded: 1, failed: 0,
    pendingSiteIds: ['two'], startedAt: 100
  };
  const refreshed = [];
  const app = loadBackground({
    sites: [
      { id: 'one', domain: 'one.example.com', name: 'One', type: 'newapi' },
      { id: 'two', domain: 'two.example.com', name: 'Two', type: 'newapi' }
    ],
    globals: {
      loadBalanceRefreshProgress: async () => progress,
      saveBalanceRefreshProgress: async (next) => {
        progress = { ...next };
        return progress;
      },
      fetchSiteBalance: async (site) => {
        refreshed.push(site.id);
        return { ok: true, balance: '$1.00', usage: null };
      },
      saveSites: async (sites) => sites
    }
  });

  const response = await app.dispatch({ type: 'refreshAllBalances' });

  assert.deepEqual(refreshed, ['two']);
  assert.equal(response.progress.status, 'completed');
  assert.equal(response.progress.completed, 2);
  assert.equal(response.progress.succeeded, 2);
});

test('updateSite remains local even if old check-in preferences are present', async () => {
  const app = loadBackground({ prefs: { autoSyncCheckin: true } });

  const response = await app.dispatch({
    type: 'updateSite',
    id: 'site-1',
    patch: { name: '更新名称' }
  });

  assert.equal(response.ok, true);
  assert.equal(response.checkin, null);
  assert.deepEqual(app.events, ['update']);
  assert.equal(app.actionCalls.length, 0);
});

test('updateSite skips auto-sync when the preference is off or the saved site is not opted in', async () => {
  const preferenceOff = loadBackground({ prefs: { autoSyncCheckin: false } });
  const offResponse = await preferenceOff.dispatch({
    type: 'updateSite', id: 'site-1', patch: { name: 'A' }
  });
  assert.equal(offResponse.checkin, null);
  assert.equal(preferenceOff.actionCalls.length, 0);

  const notOptedIn = loadBackground({
    prefs: { autoSyncCheckin: true },
    sites: [{ id: 'site-2', checkinOptIn: false }]
  });
  const optInResponse = await notOptedIn.dispatch({
    type: 'updateSite', id: 'site-2', patch: { name: 'B' }
  });
  assert.equal(optInResponse.checkin, null);
  assert.equal(notOptedIn.actionCalls.length, 0);
});

test('detectAndSave stays local even for sites saved with legacy opt-in data', async () => {
  const stored = [{
    id: 'detected-1',
    domain: 'example.com',
    name: 'Example',
    checkinOptIn: true
  }];
  const app = loadBackground({
    prefs: { autoSyncCheckin: true },
    globals: {
      detectSite: async () => ({
        ok: true,
        domain: 'example.com',
        name: 'Example',
        baseUrl: 'https://example.com',
        pageUrl: 'https://example.com/',
        type: 'newapi'
      }),
      normalizeSite: (site) => ({ ...site, id: 'detected-1' }),
      upsertSite: async () => stored,
      loadSites: async () => stored
    }
  });

  const response = await app.dispatch({
    type: 'detectAndSave',
    input: 'https://example.com',
    category: 'gongyi'
  });

  assert.equal(response.ok, true);
  assert.equal(response.checkin, null);
  assert.equal(app.actionCalls.length, 0);
});

test('batch add rejects credential-bearing requests before touching any site', async () => {
  let detections = 0;
  let writes = 0;
  const app = loadBackground({
    globals: {
      detectSite: async () => {
        detections += 1;
        return { ok: false };
      },
      upsertSite: async () => {
        writes += 1;
        return [];
      }
    }
  });

  for (const credential of [
    { key: 'sk-single-site-secret-123' },
    { keys: [{ name: '默认', key: 'sk-array-secret-123' }] },
    { apiKey: 'sk-legacy-secret-123' },
    { token: 'sk-token-secret-123' }
  ]) {
    const response = await app.dispatch({
      type: 'batchDetectAndSave',
      text: 'https://a.example.com\nhttps://b.example.com',
      ...credential
    });
    assert.equal(response.ok, false);
    assert.equal(response.code, 'batch_key_not_allowed');
  }

  assert.equal(detections, 0);
  assert.equal(writes, 0);
});

test('batch add without credentials saves every site with an empty key list', async () => {
  const sites = [];
  const writes = [];
  let keyImportCalls = 0;
  const app = loadBackground({
    sites,
    globals: {
      detectSite: async (input) => {
        const url = new URL(input);
        return {
          ok: true,
          domain: url.hostname,
          name: url.hostname,
          baseUrl: url.origin,
          pageUrl: url.origin,
          type: 'newapi',
          summary: '已识别'
        };
      },
      upsertSite: async (partial) => {
        writes.push(partial);
        sites.push({ ...partial, id: `site-${sites.length + 1}` });
        return sites;
      }
    }
  });
  app.context.tryAutoImportKeys = async () => {
    keyImportCalls += 1;
    return { added: 1 };
  };

  const response = await app.dispatch({
    type: 'batchDetectAndSave',
    text: 'https://a.example.com\nhttps://b.example.com'
  });

  assert.equal(response.ok, true);
  assert.equal(response.okCount, 2);
  assert.equal(writes.length, 2);
  assert.equal(writes.every((site) => Array.isArray(site.keys) && site.keys.length === 0), true);
  assert.equal(keyImportCalls, 0, 'batch add must never scan or import site credentials');
});

test('detectAndSave leaves legacy check-in data untouched without invoking the other extension', async () => {
  const memory = {
    sites: [],
    prefs: { autoSyncCheckin: true, defaultCategory: 'gongyi' }
  };
  const syncCalls = [];
  let listener;
  let context;
  const chrome = {
    storage: {
      local: {
        get(_keys, callback) { callback({ ...memory }); },
        set(patch, callback) {
          Object.assign(memory, patch);
          callback();
        }
      }
    },
    contextMenus: {
      create() {},
      removeAll(callback) { callback(); },
      onClicked: { addListener() {} }
    },
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener(fn) { listener = fn; } }
    },
    tabs: { query: async () => [], create: async () => ({}) }
  };
  context = vm.createContext({
    URL,
    console,
    setTimeout,
    clearTimeout,
    chrome,
    detectSite: async () => ({
      ok: true,
      domain: 'example.com',
      name: 'Changed Name',
      baseUrl: 'https://example.com',
      pageUrl: 'https://example.com/new-page',
      type: 'sub2api'
    }),
    handleCheckinAction: async (action, message) => {
      syncCalls.push([action, message]);
      return { ok: true, action };
    }
  });
  context.importScripts = (...files) => {
    for (const file of files) {
      if (file === 'site-utils.js' || file === 'storage.js' || file === 'permissions.js' || file === 'site-tabs.js') {
        const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        vm.runInContext(source, context, { filename: file });
      }
    }
  };
  vm.runInContext(backgroundSource, context, { filename: 'background.js' });

  const base = context.normalizeSite({
    id: 'existing-1',
    domain: 'example.com',
    name: 'Original Name',
    type: 'newapi',
    category: 'gongyi',
    checkinOptIn: true,
    syncedToCheckinAt: 1000
  });
  memory.sites = [context.normalizeSite({
    ...base,
    checkinSync: {
      status: 'verified',
      fingerprint: context.checkinFingerprint(base),
      lastSuccessAt: 1000,
      lastVerifiedAt: 1000
    }
  })];

  const response = await new Promise((resolve) => {
    listener({
      type: 'detectAndSave',
      input: 'https://example.com',
      category: 'gongyi'
    }, {}, resolve);
  });

  assert.equal(response.ok, true);
  assert.equal(response.site.checkinOptIn, true);
  assert.notEqual(response.site.checkinSync.status, 'idle');
  assert.equal(response.checkin, null);
  assert.equal(syncCalls.length, 0);
});

test('real script loading no longer boots checkin-sync; status is standalone', async () => {
  const imported = [];
  const retained = [];
  let listener;
  let context;
  const realScripts = new Set([
    'site-utils.js', 'permissions.js', 'site-tabs.js', 'balance-format.js', 'page-scrape.js', 'tab-api-key.js',
    'balance.js', 'storage.js', 'detect.js', 'balance-refresh.js', 'bridge.js', 'key-provision.js', 'key-import.js'
  ]);
  const chrome = {
    storage: {
      local: {
        get(_keys, callback) {
          callback({
            sites: [],
            checkinSyncMeta: { lastRunAt: 456, failed: 1 }
          });
        },
        set(_data, callback) { callback(); }
      }
    },
    management: { getAll: async () => [] },
    contextMenus: {
      create() {},
      removeAll(callback) { callback(); },
      onClicked: { addListener() {} }
    },
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener(fn) { listener = fn; } }
    },
    tabs: { query: async () => [], create: async () => ({}) }
  };
  context = vm.createContext({ URL, console, setTimeout, clearTimeout, chrome });
  context.importScripts = (...files) => {
    for (const file of files) {
      imported.push(file);
      if (realScripts.has(file)) {
        const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        vm.runInContext(source, context, { filename: file });
      }
    }
  };

  vm.runInContext(backgroundSource, context, { filename: 'background.js' });

  assert.equal(imported.includes('bridge.js'), false);
  assert.equal(imported.includes('checkin-sync.js'), false);
  assert.equal(typeof context.handleCheckinAction, 'undefined');
  const realOrder = [
    'site-utils.js', 'permissions.js', 'site-tabs.js', 'balance-format.js', 'page-scrape.js', 'tab-api-key.js',
    'balance.js', 'storage.js', 'detect.js', 'balance-refresh.js', 'key-provision.js', 'key-import.js'
  ].map((file) => imported.indexOf(file));
  assert.equal(realOrder.every((index) => index >= 0), true);
  assert.deepEqual([...realOrder].sort((a, b) => a - b), realOrder);
  assert.ok(imported.indexOf('detect.js') < imported.indexOf('balance-refresh.js'));
  assert.ok(imported.indexOf('key-provision.js') < imported.indexOf('key-import.js'));
  const response = await new Promise((resolve) => {
    retained.push(listener({ type: 'getCheckinStatus' }, {}, resolve));
  });
  assert.equal(retained[0], true);
  assert.equal(response.ok, true);
  assert.equal(response.standalone, true);
  assert.equal(response.connection.code, 'checkin_standalone');
  assert.equal(response.meta, null);
});

test('getCheckinStatus is standalone and does not load check-in transport metadata', async () => {
  const app = loadBackground();

  const response = await app.dispatch({ type: 'getCheckinStatus' });
  assert.equal(response.ok, true);
  assert.equal(response.standalone, true);
  assert.equal(response.connection.ok, false);
  assert.equal(response.connection.code, 'checkin_standalone');
  assert.equal(response.meta, null);
});

test('disabling checkin opt-in only updates local mark under standalone mode', async () => {
  const app = loadBackground();

  const response = await app.dispatch({
    type: 'setCheckinOptIn',
    id: 'site-1',
    value: false
  });

  assert.equal(app.updates.length, 1);
  assert.equal(app.updates[0][0], 'site-1');
  assert.equal(app.updates[0][1].checkinOptIn, false);
  assert.equal(response.ok, true);
  assert.equal(response.standalone, true);
  assert.match(response.warning, /签到已独立|不会同步/);
});
