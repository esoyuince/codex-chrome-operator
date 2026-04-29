'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sendRpc } = require('../native-bridge/daemonClient');
const { loadConfig, loadInstalledToken } = require('../operator-daemon/daemon');

const ROOT = path.resolve(__dirname, '..');

function defaultInstallDir(env = process.env) {
  return path.join(
    env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'CodexChromeOperator'
  );
}

function usage() {
  return `Usage:
  node scripts/operator-cli.js status
  node scripts/operator-cli.js ensure-started [origin-or-url]
  node scripts/operator-cli.js prepare-origin <origin-or-url>
  node scripts/operator-cli.js profiles [userDataDir]
  node scripts/operator-cli.js profile-bind <userDataDir> <profileDirectory> [profileLabel]
  node scripts/operator-cli.js profile-verify
  node scripts/operator-cli.js readiness <origin-or-url>
  node scripts/operator-cli.js approvals
  node scripts/operator-cli.js approval-approve <approvalId>
  node scripts/operator-cli.js approval-reject <approvalId>
  node scripts/operator-cli.js approval-run <approvalId>
  node scripts/operator-cli.js approve <origin>
  node scripts/operator-cli.js revoke <origin>
  node scripts/operator-cli.js audit-tail [limit]
  node scripts/operator-cli.js screenshots-cleanup [olderThanMs]
  node scripts/operator-cli.js emergency-stop [reason]
  node scripts/operator-cli.js emergency-clear
  node scripts/operator-cli.js full-auto-start <contract-json>
  node scripts/operator-cli.js full-auto-status
  node scripts/operator-cli.js full-auto-stop [reason]
  node scripts/operator-cli.js disconnect [reason]
  node scripts/operator-cli.js observe <origin>
  node scripts/operator-cli.js visual-observe <origin>
  node scripts/operator-cli.js navigate <url>
  node scripts/operator-cli.js wait-for <origin> <condition-json> [timeoutMs] [pollIntervalMs]
  node scripts/operator-cli.js fill <origin> <handle> <text>
  node scripts/operator-cli.js click <origin> <handle>

Options:
  --base-url <url>   Override daemon base URL
  --token <token>    Override daemon bearer token
  --no-bootstrap     Do not launch Chrome bootstrap from ensure-started
`;
}

function usageError() {
  return new Error(usage());
}

function splitOptions(argv) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base-url') {
      options.baseUrl = argv[index + 1];
      index += 1;
    } else if (arg === '--token') {
      options.token = argv[index + 1];
      index += 1;
    } else if (arg === '--install-dir') {
      options.installDir = argv[index + 1];
      index += 1;
    } else if (arg === '--no-bootstrap') {
      options.openBootstrap = false;
    } else {
      positional.push(arg);
    }
  }
  return { options, positional };
}

function requireArgs(args, count) {
  if (args.length < count) {
    throw usageError();
  }
}

