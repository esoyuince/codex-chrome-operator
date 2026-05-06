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
      expiresAt: '2999-01-01T00:00:00.000Z'
    });
    assert.equal(approval.ok, true);

    const permission = await postJson(baseUrl, 'extension.hostPermissionGranted', {
      origin: 'https://example.com',
      profileBindingId: 'profbind_developmentBinding01'
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
      expiresAt: '2999-01-01T00:00:00.000Z'
    });
  });
});

test('operator.profile.bind configures profile selection and verifyReadiness is ready without per-site host permission', async () => {
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
    assert.equal(bind.result.profileBindingId, undefined);
    assert.equal(bind.result.profileBindingVersion, undefined);
    assert.equal(bind.result.setupUrl, undefined);

    const hello = await postJson(baseUrl, 'extension.hello', {
      hello: {
        type: 'HELLO',
        protocolVersion: '1.0',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        extensionVersion: '0.2.11',
        bridgeVersion: '0.2.11',
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
    assert.equal(readiness.result.ready, true);
    assert.deepEqual(readiness.result.missing, []);
    assert.equal(readiness.result.hostPermissionGranted, false);
    assert.equal(readiness.result.error, null);
  });
});

test('extension.blockedOriginsSynced blocks readiness for user blocked sites', async () => {
  const paths = tempPaths();

  await withServer(makeSession(paths), async (baseUrl) => {
    await postJson(baseUrl, 'extension.hello', {
      hello: {
        type: 'HELLO',
        protocolVersion: '1.0',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        extensionVersion: '0.2.11',
        bridgeVersion: '0.2.11',
        sessionBootstrapId: 'boot_abc',
        profileBindingState: 'bound',
        profileBindingId: 'profbind_developmentBinding01',
        profileBindingVersion: 1,
        profileBindingSource: 'chrome.storage.local',
        capabilities: ['observe.v1']
      }
    });
    await postJson(baseUrl, 'operator.approveDomain', {
      origin: 'https://login.internal.example'
    });
    const sync = await postJson(baseUrl, 'extension.blockedOriginsSynced', {
      blockedOrigins: ['*.internal.example', 'https://bank.example']
    });
    assert.equal(sync.ok, true);
    assert.deepEqual(sync.result.blockedOrigins, ['*.internal.example', 'https://bank.example']);

    const readiness = await postJson(baseUrl, 'operator.verifyReadiness', {
      origin: 'https://login.internal.example'
    });
    assert.equal(readiness.ok, true);
    assert.equal(readiness.result.ready, false);
    assert.equal(readiness.result.siteBlocked, true);
    assert.equal(readiness.result.blockedPattern, '*.internal.example');
    assert.deepEqual(readiness.result.missing, ['siteAllowed']);
    assert.equal(readiness.result.error.code, ERROR_CODES.SITE_BLOCKED_BY_USER_SETTINGS);
  });
});

test('readiness treats persisted host permission as profile-independent', async () => {
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
        extensionVersion: '0.2.11',
        bridgeVersion: '0.2.11',
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
    assert.equal(readiness.result.ready, true);
    assert.equal(readiness.result.hostPermissionGranted, true);
    assert.deepEqual(readiness.result.missing, []);
    assert.equal(readiness.result.error, null);
  });
});

test('extension.hostPermissionsSynced replaces the profile-independent permission set', async () => {
  const paths = tempPaths();

  await withServer(makeSession(paths), async (baseUrl) => {
    await postJson(baseUrl, 'operator.profile.bind', {
      userDataDir: 'C:/Chrome/User Data',
      profileDirectory: 'Profile 1',
      profileBindingId: 'profbind_syncProfile',
      profileBindingVersion: 1
    });
    await postJson(baseUrl, 'extension.hello', {
      hello: {
        type: 'HELLO',
        protocolVersion: '1.0',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        extensionVersion: '0.2.11',
        bridgeVersion: '0.2.11',
        sessionBootstrapId: 'boot_abc',
        profileBindingState: 'bound',
        profileBindingId: 'profbind_syncProfile',
        profileBindingVersion: 1,
        profileBindingSource: 'chrome.storage.local',
        capabilities: ['observe.v1']
      }
    });
    await postJson(baseUrl, 'operator.approveDomain', {
      origin: 'https://keep.example'
    });
    await postJson(baseUrl, 'operator.approveDomain', {
      origin: 'https://remove.example'
    });
    await postJson(baseUrl, 'extension.hostPermissionGranted', {
      origin: 'https://keep.example',
      profileBindingId: 'profbind_syncProfile'
    });
    await postJson(baseUrl, 'extension.hostPermissionGranted', {
      origin: 'https://remove.example',
      profileBindingId: 'profbind_syncProfile'
    });

    const sync = await postJson(baseUrl, 'extension.hostPermissionsSynced', {
      profileBindingId: 'profbind_syncProfile',
      origins: ['https://keep.example']
    });
    assert.equal(sync.ok, true);
    assert.deepEqual(sync.result.hostPermissionOrigins, ['https://keep.example']);

    const readiness = await postJson(baseUrl, 'operator.verifyReadiness', {
      origin: 'https://remove.example'
    });
    assert.equal(readiness.ok, true);
    assert.equal(readiness.result.ready, true);
    assert.equal(readiness.result.hostPermissionGranted, false);
    assert.deepEqual(readiness.result.missing, []);
  });
});

