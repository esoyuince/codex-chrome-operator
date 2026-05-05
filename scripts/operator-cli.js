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
  node scripts/operator-cli.js open-observe <url> [timeoutMs] [pollIntervalMs]
  node scripts/operator-cli.js profiles [userDataDir]
  node scripts/operator-cli.js profile-bind <userDataDir> <profileDirectory> [profileLabel]
  node scripts/operator-cli.js profile-verify
  node scripts/operator-cli.js profile-doctor [origin-or-url]
  node scripts/operator-cli.js profile-onboard [userDataDir] [profileDirectory] [profileLabel]
  node scripts/operator-cli.js readiness <origin-or-url>
  node scripts/operator-cli.js wait-ready <origin-or-url> [timeoutMs] [pollIntervalMs]
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
  node scripts/operator-cli.js read-page <origin> [filter] [maxChars] [includeFormValues] [maxFieldValueChars]
  node scripts/operator-cli.js visual-observe <origin>
  node scripts/operator-cli.js visual-analyze <origin> [provider]
  node scripts/operator-cli.js upload-file <origin> <handle> <ruleset> <files-json> [verifyPreview]
  node scripts/operator-cli.js cart-prepare <origin-or-url> <query> <criteria-json> <cartActionAllowed> [profileId]
  node scripts/operator-cli.js navigate <url>
  node scripts/operator-cli.js wait-for <origin> <condition-json> [timeoutMs] [pollIntervalMs]
  node scripts/operator-cli.js fill <origin> <handle> <text>
  node scripts/operator-cli.js type <origin> <handle> <text>
  node scripts/operator-cli.js clear <origin> <handle>
  node scripts/operator-cli.js focus <origin> <handle>
  node scripts/operator-cli.js select <origin> <handle> <value>
  node scripts/operator-cli.js check <origin> <handle> [true|false]
  node scripts/operator-cli.js scroll <origin> <handle> <deltaX> <deltaY>
  node scripts/operator-cli.js press-key <origin> <handle> <key>
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

