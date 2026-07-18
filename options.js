/* global filterSites, filterSitesByQuery, maskKey, categoryLabel, formatClientSnippet, openUrlForSite, isCompleteApiKey, requestSiteAccessFromGesture */

const $ = (id) => document.getElementById(id);
const send = PublicSiteUi.sendMessage;
const escapeHtml = PublicSiteUi.escapeHtml;
const escapeAttr = PublicSiteUi.escapeAttr;
const hasCompleteKeyValue = PublicSiteUi.isUsableKey;
const state = {
  sites: [],
  query: '',
  categoryFilter: 'all',
  editingId: null,
  selected: new Set(),
  importBusy: false,
  importPreview: null,
  importPreviewText: '',
  latestImportBackup: null,
  latestDiagnostics: null,
  balanceRefreshProgress: null,
  currentView: 'sites',
  drawerMode: null,
  drawerReturnFocus: null,
  openRowMenuId: null
};

function splitPermissionInputs(text) {
  return String(text || '')
    .split(/[\r\n,;]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

async function requestOptionsAccessFromGesture(targets, { continueOnDenied = false } = {}) {
  if (typeof requestSiteAccessFromGesture !== 'function') return true;
  const access = await requestSiteAccessFromGesture(targets);
  if (access.ok) return true;
  setStatus(
    continueOnDenied
      ? '未授权的站点将跳过，继续处理已授权站点'
      : (access.error || '未获得站点访问权限'),
    'err'
  );
  return continueOnDenied;
}

function permissionSite(siteId) {
  return state.sites.find((site) => site.id === siteId) || null;
}

function setStatus(message, kind = '', action = null) {
  const el = $('status');
  el.textContent = message || '';
  el.className = `status ${kind}`.trim();
  const actionBtn = $('statusAction');
  if (!actionBtn) return;
  actionBtn.hidden = !(action?.label && action?.run);
  actionBtn.textContent = action?.label || '';
  actionBtn.onclick = action?.run ? () => Promise.resolve(action.run()).catch((error) => {
    setStatus(String(error?.message || error || '操作失败'), 'err');
  }) : null;
}

function normalizeView(value) {
  return ['sites', 'import', 'diagnostics'].includes(value) ? value : 'sites';
}

function parseRoute() {
  try {
    const raw = String(window.location.hash || '').replace(/^#/, '');
    const params = new URLSearchParams(raw);
    return {
      view: normalizeView(params.get('view') || (params.has('edit') ? 'sites' : 'sites')),
      editId: params.get('edit') || ''
    };
  } catch {
    return { view: 'sites', editId: '' };
  }
}

function writeRoute(view, editId = '', replace = false) {
  const params = new URLSearchParams();
  params.set('view', normalizeView(view));
  if (editId) params.set('edit', editId);
  const next = `#${params.toString()}`;
  if (replace && window.history?.replaceState) {
    window.history.replaceState(null, '', next);
  } else if (window.location.hash !== next) {
    window.location.hash = next;
  }
}

function showWorkspace(view, { updateRoute = true, replace = false } = {}) {
  const next = normalizeView(view);
  state.currentView = next;
  document.querySelectorAll('[data-workspace]').forEach((workspace) => {
    workspace.hidden = workspace.dataset.workspace !== next;
  });
  document.querySelectorAll('[data-view]').forEach((button) => {
    if (button.dataset.view === next) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (updateRoute) writeRoute(next, next === 'sites' ? state.editingId : '', replace);
}

function focusableIn(container) {
  return Array.from(container.querySelectorAll(
    'button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden]), select:not([disabled]):not([hidden]), textarea:not([disabled]):not([hidden]), [href], [tabindex]:not([tabindex="-1"])'
  )).filter((item) => item.getClientRects().length > 0);
}

function setDrawerMode(mode) {
  const drawer = $('editor');
  drawer.dataset.mode = mode;
  document.querySelectorAll('[data-drawer-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.drawerPanel !== mode;
  });
  document.querySelectorAll('[data-drawer-only]').forEach((control) => {
    control.hidden = control.dataset.drawerOnly !== mode;
  });
  const titles = {
    add: ['添加站点', '先识别，再保存到本机收藏。'],
    batch: ['批量添加', '每行一个站点，逐个识别并添加。'],
    edit: ['编辑站点', '修改站点信息、余额识别与 API Key。']
  };
  const [title, subtitle] = titles[mode] || titles.edit;
  $('drawerTitle').textContent = title;
  $('drawerSubtitle').textContent = subtitle;
}

function openDrawer(mode, trigger = document.activeElement) {
  const drawer = $('editor');
  state.drawerMode = mode;
  state.drawerReturnFocus = trigger && typeof trigger.focus === 'function' ? trigger : null;
  setDrawerMode(mode);
  drawer.hidden = false;
  $('drawerScrim').hidden = false;
  $('optionsShell').inert = true;
  document.body.classList.add('modal-open');
  const firstId = mode === 'add' ? 'addUrl' : (mode === 'batch' ? 'batchUrls' : 'editName');
  queueMicrotask(() => $(firstId)?.focus());
}

function closeDrawer({ restoreFocus = true, updateRoute = true } = {}) {
  const drawer = $('editor');
  if (drawer.hidden) return;
  drawer.hidden = true;
  $('drawerScrim').hidden = true;
  $('optionsShell').inert = false;
  document.body.classList.remove('modal-open');
  state.drawerMode = null;
  if (updateRoute && state.currentView === 'sites') writeRoute('sites', '', true);
  if (restoreFocus) {
    const target = state.drawerReturnFocus;
    queueMicrotask(() => target?.isConnected && target.focus());
  }
  state.drawerReturnFocus = null;
}

function confirmAction({ title, copy, details = '', confirmLabel = '确认', trigger } = {}) {
  const dialog = $('confirmDialog');
  if (!dialog?.showModal) return Promise.resolve(false);
  $('confirmDialogTitle').textContent = title || '确认操作？';
  $('confirmDialogCopy').textContent = copy || '请确认后继续。';
  $('confirmDialogDetails').textContent = details || '';
  $('confirmDialogSubmit').textContent = confirmLabel;
  return new Promise((resolve) => {
    const returnTarget = trigger || document.activeElement;
    dialog.returnValue = 'cancel';
    const finish = () => {
      const confirmed = dialog.returnValue === 'confirm';
      if (!$('editor').hidden) document.body.classList.add('modal-open');
      else document.body.classList.remove('modal-open');
      queueMicrotask(() => returnTarget?.isConnected && returnTarget.focus());
      resolve(confirmed);
    };
    dialog.addEventListener('close', finish, { once: true });
    dialog.addEventListener('cancel', () => {
      dialog.returnValue = 'cancel';
    }, { once: true });
    document.body.classList.add('modal-open');
    dialog.showModal();
    queueMicrotask(() => dialog.querySelector('button[value="cancel"]')?.focus());
  });
}

function resolveOptionsErrorAction(res, siteId, retryType) {
  const code = String(res?.code || '');
  const retry = async () => {
    const target = siteId ? permissionSite(siteId) : null;
    if (target && !(await requestOptionsAccessFromGesture([target]))) return;
    const payload = siteId ? { id: siteId } : {};
    const again = await send(retryType, payload);
    if (!again.ok) {
      setStatus(again.error || '重试失败', 'err', resolveOptionsErrorAction(again, siteId, retryType));
      return;
    }
    if (again.sites) state.sites = again.sites;
    if (again.site && siteId) {
      const index = state.sites.findIndex((item) => item.id === siteId);
      if (index >= 0) state.sites[index] = again.site;
    }
    setStatus(again.detection?.summary || again.message || '操作完成', 'ok');
    renderList();
    if (state.editingId && siteId) fillEditor(state.sites.find((item) => item.id === siteId));
  };
  if (['site_permission_denied', 'site_permission_required', 'permission_denied'].includes(code)
    || res?.action === 'retry_permission') {
    return { label: '重试并授权', run: retry };
  }
  if (siteId && (code === 'login_tab_required' || code.startsWith('token_list_'))) {
    return {
      label: '打开令牌页',
      run: async () => {
        const opened = await send('openTokenPage', { id: siteId });
        setStatus(opened.ok ? '已打开令牌页，登录后可再试' : (opened.error || '打开失败'), opened.ok ? 'ok' : 'err');
      }
    };
  }
  if (siteId && (code === 'wrong_type' || res?.action === 'redetect')) {
    return { label: '重新识别', run: () => retryType === 'redetectSite' ? retry() : send('redetectSite', { id: siteId }) };
  }
  if (siteId && ['not_logged_in', 'network_error', 'timeout', 'parse_failed', 'tab_open_failed'].includes(code)) {
    return {
      label: '打开站点',
      run: async () => {
        const opened = await send('openUrl', { siteId });
        setStatus(opened.ok ? '已打开站点，准备好后可再试' : (opened.error || '打开失败'), opened.ok ? 'ok' : 'err');
      }
    };
  }
  return null;
}

function resolveInputAction(res, mode) {
  const code = String(res?.code || '');
  if (!['site_permission_denied', 'site_permission_required', 'permission_denied'].includes(code)
    && res?.action !== 'retry_permission') return null;
  return {
    label: '重试并授权',
    run: async () => {
      const input = $('addUrl').value.trim();
      if (!(await requestOptionsAccessFromGesture([input]))) return;
      const payload = mode === 'detectSite'
        ? { input, hintName: $('addName').value.trim() || undefined }
        : {
          input,
          name: $('addName').value.trim() || undefined,
          note: $('addNote').value.trim() || undefined,
          tags: $('addTags').value.trim() || undefined,
          key: $('addKey').value.trim() || undefined,
          category: $('addCategory')?.value || 'gongyi'
        };
      setStatus('正在申请访问权限并重试…');
      const again = await send(mode, payload);
      if (!again.ok) {
        setStatus(again.error || '仍未获得权限', 'err', resolveInputAction(again, mode));
        return;
      }
      if (mode === 'detectSite') {
        showDetectPreview(again);
        setStatus(again.summary || '识别完成', 'ok');
      } else {
        state.sites = again.sites || state.sites;
        renderList();
        setStatus(`已添加 ${again.site?.name || again.site?.domain || ''}`, 'ok');
      }
    }
  };
}

function renderBalanceProgress() {
  const progress = state.balanceRefreshProgress || {};
  const el = $('balanceProgress');
  if (!el) return;
  const total = Number(progress.total) || 0;
  const completed = Math.min(total, Number(progress.completed) || 0);
  const isVisible = ['running', 'interrupted'].includes(progress.status)
    || (progress.status === 'completed' && total > 0);
  el.hidden = !isVisible;
  if (!isVisible) return;
  $('balanceProgressBar').max = Math.max(total, 1);
  $('balanceProgressBar').value = completed;
  $('balanceProgressCount').textContent = `${completed}/${total}`;
  if (progress.status === 'running') {
    const current = progress.currentSiteName ? ` · 正在处理 ${progress.currentSiteName}` : '';
    $('balanceProgressText').textContent = `刷新余额中：成功 ${Number(progress.succeeded) || 0}，失败 ${Number(progress.failed) || 0}，跳过 ${Number(progress.skipped) || 0}${current}`;
  } else if (progress.status === 'interrupted') {
    const pending = Array.isArray(progress.pendingSiteIds) ? progress.pendingSiteIds.length : 0;
    $('balanceProgressText').textContent = `余额刷新已中断，剩余 ${pending} 个站点；再次点击“刷新全部余额”可继续`;
  } else {
    $('balanceProgressText').textContent = `余额刷新完成：成功 ${Number(progress.succeeded) || 0}，失败 ${Number(progress.failed) || 0}，跳过 ${Number(progress.skipped) || 0}`;
  }
}

async function copyText(text, successMessage = '已复制') {
  const result = await PublicSiteUi.writeClipboard(text);
  if (!result.ok) {
    setStatus(result.error || '复制失败', 'err');
    return false;
  }
  setStatus(successMessage, 'ok');
  return true;
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function updateRestoreImportButton(backup) {
  state.latestImportBackup = backup || null;
  const button = $('restoreLastImport');
  if (!button) return;
  button.hidden = !backup;
  if (backup) button.textContent = `撤销上次替换导入（${backup.siteCount} 站 / ${backup.completeKeyCount || 0} 个完整 Key）`;
}

async function refreshLatestImportBackup() {
  const [latest, list] = await Promise.all([
    send('getLatestSiteBackup'),
    send('listSiteBackups')
  ]);
  if (latest.ok) updateRestoreImportButton(latest.backup);
  const backups = list.ok && Array.isArray(list.backups) ? list.backups : [];
  const summary = $('backupSummary');
  if (summary) {
    const completeKeys = backups.reduce((total, backup) => total + (backup.completeKeyCount || 0), 0);
    summary.textContent = backups.length
      ? `本机恢复快照：${backups.length} 份，合计 ${completeKeys} 个完整 Key（最长 7 天，仅用于撤销替换导入）`
      : '本机没有恢复快照。';
  }
  const clear = $('clearBackups');
  if (clear) clear.disabled = backups.length === 0;
}

function visibleSites() {
  if (typeof filterSites === 'function') {
    return filterSites(state.sites, { query: state.query, category: state.categoryFilter });
  }
  return typeof filterSitesByQuery === 'function'
    ? filterSitesByQuery(state.sites, state.query)
    : state.sites.slice();
}

function catText(site) {
  if (typeof categoryLabel === 'function') return categoryLabel(site.category);
  return site.category === 'relay' ? '中转站' : '公益站';
}

function updateBulkBar() {
  const bar = $('bulkBar');
  const n = state.selected.size;
  if (!bar) return;
  bar.classList.toggle('show', n > 0);
  if ($('bulkCount')) $('bulkCount').textContent = `已选 ${n}`;
}

function safeDomIdPart(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9_-]+/g, '_');
}

function typeText(site) {
  const type = String(site?.type || 'auto').toLowerCase();
  return ({ newapi: 'NewAPI', sub2api: 'Sub2API', zenapi: 'ZenAPI', auto: '自动' })[type] || site?.type || '自动';
}

function positionRowMenu(trigger, menu) {
  if (!trigger || !menu || menu.hidden) return;
  const edge = 8;
  const gap = 6;
  menu.style.left = '0px';
  menu.style.top = '0px';
  const triggerRect = trigger.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const left = Math.min(
    Math.max(edge, window.innerWidth - menuRect.width - edge),
    Math.max(edge, triggerRect.right - menuRect.width)
  );
  let top = triggerRect.bottom + gap;
  if (top + menuRect.height > window.innerHeight - edge) {
    top = Math.max(edge, triggerRect.top - menuRect.height - gap);
  }
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function closeRowMenu({ restoreFocus = false } = {}) {
  const open = document.querySelector('.row-menu:not([hidden])');
  if (!open) {
    state.openRowMenuId = null;
    return;
  }
  const trigger = open.parentElement?.querySelector('[data-act="toggle-row-menu"]');
  open.hidden = true;
  trigger?.setAttribute('aria-expanded', 'false');
  state.openRowMenuId = null;
  if (restoreFocus) trigger?.focus();
}

function renderList() {
  const list = $('siteList');
  const sites = visibleSites();
  if ($('listCount')) {
    $('listCount').textContent = state.sites.length
      ? `${sites.length} / ${state.sites.length}`
      : '0';
  }
  if ($('navSiteCount')) $('navSiteCount').textContent = String(state.sites.length);
  updateBulkBar();

  if (!state.sites.length) {
    list.innerHTML = '<div class="empty">暂无站点。点击“添加站点”，或从 Popup 收藏当前页。</div>';
    return;
  }
  if (!sites.length) {
    list.innerHTML = '<div class="empty">没有匹配结果，请调整搜索或分类筛选。</div>';
    return;
  }

  state.openRowMenuId = null;
  list.innerHTML = sites.map((site) => {
    const active = site.id === state.editingId ? 'active' : '';
    const balanceFailed = site.balanceStatus?.status === 'failed';
    const balance = site.balance || (balanceFailed ? '余额失败' : '—');
    const usableKeys = (site.keys || []).filter((key) => hasCompleteKeyValue(key?.key)).length;
    const maskedKeys = Math.max(0, (site.keys || []).length - usableKeys);
    const checked = state.selected.has(site.id) ? 'checked' : '';
    const origin = (() => {
      const input = site.baseUrl || (site.domain ? `https://${site.domain}` : '');
      try { return new URL(input).origin; } catch { return site.domain || input; }
    })();
    const initial = String(site.name || site.domain || '?').trim().slice(0, 1).toUpperCase();
    const menuId = `row-menu-${safeDomIdPart(site.id)}`;
    const balanceLabel = balanceFailed
      ? (site.balanceStatus?.lastError?.message || '余额查询失败')
      : (site.balance ? '缓存余额' : '尚未查询');
    return `<article class="site-item ${active}" data-id="${escapeAttr(site.id)}">
      <label class="site-select" title="多选删除">
        <input class="row-check" type="checkbox" data-act="select" aria-label="选择站点：${escapeAttr(site.name || site.domain)}" ${checked}>
      </label>
      <div class="table-site">
        <span class="site-favicon" aria-hidden="true">${escapeHtml(initial)}</span>
        <span class="table-site-copy"><strong>${escapeHtml(site.name || site.domain)}</strong><small>${escapeHtml(origin)}</small></span>
      </div>
      <div class="table-meta table-tags">
        <span class="tag">${escapeHtml(catText(site))}</span>
        <span class="tag">${escapeHtml(typeText(site))}</span>
        ${(site.tags || []).slice(0, 2).map((tag) => `<span class="tag">#${escapeHtml(tag)}</span>`).join('')}
      </div>
      <div class="table-balance"><strong>${escapeHtml(balance)}</strong><small>${escapeHtml(balanceLabel)}</small></div>
      <div class="table-key">${usableKeys ? `${usableKeys} 个可用` : 'Key 可选'}${maskedKeys ? `<br>${maskedKeys} 个待修复` : ''}</div>
      <div class="row-actions desktop-row-actions">
        <button type="button" class="icon-btn" data-act="edit" aria-label="编辑${escapeAttr(site.name || site.domain)}">
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4-.8L19 8.2 15.8 5 4.8 16zM14.5 6.3l3.2 3.2"/></svg>
        </button>
        <button type="button" class="icon-btn" data-act="toggle-row-menu" aria-label="${escapeAttr(site.name || site.domain)}更多操作" aria-expanded="false" aria-controls="${menuId}">
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>
        </button>
        <div class="popover row-menu" id="${menuId}" role="menu" hidden>
          <button class="menu-item" type="button" role="menuitem" data-act="copy-client">复制接口地址</button>
          <button class="menu-item" type="button" role="menuitem" data-act="open">打开站点</button>
          <button class="menu-item" type="button" role="menuitem" data-act="refresh">刷新余额</button>
          <button class="menu-item" type="button" role="menuitem" data-tone="danger" data-act="delete">删除站点</button>
        </div>
      </div>
      <footer class="mobile-card-actions">
        <button type="button" class="btn btn-sm" data-act="copy-client">复制接口地址</button>
        <button type="button" class="btn btn-sm" data-act="open">打开站点</button>
        <button type="button" class="btn btn-sm" data-act="edit">编辑</button>
      </footer>
    </article>`;
  }).join('');
}

function fillEditor(site) {
  if (!site) {
    state.editingId = null;
    closeDrawer({ updateRoute: state.currentView === 'sites' });
    return;
  }
  state.editingId = site.id;
  showWorkspace('sites', { updateRoute: false });
  if ($('editor').hidden) openDrawer('edit', document.activeElement);
  else setDrawerMode('edit');
  $('editId').value = site.id;
  $('editName').value = site.name || '';
  $('editDomain').value = site.domain || '';
  $('editBase').value = site.baseUrl || '';
  $('editPage').value = site.pageUrl || '';
  if ($('editCategory')) $('editCategory').value = site.category === 'relay' ? 'relay' : 'gongyi';
  $('editType').value = site.type || 'auto';
  $('editNote').value = site.note || '';
  $('editTags').value = (site.tags || []).join(', ');
  $('drawerSubtitle').textContent = `${site.name || site.domain} · ${typeText(site)}`;
  renderKeys(site);
  writeRoute('sites', site.id, true);
}

function renderKeys(site) {
  const box = $('editKeys');
  const keys = site.keys || [];
  if (!keys.length) {
    box.innerHTML = '<div class="muted">暂无 Key — 下方粘贴 sk- 后点添加</div>';
    return;
  }
  box.innerHTML = keys.map((k) => {
    const actions = PublicSiteUi.keyActionsFor(k.key);
    const isUsableDefault = k.isDefault && actions.canSetDefault;
    const keyDisplay = actions.canCopy ? `尾号 ${String(k.key).slice(-4)}` : '待修复的掩码 Key';
    return `
      <div class="key-chip ${isUsableDefault ? 'is-default' : ''}" data-key-id="${escapeAttr(k.id)}">
        <div class="key-chip-main">
          <div class="key-chip-title">
            <span>${escapeHtml(k.name || 'Key')}</span>
            ${isUsableDefault
              ? '<span class="tag">默认</span>'
              : (!actions.canCopy ? '<span class="tag">待修复</span>' : '')}
          </div>
          <div class="key-chip-mask">${escapeHtml(keyDisplay)}</div>
        </div>
        <div class="key-chip-actions">
          ${actions.canCopy
            ? `<button type="button" class="btn btn-sm ${isUsableDefault ? 'btn-primary' : ''}" data-key-act="copy">复制</button>`
            : ''}
          ${actions.canSetDefault && !isUsableDefault
            ? '<button type="button" class="btn btn-sm" data-key-act="default">设默认</button>'
            : ''}
          <button type="button" class="btn btn-sm btn-danger" data-key-act="del">删除</button>
        </div>
      </div>
    `;
  }).join('');
}

async function refreshPrefsUi() {
  const res = await send('getPrefs');
  if (res.ok && res.prefs) {
    if (res.prefs.defaultCategory && $('addCategory')) {
      $('addCategory').value = res.prefs.defaultCategory;
      $('addCategory').dataset.previous = res.prefs.defaultCategory;
    }
    if (res.prefs.listCategoryFilter) {
      state.categoryFilter = res.prefs.listCategoryFilter;
      if ($('listCategory')) $('listCategory').value = state.categoryFilter;
    }
    const unlimited = $('preferUnlimitedAutoKey');
    if (unlimited) unlimited.checked = res.prefs.preferUnlimitedAutoKey === true;
  }
}

async function load() {
  await refreshPrefsUi();
  const res = await send('listSites');
  if (!res.ok) {
    setStatus(res.error || '加载失败', 'err');
    return;
  }
  state.sites = res.sites || [];
  // 清理已删选择
  for (const id of [...state.selected]) {
    if (!state.sites.some((s) => s.id === id)) state.selected.delete(id);
  }
  renderList();
  if (state.editingId) {
    const site = state.sites.find((s) => s.id === state.editingId);
    if (site) fillEditor(site);
    else fillEditor(null);
  }
  const progressRes = await send('getBalanceRefreshProgress');
  if (progressRes.ok) state.balanceRefreshProgress = progressRes.progress;
  renderBalanceProgress();
  await refreshLatestImportBackup();
}

if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.balanceRefreshProgress) return;
    state.balanceRefreshProgress = changes.balanceRefreshProgress.newValue || null;
    renderBalanceProgress();
  });
}

async function deleteOne(site, trigger) {
  const name = site.name || site.domain;
  const confirmed = await confirmAction({
    title: '删除站点？',
    copy: `「${name}」及其 Key 将一并删除，无法撤销。`,
    confirmLabel: '删除站点',
    trigger
  });
  if (!confirmed) return false;
  const res = await send('removeSite', { id: site.id });
  if (!res.ok) {
    setStatus(res.error || '删除失败', 'err');
    return false;
  }
  state.selected.delete(site.id);
  if (state.editingId === site.id) fillEditor(null);
  state.sites = res.sites || [];
  setStatus(`已删除 ${name}`, 'ok');
  renderList();
  return true;
}

async function deleteSelected(trigger) {
  const ids = [...state.selected];
  if (!ids.length) return;
  const confirmed = await confirmAction({
    title: `删除 ${ids.length} 个站点？`,
    copy: '所选站点及其 Key 将一并删除，无法撤销。',
    confirmLabel: '删除所选',
    trigger
  });
  if (!confirmed) return;
  setStatus(`正在删除 ${ids.length} 个…`);
  const res = await send('removeSites', { ids });
  if (!res.ok) {
    // 兼容旧 service worker：逐个删
    let ok = 0;
    for (const id of ids) {
      const r = await send('removeSite', { id });
      if (r.ok) {
        ok += 1;
        state.sites = r.sites || state.sites;
      }
    }
    state.selected.clear();
    if (state.editingId && !state.sites.some((s) => s.id === state.editingId)) fillEditor(null);
    setStatus(`已删除 ${ok}/${ids.length}`, ok ? 'ok' : 'err');
    renderList();
    return;
  }
  state.selected.clear();
  state.sites = res.sites || [];
  if (state.editingId && !state.sites.some((s) => s.id === state.editingId)) fillEditor(null);
  setStatus(`已删除 ${res.removed || ids.length} 个站点`, 'ok');
  renderList();
}

function showDetectPreview(detection) {
  const el = $('detectPreview');
  if (!detection?.ok) {
    el.textContent = detection?.error || '识别失败';
    el.className = 'notice drawer-detection';
    el.dataset.tone = 'danger';
    return;
  }
  const signals = (detection.signals || []).slice(0, 4).join(' · ') || '无额外信号';
  el.innerHTML = `
    <strong>${escapeHtml(detection.summary || '')}</strong><br>
    名称：${escapeHtml(detection.name)} · 类型：${escapeHtml(detection.typeLabel || detection.type)} · 置信：${escapeHtml(detection.confidence)}<br>
    Base：${escapeHtml(detection.baseUrl)}<br>
    信号：${escapeHtml(signals)}
  `;
  el.className = 'notice drawer-detection';
  el.dataset.tone = 'info';
}

$('detectOnly').addEventListener('click', async () => {
  const url = $('addUrl').value.trim();
  if (!url) { setStatus('请填写 URL 或域名', 'err'); return; }
  if (!(await requestOptionsAccessFromGesture([url]))) return;
  setStatus('正在识别…');
  $('detectOnly').disabled = true;
  const res = await send('detectSite', { input: url, hintName: $('addName').value.trim() || undefined });
  $('detectOnly').disabled = false;
  if (!res.ok) {
    showDetectPreview(res);
    setStatus(res.error || '识别失败', 'err', resolveInputAction(res, 'detectSite'));
    return;
  }
  showDetectPreview(res);
  if (!$('addName').value.trim() && res.name) $('addName').value = res.name;
  setStatus(res.summary || '识别完成', 'ok');
});

$('detectAndAdd').addEventListener('click', async () => {
  const url = $('addUrl').value.trim();
  if (!url) { setStatus('请填写 URL 或域名', 'err'); return; }
  if (!(await requestOptionsAccessFromGesture([url]))) return;
  setStatus('正在识别并添加…');
  $('detectAndAdd').disabled = true;
  const res = await send('detectAndSave', {
    input: url,
    name: $('addName').value.trim() || undefined,
    note: $('addNote').value.trim() || undefined,
    tags: $('addTags').value.trim() || undefined,
    key: $('addKey').value.trim() || undefined,
    category: $('addCategory')?.value || 'gongyi'
  });
  $('detectAndAdd').disabled = false;
  if (!res.ok) {
    showDetectPreview(res);
    setStatus(res.error || '失败', 'err', resolveInputAction(res, 'detectAndSave'));
    return;
  }
  showDetectPreview(res.detection);
  $('addUrl').value = '';
  $('addName').value = '';
  $('addKey').value = '';
  $('addNote').value = '';
  setStatus(`已添加 ${res.site?.name || ''} · ${res.detection?.summary || ''}`, 'ok');
  state.sites = res.sites || [];
  renderList();
  closeDrawer();
});

const batchAddBtn = $('batchAdd');
if (batchAddBtn) {
  batchAddBtn.addEventListener('click', async () => {
    const text = ($('batchUrls')?.value || '').trim() || $('addUrl').value.trim();
    if (!text) {
      setStatus('请填写批量 URL', 'err');
      return;
    }
    await requestOptionsAccessFromGesture(splitPermissionInputs(text), { continueOnDenied: true });
    setStatus('批量识别添加中…');
    batchAddBtn.disabled = true;
    const res = await send('batchDetectAndSave', {
      text,
      note: $('addNote').value.trim() || undefined,
      tags: $('addTags').value.trim() || undefined,
      key: $('addKey').value.trim() || undefined,
      category: $('addCategory')?.value || 'gongyi'
    });
    batchAddBtn.disabled = false;
    if (!res.ok) {
      setStatus(res.error || '批量添加失败', 'err');
      return;
    }
    const lines = (res.results || []).map((r) =>
      r.ok
        ? `✓ ${r.domain || r.input} · ${r.summary || r.type || ''}`
        : `✗ ${r.input} · ${r.error || '失败'}`
    );
    const el = $('batchPreview');
    if (el) {
      el.textContent = lines.join('\n');
      el.className = 'notice drawer-detection';
      el.dataset.tone = res.okCount ? 'info' : 'danger';
    }
    if ($('batchUrls')) $('batchUrls').value = '';
    setStatus(`批量完成：成功 ${res.okCount}/${res.total}`, res.okCount ? 'ok' : 'err');
    state.sites = res.sites || [];
    renderList();
    closeDrawer();
  });
}

$('addSite').addEventListener('click', async () => {
  const url = $('addUrl').value.trim();
  if (!url) { setStatus('请填写 URL 或域名', 'err'); return; }
  const addKey = $('addKey').value.trim();
  if (addKey && !hasCompleteKeyValue(addKey)) {
    setStatus('请粘贴完整、未脱敏的 API Key', 'err');
    $('addKey').focus();
    return;
  }
  const res = await send('upsertSite', {
    site: {
      domain: url,
      baseUrl: url,
      pageUrl: url,
      name: $('addName').value.trim() || undefined,
      note: $('addNote').value.trim(),
      tags: $('addTags').value.trim(),
      category: $('addCategory')?.value || 'gongyi',
      keys: $('addKey').value.trim() ? [{ name: '默认', key: $('addKey').value.trim() }] : []
    }
  });
  if (!res.ok) { setStatus(res.error || '添加失败', 'err'); return; }
  $('addUrl').value = '';
  $('addName').value = '';
  $('addKey').value = '';
  $('addNote').value = '';
  setStatus('已添加（未自动识别）', 'ok');
  state.sites = res.sites || [];
  renderList();
  closeDrawer();
});

$('siteList').addEventListener('click', async (e) => {
  const item = e.target.closest('.site-item');
  if (!item) return;
  const site = state.sites.find((s) => s.id === item.dataset.id);
  if (!site) return;

  const selectBox = e.target.closest('[data-act="select"]');
  if (selectBox || e.target.matches('input[type="checkbox"][data-act="select"]')) {
    const box = item.querySelector('input[data-act="select"]');
    if (box?.checked) state.selected.add(site.id);
    else state.selected.delete(site.id);
    updateBulkBar();
    return;
  }

  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'select') return;

  if (act === 'toggle-row-menu') {
    const menu = item.querySelector('.row-menu');
    if (!menu) return;
    if (!menu.hidden) {
      closeRowMenu({ restoreFocus: true });
    } else {
      closeRowMenu();
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      state.openRowMenuId = site.id;
      positionRowMenu(btn, menu);
      queueMicrotask(() => menu.querySelector('button:not([disabled])')?.focus());
    }
    return;
  }

  if (btn.closest('.row-menu') && act !== 'delete') closeRowMenu();

  if (act === 'edit') {
    fillEditor(site);
    renderList();
  } else if (act === 'open') {
    const openUrl = typeof openUrlForSite === 'function'
      ? openUrlForSite(site)
      : (site.domain ? `https://${site.domain}/` : site.baseUrl);
    await send('openUrl', { url: openUrl, siteId: site.id });
  } else if (act === 'copy-client') {
    const text = typeof formatApiBaseV1 === 'function'
      ? formatApiBaseV1(site)
      : (site.domain ? `https://${site.domain}/v1` : '');
    if (!text) {
      setStatus('无法生成调用地址', 'err');
      return;
    }
    await copyText(text, `已复制 ${text}`);
  } else if (act === 'refresh') {
    if (!(await requestOptionsAccessFromGesture([site]))) return;
    setStatus('查询余额…');
    const res = await send('refreshBalance', { id: site.id });
    if (!res.ok) {
      setStatus(res.error || '余额失败', 'err', resolveOptionsErrorAction(res, site.id, 'refreshBalance'));
      return;
    }
    setStatus(`余额 ${res.site.balance || '—'}`, 'ok');
    await load();
  } else if (act === 'delete') {
    await deleteOne(site, btn);
  }
});

document.addEventListener('click', (event) => {
  if (event.target.closest('.row-menu, [data-act="toggle-row-menu"]')) return;
  closeRowMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !document.querySelector('.row-menu:not([hidden])')) return;
  event.preventDefault();
  closeRowMenu({ restoreFocus: true });
});

window.addEventListener('resize', () => {
  const menu = document.querySelector('.row-menu:not([hidden])');
  if (!menu) return;
  const trigger = menu.parentElement?.querySelector('[data-act="toggle-row-menu"]');
  positionRowMenu(trigger, menu);
});

$('bulkSelectAll')?.addEventListener('click', () => {
  for (const s of visibleSites()) state.selected.add(s.id);
  renderList();
});

$('bulkClear')?.addEventListener('click', () => {
  state.selected.clear();
  renderList();
});

$('bulkDelete')?.addEventListener('click', (event) => deleteSelected(event.currentTarget));

$('openAddDrawer')?.addEventListener('click', (event) => {
  state.editingId = null;
  renderList();
  writeRoute('sites', '', true);
  openDrawer('add', event.currentTarget);
});

$('openBatchDrawer')?.addEventListener('click', (event) => {
  state.editingId = null;
  renderList();
  writeRoute('sites', '', true);
  openDrawer('batch', event.currentTarget);
});

$('saveEdit').addEventListener('click', async () => {
  const id = $('editId').value;
  const res = await send('updateSite', {
    id,
    patch: {
      name: $('editName').value.trim(),
      domain: $('editDomain').value.trim(),
      baseUrl: $('editBase').value.trim(),
      pageUrl: $('editPage').value.trim(),
      category: $('editCategory')?.value || 'gongyi',
      type: $('editType').value,
      note: $('editNote').value.trim(),
      tags: $('editTags').value.trim()
    }
  });
  if (!res.ok) { setStatus(res.error || '保存失败', 'err'); return; }
  setStatus('已保存', 'ok');
  state.sites = res.sites || [];
  fillEditor(state.sites.find((s) => s.id === id));
  renderList();
});

$('cancelEdit').addEventListener('click', () => { fillEditor(null); renderList(); });
$('closeDrawer')?.addEventListener('click', () => { fillEditor(null); renderList(); });
$('drawerScrim')?.addEventListener('click', () => { fillEditor(null); renderList(); });

$('deleteSite').addEventListener('click', async () => {
  const id = $('editId').value;
  const site = state.sites.find((s) => s.id === id);
  if (!site) return;
  await deleteOne(site, $('deleteSite'));
});

$('refreshOne').addEventListener('click', async () => {
  const siteId = $('editId').value;
  const site = permissionSite(siteId);
  if (!site || !(await requestOptionsAccessFromGesture([site]))) return;
  const res = await send('refreshBalance', { id: siteId });
  if (!res.ok) {
    setStatus(res.error || '余额失败', 'err', resolveOptionsErrorAction(res, siteId, 'refreshBalance'));
    return;
  }
  setStatus(`余额 ${res.site.balance || '—'}`, 'ok');
  await load();
});

$('redetect').addEventListener('click', async () => {
  const id = $('editId').value;
  if (!id) return;
  const site = permissionSite(id);
  if (!site || !(await requestOptionsAccessFromGesture([site]))) return;
  setStatus('重新识别中…');
  $('redetect').disabled = true;
  const res = await send('redetectSite', { id });
  $('redetect').disabled = false;
  if (!res.ok) {
    setStatus(res.error || '识别失败', 'err', resolveOptionsErrorAction(res, id, 'redetectSite'));
    return;
  }
  setStatus(res.detection?.summary || '识别完成', 'ok');
  state.sites = res.sites || [];
  fillEditor(res.site);
  renderList();
});

async function addKeyFromForm() {
  const siteId = $('editId').value;
  if (!siteId) {
    setStatus('请先打开要编辑的站点', 'err');
    return false;
  }
  const key = $('newKeyValue').value.trim();
  if (!key || !hasCompleteKeyValue(key)) {
    setStatus('请粘贴完整、未脱敏的 API Key', 'err');
    return false;
  }
  const res = await send('addKey', {
    siteId,
    key: { name: $('newKeyName').value.trim() || '默认', key, isDefault: true }
  });
  if (!res.ok) {
    setStatus(res.error || '添加 Key 失败', 'err');
    return false;
  }
  $('newKeyName').value = '';
  $('newKeyValue').value = '';
  setStatus('Key 已保存', 'ok');
  state.sites = res.sites || [];
  fillEditor(state.sites.find((s) => s.id === siteId));
  renderList();
  return true;
}

$('addKeyBtn').addEventListener('click', () => { addKeyFromForm(); });

['newKeyValue', 'newKeyName'].forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addKeyFromForm();
    }
  });
});

