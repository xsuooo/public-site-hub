const assert = require('node:assert/strict');
const test = require('node:test');
const utils = require('../site-utils.js');

test('normalizeCategory maps chinese and english', () => {
  assert.equal(utils.normalizeCategory('中转站'), 'relay');
  assert.equal(utils.normalizeCategory('公益站'), 'gongyi');
  assert.equal(utils.normalizeCategory('relay'), 'relay');
  assert.equal(utils.normalizeCategory(''), 'gongyi');
});

test('normalizeSite stores category', () => {
  const a = utils.normalizeSite({ domain: 'a.example.com', category: 'relay' });
  assert.equal(a.category, 'relay');
  const b = utils.normalizeSite({ domain: 'b.example.com' });
  assert.equal(b.category, 'gongyi');
});

test('filterSitesByCategory and filterSites', () => {
  const sites = [
    utils.normalizeSite({ domain: 'g.example.com', category: 'gongyi', name: 'G' }),
    utils.normalizeSite({ domain: 'r.example.com', category: 'relay', name: 'R' })
  ];
  assert.equal(utils.filterSitesByCategory(sites, 'gongyi').length, 1);
  assert.equal(utils.filterSitesByCategory(sites, 'relay')[0].domain, 'r.example.com');
  assert.equal(utils.filterSites(sites, { category: 'all', query: 'r.example' }).length, 1);
  assert.equal(utils.filterSites(sites, { category: 'gongyi', query: 'r.example' }).length, 0);
});

test('categoryLabel', () => {
  assert.equal(utils.categoryLabel('relay'), '中转站');
  assert.equal(utils.categoryLabel('gongyi'), '公益站');
});

test('normalizeSite stores deduplicated tags and search matches them', () => {
  const site = utils.normalizeSite({
    domain: 'tagged.example.com',
    tags: '常用, Claude，常用, 低价'
  });
  assert.deepEqual(site.tags, ['常用', 'Claude', '低价']);
  assert.equal(utils.filterSitesByQuery([site], 'claude').length, 1);
});
