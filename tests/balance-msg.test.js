const assert = require('node:assert/strict');
const test = require('node:test');
const balance = require('../balance.js');
const balanceFormat = require('../balance-format.js');
const tabApiKey = require('../tab-api-key.js');
const pageScrape = require('../page-scrape.js');

if (!global.location) {
  global.location = { origin: 'https://example.com', href: 'https://example.com/' };
}

test('balance-format pure helpers match balance re-exports', () => {
  assert.equal(balanceFormat.formatBalanceValue(1000000, 'quota'), balance.formatBalanceValue(1000000, 'quota'));
  assert.equal(balanceFormat.classifyBalanceError('HTTP 401').code, 'not_logged_in');
  assert.equal(balance.classifyBalanceError('HTTP 401').code, 'not_logged_in');
});

test('tab-api-key module exports create and verify entry points used by balance', () => {
  assert.equal(typeof tabApiKey.createTabApiKey, 'function');
  assert.equal(typeof tabApiKey.verifyNewApiTabAccount, 'function');
  assert.equal(typeof balance.createTabApiKey, 'function');
  assert.equal(typeof balance.verifyNewApiTabAccount, 'function');
});

test('page-scrape module exports tab scrape entry points used by balance', () => {
  assert.equal(typeof pageScrape.scrapeTabBalanceAndKeys, 'function');
  assert.equal(typeof pageScrape.fetchBalanceViaTab, 'function');
  assert.equal(typeof balance.scrapeTabBalanceAndKeys, 'function');
  assert.equal(typeof balance.fetchBalanceViaTab, 'function');
});

test('privileged page and Key operations fail closed without an expected Origin', async () => {
  assert.equal((await balance.scrapeTabBalanceAndKeys(17, 'newapi')).code, 'expected_origin_required');
  assert.equal((await balance.verifyNewApiTabAccount(17, { userId: '1' })).code, 'expected_origin_required');
  assert.equal((await balance.createTabApiKey(17, 'newapi', { expectedUserId: '1' })).code, 'expected_origin_required');
});

test('verifyNewApiTabAccount rejects nullish or stringified-null account identities', async () => {
  const origin = 'https://account.example.com';
  for (const session of [
    { userId: null, token: 'session-token' },
    { userId: undefined, token: 'session-token' },
    { userId: 'null', token: 'session-token' },
    { userId: 'undefined', token: 'session-token' },
    null,
    undefined
  ]) {
    const result = await tabApiKey.verifyNewApiTabAccount(17, session, origin);
    assert.equal(result.ok, false, String(session));
    assert.equal(result.code, 'account_identity_unavailable', String(session));
  }
});

test('page-scrape inspectTokenList is total-aware for empty pages with positive total', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'page-scrape.js'), 'utf8');
  // 注入脚本内的判定必须 total 感知，且与 tab-api-key.pickList 行为一致。
  assert.match(source, /numericTotal === 0 \? 'empty' : 'with-tokens'/);
  assert.match(source, /unknown-empty/);
  assert.match(source, /tokenListState = inspected\.state/);
  assert.doesNotMatch(
    source,
    /tokenListState = list\.length \? 'with-tokens' : 'empty'/
  );
});

test('humanizeBalanceError maps common codes', () => {
  assert.match(balance.humanizeBalanceError('HTTP 401'), /未授权|登录|Key/);
  assert.match(balance.humanizeBalanceError('no balance field'), /余额/);
  assert.equal(balance.humanizeBalanceError('invalid domain'), '域名无效');
  assert.match(balance.humanizeBalanceError('not logged in'), /登录/);
});

test('classifyBalanceError grades failures into stable codes and actions', () => {
  assert.equal(balance.classifyBalanceError('HTTP 401').code, 'not_logged_in');
  assert.equal(balance.classifyBalanceError('HTTP 401').action, 'open_site');
  assert.equal(balance.classifyBalanceError('HTTP 404').code, 'wrong_type');
  assert.equal(balance.classifyBalanceError('HTTP 404').action, 'redetect');
  assert.equal(balance.classifyBalanceError('no balance field').code, 'parse_failed');
  assert.equal(balance.classifyBalanceError('aborted', 'timeout').code, 'timeout');
  assert.equal(balance.classifyBalanceError('需要站点访问权限', 'site_permission_denied').code, 'permission_denied');
  assert.equal(balance.classifyBalanceError('', 'site_permission_denied').action, 'retry_permission');
  assert.equal(balance.classifyBalanceError('no response').code, 'network_error');
  assert.equal(balance.classifyBalanceError('无法打开站点标签。请先登录').code, 'tab_open_failed');
});

