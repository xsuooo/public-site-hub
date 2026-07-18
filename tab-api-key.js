(function (root) {
  // 依赖 balance-format；浏览器由 importScripts 保证加载顺序。
  if (typeof root.buildAuthHeaders !== 'function' && typeof require === 'function') {
    try { Object.assign(root, require('./balance-format.js')); } catch (error) {}
  }

  /**
   * 自动创建前把页面 localStorage 账号和 cookie 会话账号做一次同页校验。
   * 两者不一致时宁可拒绝，也不能把另一账号的 Key 写入收藏。
   */
  async function verifyNewApiTabAccount(tabId, session = {}, expectedOrigin = '') {
    if (!String(expectedOrigin || '').trim()) {
      return { ok: false, code: 'expected_origin_required', error: '缺少站点 Origin，已拒绝读取账号会话' };
    }
    if (!tabId || typeof chrome === 'undefined' || !chrome.scripting?.executeScript) {
      return { ok: false, code: 'no_tab', error: '请先打开并登录该站的令牌页' };
    }
    const expected = String(
      session && typeof session === 'object' ? session.userId : session
    ).trim();
    const suppliedToken = String(
      session && typeof session === 'object' ? session.token : ''
    ).trim();
    if (!expected) {
      return { ok: false, code: 'account_identity_unavailable', error: '无法确认当前登录账号，未执行自动获取 Key' };
    }
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        args: [expected, suppliedToken, String(expectedOrigin || '').trim()],
        func: async (expectedId, suppliedSessionToken, expectedSite) => {
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
          const requestDeadline = Date.now() + 12000;
          async function safeFetch(input, init = {}) {
            const remaining = Math.max(1, requestDeadline - Date.now());
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), remaining);
            try {
              return await fetch(input, { ...init, redirect: 'error', signal: controller.signal });
            } finally {
              clearTimeout(timer);
            }
          }
          function isExpectedSite() {
            if (!requiredOrigin) return false;
            try {
              return String(location.origin || '').toLowerCase() === requiredOrigin;
            } catch (error) {
              return false;
            }
          }

          function domainChanged() {
            return {
              ok: false,
              code: 'tab_domain_changed',
              error: '当前标签页已跳转到其他站点，请回到原站后重试'
            };
          }

          if (!isExpectedSite()) return domainChanged();
          function pickId(payload) {
            if (!payload || typeof payload !== 'object') return null;
            const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
            const value = data.id ?? data.user_id ?? data.userId
              ?? payload.id ?? payload.user_id ?? payload.userId ?? null;
            return value === undefined || value === null || value === '' ? null : String(value);
          }

          function bearer(value) {
            const token = String(value || '').trim();
            if (!token) return '';
            return /^bearer\s+/i.test(token) ? token : `Bearer ${token}`;
          }

          let localId = null;
          let localToken = '';
          try {
            const raw = localStorage.getItem('user') || sessionStorage.getItem('user')
              || localStorage.getItem('User');
            localId = pickId(typeof raw === 'string' ? JSON.parse(raw) : raw);
            for (const key of ['token', 'access_token', 'auth_token', 'user_token', 'session', 'jwt', 'Authorization']) {
              const value = localStorage.getItem(key) || sessionStorage.getItem(key);
              if (value && String(value).trim().length > 8) {
                localToken = String(value).trim();
                break;
              }
            }
            if (!localToken && raw) {
              const user = typeof raw === 'string' ? JSON.parse(raw) : raw;
              localToken = String(user?.token || user?.access_token || user?.key || '').trim();
            }
          } catch (error) {}
          if (!localId) {
            return { ok: false, code: 'account_identity_unavailable', error: '页面没有可验证的登录账号，请刷新登录后重试' };
          }
          if (localId !== String(expectedId)) {
            return { ok: false, code: 'account_mismatch', error: '当前页面的登录账号已变化，未创建 Key' };
          }

          const headersList = [];
          const seen = new Set();
          function addHeaders(headers) {
            const normalized = headers && typeof headers === 'object' ? headers : {};
            const signature = JSON.stringify(normalized);
            if (seen.has(signature)) return;
            seen.add(signature);
            headersList.push(normalized);
          }
          addHeaders({});
          addHeaders({ 'New-API-User': localId });
          const auth = bearer(localToken || suppliedSessionToken);
          if (auth) addHeaders({ Authorization: auth });
          if (auth) addHeaders({ 'New-API-User': localId, Authorization: auth });

          let sawMismatch = false;
          let sawUnauthorized = false;
          let lastFailure = '';
          for (const headers of headersList) {
            if (!isExpectedSite()) return domainChanged();
            let response;
            try {
              response = await safeFetch('/api/user/self', {
                credentials: 'include',
                headers: { Accept: 'application/json', ...headers }
              });
            } catch (error) {
              lastFailure = String(error?.message || error);
              continue;
            }
            if (!isExpectedSite()) return domainChanged();
            let payload = null;
            try { payload = await response.json(); } catch (error) {}
            if (!response.ok) {
              if (response.status === 401 || response.status === 403) sawUnauthorized = true;
              else lastFailure = `HTTP ${response.status}`;
              continue;
            }
            const accountId = pickId(payload);
            if (!accountId) {
              lastFailure = '站点没有返回可验证的账号信息';
              continue;
            }
            if (accountId === localId && accountId === String(expectedId)) {
              return { ok: true, userId: accountId, headers };
            }
            sawMismatch = true;
          }
          if (sawMismatch) {
            return { ok: false, code: 'account_mismatch', error: '页面登录账号与站点会话不一致，未创建 Key' };
          }
          if (sawUnauthorized) {
            return { ok: false, code: 'not_logged_in', error: '登录已失效，请先登录令牌页' };
          }
          return { ok: false, code: 'account_verify_failed', error: lastFailure || '无法验证当前登录账号' };
        }
      });
      return results?.[0]?.result || { ok: false, code: 'account_verify_failed', error: '无法验证当前登录账号' };
    } catch (error) {
      return { ok: false, code: 'account_verify_failed', error: String(error?.message || error) };
    }
  }

  /**
   * 仅对经过令牌列表验证的 NewAPI 站点创建一把默认 Key。
   * 创建在真实已登录页面内执行，避免把浏览器会话或 Key 送出页面上下文。
   */
  async function createTabApiKey(tabId, type, options = {}) {
    if (!String(options.expectedOrigin || options.expectedDomain || '').trim()) {
      return { ok: false, code: 'expected_origin_required', error: '缺少站点 Origin，已拒绝创建 Key' };
    }
    if (!tabId || typeof chrome === 'undefined' || !chrome.scripting?.executeScript) {
      return { ok: false, code: 'no_tab', error: '请先打开并登录该站的令牌页' };
    }
    if (String(type || '').toLowerCase() !== 'newapi') {
      return {
        ok: false,
        code: 'unsupported_site_type',
        error: '当前仅支持已识别的 NewAPI/OneAPI 兼容站自动创建 Key'
      };
    }

    const expectedUserId = String(options.expectedUserId || '').trim();
    const account = await verifyNewApiTabAccount(tabId, {
      userId: expectedUserId,
      token: options.sessionToken || ''
    }, options.expectedOrigin || options.expectedDomain || '');
    if (!account?.ok) return account;

    const name = String(options.name || '公益站收藏').trim().slice(0, 50) || '公益站收藏';
    const unlimitedQuota = options.unlimitedQuota === true;
    const remainQuotaRaw = Number(options.remainQuota);
    const remainQuota = unlimitedQuota
      ? 0
      : (Number.isFinite(remainQuotaRaw) && remainQuotaRaw > 0
        ? Math.trunc(remainQuotaRaw)
        : 5_000_000);
    const expireDaysRaw = Number(options.expireDays);
    const expireDays = Number.isFinite(expireDaysRaw) && expireDaysRaw > 0
      ? Math.trunc(expireDaysRaw)
      : 90;
    const expiredTimeOverride = Number(options.expiredTime);
    const expiredTime = unlimitedQuota
      ? -1
      : (Number.isFinite(expiredTimeOverride) && expiredTimeOverride > 0
        ? Math.trunc(expiredTimeOverride)
        : Math.floor(Date.now() / 1000) + expireDays * 86400);
    const keyPolicy = { unlimitedQuota, remainQuota, expiredTime };
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        args: [
          name,
          expectedUserId,
          account.headers || {},
          String(options.expectedOrigin || options.expectedDomain || '').trim(),
          keyPolicy
        ],
        func: async (tokenName, expectedId, authHeaders, expectedSite, policy = {}) => {
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
          const requestDeadline = Date.now() + 12000;
          async function safeFetch(input, init = {}) {
            const remaining = Math.max(1, requestDeadline - Date.now());
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), remaining);
            try {
              return await fetch(input, { ...init, redirect: 'error', signal: controller.signal });
            } finally {
              clearTimeout(timer);
            }
          }
          function isExpectedSite() {
            if (!requiredOrigin) return false;
            try {
              return String(location.origin || '').toLowerCase() === requiredOrigin;
            } catch (error) {
              return false;
            }
          }

          function domainChanged() {
            return {
              ok: false,
              code: 'tab_domain_changed',
              error: '当前标签页已跳转到其他站点，请回到原站后重试'
            };
          }

          if (!isExpectedSite()) return domainChanged();
          function pickList(payload) {
            if (!payload || typeof payload !== 'object' || payload.success === false) {
              return { known: false, items: [], state: 'unavailable', total: null };
            }
            if (Array.isArray(payload)) {
              return { known: true, items: payload, state: payload.length ? 'with-tokens' : 'empty', total: payload.length };
            }
            const data = payload.data;
            if (Array.isArray(data)) {
              return { known: true, items: data, state: data.length ? 'with-tokens' : 'empty', total: data.length };
            }
            let items = null;
            let total = null;
            if (data && typeof data === 'object') {
              for (const field of ['items', 'records', 'list', 'tokens', 'data', 'rows']) {
                if (Array.isArray(data[field])) {
                  items = data[field];
                  total = data.total ?? data.total_count ?? data.count ?? data.totalCount ?? null;
                  break;
                }
              }
            }
            if (!items) {
              for (const field of ['items', 'records', 'list', 'tokens', 'rows']) {
                if (Array.isArray(payload[field])) {
                  items = payload[field];
                  total = payload.total ?? payload.total_count ?? payload.count ?? payload.totalCount ?? null;
                  break;
                }
              }
            }
            if (!items) return { known: false, items: [], state: 'unavailable', total: null };
            const numericTotal = Number(total);
            const hasTotal = total !== null && total !== undefined && total !== ''
              && Number.isFinite(numericTotal) && numericTotal >= 0;
            return {
              known: true,
              items,
              total: hasTotal ? numericTotal : null,
              state: hasTotal ? (numericTotal === 0 ? 'empty' : 'with-tokens')
                : (items.length ? 'with-tokens' : 'unknown-empty')
            };
          }

          function pickId(payload) {
            if (!payload || typeof payload !== 'object') return null;
            const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
            const value = data.id ?? data.user_id ?? data.userId
              ?? payload.id ?? payload.user_id ?? payload.userId ?? null;
            return value === undefined || value === null || value === '' ? null : String(value);
          }

          function isCompleteKey(value) {
            const key = String(value || '').trim();
            return key.length > 12
              && /^[A-Za-z0-9._~-]+$/.test(key)
              && !/\.{2,}/.test(key)
              && !/[•●○◦∙·…*]/.test(key);
          }

          function pickFullKey(payload) {
            const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
            const value = data?.key || data?.token || data?.api_key || data?.secret || '';
            const key = String(value || '').trim();
            return isCompleteKey(key) ? key : '';
          }

          function payloadError(payload, fallback) {
            return String(payload?.message || payload?.error || fallback || '请求失败');
          }

          function tokenId(item) {
            const id = item?.id ?? item?.token_id ?? item?.tokenId;
            return id === undefined || id === null || id === '' ? null : String(id);
          }

          async function verifyExpectedAccount() {
            if (!isExpectedSite()) return domainChanged();
            let response;
            try {
              response = await safeFetch('/api/user/self', {
                credentials: 'include',
                headers: { Accept: 'application/json', ...(authHeaders || {}) }
              });
            } catch (error) {
              return { ok: false, code: 'account_verify_failed', error: String(error?.message || error) };
            }
            if (!isExpectedSite()) return domainChanged();
            let payload = null;
            try { payload = await response.json(); } catch (error) {}
            if (!response.ok) {
              return {
                ok: false,
                code: response.status === 401 || response.status === 403 ? 'not_logged_in' : 'account_verify_failed',
                error: response.status === 401 || response.status === 403
                  ? '登录已失效，请先登录令牌页'
                  : `验证登录账号失败（HTTP ${response.status}）`
              };
            }
            const actual = pickId(payload);
            if (!actual) {
              return { ok: false, code: 'account_identity_unavailable', error: '站点没有返回可验证的账号信息，未创建 Key' };
            }
            if (actual !== String(expectedId)) {
              return { ok: false, code: 'account_mismatch', error: '当前页面的登录账号已变化，未创建 Key' };
            }
            return { ok: true };
          }

          async function getTokenList() {
            if (!isExpectedSite()) return domainChanged();
            let response;
            try {
              response = await safeFetch('/api/token/?p=0&size=100', {
                credentials: 'include',
                headers: { Accept: 'application/json', ...(authHeaders || {}) }
              });
            } catch (error) {
              return { ok: false, code: 'token_list_unavailable', error: String(error?.message || error) };
            }
            if (!isExpectedSite()) return domainChanged();
            let payload = null;
            try { payload = await response.json(); } catch (error) {}
            if (!response.ok) {
              return {
                ok: false,
                code: response.status === 401 || response.status === 403 ? 'not_logged_in' : 'token_list_unavailable',
                error: response.status === 401 || response.status === 403
                  ? '登录已失效，请先登录令牌页'
                  : `读取令牌列表失败（HTTP ${response.status}）`
              };
            }
            const parsed = pickList(payload);
            if (!parsed.known || parsed.state === 'unknown-empty') {
              return { ok: false, code: 'token_list_unavailable', error: payloadError(payload, '无法确认令牌列表') };
            }
            if (parsed.total === 0 && parsed.items.length) {
              return { ok: false, code: 'token_list_conflict', error: '令牌列表返回矛盾数据，已停止创建 Key' };
            }
            return { ok: true, items: parsed.items, state: parsed.state, total: parsed.total, payload };
          }

          const initialIdentity = await verifyExpectedAccount();
          if (!initialIdentity.ok) return initialIdentity;
          const before = await getTokenList();
          if (!before.ok) return before;
          if (before.state !== 'empty') {
            return {
              ok: false,
              code: before.state === 'with-tokens' ? 'token_list_not_empty' : 'token_list_unavailable',
              error: before.state === 'with-tokens'
                ? '站点已有 Key；不会自动创建重复 Key'
                : '无法确认令牌列表是否为空；未创建新 Key',
              found: before.total ?? before.items.length
            };
          }

          const writeIdentity = await verifyExpectedAccount();
          if (!writeIdentity.ok) return writeIdentity;
          if (!isExpectedSite()) return domainChanged();

          const unlimited = policy?.unlimitedQuota === true;
          const remainQuota = unlimited
            ? 0
            : (Number.isFinite(Number(policy?.remainQuota)) && Number(policy.remainQuota) > 0
              ? Math.trunc(Number(policy.remainQuota))
              : 5000000);
          const expiredTime = unlimited
            ? -1
            : (Number.isFinite(Number(policy?.expiredTime)) && Number(policy.expiredTime) > 0
              ? Math.trunc(Number(policy.expiredTime))
              : Math.floor(Date.now() / 1000) + 90 * 86400);

          let createResponse;
          try {
            createResponse = await safeFetch('/api/token/', {
              method: 'POST',
              credentials: 'include',
              headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(authHeaders || {}) },
              body: JSON.stringify({
                name: tokenName,
                remain_quota: remainQuota,
                expired_time: expiredTime,
                unlimited_quota: unlimited,
                model_limits_enabled: false,
                model_limits: '',
                allow_ips: '',
                group: '',
                cross_group_retry: false
              })
            });
          } catch (error) {
            return { ok: false, code: 'key_create_failed', error: String(error?.message || error) };
          }
          if (!isExpectedSite()) return domainChanged();

          let createdPayload = null;
          try { createdPayload = await createResponse.json(); } catch (error) {}
          if (!createResponse.ok || createdPayload?.success === false) {
            return {
              ok: false,
              code: 'key_create_failed',
              error: payloadError(createdPayload, `创建 Key 失败（HTTP ${createResponse.status}）`)
            };
          }

          const immediateKey = pickFullKey(createdPayload);
          const immediateData = createdPayload?.data && typeof createdPayload.data === 'object'
            ? createdPayload.data
            : createdPayload;
          if (immediateKey) {
            return { ok: true, created: true, key: { name: tokenName, key: immediateKey } };
          }

          const after = await getTokenList();
          if (!after.ok) {
            return {
              ok: false,
              created: true,
              code: 'created_key_unreadable',
              error: 'Key 已创建，但无法重新读取令牌列表，请到令牌页复制后手动添加'
            };
          }
          const wantedId = tokenId(immediateData);
          const createdItem = after.items.find((item) => (
            (wantedId && tokenId(item) === wantedId) || String(item?.name || '') === tokenName
          ));
          if (!createdItem) {
            return {
              ok: false,
              created: true,
              code: 'created_key_unreadable',
              error: 'Key 已创建，但未能定位新令牌，请到令牌页复制后手动添加'
            };
          }
          const listedKey = pickFullKey(createdItem);
          if (listedKey) {
            return {
              ok: true,
              created: true,
              key: { name: String(createdItem.name || tokenName), key: listedKey }
            };
          }

          const id = tokenId(createdItem);
          if (!id) {
            return {
              ok: false,
              created: true,
              code: 'created_key_unreadable',
              error: 'Key 已创建，但站点没有提供令牌编号，请到令牌页复制后手动添加'
            };
          }
          let keyResponse;
          try {
            if (!isExpectedSite()) return domainChanged();
            keyResponse = await safeFetch(`/api/token/${encodeURIComponent(id)}/key`, {
              method: 'POST',
              credentials: 'include',
              headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(authHeaders || {}) },
              body: '{}'
            });
          } catch (error) {
            return {
              ok: false,
              created: true,
              code: 'created_key_unreadable',
              error: 'Key 已创建，但读取完整 Key 失败，请到令牌页复制后手动添加'
            };
          }
          if (!isExpectedSite()) return domainChanged();
          let keyPayload = null;
          try { keyPayload = await keyResponse.json(); } catch (error) {}
          const fullKey = keyResponse.ok && keyPayload?.success !== false ? pickFullKey(keyPayload) : '';
          if (!fullKey) {
            return {
              ok: false,
              created: true,
              code: 'created_key_unreadable',
              error: 'Key 已创建，但站点没有返回完整 Key，请到令牌页复制后手动添加'
            };
          }
          return {
            ok: true,
            created: true,
            key: { name: String(createdItem.name || tokenName), key: fullKey }
          };
        }
      });
      const payload = results?.[0]?.result;
      return payload || { ok: false, code: 'tab_inject_failed', error: '无法在当前站点读取令牌信息' };
    } catch (error) {
      return { ok: false, code: 'tab_inject_failed', error: String(error?.message || error) };
    }
  }

  root.verifyNewApiTabAccount = verifyNewApiTabAccount;
  root.createTabApiKey = createTabApiKey;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      verifyNewApiTabAccount,
      createTabApiKey
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
