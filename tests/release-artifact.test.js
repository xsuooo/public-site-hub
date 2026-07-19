const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const packageJson = require('../package.json');
const manifest = require('../manifest.json');
const { RUNTIME_FILES, buildExtension } = require('../scripts/build-extension.js');
const {
  FIXED_DOS_DATE,
  FIXED_DOS_TIME,
  createReleaseArtifacts,
  inspectDeterministicZip,
  validateReleaseIdentity
} = require('../scripts/package-release.js');

function temporaryDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const provenance = Object.freeze({
  tag: 'v1.0.0-rc.2',
  commit: '1'.repeat(40),
  tree: '2'.repeat(40)
});

test('release identity keeps user and Chrome versions separate', () => {
  assert.deepEqual(validateReleaseIdentity(packageJson, manifest), {
    packageName: 'public-site-hub',
    packageVersion: '1.0.0-rc.2',
    manifestVersion: '0.99.0.2',
    tag: 'v1.0.0-rc.2',
    baseName: 'public-site-hub-1.0.0-rc.2'
  });
  assert.equal(FIXED_DOS_TIME, 0);
  assert.equal(FIXED_DOS_DATE, 0x0021);
});

test('release ZIP, sidecar and attestation are deterministic with a root manifest', (t) => {
  const packageA = temporaryDirectory(t, 'public-site-hub-release-package-a-');
  const packageB = temporaryDirectory(t, 'public-site-hub-release-package-b-');
  const outputA = temporaryDirectory(t, 'public-site-hub-release-output-a-');
  const outputB = temporaryDirectory(t, 'public-site-hub-release-output-b-');
  buildExtension(packageA);
  buildExtension(packageB);

  const first = createReleaseArtifacts({
    packageDir: packageA,
    outputDir: outputA,
    packageJson,
    manifest,
    provenance
  });
  const second = createReleaseArtifacts({
    packageDir: packageB,
    outputDir: outputB,
    packageJson,
    manifest,
    provenance
  });

  const firstZip = fs.readFileSync(first.zipPath);
  const secondZip = fs.readFileSync(second.zipPath);
  assert.deepEqual(firstZip, secondZip);
  assert.equal(first.zipSha256, second.zipSha256);
  assert.equal(first.attestationSha256, second.attestationSha256);

  const entries = inspectDeterministicZip(firstZip);
  const expectedPaths = [...RUNTIME_FILES]
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  assert.deepEqual(entries.map((entry) => entry.path), expectedPaths);
  assert.equal(entries[expectedPaths.indexOf('manifest.json')].data.toString('utf8'),
    fs.readFileSync(path.join(packageA, 'manifest.json'), 'utf8'));

  const zipName = path.basename(first.zipPath);
  assert.equal(fs.readFileSync(first.sha256Path, 'utf8'),
    `${first.zipSha256}  ${zipName}\n`);
  const attestation = JSON.parse(fs.readFileSync(first.attestationPath, 'utf8'));
  assert.deepEqual(attestation.source, provenance);
  assert.equal(attestation.artifact.zip, zipName);
  assert.equal(attestation.artifact.sha256, first.zipSha256);
  assert.equal(attestation.artifact.entryCount, RUNTIME_FILES.length);
  assert.deepEqual(attestation.artifact.entries, expectedPaths);
  assert.equal(attestation.reproducibility.entryTimestamp, '1980-01-01T00:00:00Z');
  assert.equal(attestation.reproducibility.compression, 'store');
});

test('release artifacts are immutable and never silently overwritten', (t) => {
  const packageDir = temporaryDirectory(t, 'public-site-hub-release-package-');
  const outputDir = temporaryDirectory(t, 'public-site-hub-release-output-');
  buildExtension(packageDir);
  createReleaseArtifacts({ packageDir, outputDir, packageJson, manifest, provenance });

  assert.throws(
    () => createReleaseArtifacts({ packageDir, outputDir, packageJson, manifest, provenance }),
    /refusing to overwrite immutable release artifact/
  );
});

test('release artifact provenance must match the versioned tag', (t) => {
  const packageDir = temporaryDirectory(t, 'public-site-hub-release-package-');
  const outputDir = temporaryDirectory(t, 'public-site-hub-release-output-');
  buildExtension(packageDir);

  assert.throws(
    () => createReleaseArtifacts({
      packageDir,
      outputDir,
      packageJson,
      manifest,
      provenance: { ...provenance, tag: 'v1.0.0-rc.1' }
    }),
    /provenance tag must be v1\.0\.0-rc\.2/
  );
});

test('release artifacts cannot be written into the runtime package', (t) => {
  const packageDir = temporaryDirectory(t, 'public-site-hub-release-package-');
  buildExtension(packageDir);

  assert.throws(
    () => createReleaseArtifacts({
      packageDir,
      outputDir: path.join(packageDir, 'release-artifacts'),
      packageJson,
      manifest,
      provenance
    }),
    /cannot be written inside the extension package/
  );
});

test('attestation identity must match the manifest inside the ZIP', (t) => {
  const packageDir = temporaryDirectory(t, 'public-site-hub-release-package-');
  const outputDir = temporaryDirectory(t, 'public-site-hub-release-output-');
  buildExtension(packageDir);

  assert.throws(
    () => createReleaseArtifacts({
      packageDir,
      outputDir,
      packageJson,
      manifest: { ...manifest, version: '0.99.0.1' },
      provenance
    }),
    /packaged manifest identity differs/
  );
});
