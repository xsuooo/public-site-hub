const { test, expect, chromium } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EXTENSION_DIR = path.resolve(
  process.env.PUBLIC_SITE_HUB_EXTENSION_DIR || path.join(ROOT, 'dist')
);
const PROFILE_PREFIX = 'public-site-hub-ui-e2e-';

test.describe.configure({ mode: 'serial' });

function resolveBrowserExecutable() {
  const explicit = String(process.env.PUBLIC_SITE_HUB_BROWSER_PATH || '').trim();
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`PUBLIC_SITE_HUB_BROWSER_PATH does not exist: ${resolved}`);
    }
    return resolved;
  }

  const requested = String(process.env.PUBLIC_SITE_HUB_BROWSER || 'edge').trim().toLowerCase();
  if (requested === 'chromium') {
    const executable = chromium.executablePath();
    if (fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) return executable;
    throw new Error('Playwright Chromium is not installed; run npx playwright install chromium or use Edge');
  }
  if (requested !== 'edge') {
    const resolved = path.resolve(requested);
    if (fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) return resolved;
    throw new Error(`unsupported UI test browser or missing executable: ${requested}`);
  }

  const candidates = process.platform === 'win32'
    ? [
        process.env.ProgramFiles,
        process.env['ProgramFiles(x86)'],
        process.env.LOCALAPPDATA
      ].filter(Boolean).map((base) => path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    : process.platform === 'darwin'
      ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'];
  const executable = candidates.find((candidate) =>
    fs.statSync(candidate, { throwIfNoEntry: false })?.isFile());
  if (!executable) throw new Error('Edge executable not found; set PUBLIC_SITE_HUB_BROWSER_PATH');
  return executable;
}

function profileIsSafeToRemove(profileDir) {
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(profileDir));
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
    && path.basename(profileDir).startsWith(PROFILE_PREFIX);
}

function makeSite(index, health = 'healthy') {
  const suffix = String(index + 1).padStart(3, '0');
  const now = Date.now() - index * 60_000;
  const balanceState = health === 'healthy'
    ? {
        balance: `$${(20 - (index % 10)).toFixed(2)}`,
        balanceUpdatedAt: now,
        balanceStatus: { status: 'ok', lastSuccessAt: now }
      }
    : health === 'failed'
      ? {
          balanceStatus: {
            status: 'failed',
            lastError: { code: 'network_error', message: 'Synthetic network failure' }
          }
        }
      : { balanceStatus: { status: 'idle' } };

  return {
    id: `synthetic-site-${suffix}`,
    domain: `site-${suffix}.invalid`,
    baseUrl: `https://site-${suffix}.invalid`,
    pageUrl: `https://site-${suffix}.invalid/console`,
    name: `Synthetic Site ${suffix}`,
    category: index % 2 ? 'relay' : 'gongyi',
    type: index % 3 ? 'newapi' : 'auto',
    tags: [index % 2 ? 'group-b' : 'group-a', index % 3 ? 'general' : 'claude'],
    note: `Synthetic fixture ${suffix}`,
    keys: index % 5 === 0
      ? [{ id: `masked-${suffix}`, name: 'Masked test value', key: 'test***masked' }]
      : [],
    ...balanceState
  };
}

function scenarioSites(name) {
  if (name === 'empty') return [];
  if (name === 'single') return [makeSite(0, 'healthy')];
  const count = name === 'hundred' ? 100 : 6;
  const health = ['healthy', 'failed', 'needsAttention'];
  return Array.from({ length: count }, (_, index) => makeSite(index, health[index % health.length]));
}

