const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SessionManager } = require('../operator-daemon/sessionManager');
const { startControlServer } = require('../operator-daemon/controlServer');
const { ERROR_CODES } = require('../operator-daemon/protocol');

function makeSession(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-operator-session-'));
  return new SessionManager({
    token: 'test-token',
    auditLogPath: path.join(dir, 'audit.jsonl'),
    statePath: path.join(dir, 'state.json'),
    screenshotDir: path.join(dir, 'screenshots'),
    expectedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
    expectedProfileBindingId: 'profbind_8Qw3z6NqfK2p9xV1',
    expectedProfileBindingVersion: 3,
    ...overrides
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

function verifiedHello(capabilities = ['observe.v1', 'visualObserve.v1']) {
  return {
    type: 'HELLO',
    protocolVersion: '1.0',
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    extensionVersion: '0.2.8',
    bridgeVersion: '0.2.8',
    sessionBootstrapId: `boot_${Date.now()}`,
    profileBindingState: 'bound',
    profileBindingId: 'profbind_8Qw3z6NqfK2p9xV1',
    profileBindingVersion: 3,
    profileBindingSource: 'chrome.storage.local',
    capabilities
  };
}

function boundedFullAutoContract(overrides = {}) {
  return {
    mode: 'bounded-full-auto-v1',
    approvedOrigins: ['https://example.com'],
    taskScope: 'unit bounded task',
    allowedActionKinds: ['observe', 'fill', 'screenshot'],
    blockedActionKinds: ['publish', 'payment'],
    limits: {
      expiresInMinutes: 30,
      maxBrowserActions: 5,
      maxScreenshots: 1,
      maxOriginChanges: 0,
      ...(overrides.limits || {})
    },
    auditRequired: true,
    emergencyStopRequired: true,
    ...overrides
  };
}

async function connectAndAuthorize(baseUrl, origin = 'https://example.com') {
  await postJson(baseUrl, 'extension.hello', {
    hello: verifiedHello()
  });
  await postJson(baseUrl, 'operator.approveDomain', { origin });
  await postJson(baseUrl, 'extension.hostPermissionGranted', { origin });
}

async function deliverNextCommand(baseUrl, response) {
  const command = await postJson(baseUrl, 'bridge.poll');
  assert.equal(command.body.ok, true);
  assert.ok(command.body.result.command);
  await postJson(baseUrl, 'bridge.deliver', {
    commandId: command.body.result.command.commandId,
    response
  });
  return command.body.result.command;
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
    assert.equal(result.body.result.activeTab, null);
  });
});

test('operator.status supports compact detail while default remains full', async () => {
  await withServer(makeSession(), async (baseUrl, session) => {
    await connectAndAuthorize(baseUrl);
    await postJson(baseUrl, 'extension.blockedOriginsSynced', {
      blockedOrigins: ['https://blocked.example']
    });
    await postJson(baseUrl, 'extension.activeTabWarmup', {
      activeTab: {
        id: 7,
        windowId: 2,
        url: 'https://example.com/form',
        title: 'Warm Form',
        status: 'complete'
      },
      warmup: {
        ok: true,
        source: 'content.batch',
        observation: {
          origin: 'https://example.com',
          title: 'Warm Form',
          elements: Array.from({ length: 20 }, (_, index) => ({
            handle: `el_${index}`,
            label: `Large control ${index}`
          }))
        },
        readPage: {
          origin: 'https://example.com',
          pageContent: 'Large warm read '.repeat(100)
        }
      }
    });
    await postJson(baseUrl, 'operator.fullAuto.start', {
      contract: boundedFullAutoContract()
    });
    session.pendingApprovals.set('approval_unit', {
      approvalId: 'approval_unit',
      status: 'pending',
      method: 'page.click',
      origin: 'https://example.com',
      params: { origin: 'https://example.com', handle: 'el_publish' },
      approvalKind: 'high-risk-action',
      targetSummary: 'button: Publish',
      createdAt: new Date().toISOString()
    });
    for (let index = 0; index < 10; index += 1) {
      session.recordRecentEvent({
        type: 'unit-heavy-event',
        method: 'page.observe',
        result: 'ok',
        payload: 'heavy-status-event '.repeat(50)
      });
    }
    session.lastError = {
      code: 'UNIT_LAST_ERROR',
      message: 'Last error is preserved.'
    };

    const full = await postJson(baseUrl, 'operator.status');
    const compact = await postJson(baseUrl, 'operator.status', { detail: 'compact' });

    assert.equal(full.body.ok, true);
    assert.equal(compact.body.ok, true);
    assert.equal(full.body.telemetry.budgetName, 'operator.status');
    assert.equal(compact.body.telemetry.budgetName, 'operator.status');
    assert.equal(compact.body.telemetry.resultChars, JSON.stringify(compact.body.result).length);
    assert.ok(
      compact.body.telemetry.approxResultTokens < full.body.telemetry.approxResultTokens / 2,
      'compact status token budget should be much smaller than full status'
    );
    assert.ok(Array.isArray(full.body.result.recentEvents));
    assert.ok(Array.isArray(full.body.result.recentActionLog));
    assert.ok(Array.isArray(full.body.result.approvedOrigins));
    assert.ok(Array.isArray(full.body.result.hostPermissionOrigins));
    assert.ok(Array.isArray(full.body.result.blockedOrigins));
    assert.ok(Array.isArray(full.body.result.pendingApprovals));
    assert.equal(Object.hasOwn(full.body.result, 'auditLogPath'), true);
    assert.equal(Object.hasOwn(full.body.result, 'screenshotDir'), true);

    const compactResult = compact.body.result;
    assert.equal(compactResult.connectionState, 'EXTENSION_CONNECTED');
    assert.equal(compactResult.activeTab.origin, 'https://example.com');
    assert.equal(compactResult.warmSession.active, true);
    assert.equal(compactResult.pendingApprovalCount, 1);
    assert.equal(compactResult.emergencyStop.active, false);
    assert.equal(compactResult.boundedFullAuto.active, true);
    assert.equal(compactResult.boundedFullAuto.mode, 'bounded-full-auto-v1');
    assert.equal(compactResult.version.protocolVersion, '1.0');
    assert.equal(compactResult.lastError.code, 'UNIT_LAST_ERROR');
    assert.equal(compactResult.approvedOriginCount, 1);
    assert.equal(compactResult.blockedOriginCount, 1);
    assert.equal(compactResult.domainApprovalCount, 1);
    assert.equal(compactResult.hostPermissionOriginCount, 1);

    for (const heavyKey of [
      'recentEvents',
      'recentActionLog',
      'domainApprovals',
      'configuredProfile',
      'approvedOrigins',
      'hostPermissionOrigins',
      'blockedOrigins',
      'pendingApprovals',
      'auditLogPath',
      'screenshotDir'
    ]) {
      assert.equal(Object.hasOwn(compactResult, heavyKey), false, `${heavyKey} should be omitted`);
    }
    assert.ok(
      JSON.stringify(compactResult).length < JSON.stringify(full.body.result).length / 2,
      'compact status should be much smaller than full status'
    );
  });
});

test('operator.ensureStarted reports daemon readiness and bootstrap URL before extension connects', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    const result = await postJson(baseUrl, 'operator.ensureStarted');

    assert.equal(result.body.ok, true);
    assert.equal(result.body.result.daemonRunning, true);
    assert.equal(result.body.result.extensionConnected, false);
    assert.equal(result.body.result.bootstrapRequired, true);
    assert.match(
      result.body.result.bootstrapUrl,
      /^chrome-extension:\/\/abcdefghijklmnopabcdefghijklmnop\/bootstrap\.html\?session=/
    );
    assert.equal(result.body.result.status.connectionState, 'DAEMON_RUNNING_EXTENSION_DISCONNECTED');
  });
});

test('operator.ensureStarted summarizes target readiness for requested origin', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    const result = await postJson(baseUrl, 'operator.ensureStarted', {
      origin: 'https://example.com'
    });

    assert.equal(result.body.ok, true);
    assert.deepEqual(result.body.result.readiness, {
      origin: 'https://example.com',
      ready: false,
      profileVerified: false,
      domainApproved: false,
      hostPermissionGranted: false,
      siteBlocked: false,
      blockedPattern: null,
      missing: ['domainApproval']
    });
  });
});

