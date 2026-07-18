/**
 * 余额单站/批量刷新编排（依赖 importScripts 已加载的 storage / tabs / balance / permissions）。
 * 通过 self 上的全局函数协作：loadSites、ensureAccessForSite、ensureSiteTab、fetchSiteBalance 等。
 */
(function (root) {
  let activeBalanceRefresh = null;

  function createBalanceRefreshRunId() {
    return `balance_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  }

/** 余额读取：多轮重试（SPA 渲染慢） */
async function scrapeBalanceWithRetry(tabId, type, rounds = 4, options = {}) {
  let last = { ok: false, error: 'no attempt' };
  for (let i = 0; i < rounds; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 900));
    last = typeof scrapeTabBalanceAndKeys === 'function'
      ? await scrapeTabBalanceAndKeys(tabId, type, options)
      : await fetchSiteBalance({ type, quotaPerUnit: options.quotaPerUnit }, { tabId, ...options });
    if (last?.ok && (last.balance || last.usage)) return last;
  }
  return last;
}
const SITE_BALANCE_TIMEOUT_MS = 25000;
const MAX_OWNED_TEMP_TABS = 2;

function balanceFailureMessage(error) {
  return String(error || '余额获取失败').replace(/\s+/g, ' ').trim().slice(0, 200) || '余额获取失败';
}

function classifySiteBalanceError(error, code) {
  if (typeof classifyBalanceError === 'function') {
    return classifyBalanceError(error, code);
  }
  return {
    code: code || 'refresh_failed',
    message: balanceFailureMessage(error),
    action: 'open_site'
  };
}

function recordBalanceFailure(site, error, code) {
  const now = Date.now();
  const classified = classifySiteBalanceError(error, code);
  site.balanceStatus = {
    status: 'failed',
    lastAttemptAt: now,
    lastError: {
      code: classified.code || 'refresh_failed',
      message: classified.message || balanceFailureMessage(error),
      ...(classified.action ? { action: classified.action } : {})
    }
  };
  site.updatedAt = now;
}

function withTimeout(promise, ms, label = '查询超时：站点响应过慢，可稍后重试') {
  const timeoutMs = Math.max(1000, Number(ms) || SITE_BALANCE_TIMEOUT_MS);
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(label);
      error.code = 'timeout';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function closeOwnedTempTabs(ownedTempTabs) {
  const list = Array.isArray(ownedTempTabs) ? ownedTempTabs : [];
  while (list.length) {
    const tabId = list.shift();
    if (tabId) await closeTabSafe(tabId);
  }
}

async function openOwnedTempTab(site, urls, ownedTempTabs) {
  const owned = Array.isArray(ownedTempTabs) ? ownedTempTabs : [];
  while (owned.length >= MAX_OWNED_TEMP_TABS) {
    const oldId = owned.shift();
    if (oldId) await closeTabSafe(oldId);
  }
  const temp = await openTemporaryBalanceTab(site, urls);
  if (temp?.tabId) owned.push(temp.tabId);
  return temp;
}

function recordBalanceSuccess(site, result) {
  const now = Date.now();
  site.balance = result.balance;
  site.usage = result.usage;
  site.balanceUpdatedAt = now;
  site.balanceStatus = { status: 'ok', lastAttemptAt: now, lastSuccessAt: now };
  site.updatedAt = now;
  if (result.quotaPerUnit) site.quotaPerUnit = result.quotaPerUnit;
}

async function refreshSiteBalance(siteId) {
  const sites = await loadSites();
  let site = sites.find((s) => s.id === siteId);
  if (!site) return { ok: false, error: '站点不存在' };
  const access = await ensureAccessForSite(site, { request: false });
  if (!access.ok) return access;

  if (!site.type || site.type === 'auto') {
    const detection = await detectSite(site.pageUrl || site.baseUrl || site.domain, {
      hintName: site.name
    });
    if (detection.ok && detection.type && detection.type !== 'auto') {
      site.type = detection.type;
      if (detection.name && site.name === site.domain) site.name = detection.name;
      if (detection.pageUrl) site.pageUrl = detection.pageUrl;
      site.detectSummary = detection.summary || site.detectSummary;
      site.detectConfidence = detection.confidence || site.detectConfidence;
    }
  }

  // 1) 优先用用户已打开的同域标签（不改 URL，避免把页面弄成 404）
  // 2) 失败再后台开临时个人中心页，用完立刻关
  // 3) 单站硬超时，避免 SW 被长任务拖死
  const ownedTempTabs = [];
  let result = null;

  try {
    result = await withTimeout((async () => {
      let tabId = null;
      let temporaryTab = false;

      const ensured = await ensureSiteTab(site, { preferPersonal: false });
      tabId = ensured.tabId;
      temporaryTab = ensured.temporary;
      if (temporaryTab && tabId) {
        while (ownedTempTabs.length >= MAX_OWNED_TEMP_TABS) {
          await closeTabSafe(ownedTempTabs.shift());
        }
        ownedTempTabs.push(tabId);
      }

      if (!tabId) {
        return {
          ok: false,
          code: 'tab_open_failed',
          error: '无法打开站点标签。请先在浏览器登录该站，再点余额'
        };
      }

      await new Promise((r) => setTimeout(r, temporaryTab ? 1200 : 300));
      const session = await readPageAuthSession(site.domain, siteOrigin(site));
      const balOpts = { quotaPerUnit: site.quotaPerUnit, expectedOrigin: siteOrigin(site) };

      let balanceResult = await scrapeBalanceWithRetry(
        tabId,
        site.type || 'newapi',
        temporaryTab ? 5 : 3,
        balOpts
      );

      if (!balanceResult?.ok) {
        balanceResult = await fetchSiteBalance(site, {
          pageToken: session.token,
          newApiUserId: session.userId || balanceResult?.userId,
          tabId,
          ...balOpts
        });
      }

      // 已有标签读不到时：另开临时页再试（仍不碰用户原标签）
      if (!balanceResult?.ok && !temporaryTab) {
        const temp = await openOwnedTempTab(site, personalUrls(site), ownedTempTabs);
        if (temp.tabId) {
          await new Promise((r) => setTimeout(r, 1500));
          const retry = await scrapeBalanceWithRetry(temp.tabId, site.type || 'newapi', 5, balOpts);
          if (retry?.ok) balanceResult = retry;
          else {
            const again = await fetchSiteBalance(site, {
              pageToken: session.token,
              newApiUserId: session.userId || retry?.userId,
              tabId: temp.tabId,
              ...balOpts
            });
            if (again?.ok) balanceResult = again;
            else if (!balanceResult?.ok) balanceResult = again || balanceResult;
          }
        }
      } else if (!balanceResult?.ok && temporaryTab && tabId) {
        await new Promise((r) => setTimeout(r, 1500));
        const retry = await scrapeTabBalanceAndKeys(tabId, site.type || 'newapi', balOpts);
        if (retry?.ok) balanceResult = retry;
      }

      return balanceResult || { ok: false, code: 'refresh_failed', error: '余额获取失败' };
    })(), SITE_BALANCE_TIMEOUT_MS);
  } catch (error) {
    const classified = classifySiteBalanceError(
      error?.message || error,
      error?.code || 'timeout'
    );
    result = { ok: false, code: classified.code, error: classified.message, action: classified.action };
  } finally {
    await closeOwnedTempTabs(ownedTempTabs);
    // 超时竞态：内层可能在 finally 后才 push 临时 tab，延迟再清一次
    setTimeout(() => { void closeOwnedTempTabs(ownedTempTabs); }, 2500);
  }

  if (!result?.ok) {
    const classified = classifySiteBalanceError(result?.error, result?.code);
    result = {
      ...result,
      ok: false,
      code: classified.code,
      error: classified.message,
      action: classified.action
    };
    site = await persistBalanceResult(site, result);
    return {
      ok: false,
      code: result.code,
      error: result.error,
      action: result.action,
      site,
      debug: { hasUser: result.hasUser, href: result.href, via: result.via }
    };
  }

  // 不要把 pageUrl 改成临时个人中心，避免「打开」进 404
  site = await persistBalanceResult(site, result);
  return {
    ok: true,
    site,
    source: result.source,
    via: result.via,
    importedKeys: result.trustedKeys?.length || 0,
    suspicious: typeof isSuspiciousBalance === 'function'
      ? isSuspiciousBalance(result.balance)
      : false
  };
}

async function getBalanceRefreshProgress() {
  const progress = typeof loadBalanceRefreshProgress === 'function'
    ? await loadBalanceRefreshProgress()
    : { status: 'idle', total: 0, completed: 0, succeeded: 0, failed: 0 };
  const isActiveStatus = ['running', 'stopping'].includes(progress.status);
  const activeMatches = Boolean(
    activeBalanceRefresh
    && progress.runId
    && progress.runId === activeBalanceRefresh.runId
  );
  if (activeMatches && activeBalanceRefresh.stopRequested) {
    return {
      ...progress,
      status: 'stopping',
      stopRequestedAt: activeBalanceRefresh.stopRequestedAt || Date.now()
    };
  }
  // Worker 重启或旧任务 ID 已失配时，内存中的物理任务已经不存在；
  // 明确标为可继续，避免界面长期显示一个实际不会再推进的“刷新中”。
  if (isActiveStatus && !activeMatches) {
    return saveBalanceRefreshProgress({
      ...progress,
      status: 'interrupted',
      currentSiteName: '',
      interruptedAt: Date.now()
    }, {
      expectedRunId: progress.runId || '',
      expectedStatuses: [progress.status]
    });
  }
  return progress;
}

function normalizeRefreshScope(options = {}) {
  const siteIds = [...new Set((Array.isArray(options.siteIds) ? options.siteIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean))].sort();
  if (options.scope === 'failed') return { kind: 'failed', siteIds };
  if (siteIds.length) return { kind: 'explicit', siteIds };
  return { kind: 'all', siteIds: [] };
}

function sameRefreshScope(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function refreshAllBalances(options = {}) {
  const requestedScope = normalizeRefreshScope(options);
  if (activeBalanceRefresh) {
    if (sameRefreshScope(requestedScope, activeBalanceRefresh.scope)) {
      return activeBalanceRefresh.promise;
    }
    return {
      ok: false,
      code: 'balance_refresh_busy',
      error: '另一项余额刷新正在进行，请等待完成后重试',
      activeScope: activeBalanceRefresh.scope,
      activeRunId: activeBalanceRefresh.runId
    };
  }
  const control = {
    runId: createBalanceRefreshRunId(),
    scope: requestedScope,
    stopRequested: false,
    stopRequestedAt: null,
    promise: null
  };
  activeBalanceRefresh = control;
  const operation = refreshAllBalancesInternal({
    ...options,
    scope: requestedScope,
    control
  });
  control.promise = operation;
  try {
    return await operation;
  } finally {
    if (activeBalanceRefresh === control) activeBalanceRefresh = null;
  }
}

async function stopBalanceRefresh(runId) {
  const requestedRunId = String(runId || '').trim();
  const active = activeBalanceRefresh;
  if (!active) {
    return {
      ok: true,
      accepted: false,
      code: 'balance_refresh_not_running',
      message: '当前没有正在进行的余额刷新',
      progress: await getBalanceRefreshProgress()
    };
  }
  if (!requestedRunId || requestedRunId !== active.runId) {
    return {
      ok: false,
      accepted: false,
      code: 'balance_refresh_run_mismatch',
      error: '余额刷新任务已变化，请重试停止操作',
      activeRunId: active.runId,
      progress: await getBalanceRefreshProgress()
    };
  }
  const alreadyRequested = active.stopRequested;
  active.stopRequested = true;
  active.stopRequestedAt ||= Date.now();
  const progress = await getBalanceRefreshProgress();
  if (activeBalanceRefresh !== active) {
    return {
      ok: true,
      accepted: false,
      code: 'balance_refresh_not_running',
      message: '余额刷新已经结束',
      progress: await getBalanceRefreshProgress()
    };
  }
  return {
    ok: true,
    accepted: true,
    alreadyRequested,
    runId: active.runId,
    progress: {
      ...progress,
      status: 'stopping',
      runId: active.runId,
      stopRequestedAt: active.stopRequestedAt
    }
  };
}

/** 仅重试 balanceStatus 为 failed 的站点（新批刷，不接上次中断队列） */
async function retryFailedBalances() {
  const allSites = await loadSites();
  const failedIds = allSites
    .filter((site) => site?.balanceStatus?.status === 'failed')
    .map((site) => String(site.id));
  if (!failedIds.length) {
    return {
      ok: true,
      results: [],
      sites: allSites,
      progress: await getBalanceRefreshProgress(),
      message: '没有余额失败的站点'
    };
  }
  const result = await refreshAllBalances({
    restart: true,
    siteIds: failedIds,
    scope: 'failed'
  });
  if (!result.ok) return result;
  return {
    ...result,
    message: `已重试 ${failedIds.length} 个余额失败站点`
  };
}

async function refreshAllBalancesInternal({
  restart = false,
  siteIds = null,
  scope = null,
  control = null
} = {}) {
  const run = control || {
    runId: createBalanceRefreshRunId(),
    stopRequested: false,
    stopRequestedAt: null
  };
  const allSites = await loadSites();
  const previous = await getBalanceRefreshProgress();
  const explicitIds = Array.isArray(siteIds)
    ? [...new Set(siteIds.map((id) => String(id || '').trim()).filter(Boolean))]
    : null;
  const canResume = restart !== true
    && !explicitIds
    && ['interrupted', 'stopped'].includes(previous.status)
    && Array.isArray(previous.pendingSiteIds)
    && previous.pendingSiteIds.length > 0;
  const sitesById = new Map(allSites.map((site) => [String(site.id), site]));
  const pendingIds = canResume
    ? previous.pendingSiteIds
    : (explicitIds || allSites.map((site) => String(site.id)));
  const sites = pendingIds.map((id) => sitesById.get(String(id))).filter(Boolean);
  const missingCount = pendingIds.length - sites.length;
  const effectiveScope = canResume && previous.scope
    ? previous.scope
    : (scope || normalizeRefreshScope({ siteIds }));
  const results = [];
  const initialCompleted = canResume
    ? Math.min(previous.total || pendingIds.length, (Number(previous.completed) || 0) + missingCount)
    : missingCount;
  const total = canResume
    ? Math.max(Number(previous.total) || 0, pendingIds.length)
    : (explicitIds ? pendingIds.length : allSites.length);
  let progress = await saveBalanceRefreshProgress({
    status: run.stopRequested ? 'stopping' : 'running',
    runId: run.runId,
    total,
    completed: initialCompleted,
    succeeded: canResume ? Number(previous.succeeded) || 0 : 0,
    failed: canResume ? Number(previous.failed) || 0 : 0,
    skipped: (canResume ? Number(previous.skipped) || 0 : 0) + missingCount,
    pendingSiteIds: sites.map((site) => String(site.id)),
    currentSiteName: sites[0]?.name || sites[0]?.domain || '',
    startedAt: canResume ? previous.startedAt || Date.now() : Date.now(),
    ...(run.stopRequestedAt ? { stopRequestedAt: run.stopRequestedAt } : {}),
    scope: effectiveScope
  });
  const progressWriteGuard = {
    expectedRunId: run.runId,
    expectedStatuses: ['running', 'stopping']
  };

  // 先刷已有权限的站，再处理未授权站。停止请求到达后不再继续预检，
  // 尚未扫描的站仍完整保留在 pending 队列中。
  const granted = [];
  const needAsk = [];
  for (let index = 0; index < sites.length; index += 1) {
    if (run.stopRequested) {
      needAsk.push(...sites.slice(index));
      break;
    }
    const site = sites[index];
    const access = await ensureAccessForSite(site, { request: false });
    if (access.ok) granted.push(site);
    else needAsk.push(site);
  }
  const orderedSites = [...granted, ...needAsk];
  progress = await saveBalanceRefreshProgress({
    ...progress,
    status: run.stopRequested ? 'stopping' : 'running',
    pendingSiteIds: orderedSites.map((site) => String(site.id)),
    currentSiteName: orderedSites[0]?.name || orderedSites[0]?.domain || '',
    ...(run.stopRequestedAt ? { stopRequestedAt: run.stopRequestedAt } : {})
  }, progressWriteGuard);

  let processedCount = 0;
  for (const [index, site] of orderedSites.entries()) {
    if (run.stopRequested) break;
    let ensured = null;
    let balanceResult = null;
    let latest = null;
    try {
      const access = await ensureAccessForSite(site, { request: false });
      if (!access.ok) {
        latest = {
          id: site.id,
          ok: false,
          skipped: true,
          code: access.code || 'site_permission_denied',
          error: access.error || '未获得站点访问权限'
        };
      } else {
        if (!site.type || site.type === 'auto') {
          const detection = await detectSite(site.pageUrl || site.baseUrl || site.domain, {
            hintName: site.name
          });
          if (detection.ok && detection.type && detection.type !== 'auto') {
            site.type = detection.type;
            if (detection.name && site.name === site.domain) site.name = detection.name;
          }
        }
        const session = await readPageAuthSession(site.domain, siteOrigin(site));
        // 不改写用户标签；没有同域页时才后台临时打开
        ensured = await ensureSiteTab(site, { preferPersonal: false });
        const tabId = ensured.tabId;
        balanceResult = await withTimeout(
          fetchSiteBalance(site, {
            pageToken: session.token,
            newApiUserId: session.userId,
            tabId,
            quotaPerUnit: site.quotaPerUnit,
            expectedOrigin: siteOrigin(site)
          }),
          SITE_BALANCE_TIMEOUT_MS
        );

        if (balanceResult.ok) {
          latest = {
            id: site.id,
            ok: true,
            balance: balanceResult.balance,
            usage: balanceResult.usage,
            via: balanceResult.via
          };
        } else {
          const classified = classifySiteBalanceError(balanceResult.error, balanceResult.code);
          latest = {
            id: site.id,
            ok: false,
            error: classified.message,
            code: classified.code,
            action: classified.action
          };
          balanceResult = { ...balanceResult, ...classified, ok: false };
        }
        try {
          await persistBalanceResult(site, balanceResult);
        } catch (persistError) {
          latest = {
            id: site.id,
            ok: false,
            code: 'balance_persist_failed',
            error: '余额结果保存失败'
          };
          console.warn('[公益站收藏] 余额结果落库失败', persistError);
        }
      }
    } catch (e) {
      const classified = classifySiteBalanceError(e?.message || e, e?.code || 'timeout');
      balanceResult = {
        ok: false,
        code: classified.code,
        error: classified.message,
        action: classified.action
      };
      latest = { id: site.id, ok: false, ...balanceResult };
      try {
        await persistBalanceResult(site, balanceResult);
      } catch (persistError) {
        console.warn('[公益站收藏] 余额结果落库失败', persistError);
      }
    } finally {
      if (ensured?.temporary && ensured.tabId) {
        await closeTabSafe(ensured.tabId);
      }
    }
    if (!latest) {
      latest = {
        id: site.id,
        ok: false,
        code: 'refresh_failed',
        error: '余额刷新未返回结果'
      };
    }
    results.push(latest);
    const row = latest;
    processedCount = index + 1;
    progress = await saveBalanceRefreshProgress({
      ...progress,
      status: run.stopRequested ? 'stopping' : 'running',
      completed: initialCompleted + results.length,
      succeeded: progress.succeeded + (row?.ok ? 1 : 0),
      failed: progress.failed + (row?.ok || row?.skipped ? 0 : 1),
      skipped: (Number(progress.skipped) || 0) + (row?.skipped ? 1 : 0),
      pendingSiteIds: orderedSites.slice(index + 1).map((item) => String(item.id)),
      currentSiteName: orderedSites[index + 1]?.name || orderedSites[index + 1]?.domain || '',
      ...(run.stopRequestedAt ? { stopRequestedAt: run.stopRequestedAt } : {})
    }, progressWriteGuard);
    if (run.stopRequested) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const remainingSites = orderedSites.slice(processedCount);
  if (run.stopRequested && remainingSites.length) {
    progress = await saveBalanceRefreshProgress({
      ...progress,
      status: 'stopped',
      completed: initialCompleted + results.length,
      pendingSiteIds: remainingSites.map((site) => String(site.id)),
      currentSiteName: '',
      stopRequestedAt: run.stopRequestedAt || Date.now(),
      stoppedAt: Date.now()
    }, progressWriteGuard);
    return {
      ok: true,
      stopped: true,
      code: 'balance_refresh_stopped',
      results,
      sites: await loadSites(),
      progress,
      scope: effectiveScope
    };
  }

  progress = await saveBalanceRefreshProgress({
    ...progress,
    status: 'completed',
    completed: total,
    pendingSiteIds: [],
    currentSiteName: '',
    finishedAt: Date.now()
  }, progressWriteGuard);
  return {
    ok: true,
    results,
    sites: await loadSites(),
    progress,
    scope: effectiveScope
  };
}

  root.scrapeBalanceWithRetry = scrapeBalanceWithRetry;
  root.refreshSiteBalance = refreshSiteBalance;
  root.getBalanceRefreshProgress = getBalanceRefreshProgress;
  root.refreshAllBalances = refreshAllBalances;
  root.stopBalanceRefresh = stopBalanceRefresh;
  root.retryFailedBalances = retryFailedBalances;
  root.refreshAllBalancesInternal = refreshAllBalancesInternal;
  root.normalizeRefreshScope = normalizeRefreshScope;
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
      stopBalanceRefresh,
      retryFailedBalances,
      SITE_BALANCE_TIMEOUT_MS,
      MAX_OWNED_TEMP_TABS
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