async function launchScenario(name) {
  if (!fs.statSync(path.join(EXTENSION_DIR, 'manifest.json'), { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`built extension not found at ${EXTENSION_DIR}; run npm run build first`);
  }
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), PROFILE_PREFIX));
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath: resolveBrowserExecutable(),
      headless: process.env.PUBLIC_SITE_HUB_UI_HEADED !== '1',
      viewport: { width: 1280, height: 900 },
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--metrics-recording-only',
        '--disable-breakpad',
        '--disable-dev-shm-usage'
      ]
    });

    let worker = context.serviceWorkers().find((item) => item.url().endsWith('/background.js'));
    if (!worker) {
      worker = await context.waitForEvent('serviceworker', {
        predicate: (item) => item.url().startsWith('chrome-extension://')
          && item.url().endsWith('/background.js'),
        timeout: 20_000
      });
    }
    const match = worker.url().match(/^chrome-extension:\/\/([^/]+)\/background\.js$/);
    if (!match) throw new Error(`unable to derive extension ID from ${worker.url()}`);

    // 启动迁移可能在空存储上写回 sites:[]；必须等它结束后再 seed，
    // 并带上当前 schemaVersion，避免后续迁移再把夹具清空。
    await worker.evaluate(async () => {
      if (typeof migrateSiteData === 'function') await migrateSiteData();
      if (typeof loadSiteBackups === 'function') await loadSiteBackups();
    });

    const sites = scenarioSites(name);
    await worker.evaluate(async (payload) => {
      await chrome.storage.local.clear();
      const schemaVersion = typeof SITE_DATA_SCHEMA_VERSION === 'number'
        ? SITE_DATA_SCHEMA_VERSION
        : 5;
      const now = Date.now();
      await chrome.storage.local.set({
        ...payload,
        siteDataMeta: {
          schemaVersion,
          updatedAt: now,
          migratedAt: now
        }
      });
      const stored = await chrome.storage.local.get(['sites']);
      const count = Array.isArray(stored.sites) ? stored.sites.length : 0;
      if (count !== payload.sites.length) {
        throw new Error(
          `UI fixture seed mismatch: expected ${payload.sites.length}, got ${count}`
        );
      }
    }, {
      sites,
      prefs: {
        autoSyncCheckin: false,
        defaultCategory: 'gongyi',
        listCategoryFilter: 'all',
        preferUnlimitedAutoKey: false
      },
      siteBackups: [],
      balanceRefreshProgress: {
        status: 'idle',
        total: 0,
        completed: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0
      }
    });

    return { context, extensionId: match[1], profileDir, sites };
  } catch (error) {
    await context?.close().catch(() => undefined);
    if (profileIsSafeToRemove(profileDir)) {
      fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    throw error;
  }
}

async function closeScenario(scenario) {
  await scenario.context.close();
  if (!profileIsSafeToRemove(scenario.profileDir)) {
    throw new Error(`refusing to remove unsafe profile path: ${scenario.profileDir}`);
  }
  fs.rmSync(scenario.profileDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100
  });
  expect(fs.existsSync(scenario.profileDir)).toBe(false);
}

async function openExtensionPage(scenario, file, viewport, colorScheme = 'light') {
  const page = await scenario.context.newPage();
  const issues = [];
  page.on('pageerror', (error) => issues.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (['warning', 'error', 'assert'].includes(message.type())) {
      issues.push(`${message.type()}: ${message.text()}`);
    }
  });
  await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme });
  await page.goto(`chrome-extension://${scenario.extensionId}/${file}`, { waitUntil: 'load' });
  return { page, issues };
}

async function assertNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => {
    const root = document.documentElement;
    const controls = [...document.querySelectorAll('button, input, select, textarea, [role="menuitem"]')]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          text: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 40) || element.id,
          left: rect.left,
          right: rect.right
        };
      })
      .filter((entry) => entry.left < -1 || entry.right > window.innerWidth + 1);
    return {
      clientWidth: root.clientWidth,
      scrollWidth: root.scrollWidth,
      innerWidth: window.innerWidth,
      controls
    };
  });
  expect(metrics.scrollWidth, `${label} document overflow`).toBeLessThanOrEqual(metrics.clientWidth + 1);
  expect(metrics.controls, `${label} controls outside viewport`).toEqual([]);
}

async function assertNoRuntimeIssues(target, label) {
  await target.page.waitForTimeout(100);
  expect(target.issues, `${label} emitted console warnings or errors`).toEqual([]);
}