test('shortBalanceErrorMessage is compact', () => {
  assert.equal(balanceFormat.shortBalanceErrorMessage({ code: 'not_logged_in' }), '未登录');
  assert.ok(balanceFormat.shortBalanceErrorMessage({ code: 'timeout' }).length <= 12);
  assert.equal(typeof balanceFormat.shortBalanceErrorMessage, 'function');
});

test('extractBalanceFromData reads NewAPI quota', () => {
  const bal = balance.extractBalanceFromData({
    success: true,
    data: { id: 1, quota: 1000000, used_quota: 250000 }
  });
  assert.equal(bal, '$2.00');
  const usage = balance.extractUsageFromData({
    success: true,
    data: { used_quota: 250000 }
  });
  assert.equal(usage, '$0.50');
});

test('extractFromUserObject handles unlimited', () => {
  const hit = balance.extractFromUserObject({
    id: 1,
    unlimited_quota: true,
    used_quota: 500000
  });
  assert.equal(hit.balance, '无限');
  assert.equal(hit.usage, '$1.00');
});

test('extractBalanceFromText handles 当前余额', () => {
  assert.equal(balance.extractBalanceFromText('当前余额 $3.50 历史消耗 $0.10'), '$3.50');
  assert.equal(balance.extractBalanceFromText('可用额度：$1.25'), '$1.25');
});

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; }
  };
}

function userStorage(userId) {
  return {
    getItem(key) {
      return key === 'user' ? JSON.stringify({ id: userId }) : null;
    }
  };
}

test('createTabApiKey rechecks a readable empty NewAPI list and retrieves the full created Key', async () => {
  const previousChrome = global.chrome;
  const previousFetch = global.fetch;
  const previousLocalStorage = global.localStorage;
  const previousSessionStorage = global.sessionStorage;
  const previousLocation = global.location;
  const calls = [];
  let created = false;
  global.chrome = {
    scripting: {
      async executeScript({ func, args }) {
        return [{ result: await func(...args) }];
      }
    }
  };
  global.localStorage = userStorage(1);
  global.sessionStorage = userStorage(1);
  global.location = {
    origin: 'https://example.com',
    protocol: 'https:',
    hostname: 'example.com',
    href: 'https://example.com/console/token'
  };
  global.fetch = async (url, init = {}) => {
    calls.push([url, init.method || 'GET']);
    if (url === '/api/user/self') {
      return jsonResponse({ success: true, data: { id: 1 } });
    }
    if (url === '/api/token/?p=0&size=100' && !created) {
      return jsonResponse({ success: true, data: { total: 0, items: [] } });
    }
    if (url === '/api/token/' && init.method === 'POST') {
      created = true;
      return jsonResponse({ success: true });
    }
    if (url === '/api/token/?p=0&size=100' && created) {
      return jsonResponse({
        success: true,
        data: { items: [{ id: 42, name: '公益站收藏-test', key: 'sk-...abcd' }] }
      });
    }
    if (url === '/api/token/42/key' && init.method === 'POST') {
      return jsonResponse({ success: true, data: { key: 'sk-created-0123456789' } });
    }
    return jsonResponse({ success: false, message: 'unexpected request' }, 404);
  };

  try {
    const result = await balance.createTabApiKey(17, 'newapi', {
      name: '公益站收藏-test',
      expectedUserId: '1',
      expectedOrigin: 'https://example.com'
    });
    assert.equal(result.ok, true);
    assert.equal(result.created, true);
    assert.deepEqual(result.key, { name: '公益站收藏-test', key: 'sk-created-0123456789' });
    assert.deepEqual(calls, [
      ['/api/user/self', 'GET'],
      ['/api/user/self', 'GET'],
      ['/api/token/?p=0&size=100', 'GET'],
      ['/api/user/self', 'GET'],
      ['/api/token/', 'POST'],
      ['/api/token/?p=0&size=100', 'GET'],
      ['/api/token/42/key', 'POST']
    ]);
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
    if (previousFetch === undefined) delete global.fetch;
    else global.fetch = previousFetch;
    if (previousLocalStorage === undefined) delete global.localStorage;
    else global.localStorage = previousLocalStorage;
    if (previousSessionStorage === undefined) delete global.sessionStorage;
    else global.sessionStorage = previousSessionStorage;
    if (previousLocation === undefined) delete global.location;
    else global.location = previousLocation;
  }
});

