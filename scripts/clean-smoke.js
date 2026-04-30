'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { ensureExtensionKey } = require('./ensure-extension-key');
const { defaultInstallDir, resolveCliSettings } = require('./operator-cli');

const ROOT = path.resolve(__dirname, '..');

function assertPathInside(parent, child) {
  const parentPath = path.resolve(parent);
  const childPath = path.resolve(child);
  const relative = path.relative(parentPath, childPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to use path outside ${parentPath}: ${childPath}`);
  }
}

function findChromeForTesting(installDir = defaultInstallDir()) {
  const browserRoot = path.join(installDir, 'browsers', 'chrome');
  if (!fs.existsSync(browserRoot)) {
    return null;
  }

  const candidates = fs.readdirSync(browserRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(browserRoot, entry.name, 'chrome-win64', 'chrome.exe'))
    .filter((candidate) => fs.existsSync(candidate))
    .sort()
    .reverse();

  return candidates[0] || null;
}

function resolveSmokeConfig({
  installDir = defaultInstallDir(),
  root = ROOT,
  fixturePort = 18180,
  debugPort = 9230,
  runId = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
} = {}) {
  const extensionIdPath = path.join(installDir, 'extension-id.txt');
  if (!fs.existsSync(extensionIdPath)) {
    throw new Error(`Extension id file not found: ${extensionIdPath}`);
  }
  const extensionId = fs.readFileSync(extensionIdPath, 'utf8').trim();
  if (!/^[a-p]{32}$/.test(extensionId)) {
    throw new Error(`Invalid extension id in ${extensionIdPath}`);
  }

  const chromeForTestingPath = findChromeForTesting(installDir);
  if (!chromeForTestingPath) {
    throw new Error(`Chrome for Testing not found under ${path.join(installDir, 'browsers')}`);
  }

  const profileDir = path.join(installDir, `clean-smoke-${runId}`);
  assertPathInside(installDir, profileDir);

  return {
    installDir,
    root,
    fixturePort,
    debugPort,
    origin: `http://127.0.0.1:${fixturePort}`,
    debugBaseUrl: `http://127.0.0.1:${debugPort}`,
    extensionId,
    extensionDir: path.join(installDir, 'extension-unpacked'),
    chromeForTestingPath,
    profileDir
  };
}

function execFile(command, args, options = {}) {
  return childProcess.execFileSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  });
}

function stopPortOwner(port) {
  const script = [
    `$owners = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`,
    'foreach ($owner in $owners) {',
    '  if ($owner -and $owner -ne 0) { Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue }',
    '}'
  ].join('\n');
  childProcess.spawnSync('powershell', ['-NoProfile', '-Command', script], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function stopChromeProfile(profileDir) {
  const escapedProfile = profileDir.replace(/'/g, "''");
  const script = [
    `$profile = '${escapedProfile}'`,
    "Get-CimInstance Win32_Process -Filter \"name = 'chrome.exe'\" |",
    "Where-Object { $_.CommandLine -like \"*$profile*\" } |",
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
  ].join('\n');
  childProcess.spawnSync('powershell', ['-NoProfile', '-Command', script], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function runInstall(extensionId) {
  execFile('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(ROOT, 'install', 'install.ps1'),
    '-ExtensionId',
    extensionId
  ]);
}

function snapshotFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return { existed: false, content: null };
  }
  return {
    existed: true,
    content: fs.readFileSync(filePath)
  };
}

function restoreFileSnapshot(filePath, snapshot) {
  if (!snapshot.existed) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, snapshot.content);
}

function startDaemon(config) {
  stopPortOwner(17391);
  const logDir = path.join(config.installDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, 'clean-smoke-daemon.out.log'), 'a');
  const err = fs.openSync(path.join(logDir, 'clean-smoke-daemon.err.log'), 'a');
  const child = childProcess.spawn(process.execPath, ['operator-daemon/daemon.js', '--daemon'], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, err]
  });
  child.unref();
  fs.writeFileSync(path.join(config.installDir, 'clean-smoke-daemon.pid'), String(child.pid), 'ascii');
  return child.pid;
}

function startFixtureServer(config) {
  const fixtureRoot = path.join(config.root, 'fixtures');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, config.origin);
    const pathname = url.pathname === '/' ? '/basic-form.html' : url.pathname;
    const file = path.resolve(fixtureRoot, `.${pathname}`);
    if (!file.startsWith(fixtureRoot) || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(file).pipe(res);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.fixturePort, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

function launchChromeForTesting(config) {
  if (fs.existsSync(config.profileDir)) {
    fs.rmSync(config.profileDir, { recursive: true, force: true });
  }
  fs.mkdirSync(config.profileDir, { recursive: true });
  const child = childProcess.spawn(config.chromeForTestingPath, [
    `--user-data-dir=${config.profileDir}`,
    `--load-extension=${config.extensionDir}`,
    '--no-first-run',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion',
    '--window-position=0,0',
    '--window-size=1280,900',
    '--new-window',
    `--remote-debugging-port=${config.debugPort}`,
    `chrome-extension://${config.extensionId}/bootstrap.html`
  ], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  return child.pid;
}

async function waitForTargets(debugBaseUrl, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${debugBaseUrl}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        if (Array.isArray(targets) && targets.length > 0) {
          return targets;
        }
      }
    } catch {
      // Retry until Chrome exposes the DevTools endpoint.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Chrome DevTools at ${debugBaseUrl}`);
}

async function withCdp(target, fn) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };

  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('Chrome DevTools websocket error'));
  });

  async function send(method, params = {}) {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => pending.set(id, resolve));
  }

  try {
    return await fn(send);
  } finally {
    socket.close();
  }
}