test('extension.hello and tab updates expose active tab in operator.status', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    const hello = await postJson(baseUrl, 'extension.hello', {
      hello: verifiedHello(),
      activeTab: {
        id: 7,
        windowId: 2,
        url: 'https://example.com/start',
        title: 'Start Page',
        status: 'loading'
      }
    });
    assert.equal(hello.body.ok, true);

    const statusAfterHello = await postJson(baseUrl, 'operator.status');
    assert.equal(statusAfterHello.body.result.activeTab.origin, 'https://example.com');
    assert.equal(statusAfterHello.body.result.activeTab.title, 'Start Page');
    assert.equal(statusAfterHello.body.result.activeTab.loadingState, 'loading');

    const updated = await postJson(baseUrl, 'extension.activeTabUpdated', {
      activeTab: {
        id: 7,
        windowId: 2,
        url: 'https://example.com/done',
        title: 'Done Page',
        status: 'complete'
      }
    });
    assert.equal(updated.body.ok, true);
    assert.equal(updated.body.result.activeTab.origin, 'https://example.com');
    assert.equal(updated.body.result.activeTab.loadingState, 'complete');

    const statusAfterUpdate = await postJson(baseUrl, 'operator.status');
    assert.equal(statusAfterUpdate.body.result.activeTab.url, 'https://example.com/done');
    assert.equal(statusAfterUpdate.body.result.activeTab.title, 'Done Page');
  });
});

test('extension active-tab warmup caches observe and compact read results without queueing', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await connectAndAuthorize(baseUrl);

    const warmed = await postJson(baseUrl, 'extension.activeTabWarmup', {
      activeTab: {
        id: 7,
        windowId: 2,
        url: 'https://example.com/form',
        title: 'Warm Form',
        status: 'complete'
      },
      warmup: {
        ok: true,
        source: 'content.batch',
        observation: {
          origin: 'https://example.com',
          url: 'https://example.com/form',
          title: 'Warm Form',
          elements: [{ handle: 'el_warm_0', tag: 'input', label: 'Email' }]
        },
        readPage: {
          origin: 'https://example.com',
          url: 'https://example.com/form',
          title: 'Warm Form',
          pageStateId: 'warm_state',
          pageContent: 'textbox "Email" [el_warm_0]',
          handles: [{ handle: 'el_warm_0', tag: 'input', label: 'Email' }]
        }
      }
    });
    assert.equal(warmed.body.ok, true);

    const readPromise = postJson(baseUrl, 'page.readPage', {
      origin: 'https://example.com',
      filter: 'interactive',
      maxChars: 1000
    });
    const pollAfterRead = await postJson(baseUrl, 'bridge.poll');
    if (pollAfterRead.body.result.command) {
      await postJson(baseUrl, 'bridge.deliver', {
        commandId: pollAfterRead.body.result.command.commandId,
        response: {
          ok: true,
          result: { origin: 'https://example.com', pageContent: 'uncached' }
        }
      });
    }
    const read = await readPromise;

    assert.equal(pollAfterRead.body.result.command, null);
    assert.equal(read.body.ok, true);
    assert.equal(read.body.result.pageContent, 'textbox "Email" [el_warm_0]');
    assert.equal(read.body.result.warmCache.hit, true);

    const observePromise = postJson(baseUrl, 'page.observe', {
      origin: 'https://example.com'
    });
    const pollAfterObserve = await postJson(baseUrl, 'bridge.poll');
    if (pollAfterObserve.body.result.command) {
      await postJson(baseUrl, 'bridge.deliver', {
        commandId: pollAfterObserve.body.result.command.commandId,
        response: {
          ok: true,
          result: { origin: 'https://example.com', title: 'uncached', elements: [] }
        }
      });
    }
    const observed = await observePromise;

    assert.equal(pollAfterObserve.body.result.command, null);
    assert.equal(observed.body.ok, true);
    assert.equal(observed.body.result.title, 'Warm Form');
    assert.equal(observed.body.result.warmCache.hit, true);

    const status = await postJson(baseUrl, 'operator.status');
    assert.equal(status.body.result.warmSession.active, true);
    assert.equal(status.body.result.warmSession.origin, 'https://example.com');
    assert.equal(status.body.result.warmSession.source, 'content.batch');
    assert.equal(status.body.result.warmSession.hasObservation, true);
    assert.equal(status.body.result.warmSession.hasReadPage, true);
  });
});

test('active-tab updates invalidate stale warm session cache before browser work', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await connectAndAuthorize(baseUrl);
    await postJson(baseUrl, 'extension.activeTabWarmup', {
      activeTab: {
        id: 7,
        windowId: 2,
        url: 'https://example.com/form',
        title: 'Warm Form',
        status: 'complete'
      },
      warmup: {
        ok: true,
        source: 'content.batch',
        observation: { origin: 'https://example.com', title: 'Warm Form', elements: [] },
        readPage: { origin: 'https://example.com', pageContent: 'main [el_warm_0]' }
      }
    });

    await postJson(baseUrl, 'extension.activeTabUpdated', {
      activeTab: {
        id: 7,
        windowId: 2,
        url: 'https://example.com/changed',
        title: 'Changed',
        status: 'complete'
      }
    });

    const status = await postJson(baseUrl, 'operator.status');
    assert.equal(status.body.result.warmSession.active, false);
    assert.equal(status.body.result.warmSession.reason, 'active-tab-changed');

    const readPromise = postJson(baseUrl, 'page.readPage', {
      origin: 'https://example.com',
      filter: 'interactive',
      maxChars: 1000
    });
    const command = await postJson(baseUrl, 'bridge.poll');
    assert.equal(command.body.result.command.method, 'page.readPage');
    await postJson(baseUrl, 'bridge.deliver', {
      commandId: command.body.result.command.commandId,
      response: {
        ok: true,
        result: { origin: 'https://example.com', pageContent: 'fresh' }
      }
    });
    const read = await readPromise;
    assert.equal(read.body.result.pageContent, 'fresh');
  });
});

test('successful mutating page commands invalidate warm session cache', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await connectAndAuthorize(baseUrl);
    await postJson(baseUrl, 'extension.activeTabWarmup', {
      activeTab: {
        id: 7,
        windowId: 2,
        url: 'https://example.com/form',
        title: 'Warm Form',
        status: 'complete'
      },
      warmup: {
        ok: true,
        source: 'content.batch',
        observation: { origin: 'https://example.com', title: 'Stale Warm Form', elements: [] },
        readPage: { origin: 'https://example.com', pageContent: 'stale warm content' }
      }
    });

    const scrollPromise = postJson(baseUrl, 'page.scroll', {
      origin: 'https://example.com',
      deltaX: 0,
      deltaY: 650
    });
    const scrollCommand = await deliverNextCommand(baseUrl, {
      ok: true,
      result: { action: 'scrolled', scrollY: 650 }
    });
    assert.equal(scrollCommand.method, 'page.scroll');
    const scrolled = await scrollPromise;
    assert.equal(scrolled.body.ok, true);

    const status = await postJson(baseUrl, 'operator.status');
    assert.equal(status.body.result.warmSession.active, false);
    assert.equal(status.body.result.warmSession.reason, 'page.scroll');

    const observePromise = postJson(baseUrl, 'page.observe', {
      origin: 'https://example.com'
    });
    const observeCommand = await deliverNextCommand(baseUrl, {
      ok: true,
      result: { origin: 'https://example.com', title: 'Fresh After Scroll', elements: [] }
    });
    assert.equal(observeCommand.method, 'page.observe');
    const observed = await observePromise;
    assert.equal(observed.body.result.title, 'Fresh After Scroll');
    assert.equal(observed.body.result.warmCache, undefined);
  });
});

