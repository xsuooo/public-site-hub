const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const config = fs.readFileSync(path.join(root, 'playwright.config.js'), 'utf8');
const spec = fs.readFileSync(path.join(root, 'tests', 'ui-e2e.spec.js'), 'utf8');

test('Playwright UI gate is isolated, single-worker, and covers the approved scenario matrix', () => {
  assert.match(config, /testMatch:\s*['"]ui-e2e\.spec\.js['"]/);
  assert.match(config, /workers:\s*1/);
  assert.match(config, /fullyParallel:\s*false/);
  for (const scenario of ['empty', 'single', 'mixed', 'hundred']) {
    assert.match(spec, new RegExp(`launchScenario\\(['"]${scenario}['"]\\)`));
  }
  assert.match(spec, /worker\.url\(\)\.match/);
  assert.match(spec, /unable to derive extension ID/);
  assert.match(spec, /PROFILE_PREFIX = ['"]public-site-hub-ui-e2e-/);
  assert.match(spec, /chrome\.storage\.local\.clear/);
  assert.match(spec, /prefers-color-scheme: dark/);
  assert.match(spec, /setViewportSize\(\{ width: 614, height: 819 \}\)/);
  assert.match(spec, /assertNoHorizontalOverflow/);
  assert.match(spec, /keyboard\.press\(['"]Escape['"]\)/);
});
