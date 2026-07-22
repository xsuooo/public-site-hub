#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_EXTENSION_DIR = path.join(ROOT, 'dist');
const DEFAULT_TIMEOUT_MS = 20_000;
const PROFILE_PREFIX = 'public-site-hub-smoke-';

function parseArgs(argv) {
  const options = {
    browser: process.env.PUBLIC_SITE_HUB_BROWSER || 'auto',
    extensionDir: process.env.PUBLIC_SITE_HUB_EXTENSION_DIR || DEFAULT_EXTENSION_DIR,
    headed: false,
    timeoutMs: DEFAULT_TIMEOUT_MS
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [name, inlineValue] = argument.split('=', 2);
    const nextValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${name}`);
      index += 1;
      return value;
    };

    if (name === '--browser') options.browser = nextValue();
    else if (name === '--extension-dir') options.extensionDir = nextValue();
    else if (name === '--timeout-ms') options.timeoutMs = Number(nextValue());
    else if (name === '--headed') options.headed = true;
    else if (name === '--help' || name === '-h') options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }

  options.extensionDir = path.resolve(options.extensionDir);
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1_000) {
    throw new Error('--timeout-ms must be at least 1000');
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/smoke-extension.js [options]

Options:
  --browser <auto|edge|chromium|path>    Automation browser (default: auto)
  --extension-dir <path>                Unpacked package (default: dist)
  --timeout-ms <number>                 Per-step timeout (default: 20000)
  --headed                              Show the isolated browser window
  --help                                Show this help

Environment overrides:
  PUBLIC_SITE_HUB_BROWSER
  PUBLIC_SITE_HUB_EXTENSION_DIR
  CHROMIUM_PATH
  EDGE_PATH`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(description, read, accept, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  let lastError;
  while (Date.now() < deadline) {
    try {
      lastValue = await read();
      if (accept(lastValue)) return lastValue;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  const suffix = lastError
    ? `; last error: ${lastError.message}`
    : `; last value: ${JSON.stringify(lastValue)}`;
  throw new Error(`timed out waiting for ${description}${suffix}`);
}

function candidatePaths(kind) {
  if (process.platform === 'win32') {
    const env = process.env;
    const bases = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
    const relative = kind === 'edge'
      ? path.join('Microsoft', 'Edge', 'Application', 'msedge.exe')
      : path.join('Chromium', 'Application', 'chrome.exe');
    return bases.map((base) => path.join(base, relative));
  }
  if (process.platform === 'darwin') {
    return kind === 'edge'
      ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/Applications/Chromium.app/Contents/MacOS/Chromium'];
  }
  return kind === 'edge'
    ? ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']
    : ['/usr/bin/chromium', '/usr/bin/chromium-browser'];
}

function findNamedBrowser(kind) {
  const override = kind === 'edge' ? process.env.EDGE_PATH : process.env.CHROMIUM_PATH;
  const executable = [override, ...candidatePaths(kind)]
    .filter(Boolean)
    .find((candidate) => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile());
  return executable ? { kind, executable: path.resolve(executable) } : null;
}

function resolveBrowsers(selection) {
  const normalized = String(selection || 'auto').trim().toLowerCase();
  if (normalized === 'all' || normalized === 'chrome') {
    throw new Error('Chrome Stable automation is not a release gate; use Edge/Chromium automation and the manual Chrome Stable checklist');
  }
  if (normalized === 'auto') {
    const browser = findNamedBrowser('edge') || findNamedBrowser('chromium');
    if (!browser) throw new Error('Edge or compatible Chromium executable not found');
    return [browser];
  }
  if (normalized === 'edge' || normalized === 'chromium') {
    const browser = findNamedBrowser(normalized);
    if (!browser) throw new Error(`${normalized} executable not found`);
    return [browser];
  }
  const executable = path.resolve(selection);
  if (!fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`browser executable not found: ${executable}`);
  }
  return [{ kind: path.basename(executable, path.extname(executable)), executable }];
}

function validateExtensionPackage(extensionDir) {
  assert(fs.statSync(extensionDir, { throwIfNoEntry: false })?.isDirectory(),
    `extension directory not found: ${extensionDir}`);
  const manifestPath = path.join(extensionDir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`invalid extension manifest: ${error.message}`);
  }
  assert(manifest.manifest_version === 3, 'manifest_version must be 3');
  assert(typeof manifest.background?.service_worker === 'string', 'manifest background.service_worker is missing');
  assert(typeof manifest.action?.default_popup === 'string', 'manifest action.default_popup is missing');
  assert(typeof manifest.options_page === 'string', 'manifest options_page is missing');
  for (const relativePath of [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_page
  ]) {
    assert(fs.statSync(path.join(extensionDir, relativePath), { throwIfNoEntry: false })?.isFile(),
      `manifest target not found: ${relativePath}`);
  }
  return manifest;
}

class CdpClient {
  constructor(url, timeoutMs) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket = null;
  }

  async connect() {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket connection timed out')), this.timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP WebSocket connection failed'));
      }, { once: true });
    });
    socket.addEventListener('message', (event) => this.handleMessage(event.data));
    socket.addEventListener('close', () => this.handleClose());
  }

  async handleMessage(data) {
    const text = typeof data === 'string'
      ? data
      : Buffer.from(await data.arrayBuffer()).toString('utf8');
    const message = JSON.parse(text);
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result || {});
      return;
    }
    const handlers = this.listeners.get(message.method);
    if (handlers) {
      for (const handler of handlers) handler(message.params || {}, message);
    }
  }

  handleClose() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`CDP connection closed during ${pending.method}`));
    }
    this.pending.clear();
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    return () => this.listeners.get(method)?.delete(handler);
  }

  send(method, params = {}, sessionId = '') {
    assert(this.socket?.readyState === WebSocket.OPEN, 'CDP WebSocket is not open');
    const id = this.nextId;
    this.nextId += 1;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.socket.send(JSON.stringify(payload));
    });
  }

  close() {
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }
}