test('empty scenario renders honest Popup and Options empty states', async ({}, testInfo) => {
  const scenario = await launchScenario('empty');
  try {
    const popup = await openExtensionPage(scenario, 'popup.html', { width: 420, height: 640 });
    await expect(popup.page.locator('.popup-shell')).toHaveAttribute('data-popup-state', 'empty');
    await expect(popup.page.locator('#list')).toHaveAttribute('data-list-state', 'empty');
    await expect(popup.page.locator('.site-card')).toHaveCount(0);
    await expect(popup.page.locator('.popup-empty h2')).toContainText('还没有收藏站点');
    await assertNoHorizontalOverflow(popup.page, 'empty Popup');
    await popup.page.screenshot({ path: testInfo.outputPath('popup-empty.png') });
    await assertNoRuntimeIssues(popup, 'empty Popup');

    const options = await openExtensionPage(
      scenario,
      'options.html#view=sites',
      { width: 1280, height: 900 }
    );
    await expect(options.page.locator('#siteList .empty')).toContainText('暂无站点');
    await expect(options.page.locator('.site-item')).toHaveCount(0);
    await expect(options.page).toHaveURL(/#view=sites$/);
    await assertNoHorizontalOverflow(options.page, 'empty Options');
    await options.page.screenshot({ path: testInfo.outputPath('options-empty.png') });
    await options.page.locator('[data-view="diagnostics"]').click();
    await expect(options.page).toHaveURL(/#view=diagnostics$/);
    await expect(options.page.locator('#diagnosticsAllClear')).toBeVisible();
    await expect(options.page.locator('#diagnosticOrphanedCount')).toHaveText('0');
    await assertNoHorizontalOverflow(options.page, 'all-clear diagnostics');
    await options.page.screenshot({ path: testInfo.outputPath('options-diagnostics-all-clear.png') });
    await assertNoRuntimeIssues(options, 'empty Options');
  } finally {
    await closeScenario(scenario);
  }
});

test('single scenario supports keyboard menus, routes, and drawer focus containment', async ({}, testInfo) => {
  const scenario = await launchScenario('single');
  try {
    const popup = await openExtensionPage(scenario, 'popup.html', { width: 420, height: 640 });
    await expect(popup.page.locator('.site-card')).toHaveCount(1);
    await popup.page.locator('#tagFilterTrigger').click();
    const radios = popup.page.locator('#tagFilter [role="menuitemradio"]');
    await expect(radios).toHaveCount(3);
    await expect(popup.page.locator('#tagFilter [aria-checked="true"]')).toHaveCount(1);
    await expect(popup.page.locator('#tagFilter [aria-checked="true"]')).toBeFocused();
    await popup.page.keyboard.press('End');
    await expect(radios.last()).toBeFocused();
    await popup.page.keyboard.press('Escape');
    await expect(popup.page.locator('#tagFilterTrigger')).toBeFocused();
    await assertNoHorizontalOverflow(popup.page, 'single Popup');
    await assertNoRuntimeIssues(popup, 'single Popup');

    const options = await openExtensionPage(
      scenario,
      'options.html#view=sites',
      { width: 1280, height: 900 }
    );
    await expect(options.page.locator('.site-item')).toHaveCount(1);
    await expect(options.page.locator('.table-health .status-pill')).toBeVisible();
    const addButton = options.page.locator('#openAddDrawer');
    await addButton.focus();
    await addButton.press('Enter');
    await expect(options.page.locator('#editor')).toBeVisible();
    await expect(options.page.locator('#addUrl')).toBeFocused();
    for (let index = 0; index < 12; index += 1) await options.page.keyboard.press('Tab');
    expect(await options.page.evaluate(() =>
      document.querySelector('#editor')?.contains(document.activeElement))).toBe(true);
    await options.page.keyboard.press('Escape');
    await expect(options.page.locator('#editor')).toBeHidden();
    await expect(addButton).toBeFocused();
    await options.page.locator('[data-view="import"]').press('Enter');
    await expect(options.page).toHaveURL(/#view=import$/);
    await expect(options.page.locator('[data-workspace="import"]')).toBeVisible();
    await assertNoHorizontalOverflow(options.page, 'single Options');
    await options.page.screenshot({ path: testInfo.outputPath('options-single.png') });
    await assertNoRuntimeIssues(options, 'single Options');
  } finally {
    await closeScenario(scenario);
  }
});

test('mixed scenario covers filters, health sorting, dark mode, and narrow layouts', async ({}, testInfo) => {
  const scenario = await launchScenario('mixed');
  try {
    const popup = await openExtensionPage(
      scenario,
      'popup.html',
      { width: 420, height: 640 },
      'dark'
    );
    await expect(popup.page.locator('.site-card')).toHaveCount(6);
    expect(await popup.page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true);
    const darkCanvas = await popup.page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim());
    expect(darkCanvas).not.toBe('');
    await popup.page.locator('#healthSummary [data-health="failed"]').click();
    await expect(popup.page.locator('.site-card')).toHaveCount(2);
    await popup.page.locator('#healthSummary [data-health="all"]').click();
    await popup.page.locator('#categoryFilter [data-cat="relay"]').click();
    await expect(popup.page.locator('.site-card')).toHaveCount(3);
    await assertNoHorizontalOverflow(popup.page, 'mixed dark Popup');
    await popup.page.screenshot({ path: testInfo.outputPath('popup-mixed-dark.png') });
    await assertNoRuntimeIssues(popup, 'mixed dark Popup');

    const options = await openExtensionPage(
      scenario,
      'options.html#view=sites',
      { width: 768, height: 1024 },
      'dark'
    );
    await expect(options.page.locator('.site-item')).toHaveCount(6);
    await expect(options.page.locator('.site-table-head')).toBeHidden();
    await options.page.locator('#listSort').selectOption('health');
    await expect(options.page.locator('.site-item').first().locator('.status-pill')).toContainText('余额失败');
    await options.page.locator('#listTag').selectOption('group-a');
    await expect(options.page.locator('.site-item')).toHaveCount(3);
    await assertNoHorizontalOverflow(options.page, 'mixed narrow Options');
    await options.page.setViewportSize({ width: 614, height: 819 });
    await assertNoHorizontalOverflow(options.page, 'mixed Options 125 percent equivalent');
    await options.page.locator('#openAddDrawer').click();
    await expect(options.page.locator('#editor')).toBeVisible();
    const drawerWidth = await options.page.locator('#editor').evaluate((element) =>
      element.getBoundingClientRect().width);
    const viewportWidth = await options.page.evaluate(() => window.innerWidth);
    expect(Math.abs(drawerWidth - viewportWidth)).toBeLessThanOrEqual(1);
    await options.page.keyboard.press('Escape');
    await options.page.screenshot({ path: testInfo.outputPath('options-mixed-dark-narrow.png') });
    await assertNoRuntimeIssues(options, 'mixed dark Options');
  } finally {
    await closeScenario(scenario);
  }
});

test('hundred scenario keeps all results reachable without horizontal overflow', async ({}, testInfo) => {
  const scenario = await launchScenario('hundred');
  try {
    const popup = await openExtensionPage(scenario, 'popup.html', { width: 420, height: 640 });
    await expect(popup.page.locator('.site-card')).toHaveCount(100);
    const popupScroll = await popup.page.locator('#list').evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY
    }));
    expect(popupScroll.scrollHeight).toBeGreaterThan(popupScroll.clientHeight);
    expect(popupScroll.overflowY).toBe('auto');
    await popup.page.locator('#search').fill('Synthetic Site 100');
    await expect(popup.page.locator('.site-card')).toHaveCount(1);
    await popup.page.locator('#search').fill('');
    await expect(popup.page.locator('.site-card')).toHaveCount(100);
    await assertNoHorizontalOverflow(popup.page, 'hundred Popup');
    await popup.page.screenshot({ path: testInfo.outputPath('popup-hundred.png') });
    await assertNoRuntimeIssues(popup, 'hundred Popup');

    const options = await openExtensionPage(
      scenario,
      'options.html#view=sites',
      { width: 1280, height: 900 }
    );
    await expect(options.page.locator('.site-item')).toHaveCount(100);
    await expect(options.page.locator('.site-table-head')).toBeVisible();
    await assertNoHorizontalOverflow(options.page, 'hundred desktop Options');
    await options.page.setViewportSize({ width: 1024, height: 720 });
    await expect(options.page.locator('.site-table-head')).toBeHidden();
    await assertNoHorizontalOverflow(options.page, 'hundred Options 125 percent equivalent');
    await options.page.screenshot({ path: testInfo.outputPath('options-hundred.png') });
    await assertNoRuntimeIssues(options, 'hundred Options');
  } finally {
    await closeScenario(scenario);
  }
});
