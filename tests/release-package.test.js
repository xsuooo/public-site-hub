const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const {
  RUNTIME_FILES,
  buildExtension,
  assertSafeOutputDirectory
} = require('../scripts/build-extension.js');
const {
  inspectRgbaPng,
  assertSourceParity,
  verifyPackage
} = require('../scripts/verify-package.js');

function listFiles(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(dir, entry.name);
      return entry.isDirectory()
        ? listFiles(absolutePath, relativePath)
        : [relativePath];
    })
    .sort();
}

test('128px icon is RGBA and has visible pixels', () => {
  const icon = inspectRgbaPng(path.join(root, 'icons', 'icon128.png'));

  assert.deepEqual(
    { width: icon.width, height: icon.height },
    { width: 128, height: 128 }
  );
  assert.ok(icon.nonTransparentPixels > 0);
});

test('PNG inspection rejects corrupted chunk data or checksums', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'public-site-hub-png-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const corruptIcon = Buffer.from(
    fs.readFileSync(path.join(root, 'icons', 'icon128.png'))
  );
  const ihdrCrcOffset = 8 + 4 + 4 + 13;
  corruptIcon[ihdrCrcOffset] ^= 0x01;
  const corruptPath = path.join(tempRoot, 'corrupt.png');
  fs.writeFileSync(corruptPath, corruptIcon);

  assert.throws(
    () => inspectRgbaPng(corruptPath),
    /PNG CRC mismatch: IHDR/
  );
});

