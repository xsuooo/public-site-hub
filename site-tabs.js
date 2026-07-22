(function (root) {
  /**
   * 标签页生命周期：余额/识别用的临时页、复用同域页、安全关闭。
   * 依赖 chrome.tabs；domain 规范化优先用 root.normalizedSiteDomain / normalizeDomain。
   */

  function domainOf(value) {
    if (typeof root.normalizedSiteDomain === 'function') {
      return root.normalizedSiteDomain(value);
    }
    if (typeof root.normalizeDomain === 'function') {
      return root.normalizeDomain(value) || '';
    }
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
    } catch (e) {
      return raw.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0].toLowerCase();
    }
  }

  function originOf(value) {
    if (typeof root.originForSite === 'function') return root.originForSite(value);
    if (typeof root.originFromDomain === 'function') return root.originFromDomain(value) || '';
    const raw = value && typeof value === 'object'
      ? (value.baseUrl || value.pageUrl || value.domain)
      : value;
    try {
      const url = new URL(/^https?:\/\//i.test(String(raw || '')) ? raw : `https://${raw}`);
      return url.protocol === 'https:' ? url.origin.toLowerCase() : '';
    } catch (error) {
      return '';
    }
  }

  function waitTabComplete(tabId, timeoutMs = 15000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch (e) {}
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      function onUpdated(id, info) {
        if (id === tabId && info.status === 'complete') {
          clearTimeout(timer);
          finish(true);
        }
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.get(tabId).then((t) => {
        if (t?.status === 'complete') {
          clearTimeout(timer);
          finish(true);
        }
      }).catch(() => {});
    });
  }

  function personalUrls(site) {
    const origin = originOf(site);
    if (!origin) return [];
    return [
      `${origin}/console/personal`,
      `${origin}/console/topup`,
      `${origin}/panel/personal`,
      `${origin}/user`,
      `${origin}/`
    ];
  }

  function isBalanceFriendlyPath(pathname) {
    return /personal|topup|dashboard|\/user|account|wallet|billing/i.test(String(pathname || ''));
  }

  async function findTabForDomain(domain, options = {}) {
    const host = domainOf(domain);
    if (!host || typeof chrome === 'undefined' || !chrome.tabs?.query) return null;
    const rawExpectedOrigin = String(options.expectedOrigin || '').trim();
    const expectedOrigin = (() => {
      try {
        const raw = rawExpectedOrigin;
        if (!raw) return '';
        const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
        return url.protocol === 'https:' ? url.origin.toLowerCase() : '';
      } catch (e) {
        return '';
      }
    })();
    if (rawExpectedOrigin && !expectedOrigin) return null;
    const matches = (tab) => {
      try {
        const url = new URL(tab?.url || '');
        if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== host) return false;
        return !expectedOrigin || url.origin.toLowerCase() === expectedOrigin;
      } catch (e) {
        return false;
      }
    };
    try {
      if (options.tabId && chrome.tabs.get) {
        try {
          const explicit = await chrome.tabs.get(options.tabId);
          if (matches(explicit)) return explicit;
        } catch (e) {}
      }
      const tabs = await chrome.tabs.query({});
      const eligible = tabs.filter(matches);
      if (!eligible.length) return null;
      if (options.preferActive !== false) {
        const active = eligible.find((tab) => tab.active === true && tab.currentWindow === true);
        if (active) return active;
      }
      return eligible[0] || null;
    } catch (e) {
      return null;
    }
  }

  function trackOwnedTempTab(ownedTempTabs, tabId) {
    if (!tabId || !Array.isArray(ownedTempTabs)) return;
    if (!ownedTempTabs.includes(tabId)) ownedTempTabs.push(tabId);
  }

  function untrackOwnedTempTab(ownedTempTabs, tabId) {
    if (!tabId || !Array.isArray(ownedTempTabs)) return;
    const index = ownedTempTabs.indexOf(tabId);
    if (index >= 0) ownedTempTabs.splice(index, 1);
  }

  /**
   * 打开「临时后台标签」读余额用。
   * 重要：绝不 chrome.tabs.update 用户已打开的标签。
   * 创建成功后立刻登记到 ownedTempTabs，避免超时竞态导致标签泄漏。
   */
  async function openTemporaryBalanceTab(site, urls, ownedTempTabs = null) {
    const list = Array.isArray(urls) && urls.length
      ? urls
      : personalUrls(site);
    for (const url of list) {
      let createdId = null;
      try {
        const created = await chrome.tabs.create({ url, active: false });
        if (!created?.id) continue;
        createdId = created.id;
        // 在 waitTabComplete 之前登记，保证超时 finally 能关掉这张页。
        trackOwnedTempTab(ownedTempTabs, createdId);
        await waitTabComplete(createdId, 12000);
        await new Promise((r) => setTimeout(r, 1600));
        return { tabId: createdId, temporary: true, url };
      } catch (e) {
        if (createdId) {
          untrackOwnedTempTab(ownedTempTabs, createdId);
          await closeTabSafe(createdId);
        }
        // 试下一个 URL
      }
    }
    return { tabId: null, temporary: false };
  }

  /**
   * 获取可读余额的标签页。
   * - 已有同域标签：直接复用，不改 URL
   * - 没有：后台静默开临时页（用完由调用方关闭）
   */
  async function ensureSiteTab(site, {
    preferPersonal = true,
    tabId,
    expectedOrigin,
    ownedTempTabs = null
  } = {}) {
    const domain = domainOf(site?.domain || site?.baseUrl);
    const siteOrigin = expectedOrigin
      || (typeof root.originFromDomain === 'function'
        ? root.originFromDomain(site?.baseUrl || site?.pageUrl || domain)
        : `https://${domain}`);
    const existing = await findTabForDomain(domain, { tabId, expectedOrigin: siteOrigin });

    if (existing?.id) {
      return {
        tabId: existing.id,
        temporary: false,
        url: existing.url || `${siteOrigin || `https://${domain}`}/`
      };
    }

    const base = siteOrigin || `https://${domain}`;
    const urls = preferPersonal
      ? [`${base}/console/personal`, `${base}/console/topup`, `${base}/panel/personal`, `${base}/user`, `${base}/`]
      : [`${base}/`, `${base}/console/personal`, `${base}/console/topup`, `${base}/panel/personal`, `${base}/user`];
    return openTemporaryBalanceTab(site, urls, ownedTempTabs);
  }

  async function closeTabSafe(tabId) {
    if (!tabId) return;
    try { await chrome.tabs.remove(tabId); } catch (e) {}
  }

  /**
   * 打开余额失败站的首页（限流，避免一次开太多标签）。
   * @param {{ limit?: number, reason?: 'all'|'not_logged_in'|'login' }} [options]
   *   reason=not_logged_in|login 时只打开未登录类失败。
   */
  async function openFailedBalanceSites(sites, { limit = 5, reason = 'all' } = {}) {
    const want = String(reason || 'all').toLowerCase();
    const list = (Array.isArray(sites) ? sites : []).filter((site) => {
      if (site?.balanceStatus?.status !== 'failed' || !site.domain) return false;
      if (want === 'all') return true;
      const code = String(site.balanceStatus?.lastError?.code || '');
      const msg = String(site.balanceStatus?.lastError?.message || '');
      if (want === 'not_logged_in' || want === 'login') {
        return code === 'not_logged_in'
          || code === 'tab_open_failed'
          || /未登录|登录|个人中心|会话/.test(msg);
      }
      return code === want;
    });
    const max = Math.max(1, Math.min(20, Number(limit) || 5));
    const targets = list.slice(0, max);
    let opened = 0;
    for (const site of targets) {
      try {
        const url = typeof root.openUrlForSite === 'function'
          ? root.openUrlForSite(site)
          : `https://${domainOf(site.domain)}/`;
        if (!url) continue;
        await chrome.tabs.create({ url, active: opened === 0 });
        opened += 1;
      } catch (e) {
        // 继续下一个
      }
    }
    const label = (want === 'not_logged_in' || want === 'login') ? '未登录失败站' : '余额失败站';
    return {
      ok: true,
      opened,
      skipped: Math.max(0, list.length - targets.length),
      total: list.length,
      reason: want,
      message: list.length
        ? `已打开 ${opened} 个${label}${list.length > max ? `（共 ${list.length} 个，仅开前 ${max} 个）` : ''}`
        : `没有${label}`
    };
  }

  root.waitTabComplete = waitTabComplete;
  root.personalUrls = personalUrls;
  root.isBalanceFriendlyPath = isBalanceFriendlyPath;
  root.findTabForDomain = findTabForDomain;
  root.openTemporaryBalanceTab = openTemporaryBalanceTab;
  root.ensureSiteTab = ensureSiteTab;
  root.closeTabSafe = closeTabSafe;
  root.openFailedBalanceSites = openFailedBalanceSites;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      waitTabComplete,
      personalUrls,
      isBalanceFriendlyPath,
      findTabForDomain,
      openTemporaryBalanceTab,
      ensureSiteTab,
      closeTabSafe,
      openFailedBalanceSites
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
