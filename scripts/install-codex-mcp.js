'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CODEX_MCP_SERVER_NAME = 'codex-chrome-operator';

function tomlString(value) {
  return JSON.stringify(String(value));
}

function defaultCodexConfigPath() {
  return path.join(os.homedir(), '.codex', 'config.toml');
}

function timestampForBackup(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '');
}

function buildCodexMcpServerToml({
  nodePath = process.execPath,
  serverScript = path.join(ROOT, 'codex-adapter', 'mcpServer.js'),
  cwd = ROOT,
  startupTimeoutSec = 20,
  toolTimeoutSec = 180,
  defaultToolsApprovalMode = 'approve'
} = {}) {
  return [
    `[mcp_servers.${CODEX_MCP_SERVER_NAME}]`,
    'enabled = true',
    `command = ${tomlString(nodePath)}`,
    `args = [${tomlString(serverScript)}]`,
    `cwd = ${tomlString(cwd)}`,
    `startup_timeout_sec = ${Number(startupTimeoutSec)}`,
    `tool_timeout_sec = ${Number(toolTimeoutSec)}`,
    `default_tools_approval_mode = ${tomlString(defaultToolsApprovalMode)}`
  ].join('\n');
}

function isAnyTomlHeader(line) {
  return /^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(line);
}

function isCodexMcpServerHeader(line) {
  return new RegExp(`^\\s*\\[mcp_servers\\.${CODEX_MCP_SERVER_NAME}\\]\\s*(?:#.*)?$`).test(line);
}

function removeCodexMcpServerBlock(toml) {
  const lines = String(toml || '').replace(/\r\n/g, '\n').split('\n');
  const kept = [];
  let skipping = false;

  for (const line of lines) {
    if (isCodexMcpServerHeader(line)) {
      skipping = true;
      continue;
    }

    if (skipping && isAnyTomlHeader(line)) {
      skipping = false;
    }

    if (!skipping) {
      kept.push(line);
    }
  }

  while (kept.length > 0 && kept[kept.length - 1].trim() === '') {
    kept.pop();
  }

  return kept.join('\n');
}

function upsertCodexMcpServerBlock(toml, options = {}) {
  const block = buildCodexMcpServerToml(options);
  const blockLines = block.split('\n');
  const lines = String(toml || '').replace(/\r\n/g, '\n').split('\n');
  const kept = [];
  let skipping = false;
  let found = false;

  for (const line of lines) {
    if (isCodexMcpServerHeader(line)) {
      if (!found) {
        kept.push(...blockLines);
        found = true;
      }
      skipping = true;
      continue;
    }

    if (skipping && isAnyTomlHeader(line)) {
      skipping = false;
      if (kept.length > 0 && kept[kept.length - 1].trim() !== '') {
        kept.push('');
      }
    }

    if (!skipping) {
      kept.push(line);
    }
  }

  while (kept.length > 0 && kept[kept.length - 1].trim() === '') {
    kept.pop();
  }

  if (!found) {
    const existing = kept.join('\n');
    return existing ? `${existing}\n\n${block}\n` : `${block}\n`;
  }

  return `${kept.join('\n')}\n`;
}

function installCodexMcpConfig({
  configPath = defaultCodexConfigPath(),
  nodePath = process.execPath,
  serverScript = path.join(ROOT, 'codex-adapter', 'mcpServer.js'),
  cwd = ROOT,
  now = new Date(),
  dryRun = false
} = {}) {
  const hadConfig = fs.existsSync(configPath);
  const existing = hadConfig ? fs.readFileSync(configPath, 'utf8') : '';
  const next = upsertCodexMcpServerBlock(existing, { nodePath, serverScript, cwd });
  const changed = next !== existing;
  let backupPath = null;

  if (changed && !dryRun) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });

    if (hadConfig) {
      backupPath = `${configPath}.bak-codex-chrome-operator-${timestampForBackup(now)}`;
      fs.writeFileSync(backupPath, existing, 'utf8');
    }

    fs.writeFileSync(configPath, next, 'utf8');
  }

  return {
    ok: true,
    changed,
    dryRun,
    serverName: CODEX_MCP_SERVER_NAME,
    configPath,
    backupPath,
    nodePath,
    serverScript,
    cwd
  };
}

function takeOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return null;
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value.`);
  }
  args.splice(index, 2);
  return value;
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    dryRun: false
  };

  options.configPath = takeOption(args, '--config') || defaultCodexConfigPath();
  options.nodePath = takeOption(args, '--node') || process.execPath;
  options.serverScript = takeOption(args, '--server') || path.join(ROOT, 'codex-adapter', 'mcpServer.js');
  options.cwd = takeOption(args, '--cwd') || ROOT;

  const dryRunIndex = args.indexOf('--dry-run');
  if (dryRunIndex !== -1) {
    options.dryRun = true;
    args.splice(dryRunIndex, 1);
  }

  if (args.length > 0) {
    throw new Error(`Unknown arguments: ${args.join(' ')}`);
  }

  return options;
}

async function main() {
  try {
    const result = installCodexMcpConfig(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  CODEX_MCP_SERVER_NAME,
  buildCodexMcpServerToml,
  defaultCodexConfigPath,
  installCodexMcpConfig,
  parseArgs,
  removeCodexMcpServerBlock,
  timestampForBackup,
  upsertCodexMcpServerBlock
};
