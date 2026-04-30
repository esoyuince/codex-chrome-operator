const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CODEX_MCP_SERVER_NAME,
  buildCodexMcpServerToml,
  installCodexMcpConfig,
  upsertCodexMcpServerBlock
} = require('../scripts/install-codex-mcp');

test('buildCodexMcpServerToml emits strict Codex app server config', () => {
  const toml = buildCodexMcpServerToml({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    serverScript: 'C:\\Users\\example\\Documents\\New project\\codex-adapter\\mcpServer.js',
    cwd: 'C:\\Users\\example\\Documents\\New project'
  });

  assert.equal(toml, [
    `[mcp_servers.${CODEX_MCP_SERVER_NAME}]`,
    'enabled = true',
    'command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"',
    'args = ["C:\\\\Users\\\\example\\\\Documents\\\\New project\\\\codex-adapter\\\\mcpServer.js"]',
    'cwd = "C:\\\\Users\\\\example\\\\Documents\\\\New project"',
    'startup_timeout_sec = 20',
    'tool_timeout_sec = 180',
    'default_tools_approval_mode = "approve"'
  ].join('\n'));
});

test('upsertCodexMcpServerBlock adds the server block while preserving other config', () => {
  const input = [
    '[profile.default]',
    'model = "gpt-5"',
    ''
  ].join('\n');

  const output = upsertCodexMcpServerBlock(input, {
    nodePath: 'node.exe',
    serverScript: 'C:\\repo\\codex-adapter\\mcpServer.js',
    cwd: 'C:\\repo'
  });

  assert.match(output, /\[profile\.default\]\nmodel = "gpt-5"/);
  assert.match(output, /\[mcp_servers\.codex-chrome-operator\]/);
  assert.match(output, /args = \["C:\\\\repo\\\\codex-adapter\\\\mcpServer\.js"\]/);
});

test('upsertCodexMcpServerBlock replaces an existing server block idempotently', () => {
  const input = [
    '[mcp_servers.codex-chrome-operator]',
    'enabled = false',
    'command = "old-node"',
    '',
    '[mcp_servers.other]',
    'enabled = true'
  ].join('\n');

  const output = upsertCodexMcpServerBlock(input, {
    nodePath: 'node.exe',
    serverScript: 'C:\\repo\\codex-adapter\\mcpServer.js',
    cwd: 'C:\\repo'
  });
  const second = upsertCodexMcpServerBlock(output, {
    nodePath: 'node.exe',
    serverScript: 'C:\\repo\\codex-adapter\\mcpServer.js',
    cwd: 'C:\\repo'
  });

  assert.equal(second, output);
  assert.equal((output.match(/\[mcp_servers\.codex-chrome-operator\]/g) || []).length, 1);
  assert.ok(output.indexOf('[mcp_servers.codex-chrome-operator]') < output.indexOf('[mcp_servers.other]'));
  assert.doesNotMatch(output, /old-node/);
  assert.match(output, /\[mcp_servers\.other\]\nenabled = true/);
});

test('upsertCodexMcpServerBlock keeps an already current block in place', () => {
  const options = {
    nodePath: 'node.exe',
    serverScript: 'C:\\repo\\codex-adapter\\mcpServer.js',
    cwd: 'C:\\repo'
  };
  const currentBlock = buildCodexMcpServerToml(options);
  const input = [
    '[profile.default]',
    'model = "gpt-5"',
    '',
    currentBlock,
    '',
    '[projects.example]',
    'trust_level = "trusted"',
    ''
  ].join('\n');

  assert.equal(upsertCodexMcpServerBlock(input, options), input);
});

test('installCodexMcpConfig writes the config and creates a backup when replacing content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mcp-config-'));
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, '[profile.default]\nmodel = "gpt-5"\n', 'utf8');

  const result = installCodexMcpConfig({
    configPath,
    nodePath: 'node.exe',
    serverScript: 'C:\\repo\\codex-adapter\\mcpServer.js',
    cwd: 'C:\\repo',
    now: new Date('2026-04-30T12:14:40Z')
  });

  assert.equal(result.changed, true);
  assert.equal(result.configPath, configPath);
  assert.ok(result.backupPath.endsWith('config.toml.bak-codex-chrome-operator-20260430121440'));
  assert.match(fs.readFileSync(configPath, 'utf8'), /\[mcp_servers\.codex-chrome-operator\]/);
  assert.equal(fs.readFileSync(result.backupPath, 'utf8'), '[profile.default]\nmodel = "gpt-5"\n');

  const unchanged = installCodexMcpConfig({
    configPath,
    nodePath: 'node.exe',
    serverScript: 'C:\\repo\\codex-adapter\\mcpServer.js',
    cwd: 'C:\\repo',
    now: new Date('2026-04-30T12:15:40Z')
  });

  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.backupPath, null);
});

test('package and runbook expose the Codex app MCP installer', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const runbook = fs.readFileSync(path.join(__dirname, '..', 'docs', 'windows-install-runbook.md'), 'utf8');

  assert.equal(packageJson.scripts['codex:mcp:install'], 'node scripts/install-codex-mcp.js');
  assert.match(runbook, /npm run codex:mcp:install/);
  assert.match(runbook, /Restart Codex/);
  assert.match(runbook, /smoke:mcp/);
});
