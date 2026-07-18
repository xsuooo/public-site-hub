/* global loadSites, saveSites, upsertSite, updateSiteById, removeSiteById, removeSitesByIds,
   addKeyToSite, removeKeyFromSite, setDefaultKey, importSites, replaceSitesWithBackup, siteFromTab, normalizeSite,
   fetchSiteBalance, buildExportConfig, buildCheckinExportConfig, parseImportText,
   detectSite, applyDetectionToSite,
    formatApiBaseV1, siteIdentity, originForSite, loadPrefs, savePrefs, openUrlForSite, tokenPageUrlForSite,
   scrapeTabBalanceAndKeys, verifyNewApiTabAccount, createTabApiKey, createKeyProvisionService, isSuspiciousBalance,
   normalizeKey, ensureDefaultKeys, cleanTokenName, isCompleteApiKey, createSiteBackup,
   getLatestSiteBackup, listSiteBackups, deleteSiteBackup, clearSiteBackups, restoreSiteBackup,
   loadBalanceRefreshProgress, saveBalanceRefreshProgress,
   mutateSites, migrateSiteData, classifyBalanceError, loadSiteDataMeta,
    ensureSiteAccess, ensureAccessForSite, countUnauthorizedSites, requestSiteAccessFromGesture,
   normalizedSiteDomain, permissionOriginForDomain, originFromDomain,
   waitTabComplete, personalUrls, isBalanceFriendlyPath, findTabForDomain,
   openTemporaryBalanceTab, ensureSiteTab, closeTabSafe, openFailedBalanceSites,
   refreshSiteBalance, refreshAllBalances, stopBalanceRefresh, retryFailedBalances, getBalanceRefreshProgress,
   scrapeBalanceWithRetry, tryAutoImportKeys, mergeScrapedKeys, ensureSiteKey */

importScripts(
  'site-utils.js',
  'permissions.js',
  'site-tabs.js',
  'balance-format.js',
  'page-scrape.js',
  'tab-api-key.js',
  'balance.js',
  'import-export.js',
  'storage.js',
  'detect.js',
  'balance-refresh.js',
  'key-provision.js',
  'key-import.js'
);

const CONTEXT_MENU_ID = 'public-site-hub-add';
const DIAGNOSTIC_BALANCE_ERROR_CODES = new Set([
  'permission_denied',
  'timeout',
  'invalid_domain',
  'tab_open_failed',
  'wrong_type',
  'not_logged_in',
  'parse_failed',
  'network_error',
  'refresh_failed',
  'balance_persist_failed',
  'unknown'
]);
let importQueue = Promise.resolve();
let contextMenuSetupInFlight = false;

function enqueueImport(task) {
  const operation = importQueue.then(task);
  importQueue = operation.catch(() => undefined);
  return operation;
}

function ensureContextMenu() {
  if (!chrome.contextMenus?.create || !chrome.contextMenus?.removeAll) return;
  if (contextMenuSetupInFlight) return;
  contextMenuSetupInFlight = true;
  const finish = () => { contextMenuSetupInFlight = false; };
  try {
    chrome.contextMenus.removeAll(() => {
      // 回调里读取 lastError，避免浏览器把一次旧菜单清理失败显示为未处理错误。
      if (chrome.runtime?.lastError) {
        finish();
        return;
      }
      try {
        chrome.contextMenus.create({
          id: CONTEXT_MENU_ID,
          title: '添加到公益站收藏',
          contexts: ['page', 'link', 'selection']
        }, () => {
          // create 的失败也必须在回调内消费；下一次生命周期事件可以再尝试注册。
          void chrome.runtime?.lastError;
          finish();
        });
      } catch (e) {
        finish();
      }
    });
  } catch (e) {
    finish();
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  ensureContextMenu();
});

