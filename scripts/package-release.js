#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { RUNTIME_FILES, buildExtension } = require('./build-extension.js');
const { verifyPackage } = require('./verify-package.js');

const ROOT = path.resolve(__dirname, '..');
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = 0x0021; // 1980-01-01, the earliest portable ZIP date.
const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;
const CRC32_TABLE = new Uint32Array(256);

for (let value = 0; value < CRC32_TABLE.length; value += 1) {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  CRC32_TABLE[value] = crc >>> 0;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function comparePortablePaths(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function assertPortableEntryPath(relativePath) {
  assert(typeof relativePath === 'string' && relativePath.length > 0,
    'ZIP entry path must be a non-empty string');
  assert(!relativePath.includes('\\'), `ZIP entry path must use forward slashes: ${relativePath}`);
  assert(!path.posix.isAbsolute(relativePath), `ZIP entry path must be relative: ${relativePath}`);
  assert(path.posix.normalize(relativePath) === relativePath &&
    relativePath !== '..' && !relativePath.startsWith('../'),
  `ZIP entry path escapes the archive root: ${relativePath}`);
  assert(!relativePath.endsWith('/'), `ZIP directory entries are not allowed: ${relativePath}`);
}

function readEntries(packageDir, relativePaths = RUNTIME_FILES) {
  const seen = new Set();
  const orderedPaths = [...relativePaths].sort(comparePortablePaths);
  return orderedPaths.map((relativePath) => {
    assertPortableEntryPath(relativePath);
    assert(!seen.has(relativePath), `duplicate ZIP entry: ${relativePath}`);
    seen.add(relativePath);
    const absolutePath = path.join(packageDir, ...relativePath.split('/'));
    assert(fs.statSync(absolutePath, { throwIfNoEntry: false })?.isFile(),
      `release entry is missing: ${relativePath}`);
    const data = fs.readFileSync(absolutePath);
    assert(data.length <= MAX_UINT32, `release entry is too large for ZIP32: ${relativePath}`);
    return {
      path: relativePath,
      name: Buffer.from(relativePath, 'utf8'),
      data,
      crc: crc32(data)
    };
  });
}

function createDeterministicZip(packageDir, relativePaths = RUNTIME_FILES) {
  const entries = readEntries(packageDir, relativePaths);
  assert(entries.length <= MAX_UINT16, 'too many release entries for ZIP32');

  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    assert(entry.name.length <= MAX_UINT16, `ZIP entry name is too long: ${entry.path}`);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(UTF8_FLAG, 6);
    localHeader.writeUInt16LE(STORE_METHOD, 8);
    localHeader.writeUInt16LE(FIXED_DOS_TIME, 10);
    localHeader.writeUInt16LE(FIXED_DOS_DATE, 12);
    localHeader.writeUInt32LE(entry.crc, 14);
    localHeader.writeUInt32LE(entry.data.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(entry.name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, entry.name, entry.data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4); // Unix creator, ZIP specification 2.0.
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(STORE_METHOD, 10);
    centralHeader.writeUInt16LE(FIXED_DOS_TIME, 12);
    centralHeader.writeUInt16LE(FIXED_DOS_DATE, 14);
    centralHeader.writeUInt32LE(entry.crc, 16);
    centralHeader.writeUInt32LE(entry.data.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(entry.name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, entry.name);

    localOffset += localHeader.length + entry.name.length + entry.data.length;
    assert(localOffset <= MAX_UINT32, 'release ZIP is too large for ZIP32');
  }

  const centralDirectory = Buffer.concat(centralParts);
  assert(centralDirectory.length <= MAX_UINT32, 'release central directory is too large for ZIP32');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

function inspectDeterministicZip(zip) {
  assert(Buffer.isBuffer(zip) && zip.length >= 22, 'invalid release ZIP');
  const endOffset = zip.length - 22;
  assert(zip.readUInt32LE(endOffset) === 0x06054b50, 'release ZIP is missing its end record');
  assert(zip.readUInt16LE(endOffset + 4) === 0 && zip.readUInt16LE(endOffset + 6) === 0,
    'multi-disk release ZIP is not allowed');
  assert(zip.readUInt16LE(endOffset + 20) === 0, 'release ZIP comments are not allowed');

  const entryCount = zip.readUInt16LE(endOffset + 10);
  assert(entryCount === zip.readUInt16LE(endOffset + 8), 'release ZIP entry count is inconsistent');
  const centralSize = zip.readUInt32LE(endOffset + 12);
  const centralOffset = zip.readUInt32LE(endOffset + 16);
  assert(centralOffset + centralSize === endOffset, 'release ZIP central directory is misplaced');

  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assert(zip.readUInt32LE(cursor) === 0x02014b50, 'invalid release ZIP central entry');
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const time = zip.readUInt16LE(cursor + 12);
    const date = zip.readUInt16LE(cursor + 14);
    const expectedCrc = zip.readUInt32LE(cursor + 16);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const uncompressedSize = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    assert(flags === UTF8_FLAG && method === STORE_METHOD,
      `release ZIP entry must be UTF-8 and stored: ${name}`);
    assert(time === FIXED_DOS_TIME && date === FIXED_DOS_DATE,
      `release ZIP entry has a variable timestamp: ${name}`);
    assert(extraLength === 0 && commentLength === 0,
      `release ZIP entry metadata is not deterministic: ${name}`);
    assert(compressedSize === uncompressedSize, `release ZIP entry is unexpectedly compressed: ${name}`);
    assertPortableEntryPath(name);

    assert(zip.readUInt32LE(localOffset) === 0x04034b50, `invalid local ZIP entry: ${name}`);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const localName = zip.toString('utf8', localOffset + 30, localOffset + 30 + localNameLength);
    assert(localName === name && localExtraLength === 0, `local ZIP metadata differs: ${name}`);
    assert(zip.readUInt16LE(localOffset + 8) === STORE_METHOD &&
      zip.readUInt16LE(localOffset + 10) === FIXED_DOS_TIME &&
      zip.readUInt16LE(localOffset + 12) === FIXED_DOS_DATE,
    `local ZIP entry is not deterministic: ${name}`);
    const dataStart = localOffset + 30 + localNameLength;
    const data = zip.subarray(dataStart, dataStart + uncompressedSize);
    assert(data.length === uncompressedSize && crc32(data) === expectedCrc,
      `release ZIP entry failed CRC verification: ${name}`);
    entries.push({ path: name, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  assert(cursor === centralOffset + centralSize, 'release ZIP central directory size is inconsistent');
  const paths = entries.map((entry) => entry.path);
  assert(paths.every((entryPath, index) => index === 0 ||
    comparePortablePaths(paths[index - 1], entryPath) < 0),
  'release ZIP entries are not strictly sorted');
  return entries;
}

function validateReleaseIdentity(packageJson, manifest) {
  assert(typeof packageJson?.name === 'string' && /^[a-z0-9][a-z0-9.-]*$/.test(packageJson.name),
    'package name is not safe for a release filename');
  assert(typeof packageJson?.version === 'string' && /^[0-9A-Za-z][0-9A-Za-z.-]*$/.test(packageJson.version),
    'package version is not safe for a release filename');
  assert(manifest?.version_name === packageJson.version,
    'manifest version_name must match package.json version');
  assert(typeof manifest?.version === 'string', 'manifest numeric version is missing');
  const versionParts = manifest.version.split('.');
  assert(versionParts.length >= 1 && versionParts.length <= 4 &&
    versionParts.every((part) => /^(?:0|[1-9]\d*)$/.test(part) && Number(part) <= MAX_UINT16) &&
    versionParts.some((part) => Number(part) !== 0),
  `invalid Chrome manifest version: ${manifest.version}`);

  return {
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    manifestVersion: manifest.version,
    tag: `v${packageJson.version}`,
    baseName: `${packageJson.name}-${packageJson.version}`
  };
}

function runGit(rootDir, args) {
  try {
    return execFileSync('git', ['-C', rootDir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (error) {
    const detail = String(error.stderr || error.message || error).trim();
    throw new Error(`Git release check failed (${args.join(' ')}): ${detail}`);
  }
}

function assertGitReleaseState(rootDir, expectedTag) {
  const repositoryRoot = path.resolve(runGit(rootDir, ['rev-parse', '--show-toplevel']));
  assert(repositoryRoot.toLowerCase() === path.resolve(rootDir).toLowerCase(),
    `release command must run at the repository root: ${repositoryRoot}`);
  const status = runGit(rootDir, ['status', '--porcelain=v1', '--untracked-files=all']);
  assert(!status, `release worktree is not clean:\n${status}`);

  const tagReference = `refs/tags/${expectedTag}`;
  const tagType = runGit(rootDir, ['cat-file', '-t', tagReference]);
  assert(tagType === 'tag', `release tag must be annotated: ${expectedTag}`);
  const commit = runGit(rootDir, ['rev-parse', 'HEAD']);
  const tagCommit = runGit(rootDir, ['rev-parse', `${tagReference}^{commit}`]);
  assert(commit === tagCommit, `HEAD does not match release tag ${expectedTag}`);
  const tree = runGit(rootDir, ['rev-parse', `${commit}^{tree}`]);
  return { tag: expectedTag, commit, tree };
}

function isSameOrInside(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) &&
    relative !== '..' && !path.isAbsolute(relative));
}

function createReleaseArtifacts({ packageDir, outputDir, packageJson, manifest, provenance }) {
  const identity = validateReleaseIdentity(packageJson, manifest);
  assert(provenance?.tag === identity.tag, `release provenance tag must be ${identity.tag}`);
  assert(/^[0-9a-f]{40,64}$/i.test(provenance?.commit || ''), 'release provenance commit is invalid');
  assert(/^[0-9a-f]{40,64}$/i.test(provenance?.tree || ''), 'release provenance tree is invalid');

  const resolvedPackage = path.resolve(packageDir);
  const resolvedOutput = path.resolve(outputDir);
  assert(!isSameOrInside(resolvedOutput, resolvedPackage),
    'release artifacts cannot be written inside the extension package');
  verifyPackage(resolvedPackage);
  const packagedManifest = JSON.parse(
    fs.readFileSync(path.join(resolvedPackage, 'manifest.json'), 'utf8')
  );
  assert(packagedManifest.version === manifest.version &&
    packagedManifest.version_name === manifest.version_name,
  'packaged manifest identity differs from the release metadata');

  const zip = createDeterministicZip(resolvedPackage);
  const inspected = inspectDeterministicZip(zip);
  const expectedPaths = [...RUNTIME_FILES].sort(comparePortablePaths);
  assert(inspected.map((entry) => entry.path).join('\n') === expectedPaths.join('\n'),
    'release ZIP does not contain the exact runtime whitelist');
  assert(inspected.some((entry) => entry.path === 'manifest.json'),
    'manifest.json must be at the ZIP root');

  const zipName = `${identity.baseName}.zip`;
  const shaName = `${zipName}.sha256`;
  const attestationName = `${identity.baseName}.attestation.json`;
  const zipHash = sha256(zip);
  const sidecar = `${zipHash}  ${zipName}\n`;
  const attestation = {
    schemaVersion: 1,
    release: {
      packageName: identity.packageName,
      packageVersion: identity.packageVersion,
      manifestVersion: identity.manifestVersion
    },
    source: {
      tag: provenance.tag,
      commit: provenance.commit.toLowerCase(),
      tree: provenance.tree.toLowerCase()
    },
    artifact: {
      zip: zipName,
      sha256File: shaName,
      sha256: zipHash,
      bytes: zip.length,
      entryCount: inspected.length,
      entries: inspected.map((entry) => entry.path)
    },
    reproducibility: {
      rootLayout: 'runtime files at ZIP root; manifest.json at root',
      entryOrder: 'ascending UTF-8 byte order',
      entryTimestamp: '1980-01-01T00:00:00Z',
      compression: 'store'
    }
  };
  const attestationText = `${JSON.stringify(attestation, null, 2)}\n`;

  fs.mkdirSync(resolvedOutput, { recursive: true });
  assert(!isSameOrInside(fs.realpathSync(resolvedOutput), fs.realpathSync(resolvedPackage)),
    'release artifact output resolves inside the extension package');
  const targets = [
    [zipName, zip],
    [shaName, sidecar],
    [attestationName, attestationText]
  ];
  for (const [name] of targets) {
    assert(!fs.existsSync(path.join(resolvedOutput, name)),
      `refusing to overwrite immutable release artifact: ${name}`);
  }

  const temporaryDir = fs.mkdtempSync(path.join(resolvedOutput, '.release-tmp-'));
  const moved = [];
  try {
    for (const [name, contents] of targets) {
      fs.writeFileSync(path.join(temporaryDir, name), contents, { flag: 'wx' });
    }
    for (const [name] of targets) {
      const target = path.join(resolvedOutput, name);
      const temporaryPath = path.join(temporaryDir, name);
      // A hard-link publish is atomic and fails with EEXIST on every platform;
      // unlike rename on POSIX, it can never replace an artifact created by a race.
      fs.linkSync(temporaryPath, target);
      moved.push(target);
      fs.unlinkSync(temporaryPath);
    }
  } catch (error) {
    for (const target of moved) fs.rmSync(target, { force: true });
    throw error;
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }

  return {
    zipPath: path.join(resolvedOutput, zipName),
    sha256Path: path.join(resolvedOutput, shaName),
    attestationPath: path.join(resolvedOutput, attestationName),
    zipSha256: zipHash,
    attestationSha256: sha256(Buffer.from(attestationText, 'utf8')),
    bytes: zip.length
  };
}

function parseArgs(argv) {
  let outputDir = path.join(ROOT, 'release-artifacts');
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [name, inlineValue] = argument.split('=', 2);
    if (name === '--help' || name === '-h') {
      help = true;
      continue;
    }
    if (name !== '--out-dir') throw new Error(`unknown argument: ${argument}`);
    const value = inlineValue === undefined ? argv[++index] : inlineValue;
    if (!value || value.startsWith('--')) throw new Error('missing value for --out-dir');
    outputDir = path.resolve(value);
  }
  return { outputDir, help };
}

function printHelp() {
  console.log(`Usage: node scripts/package-release.js [--out-dir <path>]

Build a deterministic release ZIP from the clean commit referenced by the
annotated tag v<package.json version>. Existing artifacts are never replaced.

Outputs:
  <name>-<version>.zip
  <name>-<version>.zip.sha256
  <name>-<version>.attestation.json`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const packageJson = readJson(path.join(ROOT, 'package.json'));
  const manifest = readJson(path.join(ROOT, 'manifest.json'));
  const identity = validateReleaseIdentity(packageJson, manifest);
  const before = assertGitReleaseState(ROOT, identity.tag);
  buildExtension();
  verifyPackage();
  const after = assertGitReleaseState(ROOT, identity.tag);
  assert(before.commit === after.commit && before.tree === after.tree,
    'release source changed while building artifacts');

  const result = createReleaseArtifacts({
    packageDir: path.join(ROOT, 'dist'),
    outputDir: options.outputDir,
    packageJson,
    manifest,
    provenance: after
  });
  console.log(`Release ZIP: ${result.zipPath}`);
  console.log(`ZIP SHA-256: ${result.zipSha256}`);
  console.log(`SHA-256 file: ${result.sha256Path}`);
  console.log(`Attestation: ${result.attestationPath}`);
  console.log(`Attestation SHA-256: ${result.attestationSha256}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

module.exports = {
  FIXED_DOS_DATE,
  FIXED_DOS_TIME,
  crc32,
  createDeterministicZip,
  inspectDeterministicZip,
  validateReleaseIdentity,
  assertGitReleaseState,
  createReleaseArtifacts
};