test('foreign native bridge cannot replace active tab or consume queued commands', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    const hello = await postJson(baseUrl, 'extension.hello', {
      bridgeInstanceId: 'bridge_smoke',
      hello: verifiedHello(),
      activeTab: {
        id: 7,
        windowId: 2,
        url: 'http://127.0.0.1:18180/basic-form.html',
        title: 'Smoke Fixture',
        status: 'complete'
      }
    });
    assert.equal(hello.body.ok, true);
    assert.equal(hello.body.result.bridgeInstanceId, 'bridge_smoke');

    const foreignHello = await postJson(baseUrl, 'extension.hello', {
      bridgeInstanceId: 'bridge_real',
      hello: {
        ...verifiedHello(),
        sessionBootstrapId: 'boot_real',
        profileBindingId: 'profbind_realProfile'
      },
      activeTab: {
        id: 99,
        windowId: 9,
        url: 'https://x.com/home',
        title: 'Real Browser',
        status: 'complete'
      }
    });
    assert.equal(foreignHello.body.ok, false);
    assert.equal(foreignHello.body.error.foreignBridgeIgnored, true);

    const ignoredUpdate = await postJson(baseUrl, 'extension.activeTabUpdated', {
      bridgeInstanceId: 'bridge_real',
      activeTab: {
        id: 99,
        windowId: 9,
        url: 'https://x.com/home',
        title: 'Real Browser',
        status: 'complete'
      }
    });
    assert.equal(ignoredUpdate.body.ok, true);
    assert.equal(ignoredUpdate.body.result.ignored, true);

    await postJson(baseUrl, 'operator.approveDomain', { origin: 'http://127.0.0.1:18180' });
    await postJson(baseUrl, 'extension.hostPermissionGranted', {
      bridgeInstanceId: 'bridge_smoke',
      origin: 'http://127.0.0.1:18180'
    });

    const observePromise = postJson(baseUrl, 'page.observe', {
      origin: 'http://127.0.0.1:18180'
    });

    const legacyPoll = await postJson(baseUrl, 'bridge.poll');
    assert.equal(legacyPoll.body.ok, true);
    assert.equal(legacyPoll.body.result.command, null);
    assert.equal(legacyPoll.body.result.ignored, true);

    const foreignPoll = await postJson(baseUrl, 'bridge.poll', {
      bridgeInstanceId: 'bridge_real'
    });
    assert.equal(foreignPoll.body.ok, true);
    assert.equal(foreignPoll.body.result.command, null);
    assert.equal(foreignPoll.body.result.ignored, true);

    const smokePoll = await postJson(baseUrl, 'bridge.poll', {
      bridgeInstanceId: 'bridge_smoke'
    });
    assert.equal(smokePoll.body.ok, true);
    assert.equal(smokePoll.body.result.command.method, 'page.observe');

    const foreignDeliver = await postJson(baseUrl, 'bridge.deliver', {
      bridgeInstanceId: 'bridge_real',
      commandId: smokePoll.body.result.command.commandId,
      response: {
        ok: false,
        error: {
          code: 'DOMAIN_NOT_APPROVED',
          message: 'Wrong browser.'
        }
      }
    });
    assert.equal(foreignDeliver.body.ok, false);
    assert.equal(foreignDeliver.body.error.code, ERROR_CODES.EXTENSION_DISCONNECTED);

    await postJson(baseUrl, 'bridge.deliver', {
      bridgeInstanceId: 'bridge_smoke',
      commandId: smokePoll.body.result.command.commandId,
      activeTab: {
        id: 7,
        windowId: 2,
        url: 'http://127.0.0.1:18180/basic-form.html',
        title: 'Smoke Fixture',
        status: 'complete'
      },
      response: {
        ok: true,
        result: {
          origin: 'http://127.0.0.1:18180',
          title: 'Smoke Fixture',
          elements: []
        }
      }
    });

    const observed = await observePromise;
    assert.equal(observed.body.ok, true);
    assert.equal(observed.body.result.title, 'Smoke Fixture');

    const status = await postJson(baseUrl, 'operator.status');
    assert.equal(status.body.result.activeTab.origin, 'http://127.0.0.1:18180');
    assert.equal(status.body.result.activeTab.title, 'Smoke Fixture');
  });
});

test('operator-cli disconnect can simulate reconnect while bridge ownership is set', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await postJson(baseUrl, 'extension.hello', {
      bridgeInstanceId: 'bridge_smoke',
      hello: verifiedHello()
    });

    const disconnected = await postJson(baseUrl, 'bridge.disconnected', {
      source: 'operator-cli',
      reason: 'unit simulated disconnect'
    });

    assert.equal(disconnected.body.ok, true);
    assert.equal(disconnected.body.result.connectionState, 'RECONNECTING');
  });
});

test('operator.fullAuto.start validates and exposes bounded session status', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await connectAndAuthorize(baseUrl);

    const contract = boundedFullAutoContract({
      limits: {
        expiresInMinutes: 30,
        maxBrowserActions: 2,
        maxScreenshots: 1,
        maxOriginChanges: 0
      }
    });
    const started = await postJson(baseUrl, 'operator.fullAuto.start', { contract });

    assert.equal(started.status, 200);
    assert.equal(started.body.ok, true);
    assert.equal(started.body.result.active, true);
    assert.equal(started.body.result.contract.taskScope, 'unit bounded task');
    assert.equal(started.body.result.counters.browserActions, 0);

    const status = await postJson(baseUrl, 'operator.status');
    assert.equal(status.body.result.boundedFullAuto.active, true);
    assert.equal(status.body.result.boundedFullAuto.contract.mode, 'bounded-full-auto-v1');
    assert.equal(status.body.result.boundedFullAuto.counters.screenshots, 0);
  });
});

test('bounded full auto enforces action and browser limits', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await connectAndAuthorize(baseUrl);
    await postJson(baseUrl, 'operator.fullAuto.start', {
      contract: boundedFullAutoContract({
        allowedActionKinds: ['observe'],
        limits: {
          expiresInMinutes: 30,
          maxBrowserActions: 1,
          maxScreenshots: 0,
          maxOriginChanges: 0
        }
      })
    });

    const disallowed = await postJson(baseUrl, 'page.click', {
      origin: 'https://example.com',
      handle: 'el_1'
    });
    assert.equal(disallowed.body.ok, false);
    assert.equal(disallowed.body.error.code, ERROR_CODES.BOUNDED_FULL_AUTO_ACTION_NOT_ALLOWED);

    const observePromise = postJson(baseUrl, 'page.observe', {
      origin: 'https://example.com'
    });
    const command = await deliverNextCommand(baseUrl, {
      ok: true,
      result: {
        origin: 'https://example.com',
        title: 'Bounded',
        elements: []
      }
    });
    assert.equal(command.method, 'page.observe');
    const observed = await observePromise;
    assert.equal(observed.body.ok, true);
    assert.equal(observed.body.result.title, 'Bounded');

    const limited = await postJson(baseUrl, 'page.observe', {
      origin: 'https://example.com'
    });
    assert.equal(limited.body.ok, false);
    assert.equal(limited.body.error.code, ERROR_CODES.BOUNDED_FULL_AUTO_LIMIT_EXCEEDED);

    await postJson(baseUrl, 'operator.fullAuto.start', {
      contract: boundedFullAutoContract({
        allowedActionKinds: ['screenshot'],
        limits: {
          expiresInMinutes: 30,
          maxBrowserActions: 5,
          maxScreenshots: 0,
          maxOriginChanges: 0
        }
      })
    });
    const screenshotLimited = await postJson(baseUrl, 'page.visualObserve', {
      origin: 'https://example.com'
    });
    assert.equal(screenshotLimited.body.ok, false);
    assert.equal(screenshotLimited.body.error.code, ERROR_CODES.BOUNDED_FULL_AUTO_LIMIT_EXCEEDED);
  });
});

test('bounded full auto blocks out-of-scope and expired sessions', async () => {
  await withServer(makeSession(), async (baseUrl, session) => {
    await connectAndAuthorize(baseUrl);
    await postJson(baseUrl, 'operator.approveDomain', {
      origin: 'https://other.example'
    });
    await postJson(baseUrl, 'extension.hostPermissionGranted', {
      origin: 'https://other.example'
    });
    await postJson(baseUrl, 'operator.fullAuto.start', {
      contract: boundedFullAutoContract()
    });

    const outOfScope = await postJson(baseUrl, 'page.observe', {
      origin: 'https://other.example'
    });
    assert.equal(outOfScope.body.ok, false);
    assert.equal(outOfScope.body.error.code, ERROR_CODES.BOUNDED_FULL_AUTO_SCOPE_MISMATCH);

    session.boundedFullAuto.expiresAt = new Date(Date.now() - 1000).toISOString();
    const expired = await postJson(baseUrl, 'page.observe', {
      origin: 'https://example.com'
    });
    assert.equal(expired.body.ok, false);
    assert.equal(expired.body.error.code, ERROR_CODES.BOUNDED_FULL_AUTO_EXPIRED);
  });
});

