const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { RUNTIME_FILES } = require('./build-extension.js');

const root = path.join(__dirname, '..');
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const FORBIDDEN_RUNTIME_PATHS = new Set(['bridge.js', 'checkin-sync.js']);
const FORBIDDEN_TOP_LEVEL_DIRECTORIES = new Set(['uploads', 'tests', 'docs', 'scripts']);
const CRC32_TABLE = new Uint32Array(256);

for (let value = 0; value < CRC32_TABLE.length; value += 1) {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  CRC32_TABLE[value] = crc >>> 0;
}

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

function paethPredictor(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);

  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function pngChunkCrc(typeBytes, data) {
  let crc = 0xffffffff;
  for (const bytes of [typeBytes, data]) {
    for (const byte of bytes) {
      crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function inspectRgbaPng(filePath) {
  const png = fs.readFileSync(filePath);
  if (png.length < PNG_SIGNATURE.length ||
      !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`invalid PNG signature: ${filePath}`);
  }

  let offset = PNG_SIGNATURE.length;
  let chunkIndex = 0;
  let header = null;
  let sawEnd = false;
  const imageData = [];

  while (offset < png.length) {
    if (offset + 12 > png.length) {
      throw new Error(`truncated PNG chunk: ${filePath}`);
    }

    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > png.length) {
      throw new Error(`truncated PNG ${type} chunk: ${filePath}`);
    }

    const data = png.subarray(dataStart, dataEnd);
    const expectedCrc = png.readUInt32BE(dataEnd);
    const actualCrc = pngChunkCrc(png.subarray(offset + 4, offset + 8), data);
    if (actualCrc !== expectedCrc) {
      throw new Error(`PNG CRC mismatch: ${type} in ${filePath}`);
    }
    if (chunkIndex === 0 && type !== 'IHDR') {
      throw new Error(`PNG first chunk must be IHDR: ${filePath}`);
    }
    if (type === 'IHDR') {
      if (header || length !== 13) throw new Error(`invalid PNG IHDR: ${filePath}`);
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12]
      };
    } else if (type === 'IDAT') {
      imageData.push(data);
    } else if (type === 'IEND') {
      if (length !== 0) throw new Error(`invalid PNG IEND: ${filePath}`);
      if (chunkEnd !== png.length) throw new Error(`PNG has trailing data: ${filePath}`);
      sawEnd = true;
      break;
    }

    offset = chunkEnd;
    chunkIndex += 1;
  }

  if (!header) throw new Error(`PNG is missing IHDR: ${filePath}`);
  if (!imageData.length) throw new Error(`PNG is missing IDAT: ${filePath}`);
  if (!sawEnd) throw new Error(`PNG is missing IEND: ${filePath}`);
  if (!header.width || !header.height) throw new Error(`PNG has invalid dimensions: ${filePath}`);
  if (header.bitDepth !== 8 || header.colorType !== 6 ||
      header.compression !== 0 || header.filter !== 0 || header.interlace !== 0) {
    throw new Error(`PNG must be non-interlaced 8-bit RGBA: ${filePath}`);
  }

  const bytesPerPixel = 4;
  const rowBytes = header.width * bytesPerPixel;
  const inflated = zlib.inflateSync(Buffer.concat(imageData));
  const expectedLength = (rowBytes + 1) * header.height;
  if (inflated.length !== expectedLength) {
    throw new Error(`PNG scanline size mismatch: ${filePath}`);
  }

  let sourceOffset = 0;
  let previousRow = Buffer.alloc(rowBytes);
  let nonTransparentPixels = 0;

  for (let y = 0; y < header.height; y += 1) {
    const filterType = inflated[sourceOffset];
    sourceOffset += 1;
    if (filterType > 4) throw new Error(`unsupported PNG filter ${filterType}: ${filePath}`);

    const filteredRow = inflated.subarray(sourceOffset, sourceOffset + rowBytes);
    sourceOffset += rowBytes;
    const row = Buffer.allocUnsafe(rowBytes);

    for (let x = 0; x < rowBytes; x += 1) {
      const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
      const above = previousRow[x];
      const upperLeft = x >= bytesPerPixel ? previousRow[x - bytesPerPixel] : 0;
      let predictor = 0;

      if (filterType === 1) predictor = left;
      else if (filterType === 2) predictor = above;
      else if (filterType === 3) predictor = Math.floor((left + above) / 2);
      else if (filterType === 4) predictor = paethPredictor(left, above, upperLeft);

      row[x] = (filteredRow[x] + predictor) & 0xff;
    }

    for (let alpha = 3; alpha < rowBytes; alpha += bytesPerPixel) {
      if (row[alpha] > 0) nonTransparentPixels += 1;
    }
    previousRow = row;
  }

  return {
    width: header.width,
    height: header.height,
    nonTransparentPixels
  };
}

