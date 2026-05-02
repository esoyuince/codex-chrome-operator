const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureExtensionKey, extensionIdFromPublicKeyDer } = require('../scripts/ensure-extension-key');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ensure-extension-key.js');

test('extensionIdFromPublicKeyDer returns Chrome id alphabet', () => {
  const extensionId = extensionIdFromPublicKeyDer(Buffer.from('codex-test-public-key'));

  assert.match(extensionId, /^[a-p]{32}$/);
});

test('checked-in extension manifest uses broad required host access instead of optional per-site grants', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));

  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  assert.equal(manifest.optional_host_permissions, undefined);
});

test('ensureExtensionKey writes a manifest key once and keeps id stable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-operator-extension-'));
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    manifest_version: 3,
    name: 'Test Extension',
    version: '0.2.8'
  }), 'utf8');

  const first = ensureExtensionKey({ manifestPath });
  const second = ensureExtensionKey({ manifestPath });
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  assert.equal(first.wroteKey, true);
  assert.equal(second.wroteKey, false);
  assert.equal(first.extensionId, second.extensionId);
  assert.equal(typeof manifest.key, 'string');
  assert.match(first.extensionId, /^[a-p]{32}$/);
});

test('ensure-extension-key CLI can derive JSON without mutating the manifest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-operator-extension-cli-'));
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    manifest_version: 3,
    name: 'Test Extension',
    version: '0.2.8'
  }), 'utf8');
  const seeded = ensureExtensionKey({ manifestPath });
  const seededKey = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).key;

  const result = childProcess.spawnSync(process.execPath, [
    SCRIPT,
    '--manifest',
    manifestPath,
    '--no-write',
    '--json'
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.extensionId, seeded.extensionId);
  assert.equal(report.wroteKey, false);
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).key, seededKey);
});

test('ensure-extension-key CLI --no-write fails instead of creating a missing key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-operator-extension-cli-'));
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    manifest_version: 3,
    name: 'Test Extension',
    version: '0.2.8'
  }), 'utf8');

  const result = childProcess.spawnSync(process.execPath, [
    SCRIPT,
    '--manifest',
    manifestPath,
    '--no-write'
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Manifest key is missing/);
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).key, undefined);
});