test('operator.audit.tail exposes bounded full-auto action summaries', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await connectAndAuthorize(baseUrl);
    await postJson(baseUrl, 'operator.fullAuto.start', {
      contract: boundedFullAutoContract({
        allowedActionKinds: ['observe'],
        limits: {
          expiresInMinutes: 30,
          maxBrowserActions: 1,
          maxScreenshots: 0,
          maxOriginChanges: 0
        }
      })
    });

    const observePromise = postJson(baseUrl, 'page.observe', {
      origin: 'https://example.com'
    });
    await deliverNextCommand(baseUrl, {
      ok: true,
      result: {
        origin: 'https://example.com',
        title: 'Audited',
        elements: []
      }
    });
    await observePromise;
    await postJson(baseUrl, 'page.observe', {
      origin: 'https://example.com'
    });

    const tail = await postJson(baseUrl, 'operator.audit.tail', { limit: 20 });
    assert.equal(tail.body.ok, true);
    assert.match(tail.body.result.auditLogPath, /audit\.jsonl$/);

    const entries = tail.body.result.entries;
    const startEntry = entries.find((entry) => entry.method === 'operator.fullAuto.start');
    assert.equal(startEntry.mode, 'bounded-full-auto-v1');
    assert.equal(startEntry.boundedFullAuto.taskScope, 'unit bounded task');
    assert.deepEqual(startEntry.boundedFullAuto.approvedOrigins, ['https://example.com']);

    const actionEntry = entries.find((entry) => entry.method === 'page.observe' && entry.result === 'ok');
    assert.equal(actionEntry.mode, 'bounded-full-auto-v1');
    assert.equal(actionEntry.origin, 'https://example.com');
    assert.equal(actionEntry.actionKind, 'observe');
    assert.equal(actionEntry.boundedFullAuto.counters.browserActions, 1);

    const limitEntry = entries.find((entry) => entry.errorCode === ERROR_CODES.BOUNDED_FULL_AUTO_LIMIT_EXCEEDED);
    assert.equal(limitEntry.mode, 'bounded-full-auto-v1');
    assert.equal(limitEntry.actionKind, 'observe');
    assert.equal(limitEntry.boundedFullAuto.counters.browserActions, 1);
  });
});

test('extension.hello connects without requiring profile binding', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    const result = await postJson(baseUrl, 'extension.hello', {
      hello: {
        type: 'HELLO',
        protocolVersion: '1.0',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        extensionVersion: '0.2.8',
        bridgeVersion: '0.2.8',
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
    assert.equal(result.body.result.profileBindingStatus, 'not-required');

    const status = await postJson(baseUrl, 'operator.status');
    assert.equal(status.body.result.connectionState, 'EXTENSION_CONNECTED');
    assert.equal(status.body.result.profileVerified, true);
  });
});

test('extension.hello accepts unbound legacy state and unlocks guarded page work', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    const result = await postJson(baseUrl, 'extension.hello', {
      hello: {
        type: 'HELLO',
        protocolVersion: '1.0',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        extensionVersion: '0.2.8',
        bridgeVersion: '0.2.8',
        sessionBootstrapId: 'boot_setup',
        profileBindingState: 'missing',
        profileBindingSource: 'chrome.storage.local',
        capabilities: ['observe.v1']
      }
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.result.connectionState, 'EXTENSION_CONNECTED');
    assert.equal(result.body.result.profileBindingStatus, 'not-required');

    await postJson(baseUrl, 'operator.approveDomain', {
      origin: 'https://example.com'
    });
    await postJson(baseUrl, 'extension.hostPermissionGranted', {
      origin: 'https://example.com'
    });

    const readiness = await postJson(baseUrl, 'operator.verifyReadiness', {
      origin: 'https://example.com'
    });
    assert.equal(readiness.body.ok, true);
    assert.equal(readiness.body.result.ready, true);

    const status = await postJson(baseUrl, 'operator.status');
    assert.equal(status.body.result.profileVerified, true);
    assert.equal(status.body.result.profileBindingStatus, 'not-required');
  });
});

test('extension.hello rejects daemon extension bridge version mismatch', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    const result = await postJson(baseUrl, 'extension.hello', {
      hello: {
        type: 'HELLO',
        protocolVersion: '1.0',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        extensionVersion: '0.3.0',
        bridgeVersion: '0.2.8',
        sessionBootstrapId: 'boot_abc',
        profileBindingState: 'bound',
        profileBindingId: 'profbind_8Qw3z6NqfK2p9xV1',
        profileBindingVersion: 3,
        profileBindingSource: 'chrome.storage.local',
        capabilities: ['observe.v1']
      }
    });

    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, ERROR_CODES.EXTENSION_VERSION_MISMATCH);

    const status = await postJson(baseUrl, 'operator.status');
    assert.equal(status.body.result.connectionState, 'DAEMON_RUNNING_EXTENSION_DISCONNECTED');
    assert.equal(status.body.result.version.protocolVersion, '1.0');
    assert.equal(status.body.result.version.extensionVersion, '0.2.8');
    assert.equal(status.body.result.version.bridgeVersion, '0.2.8');
    assert.equal(status.body.result.version.lastMismatch.code, ERROR_CODES.EXTENSION_VERSION_MISMATCH);
    assert.equal(status.body.result.version.lastMismatch.expectedExtensionVersion, '0.2.8');
    assert.equal(status.body.result.version.lastMismatch.actualExtensionVersion, '0.3.0');
  });
});

test('page.observe queues once profile and domain are ready without per-site host permission', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await postJson(baseUrl, 'extension.hello', {
      hello: {
        type: 'HELLO',
        protocolVersion: '1.0',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        extensionVersion: '0.2.8',
        bridgeVersion: '0.2.8',
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

    const observePromise = postJson(baseUrl, 'page.observe', {
      origin: 'https://example.com'
    });

    const command = await deliverNextCommand(baseUrl, {
      ok: true,
      result: {
        title: 'Example',
        url: 'https://example.com/'
      }
    });
    assert.equal(command.method, 'page.observe');
    assert.equal(command.params.origin, 'https://example.com');

    const result = await observePromise;
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.result.title, 'Example');
  });
});

test('page.observe forwards compact observation options to the extension command', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await connectAndAuthorize(baseUrl);

    const observePromise = postJson(baseUrl, 'page.observe', {
      origin: 'https://example.com',
      mode: 'medium',
      maxActionableHandles: 18,
      summaryMaxChars: 500,
      sincePageStateId: 'state_previous'
    });

    const command = await deliverNextCommand(baseUrl, {
      ok: true,
      result: {
        title: 'Medium',
        url: 'https://example.com/path'
      }
    });
    assert.equal(command.method, 'page.observe');
    assert.deepEqual(command.params, {
      origin: 'https://example.com',
      mode: 'medium',
      maxActionableHandles: 18,
      summaryMaxChars: 500,
      sincePageStateId: 'state_previous'
    });

    const result = await observePromise;
    assert.equal(result.body.ok, true);
    assert.equal(result.body.result.title, 'Medium');
  });
});

test('page.extract queues read-only intent extraction for approved origins', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await connectAndAuthorize(baseUrl);

    const extractPromise = postJson(baseUrl, 'page.extract', {
      origin: 'https://example.com',
      intent: 'shopping.productCandidates',
      maxCandidates: 5
    });

    const command = await deliverNextCommand(baseUrl, {
      ok: true,
      result: {
        intent: 'shopping.productCandidates',
        status: 'ok',
        origin: 'https://example.com',
        productCandidates: []
      }
    });
    assert.equal(command.method, 'page.extract');
    assert.deepEqual(command.params, {
      origin: 'https://example.com',
      intent: 'shopping.productCandidates',
      maxCandidates: 5
    });

    const result = await extractPromise;
    assert.equal(result.body.ok, true);
    assert.equal(result.body.result.intent, 'shopping.productCandidates');
  });
});

