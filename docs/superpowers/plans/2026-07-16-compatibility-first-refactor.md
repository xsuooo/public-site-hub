# Compatibility-First Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复已复现的 Origin、存储竞态、UI、余额任务和发布缺陷，同时保持现有界面、存储键及导入导出格式兼容。

**Architecture:** 以 `site-utils.js` 统一 Origin 语义，以 storage keyed queues 保证读改写顺序，以 `ui-runtime.js` 收敛 popup/options 公共行为，并通过干净的 `dist/` 白名单产物建立发布门禁。每项生产改动都先增加会因当前缺陷失败的测试，再实施最小修复。

**Tech Stack:** Manifest V3、原生 JavaScript、Chrome Extension APIs、Node.js `node:test`、PowerShell、Python Pillow（仅用于生成 PNG）。

---

## 执行说明

当前目录没有 `.git`。下面保留每个任务的提交步骤作为检查点，但执行时不得擅自初始化 Git；只有用户恢复或初始化 Git 后才运行提交命令。

## 文件结构

- `site-utils.js`：唯一的站点 Origin、打开地址和 `/v1` 调用地址格式化入口。
- `permissions.js`：基于完整 Origin 生成权限 pattern。
- `detect.js`：基于完整 Origin 发起探测请求。
- `storage.js`：站点、偏好、备份的串行化读改写及原子替换。
- `balance-refresh.js`：余额任务 scope 与并发控制。
- `ui-runtime.js`：popup/options 共用消息、转义、Key 判定、剪贴板和 debounce。
- `popup.js`、`options.js`：保留页面状态和渲染，仅调用共享 runtime。
- `scripts/build-extension.js`：生成白名单 `dist/`。
- `scripts/verify-package.js`：校验产物引用、禁止文件和 PNG 内容。
- `tests/origin-routing.test.js`：Origin 与端口行为。
- `tests/ui-runtime.test.js`：共享 UI 行为。
- `tests/release-package.test.js`：图标和发布产物。

### Task 1: 统一 Origin 与调用地址

**Files:**
- Modify: `site-utils.js:38-52,188-203,584-667`
- Modify: `balance.js:194-238`
- Modify: `bridge.js:195-208`
- Modify: `popup.js:1,948-956`
- Modify: `options.js:1,595-604`
- Modify: `background.js:1-16,790-795`
- Modify: `tests/week1.test.js`

- [ ] **Step 1: 写入失败测试**

在 `tests/week1.test.js` 增加：

```js
test('API base formatting preserves an explicit HTTPS port', () => {
  const site = utils.normalizeSite({
    domain: 'api.example.com',
    baseUrl: 'https://api.example.com:8443',
    pageUrl: 'https://api.example.com:8443/console'
  });
  assert.equal(utils.originForSite(site), 'https://api.example.com:8443');
  assert.equal(utils.formatApiBaseV1(site), 'https://api.example.com:8443/v1');
});
```

- [ ] **Step 2: 验证测试因缺少 helper 失败**

Run: `node --test tests/week1.test.js`

Expected: FAIL，提示 `utils.originForSite is not a function` 或 `utils.formatApiBaseV1 is not a function`。

- [ ] **Step 3: 在 `site-utils.js` 实现唯一 helper**

```js
function originForSite(value) {
  const candidates = value && typeof value === 'object'
    ? [value.baseUrl, value.pageUrl, value.domain]
    : [value];
  for (const candidate of candidates) {
    const origin = originFromDomain(candidate);
    if (origin) return origin;
  }
  return '';
}

function formatApiBaseV1(site) {
  const origin = originForSite(site);
  return origin ? origin + '/v1' : '';
}
```

将 `openUrlForSite` 和 `tokenPageUrlForSite` 改为调用 `originForSite`，并把两个新函数挂到 `root` 及 `module.exports`。

- [ ] **Step 4: 删除调用方的 hostname 重建**