const importKeysBtn = $('importKeysFromPage');
if (importKeysBtn) {
  importKeysBtn.addEventListener('click', async () => {
    const siteId = $('editId').value;
    if (!siteId) {
      setStatus('请先打开要编辑的站点', 'err');
      return;
    }
    const site = permissionSite(siteId);
    if (!site || !(await requestOptionsAccessFromGesture([site]))) return;
    setStatus('正在从打开的站点页扫描 Key…');
    importKeysBtn.disabled = true;
    const res = await send('importKeysFromPage', { id: siteId });
    importKeysBtn.disabled = false;
    if (!res.ok) {
      setStatus(res.error || '导入失败', 'err', resolveOptionsErrorAction(res, siteId, 'importKeysFromPage'));
      return;
    }
    state.sites = res.sites || [];
    fillEditor(state.sites.find((s) => s.id === siteId));
    renderList();
    setStatus(res.message || '完成', res.added ? 'ok' : 'err');
  });
}

$('editKeys').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-key-act]');
  const row = e.target.closest('.key-chip, .key-row');
  if (!btn || !row) return;
  const siteId = $('editId').value;
  const site = state.sites.find((s) => s.id === siteId);
  const key = site?.keys?.find((k) => k.id === row.dataset.keyId);
  if (!key) return;
  const actions = PublicSiteUi.keyActionsFor(key.key);
  if (btn.dataset.keyAct === 'copy') {
    if (!actions.canCopy) {
      setStatus('该 Key 是掩码或残缺值，不能复制使用', 'err');
      return;
    }
    await copyText(
      key.key,
      `已复制「${key.name || 'Key'}」到系统剪贴板，请用后清理剪贴板`
    );
    return;
  }
  if (btn.dataset.keyAct === 'default') {
    if (!actions.canSetDefault) {
      setStatus('该 Key 是掩码或残缺值，不能设为默认', 'err');
      return;
    }
    const res = await send('setDefaultKey', { siteId, keyId: key.id });
    if (!res.ok) { setStatus(res.error || '设置失败', 'err'); return; }
    setStatus(`已将「${key.name}」设为默认 Key`, 'ok');
    state.sites = res.sites || [];
    fillEditor(state.sites.find((s) => s.id === siteId));
    renderList();
    return;
  }
  if (btn.dataset.keyAct === 'del') {
    const confirmed = await confirmAction({
      title: '删除 Key？',
      copy: `「${key.name || 'Key'}」将从该站点删除，无法撤销。`,
      confirmLabel: '删除 Key',
      trigger: btn
    });
    if (!confirmed) return;
    const res = await send('removeKey', { siteId, keyId: key.id });
    if (!res.ok) { setStatus(res.error || '删除失败', 'err'); return; }
    setStatus('Key 已删除', 'ok');
    state.sites = res.sites || [];
    fillEditor(state.sites.find((s) => s.id === siteId));
    renderList();
  }
});

