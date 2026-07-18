(function (root) {
  function normalizedSiteDomain(value) {
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

  function permissionOriginForDomain(domain) {
    return permissionOriginForSite(domain);
  }

  function permissionOriginForSite(value) {
    if (typeof root.originForSite === 'function') {
      const origin = root.originForSite(value);
      return origin ? `${origin}/*` : '';
    }
    const rawValue = value && typeof value === 'object'
      ? (value.baseUrl || value.pageUrl || value.domain)
      : value;
    const raw = String(rawValue || '').trim();
    if (!raw) return '';
    try {
      const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (url.protocol === 'https:' && url.hostname) return `${url.origin}/*`;
    } catch (e) {}
    const normalized = normalizedSiteDomain(raw);
    return normalized ? `https://${normalized}/*` : '';
  }

  function chromePermissionCall(method, details) {
    return new Promise((resolve) => {
      try {
        if (typeof chrome === 'undefined' || !chrome.permissions?.[method]) {
          resolve({ ok: false, error: 'chrome.permissions unavailable' });
          return;
        }
        chrome.permissions[method](details, (value) => {
          const error = chrome.runtime?.lastError;
          if (error) {
            resolve({ ok: false, error: error.message || String(error) });
            return;
          }
          resolve({ ok: true, value: value === true });
        });
      } catch (error) {
        resolve({ ok: false, error: String(error?.message || error) });
      }
    });
  }

  function permissionOriginsForSites(domains) {
    return [...new Set((Array.isArray(domains) ? domains : [domains])
      .map(permissionOriginForSite)
      .filter(Boolean))];
  }

  function permissionRequestErrorMessage(error) {
    const message = String(error || '').trim();
    if (/user gesture/i.test(message)) {
      return '请直接点击“重试并授权”，然后在浏览器提示中允许访问';
    }
    if (/denied|not allowed|not permitted/i.test(message)) {
      return '未获得站点访问权限；余额、识别和自动导入 Key 不会执行';
    }
    return message || '未获得站点访问权限；余额、识别和自动导入 Key 不会执行';
  }

  /**
   * 必须从 popup/options 的真实点击处理器同步进入；
   * 不先 await contains，避免丢失 Chrome 的瞬时 user gesture。
   */
  async function requestSiteAccessFromGesture(domains) {
    const origins = permissionOriginsForSites(domains);
    if (!origins.length || typeof chrome === 'undefined' || !chrome.permissions?.request) {
      return { ok: true, origins, unsupported: true };
    }
    const granted = await chromePermissionCall('request', { origins });
    if (!granted.ok || !granted.value) {
      return {
        ok: false,
        origins,
        code: 'site_permission_denied',
        error: permissionRequestErrorMessage(granted.error)
      };
    }
    return { ok: true, origins, granted: true };
  }

  /**
   * 站点权限为可选权限：只在用户主动操作时申请。
   * permissions API 不可用时返回 ok（兼容单元测试）。
   */
  async function ensureSiteAccess(domains, { request = false } = {}) {
    const origins = permissionOriginsForSites(domains);
    if (!origins.length || typeof chrome === 'undefined'
      || !chrome.permissions?.contains || !chrome.permissions?.request) {
      return { ok: true, origins, unsupported: true };
    }
    const hasAll = await chromePermissionCall('contains', { origins });
    if (!hasAll.ok) return { ok: false, origins, error: `无法检查站点访问权限：${hasAll.error}` };
    if (hasAll.value) return { ok: true, origins, granted: false };
    if (!request) {
      return {
        ok: false,
        origins,
        code: 'site_permission_required',
        error: '需要站点访问权限，请重新点击本次操作后授权'
      };
    }
    const granted = await chromePermissionCall('request', { origins });
    if (!granted.ok || !granted.value) {
      return {
        ok: false,
        origins,
        code: 'site_permission_denied',
        error: permissionRequestErrorMessage(granted.error)
      };
    }
    return { ok: true, origins, granted: true };
  }

  async function ensureAccessForSite(site, options) {
    return ensureSiteAccess(site, options);
  }

  /** 只读统计：尚未授予 HTTPS 可选权限的收藏站（不弹授权框） */
  async function countUnauthorizedSites(sites) {
    const list = Array.isArray(sites) ? sites : [];
    if (!list.length) {
      return {
        unauthorizedCount: 0,
        authorizedCount: 0,
        unknownCount: 0,
        checked: 0,
        unauthorizedSites: []
      };
    }
    if (typeof chrome === 'undefined' || !chrome.permissions?.contains) {
      return {
        unauthorizedCount: 0,
        authorizedCount: 0,
        unknownCount: list.length,
        checked: 0,
        unsupported: true,
        unauthorizedSites: []
      };
    }
    let unauthorizedCount = 0;
    let authorizedCount = 0;
    let unknownCount = 0;
    const unauthorizedSites = [];
    for (const site of list) {
      try {
        const access = await ensureAccessForSite(site, { request: false });
        if (access.ok) authorizedCount += 1;
        else if (access.code === 'site_permission_required' || access.code === 'site_permission_denied') {
          unauthorizedCount += 1;
          unauthorizedSites.push({
            id: site.id,
            domain: site.domain,
            name: site.name || site.domain,
            origin: typeof root.originForSite === 'function'
              ? root.originForSite(site)
              : String(site.baseUrl || site.pageUrl || site.domain || '')
          });
        } else {
          unknownCount += 1;
        }
      } catch (error) {
        unknownCount += 1;
      }
    }
    return {
      unauthorizedCount,
      authorizedCount,
      unknownCount,
      checked: list.length,
      unauthorizedSites
    };
  }

  root.normalizedSiteDomain = normalizedSiteDomain;
  root.permissionOriginForDomain = permissionOriginForDomain;
  root.permissionOriginForSite = permissionOriginForSite;
  root.chromePermissionCall = chromePermissionCall;
  root.permissionOriginsForSites = permissionOriginsForSites;
  root.permissionRequestErrorMessage = permissionRequestErrorMessage;
  root.requestSiteAccessFromGesture = requestSiteAccessFromGesture;
  root.ensureSiteAccess = ensureSiteAccess;
  root.ensureAccessForSite = ensureAccessForSite;
  root.countUnauthorizedSites = countUnauthorizedSites;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      normalizedSiteDomain,
      permissionOriginForDomain,
      permissionOriginForSite,
      chromePermissionCall,
      permissionOriginsForSites,
      permissionRequestErrorMessage,
      requestSiteAccessFromGesture,
      ensureSiteAccess,
      ensureAccessForSite,
      countUnauthorizedSites
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
