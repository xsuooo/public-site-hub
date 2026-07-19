const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const uiRuntime = require('../ui-runtime.js');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'options.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'options.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'options.css'), 'utf8');
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

test('options uses layered local CSS and preserves the hidden contract', () => {
  assert.match(html, /shared-ui\.css[\s\S]*options\.css/);
  assert.doesNotMatch(html, /<style\b|\sstyle=/i);
  assert.doesNotMatch(js, /style="/i);
  assert.match(sharedCss, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important\s*;/s);
  assert.match(sharedCss, /:focus-visible/);
  assert.match(sharedCss, /prefers-reduced-motion/);
});

test('options exposes three persistent workspaces and new plus legacy hash routing', () => {
  for (const view of ['sites', 'import', 'diagnostics']) {
    assert.match(html, new RegExp(`data-workspace=["']${view}["']`));
    assert.match(html, new RegExp(`data-view=["']${view}["']`));
  }
  assert.match(js, /new URLSearchParams\(raw\)/);
  assert.match(js, /params\.get\('view'\)/);
  assert.match(js, /params\.get\('edit'\)/);
  assert.match(js, /#\$\{params\.toString\(\)\}/);
  assert.match(js, /window\.addEventListener\('hashchange',\s*applyCurrentRoute\)/);
});

test('options drawer is modal, responsive and keyboard-contained', () => {
  assert.match(html, /<aside[^>]+id="editor"[^>]+role="dialog"[^>]+aria-modal="true"/);
  assert.match(html, /id="drawerScrim"/);
  assert.match(js, /optionsShell'\)\.inert\s*=\s*true/);
  assert.match(js, /focusableIn\(\$\('editor'\)\)/);
  assert.match(js, /event\.key === 'Escape'/);
  assert.match(css, /@media\s*\(max-width:\s*860px\)[\s\S]*?\.drawer\s*\{[^}]*width:\s*100vw/s);
});

test('high-risk auto-key preference lives in diagnostics and defaults remain controller-owned', () => {
  const diagnosticsStart = html.indexOf('data-workspace="diagnostics"');
  const preference = html.indexOf('id="preferUnlimitedAutoKey"');
  assert.ok(diagnosticsStart >= 0 && preference > diagnosticsStart);
  assert.match(js, /preferUnlimitedAutoKey/);
  const prefStart = js.indexOf("const unlimitedKeyPref = $('preferUnlimitedAutoKey')");
  const prefSource = js.slice(prefStart, js.indexOf("$('refreshAll')", prefStart));
  assert.match(prefSource, /await confirmAction\(/);
  assert.ok(prefSource.indexOf('confirmAction') < prefSource.indexOf("send('savePrefs'"));
  assert.match(html, /高风险能力默认关闭/);
});

test('options remains a standalone collection manager', () => {
  for (const id of [
    'autoSyncCheckin', 'pushAllCheckin', 'syncCheckin', 'checkinDiagnostics',
    'checkinConnection', 'checkinLastRun', 'recheckCheckin', 'retryFailedCheckin', 'exportCheckin'
  ]) {
    assert.doesNotMatch(html, new RegExp(`id=["']${id}["']`, 'i'));
  }
  assert.doesNotMatch(js, /(?:pushToCheckin|setCheckinOptIn|getCheckinStatus|retryFailedCheckin|pingCheckin)/);
  for (const id of ['detectAndAdd', 'refreshAll', 'addTags', 'editTags']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
});

test('all imports require a current preview and remain mutually exclusive', () => {
  assert.match(html, /id="previewImport"/);
  assert.match(js, /function hasCurrentImportPreview/);
  assert.match(js, /async function previewImportData/);
  const runImport = extractFunction(js, 'runImport');
  assert.match(runImport, /if\s*\(state\.importBusy\)\s*return/);
  assert.match(runImport, /if\s*\(!hasCurrentImportPreview\(\)\)[\s\S]*?await previewImportData\(\)[\s\S]*?return/);
  assert.match(runImport, /state\.importBusy\s*=\s*true/);
  assert.match(runImport, /\$\('doImport'\)\.disabled\s*=\s*true/);
  assert.match(runImport, /\$\('doReplace'\)\.disabled\s*=\s*true/);
  assert.match(runImport, /finally\s*\{[\s\S]*?state\.importBusy\s*=\s*false/);
  assert.match(js, /title:\s*'确认替换导入？'/);
  assert.match(js, /跳过：\$\{skipped\}/);
  assert.match(js, /preview\.duplicates/);
  assert.match(js, /IMPORT_MAX_BYTES/);
  assert.match(js, /IMPORT_MAX_SITES/);
  assert.match(js, /file\.size/);
  assert.match(js, /previewUpdatedAt/);
  assert.match(js, /changes\.siteDataMeta/);
  assert.match(extractFunction(js, 'runImport'), /\$\('importText'\)\.value\s*=\s*''/);
});

test('dangerous actions use native dialog confirmation before mutations', () => {
  assert.match(html, /<dialog[^>]+id="confirmDialog"/);
  assert.match(js, /function confirmAction/);
  assert.doesNotMatch(js, /window\.confirm|\bconfirm\(/);
  const nativeHandler = js.match(/\$\('exportNative'\)\.addEventListener[\s\S]*?\n\}\);/);
  assert.ok(nativeHandler);
  assert.match(nativeHandler[0], /await confirmAction\(/);
  assert.match(nativeHandler[0], /完整 API Key/);
  assert.match(nativeHandler[0], /可信位置/);
  assert.ok(nativeHandler[0].indexOf('confirmAction') < nativeHandler[0].indexOf("send('export'"));
  assert.match(js, /title:\s*'删除站点？'/);
  assert.match(js, /title:\s*'恢复本机快照？'/);
  assert.match(js, /title:\s*'清理恢复快照？'/);
});

test('diagnostics formatter is read-only and covers schema counts', () => {
  const formatDiagnostics = eval(`(${extractFunction(js, 'formatDiagnostics')})`);
  const text = formatDiagnostics({
    extensionVersion: '2.4.2',
    schemaVersion: 4,
    migratedAt: Date.UTC(2026, 0, 1),
    siteCount: 2,
    authorizedSiteCount: 1,
    unauthorizedSiteCount: 1,
    completeKeyCount: 1,
    maskedKeyCount: 1,
    failedBalanceCount: 0,
    defaultCategory: 'gongyi',
    preferUnlimitedAutoKey: false,
    balanceRefresh: { status: 'idle', pending: 0 }
  });
  assert.match(text, /2\.4\.2/);
  assert.match(text, /schema：v4/);
  assert.match(text, /站点数：2/);
  assert.match(text, /完整 Key：1/);
  assert.match(text, /已授权 1 · 未授权 1/);
  assert.match(text, /孤立授权：0/);
  for (const id of ['copyDiagnostics', 'grantUnauthorizedSites', 'retryFailedBalances', 'openFailedBalanceSites', 'openLoginFailedSites']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(js, /requestSiteAccessFromGesture/);
  assert.doesNotMatch(js, /send\('requestUnauthorizedSiteAccess'/);
  assert.match(js, /getDiagnostics|formatDiagnostics|refreshDiagnostics/);
});

test('diagnostics exposes orphaned permission cleanup and an all-clear state', () => {
  for (const id of ['diagnosticOrphanedCount', 'orphanedPermissionIssue', 'cleanupOrphanedAccess',
    'diagnosticsAllClear', 'maintenanceIssue', 'refreshMaintenance']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(js, /send\('removeOrphanedSiteAccess'\)/);
  assert.match(js, /清理孤立授权/);
  assert.match(html, /当前没有需要处理的问题/);
  const redacted = eval(`(${extractFunction(js, 'buildRedactedDiagnostics')})`);
  const report = redacted({ orphanedPermissionCount: 3 });
  assert.match(report, /孤立授权：3/);
  assert.doesNotMatch(report, /origins|example\.com/i);
});

test('copied diagnostics are allowlisted and exclude site or credential material', () => {
  const buildRedactedDiagnostics = eval(`(${extractFunction(js, 'buildRedactedDiagnostics')})`);
  const report = buildRedactedDiagnostics({
    extensionVersion: '1.0.0-rc.2',
    manifestVersion: '0.99.0.2',
    schemaVersion: 4,
    siteCount: 3,
    authorizedSiteCount: 2,
    unauthorizedSiteCount: 1,
    unknownPermissionSiteCount: 0,
    failedBalanceCount: 1,
    balanceRefresh: {
      status: 'stopped', total: 3, completed: 2, succeeded: 1, failed: 0, skipped: 1, pending: 1
    },
    balanceErrorCodes: [
      { code: 'not_logged_in', count: 1 },
      { code: 'sk-secret-diagnostic-code', count: 1 }
    ],
    unauthorizedDomains: ['private.example.com'],
    note: 'private note',
    key: 'sk-secret-value',
    cookie: 'secret-cookie'
  }, 'Mozilla/5.0 Chrome/150.0.0.0 Edg/150.0.0.0');

  assert.match(report, /1\.0\.0-rc\.2/);
  assert.match(report, /Edge 150\.0\.0\.0/);
  assert.match(report, /schema：v4/);
  assert.match(report, /已授权 2 · 未授权 1/);
  assert.match(report, /not_logged_in=1/);
  assert.match(report, /unknown=1/);
  assert.match(report, /完成 2\/3/);
  assert.doesNotMatch(report, /private\.example|private note|sk-secret|secret-cookie/i);
});

test('options requests host access in foreground click paths before messaging the worker', () => {
  assert.match(html, /site-utils\.js[\s\S]*permissions\.js[\s\S]*ui-runtime\.js[\s\S]*options\.js/);
  assert.match(js, /function requestOptionsAccessFromGesture[\s\S]*requestSiteAccessFromGesture/);
  for (const [control, message] of [
    ['detectOnly', 'detectSite'],
    ['detectAndAdd', 'detectAndSave'],
    ['batchAdd', 'batchDetectAndSave'],
    ['refreshOne', 'refreshBalance'],
    ['redetect', 'redetectSite'],
    ['importKeysFromPage', 'importKeysFromPage'],
    ['refreshAll', 'refreshAllBalances'],
    ['retryFailedBalances', 'retryFailedBalances']
  ]) {
    const start = js.indexOf(`$('${control}')`);
    assert.notEqual(start, -1, `${control} handler should exist`);
    const permission = js.indexOf('requestOptionsAccessFromGesture', start);
    const sendMessage = js.indexOf(`send('${message}'`, start);
    assert.ok(permission > start && permission < sendMessage,
      `${control} must request foreground access before ${message}`);
  }
  assert.match(js, /resolveOptionsErrorAction[\s\S]*requestOptionsAccessFromGesture[\s\S]*send\(retryType/);
  assert.match(js, /resolveInputAction[\s\S]*requestOptionsAccessFromGesture[\s\S]*send\(mode/);
});

test('batch add never reuses hidden single-site fields or credentials', () => {
  const batchStart = js.indexOf("const batchAddBtn = $('batchAdd')");
  const batchEnd = js.indexOf("$('addSite').addEventListener", batchStart);
  assert.ok(batchStart >= 0 && batchEnd > batchStart);
  const batchHandler = js.slice(batchStart, batchEnd);

  assert.match(html, /批量添加不会读取或保存 API Key/);
  assert.match(batchHandler, /const text = \(\$\('batchUrls'\)\?\.value \|\| ''\)\.trim\(\)/);
  assert.doesNotMatch(batchHandler, /\$\('add(?:Url|Key|Note|Tags|Category)'\)/);
  assert.match(batchHandler, /send\('batchDetectAndSave', \{ text \}\)/);
});

test('drawer lifecycle clears transient credential inputs', () => {
  const fields = {
    addKey: { value: 'sk-single-site-secret' },
    newKeyValue: { value: 'sk-editor-secret' }
  };
  const $ = (id) => fields[id] || null;
  const clearCredentialInputs = eval(`(${extractFunction(js, 'clearCredentialInputs')})`);

  clearCredentialInputs();
  assert.equal(fields.addKey.value, '');
  assert.equal(fields.newKeyValue.value, '');
  assert.match(extractFunction(js, 'setDrawerMode'), /clearCredentialInputs\(\)/);
  assert.match(extractFunction(js, 'closeDrawer'), /clearCredentialInputs\(\)/);
});

test('options escapes identifiers and uses the shared runtime', () => {
  assert.equal(
    uiRuntime.escapeAttr('x" onmouseover="alert(1)&<'),
    'x&quot; onmouseover=&quot;alert(1)&amp;&lt;'
  );
  assert.match(js, /data-id="\$\{escapeAttr\(site\.id\)\}"/);
  assert.match(js, /data-key-id="\$\{escapeAttr\(k\.id\)\}"/);
  assert.match(html, /site-utils\.js[\s\S]*permissions\.js[\s\S]*ui-runtime\.js[\s\S]*options\.js/);
  assert.doesNotMatch(html, /bridge\.js/);
  assert.match(js, /PublicSiteUi\.sendMessage/);
  assert.match(js, /PublicSiteUi\.writeClipboard/);
  assert.match(js, /PublicSiteUi\.keyActionsFor/);
});

test('options site manager exposes tag filtering, sorting, and health state on every layout', () => {
  for (const id of ['listTag', 'listSort', 'listCategory', 'stopBalanceRefresh']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /站点排序/);
  assert.match(html, /健康状态/);
  assert.match(js, /tagFilter:\s*'all'/);
  assert.match(js, /sortOrder:\s*'current'/);
  assert.match(js, /collectSiteTags/);
  assert.match(js, /state\.tagFilter/);
  assert.match(js, /state\.sortOrder/);
  const visibleSource = extractFunction(js, 'visibleSites');
  assert.match(visibleSource, /sortOrder === 'name'/);
  assert.match(visibleSource, /sortOrder === 'updated'/);
  assert.match(visibleSource, /sortOrder === 'health'/);
  assert.match(js, /class="table-health"/);
  assert.match(js, /data-act="refresh" aria-label="刷新\$\{escapeAttr\(site\.name \|\| site\.domain\)\}余额"/);
  assert.match(html, /id="refreshAll"[^>]*aria-label="刷新全部余额"/);
});

test('options keeps bulk deletion scoped to the current filtered result', () => {
  assert.match(js, /function reconcileSelection\(sites = visibleSites\(\)\)/);
  assert.match(extractFunction(js, 'renderList'), /reconcileSelection\(sites\)/);
  const selectionState = { selected: new Set(['visible', 'hidden']) };
  const reconcileSelection = Function(
    'state',
    `return (${extractFunction(js, 'reconcileSelection')});`
  )(selectionState);
  reconcileSelection([{ id: 'visible' }]);
  assert.deepEqual([...selectionState.selected], ['visible']);
  const deleteSource = extractFunction(js, 'deleteSelected');
  assert.match(deleteSource, /currentIds/);
  assert.match(deleteSource, /if \(!currentIds\.has\(id\)\) state\.selected\.delete\(id\)/);
});

test('a busy batch deletion never falls back to partial deletion', () => {
  const source = extractFunction(js, 'deleteSelected');
  const busyGuard = source.indexOf('if (res.code)');
  const fallbackLoop = source.indexOf('for (const id of ids)', busyGuard);
  assert.ok(busyGuard >= 0 && fallbackLoop > busyGuard);
  const guardBlock = source.slice(busyGuard, fallbackLoop);
  assert.match(guardBlock, /setStatus\(res\.error \|\| [^,]+, 'err'\)/);
  assert.match(guardBlock, /return;/);
});

test('options synchronizes sites, preferences, backups, and balance state without overwriting edit drafts', () => {
  const listenerStart = js.indexOf("if (chrome.storage?.onChanged)");
  const listenerEnd = js.indexOf('async function deleteOne', listenerStart);
  assert.ok(listenerStart >= 0 && listenerEnd > listenerStart);
  const listener = js.slice(listenerStart, listenerEnd);
  assert.match(listener, /changes\.sites/);
  assert.match(listener, /changes\.prefs/);
  assert.match(listener, /changes\.siteBackups/);
  assert.match(listener, /changes\.balanceRefreshProgress/);
  assert.match(listener, /applySitesSnapshot\(changes\.sites\.newValue \|\| \[\], \{ external: true \}\)/);
  assert.match(js, /function editorDraftDirty\(\)/);
  assert.match(js, /当前编辑草稿已保留/);
  assert.match(js, /refreshLatestImportBackup\(\)/);

  const baseline = {
    name: '站点', domain: 'a.example.com', baseUrl: 'https://a.example.com',
    pageUrl: 'https://a.example.com/console', category: 'gongyi', type: 'newapi',
    note: '', tags: '常用'
  };
  const fields = {
    editor: { hidden: false }, editName: { value: baseline.name }, editDomain: { value: baseline.domain },
    editBase: { value: baseline.baseUrl }, editPage: { value: baseline.pageUrl },
    editCategory: { value: baseline.category }, editType: { value: baseline.type },
    editNote: { value: baseline.note }, editTags: { value: baseline.tags }, newKeyValue: { value: '' }
  };
  const editorState = { drawerMode: 'edit', editingBaseline: baseline };
  const editorDraftDirty = Function(
    'state', '$',
    `return (${extractFunction(js, 'editorDraftDirty')});`
  )(editorState, (id) => fields[id]);
  assert.equal(editorDraftDirty(), false);
  fields.editName.value = '草稿名';
  assert.equal(editorDraftDirty(), true);
  fields.editName.value = baseline.name;
  fields.newKeyValue.value = 'sk-local-draft-123456';
  assert.equal(editorDraftDirty(), true);
});

test('options balance progress exposes cooperative stop and every persisted terminal state', () => {
  const progressSource = extractFunction(js, 'renderBalanceProgress');
  assert.match(html, /id="balanceProgress"[^>]*role="region"[^>]*aria-describedby="balanceProgressText balanceProgressCount"/);
  assert.match(html, /id="balanceProgressBar"[^>]*aria-busy="false"/);
  assert.match(progressSource, /\['running', 'stopping'\]\.includes\(status\)/);
  for (const status of ['stopping', 'stopped', 'interrupted', 'completed']) {
    assert.match(progressSource, new RegExp(`status === '${status}'`));
  }
  const stopStart = js.indexOf("$('stopBalanceRefresh')?.addEventListener('click'");
  assert.notEqual(stopStart, -1);
  const stopSource = js.slice(stopStart, js.indexOf('\n});', stopStart) + 4);
  assert.match(stopSource, /status:\s*'stopping'/);
  assert.match(stopSource, /send\('stopBalanceRefresh',\s*\{ runId \}\)/);
});