`popup.js`、`options.js` 和 background 的 `formatClientSnippet` 消息直接调用 `formatApiBaseV1(site)`。`balance.js` 与遗留 `bridge.js` 的同名 helper 只委托给 `root.formatApiBaseV1`，Node fallback 也必须从 `baseUrl/pageUrl` 的 `URL.origin` 生成，不能从 `hostname` 生成。

- [ ] **Step 5: 验证目标测试**

Run: `node --test tests/week1.test.js tests/bridge.test.js`

Expected: PASS，显式端口断言通过，调用地址仍不包含 Key。

- [ ] **Step 6: 提交检查点（仅 Git 可用时）**

```powershell
git add site-utils.js balance.js bridge.js popup.js options.js background.js tests/week1.test.js
git commit -m "fix: preserve site origin in API endpoints"
```

### Task 2: 修复探测与批量授权的端口丢失

**Files:**
- Create: `tests/origin-routing.test.js`
- Modify: `detect.js:141-155,383-435`
- Modify: `permissions.js:2-24,51-84,86-203`
- Modify: `tests/background-checkin.test.js:476-503`

- [ ] **Step 1: 写入探测失败测试**

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const utils = require('../site-utils.js');
Object.assign(globalThis, utils);
require('../detect.js');

test('network probing keeps the resolved explicit port', async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return {
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => ''
    };
  };
  try {
    await globalThis.probeSiteEndpoints('https://port.example.com:8443', {
      cookieHeader: '',
      timeoutMs: 50
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(requested.length > 0);
  assert.ok(requested.every((url) => url.startsWith('https://port.example.com:8443/')));
});
```

在 `tests/background-checkin.test.js` 的授权测试中增加带 `baseUrl: 'https://two.example.com:8443'` 的站点，并断言请求为 `https://two.example.com:8443/*`。

- [ ] **Step 2: 运行并确认失败**

Run: `node --test tests/origin-routing.test.js tests/background-checkin.test.js`

Expected: FAIL；当前探测请求和批量授权会落到默认 443。

- [ ] **Step 3: 修改探测参数语义**

`probeSiteEndpoints` 接收 `targetOrigin`，内部同时推导 hostname：

```js
async function probeSiteEndpoints(targetOrigin, options = {}) {
  const origin = root.originFromDomain?.(targetOrigin) || '';
  const domain = root.normalizeDomain?.(targetOrigin) || '';
  if (!origin || !domain) return { type: null, signals: [], confidence: 'low' };
  const cookie = options.cookieHeader || await cookieHeaderForDomain(domain);
  const headers = cookie ? { Cookie: cookie } : {};
  const signals = [];
  const first = await fetchJsonQuiet(
    origin + '/api/public/site-info',
    headers,
    options.timeoutMs
  );
  // 将现有函数后续的 `/api/status`、`/api/about`、`/api/user/self`
  // 和 `/api/user/status` 请求全部保持为 `origin + path`。
}
```

`detectSite` 的调用点精确改为：

```js
const netProbe = await probeSiteEndpoints(origin, options);
```

- [ ] **Step 4: 修改权限记录**

新增 `permissionOriginForSite(value)`，通过 `originForSite` 生成 `origin + '/*'`；保留 `permissionOriginForDomain` 作为兼容别名。`countUnauthorizedSites` 的每个条目保存 `origin`，`requestUnauthorizedSiteAccess` 使用这些 origin 重新申请。

- [ ] **Step 5: 验证端口链路**

Run: `node --test tests/origin-routing.test.js tests/background-checkin.test.js tests/week1.test.js`

Expected: PASS；探测、权限、打开地址和复制地址均使用同一 Origin。

- [ ] **Step 6: 提交检查点（仅 Git 可用时）**

```powershell
git add detect.js permissions.js tests/origin-routing.test.js tests/background-checkin.test.js
git commit -m "fix: preserve explicit ports in detection and permissions"
```

### Task 3: 串行化偏好并保留迁移元数据

**Files:**
- Modify: `storage.js:32-35,167-177,187-215`
- Modify: `tests/storage-upsert.test.js`
- Modify: `tests/storage-backup.test.js`

- [ ] **Step 1: 写入并发偏好失败测试**

```js
test('concurrent preference patches retain both updates', async () => {
  const read = useMemoryStorage([]);
  await Promise.all([
    storage.savePrefs({ defaultCategory: 'relay' }),
    storage.savePrefs({ listCategoryFilter: 'relay' })
  ]);
  assert.equal(read().prefs.defaultCategory, 'relay');
  assert.equal(read().prefs.listCategoryFilter, 'relay');
});
```

在 `tests/storage-backup.test.js` 增加：

```js
test('site writes preserve the last migration timestamp', async () => {
  memory.sites = [];
  memory.siteDataMeta = { schemaVersion: 0 };
  await storage.migrateSiteData();
  const migratedAt = memory.siteDataMeta.migratedAt;
  await storage.saveSites([{ domain: 'meta.example.com' }]);
  assert.equal(memory.siteDataMeta.migratedAt, migratedAt);
});
```

- [ ] **Step 2: 验证两个测试失败**

Run: `node --test tests/storage-upsert.test.js tests/storage-backup.test.js`

Expected: FAIL；并发 patch 丢失一个字段，`saveSites` 删除 `migratedAt`。

- [ ] **Step 3: 增加偏好 queue**

```js
let prefsMutationQueue = Promise.resolve();

function enqueuePrefsMutation(task) {
  const operation = prefsMutationQueue.then(task);
  prefsMutationQueue = operation.catch(() => undefined);
  return operation;
}

async function savePrefs(patch = {}) {
  return enqueuePrefsMutation(async () => {
    const current = await loadPrefs();
    const next = normalizePrefs({ ...current, ...patch });
    await chromeStorageSet({ [PREFS_KEY]: next });
    return next;
  });
}
```

- [ ] **Step 4: 保留 site data meta**

`saveSites` 先读取 `loadSiteDataMeta()`，写入：

```js
[SITE_DATA_META_KEY]: {
  ...currentMeta,
  schemaVersion: SITE_DATA_SCHEMA_VERSION,
  updatedAt: now
}
```

- [ ] **Step 5: 验证存储测试**

Run: `node --test tests/storage-upsert.test.js tests/storage-backup.test.js`

Expected: PASS。

- [ ] **Step 6: 提交检查点（仅 Git 可用时）**

```powershell
git add storage.js tests/storage-upsert.test.js tests/storage-backup.test.js
git commit -m "fix: serialize preferences and preserve migration metadata"
```

### Task 4: 原子替换导入与物理清理过期备份

**Files:**
- Modify: `storage.js:262-356,481-570`
- Modify: `background.js:655-674`
- Modify: `tests/storage-backup.test.js`
- Modify: `tests/background-checkin.test.js:326-385`

- [ ] **Step 1: 写入失败测试**

```js
test('replaceSitesWithBackup captures the latest queued site edit', async () => {
  memory.siteBackups = [];
  memory.sites = [utils.normalizeSite({
    id: 'site-1',
    domain: 'before.example.com',
    note: 'old'
  })];

  const edit = storage.updateSiteById('site-1', { note: 'latest edit' });
  const replace = storage.replaceSitesWithBackup([
    { domain: 'after.example.com' }
  ]);
  const [, result] = await Promise.all([edit, replace]);
  await storage.restoreSiteBackup(result.backup.id);
  assert.equal(memory.sites[0].note, 'latest edit');
});

test('loading backups physically removes expired secret snapshots', async () => {
  memory.siteBackups = [{
    id: 'expired',
    reason: 'manual',
    createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
    sites: [{ domain: 'expired.example.com', keys: [{ key: 'sk-expired-secret-value' }] }]
  }];
  assert.deepEqual(await storage.listSiteBackups(), []);
  assert.deepEqual(memory.siteBackups, []);
  assert.doesNotMatch(JSON.stringify(memory), /sk-expired-secret-value/);
});
```

- [ ] **Step 2: 验证失败**

Run: `node --test tests/storage-backup.test.js`

Expected: FAIL；`replaceSitesWithBackup` 尚不存在，过期数据仍留在底层 memory。

- [ ] **Step 3: 建立 backup queue 与 unlocked reader**

```js
let backupMutationQueue = Promise.resolve();

function enqueueBackupMutation(task) {
  const operation = backupMutationQueue.then(task);
  backupMutationQueue = operation.catch(() => undefined);
  return operation;
}

async function readSiteBackupsUnlocked() {
  const data = await chromeStorageGet([SITE_BACKUPS_KEY]);
  const raw = Array.isArray(data[SITE_BACKUPS_KEY]) ? data[SITE_BACKUPS_KEY] : [];
  return { raw, normalized: normalizeSiteBackups(raw) };
}

async function loadSiteBackups() {
  return enqueueBackupMutation(async () => {
    const { raw, normalized } = await readSiteBackupsUnlocked();
    if (JSON.stringify(raw) !== JSON.stringify(normalized)) {
      await chromeStorageSet({ [SITE_BACKUPS_KEY]: normalized });
    }
    return normalized;
  });
}
```

`create/delete/clear` 备份均在 `enqueueBackupMutation` 内使用 `readSiteBackupsUnlocked`，避免嵌套进入同一 queue。

- [ ] **Step 4: 实现原子替换**

```js
async function replaceSitesWithBackup(incomingSites, reason = 'before-replace-import') {
  if (!Array.isArray(incomingSites) || !incomingSites.length) {
    throw new Error('导入内容中没有可用站点，已取消以保护现有数据');
  }
  return enqueueSiteMutation(async () => {
    const current = await loadSites();
    const backup = await createSiteBackup(current, reason);
    const next = root.mergeSites?.([], incomingSites, { preferIncoming: true }) || [];
    const sites = await saveSites(next);
    return { sites, backup };
  });
}
```

导出到 `root` 与 `module.exports`。background 的 replace 分支只调用这个 API；merge 分支继续调用 `importSites`。

- [ ] **Step 5: 更新 background import 测试 mock**

replace 测试注入：

```js
replaceSitesWithBackup: async (sites) => ({
  sites,
  backup: { id: 'backup-1', siteCount: 1 }
})
```

并断言 replace 响应携带该 backup。

- [ ] **Step 6: 验证**

Run: `node --test tests/storage-backup.test.js tests/background-checkin.test.js`

Expected: PASS。

- [ ] **Step 7: 提交检查点（仅 Git 可用时）**

```powershell
git add storage.js background.js tests/storage-backup.test.js tests/background-checkin.test.js
git commit -m "fix: make replace imports and backup retention atomic"
```

### Task 5: 区分余额任务 scope

**Files:**
- Modify: `storage.js:114-137`
- Modify: `balance-refresh.js:238-305`
- Modify: `tests/storage-backup.test.js`
- Modify: `tests/background-checkin.test.js:584-646`

- [ ] **Step 1: 写入混合 scope 失败测试**

```js
test('failed-only retry does not attach to an active full refresh', async () => {
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const app = loadBackground({
    sites: [{
      id: 'failed',
      domain: 'failed.example.com',
      name: 'Failed',
      type: 'newapi',
      balanceStatus: { status: 'failed' }
    }],
    globals: {
      saveBalanceRefreshProgress: async (progress) => progress,
      fetchSiteBalance: async () => {
        started();
        await gate;
        return { ok: true, balance: '$1.00' };
      },
      saveSites: async (sites) => sites
    }
  });

  const full = app.dispatch({ type: 'refreshAllBalances' });
  await startedPromise;
  const retry = await app.dispatch({ type: 'retryFailedBalances' });
  assert.equal(retry.ok, false);
  assert.equal(retry.code, 'balance_refresh_busy');
  assert.equal(retry.activeScope.kind, 'all');
  release();
  await full;
});
```

- [ ] **Step 2: 验证当前代码错误共享 Promise**

Run: `node --test tests/background-checkin.test.js`

Expected: FAIL；retry 当前会返回成功并声称已重试。

- [ ] **Step 3: 实现规范 scope**

```js
function normalizeRefreshScope(options = {}) {
  const ids = Array.isArray(options.siteIds)
    ? [...new Set(options.siteIds.map(String).filter(Boolean))].sort()
    : [];
  if (options.scope === 'failed') return { kind: 'failed', siteIds: ids };
  if (ids.length) return { kind: 'explicit', siteIds: ids };
  return { kind: 'all', siteIds: [] };
}

function sameRefreshScope(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
```

保存 `allBalanceRefreshScope`。同 scope 返回现有 Promise；不同 scope 返回：

```js
{
  ok: false,
  code: 'balance_refresh_busy',
  error: '另一项余额刷新正在进行，请等待完成后重试',
  activeScope: allBalanceRefreshScope
}
```

`retryFailedBalances` 传 `{ restart: true, siteIds: failedIds, scope: 'failed' }`，且 busy 时原样返回，不生成成功文案。

- [ ] **Step 4: 将 scope 写入 progress**

`normalizeBalanceRefreshProgress` 仅接受 `all/failed/explicit`，并清洗 `siteIds`。`refreshAllBalancesInternal` 的 running/interrupted/completed progress 均保留 scope。

- [ ] **Step 5: 验证余额测试**

Run: `node --test tests/background-checkin.test.js tests/storage-backup.test.js`

Expected: PASS；相同全量请求仍共享，混合 scope 明确 busy。

- [ ] **Step 6: 提交检查点（仅 Git 可用时）**

```powershell
git add balance-refresh.js storage.js tests/background-checkin.test.js tests/storage-backup.test.js
git commit -m "fix: distinguish concurrent balance refresh scopes"
```

### Task 6: 抽取共享 UI runtime 并修复复制与 Key 行为

**Files:**
- Create: `ui-runtime.js`
- Create: `tests/ui-runtime.test.js`
- Modify: `popup.html:361-364`
- Modify: `options.html:203-211,288-290`
- Modify: `popup.js:18-30,299-320,668-675,711-714`
- Modify: `options.js:15-27,148-175,236-338,595-604,754-784,787-790`
- Modify: `tests/popup-health.test.js`
- Modify: `tests/options-diagnostics.test.js`

- [ ] **Step 1: 写入共享模块失败测试**

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const ui = require('../ui-runtime.js');

test('clipboard failure is returned to the caller', async () => {
  const result = await ui.writeClipboard('value', {
    writeText: async () => { throw new Error('denied'); }
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /denied|复制失败/);
});

test('masked keys are diagnostic only', () => {
  assert.equal(ui.isUsableKey('sk-complete-key-value-123'), true);
  assert.equal(ui.isUsableKey('sk-abcd••••wxyz'), false);
  assert.deepEqual(ui.keyActionsFor('sk-abcd••••wxyz'), {
    canCopy: false,
    canSetDefault: false
  });
});
```

- [ ] **Step 2: 验证模块缺失**

Run: `node --test tests/ui-runtime.test.js`

Expected: FAIL with `Cannot find module '../ui-runtime.js'`。

- [ ] **Step 3: 创建 `ui-runtime.js`**

```js
(function (root) {
  function sendMessage(type, payload = {}) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (response) => {
          const error = chrome.runtime.lastError;
          resolve(error
            ? { ok: false, error: error.message }
            : (response || { ok: false, error: 'no response' }));
        });
      } catch (error) {
        resolve({ ok: false, error: String(error?.message || error) });
      }
    });
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/'/g, '&#39;');
  }

  function isUsableKey(value) {
    if (typeof root.isCompleteApiKey === 'function') return root.isCompleteApiKey(value);
    const key = String(value || '').trim();
    return key.length > 12
      && /^[A-Za-z0-9._~-]+$/.test(key)
      && !/\.{2,}/.test(key)
      && !/[•●○◦∙·…*]/.test(key);
  }

  function keyActionsFor(value) {
    const usable = isUsableKey(value);
    return { canCopy: usable, canSetDefault: usable };
  }

  async function writeClipboard(text, clipboard = root.navigator?.clipboard) {
    try {
      if (!clipboard?.writeText) throw new Error('剪贴板不可用');
      await clipboard.writeText(String(text ?? ''));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message || error || '复制失败') };
    }
  }

  function debounce(fn, wait = 120) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  const api = {
    sendMessage, escapeHtml, escapeAttr, isUsableKey,
    keyActionsFor, writeClipboard, debounce
  };
  root.PublicSiteUi = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
