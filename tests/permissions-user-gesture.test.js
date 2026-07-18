const test = require('node:test');
const assert = require('node:assert/strict');

const {
  permissionOriginsForSites,
  permissionRequestErrorMessage,
  requestSiteAccessFromGesture,
  ensureSiteAccess
} = require('../permissions.js');

test('foreground permission request starts directly and preserves explicit ports', async () => {
  const previousChrome = global.chrome;
  const calls = [];
  global.chrome = {
    runtime: { lastError: null },
    permissions: {
      contains(_details, callback) {
        calls.push('contains');
        callback(false);
      },
      request(details, callback) {
        calls.push({ method: 'request', details });
        callback(true);
      }
    }
  };

  try {
    const result = await requestSiteAccessFromGesture({
      baseUrl: 'https://api.example.invalid:8443/console'
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.origins, ['https://api.example.invalid:8443/*']);
    assert.deepEqual(calls, [{
      method: 'request',
      details: { origins: ['https://api.example.invalid:8443/*'] }
    }]);
  } finally {
    global.chrome = previousChrome;
  }
});

test('foreground permission denial never exposes the raw user-gesture error', async () => {
  const previousChrome = global.chrome;
  const runtime = { lastError: null };
  global.chrome = {
    runtime,
    permissions: {
      request(_details, callback) {
        runtime.lastError = { message: 'This function must be called during a user gesture' };
        callback(false);
        runtime.lastError = null;
      }
    }
  };

  try {
    const result = await requestSiteAccessFromGesture('https://api.example.invalid');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'site_permission_denied');
    assert.match(result.error, /重试并授权|浏览器提示/);
    assert.doesNotMatch(result.error, /user gesture/i);
  } finally {
    global.chrome = previousChrome;
  }
});

test('permission origin collection deduplicates and error mapping stays Chinese', () => {
  assert.deepEqual(
    permissionOriginsForSites([
      'https://api.example.invalid:8443/path',
      { baseUrl: 'https://api.example.invalid:8443/other' }
    ]),
    ['https://api.example.invalid:8443/*']
  );
  assert.equal(
    permissionRequestErrorMessage('This function must be called during a user gesture'),
    '请直接点击“重试并授权”，然后在浏览器提示中允许访问'
  );
});

test('background-safe access checks default to no permission request', async () => {
  const previousChrome = global.chrome;
  let requests = 0;
  global.chrome = {
    runtime: { lastError: null },
    permissions: {
      contains(_details, callback) { callback(false); },
      request() { requests += 1; }
    }
  };

  try {
    const result = await ensureSiteAccess('https://api.example.invalid');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'site_permission_required');
    assert.equal(requests, 0);
  } finally {
    global.chrome = previousChrome;
  }
});
