const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { notifyDaemonDisconnect, sendRpc } = require('../native-bridge/daemonClient');
const { SessionManager } = require('../operator-daemon/sessionManager');
const { startControlServer } = require('../operator-daemon/controlServer');
const { ERROR_CODES } = require('../operator-daemon/protocol');

function makeSession() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-operator-daemon-client-'));
  return new SessionManager({
    token: 'bridge-token',
    auditLogPath: path.join(dir, 'audit.jsonl'),
    statePath: path.join(dir, 'state.json'),
    expectedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
    expectedProfileBindingId: 'profbind_8Qw3z6NqfK2p9xV1',
    expectedProfileBindingVersion: 3
  });
}

test('sendRpc posts a bearer-authenticated JSON request to daemon', async () => {
  const session = makeSession();
  const server = await startControlServer({ session, token: 'bridge-token', port: 0 });

  try {
    const response = await sendRpc({
      baseUrl: `http://127.0.0.1:${server.port}`,
      token: 'bridge-token',
      request: { id: 'req_1', method: 'operator.status', params: {} }
    });

    assert.equal(response.ok, true);
    assert.equal(response.result.connectionState, 'DAEMON_RUNNING_EXTENSION_DISCONNECTED');
  } finally {
    await server.close();
  }
});

test('sendRpc reports daemon auth failures without throwing', async () => {
  const session = makeSession();
  const server = await startControlServer({ session, token: 'bridge-token', port: 0 });

  try {
    const response = await sendRpc({
      baseUrl: `http://127.0.0.1:${server.port}`,
      token: 'wrong',
      request: { id: 'req_1', method: 'operator.status', params: {} }
    });

    assert.equal(response.ok, false);
    assert.equal(response.error.code, ERROR_CODES.AUTH_INVALID);
  } finally {
    await server.close();
  }
});

test('notifyDaemonDisconnect posts deterministic bridge disconnect event', async () => {
  const session = makeSession();
  const server = await startControlServer({ session, token: 'bridge-token', port: 0 });

  try {
    await sendRpc({
      baseUrl: `http://127.0.0.1:${server.port}`,
      token: 'bridge-token',
      request: {
        id: 'hello_1',
        method: 'extension.hello',
        params: {
          hello: {
            type: 'HELLO',
            protocolVersion: '1.0',
            extensionId: 'abcdefghijklmnopabcdefghijklmnop',
            extensionVersion: '0.2.0',
            bridgeVersion: '0.2.0',
            sessionBootstrapId: 'boot_abc',
            profileBindingState: 'bound',
            profileBindingId: 'profbind_8Qw3z6NqfK2p9xV1',
            profileBindingVersion: 3,
            profileBindingSource: 'chrome.storage.local',
            capabilities: ['observe.v1']
          }
        }
      }
    });

    const response = await notifyDaemonDisconnect({
      baseUrl: `http://127.0.0.1:${server.port}`,
      token: 'bridge-token',
      source: 'native-bridge',
      reason: 'stdin closed'
    });

    assert.equal(response.ok, true);
    assert.equal(response.result.connectionState, 'RECONNECTING');
    assert.equal(response.result.source, 'native-bridge');
  } finally {
    await server.close();
  }
});
