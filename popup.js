/* global filterSites, deriveSiteHealth, maskKey, formatClientSnippet, getDefaultKey, categoryLabel, openUrlForSite, originForSite, isCompleteApiKey, collectSiteTags, shortBalanceErrorMessage, requestSiteAccessFromGesture */

const $ = (id) => document.getElementById(id);
const send = PublicSiteUi.sendMessage;
const escapeHtml = PublicSiteUi.escapeHtml;
const escapeAttr = PublicSiteUi.escapeAttr;
const hasCompleteKeyValue = PublicSiteUi.isUsableKey;
let toastTimer = null;
const state = {
  sites: [],
  query: '',
  categoryFilter: 'all',
  tagFilter: 'all',
  healthFilter: 'all',
  saveCategory: 'gongyi',
  busy: false,
  mutationBusy: false,
  expandedId: null,
  activeTabUrl: '',
  balanceRefreshProgress: null,
  balanceStopFocusPending: false,
  balanceStopPendingRunId: ''
};

function captureActiveTabUrl() {
  if (typeof chrome === 'undefined' || !chrome.tabs?.query) return Promise.resolve('');
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const error = chrome.runtime?.lastError;
      const url = error ? '' : String(tabs?.[0]?.url || '');
      state.activeTabUrl = url;
      resolve(url);
    });
  });
}

function permissionTargetsForAction(preferredRetry, target = null) {
  if (preferredRetry === 'saveCurrentTab') {
    return state.activeTabUrl ? [state.activeTabUrl] : [];
  }
  if (preferredRetry === 'refreshAllBalances') return state.sites;
  if (preferredRetry === 'retryFailedBalances') {
    return state.sites.filter((site) => site?.balanceStatus?.status === 'failed');
  }
  return target ? [target] : [];
}

async function requestAccessForAction(targets, site, preferredRetry, options = {}) {
  const continueOnDenied = options.continueOnDenied === true;
  if (typeof requestSiteAccessFromGesture !== 'function') return true;
  const access = await requestSiteAccessFromGesture(targets);
  if (access.ok) return true;
  toast(
    continueOnDenied
      ? '未授权的站点将跳过，继续处理已授权站点'
      : (access.error || '未获得站点访问权限'),
    'err',
    resolveErrorAction(access, site, preferredRetry)
  );
  return continueOnDenied;
}

function clearToastAction() {
  const btn = $('toastAction');
  if (!btn) return;
  btn.hidden = true;
  btn.textContent = '';
  btn.onclick = null;
}

function toast(message, kind = '', action = null) {
  if (toastTimer) clearTimeout(toastTimer);
  const el = $('toast');
  const row = $('toastRow');
  el.textContent = message || '';
  el.className = `toast ${kind}`.trim();
  if (row) row.classList.toggle('is-visible', Boolean(message));
  if (action?.label && action?.run) {
    const btn = $('toastAction');
    if (btn) {
      btn.hidden = false;
      btn.textContent = action.label;
      btn.onclick = () => {
        Promise.resolve(action.run()).catch((error) => {
          toast(String(error?.message || error || '操作失败'), 'err');
        });
      };
    }
  } else {
    clearToastAction();
  }
  if (kind === 'ok' && message) {
    toastTimer = setTimeout(() => toast(''), 3800);
  }
}

/** 失败时给出可点的下一步，而不是只剩一句 toast */
function resolveErrorAction(res, site, preferredRetry = 'refreshBalance') {
  const err = String(res?.error || '');
  const siteId = site?.id || res?.site?.id || null;
  const findSite = () => state.sites.find((item) => item.id === siteId) || site || null;
  const effectiveCode = String(res?.code || '');

  if (
    effectiveCode === 'site_permission_denied'
    || effectiveCode === 'site_permission_required'
    || effectiveCode === 'permission_denied'
    || res?.action === 'retry_permission'
  ) {
    return {
      label: '重试并授权',
      run: async () => {
        const target = findSite();
        if (!target && !['refreshAllBalances', 'retryFailedBalances', 'saveCurrentTab'].includes(preferredRetry)) {
          toast('站点不存在', 'err');
          return;
        }
        const permissionTargets = permissionTargetsForAction(preferredRetry, target);
        const continueOnDenied = ['refreshAllBalances', 'retryFailedBalances'].includes(preferredRetry);
        if (!(await requestAccessForAction(permissionTargets, target, preferredRetry, { continueOnDenied }))) {
          return;
        }
        toast('正在申请访问权限…');
        let again;
        if (preferredRetry === 'saveCurrentTab') {
          again = await send('saveCurrentTab', {
            detect: true,
            category: resolveSaveCategory()
          });
        } else if (preferredRetry === 'redetectSite' && target) {
          again = await send('redetectSite', { id: target.id });
        } else if (preferredRetry === 'ensureSiteKey' && target) {
          again = await send('ensureSiteKey', { id: target.id, allowCreate: false });
        } else if (preferredRetry === 'refreshAllBalances') {
          again = await send('refreshAllBalances');
        } else if (preferredRetry === 'retryFailedBalances') {
          again = await send('retryFailedBalances');
        } else if (target) {
          again = await send('refreshBalance', { id: target.id });
        } else {
          toast('无法重试', 'err');
          return;
        }
        if (!again.ok) {
          toast(again.error || '仍未获得权限', 'err', resolveErrorAction(again, target, preferredRetry));
          if (again.sites) {
            state.sites = again.sites;
            render();
          }
          return;
        }
        if (again.sites) state.sites = again.sites;
        else if (again.site && target) {
          const idx = state.sites.findIndex((s) => s.id === target.id);
          if (idx >= 0) state.sites[idx] = again.site;
        }
        if (preferredRetry === 'saveCurrentTab') {
          const name = again.site?.name || again.site?.domain || '当前站点';
          toast(`已收藏 ${name}`, 'ok');
        } else if (preferredRetry === 'redetectSite') {
          toast(again.detection?.summary || '识别完成', 'ok');
        } else if (preferredRetry === 'ensureSiteKey') {
          toast(again.outcome === 'imported'
            ? `已导入 ${again.added || again.found || 1} 个 Key`
            : (again.outcome === 'existing' ? '该站已有可用 Key' : '操作完成'), 'ok');
        } else if (preferredRetry === 'refreshAllBalances') {
          const rows = again.results || [];
          const okCount = rows.filter((r) => r.ok).length;
          toast(`余额：${okCount}/${rows.length} 成功`, okCount ? 'ok' : 'err');
          if (again.progress) applyBalanceRefreshProgress(again.progress);
        } else if (preferredRetry === 'retryFailedBalances') {
          const rows = again.results || [];
          const okCount = rows.filter((r) => r.ok).length;
          toast(
            rows.length ? `重试完成：成功 ${okCount}/${rows.length}` : '没有余额失败的站点',
            rows.length && !okCount ? 'err' : 'ok'
          );
        } else {
          toast(again.site?.balance ? `余额 ${again.site.balance}` : '余额已查询', 'ok');
        }
        render();
      }
    };
  }

  if (effectiveCode === 'wrong_type' || res?.action === 'redetect') {
    return {
      label: '重新识别',
      run: async () => {
        const target = findSite();
        if (!target) {
          toast('站点不存在', 'err');
          return;
        }
        toast('识别中…');
        const again = await send('redetectSite', { id: target.id });
        if (!again.ok) {
          toast(again.error || '识别失败', 'err', resolveErrorAction(again, target, 'redetectSite'));
          return;
        }
        if (again.sites) state.sites = again.sites;
        toast(again.detection?.summary || '识别完成', 'ok');
        render();
      }
    };
  }

  if (
    effectiveCode === 'login_tab_required'
    || effectiveCode.startsWith('token_list_')
    || effectiveCode === 'unsupported_site_type'
    || /令牌页|登录.*令牌|请先打开并登录/.test(err)
  ) {
    return {
      label: '打开令牌页',
      run: async () => {
        const target = findSite();
        if (!target) {
          toast('站点不存在', 'err');
          return;
        }
        const opened = await send('openTokenPage', { id: target.id });
        if (!opened.ok) toast(opened.error || '打开令牌页失败', 'err');
        else toast('已打开令牌页，登录后可再试', 'ok');
      }
    };
  }

  if (
    effectiveCode === 'not_logged_in'
    || effectiveCode === 'parse_failed'
    || effectiveCode === 'network_error'
    || effectiveCode === 'timeout'
    || effectiveCode === 'tab_open_failed'
    || res?.action === 'open_site'
    || /未登录|个人中心|登录态|请先登录|超时|无响应/.test(err)
  ) {
    if (!siteId) return null;
    return {
      label: '打开站点',
      run: async () => {
        const target = findSite();
        if (!target) return;
        const openUrl = typeof openUrlForSite === 'function'
          ? openUrlForSite(target)
          : (target.domain ? `https://${target.domain}/` : target.baseUrl);
        const opened = await send('openUrl', { url: openUrl, siteId: target.id });
        if (!opened.ok) toast(opened.error || '打开站点失败', 'err');
        else toast('已打开站点', 'ok');
      }
    };
  }

  return null;
}