function parseBooleanArg(value, defaultValue = true) {
  if (value === undefined) {
    return defaultValue;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw usageError();
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
    case 'open-observe':
      requireArgs(args, 1);
      return {
        method: 'page.observe',
        params: {
          url: args[0],
          origin: new URL(args[0]).origin,
          ...(args[1] === undefined ? {} : { timeoutMs: Number(args[1]) }),
          ...(args[2] === undefined ? {} : { pollIntervalMs: Number(args[2]) })
        },
        cliAction: 'openObserve'
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
    case 'profile-doctor':
      return {
        method: 'operator.status',
        params: args[0] ? { origin: new URL(args[0]).origin } : {},
        cliAction: 'profileDoctor'
      };
    case 'profile-onboard':
      return {
        method: 'operator.profiles.discover',
        params: {
          ...(args[0] === undefined ? {} : { userDataDir: args[0] }),
          ...(args[1] === undefined ? {} : { profileDirectory: args[1] }),
          ...(args.length > 2 ? { profileLabel: args.slice(2).join(' ') } : {})
        },
        cliAction: 'profileOnboard'
      };
    case 'readiness':
      requireArgs(args, 1);
      return {
        method: 'operator.verifyReadiness',
        params: {
          origin: new URL(args[0]).origin
        }
      };
    case 'wait-ready':
      requireArgs(args, 1);
      return {
        method: 'operator.verifyReadiness',
        params: {
          origin: new URL(args[0]).origin,
          ...(args[1] === undefined ? {} : { timeoutMs: Number(args[1]) }),
          ...(args[2] === undefined ? {} : { pollIntervalMs: Number(args[2]) })
        },
        cliAction: 'waitReady'
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
    case 'read-page':
      requireArgs(args, 1);
      return {
        method: 'page.readPage',
        params: {
          origin: args[0],
          ...(args[1] === undefined ? {} : { filter: args[1] }),
          ...(args[2] === undefined ? {} : { maxChars: Number(args[2]) }),
          ...(args[3] === undefined ? {} : { includeFormValues: parseBooleanArg(args[3]) }),
          ...(args[4] === undefined ? {} : { maxFieldValueChars: Number(args[4]) })
        }
      };
    case 'visual-observe':
      requireArgs(args, 1);
      return { method: 'page.visualObserve', params: { origin: args[0] } };
    case 'visual-analyze':
      requireArgs(args, 1);
      return {
        method: 'page.visualAnalyze',
        params: {
          origin: args[0],
          ...(args[1] === undefined ? {} : { provider: args[1] })
        }
      };
    case 'upload-file':
      requireArgs(args, 4);
      {
        const maybeVerifyPreview = args.at(-1);
        const hasVerifyPreview = maybeVerifyPreview === 'true' || maybeVerifyPreview === 'false';
        const filesJson = args
          .slice(3, hasVerifyPreview ? -1 : undefined)
          .join(' ');
        const verifyPreview = hasVerifyPreview
          ? parseBooleanArg(maybeVerifyPreview)
          : undefined;
        return {
          method: 'page.uploadFile',
          params: {
            origin: args[0],
            target: { handle: args[1] },
            ruleset: args[2],
            files: parseJsonArg(filesJson, 'files-json'),
            ...(verifyPreview === undefined ? {} : { verifyPreview })
          }
        };
      }
    case 'cart-prepare':
      requireArgs(args, 4);
      {
        const criteria = parseJsonArg(args[2], 'criteria-json');
        if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) {
          throw new Error(`criteria-json must be a JSON object.\n\n${usage()}`);
        }
        return {
          method: 'page.prepareCart',
          params: {
            origin: new URL(args[0]).origin,
            query: args[1],
            criteria,
            cartActionAllowed: parseBooleanArg(args[3]),
            ...(args[4] === undefined ? {} : { profileId: args[4] })
          }
        };
      }
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
    case 'type':
      requireArgs(args, 3);
      return {
        method: 'page.type',
        params: {
          origin: args[0],
          handle: args[1],
          text: args.slice(2).join(' ')
        }
      };
    case 'clear':
      requireArgs(args, 2);
      return {
        method: 'page.clear',
        params: {
          origin: args[0],
          handle: args[1]
        }
      };
    case 'focus':
      requireArgs(args, 2);
      return {
        method: 'page.focus',
        params: {
          origin: args[0],
          handle: args[1]
        }
      };
    case 'select':
      requireArgs(args, 3);
      return {
        method: 'page.select',
        params: {
          origin: args[0],
          handle: args[1],
          value: args.slice(2).join(' ')
        }
      };
    case 'check':
      requireArgs(args, 2);
      return {
        method: 'page.check',
        params: {
          origin: args[0],
          handle: args[1],
          checked: parseBooleanArg(args[2], true)
        }
      };
    case 'scroll':
      requireArgs(args, 4);
      return {
        method: 'page.scroll',
        params: {
          origin: args[0],
          handle: args[1],
          deltaX: Number(args[2]),
          deltaY: Number(args[3])
        }
      };
    case 'press-key':
      requireArgs(args, 3);
      return {
        method: 'page.pressKey',
        params: {
          origin: args[0],
          handle: args[1],
          key: args.slice(2).join(' ')
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

function isPathInside(parentPath, candidatePath) {
  const parent = path.resolve(parentPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
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

function bundledChromeCandidates(installDir) {
  const browserRoot = path.join(installDir, 'browsers', 'chrome');
  if (!fs.existsSync(browserRoot)) {
    return [];
  }
  return fs.readdirSync(browserRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(browserRoot, entry.name, 'chrome-win64', 'chrome.exe'))
      .filter((candidate) => fs.existsSync(candidate))
      .sort()
      .reverse();
}

function systemChromeCandidates(env = process.env) {
  return [
    env.ProgramFiles && path.join(env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
  ].filter(Boolean).filter((candidate) => fs.existsSync(candidate));
}

function isConfiguredRealProfile(installDir, configuredProfile) {
  return Boolean(
    configuredProfile &&
    configuredProfile.userDataDir &&
    !isPathInside(installDir, configuredProfile.userDataDir)
  );
}

function browserSelection(chromePath, browserKind, profileLaunchMode, configuredProfile) {
  return {
    chromePath,
    browserKind,
    profileLaunchMode,
    ...(configuredProfile ? { configuredProfile } : {})
  };
}

function findChromeForBootstrap(installDir, env = process.env) {
  const configuredProfile = loadConfiguredProfile(installDir);
  const configuredRealProfile = isConfiguredRealProfile(installDir, configuredProfile);
  const profileLaunchMode = configuredRealProfile
    ? 'configured-real-profile'
    : configuredProfile && configuredProfile.userDataDir
    ? 'configured-isolated-profile'
    : 'isolated-operator-profile';
  const systemChrome = systemChromeCandidates(env)[0] || null;
  const bundledChrome = bundledChromeCandidates(installDir)[0] || null;

  if (configuredRealProfile && systemChrome) {
    return browserSelection(systemChrome, 'system-google-chrome', profileLaunchMode, configuredProfile);
  }
  if (configuredRealProfile && bundledChrome) {
    return browserSelection(bundledChrome, 'bundled-chrome-for-testing', profileLaunchMode, configuredProfile);
  }
  if (bundledChrome) {
    return browserSelection(bundledChrome, 'bundled-chrome-for-testing', profileLaunchMode, configuredProfile);
  }
  if (systemChrome) {
    return browserSelection(systemChrome, 'system-google-chrome', profileLaunchMode, configuredProfile);
  }
  return null;
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
  const chromeSelection = findChromeForBootstrap(installDir, env);
  if (!chromeSelection) {
    return {
      attempted: true,
      launched: false,
      error: {
        code: 'CHROME_NOT_FOUND',
        message: 'Chrome executable was not found for bootstrap launch.'
      }
    };
  }
  const {
    chromePath,
    browserKind,
    profileLaunchMode,
    configuredProfile
  } = chromeSelection;

  if (profileLaunchMode === 'configured-real-profile' && browserKind !== 'system-google-chrome') {
    return {
      attempted: true,
      launched: false,
      chromePath,
      browserKind,
      profileLaunchMode,
      error: {
        code: 'PROFILE_BROWSER_MISMATCH',
        message: 'Configured real Chrome profiles must be launched with installed Google Chrome, not bundled Chrome for Testing.'
      }
    };
  }

  const extensionDir = path.join(installDir, 'extension-unpacked');
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
    bootstrapUrl,
    chromePath,
    browserKind,
    profileLaunchMode
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
  if (!readiness.domainApproved) {
    missing.push('domainApproval');
  }
  if (readiness.siteBlocked) {
    missing.push('siteAllowed');
  }
  return {
    ...readiness,
    ready: missing.length === 0,
    missing
  };
}

function readinessNextActions(readiness, status = {}, bootstrapUrl = null) {
  const origin = readiness && readiness.origin;
  const missing = Array.isArray(readiness && readiness.missing)
    ? readiness.missing
    : [];
  const actions = [];

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

  if (missing.includes('siteAllowed')) {
    actions.push({
      kind: 'blockedSiteSettings',
      command: null,
      description: origin
        ? `Remove ${origin} from the extension blocked sites list before browser work.`
        : 'Remove the target origin from the extension blocked sites list before browser work.',
      requiresUserGesture: true
    });
  }

  return actions;
}

function checkResult(ok, details = {}) {
  return {
    ok: Boolean(ok),
    ...details
  };
}

function uniqueActions(actions) {
  const seen = new Set();
  return actions.filter((action) => {
    const key = `${action.kind}:${action.command || ''}:${action.url || ''}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function quoteCommandArg(value) {
  const text = String(value);
  return /[\s"]/u.test(text) ? JSON.stringify(text) : text;
}

function profileOnboardCommand(profile) {
  const args = [
    'node',
    'scripts/operator-cli.js',
    'profile-onboard',
    profile.userDataDir,
    profile.profileDirectory,
    profile.profileLabel
  ].filter((value) => value !== undefined && value !== null && value !== '');
  return args.map(quoteCommandArg).join(' ');
}

function profileOnboardAction(configuredProfile = null) {
  return {
    kind: 'profile',
    command: configuredProfile
      ? profileOnboardCommand(configuredProfile)
      : 'node scripts/operator-cli.js profile-onboard',
    description: configuredProfile
      ? 'Refresh the configured Chrome profile selection.'
      : 'Discover and save the Chrome profile that should launch operator bootstrap tabs.',
    requiresUserGesture: false
  };
}

async function profileOnboard({
  settings,
  request,
  sendRpcFn = sendRpc,
  profileDoctorFn = profileDoctor
}) {
  const params = request && request.params ? request.params : {};
  let selectedProfile = null;
  let discovery = null;
  const selection = {
    source: params.profileDirectory ? 'explicit' : 'discovered',
    autoSelected: false
  };

  if (params.profileDirectory) {
    if (!params.userDataDir) {
      return {
        id: request && request.id,
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'profile-onboard requires userDataDir when profileDirectory is provided.'
        }
      };
    }
    selectedProfile = {
      userDataDir: params.userDataDir,
      profileDirectory: params.profileDirectory,
      ...(params.profileLabel ? { profileLabel: params.profileLabel } : {})
    };
  } else {
    const discoveryResponse = await sendRpcFn({
      baseUrl: settings.baseUrl,
      token: settings.token,
      request: {
        id: `${request.id}_discover_profiles`,
        method: 'operator.profiles.discover',
        params: {
          ...(params.userDataDir ? { userDataDir: params.userDataDir } : {})
        }
      }
    });
    if (!discoveryResponse || !discoveryResponse.ok) {
      return discoveryResponse;
    }

    discovery = discoveryResponse.result || {};
    const profiles = Array.isArray(discovery.profiles) ? discovery.profiles : [];
    if (profiles.length === 0) {
      return {
        id: request.id,
        ok: false,
        error: {
          code: 'PROFILE_ONBOARD_NO_PROFILES',
          message: 'No Chrome profiles were discovered for onboarding.',
          userDataDir: params.userDataDir || null,
          nextActions: [
            {
              kind: 'profileDiscovery',
              command: params.userDataDir
                ? `node scripts/operator-cli.js profiles ${quoteCommandArg(params.userDataDir)}`
                : 'node scripts/operator-cli.js profiles',
              description: 'Confirm Chrome profile discovery before binding a profile.',
              requiresUserGesture: false
            }
          ]
        }
      };
    }

    if (profiles.length > 1) {
      return {
        id: request.id,
        ok: false,
        error: {
          code: 'PROFILE_SELECTION_REQUIRED',
          message: 'Multiple Chrome profiles were discovered; rerun profile-onboard with the intended profile directory.',
          profiles,
          nextActions: profiles.map((profile) => ({
            kind: 'profileSelection',
            command: profileOnboardCommand(profile),
            description: `Bind Chrome profile ${profile.profileLabel || profile.profileDirectory}.`,
            requiresUserGesture: false
          }))
        }
      };
    }

    selectedProfile = profiles[0];
    selection.source = 'single-discovered-profile';
    selection.autoSelected = true;
  }

  const bindParams = {
    userDataDir: selectedProfile.userDataDir,
    profileDirectory: selectedProfile.profileDirectory,
    profileLabel: params.profileLabel || selectedProfile.profileLabel || undefined
  };
  const bindResponse = await sendRpcFn({
    baseUrl: settings.baseUrl,
    token: settings.token,
    request: {
      id: `${request.id}_bind_profile`,
      method: 'operator.profile.bind',
      params: bindParams
    }
  });
  if (!bindResponse || !bindResponse.ok) {
    return bindResponse;
  }

  const doctorResponse = await profileDoctorFn({
    settings,
    request: {
      id: `${request.id}_doctor`,
      method: 'operator.status',
      params: {}
    },
    sendRpcFn
  });

  return {
    id: request.id,
    ok: Boolean(doctorResponse && doctorResponse.ok),
    result: {
      selection,
      selectedProfile,
      bind: bindResponse.result,
      setupUrl: null,
      bootstrapLaunch: {
        attempted: false,
        launched: false,
        skippedReason: 'PROFILE_SELECTION_ONLY'
      },
      profileWait: {
        attempted: false,
        verified: true,
        skippedReason: 'PROFILE_SELECTION_ONLY'
      },
      doctor: doctorResponse
    }
  };
}

async function profileDoctor({
  settings,
  request,
  sendRpcFn = sendRpc
}) {
  const origin = request && request.params && request.params.origin;
  let statusResponse;
  try {
    statusResponse = await sendRpcFn({
      baseUrl: settings.baseUrl,
      token: settings.token,
      request: {
        id: `${request.id}_status`,
        method: 'operator.status',
        params: {}
      }
    });
  } catch (error) {
    return {
      id: request && request.id,
      ok: false,
      error: {
        code: 'PROFILE_DOCTOR_DAEMON_UNREACHABLE',
        message: error.message,
        nextActions: [
          {
            kind: 'daemon',
            command: 'node scripts/operator-cli.js ensure-started --no-bootstrap',
            description: 'Start the local daemon before checking the live Chrome profile.',
            requiresUserGesture: false
          }
        ]
      }
    };
  }

  if (!statusResponse || !statusResponse.ok) {
    return statusResponse;
  }

  const status = statusResponse.result || {};
  let readiness = null;
  let readinessResponse = null;
  if (origin) {
    readinessResponse = await sendRpcFn({
      baseUrl: settings.baseUrl,
      token: settings.token,
      request: {
        id: `${request.id}_readiness`,
        method: 'operator.verifyReadiness',
        params: { origin }
      }
    });
    if (readinessResponse && readinessResponse.ok) {
      readiness = normalizeReadiness(readinessResponse.result);
    }
  }

  const configuredProfile = status.configuredProfile || null;
  const activeTab = status.activeTab || null;
  const activeTabOrigin = activeTab && activeTab.origin ? activeTab.origin : null;
  const activeTabReady = !origin || (
    activeTabOrigin === origin &&
    activeTab.loadingState !== 'loading'
  );
  const readinessOk = !origin || Boolean(readiness && readiness.ready);
  const checks = {
    daemon: checkResult(true, {
      connectionState: status.connectionState || null
    }),
    configuredProfile: checkResult(true, {
      profile: configuredProfile
    }),
    extensionConnected: checkResult(status.connectionState === 'EXTENSION_CONNECTED', {
      profileBindingStatus: status.profileBindingStatus || null,
      lastError: status.lastError || null
    }),
    activeTabOrigin: origin
      ? checkResult(activeTabReady, {
        expected: origin,
        actual: activeTabOrigin,
        activeTab
      })
      : checkResult(true, { skipped: true, activeTab }),
    readiness: origin
      ? checkResult(readinessOk, {
        details: readiness,
        error: readinessResponse && !readinessResponse.ok ? readinessResponse.error : null
      })
      : checkResult(true, { skipped: true })
  };

  const nextActions = [];
  if (readiness && !readiness.ready) {
    nextActions.push(...readinessNextActions(readiness, status));
  }
  if (origin && !activeTabReady) {
    nextActions.push({
      kind: 'activeTab',
      command: `node scripts/operator-cli.js navigate ${origin}`,
      description: `Make the active tab match ${origin} before observing or acting.`,
      requiresUserGesture: false
    });
  }

  const failedChecks = Object.entries(checks)
    .filter(([, check]) => !check.ok)
    .map(([name]) => name);

  return {
    id: request.id,
    ok: failedChecks.length === 0,
    result: {
      origin: origin || null,
      checks,
      failedChecks,
      nextActions: uniqueActions(nextActions),
      status: {
        connectionState: status.connectionState || null,
        profileVerified: status.profileVerified === true,
        profileBindingStatus: status.profileBindingStatus || null,
        configuredProfile,
        activeTab,
        version: status.version || null,
        lastError: status.lastError || null
      }
    }
  };
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
      permissionUrl: null,
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

async function waitReady({
  settings,
  request,
  sendRpcFn = sendRpc,
  timeoutMs = request && request.params && Number.isFinite(request.params.timeoutMs)
    ? request.params.timeoutMs
    : 10000,
  pollIntervalMs = request && request.params && Number.isFinite(request.params.pollIntervalMs)
    ? request.params.pollIntervalMs
    : 250,
  delayFn = delay
}) {
  const origin = request && request.params && request.params.origin;
  if (!origin) {
    return {
      id: request && request.id,
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        message: 'wait-ready requires an origin or URL.'
      }
    };
  }

  const started = Date.now();
  let attempts = 0;
  let lastResponse = null;
  let lastError = null;

  while (Date.now() - started < timeoutMs) {
    attempts += 1;
    try {
      const response = await sendRpcFn({
        baseUrl: settings.baseUrl,
        token: settings.token,
        request: {
          id: `${request.id}_wait_ready_${attempts}`,
          method: 'operator.verifyReadiness',
          params: { origin }
        }
      });
      lastResponse = response;
      if (response && response.ok && response.result && response.result.ready) {
        return {
          ...response,
          result: {
            ...response.result,
            readiness: normalizeReadiness(response.result),
            waitReady: {
              attempted: true,
              ready: true,
              elapsedMs: Date.now() - started,
              attempts
            }
          }
        };
      }
    } catch (error) {
      lastError = error;
    }
    await delayFn(pollIntervalMs);
  }

  const lastReadiness = lastResponse && lastResponse.ok
    ? normalizeReadiness(lastResponse.result)
    : null;
  const nextActions = lastReadiness
    ? readinessNextActions(lastReadiness)
    : [];
  return {
    id: request.id,
    ok: false,
    error: {
      code: 'READINESS_WAIT_TIMEOUT',
      message: `Timed out waiting for ${origin} readiness.`,
      origin,
      timeoutMs,
      attempts,
      lastReadiness,
      nextActions,
      lastError: lastError ? lastError.message : null
    }
  };
}

function comparableUrl(value) {
  try {
    return new URL(value).href;
  } catch {
    return null;
  }
}

function activeTabMatchesUrl(activeTab, url, origin) {
  if (!activeTab || comparableUrl(activeTab.url) !== comparableUrl(url)) {
    return false;
  }
  const activeOrigin = activeTab.origin || (() => {
    try {
      return new URL(activeTab.url).origin;
    } catch {
      return null;
    }
  })();
  return activeOrigin === origin && activeTab.loadingState !== 'loading';
}

async function waitForActiveTabUrl({
  settings,
  requestId,
  url,
  origin,
  sendRpcFn = sendRpc,
  timeoutMs = 10000,
  pollIntervalMs = 250,
  delayFn = delay
}) {
  const started = Date.now();
  let attempts = 0;
  let lastActiveTab = null;
  let lastError = null;

  while (Date.now() - started < timeoutMs) {
    attempts += 1;
    try {
      const response = await sendRpcFn({
        baseUrl: settings.baseUrl,
        token: settings.token,
        request: {
          id: `${requestId}_status_${attempts}`,
          method: 'operator.status',
          params: {}
        }
      });
      lastActiveTab = response && response.result && response.result.activeTab
        ? response.result.activeTab
        : null;
      if (response && response.ok && activeTabMatchesUrl(lastActiveTab, url, origin)) {
        return {
          ok: true,
          result: {
            activeTab: lastActiveTab,
            attempted: true,
            elapsedMs: Date.now() - started,
            attempts
          }
        };
      }
    } catch (error) {
      lastError = error;
    }
    await delayFn(pollIntervalMs);
  }

  return {
    ok: false,
    error: {
      code: 'NAVIGATION_WAIT_TIMEOUT',
      message: `Timed out waiting for active tab to reach ${url}.`,
      origin,
      url,
      timeoutMs,
      attempts,
      lastActiveTab,
      lastError: lastError ? lastError.message : null
    }
  };
}

async function openObserve({
  settings,
  request,
  sendRpcFn = sendRpc,
  prepareOriginFn = prepareOrigin,
  waitReadyFn = waitReady,
  waitForActiveTabUrlFn = waitForActiveTabUrl,
  openBootstrap = true
}) {
  const url = request && request.params && request.params.url;
  const origin = request && request.params && request.params.origin;
  if (!url || !origin) {
    return {
      id: request && request.id,
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        message: 'open-observe requires an absolute URL.'
      }
    };
  }

  const prepareRequest = {
    id: `${request.id}_prepare_origin`,
    method: 'operator.ensureStarted',
    params: { origin }
  };
  const prepared = await prepareOriginFn({
    settings,
    request: prepareRequest,
    sendRpcFn,
    openBootstrap
  });
  if (!prepared || !prepared.ok) {
    return prepared;
  }

  if (prepared.result && prepared.result.requiresUserGesture) {
    return {
      id: request.id,
      ok: false,
      error: {
        code: 'READINESS_INCOMPLETE',
        message: `User permission is required before opening ${origin}.`,
        origin,
        blockedAt: 'prepare-origin',
        permissionUrl: prepared.result.permissionUrl,
        diagnostic: prepared.result.diagnostic,
        nextActions: prepared.result.nextActions
      }
    };
  }

  const waitResponse = await waitReadyFn({
    settings,
    request: {
      id: `${request.id}_wait_ready`,
      method: 'operator.verifyReadiness',
      params: {
        origin,
        timeoutMs: request.params.timeoutMs,
        pollIntervalMs: request.params.pollIntervalMs
      }
    },
    sendRpcFn
  });
  if (!waitResponse || !waitResponse.ok) {
    return {
      id: request.id,
      ok: false,
      error: {
        ...(waitResponse && waitResponse.error ? waitResponse.error : {
          code: 'READINESS_WAIT_FAILED',
          message: `Failed waiting for ${origin} readiness.`
        }),
        blockedAt: 'wait-ready'
      }
    };
  }

  const navigation = await sendRpcFn({
    baseUrl: settings.baseUrl,
    token: settings.token,
    request: {
      id: `${request.id}_navigate`,
      method: 'page.navigate',
      params: {
        url,
        origin,
        timeoutMs: request.params.timeoutMs,
        pollIntervalMs: request.params.pollIntervalMs
      }
    }
  });
  if (!navigation || !navigation.ok) {
    return navigation;
  }

  const navigationSettled = await waitForActiveTabUrlFn({
    settings,
    requestId: request.id,
    url,
    origin,
    sendRpcFn,
    timeoutMs: Number.isFinite(request.params.timeoutMs) ? request.params.timeoutMs : 10000,
    pollIntervalMs: Number.isFinite(request.params.pollIntervalMs) ? request.params.pollIntervalMs : 250
  });
  if (!navigationSettled || !navigationSettled.ok) {
    return {
      id: request.id,
      ok: false,
      error: {
        ...(navigationSettled && navigationSettled.error ? navigationSettled.error : {
          code: 'NAVIGATION_WAIT_FAILED',
          message: `Failed waiting for active tab to reach ${url}.`
        }),
        blockedAt: 'navigation-settle'
      }
    };
  }

  const observation = await sendRpcFn({
    baseUrl: settings.baseUrl,
    token: settings.token,
    request: {
      id: `${request.id}_observe`,
      method: 'page.observe',
      params: {
        origin,
        ...(request.params.mode === undefined ? {} : { mode: request.params.mode }),
        ...(request.params.maxActionableHandles === undefined ? {} : {
          maxActionableHandles: request.params.maxActionableHandles
        }),
        ...(request.params.summaryMaxChars === undefined ? {} : {
          summaryMaxChars: request.params.summaryMaxChars
        }),
        ...(request.params.sincePageStateId === undefined ? {} : {
          sincePageStateId: request.params.sincePageStateId
        })
      }
    }
  });
  if (!observation || !observation.ok) {
    return observation;
  }

  return {
    id: request.id,
    ok: true,
    result: {
      origin,
      url,
      prepared: prepared.result,
      readiness: waitResponse.result,
      navigation: navigation.result,
      navigationSettled: navigationSettled.result,
      observation: observation.result
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
    : cliAction === 'profileDoctor'
    ? await profileDoctor({
      settings,
      request
    })
    : cliAction === 'profileOnboard'
    ? await profileOnboard({
      settings,
      request,
      openBootstrap: options.openBootstrap !== false
    })
    : cliAction === 'openObserve'
    ? await openObserve({
      settings,
      request,
      openBootstrap: options.openBootstrap !== false
    })
    : cliAction === 'waitReady'
    ? await waitReady({
      settings,
      request
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
  openObserve,
  prepareOrigin,
  profileDoctor,
  profileOnboard,
  resolveCliSettings,
  run,
  startDaemonProcess,
  splitOptions,
  usage,
  waitForActiveTabUrl,
  waitForExtensionConnection,
  waitReady
};