const renderSearchResults = PublicSiteUi.debounce(renderList, 120);
$('search').addEventListener('input', (e) => {
  state.query = e.target.value || '';
  renderSearchResults();
});

const listCategorySel = $('listCategory');
if (listCategorySel) {
  listCategorySel.addEventListener('change', async () => {
    const previous = state.categoryFilter;
    state.categoryFilter = listCategorySel.value || 'all';
    renderList();
    const res = await send('savePrefs', { prefs: { listCategoryFilter: state.categoryFilter } });
    if (!res.ok) {
      state.categoryFilter = previous;
      listCategorySel.value = previous;
      renderList();
      setStatus(res.error || '保存列表筛选失败', 'err');
    }
  });
}

const addCategorySel = $('addCategory');
if (addCategorySel) {
  addCategorySel.addEventListener('change', async () => {
    const previous = addCategorySel.dataset.previous || 'gongyi';
    const next = addCategorySel.value || 'gongyi';
    const res = await send('savePrefs', { prefs: { defaultCategory: next } });
    if (!res.ok) {
      addCategorySel.value = previous;
      setStatus(res.error || '保存默认分类失败', 'err');
      return;
    }
    addCategorySel.dataset.previous = next;
  });
}

const unlimitedKeyPref = $('preferUnlimitedAutoKey');
if (unlimitedKeyPref) {
  unlimitedKeyPref.addEventListener('change', async () => {
    const next = unlimitedKeyPref.checked === true;
    const res = await send('savePrefs', { prefs: { preferUnlimitedAutoKey: next } });
    if (!res.ok) {
      unlimitedKeyPref.checked = !next;
      setStatus(res.error || '保存自动创建偏好失败', 'err');
      return;
    }
    setStatus(
      next
        ? '已开启：自动创建将使用无限额度 + 永不过期'
        : '已关闭：自动创建默认约 $10 / 90 天',
      'ok'
    );
  });
}

