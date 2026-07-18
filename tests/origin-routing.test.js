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