function profileIsSafeToRemove(profileDir) {
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(profileDir));
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative) && path.basename(profileDir).startsWith(PROFILE_PREFIX);
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function launchBrowser(browser, extensionDir, headed, timeoutMs) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), PROFILE_PREFIX));
  const args = [
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--metrics-recording-only',
    '--disable-breakpad',
    '--disable-dev-shm-usage',
    '--window-size=1280,900'
  ];
  if (!headed) args.push('--headless=new');
  args.push('about:blank');

  const child = spawn(browser.executable, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-12_000);
  });

  const portFile = path.join(profileDir, 'DevToolsActivePort');
  try {
    const devtools = await waitFor(
      `${browser.kind} DevTools endpoint`,
      () => {
        if (child.exitCode !== null) {
          throw new Error(`${browser.kind} exited with code ${child.exitCode}: ${stderr.trim()}`);
        }
        if (!fs.existsSync(portFile)) return null;
        const [portText, websocketPath] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
        const port = Number(portText);
        return Number.isInteger(port) && websocketPath ? { port, websocketPath } : null;
      },
      Boolean,
      timeoutMs
    );
    return {
      child,
      profileDir,
      stderr: () => stderr,
      websocketUrl: `ws://127.0.0.1:${devtools.port}${devtools.websocketPath}`
    };
  } catch (error) {
    child.kill();
    await waitForChildExit(child, 3_000);
    if (profileIsSafeToRemove(profileDir)) {
      fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    throw error;
  }
}

async function stopBrowser(runtime, client) {
  try {
    if (client) await client.send('Browser.close');
  } catch {
    // The browser may already be closing after a failed assertion.
  }
  client?.close();
  if (!(await waitForChildExit(runtime.child, 5_000))) {
    runtime.child.kill();
    await waitForChildExit(runtime.child, 3_000);
  }
  assert(profileIsSafeToRemove(runtime.profileDir), `refusing to remove unsafe profile path: ${runtime.profileDir}`);
  fs.rmSync(runtime.profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  assert(!fs.existsSync(runtime.profileDir), 'temporary browser profile was not removed');
}

async function attachToTarget(client, targetId) {
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  assert(sessionId, `failed to attach to target ${targetId}`);
  await client.send('Runtime.enable', {}, sessionId);
  await client.send('Log.enable', {}, sessionId);
  return sessionId;
}

function remoteValue(result) {
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(`browser evaluation failed: ${detail}`);
  }
  return result.result?.value;
}

async function evaluate(client, sessionId, expression) {
  return remoteValue(await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: false
  }, sessionId));
}

function formatConsoleArguments(args = []) {
  return args.map((argument) => {
    if (argument.value !== undefined) return String(argument.value);
    return argument.description || argument.type || '';
  }).join(' ');
}