async function pageTarget(config) {
  const targets = await waitForTargets(config.debugBaseUrl);
  const target = targets.find((entry) => entry.type === 'page');
  if (!target) {
    throw new Error('Chrome page target not found.');
  }
  return target;
}

function runCliJson(args, settings) {
  const result = childProcess.spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'operator-cli.js'),
    '--base-url',
    settings.baseUrl,
    '--token',
    settings.token,
    ...args
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const output = result.stdout && result.stdout.trim();
  if (!output) {
    throw new Error(result.stderr || `operator-cli exited with ${result.status}`);
  }
  return JSON.parse(output);
}

function runCliJsonAsync(args, settings) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [
      path.join(ROOT, 'scripts', 'operator-cli.js'),
      '--base-url',
      settings.baseUrl,
      '--token',
      settings.token,
      ...args
    ], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (status) => {
      const output = stdout.trim();
      if (!output) {
        reject(new Error(stderr || `operator-cli exited with ${status}`));
        return;
      }
      try {
        resolve(JSON.parse(output));
      } catch (error) {
        reject(new Error(`operator-cli returned invalid JSON: ${error.message}\n${output}`));
      }
    });
  });
}

function bindSmokeProfile(config, settings, runCliJsonFn = runCliJson) {
  const profileBind = runCliJsonFn([
    'profile-bind',
    config.profileDir,
    'Default',
    'Codex Clean Smoke'
  ], settings);
  if (!profileBind.ok || !profileBind.result || !profileBind.result.setupUrl) {
    throw new Error(`Clean smoke profile bind failed: ${JSON.stringify(profileBind)}`);
  }
  return profileBind.result;
}

function findElementHandle(observation, predicate, label) {
  const elements = observation && observation.result && Array.isArray(observation.result.elements)
    ? observation.result.elements
    : [];
  const element = elements.find(predicate);
  if (!element || !element.handle) {
    throw new Error(`Could not find handle for ${label}: ${JSON.stringify(observation)}`);
  }
  return element.handle;
}

function pngBuffer({ width, height, colorType }) {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = colorType;
  return buffer;
}

function writeSmokePngAsset(config, name, options) {
  const assetDir = path.join(config.profileDir, 'assets');
  assertPathInside(config.profileDir, assetDir);
  fs.mkdirSync(assetDir, { recursive: true });
  const assetPath = path.join(assetDir, name);
  assertPathInside(assetDir, assetPath);
  fs.writeFileSync(assetPath, pngBuffer(options));
  return assetPath;
}

async function waitForStatus(settings, predicate, timeoutMs = 10000) {
  const started = Date.now();
  let lastStatus = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = runCliJson(['status'], settings);
      lastStatus = response.result;
      if (response.ok && predicate(response.result)) {
        return response.result;
      }
    } catch (error) {
      lastStatus = { waiting: error.message };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for daemon status. Last status: ${JSON.stringify(lastStatus)}`);
}

function acceptPermissionPrompt(profileDir) {
  const escapedProfile = profileDir.replace(/'/g, "''");
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$profile = '${escapedProfile}'
$procInfo = Get-CimInstance Win32_Process -Filter "name = 'chrome.exe'" | Where-Object { $_.CommandLine -like "*$profile*" -and $_.CommandLine -notlike "*--type=*" } | Select-Object -First 1
if (-not $procInfo) { throw "Chrome process not found for $profile" }
$root = [System.Windows.Automation.AutomationElement]::RootElement
$nameProperty = [System.Windows.Automation.AutomationElement]::NameProperty
$allowButton = $null
foreach ($name in @('İzin ver', 'Allow')) {
  $condition = New-Object System.Windows.Automation.PropertyCondition($nameProperty, $name)
  $allowButton = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
  if ($allowButton) { break }
}
if (-not $allowButton) { throw "Permission allow button not found." }
$pattern = $allowButton.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
$pattern.Invoke()
Start-Sleep -Milliseconds 1000
`;
  execFile('powershell', ['-NoProfile', '-Command', script]);
}

