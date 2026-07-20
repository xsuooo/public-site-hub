const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const excludedDirectories = new Set([
  '.git',
  '.playwright',
  'dist',
  'node_modules',
  'release-artifacts',
  'uploads'
]);

function collectJavaScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectJavaScriptFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute);
  }
  return files;
}

const files = collectJavaScriptFiles(root).sort();
const failed = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: root,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    failed.push({
      file: path.relative(root, file),
      output: String(result.stderr || result.stdout || '').trim()
    });
  }
}

if (failed.length) {
  for (const failure of failed) {
    console.error(`[syntax] ${failure.file}`);
    if (failure.output) console.error(failure.output);
  }
  process.exitCode = 1;
} else {
  console.log(`[syntax] ${files.length} JavaScript files passed node --check`);
}
