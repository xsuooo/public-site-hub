/**
 * 余额单站/批量刷新编排（依赖 importScripts 已加载的 storage / tabs / balance / permissions）。
 * 通过 self 上的全局函数协作：loadSites、ensureAccessForSite、ensureSiteTab、fetchSiteBalance 等。
 */
(function (root) {
  let activeBalanceRefresh = null;
  // 单站与批量刷新共享同一份 in-flight Promise。这样同一站点不会同时发出
  // 两组余额请求，也不会让较早完成的结果覆盖较新的 attempt。
  const activeSiteBalanceRefreshes = new Map();

  function createBalanceRefreshRunId() {
    return `balance_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function createBalanceAttemptId(siteId) {
    return `balance_site_${String(siteId || '').slice(0, 40)}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function balanceSiteOrigin(site) {
    if (typeof root.siteIdentity === 'function') return root.siteIdentity(site) || '';
    if (typeof root.siteOriginForKeyImport === 'function') return root.siteOriginForKeyImport(site) || '';
    try {
      const raw = site && typeof site === 'object'
        ? (site.baseUrl || site.pageUrl || site.domain)
        : site;
      const url = new URL(/^https:\/\//i.test(String(raw || '')) ? raw : `https://${raw}`);
      return url.protocol === 'https:' ? url.origin.toLowerCase() : '';
    } catch (error) {
      return '';
    }
  }

  function balanceAttemptFailure(code, error, extra = {}) {
    return {
      ok: false,
      skipped: true,
      code: code || 'balance_attempt_stale',
      error: error || '站点在刷新期间已发生变化，已取消过期请求',
      ...extra
    };
  }

  async function claimBalanceAttempt(siteId) {
    const sites = await loadSites();
    const site = (Array.isArray(sites) ? sites : [])
      .find((item) => String(item?.id) === String(siteId));
    if (!site) return balanceAttemptFailure('site_not_found', '站点不存在');
    const expectedOrigin = balanceSiteOrigin(site);
    if (!expectedOrigin) return balanceAttemptFailure('site_domain_changed', '站点 Origin 无效，已取消余额刷新');
    const attemptId = createBalanceAttemptId(siteId);
    if (typeof root.beginBalanceRefreshAttempt === 'function') {
      const claimed = await root.beginBalanceRefreshAttempt(siteId, expectedOrigin, attemptId);
      if (!claimed?.ok) return claimed;
      return {
        ok: true,
        site: claimed.site || site,
        attempt: { ...claimed.attempt, attemptId, siteId: String(siteId), expectedOrigin, cancelled: false }
      };
    }
    // 兼容仅加载 balance-refresh.js 的旧测试/临时上下文；正式 Worker 会走持久化 CAS。
    return {
      ok: true,
      site,
      attempt: { siteId: String(siteId), expectedOrigin, attemptId, startedAt: Date.now(), cancelled: false }
    };
  }

  async function loadCurrentBalanceSite(attempt) {
    if (!attempt || attempt.cancelled) {
      return balanceAttemptFailure('balance_attempt_cancelled', '余额刷新已取消，未继续请求');
    }
    const sites = await loadSites();
    const site = (Array.isArray(sites) ? sites : [])
      .find((item) => String(item?.id) === String(attempt.siteId));
    if (!site) return balanceAttemptFailure('site_not_found', '站点已删除，已取消余额刷新');
    const currentOrigin = balanceSiteOrigin(site);
    if (!currentOrigin || currentOrigin !== attempt.expectedOrigin) {
      return balanceAttemptFailure(
        'site_domain_changed',
        '站点地址已修改，已取消过期的余额刷新'
      );
    }
    if (typeof root.isBalanceRefreshAttemptCurrent === 'function') {
      const current = await root.isBalanceRefreshAttemptCurrent(
        attempt.siteId,
        attempt.expectedOrigin,
        attempt.attemptId
      );
      if (!current) {
        return balanceAttemptFailure(
          'balance_attempt_stale',
          '余额刷新已被更新的任务替代，未写入旧结果'
        );
      }
    }
    return { ok: true, site };
  }

  async function finishBalanceAttempt(attempt) {
    if (!attempt || typeof root.finishBalanceRefreshAttempt !== 'function') return;
    try {
      await root.finishBalanceRefreshAttempt(attempt.siteId, attempt.attemptId);
    } catch (error) {
      console.warn('[公益站收藏] 清理余额刷新 attempt 失败', balanceLogErrorCode(error));
    }
  }

  function balanceOperationFailure(error) {
    const classified = classifySiteBalanceError(
      error?.message || error,
      error?.code || 'refresh_failed'
    );
    return {
      ok: false,
      code: classified.code,
      error: classified.message,
      action: classified.action
    };
  }

  function coordinateSiteBalanceRefresh(siteId, operation) {
    const key = String(siteId || '').trim();
    if (!key) return Promise.resolve(balanceAttemptFailure('site_not_found', '站点不存在'));
    const existing = activeSiteBalanceRefreshes.get(key);
    if (existing) return existing;

    const promise = (async () => {
      let claimed;
      try {
        claimed = await claimBalanceAttempt(key);
      } catch (error) {
        return balanceOperationFailure(error);
      }
      if (!claimed?.ok) return claimed;
      const attempt = claimed.attempt;
      try {
        return await operation(attempt, claimed.site);
      } catch (error) {
        return balanceOperationFailure(error);
      } finally {
        await finishBalanceAttempt(attempt);
      }
    })();
    activeSiteBalanceRefreshes.set(key, promise);
    promise.finally(() => {
      if (activeSiteBalanceRefreshes.get(key) === promise) activeSiteBalanceRefreshes.delete(key);
    }).catch(() => undefined);
    return promise;
  }

  function isBalanceAttemptAbort(result) {
    return ['site_not_found', 'site_domain_changed', 'balance_attempt_stale',
      'balance_attempt_cancelled', 'site_changed_during_refresh'].includes(result?.code);
  }

/** 余额读取：多轮重试（SPA 渲染慢） */
async function scrapeBalanceWithRetry(tabId, type, rounds = 4, options = {}) {
  const { beforeAttempt, ...requestOptions } = options || {};
  let last = { ok: false, error: 'no attempt' };
  for (let i = 0; i < rounds; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 900));
    if (typeof beforeAttempt === 'function') {
      const guard = await beforeAttempt(i);
      if (guard?.ok === false) return guard;
    }
    last = typeof scrapeTabBalanceAndKeys === 'function'
      ? await scrapeTabBalanceAndKeys(tabId, type, requestOptions)
      : await fetchSiteBalance({ type, quotaPerUnit: requestOptions.quotaPerUnit }, { tabId, ...requestOptions });
    if (last?.ok && (last.balance || last.usage)) return last;
  }
  return last;
}
const SITE_BALANCE_TIMEOUT_MS = 25000;
const MAX_OWNED_TEMP_TABS = 2;
// 临时页打开最长约 12s 加载 + 1.6s 稳定等待；超时竞态下延迟清理需覆盖该窗口。
const OWNED_TEMP_TAB_SWEEP_MS = 15000;

function balanceFailureMessage(error) {
  return String(error || '余额获取失败').replace(/\s+/g, ' ').trim().slice(0, 200) || '余额获取失败';
}

function balanceLogErrorCode(error) {
  const code = String(error?.code || error?.name || 'operation_failed')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 40);
  return code || 'operation_failed';
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
  // openTemporaryBalanceTab 在 tabs.create 成功后立刻登记到 owned，
  // 这样 withTimeout 触发后 finally 仍能关掉慢加载标签。
  return openTemporaryBalanceTab(site, urls, owned);
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
  return coordinateSiteBalanceRefresh(siteId, (attempt, claimedSite) =>
    refreshSiteBalanceInternal(attempt, claimedSite));
}

async function refreshSiteBalanceInternal(attempt, claimedSite = null) {
  let checked = await loadCurrentBalanceSite(attempt);
  if (!checked.ok) return checked;
  // claimedSite 只用于让协调器完成原子 claim；请求始终以 guard 重读的最新站点为准。
  void claimedSite;
  let site = checked.site;
  const access = await ensureAccessForSite(site, { request: false });
  if (!access.ok) return access;

  let detectionPatch = {};
  const refreshCurrentSite = async () => {
    const current = await loadCurrentBalanceSite(attempt);
    if (current.ok) {
      site = { ...current.site, ...detectionPatch };
    }
    return current;
  };

  if (!site.type || site.type === 'auto') {
    checked = await refreshCurrentSite();
    if (!checked.ok) return checked;
    const detection = await detectSite(site.pageUrl || site.baseUrl || site.domain, {
      hintName: site.name,
      expectedOrigin: attempt.expectedOrigin
    });
    if (detection.ok && detection.type && detection.type !== 'auto') {
      detectionPatch = {
        type: detection.type,
        ...(detection.name && site.name === site.domain ? { name: detection.name } : {}),
        ...(detection.pageUrl ? { pageUrl: detection.pageUrl } : {}),
        ...(detection.summary ? { detectSummary: detection.summary } : {}),
        ...(detection.confidence ? { detectConfidence: detection.confidence } : {})
      };
      site = { ...site, ...detectionPatch };
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

      const freshBeforeTab = await refreshCurrentSite();
      if (!freshBeforeTab.ok) return freshBeforeTab;
      // ownedTempTabs 在 tabs.create 成功瞬间登记，避免超时后标签泄漏。
      const ensured = await ensureSiteTab(site, {
        preferPersonal: false,
        ownedTempTabs
      });
      tabId = ensured.tabId;
      temporaryTab = ensured.temporary;

      if (!tabId) {
        return {
          ok: false,
          code: 'tab_open_failed',
          error: '无法打开站点标签。请先在浏览器登录该站，再点余额'
        };
      }

      await new Promise((r) => setTimeout(r, temporaryTab ? 1200 : 300));
      const freshBeforeSession = await refreshCurrentSite();
      if (!freshBeforeSession.ok) return freshBeforeSession;
      // 余额请求和会话必须来自同一标签页；同 Origin 多账号时不能回退到另一页。
      const session = await readPageAuthSession(site.domain, siteOrigin(site), tabId);
      const balOpts = { quotaPerUnit: site.quotaPerUnit, expectedOrigin: siteOrigin(site) };

      let balanceResult = await scrapeBalanceWithRetry(
        tabId,
        site.type || 'newapi',
        temporaryTab ? 5 : 3,
        {
          ...balOpts,
          beforeAttempt: refreshCurrentSite
        }
      );

      if (!balanceResult?.ok) {
        const freshBeforeFetch = await refreshCurrentSite();
        if (!freshBeforeFetch.ok) return freshBeforeFetch;
        balanceResult = await fetchSiteBalance(site, {
          pageToken: session.token,
          newApiUserId: session.userId || balanceResult?.userId,
          tabId,
          ...balOpts
        });
      }

      // 已有标签读不到时：另开临时页再试（仍不碰用户原标签）
      if (!balanceResult?.ok && !temporaryTab) {
        const freshBeforeTemp = await refreshCurrentSite();
        if (!freshBeforeTemp.ok) return freshBeforeTemp;
        const temp = await openOwnedTempTab(site, personalUrls(site), ownedTempTabs);
        if (temp.tabId) {
          await new Promise((r) => setTimeout(r, 1500));
          const freshBeforeRetry = await refreshCurrentSite();
          if (!freshBeforeRetry.ok) return freshBeforeRetry;
          const retry = await scrapeBalanceWithRetry(temp.tabId, site.type || 'newapi', 5, {
            ...balOpts,
            beforeAttempt: refreshCurrentSite
          });
          if (retry?.ok) balanceResult = retry;
          else {
            const freshBeforeAgain = await refreshCurrentSite();
            if (!freshBeforeAgain.ok) return freshBeforeAgain;
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
        const freshBeforeRetry = await refreshCurrentSite();
        if (!freshBeforeRetry.ok) return freshBeforeRetry;
        const retry = await scrapeBalanceWithRetry(tabId, site.type || 'newapi', 1, {
          ...balOpts,
          beforeAttempt: refreshCurrentSite
        });
        if (retry?.ok) balanceResult = retry;
      }

      return balanceResult || { ok: false, code: 'refresh_failed', error: '余额获取失败' };
    })(), SITE_BALANCE_TIMEOUT_MS);
  } catch (error) {
    if (error?.code === 'timeout') attempt.cancelled = true;
    const classified = classifySiteBalanceError(
      error?.message || error,
      error?.code || 'timeout'
    );
    result = { ok: false, code: classified.code, error: classified.message, action: classified.action };
  } finally {
    await closeOwnedTempTabs(ownedTempTabs);
    // 超时竞态兜底：create→wait 可能跨过 hard timeout，延迟再清一次。
    setTimeout(() => { void closeOwnedTempTabs(ownedTempTabs); }, OWNED_TEMP_TAB_SWEEP_MS);
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
    if (isBalanceAttemptAbort(result)) return result;
    try {
      site = await persistBalanceResult(site, result, { attemptId: attempt.attemptId });
    } catch (persistError) {
      console.warn('[公益站收藏] 余额结果落库失败', balanceLogErrorCode(persistError));
      return { ok: false, code: 'balance_persist_failed', error: '余额结果保存失败' };
    }
    if (!site) {
      return balanceAttemptFailure(
        'site_changed_during_refresh',
        '站点在刷新期间已删除或修改，未写入过期余额结果'
      );
    }
    return {
      ok: false,
      code: result.code,
      error: result.error,
      action: result.action,
      site,
      // 仅保留受控诊断字段；页面 href 可能带 query/hash 或临时令牌，不能回传到 UI。
      debug: {
        hasUser: result.hasUser === true,
        via: /^[a-z0-9_-]{1,40}$/i.test(String(result.via || '')) ? String(result.via) : ''
      }
    };
  }

  // 不要把 pageUrl 改成临时个人中心，避免「打开」进 404
  if (isBalanceAttemptAbort(result)) return result;
  try {
    site = await persistBalanceResult(site, result, { attemptId: attempt.attemptId });
  } catch (persistError) {
    console.warn('[公益站收藏] 余额结果落库失败', balanceLogErrorCode(persistError));
    return { ok: false, code: 'balance_persist_failed', error: '余额结果保存失败' };
  }
  if (!site) {
    return balanceAttemptFailure(
      'site_changed_during_refresh',
      '站点在刷新期间已删除或修改，未写入过期余额结果'
    );
  }
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

// 批量刷新使用较轻的 fetch 路径，但仍复用单站的 siteId 协调器与 attempt
// 校验。单站刷新先开始时，批量会直接等待同一 Promise，反之亦然。
async function refreshBatchSiteBalanceInternal(attempt, claimedSite = null) {
  void claimedSite;
  let checked = await loadCurrentBalanceSite(attempt);
  if (!checked.ok) return { id: attempt.siteId, ...checked };
  let site = checked.site;
  let detectionPatch = {};
  let balanceResult = null;
  const refreshCurrentSite = async () => {
    const current = await loadCurrentBalanceSite(attempt);
    if (current.ok) site = { ...current.site, ...detectionPatch };
    return current;
  };

  try {
    const access = await ensureAccessForSite(site, { request: false });
    if (!access.ok) {
      return {
        id: attempt.siteId,
        ok: false,
        skipped: true,
        code: access.code || 'site_permission_denied',
        error: access.error || '未获得站点访问权限'
      };
    }
    if (!site.type || site.type === 'auto') {
      checked = await refreshCurrentSite();
      if (!checked.ok) return { id: attempt.siteId, ...checked };
      const detection = await detectSite(site.pageUrl || site.baseUrl || site.domain, {
        hintName: site.name,
        expectedOrigin: attempt.expectedOrigin
      });
      if (detection.ok && detection.type && detection.type !== 'auto') {
        detectionPatch = {
          type: detection.type,
          ...(detection.name && site.name === site.domain ? { name: detection.name } : {}),
          ...(detection.summary ? { detectSummary: detection.summary } : {}),
          ...(detection.confidence ? { detectConfidence: detection.confidence } : {})
        };
        site = { ...site, ...detectionPatch };
      }
    }

    checked = await refreshCurrentSite();
    if (!checked.ok) return { id: attempt.siteId, ...checked };
    const initialSession = await readPageAuthSession(site.domain, siteOrigin(site));
    checked = await refreshCurrentSite();
    if (!checked.ok) return { id: attempt.siteId, ...checked };
    // 批量路径也立刻登记临时标签，避免 withTimeout 与 tabs.create 竞态泄漏。
    const batchOwnedTempTabs = [];
    try {
      const ensured = await ensureSiteTab(site, {
        preferPersonal: false,
        ownedTempTabs: batchOwnedTempTabs
      });
      const tabId = ensured?.tabId;
      const session = tabId
        ? await readPageAuthSession(site.domain, siteOrigin(site), tabId)
        : initialSession;
      // 批量路径保留旧兼容行为：fetchSiteBalance 可在没有标签 ID 时使用
      // page/session 或测试夹具完成请求；不要把“无标签”提前变成失败。
      checked = await refreshCurrentSite();
      if (!checked.ok) return { id: attempt.siteId, ...checked };
      balanceResult = await withTimeout(
        fetchSiteBalance(site, {
          pageToken: session?.token,
          newApiUserId: session?.userId,
          tabId,
          quotaPerUnit: site.quotaPerUnit,
          expectedOrigin: attempt.expectedOrigin
        }),
        SITE_BALANCE_TIMEOUT_MS
      );

      if (!balanceResult?.ok) {
        const classified = classifySiteBalanceError(balanceResult?.error, balanceResult?.code);
        balanceResult = { ...balanceResult, ...classified, ok: false };
      }
      if (isBalanceAttemptAbort(balanceResult)) {
        return { id: attempt.siteId, ...balanceResult };
      }
      let persisted;
      try {
        persisted = await persistBalanceResult(site, balanceResult, { attemptId: attempt.attemptId });
      } catch (persistError) {
        console.warn('[公益站收藏] 余额结果落库失败', balanceLogErrorCode(persistError));
        return {
          id: attempt.siteId,
          ok: false,
          code: 'balance_persist_failed',
          error: '余额结果保存失败'
        };
      }
      if (!persisted) {
        return {
          id: attempt.siteId,
          ...balanceAttemptFailure(
            'site_changed_during_refresh',
            '站点在刷新期间已删除或修改，未写入过期余额结果'
          )
        };
      }
      return {
        id: attempt.siteId,
        ok: !!balanceResult.ok,
        ...(balanceResult.ok ? {
          balance: balanceResult.balance,
          usage: balanceResult.usage,
          via: balanceResult.via
        } : {
          code: balanceResult.code,
          error: balanceResult.error,
          action: balanceResult.action
        }),
        site: persisted
      };
    } finally {
      await closeOwnedTempTabs(batchOwnedTempTabs);
      setTimeout(() => { void closeOwnedTempTabs(batchOwnedTempTabs); }, OWNED_TEMP_TAB_SWEEP_MS);
    }
  } catch (error) {
    if (error?.code === 'timeout') attempt.cancelled = true;
    const classified = classifySiteBalanceError(error?.message || error, error?.code || 'timeout');
    if (isBalanceAttemptAbort(classified)) return { id: attempt.siteId, ...classified };
    const failed = { ok: false, ...classified };
    try {
      const persisted = await persistBalanceResult(site, failed, { attemptId: attempt.attemptId });
      if (!persisted) {
        return {
          id: attempt.siteId,
          ...balanceAttemptFailure(
            'site_changed_during_refresh',
            '站点在刷新期间已删除或修改，未写入过期余额结果'
          )
        };
      }
      return { id: attempt.siteId, ...failed, site: persisted };
    } catch (persistError) {
      console.warn('[公益站收藏] 余额结果落库失败', balanceLogErrorCode(persistError));
      return {
        id: attempt.siteId,
        ok: false,
        code: 'balance_persist_failed',
        error: '余额结果保存失败'
      };
    }
  }
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
    const coordinated = await coordinateSiteBalanceRefresh(
      site.id,
      (attempt, claimedSite) => refreshBatchSiteBalanceInternal(attempt, claimedSite)
    );
    let latest = coordinated ? { ...coordinated, id: site.id } : null;
    if (latest && !latest.ok && ['site_permission_required', 'site_permission_denied', 'permission_denied']
      .includes(latest.code)) {
      latest.skipped = true;
    }
    if (!latest) {
      // 协调器理论上总会返回结果；保留兜底以维持进度计数契约。
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
  root.refreshSiteBalanceInternal = refreshSiteBalanceInternal;
  root.coordinateSiteBalanceRefresh = coordinateSiteBalanceRefresh;
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
      refreshSiteBalanceInternal,
      coordinateSiteBalanceRefresh,
      getBalanceRefreshProgress,
      refreshAllBalances,
      stopBalanceRefresh,
      retryFailedBalances,
      SITE_BALANCE_TIMEOUT_MS,
      MAX_OWNED_TEMP_TABS
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
