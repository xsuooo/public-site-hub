const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'balance-refresh.js'), 'utf8');

test('balance fallback reads auth session from the selected tab', () => {
  assert.match(source, /readPageAuthSession\(site\.domain, siteOrigin\(site\), tabId\)/);
  assert.match(source, /const session = tabId\s*\?\s*await readPageAuthSession\(site\.domain, siteOrigin\(site\), tabId\)/);
});

function makeHarness({ onEnsureTab, failFirstLoad = false } = {}) {
  const sites = [{
    id: 'site-one',
    domain: 'one.example.com',
    baseUrl: 'https://one.example.com',
    pageUrl: 'https://one.example.com/',
    name: 'One',
    type: 'newapi',
    keys: []
  }];
  let progress = { status: 'idle', total: 0, completed: 0, succeeded: 0, failed: 0 };
  let fetchCalls = 0;
  let scrapeCalls = 0;
  let remainingLoadFailures = failFirstLoad ? 1 : 0;
  let releaseFetch;
  let fetchStarted;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  const started = new Promise((resolve) => { fetchStarted = resolve; });

  const origin = (value) => {
    const raw = value && typeof value === 'object'
      ? (value.baseUrl || value.pageUrl || value.domain)
      : value;
    const url = new URL(/^https:\/\//i.test(String(raw || '')) ? raw : `https://${raw}`);
    return url.origin.toLowerCase();
  };
  const context = {
    URL,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    siteIdentity: origin,
    siteOrigin: origin,
    loadSites: async () => {
      if (remainingLoadFailures > 0) {
        remainingLoadFailures -= 1;
        throw new Error('storage unavailable');
      }
      return sites.map((site) => ({ ...site, keys: [...site.keys] }));
    },
    ensureAccessForSite: async () => ({ ok: true }),
    ensureSiteTab: async (site) => {
      onEnsureTab?.(site, sites);
      return { tabId: 11, temporary: false };
    },
    closeTabSafe: async () => undefined,
    readPageAuthSession: async () => ({}),
    personalUrls: () => ['https://one.example.com/'],
    detectSite: async () => ({ ok: false }),
    scrapeTabBalanceAndKeys: async () => {
      scrapeCalls += 1;
      return { ok: false, code: 'parse_failed', error: 'no balance field' };
    },
    fetchSiteBalance: async () => {
      fetchCalls += 1;
      fetchStarted();
      await fetchGate;
      return { ok: true, balance: '$1.00', usage: null, via: 'test' };
    },
    persistBalanceResult: async (site, result) => {
      const target = sites.find((item) => item.id === site.id);
      if (!target) return null;
      if (result.ok) target.balance = result.balance;
      return target;
    },
    loadBalanceRefreshProgress: async () => progress,
    saveBalanceRefreshProgress: async (next) => {
      progress = { ...next };
      return progress;
    },
    classifyBalanceError: (error, code) => ({
      code: code || 'refresh_failed',
      message: String(error || 'failed'),
      action: 'open_site'
    }),
    isSuspiciousBalance: () => false
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'balance-refresh.js' });
  return {
    context,
    sites,
    started,
    releaseFetch,
    get fetchCalls() { return fetchCalls; },
    get scrapeCalls() { return scrapeCalls; }
  };
}

test('single and batch refresh share one in-flight request per site', async () => {
  const harness = makeHarness();
  const batch = harness.context.refreshAllBalances();
  await harness.started;

  const single = harness.context.refreshSiteBalance('site-one');
  assert.equal(harness.fetchCalls, 1);

  harness.releaseFetch();
  const [batchResult, singleResult] = await Promise.all([batch, single]);
  assert.equal(batchResult.ok, true);
  assert.equal(singleResult.ok, true);
  assert.equal(harness.fetchCalls, 1);
  assert.equal(harness.sites[0].balance, '$1.00');
});

test('a deleted site is rechecked before the next network request', async () => {
  const harness = makeHarness({
    onEnsureTab: (_site, sites) => { sites.splice(0, 1); }
  });

  const result = await harness.context.refreshSiteBalance('site-one');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'site_not_found');
  assert.equal(harness.fetchCalls, 0);
  assert.equal(harness.scrapeCalls, 0);
});

test('a failed claim clears the site flight so a later retry can run', async () => {
  const harness = makeHarness({ failFirstLoad: true });

  const failed = await harness.context.coordinateSiteBalanceRefresh(
    'site-one',
    async () => ({ ok: true })
  );
  assert.equal(failed.ok, false);

  const retried = await harness.context.coordinateSiteBalanceRefresh(
    'site-one',
    async () => ({ ok: true, retried: true })
  );
  assert.equal(retried.ok, true);
  assert.equal(retried.retried, true);
});