function parseJsonArg(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON.\n\n${usage()}`);
  }
}

function buildRpcRequest(argv) {
  const { positional } = splitOptions(argv);
  const [command, ...args] = positional;

  switch (command) {
    case 'status':
      return { method: 'operator.status', params: {} };
    case 'ensure-started':
      return {
        method: 'operator.ensureStarted',
        params: args[0] ? { origin: new URL(args[0]).origin } : {}
      };
    case 'prepare-origin':
      requireArgs(args, 1);
      return {
        method: 'operator.ensureStarted',
        params: {
          origin: new URL(args[0]).origin
        },
        cliAction: 'prepareOrigin'
      };
    case 'profiles':
      return {
        method: 'operator.profiles.discover',
        params: args[0] ? { userDataDir: args[0] } : {}
      };
    case 'profile-bind':
      requireArgs(args, 2);
      return {
        method: 'operator.profile.bind',
        params: {
          userDataDir: args[0],
          profileDirectory: args[1],
          profileLabel: args.slice(2).join(' ') || undefined
        }
      };
    case 'profile-verify':
      return { method: 'operator.profile.verify', params: {} };
    case 'readiness':
      requireArgs(args, 1);
      return {
        method: 'operator.verifyReadiness',
        params: {
          origin: new URL(args[0]).origin
        }
      };
    case 'approvals':
      return { method: 'operator.approvals.list', params: {} };
    case 'approval-approve':
      requireArgs(args, 1);
      return { method: 'operator.approvals.approve', params: { approvalId: args[0] } };
    case 'approval-reject':
      requireArgs(args, 1);
      return { method: 'operator.approvals.reject', params: { approvalId: args[0] } };
    case 'approval-run':
      requireArgs(args, 1);
      return { method: 'operator.approvals.run', params: { approvalId: args[0] } };
    case 'approve':
      requireArgs(args, 1);
      return { method: 'operator.approveDomain', params: { origin: args[0] } };
    case 'revoke':
      requireArgs(args, 1);
      return { method: 'operator.revokeDomain', params: { origin: args[0] } };
    case 'audit-tail':
      if (args[0] !== undefined && !Number.isFinite(Number(args[0]))) {
        throw usageError();
      }
      return {
        method: 'operator.audit.tail',
        params: {
          limit: args[0] === undefined ? 20 : Number(args[0])
        }
      };
    case 'screenshots-cleanup':
      return {
        method: 'operator.screenshots.cleanup',
        params: {
          olderThanMs: args[0] === undefined ? 0 : Number(args[0])
        }
      };
    case 'emergency-stop':
      return {
        method: 'operator.emergencyStop',
        params: {
          reason: args.join(' ') || undefined
        }
      };
    case 'emergency-clear':
      return { method: 'operator.emergencyClear', params: {} };
    case 'full-auto-start':
      requireArgs(args, 1);
      return {
        method: 'operator.fullAuto.start',
        params: {
          contract: parseJsonArg(args.join(' '), 'full-auto-start contract')
        }
      };
    case 'full-auto-status':
      return { method: 'operator.fullAuto.status', params: {} };
    case 'full-auto-stop':
      return {
        method: 'operator.fullAuto.stop',
        params: {
          reason: args.join(' ') || undefined
        }
      };
    case 'disconnect':
      return {
        method: 'bridge.disconnected',
        params: {
          source: 'operator-cli',
          reason: args.join(' ') || undefined
        }
      };
    case 'observe':
      requireArgs(args, 1);
      return { method: 'page.observe', params: { origin: args[0] } };
    case 'visual-observe':
      requireArgs(args, 1);
      return { method: 'page.visualObserve', params: { origin: args[0] } };
    case 'navigate':
      requireArgs(args, 1);
      return {
        method: 'page.navigate',
        params: {
          url: args[0],
          origin: new URL(args[0]).origin
        }
      };
    case 'wait-for':
      requireArgs(args, 2);
      return {
        method: 'page.waitFor',
        params: {
          origin: args[0],
          condition: parseJsonArg(args[1], 'wait-for condition'),
          ...(args[2] === undefined ? {} : { timeoutMs: Number(args[2]) }),
          ...(args[3] === undefined ? {} : { pollIntervalMs: Number(args[3]) })
        }
      };
    case 'fill':
      requireArgs(args, 3);
      return {
        method: 'page.fill',
        params: {
          origin: args[0],
          handle: args[1],
          text: args.slice(2).join(' ')
        }
      };
    case 'click':
      requireArgs(args, 2);
      return {
        method: 'page.click',
        params: {
          origin: args[0],
          handle: args[1]
        }
      };
    default:
      throw usageError();
  }
}

function resolveCliSettings({
  installDir = defaultInstallDir(),
  env = process.env,
  baseUrl,
  token
} = {}) {
  const configPath = path.join(installDir, 'config.json');
  const tokenPath = path.join(installDir, 'token.txt');
  const config = loadConfig(configPath);
  const resolvedToken = token || env.CODEX_CHROME_OPERATOR_TOKEN || config.token || loadInstalledToken(tokenPath);
  const port = config.port || 17391;

  if (!resolvedToken) {
    throw new Error(`Missing daemon token. Expected token file at ${tokenPath}`);
  }

  return {
    baseUrl: baseUrl || `http://127.0.0.1:${port}`,
    token: resolvedToken,
    installDir
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDaemonConnectionFailure(error) {
  const text = `${error && error.code ? error.code : ''} ${error && error.message ? error.message : ''}`;
  return /ECONNREFUSED|ECONNRESET|fetch failed|Failed to fetch|connect/i.test(text);
}

function logPath(installDir, fileName) {
  const logDir = path.join(installDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  return path.join(logDir, fileName);
}

function startDaemonProcess({ installDir = defaultInstallDir() } = {}) {
  const out = fs.openSync(logPath(installDir, 'operator-daemon.out.log'), 'a');
  const err = fs.openSync(logPath(installDir, 'operator-daemon.err.log'), 'a');
  const child = childProcess.spawn(process.execPath, ['operator-daemon/daemon.js', '--daemon'], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, err]
  });
  child.unref();
  return { pid: child.pid };
}

