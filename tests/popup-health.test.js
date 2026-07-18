const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'popup.css'), 'utf8');
const sharedCss = fs.readFileSync(path.join(root, 'shared-ui.css'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  const signatureEnd = source.indexOf('\n', start);
  const bodyStart = source.lastIndexOf('{', signatureEnd);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`could not extract ${name}`);
}

function visibleText(fragment) {
  return fragment
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

test('popup loads layered local CSS and keeps only the site list scrollable', () => {
  assert.match(html, /shared-ui\.css[\s\S]*popup\.css/);
  assert.doesNotMatch(html, /<style\b|\sstyle=/i);
  assert.match(css, /html,\s*\nbody\s*\{[^}]*width:\s*420px[^}]*height:\s*640px[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.popup-shell\s*\{[^}]*grid-template-rows:\s*auto auto auto auto minmax\(0,\s*1fr\)[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.site-list\s*\{[^}]*overflow-y:\s*auto[^}]*overflow-x:\s*hidden/s);
  assert.match(css, /\.site-card\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.site-card-actions \.btn\s*\{[^}]*min-width:\s*0/s);
  assert.match(html, /id="saveCurrent"[^>]*>收藏当前页<\/button>/);
  assert.match(html, /id="refreshBalances"/);
});

test('popup typography uses the approved local font stacks without synthetic weights', () => {
  assert.match(sharedCss, /--font-ui:[^;]*Segoe UI Variable Text[^;]*Noto Sans SC[^;]*Microsoft YaHei UI/);
  assert.match(sharedCss, /--font-mono:[^;]*Cascadia Mono[^;]*Consolas/);
  assert.match(sharedCss, /font-synthesis:\s*none/);
  assert.doesNotMatch(`${sharedCss}\n${css}`, /font-weight:\s*(?:650|750)\b/);
  assert.doesNotMatch(`${sharedCss}\n${css}`, /font-size:\s*10px\b/);
  assert.match(sharedCss, /\.site-name-button\s*\{[\s\S]*?font-size:\s*14px[\s\S]*?font-weight:\s*600/s);
  assert.match(sharedCss, /\.site-origin\s*\{[\s\S]*?font-family:\s*var\(--font-mono\)/s);
});

test('popup renders Key tails as ordinary UI text instead of emphasized monospace text', () => {
  const renderSource = extractFunction(js, 'render');
  const combinedCss = `${sharedCss}\n${css}`;
  assert.match(renderSource, /<span class="key-mask">[\s\S]*?<\/span>/);
  assert.doesNotMatch(renderSource, /<(?:strong|b)[^>]*class="[^"]*key-mask/);
  assert.doesNotMatch(renderSource, /class="[^"]*key-mask[^"]*\bmono\b/);
  assert.match(combinedCss, /\.key-mask\s*\{[^}]*font-family:\s*var\(--font-ui\)/s);
  assert.match(combinedCss, /\.key-mask\s*\{[^}]*font-weight:\s*500/s);
  assert.doesNotMatch(combinedCss, /\.key-mask\s*\{[^}]*font-family:\s*var\(--font-mono\)/s);
});

test('popup keeps collection and check-in completely separate', () => {
  assert.doesNotMatch(html, /签到|同步|联动/);
  assert.doesNotMatch(js, /(?:pushToCheckin|setCheckinOptIn|getCheckinStatus|retryFailedCheckin|checkinStatusMeta)/);
  assert.match(js, /deriveSiteHealth\(site,\s*\{\s*includeCheckin:\s*false\s*\}\)/);
});

test('popup keeps list filters separate from the saved collection category', () => {
  for (const id of ['categoryFilter', 'tagFilter', 'tagFilterTrigger', 'search', 'saveCategory', 'saveCategoryTrigger']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /data-cat="all"[\s\S]*data-cat="gongyi"[\s\S]*data-cat="relay"/);
  assert.match(js, /categoryFilter:\s*'all'/);
  assert.match(js, /saveCategory:\s*'gongyi'/);
  assert.match(js, /collectSiteTags/);
  assert.match(js, /savePrefs[\s\S]*defaultCategory/);
  assert.match(js, /\$\('listScope'\)\.textContent = String\(total\)/);
  assert.match(js, /data-act="reset-filters"/);
  assert.doesNotMatch(js, /isFiltered \? visibleCount : total/);
});

test('popup exposes the approved direct actions and guards sensitive Key operations', () => {
  const renderSource = extractFunction(js, 'render');
  for (const action of ['open', 'copy-client', 'copy-key', 'refresh', 'auto-key', 'edit', 'redetect', 'delete']) {
    assert.match(renderSource, new RegExp(`data-act=["']${action}["']`));
  }
  assert.match(js, /const hasCompleteKeyValue = PublicSiteUi\.isUsableKey/);
  assert.match(renderSource, /hasCompleteKeyValue\(key\?\.key\)/);
  assert.match(js, /create_confirmation_required|needsCreateConfirm/);
  assert.match(js, /allowCreate:\s*true/);
  assert.match(js, /confirmWithDialog\(\s*'keyCreateDialog'/);
  assert.match(js, /formatApiBaseV1\(site\)/);
  assert.doesNotMatch(js, /window\.confirm|\bconfirm\(/);
  assert.match(html, /<dialog[^>]+id="deleteDialog"/);
  assert.match(html, /<dialog[^>]+id="keyCreateDialog"/);
});

test('popup menus expose accessible state and Escape focus restoration', () => {
  const menuStart = html.indexOf('id="saveCategoryMenu"');
  const menuEnd = html.indexOf('<select id="saveCategory"', menuStart);
  assert.notEqual(menuStart, -1, 'save category menu should exist');
  assert.notEqual(menuEnd, -1, 'save category menu should end before its fallback select');
  const menuSource = html.slice(menuStart, menuEnd);
  assert.match(menuSource, />\s*收藏分类\s*</);
  assert.doesNotMatch(menuSource, /收藏为(?:公益站|中转站)/);
  for (const [category, label] of [['gongyi', '公益站'], ['relay', '中转站']]) {
    const option = menuSource.match(new RegExp(
      `<button(?=[^>]*data-save-category=["']${category}["'])(?=[^>]*role=["']menuitemradio["'])(?=[^>]*aria-checked=["'](?:true|false)["'])[^>]*>([\\s\\S]*?)<\\/button>`
    ));
    assert.ok(option, `${category} should be an aria-checked menuitemradio`);
    assert.equal(visibleText(option[1]), label);
  }
  assert.match(css, /\.save-category-menu \.menu-item\[aria-checked="true"\]::after\s*\{[^}]*content:\s*"✓"/s);
  const renderFiltersSource = extractFunction(js, 'renderFilters');
  assert.match(renderFiltersSource, /setAttribute\('aria-checked',\s*String\(item\.dataset\.saveCategory === state\.saveCategory\)\)/);
  assert.match(renderFiltersSource, /saveCategoryTrigger[\s\S]*setAttribute\('aria-label'/);
  assert.match(renderFiltersSource, /saveCategoryTrigger[\s\S]*(?:\.title\s*=|setAttribute\('title')/);
  const openPopoverSource = extractFunction(js, 'openPopover');
  assert.match(openPopoverSource, /\[role=["']menuitemradio["']\]\[aria-checked=["']true["']\]/);
  assert.match(openPopoverSource, /button:not\(\[disabled\]\)/);
  const categoryMenuKeydownStart = js.indexOf("$('saveCategoryMenu')?.addEventListener('keydown'");
  const categoryMenuKeydownEnd = js.indexOf("$('tagFilterTrigger')", categoryMenuKeydownStart);
  assert.notEqual(categoryMenuKeydownStart, -1, 'save category menu should handle keyboard navigation');
  assert.notEqual(categoryMenuKeydownEnd, -1, 'save category keyboard handler should be scoped');
  const categoryMenuKeydownSource = js.slice(categoryMenuKeydownStart, categoryMenuKeydownEnd);
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
    assert.match(categoryMenuKeydownSource, new RegExp(`["']${key}["']`));
  }
  assert.match(categoryMenuKeydownSource, /preventDefault\(\)/);
  assert.match(categoryMenuKeydownSource, /\.focus\(\)/);
  assert.match(html, /aria-controls="saveCategoryMenu"/);
  assert.match(html, /aria-controls="tagFilter"/);
  assert.match(html, /aria-controls="quickTools"/);
  assert.match(js, /function positionPopover/);
  assert.match(js, /event\.key !== 'Escape'/);
  assert.match(js, /closePopover\(trigger, openMenu, true\)/);
  assert.match(sharedCss, /:focus-visible/);
  assert.match(sharedCss, /prefers-reduced-motion/);
});

test('popup exposes a cooperative stop control for an active balance refresh', () => {
  assert.match(html, /id="balanceProgress"[^>]*role="region"[^>]*aria-describedby="balanceProgressText balanceProgressCount"[^>]*tabindex="-1"/);
  assert.match(html, /id="balanceProgressText"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="balanceProgressBar"[^>]*aria-busy="false"/);
  assert.match(html, /id="stopBalanceRefresh"[^>]*title="当前站点处理完成后停止"[^>]*hidden/);
  assert.match(css, /\.progress-strip\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) 60px auto/s);
  assert.match(css, /\.progress-stop\s*\{[^}]*min-height:\s*24px/s);
  const progressSource = extractFunction(js, 'renderBalanceProgress');
  assert.match(progressSource, /\['running', 'stopping'\]\.includes\(status\)/);
  assert.match(progressSource, /\['interrupted', 'stopped'\]\.includes\(status\)/);
  assert.match(progressSource, /stopButton\.disabled = status === 'stopping' \|\| !progress\.runId/);
  assert.match(progressSource, /refreshButton\.disabled = isActive \|\| state\.busy/);
  assert.match(progressSource, /bar\?\.setAttribute\('aria-busy', String\(isActive\)\)/);
  assert.match(progressSource, /当前站点完成后结束/);
  assert.match(progressSource, /余额刷新已停止/);
  const stopStart = js.indexOf("$('stopBalanceRefresh')?.addEventListener('click'");
  const stopEnd = js.indexOf("$('openOptions2')", stopStart);
  assert.notEqual(stopStart, -1, 'stop balance listener should exist');
  assert.notEqual(stopEnd, -1, 'stop balance listener should be scoped');
  const stopSource = js.slice(stopStart, stopEnd);
  assert.match(stopSource, /status:\s*'stopping'[\s\S]*send\('stopBalanceRefresh',\s*\{ runId \}\)/);
  assert.doesNotMatch(stopSource, /runMutation\s*\(/);
  const applyProgressSource = extractFunction(js, 'applyBalanceRefreshProgress');
  assert.match(applyProgressSource, /incoming\?\.runId === pendingRunId[\s\S]*incoming\?\.status === 'running'[\s\S]*return false/);
});

test('popup reports messaging and clipboard failures through the shared runtime', () => {
  assert.match(html, /site-utils\.js[\s\S]*permissions\.js[\s\S]*ui-runtime\.js[\s\S]*balance-format\.js[\s\S]*popup\.js/);
  assert.match(js, /requestAccessForAction[\s\S]*requestSiteAccessFromGesture/);
  assert.match(js, /saveCurrent[\s\S]*requestAccessForAction[\s\S]*send\('saveCurrentTab'/);
  assert.match(js, /refreshBalances[\s\S]*requestAccessForAction[\s\S]*send\('refreshAllBalances'/);
  assert.match(js, /permissionRetry[\s\S]*requestAccessForAction/);
  assert.doesNotMatch(html, /bridge\.js/);
  assert.match(js, /PublicSiteUi\.sendMessage/);
  assert.match(js, /PublicSiteUi\.writeClipboard/);
  assert.match(js, /PublicSiteUi\.debounce\(render,\s*120\)/);
  assert.match(js, /function runMutation[\s\S]*state\.mutationBusy/);
  assert.doesNotMatch(js, /function originForSite\s*\(/);
  assert.match(js, /escapeHtml\(originForSite\(site\)\)/);
});

test('popup continues bulk refresh after permission denial but blocks single-site work', async () => {
  const source = `async ${extractFunction(js, 'requestAccessForAction')}`;
  const notices = [];
  const context = {
    requestSiteAccessFromGesture: async () => ({
      ok: false,
      code: 'site_permission_denied',
      error: '未获得站点访问权限'
    }),
    toast: (...args) => notices.push(args),
    resolveErrorAction: () => null
  };
  vm.runInNewContext(`${source}; this.requestAccessForAction = requestAccessForAction`, context);

  assert.equal(await context.requestAccessForAction([], null, 'refreshAllBalances', {
    continueOnDenied: true
  }), true);
  assert.equal(await context.requestAccessForAction([], {}, 'refreshBalance'), false);
  assert.match(notices[0][0], /跳过.*已授权/);
  assert.match(notices[1][0], /未获得站点访问权限/);

  const refreshStart = js.indexOf("$('refreshBalances').addEventListener('click'");
  const refreshSend = js.indexOf("send('refreshAllBalances'", refreshStart);
  assert.match(js.slice(refreshStart, refreshSend), /continueOnDenied:\s*true/);
  const retryStart = js.indexOf("popupRetryFailed.addEventListener('click'");
  const retrySend = js.indexOf("runQuickBalanceAction('retryFailedBalances'", retryStart);
  assert.match(js.slice(retryStart, retrySend), /continueOnDenied:\s*true/);
});

test('manage click events cannot become edit ids and edit links use the new route', () => {
  const openOptionsSource = extractFunction(js, 'openOptions');
  const calls = [];
  const context = {
    chrome: {
      tabs: { create: (options) => calls.push(options) },
      runtime: {
        getURL: (file) => `chrome-extension://test/${file}`,
        openOptionsPage: () => calls.push('open-options')
      }
    },
    window: { open: (url) => calls.push({ fallback: url }) }
  };
  vm.runInNewContext(`${openOptionsSource}; this.openOptions = openOptions`, context);

  context.openOptions({ type: 'click' });
  assert.deepEqual(calls, ['open-options']);

  calls.length = 0;
  context.openOptions('site id');
  assert.equal(calls[0].url,
    'chrome-extension://test/options.html#view=sites&edit=site%20id');
});
