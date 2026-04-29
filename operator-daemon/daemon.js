'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionManager } = require('./sessionManager');
const { startControlServer } = require('./controlServer');

const MIN_NODE_MAJOR = 24;

function defaultConfigPath() {
  return path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'CodexChromeOperator',
    'config.json'
  );
}

function defaultTokenPath() {
  return path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'CodexChromeOperator',
    'token.txt'
  );
}

function loadConfig(configPath = defaultConfigPath()) {
  if (!fs.existsSync(configPath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function loadInstalledToken(tokenPath = defaultTokenPath()) {
  if (!fs.existsSync(tokenPath)) {
    return null;
  }
  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  return token || null;
}

function parseNodeMajor(nodeVersion) {
  const match = /^v?(\d+)\./.exec(nodeVersion || '');
  return match ? Number.parseInt(match[1], 10) : 0;
}

function buildDoctorReport({
  configPath = defaultConfigPath(),
  nodeVersion = process.version,
  nodePath = process.execPath
} = {}) {
  const nodeMajor = parseNodeMajor(nodeVersion);
  const nodeOk = nodeMajor >= MIN_NODE_MAJOR;
  return {
    ok: nodeOk,
    configPath,
    configExists: fs.existsSync(configPath),
    nodeVersion,
    node: {
      ok: nodeOk,
      path: nodePath,
      version: nodeVersion,
      minimumMajor: MIN_NODE_MAJOR
    }
  };
}

function printHelp() {
  process.stdout.write(`Codex Chrome Operator daemon

Usage:
  node operator-daemon/daemon.js --daemon [--port 17391]
  node operator-daemon/daemon.js --doctor
  node operator-daemon/daemon.js --help
`);
}

function parseArgValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) {
    return fallback;
  }
  return process.argv[index + 1];
}

async function main() {
  if (process.argv.includes('--help')) {
    printHelp();
    return;
  }

  if (process.argv.includes('--doctor')) {
    const report = buildDoctorReport();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  const config = loadConfig();
  const token = process.env.CODEX_CHROME_OPERATOR_TOKEN || config.token || loadInstalledToken() || 'dev-token';
  const port = Number(parseArgValue('--port', config.port || 17391));
  const session = new SessionManager({
    ...config,
    token
  });
  const server = await startControlServer({ session, token, port });
  process.stdout.write(`Codex Chrome Operator daemon listening on http://127.0.0.1:${server.port}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildDoctorReport,
  defaultConfigPath,
  defaultTokenPath,
  loadConfig,
  loadInstalledToken
};
