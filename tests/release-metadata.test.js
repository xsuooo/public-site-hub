const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const manifest = require('../manifest.json');
const pkg = require('../package.json');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');

function read(relativePath) {
  return fs.readFileSync(path.join(root, ...relativePath.split('/')), 'utf8');
}

test('release versions expose SemVer RC identity and Chrome numeric ordering', () => {
  assert.equal(pkg.version, '1.0.0-rc.3');
  assert.equal(manifest.version_name, '1.0.0-rc.3');
  assert.equal(manifest.version, '0.99.0.3');
});

test('Chrome manifest versions strictly increase from every RC to final', () => {
  const parts = (version) => version.split('.').map(Number).concat([0, 0, 0, 0]).slice(0, 4);
  const compare = (left, right) => {
    const a = parts(left);
    const b = parts(right);
    for (let index = 0; index < 4; index += 1) {
      if (a[index] !== b[index]) return a[index] - b[index];
    }
    return 0;
  };

  assert.ok(compare('0.99.0.1', '0.99.0.2') < 0);
  assert.ok(compare('0.99.0.2', '0.99.0.3') < 0);
  assert.ok(compare('0.99.0.3', '1.0.0') < 0);
});

test('release metadata preserves identity, least host access and executable gates', () => {
  assert.equal(manifest.name, '公益站收藏');
  assert.deepEqual(manifest.permissions, [
    'storage',
    'alarms',
    'tabs',
    'activeTab',
    'scripting',
    'contextMenus'
  ]);
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*']);
  assert.equal(pkg.name, 'public-site-hub');
  assert.equal(pkg.scripts.test, 'node --test tests/*.test.js');
  assert.equal(pkg.scripts['test:coverage'],
    'node --test --experimental-test-coverage tests/*.test.js');
  assert.equal(pkg.scripts['verify:syntax'], 'node scripts/check-js.js');
  assert.equal(pkg.scripts.build, 'node scripts/build-extension.js');
  assert.equal(pkg.scripts['verify:package'], 'node scripts/verify-package.js');
  assert.equal(pkg.scripts['verify:runtime'], 'node scripts/smoke-extension.js');
  assert.equal(pkg.scripts['verify:ui'],
    'npm run build && playwright test --config=playwright.config.js --workers=1');
  assert.match(pkg.devDependencies['@playwright/test'], /^\^1\./);
  assert.equal(pkg.scripts['release:artifact'], 'node scripts/package-release.js');
  assert.match(ci, /npm run verify:syntax/);
  assert.match(ci, /npm run test:coverage/);
  assert.match(ci, /playwright install --with-deps chromium/);
  assert.match(ci, /verify:runtime -- --browser=chromium/);
  assert.match(ci, /PUBLIC_SITE_HUB_BROWSER:\s*chromium/);
  assert.match(ci, /npm run verify:ui/);
});

test('README documents permissions, local-only data and zero-telemetry RC boundaries', () => {
  for (const pattern of [
    /1\.0\.0-rc\.3/,
    /`storage`：[^\n]*chrome\.storage\.local/,
    /`alarms`：[^\n]*恢复快照/,
    /`tabs`：[^\n]*(?:读取|创建)[^\n]*标签页/,
    /不申请 `cookies` 权限[^\n]*目标站标签页/,
    /`activeTab`：[^\n]*用户点击/,
    /`scripting`：[^\n]*用户发起/,
    /`contextMenus`：[^\n]*右键/,
    /可选 HTTPS 主机权限：[^\n]*Origin/,
    /完整导出[^\n]*完整 Key/,
    /存储配额[^\n]*不会部分覆盖/,
    /没有遥测/,
    /(?:不得|不要)(?:使用|用)生产账号或生产 Key/
  ]) {
    assert.match(readme, pattern);
  }
});

test('README uses reproducible commands and only relative dist paths', () => {
  for (const command of [
    'npm test',
    'npm run test:coverage',
    'npm run verify:syntax',
    'npm run build',
    'npm run verify:package',
    'npm run verify:runtime',
    'npm run verify:ui'
  ]) {
    assert.match(readme, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(readme, /相对路径 `dist\/`/);
  assert.doesNotMatch(readme, /[A-Z]:\\/i);
  assert.match(readme, /复制接口地址[^\n]*https:\/\/example\.invalid\/v1/);
  assert.match(readme, /复制 Key[^\n]*单独/);
});

test('generated packages, profiles, inputs and external attestations stay out of Git', () => {
  for (const pattern of [
    /^dist\/$/m,
    /^uploads\/$/m,
    /^release-artifacts\/$/m,
    /^\.playwright\/$/m,
    /^\*\.zip$/m,
    /^\*\.sha256$/m,
    /^\.env$/m,
    /^\*\.pem$/m,
    /^\*\.key$/m
  ]) {
    assert.match(gitignore, pattern);
  }
});

test('RC docs keep only the local fixture helper; no paper acceptance pack', () => {
  const rcDir = path.join(root, 'docs', 'rc');
  const names = fs.readdirSync(rcDir).sort();
  assert.deepEqual(names, ['local-newapi-fixture.md']);

  const fixture = read('docs/rc/local-newapi-fixture.md');
  assert.match(fixture, /npm run rc:fixture/);
  assert.match(fixture, /127\.0\.0\.1:4173[1-4]/);
  assert.match(fixture, /不使用任何外部账号/);

  assert.equal(fs.existsSync(path.join(rcDir, 'rc-3-acceptance.md')), false);
  assert.equal(fs.existsSync(path.join(rcDir, 'rc-3-release-record.md')), false);
  assert.equal(fs.existsSync(path.join(rcDir, 'immutable-release-policy.md')), false);

  assert.match(readme, /release:artifact/);
  assert.match(readme, /local-newapi-fixture\.md/);
  assert.doesNotMatch(readme, /rc-3-acceptance\.md/);
  assert.doesNotMatch(readme, /问题台账/);
});