test('page.batch queues a single extension command for low-risk multi-step browser work', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await connectAndAuthorize(baseUrl);

    const batchPromise = postJson(baseUrl, 'page.batch', {
      origin: 'https://example.com',
      stopOnError: true,
      actions: [{
        action: 'observe',
        sincePageStateId: 'state_previous',
        maxActionableHandles: 10
      }, {
        action: 'readPage',
        filter: 'interactive',
        maxChars: 12000
      }, {
        action: 'fill',
        handle: 'el_state_0',
        text: 'Draft',
        postActionSnapshot: 'delta',
        sincePageStateId: 'state_previous'
      }, {
        action: 'pressKey',
        handle: 'el_state_0',
        key: 'Enter'
      }]
    });

    const command = await deliverNextCommand(baseUrl, {
      ok: true,
      result: {
        origin: 'https://example.com',
        results: [
          { ok: true, result: { action: 'observe', title: 'Example' } },
          { ok: true, result: { action: 'readPage', pageContent: 'textbox "Draft" [el_state_0]' } },
          { ok: true, result: { action: 'filled' } },
          { ok: true, result: { action: 'key-pressed', key: 'Enter' } }
        ],
        stoppedOnError: false
      }
    });
    assert.equal(command.method, 'page.batch');
    assert.equal(command.params.origin, 'https://example.com');
    assert.deepEqual(command.params.actions.map((action) => action.action), ['observe', 'readPage', 'fill', 'pressKey']);
    assert.equal(command.params.actions[0].sincePageStateId, 'state_previous');
    assert.equal(command.params.actions[0].maxActionableHandles, 10);
    assert.equal(command.params.actions[2].postActionSnapshot, 'delta');
    assert.equal(command.params.actions[2].sincePageStateId, 'state_previous');

    const result = await batchPromise;
    assert.equal(result.body.ok, true);
    assert.equal(result.body.result.results.length, 4);
    assert.equal(result.body.result.stoppedOnError, false);
  });
});

test('page.type fails closed for user blocked sites before queueing browser work', async () => {
  await withServer(makeSession(), async (baseUrl, session) => {
    await postJson(baseUrl, 'extension.hello', {
      hello: verifiedHello(['observe.v1'])
    });
    await postJson(baseUrl, 'operator.approveDomain', {
      origin: 'https://bank.example'
    });
    await postJson(baseUrl, 'extension.blockedOriginsSynced', {
      blockedOrigins: ['bank.example']
    });

    const result = await postJson(baseUrl, 'page.type', {
      origin: 'https://bank.example',
      handle: 'el_1',
      text: 'super secret typed text'
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, ERROR_CODES.SITE_BLOCKED_BY_USER_SETTINGS);
    assert.equal(result.body.error.blockedPattern, 'bank.example');
    assert.equal(session.pendingCommands.size, 0);

    const status = await postJson(baseUrl, 'operator.status');
    const failureEvent = status.body.result.recentEvents.find((event) => (
      event.type === 'pageCommandFailed' && event.method === 'page.type'
    ));
    assert.equal(failureEvent.errorCode, ERROR_CODES.SITE_BLOCKED_BY_USER_SETTINGS);
    assert.equal(JSON.stringify(failureEvent).includes('super secret typed text'), false);
  });
});

test('page.visualObserve queues once profile and domain are ready without per-site host permission', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await postJson(baseUrl, 'extension.hello', {
      hello: {
        type: 'HELLO',
        protocolVersion: '1.0',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        extensionVersion: '0.2.8',
        bridgeVersion: '0.2.8',
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

    const observePromise = postJson(baseUrl, 'page.visualObserve', {
      origin: 'https://example.com'
    });

    const command = await deliverNextCommand(baseUrl, {
      ok: true,
      result: {
        title: 'Visual',
        url: 'https://example.com/',
        screenshot: {
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,aGVsbG8=',
          bytesApprox: 5
        }
      }
    });
    assert.equal(command.method, 'page.visualObserve');
    assert.equal(command.params.origin, 'https://example.com');

    const result = await observePromise;
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.result.title, 'Visual');
  });
});

test('page.observe queues extension command and resolves from bridge delivery', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await postJson(baseUrl, 'extension.hello', {
      hello: {
        type: 'HELLO',
        protocolVersion: '1.0',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        extensionVersion: '0.2.8',
        bridgeVersion: '0.2.8',
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
      activeTab: {
        id: 3,
        windowId: 1,
        url: 'https://example.com/basic',
        title: 'Fixture',
        status: 'complete'
      },
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

    const status = await postJson(baseUrl, 'operator.status');
    assert.equal(status.body.result.activeTab.url, 'https://example.com/basic');
    assert.equal(status.body.result.activeTab.loadingState, 'complete');
  });
});

test('bridge.poll wait mode resolves immediately when a command is queued', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await connectAndAuthorize(baseUrl);

    const pollPromise = postJson(baseUrl, 'bridge.poll', {
      wait: true,
      timeoutMs: 1000
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    const observePromise = postJson(baseUrl, 'page.observe', {
      origin: 'https://example.com'
    });

    const command = await pollPromise;
    assert.equal(command.body.ok, true);
    assert.equal(command.body.result.command.method, 'page.observe');
    assert.equal(command.body.result.command.params.origin, 'https://example.com');

    await postJson(baseUrl, 'bridge.deliver', {
      commandId: command.body.result.command.commandId,
      response: {
        ok: true,
        result: {
          origin: 'https://example.com',
          title: 'Long poll delivered'
        }
      }
    });

    const result = await observePromise;
    assert.equal(result.body.ok, true);
    assert.equal(result.body.result.title, 'Long poll delivered');
  });
});

test('page.waitFor queues extension command and resolves condition result', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await connectAndAuthorize(baseUrl);

    const waitPromise = postJson(baseUrl, 'page.waitFor', {
      origin: 'https://example.com',
      condition: {
        type: 'textVisible',
        text: 'Draft saved'
      },
      timeoutMs: 750,
      pollIntervalMs: 50
    });

    const command = await postJson(baseUrl, 'bridge.poll');
    assert.equal(command.body.ok, true);
    assert.equal(command.body.result.command.method, 'page.waitFor');
    assert.equal(command.body.result.command.params.origin, 'https://example.com');
    assert.equal(command.body.result.command.params.condition.type, 'textVisible');
    assert.equal(command.body.result.command.params.timeoutMs, 750);

    await postJson(baseUrl, 'bridge.deliver', {
      commandId: command.body.result.command.commandId,
      response: {
        ok: true,
        result: {
          action: 'waited',
          condition: { type: 'textVisible', text: 'Draft saved' },
          elapsedMs: 50,
          finalState: { satisfied: true }
        }
      }
    });

    const result = await waitPromise;
    assert.equal(result.body.ok, true);
    assert.equal(result.body.result.action, 'waited');
    assert.equal(result.body.result.condition.type, 'textVisible');
    assert.equal(result.body.result.elapsedMs, 50);
  });
});

test('page.navigate rejects unsupported schemes before queueing browser work', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await connectAndAuthorize(baseUrl);

    const result = await postJson(baseUrl, 'page.navigate', {
      url: 'file:///C:/Users/example/secret.txt'
    });

    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, ERROR_CODES.UNSUPPORTED_SCHEME);

    const command = await postJson(baseUrl, 'bridge.poll');
    assert.equal(command.body.ok, true);
    assert.equal(command.body.result.command, null);
  });
});

test('page.navigate revokes previous origin approval after an origin change', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await connectAndAuthorize(baseUrl, 'https://example.com');
    await postJson(baseUrl, 'extension.activeTabUpdated', {
      activeTab: {
        id: 9,
        windowId: 2,
        url: 'https://example.com/start',
        title: 'Start',
        status: 'complete'
      }
    });
    await postJson(baseUrl, 'operator.approveDomain', {
      origin: 'https://next.example'
    });
    await postJson(baseUrl, 'extension.hostPermissionGranted', {
      origin: 'https://next.example'
    });

    const navigatePromise = postJson(baseUrl, 'page.navigate', {
      url: 'https://next.example/path'
    });
    const command = await postJson(baseUrl, 'bridge.poll');
    assert.equal(command.body.ok, true);
    assert.equal(command.body.result.command.method, 'page.navigate');

    await postJson(baseUrl, 'bridge.deliver', {
      commandId: command.body.result.command.commandId,
      activeTab: {
        id: 9,
        windowId: 2,
        url: 'https://next.example/path',
        title: 'Next',
        status: 'complete'
      },
      response: {
        ok: true,
        result: {
          action: 'navigate',
          url: 'https://next.example/path'
        }
      }
    });

    const result = await navigatePromise;
    assert.equal(result.body.ok, true);
    assert.deepEqual(result.body.result.navigationOriginChange, {
      from: 'https://example.com',
      to: 'https://next.example',
      previousApprovalRevoked: true
    });

    const status = await postJson(baseUrl, 'operator.status');
    assert.equal(status.body.result.approvedOrigins.includes('https://example.com'), false);
    assert.equal(status.body.result.approvedOrigins.includes('https://next.example'), true);
  });
});