function assertExactRuntimeFiles(packageDir) {
  const actualFiles = listFiles(packageDir);
  const expectedFiles = [...RUNTIME_FILES].sort();
  const actualSet = new Set(actualFiles);
  const expectedSet = new Set(expectedFiles);

  for (const expectedFile of expectedFiles) {
    if (!actualSet.has(expectedFile)) throw new Error(`missing runtime file: ${expectedFile}`);
  }
  for (const actualFile of actualFiles) {
    if (!expectedSet.has(actualFile)) throw new Error(`unexpected runtime file: ${actualFile}`);
  }

  for (const file of actualFiles) {
    const topLevel = file.split('/')[0];
    if (FORBIDDEN_TOP_LEVEL_DIRECTORIES.has(topLevel) || FORBIDDEN_RUNTIME_PATHS.has(file)) {
      throw new Error(`forbidden runtime file: ${file}`);
    }
  }

  return actualFiles;
}

function assertSourceParity(packageDir, files) {
  for (const relativePath of files) {
    const segments = relativePath.split('/');
    const sourcePath = path.join(root, ...segments);
    const packagePath = path.join(packageDir, ...segments);
    if (!fs.readFileSync(sourcePath).equals(fs.readFileSync(packagePath))) {
      throw new Error(`stale runtime file; run npm run build: ${relativePath}`);
    }
  }
}

function normalizeLocalReference(reference, ownerPath) {
  const trimmedReference = reference.trim();
  if (!trimmedReference || trimmedReference.startsWith('#')) {
    return null;
  }
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(trimmedReference)) {
    throw new Error(`external package reference is not allowed: ${ownerPath} -> ${reference}`);
  }
  if (trimmedReference.includes('\\')) {
    throw new Error(`invalid package reference: ${ownerPath} -> ${reference}`);
  }

  const cleanReference = trimmedReference.split(/[?#]/, 1)[0];

  const ownerDir = path.posix.dirname(ownerPath.replaceAll('\\', '/'));
  const normalized = path.posix.normalize(path.posix.join(ownerDir, cleanReference));
  if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new Error(`package reference escapes output directory: ${ownerPath} -> ${reference}`);
  }
  return normalized;
}

function assertReferenceExists(packageDir, ownerPath, reference, availableFiles) {
  const normalized = normalizeLocalReference(reference, ownerPath);
  if (!normalized) return;

  if (!availableFiles.has(normalized)) {
    throw new Error(`missing referenced file: ${ownerPath} -> ${normalized}`);
  }
}

function requireManifestString(value, fieldPath) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`missing manifest field: ${fieldPath}`);
  }
}

function validateManifest(manifest) {
  if (manifest.manifest_version !== 3) {
    throw new Error('manifest_version must be 3');
  }

  requireManifestString(manifest.background?.service_worker, 'background.service_worker');
  requireManifestString(manifest.action?.default_popup, 'action.default_popup');
  requireManifestString(manifest.options_page, 'options_page');

  for (const size of ['16', '48', '128']) {
    requireManifestString(manifest.icons?.[size], `icons.${size}`);
    requireManifestString(manifest.action?.default_icon?.[size], `action.default_icon.${size}`);
  }
}

function collectManifestReferences(manifest) {
  const references = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.options_page,
    manifest.options_ui?.page,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {})
  ];

  return [...new Set(references.filter((reference) => typeof reference === 'string'))];
}