$('refreshAll').addEventListener('click', async () => {
  await requestOptionsAccessFromGesture(state.sites, { continueOnDenied: true });
  setStatus('正在刷新全部余额…');
  $('refreshAll').disabled = true;
  state.balanceRefreshProgress = { status: 'running', total: state.sites.length, completed: 0, succeeded: 0, failed: 0 };
  renderBalanceProgress();
  const res = await send('refreshAllBalances');
  $('refreshAll').disabled = false;
  if (!res.ok) { setStatus(res.error || '刷新失败', 'err'); return; }
  state.sites = res.sites || [];
  if (res.progress) state.balanceRefreshProgress = res.progress;
  const rows = res.results || [];
  const ok = rows.filter((row) => row.ok).length;
  const skipped = rows.filter((row) => row.skipped).length;
  const failed = rows.length - ok - skipped;
  setStatus(
    `完成：成功 ${ok} · 失败 ${failed} · 未授权跳过 ${skipped}`,
    ok || (!failed && !skipped) ? 'ok' : 'err'
  );
  renderList();
  renderBalanceProgress();
  if (state.editingId) fillEditor(state.sites.find((s) => s.id === state.editingId));
});

function resetImportPreview(message = '粘贴或选择 JSON 后先生成预览。') {
  state.importPreview = null;
  state.importPreviewText = '';
  const preview = $('importPreview');
  preview.textContent = message;
  preview.classList.remove('is-ready');
  $('doImport').disabled = true;
  $('doReplace').disabled = true;
}

