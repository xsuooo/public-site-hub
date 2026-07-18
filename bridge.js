(function (root) {
  // 与「公益站签到」扩展通信：通过 management 按名称查找 extensionId。

  const CHECKIN_NAMES = ['公益站签到', 'Public Check-in'];

  async function discoverCheckinExtension() {
    if (typeof chrome === 'undefined' || !chrome.management?.getAll) {
      return {
        ok: false,
        code: 'permission_missing',
        error: '缺少 management 权限，无法查找签到扩展'
      };
    }
    try {
      const list = await chrome.management.getAll();
      const matches = list.filter((e) =>
        e
        && e.type === 'extension'
        && CHECKIN_NAMES.includes(e.name)
      );
      const hit = matches.find((e) => e.enabled);
      if (!hit && matches.length) {
        return {
          ok: false,
          code: 'extension_disabled',
          error: '已找到「公益站签到」，但扩展未启用。请先在 chrome://extensions 启用它。'
        };
      }
      if (!hit) {
        return {
          ok: false,
          code: 'extension_not_found',
          error: '未找到「公益站签到」。请先在 chrome://extensions 加载并启用它。'
        };
      }
      return { ok: true, id: hit.id, name: hit.name, version: hit.version };
    } catch (e) {
      return { ok: false, code: 'unknown', error: String(e?.message || e) };
    }
  }

  const findCheckinExtension = discoverCheckinExtension;

  function toCheckinSite(site) {
    const rawDomain = String(site?.domain || '').trim().toLowerCase();
    const domain = typeof root.normalizeDomain === 'function'
      ? root.normalizeDomain(rawDomain)
      : rawDomain;
    if (!domain) return null;
    const item = {
      domain,
      name: String(site?.name || domain).slice(0, 60),
      enabled: true,
      mode: 'checkin',
      type: ['newapi', 'sub2api', 'zenapi', 'auto'].includes(site?.type) ? site.type : 'auto',
      group: typeof root.categoryLabel === 'function'
        ? root.categoryLabel(site?.category)
        : (site?.category === 'relay' ? '中转站' : '公益站')
    };
    item.pageUrl = `https://${domain}/`;
    return item;
  }

  function sendToExtension(extensionId, message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(extensionId, message, (response) => {
          const err = chrome.runtime.lastError;
          if (err) {
            resolve({ ok: false, code: 'no_response', error: err.message });
            return;
          }
          resolve(response || {
            ok: false,
            code: 'no_response',
            error: '签到扩展无响应'
          });
        });
      } catch (e) {
        resolve({ ok: false, code: 'unknown', error: String(e?.message || e) });
      }
    });
  }

  function normalizeCheckinCapabilities(raw) {
    return { readSites: raw?.readSites === true };
  }

  async function pingCheckin() {
    const found = await discoverCheckinExtension();
    if (!found.ok) return found;
    const res = await sendToExtension(found.id, { action: 'ping' });
    if (!res.ok && !res.success) {
      return {
        ok: false,
        code: res.code,
        error: res.error || '无法连接签到扩展（请确认两边都已重新加载）',
        id: found.id
      };
    }
    return {
      ok: true,
      id: found.id,
      name: found.name,
      version: res.version || found.version,
      capabilities: normalizeCheckinCapabilities(res.capabilities)
    };
  }

  function importCheckinSites(extensionId, sites) {
    const list = (Array.isArray(sites) ? sites : [sites]).map(toCheckinSite).filter(Boolean);
    return sendToExtension(extensionId, {
      action: 'importSitesFromHub',
      sites: list,
      updateExisting: true
    });
  }

  function readCheckinSites(extensionId, domains) {
    const normalizedDomains = (Array.isArray(domains) ? domains : [domains])
      .map((domain) => String(domain || '').trim().toLowerCase())
      .filter(Boolean);
    return sendToExtension(extensionId, {
      action: 'getSitesForHub',
      domains: normalizedDomains
    });
  }

  /**
   * 推送到签到扩展。
   * 批量默认仅 checkinOptIn 的站（公益/中转均可）。
   * options.force=true：单站「加入签到」用，不要求事先 opt-in。
   */
  async function pushSitesToCheckin(sites, options = {}) {
    const raw = Array.isArray(sites) ? sites : [sites];
    const force = options.force === true;
    const eligible = raw.filter((s) => {
      if (!s?.domain) return false;
      if (typeof root.isCheckinEligible === 'function') {
        return root.isCheckinEligible(s, { requireOptIn: !force });
      }
      if (!force && s.checkinOptIn !== true) return false;
      return true;
    });

    const skippedNoOptIn = Math.max(0, raw.length - eligible.length);

    const list = eligible.map(toCheckinSite).filter(Boolean);
    if (!list.length) {
      return {
        ok: false,
        error: '没有已标记「可签到」的站点。请在卡片「更多」点「加入签到」逐个标记（公益/中转均可）',
        skippedNoOptIn,
        pushed: 0
      };
    }

    const found = await discoverCheckinExtension();
    if (!found.ok) return found;

    const res = await sendToExtension(found.id, {
      action: 'importSitesFromHub',
      sites: list,
      updateExisting: true
    });

    if (!res || res.ok === false || res.success === false) {
      return {
        ok: false,
        error: res?.error || '推送失败',
        id: found.id
      };
    }
    if (res.success === false && res.ok !== true) {
      return { ok: false, error: res.error || '推送失败', id: found.id };
    }

    const newCount = res.newCount ?? 0;
    const updatedCount = res.updatedCount ?? 0;
    const skipped = res.skipped ?? 0;
    return {
      ok: true,
      id: found.id,
      newCount,
      updatedCount,
      skipped,
      skippedNoOptIn,
      pushed: list.length,
      total: res.total,
      message: `已同步 ${list.length} 个可签到站：新增 ${newCount}，更新 ${updatedCount}`
        + (skipped ? `，签到侧跳过 ${skipped}` : '')
    };
  }

  /** 复制调用地址：仅 https://域名/v1（Key 请用「复制 Key」） */
  function formatClientSnippet(site) {
    if (typeof root.formatApiBaseV1 === 'function') {
      const base = root.formatApiBaseV1(site);
      if (base) return base;
    }
    try {
      const raw = site?.baseUrl || site?.pageUrl || site?.domain || '';
      const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (url.protocol === 'https:' && url.hostname) return `${url.origin}/v1`;
    } catch (e) {}
    return '';
  }

  function detectionNeedsHelp(detection) {
    if (!detection) return true;
    if (!detection.ok) return true;
    const t = detection.detectedType || detection.type;
    return t === 'unknown' || t === 'auto' || detection.confidence === 'low';
  }

  function formatDetectionPanel(detection, site) {
    if (!detection) {
      return {
        kind: 'warn',
        title: '未执行自动识别',
        body: '可点「重新识别」，或手动选择类型。',
        needsHelp: true
      };
    }
    if (!detection.ok) {
      return {
        kind: 'err',
        title: '识别失败',
        body: detection.error || '请打开站点并登录后重试',
        needsHelp: true,
        openUrl: site?.pageUrl || site?.baseUrl || (detection.domain ? `https://${detection.domain}` : '')
      };
    }
    const signals = (detection.signals || []).slice(0, 5).join(' · ') || '无信号';
    const confMap = { high: '高', medium: '中', low: '低' };
    const conf = confMap[detection.confidence] || detection.confidence || '—';
    const needsHelp = detectionNeedsHelp(detection);
    return {
      kind: needsHelp ? 'warn' : 'ok',
      title: detection.summary || `识别为 ${detection.typeLabel || detection.type}`,
      body: `类型 ${detection.typeLabel || detection.type} · 置信 ${conf}\n${signals}`,
      needsHelp,
      openUrl: detection.pageUrl || site?.pageUrl || site?.baseUrl
    };
  }

  root.discoverCheckinExtension = discoverCheckinExtension;
  root.findCheckinExtension = findCheckinExtension;
  root.sendToExtension = sendToExtension;
  root.normalizeCheckinCapabilities = normalizeCheckinCapabilities;
  root.pingCheckin = pingCheckin;
  root.importCheckinSites = importCheckinSites;
  root.readCheckinSites = readCheckinSites;
  root.pushSitesToCheckin = pushSitesToCheckin;
  root.toCheckinSite = toCheckinSite;
  root.formatClientSnippet = formatClientSnippet;
  root.detectionNeedsHelp = detectionNeedsHelp;
  root.formatDetectionPanel = formatDetectionPanel;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      discoverCheckinExtension,
      findCheckinExtension,
      sendToExtension,
      normalizeCheckinCapabilities,
      pingCheckin,
      importCheckinSites,
      readCheckinSites,
      pushSitesToCheckin,
      toCheckinSite,
      formatClientSnippet,
      detectionNeedsHelp,
      formatDetectionPanel,
      CHECKIN_NAMES
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