function collectRuntimeIssues(client, sessionId, label) {
  const errors = [];
  const warnings = [];
  const add = (target, message) => {
    const normalized = `${label}: ${String(message || 'unknown runtime issue')}`;
    if (!target.includes(normalized)) target.push(normalized);
  };
  const disposers = [
    client.on('Runtime.exceptionThrown', (params, event) => {
      if (event.sessionId !== sessionId) return;
      add(errors, params.exceptionDetails?.exception?.description || params.exceptionDetails?.text);
    }),
    client.on('Runtime.consoleAPICalled', (params, event) => {
      if (event.sessionId !== sessionId) return;
      const message = formatConsoleArguments(params.args);
      if (['error', 'assert'].includes(params.type)) add(errors, message);
      else if (params.type === 'warning') add(warnings, message);
    }),
    client.on('Log.entryAdded', (params, event) => {
      if (event.sessionId !== sessionId) return;
      if (params.entry?.level === 'error') add(errors, params.entry.text);
      else if (params.entry?.level === 'warning') add(warnings, params.entry.text);
    })
  ];
  return {
    errors,
    warnings,
    dispose: () => disposers.forEach((dispose) => dispose())
  };
}

function assertNoRuntimeErrors(collector) {
  assert(collector.errors.length === 0, `runtime errors detected:\n${collector.errors.join('\n')}`);
}

async function findExtensionWorker(client, workerPath, timeoutMs) {
  return waitFor(
    'MV3 extension service worker',
    async () => {
      const { targetInfos } = await client.send('Target.getTargets');
      return targetInfos.find((target) => target.type === 'service_worker' &&
        target.url.startsWith('chrome-extension://') && target.url.endsWith(`/${workerPath}`)) || null;
    },
    Boolean,
    timeoutMs
  );
}

async function verifyServiceWorker(client, workerTarget, manifest) {
  const sessionId = await attachToTarget(client, workerTarget.targetId);
  const issues = collectRuntimeIssues(client, sessionId, 'service worker');
  const result = await evaluate(client, sessionId, `(async () => {
    const manifest = chrome.runtime.getManifest();
    const sites = await loadSites();
    const prefs = await loadPrefs();
    const progress = await getBalanceRefreshProgress();
    const stored = await chrome.storage.local.get(null);
    const completeKeys = sites.reduce((total, site) => total + (site.keys || [])
      .filter((key) => typeof key.key === 'string' && key.key.startsWith('sk-')).length, 0);
    return {
      runtimeId: chrome.runtime.id,
      manifestVersion: manifest.manifest_version,
      version: manifest.version,
      versionName: manifest.version_name || '',
      worker: manifest.background && manifest.background.service_worker,
      popup: manifest.action && manifest.action.default_popup,
      optionsPage: manifest.options_page,
      siteCount: sites.length,
      completeKeyCount: completeKeys,
      prefsReady: Boolean(prefs && typeof prefs === 'object'),
      progressReady: Boolean(progress && typeof progress === 'object'),
      storageKeys: Object.keys(stored).sort(),
      runtimeFunctionsReady: [
        typeof loadSites,
        typeof loadPrefs,
        typeof getBalanceRefreshProgress,
        typeof countUnauthorizedSites
      ].every((type) => type === 'function')
    };
  })()`);
  await delay(100);
  assert(result.runtimeId, 'service worker did not expose a runtime id');
  assert(result.manifestVersion === 3, 'service worker reported a non-MV3 manifest');
  assert(result.version === manifest.version, 'runtime manifest version differs from packaged manifest');
  assert(result.versionName === (manifest.version_name || ''),
    'runtime manifest version_name differs from packaged manifest');
  assert(result.worker === manifest.background.service_worker, 'runtime service worker differs from manifest');
  assert(result.popup === manifest.action.default_popup, 'runtime popup differs from manifest');
  assert(result.optionsPage === manifest.options_page, 'runtime options page differs from manifest');
  assert(result.siteCount === 0, 'fresh smoke profile unexpectedly contains sites');
  assert(result.completeKeyCount === 0, 'fresh smoke profile unexpectedly contains a complete Key');
  assert(result.prefsReady && result.progressReady && result.runtimeFunctionsReady,
    'service worker runtime modules did not initialize');
  assertNoRuntimeErrors(issues);
  issues.dispose();
  return { runtimeId: result.runtimeId, warnings: issues.warnings };
}