test('page.visualObserve queues extension command and resolves from bridge delivery', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await postJson(baseUrl, 'extension.hello', {
      hello: {
        type: 'HELLO',
        protocolVersion: '1.0',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        extensionVersion: '0.2.8',
        bridgeVersion: '0.2.8',
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
    assert.match(result.body.result.screenshot.artifactId, /^shot_/);
    assert.match(result.body.result.screenshot.sha256, /^[a-f0-9]{64}$/);
    assert.equal(Object.prototype.hasOwnProperty.call(result.body.result.screenshot, 'dataUrl'), false);
    assert.equal(fs.existsSync(result.body.result.screenshot.path), true);
  });
});

test('page.visualAnalyze stores screenshot artifact and returns local-basic analysis', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await connectAndAuthorize(baseUrl);

    const analyzePromise = postJson(baseUrl, 'page.visualAnalyze', {
      origin: 'https://example.com',
      provider: 'local-basic',
      policy: {
        maxBytes: 4096
      }
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
          title: 'Visual Cards Fixture',
          visibleTextSummary: 'Product Alpha Seller rating 4.5 of 5',
          viewport: {
            width: 1280,
            height: 900,
            devicePixelRatio: 1
          },
          screenshot: {
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,abc',
            width: 1280,
            height: 900
          },
          elements: [
            {
              handle: 'el_0',
              tag: 'article',
              label: 'Product Alpha',
              visualRole: 'product-card',
              productId: 'alpha',
              bbox: { x: 40, y: 80, width: 320, height: 220 }
            },
            {
              handle: 'el_1',
              tag: 'span',
              label: 'Seller rating 4.5 of 5',
              visualRole: 'rating-stars',
              ratingValue: 4.5,
              bbox: { x: 80, y: 170, width: 120, height: 24 }
            }
          ]
        }
      }
    });

    const result = await analyzePromise;
    assert.equal(result.body.ok, true);
    assert.equal(result.body.result.visual.provider, 'chrome.tabs.captureVisibleTab');
    assert.equal(result.body.result.visual.analysis.provider, 'local-basic');
    assert.equal(result.body.result.visual.analysis.status, 'analyzed');
    assert.equal(result.body.result.visual.analysis.artifactId, result.body.result.screenshot.artifactId);
    assert.deepEqual(result.body.result.visual.analysis.regions.map((region) => region.kind), [
      'product-card',
      'rating-stars'
    ]);
    assert.equal(result.body.result.visual.analysis.handleCorrelations.length, 2);
    assert.equal(result.body.result.screenshot.dataUrl, undefined);
    assert.equal(fs.existsSync(result.body.result.screenshot.path), true);
  });
});

test('page.visualAnalyze blocks sensitive visual observations before provider analysis', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await connectAndAuthorize(baseUrl);

    const analyzePromise = postJson(baseUrl, 'page.visualAnalyze', {
      origin: 'https://example.com'
    });
    const command = await postJson(baseUrl, 'bridge.poll');
    await postJson(baseUrl, 'bridge.deliver', {
      commandId: command.body.result.command.commandId,
      response: {
        ok: true,
        result: {
          origin: 'https://example.com',
          sensitiveVisualContent: true,
          screenshot: {
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,abc'
          },
          elements: []
        }
      }
    });

    const result = await analyzePromise;
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, ERROR_CODES.VISUAL_PROVIDER_POLICY_BLOCKED);
    assert.equal(result.body.error.reason, 'SENSITIVE_VISUAL_CONTENT');
  });
});

test('operator.screenshots.cleanup removes stored visual artifacts', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await postJson(baseUrl, 'extension.hello', {
      hello: {
        type: 'HELLO',
        protocolVersion: '1.0',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        extensionVersion: '0.2.8',
        bridgeVersion: '0.2.8',
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
      origin: 'https://example.com',
      mode: 'medium',
      maxActionableHandles: 12,
      summaryMaxChars: 400,
      maxBytes: 128000,
      reason: 'DOM confidence low around checkout affordance'
    });
    const command = await postJson(baseUrl, 'bridge.poll');
    assert.equal(command.body.result.command.method, 'page.visualObserve');
    assert.deepEqual(command.body.result.command.params, {
      origin: 'https://example.com',
      mode: 'medium',
      maxActionableHandles: 12,
      summaryMaxChars: 400,
      maxBytes: 128000,
      reason: 'DOM confidence low around checkout affordance'
    });
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
    const artifactPath = result.body.result.screenshot.path;
    const metadata = JSON.parse(fs.readFileSync(result.body.result.screenshot.metadataPath, 'utf8'));
    assert.equal(fs.existsSync(artifactPath), true);
    assert.equal(result.body.result.screenshot.dataUrl, undefined);
    assert.equal(metadata.reason, 'DOM confidence low around checkout affordance');

    const cleanup = await postJson(baseUrl, 'operator.screenshots.cleanup', {
      olderThanMs: 0
    });

    assert.equal(cleanup.body.ok, true);
    assert.equal(cleanup.body.result.removed.length, 1);
    assert.equal(fs.existsSync(artifactPath), false);
  });
});

test('page.uploadFile rejects invalid assets before queueing browser work', async () => {
  const rawPath = 'C:\\Users\\example\\Pictures\\bad-feature.png';
  const session = makeSession({
    assetValidator: {
      validateUploadFiles(files, options) {
        assert.deepEqual(files, [{
          role: 'playStoreFeatureGraphic',
          path: rawPath
        }]);
        assert.equal(options.ruleset, 'googlePlayPreviewAssets.v2026');
        return {
          ok: false,
          error: {
            code: 'ASSET_DIMENSION_MISMATCH',
            message: 'Feature graphic must be 1024x500.',
            role: 'playStoreFeatureGraphic',
            basename: 'bad-feature.png'
          }
        };
      }
    }
  });

  await withServer(session, async (baseUrl) => {
    await connectAndAuthorize(baseUrl);

    const result = await postJson(baseUrl, 'page.uploadFile', {
      origin: 'https://example.com',
      target: { handle: 'el_upload_feature' },
      ruleset: 'googlePlayPreviewAssets.v2026',
      files: [{
        role: 'playStoreFeatureGraphic',
        path: rawPath
      }]
    });

    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, 'ASSET_DIMENSION_MISMATCH');
    assert.equal(session.pendingCommands.size, 0);

    const auditTail = await postJson(baseUrl, 'operator.audit.tail', { limit: 5 });
    assert.doesNotMatch(JSON.stringify(auditTail.body.result.entries), /C:\\\\Users\\\\example\\\\Pictures/);
    assert.match(JSON.stringify(auditTail.body.result.entries), /\[REDACTED_PATH:bad-feature\.png\]/);
  });
});

test('page.uploadFile queues redacted validated file metadata and returns upload verification', async () => {
  const rawPath = 'C:\\Users\\example\\Pictures\\icon.png';
  const validatedFile = {
    role: 'playStoreAppIcon',
    basename: 'icon.png',
    extension: '.png',
    mimeType: 'image/png',
    bytes: 2048,
    sha256: 'a'.repeat(64),
    width: 512,
    height: 512,
    hasAlpha: true,
    ruleset: 'googlePlayPreviewAssets.v2026'
  };
  const session = makeSession({
    assetValidator: {
      validateUploadFiles(files, options) {
        assert.equal(options.ruleset, 'googlePlayPreviewAssets.v2026');
        assert.equal(options.expectedOrigin, 'https://example.com');
        assert.equal(options.targetHandle, 'el_upload_icon');
        assert.equal(files[0].path, rawPath);
        return {
          ok: true,
          ruleset: 'googlePlayPreviewAssets.v2026',
          files: [validatedFile]
        };
      }
    }
  });

  await withServer(session, async (baseUrl) => {
    await connectAndAuthorize(baseUrl);

    const uploadPromise = postJson(baseUrl, 'page.uploadFile', {
      origin: 'https://example.com',
      target: { handle: 'el_upload_icon' },
      ruleset: 'googlePlayPreviewAssets.v2026',
      verifyPreview: true,
      files: [{
        role: 'playStoreAppIcon',
        path: rawPath,
        expectedSha256: 'a'.repeat(64)
      }]
    });

    const command = await postJson(baseUrl, 'bridge.poll');
    assert.equal(command.body.ok, true);
    assert.equal(command.body.result.command.method, 'page.uploadFile');
    assert.equal(command.body.result.command.params.origin, 'https://example.com');
    assert.deepEqual(command.body.result.command.params.target, { handle: 'el_upload_icon' });
    assert.equal(command.body.result.command.params.verifyPreview, true);
    assert.deepEqual(command.body.result.command.params.files, [validatedFile]);
    assert.equal(JSON.stringify(command.body.result.command.params).includes(rawPath), false);

    await postJson(baseUrl, 'bridge.deliver', {
      commandId: command.body.result.command.commandId,
      response: {
        ok: true,
        result: {
          action: 'uploaded',
          uploadTarget: 'el_upload_icon',
          previewVerified: true,
          validationMessages: ['App icon accepted'],
          files: [{
            role: 'playStoreAppIcon',
            basename: 'icon.png',
            sha256: 'a'.repeat(64)
          }]
        }
      }
    });

    const result = await uploadPromise;
    assert.equal(result.body.ok, true);
    assert.equal(result.body.result.action, 'uploaded');
    assert.deepEqual(result.body.result.assetValidation.files, [validatedFile]);
    assert.equal(result.body.result.previewVerified, true);
  });
});