async function clickElement(send, elementId, options = {}) {
  const rect = await send('Runtime.evaluate', {
    expression: `(() => { const r = document.getElementById('${elementId}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    returnByValue: true
  });
  const { x, y } = rect.result.result.value;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  if (options.fallbackDomClick) {
    await send('Runtime.evaluate', {
      expression: `document.getElementById('${elementId}').click()`
    });
  }
}

async function runCleanSmoke(options = {}) {
  const installDir = options.installDir || defaultInstallDir();
  const statePath = path.join(installDir, 'state.json');
  const stateSnapshot = snapshotFile(statePath);
  const extensionId = ensureExtensionKey().extensionId;
  runInstall(extensionId);
  const config = resolveSmokeConfig({ ...options, installDir });
  const settings = resolveCliSettings({ installDir: config.installDir });
  let fixtureServer = null;
  let chromeStarted = false;

  try {
    stopPortOwner(config.debugPort);
    stopPortOwner(config.fixturePort);
    startDaemon(config);
    await waitForStatus(settings, (status) => status.connectionState === 'DAEMON_RUNNING_EXTENSION_DISCONNECTED');
    const ensureStartedBeforeChrome = runCliJson(['--no-bootstrap', 'ensure-started'], settings);
    if (
      !ensureStartedBeforeChrome.ok ||
      ensureStartedBeforeChrome.result.daemonRunning !== true ||
      ensureStartedBeforeChrome.result.bootstrapRequired !== true ||
      !ensureStartedBeforeChrome.result.bootstrapUrl
    ) {
      throw new Error(`Ensure-started did not report bootstrap readiness: ${JSON.stringify(ensureStartedBeforeChrome)}`);
    }

    fixtureServer = await startFixtureServer(config);
    stopChromeProfile(config.profileDir);
    const chromePid = launchChromeForTesting(config);
    chromeStarted = true;
    await waitForStatus(settings, (status) => status.connectionState === 'EXTENSION_CONNECTED_SETUP_ONLY');

    const smokeProfileBinding = bindSmokeProfile(config, settings);
    await withCdp(await pageTarget(config), async (send) => {
      await send('Page.navigate', {
        url: smokeProfileBinding.setupUrl
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await clickElement(send, 'bind');
    });
    await waitForStatus(settings, (status) => status.profileVerified === true);

    const preflightRevoke = runCliJson(['revoke', config.origin], settings);
    if (!preflightRevoke.ok) {
      throw new Error(`Preflight domain revoke failed: ${JSON.stringify(preflightRevoke)}`);
    }
    const preparedOrigin = runCliJson(['prepare-origin', config.origin], settings);
    if (
      !preparedOrigin.ok ||
      preparedOrigin.result.origin !== config.origin ||
      preparedOrigin.result.applied.domainApproval !== true ||
      preparedOrigin.result.ready !== false ||
      preparedOrigin.result.requiresUserGesture !== true ||
      preparedOrigin.result.nextAction.kind !== 'hostPermission' ||
      !preparedOrigin.result.permissionUrl
    ) {
      throw new Error(`Prepare-origin did not report host permission handoff: ${JSON.stringify(preparedOrigin)}`);
    }
    const blockedObserve = runCliJson(['observe', config.origin], settings);
    if (blockedObserve.ok || blockedObserve.error.code !== 'HOST_PERMISSION_REQUIRED') {
      throw new Error(`Expected HOST_PERMISSION_REQUIRED before permission grant: ${JSON.stringify(blockedObserve)}`);
    }

    await withCdp(await pageTarget(config), async (send) => {
      await send('Page.navigate', {
        url: preparedOrigin.result.permissionUrl
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await clickElement(send, 'grant');
    });
    acceptPermissionPrompt(config.profileDir);
    await waitForStatus(settings, (status) => status.hostPermissionOrigins.includes(config.origin));
    const readyAfterPermission = runCliJson(['wait-ready', config.origin, '5000', '100'], settings);
    if (!readyAfterPermission.ok || readyAfterPermission.result.ready !== true) {
      throw new Error(`wait-ready did not confirm readiness after permission grant: ${JSON.stringify(readyAfterPermission)}`);
    }

    const openedObservation = await runCliJsonAsync(['open-observe', `${config.origin}/basic-form.html`, '45000', '1000'], settings);
    if (
      !openedObservation.ok ||
      openedObservation.result.origin !== config.origin ||
      openedObservation.result.url !== `${config.origin}/basic-form.html` ||
      !openedObservation.result.navigation ||
      openedObservation.result.navigation.url !== `${config.origin}/basic-form.html` ||
      !openedObservation.result.observation ||
      openedObservation.result.observation.title !== 'Codex Operator Basic Fixture'
    ) {
      throw new Error(`open-observe did not navigate and observe the fixture: ${JSON.stringify(openedObservation)}`);
    }

    await withCdp(await pageTarget(config), async (send) => {
      await send('Page.navigate', {
        url: `chrome-extension://${config.extensionId}/permissionRequest.html?origin=${encodeURIComponent(config.origin)}&visualCapture=1`
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await clickElement(send, 'grant');
    });
    acceptPermissionPrompt(config.profileDir);

    await withCdp(await pageTarget(config), async (send) => {
      await send('Page.navigate', { url: `${config.origin}/gate-form.html` });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });
    const gateObservation = runCliJson(['observe', config.origin], settings);
    if (!gateObservation.ok) {
      throw new Error(`Gate observe failed: ${JSON.stringify(gateObservation)}`);
    }
    const gateTypes = (gateObservation.result.detectedGates || []).map((gate) => gate.type);
    if (!gateTypes.includes('PASSWORD_REQUIRED')) {
      throw new Error(`Expected PASSWORD_REQUIRED gate: ${JSON.stringify(gateObservation)}`);
    }
    const completeGateHandle = findElementHandle(
      gateObservation,
      (element) => element.id === 'completeGate',
      'complete gate button'
    );
    const gatedVisualObserve = runCliJson(['visual-observe', config.origin], settings);
    if (
      gatedVisualObserve.ok ||
      gatedVisualObserve.error.code !== 'VISUAL_PROVIDER_POLICY_BLOCKED' ||
      gatedVisualObserve.error.gateType !== 'PASSWORD_REQUIRED'
    ) {
      throw new Error(`Expected visual capture policy block on gated page: ${JSON.stringify(gatedVisualObserve)}`);
    }
    const gatedClick = runCliJson(['click', config.origin, completeGateHandle], settings);
    if (
      gatedClick.ok ||
      gatedClick.error.code !== 'PASSWORD_REQUIRED' ||
      gatedClick.error.resumePolicy !== 'wait-and-reobserve'
    ) {
      throw new Error(`Expected password gate handoff before action: ${JSON.stringify(gatedClick)}`);
    }
    const gateBlockedState = await withCdp(await pageTarget(config), async (send) => {
      const result = await send('Runtime.evaluate', {
        expression: `({
          gateHidden: document.getElementById('gate').hidden,
          postGateHidden: document.getElementById('postGate').hidden,
          gateStatus: document.getElementById('gateStatus').textContent
        })`,
        returnByValue: true
      });
      return result.result.result.value;
    });
    if (gateBlockedState.gateHidden || !gateBlockedState.postGateHidden) {
      throw new Error(`Gate action was not paused: ${JSON.stringify(gateBlockedState)}`);
    }

    await withCdp(await pageTarget(config), async (send) => {
      await clickElement(send, 'completeGate', { fallbackDomClick: true });
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    const resumedGateObservation = runCliJson(['observe', config.origin], settings);
    if (!resumedGateObservation.ok) {
      throw new Error(`Gate resume observe failed: ${JSON.stringify(resumedGateObservation)}`);
    }
    const resumedGateTypes = (resumedGateObservation.result.detectedGates || []).map((gate) => gate.type);
    if (resumedGateTypes.length !== 0) {
      throw new Error(`Expected gate to clear after manual completion: ${JSON.stringify(resumedGateObservation)}`);
    }
    const postGateValueHandle = findElementHandle(
      resumedGateObservation,
      (element) => element.name === 'postGateValue',
      'post-gate value input'
    );
    const safeAfterGateHandle = findElementHandle(
      resumedGateObservation,
      (element) => element.id === 'safeAfterGate',
      'safe after gate button'
    );
    const gateFill = runCliJson(['fill', config.origin, postGateValueHandle, 'Manual gate complete'], settings);
    const gateSafeClick = runCliJson(['click', config.origin, safeAfterGateHandle], settings);
    if (!gateFill.ok || !gateSafeClick.ok) {
      throw new Error(`Post-gate action failed: ${JSON.stringify({ gateFill, gateSafeClick })}`);
    }
    const gateDom = await withCdp(await pageTarget(config), async (send) => {
      const result = await send('Runtime.evaluate', {
        expression: `({
          postGateValue: document.querySelector('[name=postGateValue]').value,
          gateStatus: document.getElementById('gateStatus').textContent
        })`,
        returnByValue: true
      });
      return result.result.result.value;
    });
    if (gateDom.gateStatus !== 'Gate resumed') {
      throw new Error(`Gate did not resume after manual completion: ${JSON.stringify(gateDom)}`);
    }

    await withCdp(await pageTarget(config), async (send) => {
      await send('Page.navigate', { url: `${config.origin}/basic-form.html` });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });

    const observation = runCliJson(['observe', config.origin], settings);
    if (!observation.ok) {
      throw new Error(`Observe failed after permission grant: ${JSON.stringify(observation)}`);
    }
    const visualObservation = runCliJson(['visual-observe', config.origin], settings);
    if (!visualObservation.ok) {
      throw new Error(`Visual observe failed after permission grant: ${JSON.stringify(visualObservation)}`);
    }
    if (
      !visualObservation.result.screenshot ||
      visualObservation.result.screenshot.dataUrl ||
      !visualObservation.result.screenshot.artifactId ||
      !visualObservation.result.screenshot.sha256 ||
      !visualObservation.result.screenshot.path ||
      !fs.existsSync(visualObservation.result.screenshot.path)
    ) {
      throw new Error(`Visual observe did not return a stored screenshot artifact: ${JSON.stringify(visualObservation)}`);
    }

    await withCdp(await pageTarget(config), async (send) => {
      await send('Page.navigate', { url: `${config.origin}/visual-cards.html` });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });
    const visualAnalysis = runCliJson(['visual-analyze', config.origin, 'local-basic'], settings);
    const analysis = visualAnalysis.result &&
      visualAnalysis.result.visual &&
      visualAnalysis.result.visual.analysis;
    const visualRegionKinds = analysis && Array.isArray(analysis.regions)
      ? analysis.regions.map((region) => region.kind)
      : [];
    if (
      !visualAnalysis.ok ||
      !analysis ||
      analysis.provider !== 'local-basic' ||
      analysis.status !== 'analyzed' ||
      !visualRegionKinds.includes('product-card') ||
      !visualRegionKinds.includes('rating-stars') ||
      !Array.isArray(analysis.handleCorrelations) ||
      analysis.handleCorrelations.length === 0 ||
      !visualAnalysis.result.screenshot ||
      visualAnalysis.result.screenshot.dataUrl ||
      !visualAnalysis.result.screenshot.artifactId
    ) {
      throw new Error(`Visual analysis did not return expected fixture regions: ${JSON.stringify(visualAnalysis)}`);
    }

    await withCdp(await pageTarget(config), async (send) => {
      await send('Page.navigate', { url: `${config.origin}/sensitive-page.html` });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });
    const sensitiveVisualAnalyze = runCliJson(['visual-analyze', config.origin, 'local-basic'], settings);
    if (
      sensitiveVisualAnalyze.ok ||
      sensitiveVisualAnalyze.error.code !== 'VISUAL_PROVIDER_POLICY_BLOCKED' ||
      sensitiveVisualAnalyze.error.reason !== 'SENSITIVE_VISUAL_CONTENT'
    ) {
      throw new Error(`Expected sensitive visual policy block: ${JSON.stringify(sensitiveVisualAnalyze)}`);
    }

    const mockPlayObservation = await runCliJsonAsync([
      'open-observe',
      `${config.origin}/mock-play-console.html`,
      '45000',
      '1000'
    ], settings);
    if (
      !mockPlayObservation.ok ||
      !mockPlayObservation.result.observation ||
      mockPlayObservation.result.observation.title !== 'Codex Operator Mock Play Console Fixture'
    ) {
      throw new Error(`Mock Play Console observation failed: ${JSON.stringify(mockPlayObservation)}`);
    }
    const appIconUploadHandle = findElementHandle(
      { result: mockPlayObservation.result.observation },
      (element) => element.id === 'appIconDropzone' &&
        element.uploadTarget === true &&
        element.uploadRole === 'playStoreAppIcon',
      'mock Play app icon upload target'
    );
    const featureGraphicUploadHandle = findElementHandle(
      { result: mockPlayObservation.result.observation },
      (element) => element.id === 'featureGraphicDropzone' &&
        element.uploadTarget === true &&
        element.uploadRole === 'playStoreFeatureGraphic',
      'mock Play feature graphic upload target'
    );

    const validIconPath = writeSmokePngAsset(config, 'play-icon.png', {
      width: 512,
      height: 512,
      colorType: 6
    });
    const mockPlayUpload = runCliJson([
      'upload-file',
      config.origin,
      appIconUploadHandle,
      'googlePlayPreviewAssets.v2026',
      JSON.stringify([{
        role: 'playStoreAppIcon',
        path: validIconPath
      }]),
      'true'
    ], settings);
    if (
      !mockPlayUpload.ok ||
      mockPlayUpload.result.action !== 'uploaded' ||
      mockPlayUpload.result.previewVerified !== true ||
      !mockPlayUpload.result.previewEvidence ||
      mockPlayUpload.result.previewEvidence.changed !== true ||
      mockPlayUpload.result.previewEvidence.method !== 'dom-preview-snapshot' ||
      !Array.isArray(mockPlayUpload.result.files) ||
      mockPlayUpload.result.files[0].role !== 'playStoreAppIcon'
    ) {
      throw new Error(`Mock Play upload failed: ${JSON.stringify(mockPlayUpload)}`);
    }
    const mockPlayDom = await withCdp(await pageTarget(config), async (send) => {
      const result = await send('Runtime.evaluate', {
        expression: `({
          appIconPreview: document.getElementById('appIconPreview').textContent,
          appIconStatus: document.getElementById('appIconStatus').textContent,
          uploadedBasenames: document.getElementById('appIconUpload').dataset.codexUploadedBasenames
        })`,
        returnByValue: true
      });
      return result.result.result.value;
    });
    if (
      !/play-icon\.png/.test(mockPlayDom.appIconPreview || '') ||
      !/accepted/.test(mockPlayDom.appIconStatus || '') ||
      mockPlayDom.uploadedBasenames !== 'play-icon.png'
    ) {
      throw new Error(`Mock Play upload DOM verification failed: ${JSON.stringify(mockPlayDom)}`);
    }

    const invalidFeaturePath = writeSmokePngAsset(config, 'bad-feature.png', {
      width: 100,
      height: 100,
      colorType: 2
    });
    const invalidAssetUpload = runCliJson([
      'upload-file',
      config.origin,
      featureGraphicUploadHandle,
      'googlePlayPreviewAssets.v2026',
      JSON.stringify([{
        role: 'playStoreFeatureGraphic',
        path: invalidFeaturePath
      }])
    ], settings);
    if (
      invalidAssetUpload.ok ||
      invalidAssetUpload.error.code !== 'ASSET_DIMENSION_MISMATCH'
    ) {
      throw new Error(`Expected invalid mock asset to be blocked: ${JSON.stringify(invalidAssetUpload)}`);
    }

    const mockPlayPostUploadObservation = runCliJson(['observe', config.origin], settings);
    const sendForReviewHandle = findElementHandle(
      mockPlayPostUploadObservation,
      (element) => element.id === 'sendForReviewButton',
      'mock Play send for review button'
    );
    const mockPlaySendForReview = runCliJson(['click', config.origin, sendForReviewHandle], settings);
    if (
      mockPlaySendForReview.ok ||
      mockPlaySendForReview.error.code !== 'HIGH_RISK_BLOCKED'
    ) {
      throw new Error(`Expected mock Play send-for-review to be high-risk blocked: ${JSON.stringify(mockPlaySendForReview)}`);
    }

    const mockCommerceObservation = await runCliJsonAsync([
      'open-observe',
      `${config.origin}/mock-commerce.html`,
      '45000',
      '1000'
    ], settings);
    if (
      !mockCommerceObservation.ok ||
      !mockCommerceObservation.result.observation ||
      mockCommerceObservation.result.observation.title !== 'Codex Operator Mock Commerce Fixture'
    ) {
      throw new Error(`Mock commerce observation failed: ${JSON.stringify(mockCommerceObservation)}`);
    }
    const mockCommerceCart = runCliJson([
      'cart-prepare',
      config.origin,
      'Mac mini',
      JSON.stringify({
        minSellerRating: 4,
        currency: 'TRY',
        sort: 'price-asc'
      }),
      'true'
    ], settings);
    if (
      !mockCommerceCart.ok ||
      !mockCommerceCart.result.selected ||
      mockCommerceCart.result.selected.productId !== 'mac-mini-eligible-base' ||
      mockCommerceCart.result.selected.price !== 24999 ||
      !mockCommerceCart.result.cart ||
      mockCommerceCart.result.cart.verified !== true ||
      mockCommerceCart.result.cart.productId !== 'mac-mini-eligible-base' ||
      mockCommerceCart.result.stoppedBeforeCheckout !== true ||
      !mockCommerceCart.result.detailRecheck ||
      mockCommerceCart.result.detailRecheck.ok !== true
    ) {
      throw new Error(`Mock commerce cart preparation failed: ${JSON.stringify(mockCommerceCart)}`);
    }
    const mockCommercePostObservation = runCliJson(['observe', config.origin], settings);
    const checkoutHandle = findElementHandle(
      mockCommercePostObservation,
      (element) => element.id === 'checkoutButton',
      'mock commerce checkout button'
    );
    const mockCommerceCheckoutClick = runCliJson(['click', config.origin, checkoutHandle], settings);
    if (
      mockCommerceCheckoutClick.ok ||
      mockCommerceCheckoutClick.error.code !== 'HIGH_RISK_BLOCKED'
    ) {
      throw new Error(`Expected mock commerce checkout to be high-risk blocked: ${JSON.stringify(mockCommerceCheckoutClick)}`);
    }

    await withCdp(await pageTarget(config), async (send) => {
      await send('Page.navigate', { url: `${config.origin}/basic-form.html` });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });

    const emergencyStop = runCliJson(['emergency-stop', 'clean smoke stop'], settings);
    if (!emergencyStop.ok || emergencyStop.result.active !== true) {
      throw new Error(`Emergency stop failed: ${JSON.stringify(emergencyStop)}`);
    }
    const emergencyBlockedObserve = runCliJson(['observe', config.origin], settings);
    if (emergencyBlockedObserve.ok || emergencyBlockedObserve.error.code !== 'EMERGENCY_STOPPED') {
      throw new Error(`Expected EMERGENCY_STOPPED during emergency stop: ${JSON.stringify(emergencyBlockedObserve)}`);
    }
    const emergencyClear = runCliJson(['emergency-clear'], settings);
    if (!emergencyClear.ok || emergencyClear.result.active !== false) {
      throw new Error(`Emergency clear failed: ${JSON.stringify(emergencyClear)}`);
    }
    const postEmergencyObserve = runCliJson(['observe', config.origin], settings);
    if (!postEmergencyObserve.ok) {
      throw new Error(`Observe failed after emergency clear: ${JSON.stringify(postEmergencyObserve)}`);
    }
    const disconnect = runCliJson(['disconnect', 'clean smoke reconnect'], settings);
    if (!disconnect.ok || disconnect.result.connectionState !== 'RECONNECTING') {
      throw new Error(`Disconnect transition failed: ${JSON.stringify(disconnect)}`);
    }
    const disconnectedObserve = runCliJson(['observe', config.origin], settings);
    if (disconnectedObserve.ok || disconnectedObserve.error.code !== 'EXTENSION_DISCONNECTED') {
      throw new Error(`Expected EXTENSION_DISCONNECTED before reconnect: ${JSON.stringify(disconnectedObserve)}`);
    }
    await withCdp(await pageTarget(config), async (send) => {
      await send('Page.navigate', {
        url: `chrome-extension://${config.extensionId}/bootstrap.html`
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });
    await waitForStatus(settings, (status) => status.connectionState === 'EXTENSION_CONNECTED' && status.profileVerified === true);
    await withCdp(await pageTarget(config), async (send) => {
      await send('Page.navigate', { url: `${config.origin}/basic-form.html` });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });
    const postReconnectObserve = runCliJson(['observe', config.origin], settings);
    if (!postReconnectObserve.ok) {
      throw new Error(`Observe failed after reconnect: ${JSON.stringify(postReconnectObserve)}`);
    }
    const basicHandles = {
      appName: findElementHandle(
        postReconnectObserve,
        (element) => element.name === 'appName',
        'app name input'
      ),
      description: findElementHandle(
        postReconnectObserve,
        (element) => element.name === 'description',
        'description textarea'
      ),
      locale: findElementHandle(
        postReconnectObserve,
        (element) => element.name === 'locale',
        'locale select'
      ),
      enableBeta: findElementHandle(
        postReconnectObserve,
        (element) => element.name === 'enableBeta',
        'enable beta checkbox'
      ),
      saveDraft: findElementHandle(
        postReconnectObserve,
        (element) => element.id === 'saveDraft',
        'save draft button'
      ),
      publish: findElementHandle(
        postReconnectObserve,
        (element) => element.id === 'publish',
        'publish button'
      )
    };
    const waitForBasicForm = runCliJson([
      'wait-for',
      config.origin,
      JSON.stringify({ type: 'textVisible', text: 'Basic Form Fixture' }),
      '5000',
      '100'
    ], settings);
    if (!waitForBasicForm.ok || waitForBasicForm.result.condition.type !== 'textVisible') {
      throw new Error(`WaitFor textVisible failed after reconnect: ${JSON.stringify(waitForBasicForm)}`);
    }
    const activeTabStatus = runCliJson(['status'], settings);
    const activeTab = activeTabStatus.result && activeTabStatus.result.activeTab;
    if (
      !activeTab ||
      activeTab.origin !== config.origin ||
      activeTab.title !== 'Codex Operator Basic Fixture' ||
      activeTab.loadingState !== 'complete'
    ) {
      throw new Error(`Active tab status did not match fixture: ${JSON.stringify(activeTabStatus)}`);
    }
    const basicActionResults = {
      focus: runCliJson(['focus', config.origin, basicHandles.appName], settings),
      type: runCliJson(['type', config.origin, basicHandles.appName, 'Typed Smoke App'], settings),
      typeBeforeClear: runCliJson(['type', config.origin, basicHandles.description, 'Temporary text'], settings),
      clear: runCliJson(['clear', config.origin, basicHandles.description], settings),
      select: runCliJson(['select', config.origin, basicHandles.locale, 'tr'], settings),
      check: runCliJson(['check', config.origin, basicHandles.enableBeta], settings),
      pressKey: runCliJson(['press-key', config.origin, basicHandles.appName, 'Enter'], settings),
      scroll: runCliJson(['scroll', config.origin, basicHandles.saveDraft, '0', '240'], settings)
    };
    for (const [action, result] of Object.entries(basicActionResults)) {
      if (!result.ok) {
        throw new Error(`Basic DOM action failed (${action}): ${JSON.stringify(result)}`);
      }
    }
    const basicDomActions = await withCdp(await pageTarget(config), async (send) => {
      const result = await send('Runtime.evaluate', {
        expression: `({
          appName: document.querySelector('[name=appName]').value,
          description: document.querySelector('[name=description]').value,
          locale: document.querySelector('[name=locale]').value,
          enableBeta: document.querySelector('[name=enableBeta]').checked,
          focusedName: document.activeElement && document.activeElement.getAttribute('name'),
          status: document.getElementById('status').textContent,
          scrollY: window.scrollY
        })`,
        returnByValue: true
      });
      return result.result.result.value;
    });
    if (
      basicDomActions.appName !== 'Typed Smoke App' ||
      basicDomActions.description !== '' ||
      basicDomActions.locale !== 'tr' ||
      basicDomActions.enableBeta !== true ||
      basicDomActions.focusedName !== 'appName' ||
      basicDomActions.status !== 'Pressed Enter' ||
      basicDomActions.scrollY <= 0
    ) {
      throw new Error(`Basic DOM action verification failed: ${JSON.stringify(basicDomActions)}`);
    }
    const boundedFullAutoContract = {
      mode: 'bounded-full-auto-v1',
      approvedOrigins: [config.origin],
      taskScope: 'Clean smoke bounded non-final fixture editing',
      allowedActionKinds: ['fill', 'click'],
      blockedActionKinds: ['publish', 'payment', 'checkout', 'order-placement', 'delete'],
      limits: {
        expiresInMinutes: 30,
        maxBrowserActions: 4,
        maxScreenshots: 0,
        maxOriginChanges: 0
      },
      auditRequired: true,
      emergencyStopRequired: true
    };
    const boundedFullAutoStart = runCliJson([
      'full-auto-start',
      JSON.stringify(boundedFullAutoContract)
    ], settings);
    if (!boundedFullAutoStart.ok || boundedFullAutoStart.result.active !== true) {
      throw new Error(`Bounded Full Auto start failed: ${JSON.stringify(boundedFullAutoStart)}`);
    }
    runCliJson(['fill', config.origin, basicHandles.appName, 'Clean Smoke App'], settings);
    runCliJson(['fill', config.origin, basicHandles.description, 'Single command smoke test.'], settings);
    runCliJson(['click', config.origin, basicHandles.saveDraft], settings);
    const highRiskClick = runCliJson(['click', config.origin, basicHandles.publish], settings);
    if (highRiskClick.ok || highRiskClick.error.code !== 'HIGH_RISK_BLOCKED' || !highRiskClick.error.approvalId) {
      throw new Error(`Expected HIGH_RISK_BLOCKED for publish click: ${JSON.stringify(highRiskClick)}`);
    }
    const boundedFullAutoAfterHighRisk = runCliJson(['full-auto-status'], settings);
    if (
      !boundedFullAutoAfterHighRisk.ok ||
      boundedFullAutoAfterHighRisk.result.counters.browserActions !== 4
    ) {
      throw new Error(`Bounded Full Auto counters did not track browser actions: ${JSON.stringify(boundedFullAutoAfterHighRisk)}`);
    }
    const boundedFullAutoStop = runCliJson(['full-auto-stop', 'manual high-risk replay'], settings);
    if (!boundedFullAutoStop.ok || boundedFullAutoStop.result.active !== false) {
      throw new Error(`Bounded Full Auto stop failed: ${JSON.stringify(boundedFullAutoStop)}`);
    }
    const auditTail = runCliJson(['audit-tail', '40'], settings);
    const auditedBoundedAction = auditTail.ok && auditTail.result.entries.some((entry) => (
      entry.method === 'page.click' &&
      entry.mode === 'bounded-full-auto-v1' &&
      entry.origin === config.origin &&
      entry.boundedFullAuto &&
      entry.boundedFullAuto.counters &&
      entry.boundedFullAuto.counters.browserActions === 4
    ));
    if (!auditedBoundedAction) {
      throw new Error(`Bounded Full Auto audit entry not found: ${JSON.stringify(auditTail)}`);
    }
    const blockedStatus = await withCdp(await pageTarget(config), async (send) => {
      const result = await send('Runtime.evaluate', {
        expression: "document.getElementById('status').textContent",
        returnByValue: true
      });
      return result.result.result.value;
    });
    if (blockedStatus !== 'Draft saved') {
      throw new Error(`High-risk click changed fixture before approval: ${blockedStatus}`);
    }

    const approvalId = highRiskClick.error.approvalId;
    const approvedHighRisk = runCliJson(['approval-approve', approvalId], settings);
    if (!approvedHighRisk.ok) {
      throw new Error(`High-risk approval failed: ${JSON.stringify(approvedHighRisk)}`);
    }
    const replayedHighRisk = runCliJson(['approval-run', approvalId], settings);
    if (!replayedHighRisk.ok) {
      throw new Error(`High-risk approval replay failed: ${JSON.stringify(replayedHighRisk)}`);
    }

    const dom = await withCdp(await pageTarget(config), async (send) => {
      const result = await send('Runtime.evaluate', {
        expression: `({
          appName: document.querySelector('[name=appName]').value,
          description: document.querySelector('[name=description]').value,
          status: document.getElementById('status').textContent
        })`,
        returnByValue: true
      });
      return result.result.result.value;
    });

    if (dom.status !== 'Published') {
      throw new Error(`Unexpected fixture status: ${JSON.stringify(dom)}`);
    }

    const finalStatus = runCliJson(['status'], settings);
    const screenshotArtifact = visualObservation.result.screenshot;
    const screenshotCleanup = runCliJson(['screenshots-cleanup', '0'], settings);
    const screenshotRemoved = screenshotCleanup.ok &&
      screenshotCleanup.result.removed.some((artifact) => artifact.artifactId === screenshotArtifact.artifactId);
    if (!screenshotRemoved || fs.existsSync(screenshotArtifact.path)) {
      throw new Error(`Screenshot cleanup failed: ${JSON.stringify({ screenshotCleanup, screenshotArtifact })}`);
    }
    const revoke = runCliJson(['revoke', config.origin], settings);
    if (!revoke.ok || revoke.result.revoked !== true) {
      throw new Error(`Domain approval revoke failed: ${JSON.stringify(revoke)}`);
    }
    const postRevokeObserve = runCliJson(['observe', config.origin], settings);
    if (postRevokeObserve.ok || postRevokeObserve.error.code !== 'DOMAIN_NOT_APPROVED') {
      throw new Error(`Expected DOMAIN_NOT_APPROVED after domain revoke: ${JSON.stringify(postRevokeObserve)}`);
    }
    const postRevokeStatus = runCliJson(['status'], settings);
    return {
      ok: true,
      chromePid,
      extensionId: config.extensionId,
      ensureStartedBootstrapRequired: ensureStartedBeforeChrome.result.bootstrapRequired,
      ensureStartedBootstrapUrl: ensureStartedBeforeChrome.result.bootstrapUrl,
      prepareOriginPermissionUrl: preparedOrigin.result.permissionUrl,
      waitReadyAfterPermission: readyAfterPermission.result.ready,
      openObserveTitle: openedObservation.result.observation.title,
      origin: config.origin,
      blockedBeforeHostPermission: blockedObserve.error.code,
      observedTitle: observation.result.title,
      visualObservedTitle: visualObservation.result.title,
      visualScreenshotArtifactId: screenshotArtifact.artifactId,
      visualScreenshotBytes: screenshotArtifact.bytes,
      visualScreenshotSha256: screenshotArtifact.sha256,
      visualAnalyzeProvider: analysis.provider,
      visualAnalyzeStatus: analysis.status,
      visualAnalyzeArtifactId: analysis.artifactId,
      visualAnalyzeRegions: visualRegionKinds,
      visualAnalyzeCorrelations: analysis.handleCorrelations.length,
      sensitiveVisualBlocked: sensitiveVisualAnalyze.error.code,
      sensitiveVisualReason: sensitiveVisualAnalyze.error.reason,
      gatedVisualBlocked: gatedVisualObserve.error.code,
      emergencyBlocked: emergencyBlockedObserve.error.code,
      emergencyCleared: emergencyClear.result.active === false,
      reconnectBlocked: disconnectedObserve.error.code,
      reconnectRecoveredTitle: postReconnectObserve.result.title,
      waitForTextVisibleElapsedMs: waitForBasicForm.result.elapsedMs,
      activeTabTitle: activeTab.title,
      activeTabOrigin: activeTab.origin,
      activeTabLoadingState: activeTab.loadingState,
      gateHandoffBlocked: gatedClick.error.code,
      gateHandoffResume: gateDom.gateStatus,
      boundedFullAutoStarted: boundedFullAutoStart.result.active,
      boundedFullAutoActions: boundedFullAutoAfterHighRisk.result.counters.browserActions,
      boundedFullAutoStopped: boundedFullAutoStop.result.active === false,
      boundedFullAutoAudited: auditedBoundedAction,
      mockPlayUploadPreviewVerified: mockPlayUpload.result.previewVerified,
      mockPlayPreviewEvidenceChanged: mockPlayUpload.result.previewEvidence.changed,
      mockPlayPreviewEvidenceMethod: mockPlayUpload.result.previewEvidence.method,
      mockPlayUploadStatus: mockPlayUpload.result.action,
      mockPlayUploadRole: mockPlayUpload.result.files[0].role,
      mockPlayUploadDom: mockPlayDom,
      invalidAssetBlocked: invalidAssetUpload.error.code,
      mockPlaySendForReviewBlocked: mockPlaySendForReview.error.code,
      mockCommerceSelectedProductId: mockCommerceCart.result.selected.productId,
      mockCommerceSelectedPrice: mockCommerceCart.result.selected.price,
      mockCommerceSelectedSellerRating: mockCommerceCart.result.selected.sellerRating,
      mockCommerceCartVerified: mockCommerceCart.result.cart.verified,
      mockCommerceStoppedBeforeCheckout: mockCommerceCart.result.stoppedBeforeCheckout,
      mockCommerceCheckoutBlocked: mockCommerceCheckoutClick.error.code,
      mockCommerceExcludedReasons: mockCommerceCart.result.excluded.map((item) => item.reason),
      basicDomActions,
      highRiskBlocked: highRiskClick.error.code,
      highRiskApprovalReplay: replayedHighRisk.result.action,
      screenshotCleanupRemoved: screenshotRemoved,
      postRevokeBlocked: postRevokeObserve.error.code,
      dom,
      finalStatus: finalStatus.result,
      postRevokeStatus: postRevokeStatus.result
    };
  } finally {
    if (chromeStarted && !options.keepBrowser) {
      stopChromeProfile(config.profileDir);
    }
    if (fixtureServer) {
      await new Promise((resolve) => fixtureServer.close(resolve));
    }
    stopPortOwner(17391);
    restoreFileSnapshot(statePath, stateSnapshot);
  }
}

function parseSmokeArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--keep-browser') {
      options.keepBrowser = true;
    } else if (arg === '--fixture-port') {
      options.fixturePort = Number(argv[++index]);
    } else if (arg === '--debug-port') {
      options.debugPort = Number(argv[++index]);
    } else if (arg === '--run-id') {
      options.runId = argv[++index];
    }
  }
  return options;
}

if (require.main === module) {
  runCleanSmoke(parseSmokeArgs(process.argv.slice(2))).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertPathInside,
  bindSmokeProfile,
  clickElement,
  findChromeForTesting,
  restoreFileSnapshot,
  parseSmokeArgs,
  resolveSmokeConfig,
  runCleanSmoke,
  snapshotFile
};