function renderImportPreview(preview) {
  const format = preview.format || '自动识别';
  const skipped = Number(preview.skipped) || 0;
  const duplicates = Number(preview.duplicates) || 0;
  const sourceCount = Number(preview.sourceCount) || Number(preview.valid) || Number(preview.incoming) || 0;
  $('importPreview').textContent = [
    `格式：${format}`,
    `原始条目：${sourceCount} 条 · 可导入 ${preview.incoming ?? 0} 个站点`,
    `跳过：${skipped} 条无效内容 · 合并 ${duplicates} 条重复站点`,
    `当前：${preview.current ?? state.sites.length} 个 · 新增 ${preview.added ?? 0} · 更新 ${preview.updating ?? 0}`,
    '合并会保留未出现的站点；替换会先创建含完整 Key 的本机恢复快照。'
  ].join('\n');
  $('importPreview').classList.add('is-ready');
}

function hasCurrentImportPreview() {
  const text = $('importText').value.trim();
  return Boolean(text && state.importPreview && state.importPreviewText === text);
}

async function previewImportData() {
  if (state.importBusy) return false;
  const text = $('importText').value.trim();
  if (!text) {
    resetImportPreview();
    setStatus('请粘贴 JSON 或选择文件', 'err');
    return false;
  }
  $('previewImport').disabled = true;
  $('importPreview').textContent = '正在解析并生成预览…';
  try {
    const preview = await send('previewImport', { text });
    if (!preview.ok) {
      resetImportPreview(preview.error || '无法预览导入内容');
      setStatus(preview.error || '无法预览导入内容', 'err');
      return false;
    }
    state.importPreview = preview;
    state.importPreviewText = text;
    renderImportPreview(preview);
    $('doImport').disabled = false;
    $('doReplace').disabled = false;
    setStatus('导入预览已生成，请核对后选择合并或替换', 'ok');
    return true;
  } finally {
    $('previewImport').disabled = false;
  }
}