async function waitForDaemon({
  settings,
  request,
  sendRpcFn = sendRpc,
  timeoutMs = 10000,
  pollIntervalMs = 250
}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      return await sendRpcFn({
        baseUrl: settings.baseUrl,
        token: settings.token,
        request
      });
    } catch (error) {
      lastError = error;
    }
    await delay(pollIntervalMs);
  }
  throw lastError || new Error('Timed out waiting for daemon.');
}

async function waitForExtensionConnection({
  settings,
  request,
  sendRpcFn = sendRpc,
  timeoutMs = 10000,
  pollIntervalMs = 250,
  delayFn = delay
}) {
  const started = Date.now();
  let lastResponse = null;
  let lastError = null;
  let attempts = 0;

  while (Date.now() - started < timeoutMs) {
    attempts += 1;
    try {
      const response = await sendRpcFn({
        baseUrl: settings.baseUrl,
        token: settings.token,
        request: {
          ...request,
          id: `${request.id}_wait_${attempts}`
        }
      });
      lastResponse = response;
      if (response && response.ok && response.result && response.result.extensionConnected) {
        response.result.extensionWait = {
          attempted: true,
          connected: true,
          elapsedMs: Date.now() - started,
          attempts
        };
        return response;
      }
    } catch (error) {
      lastError = error;
    }
    await delayFn(pollIntervalMs);
  }

  if (lastResponse && lastResponse.ok && lastResponse.result) {
    lastResponse.result.extensionWait = {
      attempted: true,
      connected: false,
      elapsedMs: Date.now() - started,
      attempts,
      timeoutMs
    };
    return lastResponse;
  }

  return {
    id: request.id,
    ok: false,
    error: {
      code: 'EXTENSION_WAIT_TIMEOUT',
      message: lastError
        ? `Timed out waiting for extension connection: ${lastError.message}`
        : 'Timed out waiting for extension connection.',
      timeoutMs,
      attempts
    }
  };
}

function findChromeForBootstrap(installDir, env = process.env) {
  const browserRoot = path.join(installDir, 'browsers', 'chrome');
  if (fs.existsSync(browserRoot)) {
    const candidates = fs.readdirSync(browserRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(browserRoot, entry.name, 'chrome-win64', 'chrome.exe'))
      .filter((candidate) => fs.existsSync(candidate))
      .sort()
      .reverse();
    if (candidates[0]) {
      return candidates[0];
    }
  }

  const common = [
    env.ProgramFiles && path.join(env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
  ].filter(Boolean);
  return common.find((candidate) => fs.existsSync(candidate)) || null;
}

function loadConfiguredProfile(installDir) {
  const statePath = path.join(installDir, 'state.json');
  if (!fs.existsSync(statePath)) {
    return null;
  }
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return state.configuredProfile || null;
  } catch {
    return null;
  }
}

function launchBootstrapChrome({
  installDir = defaultInstallDir(),
  bootstrapUrl,
  env = process.env
} = {}) {
  const chromePath = findChromeForBootstrap(installDir, env);
  if (!chromePath) {
    return {
      attempted: true,
      launched: false,
      error: {
        code: 'CHROME_NOT_FOUND',
        message: 'Chrome executable was not found for bootstrap launch.'
      }
    };
  }

  const extensionDir = path.join(installDir, 'extension-unpacked');
  const configuredProfile = loadConfiguredProfile(installDir);
  const args = [];
  if (configuredProfile && configuredProfile.userDataDir) {
    args.push(`--user-data-dir=${configuredProfile.userDataDir}`);
    if (configuredProfile.profileDirectory) {
      args.push(`--profile-directory=${configuredProfile.profileDirectory}`);
    }
  } else if (fs.existsSync(path.join(extensionDir, 'manifest.json'))) {
    args.push(`--user-data-dir=${path.join(installDir, 'chrome-operator-profile')}`);
  }
  if (fs.existsSync(path.join(extensionDir, 'manifest.json'))) {
    args.push(`--load-extension=${extensionDir}`);
  }
  args.push('--no-first-run', '--new-window', bootstrapUrl);

  const child = childProcess.spawn(chromePath, args, {
    detached: true,
    windowsHide: true,
    stdio: 'ignore'
  });
  child.unref();
  return {
    attempted: true,
    launched: true,
    pid: child.pid,
    bootstrapUrl
  };
}

