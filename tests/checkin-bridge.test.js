const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');

const bridgePath = require.resolve('../bridge.js');

function loadBridge(chromeMock) {
  delete require.cache[bridgePath];
  globalThis.chrome = chromeMock;
  return require('../bridge.js');
}

afterEach(() => {
  delete require.cache[bridgePath];
  delete globalThis.chrome;
});

test('discoverCheckinExtension reports a disabled matching extension', async () => {
  const bridge = loadBridge({
    management: {
      getAll: async () => [{
        id: 'disabled-id',
        name: '公益站签到',
        type: 'extension',
        enabled: false
      }]
    }
  });

  const result = await bridge.discoverCheckinExtension();

  assert.equal(result.ok, false);
  assert.equal(result.code, 'extension_disabled');
});

test('discoverCheckinExtension distinguishes missing extension and permission', async () => {
  const noMatch = loadBridge({ management: { getAll: async () => [] } });
  assert.equal((await noMatch.discoverCheckinExtension()).code, 'extension_not_found');

  const noPermission = loadBridge({});
  assert.equal((await noPermission.discoverCheckinExtension()).code, 'permission_missing');
});

test('pingCheckin defaults old receivers to conservative capabilities', async () => {
  const bridge = loadBridge({
    management: {
      getAll: async () => [{
        id: 'checkin-id',
        name: '公益站签到',
        type: 'extension',
        enabled: true
      }]
    },
    runtime: {
      sendMessage(_id, _message, callback) {
        callback({ ok: true, version: '1.0.0' });
      }
    }
  });

  const result = await bridge.pingCheckin();

  assert.deepEqual(result.capabilities, { readSites: false });
});

test('pingCheckin preserves an advertised readSites capability', async () => {
  const bridge = loadBridge({
    management: {
      getAll: async () => [{
        id: 'checkin-id',
        name: '公益站签到',
        type: 'extension',
        enabled: true
      }]
    },
    runtime: {
      sendMessage(_id, _message, callback) {
        callback({ ok: true, capabilities: { readSites: true } });
      }
    }
  });

  const result = await bridge.pingCheckin();

  assert.deepEqual(result.capabilities, { readSites: true });
});

test('sendToExtension treats runtime.lastError as no_response', async () => {
  const runtime = {
    sendMessage(_id, _message, callback) {
      runtime.lastError = { message: 'Receiving end does not exist.' };
      callback({ ok: true, stale: true });
      delete runtime.lastError;
    }
  };
  const bridge = loadBridge({ runtime });

  const result = await bridge.sendToExtension('checkin-id', { action: 'ping' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'no_response');
  assert.equal(result.error, 'Receiving end does not exist.');
  assert.equal(result.stale, undefined);
});

test('importCheckinSites maps sites and requests updateExisting', async () => {
  let sent;
  const bridge = loadBridge({
    runtime: {
      sendMessage(id, message, callback) {
        sent = { id, message };
        callback({ ok: true });
      }
    }
  });

  const result = await bridge.importCheckinSites('checkin-id', [{
    domain: ' Example.COM ',
    name: 'Example',
    type: 'newapi',
    pageUrl: 'https://example.com/console'
  }]);

  assert.equal(result.ok, true);
  assert.equal(sent.id, 'checkin-id');
  assert.equal(sent.message.action, 'importSitesFromHub');
  assert.equal(sent.message.updateExisting, true);
  assert.deepEqual(sent.message.sites, [bridge.toCheckinSite({
    domain: ' Example.COM ',
    name: 'Example',
    type: 'newapi',
    pageUrl: 'https://example.com/console'
  })]);
});

test('readCheckinSites requests normalized lowercase domains', async () => {
  let sent;
  const bridge = loadBridge({
    runtime: {
      sendMessage(id, message, callback) {
        sent = { id, message };
        callback({ ok: true, sites: [] });
      }
    }
  });

  const result = await bridge.readCheckinSites('checkin-id', [
    ' Example.COM ',
    'API.Example.COM'
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(sent, {
    id: 'checkin-id',
    message: {
      action: 'getSitesForHub',
      domains: ['example.com', 'api.example.com']
    }
  });
});
