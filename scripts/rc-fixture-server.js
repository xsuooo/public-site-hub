'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_PORTS = Object.freeze([41731, 41732, 41733, 41734]);
const DEFAULT_DELAYS = Object.freeze([1400, 1800, 2200, 2600]);
const COOKIE_NAME = 'public_site_hub_rc_fixture';
const MAX_BODY_BYTES = 64 * 1024;

function randomSecret(prefix) {
  return `${prefix}${crypto.randomBytes(24).toString('base64url')}`;
}

function maskKey(value) {
  const key = String(value || '');
  return key ? `sk-${'*'.repeat(12)}${key.slice(-6)}` : '';
}

function createInstance({ port, index, sessionToken, delayMs }) {
  const instance = {
    label: String.fromCharCode(65 + index),
    port,
    delayMs,
    sessionToken,
    user: {
      id: 91001,
      username: 'rc-fixture-user'
    },
    quota: (index + 2) * 2_500_000,
    usedQuota: (index + 1) * 125_000,
    tokens: [],
    nextTokenId: 1,
    apiMutations: 0,
    apiRequests: 0,
    fixtureMutations: 0,
    startedAt: Date.now()
  };
  if (index === 0) seedToken(instance, 'RC 预置 Key');
  return instance;
}

function seedToken(instance, name = 'RC 测试 Key') {
  const token = {
    id: instance.nextTokenId++,
    name: String(name).slice(0, 50),
    key: randomSecret('sk-rc-fixture-')
  };
  instance.tokens.push(token);
  return token;
}

function safeToken(token) {
  return {
    id: token.id,
    name: token.name,
    key: maskKey(token.key),
    tail: token.key.slice(-6)
  };
}

function publicState(instance, authenticated = false) {
  return {
    instance: instance.label,
    origin: `https://127.0.0.1:${instance.port}`,
    authenticated,
    userId: authenticated ? instance.user.id : null,
    tokenCount: instance.tokens.length,
    tokens: instance.tokens.map((token) => ({
      id: token.id,
      name: token.name,
      tail: token.key.slice(-6)
    })),
    apiMutations: instance.apiMutations,
    apiRequests: instance.apiRequests,
    fixtureMutations: instance.fixtureMutations,
    delayMs: instance.delayMs,
    uptimeMs: Math.max(0, Date.now() - instance.startedAt)
  };
}

function parseCookies(header) {
  const result = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

function bearerToken(header) {
  const match = String(header || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function isAuthenticated(req, instance) {
  const cookies = parseCookies(req.headers.cookie);
  const bearer = bearerToken(req.headers.authorization);
  return cookies[COOKIE_NAME] === instance.sessionToken || bearer === instance.sessionToken;
}

function securityHeaders(contentType) {
  return {
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  };
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...securityHeaders('application/json; charset=utf-8'),
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders
  });
  res.end(body);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    ...securityHeaders('text/html; charset=utf-8'),
    'Content-Length': Buffer.byteLength(html),
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:"
  });
  res.end(html);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function unauthorized(res) {
  sendJson(res, 401, { success: false, message: '未登录 RC 测试账号' });
}

