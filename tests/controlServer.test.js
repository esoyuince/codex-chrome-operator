const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SessionManager } = require('../operator-daemon/sessionManager');
const { startControlServer } = require('../operator-daemon/controlServer');
const { ERROR_CODES } = require('../operator-daemon/protocol');

function makeSession() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-operator-session-'));
  return new SessionManager({
    token: 'test-token',
    auditLogPath: path.join(dir, 'audit.jsonl'),
    statePath: path.join(dir, 'state.json'),
    expectedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
    expectedProfileBindingId: 'profbind_8Qw3z6NqfK2p9xV1',
    expectedProfileBindingVersion: 3
  });
}

async function withServer(session, fn) {
  const server = await startControlServer({ session, token: 'test-token', port: 0 });
  try {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    await fn(baseUrl, session);
  } finally {
    await server.close();
  }
}

async function postJson(baseUrl, method, params = {}, token = 'test-token') {
  const response = await fetch(`${baseUrl}/v1/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-codex-chrome-operator': '1'
    },
    body: JSON.stringify({ id: 'req_1', method, params })
  });
  return { status: response.status, body: await response.json() };
}

test('control server rejects GET and wrong bearer token', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    const getResponse = await fetch(`${baseUrl}/v1/rpc`);
    assert.equal(getResponse.status, 405);

    const wrongToken = await postJson(baseUrl, 'operator.status', {}, 'wrong-token');
    assert.equal(wrongToken.status, 401);
    assert.equal(wrongToken.body.error.code, ERROR_CODES.AUTH_INVALID);
  });
});

test('operator.status returns disconnected state before HELLO', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    const result = await postJson(baseUrl, 'operator.status');

    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.result.connectionState, 'DAEMON_RUNNING_EXTENSION_DISCONNECTED');
  });
});

test('extension.hello verifies profile binding and updates status', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    const result = await postJson(baseUrl, 'extension.hello', {
      hello: {
        type: 'HELLO',
        protocolVersion: '1.0',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        extensionVersion: '0.1.0',
        bridgeVersion: '0.1.0',
        sessionBootstrapId: 'boot_abc',
        profileBindingState: 'bound',
        profileBindingId: 'profbind_8Qw3z6NqfK2p9xV1',
        profileBindingVersion: 3,
        profileBindingSource: 'chrome.storage.local',
        capabilities: ['observe.v1']
      }
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.result.profileBindingStatus, 'verified');

    const status = await postJson(baseUrl, 'operator.status');
    assert.equal(status.body.result.connectionState, 'EXTENSION_CONNECTED');
    assert.equal(status.body.result.profileVerified, true);
  });
});

test('page.observe fails closed before host permission is granted', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await postJson(baseUrl, 'extension.hello', {
      hello: {
        type: 'HELLO',
        protocolVersion: '1.0',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        extensionVersion: '0.1.0',
        bridgeVersion: '0.1.0',
        sessionBootstrapId: 'boot_abc',
        profileBindingState: 'bound',
        profileBindingId: 'profbind_8Qw3z6NqfK2p9xV1',
        profileBindingVersion: 3,
        profileBindingSource: 'chrome.storage.local',
        capabilities: ['observe.v1']
      }
    });
    await postJson(baseUrl, 'operator.approveDomain', {
      origin: 'https://example.com'
    });

    const result = await postJson(baseUrl, 'page.observe', {
      origin: 'https://example.com'
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, ERROR_CODES.HOST_PERMISSION_REQUIRED);
  });
});

test('page.observe queues extension command and resolves from bridge delivery', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await postJson(baseUrl, 'extension.hello', {
      hello: {
        type: 'HELLO',
        protocolVersion: '1.0',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        extensionVersion: '0.1.0',
        bridgeVersion: '0.1.0',
        sessionBootstrapId: 'boot_abc',
        profileBindingState: 'bound',
        profileBindingId: 'profbind_8Qw3z6NqfK2p9xV1',
        profileBindingVersion: 3,
        profileBindingSource: 'chrome.storage.local',
        capabilities: ['observe.v1']
      }
    });
    await postJson(baseUrl, 'operator.approveDomain', {
      origin: 'https://example.com'
    });
    await postJson(baseUrl, 'extension.hostPermissionGranted', {
      origin: 'https://example.com'
    });

    const observePromise = postJson(baseUrl, 'page.observe', {
      origin: 'https://example.com'
    });

    const command = await postJson(baseUrl, 'bridge.poll');
    assert.equal(command.body.ok, true);
    assert.equal(command.body.result.command.method, 'page.observe');
    assert.equal(command.body.result.command.params.origin, 'https://example.com');

    await postJson(baseUrl, 'bridge.deliver', {
      commandId: command.body.result.command.commandId,
      response: {
        ok: true,
        result: {
          origin: 'https://example.com',
          title: 'Fixture',
          elements: []
        }
      }
    });

    const result = await observePromise;
    assert.equal(result.body.ok, true);
    assert.equal(result.body.result.origin, 'https://example.com');
    assert.equal(result.body.result.title, 'Fixture');
  });
});

test('successful page command clears stale lastError', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await postJson(baseUrl, 'extension.hello', {
      hello: {
        type: 'HELLO',
        protocolVersion: '1.0',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        extensionVersion: '0.1.0',
        bridgeVersion: '0.1.0',
        sessionBootstrapId: 'boot_abc',
        profileBindingState: 'bound',
        profileBindingId: 'profbind_8Qw3z6NqfK2p9xV1',
        profileBindingVersion: 3,
        profileBindingSource: 'chrome.storage.local',
        capabilities: ['observe.v1']
      }
    });
    await postJson(baseUrl, 'operator.approveDomain', {
      origin: 'https://example.com'
    });

    const failClosed = await postJson(baseUrl, 'page.observe', {
      origin: 'https://example.com'
    });
    assert.equal(failClosed.body.ok, false);
    assert.equal(failClosed.body.error.code, ERROR_CODES.HOST_PERMISSION_REQUIRED);

    const statusAfterError = await postJson(baseUrl, 'operator.status');
    assert.equal(statusAfterError.body.result.lastError.code, ERROR_CODES.HOST_PERMISSION_REQUIRED);

    await postJson(baseUrl, 'extension.hostPermissionGranted', {
      origin: 'https://example.com'
    });

    const observePromise = postJson(baseUrl, 'page.observe', {
      origin: 'https://example.com'
    });
    const command = await postJson(baseUrl, 'bridge.poll');
    await postJson(baseUrl, 'bridge.deliver', {
      commandId: command.body.result.command.commandId,
      response: {
        ok: true,
        result: {
          origin: 'https://example.com',
          title: 'Recovered',
          elements: []
        }
      }
    });

    const recovered = await observePromise;
    assert.equal(recovered.body.ok, true);

    const statusAfterSuccess = await postJson(baseUrl, 'operator.status');
    assert.equal(statusAfterSuccess.body.result.lastError, null);
  });
});