```

- [ ] **Step 4: 加载并使用共享模块**

popup HTML 顺序固定为 `site-utils.js` → `ui-runtime.js` → `balance-format.js` → `popup.js`；options HTML 顺序固定为 `site-utils.js` → `ui-runtime.js` → `options.js`。删除两页本地的 `send`、`escapeHtml`、`escapeAttr` 和 `hasCompleteKeyValue` 实现，分别绑定到 `PublicSiteUi` 对应函数。

页面复制 wrapper 必须返回 boolean：

```js
async function copyText(text, successMessage) {
  const result = await PublicSiteUi.writeClipboard(text);
  if (!result.ok) {
    setStatus(result.error || '复制失败', 'err');
    return false;
  }
  setStatus(successMessage || '已复制', 'ok');
  return true;
}
```

所有调用方不得在 `false` 后再次写成功状态。

- [ ] **Step 5: 禁用掩码 Key 操作并补 a11y**

`renderKeys` 根据 `PublicSiteUi.keyActionsFor(k.key)` 决定是否渲染复制/默认按钮；不可用 Key 显示“待修复”，保留删除。事件处理再次调用 `isUsableKey` 做防御校验。

给 options 搜索框增加 `aria-label="搜索收藏站点"`；动态 checkbox 增加 `aria-label="选择站点：站点名"`。

- [ ] **Step 6: 搜索使用 120ms debounce**

状态在 input 时立即更新，但列表渲染通过 `PublicSiteUi.debounce(render, 120)` 或 `debounce(renderList, 120)` 调度。

- [ ] **Step 7: 更新静态守卫测试并运行**

Run: `node --test tests/ui-runtime.test.js tests/popup-health.test.js tests/options-diagnostics.test.js`

Expected: PASS；测试确认脚本加载、可访问名称、掩码 Key 分支和复制结果分支。

- [ ] **Step 8: 提交检查点（仅 Git 可用时）**

```powershell
git add ui-runtime.js popup.html options.html popup.js options.js tests/ui-runtime.test.js tests/popup-health.test.js tests/options-diagnostics.test.js
git commit -m "refactor: share popup and options runtime behavior"
```

### Task 7: 将签到桥接移出活动加载图

**Files:**
- Modify: `background.js:18-33`
- Modify: `popup.html:361-365`
- Modify: `options.html:288-291`
- Modify: `tests/module-load-smoke.test.js:9-22`
- Modify: `tests/background-checkin.test.js:99-125`
- Modify: `tests/popup-health.test.js`
- Modify: `tests/options-diagnostics.test.js`

- [ ] **Step 1: 先更新运行图断言**

```js
assert.equal(app.imported.includes('bridge.js'), false);
assert.doesNotMatch(popupHtml, /bridge\.js/);
assert.doesNotMatch(optionsHtml, /bridge\.js/);
```

并从 `LOAD_ORDER` 删除 `bridge.js`。

- [ ] **Step 2: 运行并确认失败**

Run: `node --test tests/module-load-smoke.test.js tests/background-checkin.test.js tests/popup-health.test.js tests/options-diagnostics.test.js`

Expected: FAIL；三个入口当前仍加载 `bridge.js`。

- [ ] **Step 3: 删除活动引用**

从 background `importScripts`、popup 和 options HTML 删除 `bridge.js`。保留 `bridge.js` 与 `checkin-sync.js` 文件及遗留单测，但当前运行路径不再依赖它们。

- [ ] **Step 4: 验证加载图**

Run: `node --test tests/module-load-smoke.test.js tests/background-checkin.test.js tests/bridge.test.js tests/checkin-bridge.test.js tests/checkin-sync.test.js`

Expected: PASS；活动图不加载 bridge，遗留模块自身测试仍通过。

- [ ] **Step 5: 提交检查点（仅 Git 可用时）**

```powershell
git add background.js popup.html options.html tests/module-load-smoke.test.js tests/background-checkin.test.js tests/popup-health.test.js tests/options-diagnostics.test.js
git commit -m "refactor: remove dormant checkin bridge from runtime"
```

### Task 8: 修复图标并建立干净发布产物

**Files:**
- Modify: `icons/icon128.png`
- Create: `scripts/build-extension.js`
- Create: `scripts/verify-package.js`
- Create: `tests/release-package.test.js`
- Modify: `package.json`
- Modify: `tests/release-metadata.test.js`
- Modify: `README.md`

- [ ] **Step 1: 写入发布失败测试**

`tests/release-package.test.js` 应断言：

```js
test('128px icon is RGBA and has visible pixels', () => {
  const icon = inspectRgbaPng(path.join(root, 'icons', 'icon128.png'));
  assert.deepEqual({ width: icon.width, height: icon.height }, { width: 128, height: 128 });
  assert.ok(icon.nonTransparentPixels > 0);
});