function collectHtmlReferences(html) {
  const references = [];
  const elementPattern = /<(?:script|link|img)\b[^>]*?\b(?:src|href)\s*=\s*(["'])(.*?)\1/gi;
  for (const match of html.matchAll(elementPattern)) references.push(match[2]);
  return references;
}

function collectWorkerReferences(script, ownerPath) {
  const references = [];
  const callPattern = /\bimportScripts\s*\(([\s\S]*?)\)\s*;?/g;

  for (const call of script.matchAll(callPattern)) {
    const argumentsSource = call[1];
    const stringPattern = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g;
    let remainingSource = argumentsSource;

    for (const literal of argumentsSource.matchAll(stringPattern)) {
      const rawReference = literal[1] ?? literal[2];
      if (/\\(?!["'\\])/.test(rawReference)) {
        throw new Error(`unsupported escaped importScripts reference: ${ownerPath}`);
      }
      references.push(rawReference.replace(/\\(["'\\])/g, '$1'));
    }

    remainingSource = remainingSource
      .replace(stringPattern, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\r\n]*/g, '');
    if (!/^[\s,]*$/.test(remainingSource)) {
      throw new Error(`dynamic importScripts reference cannot be verified: ${ownerPath}`);
    }
  }

  return references;
}

function verifyPackage(packageDir = path.join(root, 'dist')) {
  const outputRoot = path.resolve(packageDir);
  if (!fs.statSync(outputRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`extension package directory does not exist: ${outputRoot}`);
  }

  const files = assertExactRuntimeFiles(outputRoot);
  if (outputRoot === path.resolve(root, 'dist')) {
    assertSourceParity(outputRoot, files);
  }
  const manifestPath = path.join(outputRoot, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`invalid manifest.json: ${error instanceof Error ? error.message : error}`);
  }
  validateManifest(manifest);
  const availableFiles = new Set(files);

  for (const reference of collectManifestReferences(manifest)) {
    assertReferenceExists(outputRoot, 'manifest.json', reference, availableFiles);
  }

  const workerReference = manifest.background?.service_worker;
  if (typeof workerReference === 'string') {
    const workerPath = normalizeLocalReference(workerReference, 'manifest.json');
    if (workerPath) {
      const workerSource = fs.readFileSync(
        path.join(outputRoot, ...workerPath.split('/')),
        'utf8'
      );
      for (const reference of collectWorkerReferences(workerSource, workerPath)) {
        assertReferenceExists(outputRoot, workerPath, reference, availableFiles);
      }
    }
  }

  for (const htmlPath of files.filter((file) => file.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(outputRoot, ...htmlPath.split('/')), 'utf8');
    for (const reference of collectHtmlReferences(html)) {
      assertReferenceExists(outputRoot, htmlPath, reference, availableFiles);
    }
  }

  const iconInspections = new Map();
  const icons = [];
  for (const [fieldPath, iconMap] of [
    ['icons', manifest.icons],
    ['action.default_icon', manifest.action.default_icon]
  ]) {
    for (const size of ['16', '48', '128']) {
      const iconPath = iconMap[size];
      if (!iconPath.toLowerCase().endsWith('.png')) {
        throw new Error(`manifest icon must be PNG: ${fieldPath}.${size}`);
      }
      let inspection = iconInspections.get(iconPath);
      if (!inspection) {
        inspection = inspectRgbaPng(path.join(outputRoot, ...iconPath.split('/')));
        iconInspections.set(iconPath, inspection);
      }
      const declaredSize = Number.parseInt(size, 10);
      if (inspection.width !== declaredSize || inspection.height !== declaredSize) {
        throw new Error(`icon dimensions do not match manifest: ${fieldPath}.${size}`);
      }
      if (inspection.nonTransparentPixels === 0) {
        throw new Error(`icon has no visible pixels: ${iconPath}`);
      }
    }
  }
  for (const [iconPath, inspection] of iconInspections) {
    icons.push({ path: iconPath, ...inspection });
  }

  return { files, icons };
}

if (require.main === module) {
  try {
    const result = verifyPackage();
    console.log(`Verified extension package: ${result.files.length} runtime files`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

module.exports = {
  inspectRgbaPng,
  assertSourceParity,
  verifyPackage
};