function autoKeyButtonLabel(site) {
  const type = String(site?.type || '').toLowerCase();
  if (type === 'newapi' || type === 'auto' || !type) return '自动获取 Key';
  return '从页面导入 Key';
}

function balanceErrorActionMeta(site) {
  const lastError = site?.balanceStatus?.lastError || {};
  const code = String(lastError.code || '');
  const action = String(lastError.action || '');
  if (action === 'retry_permission' || code === 'permission_denied') {
    return { act: 'refresh', label: '重试并授权' };
  }
  if (action === 'redetect' || code === 'wrong_type') {
    return { act: 'redetect', label: '重新识别' };
  }
  if (action === 'open_token' || code === 'login_tab_required') {
    return { act: 'open-token', label: '打开令牌页' };
  }
  if (code === 'not_logged_in' || code === 'parse_failed' || code === 'network_error'
    || code === 'timeout' || code === 'tab_open_failed' || action === 'open_site') {
    return { act: 'open', label: '打开站点' };
  }
  if (site?.balanceStatus?.status === 'failed') {
    return { act: 'open', label: '打开站点' };
  }
  return null;
}

// popup 级全局锁：这里操作量小、吞吐低，足以阻止双击和跨卡片并发写入；
// 若未来需要真正并发，再下沉为 storage 原子 mutation。
async function runMutation(fn) {
  if (state.mutationBusy) {
    toast('操作进行中…');
    return undefined;
  }
  state.mutationBusy = true;
  try {
    return await fn();
  } finally {
    state.mutationBusy = false;
  }
}

function formatBalance(site) {
  if (site.balance) return site.balance;
  if (site.usage) return `用量 ${site.usage}`;
  if (site.balanceUpdatedAt) return '已查询';
  return '—';
}

function balanceStateText(site) {
  const status = site?.balanceStatus || {};
  if (status.status === 'failed') return '余额失败';
  const updatedAt = Number(status.lastSuccessAt || site?.balanceUpdatedAt) || 0;
  if (!updatedAt) return '未查余额';
  const age = Date.now() - updatedAt;
  if (age > 24 * 60 * 60 * 1000) return '余额待刷新';
  if (age > 60 * 60 * 1000) return `${Math.floor(age / (60 * 60 * 1000))} 小时前`;
  return '余额已更新';
}

function applyBalanceRefreshProgress(next) {
  const incoming = next || null;
  const pendingRunId = String(state.balanceStopPendingRunId || '');
  if (pendingRunId
    && incoming?.runId === pendingRunId
    && incoming?.status === 'running') {
    return false;
  }
  state.balanceRefreshProgress = incoming;
  if (pendingRunId && (
    !incoming
    || incoming.runId !== pendingRunId
    || !['running', 'stopping'].includes(incoming.status)
  )) {
    state.balanceStopPendingRunId = '';
  }
  return true;
}

function renderBalanceProgress() {
  const progress = state.balanceRefreshProgress || {};
  const el = $('balanceProgress');
  if (!el) return;
  const status = String(progress.status || 'idle');
  const total = Number(progress.total) || 0;
  const completed = Math.min(total, Number(progress.completed) || 0);
  const isActive = ['running', 'stopping'].includes(status);
  // 完成后的进度条不常驻；用户停止或意外中断则保留剩余数量与继续入口。
  const isVisible = isActive || ['interrupted', 'stopped'].includes(status);
  const stopButton = $('stopBalanceRefresh');
  const refreshButton = $('refreshBalances');
  const bar = $('balanceProgressBar');
  const stopHadFocus = document.activeElement === stopButton;
  el.hidden = !isVisible;
  bar?.setAttribute('aria-busy', String(isActive));
  if (refreshButton) refreshButton.disabled = isActive || state.busy;
  if (stopButton) {
    stopButton.hidden = !isActive;
    stopButton.disabled = status === 'stopping' || !progress.runId;
    stopButton.textContent = status === 'stopping' ? '正在停止' : '停止';
    stopButton.setAttribute(
      'aria-label',
      status === 'stopping' ? '正在停止余额刷新' : '停止余额刷新'
    );
  }
  if (stopHadFocus && !isActive) state.balanceStopFocusPending = true;
  if (state.balanceStopFocusPending && !isActive) {
    queueMicrotask(() => {
      const target = isVisible
        ? el
        : (refreshButton && !refreshButton.disabled ? refreshButton : null);
      if (!target) return;
      target.focus();
      state.balanceStopFocusPending = false;
    });
  }
  if (!isVisible) return;
  bar.max = Math.max(total, 1);
  bar.value = completed;
  $('balanceProgressCount').textContent = `${completed}/${total}`;
  const skipped = Number(progress.skipped) || 0;
  const skippedPart = skipped ? `，跳过 ${skipped}` : '';
  if (status === 'running') {
    const current = progress.currentSiteName ? ` · 正在处理 ${progress.currentSiteName}` : '';
    $('balanceProgressText').textContent = `刷新余额中：成功 ${Number(progress.succeeded) || 0}，失败 ${Number(progress.failed) || 0}${skippedPart}${current}`;
  } else if (status === 'stopping') {
    $('balanceProgressText').textContent = '正在停止余额刷新；当前站点完成后结束';
  } else if (status === 'stopped') {
    const pending = Array.isArray(progress.pendingSiteIds)
      ? progress.pendingSiteIds.length
      : Math.max(0, total - completed);
    $('balanceProgressText').textContent = `余额刷新已停止，剩余 ${pending} 个；点“刷新余额”继续`;
  } else if (status === 'interrupted') {
    const pending = Array.isArray(progress.pendingSiteIds) ? progress.pendingSiteIds.length : 0;
    $('balanceProgressText').textContent = `余额刷新已中断，剩余 ${pending} 个；点“刷新余额”继续`;
  } else {
    $('balanceProgressText').textContent = `余额刷新完成：成功 ${Number(progress.succeeded) || 0}，失败 ${Number(progress.failed) || 0}${skippedPart}`;
  }
}