async function openExtensionPage(client, url, label) {
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const sessionId = await attachToTarget(client, targetId);
  await client.send('Page.enable', {}, sessionId);
  const issues = collectRuntimeIssues(client, sessionId, label);
  const navigation = await client.send('Page.navigate', { url }, sessionId);
  assert(!navigation.errorText, `${label} navigation failed: ${navigation.errorText}`);
  return { targetId, sessionId, issues };
}

async function verifyPopup(client, extensionId, manifest, timeoutMs) {
  const url = `chrome-extension://${extensionId}/${manifest.action.default_popup}`;
  const page = await openExtensionPage(client, url, 'popup');
  try {
    const result = await waitFor(
      'Popup render',
      () => evaluate(client, page.sessionId, `(() => {
        const required = [
          '.popup-shell', '#saveCurrent', '#refreshBalances', '#healthSummary', '#grantAllSites',
          '#search', '#list', '#stopBalanceRefresh', '#deleteDialog', '#keyCreateDialog'
        ];
        const list = document.querySelector('#list');
        return {
          readyState: document.readyState,
          title: document.title,
          runtimeId: chrome.runtime.id,
          missing: required.filter((selector) => !document.querySelector(selector)),
          textLength: (document.body && document.body.innerText.trim().length) || 0,
          listState: list && list.dataset.listState,
          listChildren: list && list.childElementCount,
          styleSheets: document.styleSheets.length,
          bodyWidth: document.body && document.body.getBoundingClientRect().width,
          bodyHeight: document.body && document.body.getBoundingClientRect().height
        };
      })()`),
      (value) => value?.readyState === 'complete' && value.listState && value.listChildren > 0,
      timeoutMs
    );
    await delay(100);
    assert(result.runtimeId === extensionId, 'Popup belongs to an unexpected extension');
    assert(result.title === '公益站收藏', `unexpected Popup title: ${result.title}`);
    assert(result.missing.length === 0, `Popup is missing critical DOM: ${result.missing.join(', ')}`);
    assert(result.textLength > 80, 'Popup rendered as an empty document');
    assert(result.styleSheets >= 2, 'Popup stylesheets did not load');
    assert(result.bodyWidth > 0 && result.bodyHeight > 0, 'Popup has no rendered dimensions');
    assertNoRuntimeErrors(page.issues);
    return { warnings: page.issues.warnings };
  } finally {
    page.issues.dispose();
    await client.send('Target.closeTarget', { targetId: page.targetId }).catch(() => undefined);
  }
}

async function verifyOptions(client, extensionId, manifest, timeoutMs) {
  const url = `chrome-extension://${extensionId}/${manifest.options_page}#view=import`;
  const page = await openExtensionPage(client, url, 'options');
  try {
    const initial = await waitFor(
      'Options render and import route',
      () => evaluate(client, page.sessionId, `(() => {
        const required = [
          '#optionsShell', '[data-view="sites"]', '[data-view="import"]',
          '[data-view="diagnostics"]', '#siteList', '#importText',
          '#diagnosticsOut', '#copyDiagnostics', '#editor', '#confirmDialog'
        ];
        const workspaces = [...document.querySelectorAll('[data-workspace]')];
        const visible = workspaces.filter((workspace) => !workspace.hidden)
          .map((workspace) => workspace.dataset.workspace);
        return {
          readyState: document.readyState,
          title: document.title,
          runtimeId: chrome.runtime.id,
          hash: location.hash,
          missing: required.filter((selector) => !document.querySelector(selector)),
          visible,
          currentView: document.querySelector('[data-view][aria-current="page"]')?.dataset.view || '',
          textLength: (document.body && document.body.innerText.trim().length) || 0,
          siteListChildren: document.querySelector('#siteList')?.childElementCount || 0,
          diagnosticsReady: document.querySelector('#diagnosticsOut')?.textContent !== '加载中…',
          styleSheets: document.styleSheets.length
        };
      })()`),
      (value) => value?.readyState === 'complete' && value.diagnosticsReady && value.siteListChildren > 0,
      timeoutMs
    );
    assert(initial.runtimeId === extensionId, 'Options belongs to an unexpected extension');
    assert(initial.title === '公益站收藏 · 设置', `unexpected Options title: ${initial.title}`);
    assert(initial.missing.length === 0, `Options is missing critical DOM: ${initial.missing.join(', ')}`);
    assert(initial.textLength > 200, 'Options rendered as an empty document');
    assert(initial.styleSheets >= 2, 'Options stylesheets did not load');
    assert(initial.hash === '#view=import', `Options did not preserve import route: ${initial.hash}`);
    assert(initial.visible.join(',') === 'import' && initial.currentView === 'import',
      'Options import workspace is not the sole active workspace');

    await evaluate(client, page.sessionId,
      `document.querySelector('[data-view="diagnostics"]').click()`);
    const diagnosticsRoute = await waitFor(
      'Options diagnostics navigation',
      () => evaluate(client, page.sessionId, `(() => ({
        hash: location.hash,
        visible: [...document.querySelectorAll('[data-workspace]')]
          .filter((workspace) => !workspace.hidden)
          .map((workspace) => workspace.dataset.workspace),
        currentView: document.querySelector('[data-view][aria-current="page"]')?.dataset.view || ''
      }))()`),
      (value) => value?.hash === '#view=diagnostics' &&
        value.visible.join(',') === 'diagnostics' && value.currentView === 'diagnostics',
      timeoutMs
    );
    assert(diagnosticsRoute.currentView === 'diagnostics', 'Options navigation did not update active view');

    await evaluate(client, page.sessionId, `location.hash = '#edit=missing-smoke-site'`);
    const legacyRoute = await waitFor(
      'Options legacy route normalization',
      () => evaluate(client, page.sessionId, `(() => ({
        hash: location.hash,
        visible: [...document.querySelectorAll('[data-workspace]')]
          .filter((workspace) => !workspace.hidden)
          .map((workspace) => workspace.dataset.workspace),
        status: document.querySelector('#status')?.textContent || ''
      }))()`),
      (value) => value?.hash === '#view=sites' && value.visible.join(',') === 'sites' &&
        value.status.includes('找不到要编辑的站点'),
      timeoutMs
    );
    assert(legacyRoute.status.includes('找不到要编辑的站点'),
      'Options legacy edit route did not surface its missing-site state');
    await delay(100);
    assertNoRuntimeErrors(page.issues);
    return { warnings: page.issues.warnings };
  } finally {
    page.issues.dispose();
    await client.send('Target.closeTarget', { targetId: page.targetId }).catch(() => undefined);
  }
}