test('page.prepareCart fails closed before domain approval is granted', async () => {
  await withServer(makeSession(), async (baseUrl, session) => {
    await postJson(baseUrl, 'extension.hello', {
      hello: verifiedHello(['observe.v1', 'cartPreparation.v1'])
    });

    const result = await postJson(baseUrl, 'page.prepareCart', {
      origin: 'http://127.0.0.1:18180',
      query: 'mac mini',
      criteria: {},
      cartActionAllowed: true
    });

    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, ERROR_CODES.DOMAIN_NOT_APPROVED);
    assert.equal(session.pendingCommands.size, 0);
  });
});

test('page.prepareCart rejects invalid params before queueing browser work', async () => {
  await withServer(makeSession(), async (baseUrl, session) => {
    await connectAndAuthorize(baseUrl, 'http://127.0.0.1:18180');

    const invalidRequests = [
      {
        origin: '',
        query: 'mac mini',
        criteria: {},
        cartActionAllowed: true
      },
      {
        origin: 'http://127.0.0.1:18180',
        query: '   ',
        criteria: {},
        cartActionAllowed: true
      },
      {
        origin: 'http://127.0.0.1:18180',
        query: 'mac mini',
        criteria: null,
        cartActionAllowed: true
      },
      {
        origin: 'http://127.0.0.1:18180',
        query: 'mac mini',
        criteria: {},
        cartActionAllowed: 'yes'
      }
    ];

    for (const params of invalidRequests) {
      const result = await postJson(baseUrl, 'page.prepareCart', params);
      assert.equal(result.body.ok, false);
      assert.equal(result.body.error.code, ERROR_CODES.INVALID_SCHEMA);
      assert.equal(session.pendingCommands.size, 0);
    }

    const emptyQueue = await postJson(baseUrl, 'bridge.poll');
    assert.equal(emptyQueue.body.result.command, null);
  });
});

test('page.prepareCart queues normalized cart params and returns verification evidence', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await connectAndAuthorize(baseUrl, 'http://127.0.0.1:18180');

    const preparePromise = postJson(baseUrl, 'page.prepareCart', {
      origin: 'http://127.0.0.1:18180',
      query: '  Mac mini M4  ',
      criteria: {
        maxPrice: 29999,
        currency: 'try',
        sort: 'price-asc'
      },
      cartActionAllowed: true
    });

    const command = await postJson(baseUrl, 'bridge.poll');
    assert.equal(command.body.ok, true);
    assert.equal(command.body.result.command.method, 'page.prepareCart');
    assert.deepEqual(command.body.result.command.params, {
      origin: 'http://127.0.0.1:18180',
      profileId: 'localTest.ecommerce.v1',
      query: 'Mac mini M4',
      criteria: {
        minSellerRating: 4,
        maxPrice: 29999,
        currency: 'try',
        sort: 'price-asc'
      },
      cartActionAllowed: true
    });

    await postJson(baseUrl, 'bridge.deliver', {
      commandId: command.body.result.command.commandId,
      response: {
        ok: true,
        result: {
          origin: 'http://127.0.0.1:18180',
          selected: {
            title: 'Mac mini M4',
            sellerRating: 4.8,
            price: 28999,
            currency: 'TRY'
          },
          cart: {
            verified: true,
            itemCount: 1,
            checkoutAttempted: false,
            paymentAttempted: false
          }
        }
      }
    });

    const result = await preparePromise;
    assert.equal(result.body.ok, true);
    assert.equal(result.body.result.selected.title, 'Mac mini M4');
    assert.equal(result.body.result.cart.verified, true);
    assert.equal(result.body.result.policy.actionKind, 'cart-preparation');
    assert.equal(result.body.result.policy.checkoutBlocked, true);
    assert.equal(result.body.result.policy.paymentBlocked, true);

    const auditTail = await postJson(baseUrl, 'operator.audit.tail', { limit: 10 });
    const cartEntry = auditTail.body.result.entries.find((entry) => entry.method === 'page.prepareCart');
    assert.equal(cartEntry.actionKind, 'cart-preparation');
    assert.equal(cartEntry.origin, 'http://127.0.0.1:18180');
    assert.equal(cartEntry.result, 'ok');
  });
});

test('bounded full auto allows explicitly listed cart preparation and blocks it otherwise', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await connectAndAuthorize(baseUrl, 'http://127.0.0.1:18180');

    await postJson(baseUrl, 'operator.fullAuto.start', {
      contract: boundedFullAutoContract({
        approvedOrigins: ['http://127.0.0.1:18180'],
        allowedActionKinds: ['observe', 'cart-preparation'],
        limits: {
          expiresInMinutes: 30,
          maxBrowserActions: 2,
          maxScreenshots: 0,
          maxOriginChanges: 0
        }
      })
    });

    const preparePromise = postJson(baseUrl, 'page.prepareCart', {
      origin: 'http://127.0.0.1:18180',
      profileId: 'localTest.ecommerce.v1',
      query: 'keyboard',
      criteria: { minSellerRating: 4.5 },
      cartActionAllowed: true
    });
    const command = await postJson(baseUrl, 'bridge.poll');
    assert.equal(command.body.result.command.method, 'page.prepareCart');
    assert.equal(command.body.result.command.params.criteria.minSellerRating, 4.5);
    await postJson(baseUrl, 'bridge.deliver', {
      commandId: command.body.result.command.commandId,
      response: {
        ok: true,
        result: {
          selected: { title: 'Keyboard' },
          cart: { verified: true }
        }
      }
    });
    const prepared = await preparePromise;
    assert.equal(prepared.body.ok, true);

    await postJson(baseUrl, 'operator.fullAuto.start', {
      contract: boundedFullAutoContract({
        approvedOrigins: ['http://127.0.0.1:18180'],
        allowedActionKinds: ['observe'],
        limits: {
          expiresInMinutes: 30,
          maxBrowserActions: 2,
          maxScreenshots: 0,
          maxOriginChanges: 0
        }
      })
    });

    const blocked = await postJson(baseUrl, 'page.prepareCart', {
      origin: 'http://127.0.0.1:18180',
      query: 'mouse',
      criteria: {},
      cartActionAllowed: true
    });
    assert.equal(blocked.body.ok, false);
    assert.equal(blocked.body.error.code, ERROR_CODES.BOUNDED_FULL_AUTO_ACTION_NOT_ALLOWED);
    assert.equal(blocked.body.error.actionKind, 'cart-preparation');
  });
});

test('page.prepareCart blocks disabled real-site profiles before queueing browser work', async () => {
  await withServer(makeSession(), async (baseUrl, session) => {
    await connectAndAuthorize(baseUrl, 'https://www.hepsiburada.com');

    const result = await postJson(baseUrl, 'page.prepareCart', {
      origin: 'https://www.hepsiburada.com',
      profileId: 'hepsiburada.shopping.v1',
      query: 'Mac mini',
      criteria: { minSellerRating: 4 },
      cartActionAllowed: true
    });

    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, ERROR_CODES.SITE_PROFILE_UNAVAILABLE);
    assert.equal(result.body.error.reason, 'REAL_SITE_PROFILE_DISABLED');
    assert.equal(session.pendingCommands.size, 0);
  });
});

