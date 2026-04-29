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

async function ensureStarted({
  settings,
  request,
  sendRpcFn = sendRpc,
  startDaemonFn = startDaemonProcess,
  waitForDaemonFn = waitForDaemon,
  launchBootstrapFn = launchBootstrapChrome,
  openBootstrap = true
}) {
  let daemonStarted = false;
  let daemonPid = null;
  let response;
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
    response.result.daemonStarted = daemonStarted;
    if (daemonPid) {
      response.result.daemonPid = daemonPid;
    }
    if (openBootstrap && response.result.bootstrapRequired && response.result.bootstrapUrl) {
      response.result.bootstrapLaunch = launchBootstrapFn({
        installDir: settings.installDir,
        bootstrapUrl: response.result.bootstrapUrl
      });
    }
  }
  return response;
}

async function run(argv = process.argv.slice(2), output = process.stdout) {
  const { options } = splitOptions(argv);
  const request = {
    id: `cli_${Date.now()}`,
    ...buildRpcRequest(argv)
  };
  const settings = resolveCliSettings(options);
  const response = request.method === 'operator.ensureStarted'
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
  resolveCliSettings,
  run,
  startDaemonProcess,
  splitOptions,
  usage
};
