const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildRpcRequest,
  resolveCliSettings
} = require('../scripts/operator-cli');

test('buildRpcRequest maps status to operator.status', () => {
  assert.deepEqual(buildRpcRequest(['status']), {
    method: 'operator.status',
    params: {}
  });
});

test('buildRpcRequest maps approval and page commands', () => {
  assert.deepEqual(buildRpcRequest(['approve', 'https://example.com']), {
    method: 'operator.approveDomain',
    params: { origin: 'https://example.com' }
  });
  assert.deepEqual(buildRpcRequest(['observe', 'https://example.com']), {
    method: 'page.observe',
    params: { origin: 'https://example.com' }
  });
  assert.deepEqual(buildRpcRequest(['fill', 'https://example.com', 'el_0', 'hello world']), {
    method: 'page.fill',
    params: {
      origin: 'https://example.com',
      handle: 'el_0',
      text: 'hello world'
    }
  });
  assert.deepEqual(buildRpcRequest(['click', 'https://example.com', 'el_2']), {
    method: 'page.click',
    params: {
      origin: 'https://example.com',
      handle: 'el_2'
    }
  });
  assert.deepEqual(buildRpcRequest(['navigate', 'https://example.com/path']), {
    method: 'page.navigate',
    params: {
      url: 'https://example.com/path',
      origin: 'https://example.com'
    }
  });
});

test('buildRpcRequest rejects incomplete commands with usage error', () => {
  assert.throws(() => buildRpcRequest([]), /Usage:/);
  assert.throws(() => buildRpcRequest(['fill', 'https://example.com', 'el_0']), /Usage:/);
  assert.throws(() => buildRpcRequest(['wat']), /Usage:/);
});

test('resolveCliSettings reads install config and token defaults', () => {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-operator-cli-'));
  fs.writeFileSync(path.join(installDir, 'config.json'), JSON.stringify({ port: 19001 }), 'utf8');
  fs.writeFileSync(path.join(installDir, 'token.txt'), 'cli-token\n', 'utf8');

  const settings = resolveCliSettings({
    installDir,
    env: {}
  });

  assert.equal(settings.baseUrl, 'http://127.0.0.1:19001');
  assert.equal(settings.token, 'cli-token');
});

test('resolveCliSettings lets explicit flags override install defaults', () => {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-operator-cli-'));
  fs.writeFileSync(path.join(installDir, 'config.json'), JSON.stringify({ port: 19001 }), 'utf8');
  fs.writeFileSync(path.join(installDir, 'token.txt'), 'cli-token\n', 'utf8');

  const settings = resolveCliSettings({
    installDir,
    env: {},
    baseUrl: 'http://127.0.0.1:19999',
    token: 'override-token'
  });

  assert.equal(settings.baseUrl, 'http://127.0.0.1:19999');
  assert.equal(settings.token, 'override-token');
});