test('dist contains exactly the runtime whitelist', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'public-site-hub-'));
  buildExtension(out);
  assert.deepEqual(listFiles(out), [...RUNTIME_FILES].sort());
  assert.equal(listFiles(out).some((file) =>
    /^(uploads|tests|scripts|docs)\//.test(file)), false);
});
```

- [ ] **Step 2: 验证当前空白图标和缺少构建 API**

Run: `node --test tests/release-package.test.js`

Expected: FAIL；当前 128px 图标的非透明像素数为 0，构建脚本不存在。

- [ ] **Step 3: 生成可见 128px 图标**

Run:

```powershell
@'
from PIL import Image
source = Image.open(r"icons\icon48.png").convert("RGBA")
icon = source.resize((128, 128), Image.Resampling.LANCZOS)
icon.save(r"icons\icon128.png")
'@ | python -
```

Expected: `icons/icon128.png` 为 128×128，且包含非透明像素。

- [ ] **Step 4: 创建白名单构建脚本**

`scripts/build-extension.js` 导出：

```js
const RUNTIME_FILES = [
  'manifest.json',
  'background.js',
  'balance-format.js',
  'balance-refresh.js',
  'balance.js',
  'detect.js',
  'import-export.js',
  'key-import.js',
  'key-provision.js',
  'options.html',
  'options.js',
  'page-scrape.js',
  'permissions.js',
  'popup.html',
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
];
```

`buildExtension(outDir = path.join(root, 'dist'))` 先安全删除该输出目录，再逐项复制并保持相对路径。不得用通配复制项目根目录。

- [ ] **Step 5: 创建产物校验脚本**

`scripts/verify-package.js`：

- 解析 PNG signature、IHDR 和 IDAT。
- 使用 `zlib.inflateSync` 和 PNG filter 0–4 还原 RGBA scanlines。
- 返回 `width`、`height`、`nonTransparentPixels`。
- 比较 `dist/` 文件与 `RUNTIME_FILES`。
- 检查 manifest 的 worker、popup、options、icons，以及 HTML 中的本地 `script/link/img` 引用均存在。
- 发现禁止目录、空白图标或缺失引用时以 exit code 1 退出。

- [ ] **Step 6: 更新 package scripts**

```json
{
  "scripts": {
    "test": "node --test tests/*.test.js",
    "test:coverage": "node --test --experimental-test-coverage tests/*.test.js",
    "build": "node scripts/build-extension.js",
    "verify:package": "node scripts/verify-package.js"
  }
}
```

更新 `release-metadata.test.js`，分别断言四个 script，而不是对 scripts 对象做旧的完整 deepEqual。README 开发段加入 `npm run build` 与 `npm run verify:package`。

- [ ] **Step 7: 验证产物**

Run:

```powershell
npm run build
npm run verify:package
node --test tests/release-package.test.js tests/release-metadata.test.js
```

Expected: PASS；`dist/` 不包含 uploads、tests、docs、scripts、bridge 或 checkin-sync。

- [ ] **Step 8: 提交检查点（仅 Git 可用时）**

```powershell
git add icons/icon128.png scripts/build-extension.js scripts/verify-package.js tests/release-package.test.js package.json tests/release-metadata.test.js README.md
git commit -m "build: create verified extension release package"
```

### Task 9: 全量验证与 Chromium 冒烟

**Files:**
- Modify: `docs/runtime-verification-1.0.md`

- [ ] **Step 1: 运行完整 Node 测试**

Run: `npm test`

Expected: exit 0，0 failures。

- [ ] **Step 2: 运行覆盖率**

Run: `npm run test:coverage`

Expected: exit 0；新增的 origin、storage、UI runtime、balance scope 和 package 路径均出现在覆盖报告中。若总覆盖率下降，先补测试。

- [ ] **Step 3: 运行全部语法检查**

```powershell
$failed = @()
Get-ChildItem -Recurse -File -Filter *.js |
  Where-Object { $_.FullName -notmatch '\\dist\\' } |
  ForEach-Object {
    node --check $_.FullName
    if ($LASTEXITCODE -ne 0) { $failed += $_.FullName }
  }
