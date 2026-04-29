const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SessionManager } = require('../operator-daemon/sessionManager');
const { startControlServer } = require('../operator-daemon/controlServer');
const { ERROR_CODES } = require('../operator-daemon/protocol');

function tempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-operator-readiness-'));
  return {
    statePath: path.join(dir, 'state.json'),
    auditLogPath: path.join(dir, 'audit.jsonl')
  };
}

function makeSession(paths) {
  return new SessionManager({
    token: 'test-token',
    auditLogPath: paths.auditLogPath,
    statePath: paths.statePath,
    expectedExtensionId: 'abcdefghijklmnopabcdefghijklmnop'
  });
}

async function withServer(session, fn) {
  const server = await startControlServer({ session, token: 'test-token', port: 0 });
  try {
    await fn(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.close();
  }
}

async function postJson(baseUrl, method, params = {}) {
  const response = await fetch(`${baseUrl}/v1/rpc`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
      'x-codex-chrome-operator': '1'
    },
    body: JSON.stringify({ id: method, method, params })
  });
  return response.json();
}

test('domain approval and host permission survive daemon session restart', async () => {
  const paths = tempPaths();

  await withServer(makeSession(paths), async (baseUrl) => {
    const approval = await postJson(baseUrl, 'operator.approveDomain', {
      origin: 'https://example.com',
      mode: 'guarded',
      taskScope: 'fixture test',
      expiresAt: '2026-04-30T00:00:00.000Z'
    });
    assert.equal(approval.ok, true);

    const permission = await postJson(baseUrl, 'extension.hostPermissionGranted', {
      origin: 'https://example.com',
      profileBindingId: 'profbind_saved'
    });
    assert.equal(permission.ok, true);
  });

  await withServer(makeSession(paths), async (baseUrl) => {
    const status = await postJson(baseUrl, 'operator.status');
    assert.deepEqual(status.result.approvedOrigins, ['https://example.com']);
    assert.deepEqual(status.result.hostPermissionOrigins, ['https://example.com']);
    assert.deepEqual(status.result.domainApprovals['https://example.com'], {
      origin: 'https://example.com',
      mode: 'guarded',
      taskScope: 'fixture test',
      expiresAt: '2026-04-30T00:00:00.000Z'
    });
  });
});

test('operator.profile.bind configures expected binding and verifyReadiness reports missing host permission', async () => {
  const paths = tempPaths();

  await withServer(makeSession(paths), async (baseUrl) => {
    const bind = await postJson(baseUrl, 'operator.profile.bind', {
      userDataDir: 'C:/Chrome/User Data',
      profileDirectory: 'Profile 1',
      profileLabel: 'Play Console',
      profileBindingId: 'profbind_boundProfile01',
      profileBindingVersion: 2
    });

    assert.equal(bind.ok, true);
    assert.equal(bind.result.profileBindingId, 'profbind_boundProfile01');
    assert.equal(bind.result.profileBindingVersion, 2);
    assert.match(bind.result.setupUrl, /^chrome-extension:\/\/abcdefghijklmnopabcdefghijklmnop\/profileSetup\.html\?/);

    const hello = await postJson(baseUrl, 'extension.hello', {
      hello: {
        type: 'HELLO',
        protocolVersion: '1.0',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        extensionVersion: '0.1.0',
        bridgeVersion: '0.1.0',
        sessionBootstrapId: 'boot_abc',
        profileBindingState: 'bound',
        profileBindingId: 'profbind_boundProfile01',
        profileBindingVersion: 2,
        profileBindingSource: 'chrome.storage.local',
        capabilities: ['observe.v1']
      }
    });
    assert.equal(hello.ok, true);

    await postJson(baseUrl, 'operator.approveDomain', {
      origin: 'https://example.com'
    });

    const readiness = await postJson(baseUrl, 'operator.verifyReadiness', {
      origin: 'https://example.com'
    });
    assert.equal(readiness.ok, true);
    assert.equal(readiness.result.ready, false);
    assert.deepEqual(readiness.result.missing, ['hostPermission']);
    assert.equal(readiness.result.error.code, ERROR_CODES.HOST_PERMISSION_REQUIRED);
  });
});

test('readiness ignores persisted host permission from a different profile binding', async () => {
  const paths = tempPaths();

  await withServer(makeSession(paths), async (baseUrl) => {
    await postJson(baseUrl, 'operator.approveDomain', {
      origin: 'https://example.com'
    });
    await postJson(baseUrl, 'extension.hostPermissionGranted', {
      origin: 'https://example.com',
      profileBindingId: 'profbind_oldProfile'
    });
  });

  await withServer(makeSession(paths), async (baseUrl) => {
    await postJson(baseUrl, 'operator.profile.bind', {
      userDataDir: 'C:/Chrome/User Data',
      profileDirectory: 'Profile 2',
      profileLabel: 'Different Profile',
      profileBindingId: 'profbind_newProfile',
      profileBindingVersion: 1
    });
    const hello = await postJson(baseUrl, 'extension.hello', {
      hello: {
        type: 'HELLO',
        protocolVersion: '1.0',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        extensionVersion: '0.1.0',
        bridgeVersion: '0.1.0',
        sessionBootstrapId: 'boot_abc',
        profileBindingState: 'bound',
        profileBindingId: 'profbind_newProfile',
        profileBindingVersion: 1,
        profileBindingSource: 'chrome.storage.local',
        capabilities: ['observe.v1']
      }
    });
    assert.equal(hello.ok, true);

    const readiness = await postJson(baseUrl, 'operator.verifyReadiness', {
      origin: 'https://example.com'
    });
    assert.equal(readiness.ok, true);
    assert.equal(readiness.result.ready, false);
    assert.deepEqual(readiness.result.missing, ['hostPermission']);
    assert.equal(readiness.result.error.code, ERROR_CODES.HOST_PERMISSION_REQUIRED);
  });
});