function safeDomIdPart(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9_-]+/g, '_');
}

function positionPopover(trigger, menu) {
  if (!trigger || !menu || menu.hidden) return;
  const gap = 6;
  const edge = 8;
  menu.style.left = '0px';
  menu.style.top = '0px';
  const triggerRect = trigger.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const maxLeft = Math.max(edge, window.innerWidth - menuRect.width - edge);
  let left = Math.min(maxLeft, Math.max(edge, triggerRect.right - menuRect.width));
  let top = triggerRect.bottom + gap;
  if (top + menuRect.height > window.innerHeight - edge) {
    top = Math.max(edge, triggerRect.top - menuRect.height - gap);
  }
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function triggerForPopover(menu) {
  if (!menu?.id) return null;
  return Array.from(document.querySelectorAll('[aria-controls]'))
    .find((item) => item.getAttribute('aria-controls') === menu.id) || null;
}

function closePopover(trigger, menu, restoreFocus = false) {
  if (!menu) return;
  menu.hidden = true;
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
  if (restoreFocus) trigger?.focus();
}

function openPopover(trigger, menu, focusFirst = false) {
  if (!trigger || !menu) return;
  document.querySelectorAll('.popover:not([hidden])').forEach((other) => {
    if (other === menu) return;
    const owner = triggerForPopover(other);
    closePopover(owner, other);
  });
  menu.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  positionPopover(trigger, menu);
  if (focusFirst) {
    queueMicrotask(() => {
      const selected = menu.querySelector('[role="menuitemradio"][aria-checked="true"]');
      (selected || menu.querySelector('button:not([disabled])'))?.focus();
    });
  }
}

function togglePopover(trigger, menu, focusFirst = false) {
  if (!trigger || !menu) return;
  if (menu.hidden) openPopover(trigger, menu, focusFirst);
  else closePopover(trigger, menu, true);
}

function closeAllPopovers(restoreFocus = false) {
  document.querySelectorAll('.popover:not([hidden])').forEach((menu) => {
    const trigger = triggerForPopover(menu);
    closePopover(trigger, menu, restoreFocus);
  });
  state.expandedId = null;
}

function confirmWithDialog(dialogId, copy, trigger) {
  const dialog = $(dialogId);
  if (!dialog?.showModal) return Promise.resolve(false);
  const copyEl = dialog.querySelector('[aria-describedby]')
    ? null
    : dialog.querySelector('p');
  const describedId = dialog.getAttribute('aria-describedby');
  const described = describedId ? document.getElementById(describedId) : copyEl;
  if (described && copy) described.textContent = copy;

  return new Promise((resolve) => {
    const previouslyFocused = trigger || document.activeElement;
    const finish = () => {
      document.body.classList.remove('modal-open');
      const confirmed = dialog.returnValue === 'confirm';
      queueMicrotask(() => previouslyFocused?.isConnected && previouslyFocused.focus());
      resolve(confirmed);
    };
    dialog.returnValue = 'cancel';
    dialog.addEventListener('close', finish, { once: true });
    dialog.addEventListener('cancel', () => {
      dialog.returnValue = 'cancel';
    }, { once: true });
    document.body.classList.add('modal-open');
    dialog.showModal();
    queueMicrotask(() => dialog.querySelector('button[value="cancel"]')?.focus());
  });
}

function getUsableDefaultKey(site) {
  const usable = (site?.keys || []).filter((key) => hasCompleteKeyValue(key?.key));
  return usable.find((key) => key.isDefault) || usable[0] || null;
}

function openOptions(siteId = '') {
  const editSiteId = typeof siteId === 'string' ? siteId : '';
  if (editSiteId && chrome.tabs?.create && chrome.runtime?.getURL) {
    const hash = `#view=sites&edit=${encodeURIComponent(editSiteId)}`;
    chrome.tabs.create({ url: `${chrome.runtime.getURL('options.html')}${hash}` });
    return;
  }
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  else window.open(chrome.runtime.getURL('options.html'));
}

function displayHealth(site) {
  return typeof deriveSiteHealth === 'function'
    ? deriveSiteHealth(site, { includeCheckin: false })
    : { level: 'needsAttention', label: '需检查', tone: 'warning' };
}

function visibleSites() {
  let sites;
  if (typeof filterSites === 'function') {
    sites = filterSites(state.sites, {
      query: state.query,
      category: state.categoryFilter,
      tag: state.tagFilter
    });
  } else {
    sites = state.sites.slice();
  }
  if (state.healthFilter === 'all') return sites;
  return sites.filter((site) => displayHealth(site).level === state.healthFilter);
}

function renderFilters() {
  document.querySelectorAll('#categoryFilter [data-cat]').forEach((btn) => {
    const active = btn.dataset.cat === state.categoryFilter;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  const tagBar = $('tagFilter');
  const tagTrigger = $('tagFilterTrigger');
  const tagRoot = tagTrigger?.closest('.tag-menu-root');
  if (tagBar) {
    const tags = typeof collectSiteTags === 'function'
      ? collectSiteTags(state.sites, { limit: 12 })
      : [];
    if (!tags.length) {
      tagBar.hidden = true;
      tagBar.innerHTML = '';
      if (tagRoot) tagRoot.hidden = true;
      if (state.tagFilter !== 'all') state.tagFilter = 'all';
    } else {
      const known = new Set(tags.map((item) => item.tag.toLowerCase()));
      if (state.tagFilter !== 'all' && !known.has(String(state.tagFilter).toLowerCase())) {
        state.tagFilter = 'all';
      }
      const activeTag = String(state.tagFilter || 'all');
      const chips = [
        { tag: 'all', label: '标签' },
        ...tags.map((item) => ({ tag: item.tag, label: `#${item.tag}` }))
      ];
      if (tagRoot) tagRoot.hidden = false;
      tagBar.hidden = true;
      tagTrigger?.setAttribute('aria-expanded', 'false');
      tagBar.innerHTML = chips.map((item) => {
        const active = item.tag === 'all'
          ? activeTag === 'all'
          : activeTag.toLowerCase() === item.tag.toLowerCase();
        return `<button type="button" class="menu-item tag-option" role="menuitemradio" data-tag="${escapeAttr(item.tag)}" aria-checked="${String(active)}"><span>${escapeHtml(item.label)}</span>${active ? '<span aria-hidden="true">✓</span>' : ''}</button>`;
      }).join('');
      const label = state.tagFilter === 'all' ? '标签' : `#${state.tagFilter}`;
      if ($('tagFilterLabel')) $('tagFilterLabel').textContent = label;
    }
  }
  $('saveCurrent').textContent = '收藏当前页';
  if ($('saveCategory')) $('saveCategory').value = state.saveCategory;
  const saveCategoryText = state.saveCategory === 'relay' ? '中转站' : '公益站';
  $('saveCategoryTrigger')?.setAttribute('aria-label', `收藏分类：${saveCategoryText}`);
  $('saveCategoryTrigger')?.setAttribute('title', `当前分类：${saveCategoryText}`);
  document.querySelectorAll('[data-save-category]').forEach((item) => {
    item.setAttribute('aria-checked', String(item.dataset.saveCategory === state.saveCategory));
  });
}

function countFailedBalanceSites() {
  return state.sites.filter((site) => site?.balanceStatus?.status === 'failed').length;
}

function countLoginFailedSites() {
  return state.sites.filter((site) => {
    if (site?.balanceStatus?.status !== 'failed') return false;
    const code = String(site.balanceStatus?.lastError?.code || '');
    const msg = String(site.balanceStatus?.lastError?.message || '');
    return code === 'not_logged_in'
      || code === 'tab_open_failed'
      || /未登录|登录|个人中心|会话/.test(msg);
  }).length;
}

function renderQuickTools() {
  const menu = $('quickTools');
  const trigger = $('quickToolsTrigger');
  if (!menu || !trigger) return;
  const failed = countFailedBalanceSites();
  const loginFailed = countLoginFailedSites();
  trigger.hidden = failed === 0;
  if (!failed) closePopover(trigger, menu);
  const retryBtn = $('popupRetryFailed');
  const openFailedBtn = $('popupOpenFailed');
  const openLoginBtn = $('popupOpenLoginFailed');
  if (retryBtn) retryBtn.disabled = failed === 0;
  if (openFailedBtn) openFailedBtn.disabled = failed === 0;
  if (openLoginBtn) openLoginBtn.disabled = loginFailed === 0;
}

function renderHealthSummary() {
  const counts = { healthy: 0, needsAttention: 0, failed: 0 };
  state.sites.forEach((site) => {
    const health = displayHealth(site);
    if (health && Object.hasOwn(counts, health.level)) counts[health.level] += 1;
  });
  $('healthyCount').textContent = String(counts.healthy);
  $('attentionCount').textContent = String(counts.needsAttention);
  $('failedCount').textContent = String(counts.failed);
  const total = state.sites.length;
  $('overviewTitle').textContent = `已收藏 ${total} 个站点`;
  $('overviewSubline').textContent = '站点、接口地址与 Key 都在这里';
  $('listScope').textContent = String(total);
  document.querySelectorAll('#healthSummary [data-health]').forEach((btn) => {
    const active = btn.dataset.health === state.healthFilter;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  renderQuickTools();
}

/** 收藏分类与列表筛选分离，只由独立控件和已保存偏好决定。 */
function resolveSaveCategory() {
  return state.saveCategory === 'relay' ? 'relay' : 'gongyi';
}

function keyTail(value) {
  const key = String(value || '').trim();
  return key ? `尾号 ${key.slice(-4)}` : '未配置';
}

function popupBalanceErrorMessage(site) {
  const error = site?.balanceStatus?.lastError || {};
  if (error.code === 'not_logged_in') return '登录状态已失效，打开站点恢复登录后再查询余额。';
  if (error.code === 'permission_denied') return '尚未授权访问该站点，授权后再查询余额。';
  return typeof shortBalanceErrorMessage === 'function'
    ? shortBalanceErrorMessage(error)
    : (error.message || '余额查询失败');
}

function render() {
  const list = $('list');
  const sites = visibleSites();
  const shell = document.querySelector('.popup-shell');
  renderFilters();
  renderHealthSummary();
  renderBalanceProgress();

  if (!state.sites.length) {
    shell?.setAttribute('data-popup-state', 'empty');
    list.dataset.listState = 'empty';
    list.innerHTML = `
      <div class="popup-empty">
        <span class="empty-icon" aria-hidden="true">
          <svg class="icon" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
        </span>
        <h2>还没有收藏站点</h2>
        <p>打开目标站后点击“收藏当前页”，扩展会自动识别站点和可用 Key。</p>
      </div>`;
    return;
  }

  shell?.setAttribute('data-popup-state', 'mixed');
  if (!sites.length) {
    list.dataset.listState = 'no-results';
    list.innerHTML = `
      <div class="popup-empty">
        <span class="empty-icon" aria-hidden="true">
          <svg class="icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg>
        </span>
        <h2>没有匹配的站点</h2>
        <p>尝试清除搜索词，或切换健康状态、分类和标签筛选。</p>
        <button type="button" class="btn btn-sm" data-act="reset-filters">清除筛选</button>
      </div>`;
    return;
  }

  list.dataset.listState = 'ready';
  list.innerHTML = sites.map((site, index) => {
    const keys = site.keys || [];
    const keyCount = keys.length;
    const defKey = getUsableDefaultKey(site);
    const usableKeyCount = keys.filter((key) => hasCompleteKeyValue(key?.key)).length;
    const maskedKeyCount = Math.max(0, keyCount - usableKeyCount);
    const category = typeof categoryLabel === 'function'
      ? categoryLabel(site.category)
      : (site.category === 'relay' ? '中转站' : '公益站');
    const isOpen = state.expandedId === site.id;
    const menuId = `site-menu-${index}-${safeDomIdPart(site.id)}`;
    const titleId = `site-title-${index}-${safeDomIdPart(site.id)}`;
    const hasBalanceData = Boolean(site.balance || site.usage || site.balanceUpdatedAt);
    const balanceText = hasBalanceData ? formatBalance(site) : '—';
    const balanceLabel = balanceStateText(site);
    const health = displayHealth(site);
    const tone = ['success', 'warning', 'danger'].includes(health.tone)
      ? health.tone
      : 'warning';
    const healthLabel = site.balanceStatus?.status === 'failed'
      ? '余额失败'
      : (!hasBalanceData ? '未查余额' : (health.level === 'healthy' ? '正常' : health.label));
    const visibleTags = (site.tags || []).slice(0, 2);
    const hiddenTagCount = Math.max(0, (site.tags || []).length - visibleTags.length);

    const keyRows = keys.map((key) => {
      const usable = hasCompleteKeyValue(key?.key);
      const isDefault = Boolean(key.isDefault || key.id === defKey?.id);
      return `<div class="key-menu-row" data-key-id="${escapeAttr(key.id)}">
        <div class="key-menu-copy">
          <strong>${escapeHtml(key.name || 'Key')}${isDefault ? ' · 默认' : ''}</strong>
          <small>${escapeHtml(usable ? maskKey(key.key) : '待修复的掩码 Key')}</small>
        </div>
        <div class="key-menu-actions">
          ${usable ? `<button type="button" class="btn btn-sm" data-act="copy-key" data-key-id="${escapeAttr(key.id)}">复制</button>` : ''}
          ${usable && !isDefault ? `<button type="button" class="btn btn-sm" data-act="set-default-key" data-key-id="${escapeAttr(key.id)}">默认</button>` : ''}
        </div>
      </div>`;
    }).join('');

    const errorHtml = site.balanceStatus?.status === 'failed'
      ? (() => {
        const message = popupBalanceErrorMessage(site);
        const fix = balanceErrorActionMeta(site);
        return `<div class="inline-error">
          <div class="notice" data-tone="danger" role="alert">
            <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9v4m0 4h.01M10.3 4.7 3.8 16a2 2 0 0 0 1.7 3h13a2 2 0 0 0 1.7-3L13.7 4.7a2 2 0 0 0-3.4 0Z"/></svg>
            <span>${escapeHtml(message)}</span>
          </div>
          <div class="inline-actions">
            ${fix ? `<button type="button" class="btn btn-soft btn-sm" data-act="${escapeAttr(fix.act)}">${escapeHtml(fix.label)}</button>` : ''}
            <button type="button" class="btn btn-sm" data-act="refresh">再查余额</button>
          </div>
        </div>`;
      })()
      : '';

    return `<article class="site site-card" data-id="${escapeAttr(site.id)}" data-tone="${escapeAttr(tone)}" data-health="${escapeAttr(health.level)}" aria-labelledby="${titleId}">
      <header class="site-card-header">
        <div class="site-identity">
          <button type="button" class="site-name-button" id="${titleId}" data-act="open" title="打开站点">${escapeHtml(site.name || site.domain)}</button>
          <div class="site-origin mono">${escapeHtml(originForSite(site))}</div>
        </div>
        <div class="site-card-header-actions">
          <span class="status-pill" data-tone="${escapeAttr(tone)}">${escapeHtml(healthLabel)}</span>
          <button type="button" class="icon-btn" data-act="toggle-more" aria-label="${escapeAttr(site.name || site.domain)}更多操作" aria-expanded="${String(isOpen)}" aria-controls="${menuId}">
            <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>
          </button>
          <div class="popover site-more" id="${menuId}" role="menu" ${isOpen ? '' : 'hidden'}>
            <div class="site-more-section">
              <button class="menu-item" type="button" role="menuitem" data-act="edit">编辑站点</button>
              <button class="menu-item" type="button" role="menuitem" data-act="redetect">重新识别</button>
              <button class="menu-item" type="button" role="menuitem" data-act="open-token">打开令牌页</button>
              <button class="menu-item" type="button" role="menuitem" data-tone="danger" data-act="delete">删除站点</button>
            </div>
            <div class="site-more-section">
              <div class="site-more-label">Key · ${keyCount}${maskedKeyCount ? `（${maskedKeyCount} 待修复）` : ''}</div>
              ${keyRows}
              ${!defKey ? `<button class="menu-item" type="button" data-act="auto-key">${escapeHtml(autoKeyButtonLabel(site))}</button>` : ''}
              <div class="key-entry key-row">
                <input class="input" type="password" data-key-input aria-label="追加 API Key" placeholder="粘贴完整 sk-…" autocomplete="new-password" spellcheck="false">
                <button type="button" class="btn btn-sm" data-act="add-key">保存</button>
              </div>
            </div>
          </div>
        </div>
      </header>
      <div class="site-tags">
        <span class="tag">${escapeHtml(category)}</span>
        ${visibleTags.map((tag) => `<span class="tag">#${escapeHtml(tag)}</span>`).join('')}
        ${hiddenTagCount ? `<span class="tag">+${hiddenTagCount}</span>` : ''}
      </div>
      ${errorHtml}
      ${site.balanceStatus?.status === 'failed' ? '' : `<div class="site-card-data">
        <div>
          <span class="data-label">${escapeHtml(hasBalanceData ? balanceLabel : '余额')}</span>
          <strong class="balance-value">${escapeHtml(balanceText)}</strong>
        </div>
        <div class="key-summary">
          <span>${defKey ? escapeHtml(defKey.name || '默认 Key') : (maskedKeyCount ? `${maskedKeyCount} 个 Key 待修复` : 'Key 可选')}</span>
          <span class="key-mask">${defKey ? escapeHtml(keyTail(defKey.key)) : '未配置'}</span>
        </div>
      </div>`}
      <footer class="site-card-actions">
        <button class="btn btn-sm" type="button" data-act="open">打开站点</button>
        <button class="btn btn-sm" type="button" data-act="copy-client">复制接口地址</button>
        ${defKey
          ? `<button class="btn btn-sm" type="button" data-act="copy-key" data-key-id="${escapeAttr(defKey.id)}">复制 Key</button>`
          : `<button class="btn btn-soft btn-sm" type="button" data-act="auto-key">获取 Key</button>`}
        ${site.balanceStatus?.status === 'failed' ? '' : '<button class="btn btn-sm" type="button" data-act="refresh">刷新余额</button>'}
      </footer>
    </article>`;
  }).join('');

  if (state.expandedId) {
    queueMicrotask(() => {
      const card = Array.from(list.querySelectorAll('.site-card'))
        .find((item) => item.dataset.id === state.expandedId);
      const trigger = card?.querySelector('[data-act="toggle-more"]');
      const menu = card?.querySelector('.site-more');
      if (trigger && menu) positionPopover(trigger, menu);
    });
  }
}

async function load() {
  const [sitesRes, prefsRes, progressRes] = await Promise.all([
    send('listSites'),
    send('getPrefs'),
    send('getBalanceRefreshProgress'),
    captureActiveTabUrl()
  ]);
  if (!sitesRes.ok) {
    toast(sitesRes.error || '加载失败', 'err');
    return;
  }
  state.sites = sitesRes.sites || [];
  if (prefsRes.ok && prefsRes.prefs) {
    if (prefsRes.prefs.defaultCategory) {
      state.saveCategory = prefsRes.prefs.defaultCategory === 'relay' ? 'relay' : 'gongyi';
    }
  }
  if (progressRes.ok) applyBalanceRefreshProgress(progressRes.progress);
  render();
}

function captureKeyDraft() {
  const input = document.querySelector('.site-card [data-key-input]');
  const card = input?.closest('.site-card');
  if (!input?.value || !card?.dataset.id) return null;
  return {
    siteId: card.dataset.id,
    value: input.value,
    focused: document.activeElement === input,
    selectionStart: input.selectionStart,
    selectionEnd: input.selectionEnd
  };
}

function restoreKeyDraft(draft) {
  if (!draft) return;
  const card = Array.from(document.querySelectorAll('.site-card'))
    .find((item) => item.dataset.id === draft.siteId);
  const input = card?.querySelector('[data-key-input]');
  if (!input) return;
  input.value = draft.value;
  if (!draft.focused) return;
  queueMicrotask(() => {
    input.focus();
    try { input.setSelectionRange(draft.selectionStart, draft.selectionEnd); } catch {}
  });
}

function applySitesSnapshot(nextSites) {
  const draft = captureKeyDraft();
  state.sites = Array.isArray(nextSites) ? nextSites : [];
  if (state.expandedId && !state.sites.some((site) => site.id === state.expandedId)) {
    state.expandedId = null;
  }
  render();
  restoreKeyDraft(draft);
}

if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.sites) {
      applySitesSnapshot(changes.sites.newValue || []);
    }
    if (changes.prefs?.newValue) {
      const prefs = changes.prefs.newValue;
      state.saveCategory = prefs.defaultCategory === 'relay' ? 'relay' : 'gongyi';
      if ($('saveCategory')) $('saveCategory').value = state.saveCategory;
      const label = state.saveCategory === 'relay' ? '中转站' : '公益站';
      $('saveCategoryTrigger')?.setAttribute('aria-label', `收藏分类：${label}`);
      $('saveCategoryTrigger')?.setAttribute('title', `当前分类：${label}`);
      document.querySelectorAll('[data-save-category]').forEach((item) => {
        item.setAttribute('aria-checked', String(item.dataset.saveCategory === state.saveCategory));
      });
    }
    if (changes.balanceRefreshProgress) {
      if (applyBalanceRefreshProgress(changes.balanceRefreshProgress.newValue || null)) {
        renderBalanceProgress();
      }
    }
  });
}

async function copyText(text, okMsg) {
  const result = await PublicSiteUi.writeClipboard(text);
  if (!result.ok) {
    toast(result.error || '复制失败', 'err');
    return false;
  }
  toast(okMsg || '已复制', 'ok');
  return true;
}

async function deleteSite(site, trigger) {
  const name = site.name || site.domain;
  const confirmed = await confirmWithDialog(
    'deleteDialog',
    `「${name}」及其 Key 将一并删除，无法撤销。`,
    trigger
  );
  if (!confirmed) return;
  const res = await send('removeSite', { id: site.id });
  if (!res.ok) {
    toast(res.error || '删除失败', 'err');
    return;
  }
  state.sites = res.sites || [];
  if (state.expandedId === site.id) state.expandedId = null;
  toast(`已删除 ${name}`, 'ok');
  render();
}

async function addKeyToSite(site, inputEl) {
  const key = String(inputEl?.value || '').trim();
  if (!key || !hasCompleteKeyValue(key)) {
    toast('请粘贴完整、未脱敏的 API Key', 'err');
    inputEl?.focus();
    return;
  }
  const res = await send('addKey', {
    siteId: site.id,
    key: { name: '默认', key, isDefault: true }
  });
  if (!res.ok) {
    toast(res.error || '保存 Key 失败', 'err');
    return;
  }
  state.sites = res.sites || [];
  toast('Key 已保存', 'ok');
  render();
}

const renderSearchResults = PublicSiteUi.debounce(render, 120);
$('search').addEventListener('input', (e) => {
  state.query = e.target.value || '';
  renderSearchResults();
});

$('categoryFilter').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-cat]');
  if (!btn) return;
  state.categoryFilter = btn.dataset.cat || 'all';
  render();
});

$('tagFilter')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tag]');
  if (!btn) return;
  const tag = btn.dataset.tag || 'all';
  if (tag === 'all') state.tagFilter = 'all';
  else if (String(state.tagFilter || '').toLowerCase() === tag.toLowerCase()) state.tagFilter = 'all';
  else state.tagFilter = tag;
  closePopover($('tagFilterTrigger'), $('tagFilter'), true);
  render();
});

async function saveCategoryPreference(nextValue) {
  const next = nextValue === 'relay' ? 'relay' : 'gongyi';
  const previous = state.saveCategory;
  state.saveCategory = next;
  render();
  const res = await send('savePrefs', { prefs: { defaultCategory: next } });
  if (!res.ok) {
    state.saveCategory = previous;
    render();
    toast(res.error || '保存收藏分类失败', 'err');
  }
}

$('saveCategory')?.addEventListener('change', (e) => {
  void saveCategoryPreference(e.target.value);
});

$('saveCategoryTrigger')?.addEventListener('click', (e) => {
  e.stopPropagation();
  togglePopover(e.currentTarget, $('saveCategoryMenu'), true);
});

$('saveCategoryMenu')?.addEventListener('click', (e) => {
  const item = e.target.closest('[data-save-category]');
  if (!item) return;
  closePopover($('saveCategoryTrigger'), $('saveCategoryMenu'), true);
  void saveCategoryPreference(item.dataset.saveCategory);
});

$('saveCategoryMenu')?.addEventListener('keydown', (event) => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = Array.from(event.currentTarget.querySelectorAll('[role="menuitemradio"]'));
  if (!items.length) return;
  event.preventDefault();
  const current = Math.max(0, items.indexOf(document.activeElement));
  const next = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? items.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  items[next].focus();
});

$('tagFilterTrigger')?.addEventListener('click', (e) => {
  e.stopPropagation();
  togglePopover(e.currentTarget, $('tagFilter'), true);
});

$('tagFilter')?.addEventListener('keydown', (event) => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = Array.from(event.currentTarget.querySelectorAll('[role="menuitemradio"]'));
  if (!items.length) return;
  event.preventDefault();
  const current = Math.max(0, items.indexOf(document.activeElement));
  const next = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? items.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  items[next].focus();
});

$('quickToolsTrigger')?.addEventListener('click', (e) => {
  e.stopPropagation();
  togglePopover(e.currentTarget, $('quickTools'), true);
});

$('healthSummary').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-health]');
  if (!btn) return;
  const health = btn.dataset.health;
  state.healthFilter = state.healthFilter === health ? 'all' : health;
  render();
});

$('saveCurrent').addEventListener('click', async () => {
  if (!(await requestAccessForAction(permissionTargetsForAction('saveCurrentTab'), null, 'saveCurrentTab'))) return;
  await runMutation(async () => {
    if (state.busy) return;
    state.busy = true;
    const category = resolveSaveCategory();
    toast(category === 'relay' ? '自动识别并收藏为中转站…' : '自动识别并收藏…');
    $('saveCurrent').disabled = true;
    const res = await send('saveCurrentTab', { detect: true, category });
    $('saveCurrent').disabled = false;
    state.busy = false;

    if (!res.ok) {
      toast(res.error || '收藏失败', 'err', resolveErrorAction(res, null, 'saveCurrentTab'));
      return;
    }

    state.saveCategory = category;
    await send('savePrefs', { prefs: { defaultCategory: category } });

    const name = res.site?.name || res.site?.domain || '';
    const summary = res.detection?.summary ? ` · ${res.detection.summary}` : '';
    const keysAdded = res.keyImport?.added
      ? ` · 已自动导入 ${res.keyImport.added} 个 Key`
      : '';
    toast(`已收藏 ${name}${summary}${keysAdded}`, 'ok');
    await load();
  });
});

$('refreshBalances').addEventListener('click', async () => {
  if (!(await requestAccessForAction(
    state.sites,
    null,
    'refreshAllBalances',
    { continueOnDenied: true }
  ))) return;
  await runMutation(async () => {
    if (state.busy) return;
    state.busy = true;
    state.balanceStopPendingRunId = '';
    toast('正在刷新余额…');
    $('refreshBalances').disabled = true;
    state.balanceRefreshProgress = { status: 'running', total: state.sites.length, completed: 0, succeeded: 0, failed: 0 };
    renderBalanceProgress();
    const res = await send('refreshAllBalances');
    state.busy = false;
    if (res.progress) applyBalanceRefreshProgress(res.progress);
    renderBalanceProgress();
    if (!res.ok) {
      toast(res.error || '刷新失败', 'err', resolveErrorAction(res, null, 'refreshAllBalances'));
      return;
    }
    state.sites = res.sites || [];
    if (res.stopped || res.progress?.status === 'stopped') {
      const progress = res.progress || {};
      const total = Number(progress.total) || state.sites.length;
      const completed = Math.min(total, Number(progress.completed) || 0);
      const pending = Array.isArray(progress.pendingSiteIds)
        ? progress.pendingSiteIds.length
        : Math.max(0, total - completed);
      toast(`余额刷新已停止 · 完成 ${completed}/${total} · 剩余 ${pending} 个`);
      render();
      return;
    }
    const rows = res.results || [];
    const okCount = rows.filter((r) => r.ok).length;
    const skipCount = rows.filter((r) => r.skipped).length;
    const failCount = rows.length - okCount - skipCount;
    let summary = `余额：${okCount}/${rows.length} 成功`;
    if (failCount) summary += ` · ${failCount} 失败`;
    if (skipCount) summary += ` · ${skipCount} 未授权跳过`;
    toast(summary, okCount ? 'ok' : 'err');
    render();
  });
});

$('stopBalanceRefresh')?.addEventListener('click', async () => {
  const progress = state.balanceRefreshProgress || {};
  const runId = String(progress.runId || '').trim();
  if (progress.status !== 'running' || !runId) return;
  state.balanceStopFocusPending = true;
  state.balanceStopPendingRunId = runId;
  state.balanceRefreshProgress = {
    ...progress,
    status: 'stopping',
    stopRequestedAt: Date.now()
  };
  renderBalanceProgress();
  queueMicrotask(() => $('balanceProgress')?.focus());
  const res = await send('stopBalanceRefresh', { runId });
  if (res.progress) applyBalanceRefreshProgress(res.progress);
  if (!res.ok) {
    state.balanceStopPendingRunId = '';
    if (state.balanceRefreshProgress?.runId === runId
      && state.balanceRefreshProgress?.status === 'stopping') {
      state.balanceRefreshProgress = {
        ...state.balanceRefreshProgress,
        status: 'running'
      };
    }
    renderBalanceProgress();
    state.balanceStopFocusPending = false;
    queueMicrotask(() => $('stopBalanceRefresh')?.focus());
    toast(res.error || '停止失败，请重试', 'err');
    return;
  }
  renderBalanceProgress();
  if (!res.accepted && res.message) toast(res.message);
});

$('openOptions2').addEventListener('click', () => openOptions());

async function runQuickBalanceAction(type, payload, busyMsg) {
  await runMutation(async () => {
    toast(busyMsg);
    const res = await send(type, payload || {});
    if (!res.ok) {
      toast(res.error || res.message || '操作失败', 'err');
      return;
    }
    if (res.sites) state.sites = res.sites;
    if (res.progress) applyBalanceRefreshProgress(res.progress);
    if (res.stopped || res.progress?.status === 'stopped') {
      const progress = res.progress || {};
      const total = Number(progress.total) || state.sites.length;
      const completed = Math.min(total, Number(progress.completed) || 0);
      const pending = Array.isArray(progress.pendingSiteIds)
        ? progress.pendingSiteIds.length
        : Math.max(0, total - completed);
      toast(`余额刷新已停止 · 完成 ${completed}/${total} · 剩余 ${pending} 个`);
      render();
      return;
    }
    if (type === 'retryFailedBalances') {
      const rows = res.results || [];
      const okCount = rows.filter((r) => r.ok).length;
      toast(
        rows.length
          ? `${res.message || '重试完成'}：成功 ${okCount}/${rows.length}`
          : (res.message || '没有余额失败的站点'),
        rows.length && !okCount ? 'err' : 'ok'
      );
    } else {
      toast(res.message || `已打开 ${res.opened || 0} 个站点`, res.opened ? 'ok' : 'err');
    }
    render();
  });
}

const popupRetryFailed = $('popupRetryFailed');
if (popupRetryFailed) {
  popupRetryFailed.addEventListener('click', async () => {
    closePopover($('quickToolsTrigger'), $('quickTools'));
    const failedSites = permissionTargetsForAction('retryFailedBalances');
    if (!(await requestAccessForAction(
      failedSites,
      null,
      'retryFailedBalances',
      { continueOnDenied: true }
    ))) return;
    void runQuickBalanceAction('retryFailedBalances', {}, '正在重试余额失败站…');
  });
}
const popupOpenFailed = $('popupOpenFailed');
if (popupOpenFailed) {
  popupOpenFailed.addEventListener('click', () => {
    closePopover($('quickToolsTrigger'), $('quickTools'));
    void runQuickBalanceAction('openFailedBalanceSites', { limit: 5, reason: 'all' }, '正在打开失败站…');
  });
}
const popupOpenLoginFailed = $('popupOpenLoginFailed');
if (popupOpenLoginFailed) {
  popupOpenLoginFailed.addEventListener('click', () => {
    closePopover($('quickToolsTrigger'), $('quickTools'));
    void runQuickBalanceAction(
      'openFailedBalanceSites',
      { limit: 5, reason: 'not_logged_in' },
      '正在打开未登录失败站…'
    );
  });
}

$('list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  if (btn.dataset.act === 'reset-filters') {
    e.preventDefault();
    Object.assign(state, { query: '', categoryFilter: 'all', tagFilter: 'all', healthFilter: 'all' });
    $('search').value = '';
    render();
    return;
  }
  const card = e.target.closest('.site');
  if (!card || e.target.matches('input')) return;

  const site = state.sites.find((s) => s.id === card.dataset.id);
  if (!site) return;
  e.preventDefault();
  e.stopPropagation();

  const act = btn.dataset.act;
  const permissionRetry = { 'auto-key': 'ensureSiteKey', refresh: 'refreshBalance', redetect: 'redetectSite' }[act];
  if (permissionRetry && !(await requestAccessForAction([site], site, permissionRetry))) return;

  if (act === 'open') {
    const openUrl = typeof openUrlForSite === 'function'
      ? openUrlForSite(site)
      : (site.domain ? `https://${site.domain}/` : site.baseUrl);
    const opened = await send('openUrl', { url: openUrl, siteId: site.id });
    toast(opened.ok ? '已打开站点' : (opened.error || '打开站点失败'), opened.ok ? 'ok' : 'err');
    return;
  }
  if (act === 'open-token') {
    const res = await send('openTokenPage', { id: site.id });
    if (!res.ok) toast(res.error || '打开令牌页失败', 'err');
    return;
  }
  if (act === 'edit') {
    openOptions(site.id);
    return;
  }
  if (act === 'toggle-more') {
    const menu = card.querySelector('.site-more');
    if (state.expandedId === site.id && menu && !menu.hidden) {
      closePopover(btn, menu, true);
      state.expandedId = null;
    } else {
      closeAllPopovers();
      state.expandedId = site.id;
      openPopover(btn, menu, true);
    }
    return;
  }
  if (act === 'delete') {
    await runMutation(async () => deleteSite(site, btn));
    return;
  }
  if (act === 'add-key') {
    const input = btn.closest('.key-row')?.querySelector('[data-key-input]')
      || card.querySelector('[data-key-input]');
    await runMutation(async () => addKeyToSite(site, input));
    return;
  }
  if (act === 'auto-key') {
    await runMutation(async () => {
      btn.disabled = true;
      toast('正在识别并补 Key…');
      let res = await send('ensureSiteKey', { id: site.id, allowCreate: false });
      if (res.code === 'create_confirmation_required' || res.needsCreateConfirm) {
        const prefsRes = await send('getPrefs');
        const unlimited = prefsRes?.prefs?.preferUnlimitedAutoKey === true;
        const ok = await confirmWithDialog(
          'keyCreateDialog',
          unlimited
            ? '未在该站发现可用 Key。继续将创建一把永不过期、无限额度的 API Key，并仅保存到本机。'
            : '未在该站发现可用 Key。继续将创建一把约 $10 额度、90 天后过期的 API Key，并仅保存到本机。',
          btn
        );
        if (!ok) {
          btn.disabled = false;
          toast('已取消创建 Key');
          return;
        }
        toast('正在创建 Key…');
        res = await send('ensureSiteKey', { id: site.id, allowCreate: true });
      }
      btn.disabled = false;
      if (!res.ok) {
        if (res.sites) state.sites = res.sites;
        toast(res.error || '自动获取 Key 失败', 'err', resolveErrorAction(res, site, 'ensureSiteKey'));
        if (res.sites) render();
        return;
      }
      state.sites = res.sites || state.sites;
      const message = res.outcome === 'created'
        ? '未发现 Key，已自动创建并导入 1 个 Key'
        : (res.outcome === 'imported'
          ? `已自动识别并导入 ${res.added || res.found || 1} 个 Key`
          : '该站已有可用 Key');
      toast(message, 'ok');
      render();
    });
    return;
  }
  if (act === 'copy-client') {
    const text = typeof formatApiBaseV1 === 'function'
      ? formatApiBaseV1(site)
      : (site.domain ? `https://${site.domain}/v1` : '');
    if (!text) {
      toast('无法生成调用地址', 'err');
      return;
    }
    await copyText(text, `已复制 ${text}`);
    return;
  }
  if (act === 'copy-key') {
    const keyId = btn.dataset.keyId;
    const picked = keyId
      ? (site.keys || []).find((k) => k.id === keyId)
      : null;
    const def = picked
      || getUsableDefaultKey(site);
    if (!hasCompleteKeyValue(def?.key)) {
      toast('还没有 Key，先粘贴 sk- 保存', 'err');
      return;
    }
    const label = def.name ? `「${def.name}」` : '';
    await copyText(def.key, `已复制 ${label} Key（${maskKey(def.key)}）到系统剪贴板，请用后清理剪贴板`);
    return;
  }
  if (act === 'set-default-key') {
    const keyId = btn.dataset.keyId;
    if (!keyId) return;
    await runMutation(async () => {
      const res = await send('setDefaultKey', { siteId: site.id, keyId });
      if (!res.ok) {
        toast(res.error || '设置默认失败', 'err');
        return;
      }
      state.sites = res.sites || [];
      toast('已设为默认 Key（复制默认 / 余额优先用这把）', 'ok');
      render();
    });
    return;
  }
  if (act === 'refresh') {
    await runMutation(async () => {
      btn.disabled = true;
      toast('查余额中（需该站已登录）…');
      const res = await send('refreshBalance', { id: site.id });
      btn.disabled = false;
      if (!res.ok) {
        toast(
          res.error || '余额失败：请先登录该站个人中心',
          'err',
          resolveErrorAction(res, site, 'refreshBalance')
        );
        if (res.site) {
          const idx = state.sites.findIndex((s) => s.id === site.id);
          if (idx >= 0) state.sites[idx] = res.site;
          render();
        }
        return;
      }
      const idx = state.sites.findIndex((s) => s.id === site.id);
      if (idx >= 0) state.sites[idx] = res.site;
      const details = [];
      if (res.site.balance) details.push(`余额 ${res.site.balance}`);
      if (res.site.usage) details.push(`已用 ${res.site.usage}`);
      if (!details.length) details.push('余额已查询');
      let msg = details.join(' · ');
      if (res.importedKeys) msg += ` · 顺带导入 ${res.importedKeys} Key`;
      if (res.suspicious) msg += '\n数值异常偏大，请对照网页个人中心';
      toast(msg, res.suspicious ? 'err' : 'ok');
      render();
    });
    return;
  }
  if (act === 'redetect') {
    await runMutation(async () => {
      btn.disabled = true;
      toast('识别中…');
      const res = await send('redetectSite', { id: site.id });
      btn.disabled = false;
      if (!res.ok) {
        toast(res.error || '识别失败', 'err', resolveErrorAction(res, site, 'redetectSite'));
        return;
      }
      state.sites = res.sites || [];
      toast(res.detection?.summary || '识别完成', 'ok');
      render();
    });
    return;
  }
});

// Enter 在 Key 输入框里直接保存
$('list').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const input = e.target.closest('[data-key-input]');
  if (!input) return;
  e.preventDefault();
  const card = e.target.closest('.site');
  const site = state.sites.find((s) => s.id === card?.dataset?.id);
  if (!site) return;
  await runMutation(async () => addKeyToSite(site, input));
});

document.addEventListener('click', (event) => {
  if (event.target.closest('.popover, [aria-controls]')) return;
  closeAllPopovers();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const openMenu = document.querySelector('.popover:not([hidden])');
  if (!openMenu) return;
  event.preventDefault();
  const trigger = triggerForPopover(openMenu);
  closePopover(trigger, openMenu, true);
  if (openMenu.classList.contains('site-more')) state.expandedId = null;
});

window.addEventListener('resize', () => {
  const openMenu = document.querySelector('.popover:not([hidden])');
  if (openMenu) positionPopover(triggerForPopover(openMenu), openMenu);
});

load();
