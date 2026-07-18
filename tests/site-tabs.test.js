const assert = require('node:assert/strict');
const test = require('node:test');

const created = [];
globalThis.chrome = {
  tabs: {
    async query() { return []; },
    async create({ url, active }) {
      created.push({ url, active });
      return { id: created.length, url };
    },
    async remove() {},
    onUpdated: { addListener() {}, removeListener() {} },
    async get() { return { status: 'complete' }; }
  }
};

const siteTabs = require('../site-tabs.js');

test('personalUrls covers common console personal paths', () => {
  const urls = siteTabs.personalUrls('api.example.com');
  assert.ok(urls.some((u) => u.includes('/console/personal')));
  assert.ok(urls.some((u) => u.endsWith('api.example.com/')));
});

test('personalUrls preserves an explicit HTTPS sibling port', () => {
  const urls = siteTabs.personalUrls({
    domain: 'api.example.com',
    baseUrl: 'https://api.example.com:8443'
  });
  assert.ok(urls.length > 0);
  assert.equal(urls.every((url) => url.startsWith('https://api.example.com:8443/')), true);
});

test('findTabForDomain fails closed for an invalid expected Origin', async () => {
  const previousQuery = globalThis.chrome.tabs.query;
  globalThis.chrome.tabs.query = async () => [{ id: 7, url: 'https://api.example.com/' }];
  try {
    assert.equal(await siteTabs.findTabForDomain('api.example.com', {
      expectedOrigin: 'http://api.example.com'
    }), null);
  } finally {
    globalThis.chrome.tabs.query = previousQuery;
  }
});

test('openFailedBalanceSites only opens failed sites and respects limit', async () => {
  created.length = 0;
  const sites = [
    { id: 'ok', domain: 'ok.example.com', balanceStatus: { status: 'ok' } },
    { id: 'bad1', domain: 'bad1.example.com', balanceStatus: { status: 'failed' } },
    { id: 'bad2', domain: 'bad2.example.com', balanceStatus: { status: 'failed' } },
    { id: 'bad3', domain: 'bad3.example.com', balanceStatus: { status: 'failed' } }
  ];
  const result = await siteTabs.openFailedBalanceSites(sites, { limit: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.opened, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.total, 3);
  assert.deepEqual(created.map((c) => c.url), [
    'https://bad1.example.com/',
    'https://bad2.example.com/'
  ]);
  assert.equal(created[0].active, true);
  assert.equal(created[1].active, false);
});

test('openFailedBalanceSites can filter not_logged_in failures only', async () => {
  created.length = 0;
  const sites = [
    {
      id: 'login',
      domain: 'login.example.com',
      balanceStatus: { status: 'failed', lastError: { code: 'not_logged_in', message: '未登录' } }
    },
    {
      id: 'parse',
      domain: 'parse.example.com',
      balanceStatus: { status: 'failed', lastError: { code: 'parse_failed', message: '未解析' } }
    }
  ];
  const result = await siteTabs.openFailedBalanceSites(sites, { reason: 'not_logged_in' });
  assert.equal(result.opened, 1);
  assert.equal(result.total, 1);
  assert.deepEqual(created.map((c) => c.url), ['https://login.example.com/']);
});

test('openFailedBalanceSites reports empty when none failed', async () => {
  created.length = 0;
  const result = await siteTabs.openFailedBalanceSites([
    { id: 'ok', domain: 'ok.example.com', balanceStatus: { status: 'ok' } }
  ]);
  assert.equal(result.opened, 0);
  assert.equal(result.total, 0);
  assert.equal(created.length, 0);
});
