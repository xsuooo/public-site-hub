/**
 * Extract balance refresh orchestration from background.js into balance-refresh.js.
 */
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const bgPath = path.join(rootDir, 'background.js');
const outPath = path.join(rootDir, 'balance-refresh.js');
const lines = fs.readFileSync(bgPath, 'utf8').split(/\n/);

if (fs.existsSync(outPath) && fs.readFileSync(bgPath, 'utf8').includes('balance-refresh.js')) {
  console.log('already split, skip');
  process.exit(0);
}

const scrapeStart = lines.findIndex((l) => l.includes('async function scrapeBalanceWithRetry'));
const scrapeEnd = lines.findIndex((l, i) => i > scrapeStart && l.includes('async function tryAutoImportKeys'));
const refreshStart = lines.findIndex((l) => l.includes('const SITE_BALANCE_TIMEOUT_MS'));
const refreshEnd = lines.findIndex((l) => l.includes('if (chrome.contextMenus?.onClicked)'));

if (scrapeStart < 0 || scrapeEnd < 0 || refreshStart < 0 || refreshEnd < 0) {
  console.error('bounds', { scrapeStart, scrapeEnd, refreshStart, refreshEnd });
  process.exit(1);
}

// include comment above scrape if any
let scrapeRealStart = scrapeStart;
for (let i = scrapeStart - 1; i >= Math.max(0, scrapeStart - 6); i -= 1) {
  if (lines[i].includes('/**')) {
    scrapeRealStart = i;
    break;
  }
}
// exclude JSDoc of tryAutoImportKeys: walk back from scrapeEnd over blank + comment
let scrapeSliceEnd = scrapeEnd;
while (scrapeSliceEnd > scrapeRealStart && (
  lines[scrapeSliceEnd - 1].trim() === ''
  || lines[scrapeSliceEnd - 1].includes('*')
  || lines[scrapeSliceEnd - 1].includes('/**')
)) {
  scrapeSliceEnd -= 1;
}

const scrapeBlock = lines.slice(scrapeRealStart, scrapeSliceEnd).join('\n').replace(/\n+$/, '\n');
const refreshBlock = lines.slice(refreshStart, refreshEnd).join('\n').replace(/\n+$/, '\n');

const out = `/**
 * 余额单站/批量刷新编排（依赖 importScripts 已加载的 storage / tabs / balance / permissions）。
 * 通过 self 上的全局函数协作：loadSites、ensureAccessForSite、ensureSiteTab、fetchSiteBalance 等。
 */
(function (root) {
  let allBalanceRefreshInFlight = null;

${scrapeBlock}
${refreshBlock}
  root.scrapeBalanceWithRetry = scrapeBalanceWithRetry;
  root.refreshSiteBalance = refreshSiteBalance;
  root.getBalanceRefreshProgress = getBalanceRefreshProgress;
  root.refreshAllBalances = refreshAllBalances;
  root.retryFailedBalances = retryFailedBalances;
  root.refreshAllBalancesInternal = refreshAllBalancesInternal;
  root.SITE_BALANCE_TIMEOUT_MS = SITE_BALANCE_TIMEOUT_MS;
  root.MAX_OWNED_TEMP_TABS = MAX_OWNED_TEMP_TABS;
  root.withTimeout = withTimeout;
  root.classifySiteBalanceError = classifySiteBalanceError;
  root.recordBalanceFailure = recordBalanceFailure;
  root.recordBalanceSuccess = recordBalanceSuccess;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      scrapeBalanceWithRetry,
      refreshSiteBalance,
      getBalanceRefreshProgress,
      refreshAllBalances,
      retryFailedBalances,
      SITE_BALANCE_TIMEOUT_MS,
      MAX_OWNED_TEMP_TABS
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
`;

fs.writeFileSync(outPath, out);

// Remove extracted blocks from background; remove allBalanceRefreshInFlight declaration
let newLines = lines.slice();
// remove refresh block first (higher indices)
newLines = [...newLines.slice(0, refreshStart), ...newLines.slice(refreshEnd)];
// re-find scrape after removal if scrape was before refresh (yes it is)
const scrapeStart2 = newLines.findIndex((l) => l.includes('async function scrapeBalanceWithRetry'));
const tryImport2 = newLines.findIndex((l, i) => i > scrapeStart2 && l.includes('async function tryAutoImportKeys'));
let scrapeRealStart2 = scrapeStart2;
if (scrapeStart2 > 0) {
  for (let i = scrapeStart2 - 1; i >= Math.max(0, scrapeStart2 - 6); i -= 1) {
    if (newLines[i].includes('/**')) {
      scrapeRealStart2 = i;
      break;
    }
  }
}
let scrapeSliceEnd2 = tryImport2;
while (scrapeSliceEnd2 > scrapeRealStart2 && (
  newLines[scrapeSliceEnd2 - 1].trim() === ''
  || newLines[scrapeSliceEnd2 - 1].includes('*')
  || newLines[scrapeSliceEnd2 - 1].includes('/**')
)) {
  scrapeSliceEnd2 -= 1;
}
if (scrapeStart2 >= 0 && tryImport2 > scrapeStart2) {
  newLines = [...newLines.slice(0, scrapeRealStart2), ...newLines.slice(scrapeSliceEnd2)];
}

// remove allBalanceRefreshInFlight from top
newLines = newLines.filter((l) => !l.includes('let allBalanceRefreshInFlight'));

// ensure importScripts includes balance-refresh.js after storage/balance
const bgText = newLines.join('\n');
if (!bgText.includes("'balance-refresh.js'")) {
  const patched = bgText.replace(
    "'key-provision.js'\n);",
    "'key-provision.js',\n  'balance-refresh.js'\n);"
  );
  // better place: after storage.js since it needs loadBalanceRefreshProgress
  // after detect.js so detectSite is available for auto type resolution
  const better = bgText.includes("'detect.js'")
    ? bgText.replace(
      "'detect.js',\n  'bridge.js'",
      "'detect.js',\n  'balance-refresh.js',\n  'bridge.js'"
    )
    : patched;
  fs.writeFileSync(bgPath, better);
} else {
  fs.writeFileSync(bgPath, bgText);
}

console.log('ok', {
  outLines: out.split(/\n/).length,
  bgLines: fs.readFileSync(bgPath, 'utf8').split(/\n/).length,
  scrape: [scrapeRealStart + 1, scrapeEnd],
  refresh: [refreshStart + 1, refreshEnd]
});
