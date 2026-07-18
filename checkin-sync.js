(function (root) {
  function isSuccessful(response) {
    if (response?.ok === false || response?.success === false) return false;
    return response?.ok === true || response?.success === true;
  }

  function normalizeError(error, fallbackCode = 'unknown', fallbackMessage = '同步失败') {
    const source = error && typeof error === 'object' ? error : {};
    const nested = source.error && typeof source.error === 'object' ? source.error : {};
    return {
      code: String(source.code || nested.code || fallbackCode).slice(0, 40) || fallbackCode,
      message: String(source.message || nested.message || source.error || fallbackMessage).slice(0, 200)
    };
  }

  function summarizeCheckinResults(results, lastRunAt, skipped = 0) {
    const list = Array.isArray(results) ? results : [];
    return {
      lastRunAt,
      requested: list.length,
      sent: list.filter((item) => item?.status === 'sent').length,
      verified: list.filter((item) => item?.status === 'verified').length,
      failed: list.filter((item) => item?.ok === false).length,
      skipped: Math.max(0, Number(skipped) || 0)
    };
  }

  function createCheckinSyncService(deps = {}) {
    const now = deps.now || Date.now;
    const loadSites = deps.loadSites;
    const saveSites = deps.saveSites;
    const mutateSites = deps.mutateSites;
    const saveMeta = deps.saveMeta;
    const ping = deps.ping;
    const importSites = deps.importSites;
    const readSites = deps.readSites;
    const fingerprint = deps.fingerprint || root.checkinFingerprint;
    let queue = Promise.resolve();

    const failedIds = (sites) => (Array.isArray(sites) ? sites : [])
      .filter((site) => site?.checkinOptIn === true && site.checkinSync?.status === 'failed')
      .map((site) => site.id);

    async function mergeLatestSites(targetIds, update) {
      if (typeof mutateSites === 'function') {
        return mutateSites((latestSites) => (
          (Array.isArray(latestSites) ? latestSites : []).map((site) => (
            targetIds.has(String(site.id)) ? update(site) : site
          ))
        ));
      }
      const loaded = await loadSites();
      const latestSites = Array.isArray(loaded) ? loaded : [];
      const nextSites = latestSites.map((site) => (
        targetIds.has(String(site.id)) ? update(site) : site
      ));
      const saved = await saveSites(nextSites);
      return Array.isArray(saved) ? saved : nextSites;
    }

    async function persistFailure(error, targets, attemptedAt, skipped = 0) {
      const normalized = normalizeError(error);
      const targetIds = new Set(targets.map((site) => String(site.id)));
      const results = targets.map((site) => ({
        id: site.id,
        domain: site.domain,
        ok: false,
        status: 'failed',
        error: normalized
      }));
      const nextSites = await mergeLatestSites(targetIds, (site) => ({
          ...site,
          checkinSync: {
            ...site.checkinSync,
            status: 'failed',
            lastAttemptAt: attemptedAt,
            lastError: normalized
          }
        }));
      const summary = summarizeCheckinResults(results, attemptedAt, skipped);
      await saveMeta(summary);
      return {
        ok: false,
        partial: false,
        code: normalized.code,
        error: normalized.message,
        sites: nextSites,
        results,
        summary
      };
    }

    async function runSyncByIds(ids) {
      const requestedIds = new Set((Array.isArray(ids) ? ids : [ids])
        .filter((id) => id !== undefined && id !== null)
        .map((id) => String(id).trim())
        .filter(Boolean));
      let sites = await loadSites();
      sites = Array.isArray(sites) ? sites : [];
      const targets = sites.filter((site) => (
        requestedIds.has(String(site.id)) && site.checkinOptIn === true
      ));
      const targetIds = new Set(targets.map((site) => String(site.id)));
      const skipped = Math.max(0, requestedIds.size - targets.length);
      const attemptedAt = now();

      if (!targets.length) {
        const summary = summarizeCheckinResults([], attemptedAt, skipped);
        await saveMeta(summary);
        return {
          ok: false,
          partial: false,
          code: 'no_targets',
          error: '没有可同步站点',
          sites,
          results: [],
          summary
        };
      }

      sites = await mergeLatestSites(targetIds, (site) => ({
          ...site,
          checkinSync: {
            ...site.checkinSync,
            status: 'pending',
            lastAttemptAt: attemptedAt,
            lastError: null
          }
        }));

      let connection;
      try {
        connection = await ping();
      } catch (error) {
        connection = error;
      }
      if (!isSuccessful(connection)) {
        return persistFailure(connection, targets, attemptedAt, skipped);
      }

      let imported;
      try {
        imported = await importSites(connection.id, targets);
      } catch (error) {
        imported = error;
      }
      if (!isSuccessful(imported)) {
        return persistFailure(imported, targets, attemptedAt, skipped);
      }

      const supportsRead = connection.capabilities?.readSites === true;
      let verifiedDomains = new Set();
      if (supportsRead) {
        let read;
        try {
          read = await readSites(connection.id, targets.map((site) => site.domain));
        } catch (error) {
          read = error;
        }
        if (!isSuccessful(read)) {
          const readError = normalizeError(read, 'verify_failed', '回读验证失败');
          readError.code = 'verify_failed';
          return persistFailure(readError, targets, attemptedAt, skipped);
        }
        const readList = Array.isArray(read.sites)
          ? read.sites
          : (Array.isArray(read.data?.sites) ? read.data.sites : []);
        verifiedDomains = new Set(readList
          .map((site) => String(site?.domain || '').trim().toLowerCase())
          .filter(Boolean));
      }

      const results = targets.map((target) => {
        const verified = supportsRead
          && verifiedDomains.has(String(target.domain || '').toLowerCase());
        const failed = supportsRead && !verified;
        const status = failed ? 'failed' : (verified ? 'verified' : 'sent');
        const result = { id: target.id, domain: target.domain, ok: !failed, status };
        if (failed) {
          result.error = { code: 'verify_failed', message: '目标扩展中未找到该站点' };
        }
        return result;
      });
      const resultsById = new Map(results.map((result) => [String(result.id), result]));

      sites = await mergeLatestSites(targetIds, (site) => {
        const result = resultsById.get(String(site.id));
        if (!result) return site;
        if (!result.ok) {
          return {
            ...site,
            checkinSync: {
              ...site.checkinSync,
              status: 'failed',
              lastAttemptAt: attemptedAt,
              lastError: result.error
            }
          };
        }

        const nextSync = {
          ...site.checkinSync,
          status: result.status,
          lastAttemptAt: attemptedAt,
          lastSuccessAt: attemptedAt,
          lastError: null,
          targetVersion: connection.version == null ? '' : String(connection.version),
          fingerprint: typeof fingerprint === 'function' ? fingerprint(site) : undefined
        };
        if (result.status === 'verified') nextSync.lastVerifiedAt = attemptedAt;
        return { ...site, syncedToCheckinAt: attemptedAt, checkinSync: nextSync };
      });

      const summary = summarizeCheckinResults(results, attemptedAt, skipped);
      await saveMeta(summary);
      return {
        ok: summary.failed === 0,
        partial: summary.failed > 0 && summary.sent + summary.verified > 0,
        sites,
        results,
        summary
      };
    }

    function syncByIds(ids) {
      const operation = queue.then(() => runSyncByIds(ids));
      queue = operation.catch(() => undefined);
      return operation;
    }

    return { syncByIds, failedIds };
  }

  function createCheckinActions(service, deps = {}) {
    return async function handle(action, message = {}) {
      const sites = await deps.loadSites();
      if (action === 'syncOne') {
        const target = (sites || []).find((site) => String(site.id) === String(message.id));
        if (!target) return { ok: false, code: 'site_not_found', error: '站点不存在' };
        if (target.checkinOptIn !== true) {
          await deps.updateSite(target.id, { checkinOptIn: true });
        }
        return service.syncByIds([target.id]);
      }
      if (action === 'syncEligible') {
        const ids = (sites || [])
          .filter((site) => site.checkinOptIn === true
            && ['pending', 'failed', 'stale'].includes(site.checkinSync?.status))
          .map((site) => site.id);
        return service.syncByIds(ids);
      }
      if (action === 'retryFailed') {
        return service.syncByIds(service.failedIds(sites));
      }
      return { ok: false, code: 'unknown_action', error: '未知签到操作' };
    };
  }

  root.summarizeCheckinResults = summarizeCheckinResults;
  root.createCheckinSyncService = createCheckinSyncService;
  root.createCheckinActions = createCheckinActions;

  const isCommonJs = typeof module !== 'undefined' && module.exports;
  if (!isCommonJs
    && typeof root.loadSites === 'function'
    && typeof root.saveSites === 'function'
    && typeof root.saveCheckinSyncMeta === 'function'
    && typeof root.pingCheckin === 'function'
    && typeof root.importCheckinSites === 'function'
    && typeof root.readCheckinSites === 'function'
    && typeof root.updateSiteById === 'function') {
    const service = createCheckinSyncService({
      loadSites: root.loadSites,
      saveSites: root.saveSites,
      mutateSites: root.mutateSites,
      saveMeta: root.saveCheckinSyncMeta,
      ping: root.pingCheckin,
      importSites: root.importCheckinSites,
      readSites: root.readCheckinSites
    });
    root.handleCheckinAction = createCheckinActions(service, {
      loadSites: root.loadSites,
      updateSite: root.updateSiteById
    });
  }

  if (isCommonJs) {
    module.exports = {
      summarizeCheckinResults,
      createCheckinSyncService,
      createCheckinActions
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
