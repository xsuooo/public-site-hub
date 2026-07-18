(function (root) {
  function sendMessage(type, payload = {}) {
    return new Promise((resolve) => {
      try {
        root.chrome.runtime.sendMessage({ type, ...payload }, (response) => {
          const error = root.chrome.runtime.lastError;
          resolve(error
            ? { ok: false, error: error.message }
            : (response || { ok: false, error: 'no response' }));
        });
      } catch (error) {
        resolve({ ok: false, error: String(error?.message || error) });
      }
    });
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/'/g, '&#39;');
  }

  function isUsableKey(value) {
    if (typeof root.isCompleteApiKey === 'function') {
      return root.isCompleteApiKey(value);
    }
    const key = String(value || '').trim();
    return key.length > 12
      && /^[A-Za-z0-9._~-]+$/.test(key)
      && !/\.{2,}/.test(key)
      && !/[•●○◦∙·…*]/.test(key);
  }

  function keyActionsFor(value) {
    const usable = isUsableKey(value);
    return { canCopy: usable, canSetDefault: usable };
  }

  async function writeClipboard(text, clipboard = root.navigator?.clipboard) {
    try {
      if (!clipboard?.writeText) throw new Error('剪贴板不可用');
      await clipboard.writeText(String(text ?? ''));
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: String(error?.message || error || '复制失败')
      };
    }
  }

  function debounce(fn, wait = 120) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  const api = {
    sendMessage,
    escapeHtml,
    escapeAttr,
    isUsableKey,
    keyActionsFor,
    writeClipboard,
    debounce
  };

  root.PublicSiteUi = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof self !== 'undefined' ? self : globalThis);