function ensureStartedDiagnostic(result) {
  if (!result || typeof result !== 'object') {
    return null;
  }
  const bootstrapUrl = result.bootstrapUrl
    || (result.bootstrapLaunch && result.bootstrapLaunch.bootstrapUrl)
    || null;

  if (result.bootstrapLaunch && result.bootstrapLaunch.attempted && !result.bootstrapLaunch.launched) {
    return {
      code: 'BOOTSTRAP_LAUNCH_FAILED',
      errorCode: result.bootstrapLaunch.error && result.bootstrapLaunch.error.code
        ? result.bootstrapLaunch.error.code
        : undefined,
      message: result.bootstrapLaunch.error && result.bootstrapLaunch.error.message
        ? result.bootstrapLaunch.error.message
        : 'Chrome bootstrap launch failed.',
      bootstrapUrl,
      nextSteps: [
        'Run install\\doctor.ps1 and check Chrome installation.',
        'Open the bootstrapUrl manually in the configured Chrome profile.',
        'Verify the unpacked extension exists in the install directory.'
      ]
    };
  }

  if (result.extensionWait && result.extensionWait.attempted && !result.extensionWait.connected) {
    return {
      code: 'EXTENSION_WAIT_TIMEOUT',
      errorCode: result.extensionWait.error && result.extensionWait.error.code
        ? result.extensionWait.error.code
        : undefined,
      message: result.extensionWait.timeoutMs
        ? `The extension did not connect within ${result.extensionWait.timeoutMs}ms after bootstrap launch.`
        : 'The extension did not connect after bootstrap launch.',
      bootstrapUrl,
      nextSteps: [
        'Open the bootstrapUrl manually in the configured Chrome profile.',
        'Check that the Codex Chrome Operator extension is enabled.',
        'Run install\\doctor.ps1 and retry ensure-started.'
      ]
    };
  }

  if (result.readiness && result.readiness.ready === false) {
    const origin = result.readiness.origin;
    const missing = Array.isArray(result.readiness.missing)
      ? result.readiness.missing
      : [];
    const nextActions = readinessNextActions(result.readiness, result.status, bootstrapUrl);
    return {
      code: 'READINESS_INCOMPLETE',
      message: origin
        ? `Target origin is not ready for browser work: ${origin}.`
        : 'Target origin is not ready for browser work.',
      origin,
      missing,
      nextActions,
      nextSteps: nextActions.map((action) => action.command || action.url || action.description)
    };
  }

  return null;
}

function normalizeReadiness(readiness) {
  if (!readiness || typeof readiness !== 'object') {
    return null;
  }
  const missing = [];
  if (!readiness.profileVerified) {
    missing.push('profile');
  }
  if (!readiness.domainApproved) {
    missing.push('domainApproval');
  }
  if (!readiness.hostPermissionGranted) {
    missing.push('hostPermission');
  }
  return {
    ...readiness,
    ready: missing.length === 0,
    missing
  };
}

function permissionRequestUrlFromBootstrap(bootstrapUrl, origin) {
  if (!bootstrapUrl || !origin) {
    return null;
  }
  try {
    const parsed = new URL(bootstrapUrl);
    if (parsed.protocol !== 'chrome-extension:') {
      return null;
    }
    return `chrome-extension://${parsed.hostname}/permissionRequest.html?origin=${encodeURIComponent(origin)}`;
  } catch {
    return null;
  }
}

