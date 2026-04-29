const test = require('node:test');
const assert = require('node:assert/strict');

const { sendRpc } = require('../native-bridge/daemonClient');
const { SessionManager } = require('../operator-daemon/sessionManager');
const { startControlServer } = require('../operator-daemon/controlServer');
const { ERROR_CODES } = require('../operator-daemon/protocol');

test('sendRpc posts a bearer-authenticated JSON request to daemon', async () => {
  const session = new SessionManager({
    token: 'bridge-token',
    expectedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
    expectedProfileBindingId: 'profbind_8Qw3z6NqfK2p9xV1',
    expectedProfileBindingVersion: 3
  });
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
  const session = new SessionManager({
    token: 'bridge-token',
    expectedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
    expectedProfileBindingId: 'profbind_8Qw3z6NqfK2p9xV1',
    expectedProfileBindingVersion: 3
  });
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
