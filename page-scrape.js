(function (root) {
  // 依赖 balance-format；浏览器由 importScripts 保证顺序。
  if (typeof root.formatBalanceValue !== 'function' && typeof require === 'function') {
    try { Object.assign(root, require('./balance-format.js')); } catch (error) {}
  }
  const resolveQuotaUnit = root.resolveQuotaUnit;
  const formatBalanceValue = root.formatBalanceValue;
  const extractFromUserObject = root.extractFromUserObject;
  const extractBalanceFromText = root.extractBalanceFromText;
  const extractUsageFromText = root.extractUsageFromText;
  const humanizeBalanceError = root.humanizeBalanceError;
  const candidateTokenPaths = root.candidateTokenPaths;

  /**
   * 在站点标签页内：
   * 0) localStorage.user 里的 quota（NewAPI 登录后常有）
   * 1) /api/user/self（会话 cookie + New-API-User）
   * 2) 页面文字「余额 $x.xx」
   * 3) 顺带扫 sk-
   */
  async function scrapeTabBalanceAndKeys(tabId, type, options = {}) {
    const expectedRaw = String(options.expectedOrigin || options.expectedDomain || '').trim();
    if (!expectedRaw) {
      return { ok: false, code: 'expected_origin_required', error: '缺少站点 Origin，已拒绝读取页面凭据' };
    }
    if (!tabId || typeof chrome === 'undefined' || !chrome.scripting?.executeScript) {
      return { ok: false, error: 'no tab' };
    }
    const quotaUnit = resolveQuotaUnit(options.quotaPerUnit);
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        args: [
          type || 'auto',
          quotaUnit,
          options.readFullTokenKeys === true,
          options.authHeaders && typeof options.authHeaders === 'object' ? options.authHeaders : null,
          expectedRaw
        ],
        func: async (siteType, quotaUnitArg, readFullTokenKeys, forcedAuthHeaders, expectedSite) => {
          function expectedOrigin(value) {
            const raw = String(value || '').trim();
            if (!raw) return '';
            try {
              const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
              return url.protocol === 'https:' ? url.origin.toLowerCase() : '';
            } catch (error) {
              return '';
            }
          }

          const requiredOrigin = expectedOrigin(expectedSite);
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
              error: '当前标签页已跳转到其他站点，请回到原站后重试',
              keys: [],
              trustedKeys: [],
              tokenListState: 'unavailable'
            };
          }

          if (!isExpectedSite()) return domainChanged();
          const paths = siteType === 'sub2api'
            ? ['/api/v1/user/self', '/api/v1/user/info', '/api/v1/user', '/api/user/self']
            : siteType === 'zenapi'
              ? ['/api/u/dashboard', '/api/u/user', '/api/user/self']
              : ['/api/user/self', '/api/user/dashboard', '/api/user', '/api/user/info'];
          const tokenPaths = siteType === 'sub2api'
            ? ['/api/v1/token/?p=0&size=100', '/api/v1/tokens']
            : siteType === 'zenapi'
              ? ['/api/u/tokens', '/api/tokens']
              : ['/api/token/?p=0&size=100', '/api/token/?p=0', '/api/tokens'];

          const DEFAULT_UNIT = 500000;
          let QUOTA_UNIT = Number(quotaUnitArg) > 0 ? Number(quotaUnitArg) : DEFAULT_UNIT;

          function pickUserId(user) {
            if (!user) return null;
            let o = user;
            if (typeof user === 'string') {
              try { o = JSON.parse(user); } catch (e) { return null; }
            }
            return o?.id ?? o?.user_id ?? o?.data?.id ?? o?.data?.user_id ?? null;
          }

          function fmtQuota(value, key) {
            if (value === null || value === undefined || value === '') return null;
            if (value === true || value === 'unlimited') return '无限';
            if (typeof value === 'object') return null;
            const numeric = Number(String(value).replace(/[$¥￥,\s]/g, ''));
            if (!Number.isFinite(numeric)) return null;
            if (numeric < 0 && /quota/i.test(key || '')) return '无限';
            if (/quota/i.test(key || '')) {
              let dollars = numeric / QUOTA_UNIT;
              if (dollars > 100000 && QUOTA_UNIT !== DEFAULT_UNIT) {
                dollars = numeric / DEFAULT_UNIT;
              }
              if (dollars > 100000 && numeric <= 100000) dollars = numeric;
              if (dollars > 100000) dollars = numeric / DEFAULT_UNIT;
              return `$${dollars.toFixed(2)}`;
            }
            return Math.abs(numeric - Math.round(numeric)) < 1e-6
              ? String(Math.round(numeric))
              : numeric.toFixed(2);
          }

          function fromUserObj(raw) {
            if (!raw) return null;
            let o = raw;
            if (typeof raw === 'string') {
              try { o = JSON.parse(raw); } catch (e) { return null; }
            }
            if (!o || typeof o !== 'object') return null;
            const u = (o.data && typeof o.data === 'object' && (o.data.quota != null || o.data.used_quota != null))
              ? o.data
              : o;
            if (u.unlimited_quota === true) {
              return {
                balance: '无限',
                usage: fmtQuota(u.used_quota, 'used_quota'),
                source: 'local-user'
              };
            }
            if (u.quota == null && u.used_quota == null && u.remain_quota == null && u.balance == null) {
              return null;
            }
            const balance = fmtQuota(
              u.quota != null ? u.quota : (u.remain_quota != null ? u.remain_quota : u.balance),
              u.quota != null ? 'quota' : (u.remain_quota != null ? 'remain_quota' : 'balance')
            );
            const usage = fmtQuota(
              u.used_quota != null ? u.used_quota : u.used,
              'used_quota'
            );
            if (!balance && !usage) return null;
            return { balance, usage, source: 'local-user' };
          }

          function walkPreferQuota(data) {
            if (!data || typeof data !== 'object') return null;
            if (data.success === false) return { failed: true, message: data.message || '未登录' };
            // 直接走 data 节点
            const node = data.data && typeof data.data === 'object' ? data.data : data;
            if (node.unlimited_quota === true) {
              return {
                balance: '无限',
                usage: fmtQuota(node.used_quota, 'used_quota')
              };
            }
            const balKeys = [
              'quota', 'remain_quota', 'remaining_quota', 'available_quota',
              'balance', 'wallet_balance', 'remaining_balance', 'available_balance',
              'credit', 'credits', 'money', 'amount'
            ];
            const useKeys = ['used_quota', 'used', 'usage', 'total_used', 'used_amount'];
            let balance = null;
            let usage = null;
            let balanceKey = '';
            let usageKey = '';
            const visited = new Set();
            function walk(v) {
              if (!v || typeof v !== 'object' || visited.has(v)) return;
              visited.add(v);
              for (const want of balKeys) {
                if (balance != null) break;
                if (Object.prototype.hasOwnProperty.call(v, want)) {
                  const child = v[want];
                  if (typeof child === 'number' || typeof child === 'string' || child === true) {
                    balance = child;
                    balanceKey = want;
                  }
                }
              }
              for (const want of useKeys) {
                if (usage != null) break;
                if (Object.prototype.hasOwnProperty.call(v, want)) {
                  const child = v[want];
                  if (typeof child === 'number' || typeof child === 'string') {
                    usage = child;
                    usageKey = want;
                  }
                }
              }
              for (const child of Object.values(v)) {
                if (child && typeof child === 'object') walk(child);
              }
            }
            walk(data);
            if (balance == null && usage == null) return null;
            return {
              balance: balance != null ? fmtQuota(balance, balanceKey) : null,
              usage: usage != null ? fmtQuota(usage, usageKey) : null,
              balanceRaw: balance != null ? { key: balanceKey, value: balance } : null,
              usageRaw: usage != null ? { key: usageKey, value: usage } : null
            };
          }

          // —— 读本地会话 ——
          let userRaw = null;
          let sessionToken = null;
          try {
            userRaw = localStorage.getItem('user')
              || sessionStorage.getItem('user')
              || localStorage.getItem('User');
            const tokenKeys = ['token', 'access_token', 'auth_token', 'user_token', 'session'];
            for (const k of tokenKeys) {
              const v = localStorage.getItem(k) || sessionStorage.getItem(k);
              if (v && String(v).length > 8) {
                sessionToken = String(v);
                break;
              }
            }
            if (!sessionToken && userRaw) {
              try {
                const o = JSON.parse(userRaw);
                sessionToken = o?.token || o?.access_token || null;
              } catch (e) {}
            }
          } catch (e) {}

          const uid = pickUserId(userRaw);
          const localHit = fromUserObj(userRaw);

          // 请求头：cookie 会话 + New-API-User
          const headerSets = forcedAuthHeaders && typeof forcedAuthHeaders === 'object'
            ? [forcedAuthHeaders]
            : [{}];
          if (!forcedAuthHeaders || typeof forcedAuthHeaders !== 'object') {
            if (uid) headerSets.push({ 'New-API-User': String(uid) });
            if (sessionToken) {
              headerSets.push({
                Authorization: /^bearer\s+/i.test(sessionToken)
                  ? sessionToken
                  : `Bearer ${sessionToken}`
              });
            }
            if (uid && sessionToken) {
              headerSets.push({
                'New-API-User': String(uid),
                Authorization: /^bearer\s+/i.test(sessionToken)
                  ? sessionToken
                  : `Bearer ${sessionToken}`
              });
            }
          }

          let apiHit = null;
          let lastApiFail = null;
          for (const headers of headerSets) {
            for (const path of paths) {
              if (!isExpectedSite()) return domainChanged();
              try {
                const resp = await safeFetch(path, {
                  credentials: 'include',
                  headers: { Accept: 'application/json', ...headers }
                });
                if (!isExpectedSite()) return domainChanged();
                if (!resp.ok) {
                  lastApiFail = `HTTP ${resp.status}`;
                  continue;
                }
                const data = await resp.json();
                const picked = walkPreferQuota(data);
                if (picked?.failed) {
                  lastApiFail = 'not logged in';
                  continue;
                }
                if (picked && (picked.balance || picked.usage)) {
                  apiHit = {
                    path,
                    balance: picked.balance,
                    usage: picked.usage,
                    balanceRaw: picked.balanceRaw,
                    usageRaw: picked.usageRaw,
                    data
                  };
                  break;
                }
                // 连通但无字段
                lastApiFail = 'no balance field';
              } catch (e) {
                lastApiFail = String(e?.message || e);
              }
            }
            if (apiHit) break;
          }

          // 令牌列表：必须带站点真实名称（claude / cc），禁止「页面导入/令牌」占位
          // NewAPI 常见：{ success, data: { items: [ { name, key } ] } } 或 data: [...]
          const apiKeyEntries = []; // { name, key, suffix }[]
          const trustedApiKeyEntries = []; // 仅来自已验证令牌 API 的完整 Key
          const tableNames = []; // 表格里按行读到的名称（可无完整 key）
          const seenKeyVals = new Set();
          const maskedNewApiTokens = [];
          let tokenListState = 'unavailable';
          let tokenListPath = '';

          function cleanName(name) {
            let n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
            if (!n) return '';
            if (/^(页面导入|令牌|默认|undefined|null|—|-)$/i.test(n)) return '';
            if (/^(已启用|已禁用|启用|禁用|enabled|disabled|永久|无限)/i.test(n)) return '';
            return n;
          }

          // 与 tab-api-key.pickList 对齐：分页 total 优先；空页但 total>0 视为 with-tokens。
          function inspectTokenList(payload) {
            if (!payload || typeof payload !== 'object' || payload.success === false) {
              return { known: false, items: [], state: 'unavailable', total: null };
            }
            if (Array.isArray(payload)) {
              return {
                known: true,
                items: payload,
                state: payload.length ? 'with-tokens' : 'empty',
                total: payload.length
              };
            }

            let items = null;
            let total = null;
            const data = payload.data;
            if (Array.isArray(data)) {
              items = data;
              total = data.length;
            } else if (data && typeof data === 'object') {
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
              state: hasTotal
                ? (numericTotal === 0 ? 'empty' : 'with-tokens')
                : (items.length ? 'with-tokens' : 'unknown-empty')
            };
          }

          function isCompleteKeyValue(value) {
            const key = String(value || '').trim();
            return key.length > 12
              && /^[A-Za-z0-9._~-]+$/.test(key)
              && !/\.{2,}/.test(key)
              && !/[•●○◦∙·…*]/.test(key);
          }

          function markTrustedKey(name, key) {
            if (!isCompleteKeyValue(key)) return;
            const existing = trustedApiKeyEntries.find((item) => item.key === key);
            if (existing) {
              if (name && !existing.name) existing.name = cleanName(name);
              return;
            }
            trustedApiKeyEntries.push({
              name: cleanName(name),
              key,
              suffix: key.slice(-6)
            });
          }

          function pushKeyEntry(name, keyVal, trusted = false) {
            let k = String(keyVal || '').trim();
            const n = cleanName(name);
            if (!k && !n) return;

            if (trusted) markTrustedKey(n, k);

            // 截断 key：只记后缀，后面用已存完整 sk 对齐改名
            if (k && !isCompleteKeyValue(k)) {
              const suffix = k.replace(/\./g, '').replace(/…/g, '').slice(-6);
              if (n && suffix.length >= 4) {
                apiKeyEntries.push({ name: n, key: '', suffix });
              }
              return;
            }
            if (isCompleteKeyValue(k)) {
              if (seenKeyVals.has(k)) {
                // 已有该 key，补名字
                const hit = apiKeyEntries.find((e) => e.key === k);
                if (hit && n && !hit.name) hit.name = n;
                return;
              }
              seenKeyVals.add(k);
              apiKeyEntries.push({ name: n, key: k, suffix: k.slice(-6) });
            } else if (n) {
              tableNames.push(n);
            }
          }

          const tokenPathsExtra = [
            ...tokenPaths,
            '/api/token/?p=0&page_size=100',
            '/api/token/?p=0&size=100',
            '/api/token/?p=1&page_size=100',
            '/api/token/search?keyword='
          ];

          for (const headers of headerSets) {
            for (const tp of tokenPathsExtra) {
              if (!isExpectedSite()) return domainChanged();
              try {
                const resp = await safeFetch(tp, {
                  credentials: 'include',
                  headers: { Accept: 'application/json', ...headers }
                });
                if (!isExpectedSite()) return domainChanged();
                if (!resp.ok) continue;
                const data = await resp.json();
                const inspected = inspectTokenList(data);
                if (!inspected.known) continue;
                const list = inspected.items;
                // state 已 total 感知：首页空但 total>0 → with-tokens，避免误导创建。
                tokenListState = inspected.state || (list.length ? 'with-tokens' : 'empty');
                tokenListPath = tp;
                if (!list.length) break;
                for (const item of list) {
                  if (!item || typeof item !== 'object') continue;
                  const k = item.key || item.token || item.api_key || item.secret
                    || item.access_token || '';
                  const n = item.name || item.token_name || item.tokenName
                    || item.label || item.remark || item.title || item.group
                    || '';
                  const id = item.id ?? item.token_id ?? item.tokenId;
                  const masked = !isCompleteKeyValue(k);
                  if (readFullTokenKeys && siteType === 'newapi' && id != null && masked) {
                    maskedNewApiTokens.push({ id: String(id), name: n, maskedKey: k });
                  } else {
                    pushKeyEntry(n, k, true);
                  }
                }
                break;
              } catch (e) {}
            }
            if (tokenListState !== 'unavailable') break;
          }

          // 标准 NewAPI 的列表只给遮罩 Key；在用户发起的 Key 导入流程中按 id 取全文。
          if (readFullTokenKeys && siteType === 'newapi' && maskedNewApiTokens.length) {
            const pending = maskedNewApiTokens.slice(0, 50);
            const fullKeys = {};
            try {
              if (!isExpectedSite()) return domainChanged();
              const response = await safeFetch('/api/token/batch/keys', {
                method: 'POST',
                credentials: 'include',
                headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(forcedAuthHeaders || {}) },
                body: JSON.stringify({ ids: pending.map((item) => Number(item.id)).filter(Number.isFinite) })
              });
              if (!isExpectedSite()) return domainChanged();
              const payload = response.ok ? await response.json() : null;
              const map = payload?.success !== false && payload?.data?.keys && typeof payload.data.keys === 'object'
                ? payload.data.keys
                : null;
              if (map) {
                for (const [id, key] of Object.entries(map)) fullKeys[String(id)] = key;
              }
            } catch (e) {}

            for (const item of pending) {
              let key = String(fullKeys[item.id] || '').trim();
              if (!isCompleteKeyValue(key)) {
                try {
                  if (!isExpectedSite()) return domainChanged();
                  const response = await safeFetch(`/api/token/${encodeURIComponent(item.id)}/key`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(forcedAuthHeaders || {}) },
                    body: '{}'
                  });
                  if (!isExpectedSite()) return domainChanged();
                  const payload = response.ok ? await response.json() : null;
                  key = String(payload?.data?.key || payload?.key || '').trim();
                } catch (e) {}
              }
              pushKeyEntry(item.name, key || item.maskedKey, true);
            }
          }

          // 令牌表格 DOM：名称列（claude/cc）+ 可能的 sk
          try {
            document.querySelectorAll('tr').forEach((tr) => {
              const cells = [...tr.querySelectorAll('td')].map((td) =>
                (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim()
              );
              if (!cells.length) return;
              const rowText = cells.join(' ');
              // 跳过表头
              if (/名称|状态|额度|创建时间|操作/.test(rowText) && !/\bsk-/i.test(rowText)) {
                if (/名称/.test(cells[0] || '')) return;
              }
              const km = rowText.match(/\b((?:sk|nk|cw|api|token)-[A-Za-z0-9_\-]{8,})\b/);
              let name = '';
              for (const c of cells) {
                if (!c || c.length > 40) continue;
                if (/^(已启用|已禁用|启用|禁用|enabled|disabled|永久|无限|名称|状态)$/i.test(c)) continue;
                if (/^(已启用|已禁用)/.test(c)) continue;
                if (/\b(?:sk|nk|cw)-/i.test(c)) continue;
                if (/^[\d.,\s$¥￥%]+$/.test(c)) continue;
                if (/^\d{4}[-/]/.test(c)) continue; // 日期
                name = c;
                break;
              }
              if (km) pushKeyEntry(name, km[1]);
              else if (name && /已启用|已禁用|enabled|disabled/i.test(rowText)) {
                // 有名称+状态行，无完整 sk：只记名称，后面按序回填
                const cn = cleanName(name);
                if (cn) tableNames.push(cn);
              }
            });
          } catch (e) {}

          // API 有 key 无 name 时，用表格名称按顺序补上
          if (tableNames.length) {
            let ni = 0;
            for (const e of apiKeyEntries) {
              if (!e.name && ni < tableNames.length) {
                e.name = tableNames[ni];
                ni += 1;
              }
            }
            // 仅有表格名称、没有新 key：带上 namesForRename 给合并逻辑
            if (!apiKeyEntries.length) {
              for (const n of tableNames) {
                apiKeyEntries.push({ name: n, key: '', suffix: '' });
              }
            } else if (ni < tableNames.length) {
              for (; ni < tableNames.length; ni += 1) {
                apiKeyEntries.push({ name: tableNames[ni], key: '', suffix: '' });
              }
            }
          }

          // 页面文字
          const bodyText = document.body?.innerText || document.body?.textContent || '';
          const textBalance = (() => {
            const n = bodyText.replace(/\s+/g, ' ');
            const patterns = [
              /(?:账户余额|账号余额|当前余额|剩余余额|可用额度|剩余额度|额度|余额)\s*[:：]?\s*([$¥￥]?\s*[-+]?\d+(?:,\d{3})*(?:\.\d+)?)/i,
              /([$¥￥]\s*[-+]?\d+(?:\.\d+)?)\s*(?:账户余额|当前余额|余额)/i,
              /(?:账户余额|当前余额|可用额度|余额)[^$¥￥\d]{0,16}([$¥￥]\s*\d+(?:\.\d+)?)/i,
              /(?:账户余额|当前余额|可用额度|余额)[\s\S]{0,40}?([$¥￥]\s*\d+(?:\.\d{1,4})?)/i
            ];
            for (const re of patterns) {
              const m = n.match(re) || bodyText.match(re);
              if (m?.[1]) return m[1];
            }
            if (/无限额度|额度\s*[:：]?\s*无限/i.test(n)) return '无限';
            return null;
          })();
          const textUsage = (() => {
            const n = bodyText.replace(/\s+/g, ' ');
            let m = n.match(/(?:历史消耗|已用额度|已用|用量)\s*[:：]?\s*([$¥￥]?\s*[-+]?\d+(?:,\d{3})*(?:\.\d+)?)/i);
            if (m?.[1]) return m[1];
            m = bodyText.match(/历史消耗[\s\S]{0,24}?([$¥￥]\s*\d+(?:\.\d{1,4})?)/i);
            return m?.[1] || null;
          })();

          // Semi Statistic：找含「余额」的节点旁数字
          let domBalance = null;
          try {
            const all = document.querySelectorAll('div,span,p,h1,h2,h3,h4,label');
            for (const el of all) {
              const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
              if (!t || t.length > 40) continue;
              if (!/^(账户余额|当前余额|可用额度|剩余额度|余额|Balance)$/i.test(t)
                && !/余额|额度/.test(t)) continue;
              // 邻近兄弟 / 父级
              const parent = el.parentElement;
              const chunk = (parent?.innerText || el.innerText || '').replace(/\s+/g, ' ');
              const m = chunk.match(/([$¥￥]\s*\d+(?:,\d{3})*(?:\.\d{1,4})?)/);
              if (m?.[1]) {
                domBalance = m[1];
                break;
              }
              const next = el.nextElementSibling;
              const nt = (next?.textContent || '').trim();
              if (/^[$¥￥]?\s*\d/.test(nt)) {
                domBalance = nt;
                break;
              }
            }
          } catch (e) {}

          // 页面零散 sk-（无名称）作为兜底
          const keyRe = /\b((?:sk|nk|cw|api|token)-[A-Za-z0-9_\-]{16,})\b/g;
          let km;
          while ((km = keyRe.exec(bodyText)) !== null) {
            if (!/[….]{2,}$/.test(km[1])) pushKeyEntry('', km[1]);
          }
          document.querySelectorAll('input, code, [data-key], [data-token]').forEach((el) => {
            const v = el.value || el.getAttribute('data-key') || el.getAttribute('data-token') || el.textContent || '';
            const m = String(v).match(/\b((?:sk|nk|cw|api|token)-[A-Za-z0-9_\-]{16,})\b/);
            if (m) pushKeyEntry('', m[1]);
          });

          if (!isExpectedSite()) return domainChanged();
          return {
            ok: Boolean(apiHit || localHit || textBalance || domBalance || apiKeyEntries.length),
            apiHit,
            localHit,
            textBalance: textBalance || domBalance,
            textUsage,
            keys: apiKeyEntries.slice(0, 50),
            trustedKeys: trustedApiKeyEntries.slice(0, 50),
            apiKeysCount: apiKeyEntries.length,
            tokenListState,
            tokenListPath,
            hasUser: Boolean(uid || userRaw),
            userId: uid != null ? String(uid) : null,
            href: location.href,
            lastApiFail
          };
        }
      });

      const payload = results?.[0]?.result;
      if (!payload) return { ok: false, error: 'tab inject failed' };
      if (payload.code === 'tab_domain_changed') {
        return {
          ok: false,
          code: payload.code,
          error: payload.error,
          keys: [],
          trustedKeys: [],
          tokenListState: 'unavailable'
        };
      }

      let balance = null;
      let usage = null;
      let source = null;
      let via = null;

      // 优先 API（最新），其次 localStorage.user，再页面文字
      if (payload.apiHit) {
        balance = payload.apiHit.balance || null;
        usage = payload.apiHit.usage || null;
        if (!balance && payload.apiHit.balanceRaw) {
          balance = formatBalanceValue(payload.apiHit.balanceRaw.value, payload.apiHit.balanceRaw.key);
        }
        if (!usage && payload.apiHit.usageRaw) {
          usage = formatBalanceValue(payload.apiHit.usageRaw.value, payload.apiHit.usageRaw.key);
        }
        if (!balance && payload.apiHit.data) {
          balance = extractBalanceFromData(payload.apiHit.data);
          usage = usage || extractUsageFromData(payload.apiHit.data);
        }
        source = payload.apiHit.path;
        via = 'tab-api';
      }

      if (!balance && !usage && payload.localHit) {
        balance = payload.localHit.balance || null;
        usage = payload.localHit.usage || null;
        source = 'localStorage.user';
        via = 'local-user';
      }

      if (!balance && payload.textBalance) {
        const t = String(payload.textBalance).replace(/\s+/g, '');
        if (t === '无限' || /无限/.test(t)) balance = '无限';
        else balance = /^[$¥￥]/.test(t) ? t : `$${t.replace(/[$¥￥]/g, '')}`;
        source = source || 'page-text';
        via = via || 'page-text';
      }
      if (!usage && payload.textUsage) {
        const t = String(payload.textUsage).replace(/\s+/g, '');
        usage = /^[$¥￥]/.test(t) ? t : `$${t.replace(/[$¥￥]/g, '')}`;
      }

      if (balance || usage) {
        return {
          ok: true,
          balance: balance || null,
          usage: usage || null,
          source,
          via,
            keys: payload.keys || [],
            trustedKeys: payload.trustedKeys || [],
            tokenListState: payload.tokenListState || 'unavailable',
            tokenListPath: payload.tokenListPath || '',
            hasUser: payload.hasUser,
          userId: payload.userId,
          href: payload.href
        };
      }

      let err = payload.lastApiFail || 'no balance field';
      if (!payload.hasUser && (err === 'no balance field' || err === 'HTTP 401')) {
        err = 'not logged in';
      }
      return {
        ok: false,
        balance: null,
        usage: null,
        source,
        via,
        keys: payload.keys || [],
        trustedKeys: payload.trustedKeys || [],
        tokenListState: payload.tokenListState || 'unavailable',
        tokenListPath: payload.tokenListPath || '',
        hasUser: payload.hasUser,
        userId: payload.userId,
        href: payload.href,
        error: humanizeBalanceError(err)
      };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  async function fetchBalanceViaTab(tabId, type, options = {}) {
    return scrapeTabBalanceAndKeys(tabId, type, options);
  }

  root.scrapeTabBalanceAndKeys = scrapeTabBalanceAndKeys;
  root.fetchBalanceViaTab = fetchBalanceViaTab;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      scrapeTabBalanceAndKeys,
      fetchBalanceViaTab
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