test('readiness does not require matching host permission once profile and domain are ready', async () => {
  const paths = tempPaths();

  await withServer(makeSession(paths), async (baseUrl) => {
    await postJson(baseUrl, 'operator.approveDomain', {
      origin: 'https://example.com'
    });
    await postJson(baseUrl, 'extension.hostPermissionGranted', {
      origin: 'https://example.com',
      profileBindingId: 'profbind_otherBinding'
    });
    await postJson(baseUrl, 'extension.hello', {
      hello: {
        type: 'HELLO',
        protocolVersion: '1.0',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        extensionVersion: '0.2.11',
        bridgeVersion: '0.2.11',
        sessionBootstrapId: 'boot_abc',
        profileBindingState: 'bound',
        profileBindingId: 'profbind_developmentBinding01',
        profileBindingVersion: 1,
        profileBindingSource: 'chrome.storage.local',
        capabilities: ['observe.v1']
      }
    });

    const readiness = await postJson(baseUrl, 'operator.verifyReadiness', {
      origin: 'https://example.com'
    });
    assert.equal(readiness.ok, true);
    assert.equal(readiness.result.ready, true);
    assert.equal(readiness.result.hostPermissionGranted, true);
    assert.deepEqual(readiness.result.missing, []);
  });
});

test('expired domain approval is not ready even when host permission exists', async () => {
  const paths = tempPaths();

  await withServer(makeSession(paths), async (baseUrl) => {
    await postJson(baseUrl, 'extension.hello', {
      hello: {
        type: 'HELLO',
        protocolVersion: '1.0',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        extensionVersion: '0.2.11',
        bridgeVersion: '0.2.11',
        sessionBootstrapId: 'boot_abc',
        profileBindingState: 'bound',
        profileBindingId: 'profbind_developmentBinding01',
        profileBindingVersion: 1,
        profileBindingSource: 'chrome.storage.local',
        capabilities: ['observe.v1']
      }
    });
    await postJson(baseUrl, 'operator.approveDomain', {
      origin: 'https://expired.example',
      expiresAt: '2020-01-01T00:00:00.000Z'
    });
    await postJson(baseUrl, 'extension.hostPermissionGranted', {
      origin: 'https://expired.example',
      profileBindingId: 'profbind_developmentBinding01'
    });

    const status = await postJson(baseUrl, 'operator.status');
    assert.deepEqual(status.result.approvedOrigins, []);
    assert.deepEqual(Object.keys(status.result.domainApprovals), ['https://expired.example']);

    const readiness = await postJson(baseUrl, 'operator.verifyReadiness', {
      origin: 'https://expired.example'
    });
    assert.equal(readiness.ok, true);
    assert.equal(readiness.result.ready, false);
    assert.deepEqual(readiness.result.missing, ['domainApproval']);
    assert.equal(readiness.result.error.code, ERROR_CODES.DOMAIN_NOT_APPROVED);
  });
});