test('dist contains exactly the runtime whitelist', (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'public-site-hub-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));

  buildExtension(out);

  const files = listFiles(out);
  assert.deepEqual(files, [...RUNTIME_FILES].sort());
  assert.equal(files.some((file) =>
    /^(uploads|tests|scripts|docs)\//.test(file)), false);
  assert.equal(files.includes('bridge.js'), false);
  assert.equal(files.includes('checkin-sync.js'), false);
});

test('source parity rejects a stale runtime file after source changes', (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'public-site-hub-parity-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));

  buildExtension(out);
  assert.doesNotThrow(() => assertSourceParity(out, [...RUNTIME_FILES]));
  fs.appendFileSync(path.join(out, 'popup.js'), '\n// stale package fixture\n');
  assert.throws(
    () => assertSourceParity(out, [...RUNTIME_FILES]),
    /stale runtime file.*popup\.js/
  );
});

test('build output is restricted to dist or an isolated temporary directory', (t) => {
  const temporaryOutput = fs.mkdtempSync(path.join(os.tmpdir(), 'public-site-hub-safe-'));
  t.after(() => fs.rmSync(temporaryOutput, { recursive: true, force: true }));

  assert.equal(typeof assertSafeOutputDirectory, 'function');
  assert.doesNotThrow(() => assertSafeOutputDirectory(path.join(root, 'dist')));
  assert.doesNotThrow(() => assertSafeOutputDirectory(temporaryOutput));
  assert.throws(
    () => assertSafeOutputDirectory(path.join(root, 'icons')),
    /unsafe output directory/
  );
  assert.throws(
    () => assertSafeOutputDirectory(path.dirname(root)),
    /unsafe output directory/
  );
  assert.throws(
    () => assertSafeOutputDirectory(os.tmpdir()),
    /unsafe output directory/
  );
});

test('build output rejects a temporary path that crosses a symbolic link', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'public-site-hub-link-'));
  const linkPath = path.join(tempRoot, 'source-link');
  t.after(() => {
    const linkStat = fs.lstatSync(linkPath, { throwIfNoEntry: false });
    if (linkStat?.isSymbolicLink()) fs.unlinkSync(linkPath);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  fs.symlinkSync(root, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(
    () => assertSafeOutputDirectory(path.join(linkPath, 'icons')),
    /unsafe output directory.*symbolic link/
  );
});

test('package verifier accepts the whitelist and rejects extra runtime files', (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'public-site-hub-verify-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));

  buildExtension(out);
  assert.doesNotThrow(() => verifyPackage(out));

  fs.writeFileSync(path.join(out, 'bridge.js'), '// dormant module\n');
  assert.throws(
    () => verifyPackage(out),
    /unexpected runtime file: bridge\.js/
  );
});

test('package verifier checks manifest, HTML and service worker references', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'public-site-hub-refs-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const manifestOut = path.join(tempRoot, 'manifest');
  buildExtension(manifestOut);
  const manifestPath = path.join(manifestOut, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.action.default_popup = 'missing-popup.html';
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  assert.throws(
    () => verifyPackage(manifestOut),
    /missing referenced file: manifest\.json -> missing-popup\.html/
  );

  const caseOut = path.join(tempRoot, 'case');
  buildExtension(caseOut);
  const caseManifestPath = path.join(caseOut, 'manifest.json');
  const caseManifest = JSON.parse(fs.readFileSync(caseManifestPath, 'utf8'));
  caseManifest.action.default_popup = 'Popup.html';
  fs.writeFileSync(caseManifestPath, `${JSON.stringify(caseManifest)}\n`);
  assert.throws(
    () => verifyPackage(caseOut),
    /missing referenced file: manifest\.json -> Popup\.html/
  );

  const htmlOut = path.join(tempRoot, 'html');
  buildExtension(htmlOut);
  fs.appendFileSync(path.join(htmlOut, 'popup.html'),
    '\n<script src="missing-ui.js"></script>\n');
  assert.throws(
    () => verifyPackage(htmlOut),
    /missing referenced file: popup\.html -> missing-ui\.js/
  );

  const workerOut = path.join(tempRoot, 'worker');
  buildExtension(workerOut);
  fs.appendFileSync(path.join(workerOut, 'background.js'),
    "\nimportScripts('missing-runtime.js');\n");
  assert.throws(
    () => verifyPackage(workerOut),
    /missing referenced file: background\.js -> missing-runtime\.js/
  );

  const remoteManifestOut = path.join(tempRoot, 'remote-manifest');
  buildExtension(remoteManifestOut);
  const remoteManifestPath = path.join(remoteManifestOut, 'manifest.json');
  const remoteManifest = JSON.parse(fs.readFileSync(remoteManifestPath, 'utf8'));
  remoteManifest.background.service_worker = 'https://cdn.example/worker.js';
  fs.writeFileSync(remoteManifestPath, `${JSON.stringify(remoteManifest)}\n`);
  assert.throws(
    () => verifyPackage(remoteManifestOut),
    /external package reference is not allowed: manifest\.json/
  );

  const remoteHtmlOut = path.join(tempRoot, 'remote-html');
  buildExtension(remoteHtmlOut);
  fs.appendFileSync(path.join(remoteHtmlOut, 'popup.html'),
    '\n<script src="https://cdn.example/ui.js"></script>\n');
  assert.throws(
    () => verifyPackage(remoteHtmlOut),
    /external package reference is not allowed: popup\.html/
  );

  const dataWorkerOut = path.join(tempRoot, 'data-worker');
  buildExtension(dataWorkerOut);
  fs.appendFileSync(path.join(dataWorkerOut, 'background.js'),
    "\nimportScripts('data:text/javascript,noop');\n");
  assert.throws(
    () => verifyPackage(dataWorkerOut),
    /external package reference is not allowed: background\.js/
  );
});

test('package verifier requires MV3 entry points and complete icon maps', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'public-site-hub-manifest-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const cases = [
    ['manifest-version', (manifest) => { manifest.manifest_version = 2; },
      /manifest_version must be 3/],
    ['worker', (manifest) => { delete manifest.background.service_worker; },
      /missing manifest field: background\.service_worker/],
    ['popup', (manifest) => { delete manifest.action.default_popup; },
      /missing manifest field: action\.default_popup/],
    ['options', (manifest) => { delete manifest.options_page; },
      /missing manifest field: options_page/],
    ['manifest-icon', (manifest) => { delete manifest.icons['128']; },
      /missing manifest field: icons\.128/],
    ['action-icon', (manifest) => { delete manifest.action.default_icon['48']; },
      /missing manifest field: action\.default_icon\.48/]
  ];

  for (const [name, mutate, expectedError] of cases) {
    const out = path.join(tempRoot, name);
    buildExtension(out);
    const manifestPath = path.join(out, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    mutate(manifest);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    assert.throws(() => verifyPackage(out), expectedError);
  }
});
