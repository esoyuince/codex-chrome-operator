const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, loadInstalledToken } = require('../operator-daemon/daemon');

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