function renderPage(instance, ports) {
  const links = ports.map((port, index) => (
    `<a href="https://127.0.0.1:${port}/console/token">实例 ${String.fromCharCode(65 + index)}</a>`
  )).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="application-name" content="RC NewAPI 本机测试站 ${instance.label}">
  <title>RC NewAPI 本机测试站 ${instance.label}</title>
  <style>
    :root{font-family:"Segoe UI Variable Text","Microsoft YaHei UI",sans-serif;color:#172033;background:#f4f6fb}*{box-sizing:border-box}body{margin:0}main{width:min(880px,calc(100% - 32px));margin:40px auto}.card{background:#fff;border:1px solid #dce1eb;border-radius:16px;padding:22px;box-shadow:0 10px 30px rgba(25,35,58,.07)}h1{margin:0 0 6px;font-size:24px}.muted{color:#697386}.banner{margin:18px 0;padding:12px 14px;border-radius:10px;background:#eef2ff;color:#3830a3}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:16px 0}.metric{padding:12px;border:1px solid #e2e6ee;border-radius:10px}.metric strong{display:block;font-size:18px}.actions,.origins{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}button,a{appearance:none;border:1px solid #aeb7c7;border-radius:9px;padding:8px 12px;background:#fff;color:#283248;text-decoration:none;cursor:pointer}button.primary{border-color:#5146e5;background:#5146e5;color:white}table{width:100%;border-collapse:collapse;margin-top:18px}th,td{text-align:left;padding:10px;border-bottom:1px solid #e5e8ef}code{font-family:"Cascadia Mono",Consolas,monospace;font-size:12px}.warning{color:#8a5100}.ok{color:#087443}@media(max-width:700px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
  </style>
</head>
<body>
  <main>
    <section class="card">
      <h1>RC NewAPI 本机测试站 ${instance.label}</h1>
      <p class="muted"><code>https://127.0.0.1:${instance.port}</code> · 仅用于公益站收藏 RC 验收</p>
      <div class="banner">所有账号、Key、余额和写入都是本机内存假数据；服务重启后失效。</div>
      <div id="status" class="warning">正在读取测试状态…</div>
      <div class="grid">
        <div class="metric"><span class="muted">实例</span><strong id="instance">${instance.label}</strong></div>
        <div class="metric"><span class="muted">Key 数</span><strong id="tokenCount">—</strong></div>
        <div class="metric"><span class="muted">API 写入</span><strong id="apiMutations">—</strong></div>
        <div class="metric"><span class="muted">余额延迟</span><strong>${instance.delayMs}ms</strong></div>
      </div>
      <div class="actions">
        <button class="primary" id="login">登录假账号</button>
        <button id="logout">退出假账号</button>
        <button id="seed">预置一把假 Key</button>
        <button id="clear">清空假 Key</button>
        <button id="reset">复位计数</button>
        <button id="refresh">刷新状态</button>
      </div>
      <table class="ant-table" aria-label="RC 假 Key 列表">
        <thead><tr><th>名称</th><th>Key 尾号</th><th>状态</th></tr></thead>
        <tbody id="tokens"><tr><td colspan="3" class="muted">正在读取…</td></tr></tbody>
      </table>
      <div class="origins">${links}</div>
    </section>
  </main>
  <script>
    const $ = (id) => document.getElementById(id);
    async function request(path, options = {}) {
      const response = await fetch(path, { credentials: 'include', ...options });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || ('HTTP ' + response.status));
      return data;
    }
    function applySession(data) {
      if (!data || !data.user || !data.token) return;
      localStorage.setItem('user', JSON.stringify(data.user));
      localStorage.setItem('token', data.token);
    }
    function clearSession() {
      for (const key of ['user','User','token','access_token','auth_token','user_token','session','jwt','Authorization']) localStorage.removeItem(key);
      sessionStorage.clear();
    }
    async function syncSession() {
      try { applySession(await request('/fixture/session')); } catch (error) { clearSession(); }
    }
    async function refreshState() {
      const state = await request('/fixture/state');
      if (state.authenticated) await syncSession();
      $('status').className = state.authenticated ? 'ok' : 'warning';
      $('status').textContent = state.authenticated ? '假账号已登录，可返回扩展执行收藏与余额测试。' : '当前未登录，请先点击“登录假账号”。';
      $('tokenCount').textContent = state.tokenCount;
      $('apiMutations').textContent = state.apiMutations;
      $('tokens').innerHTML = state.tokens.length ? state.tokens.map((token) => '<tr><td>' + token.name + '</td><td><code>尾号 ' + token.tail + '</code></td><td>假数据</td></tr>').join('') : '<tr><td colspan="3" class="muted">暂无 Key</td></tr>';
    }
    async function mutate(path) {
      await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      await refreshState();
    }
    $('login').addEventListener('click', async () => { applySession(await request('/fixture/login', { method: 'POST' })); await refreshState(); });
    $('logout').addEventListener('click', async () => { clearSession(); await mutate('/fixture/logout'); });
    $('seed').addEventListener('click', () => mutate('/fixture/seed'));
    $('clear').addEventListener('click', () => mutate('/fixture/clear-tokens'));
    $('reset').addEventListener('click', () => mutate('/fixture/reset-counts'));
    $('refresh').addEventListener('click', refreshState);
    refreshState().catch((error) => { $('status').textContent = error.message; });
  </script>
</body>
</html>`;
}

function createRequestHandler(instance, ports) {
  return async (req, res) => {
    const url = new URL(req.url || '/', `https://127.0.0.1:${instance.port}`);
    const authenticated = isAuthenticated(req, instance);

    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/console' || url.pathname === '/console/token')) {
        sendHtml(res, renderPage(instance, ports));
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/api/status' || url.pathname === '/api/about')) {
        instance.apiRequests += 1;
        sendJson(res, 200, {
          success: true,
          data: {
            system_name: `RC NewAPI 本机测试站 ${instance.label}`,
            quota_per_unit: 500000,
            display_in_currency: true,
            turnstile_check: false
          }
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/models') {
        instance.apiRequests += 1;
        if (!authenticated) return unauthorized(res);
        sendJson(res, 200, { object: 'list', data: [{ id: 'rc-fixture-model', object: 'model' }] });
        return;
      }

      if (req.method === 'GET' && ['/api/user/self', '/api/user/dashboard', '/api/user', '/api/user/info'].includes(url.pathname)) {
        instance.apiRequests += 1;
        if (!authenticated) return unauthorized(res);
        await wait(instance.delayMs);
        sendJson(res, 200, {
          success: true,
          data: {
            ...instance.user,
            quota: instance.quota,
            used_quota: instance.usedQuota
          }
        });
        return;
      }

      if (req.method === 'GET' && ['/api/token/', '/api/token', '/api/tokens', '/api/token/search'].includes(url.pathname)) {
        instance.apiRequests += 1;
        if (!authenticated) return unauthorized(res);
        sendJson(res, 200, {
          success: true,
          data: {
            items: instance.tokens.map(safeToken),
            total: instance.tokens.length
          }
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/token/batch/keys') {
        instance.apiRequests += 1;
        if (!authenticated) return unauthorized(res);
        const body = await readJson(req);
        const ids = new Set((Array.isArray(body.ids) ? body.ids : []).map(String));
        const keys = {};
        for (const token of instance.tokens) {
          if (ids.has(String(token.id))) keys[String(token.id)] = token.key;
        }
        sendJson(res, 200, { success: true, data: { keys } });
        return;
      }

      const keyMatch = url.pathname.match(/^\/api\/token\/(\d+)\/key$/);
      if (req.method === 'POST' && keyMatch) {
        instance.apiRequests += 1;
        if (!authenticated) return unauthorized(res);
        const token = instance.tokens.find((item) => String(item.id) === keyMatch[1]);
        if (!token) {
          sendJson(res, 404, { success: false, message: 'RC 假 Key 不存在' });
          return;
        }
        sendJson(res, 200, { success: true, data: { key: token.key } });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/token/') {
        instance.apiRequests += 1;
        if (!authenticated) return unauthorized(res);
        const body = await readJson(req);
        const token = seedToken(instance, body.name || 'RC 扩展创建 Key');
        instance.apiMutations += 1;
        sendJson(res, 200, { success: true, data: { id: token.id, name: token.name } });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/fixture/login') {
        instance.fixtureMutations += 1;
        sendJson(res, 200, { success: true, user: instance.user, token: instance.sessionToken }, {
          'Set-Cookie': `${COOKIE_NAME}=${encodeURIComponent(instance.sessionToken)}; Path=/; Secure; HttpOnly; SameSite=Lax`
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/fixture/logout') {
        instance.fixtureMutations += 1;
        sendJson(res, 200, { success: true }, {
          'Set-Cookie': `${COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/fixture/session') {
        if (!authenticated) return unauthorized(res);
        sendJson(res, 200, { success: true, user: instance.user, token: instance.sessionToken });
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/fixture/state' || url.pathname === '/fixture/health')) {
        sendJson(res, 200, publicState(instance, authenticated));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/fixture/seed') {
        if (!instance.tokens.length) seedToken(instance);
        instance.fixtureMutations += 1;
        sendJson(res, 200, publicState(instance, authenticated));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/fixture/clear-tokens') {
        instance.tokens = [];
        instance.fixtureMutations += 1;
        sendJson(res, 200, publicState(instance, authenticated));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/fixture/reset-counts') {
        instance.apiMutations = 0;
        instance.apiRequests = 0;
        instance.fixtureMutations += 1;
        sendJson(res, 200, publicState(instance, authenticated));
        return;
      }

      sendJson(res, 404, { success: false, message: 'RC 夹具路由不存在' });
    } catch (error) {
      if (!res.headersSent) sendJson(res, 400, { success: false, message: String(error?.message || error) });
      else res.end();
    }
  };
}

function ensureCertificate(directory = path.join(os.tmpdir(), 'public-site-hub-rc-fixture')) {
  fs.mkdirSync(directory, { recursive: true });
  const keyPath = path.join(directory, 'localhost.key.pem');
  const certPath = path.join(directory, 'localhost.cert.pem');
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    const configPath = path.join(directory, 'openssl.cnf');
    fs.writeFileSync(configPath, [
      '[req]',
      'distinguished_name = dn',
      'x509_extensions = ext',
      'prompt = no',
      '[dn]',
      'CN = 127.0.0.1',
      '[ext]',
      'subjectAltName = IP:127.0.0.1,DNS:localhost',
      'basicConstraints = critical,CA:FALSE',
      'keyUsage = critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage = serverAuth'
    ].join('\n'));
    const result = spawnSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', '14', '-config', configPath
    ], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) {
      throw new Error(`openssl failed: ${String(result.stderr || result.stdout || result.error || '').trim()}`);
    }
  }
  const key = fs.readFileSync(keyPath);
  const cert = fs.readFileSync(certPath);
  const fingerprint256 = new crypto.X509Certificate(cert).fingerprint256;
  return { key, cert, keyPath, certPath, fingerprint256 };
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function startFixture(options = {}) {
  const ports = options.ports || [...DEFAULT_PORTS];
  const delays = options.delays || [...DEFAULT_DELAYS];
  const certificate = options.certificate || ensureCertificate(options.certificateDirectory);
  const sessionToken = randomSecret('rc-session-');
  const instances = ports.map((port, index) => createInstance({
    port,
    index,
    sessionToken,
    delayMs: Number(delays[index]) || DEFAULT_DELAYS[index] || 1800
  }));
  const servers = instances.map((instance) => https.createServer(
    { key: certificate.key, cert: certificate.cert },
    createRequestHandler(instance, ports)
  ));
  try {
    await Promise.all(servers.map((server, index) => listen(server, ports[index])));
  } catch (error) {
    await Promise.allSettled(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    throw error;
  }
  return {
    ports,
    origins: ports.map((port) => `https://127.0.0.1:${port}`),
    instances,
    certificate,
    async close() {
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    }
  };
}

async function main() {
  const fixture = await startFixture();
  console.log('[RC fixture] ready');
  console.log(`[RC fixture] open ${fixture.origins[0]}/console/token`);
  console.log(`[RC fixture] origins ${fixture.origins.join(', ')}`);
  console.log(`[RC fixture] certificate ${fixture.certificate.certPath}`);
  console.log(`[RC fixture] SHA-256 fingerprint ${fixture.certificate.fingerprint256}`);
  console.log('[RC fixture] no real account, API Key or balance is used');

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await fixture.close();
    process.exit(0);
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[RC fixture] ${String(error?.message || error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  COOKIE_NAME,
  DEFAULT_DELAYS,
  DEFAULT_PORTS,
  createInstance,
  createRequestHandler,
  ensureCertificate,
  maskKey,
  publicState,
  seedToken,
  startFixture
};
