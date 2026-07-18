const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(rootDir, 'balance.js'), 'utf8');
const startMark = '(function (root) {';
const endMark = '  async function fetchJson';
const start = src.indexOf(startMark);
const end = src.indexOf(endMark);
if (start < 0 || end < 0) {
  console.error('marks not found', start, end);
  process.exit(1);
}

const pureBody = src.slice(start + startMark.length, end);
const formatFile = `${startMark}${pureBody}
  root.QUOTA_UNIT = QUOTA_UNIT;
  root.formatBalanceValue = formatBalanceValue;
  root.extractBalanceFromData = extractBalanceFromData;
  root.extractUsageFromData = extractUsageFromData;
  root.extractBalanceFromText = extractBalanceFromText;
  root.extractUsageFromText = extractUsageFromText;
  root.extractFromUserObject = extractFromUserObject;
  root.isSuspiciousBalance = isSuspiciousBalance;
  root.resolveQuotaUnit = resolveQuotaUnit;
  root.buildAuthHeaders = buildAuthHeaders;
  root.candidateBalancePaths = candidatePaths;
  root.candidateTokenPaths = candidateTokenPaths;
  root.humanizeBalanceError = humanizeBalanceError;
  root.classifyBalanceError = classifyBalanceError;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      QUOTA_UNIT,
      formatBalanceValue,
      extractBalanceFromData,
      extractUsageFromData,
      extractBalanceFromText,
      extractUsageFromText,
      extractFromUserObject,
      isSuspiciousBalance,
      resolveQuotaUnit,
      buildAuthHeaders,
      candidatePaths,
      candidateTokenPaths,
      humanizeBalanceError,
      classifyBalanceError
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
`;

fs.writeFileSync(path.join(rootDir, 'balance-format.js'), formatFile);

const rest = src.slice(end);
const header = `(function (root) {
  // 纯展示/解析逻辑在 balance-format.js；浏览器由 importScripts 先加载，Node 在此补齐。
  if (typeof root.formatBalanceValue !== 'function' && typeof require === 'function') {
    try { Object.assign(root, require('./balance-format.js')); } catch (error) {}
  }
  const QUOTA_UNIT = root.QUOTA_UNIT || 500000;
  const formatBalanceValue = root.formatBalanceValue;
  const extractBalanceFromData = root.extractBalanceFromData;
  const extractUsageFromData = root.extractUsageFromData;
  const extractBalanceFromText = root.extractBalanceFromText;
  const extractUsageFromText = root.extractUsageFromText;
  const extractFromUserObject = root.extractFromUserObject;
  const isSuspiciousBalance = root.isSuspiciousBalance;
  const resolveQuotaUnit = root.resolveQuotaUnit;
  const buildAuthHeaders = root.buildAuthHeaders;
  const humanizeBalanceError = root.humanizeBalanceError;
  const classifyBalanceError = root.classifyBalanceError;
  const candidatePaths = root.candidateBalancePaths || root.candidatePaths;
  const candidateTokenPaths = root.candidateTokenPaths;

`;

let newBalance = header + rest;
// Keep re-exports at bottom intact (they already reference local consts from root)
fs.writeFileSync(path.join(rootDir, 'balance.js'), newBalance);
console.log('ok', {
  formatLines: formatFile.split(/\n/).length,
  balanceLines: newBalance.split(/\n/).length
});
