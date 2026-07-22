(function (root) {
  function createId(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function truncateText(value, maxLength = 80) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
  }

  function normalizeDomain(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    try {
      const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      const domain = String(url.hostname || '').trim().toLowerCase();
      if (!domain || !domain.includes('.')) return null;
      if (!/^[a-z0-9.-]+$/.test(domain)) return null;
      return domain;
    } catch (e) {
      return null;
    }
  }

  function normalizeHttpsUrl(input, domain) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    try {
      const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (url.protocol !== 'https:') return null;
      if (domain) {
        const rawExpected = domain && typeof domain === 'object'
          ? originForSite(domain)
          : String(domain || '').trim();
        const enforceOrigin = typeof domain === 'object'
          || /^https?:\/\//i.test(rawExpected)
          || /:\d+(?:\/|$)/.test(rawExpected);
        if (enforceOrigin) {
          const expectedOrigin = originFromDomain(rawExpected);
          if (!expectedOrigin || url.origin.toLowerCase() !== expectedOrigin) return null;
        } else if (url.hostname.toLowerCase() !== String(domain).toLowerCase()) {
          return null;
        }
      }
      // 查询串和 hash 可能携带 token、授权码或临时会话信息，不进入本地站点数据。
      return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/$/, ''));
    } catch (e) {
      return null;
    }
  }

  function originFromDomain(domain) {
    const raw = String(domain || '').trim();
    if (!raw) return null;
    try {
      const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (url.protocol !== 'https:') return null;
      const host = String(url.hostname || '').trim().toLowerCase();
      if (!host || !host.includes('.') || !/^[a-z0-9.-]+$/.test(host)) return null;
      // 保留显式端口，避免权限/会话/余额请求把 :8443 等站点打到默认 443。
      return url.origin.toLowerCase();
    } catch (e) {
      const d = normalizeDomain(raw);
      return d ? `https://${d}` : null;
    }
  }

  function originForSite(value) {
    if (value && typeof value === 'object') return selectSiteOrigin(value);
    const candidates = [value];
    for (const candidate of candidates) {
      const origin = originFromDomain(candidate);
      if (origin) return origin;
    }
    return '';
  }

  // 站点历史数据有时同时保存了 baseUrl/pageUrl。若其中一个带有显式非默认
  // 端口，优先保留它，避免迁移时把 https://host:8443 重新绑定到 443。
  function selectSiteOrigin(site) {
    const values = site && typeof site === 'object'
      ? [site.baseUrl, site.site_url, site.pageUrl, site.domain]
      : [site];
    let origins = values.map(originFromDomain).filter(Boolean);
    if (!origins.length) return '';
    const declaredHost = site && typeof site === 'object'
      ? normalizeDomain(site.domain)
      : null;
    if (declaredHost) {
      const matching = origins.filter((origin) => {
        try { return new URL(origin).hostname.toLowerCase() === declaredHost; } catch (error) { return false; }
      });
      // URL 与显式 domain 冲突时，保守回到显式 domain；绝不把凭据绑定到外站。
      origins = matching.length ? matching : [originFromDomain(declaredHost)].filter(Boolean);
    }
    const explicit = origins.find((origin) => {
      try {
        return new URL(origin).port && new URL(origin).port !== '443';
      } catch (error) {
        return false;
      }
    });
    return explicit || origins[0];
  }

  function siteIdentity(value) {
    return originForSite(value).toLowerCase();
  }

  function formatApiBaseV1(site) {
    const origin = originForSite(site);
    return origin ? `${origin}/v1` : '';
  }

  function siteFromTab(tab = {}) {
    const pageUrl = String(tab.url || '').trim();
    if (!pageUrl || !/^https:\/\//i.test(pageUrl)) return null;

    let parsed;
    try {
      parsed = new URL(pageUrl);
    } catch (e) {
      return null;
    }

    const domain = normalizeDomain(parsed.hostname);
    if (!domain) return null;

    const title = truncateText(tab.title, 60);
    const name = title && !/^https?:\/\//i.test(title) ? title : domain;

    return {
      domain,
      name,
      baseUrl: parsed.origin,
      pageUrl: parsed.href,
      note: ''
    };
  }

  /** 清洗令牌显示名（站点上的 claude / cc 等） */
  function cleanTokenName(name) {
    const n = truncateText(String(name || '').trim(), 40);
    if (!n) return '';
    // 旧版占位名、无意义名
    if (/^(页面导入|page\s*import|导入|undefined|null|default|默认令牌)$/i.test(n)) return '';
    return n;
  }

  /** 自动读取到的值必须是完整 Key，不能把页面掩码当成可调用凭据保存。 */
  function isCompleteApiKey(value) {
    const key = String(value || '').trim();
    return key.length > 12
      && /^[A-Za-z0-9._~-]+$/.test(key)
      && !/\.{2,}/.test(key)
      && !/[•●○◦∙·…*]/.test(key);
  }

  function normalizeKey(entry = {}) {
    const key = String(entry.key || entry.token || entry.value || '').trim();
    if (!key) return null;
    const named = cleanTokenName(entry.name || entry.label || entry.token_name || entry.tokenName);
    return {
      id: String(entry.id || '').trim() || createId('key'),
      // 占位名（页面导入）丢弃，用「令牌」；有真实名用真实名
      name: named || '令牌',
      key,
      isDefault: entry.isDefault === true,
      createdAt: Number(entry.createdAt) || Date.now()
    };
  }

  /** 保证至多一个默认 Key；若都未标记则第一条为默认 */
  function ensureDefaultKeys(keys) {
    if (!Array.isArray(keys) || !keys.length) return [];
    const hasDefault = keys.some((k) => k && k.isDefault === true);
    if (!hasDefault) {
      return keys.map((k, i) => (k ? { ...k, isDefault: i === 0 } : k)).filter(Boolean);
    }
    let kept = false;
    return keys.map((k) => {
      if (!k) return null;
      if (k.isDefault && !kept) {
        kept = true;
        return { ...k, isDefault: true };
      }
      return { ...k, isDefault: false };
    }).filter(Boolean);
  }

  function getDefaultKey(site) {
    const keys = ensureDefaultKeys(site?.keys || []);
    const usable = keys.filter((key) => isCompleteApiKey(key?.key));
    // 掩码/残缺 Key 只能用于诊断展示，绝不作为调用凭据回退。
    return usable.find((key) => key.isDefault) || usable[0] || null;
  }

  function getDefaultKeyValue(site) {
    return getDefaultKey(site)?.key || '';
  }

  // 站点业务分类：公益站 vs 中转站（与架构 type 无关）
  const CATEGORY = {
    GONGYI: 'gongyi',
    RELAY: 'relay'
  };

  const CATEGORY_LABELS = {
    gongyi: '公益站',
    relay: '中转站'
  };

  function normalizeCategory(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'relay' || raw === 'zhongzhuan' || raw === '中转' || raw === '中转站') {
      return CATEGORY.RELAY;
    }
    if (raw === 'gongyi' || raw === '公益' || raw === '公益站' || raw === 'free' || raw === 'public') {
      return CATEGORY.GONGYI;
    }
    // 兼容旧备注/group 暗示
    if (/中转/.test(String(value || ''))) return CATEGORY.RELAY;
    if (/公益/.test(String(value || ''))) return CATEGORY.GONGYI;
    return CATEGORY.GONGYI; // 默认公益站
  }

  function categoryLabel(category) {
    const c = normalizeCategory(category);
    return CATEGORY_LABELS[c] || CATEGORY_LABELS.gongyi;
  }

  function normalizeTags(value) {
    const source = Array.isArray(value)
      ? value
      : String(value || '').split(/[，,\n]/);
    const seen = new Set();
    const tags = [];
    for (const entry of source) {
      const tag = truncateText(entry, 24);
      const key = tag.toLowerCase();
      if (!tag || seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
      if (tags.length >= 12) break;
    }
    return tags;
  }

  /** 打开站点用的稳定地址：永远优先站点根，避免 personal 深链 404 */
  function openUrlForSite(site) {
    if (!site) return '';
    const origin = originForSite(site);
    return origin ? `${origin}/` : '';
  }

  /** 令牌管理页（引导加 Key，不保证每站都有） */
  function tokenPageUrlForSite(site) {
    const origin = originForSite(site);
    if (!origin) return openUrlForSite(site);
    const type = site?.type || 'auto';
    if (type === 'sub2api') return `${origin}/`;
    if (type === 'zenapi') return `${origin}/user`;
    return `${origin}/console/token`;
  }

  function normalizeQuotaPerUnit(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    // 常见 500000；也有 1 / 1000 等
    if (n > 1e12) return null;
    return n;
  }

  const CHECKIN_SYNC_STATUSES = new Set(['idle', 'pending', 'sent', 'verified', 'failed', 'stale']);
  const BALANCE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

  function normalizeBalanceError(raw) {
    if (!raw) return null;
    if (typeof raw === 'string') {
      const message = truncateText(raw, 200);
      return message ? { code: 'refresh_failed', message } : null;
    }
    if (typeof raw !== 'object') return null;
    const message = truncateText(raw.message || raw.error || '', 200);
    if (!message) return null;
    const normalized = {
      code: truncateText(raw.code || 'refresh_failed', 40) || 'refresh_failed',
      message
    };
    const action = String(raw.action || '').trim();
    if (['open_site', 'open_token', 'redetect', 'retry_permission'].includes(action)) {
      normalized.action = action;
    }
    return normalized;
  }

  function normalizeBalanceStatus(raw, fallbackUpdatedAt = null) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const lastAttemptAt = Number(source.lastAttemptAt) || null;
    const lastSuccessAt = Number(source.lastSuccessAt) || Number(fallbackUpdatedAt) || null;
    const status = source.status === 'failed'
      ? 'failed'
      : (source.status === 'ok' || lastSuccessAt ? 'ok' : 'never');
    const normalized = { status };
    if (lastAttemptAt) normalized.lastAttemptAt = lastAttemptAt;
    if (lastSuccessAt) normalized.lastSuccessAt = lastSuccessAt;
    const lastError = normalizeBalanceError(source.lastError);
    if (lastError) normalized.lastError = lastError;
    return normalized;
  }

  function checkinFingerprint(site = {}) {
    const origin = siteIdentity(site);
    const domain = normalizeDomain(origin || site.domain || site.baseUrl || site.pageUrl) || '';
    const rawType = String(site.type || 'auto').trim().toLowerCase();
    const type = ['auto', 'newapi', 'sub2api', 'zenapi'].includes(rawType) ? rawType : 'auto';
    const rawPageUrl = String(site.pageUrl || '').trim();
    // 回退也必须剥离 query/hash，避免临时令牌进入指纹与完整导出。
    const safePageUrl = normalizeHttpsUrl(rawPageUrl, origin || domain)
      || (rawPageUrl ? rawPageUrl.split(/[?#]/, 1)[0] : '');
    return JSON.stringify([
      origin || domain,
      truncateText(site.name, 60),
      type,
      safePageUrl,
      normalizeCategory(site.category)
    ]);
  }

  function normalizeCheckinError(raw) {
    if (!raw) return null;
    if (typeof raw === 'string') {
      const message = truncateText(raw, 200);
      return message ? { code: 'unknown', message } : null;
    }
    if (typeof raw !== 'object') return null;
    const message = truncateText(raw.message || raw.error || '', 200);
    if (!message) return null;
    return {
      code: truncateText(raw.code || 'unknown', 40) || 'unknown',
      message
    };
  }

  function normalizeCheckinSync(rawSite = {}, normalizedSite = {}) {
    const raw = rawSite.checkinSync && typeof rawSite.checkinSync === 'object'
      ? rawSite.checkinSync
      : null;
    const legacySuccessAt = Number(rawSite.syncedToCheckinAt) || null;
    let status = normalizedSite.checkinOptIn !== true
      ? 'idle'
      : (raw && CHECKIN_SYNC_STATUSES.has(raw.status)
        ? raw.status
        : (legacySuccessAt ? 'sent' : 'pending'));
    let fingerprint = raw?.fingerprint || (!raw && legacySuccessAt ? checkinFingerprint(normalizedSite) : null);
    if ((status === 'sent' || status === 'verified') && !fingerprint) {
      fingerprint = checkinFingerprint(normalizedSite);
    }
    if ((status === 'sent' || status === 'verified')
      && fingerprint
      && fingerprint !== checkinFingerprint(normalizedSite)) {
      status = 'stale';
    }

    const sync = { status };
    const lastAttemptAt = Number(raw?.lastAttemptAt) || null;
    const lastSuccessAt = Number(raw?.lastSuccessAt) || legacySuccessAt;
    const lastVerifiedAt = Number(raw?.lastVerifiedAt) || null;
    if (lastAttemptAt) sync.lastAttemptAt = lastAttemptAt;
    if (lastSuccessAt) sync.lastSuccessAt = lastSuccessAt;
    if (lastVerifiedAt) sync.lastVerifiedAt = lastVerifiedAt;
    const lastError = normalizeCheckinError(raw?.lastError);
    if (lastError) sync.lastError = lastError;
    if (raw?.targetVersion != null) sync.targetVersion = truncateText(raw.targetVersion, 40);
    if (fingerprint) sync.fingerprint = fingerprint;
    return sync;
  }

  function checkinStatusMeta(status) {
    const meta = {
      idle: { label: '未启用', tone: 'muted', action: '启用同步' },
      pending: { label: '待同步', tone: 'warning', action: '立即同步' },
      sent: { label: '已发送', tone: 'info', action: '验证同步' },
      verified: { label: '已同步', tone: 'success', action: '' },
      failed: { label: '同步失败', tone: 'danger', action: '重新同步' },
      stale: { label: '需重新同步', tone: 'warning', action: '重新同步' }
    };
    return meta[status] || meta.idle;
  }

  /**
   * 收藏视图只关心余额运行状态；Key 是可选凭据。保留 includeCheckin 是为了兼容旧数据诊断调用。
   */
  function deriveSiteHealth(site = {}, { includeCheckin = true } = {}) {
    if (includeCheckin) {
      const status = site.checkinSync?.status;
      if (status === 'failed') return { level: 'failed', label: '同步失败', tone: 'danger' };
      if (['pending', 'sent', 'stale'].includes(status)) {
        return { level: 'needsAttention', label: '需要处理', tone: 'warning' };
      }
    }
    // Key 是可选凭据，不应把“未配置 Key”当成站点健康问题；
    // 余额失败/未查询/过期等运行状态仍然照常展示。
    const balanceStatus = normalizeBalanceStatus(site.balanceStatus, site.balanceUpdatedAt);
    if (balanceStatus.status === 'failed') {
      return { level: 'failed', label: '余额失败', tone: 'danger' };
    }
    if (!balanceStatus.lastSuccessAt) {
      return { level: 'needsAttention', label: '需要处理', tone: 'warning' };
    }
    if (Date.now() - balanceStatus.lastSuccessAt > BALANCE_STALE_AFTER_MS) {
      return { level: 'needsAttention', label: '余额待刷新', tone: 'warning' };
    }
    return { level: 'healthy', label: '健康', tone: 'success' };
  }

  function filterSitesByHealth(sites, health) {
    const list = Array.isArray(sites) ? sites : [];
    const level = String(health || 'all');
    if (level === 'all') return list.slice();
    if (!['healthy', 'needsAttention', 'failed'].includes(level)) return list.slice();
    return list.filter((site) => deriveSiteHealth(site).level === level);
  }

  function normalizeSite(site = {}) {
    if (!site || typeof site !== 'object') return null;
    const origin = selectSiteOrigin(site);
    const domain = normalizeDomain(origin);
    if (!origin || !domain) return null;

    const baseUrl = normalizeHttpsUrl(site.baseUrl, origin)
      || normalizeHttpsUrl(site.site_url, origin)
      || origin;

    // pageUrl：过滤明显 personal 深链，避免存进库后「打开」404
    let pageUrl = normalizeHttpsUrl(site.pageUrl, origin)
      || normalizeHttpsUrl(site.site_url, origin)
      || baseUrl;
    try {
      const pu = new URL(pageUrl);
      if (/\/console\/personal\/?$/i.test(pu.pathname) || /\/panel\/personal\/?$/i.test(pu.pathname)) {
        pageUrl = baseUrl || origin;
      }
    } catch (e) {}

    let keys = Array.isArray(site.keys)
      ? site.keys.map(normalizeKey).filter(Boolean)
      : [];

    if (!keys.length) {
      const single = normalizeKey({
        name: '默认',
        key: site.apiKey || site.token || site.access_token || site.key,
        isDefault: true
      });
      if (single) keys.push(single);
    }
    keys = ensureDefaultKeys(keys);

    const type = ['auto', 'newapi', 'sub2api', 'zenapi'].includes(site.type)
      ? site.type
      : (site.site_type === 'new-api' ? 'newapi' : 'auto');

    const category = normalizeCategory(
      site.category || site.kind || site.group || site.site_category
    );

    const quotaPerUnit = normalizeQuotaPerUnit(
      site.quotaPerUnit ?? site.quota_per_unit
    );

    const normalized = {
      id: String(site.id || '').trim() || createId('site'),
      domain,
      name: truncateText(site.name || site.site_name, 60) || domain,
      baseUrl,
      pageUrl,
      note: truncateText(site.note || site.remark || '', 200),
      tags: normalizeTags(site.tags ?? site.labels ?? site.tag),
      category,
      type,
      keys,
      balance: site.balance != null ? String(site.balance) : null,
      usage: site.usage != null ? String(site.usage) : null,
      balanceUpdatedAt: Number(site.balanceUpdatedAt) || null,
      balanceStatus: normalizeBalanceStatus(site.balanceStatus, site.balanceUpdatedAt),
      createdAt: Number(site.createdAt) || Date.now(),
      updatedAt: Number(site.updatedAt) || Date.now()
    };

    if (quotaPerUnit != null) normalized.quotaPerUnit = quotaPerUnit;
    if (site.displayInCurrency === true || site.display_in_currency === true) {
      normalized.displayInCurrency = true;
    }
    if (site.detectSummary) normalized.detectSummary = truncateText(site.detectSummary, 200);
    if (site.detectConfidence) normalized.detectConfidence = String(site.detectConfidence).slice(0, 20);
    if (site.detectedType) normalized.detectedType = String(site.detectedType).slice(0, 20);
    if (site.syncedToCheckinAt) normalized.syncedToCheckinAt = Number(site.syncedToCheckinAt) || null;

    // 用户明确标记「要签到」才参与批量同步（公益/中转均可，不按分类一刀切）
    normalized.checkinOptIn = site.checkinOptIn === true || site.enableCheckin === true;
    normalized.checkinSync = normalizeCheckinSync(site, normalized);

    return normalized;
  }

  /**
   * 是否可推到签到：只看用户是否 opt-in。
   * 公益、中转都可能能签到，不按分类拦截。
   */
  function isCheckinEligible(site, { requireOptIn = true } = {}) {
    if (!site?.domain) return false;
    if (requireOptIn && site.checkinOptIn !== true) return false;
    return true;
  }

  function mergeSitePair(previous, incoming, preferIncoming) {
    const kept = preferIncoming ? incoming : previous;
    const other = preferIncoming ? previous : incoming;
    const keyMap = new Map();
    for (const key of [...(other.keys || []), ...(kept.keys || [])]) {
      if (key?.key) keyMap.set(key.key, key);
    }
    const preferType = (primary, fallback) => {
      if (primary && primary !== 'auto') return primary;
      if (fallback && fallback !== 'auto') return fallback;
      return primary || fallback || 'auto';
    };
    const preferName = (primary, fallback, domain) => {
      const first = String(primary || '').trim();
      const second = String(fallback || '').trim();
      if (first && first !== domain) return first;
      if (second && second !== domain) return second;
      return first || second || domain;
    };
    const merged = normalizeSite({
      ...other,
      ...kept,
      id: previous.id || kept.id || other.id,
      type: preferType(kept.type, other.type),
      name: preferName(kept.name, other.name, kept.domain),
      note: kept.note || other.note || '',
      tags: normalizeTags([...(other.tags || []), ...(kept.tags || [])]),
      keys: ensureDefaultKeys(Array.from(keyMap.values())),
      balance: kept.balance ?? other.balance ?? null,
      usage: kept.usage ?? other.usage ?? null,
      balanceUpdatedAt: Math.max(kept.balanceUpdatedAt || 0, other.balanceUpdatedAt || 0) || null,
      balanceStatus: (Number(kept.balanceStatus?.lastAttemptAt || kept.balanceStatus?.lastSuccessAt || 0)
        >= Number(other.balanceStatus?.lastAttemptAt || other.balanceStatus?.lastSuccessAt || 0))
        ? kept.balanceStatus
        : other.balanceStatus,
      createdAt: Math.min(kept.createdAt || Date.now(), other.createdAt || Date.now()),
      updatedAt: Math.max(kept.updatedAt || 0, other.updatedAt || 0) || Date.now()
    });
    if (!merged) return previous;
    merged.id = previous.id || merged.id;
    return merged;
  }

  function dedupeSitesByOrigin(sites) {
    if (!Array.isArray(sites)) return [];
    const indexes = new Map();
    const out = [];
    for (const raw of sites) {
      const site = normalizeSite(raw);
      const identity = siteIdentity(site);
      if (!site || !identity) continue;
      const index = indexes.get(identity);
      if (index == null) {
        indexes.set(identity, out.length);
        out.push(site);
      } else {
        out[index] = mergeSitePair(out[index], site, false);
      }
    }
    return ensureUniqueSiteIds(out);
  }

  function ensureUniqueSiteIds(sites) {
    const used = new Set();
    return (Array.isArray(sites) ? sites : []).map((site) => {
      const next = { ...site };
      next.id = reserveUniqueSiteId(next.id, used);
      return next;
    });
  }

  function reserveUniqueSiteId(candidate, used) {
    let id = String(candidate || '').trim() || createId('site');
    if (used.has(id)) {
      const base = id;
      let suffix = 2;
      do {
        id = `${base}_${suffix++}`;
      } while (used.has(id));
    }
    used.add(id);
    return id;
  }

  // 旧 API 名保留给历史调用方，实际身份已是完整 Origin。
  function dedupeSitesByDomain(sites) {
    return dedupeSitesByOrigin(sites);
  }

  function filterSitesByQuery(sites, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return Array.isArray(sites) ? sites.slice() : [];
    return (sites || []).filter((site) => {
      const hay = [
        site.name,
        site.domain,
        site.baseUrl,
        site.pageUrl,
        site.note,
        ...(site.tags || []),
        site.category,
        categoryLabel(site.category),
        ...(site.keys || []).map((k) => k.name)
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  /** categoryFilter: 'all' | 'gongyi' | 'relay' */
  function filterSitesByCategory(sites, categoryFilter) {
    const list = Array.isArray(sites) ? sites : [];
    const f = String(categoryFilter || 'all').trim().toLowerCase();
    if (!f || f === 'all') return list.slice();
    const want = normalizeCategory(f);
    return list.filter((s) => normalizeCategory(s.category) === want);
  }

  /** tagFilter: 'all' | 具体标签（大小写不敏感） */
  function filterSitesByTag(sites, tagFilter) {
    const list = Array.isArray(sites) ? sites : [];
    const want = String(tagFilter || '').trim().toLowerCase();
    if (!want || want === 'all') return list.slice();
    return list.filter((site) => (site.tags || []).some(
      (tag) => String(tag || '').trim().toLowerCase() === want
    ));
  }

  /** 按出现次数收集标签，供弹窗筛选条使用 */
  function collectSiteTags(sites, { limit = 16 } = {}) {
    const counts = new Map();
    for (const site of sites || []) {
      for (const entry of site.tags || []) {
        const tag = truncateText(entry, 24);
        if (!tag) continue;
        const key = tag.toLowerCase();
        const prev = counts.get(key);
        if (prev) prev.count += 1;
        else counts.set(key, { tag, count: 1 });
      }
    }
    const max = Math.max(1, Number(limit) || 16);
    return Array.from(counts.values())
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh'))
      .slice(0, max);
  }

  function filterSites(sites, { query = '', category = 'all', tag = 'all' } = {}) {
    return filterSitesByQuery(
      filterSitesByTag(filterSitesByCategory(sites, category), tag),
      query
    );
  }

  function mergeSites(existing, incoming, { preferIncoming = false } = {}) {
    const map = new Map();
    const usedIds = new Set();
    for (const site of Array.isArray(existing) ? existing : []) {
      const normalized = normalizeSite(site);
      const identity = siteIdentity(normalized);
      if (!normalized || !identity) continue;
      const previous = map.get(identity);
      if (previous) {
        map.set(identity, mergeSitePair(previous, normalized, false));
      } else {
        normalized.id = reserveUniqueSiteId(normalized.id, usedIds);
        map.set(identity, normalized);
      }
    }
    for (const site of Array.isArray(incoming) ? incoming : []) {
      const raw = normalizeSite(site);
      const identity = siteIdentity(raw);
      if (!raw || !identity) continue;
      const prev = map.get(identity);
      if (!prev) {
        raw.id = reserveUniqueSiteId(raw.id, usedIds);
        map.set(identity, raw);
        continue;
      }
      map.set(identity, mergeSitePair(prev, raw, preferIncoming));
    }
    return Array.from(map.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function maskKey(key) {
    const value = String(key || '');
    if (value.length <= 8) return '••••';
    return `${value.slice(0, 4)}…${value.slice(-4)}`;
  }

  root.createId = createId;
  root.truncateText = truncateText;
  root.normalizeDomain = normalizeDomain;
  root.normalizeHttpsUrl = normalizeHttpsUrl;
  root.originFromDomain = originFromDomain;
  root.originForSite = originForSite;
  root.selectSiteOrigin = selectSiteOrigin;
  root.siteIdentity = siteIdentity;
  root.formatApiBaseV1 = formatApiBaseV1;
  root.siteFromTab = siteFromTab;
  root.cleanTokenName = cleanTokenName;
  root.isCompleteApiKey = isCompleteApiKey;
  root.normalizeKey = normalizeKey;
  root.ensureDefaultKeys = ensureDefaultKeys;
  root.getDefaultKey = getDefaultKey;
  root.getDefaultKeyValue = getDefaultKeyValue;
  root.CATEGORY = CATEGORY;
  root.CATEGORY_LABELS = CATEGORY_LABELS;
  root.normalizeCategory = normalizeCategory;
  root.categoryLabel = categoryLabel;
  root.normalizeTags = normalizeTags;
  root.openUrlForSite = openUrlForSite;
  root.tokenPageUrlForSite = tokenPageUrlForSite;
  root.normalizeQuotaPerUnit = normalizeQuotaPerUnit;
  root.CHECKIN_SYNC_STATUSES = CHECKIN_SYNC_STATUSES;
  root.BALANCE_STALE_AFTER_MS = BALANCE_STALE_AFTER_MS;
  root.normalizeBalanceError = normalizeBalanceError;
  root.normalizeBalanceStatus = normalizeBalanceStatus;
  root.checkinFingerprint = checkinFingerprint;
  root.normalizeCheckinError = normalizeCheckinError;
  root.normalizeCheckinSync = normalizeCheckinSync;
  root.checkinStatusMeta = checkinStatusMeta;
  root.deriveSiteHealth = deriveSiteHealth;
  root.filterSitesByHealth = filterSitesByHealth;
  root.normalizeSite = normalizeSite;
  root.isCheckinEligible = isCheckinEligible;
  root.dedupeSitesByDomain = dedupeSitesByDomain;
  root.dedupeSitesByOrigin = dedupeSitesByOrigin;
  root.filterSitesByQuery = filterSitesByQuery;
  root.filterSitesByCategory = filterSitesByCategory;
  root.filterSitesByTag = filterSitesByTag;
  root.collectSiteTags = collectSiteTags;
  root.filterSites = filterSites;
  root.mergeSites = mergeSites;
  root.ensureUniqueSiteIds = ensureUniqueSiteIds;
  root.maskKey = maskKey;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      createId,
      truncateText,
      normalizeDomain,
      normalizeHttpsUrl,
      originFromDomain,
      originForSite,
      selectSiteOrigin,
      siteIdentity,
      formatApiBaseV1,
      siteFromTab,
      cleanTokenName,
      isCompleteApiKey,
      normalizeKey,
      ensureDefaultKeys,
      getDefaultKey,
      getDefaultKeyValue,
      CATEGORY,
      CATEGORY_LABELS,
      normalizeCategory,
      categoryLabel,
      normalizeTags,
      openUrlForSite,
      tokenPageUrlForSite,
      normalizeQuotaPerUnit,
      CHECKIN_SYNC_STATUSES,
      BALANCE_STALE_AFTER_MS,
      normalizeBalanceError,
      normalizeBalanceStatus,
      checkinFingerprint,
      normalizeCheckinError,
      normalizeCheckinSync,
      checkinStatusMeta,
      deriveSiteHealth,
      filterSitesByHealth,
      normalizeSite,
      isCheckinEligible,
      dedupeSitesByDomain,
      dedupeSitesByOrigin,
      filterSitesByQuery,
      filterSitesByCategory,
      filterSitesByTag,
      collectSiteTags,
      filterSites,
      mergeSites,
      ensureUniqueSiteIds,
      maskKey
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
