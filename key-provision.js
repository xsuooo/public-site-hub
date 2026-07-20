(function (root) {
  function isCompleteKey(value) {
    if (typeof root.isCompleteApiKey === 'function') return root.isCompleteApiKey(value);
    const key = String(value || '').trim();
    return key.length > 12
      && /^[A-Za-z0-9._~-]+$/.test(key)
      && !/\.{2,}/.test(key)
      && !/[•●○◦∙·…*]/.test(key);
  }

  function hasCompleteKey(site) {
    return Array.isArray(site?.keys) && site.keys.some((item) => isCompleteKey(item?.key));
  }

  function comparableOrigin(value) {
    if (typeof root.siteIdentity === 'function') return root.siteIdentity(value) || '';
    if (typeof root.originForSite === 'function') return root.originForSite(value) || '';
    const rawValue = value && typeof value === 'object'
      ? (value.baseUrl || value.pageUrl || value.domain)
      : value;
    const raw = String(rawValue || '').trim();
    if (!raw) return '';
    try {
      const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      return url.protocol === 'https:' ? url.origin.toLowerCase() : '';
    } catch (error) {
      return '';
    }
  }

  function createAutoKeyName(now = Date.now) {
    const stamp = new Date(now()).toISOString()
      .replace(/[-:TZ.]/g, '')
      .slice(0, 14);
    const suffix = Math.random().toString(36).slice(2, 7);
    return `公益站收藏-${stamp}-${suffix}`;
  }

  function tokenStateError(state) {
    const messages = {
      'with-tokens': '站点已有 Key，但未能读取完整值；请在令牌页复制后手动添加',
      unavailable: '无法确认站点的 Key 列表；请先登录令牌页后重试',
      unsupported: '该站暂不支持自动创建 Key，可打开令牌页手动创建'
    };
    return messages[state] || '无法安全确认站点是否已有 Key；未创建新 Key';
  }

  function createKeyProvisionService(deps = {}) {
    const loadSites = deps.loadSites;
    const saveSites = deps.saveSites;
    const mutateSites = deps.mutateSites;
    const readSession = deps.readSession;
    const verify = deps.verify;
    const scan = deps.scan;
    const create = deps.create;
    const merge = deps.merge;
    const makeName = deps.makeName || createAutoKeyName;
    const tryAcquireSiteOperation = deps.tryAcquireSiteOperation;
    const inFlight = new Map();

    async function persistCandidates(siteId, candidates, expectedOrigin) {
      if (typeof mutateSites === 'function') {
        let failure = null;
        let before = 0;
        let target = null;
        const sites = await mutateSites(async (latestSites) => {
          const list = Array.isArray(latestSites) ? latestSites : [];
          const index = list.findIndex((site) => String(site?.id) === String(siteId));
          if (index < 0) {
            failure = { ok: false, code: 'site_not_found', error: '站点不存在' };
            return list;
          }
          target = list[index];
          if (comparableOrigin(target) !== comparableOrigin(expectedOrigin)) {
            failure = {
              ok: false,
              code: 'site_domain_changed',
              error: '站点地址已修改，未把 Key 写入新站点；请重新打开原站后再试'
            };
            return list;
          }
          before = (target.keys || []).filter((item) => isCompleteKey(item?.key)).length;
          list[index] = await merge(target, candidates) || target;
          return list;
        });
        if (failure) return failure;
        const site = sites.find((item) => String(item?.id) === String(siteId)) || target;
        const after = (site?.keys || []).filter((item) => isCompleteKey(item?.key)).length;
        return { ok: true, sites, site, added: Math.max(0, after - before) };
      }
      const loaded = await loadSites();
      const latestSites = Array.isArray(loaded) ? loaded : [];
      const index = latestSites.findIndex((site) => String(site?.id) === String(siteId));
      if (index < 0) return { ok: false, code: 'site_not_found', error: '站点不存在' };
      const target = latestSites[index];
      if (comparableOrigin(target) !== comparableOrigin(expectedOrigin)) {
        return {
          ok: false,
          code: 'site_domain_changed',
          error: '站点地址已修改，未把 Key 写入新站点；请重新打开原站后再试'
        };
      }
      const before = (target.keys || []).filter((item) => isCompleteKey(item?.key)).length;
      const merged = await merge(target, candidates);
      latestSites[index] = merged || target;
      const saved = await saveSites(latestSites);
      const sites = Array.isArray(saved) ? saved : latestSites;
      const site = sites.find((item) => String(item?.id) === String(siteId)) || latestSites[index];
      const after = (site?.keys || []).filter((item) => isCompleteKey(item?.key)).length;
      return { ok: true, sites, site, added: Math.max(0, after - before) };
    }

    async function provision(siteId, options = {}) {
      if (typeof loadSites !== 'function' || (typeof saveSites !== 'function' && typeof mutateSites !== 'function')
        || typeof merge !== 'function'
        || typeof readSession !== 'function' || typeof verify !== 'function' || typeof scan !== 'function'
        || typeof create !== 'function') {
        return { ok: false, code: 'provision_unavailable', error: '自动获取 Key 当前不可用' };
      }

      const allowCreate = options.allowCreate === true;

      let sites;
      try {
        sites = await loadSites();
      } catch (error) {
        return { ok: false, code: 'storage_read_failed', error: String(error?.message || error) };
      }
      const site = (Array.isArray(sites) ? sites : [])
        .find((item) => String(item?.id) === String(siteId));
      if (!site) return { ok: false, code: 'site_not_found', error: '站点不存在' };
      if (hasCompleteKey(site)) return { ok: true, outcome: 'existing', site, sites };

      let session;
      try {
        session = await readSession(site.domain, site);
      } catch (error) {
        return { ok: false, code: 'session_read_failed', error: String(error?.message || error) };
      }
      if (!session?.tabId) {
        return {
          ok: false,
          code: 'login_tab_required',
          error: '需要登录该站的令牌页后再获取 Key'
        };
      }

      let identity;
      const isNewApi = String(site.type || '').toLowerCase() === 'newapi';
      if (isNewApi) {
        try {
          identity = await verify(session.tabId, session, site);
        } catch (error) {
          return { ok: false, code: 'account_verify_failed', error: String(error?.message || error), site };
        }
        if (!identity?.ok) {
          return {
            ok: false,
            code: identity?.code || 'account_verify_failed',
            error: identity?.error || '无法确认当前登录账号，未创建 Key',
            site
          };
        }
      }

      let scanned;
      try {
        scanned = await scan(session.tabId, site, identity);
      } catch (error) {
        return { ok: false, code: 'key_scan_failed', error: String(error?.message || error) };
      }

      const candidates = (scanned?.trustedKeys || []).filter((item) => isCompleteKey(
        typeof item === 'string' ? item : item?.key
      ));
      if (candidates.length) {
        try {
            const persisted = await persistCandidates(site.id, candidates, comparableOrigin(site));
          if (!persisted.ok) return persisted;
          if (hasCompleteKey(persisted.site)) {
            return { ...persisted, ok: true, outcome: 'imported', found: candidates.length };
          }
        } catch (error) {
          return { ok: false, code: 'key_save_failed', error: String(error?.message || error) };
        }
      }

      const tokenListState = scanned?.tokenListState || 'unavailable';
      if (tokenListState !== 'empty') {
        return {
          ok: false,
          code: `token_list_${tokenListState}`,
          error: tokenStateError(tokenListState),
          site
        };
      }

      if (!isNewApi) {
        return {
          ok: false,
          code: 'unsupported_site_type',
          error: '该站没有可读取的完整 Key，当前仅支持 NewAPI/OneAPI 自动创建',
          site
        };
      }

      if (!allowCreate) {
        return {
          ok: false,
          code: 'create_confirmation_required',
          needsCreateConfirm: true,
          error: '未发现可用 Key；确认后将按当前自动创建设置创建一把新 Key，并仅保存到本机',
          site
        };
      }

      let latestBeforeCreate;
      try {
        latestBeforeCreate = await loadSites();
      } catch (error) {
        return { ok: false, code: 'storage_read_failed', error: String(error?.message || error), site };
      }
      const latestSite = (Array.isArray(latestBeforeCreate) ? latestBeforeCreate : [])
        .find((item) => String(item?.id) === String(site.id));
      if (!latestSite) return { ok: false, code: 'site_not_found', error: '站点不存在' };
      if (comparableOrigin(latestSite) !== comparableOrigin(site)) {
        return {
          ok: false,
          code: 'site_domain_changed',
          error: '站点地址已修改，未在旧站点创建 Key；请重新打开原站后再试'
        };
      }
      if (hasCompleteKey(latestSite)) {
        return { ok: true, outcome: 'existing', site: latestSite, sites: latestBeforeCreate };
      }

      let created;
      try {
        created = await create(session.tabId, site, {
          name: makeName(),
          expectedUserId: identity.userId || session.userId || null,
          sessionToken: session.token || '',
          authHeaders: identity.headers || {}
        });
      } catch (error) {
        return { ok: false, code: 'key_create_failed', error: String(error?.message || error), site };
      }
      if (!created?.ok || !isCompleteKey(created?.key?.key || created?.key)) {
        return {
          ok: false,
          created: created?.created === true,
          code: created?.code || 'created_key_unreadable',
          error: created?.error || '令牌已创建，但站点没有返回完整 Key，请到令牌页复制后手动添加',
          site
        };
      }

      const key = typeof created.key === 'string'
        ? { name: '公益站收藏', key: created.key }
        : created.key;
      try {
          const persisted = await persistCandidates(site.id, [key], comparableOrigin(site));
        if (!persisted.ok) return persisted;
        if (!hasCompleteKey(persisted.site)) {
          return {
            ok: false,
            created: true,
            code: 'key_save_failed',
            error: 'Key 已创建，但保存到收藏列表失败',
            site: persisted.site
          };
        }
        return { ...persisted, ok: true, outcome: 'created', created: true, found: 0 };
      } catch (error) {
        return {
          ok: false,
          created: true,
          code: 'key_save_failed',
          error: String(error?.message || error),
          site
        };
      }
    }

    function ensureSiteKey(siteId, options = {}) {
      const key = String(siteId || '').trim();
      if (!key) return Promise.resolve({ ok: false, code: 'site_not_found', error: '站点不存在' });
      // 创建与仅扫描确认分流：不同 allowCreate 不能共用 in-flight Promise
      const flightKey = `${key}:${options.allowCreate === true ? 'create' : 'scan'}`;
      const pending = inFlight.get(flightKey);
      if (pending) return pending;
      let lease = null;
      if (typeof tryAcquireSiteOperation === 'function') {
        lease = tryAcquireSiteOperation(key, 'ensure_site_key');
        if (!lease?.ok) {
          return Promise.resolve({
            ok: false,
            code: lease?.code || 'site_operation_busy',
            error: lease?.error || '站点正在执行其他操作，请稍后重试'
          });
        }
      }
      const operation = provision(key, options).finally(() => lease?.release?.());
      inFlight.set(flightKey, operation);
      operation.finally(() => {
        if (inFlight.get(flightKey) === operation) inFlight.delete(flightKey);
      }).catch(() => undefined);
      return operation;
    }

    return { ensureSiteKey };
  }

  root.isCompleteKey = isCompleteKey;
  root.createAutoKeyName = createAutoKeyName;
  root.createKeyProvisionService = createKeyProvisionService;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { isCompleteKey, createAutoKeyName, createKeyProvisionService };
  }
})(typeof self !== 'undefined' ? self : globalThis);