// SW 冷启动时也注册一次
ensureContextMenu();
if (typeof migrateSiteData === 'function') {
  void migrateSiteData().catch((error) => {
    console.warn('[公益站收藏] 本地数据迁移失败', error);
  });
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

// 权限相关实现见 permissions.js；标签页生命周期见 site-tabs.js（importScripts 挂到 self）
function sameSiteDomain(a, b) {
  const left = typeof siteIdentity === 'function' ? siteIdentity(a) : siteOrigin(a);
  const right = typeof siteIdentity === 'function' ? siteIdentity(b) : siteOrigin(b);
  return Boolean(left && right && left === right);
}

function siteOrigin(site) {
  if (typeof originForSite === 'function') return originForSite(site);
  const domain = typeof normalizedSiteDomain === 'function'
    ? normalizedSiteDomain(site?.domain || site?.baseUrl || site?.pageUrl)
    : String(site?.domain || '').toLowerCase();
  if (!domain) return '';
  try {
    const url = new URL(site?.baseUrl || site?.pageUrl || `https://${domain}`);
    if (url.protocol === 'https:' && url.hostname.toLowerCase() === domain) {
      return url.origin.toLowerCase();
    }
  } catch (e) {}
  return `https://${domain}`;
}

/** 从站点页读取 token + NewAPI user id */
async function readPageAuthSession(domain, expectedOrigin = '', preferredTabId = null) {
  const empty = { token: null, userId: null, tabId: null };
  if (!domain || !chrome.scripting?.executeScript) return empty;
  const canonicalOrigin = typeof originFromDomain === 'function'
    ? originFromDomain(expectedOrigin)
    : '';
  if (!canonicalOrigin) return empty;
  try {
    const match = await findTabForDomain(domain, {
      tabId: preferredTabId,
      expectedOrigin: canonicalOrigin,
      preferActive: true
    });
    if (!match?.id) return empty;

    const results = await chrome.scripting.executeScript({
      target: { tabId: match.id },
      args: [canonicalOrigin],
      func: (expectedSite) => {
        function expectedOriginForSite(value) {
          const raw = String(value || '').trim();
          if (!raw) return '';
          try {
            const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
            return url.protocol === 'https:' ? url.origin.toLowerCase() : '';
          } catch (error) {
            return '';
          }
        }
        const requiredOrigin = expectedOriginForSite(expectedSite);
        if (requiredOrigin && String(location.origin || '').toLowerCase() !== requiredOrigin) {
          return { domainChanged: true };
        }
        function pickUserId(raw) {
          if (!raw) return null;
          let o = raw;
          if (typeof raw === 'string') {
            try { o = JSON.parse(raw); } catch (e) { return null; }
          }
          return o?.id || o?.user_id || o?.data?.id || o?.data?.user_id || null;
        }
        const keys = [
          'token', 'access_token', 'auth_token', 'user_token',
          'session', 'jwt', 'Authorization'
        ];
        let token = null;
        for (const k of keys) {
          const v = localStorage.getItem(k) || sessionStorage.getItem(k);
          if (v && String(v).trim().length > 8) {
            token = String(v).trim();
            break;
          }
        }
        const rawUser = localStorage.getItem('user') || sessionStorage.getItem('user')
          || localStorage.getItem('User') || sessionStorage.getItem('User');
        const userId = pickUserId(rawUser);
        if (!token && rawUser) {
          try {
            const o = JSON.parse(rawUser);
            token = o?.token || o?.access_token || o?.key || null;
          } catch (e) {}
        }
        return { token: token ? String(token) : null, userId: userId != null ? String(userId) : null };
      }
    });
    const r = results?.[0]?.result || {};
    if (r.domainChanged) return empty;
    return { token: r.token || null, userId: r.userId || null, tabId: match.id };
  } catch (e) {
    return empty;
  }
}

async function resolveSaveCategory(explicit) {
  if (explicit) {
    return typeof normalizeCategory === 'function'
      ? normalizeCategory(explicit)
      : (explicit === 'relay' ? 'relay' : 'gongyi');
  }
  try {
    const prefs = await loadPrefs();
    return prefs.defaultCategory || 'gongyi';
  } catch (e) {
    return 'gongyi';
  }
}

async function maybeAutoSyncSite(site) {
  // 签到扩展已改为独立识别和添加；保留旧数据字段仅用于兼容已有本地存储，
  // 收藏、编辑和刷新不再触发任何跨扩展操作。
  void site;
  return null;
}

async function saveCurrentTab({ detect = true, category } = {}) {
  const tab = await getActiveTab();
  if (!tab) return { ok: false, error: '没有活动标签页' };
  let partial = siteFromTab(tab);
  if (!partial) return { ok: false, error: '当前页不是可收藏的 https 站点' };
  const access = await ensureAccessForSite(partial, { request: false });
  if (!access.ok) return access;

  partial.category = await resolveSaveCategory(category);

  let detection = null;
  if (detect) {
    detection = await detectSite(partial.pageUrl || partial.domain, {
      tabId: tab.id,
      expectedOrigin: partial.baseUrl,
      hintName: partial.name
    });
    if (detection.ok) partial = applyDetectionToSite(partial, detection);
  }

  if (detection?.ok) {
    partial.detectSummary = detection.summary || '';
    partial.detectConfidence = detection.confidence || '';
    partial.detectedType = detection.detectedType || detection.type || '';
  }
  // applyDetection 可能冲掉 category，再写回
  partial.category = await resolveSaveCategory(category || partial.category);

  if (detection?.quotaPerUnit) partial.quotaPerUnit = detection.quotaPerUnit;
  if (detection?.displayInCurrency) partial.displayInCurrency = true;

  const sites = await upsertSite(partial);
  let site = sites.find((item) => sameSiteDomain(item, partial));

  // 已登录同域标签：自动尝试导入完整 sk-
  let keyImport = null;
  try {
    keyImport = await tryAutoImportKeys(site, tab.id);
    if (keyImport?.site) site = keyImport.site;
  } catch (e) {
    keyImport = { added: 0, error: String(e?.message || e) };
  }

  const checkin = await maybeAutoSyncSite(site);
  if (checkin && site) {
    site = (await loadSites()).find((s) => s.id === site.id) || site;
  }

  return { ok: true, site, detection, count: sites.length, checkin, keyImport };
}

async function detectAndSave(input, extra = {}) {
  const incomingKeys = [
    ...(extra.key ? [{ key: extra.key }] : []),
    ...(Array.isArray(extra.keys) ? extra.keys : [])
  ];
  if (incomingKeys.some((entry) => typeof isCompleteApiKey === 'function'
    ? !isCompleteApiKey(entry?.key || entry?.token || entry?.value)
    : false)) {
    return { ok: false, code: 'invalid_key', error: '请提供完整、未脱敏的 API Key' };
  }
  const access = await ensureSiteAccess(input, { request: false });
  if (!access.ok) return access;
  // 没传 tabId 时，主动找该域已打开的标签页（用页面会话更准）
  let tabId = extra.tabId;
  if (!tabId) {
    const domain = typeof normalizeDomain === 'function'
      ? normalizeDomain(input)
      : String(input || '').trim().toLowerCase();
    if (domain) {
      const tab = await findTabForDomain(domain, {
        expectedOrigin: typeof originFromDomain === 'function' ? originFromDomain(input) : ''
      });
      tabId = tab?.id || null;
    }
  }

  const detection = await detectSite(input, {
    tabId,
    expectedOrigin: typeof originFromDomain === 'function'
      ? originFromDomain(input)
      : undefined,
    hintName: extra.name || extra.hintName
  });
  if (!detection.ok) return detection;

  const category = await resolveSaveCategory(extra.category);

  const partial = {
    domain: detection.domain,
    name: extra.name || detection.name,
    baseUrl: detection.baseUrl,
    pageUrl: detection.pageUrl,
    type: detection.type,
    category,
    note: extra.note || '',
    tags: extra.tags || [],
    keys: extra.key ? [{ name: '默认', key: extra.key }] : (extra.keys || []),
    detectSummary: detection.summary || '',
    detectConfidence: detection.confidence || '',
    detectedType: detection.detectedType || detection.type || '',
    quotaPerUnit: detection.quotaPerUnit || undefined,
    displayInCurrency: detection.displayInCurrency || undefined
  };
  const preview = normalizeSite(partial);
  if (!preview) return { ok: false, error: '识别结果无效' };

  const sites = await upsertSite(partial);
  let site = sites.find((item) => sameSiteDomain(item, preview));

  let keyImport = null;
  try {
    keyImport = await tryAutoImportKeys(site);
    if (keyImport?.site) site = keyImport.site;
  } catch (e) {
    keyImport = { added: 0, error: String(e?.message || e) };
  }

  const checkin = await maybeAutoSyncSite(site);
  const latestSites = await loadSites();
  if (site) site = latestSites.find((s) => s.id === site.id) || site;

  return {
    ok: true,
    site,
    detection,
    sites: latestSites,
    count: latestSites.length,
    keyImport,
    checkin
  };
}

function parseBatchLines(text) {
  return String(text || '')
    .split(/[\r\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    // 去重保序
    .filter((line, i, arr) => arr.indexOf(line) === i);
}

async function batchDetectAndSave(text, options = {}) {
  const lines = parseBatchLines(text);
  if (!lines.length) return { ok: false, error: '请粘贴至少一个 URL 或域名' };

  const category = await resolveSaveCategory(options.category);
  const results = [];
  let okCount = 0;
  for (const line of lines) {
    try {
      const res = await detectAndSave(line, {
        note: options.note || '',
        key: options.key || undefined,
        tags: options.tags || [],
        category
      });
      if (res.ok) okCount += 1;
      results.push({
        input: line,
        ok: !!res.ok,
        domain: res.site?.domain || res.domain,
        name: res.site?.name,
        type: res.site?.type || res.type,
        summary: res.detection?.summary || res.error || '',
        error: res.ok ? null : (res.error || '失败')
      });
    } catch (e) {
      results.push({ input: line, ok: false, error: String(e?.message || e) });
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    ok: true,
    total: lines.length,
    okCount,
    failCount: lines.length - okCount,
    results,
    sites: await loadSites()
  };
}

async function redetectSite(siteId) {
  const sites = await loadSites();
  const site = sites.find((s) => s.id === siteId);
  if (!site) return { ok: false, error: '站点不存在' };

  const access = await ensureAccessForSite(site, { request: false });
  if (!access.ok) return access;

  // 若该站已在标签页打开，注入探测更准；必须绑定保存的 Origin。
  const hit = await findTabForDomain(site.domain, {
    expectedOrigin: siteOrigin(site),
    preferActive: true
  });
  const tabId = hit?.id;

  const detection = await detectSite(site.pageUrl || site.baseUrl || site.domain, {
    hintName: site.name,
    tabId,
    expectedOrigin: siteOrigin(site)
  });
  if (!detection.ok) return detection;

  const patch = applyDetectionToSite(site, detection);
  const next = await updateSiteById(siteId, {
    name: patch.name,
    type: patch.type,
    baseUrl: patch.baseUrl,
    pageUrl: patch.pageUrl,
    detectSummary: detection.summary || '',
    detectConfidence: detection.confidence || '',
    detectedType: detection.detectedType || detection.type || ''
  }, { expectedIdentity: siteIdentity(site) });
  return { ok: true, site: next.find((s) => s.id === siteId), detection, sites: next };
}



if (chrome.contextMenus?.onClicked) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    const raw = info.linkUrl
      || (info.selectionText && String(info.selectionText).trim())
      || info.pageUrl
      || tab?.url
      || '';
    if (!raw || (!/^https:\/\//i.test(raw) && !raw.includes('.'))) {
      console.warn('[公益站收藏] 右键添加：无效地址', raw);
      return;
    }
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/\s+/g, '')}`;
    const targetOrigin = typeof originFromDomain === 'function' ? originFromDomain(url) : '';
    const sourceOrigin = typeof originFromDomain === 'function' ? originFromDomain(tab?.url) : '';
    const targetTabId = targetOrigin && targetOrigin === sourceOrigin ? tab?.id : undefined;
    // contextMenus.onClicked 是用户手势入口；必须在任何 await 前发起可选权限请求。
    const accessRequest = requestSiteAccessFromGesture(url);
    (async () => {
      const access = await accessRequest;
      if (!access.ok) {
        console.warn('[公益站收藏] 右键添加：未获得站点访问权限', access.error);
        return;
      }
      const res = await detectAndSave(url, {
        name: tab?.title,
        tabId: targetTabId,
        hintName: tab?.title
        // category 走默认偏好（设置里「添加分类」）
      });
      if (res.ok) {
        console.log('[公益站收藏] 已添加', res.site?.domain, res.detection?.summary);
      } else {
        console.warn('[公益站收藏] 添加失败', res.error);
      }
    })().catch((e) => console.warn('[公益站收藏] 右键添加异常', e));
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message?.type;
  (async () => {
    switch (type) {
      case 'listSites':
        return { ok: true, sites: await loadSites() };
      case 'getPrefs':
        return { ok: true, prefs: await loadPrefs() };
      case 'savePrefs':
        return { ok: true, prefs: await savePrefs(message.prefs || message.patch || {}) };
      case 'saveCurrentTab':
        return saveCurrentTab({
          detect: message.detect !== false,
          category: message.category
        });
      case 'detectSite': {
        const access = await ensureSiteAccess(message.input || message.url, { request: false });
        if (!access.ok) return access;
        return detectSite(message.input || message.url, {
          tabId: message.tabId,
          hintName: message.hintName
        });
      }
      case 'detectAndSave':
        return detectAndSave(message.input || message.url, {
          name: message.name,
          note: message.note,
          tags: message.tags,
          key: message.key,
          keys: message.keys,
          tabId: message.tabId,
          category: message.category
        });
      case 'batchDetectAndSave':
        return batchDetectAndSave(message.text || message.input, {
          note: message.note,
          tags: message.tags,
          key: message.key,
          category: message.category
        });
      case 'redetectSite':
        return redetectSite(message.id);
      case 'upsertSite': {
        const incoming = message.site || {};
        const entries = [
          ...(Array.isArray(incoming.keys) ? incoming.keys : []),
          ...(incoming.apiKey ? [{ key: incoming.apiKey }] : []),
          ...(incoming.key ? [{ key: incoming.key }] : [])
        ];
        if (entries.some((entry) => typeof isCompleteApiKey === 'function'
          ? !isCompleteApiKey(entry?.key || entry?.token || entry?.value)
          : false)) {
          return { ok: false, code: 'invalid_key', error: '请提供完整、未脱敏的 API Key' };
        }
        const sites = await upsertSite(incoming);
        const input = message.site || {};
        const identity = typeof siteIdentity === 'function' ? siteIdentity(input) : '';
        const site = sites.find((s) => input.id && s.id === input.id)
          || sites.find((item) => identity && siteIdentity(item) === identity)
          || sites[sites.length - 1]
          || null;
        const checkin = await maybeAutoSyncSite(site);
        const responseSites = checkin ? await loadSites() : sites;
        return {
          ok: true,
          sites: responseSites,
          site: site ? responseSites.find((s) => s.id === site.id) || site : null,
          checkin
        };
      }
      case 'updateSite': {
        const sites = await updateSiteById(message.id, message.patch || {});
        const site = sites.find((s) => s.id === message.id) || null;
        const checkin = await maybeAutoSyncSite(site);
        const responseSites = checkin ? await loadSites() : sites;
        return {
          ok: true,
          sites: responseSites,
          site: site ? responseSites.find((s) => s.id === site.id) || site : null,
          checkin
        };
      }
      case 'removeSite':
        return { ok: true, sites: await removeSiteById(message.id) };
      case 'removeSites': {
        const ids = Array.isArray(message.ids) ? message.ids : [];
        const before = await loadSites();
        const sites = await removeSitesByIds(ids);
        return { ok: true, sites, removed: Math.max(0, before.length - sites.length) };
      }
      case 'addKey':
        return { ok: true, sites: await addKeyToSite(message.siteId, message.key) };
      case 'removeKey':
        return { ok: true, sites: await removeKeyFromSite(message.siteId, message.keyId) };
      case 'setDefaultKey':
        return { ok: true, sites: await setDefaultKey(message.siteId, message.keyId) };
      case 'refreshBalance':
        return refreshSiteBalance(message.id);
      case 'refreshAllBalances':
        return refreshAllBalances({
          restart: message.restart === true,
          siteIds: Array.isArray(message.siteIds) ? message.siteIds : null
        });
      case 'stopBalanceRefresh':
        return stopBalanceRefresh(message.runId);
      case 'retryFailedBalances':
        return retryFailedBalances();
      case 'openFailedBalanceSites': {
        const sites = await loadSites();
        if (typeof openFailedBalanceSites !== 'function') {
          return { ok: false, error: '打开失败站功能不可用' };
        }
        return openFailedBalanceSites(sites, {
          limit: Math.max(1, Math.min(20, Number(message.limit) || 5)),
          reason: message.reason || 'all'
        });
      }
      case 'getBalanceRefreshProgress':
        return {
          ok: true,
          progress: await getBalanceRefreshProgress()
        };
      case 'export': {
        const format = message.format;
        if (format !== 'native' && format !== 'checkin') {
          return {
            ok: false,
            code: 'unsupported_export_format',
            error: '不支持的导出格式'
          };
        }
        const sites = await loadSites();
        const redactKeys = message.redactKeys === true;
        const config = format === 'checkin'
          ? buildCheckinExportConfig(sites)
          : buildExportConfig(sites, { redactKeys });
        return { ok: true, config, format, redacted: redactKeys };
      }
      case 'requestUnauthorizedSiteAccess':
        return {
          ok: false,
          code: 'foreground_permission_required',
          error: '站点权限必须在 Popup 或设置页的用户点击中申请'
        };
      case 'getDiagnostics': {
        const sites = await loadSites();
        const prefs = await loadPrefs();
        const progress = await getBalanceRefreshProgress();
        const meta = typeof loadSiteDataMeta === 'function'
          ? await loadSiteDataMeta()
          : { schemaVersion: 0 };
        const accessStats = await countUnauthorizedSites(sites);
        let completeKeys = 0;
        let maskedKeys = 0;
        let failedBalance = 0;
        const balanceErrorCounts = new Map();
        for (const site of sites) {
          if (site?.balanceStatus?.status === 'failed') {
            failedBalance += 1;
            const rawCode = String(site.balanceStatus?.lastError?.code || 'unknown').toLowerCase();
            const code = DIAGNOSTIC_BALANCE_ERROR_CODES.has(rawCode) ? rawCode : 'unknown';
            balanceErrorCounts.set(code, (balanceErrorCounts.get(code) || 0) + 1);
          }
          for (const key of site?.keys || []) {
            if (typeof isCompleteApiKey === 'function' ? isCompleteApiKey(key?.key) : String(key?.key || '').length > 12) {
              completeKeys += 1;
            } else if (key?.key) {
              maskedKeys += 1;
            }
          }
        }
        let extensionVersion = '';
        let manifestVersion = '';
        try {
          const manifest = chrome.runtime?.getManifest?.() || {};
          extensionVersion = manifest.version_name || manifest.version || '';
          manifestVersion = manifest.version || '';
        } catch (error) {
          extensionVersion = '';
        }
        return {
          ok: true,
          diagnostics: {
            extensionVersion,
            manifestVersion,
            schemaVersion: meta.schemaVersion ?? 0,
            migratedAt: meta.migratedAt || null,
            siteCount: sites.length,
            completeKeyCount: completeKeys,
            maskedKeyCount: maskedKeys,
            failedBalanceCount: failedBalance,
            authorizedSiteCount: accessStats.authorizedCount,
            unauthorizedSiteCount: accessStats.unauthorizedCount,
            unknownPermissionSiteCount: accessStats.unknownCount || 0,
            permissionCheckUnsupported: accessStats.unsupported === true,
            preferUnlimitedAutoKey: prefs.preferUnlimitedAutoKey === true,
            defaultCategory: prefs.defaultCategory || 'gongyi',
            balanceRefresh: {
              status: progress.status || 'idle',
              total: Number(progress.total) || 0,
              completed: Number(progress.completed) || 0,
              succeeded: Number(progress.succeeded) || 0,
              failed: Number(progress.failed) || 0,
              skipped: Number(progress.skipped) || 0,
              pending: Array.isArray(progress.pendingSiteIds) ? progress.pendingSiteIds.length : 0
            },
            balanceErrorCodes: [...balanceErrorCounts.entries()]
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([code, count]) => ({ code, count }))
          }
        };
      }
      case 'import': {
        return enqueueImport(async () => {
          const parsed = typeof message.text === 'string'
            ? parseImportText(message.text)
            : parseImportText(JSON.stringify(message.config || {}));
          if (!parsed.format || !parsed.sites?.length) {
            return {
              ok: false,
              code: 'empty_import',
              error: `导入内容中没有可用站点${parsed.skipped ? `（已跳过 ${parsed.skipped} 条）` : ''}，已取消以保护现有数据`,
              skipped: Number(parsed.skipped) || 0
            };
          }
          const mode = message.mode === 'replace' ? 'replace' : 'merge';
          const importedIdentities = new Set(parsed.sites.map((site) => siteIdentity(site)).filter(Boolean));
          const imported = importedIdentities.size;
          const duplicates = Math.max(0, parsed.sites.length - imported);
          if (mode === 'replace') {
            if (typeof replaceSitesWithBackup !== 'function') {
              return {
                ok: false,
                code: 'replace_import_unavailable',
                error: '替换导入当前不可用，现有数据未修改'
              };
            }
            const replaced = await replaceSitesWithBackup(
              parsed.sites,
              'before-replace-import'
            );
            return {
              ok: true,
              sites: replaced.sites,
              format: parsed.format,
              imported,
              valid: parsed.sites.length,
              duplicates,
              sourceCount: Number(parsed.sourceCount) || parsed.sites.length,
              skipped: Number(parsed.skipped) || 0,
              backup: replaced.backup
            };
          }
          const sites = await importSites(parsed.sites, { mode });
          return {
            ok: true,
            sites,
            format: parsed.format,
            imported,
            valid: parsed.sites.length,
            duplicates,
            sourceCount: Number(parsed.sourceCount) || parsed.sites.length,
            skipped: Number(parsed.skipped) || 0,
            backup: null
          };
        });
      }
      case 'previewImport': {
        const parsed = typeof message.text === 'string'
          ? parseImportText(message.text)
          : parseImportText(JSON.stringify(message.config || {}));
        if (!parsed.format || !parsed.sites?.length) {
          return {
            ok: false,
            code: 'empty_import',
            error: `导入内容中没有可用站点${parsed.skipped ? `（已跳过 ${parsed.skipped} 条）` : ''}，已取消以保护现有数据`,
            skipped: Number(parsed.skipped) || 0
          };
        }
        const current = await loadSites();
        const currentIdentities = new Set(current.map((site) => siteIdentity(site)).filter(Boolean));
        const incomingIdentities = new Set(parsed.sites.map((site) => siteIdentity(site)).filter(Boolean));
        const updating = [...incomingIdentities].filter((identity) => currentIdentities.has(identity)).length;
        const duplicates = Math.max(0, parsed.sites.length - incomingIdentities.size);
        return {
          ok: true,
          format: parsed.format,
          sourceCount: Number(parsed.sourceCount) || parsed.sites.length,
          valid: parsed.sites.length,
          skipped: Number(parsed.skipped) || 0,
          duplicates,
          incoming: incomingIdentities.size,
          current: current.length,
          added: incomingIdentities.size - updating,
          updating
        };
      }
      case 'getLatestSiteBackup':
        return { ok: true, backup: typeof getLatestSiteBackup === 'function' ? await getLatestSiteBackup() : null };
      case 'listSiteBackups':
        return {
          ok: true,
          backups: typeof listSiteBackups === 'function' ? await listSiteBackups() : []
        };
      case 'deleteSiteBackup':
        if (!message.id || typeof deleteSiteBackup !== 'function') return { ok: false, error: '未指定快照' };
        return { ok: true, backups: await deleteSiteBackup(message.id) };
      case 'clearSiteBackups':
        return { ok: true, backups: typeof clearSiteBackups === 'function' ? await clearSiteBackups() : [] };
      case 'restoreSiteBackup': {
        if (!message.id) return { ok: false, error: '未指定可恢复的导入快照' };
        if (typeof restoreSiteBackup !== 'function') return { ok: false, error: '导入恢复当前不可用' };
        const result = await restoreSiteBackup(message.id);
        return { ok: true, ...result };
      }
      case 'openUrl': {
        let url = String(message.url || '').trim();
        // 可传 siteId，强制用稳定首页
        if (message.siteId && typeof openUrlForSite === 'function') {
          const all = await loadSites();
          const s = all.find((x) => x.id === message.siteId);
          if (s) url = openUrlForSite(s) || url;
        }
        if (!url) return { ok: false, error: '无效链接' };
        try {
          const u = new URL(url);
          if (u.protocol !== 'https:') return { ok: false, error: '只允许打开 HTTPS 站点' };
          // 易 404 深链 → 站点根；同时丢弃查询串和 hash，避免把临时凭据带进新标签页。
          if (/\/console\/personal|\/panel\/personal|\/console\/topup/i.test(u.pathname)) {
            url = u.origin + '/';
          } else {
            url = u.origin + (u.pathname === '/' ? '/' : u.pathname);
          }
        } catch (e) {
          return { ok: false, error: '无效链接' };
        }
        await chrome.tabs.create({ url });
        return { ok: true };
      }
      case 'openTokenPage': {
        const all = await loadSites();
        const s = all.find((x) => x.id === message.id);
        if (!s) return { ok: false, error: '站点不存在' };
        const url = typeof tokenPageUrlForSite === 'function'
          ? tokenPageUrlForSite(s)
          : `https://${s.domain}/console/token`;
        await chrome.tabs.create({ url });
        return { ok: true, url };
      }
      case 'pushToCheckin':
      case 'retryFailedCheckin':
        return {
          ok: false,
          code: 'checkin_standalone',
          error: '签到已独立，请在「公益站签到」中识别添加'
        };
      case 'getCheckinStatus':
        return {
          ok: true,
          standalone: true,
          connection: {
            ok: false,
            code: 'checkin_standalone',
            error: '签到已独立，请在「公益站签到」中识别添加'
          },
          meta: null
        };
      case 'setCheckinOptIn': {
        // 仅兼容旧本地字段；不再触发任何跨扩展同步
        const all = await loadSites();
        const one = all.find((s) => s.id === message.id);
        if (!one) return { ok: false, error: '站点不存在' };
        const sites = await updateSiteById(one.id, { checkinOptIn: message.value === true });
        return {
          ok: true,
          standalone: true,
          sites,
          site: sites.find((s) => s.id === one.id),
          warning: '签到已独立；此开关只改本地标记，不会同步到签到扩展'
        };
      }
      case 'pingCheckin':
        return {
          ok: false,
          code: 'checkin_standalone',
          error: '签到已独立，请在「公益站签到」中识别添加'
        };
      case 'formatClientSnippet': {
        const all = await loadSites();
        const site = all.find((s) => s.id === message.id);
        if (!site) return { ok: false, error: '站点不存在' };
        return { ok: true, text: formatApiBaseV1(site) };
      }
      case 'ensureSiteKey':
        return ensureSiteKey(message.id, { allowCreate: message.allowCreate === true });
      case 'importKeysFromPage': {
        // 从当前打开的该站标签页扫描 sk- 并保存
        const all = await loadSites();
        const site = all.find((s) => s.id === message.id);
        if (!site) return { ok: false, error: '站点不存在' };
        const access = await ensureAccessForSite(site, { request: false });
        if (!access.ok) return access;
        const session = await readPageAuthSession(site.domain, siteOrigin(site));
        let tabId = session.tabId;
        let temporary = false;
        if (!tabId) {
          // 不改写用户标签；仅后台临时打开
          const ensured = await ensureSiteTab(site, { preferPersonal: false });
          tabId = ensured.tabId;
          temporary = ensured.temporary;
        }
        if (!tabId) return { ok: false, error: '请先打开该站页面（令牌管理页最佳）' };
        const activeSession = await readPageAuthSession(site.domain, siteOrigin(site));
        const scanTabId = activeSession.tabId || tabId;
        const scanOptions = { readFullTokenKeys: false, expectedOrigin: siteOrigin(site) };
        if (site.type === 'newapi') {
          const identity = typeof verifyNewApiTabAccount === 'function'
            ? await verifyNewApiTabAccount(scanTabId, activeSession, siteOrigin(site))
            : { ok: false, code: 'account_verify_failed' };
          if (!identity?.ok) {
            if (temporary) {
              try { await chrome.tabs.remove(tabId); } catch (e) {}
            }
            return { ok: false, error: identity?.error || '无法验证当前登录账号' };
          }
          scanOptions.authHeaders = identity.headers || {};
          scanOptions.readFullTokenKeys = true;
        }
        const scraped = typeof scrapeTabBalanceAndKeys === 'function'
          ? await scrapeTabBalanceAndKeys(scanTabId, site.type, scanOptions)
          : { trustedKeys: [] };
        if (temporary) {
          try { await chrome.tabs.remove(tabId); } catch (e) {}
        }
        if (scraped?.code === 'tab_domain_changed') {
          return { ok: false, code: scraped.code, error: scraped.error || '标签页已跳转，请回到原站后重试' };
        }
        const persisted = await persistScrapedKeys(
          site.id,
          site.domain,
          scraped.trustedKeys || []
        );
        if (persisted.reason === 'site_not_found') return { ok: false, error: '站点不存在' };
        if (persisted.reason === 'site_domain_changed') {
          return {
            ok: false,
            code: 'site_domain_changed',
            error: '站点地址已修改，未把 Key 写入新站点；请重新打开原站后再试'
          };
        }
        const added = persisted.added;
        return {
          ok: true,
          site: persisted.site,
          sites: await loadSites(),
          added,
          found: (scraped.trustedKeys || []).length,
          message: added
            ? `已导入 ${added} 个 Key`
            : ((scraped.trustedKeys || []).length
              ? '页面上的 Key 均已存在'
              : '页面未扫到完整 sk-（令牌页常只显示截断，请点复制后手动「添加 Key」）')
        };
      }
      default:
        return { ok: false, error: `unknown message: ${type}` };
    }
  })()
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
