const assert = require('node:assert/strict');
const test = require('node:test');

const utils = require('../site-utils.js');
Object.assign(globalThis, utils);
const bridge = require('../bridge.js');

test('toCheckinSite maps hub site to checkin shape without leaking deep URL paths', () => {
  const site = utils.normalizeSite({
    domain: 'a.example.com',
    name: 'Alpha',
    pageUrl: 'https://a.example.com/console/sk-path-secret?token=sk-query-secret',
    type: 'newapi'
  });
  const mapped = bridge.toCheckinSite(site);
  assert.equal(mapped.domain, 'a.example.com');
  assert.equal(mapped.name, 'Alpha');
  assert.equal(mapped.type, 'newapi');
  assert.equal(mapped.mode, 'checkin');
  assert.equal(mapped.enabled, true);
  assert.equal(mapped.pageUrl, 'https://a.example.com/');
  assert.doesNotMatch(JSON.stringify(mapped), /sk-path-secret|sk-query-secret/);
});

test('formatClientSnippet is domain /v1 only', () => {
  const site = utils.normalizeSite({
    domain: 'a.example.com',
    name: 'A',
    apiKey: 'sk-abc'
  });
  const text = bridge.formatClientSnippet(site);
  assert.equal(text, 'https://a.example.com/v1');
  assert.doesNotMatch(text, /sk-abc|Base:|Key:/i);
});

test('detectionNeedsHelp for low confidence and unknown', () => {
  assert.equal(bridge.detectionNeedsHelp({ ok: true, type: 'newapi', confidence: 'high' }), false);
  assert.equal(bridge.detectionNeedsHelp({ ok: true, detectedType: 'unknown', confidence: 'low' }), true);
  assert.equal(bridge.detectionNeedsHelp({ ok: false }), true);
  assert.equal(bridge.detectionNeedsHelp(null), true);
});

test('formatDetectionPanel returns kinds', () => {
  const ok = bridge.formatDetectionPanel({
    ok: true,
    summary: '识别为 NewAPI（高置信）',
    type: 'newapi',
    typeLabel: 'NewAPI',
    confidence: 'high',
    signals: ['net:/api/status']
  }, { domain: 'a.com' });
  assert.equal(ok.kind, 'ok');

  const bad = bridge.formatDetectionPanel({ ok: false, error: '超时' }, null);
  assert.equal(bad.kind, 'err');
  assert.equal(bad.needsHelp, true);
});
