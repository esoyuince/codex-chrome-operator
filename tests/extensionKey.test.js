const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureExtensionKey, extensionIdFromPublicKeyDer } = require('../scripts/ensure-extension-key');

test('extensionIdFromPublicKeyDer returns Chrome id alphabet', () => {
  const extensionId = extensionIdFromPublicKeyDer(Buffer.from('codex-test-public-key'));

  assert.match(extensionId, /^[a-p]{32}$/);
});

test('ensureExtensionKey writes a manifest key once and keeps id stable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-operator-extension-'));
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    manifest_version: 3,
    name: 'Test Extension',
    version: '0.1.0'
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
