const assert = require('node:assert/strict');
const test = require('node:test');

const utils = require('../site-utils.js');
Object.assign(globalThis, utils);
require('../detect.js');

test('network probing keeps the resolved explicit port', async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return {
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => ''
    };
  };
  try {
    await globalThis.detectSite('https://port.example.com:8443/console', {
      timeoutMs: 50
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(requested.length > 0);
  assert.ok(
    requested.every((url) => url.startsWith('https://port.example.com:8443/')),
    `unexpected requests: ${requested.join(', ')}`
  );
});

test('public endpoint probing never reads or forwards browser cookies', async () => {
  const originalFetch = globalThis.fetch;
  const originalChrome = globalThis.chrome;
  const requests = [];
  let cookieReads = 0;
  globalThis.chrome = {
    cookies: {
      getAll: async () => {
        cookieReads += 1;
        return [{ name: 'session', value: 'should-not-be-read' }];
      }
    }
  };
  globalThis.fetch = async (url, options = {}) => {
    requests.push({
      url: String(url),
      headers: options.headers || {},
      credentials: options.credentials
    });
    return {
      ok: false,
      status: 404,
      text: async () => ''
    };
  };
  try {
    await globalThis.probeSiteEndpoints('https://public.example.invalid', { timeoutMs: 50 });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }

  assert.equal(cookieReads, 0);
  assert.ok(requests.length > 0);
  assert.ok(requests.every(({ headers, credentials }) => {
    const names = Object.keys(headers).map((name) => name.toLowerCase());
    return credentials === 'omit'
      && !names.includes('cookie')
      && !names.includes('authorization');
  }));
});
