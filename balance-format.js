(function (root) {
  // NewAPI 常见：quota / 500000 = 美元余额
  const QUOTA_UNIT = 500000;

  // 优先顺序：额度类字段在前，避免 dashboard 里无关 amount 抢先
  const BALANCE_KEYS = [
    'quota', 'remain_quota', 'remaining_quota', 'available_quota',
    'balance', 'wallet_balance', 'remaining_balance', 'remain_balance',
    'available_balance', 'credit', 'credits', 'money', 'wallet', 'amount'
  ];

  const USAGE_KEYS = [
    'used_quota', 'used', 'usage', 'total_used', 'used_amount', 'request_count'
  ];

  function formatNumber(value) {
    if (Math.abs(value - Math.round(value)) < 0.000001) return String(Math.round(value));
    return value.toFixed(2);
  }

  function isPlainNumberLike(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return true;
    if (typeof value === 'string') {
      const t = value.replace(/\s+/g, '').replace(/[$¥￥,]/g, '');
      return t !== '' && Number.isFinite(Number(t));
    }
    if (typeof value === 'boolean') return false;
    return false;
  }

  function resolveQuotaUnit(unit) {
    const n = Number(unit);
    if (Number.isFinite(n) && n > 0 && n < 1e12) return n;
    return QUOTA_UNIT;
  }

  /**
   * 将 quota/金额格式化为展示字符串。
   * @param unit NewAPI quota_per_unit，默认 500000
   */
  function formatBalanceValue(value, key = '', unit = QUOTA_UNIT) {
    const quotaUnit = resolveQuotaUnit(unit);
    if (value === null || value === undefined || value === '') return null;
    // NewAPI unlimited
    if (value === true || value === 'unlimited' || value === -1) {
      if (/unlimited|quota|remain/i.test(key) || value === -1 || value === true) {
        if (value === true || value === 'unlimited' || value === -1) return '无限';
      }
    }
    if (typeof value === 'boolean') return null;
    if (typeof value === 'object') return null;

    if (typeof value === 'string') {
      const normalized = value.replace(/\s+/g, ' ').trim();
      if (!normalized) return null;
      if (/无限|unlimited/i.test(normalized)) return '无限';
      const numeric = Number(normalized.replace(/[$¥￥,]/g, ''));
      if (!Number.isFinite(numeric)) return normalized;
      if (/quota/i.test(key)) return sanitizeDollarDisplay(numeric / quotaUnit, numeric, key, quotaUnit);
      if (/^[$¥￥]/.test(normalized)) return normalized.replace(/\s+/g, '');
      return formatNumber(numeric);
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    // NewAPI：-1 常表示无限额度
    if (numeric < 0 && /quota/i.test(key)) return '无限';
    if (/quota/i.test(key)) return sanitizeDollarDisplay(numeric / quotaUnit, numeric, key, quotaUnit);
    return formatNumber(numeric);
  }

  /**
   * 离谱美元值纠偏：例如单位错了会出现上亿。
   * 若 dollars > 1e5，尝试默认 500000 单位或当作已是美元。
   */
  function sanitizeDollarDisplay(dollars, rawNumeric, key, usedUnit) {
    if (!Number.isFinite(dollars)) return null;
    if (dollars < 0) return '无限';
    if (dollars <= 100000) return `$${dollars.toFixed(2)}`;

    // 试标准单位
    if (usedUnit !== QUOTA_UNIT) {
      const alt = rawNumeric / QUOTA_UNIT;
      if (alt >= 0 && alt <= 100000) return `$${alt.toFixed(2)}`;
    }
    // 原始数本身就像美元（小于 1e5）
    if (rawNumeric >= 0 && rawNumeric <= 100000) return `$${Number(rawNumeric).toFixed(2)}`;
    // 仍离谱：截断展示并标异常（避免 UI 出现 $100008542）
    return `$${(rawNumeric / QUOTA_UNIT).toFixed(2)}`;
  }

  function isSuspiciousBalance(balanceStr) {
    if (!balanceStr || balanceStr === '无限') return false;
    const n = Number(String(balanceStr).replace(/[$¥￥,\s]/g, ''));
    return Number.isFinite(n) && n > 100000;
  }

  /** 按 keys 优先序找第一个「像数字」的字段（不扫对象） */
  function walkFind(data, keys, unit = QUOTA_UNIT) {
    if (!data || typeof data !== 'object') return null;
    const wanted = keys.map((k) => k.toLowerCase());

    function search(rootObj) {
      const queue = [rootObj];
      const visited = new Set();
      while (queue.length) {
        const cur = queue.shift();
        if (!cur || typeof cur !== 'object' || visited.has(cur)) continue;
        visited.add(cur);
        for (const want of wanted) {
          for (const [key, child] of Object.entries(cur)) {
            if (key.toLowerCase() !== want) continue;
            if (!isPlainNumberLike(child) && child !== -1 && child !== true && child !== 'unlimited') {
              if (!(child === -1 || child === true || child === 'unlimited')) continue;
            }
            const formatted = formatBalanceValue(child, key, unit);
            if (formatted) return formatted;
          }
        }
        for (const child of Object.values(cur)) {
          if (child && typeof child === 'object') queue.push(child);
        }
      }
      return null;
    }
    return search(data);
  }

  function extractBalanceFromData(data, unit = QUOTA_UNIT) {
    // NewAPI：success:false 时 data 可能为空对象，直接判失败
    if (data && data.success === false) return null;
    return walkFind(data, BALANCE_KEYS, unit);
  }

  function extractUsageFromData(data, unit = QUOTA_UNIT) {
    if (data && data.success === false) return null;
    return walkFind(data, USAGE_KEYS, unit);
  }

  /** 从 NewAPI user 对象（localStorage / API data）抽余额 */
  function extractFromUserObject(user, unit = QUOTA_UNIT) {
    if (!user) return null;
    let o = user;
    if (typeof user === 'string') {
      try { o = JSON.parse(user); } catch (e) { return null; }
    }
    if (!o || typeof o !== 'object') return null;
    // 嵌套 data
    const u = o.data && typeof o.data === 'object' && (o.data.quota != null || o.data.used_quota != null)
      ? o.data
      : o;

    if (u.unlimited_quota === true) {
      return {
        balance: '无限',
        usage: formatBalanceValue(u.used_quota, 'used_quota', unit)
      };
    }
    const balance = formatBalanceValue(
      u.quota != null ? u.quota : (u.remain_quota != null ? u.remain_quota : u.balance),
      u.quota != null ? 'quota' : (u.remain_quota != null ? 'remain_quota' : 'balance'),
      unit
    );
    const usage = formatBalanceValue(
      u.used_quota != null ? u.used_quota : u.used,
      u.used_quota != null ? 'used_quota' : 'used',
      unit
    );
    if (!balance && !usage) return null;
    return { balance: balance || null, usage: usage || null };
  }

  /** 从页面可见文字识别「余额 $2.28」 */
  function extractBalanceFromText(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return null;
    const patterns = [
      /(?:账户余额|账号余额|当前余额|剩余余额|可用额度|剩余额度|额度|余额|Balance|Credit|Credits)\s*[:：]?\s*([$¥￥]?\s*[-+]?\d+(?:,\d{3})*(?:\.\d+)?)/i,
      /([$¥￥]\s*[-+]?\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:账户余额|账号余额|当前余额|剩余余额|可用额度|余额|Balance)/i,
      // 标签与金额之间夹杂其它字
      /(?:账户余额|当前余额|可用额度|剩余额度|余额)[^$¥￥\d]{0,16}([$¥￥]\s*\d+(?:,\d{3})*(?:\.\d+)?)/i,
      // 换行场景：余额\n$1.23
      /(?:账户余额|当前余额|可用额度|余额)[\s\S]{0,24}?([$¥￥]\s*\d+(?:\.\d{1,4})?)/i
    ];
    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match?.[1]) {
        const v = formatBalanceValue(match[1]);
        if (v) return v.startsWith('$') || v.startsWith('¥') || v.startsWith('￥') || v === '无限'
          ? v
          : `$${v}`;
      }
    }
    if (/无限额度|额度\s*无限|unlimited\s*quota/i.test(normalized)) return '无限';
    return null;
  }

  function extractUsageFromText(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return null;
    const patterns = [
      /(?:历史消耗|已用额度|已用|用量|Used)\s*[:：]?\s*([$¥￥]?\s*[-+]?\d+(?:,\d{3})*(?:\.\d+)?)/i,
      /历史消耗[^$¥￥\d]{0,12}([$¥￥]\s*\d+(?:\.\d+)?)/i,
      /历史消耗[\s\S]{0,24}?([$¥￥]\s*\d+(?:\.\d{1,4})?)/i
    ];
    for (const pattern of patterns) {
      const m = normalized.match(pattern);
      if (m?.[1]) {
        const v = formatBalanceValue(m[1]);
        return v ? (v.startsWith('$') || v.startsWith('¥') || v === '无限' ? v : `$${v}`) : null;
      }
    }
    return null;
  }

  function buildAuthHeaders(apiKey) {
    const key = String(apiKey || '').trim();
    if (!key) return {};
    if (/^bearer\s+/i.test(key)) return { Authorization: key };
    return { Authorization: `Bearer ${key}` };
  }

  function candidatePaths(type) {
    if (type === 'sub2api') {
      return ['/api/v1/user/self', '/api/v1/user/info', '/api/v1/user', '/api/user/self'];
    }
    if (type === 'zenapi') {
      return ['/api/u/dashboard', '/api/u/user', '/api/user/self'];
    }
    // NewAPI：self 最准；dashboard 可能无 quota
    return ['/api/user/self', '/api/user/dashboard', '/api/user', '/api/user/info'];
  }

  function candidateTokenPaths(type) {
    if (type === 'sub2api') return ['/api/v1/token/?p=0&size=100', '/api/v1/tokens'];
    if (type === 'zenapi') return ['/api/u/tokens', '/api/tokens'];
    return ['/api/token/?p=0&size=100', '/api/token/?p=0', '/api/tokens'];
  }

  function humanizeBalanceError(code) {
    const map = {
      'invalid domain': '域名无效',
      'no response': '无响应：请先登录该站',
      'no balance field': '未解析到余额，请登录后再试',
      'not logged in': '未登录：请先打开并登录该站',
      'HTTP 401': '未授权：请登录（sk- 不能代替登录）',
      'HTTP 403': '无权限：请登录该站',
      'HTTP 404': '接口不存在：可重新识别',
      'HTTP 0': '请求失败或超时'
    };
    if (map[code]) return map[code];
    if (/^HTTP \d+/.test(code)) return `请求失败（${code}）`;
    if (/abort/i.test(code)) return '请求超时';
    return code || '余额获取失败';
  }

  /** 卡片上用的短文案；完整说明仍走 classify / toast */
  function shortBalanceErrorMessage(lastError = {}) {
    const code = String(lastError.code || '').trim();
    const map = {
      permission_denied: '未授权访问',
      timeout: '查询超时',
      invalid_domain: '域名无效',
      tab_open_failed: '无法打开页面',
      wrong_type: '类型可能不对',
      not_logged_in: '未登录',
      parse_failed: '未解析到余额',
      network_error: '网络异常',
      refresh_failed: '余额失败'
    };
    if (map[code]) return map[code];
    const msg = String(lastError.message || '').replace(/\s+/g, ' ').trim();
    if (!msg) return '余额失败';
    return msg.length > 28 ? `${msg.slice(0, 26)}…` : msg;
  }

  /**
   * 将原始余额错误归类为稳定 code + 用户文案 + 建议动作。
   * action: open_site | open_token | redetect | retry_permission | null
   */
  function classifyBalanceError(rawError, rawCode = '') {
    const text = String(rawError || '').replace(/\s+/g, ' ').trim();
    const codeHint = String(rawCode || '').trim();
    const blob = `${codeHint} ${text}`;

    if (
      codeHint === 'site_permission_denied'
      || codeHint === 'site_permission_required'
      || codeHint === 'permission_denied'
      || /站点访问权限|未获得站点访问|site_permission/i.test(blob)
    ) {
      return {
        code: 'permission_denied',
        message: text || '未获得站点访问权限；余额查询不会执行',
        action: 'retry_permission'
      };
    }
    if (
      codeHint === 'timeout'
      || /abort|timeout|超时/i.test(blob)
    ) {
      return {
        code: 'timeout',
        message: text && /超时|timeout|abort/i.test(text) && text.length <= 40
          ? text
          : '查询超时，可稍后重试',
        action: 'open_site'
      };
    }
    if (codeHint === 'invalid_domain' || /invalid domain|域名无效/i.test(blob)) {
      return { code: 'invalid_domain', message: '域名无效', action: null };
    }
    if (
      codeHint === 'tab_open_failed'
      || /无法打开站点标签|无法打开.*标签/i.test(blob)
    ) {
      return {
        code: 'tab_open_failed',
        message: text && text.length <= 40 ? text : '无法打开页面，请先登录该站',
        action: 'open_site'
      };
    }
    if (
      codeHint === 'wrong_type'
      || /HTTP 404|接口不存在|重新识别站点类型/i.test(blob)
    ) {
      return {
        code: 'wrong_type',
        message: text && /404|接口|识别/.test(text)
          ? humanizeBalanceError(text.startsWith('HTTP') ? text : 'HTTP 404')
          : '接口不存在：可重新识别站点类型',
        action: 'redetect'
      };
    }
    if (
      codeHint === 'not_logged_in'
      || /HTTP 401|HTTP 403|not logged in|未登录|未授权|登录态|个人中心|sk- 不能代替/i.test(blob)
    ) {
      return {
        code: 'not_logged_in',
        message: text && /登录|授权|个人中心|sk-/.test(text)
          ? text.slice(0, 200)
          : humanizeBalanceError('not logged in'),
        action: 'open_site'
      };
    }
    if (
      codeHint === 'parse_failed'
      || /no balance field|未解析到余额/i.test(blob)
    ) {
      return {
        code: 'parse_failed',
        message: humanizeBalanceError('no balance field'),
        action: 'open_site'
      };
    }
    if (
      codeHint === 'network_error'
      || /HTTP 0|no response|请求失败或超时|Failed to fetch|NetworkError/i.test(blob)
    ) {
      return {
        code: 'network_error',
        message: text && text.length < 120 ? text : humanizeBalanceError('no response'),
        action: 'open_site'
      };
    }

    const message = text
      ? (text.length > 200 ? `${text.slice(0, 197)}…` : text)
      : '余额获取失败';
    return {
      code: codeHint && codeHint !== 'refresh_failed' ? codeHint.slice(0, 40) : 'refresh_failed',
      message,
      action: 'open_site'
    };
  }


  root.QUOTA_UNIT = QUOTA_UNIT;
  root.formatBalanceValue = formatBalanceValue;
  root.extractBalanceFromData = extractBalanceFromData;
  root.extractUsageFromData = extractUsageFromData;
  root.extractBalanceFromText = extractBalanceFromText;
  root.extractUsageFromText = extractUsageFromText;
  root.extractFromUserObject = extractFromUserObject;
  root.isSuspiciousBalance = isSuspiciousBalance;
  root.resolveQuotaUnit = resolveQuotaUnit;
  root.buildAuthHeaders = buildAuthHeaders;
  root.candidateBalancePaths = candidatePaths;
  root.candidateTokenPaths = candidateTokenPaths;
  root.humanizeBalanceError = humanizeBalanceError;
  root.shortBalanceErrorMessage = shortBalanceErrorMessage;
  root.classifyBalanceError = classifyBalanceError;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      QUOTA_UNIT,
      formatBalanceValue,
      extractBalanceFromData,
      extractUsageFromData,
      extractBalanceFromText,
      extractUsageFromText,
      extractFromUserObject,
      isSuspiciousBalance,
      resolveQuotaUnit,
      buildAuthHeaders,
      candidatePaths,
      candidateTokenPaths,
      humanizeBalanceError,
      shortBalanceErrorMessage,
      classifyBalanceError
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