test('createTabApiKey never posts when the verified NewAPI list already has a token', async () => {
  const previousChrome = global.chrome;
  const previousFetch = global.fetch;
  const previousLocalStorage = global.localStorage;
  const previousSessionStorage = global.sessionStorage;
  const calls = [];
  global.chrome = {
    scripting: {
      async executeScript({ func, args }) {
        return [{ result: await func(...args) }];
      }
    }
  };
  global.localStorage = userStorage(1);
  global.sessionStorage = userStorage(1);
  global.fetch = async (url, init = {}) => {
    calls.push([url, init.method || 'GET']);
    if (url === '/api/user/self') {
      return jsonResponse({ success: true, data: { id: 1 } });
    }
    return jsonResponse({ success: true, data: { items: [{ id: 7, name: '已有', key: 'sk-...abcd' }] } });
  };

  try {
    const result = await balance.createTabApiKey(17, 'newapi', {
      name: '公益站收藏-test',
      expectedUserId: '1',
      expectedOrigin: 'https://example.com'
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'token_list_not_empty');
    assert.deepEqual(calls, [
      ['/api/user/self', 'GET'],
      ['/api/user/self', 'GET'],
      ['/api/token/?p=0&size=100', 'GET']
    ]);
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
    if (previousFetch === undefined) delete global.fetch;
    else global.fetch = previousFetch;
    if (previousLocalStorage === undefined) delete global.localStorage;
    else global.localStorage = previousLocalStorage;
    if (previousSessionStorage === undefined) delete global.sessionStorage;
    else global.sessionStorage = previousSessionStorage;
  }
});

test('createTabApiKey fails closed when the tab has navigated away from the saved site', async () => {
  const previousChrome = global.chrome;
  const previousFetch = global.fetch;
  const previousLocation = global.location;
  let fetchCalls = 0;
  global.chrome = { scripting: { async executeScript({ func, args }) { return [{ result: await func(...args) }]; } } };
  global.location = { hostname: 'other.example', href: 'https://other.example/console/token' };
  global.fetch = async () => {
    fetchCalls += 1;
    return jsonResponse({ success: true, data: { id: 1 } });
  };

  try {
    const result = await balance.createTabApiKey(17, 'newapi', {
      name: '公益站收藏-test',
      expectedUserId: '1',
      expectedDomain: 'saved.example'
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'tab_domain_changed');
    assert.equal(fetchCalls, 0);
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
    if (previousFetch === undefined) delete global.fetch;
    else global.fetch = previousFetch;
    if (previousLocation === undefined) delete global.location;
    else global.location = previousLocation;
  }
});

test('createTabApiKey rejects an HTTP tab even when its hostname matches the saved site', async () => {
  const previousChrome = global.chrome;
  const previousFetch = global.fetch;
  const previousLocation = global.location;
  let fetchCalls = 0;
  global.chrome = { scripting: { async executeScript({ func, args }) { return [{ result: await func(...args) }]; } } };
  global.location = {
    protocol: 'http:',
    hostname: 'saved.example',
    href: 'http://saved.example/console/token'
  };
  global.fetch = async () => {
    fetchCalls += 1;
    return jsonResponse({ success: true, data: { id: 1 } });
  };

  try {
    const result = await balance.createTabApiKey(17, 'newapi', {
      name: '公益站收藏-test',
      expectedUserId: '1',
      expectedDomain: 'saved.example'
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'tab_domain_changed');
    assert.equal(fetchCalls, 0);
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
    if (previousFetch === undefined) delete global.fetch;
    else global.fetch = previousFetch;
    if (previousLocation === undefined) delete global.location;
    else global.location = previousLocation;
  }
});

test('createTabApiKey rejects a different HTTPS port for the saved site', async () => {
  const previousChrome = global.chrome;
  const previousFetch = global.fetch;
  const previousLocation = global.location;
  let fetchCalls = 0;
  global.chrome = { scripting: { async executeScript({ func, args }) { return [{ result: await func(...args) }]; } } };
  global.location = {
    origin: 'https://saved.example:8443',
    protocol: 'https:',
    hostname: 'saved.example',
    href: 'https://saved.example:8443/console/token'
  };
  global.fetch = async () => {
    fetchCalls += 1;
    return jsonResponse({ success: true, data: { id: 1 } });
  };

  try {
    const result = await balance.createTabApiKey(17, 'newapi', {
      name: '公益站收藏-test',
      expectedUserId: '1',
      expectedOrigin: 'https://saved.example'
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'tab_domain_changed');
    assert.equal(fetchCalls, 0);
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
    if (previousFetch === undefined) delete global.fetch;
    else global.fetch = previousFetch;
    if (previousLocation === undefined) delete global.location;
    else global.location = previousLocation;
  }
});

test('createTabApiKey fails closed when the page account changes before creation', async () => {
  const previousChrome = global.chrome;
  const previousFetch = global.fetch;
  const previousLocalStorage = global.localStorage;
  const previousSessionStorage = global.sessionStorage;
  const calls = [];
  global.chrome = {
    scripting: {
      async executeScript({ func, args }) {
        return [{ result: await func(...args) }];
      }
    }
  };
  global.localStorage = userStorage(1);
  global.sessionStorage = userStorage(1);
  global.fetch = async (url, init = {}) => {
    calls.push([url, init.method || 'GET']);
    if (url === '/api/user/self') return jsonResponse({ success: true, data: { id: 2 } });
    return jsonResponse({ success: false, message: 'unexpected request' }, 404);
  };

  try {
    const result = await balance.createTabApiKey(17, 'newapi', {
      name: '公益站收藏-test',
      expectedUserId: '1',
      expectedOrigin: 'https://example.com'
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'account_mismatch');
    assert.deepEqual(calls, [
      ['/api/user/self', 'GET'],
      ['/api/user/self', 'GET']
    ]);
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
    if (previousFetch === undefined) delete global.fetch;
    else global.fetch = previousFetch;
    if (previousLocalStorage === undefined) delete global.localStorage;
    else global.localStorage = previousLocalStorage;
    if (previousSessionStorage === undefined) delete global.sessionStorage;
    else global.sessionStorage = previousSessionStorage;
  }
});

test('createTabApiKey never posts for a paginated list that reports existing tokens off-page', async () => {
  const previousChrome = global.chrome;
  const previousFetch = global.fetch;
  const previousLocalStorage = global.localStorage;
  const previousSessionStorage = global.sessionStorage;
  const calls = [];
  global.chrome = { scripting: { async executeScript({ func, args }) { return [{ result: await func(...args) }]; } } };
  global.localStorage = userStorage(1);
  global.sessionStorage = userStorage(1);
  global.fetch = async (url, init = {}) => {
    calls.push([url, init.method || 'GET']);
    if (url === '/api/user/self') return jsonResponse({ success: true, data: { id: 1 } });
    if (url === '/api/token/?p=0&size=100') {
      return jsonResponse({ success: true, data: { total: 1, items: [] } });
    }
    return jsonResponse({ success: false, message: 'unexpected request' }, 404);
  };

  try {
    const result = await balance.createTabApiKey(17, 'newapi', {
      name: '公益站收藏-test', expectedUserId: '1', expectedOrigin: 'https://example.com'
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'token_list_not_empty');
    assert.equal(calls.some(([url, method]) => url === '/api/token/' && method === 'POST'), false);
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
    if (previousFetch === undefined) delete global.fetch;
    else global.fetch = previousFetch;
    if (previousLocalStorage === undefined) delete global.localStorage;
    else global.localStorage = previousLocalStorage;
    if (previousSessionStorage === undefined) delete global.sessionStorage;
    else global.sessionStorage = previousSessionStorage;
  }
});

test('createTabApiKey re-reads a 201 creation response that has no success flag', async () => {
  const previousChrome = global.chrome;
  const previousFetch = global.fetch;
  const previousLocalStorage = global.localStorage;
  const previousSessionStorage = global.sessionStorage;
  let created = false;
  global.chrome = { scripting: { async executeScript({ func, args }) { return [{ result: await func(...args) }]; } } };
  global.localStorage = userStorage(1);
  global.sessionStorage = userStorage(1);
  global.fetch = async (url, init = {}) => {
    if (url === '/api/user/self') return jsonResponse({ success: true, data: { id: 1 } });
    if (url === '/api/token/?p=0&size=100' && !created) {
      return jsonResponse({ success: true, data: { total: 0, items: [] } });
    }
    if (url === '/api/token/' && init.method === 'POST') {
      created = true;
      return jsonResponse({ data: { id: 42 } }, 201);
    }
    if (url === '/api/token/?p=0&size=100' && created) {
      return jsonResponse({ success: true, data: { total: 1, items: [{ id: 42, name: '公益站收藏-test', key: 'sk-...abcd' }] } });
    }
    if (url === '/api/token/42/key' && init.method === 'POST') {
      return jsonResponse({ success: true, data: { key: 'sk-created-201-0123456789' } });
    }
    return jsonResponse({ success: false, message: 'unexpected request' }, 404);
  };

  try {
    const result = await balance.createTabApiKey(17, 'newapi', {
      name: '公益站收藏-test', expectedUserId: '1', expectedOrigin: 'https://example.com'
    });
    assert.equal(result.ok, true);
    assert.equal(result.key.key, 'sk-created-201-0123456789');
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
    if (previousFetch === undefined) delete global.fetch;
    else global.fetch = previousFetch;
    if (previousLocalStorage === undefined) delete global.localStorage;
    else global.localStorage = previousLocalStorage;
    if (previousSessionStorage === undefined) delete global.sessionStorage;
    else global.sessionStorage = previousSessionStorage;
  }
});

test('createTabApiKey defaults to limited quota and 90-day expiry', async () => {
  const previousChrome = global.chrome;
  const previousFetch = global.fetch;
  const previousLocalStorage = global.localStorage;
  const previousSessionStorage = global.sessionStorage;
  const previousLocation = global.location;
  let posted = null;
  let created = false;
  global.location = { origin: 'https://example.com', href: 'https://example.com/console/token' };
  global.chrome = { scripting: { async executeScript({ func, args }) { return [{ result: await func(...args) }]; } } };
  global.localStorage = userStorage(1);
  global.sessionStorage = userStorage(1);
  global.fetch = async (url, init = {}) => {
    if (url === '/api/user/self') return jsonResponse({ success: true, data: { id: 1 } });
    if (url === '/api/token/?p=0&size=100' && !created) {
      return jsonResponse({ success: true, data: { total: 0, items: [] } });
    }
    if (url === '/api/token/' && init.method === 'POST') {
      created = true;
      posted = JSON.parse(init.body);
      return jsonResponse({ success: true });
    }
    if (url === '/api/token/?p=0&size=100' && created) {
      return jsonResponse({
        success: true,
        data: { items: [{ id: 42, name: '公益站收藏-test', key: 'sk-...abcd' }] }
      });
    }
    if (url === '/api/token/42/key' && init.method === 'POST') {
      return jsonResponse({ success: true, data: { key: 'sk-created-0123456789' } });
    }
    return jsonResponse({ success: false, message: 'unexpected request' }, 404);
  };

  try {
    const before = Math.floor(Date.now() / 1000);
    const result = await balance.createTabApiKey(17, 'newapi', {
      name: '公益站收藏-test',
      expectedUserId: '1',
      expectedOrigin: 'https://example.com'
    });
    assert.equal(result.ok, true);
    assert.equal(posted.unlimited_quota, false);
    assert.equal(posted.remain_quota, 5_000_000);
    assert.ok(posted.expired_time >= before + 89 * 86400);
    assert.ok(posted.expired_time <= before + 91 * 86400);
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
    if (previousFetch === undefined) delete global.fetch;
    else global.fetch = previousFetch;
    if (previousLocalStorage === undefined) delete global.localStorage;
    else global.localStorage = previousLocalStorage;
    if (previousSessionStorage === undefined) delete global.sessionStorage;
    else global.sessionStorage = previousSessionStorage;
    if (previousLocation === undefined) delete global.location;
    else global.location = previousLocation;
  }
});

test('createTabApiKey can still post unlimited never-expire when requested', async () => {
  const previousChrome = global.chrome;
  const previousFetch = global.fetch;
  const previousLocalStorage = global.localStorage;
  const previousSessionStorage = global.sessionStorage;
  const previousLocation = global.location;
  let posted = null;
  let created = false;
  global.location = { origin: 'https://example.com', href: 'https://example.com/console/token' };
  global.chrome = { scripting: { async executeScript({ func, args }) { return [{ result: await func(...args) }]; } } };
  global.localStorage = userStorage(1);
  global.sessionStorage = userStorage(1);
  global.fetch = async (url, init = {}) => {
    if (url === '/api/user/self') return jsonResponse({ success: true, data: { id: 1 } });
    if (url === '/api/token/?p=0&size=100' && !created) {
      return jsonResponse({ success: true, data: { total: 0, items: [] } });
    }
    if (url === '/api/token/' && init.method === 'POST') {
      created = true;
      posted = JSON.parse(init.body);
      return jsonResponse({ success: true });
    }
    if (url === '/api/token/?p=0&size=100' && created) {
      return jsonResponse({
        success: true,
        data: { items: [{ id: 42, name: '公益站收藏-test', key: 'sk-...abcd' }] }
      });
    }
    if (url === '/api/token/42/key' && init.method === 'POST') {
      return jsonResponse({ success: true, data: { key: 'sk-created-0123456789' } });
    }
    return jsonResponse({ success: false, message: 'unexpected request' }, 404);
  };

  try {
    const result = await balance.createTabApiKey(17, 'newapi', {
      name: '公益站收藏-test',
      expectedUserId: '1',
      expectedOrigin: 'https://example.com',
      unlimitedQuota: true
    });
    assert.equal(result.ok, true);
    assert.equal(posted.unlimited_quota, true);
    assert.equal(posted.expired_time, -1);
    assert.equal(posted.remain_quota, 0);
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
    if (previousFetch === undefined) delete global.fetch;
    else global.fetch = previousFetch;
    if (previousLocalStorage === undefined) delete global.localStorage;
    else global.localStorage = previousLocalStorage;
    if (previousSessionStorage === undefined) delete global.sessionStorage;
    else global.sessionStorage = previousSessionStorage;
    if (previousLocation === undefined) delete global.location;
    else global.location = previousLocation;
  }
});

test('createTabApiKey checks the same account again immediately before POST', async () => {
  const previousChrome = global.chrome;
  const previousFetch = global.fetch;
  const previousLocalStorage = global.localStorage;
  const previousSessionStorage = global.sessionStorage;
  let selfReads = 0;
  const calls = [];
  global.chrome = { scripting: { async executeScript({ func, args }) { return [{ result: await func(...args) }]; } } };
  global.localStorage = userStorage(1);
  global.sessionStorage = userStorage(1);
  global.fetch = async (url, init = {}) => {
    calls.push([url, init.method || 'GET']);
    if (url === '/api/user/self') {
      selfReads += 1;
      return jsonResponse({ success: true, data: { id: selfReads >= 3 ? 2 : 1 } });
    }
    if (url === '/api/token/?p=0&size=100') {
      return jsonResponse({ success: true, data: { total: 0, items: [] } });
    }
    return jsonResponse({ success: false, message: 'unexpected request' }, 404);
  };

  try {
    const result = await balance.createTabApiKey(17, 'newapi', {
      name: '公益站收藏-test', expectedUserId: '1', expectedOrigin: 'https://example.com'
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'account_mismatch');
    assert.equal(calls.some(([url, method]) => url === '/api/token/' && method === 'POST'), false);
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
    if (previousFetch === undefined) delete global.fetch;
    else global.fetch = previousFetch;
    if (previousLocalStorage === undefined) delete global.localStorage;
    else global.localStorage = previousLocalStorage;
    if (previousSessionStorage === undefined) delete global.sessionStorage;
    else global.sessionStorage = previousSessionStorage;
  }
});

test('scrapeTabBalanceAndKeys uses the verified profile to reveal a masked NewAPI Key', async () => {
  const previousChrome = global.chrome;
  const previousFetch = global.fetch;
  const previousDocument = global.document;
  const previousLocation = global.location;
  const previousLocalStorage = global.localStorage;
  const previousSessionStorage = global.sessionStorage;
  const authCalls = [];
  const storage = {
    getItem(key) {
      if (key === 'user') return JSON.stringify({ id: 1 });
      if (key === 'auth_token') return 'token-a';
      return null;
    }
  };
  global.chrome = { scripting: { async executeScript({ func, args }) { return [{ result: await func(...args) }]; } } };
  global.localStorage = storage;
  global.sessionStorage = storage;
  global.document = {
    body: { innerText: '', textContent: '' },
    querySelectorAll() { return []; }
  };
  global.location = { origin: 'https://example.com', href: 'https://example.com/console/token' };
  global.fetch = async (url, init = {}) => {
    if (url.startsWith('/api/token')) authCalls.push([url, init.headers?.Authorization || '']);
    if (url === '/api/token/?p=0&size=100') {
      return jsonResponse({
        success: true,
        data: { total: 1, items: [{ id: 42, name: '已有', key: 'sk-**************abcd' }] }
      });
    }
    if (url === '/api/token/batch/keys') {
      return jsonResponse({ success: true, data: { keys: { 42: 'sk-real-0123456789abcd' } } });
    }
    return jsonResponse({ success: false, message: 'not found' }, 404);
  };

  try {
    const result = await balance.scrapeTabBalanceAndKeys(17, 'newapi', {
      readFullTokenKeys: true,
      authHeaders: { Authorization: 'Bearer token-a' },
      expectedOrigin: 'https://example.com'
    });
    assert.equal(result.trustedKeys.length, 1);
    assert.equal(result.trustedKeys[0].key, 'sk-real-0123456789abcd');
    assert.deepEqual(authCalls, [
      ['/api/token/?p=0&size=100', 'Bearer token-a'],
      ['/api/token/batch/keys', 'Bearer token-a']
    ]);
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
    if (previousFetch === undefined) delete global.fetch;
    else global.fetch = previousFetch;
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
    if (previousLocation === undefined) delete global.location;
    else global.location = previousLocation;
    if (previousLocalStorage === undefined) delete global.localStorage;
    else global.localStorage = previousLocalStorage;
    if (previousSessionStorage === undefined) delete global.sessionStorage;
    else global.sessionStorage = previousSessionStorage;
  }
});

test('scrapeTabBalanceAndKeys discards data when the tab no longer matches the saved site', async () => {
  const previousChrome = global.chrome;
  const previousFetch = global.fetch;
  const previousLocation = global.location;
  let fetchCalls = 0;
  global.chrome = { scripting: { async executeScript({ func, args }) { return [{ result: await func(...args) }]; } } };
  global.location = { hostname: 'other.example', href: 'https://other.example/console/token' };
  global.fetch = async () => {
    fetchCalls += 1;
    return jsonResponse({ success: true, data: { total: 0, items: [] } });
  };

  try {
    const result = await balance.scrapeTabBalanceAndKeys(17, 'newapi', {
      expectedDomain: 'saved.example',
      readFullTokenKeys: true
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'tab_domain_changed');
    assert.deepEqual(result.trustedKeys, []);
    assert.equal(fetchCalls, 0);
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
    if (previousFetch === undefined) delete global.fetch;
    else global.fetch = previousFetch;
    if (previousLocation === undefined) delete global.location;
    else global.location = previousLocation;
  }
});

test('verifyNewApiTabAccount selects a bearer profile instead of a mismatched cookie account', async () => {
  const previousChrome = global.chrome;
  const previousFetch = global.fetch;
  const previousLocalStorage = global.localStorage;
  const previousSessionStorage = global.sessionStorage;
  const previousLocation = global.location;
  const storage = {
    getItem(key) {
      if (key === 'user') return JSON.stringify({ id: 1 });
      if (key === 'auth_token') return 'token-a';
      return null;
    }
  };
  global.chrome = { scripting: { async executeScript({ func, args }) { return [{ result: await func(...args) }]; } } };
  global.localStorage = storage;
  global.sessionStorage = storage;
  global.location = { origin: 'https://example.com', href: 'https://example.com/console/token' };
  global.fetch = async (url, init = {}) => {
    assert.equal(url, '/api/user/self');
    return jsonResponse({
      success: true,
      data: { id: init.headers?.Authorization === 'Bearer token-a' ? 1 : 2 }
    });
  };

  try {
    const result = await balance.verifyNewApiTabAccount(17, { userId: '1', token: 'token-a' }, 'https://example.com');
    assert.equal(result.ok, true);
    assert.equal(result.userId, '1');
    assert.equal(result.headers.Authorization, 'Bearer token-a');
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
    if (previousFetch === undefined) delete global.fetch;
    else global.fetch = previousFetch;
    if (previousLocalStorage === undefined) delete global.localStorage;
    else global.localStorage = previousLocalStorage;
    if (previousSessionStorage === undefined) delete global.sessionStorage;
    else global.sessionStorage = previousSessionStorage;
    if (previousLocation === undefined) delete global.location;
    else global.location = previousLocation;
  }
});
