/**
 * Key 自动导入 / 合并 / 自动获取（依赖 storage、page-scrape、tab-api-key 等全局）。
 */
(function (root) {
  function siteOriginFor(value) {
    if (typeof root.siteIdentity === 'function') return root.siteIdentity(value) || '';
    if (typeof root.originForSite === 'function') return root.originForSite(value) || '';
    const raw = value && typeof value === 'object'
      ? (value.baseUrl || value.pageUrl || value.domain)
      : value;
    try {
      const text = String(raw || '').trim();
      const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
      return url.protocol === 'https:' ? url.origin.toLowerCase() : '';
    } catch (error) {
      return '';
    }
  }

  function sameSiteOrigin(a, b) {
    const left = siteOriginFor(a);
    const right = siteOriginFor(b);
    return Boolean(left && right && left === right);
  }

/**
 * 用户已打开该站时：从会话拉完整 sk- 写入站点（不改标签 URL）
 */
async function tryAutoImportKeys(site, preferredTabId = null) {
  if (!site?.id || !site.domain) return { added: 0, skipped: true };
  const expectedOrigin = siteOriginFor(site);
  const session = await readPageAuthSession(site.domain, expectedOrigin, preferredTabId);
  if (!session.tabId) return { added: 0, skipped: true, reason: 'no-tab' };

  const options = {
    quotaPerUnit: site.quotaPerUnit,
    readFullTokenKeys: false,
    expectedOrigin
  };
  if (site.type === 'newapi') {
    const identity = typeof verifyNewApiTabAccount === 'function'
      ? await verifyNewApiTabAccount(session.tabId, session, expectedOrigin)
      : { ok: false, code: 'account_verify_failed' };
    if (!identity?.ok) {
      return { added: 0, found: 0, skipped: true, reason: identity?.code || 'account_verify_failed' };
    }
    options.authHeaders = identity.headers || {};
    options.readFullTokenKeys = true;
  }

  const scraped = typeof scrapeTabBalanceAndKeys === 'function'
    ? await scrapeTabBalanceAndKeys(session.tabId, site.type || 'auto', options)
    : { trustedKeys: [] };

  const keys = scraped.trustedKeys || [];
  if (!keys.length) return { added: 0, found: 0 };

  return persistScrapedKeys(site.id, expectedOrigin, keys);
}

/**
 * 合并扫到的 Key。
 * keys: string | { name, key, suffix }[]
 * - 有完整 key：新增或按 key 更新名称（claude/cc）
 * - 仅有 name：按顺序回填已有「令牌/页面导入/默认」占位名
 * - 仅有 suffix：按 sk 后缀匹配改名
 */
async function mergeScrapedKeys(site, keys) {
  if (!Array.isArray(keys) || !keys.length) return site;
  const clean = typeof cleanTokenName === 'function'
    ? cleanTokenName
    : (n) => {
      const t = String(n || '').trim();
      if (/^(页面导入|令牌|默认)$/i.test(t)) return '';
      return t;
    };
  const isPlaceholder = (n) => !n || /^(页面导入|令牌\d*|默认)$/i.test(String(n).trim());
  const isComplete = typeof isCompleteApiKey === 'function'
    ? isCompleteApiKey
    : (value) => {
      const key = String(value || '').trim();
      return key.length > 12
        && /^[A-Za-z0-9._~-]+$/.test(key)
        && !/\.{2,}/.test(key)
        && !/[•●○◦∙·…*]/.test(key);
    };

  const incoming = [];
  const namesOnly = [];
  for (const raw of keys) {
    if (!raw) continue;
    if (typeof raw === 'string') {
      if (isComplete(raw)) incoming.push({ key: raw, name: '' });
      continue;
    }
    const key = String(raw.key || raw.token || raw.api_key || '').trim();
    const name = clean(raw.name || raw.label || raw.token_name || raw.tokenName || '');
    const suffix = String(raw.suffix || '').replace(/\W/g, '').slice(-8);
    if (isComplete(key)) {
      incoming.push({ key, name, suffix: key.slice(-6) });
    } else if (name && suffix) {
      incoming.push({ key: '', name, suffix });
    } else if (name) {
      namesOnly.push(name);
    }
  }

  let changed = false;
  if (!site.keys) site.keys = [];
  const byKey = new Map(site.keys.map((k) => [k.key, k]));

  for (const { key, name, suffix } of incoming) {
    if (key) {
      const prev = byKey.get(key);
      if (prev) {
        if (name && (isPlaceholder(prev.name) || prev.name !== name)) {
          prev.name = name;
          changed = true;
        }
        continue;
      }
      const entry = typeof normalizeKey === 'function'
        ? normalizeKey({
          name: name || `令牌${site.keys.length + 1}`,
          key,
          isDefault: !site.keys.length
        })
        : {
          id: `key_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name: name || '令牌',
          key,
          isDefault: !site.keys.length,
          createdAt: Date.now()
        };
      if (!entry) continue;
      // normalizeKey 会把空名变成「令牌」；有真实名则强制写回
      if (name) entry.name = name;
      site.keys.push(entry);
      byKey.set(key, entry);
      changed = true;
      continue;
    }
    // 仅后缀+名称：对齐已有完整 key
    if (name && suffix && suffix.length >= 4) {
      for (const prev of site.keys) {
        if (!prev?.key) continue;
        if (prev.key.endsWith(suffix) || prev.key.slice(-6) === suffix.slice(-6)) {
          if (isPlaceholder(prev.name) || prev.name !== name) {
            prev.name = name;
            changed = true;
          }
          break;
        }
      }
    }
  }

  // 仅名称列表：按顺序回填占位名（站点上 claude/cc，库里却是「令牌」）
  if (namesOnly.length) {
    const placeholders = site.keys.filter((k) => isPlaceholder(k.name));
    const count = Math.min(namesOnly.length, placeholders.length || site.keys.length);
    if (placeholders.length && placeholders.length === namesOnly.length) {
      placeholders.forEach((k, i) => {
        if (namesOnly[i] && k.name !== namesOnly[i]) {
          k.name = namesOnly[i];
          changed = true;
        }
      });
    } else if (site.keys.length === namesOnly.length) {
      site.keys.forEach((k, i) => {
        if (namesOnly[i] && isPlaceholder(k.name)) {
          k.name = namesOnly[i];
          changed = true;
        }
      });
    } else if (placeholders.length && namesOnly.length) {
      // 数量不完全一致：尽量给占位项按序命名
      placeholders.forEach((k, i) => {
        if (namesOnly[i] && k.name !== namesOnly[i]) {
          k.name = namesOnly[i];
          changed = true;
        }
      });
    }
    void count;
  }

  // 有 name+key 的 incoming 已处理；把 namesOnly 里多余的且尚未用过的也按序补
  if (namesOnly.length && incoming.some((i) => i.key && !i.name)) {
    let ni = 0;
    for (const prev of site.keys) {
      if (isPlaceholder(prev.name) && namesOnly[ni]) {
        prev.name = namesOnly[ni];
        ni += 1;
        changed = true;
      }
    }
  }

  if (changed && typeof ensureDefaultKeys === 'function') {
    site.keys = ensureDefaultKeys(site.keys);
  }
  return site;
}

async function persistScrapedKeys(siteId, expectedOrigin, keys) {
  let status = { added: 0, found: Array.isArray(keys) ? keys.length : 0 };
  const apply = async (sites) => {
    const target = sites.find((site) => site.id === siteId);
    if (!target) {
      status = { ...status, skipped: true, reason: 'site_not_found' };
      return sites;
    }
    if (!sameSiteOrigin(target, expectedOrigin)) {
      status = { ...status, skipped: true, reason: 'site_domain_changed' };
      return sites;
    }
    const before = (target.keys || []).length;
    await mergeScrapedKeys(target, keys);
    status = { ...status, added: (target.keys || []).length - before, site: target };
    return sites;
  };

  const saved = typeof mutateSites === 'function'
    ? await mutateSites(apply)
    : await apply(await loadSites()).then(saveSites);
  const site = saved.find((item) => item.id === siteId) || status.site;
  return { ...status, site };
}

async function persistBalanceResult(site, result, options = {}) {
  const expectedOrigin = siteOriginFor(site);
  const expectedAttemptId = String(options?.attemptId || '').trim();
  let persistedSite = null;
  let rejected = false;
  const apply = async (sites) => {
    const target = sites.find((item) => item.id === site?.id);
    if (!target || !sameSiteOrigin(target, expectedOrigin)) {
      rejected = true;
      return sites;
    }
    if (expectedAttemptId && typeof root.isBalanceRefreshAttemptCurrent === 'function') {
      const isCurrent = await root.isBalanceRefreshAttemptCurrent(
        site.id,
        expectedOrigin,
        expectedAttemptId
      );
      if (!isCurrent) {
        rejected = true;
        return sites;
      }
    }

    // 只回填刷新流程实际产生的字段；用户在刷新期间修改的备注、分类等保持不动。
    if ((!target.type || target.type === 'auto') && site.type && site.type !== 'auto') {
      target.type = site.type;
      if (site.name && target.name === target.domain) target.name = site.name;
      if (site.detectSummary) target.detectSummary = site.detectSummary;
      if (site.detectConfidence) target.detectConfidence = site.detectConfidence;
    }
    // 余额抓取返回的 page-text keys 只能用于诊断；仅持久化可信来源 Key。
    const trustedKeys = Array.isArray(result?.trustedKeys) ? result.trustedKeys : [];
    if (trustedKeys.length) await mergeScrapedKeys(target, trustedKeys);
    if (result?.ok) recordBalanceSuccess(target, result);
    else recordBalanceFailure(target, result?.error, result?.code);
    persistedSite = target;
    return sites;
  };

  const saved = typeof mutateSites === 'function'
    ? await mutateSites(apply)
    : await apply(await loadSites()).then(saveSites);
  if (rejected) return null;
  return saved.find((item) => item.id === site?.id) || persistedSite || site;
}

const keyProvisionService = typeof createKeyProvisionService === 'function'
  && typeof loadSites === 'function'
  && typeof saveSites === 'function'
  ? createKeyProvisionService({
    loadSites,
    saveSites,
    mutateSites: typeof mutateSites === 'function' ? mutateSites : undefined,
    tryAcquireSiteOperation: typeof root.tryAcquireSiteOperation === 'function'
      ? root.tryAcquireSiteOperation
      : undefined,
    readSession: (domain, site) => readPageAuthSession(domain, siteOriginFor(site || { domain })),
    verify: (tabId, session, site) => (typeof verifyNewApiTabAccount === 'function'
      ? verifyNewApiTabAccount(tabId, session, siteOriginFor(site))
      : { ok: false, code: 'account_verify_failed', error: '无法验证当前登录账号' }),
    scan: (tabId, site, identity) => {
      if (typeof scrapeTabBalanceAndKeys !== 'function') {
        return { ok: false, keys: [], trustedKeys: [], tokenListState: 'unsupported' };
      }
      const options = {
        quotaPerUnit: site.quotaPerUnit,
        readFullTokenKeys: true,
        expectedOrigin: siteOriginFor(site)
      };
      if (identity?.headers && typeof identity.headers === 'object') {
        options.authHeaders = identity.headers;
      }
      return scrapeTabBalanceAndKeys(tabId, site.type || 'auto', options);
    },
    create: async (tabId, site, options) => {
      if (typeof createTabApiKey !== 'function') {
        return { ok: false, code: 'unsupported_site_type', error: '当前站点不支持自动创建 Key' };
      }
      let unlimitedQuota = false;
      try {
        const prefs = typeof loadPrefs === 'function' ? await loadPrefs() : {};
        unlimitedQuota = prefs?.preferUnlimitedAutoKey === true;
      } catch (error) {
        unlimitedQuota = false;
      }
      return createTabApiKey(tabId, site.type || 'auto', {
        ...options,
        expectedOrigin: siteOriginFor(site),
        unlimitedQuota,
        // 默认约 $10（quota_per_unit=500000 时）+ 90 天；无限模式由 prefs 打开
        remainQuota: unlimitedQuota ? 0 : 5_000_000,
        expireDays: unlimitedQuota ? 0 : 90
      });
    },
    merge: mergeScrapedKeys
  })
  : null;

async function ensureSiteKey(siteId, options = {}) {
  if (!keyProvisionService) {
    return { ok: false, code: 'provision_unavailable', error: '自动获取 Key 当前不可用' };
  }
  const site = (await loadSites()).find((item) => item.id === siteId);
  if (!site) return { ok: false, code: 'site_not_found', error: '站点不存在' };
  const access = await ensureAccessForSite(site, { request: false });
  if (!access.ok) return access;
  return keyProvisionService.ensureSiteKey(siteId, options);
}
  root.tryAutoImportKeys = tryAutoImportKeys;
  root.siteOriginForKeyImport = siteOriginFor;
  root.mergeScrapedKeys = mergeScrapedKeys;
  root.persistScrapedKeys = persistScrapedKeys;
  root.persistBalanceResult = persistBalanceResult;
  root.ensureSiteKey = ensureSiteKey;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      tryAutoImportKeys,
      siteOriginFor,
      mergeScrapedKeys,
      persistScrapedKeys,
      persistBalanceResult,
      ensureSiteKey
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