$('pickFile').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    $('importText').value = await file.text();
    setStatus(`已载入文件 ${file.name}`, 'ok');
    resetImportPreview('文件已载入，正在生成预览…');
    await previewImportData();
  } catch (err) {
    setStatus('读取文件失败', 'err');
  }
  e.target.value = '';
});

$('importText').addEventListener('input', () => resetImportPreview('内容已变化，请重新生成预览。'));
$('previewImport').addEventListener('click', () => { void previewImportData(); });

async function runImport(mode) {
  if (state.importBusy) return;
  const text = $('importText').value.trim();
  if (!text) { setStatus('请粘贴 JSON 或选择文件', 'err'); return; }
  if (!hasCurrentImportPreview()) {
    await previewImportData();
    return;
  }
  state.importBusy = true;
  $('doImport').disabled = true;
  $('doReplace').disabled = true;
  try {
    const res = await send('import', { text, mode });
    if (!res.ok) { setStatus(res.error || '导入失败', 'err'); return; }
    const backupText = res.backup ? '；已保留替换前快照，可立即撤销' : '';
    const skippedText = res.skipped ? `，跳过 ${res.skipped} 条` : '';
    setStatus(`导入成功（${res.format || 'unknown'}）：${res.imported} 条${skippedText}，当前共 ${res.sites.length} 站${backupText}`, 'ok');
    state.sites = res.sites || [];
    renderList();
    if (res.backup) updateRestoreImportButton(res.backup);
    resetImportPreview('导入完成。修改内容后可生成下一次预览。');
    await refreshLatestImportBackup();
  } catch (error) {
    setStatus(error?.message || '导入失败', 'err');
  } finally {
    state.importBusy = false;
    const ready = hasCurrentImportPreview();
    $('doImport').disabled = !ready;
    $('doReplace').disabled = !ready;
  }
}

