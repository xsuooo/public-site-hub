/**
 * Extract verifyNewApiTabAccount + createTabApiKey into tab-api-key.js.
 * balance.js keeps thin root aliases for Node require('./balance.js') tests.
 */
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const balancePath = path.join(rootDir, 'balance.js');
const src = fs.readFileSync(balancePath, 'utf8');
const lines = src.split(/\n/);

// Already split?
if (fs.existsSync(path.join(rootDir, 'tab-api-key.js'))
  && src.includes("require('./tab-api-key.js')")
  && !src.includes('async function verifyNewApiTabAccount')) {
  console.log('already split, skip');
  process.exit(0);
}

const startIdx = lines.findIndex((l) => /async function verifyNewApiTabAccount/.test(l));
// include JSDoc above if present
let realStart = startIdx;
while (realStart > 0 && (/^\s*\/\*\*/.test(lines[realStart - 1]) || /^\s*\*/.test(lines[realStart - 1]) || lines[realStart - 1].trim() === '')) {
  if (/^\s*\/\*\*/.test(lines[realStart - 1])) {
    realStart -= 1;
    break;
  }
  realStart -= 1;
}
// walk back to start of comment block
if (realStart > 0 && lines[realStart].includes('/**')) {
  // ok
} else if (startIdx > 0) {
  // find /** above startIdx
  for (let i = startIdx - 1; i >= Math.max(0, startIdx - 8); i -= 1) {
    if (lines[i].includes('/**')) {
      realStart = i;
      break;
    }
    if (lines[i].trim() && !lines[i].includes('*')) break;
  }
}

const endIdx = lines.findIndex((l) => /async function fetchSiteBalance/.test(l));
if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
  console.error('function bounds not found', { startIdx, endIdx });
  process.exit(1);
}

const extracted = lines.slice(realStart, endIdx).join('\n').replace(/\n+$/, '\n');

const tabApiKey = `(function (root) {
  // 依赖 balance-format；浏览器由 importScripts 保证加载顺序。
  if (typeof root.buildAuthHeaders !== 'function' && typeof require === 'function') {
    try { Object.assign(root, require('./balance-format.js')); } catch (error) {}
  }

${extracted}
  root.verifyNewApiTabAccount = verifyNewApiTabAccount;
  root.createTabApiKey = createTabApiKey;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      verifyNewApiTabAccount,
      createTabApiKey
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
`;

fs.writeFileSync(path.join(rootDir, 'tab-api-key.js'), tabApiKey);

const aliasBlock = `  // tab-api-key.js：账号校验 + 自动创建 Key（Node 下按需 require）
  // 必须捕获真实实现再挂 root，禁止 () => root.fn 回写（会递归）。
  if (typeof root.verifyNewApiTabAccount !== 'function' && typeof require === 'function') {
    try { Object.assign(root, require('./tab-api-key.js')); } catch (error) {}
  }
  const verifyNewApiTabAccount = root.verifyNewApiTabAccount;
  const createTabApiKey = root.createTabApiKey;

`;

const before = lines.slice(0, realStart).join('\n');
const after = lines.slice(endIdx).join('\n');
const newBalance = `${before}\n${aliasBlock}\n${after}`;
fs.writeFileSync(balancePath, newBalance);

console.log('ok', {
  tabApiKeyLines: tabApiKey.split(/\n/).length,
  balanceLines: newBalance.split(/\n/).length,
  extractedFrom: realStart + 1,
  extractedTo: endIdx
});
