(function (root) {
  // 纯展示/解析逻辑在 balance-format.js；浏览器由 importScripts 先加载，Node 在此补齐。
  if (typeof root.formatBalanceValue !== 'function' && typeof require === 'function') {
    try { Object.assign(root, require('./balance-format.js')); } catch (error) {}
  }
  const QUOTA_UNIT = root.QUOTA_UNIT || 500000;
  const formatBalanceValue = root.formatBalanceValue;
  const extractBalanceFromData = root.extractBalanceFromData;
  const extractUsageFromData = root.extractUsageFromData;
  const extractBalanceFromText = root.extractBalanceFromText;
  const extractUsageFromText = root.extractUsageFromText;
  const extractFromUserObject = root.extractFromUserObject;
  const isSuspiciousBalance = root.isSuspiciousBalance;
  const resolveQuotaUnit = root.resolveQuotaUnit;
  const buildAuthHeaders = root.buildAuthHeaders;
  const humanizeBalanceError = root.humanizeBalanceError;
  const classifyBalanceError = root.classifyBalanceError;
  const candidatePaths = root.candidateBalancePaths || root.candidatePaths;
  const candidateTokenPaths = root.candidateTokenPaths;

  async function fetchJson(url, headers = {}, timeoutMs = 12000) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json', ...headers },
        credentials: 'include',
        redirect: 'error',
        signal: controller?.signal
      });
      if (!response.ok) return { ok: false, status: response.status, data: null };
      const text = await response.text();
      if (!text) return { ok: true, status: response.status, data: null };
      try {
        return { ok: true, status: response.status, data: JSON.parse(text) };
      } catch (e) {
        return { ok: true, status: response.status, data: { raw: text } };
      }
    } catch (e) {
      return { ok: false, status: 0, data: null, error: String(e?.message || e) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // page-scrape.js：标签页余额/Key 抓取（Node 下按需 require）
  // 必须捕获真实实现再挂 root，禁止 () => root.fn 回写（会递归）。
  if (typeof root.scrapeTabBalanceAndKeys !== 'function' && typeof require === 'function') {
    try { Object.assign(root, require('./page-scrape.js')); } catch (error) {}
  }
  const scrapeTabBalanceAndKeys = root.scrapeTabBalanceAndKeys;
  const fetchBalanceViaTab = root.fetchBalanceViaTab;


  // tab-api-key.js：账号校验 + 自动创建 Key（Node 下按需 require）
  // 注意：必须捕获「真实实现」再挂到 root，不能用 () => root.fn 再回写，否则会递归。
  if (typeof root.verifyNewApiTabAccount !== 'function' && typeof require === 'function') {
    try { Object.assign(root, require('./tab-api-key.js')); } catch (error) {}
  }
  const verifyNewApiTabAccount = root.verifyNewApiTabAccount;
  const createTabApiKey = root.createTabApiKey;


  async function fetchSiteBalance(site, options = {}) {
    const domain = root.normalizeDomain?.(site?.domain) || site?.domain;
    if (!domain) {
      const classified = classifyBalanceError('invalid domain', 'invalid_domain');
      return { ok: false, code: classified.code, error: classified.message, action: classified.action };
    }

    const origin = root.originForSite?.(site)
      || root.originFromDomain?.(site?.baseUrl || site?.pageUrl || domain)
      || `https://${domain}`;
    const type = site?.type || 'auto';
    const paths = candidatePaths(type);
    const quotaUnit = resolveQuotaUnit(
      options.quotaPerUnit ?? site?.quotaPerUnit ?? site?.quota_per_unit
    );
    const candidateKey = options.apiKey
      || (typeof root.getDefaultKeyValue === 'function' ? root.getDefaultKeyValue(site) : '');
    const apiKey = typeof root.isCompleteApiKey === 'function'
      ? (root.isCompleteApiKey(candidateKey) ? candidateKey : '')
      : candidateKey;

    // 1) 标签页会话（最可靠）
    if (options.tabId) {
      let expectedOrigin = origin;
      try {
        const candidate = new URL(site?.baseUrl || site?.pageUrl || origin);
        if (candidate.protocol === 'https:') expectedOrigin = candidate.origin;
      } catch (error) {}
      const tabResult = await scrapeTabBalanceAndKeys(options.tabId, type, {
        quotaPerUnit: quotaUnit,
        expectedOrigin
      });
      if (tabResult.ok) return tabResult;
      // 页面文字中的 keys 只用于诊断；只有可信 API/令牌读取结果允许进入持久化链路。
      if (tabResult.trustedKeys?.length) options._scrapedTrustedKeys = tabResult.trustedKeys;
      // 保留更明确错误
      options._tabError = tabResult.error;
    }

    // 2) 扩展侧请求（会话 cookie 通常带不过来，主要靠 pageToken / key）
    const headerSets = [];
    if (apiKey) {
      headerSets.push({
        ...buildAuthHeaders(apiKey),
        ...(options.newApiUserId ? { 'New-API-User': String(options.newApiUserId) } : {}),
        _via: 'key'
      });
    }
    if (options.pageToken || options.newApiUserId) {
      const h = { _via: 'page-session' };
      if (options.newApiUserId) h['New-API-User'] = String(options.newApiUserId);
      if (options.pageToken) Object.assign(h, buildAuthHeaders(options.pageToken));
      headerSets.push(h);
    }
    headerSets.push({
      ...(options.newApiUserId ? { 'New-API-User': String(options.newApiUserId) } : {}),
      _via: 'credentials'
    });

    let lastError = options._tabError || 'no response';
    let sawAuthError = false;
    for (const headers of headerSets) {
      const via = headers._via;
      const reqHeaders = { ...headers };
      delete reqHeaders._via;
      if (!reqHeaders.Authorization) delete reqHeaders.Authorization;

      for (const path of paths) {
        const result = await fetchJson(`${origin}${path}`, reqHeaders, options.timeoutMs || 12000);
        if (!result.ok) {
          if (result.status === 401 || result.status === 403) sawAuthError = true;
          lastError = result.error || `HTTP ${result.status}`;
          continue;
        }
        if (result.data && result.data.success === false) {
          lastError = 'not logged in';
          sawAuthError = true;
          continue;
        }
        const fromUser = extractFromUserObject(result.data, quotaUnit);
        if (fromUser && (fromUser.balance || fromUser.usage)) {
          return {
            ok: true,
            balance: fromUser.balance || null,
            usage: fromUser.usage || null,
            source: path,
            via,
            quotaPerUnit: quotaUnit
          };
        }
        const balance = extractBalanceFromData(result.data, quotaUnit);
        const usage = extractUsageFromData(result.data, quotaUnit);
        if (balance || usage) {
          return {
            ok: true,
            balance: balance || null,
            usage: usage || null,
            source: path,
            via,
            quotaPerUnit: quotaUnit
          };
        }
        lastError = 'no balance field';
      }
    }

    if (sawAuthError && !apiKey) {
      const classified = classifyBalanceError(
        '未读到余额：请打开该站「个人中心」并保持登录，再点余额。sk- 是 API 密钥，不能代替登录。',
        'not_logged_in'
      );
      return {
        ok: false,
        code: classified.code,
        error: classified.message,
        action: classified.action,
        trustedKeys: options._scrapedTrustedKeys || []
      };
    }
    const rawMessage = typeof lastError === 'string' && /未登录|个人中心|未授权|未解析/.test(lastError)
      ? lastError
      : humanizeBalanceError(lastError);
    const classified = classifyBalanceError(rawMessage, lastError);
    return {
      ok: false,
      code: classified.code,
      error: classified.message,
      action: classified.action,
      trustedKeys: options._scrapedTrustedKeys || []
    };
  }

  function formatApiBaseV1(site) {
    if (typeof root.originForSite === 'function') {
      const origin = root.originForSite(site);
      return origin ? `${origin}/v1` : '';
    }
    try {
      const raw = site?.baseUrl || site?.pageUrl || site?.domain || '';
      const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      return url.protocol === 'https:' ? `${url.origin}/v1` : '';
    } catch (error) {
      return '';
    }
  }

  root.formatBalanceValue = formatBalanceValue;
  root.extractBalanceFromData = extractBalanceFromData;
  root.extractUsageFromData = extractUsageFromData;
  root.extractBalanceFromText = extractBalanceFromText;
  root.extractUsageFromText = extractUsageFromText;
  root.extractFromUserObject = extractFromUserObject;
  root.isSuspiciousBalance = isSuspiciousBalance;
  root.resolveQuotaUnit = resolveQuotaUnit;
  root.buildAuthHeaders = buildAuthHeaders;
  root.fetchSiteBalance = fetchSiteBalance;
  root.fetchBalanceViaTab = fetchBalanceViaTab;
  root.scrapeTabBalanceAndKeys = scrapeTabBalanceAndKeys;
  root.verifyNewApiTabAccount = verifyNewApiTabAccount;
  root.createTabApiKey = createTabApiKey;
  root.candidateBalancePaths = candidatePaths;
  root.humanizeBalanceError = humanizeBalanceError;
  root.classifyBalanceError = classifyBalanceError;
  root.formatApiBaseV1 = formatApiBaseV1;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      formatBalanceValue,
      extractBalanceFromData,
      extractUsageFromData,
      extractBalanceFromText,
      extractUsageFromText,
      extractFromUserObject,
      isSuspiciousBalance,
      resolveQuotaUnit,
      buildAuthHeaders,
      fetchSiteBalance,
      fetchBalanceViaTab,
      scrapeTabBalanceAndKeys,
      verifyNewApiTabAccount,
      createTabApiKey,
      candidatePaths,
      humanizeBalanceError,
      classifyBalanceError,
      formatApiBaseV1,
      QUOTA_UNIT
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
