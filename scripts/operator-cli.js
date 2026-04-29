'use strict';

const os = require('node:os');
const path = require('node:path');
const { sendRpc } = require('../native-bridge/daemonClient');
const { loadConfig, loadInstalledToken } = require('../operator-daemon/daemon');

function defaultInstallDir(env = process.env) {
  return path.join(
    env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'CodexChromeOperator'
  );
}

function usage() {
  return `Usage:
  node scripts/operator-cli.js status
  node scripts/operator-cli.js approve <origin>
  node scripts/operator-cli.js observe <origin>
  node scripts/operator-cli.js navigate <url>
  node scripts/operator-cli.js fill <origin> <handle> <text>
  node scripts/operator-cli.js click <origin> <handle>

Options:
  --base-url <url>   Override daemon base URL
  --token <token>    Override daemon bearer token
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

function buildRpcRequest(argv) {
  const { positional } = splitOptions(argv);
  const [command, ...args] = positional;

  switch (command) {
    case 'status':
      return { method: 'operator.status', params: {} };
    case 'approve':
      requireArgs(args, 1);
      return { method: 'operator.approveDomain', params: { origin: args[0] } };
    case 'observe':
      requireArgs(args, 1);
      return { method: 'page.observe', params: { origin: args[0] } };
    case 'navigate':
      requireArgs(args, 1);
      return {
        method: 'page.navigate',
        params: {
          url: args[0],
          origin: new URL(args[0]).origin
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
    token: resolvedToken
  };
}

async function run(argv = process.argv.slice(2), output = process.stdout) {
  const { options } = splitOptions(argv);
  const request = {
    id: `cli_${Date.now()}`,
    ...buildRpcRequest(argv)
  };
  const settings = resolveCliSettings(options);
  const response = await sendRpc({
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
  resolveCliSettings,
  run,
  splitOptions,
  usage
};
