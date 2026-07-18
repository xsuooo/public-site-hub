(function (root) {
  const EXPORT_VERSION = 1;
  const APP_ID = 'public-site-hub';

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function assertRecoverableKeys(config) {
    if (!isPlainObject(config)) return;
    if (config.redacted === true || config.redaction === 'keys_masked' || config.redaction === 'share_safe') {
      throw new Error('这是脱敏安全分享列表，只能用于查看站点，不能恢复完整 API Key');
    }
    for (const site of Array.isArray(config.sites) ? config.sites : []) {
      for (const key of Array.isArray(site?.keys) ? site.keys : []) {
        if (key?.redacted === true) {
          throw new Error('导入内容包含脱敏 Key，不能作为可用凭据恢复');
        }
      }
    }
  }

  function safeNativeUrl(value, site) {
    const origin = typeof root.originForSite === 'function'
      ? root.originForSite(site)
      : root.originFromDomain?.(site?.domain || site);
    if (typeof root.normalizeHttpsUrl === 'function') {
      return root.normalizeHttpsUrl(value, origin) || origin || '';
    }
    return String(value || '').split(/[?#]/, 1)[0] || origin || '';
  }

  function safeCheckinPageUrl(site) {
    const rawDomain = String(site?.domain || '').trim().toLowerCase();
    const domain = typeof root.normalizeDomain === 'function'
      ? root.normalizeDomain(rawDomain)
      : rawDomain.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
    const origin = typeof root.originForSite === 'function'
      ? root.originForSite(site)
      : (domain ? `https://${domain}` : '');
    const fallback = origin ? `${origin}/` : '';
    return fallback;
  }

  function normalizeImportedSite(site) {
    if (!site || typeof site !== 'object') return null;
    try {
      return typeof root.normalizeSite === 'function' ? root.normalizeSite(site) : site;
    } catch (error) {
      return null;
    }
  }

  /**
   * @param {object[]} sites
   * @param {{ redactKeys?: boolean }} [options]
   *   redactKeys=true 时仅导出可分享的 Origin/名称/分类，不包含凭据、备注、标签或运行状态。
   */
  function buildExportConfig(sites, options = {}) {
    const redactKeys = options.redactKeys === true;
    const normalized = typeof root.dedupeSitesByOrigin === 'function'
      ? root.dedupeSitesByOrigin(sites)
      : (Array.isArray(sites) ? sites : []);
    if (redactKeys) {
      return {
        app: APP_ID,
        version: EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        redacted: true,
        redaction: 'share_safe',
        sites: normalized.map((site) => {
          const origin = typeof root.originForSite === 'function'
            ? root.originForSite(site)
            : safeNativeUrl(site.baseUrl, site);
          return {
            domain: site.domain,
            name: site.name,
            baseUrl: origin ? `${origin}/` : '',
            pageUrl: origin ? `${origin}/` : '',
            category: site.category || 'gongyi',
            type: site.type || 'auto'
          };
        })
      };
    }
    const config = {
      app: APP_ID,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      sites: normalized.map((site) => ({
        id: site.id,
        domain: site.domain,
        name: site.name,
        baseUrl: safeNativeUrl(site.baseUrl, site),
        pageUrl: safeNativeUrl(site.pageUrl, site),
        note: site.note || '',
        tags: Array.isArray(site.tags) ? site.tags.slice() : [],
        category: site.category || 'gongyi',
        type: site.type || 'auto',
        keys: (site.keys || []).map((k) => ({
          id: k.id,
          name: k.name,
          key: k.key,
          isDefault: k.isDefault === true,
          createdAt: k.createdAt
        })),
        balance: site.balance ?? null,
        usage: site.usage ?? null,
        balanceUpdatedAt: site.balanceUpdatedAt ?? null,
        balanceStatus: site.balanceStatus == null
          ? null
          : JSON.parse(JSON.stringify(site.balanceStatus)),
        checkinOptIn: site.checkinOptIn === true,
        checkinSync: site.checkinSync == null
          ? null
          : JSON.parse(JSON.stringify(site.checkinSync)),
        syncedToCheckinAt: site.syncedToCheckinAt ?? null,
        createdAt: site.createdAt,
        updatedAt: site.updatedAt
      }))
    };
    return config;
  }

  function buildCheckinExportConfig(sites) {
    const normalized = typeof root.dedupeSitesByOrigin === 'function'
      ? root.dedupeSitesByOrigin(sites)
      : (Array.isArray(sites) ? sites : []);
    return {
      sites: normalized.map((site) => {
        const item = {
          domain: site.domain,
          name: site.name,
          enabled: true,
          type: site.type && site.type !== 'auto' ? site.type : 'auto',
          // 签到扩展支持 group，用来带上公益/中转分类
          group: (typeof root.categoryLabel === 'function'
            ? root.categoryLabel(site.category)
            : (site.category === 'relay' ? '中转站' : '公益站'))
        };
        const pageUrl = safeCheckinPageUrl(site);
        if (pageUrl) item.pageUrl = pageUrl;
        return item;
      })
    };
  }

  function matchNative(config) {
    return isPlainObject(config)
      && Array.isArray(config.sites)
      && (config.app === APP_ID || config.version === EXPORT_VERSION || config.sites.some((s) => s?.keys || s?.baseUrl));
  }

  function matchCheckin(config) {
    return isPlainObject(config)
      && Array.isArray(config.sites)
      && config.app !== APP_ID
      && config.sites.every((s) => s && (s.domain || s.pageUrl) && !Array.isArray(s.keys));
  }

  function matchAllApiHub(config) {
    return isPlainObject(config) && Array.isArray(config?.accounts?.accounts);
  }

  function convertNative(config) {
    assertRecoverableKeys(config);
    const source = Array.isArray(config.sites) ? config.sites : [];
    const sites = source.map(normalizeImportedSite).filter(Boolean);
    return {
      sites,
      sourceCount: source.length,
      skipped: Math.max(0, source.length - sites.length)
    };
  }

  function convertCheckin(config) {
    const source = Array.isArray(config.sites) ? config.sites : [];
    const sites = source.map((site) => root.normalizeSite?.({
      domain: site.domain,
      name: site.name,
      pageUrl: site.pageUrl,
      baseUrl: site.pageUrl || site.domain,
      type: site.type,
      category: site.category || site.group,
      note: site.group || ''
    })).filter(Boolean);
    return {
      sites,
      sourceCount: source.length,
      skipped: Math.max(0, source.length - sites.length)
    };
  }

  function convertAllApiHub(config) {
    const accounts = config?.accounts?.accounts || [];
    let sites = [];
    let skipped = 0;
    for (const rawAccount of accounts) {
      if (!isPlainObject(rawAccount)) {
        skipped += 1;
        continue;
      }
      const account = rawAccount;
      const tokenItems = (Array.isArray(account.tokens) ? account.tokens
        : (Array.isArray(account.api_keys) ? account.api_keys : []))
        .filter(isPlainObject);
      const site = root.normalizeSite?.({
        domain: account.site_url || account.domain,
        name: account.site_name || account.name,
        baseUrl: account.site_url,
        pageUrl: account.site_url,
        type: account.site_type === 'new-api' ? 'newapi' : (account.site_type || 'auto'),
        note: account.notes || account.note || '',
        apiKey: account.token || account.access_token || account.api_key || account.key,
        keys: Array.isArray(account.tokens)
          ? tokenItems.map((t) => ({
            name: t.name || t.label || '导入',
            key: t.token || t.key || t.value
          }))
          : Array.isArray(account.api_keys)
            ? tokenItems.map((t) => ({
              name: t.name || t.label || '导入',
              key: t.key || t.token || t.value
            }))
            : undefined
      });
      if (!site) {
        skipped += 1;
        continue;
      }
      sites.push(site);
    }
    return { sites, sourceCount: accounts.length, skipped };
  }

  const adapters = [
    { name: 'native', match: matchNative, convert: convertNative },
    { name: 'all-api-hub', match: matchAllApiHub, convert: convertAllApiHub },
    { name: 'public-checkin', match: matchCheckin, convert: convertCheckin }
  ];

  function adaptImportConfig(config) {
    if (!isPlainObject(config)) return { sites: [], format: null };
    assertRecoverableKeys(config);

    if (matchNative(config) && (config.app === APP_ID || config.sites.some((s) => s?.keys || s?.baseUrl))) {
      return { ...convertNative(config), format: 'native' };
    }

    for (const adapter of adapters) {
      try {
        if (!adapter.match(config)) continue;
        const converted = adapter.convert(config);
        if (Array.isArray(converted?.sites)) {
          const sites = converted.sites.map(normalizeImportedSite).filter(Boolean);
          return {
            sites,
            sourceCount: Number(converted.sourceCount) || converted.sites.length,
            skipped: (Number(converted.skipped) || 0)
              + Math.max(0, converted.sites.length - sites.length),
            format: adapter.name
          };
        }
      } catch (e) {}
    }

    if (Array.isArray(config.sites)) {
      const sites = config.sites.map((s) => root.normalizeSite?.(s)).filter(Boolean);
      return {
        sites,
        sourceCount: config.sites.length,
        skipped: Math.max(0, config.sites.length - sites.length),
        format: 'sites'
      };
    }
    return { sites: [], format: null };
  }

  function parseImportText(text) {
    const raw = String(text || '').trim();
    if (!raw) throw new Error('空内容');
    let config;
    try {
      config = JSON.parse(raw);
    } catch (e) {
      throw new Error('JSON 解析失败');
    }
    const parsed = adaptImportConfig(config);
    if (!parsed.format) throw new Error('不支持的导入格式');
    return parsed;
  }

  root.EXPORT_VERSION = EXPORT_VERSION;
  root.APP_ID = APP_ID;
  root.buildExportConfig = buildExportConfig;
  root.buildCheckinExportConfig = buildCheckinExportConfig;
  root.adaptImportConfig = adaptImportConfig;
  root.parseImportText = parseImportText;
  root.matchAllApiHub = matchAllApiHub;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      EXPORT_VERSION,
      APP_ID,
      buildExportConfig,
      buildCheckinExportConfig,
      adaptImportConfig,
      parseImportText,
      matchAllApiHub
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
