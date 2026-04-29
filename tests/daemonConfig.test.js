const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildDoctorReport, loadConfig, loadInstalledToken } = require('../operator-daemon/daemon');

test('loadConfig reads installer-written daemon config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-operator-config-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    port: 17391,
    expectedExtensionId: 'abcdefghijklmnopabcdefghijklmnop'
  }), 'utf8');

  const config = loadConfig(configPath);

  assert.equal(config.port, 17391);
  assert.equal(config.expectedExtensionId, 'abcdefghijklmnopabcdefghijklmnop');
});

test('loadInstalledToken trims installer token file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-operator-token-'));
  const tokenPath = path.join(dir, 'token.txt');
  fs.writeFileSync(tokenPath, 'installed-token\r\n', 'utf8');

  assert.equal(loadInstalledToken(tokenPath), 'installed-token');
});

test('loadInstalledToken returns null when token file is absent or blank', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-operator-token-'));
  const tokenPath = path.join(dir, 'token.txt');

  assert.equal(loadInstalledToken(tokenPath), null);

  fs.writeFileSync(tokenPath, '  \n', 'utf8');
  assert.equal(loadInstalledToken(tokenPath), null);
});

test('buildDoctorReport enforces the Node 24 runtime contract', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-operator-doctor-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, '{}', 'utf8');

  const report = buildDoctorReport({
    configPath,
    nodeVersion: 'v24.14.0',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe'
  });

  assert.equal(report.ok, true);
  assert.equal(report.configExists, true);
  assert.equal(report.node.minimumMajor, 24);
  assert.equal(report.node.ok, true);

  const oldRuntime = buildDoctorReport({
    configPath,
    nodeVersion: 'v20.0.0',
    nodePath: 'C:\\node\\node.exe'
  });
  assert.equal(oldRuntime.ok, false);
  assert.equal(oldRuntime.node.ok, false);
});