test('page.prepareCart returns checkout policy errors without approval replay', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await connectAndAuthorize(baseUrl, 'http://127.0.0.1:18180');

    const preparePromise = postJson(baseUrl, 'page.prepareCart', {
      origin: 'http://127.0.0.1:18180',
      query: 'laptop',
      criteria: {},
      cartActionAllowed: true
    });
    const command = await postJson(baseUrl, 'bridge.poll');
    await postJson(baseUrl, 'bridge.deliver', {
      commandId: command.body.result.command.commandId,
      response: {
        ok: false,
        error: {
          code: ERROR_CODES.CHECKOUT_BLOCKED,
          message: 'Checkout is outside cart-preparation policy.',
          actionKind: 'checkout'
        }
      }
    });

    const blocked = await preparePromise;
    assert.equal(blocked.body.ok, false);
    assert.equal(blocked.body.error.code, ERROR_CODES.CHECKOUT_BLOCKED);
    assert.equal(blocked.body.error.approvalId, undefined);

    const approvals = await postJson(baseUrl, 'operator.approvals.list');
    assert.deepEqual(approvals.body.result.approvals, []);
  });
});

test('page.click checkout and payment policy errors remain blocked without approval replay', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await connectAndAuthorize(baseUrl, 'https://shop.example');

    const blockedActions = [
      {
        handle: 'checkout_button',
        error: {
          code: ERROR_CODES.CHECKOUT_BLOCKED,
          message: 'Checkout is outside cart-preparation policy.',
          actionKind: 'checkout'
        }
      },
      {
        handle: 'payment_button',
        error: {
          code: ERROR_CODES.PAYMENT_AUTH_REQUIRED,
          message: 'Payment authorization is outside cart-preparation policy.',
          actionKind: 'payment'
        }
      }
    ];

    for (const action of blockedActions) {
      const clickPromise = postJson(baseUrl, 'page.click', {
        origin: 'https://shop.example',
        handle: action.handle
      });
      const command = await postJson(baseUrl, 'bridge.poll');
      assert.equal(command.body.result.command.method, 'page.click');
      await postJson(baseUrl, 'bridge.deliver', {
        commandId: command.body.result.command.commandId,
        response: {
          ok: false,
          error: action.error
        }
      });

      const blocked = await clickPromise;
      assert.equal(blocked.body.ok, false);
      assert.equal(blocked.body.error.code, action.error.code);
      assert.equal(blocked.body.error.approvalId, undefined);
    }

    const approvals = await postJson(baseUrl, 'operator.approvals.list');
    assert.deepEqual(approvals.body.result.approvals, []);
  });
});

test('operator.emergencyStop cancels pending page actions and blocks new ones until cleared', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await postJson(baseUrl, 'extension.hello', {
      hello: {
        type: 'HELLO',
        protocolVersion: '1.0',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        extensionVersion: '0.2.8',
        bridgeVersion: '0.2.8',
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
    assert.equal(command.body.result.command.method, 'page.observe');

    const stopped = await postJson(baseUrl, 'operator.emergencyStop', {
      reason: 'unit test stop'
    });
    assert.equal(stopped.body.ok, true);
    assert.equal(stopped.body.result.active, true);
    assert.equal(stopped.body.result.cancelledPendingCommands, 1);

    const cancelled = await observePromise;
    assert.equal(cancelled.body.ok, false);
    assert.equal(cancelled.body.error.code, ERROR_CODES.EMERGENCY_STOPPED);

    const blocked = await postJson(baseUrl, 'page.observe', {
      origin: 'https://example.com'
    });
    assert.equal(blocked.body.ok, false);
    assert.equal(blocked.body.error.code, ERROR_CODES.EMERGENCY_STOPPED);

    const emptyQueue = await postJson(baseUrl, 'bridge.poll');
    assert.equal(emptyQueue.body.result.command, null);

    const status = await postJson(baseUrl, 'operator.status');
    assert.equal(status.body.result.emergencyStop.active, true);
    assert.equal(status.body.result.emergencyStop.reason, 'unit test stop');

    const cleared = await postJson(baseUrl, 'operator.emergencyClear');
    assert.equal(cleared.body.ok, true);
    assert.equal(cleared.body.result.active, false);

    const afterClearPromise = postJson(baseUrl, 'page.observe', {
      origin: 'https://example.com'
    });
    const afterClearCommand = await postJson(baseUrl, 'bridge.poll');
    assert.equal(afterClearCommand.body.result.command.method, 'page.observe');
    await postJson(baseUrl, 'bridge.deliver', {
      commandId: afterClearCommand.body.result.command.commandId,
      response: {
        ok: true,
        result: {
          origin: 'https://example.com',
          title: 'Recovered',
          elements: []
        }
      }
    });
    const afterClear = await afterClearPromise;
    assert.equal(afterClear.body.ok, true);
    assert.equal(afterClear.body.result.title, 'Recovered');
  });
});

test('extension disconnect cancels pending commands and reconnect requires a fresh hello', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    const hello = await postJson(baseUrl, 'extension.hello', {
      hello: {
        type: 'HELLO',
        protocolVersion: '1.0',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        extensionVersion: '0.2.8',
        bridgeVersion: '0.2.8',
        sessionBootstrapId: 'boot_abc',
        profileBindingState: 'bound',
        profileBindingId: 'profbind_8Qw3z6NqfK2p9xV1',
        profileBindingVersion: 3,
        profileBindingSource: 'chrome.storage.local',
        capabilities: ['observe.v1']
      }
    });
    const firstConnectionId = hello.body.result.connectionId;
    assert.match(firstConnectionId, /^conn_/);
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
    assert.equal(command.body.result.command.connectionId, firstConnectionId);

    const disconnected = await postJson(baseUrl, 'extension.disconnected', {
      source: 'native-port',
      reason: 'unit disconnect'
    });
    assert.equal(disconnected.body.ok, true);
    assert.equal(disconnected.body.result.connectionState, 'RECONNECTING');
    assert.equal(disconnected.body.result.cancelledPendingCommands, 1);

    const cancelled = await observePromise;
    assert.equal(cancelled.body.ok, false);
    assert.equal(cancelled.body.error.code, ERROR_CODES.EXTENSION_DISCONNECTED);

    const blocked = await postJson(baseUrl, 'page.observe', {
      origin: 'https://example.com'
    });
    assert.equal(blocked.body.ok, false);
    assert.equal(blocked.body.error.code, ERROR_CODES.EXTENSION_DISCONNECTED);

    const staleDeliver = await postJson(baseUrl, 'bridge.deliver', {
      commandId: command.body.result.command.commandId,
      connectionId: firstConnectionId,
      response: {
        ok: true,
        result: { title: 'too late' }
      }
    });
    assert.equal(staleDeliver.body.ok, false);
    assert.equal(staleDeliver.body.error.code, ERROR_CODES.EXTENSION_DISCONNECTED);

    const reconnect = await postJson(baseUrl, 'extension.hello', {
      hello: {
        type: 'HELLO',
        protocolVersion: '1.0',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        extensionVersion: '0.2.8',
        bridgeVersion: '0.2.8',
        sessionBootstrapId: 'boot_def',
        profileBindingState: 'bound',
        profileBindingId: 'profbind_8Qw3z6NqfK2p9xV1',
        profileBindingVersion: 3,
        profileBindingSource: 'chrome.storage.local',
        capabilities: ['observe.v1']
      }
    });
    assert.equal(reconnect.body.ok, true);
    assert.notEqual(reconnect.body.result.connectionId, firstConnectionId);
    assert.equal(reconnect.body.result.connectionState, 'EXTENSION_CONNECTED');
  });
});

test('successful page command clears stale lastError', async () => {
  await withServer(makeSession(), async (baseUrl) => {
    await postJson(baseUrl, 'extension.hello', {
      hello: {
        type: 'HELLO',
        protocolVersion: '1.0',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        extensionVersion: '0.2.8',
        bridgeVersion: '0.2.8',
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
    await postJson(baseUrl, 'extension.blockedOriginsSynced', {
      blockedOrigins: ['example.com']
    });

    const failClosed = await postJson(baseUrl, 'page.observe', {
      origin: 'https://example.com'
    });
    assert.equal(failClosed.body.ok, false);
    assert.equal(failClosed.body.error.code, ERROR_CODES.SITE_BLOCKED_BY_USER_SETTINGS);

    const statusAfterError = await postJson(baseUrl, 'operator.status');
    assert.equal(statusAfterError.body.result.lastError.code, ERROR_CODES.SITE_BLOCKED_BY_USER_SETTINGS);

    await postJson(baseUrl, 'extension.blockedOriginsSynced', {
      blockedOrigins: []
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
        extensionVersion: '0.2.8',
        bridgeVersion: '0.2.8',
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
        extensionVersion: '0.2.8',
        bridgeVersion: '0.2.8',
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
        extensionVersion: '0.2.8',
        bridgeVersion: '0.2.8',
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
