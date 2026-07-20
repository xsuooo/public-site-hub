const assert = require('node:assert/strict');
const test = require('node:test');

const utils = require('../site-utils.js');
Object.assign(globalThis, utils);
const balance = require('../balance.js');
const detect = require('../detect.js');

test('openUrlForSite always returns domain root', () => {
  const site = utils.normalizeSite({
    domain: 'www.cctq.ai',
    pageUrl: 'https://www.cctq.ai/console/personal',
    baseUrl: 'https://www.cctq.ai'
  });
  assert.equal(utils.openUrlForSite(site), 'https://www.cctq.ai/');
  // normalizeSite 应滤掉 personal 深链
  assert.ok(!/personal/i.test(site.pageUrl));
});

test('site origins preserve explicit ports while dropping query secrets', () => {
  const site = utils.normalizeSite({
    domain: 'port.example.com',
    baseUrl: 'https://port.example.com:8443/?token=secret',
    pageUrl: 'https://port.example.com:8443/user?code=secret#private',
    type: 'newapi'
  });
  assert.equal(site.baseUrl, 'https://port.example.com:8443');
  assert.equal(site.pageUrl, 'https://port.example.com:8443/user');
  assert.equal(utils.openUrlForSite(site), 'https://port.example.com:8443/');
  assert.equal(utils.tokenPageUrlForSite(site), 'https://port.example.com:8443/console/token');
});

test('API base formatting preserves an explicit HTTPS port', () => {
  const site = utils.normalizeSite({
    domain: 'api.example.com',
    baseUrl: 'https://api.example.com:8443',
    pageUrl: 'https://api.example.com:8443/console'
  });
  assert.equal(utils.originForSite(site), 'https://api.example.com:8443');
  assert.equal(utils.formatApiBaseV1(site), 'https://api.example.com:8443/v1');
});

test('tokenPageUrlForSite for newapi', () => {
  const site = utils.normalizeSite({ domain: 'a.example.com', type: 'newapi' });
  assert.equal(utils.tokenPageUrlForSite(site), 'https://a.example.com/console/token');
});

test('formatBalanceValue uses custom quotaPerUnit', () => {
  // unit=1 → quota 直接当美元
  assert.equal(balance.formatBalanceValue(12.5, 'quota', 1), '$12.50');
  // 默认 500000
  assert.equal(balance.formatBalanceValue(500000, 'quota'), '$1.00');
  assert.equal(balance.formatBalanceValue(1000000, 'quota', 500000), '$2.00');
});

test('sanitize huge balance with wrong unit', () => {
  // 错误单位导致超大时回退标准单位
  const huge = balance.formatBalanceValue(500000 * 2, 'quota', 1);
  // unit=1 会给出 $1000000.00 → 应被纠偏到默认单位 $2.00 或合理值
  assert.ok(huge.startsWith('$'));
  const n = Number(huge.replace(/[$¥￥,]/g, ''));
  assert.ok(n <= 100000, `expected sane balance, got ${huge}`);
});

test('isSuspiciousBalance', () => {
  assert.equal(balance.isSuspiciousBalance('$12.50'), false);
  assert.equal(balance.isSuspiciousBalance('$100008542.06'), true);
  assert.equal(balance.isSuspiciousBalance('无限'), false);
});

test('extractQuotaMeta from status', () => {
  const meta = detect.extractQuotaMeta({ quota_per_unit: 500000, display_in_currency: true });
  assert.equal(meta.quotaPerUnit, 500000);
  assert.equal(meta.displayInCurrency, true);
});

test('pageUrlForType does not force personal', () => {
  const url = detect.pageUrlForType('a.example.com', 'newapi', null);
  assert.equal(url, 'https://a.example.com/');
  const safe = detect.pageUrlForType(
    'a.example.com',
    'newapi',
    'https://a.example.com/console/personal'
  );
  assert.equal(safe, 'https://a.example.com/');
});

test('normalizeSite stores quotaPerUnit', () => {
  const site = utils.normalizeSite({
    domain: 'b.example.com',
    quotaPerUnit: 500000
  });
  assert.equal(site.quotaPerUnit, 500000);
});

test('cleanTokenName drops placeholder names', () => {
  assert.equal(utils.cleanTokenName('页面导入'), '');
  assert.equal(utils.cleanTokenName('claude'), 'claude');
  assert.equal(utils.cleanTokenName('cc'), 'cc');
});

test('normalizeKey prefers real token names', () => {
  const k = utils.normalizeKey({ name: 'claude', key: 'sk-abcdefghijklmnopqrstuvwxyz' });
  assert.equal(k.name, 'claude');
  const bad = utils.normalizeKey({ name: '页面导入', key: 'sk-abcdefghijklmnopqrstuvwxyz' });
  assert.equal(bad.name, '令牌');
});

test('extractTokenList nested items shape (logic mirror)', () => {
  // 与 balance inject 内 extractTokenList 一致的解析约定
  function extractTokenList(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    const d = payload.data;
    if (Array.isArray(d)) return d;
    if (d && typeof d === 'object') {
      if (Array.isArray(d.items)) return d.items;
      if (Array.isArray(d.records)) return d.records;
      if (Array.isArray(d.list)) return d.list;
    }
    return [];
  }
  const list = extractTokenList({
    success: true,
    data: {
      page: 1,
      items: [
        { name: 'claude', key: 'sk-aaaabbbbccccddddeeee' },
        { name: 'cc', key: 'sk-ffffgggghhhhiiiijjjj' }
      ]
    }
  });
  assert.equal(list.length, 2);
  assert.equal(list[0].name, 'claude');
  assert.equal(list[1].name, 'cc');
});

test('checkin: any category can opt-in; unmarked not eligible', () => {
  const relay = utils.normalizeSite({ domain: 'r.example.com', category: 'relay', checkinOptIn: true });
  assert.equal(relay.checkinOptIn, true);
  assert.equal(utils.isCheckinEligible(relay), true);

  const gongyi = utils.normalizeSite({ domain: 'g.example.com', category: 'gongyi' });
  assert.equal(gongyi.checkinOptIn, false);
  assert.equal(utils.isCheckinEligible(gongyi), false);
  assert.equal(utils.isCheckinEligible(gongyi, { requireOptIn: false }), true);

  const marked = utils.normalizeSite({ domain: 'm.example.com', category: 'gongyi', checkinOptIn: true });
  assert.equal(marked.checkinOptIn, true);
  assert.equal(utils.isCheckinEligible(marked), true);
});

test('filterSitesByTag and collectSiteTags', () => {
  const sites = [
    utils.normalizeSite({ domain: 'a.example.com', tags: ['稳定', 'claude'] }),
    utils.normalizeSite({ domain: 'b.example.com', tags: ['claude'] }),
    utils.normalizeSite({ domain: 'c.example.com', tags: [] })
  ];
  assert.equal(utils.filterSitesByTag(sites, 'claude').length, 2);
  assert.equal(utils.filterSites(sites, { tag: '稳定' }).length, 1);
  const tags = utils.collectSiteTags(sites);
  assert.equal(tags[0].tag, 'claude');
  assert.equal(tags[0].count, 2);
});
