(function (root) {
  const STORAGE_KEY = 'sites';
  const PREFS_KEY = 'prefs';
  const CHECKIN_SYNC_META_KEY = 'checkinSyncMeta';
  const SITE_BACKUPS_KEY = 'siteBackups';
  const BALANCE_REFRESH_PROGRESS_KEY = 'balanceRefreshProgress';
  const SITE_DATA_META_KEY = 'siteDataMeta';
  const SITE_DATA_SCHEMA_VERSION = 5;
  const MAX_SITE_BACKUPS = 3;
  const SITE_BACKUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  /**
   * 有序迁移：键为「目标版本号」。从 meta.schemaVersion 起逐级 +1 直到 SITE_DATA_SCHEMA_VERSION。
   * 1: 历史占位；2: 旧域名去重；3-4: 安全规范化；5: 按完整 Origin 去重
   */
  const SITE_DATA_MIGRATIONS = {
    1: (sites) => (Array.isArray(sites) ? sites : []),
    2: (sites) => (typeof root.dedupeSitesByDomain === 'function'
      ? root.dedupeSitesByDomain(sites)
      : (Array.isArray(sites) ? sites : [])),
    3: (sites) => {
      const list = Array.isArray(sites) ? sites : [];
      if (typeof root.normalizeSite !== 'function') return list;
      return list.map((site) => root.normalizeSite(site)).filter(Boolean);
    },
    4: (sites) => {
      const list = Array.isArray(sites) ? sites : [];
      if (typeof root.normalizeSite !== 'function') return list;
      return list.map((site) => root.normalizeSite(site)).filter(Boolean);
    },
    5: (sites) => (typeof root.dedupeSitesByOrigin === 'function'
      ? root.dedupeSitesByOrigin(sites)
      : (Array.isArray(sites) ? sites : []))
  };
  // chrome.storage 没有 compare-and-swap。所有站点变更都经由此队列执行，
  // 让每个变更基于上一个变更后的最新快照，避免余额/签到/编辑相互覆盖。
  let siteMutationQueue = Promise.resolve();
  let prefsMutationQueue = Promise.resolve();
  let backupMutationQueue = Promise.resolve();
  let balanceProgressMutationQueue = Promise.resolve();

  function chromeStorageGet(keys) {
    return new Promise((resolve, reject) => {
      if (typeof chrome === 'undefined' || !chrome.storage?.local) {
        reject(new Error('chrome.storage unavailable'));
        return;
      }
      chrome.storage.local.get(keys, (result) => {
        const err = chrome.runtime?.lastError;
        if (err) reject(new Error(err.message));
        else resolve(result || {});
      });
    });
  }

  function chromeStorageSet(data) {
    return new Promise((resolve, reject) => {
      if (typeof chrome === 'undefined' || !chrome.storage?.local) {
        reject(new Error('chrome.storage unavailable'));
        return;
      }
      chrome.storage.local.set(data, () => {
        const err = chrome.runtime?.lastError;
        if (err) reject(new Error(err.message));
        else resolve();
      });
    });
  }

  function normalizePrefs(raw = {}) {
    const cat = typeof root.normalizeCategory === 'function'
      ? root.normalizeCategory(raw.defaultCategory)
      : (raw.defaultCategory === 'relay' ? 'relay' : 'gongyi');
    return {
      // 兼容旧字段：收藏扩展不再自动同步签到
      autoSyncCheckin: raw.autoSyncCheckin === true,
      // 新收藏默认分类：gongyi 公益站 / relay 中转站
      defaultCategory: cat,
      // 列表筛选记忆：all | gongyi | relay
      listCategoryFilter: ['all', 'gongyi', 'relay'].includes(raw.listCategoryFilter)
        ? raw.listCategoryFilter
        : 'all',
      // 自动创建 Key 时是否使用无限额度+永不过期（默认 false：约 $10 / 90 天）
      preferUnlimitedAutoKey: raw.preferUnlimitedAutoKey === true
    };
  }

  function normalizeSiteDataMeta(raw = {}) {
    const schemaVersion = Math.min(
      SITE_DATA_SCHEMA_VERSION,
      Math.max(0, toFiniteNonnegativeInteger(raw.schemaVersion))
    );
    const normalized = { schemaVersion };
    const migratedAt = Number(raw.migratedAt) || null;
    const updatedAt = Number(raw.updatedAt) || null;
    if (migratedAt) normalized.migratedAt = migratedAt;
    if (updatedAt) normalized.updatedAt = updatedAt;
    return normalized;
  }

  function toFiniteNonnegativeInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
  }

  function normalizeCheckinSyncMeta(raw = {}) {
    const lastRunAt = Number(raw.lastRunAt);
    return {
      lastRunAt: Number.isFinite(lastRunAt) && Number.isInteger(lastRunAt) && lastRunAt > 0
        ? lastRunAt
        : null,
      requested: toFiniteNonnegativeInteger(raw.requested),
      sent: toFiniteNonnegativeInteger(raw.sent),
      verified: toFiniteNonnegativeInteger(raw.verified),
      failed: toFiniteNonnegativeInteger(raw.failed),
      skipped: toFiniteNonnegativeInteger(raw.skipped)
    };
  }

  function normalizeBalanceRefreshProgress(raw = {}) {
    const total = toFiniteNonnegativeInteger(raw.total);
    const completed = Math.min(total, toFiniteNonnegativeInteger(raw.completed));
    const succeeded = Math.min(completed, toFiniteNonnegativeInteger(raw.succeeded));
    const failed = Math.min(completed - succeeded, toFiniteNonnegativeInteger(raw.failed));
    const status = ['idle', 'running', 'stopping', 'stopped', 'interrupted', 'completed'].includes(raw.status)
      ? raw.status
      : 'idle';
    const normalized = { status, total, completed, succeeded, failed };
    const skipped = Math.min(completed - succeeded - failed, toFiniteNonnegativeInteger(raw.skipped));
    if (skipped) normalized.skipped = skipped;
    const currentSiteName = String(raw.currentSiteName || '').trim().slice(0, 60);
    if (currentSiteName) normalized.currentSiteName = currentSiteName;
    const pendingSiteIds = [...new Set((Array.isArray(raw.pendingSiteIds) ? raw.pendingSiteIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean))].slice(0, 1000);
    if (pendingSiteIds.length) normalized.pendingSiteIds = pendingSiteIds;
    const runId = String(raw.runId || '').trim().slice(0, 80);
    if (runId) normalized.runId = runId;
    const startedAt = Number(raw.startedAt) || null;
    const finishedAt = Number(raw.finishedAt) || null;
    const interruptedAt = Number(raw.interruptedAt) || null;
    const stopRequestedAt = Number(raw.stopRequestedAt) || null;
    const stoppedAt = Number(raw.stoppedAt) || null;
    if (startedAt) normalized.startedAt = startedAt;
    if (finishedAt) normalized.finishedAt = finishedAt;
    if (interruptedAt) normalized.interruptedAt = interruptedAt;
    if (stopRequestedAt) normalized.stopRequestedAt = stopRequestedAt;
    if (stoppedAt) normalized.stoppedAt = stoppedAt;
    const scope = normalizeBalanceRefreshScope(raw.scope);
    if (scope) normalized.scope = scope;
    return normalized;
  }

  function normalizeBalanceRefreshScope(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const kind = ['all', 'failed', 'explicit'].includes(raw.kind)
      ? raw.kind
      : null;
    if (!kind) return null;
    const siteIds = [...new Set((Array.isArray(raw.siteIds) ? raw.siteIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean))].sort();
    return { kind, siteIds };
  }

  async function loadSiteDataMeta() {
    const data = await chromeStorageGet([SITE_DATA_META_KEY]);
    return normalizeSiteDataMeta(data[SITE_DATA_META_KEY] || {});
  }

  async function loadBalanceRefreshProgress() {
    const data = await chromeStorageGet([BALANCE_REFRESH_PROGRESS_KEY]);
    return normalizeBalanceRefreshProgress(data[BALANCE_REFRESH_PROGRESS_KEY] || {});
  }

  function saveBalanceRefreshProgress(raw, options = {}) {
    const hasExpectedRunId = Object.hasOwn(options, 'expectedRunId');
    const expectedRunId = String(options.expectedRunId || '').trim();
    const expectedStatuses = Array.isArray(options.expectedStatuses)
      ? options.expectedStatuses.map((status) => String(status || '')).filter(Boolean)
      : [];
    const operation = balanceProgressMutationQueue.then(async () => {
      if (hasExpectedRunId || expectedStatuses.length) {
        const current = await loadBalanceRefreshProgress();
        if (hasExpectedRunId && String(current.runId || '') !== expectedRunId) return current;
        if (expectedStatuses.length && !expectedStatuses.includes(current.status)) return current;
      }
      const normalized = normalizeBalanceRefreshProgress(raw);
      await chromeStorageSet({ [BALANCE_REFRESH_PROGRESS_KEY]: normalized });
      return normalized;
    });
    balanceProgressMutationQueue = operation.catch(() => undefined);
    return operation;
  }

  async function loadCheckinSyncMeta() {
    const data = await chromeStorageGet([CHECKIN_SYNC_META_KEY]);
    return normalizeCheckinSyncMeta(data[CHECKIN_SYNC_META_KEY] || {});
  }

  async function saveCheckinSyncMeta(raw) {
    const normalized = normalizeCheckinSyncMeta(raw);
    await chromeStorageSet({ [CHECKIN_SYNC_META_KEY]: normalized });
    return normalized;
  }

  async function loadPrefs() {
    const data = await chromeStorageGet([PREFS_KEY]);
    return normalizePrefs(data[PREFS_KEY] || {});
  }

  async function savePrefs(patch = {}) {
    const operation = prefsMutationQueue.then(async () => {
      const current = await loadPrefs();
      const next = normalizePrefs({ ...current, ...patch });
      await chromeStorageSet({ [PREFS_KEY]: next });
      return next;
    });
    prefsMutationQueue = operation.catch(() => undefined);
    return operation;
  }

  async function loadSites() {
    const data = await chromeStorageGet([STORAGE_KEY]);
    const sites = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
    return typeof root.dedupeSitesByOrigin === 'function'
      ? root.dedupeSitesByOrigin(sites)
      : sites;
  }

  async function saveSites(sites) {
    const normalized = typeof root.dedupeSitesByOrigin === 'function'
      ? root.dedupeSitesByOrigin(sites)
      : (Array.isArray(sites) ? sites : []);
    const now = Date.now();
    const currentMeta = await loadSiteDataMeta();
    await chromeStorageSet({
      [STORAGE_KEY]: normalized,
      [SITE_DATA_META_KEY]: {
        ...currentMeta,
        schemaVersion: SITE_DATA_SCHEMA_VERSION,
        updatedAt: now
      }
    });
    return normalized;
  }

  function enqueueSiteMutation(task) {
    const operation = siteMutationQueue.then(task);
    // 某次写入失败不能阻塞后续用户操作。
    siteMutationQueue = operation.catch(() => undefined);
    return operation;
  }

  async function mutateSites(mutator) {
    if (typeof mutator !== 'function') throw new Error('无效站点变更');
    return enqueueSiteMutation(async () => {
      const current = await loadSites();
      const next = await mutator(current);
      return saveSites(next);
    });
  }

  async function migrateSiteData() {
    return enqueueSiteMutation(async () => {
      const data = await chromeStorageGet([STORAGE_KEY, SITE_DATA_META_KEY]);
      const rawSites = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
      const previous = normalizeSiteDataMeta(data[SITE_DATA_META_KEY] || {});
      let sites = rawSites;
      let version = previous.schemaVersion;
      let ranMigration = false;

      while (version < SITE_DATA_SCHEMA_VERSION) {
        const nextVersion = version + 1;
        const migrate = SITE_DATA_MIGRATIONS[nextVersion];
        if (typeof migrate === 'function') {
          // eslint-disable-next-line no-await-in-loop
          sites = await migrate(sites);
        }
        version = nextVersion;
        ranMigration = true;
      }

      if (typeof root.dedupeSitesByOrigin === 'function') {
        sites = root.dedupeSitesByOrigin(sites);
      }
      const needsNormalization = JSON.stringify(rawSites) !== JSON.stringify(sites);
      const meta = {
        schemaVersion: SITE_DATA_SCHEMA_VERSION,
        migratedAt: ranMigration ? Date.now() : previous.migratedAt,
        updatedAt: previous.updatedAt || Date.now()
      };
      if (ranMigration || needsNormalization) {
        // 迁移前保留一次原始快照，便于端口/Origin 解析出现问题时回滚。
        if (ranMigration && rawSites.length) {
          await createSiteBackup(rawSites, 'before-schema-migration');
        }
        meta.updatedAt = Date.now();
        if (needsNormalization && !ranMigration) {
          meta.migratedAt = previous.migratedAt || Date.now();
        }
        await chromeStorageSet({ [STORAGE_KEY]: sites, [SITE_DATA_META_KEY]: meta });
      }
      return {
        sites,
        meta,
        migrated: ranMigration || needsNormalization
      };
    });
  }

  function cloneSites(sites) {
    return JSON.parse(JSON.stringify(Array.isArray(sites) ? sites : []));
  }

  function normalizeSiteBackups(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((item) => item && typeof item === 'object' && Array.isArray(item.sites))
      .map((item) => ({
        id: String(item.id || '').trim(),
        reason: String(item.reason || 'manual').slice(0, 40),
        createdAt: Number(item.createdAt) || 0,
        sites: cloneSites(item.sites)
      }))
      .filter((item) => item.id && item.createdAt > 0)
      .filter((item) => item.createdAt >= Date.now() - SITE_BACKUP_TTL_MS)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_SITE_BACKUPS);
  }

  function siteBackupInfo(backup) {
    if (!backup) return null;
    const sites = Array.isArray(backup.sites) ? backup.sites : [];
    const keyCount = sites.reduce((total, site) => total + (Array.isArray(site?.keys) ? site.keys.length : 0), 0);
    const completeKeyCount = sites.reduce((total, site) => total + (site?.keys || []).filter((key) =>
      typeof root.isCompleteApiKey === 'function' ? root.isCompleteApiKey(key?.key) : Boolean(key?.key)
    ).length, 0);
    return {
      id: backup.id,
      reason: backup.reason,
      createdAt: backup.createdAt,
      siteCount: sites.length,
      keyCount,
      completeKeyCount
    };
  }

  function enqueueBackupMutation(task) {
    const operation = backupMutationQueue.then(task);
    backupMutationQueue = operation.catch(() => undefined);
    return operation;
  }

  async function readSiteBackupsUnlocked() {
    const data = await chromeStorageGet([SITE_BACKUPS_KEY]);
    const raw = Array.isArray(data[SITE_BACKUPS_KEY]) ? data[SITE_BACKUPS_KEY] : [];
    return { raw, normalized: normalizeSiteBackups(raw) };
  }

  async function writeSiteBackupsUnlocked(backups) {
    const normalized = normalizeSiteBackups(backups);
    await chromeStorageSet({ [SITE_BACKUPS_KEY]: normalized });
    return normalized;
  }

  async function loadSiteBackups() {
    return enqueueBackupMutation(async () => {
      const { raw, normalized } = await readSiteBackupsUnlocked();
      if (JSON.stringify(raw) !== JSON.stringify(normalized)) {
        await chromeStorageSet({ [SITE_BACKUPS_KEY]: normalized });
      }
      return normalized;
    });
  }

  async function saveSiteBackups(backups) {
    return enqueueBackupMutation(() => writeSiteBackupsUnlocked(backups));
  }

  async function createSiteBackup(sites, reason = 'manual') {
    const snapshot = cloneSites(sites);
    if (!snapshot.length) return null;
    const backup = {
      id: typeof root.createId === 'function' ? root.createId('backup') : `backup_${Date.now()}`,
      reason: String(reason || 'manual').slice(0, 40),
      createdAt: Date.now(),
      sites: snapshot
    };
    return enqueueBackupMutation(async () => {
      const { normalized: existing } = await readSiteBackupsUnlocked();
      await writeSiteBackupsUnlocked([backup, ...existing]);
      return siteBackupInfo(backup);
    });
  }

  async function getLatestSiteBackup() {
    const [latest] = await loadSiteBackups();
    return siteBackupInfo(latest);
  }

  async function listSiteBackups() {
    return (await loadSiteBackups()).map(siteBackupInfo).filter(Boolean);
  }

  async function deleteSiteBackup(id) {
    const targetId = String(id || '').trim();
    if (!targetId) return listSiteBackups();
    return enqueueBackupMutation(async () => {
      const { normalized: backups } = await readSiteBackupsUnlocked();
      const next = await writeSiteBackupsUnlocked(
        backups.filter((item) => item.id !== targetId)
      );
      return next.map(siteBackupInfo).filter(Boolean);
    });
  }

  async function clearSiteBackups() {
    return enqueueBackupMutation(async () => {
      await writeSiteBackupsUnlocked([]);
      return [];
    });
  }

  async function restoreSiteBackup(id) {
    const backups = await loadSiteBackups();
    const backup = backups.find((item) => item.id === id) || null;
    if (!backup) throw new Error('找不到可恢复的导入快照');
    let safetyBackup = null;
    const sites = await mutateSites(async (current) => {
      safetyBackup = await createSiteBackup(current, 'before-restore');
      return backup.sites;
    });
    return { sites, restored: siteBackupInfo(backup), safetyBackup };
  }

  async function upsertSite(partial) {
    return mutateSites((sites) => {
      const rawPartial = partial && typeof partial === 'object' ? partial : {};
      const hasOwn = (key) => Object.prototype.hasOwnProperty.call(rawPartial, key);
      const hasCheckinOptIn = hasOwn('checkinOptIn') || hasOwn('enableCheckin');
      const hasCheckinSync = hasOwn('checkinSync');
      const hasSyncedToCheckinAt = hasOwn('syncedToCheckinAt');
      const incoming = root.normalizeSite?.(partial);
      if (!incoming) throw new Error('无效站点');

      const incomingIdentity = root.siteIdentity?.(incoming);
      const index = sites.findIndex((site) => root.siteIdentity?.(site) === incomingIdentity);
      if (index === -1) {
        if (typeof root.ensureUniqueSiteIds === 'function') {
          const reserved = root.ensureUniqueSiteIds([...sites, incoming]);
          incoming.id = reserved[reserved.length - 1].id;
        }
        sites.unshift(incoming);
      } else {
        const prev = sites[index];
        const keyMap = new Map();
        for (const k of [...(prev.keys || []), ...(incoming.keys || [])]) {
          if (k?.key) keyMap.set(k.key, k);
        }
        const mergedRaw = {
          ...prev,
          ...incoming,
          id: prev.id,
          keys: Array.from(keyMap.values()),
          createdAt: prev.createdAt || incoming.createdAt,
          updatedAt: Date.now()
        };
        if (!hasCheckinOptIn) mergedRaw.checkinOptIn = prev.checkinOptIn;
        if (!hasCheckinSync) mergedRaw.checkinSync = prev.checkinSync;
        else mergedRaw.checkinSync = rawPartial.checkinSync;
        if (!hasSyncedToCheckinAt) mergedRaw.syncedToCheckinAt = prev.syncedToCheckinAt;
        else mergedRaw.syncedToCheckinAt = rawPartial.syncedToCheckinAt;

        const merged = root.normalizeSite?.(mergedRaw);
        if (!merged) throw new Error('无效站点');
        merged.id = prev.id;
        merged.createdAt = prev.createdAt || merged.createdAt;
        sites[index] = merged;
      }
      return sites;
    });
  }

  async function updateSiteById(id, patch, options = {}) {
    return mutateSites((sites) => {
      const index = sites.findIndex((s) => s.id === id);
      if (index === -1) throw new Error('站点不存在');
      const previousIdentity = root.siteIdentity?.(sites[index]) || '';
      const expectedIdentity = String(options?.expectedIdentity || '').trim().toLowerCase();
      if (expectedIdentity && expectedIdentity !== previousIdentity) {
        throw new Error('站点地址已修改，已拒绝写入过期结果');
      }
      const merged = root.normalizeSite?.({
        ...sites[index],
        ...patch,
        id: sites[index].id,
        domain: patch.domain || sites[index].domain,
        updatedAt: Date.now()
      });
      if (!merged) throw new Error('无效站点');
      const mergedIdentity = root.siteIdentity?.(merged);
      if (mergedIdentity !== previousIdentity) {
        throw new Error('Origin 不支持直接修改，请删除旧站点后重新添加');
      }
      const conflict = sites.find((site, itemIndex) =>
        itemIndex !== index && root.siteIdentity?.(site) === mergedIdentity);
      if (conflict) throw new Error('Origin 已存在');
      sites[index] = merged;
      return sites;
    });
  }

  async function removeSiteById(id) {
    return mutateSites((sites) => sites.filter((s) => s.id !== id));
  }

  async function removeSitesByIds(ids) {
    const idSet = new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean));
    if (!idSet.size) return loadSites();
    return mutateSites((sites) => sites.filter((s) => !idSet.has(String(s.id))));
  }

  async function addKeyToSite(siteId, keyEntry) {
    return mutateSites((sites) => {
      const site = sites.find((s) => s.id === siteId);
      if (!site) throw new Error('站点不存在');
      const key = root.normalizeKey?.(keyEntry);
      if (!key || (typeof root.isCompleteApiKey === 'function' && !root.isCompleteApiKey(key.key))) {
        throw new Error('无效 Key：请粘贴完整、未脱敏的 API Key');
      }
      if ((site.keys || []).some((k) => k.key === key.key)) throw new Error('Key 已存在');
      const isFirst = !(site.keys || []).length;
      if (isFirst || keyEntry?.isDefault === true) key.isDefault = true;
      let keys = [...(site.keys || []), key];
      if (key.isDefault) {
        keys = keys.map((k) => ({ ...k, isDefault: k.id === key.id }));
      }
      site.keys = typeof root.ensureDefaultKeys === 'function'
        ? root.ensureDefaultKeys(keys)
        : keys;
      site.updatedAt = Date.now();
      return sites;
    });
  }

  async function removeKeyFromSite(siteId, keyId) {
    return mutateSites((sites) => {
      const site = sites.find((s) => s.id === siteId);
      if (!site) throw new Error('站点不存在');
      const keys = (site.keys || []).filter((k) => k.id !== keyId);
      site.keys = typeof root.ensureDefaultKeys === 'function'
        ? root.ensureDefaultKeys(keys)
        : keys;
      site.updatedAt = Date.now();
      return sites;
    });
  }

  async function setDefaultKey(siteId, keyId) {
    return mutateSites((sites) => {
      const site = sites.find((s) => s.id === siteId);
      if (!site) throw new Error('站点不存在');
      const exists = (site.keys || []).some((k) => k.id === keyId);
      if (!exists) throw new Error('Key 不存在');
      site.keys = (site.keys || []).map((k) => ({
        ...k,
        isDefault: k.id === keyId
      }));
      site.updatedAt = Date.now();
      return sites;
    });
  }

  async function importSites(incomingSites, { mode = 'merge' } = {}) {
    if (!Array.isArray(incomingSites) || !incomingSites.length) {
      throw new Error('导入内容中没有可用站点，已取消以保护现有数据');
    }
    return mutateSites((existing) => root.mergeSites?.(
      mode === 'replace' ? [] : existing,
      incomingSites,
      { preferIncoming: mode === 'replace' || mode === 'merge' }
    ) || []);
  }

  async function replaceSitesWithBackup(incomingSites, reason = 'before-replace-import') {
    if (!Array.isArray(incomingSites) || !incomingSites.length) {
      throw new Error('导入内容中没有可用站点，已取消以保护现有数据');
    }
    return enqueueSiteMutation(async () => {
      const current = await loadSites();
      const backup = await createSiteBackup(current, reason);
      const next = root.mergeSites?.(
        [],
        incomingSites,
        { preferIncoming: true }
      ) || [];
      const sites = await saveSites(next);
      return { sites, backup };
    });
  }

  root.STORAGE_KEY = STORAGE_KEY;
  root.PREFS_KEY = PREFS_KEY;
  root.CHECKIN_SYNC_META_KEY = CHECKIN_SYNC_META_KEY;
  root.SITE_BACKUPS_KEY = SITE_BACKUPS_KEY;
  root.BALANCE_REFRESH_PROGRESS_KEY = BALANCE_REFRESH_PROGRESS_KEY;
  root.SITE_DATA_META_KEY = SITE_DATA_META_KEY;
  root.SITE_DATA_SCHEMA_VERSION = SITE_DATA_SCHEMA_VERSION;
  root.SITE_DATA_MIGRATIONS = SITE_DATA_MIGRATIONS;
  root.loadPrefs = loadPrefs;
  root.savePrefs = savePrefs;
  root.normalizePrefs = normalizePrefs;
  root.normalizeCheckinSyncMeta = normalizeCheckinSyncMeta;
  root.normalizeBalanceRefreshProgress = normalizeBalanceRefreshProgress;
  root.normalizeBalanceRefreshScope = normalizeBalanceRefreshScope;
  root.loadBalanceRefreshProgress = loadBalanceRefreshProgress;
  root.saveBalanceRefreshProgress = saveBalanceRefreshProgress;
  root.loadCheckinSyncMeta = loadCheckinSyncMeta;
  root.saveCheckinSyncMeta = saveCheckinSyncMeta;
  root.loadSites = loadSites;
  root.saveSites = saveSites;
  root.mutateSites = mutateSites;
  root.normalizeSiteDataMeta = normalizeSiteDataMeta;
  root.loadSiteDataMeta = loadSiteDataMeta;
  root.migrateSiteData = migrateSiteData;
  root.loadSiteBackups = loadSiteBackups;
  root.createSiteBackup = createSiteBackup;
  root.getLatestSiteBackup = getLatestSiteBackup;
  root.listSiteBackups = listSiteBackups;
  root.deleteSiteBackup = deleteSiteBackup;
  root.clearSiteBackups = clearSiteBackups;
  root.restoreSiteBackup = restoreSiteBackup;
  root.upsertSite = upsertSite;
  root.updateSiteById = updateSiteById;
  root.removeSiteById = removeSiteById;
  root.removeSitesByIds = removeSitesByIds;
  root.addKeyToSite = addKeyToSite;
  root.removeKeyFromSite = removeKeyFromSite;
  root.setDefaultKey = setDefaultKey;
  root.importSites = importSites;
  root.replaceSitesWithBackup = replaceSitesWithBackup;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      STORAGE_KEY,
      PREFS_KEY,
      CHECKIN_SYNC_META_KEY,
      SITE_BACKUPS_KEY,
      BALANCE_REFRESH_PROGRESS_KEY,
      SITE_DATA_META_KEY,
      SITE_DATA_SCHEMA_VERSION,
      SITE_DATA_MIGRATIONS,
      loadPrefs,
      savePrefs,
      normalizePrefs,
      normalizeCheckinSyncMeta,
      normalizeBalanceRefreshProgress,
      normalizeBalanceRefreshScope,
      loadBalanceRefreshProgress,
      saveBalanceRefreshProgress,
      loadCheckinSyncMeta,
      saveCheckinSyncMeta,
      loadSites,
      saveSites,
      mutateSites,
      normalizeSiteDataMeta,
      loadSiteDataMeta,
      migrateSiteData,
      loadSiteBackups,
      createSiteBackup,
      getLatestSiteBackup,
      listSiteBackups,
      deleteSiteBackup,
      clearSiteBackups,
      restoreSiteBackup,
      upsertSite,
      updateSiteById,
      removeSiteById,
      removeSitesByIds,
      addKeyToSite,
      setDefaultKey,
      removeKeyFromSite,
      importSites,
      replaceSitesWithBackup
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