function readinessNextActions(readiness, status = {}, bootstrapUrl = null) {
  const origin = readiness && readiness.origin;
  const missing = Array.isArray(readiness && readiness.missing)
    ? readiness.missing
    : [];
  const actions = [];

  if (missing.includes('profile')) {
    const configuredProfile = status && status.configuredProfile;
    actions.push({
      kind: 'profile',
      command: configuredProfile
        ? 'node scripts/operator-cli.js profile-verify'
        : 'node scripts/operator-cli.js profiles',
      description: configuredProfile
        ? 'Verify the configured Chrome profile binding.'
        : 'Discover and bind the Chrome profile that should own the session.',
      requiresUserGesture: false
    });
  }

  if (missing.includes('domainApproval')) {
    actions.push({
      kind: 'domainApproval',
      command: origin ? `node scripts/operator-cli.js approve ${origin}` : 'node scripts/operator-cli.js approve <origin>',
      description: origin
        ? `Approve ${origin} for guarded operator work.`
        : 'Approve the target origin for guarded operator work.',
      requiresUserGesture: false
    });
  }

  if (missing.includes('hostPermission')) {
    actions.push({
      kind: 'hostPermission',
      command: null,
      url: permissionRequestUrlFromBootstrap(bootstrapUrl, origin),
      description: origin
        ? `Grant Chrome optional host permission for ${origin} from the extension permission page.`
        : 'Grant Chrome optional host permission from the extension permission page.',
      requiresUserGesture: true
    });
  }

  return actions;
}

async function ensureStarted({
  settings,
  request,
  sendRpcFn = sendRpc,
  startDaemonFn = startDaemonProcess,
  waitForDaemonFn = waitForDaemon,
  waitForExtensionConnectionFn = waitForExtensionConnection,
  launchBootstrapFn = launchBootstrapChrome,
  openBootstrap = true,
  waitForExtension = true,
  extensionWaitTimeoutMs = 10000,
  extensionWaitPollIntervalMs = 250
}) {
  let daemonStarted = false;
  let daemonPid = null;
  let response;
  let bootstrapLaunch = null;
  try {
    response = await sendRpcFn({
      baseUrl: settings.baseUrl,
      token: settings.token,
      request
    });
  } catch (error) {
    if (!isDaemonConnectionFailure(error)) {
      throw error;
    }
    const started = startDaemonFn({ installDir: settings.installDir });
    daemonStarted = true;
    daemonPid = started && started.pid ? started.pid : null;
    response = await waitForDaemonFn({
      settings,
      request,
      sendRpcFn
    });
  }

  if (response && response.ok && response.result) {
    if (openBootstrap && response.result.bootstrapRequired && response.result.bootstrapUrl) {
      bootstrapLaunch = launchBootstrapFn({
        installDir: settings.installDir,
        bootstrapUrl: response.result.bootstrapUrl
      });
      response.result.bootstrapLaunch = bootstrapLaunch;

      if (waitForExtension && bootstrapLaunch && bootstrapLaunch.launched) {
        const waitResponse = await waitForExtensionConnectionFn({
          settings,
          request,
          sendRpcFn,
          timeoutMs: extensionWaitTimeoutMs,
          pollIntervalMs: extensionWaitPollIntervalMs
        });
        if (waitResponse && waitResponse.ok && waitResponse.result) {
          response = waitResponse;
          if (!response.result.extensionWait) {
            response.result.extensionWait = {
              attempted: true,
              connected: Boolean(response.result.extensionConnected)
            };
          }
        } else if (waitResponse && !waitResponse.ok && waitResponse.error) {
          response.result.extensionWait = {
            attempted: true,
            connected: false,
            timeoutMs: waitResponse.error.timeoutMs,
            attempts: waitResponse.error.attempts,
            error: waitResponse.error
          };
        }
      } else if (bootstrapLaunch && bootstrapLaunch.attempted && !bootstrapLaunch.launched) {
        response.result.extensionWait = {
          attempted: false,
          connected: false,
          skippedReason: 'BOOTSTRAP_LAUNCH_FAILED'
        };
      }
    }
    response.result.daemonStarted = daemonStarted;
    if (daemonPid) {
      response.result.daemonPid = daemonPid;
    }
    if (bootstrapLaunch) {
      response.result.bootstrapLaunch = bootstrapLaunch;
    }
    if (response.result.readiness) {
      response.result.readiness = normalizeReadiness(response.result.readiness);
    }
    const diagnostic = ensureStartedDiagnostic(response.result);
    if (diagnostic) {
      response.result.diagnostic = diagnostic;
    }
  }
  return response;
}

