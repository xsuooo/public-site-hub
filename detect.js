(function (root) {
  const TYPE_LABELS = {
    newapi: 'NewAPI',
    sub2api: 'Sub2API',
    zenapi: 'ZenAPI',
    unknown: '未知',
    auto: '自动'
  };

  // 打开/收藏默认页：用站点根，避免 /console/personal 在部分站 404
  const DEFAULT_PAGE_BY_TYPE = {
    newapi: '/',
    sub2api: '/',
    zenapi: '/'
  };

  function typeLabel(type) {
    return TYPE_LABELS[type] || type || '未知';
  }

  function detectSiteTypeFromUrl(url) {
    try {
      const parsed = new URL(url || '');
      const redirect = parsed.searchParams.get('redirect') || '';
      if (
        parsed.pathname === '/check-in'
        || redirect === '/check-in'
        || redirect.startsWith('/check-in?')
      ) return 'sub2api';
      if (parsed.pathname.startsWith('/user')) return 'zenapi';
    } catch (e) {}
    return null;
  }

  function pageUrlForType(domain, type, preferredUrl) {
    let origin = root.originFromDomain?.(domain) || `https://${domain}`;
    const expectedHost = root.normalizeDomain?.(domain)
      || String(domain || '').toLowerCase().replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
    if (preferredUrl) {
      try {
        const u = new URL(preferredUrl);
        if (u.hostname.toLowerCase() === expectedHost && u.protocol === 'https:') {
          // preferredUrl 可能是 sibling port；保留其完整 Origin。
          origin = u.origin.toLowerCase();
          // 不把易 404 的 personal/topup 深链当成默认打开地址
          if (/\/console\/personal|\/panel\/personal|\/console\/topup/i.test(u.pathname)) {
            return `${origin}/`;
          }
          // 当前标签页路径可用则保留（用户本来就在这）
          return u.origin + (u.pathname === '/' ? '/' : u.pathname.replace(/\/$/, '') || '/');
        }
      } catch (e) {}
    }
    const path = DEFAULT_PAGE_BY_TYPE[type] || '/';
    return path === '/' ? `${origin}/` : `${origin}${path}`;
  }

  function extractQuotaMeta(status) {
    if (!status || typeof status !== 'object') return {};
    const src = status.data && typeof status.data === 'object' && status.quota_per_unit == null
      ? status.data
      : status;
    const unit = Number(src.quota_per_unit ?? src.QuotaPerUnit);
    const meta = {};
    if (Number.isFinite(unit) && unit > 0 && unit < 1e12) meta.quotaPerUnit = unit;
    if (src.display_in_currency === true || src.displayInCurrency === true) {
      meta.displayInCurrency = true;
    }
    return meta;
  }

  function pickNameFromStatus(status, domain) {
    if (!status || typeof status !== 'object') return null;
    const candidates = [status.system_name, status.systemName, status.site_name, status.siteName, status.name, status.title];
    for (const c of candidates) {
      const name = root.truncateText?.(c, 60) || String(c || '').trim();
      if (name && name.toLowerCase() !== String(domain || '').toLowerCase()) return name;
    }
    return null;
  }

  function isNewApiStatus(status) {
    if (!status || typeof status !== 'object') return false;
    return Boolean(
      status.linuxdo_client_id
      || status.linuxdo_oauth_enabled
      || Object.prototype.hasOwnProperty.call(status, 'system_name')
      || Object.prototype.hasOwnProperty.call(status, 'quota_per_unit')
      || Object.prototype.hasOwnProperty.call(status, 'turnstile_check')
      || Object.prototype.hasOwnProperty.call(status, 'version')
      || Object.prototype.hasOwnProperty.call(status, 'start_time')
      || Object.prototype.hasOwnProperty.call(status, 'display_in_currency')
      || Object.prototype.hasOwnProperty.call(status, 'display_token_stat_enabled')
      || Object.prototype.hasOwnProperty.call(status, 'email_verification_enabled')
      || Object.prototype.hasOwnProperty.call(status, 'github_oauth_enabled')
      || Object.prototype.hasOwnProperty.call(status, 'wechat_login')
      || Object.prototype.hasOwnProperty.call(status, 'footer_html')
      || Object.prototype.hasOwnProperty.call(status, 'logo')
      || Object.prototype.hasOwnProperty.call(status, 'chat_link')
    );
  }

  function isZenApiSiteInfo(data) {
    if (!data || typeof data !== 'object') return false;
    return Boolean(
      Object.prototype.hasOwnProperty.call(data, 'site_mode')
      || Object.prototype.hasOwnProperty.call(data, 'registration_mode')
      || Object.prototype.hasOwnProperty.call(data, 'linuxdo_enabled')
    );
  }

  function isSub2ApiPayload(data) {
    if (!data || typeof data !== 'object') return false;
    return Boolean(
      Object.prototype.hasOwnProperty.call(data, 'api_base_url')
      || Object.prototype.hasOwnProperty.call(data, 'linuxdo_oauth_enabled')
      || Object.prototype.hasOwnProperty.call(data, 'check_in')
      || Object.prototype.hasOwnProperty.call(data, 'checkin')
    );
  }

  async function fetchJsonQuiet(url, headers = {}, timeoutMs = 8000) {
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
      const text = await response.text();
      let data = null;
      if (text) {
        try { data = JSON.parse(text); } catch (e) { data = null; }
      }
      return { ok: response.ok, status: response.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: null, error: String(e?.message || e) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function cookieHeaderForDomain(domain) {
    if (typeof chrome === 'undefined' || !chrome.cookies?.getAll) return '';
    try {
      let list = await chrome.cookies.getAll({ domain });
      if (!list?.length) list = await chrome.cookies.getAll({ url: `https://${domain}` });
      if (!list?.length) return '';
      return list.map((c) => `${c.name}=${c.value}`).join('; ');
    } catch (e) {
      return '';
    }
  }

  async function probeSiteEndpoints(targetOrigin, options = {}) {
    const origin = root.originFromDomain?.(targetOrigin) || '';
    const domain = root.normalizeDomain?.(targetOrigin) || '';
    if (!origin || !domain) {
      return { type: null, name: null, signals: [], confidence: 'low', rawStatus: null };
    }
    const cookie = options.cookieHeader || await cookieHeaderForDomain(domain);
    const headers = cookie ? { Cookie: cookie } : {};
    const signals = [];
    let type = null;
    let name = null;
    let rawStatus = null;
    let confidence = 'low';

    {
      const r = await fetchJsonQuiet(`${origin}/api/public/site-info`, headers, options.timeoutMs);
      const payload = r.data?.data || r.data;
      if (r.ok && isZenApiSiteInfo(payload)) {
        type = 'zenapi';
        name = pickNameFromStatus(payload, domain);
        signals.push('/api/public/site-info');
        confidence = 'high';
        rawStatus = payload;
      }
    }

    if (!type || type === 'newapi') {
      const r = await fetchJsonQuiet(`${origin}/api/status`, headers, options.timeoutMs);
      const status = r.data?.data || r.data;
      if (r.ok && isNewApiStatus(status)) {
        if (!type) type = 'newapi';
        if (type === 'newapi') {
          name = name || pickNameFromStatus(status, domain);
          signals.push('/api/status');
          confidence = 'high';
          rawStatus = status;
        }
      }
    }

    // NewAPI 关闭 /api/status 公开访问时的回退
    if (!type) {
      const r = await fetchJsonQuiet(`${origin}/api/about`, headers, options.timeoutMs);
      const payload = r.data?.data || r.data;
      if (r.ok && isNewApiStatus(payload)) {
        type = 'newapi';
        name = name || pickNameFromStatus(payload, domain);
        signals.push('/api/about');
        confidence = 'high';
        rawStatus = payload;
      }
    }

    if (!type) {
      const candidates = [`${origin}/api/v1/settings`, `${origin}/api/v1/system`, `${origin}/api/v1/user`];
      for (const url of candidates) {
        const r = await fetchJsonQuiet(url, headers, options.timeoutMs);
        if (r.status === 401 || r.status === 403) {
          type = 'sub2api';
          signals.push(`${url} → ${r.status}`);
          confidence = 'medium';
          break;
        }
        const payload = r.data?.data || r.data;
        if (r.ok && isSub2ApiPayload(payload)) {
          type = 'sub2api';
          name = name || pickNameFromStatus(payload, domain);
          signals.push(url);
          confidence = 'high';
          rawStatus = payload;
          break;
        }
      }
    }

    if (!type) {
      const r = await fetchJsonQuiet(`${origin}/v1/models`, headers, options.timeoutMs);
      if (r.ok || r.status === 401 || r.status === 403) {
        signals.push(`/v1/models → ${r.status}`);
        type = 'newapi';
        confidence = confidence === 'low' ? 'medium' : confidence;
      }
    }

    return { type: type || 'unknown', name, signals, confidence, rawStatus, origin };
  }

  async function probeActiveTabPage(tabId, expectedOrigin = '') {
    if (typeof chrome === 'undefined' || !chrome.scripting?.executeScript) return null;
    if (!String(expectedOrigin || '').trim()) {
      return { error: 'expected_origin_required' };
    }
    try {
      if (expectedOrigin && chrome.tabs?.get) {
        const tab = await chrome.tabs.get(tabId);
        const currentOrigin = new URL(tab?.url || '').origin.toLowerCase();
        if (currentOrigin !== String(expectedOrigin).toLowerCase()) {
          return { error: 'tab_origin_changed', origin: currentOrigin };
        }
      }
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        args: [String(expectedOrigin || '')],
        func: async (requiredOrigin) => {
          if (requiredOrigin && String(location.origin || '').toLowerCase() !== requiredOrigin.toLowerCase()) {
            return { error: 'tab_origin_changed', origin: location.origin };
          }
          const signals = [];
          let type = null;
          let name = null;
          const appConfig = window.__APP_CONFIG__ || {};
          if (
            Object.prototype.hasOwnProperty.call(appConfig, 'api_base_url')
            || Object.prototype.hasOwnProperty.call(appConfig, 'linuxdo_oauth_enabled')
            || location.pathname === '/check-in'
          ) {
            type = 'sub2api';
            signals.push('__APP_CONFIG__ /check-in');
          }
          if (!type) {
            try {
              const response = await fetch('/api/public/site-info', { credentials: 'include', redirect: 'error' });
              const data = await response.json();
              const payload = data?.data || data;
              if (
                payload && (
                  Object.prototype.hasOwnProperty.call(payload, 'site_mode')
                  || Object.prototype.hasOwnProperty.call(payload, 'registration_mode')
                  || Object.prototype.hasOwnProperty.call(payload, 'linuxdo_enabled')
                  || location.pathname.startsWith('/user')
                )
              ) {
                type = 'zenapi';
                name = payload.site_name || payload.system_name || payload.name || null;
                signals.push('/api/public/site-info');
              }
            } catch (e) {
              if (location.pathname.startsWith('/user')) {
                type = 'zenapi';
                signals.push('pathname /user');
              }
            }
          }
          if (!type) {
            try {
              const response = await fetch('/api/status', { credentials: 'include', redirect: 'error' });
              const data = await response.json();
              const status = data?.data || data;
              if (
                response.ok && status && (
                  status.linuxdo_client_id
                  || Object.prototype.hasOwnProperty.call(status, 'system_name')
                  || Object.prototype.hasOwnProperty.call(status, 'quota_per_unit')
                  || Object.prototype.hasOwnProperty.call(status, 'turnstile_check')
                )
              ) {
                type = 'newapi';
                name = status.system_name || status.systemName || null;
                signals.push('/api/status');
              }
            } catch (e) {}
          }
          const metaName = document.querySelector('meta[property="og:site_name"]')?.content
            || document.querySelector('meta[name="application-name"]')?.content
            || null;

          // __NEXT_DATA__（部分 NewAPI 衍生站用 Next.js）：看 props.pageProps 是否有 system_name 等
          if (!type) {
            try {
              const nd = window.__NEXT_DATA__;
              const pp = nd?.props?.pageProps;
              if (pp && (pp.system_name || pp.quota_per_unit != null || pp.site_mode != null)) {
                if (pp.site_mode != null || pp.registration_mode != null) {
                  type = 'zenapi';
                  name = name || pp.site_name || pp.system_name || null;
                  signals.push('__NEXT_DATA__:zenapi');
                } else {
                  type = 'newapi';
                  name = name || pp.system_name || null;
                  signals.push('__NEXT_DATA__:newapi');
                }
              }
            } catch (e) {}
          }

          // Ant Design Table + /console/token 路径 → 多半是 NewAPI
          if (!type) {
            const hasAntTable = !!document.querySelector('.ant-table, .ant-pagination');
            const onConsole = /\/console(\/|$)/.test(location.pathname);
            if (hasAntTable && onConsole) {
              type = 'newapi';
              signals.push('antd-table+/console');
            }
          }

          if (requiredOrigin && String(location.origin || '').toLowerCase() !== requiredOrigin.toLowerCase()) {
            return { error: 'tab_origin_changed', origin: location.origin };
          }
          return {
            type,
            name: name || metaName || null,
            title: document.title || null,
            signals,
            href: location.href,
            origin: location.origin
          };
        }
      });
      return results?.[0]?.result || null;
    } catch (e) {
      return { error: String(e?.message || e) };
    }
  }

  function resolveInputUrl(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    const domain = root.normalizeDomain?.(raw);
    if (!domain) return null;
    let pageUrl = null;
    let origin = null;
    try {
      const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (u.protocol === 'https:') {
        origin = u.origin;
        pageUrl = u.origin + (u.pathname === '/' ? '/' : u.pathname);
      }
    } catch (e) {
      pageUrl = `https://${domain}/`;
    }
    return {
      domain,
      origin: origin || root.originFromDomain?.(domain) || `https://${domain}`,
      pageUrl: pageUrl || `https://${domain}/`
    };
  }

  async function detectSite(input, options = {}) {
    const resolved = resolveInputUrl(input);
    if (!resolved) return { ok: false, error: '无法解析域名，请输入 https 链接或域名' };

    const { domain, origin } = resolved;
    let preferredPage = resolved.pageUrl;
    const signals = [];
    let type = detectSiteTypeFromUrl(preferredPage);
    if (type) signals.push(`url → ${type}`);

    let name = root.truncateText?.(options.hintName, 60) || null;
    if (name && name.toLowerCase() === domain) name = null;

    let confidence = type ? 'medium' : 'low';
    let quotaMeta = {};

    if (options.tabId) {
      const pageProbe = await probeActiveTabPage(
        options.tabId,
        options.expectedOrigin || resolved.origin
      );
      if (pageProbe?.error === 'tab_origin_changed') {
        return { ok: false, code: 'tab_origin_changed', error: '当前标签页已离开目标站点，已停止识别' };
      }
      if (pageProbe?.error === 'expected_origin_required') {
        return { ok: false, code: 'expected_origin_required', error: '缺少站点 Origin，已停止识别' };
      }
      if (pageProbe && !pageProbe.error) {
        if (pageProbe.type) {
          type = pageProbe.type;
          confidence = 'high';
        }
        if (pageProbe.name) name = name || root.truncateText?.(pageProbe.name, 60);
        else if (pageProbe.title) {
          const t = root.truncateText?.(pageProbe.title, 60);
          if (t && t.toLowerCase() !== domain) name = name || t;
        }
        if (pageProbe.href) preferredPage = pageProbe.href;
        if (pageProbe.signals?.length) signals.push(...pageProbe.signals.map((s) => `tab:${s}`));
      }
    }

    if (!type || type === 'unknown' || !name || confidence !== 'high' || !quotaMeta.quotaPerUnit) {
      const netProbe = await probeSiteEndpoints(origin, options);
      if (netProbe.type && netProbe.type !== 'unknown') {
        if (!type || type === 'unknown' || netProbe.confidence === 'high') {
          type = netProbe.type;
          confidence = netProbe.confidence || confidence;
        }
      }
      if (netProbe.name) name = name || netProbe.name;
      if (netProbe.signals?.length) signals.push(...netProbe.signals.map((s) => `net:${s}`));
      if (netProbe.rawStatus) {
        quotaMeta = { ...quotaMeta, ...extractQuotaMeta(netProbe.rawStatus) };
      }
    }

    if (!type || type === 'unknown') {
      type = 'unknown';
      confidence = 'low';
    }

    const storedType = type === 'unknown' ? 'auto' : type;
    // 打开用 base；pageUrl 存稳定地址（根路径或当前安全路径）
    const pageUrl = pageUrlForType(domain, type === 'unknown' ? 'newapi' : type, preferredPage);
    const apiBaseUrl = type === 'sub2api' ? `${origin}/api/v1` : origin;

    return {
      ok: true,
      domain,
      name: name || domain,
      type: storedType,
      detectedType: type,
      typeLabel: typeLabel(type === 'unknown' ? 'unknown' : type),
      baseUrl: origin,
      pageUrl,
      apiBaseUrl,
      confidence,
      signals,
      quotaPerUnit: quotaMeta.quotaPerUnit || null,
      displayInCurrency: quotaMeta.displayInCurrency === true,
      summary: type === 'unknown'
        ? `已解析 ${domain}，未能确认架构（可手动选类型）`
        : `识别为 ${typeLabel(type)}（${confidence === 'high' ? '高' : confidence === 'medium' ? '中' : '低'}置信）`
    };
  }

  function applyDetectionToSite(partial, detection) {
    if (!detection?.ok) return partial;
    const next = { ...partial };
    // 保留业务分类（公益/中转），识别只改架构 type
    const keptCategory = partial?.category;
    if (detection.domain) next.domain = detection.domain;
    if (detection.name && (!next.name || next.name === next.domain || next.name === detection.domain)) {
      next.name = detection.name;
    }
    if (detection.baseUrl) next.baseUrl = detection.baseUrl;
    // pageUrl：仅在没有合理 base 时写入；优先 baseUrl 作打开地址
    if (detection.pageUrl) {
      const safe = String(detection.pageUrl);
      if (!/\/console\/personal|\/panel\/personal/i.test(safe)) {
        next.pageUrl = detection.pageUrl;
      } else if (detection.baseUrl) {
        next.pageUrl = detection.baseUrl;
      }
    }
    if (detection.type && detection.type !== 'auto') next.type = detection.type;
    else if (detection.detectedType && detection.detectedType !== 'unknown') next.type = detection.detectedType;
    if (detection.quotaPerUnit) next.quotaPerUnit = detection.quotaPerUnit;
    if (detection.displayInCurrency) next.displayInCurrency = true;
    if (keptCategory) next.category = keptCategory;
    return next;
  }

  root.TYPE_LABELS = TYPE_LABELS;
  root.typeLabel = typeLabel;
  root.detectSiteTypeFromUrl = detectSiteTypeFromUrl;
  root.pageUrlForType = pageUrlForType;
  root.pickNameFromStatus = pickNameFromStatus;
  root.isNewApiStatus = isNewApiStatus;
  root.isZenApiSiteInfo = isZenApiSiteInfo;
  root.probeSiteEndpoints = probeSiteEndpoints;
  root.detectSite = detectSite;
  root.applyDetectionToSite = applyDetectionToSite;
  root.resolveInputUrl = resolveInputUrl;
  root.extractQuotaMeta = extractQuotaMeta;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      TYPE_LABELS,
      typeLabel,
      detectSiteTypeFromUrl,
      pageUrlForType,
      pickNameFromStatus,
      isNewApiStatus,
      isZenApiSiteInfo,
      isSub2ApiPayload,
      detectSite,
      applyDetectionToSite,
      resolveInputUrl,
      extractQuotaMeta
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
