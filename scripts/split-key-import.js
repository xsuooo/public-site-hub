/**
 * Extract tryAutoImportKeys / mergeScrapedKeys / persistScrapedKeys /
 * keyProvisionService / ensureSiteKey into key-import.js.
 */
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const bgPath = path.join(rootDir, 'background.js');
const outPath = path.join(rootDir, 'key-import.js');
const lines = fs.readFileSync(bgPath, 'utf8').split(/\n/);

if (fs.existsSync(outPath) && fs.readFileSync(bgPath, 'utf8').includes("'key-import.js'")) {
  console.log('already split, skip');
  process.exit(0);
}

const start = lines.findIndex((l) => l.includes('async function tryAutoImportKeys'));
// include preceding JSDoc
let realStart = start;
for (let i = start - 1; i >= Math.max(0, start - 6); i -= 1) {
  if (lines[i].includes('/**')) {
    realStart = i;
    break;
  }
}
const end = lines.findIndex((l, i) => i > start && l.includes('if (chrome.contextMenus?.onClicked)'));
if (start < 0 || end < 0) {
  console.error('bounds', { start, end });
  process.exit(1);
}

// back up over blank lines before contextMenus
let sliceEnd = end;
while (sliceEnd > realStart && lines[sliceEnd - 1].trim() === '') sliceEnd -= 1;

const body = lines.slice(realStart, sliceEnd).join('\n').replace(/\n+$/, '\n');

const out = `/**
 * Key 自动导入 / 合并 / 自动获取（依赖 storage、page-scrape、tab-api-key、siteOrigin 等全局）。
 */
(function (root) {
${body}
  root.tryAutoImportKeys = tryAutoImportKeys;
  root.mergeScrapedKeys = mergeScrapedKeys;
  root.persistScrapedKeys = persistScrapedKeys;
  root.ensureSiteKey = ensureSiteKey;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      tryAutoImportKeys,
      mergeScrapedKeys,
      persistScrapedKeys,
      ensureSiteKey
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
`;

fs.writeFileSync(outPath, out);

let newLines = [...lines.slice(0, realStart), ...lines.slice(sliceEnd)];
let text = newLines.join('\n');
if (!text.includes("'key-import.js'")) {
  text = text.replace(
    "'key-provision.js'\n);",
    "'key-provision.js',\n  'key-import.js'\n);"
  );
}
// remove allBalanceRefresh if any leftover - no

// update global comment
if (!text.includes('tryAutoImportKeys,')) {
  text = text.replace(
    'scrapeBalanceWithRetry */',
    'scrapeBalanceWithRetry, tryAutoImportKeys, mergeScrapedKeys, ensureSiteKey */'
  );
}

fs.writeFileSync(bgPath, text);
console.log('ok', {
  outLines: out.split(/\n/).length,
  bgLines: text.split(/\n/).length,
  from: realStart + 1,
  to: sliceEnd
});