async function verifyBrowser(browser, options, manifest) {
  console.log(`[runtime] ${browser.kind}: launching isolated ${options.headed ? 'headed' : 'headless'} browser`);
  const runtime = await launchBrowser(
    browser,
    options.extensionDir,
    options.headed,
    options.timeoutMs
  );
  let client;
  try {
    client = new CdpClient(runtime.websocketUrl, options.timeoutMs);
    await client.connect();
    const version = await client.send('Browser.getVersion');
    const workerTarget = await findExtensionWorker(
      client,
      manifest.background.service_worker,
      options.timeoutMs
    );
    const worker = await verifyServiceWorker(client, workerTarget, manifest);
    console.log(`[pass] ${browser.kind}: MV3 service worker and manifest (${worker.runtimeId})`);

    const popup = await verifyPopup(client, worker.runtimeId, manifest, options.timeoutMs);
    console.log(`[pass] ${browser.kind}: Popup rendered with critical controls`);

    const optionsResult = await verifyOptions(client, worker.runtimeId, manifest, options.timeoutMs);
    console.log(`[pass] ${browser.kind}: Options rendered and routes changed correctly`);

    const warnings = [...worker.warnings, ...popup.warnings, ...optionsResult.warnings];
    if (warnings.length) {
      console.warn(`[warn] ${browser.kind}: ${warnings.join('\n[warn] ')}`);
    }
    console.log(`[pass] ${browser.kind}: no console errors (${version.product})`);
  } catch (error) {
    const stderr = runtime.stderr().trim();
    if (stderr) error.message += `\nBrowser stderr tail:\n${stderr}`;
    throw error;
  } finally {
    await stopBrowser(runtime, client);
    console.log(`[pass] ${browser.kind}: temporary profile removed`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  assert(typeof WebSocket === 'function' && typeof fetch === 'function',
    'Node.js 22 or newer is required for the dependency-free CDP client');
  const manifest = validateExtensionPackage(options.extensionDir);
  const browsers = resolveBrowsers(options.browser);
  console.log(`[runtime] package: ${options.extensionDir}`);
  for (const browser of browsers) {
    await verifyBrowser(browser, options, manifest);
  }
  console.log(`[pass] runtime smoke completed in ${browsers.length} browser(s)`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[fail] ${error.stack || error.message || error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  candidatePaths,
  findNamedBrowser,
  resolveBrowsers,
  profileIsSafeToRemove
};
