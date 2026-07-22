(function (root) {
  const MAX_ID_LENGTH = 120;
  const MAX_RUN_ID_LENGTH = 80;
  const MAX_URL_LENGTH = 4096;
  const MAX_TEXT_BYTES = 2 * 1024 * 1024;
  const MAX_KEY_BYTES = 8 * 1024;
  const MAX_SITE_IDS = 1000;

  const MESSAGE_TYPES = Object.freeze([
    'listSites',
    'getPrefs',
    'savePrefs',
    'saveCurrentTab',
    'detectSite',
    'detectAndSave',
    'batchDetectAndSave',
    'redetectSite',
    'upsertSite',
    'updateSite',
    'removeSite',
    'removeSites',
    'addKey',
    'removeKey',
    'setDefaultKey',
    'refreshBalance',
    'refreshAllBalances',
    'stopBalanceRefresh',
    'retryFailedBalances',
    'openFailedBalanceSites',
    'getBalanceRefreshProgress',
    'export',
    'requestUnauthorizedSiteAccess',
    'getOrphanedSiteAccess',
    'removeOrphanedSiteAccess',
    'getDiagnostics',
    'import',
    'previewImport',
    'getLatestSiteBackup',
    'listSiteBackups',
    'deleteSiteBackup',
    'clearSiteBackups',
    'restoreSiteBackup',
    'openUrl',
    'openTokenPage',
    'pushToCheckin',
    'retryFailedCheckin',
    'getCheckinStatus',
    'setCheckinOptIn',
    'pingCheckin',
    'formatClientSnippet',
    'ensureSiteKey',
    'importKeysFromPage'
  ]);
  const MESSAGE_TYPE_SET = new Set(MESSAGE_TYPES);

  const REQUIRED_ID_FIELDS = Object.freeze({
    redetectSite: ['id'],
    updateSite: ['id'],
    removeSite: ['id'],
    addKey: ['siteId'],
    removeKey: ['siteId', 'keyId'],
    setDefaultKey: ['siteId', 'keyId'],
    refreshBalance: ['id'],
    deleteSiteBackup: ['id'],
    restoreSiteBackup: ['id'],
    openTokenPage: ['id'],
    setCheckinOptIn: ['id'],
    formatClientSnippet: ['id'],
    ensureSiteKey: ['id'],
    importKeysFromPage: ['id']
  });

  function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function utf8ByteLength(value) {
    const text = String(value ?? '');
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
    if (typeof Buffer !== 'undefined') return Buffer.byteLength(text, 'utf8');
    return unescape(encodeURIComponent(text)).length;
  }

  function failure(code, error) {
    return { ok: false, code, error };
  }

  function validIdentifier(value, maxLength = MAX_ID_LENGTH) {
    if (typeof value !== 'string') return false;
    const normalized = value.trim();
    return Boolean(normalized)
      && normalized.length <= maxLength
      && !/[\u0000-\u001f\u007f]/.test(value);
  }

  function validateIdentifierArray(value) {
    return Array.isArray(value)
      && value.length <= MAX_SITE_IDS
      && value.every((item) => validIdentifier(item));
  }

  function validateBoundedText(value, maxLength = MAX_TEXT_BYTES) {
    return value == null || (typeof value === 'string' && utf8ByteLength(value) <= maxLength);
  }

  function validateRuntimeMessage(message) {
    if (!isRecord(message) || typeof message.type !== 'string') {
      return failure('invalid_message', '扩展请求格式无效');
    }
    const type = message.type.trim();
    if (!MESSAGE_TYPE_SET.has(type)) {
      return failure('unknown_message', '不支持的扩展请求');
    }

    for (const field of REQUIRED_ID_FIELDS[type] || []) {
      if (!validIdentifier(message[field])) {
        return failure('invalid_message', '扩展请求缺少有效标识');
      }
    }

    if (message.siteId != null && !validIdentifier(message.siteId)) {
      return failure('invalid_message', '扩展请求包含无效站点标识');
    }
    if (message.runId != null && !validIdentifier(message.runId, MAX_RUN_ID_LENGTH)) {
      return failure('invalid_message', '余额任务标识无效');
    }
    if (message.url != null && !validateBoundedText(message.url, MAX_URL_LENGTH)) {
      return failure('message_too_large', '链接内容过长');
    }
    if (message.input != null && !validateBoundedText(message.input)) {
      return failure('message_too_large', '输入内容超过 2 MB 上限');
    }
    if (message.text != null && !validateBoundedText(message.text)) {
      return failure('message_too_large', '输入内容超过 2 MB 上限');
    }
    if (message.ids != null && !validateIdentifierArray(message.ids)) {
      return failure('invalid_message', '站点标识列表无效或超过 1000 项');
    }
    if (message.siteIds != null && !validateIdentifierArray(message.siteIds)) {
      return failure('invalid_message', '站点标识列表无效或超过 1000 项');
    }
    if (type === 'openTokenPage' && message.background != null && typeof message.background !== 'boolean') {
      return failure('invalid_message', '令牌页打开方式无效');
    }

    if (type === 'removeSites' && !Array.isArray(message.ids)) {
      return failure('invalid_message', '批量删除请求缺少站点列表');
    }
    if (type === 'savePrefs') {
      const prefs = message.prefs ?? message.patch;
      if (prefs != null && !isRecord(prefs)) {
        return failure('invalid_message', '偏好设置格式无效');
      }
    }
    if (type === 'upsertSite' && !isRecord(message.site)) {
      return failure('invalid_message', '站点数据格式无效');
    }
    if (type === 'updateSite' && !isRecord(message.patch)) {
      return failure('invalid_message', '站点更新格式无效');
    }
    if (type === 'addKey') {
      if (typeof message.key !== 'string' && !isRecord(message.key)) {
        return failure('invalid_message', 'Key 数据格式无效');
      }
      let keyPayload = '';
      try {
        keyPayload = typeof message.key === 'string'
          ? message.key
          : JSON.stringify(message.key);
      } catch (error) {
        return failure('invalid_message', 'Key 数据格式无效');
      }
      if (utf8ByteLength(keyPayload) > MAX_KEY_BYTES) {
        return failure('message_too_large', 'Key 内容过长');
      }
    }
    if ((type === 'import' || type === 'previewImport') && message.config != null) {
      if (!isRecord(message.config)) return failure('invalid_message', '导入配置格式无效');
      let serialized = '';
      try {
        serialized = JSON.stringify(message.config);
      } catch (error) {
        return failure('invalid_message', '导入配置无法序列化');
      }
      if (utf8ByteLength(serialized) > MAX_TEXT_BYTES) {
        return failure('message_too_large', '导入内容超过 2 MB 上限');
      }
    }

    return { ok: true, type, message };
  }

  function validateRuntimeSender(sender, runtimeId) {
    const expectedId = String(runtimeId || '').trim();
    if (!expectedId) return { ok: true };
    if (sender?.id === expectedId) return { ok: true };
    return failure('untrusted_sender', '已拒绝非本扩展发起的请求');
  }

  const api = {
    MESSAGE_TYPES,
    MAX_ID_LENGTH,
    MAX_RUN_ID_LENGTH,
    MAX_TEXT_BYTES,
    MAX_KEY_BYTES,
    MAX_SITE_IDS,
    validateRuntimeMessage,
    validateRuntimeSender
  };

  root.PublicSiteMessageContract = api;

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