$('doImport').addEventListener('click', () => runImport('merge'));
$('doReplace').addEventListener('click', async () => {
  const text = $('importText').value.trim();
  if (!text) { setStatus('请粘贴 JSON 或选择文件', 'err'); return; }
  if (!hasCurrentImportPreview()) {
    await previewImportData();
    return;
  }
  const preview = state.importPreview;
  const confirmed = await confirmAction({
    title: '确认替换导入？',
    copy: '替换前会在本机创建一份含完整 Key 的恢复快照，最长保留 7 天。',
    details: `当前 ${preview.current ?? state.sites.length} 个站点，替换后 ${preview.incoming ?? 0} 个；新增 ${preview.added ?? 0}，更新 ${preview.updating ?? 0}，跳过 ${preview.skipped ?? 0} 条。`,
    confirmLabel: '创建快照并替换',
    trigger: $('doReplace')
  });
  if (!confirmed) return;
  await runImport('replace');
});

$('restoreLastImport')?.addEventListener('click', async () => {
  const backup = state.latestImportBackup;
  if (!backup) return;
  const button = $('restoreLastImport');
  const confirmed = await confirmAction({
    title: '恢复本机快照？',
    copy: '快照包含完整 Key；恢复前会先把当前内容保存为新的安全快照。',
    details: `${backup.siteCount} 个站点 · ${backup.completeKeyCount || 0} 个完整 Key`,
    confirmLabel: '保存当前内容并恢复',
    trigger: button
  });
  if (!confirmed) return;
  button.disabled = true;
  try {
    const res = await send('restoreSiteBackup', { id: backup.id });
    if (!res.ok) { setStatus(res.error || '恢复失败', 'err'); return; }
    state.sites = res.sites || [];
    renderList();
    updateRestoreImportButton(res.safetyBackup);
    setStatus(`已恢复 ${res.restored?.siteCount || state.sites.length} 个站点；恢复前内容也已保留快照`, 'ok');
    await refreshLatestImportBackup();
  } finally {
    button.disabled = false;
  }
});

$('clearBackups')?.addEventListener('click', async () => {
  const summary = $('backupSummary')?.textContent || '';
  const button = $('clearBackups');
  const confirmed = await confirmAction({
    title: '清理恢复快照？',
    copy: '清理后将无法撤销此前的替换导入。',
    details: summary,
    confirmLabel: '清理快照',
    trigger: button
  });
  if (!confirmed) return;
  button.disabled = true;
  const res = await send('clearSiteBackups');
  if (!res.ok) setStatus(res.error || '清理快照失败', 'err');
  else setStatus('已清理本机恢复快照', 'ok');
  await refreshLatestImportBackup();
});

$('exportNative').addEventListener('click', async () => {
  const keyCount = state.sites.reduce((total, site) => total + (site.keys || []).filter((key) => hasCompleteKeyValue(key.key)).length, 0);
  const confirmed = await confirmAction({
    title: '导出完整 Key？',
    copy: '导出文件包含可直接使用的敏感凭据，请只保存到可信位置。',
    details: `${state.sites.length} 个站点 · ${keyCount} 个完整 API Key`,
    confirmLabel: '风险导出',
    trigger: $('exportNative')
  });
  if (!confirmed) return;
  const res = await send('export', { format: 'native', redactKeys: false });
  if (!res.ok) { setStatus(res.error || '导出失败', 'err'); return; }
  downloadJson(`公益站收藏-${new Date().toISOString().slice(0, 10)}.json`, res.config);
  setStatus('已导出「公益站收藏」格式（含完整 Key）', 'ok');
});

const exportRedactedBtn = $('exportRedacted');
if (exportRedactedBtn) {
  exportRedactedBtn.addEventListener('click', async () => {
    const res = await send('export', { format: 'native', redactKeys: true });
    if (!res.ok) { setStatus(res.error || '导出失败', 'err'); return; }
    downloadJson(`公益站收藏-脱敏-${new Date().toISOString().slice(0, 10)}.json`, res.config);
    setStatus('已导出安全分享格式（不含 Key、备注、标签、余额或深层 URL）', 'ok');
  });
}

function formatDiagnostics(d) {
  if (!d) return '暂无诊断数据';
  const accessLine = d.permissionCheckUnsupported
    ? '站点授权：当前环境无法检查（开发/测试）'
    : `站点授权：已授权 ${d.authorizedSiteCount ?? 0} · 未授权 ${d.unauthorizedSiteCount ?? 0} · 未知 ${d.unknownPermissionSiteCount ?? 0}`;
  const errorCodes = Array.isArray(d.balanceErrorCodes)
    ? d.balanceErrorCodes
      .filter((item) => /^[a-z0-9_:-]{1,64}$/.test(String(item?.code || '')))
      .map((item) => `${item.code}=${Number(item.count) || 0}`)
    : [];
  const batch = d.balanceRefresh || {};
  const lines = [
    `扩展版本：${d.extensionVersion || '—'}`,
    `数据 schema：v${d.schemaVersion ?? '—'}`,
    `上次迁移：${d.migratedAt ? new Date(d.migratedAt).toLocaleString() : '—'}`,
    `站点数：${d.siteCount ?? 0}`,
    accessLine,
    `完整 Key：${d.completeKeyCount ?? 0} · 掩码/残缺 Key：${d.maskedKeyCount ?? 0}`,
    `余额失败站点：${d.failedBalanceCount ?? 0}`,
    `余额错误码：${errorCodes.length ? errorCodes.join(' · ') : '无'}`,
    `默认分类：${d.defaultCategory || 'gongyi'}`,
    `自动创建无限 Key：${d.preferUnlimitedAutoKey ? '是' : '否（默认 $10 / 90 天）'}`,
    `余额批刷：${batch.status || 'idle'} · 完成 ${Number(batch.completed) || 0}/${Number(batch.total) || 0} · 成功 ${Number(batch.succeeded) || 0} · 失败 ${Number(batch.failed) || 0} · 跳过 ${Number(batch.skipped) || 0} · 待处理 ${Number(batch.pending) || 0}`
  ];
  return lines.join('\n');
}