if ($failed.Count) { $failed; exit 1 }
```

Expected: exit 0。

- [ ] **Step 4: 重建并校验发布目录**

Run:

```powershell
npm run build
npm run verify:package
```

Expected: 两条命令 exit 0。

- [ ] **Step 5: 启动隔离 Chromium**

使用 `browser:control-in-app-browser` 或独立 Chrome profile 加载当前仓库构建出的 `dist/`。若使用命令行：

```powershell
$dist = (Resolve-Path 'dist').Path
$chrome = @(
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $chrome) { throw 'Chrome Stable not found' }
$profile = Join-Path $env:TEMP 'public-site-hub-smoke'
Start-Process -FilePath $chrome -ArgumentList @(
  "--user-data-dir=$profile",
  "--disable-extensions-except=$dist",
  "--load-extension=$dist",
  'chrome://extensions'
)
```

验证 service worker 无启动错误、popup/options 能打开、控制台无未处理异常、搜索与导航可用。

- [ ] **Step 6: 更新运行验证记录**

只勾选本轮真实执行并有证据的项目。需要登录站点或真实 Key 的项目保持未勾选，并在“执行结论”明确写为待人工验证；不得把 Node 绿灯表述为完整发布验收。

- [ ] **Step 7: 最终差异检查**

若 Git 可用，运行 `git diff --check` 与 `git status --short`；当前无 Git 时，至少核对 `dist/` 白名单输出、源文件清单和所有测试输出。
