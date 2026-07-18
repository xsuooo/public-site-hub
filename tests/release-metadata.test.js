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

function read(relativePath) {
  return fs.readFileSync(path.join(root, ...relativePath.split('/')), 'utf8');
}

test('release versions expose SemVer RC identity and Chrome numeric ordering', () => {
  assert.equal(pkg.version, '1.0.0-rc.1');
  assert.equal(manifest.version_name, '1.0.0-rc.1');
  assert.equal(manifest.version, '0.99.0.1');
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
  assert.ok(compare('0.99.0.2', '1.0.0') < 0);
});

test('release metadata preserves identity, least host access and executable gates', () => {
  assert.equal(manifest.name, '公益站收藏');
  assert.deepEqual(manifest.permissions, [
    'storage',
    'tabs',
    'cookies',
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
  assert.equal(pkg.scripts.build, 'node scripts/build-extension.js');
  assert.equal(pkg.scripts['verify:package'], 'node scripts/verify-package.js');
  assert.equal(pkg.scripts['verify:runtime'], 'node scripts/smoke-extension.js');
  assert.equal(pkg.scripts['release:artifact'], 'node scripts/package-release.js');
});

test('README documents permissions, local-only data and zero-telemetry RC boundaries', () => {
  for (const pattern of [
    /1\.0\.0-rc\.1/,
    /`storage`：[^\n]*chrome\.storage\.local/,
    /`tabs`：[^\n]*(?:读取|创建)[^\n]*标签页/,
    /`cookies`：[^\n]*登录会话/,
    /`activeTab`：[^\n]*用户点击/,
    /`scripting`：[^\n]*用户发起/,
    /`contextMenus`：[^\n]*右键/,
    /可选 HTTPS 主机权限：[^\n]*Origin/,
    /完整导出[^\n]*完整 Key/,
    /没有遥测/,
    /不得使用生产账号或生产 Key/
  ]) {
    assert.match(readme, pattern);
  }
});

test('README uses reproducible commands and only relative dist paths', () => {
  for (const command of [
    'npm test',
    'npm run test:coverage',
    'npm run build',
    'npm run verify:package',
    'npm run verify:runtime'
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

test('RC documentation fixes immutable artifacts, two-person matrix and release gates', () => {
  const overview = read('docs/rc/README.md');
  const matrix = read('docs/rc/rc-1-test-matrix.md');
  const acceptance = read('docs/rc/rc-1-acceptance.md');
  const policy = read('docs/rc/immutable-release-policy.md');
  const cleanup = read('docs/rc/credential-cleanup.md');

  for (const pattern of [
    /v1\.0\.0-rc\.1/,
    /public-site-hub-1\.0\.0-rc\.1\.zip/,
    /SHA-256/,
    /Chrome Stable/,
    /Edge Stable/,
    /两人/,
    /五天/,
    /P0、P1 和阻断型 P2 均为零/
  ]) {
    assert.match(overview, pattern);
  }
  assert.match(matrix, /测试者 A[\s\S]*Chrome[\s\S]*测试者 B[\s\S]*Edge/);
  assert.match(acceptance, /可再次从用户手势重试/);
  assert.match(acceptance, /批量刷新显示进度，并可手动请求停止/);
  assert.match(policy, /(?:永不覆盖|不覆盖)/);
  assert.match(cleanup, /撤销[\s\S]*Key/);
  assert.match(overview, /外部 attestation/);
  assert.match(overview, /注释标签/);
  assert.match(overview, /标签后的记录提交/);
  assert.match(overview, /Edge\/Chromium[\s\S]*Chrome Stable 和 Edge Stable[\s\S]*手工/);
  assert.doesNotMatch(changelog, /自动冒烟通过/);
  assert.match(changelog, /自动冒烟必须通过/);
  assert.match(changelog, /两名测试者必须[\s\S]*并完成五天交叉浏览器验收/);
});

test('superseded 2.x verification documents are archived with explicit banners', () => {
  const legacyEntry = read('docs/runtime-verification-1.0.md');
  assert.match(legacyEntry, /由 `1\.0\.0-rc\.1` 验收流程接管/);
  assert.match(legacyEntry, /rc\/README\.md/);

  for (const version of ['2.2.0', '2.3.0', '2.3.2']) {
    const archived = read(`docs/archive/runtime-verification-${version}.md`);
    assert.match(archived, /已取代/);
    assert.equal(fs.existsSync(path.join(root, 'docs', `runtime-verification-${version}.md`)), false);
  }
});
