const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');

const RUNTIME_FILES = Object.freeze([
  'manifest.json',
  'background.js',
  'message-contract.js',
  'balance-format.js',
  'balance-refresh.js',
  'balance.js',
  'detect.js',
  'import-export.js',
  'key-import.js',
  'key-provision.js',
  'options.html',
  'options.css',
  'options.js',
  'page-scrape.js',
  'permissions.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'shared-ui.css',
  'site-tabs.js',
  'site-utils.js',
  'storage.js',
  'tab-api-key.js',
  'ui-runtime.js',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'icons/logo.svg'
]);

function fromPortablePath(baseDir, relativePath) {
  return path.join(baseDir, ...relativePath.split('/'));
}

function isInsideDirectory(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return Boolean(relative) && relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertNoSymbolicLinkComponents(candidate, boundary) {
  const relative = path.relative(boundary, candidate);
  let current = boundary;

  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw new Error(`unsafe output directory (symbolic link component): ${current}`);
    }
  }
}

function assertSafeOutputDirectory(outDir) {
  const resolved = path.resolve(outDir);
  const sourceRoot = path.resolve(root);
  const releaseRoot = path.join(sourceRoot, 'dist');
  const temporaryRoot = path.resolve(os.tmpdir());
  const isReleaseRoot = resolved === releaseRoot;
  const isIsolatedTemporaryPath = isInsideDirectory(resolved, temporaryRoot);

  if (!isReleaseRoot && !isIsolatedTemporaryPath) {
    throw new Error(`unsafe output directory: ${resolved}`);
  }

  assertNoSymbolicLinkComponents(
    resolved,
    isReleaseRoot ? sourceRoot : temporaryRoot
  );

  return resolved;
}

function buildExtension(outDir = path.join(root, 'dist')) {
  const outputRoot = assertSafeOutputDirectory(outDir);
  const copies = RUNTIME_FILES.map((relativePath) => ({
    relativePath,
    sourcePath: fromPortablePath(root, relativePath),
    outputPath: fromPortablePath(outputRoot, relativePath)
  }));

  for (const { relativePath, sourcePath } of copies) {
    if (!fs.statSync(sourcePath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`missing runtime source file: ${relativePath}`);
    }
  }

  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });

  for (const { sourcePath, outputPath } of copies) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.copyFileSync(sourcePath, outputPath);
  }

  return outputRoot;
}

if (require.main === module) {
  try {
    const outputRoot = buildExtension();
    console.log(`Built extension package: ${outputRoot}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

module.exports = {
  RUNTIME_FILES,
  buildExtension,
  assertSafeOutputDirectory
};