function buildRedactedDiagnostics(d, userAgent = '') {
  const safeToken = (value, fallback = '—') => {
    const token = String(value || '').trim();
    return /^[a-z0-9._:-]{1,80}$/i.test(token) ? token : fallback;
  };
  const ua = String(userAgent || '');
  const edge = ua.match(/Edg\/([0-9.]+)/);
  const chrome = ua.match(/Chrome\/([0-9.]+)/);
  const browser = edge
    ? `Edge ${safeToken(edge[1])}`
    : (chrome ? `Chrome ${safeToken(chrome[1])}` : '未知 Chromium');
  const number = (value) => Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
  const batch = d?.balanceRefresh || {};
  const allowedStatuses = new Set(['idle', 'running', 'stopping', 'stopped', 'interrupted', 'completed']);
  const allowedErrorCodes = new Set([
    'permission_denied', 'timeout', 'invalid_domain', 'tab_open_failed', 'wrong_type',
    'not_logged_in', 'parse_failed', 'network_error', 'refresh_failed',
    'balance_persist_failed', 'unknown'
  ]);
  const batchStatus = allowedStatuses.has(String(batch.status)) ? String(batch.status) : 'unknown';
  const errorCodes = Array.isArray(d?.balanceErrorCodes)
    ? d.balanceErrorCodes
      .map((item) => {
        const rawCode = safeToken(item?.code, 'unknown').toLowerCase();
        return { code: allowedErrorCodes.has(rawCode) ? rawCode : 'unknown', count: number(item?.count) };
      })
      .filter((item) => item.code !== '—')
      .sort((left, right) => left.code.localeCompare(right.code))
      .map((item) => `${item.code}=${item.count}`)
    : [];
  return [
    '公益站收藏 - 脱敏诊断',
    `扩展版本：${safeToken(d?.extensionVersion)}`,
    `Manifest 版本：${safeToken(d?.manifestVersion)}`,
    `浏览器：${browser}`,
    `数据 schema：v${number(d?.schemaVersion)}`,
    `站点数：${number(d?.siteCount)}`,
    `站点授权：已授权 ${number(d?.authorizedSiteCount)} · 未授权 ${number(d?.unauthorizedSiteCount)} · 未知 ${number(d?.unknownPermissionSiteCount)}`,
    `余额失败：${number(d?.failedBalanceCount)}`,
    `余额批刷：${batchStatus} · 完成 ${number(batch.completed)}/${number(batch.total)} · 成功 ${number(batch.succeeded)} · 失败 ${number(batch.failed)} · 跳过 ${number(batch.skipped)} · 待处理 ${number(batch.pending)}`,
    `稳定错误码：${errorCodes.length ? errorCodes.join(' · ') : '无'}`
  ].join('\n');
}

async function refreshDiagnostics() {
  const out = $('diagnosticsOut');
  if (!out) return;
  out.textContent = '加载中…';
  const res = await send('getDiagnostics');
  if (!res.ok) {
    out.textContent = res.error || '诊断加载失败';
    return;
  }
  const diagnostics = res.diagnostics || {};
  state.latestDiagnostics = diagnostics;
  out.textContent = formatDiagnostics(diagnostics);
  if ($('diagnosticSiteCount')) $('diagnosticSiteCount').textContent = String(diagnostics.siteCount ?? 0);
  if ($('diagnosticKeyCount')) $('diagnosticKeyCount').textContent = String(diagnostics.completeKeyCount ?? 0);
  if ($('diagnosticFailureCount')) $('diagnosticFailureCount').textContent = String(diagnostics.failedBalanceCount ?? 0);
  return diagnostics;
}

const refreshDiagBtn = $('refreshDiagnostics');
if (refreshDiagBtn) {
  refreshDiagBtn.addEventListener('click', () => { void refreshDiagnostics(); });
}

const copyDiagBtn = $('copyDiagnostics');
if (copyDiagBtn) {
  copyDiagBtn.addEventListener('click', async () => {
    copyDiagBtn.disabled = true;
    try {
      const diagnostics = await refreshDiagnostics();
      if (!diagnostics) {
        setStatus('诊断数据不可用', 'err');
        return;
      }
      const report = buildRedactedDiagnostics(diagnostics, navigator.userAgent);
      await copyText(report, '已复制脱敏诊断（不含 Key、Cookie、站点地址或备注）');
    } finally {
      copyDiagBtn.disabled = false;
    }
  });
}

const grantUnauthorizedBtn = $('grantUnauthorizedSites');
if (grantUnauthorizedBtn) {
  grantUnauthorizedBtn.addEventListener('click', async () => {
    grantUnauthorizedBtn.disabled = true;
    setStatus('正在申请未授权站点的 HTTPS 权限…');
    try {
      const granted = await requestOptionsAccessFromGesture(state.sites);
      await refreshDiagnostics();
      if (granted) setStatus('站点权限状态已更新', 'ok');
    } finally {
      grantUnauthorizedBtn.disabled = false;
    }
  });
}

const retryFailedBalancesBtn = $('retryFailedBalances');
if (retryFailedBalancesBtn) {
  retryFailedBalancesBtn.addEventListener('click', async () => {
    const failedSites = state.sites.filter((site) => site?.balanceStatus?.status === 'failed');
    await requestOptionsAccessFromGesture(failedSites, { continueOnDenied: true });
    retryFailedBalancesBtn.disabled = true;
    setStatus('正在重试余额失败的站点…');
    try {
      const res = await send('retryFailedBalances');
      if (!res.ok) {
        setStatus(res.error || res.message || '重试失败', 'err');
      } else {
        const rows = res.results || [];
        const okCount = rows.filter((row) => row.ok).length;
        const skipped = rows.filter((row) => row.skipped).length;
        const failed = rows.length - okCount - skipped;
        const total = rows.length;
        setStatus(
          total
            ? `${res.message || '重试完成'}：成功 ${okCount} · 失败 ${failed} · 跳过 ${skipped}`
            : (res.message || '没有余额失败的站点'),
          total && !okCount ? 'err' : 'ok'
        );
        if (res.sites) {
          state.sites = res.sites;
          renderList();
        }
        if (res.progress) {
          state.balanceRefreshProgress = res.progress;
          renderBalanceProgress();
        }
      }
      await refreshDiagnostics();
    } finally {
      retryFailedBalancesBtn.disabled = false;
    }
  });
}

async function openFailedSites(reason, busyLabel) {
  setStatus(busyLabel);
  const res = await send('openFailedBalanceSites', { limit: 5, reason });
  if (!res.ok) {
    setStatus(res.error || '打开失败', 'err');
  } else {
    setStatus(res.message || `已打开 ${res.opened || 0} 个站点`, res.opened ? 'ok' : 'err');
  }
}

const openFailedBalanceSitesBtn = $('openFailedBalanceSites');
if (openFailedBalanceSitesBtn) {
  openFailedBalanceSitesBtn.addEventListener('click', async () => {
    openFailedBalanceSitesBtn.disabled = true;
    try {
      await openFailedSites('all', '正在打开余额失败站…');
    } finally {
      openFailedBalanceSitesBtn.disabled = false;
    }
  });
}

const openLoginFailedSitesBtn = $('openLoginFailedSites');
if (openLoginFailedSitesBtn) {
  openLoginFailedSitesBtn.addEventListener('click', async () => {
    openLoginFailedSitesBtn.disabled = true;
    try {
      await openFailedSites('not_logged_in', '正在打开未登录失败站…');
    } finally {
      openLoginFailedSitesBtn.disabled = false;
    }
  });
}

function requestedEditId() {
  return parseRoute().editId;
}

function applyCurrentRoute() {
  const route = parseRoute();
  showWorkspace(route.view, { updateRoute: false });
  if (route.editId) {
    const site = state.sites.find((item) => item.id === route.editId);
    if (site) {
      fillEditor(site);
      renderList();
    } else {
      state.editingId = null;
      closeDrawer({ restoreFocus: false, updateRoute: false });
      setStatus('找不到要编辑的站点，可能已被删除', 'err');
      writeRoute('sites', '', true);
    }
  } else if (state.drawerMode === 'edit') {
    state.editingId = null;
    closeDrawer({ restoreFocus: false, updateRoute: false });
    renderList();
  }
}

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', () => {
    state.editingId = null;
    closeDrawer({ restoreFocus: false, updateRoute: false });
    renderList();
    showWorkspace(button.dataset.view);
  });
});

$('editor').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    fillEditor(null);
    renderList();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = focusableIn($('editor'));
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

window.addEventListener('hashchange', applyCurrentRoute);

async function boot() {
  const route = parseRoute();
  showWorkspace(route.view, { updateRoute: false });
  resetImportPreview();
  await load();
  const editId = requestedEditId();
  if (editId) {
    const site = state.sites.find((item) => item.id === editId);
    if (site) {
      fillEditor(site);
      renderList();
      $('editName')?.focus();
    } else {
      setStatus('找不到要编辑的站点，可能已被删除', 'err');
      writeRoute('sites', '', true);
    }
  }
  await refreshDiagnostics();
  if (!window.location.hash) writeRoute(route.view, '', true);
}

boot();