async function prepareOrigin({
  settings,
  request,
  sendRpcFn = sendRpc,
  ensureStartedFn = ensureStarted,
  openBootstrap = true
}) {
  const origin = request && request.params && request.params.origin;
  if (!origin) {
    return {
      id: request && request.id,
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        message: 'prepare-origin requires an origin or URL.'
      }
    };
  }

  const ensureResponse = await ensureStartedFn({
    settings,
    request,
    sendRpcFn,
    openBootstrap
  });
  if (!ensureResponse || !ensureResponse.ok) {
    return ensureResponse;
  }

  let readiness = normalizeReadiness(ensureResponse.result && ensureResponse.result.readiness);
  const applied = {
    domainApproval: false
  };
  let approval = null;

  if (readiness && readiness.missing.includes('domainApproval')) {
    const approvalResponse = await sendRpcFn({
      baseUrl: settings.baseUrl,
      token: settings.token,
      request: {
        id: `${request.id}_approve_domain`,
        method: 'operator.approveDomain',
        params: { origin }
      }
    });
    if (!approvalResponse || !approvalResponse.ok) {
      return approvalResponse;
    }
    approval = approvalResponse.result;
    applied.domainApproval = true;

    const readinessResponse = await sendRpcFn({
      baseUrl: settings.baseUrl,
      token: settings.token,
      request: {
        id: `${request.id}_verify_readiness`,
        method: 'operator.verifyReadiness',
        params: { origin }
      }
    });
    if (!readinessResponse || !readinessResponse.ok) {
      return readinessResponse;
    }
    readiness = normalizeReadiness(readinessResponse.result);
  }

  const bootstrapUrl = ensureResponse.result && (
    ensureResponse.result.bootstrapUrl ||
    (ensureResponse.result.bootstrapLaunch && ensureResponse.result.bootstrapLaunch.bootstrapUrl)
  );
  const nextActions = readiness ? readinessNextActions(readiness, ensureResponse.result.status, bootstrapUrl) : [];
  const nextAction = nextActions.find((action) => action.requiresUserGesture) || nextActions[0] || null;
  const permissionAction = nextActions.find((action) => action.kind === 'hostPermission') || null;

  return {
    id: request.id,
    ok: true,
    result: {
      origin,
      ready: readiness ? readiness.ready : false,
      readiness,
      applied,
      approval,
      ensureStarted: ensureResponse.result,
      nextActions,
      nextAction,
      permissionUrl: permissionAction ? permissionAction.url : null,
      requiresUserGesture: Boolean(nextAction && nextAction.requiresUserGesture),
      diagnostic: readiness && !readiness.ready
        ? {
          code: 'READINESS_INCOMPLETE',
          origin,
          missing: readiness.missing,
          nextActions
        }
        : null
    }
  };
}

async function run(argv = process.argv.slice(2), output = process.stdout) {
  const { options } = splitOptions(argv);
  const builtRequest = buildRpcRequest(argv);
  const { cliAction, ...rpcRequest } = builtRequest;
  const request = {
    id: `cli_${Date.now()}`,
    ...rpcRequest
  };
  const settings = resolveCliSettings(options);
  const response = cliAction === 'prepareOrigin'
    ? await prepareOrigin({
      settings,
      request,
      openBootstrap: options.openBootstrap !== false
    })
    : request.method === 'operator.ensureStarted'
    ? await ensureStarted({
      settings,
      request,
      openBootstrap: options.openBootstrap !== false
    })
    : await sendRpc({
      baseUrl: settings.baseUrl,
      token: settings.token,
      request
    });
  output.write(`${JSON.stringify(response, null, 2)}\n`);
  return response;
}

if (require.main === module) {
  run().then((response) => {
    if (!response.ok) {
      process.exitCode = 1;
    }
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildRpcRequest,
  defaultInstallDir,
  ensureStarted,
  findChromeForBootstrap,
  launchBootstrapChrome,
  prepareOrigin,
  resolveCliSettings,
  run,
  startDaemonProcess,
  splitOptions,
  usage,
  waitForExtensionConnection
};