test('operator.revokeDomain removes approval but keeps host permission metadata', async () => {
  const paths = tempPaths();

  await withServer(makeSession(paths), async (baseUrl) => {
    await postJson(baseUrl, 'extension.hello', {
      hello: {
        type: 'HELLO',
        protocolVersion: '1.0',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        extensionVersion: '0.2.11',
        bridgeVersion: '0.2.11',
        sessionBootstrapId: 'boot_abc',
        profileBindingState: 'bound',
        profileBindingId: 'profbind_developmentBinding01',
        profileBindingVersion: 1,
        profileBindingSource: 'chrome.storage.local',
        capabilities: ['observe.v1']
      }
    });
    await postJson(baseUrl, 'operator.approveDomain', {
      origin: 'https://example.com'
    });
    await postJson(baseUrl, 'extension.hostPermissionGranted', {
      origin: 'https://example.com',
      profileBindingId: 'profbind_developmentBinding01'
    });

    const revoked = await postJson(baseUrl, 'operator.revokeDomain', {
      origin: 'https://example.com'
    });
    assert.equal(revoked.ok, true);
    assert.equal(revoked.result.revoked, true);

    const status = await postJson(baseUrl, 'operator.status');
    assert.deepEqual(status.result.approvedOrigins, []);
    assert.deepEqual(status.result.hostPermissionOrigins, ['https://example.com']);

    const readiness = await postJson(baseUrl, 'operator.verifyReadiness', {
      origin: 'https://example.com'
    });
    assert.equal(readiness.ok, true);
    assert.equal(readiness.result.ready, false);
    assert.deepEqual(readiness.result.missing, ['domainApproval']);
  });
});

test('status recentEvents includes active tab updates without raw sensitive params', async () => {
  const paths = tempPaths();

  await withServer(makeSession(paths), async (baseUrl) => {
    const updated = await postJson(baseUrl, 'extension.activeTabUpdated', {
      activeTab: {
        id: 7,
        windowId: 2,
        url: 'https://example.com/settings',
        title: 'Settings',
        status: 'loading'
      },
      text: 'do not expose this text',
      filePath: 'C:/Users/example/Desktop/private.png'
    });
    assert.equal(updated.ok, true);

    const status = await postJson(baseUrl, 'operator.status');
    const activeTabEvent = status.result.recentEvents.find((event) => (
      event.type === 'activeTabUpdated'
    ));

    assert.equal(activeTabEvent.method, 'extension.activeTabUpdated');
    assert.equal(activeTabEvent.activeTab.url, 'https://example.com/settings');
    assert.equal(activeTabEvent.activeTab.origin, 'https://example.com');
    assert.equal(activeTabEvent.activeTab.title, 'Settings');
    assert.equal(activeTabEvent.activeTab.loadingState, 'loading');

    const serialized = JSON.stringify(status.result.recentEvents);
    assert.equal(serialized.includes('do not expose this text'), false);
    assert.equal(serialized.includes('C:/Users/example/Desktop/private.png'), false);
  });
});

test('status recentEvents includes page command readiness failures', async () => {
  const paths = tempPaths();

  await withServer(makeSession(paths), async (baseUrl) => {
    await postJson(baseUrl, 'extension.hello', {
      hello: {
        type: 'HELLO',
        protocolVersion: '1.0',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        extensionVersion: '0.2.11',
        bridgeVersion: '0.2.11',
        sessionBootstrapId: 'boot_abc',
        profileBindingState: 'bound',
        profileBindingId: 'profbind_developmentBinding01',
        profileBindingVersion: 1,
        profileBindingSource: 'chrome.storage.local',
        capabilities: ['observe.v1']
      }
    });
    await postJson(baseUrl, 'operator.approveDomain', {
      origin: 'https://example.com'
    });
    await postJson(baseUrl, 'extension.blockedOriginsSynced', {
      blockedOrigins: ['example.com']
    });

    const result = await postJson(baseUrl, 'page.type', {
      origin: 'https://example.com',
      handle: 'el_1',
      text: 'super secret typed text'
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, ERROR_CODES.SITE_BLOCKED_BY_USER_SETTINGS);

    const status = await postJson(baseUrl, 'operator.status');
    const failureEvent = status.result.recentEvents.find((event) => (
      event.type === 'pageCommandFailed' && event.method === 'page.type'
    ));

    assert.equal(failureEvent.origin, 'https://example.com');
    assert.equal(failureEvent.actionKind, 'type');
    assert.equal(failureEvent.result, 'error');
    assert.equal(failureEvent.errorCode, ERROR_CODES.SITE_BLOCKED_BY_USER_SETTINGS);
    assert.equal(JSON.stringify(failureEvent).includes('super secret typed text'), false);
  });
});
