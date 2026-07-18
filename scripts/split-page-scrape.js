/**
 * Extract scrapeTabBalanceAndKeys + fetchBalanceViaTab into page-scrape.js.
 */
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const balancePath = path.join(rootDir, 'balance.js');
const outPath = path.join(rootDir, 'page-scrape.js');
const src = fs.readFileSync(balancePath, 'utf8');
const lines = src.split(/\n/);

if (fs.existsSync(outPath) && src.includes("require('./page-scrape.js')")) {
  console.log('already split, skip');
  process.exit(0);
}

const startIdx = lines.findIndex((l) => /async function scrapeTabBalanceAndKeys/.test(l));
const endIdx = lines.findIndex((l) => /\/\/ tab-api-key\.js/.test(l));
if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
  console.error('bounds not found', { startIdx, endIdx });
  process.exit(1);
}

// include JSDoc above scrape
let realStart = startIdx;
for (let i = startIdx - 1; i >= Math.max(0, startIdx - 20); i -= 1) {
  if (lines[i].includes('/**')) {
    realStart = i;
    break;
  }
}

const extracted = lines.slice(realStart, endIdx).join('\n').replace(/\n+$/, '\n');

const pageScrape = `(function (root) {
  // 依赖 balance-format；浏览器由 importScripts 保证顺序。
  if (typeof root.formatBalanceValue !== 'function' && typeof require === 'function') {
    try { Object.assign(root, require('./balance-format.js')); } catch (error) {}
  }
  const resolveQuotaUnit = root.resolveQuotaUnit;
  const formatBalanceValue = root.formatBalanceValue;
  const extractFromUserObject = root.extractFromUserObject;
  const extractBalanceFromText = root.extractBalanceFromText;
  const extractUsageFromText = root.extractUsageFromText;
  const humanizeBalanceError = root.humanizeBalanceError;
  const candidateTokenPaths = root.candidateTokenPaths;

${extracted}
  root.scrapeTabBalanceAndKeys = scrapeTabBalanceAndKeys;
  root.fetchBalanceViaTab = fetchBalanceViaTab;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      scrapeTabBalanceAndKeys,
      fetchBalanceViaTab
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
`;

fs.writeFileSync(outPath, pageScrape);

const aliasBlock = `  // page-scrape.js：标签页余额/Key 抓取（Node 下按需 require）
  // 必须捕获真实实现再挂 root，禁止 () => root.fn 回写（会递归）。
  if (typeof root.scrapeTabBalanceAndKeys !== 'function' && typeof require === 'function') {
    try { Object.assign(root, require('./page-scrape.js')); } catch (error) {}
  }
  const scrapeTabBalanceAndKeys = root.scrapeTabBalanceAndKeys;
  const fetchBalanceViaTab = root.fetchBalanceViaTab;

`;

const before = lines.slice(0, realStart).join('\n');
const after = lines.slice(endIdx).join('\n');
const newBalance = `${before}\n${aliasBlock}\n${after}`;
fs.writeFileSync(balancePath, newBalance);

console.log('ok', {
  pageScrapeLines: pageScrape.split(/\n/).length,
  balanceLines: newBalance.split(/\n/).length,
  from: realStart + 1,
  to: endIdx
});
