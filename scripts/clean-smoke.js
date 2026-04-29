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

async function clickElement(send, elementId) {
  const rect = await send('Runtime.evaluate', {
    expression: `(() => { const r = document.getElementById('${elementId}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    returnByValue: true
  });
  const { x, y } = rect.result.result.value;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function runCleanSmoke(options = {}) {
  const extensionId = ensureExtensionKey().extensionId;
  runInstall(extensionId);
  const config = resolveSmokeConfig(options);
  const settings = resolveCliSettings({ installDir: config.installDir });
  let fixtureServer = null;
  let chromeStarted = false;

  try {
    stopPortOwner(config.debugPort);
    stopPortOwner(config.fixturePort);
    startDaemon(config);
    await waitForStatus(settings, (status) => status.connectionState === 'DAEMON_RUNNING_EXTENSION_DISCONNECTED');

    fixtureServer = await startFixtureServer(config);
    stopChromeProfile(config.profileDir);
    const chromePid = launchChromeForTesting(config);
    chromeStarted = true;
    await waitForStatus(settings, (status) => status.connectionState === 'EXTENSION_CONNECTED_SETUP_ONLY');

    await withCdp(await pageTarget(config), async (send) => {
      await send('Page.navigate', {
        url: `chrome-extension://${config.extensionId}/profileSetup.html?profileBindingId=profbind_developmentBinding01&profileBindingVersion=1`
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await clickElement(send, 'bind');
    });
    await waitForStatus(settings, (status) => status.profileVerified === true);

    const failClosed = runCliJson(['approve', config.origin], settings);
    if (!failClosed.ok) {
      throw new Error(`Domain approval failed: ${JSON.stringify(failClosed)}`);
    }
    const blockedObserve = runCliJson(['observe', config.origin], settings);
    if (blockedObserve.ok || blockedObserve.error.code !== 'HOST_PERMISSION_REQUIRED') {
      throw new Error(`Expected HOST_PERMISSION_REQUIRED before permission grant: ${JSON.stringify(blockedObserve)}`);
    }

    await withCdp(await pageTarget(config), async (send) => {
      await send('Page.navigate', {
        url: `chrome-extension://${config.extensionId}/permissionRequest.html?origin=${encodeURIComponent(config.origin)}`
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await clickElement(send, 'grant');
    });
    acceptPermissionPrompt(config.profileDir);
    await waitForStatus(settings, (status) => status.hostPermissionOrigins.includes(config.origin));

    await withCdp(await pageTarget(config), async (send) => {
      await send('Page.navigate', {
        url: `chrome-extension://${config.extensionId}/permissionRequest.html?origin=${encodeURIComponent(config.origin)}&visualCapture=1`
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await clickElement(send, 'grant');
    });
    acceptPermissionPrompt(config.profileDir);

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
    if (!visualObservation.result.screenshot || !visualObservation.result.screenshot.dataUrl.startsWith('data:image/png;base64,')) {
      throw new Error(`Visual observe did not return a PNG screenshot: ${JSON.stringify(visualObservation)}`);
    }
    runCliJson(['fill', config.origin, 'el_0', 'Clean Smoke App'], settings);
    runCliJson(['fill', config.origin, 'el_1', 'Single command smoke test.'], settings);
    runCliJson(['click', config.origin, 'el_2'], settings);
    const highRiskClick = runCliJson(['click', config.origin, 'el_3'], settings);
    if (highRiskClick.ok || highRiskClick.error.code !== 'HIGH_RISK_BLOCKED' || !highRiskClick.error.approvalId) {
      throw new Error(`Expected HIGH_RISK_BLOCKED for publish click: ${JSON.stringify(highRiskClick)}`);
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
    return {
      ok: true,
      chromePid,
      extensionId: config.extensionId,
      origin: config.origin,
      blockedBeforeHostPermission: blockedObserve.error.code,
      observedTitle: observation.result.title,
      visualObservedTitle: visualObservation.result.title,
      visualScreenshotBytes: visualObservation.result.screenshot.bytesApprox,
      highRiskBlocked: highRiskClick.error.code,
      highRiskApprovalReplay: replayedHighRisk.result.action,
      dom,
      finalStatus: finalStatus.result
    };
  } finally {
    if (chromeStarted && !options.keepBrowser) {
      stopChromeProfile(config.profileDir);
    }
    if (fixtureServer) {
      await new Promise((resolve) => fixtureServer.close(resolve));
    }
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
  findChromeForTesting,
  parseSmokeArgs,
  resolveSmokeConfig,
  runCleanSmoke
};
