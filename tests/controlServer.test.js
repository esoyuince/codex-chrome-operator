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

test('page.visualObserve fails closed before host permission is granted', async () => {
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
        capabilities: ['observe.v1', 'visualObserve.v1']
      }
    });
    await postJson(baseUrl, 'operator.approveDomain', {
      origin: 'https://example.com'
    });

    const result = await postJson(baseUrl, 'page.visualObserve', {
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

test('page.visualObserve queues extension command and resolves from bridge delivery', async () => {
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
        capabilities: ['observe.v1', 'visualObserve.v1']
      }
    });
    await postJson(baseUrl, 'operator.approveDomain', {
      origin: 'https://example.com'
    });
    await postJson(baseUrl, 'extension.hostPermissionGranted', {
      origin: 'https://example.com'
    });

    const observePromise = postJson(baseUrl, 'page.visualObserve', {
      origin: 'https://example.com'
    });

    const command = await postJson(baseUrl, 'bridge.poll');
    assert.equal(command.body.ok, true);
    assert.equal(command.body.result.command.method, 'page.visualObserve');
    assert.equal(command.body.result.command.params.origin, 'https://example.com');

    await postJson(baseUrl, 'bridge.deliver', {
      commandId: command.body.result.command.commandId,
      response: {
        ok: true,
        result: {
          origin: 'https://example.com',
          screenshot: {
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,abc'
          },
          elements: []
        }
      }
    });

    const result = await observePromise;
    assert.equal(result.body.ok, true);
    assert.equal(result.body.result.screenshot.mimeType, 'image/png');
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

test('local high-risk click can be approved and replayed once', async () => {
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
      origin: 'http://127.0.0.1:18888'
    });
    await postJson(baseUrl, 'extension.hostPermissionGranted', {
      origin: 'http://127.0.0.1:18888'
    });

    const clickPromise = postJson(baseUrl, 'page.click', {
      origin: 'http://127.0.0.1:18888',
      handle: 'el_3'
    });
    const blockedCommand = await postJson(baseUrl, 'bridge.poll');
    await postJson(baseUrl, 'bridge.deliver', {
      commandId: blockedCommand.body.result.command.commandId,
      response: {
        ok: false,
        error: {
          code: ERROR_CODES.HIGH_RISK_BLOCKED,
          approvalKind: 'publish',
          targetSummary: 'button: Publish'
        }
      }
    });

    const blocked = await clickPromise;
    assert.equal(blocked.body.ok, false);
    assert.equal(blocked.body.error.code, ERROR_CODES.HIGH_RISK_BLOCKED);
    assert.match(blocked.body.error.approvalId, /^approval_/);

    const approvals = await postJson(baseUrl, 'operator.approvals.list');
    assert.equal(approvals.body.result.approvals.length, 1);
    assert.equal(approvals.body.result.approvals[0].status, 'pending');

    const approvalId = blocked.body.error.approvalId;
    const approved = await postJson(baseUrl, 'operator.approvals.approve', { approvalId });
    assert.equal(approved.body.ok, true);
    assert.equal(approved.body.result.status, 'approved');

    const runPromise = postJson(baseUrl, 'operator.approvals.run', { approvalId });
    const replayCommand = await postJson(baseUrl, 'bridge.poll');
    assert.equal(replayCommand.body.result.command.method, 'page.click');
    assert.deepEqual(replayCommand.body.result.command.params.approval, {
      approvalId,
      allowHighRisk: true,
      approvalKind: 'publish'
    });
    await postJson(baseUrl, 'bridge.deliver', {
      commandId: replayCommand.body.result.command.commandId,
      response: {
        ok: true,
        result: { action: 'clicked' }
      }
    });

    const replayed = await runPromise;
    assert.equal(replayed.body.ok, true);
    assert.equal(replayed.body.result.action, 'clicked');
  });
});

test('gate handoff errors pause actions without creating approval requests', async () => {
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
        capabilities: ['observe.v1', 'gateHandoff.v1']
      }
    });
    await postJson(baseUrl, 'operator.approveDomain', {
      origin: 'http://127.0.0.1:18888'
    });
    await postJson(baseUrl, 'extension.hostPermissionGranted', {
      origin: 'http://127.0.0.1:18888'
    });

    const clickPromise = postJson(baseUrl, 'page.click', {
      origin: 'http://127.0.0.1:18888',
      handle: 'el_1'
    });
    const command = await postJson(baseUrl, 'bridge.poll');
    await postJson(baseUrl, 'bridge.deliver', {
      commandId: command.body.result.command.commandId,
      response: {
        ok: false,
        error: {
          code: 'PASSWORD_REQUIRED',
          message: 'A password gate is visible. Please complete it in Chrome; the operator will resume after the page changes.',
          gateType: 'PASSWORD_REQUIRED',
          resumePolicy: 'wait-and-reobserve',
          timeoutMs: 300000,
          taskStatePreserved: true,
          freshObservationRequired: true
        }
      }
    });

    const blocked = await clickPromise;
    assert.equal(blocked.body.ok, false);
    assert.equal(blocked.body.error.code, 'PASSWORD_REQUIRED');
    assert.equal(blocked.body.error.resumePolicy, 'wait-and-reobserve');
    assert.equal(blocked.body.error.approvalId, undefined);

    const approvals = await postJson(baseUrl, 'operator.approvals.list');
    assert.deepEqual(approvals.body.result.approvals, []);
  });
});

test('real-origin high-risk approval replay is blocked in M1', async () => {
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

    const clickPromise = postJson(baseUrl, 'page.click', {
      origin: 'https://example.com',
      handle: 'el_3'
    });
    const blockedCommand = await postJson(baseUrl, 'bridge.poll');
    await postJson(baseUrl, 'bridge.deliver', {
      commandId: blockedCommand.body.result.command.commandId,
      response: {
        ok: false,
        error: {
          code: ERROR_CODES.HIGH_RISK_BLOCKED,
          approvalKind: 'publish',
          targetSummary: 'button: Publish'
        }
      }
    });
    const blocked = await clickPromise;
    const approved = await postJson(baseUrl, 'operator.approvals.approve', {
      approvalId: blocked.body.error.approvalId
    });
    assert.equal(approved.body.ok, false);
    assert.equal(approved.body.error.code, ERROR_CODES.HIGH_RISK_BLOCKED);
  });
});
