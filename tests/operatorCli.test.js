const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildRpcRequest,
  ensureStarted,
  resolveCliSettings
} = require('../scripts/operator-cli');

test('buildRpcRequest maps status to operator.status', () => {
  assert.deepEqual(buildRpcRequest(['status']), {
    method: 'operator.status',
    params: {}
  });
  assert.deepEqual(buildRpcRequest(['ensure-started']), {
    method: 'operator.ensureStarted',
    params: {}
  });
  assert.deepEqual(buildRpcRequest(['ensure-started', 'https://example.com/path']), {
    method: 'operator.ensureStarted',
    params: {
      origin: 'https://example.com'
    }
  });
});

test('ensureStarted starts daemon when the first RPC cannot connect', async () => {
  const calls = [];
  const response = await ensureStarted({
    request: {
      id: 'req_1',
      method: 'operator.ensureStarted',
      params: {}
    },
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'cli-token',
      installDir: 'C:/Operator'
    },
    openBootstrap: false,
    sendRpcFn: async () => {
      calls.push('send');
      if (calls.length === 1) {
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:19091'), { code: 'ECONNREFUSED' });
      }
      return {
        ok: true,
        result: {
          daemonRunning: true,
          bootstrapRequired: true,
          bootstrapUrl: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/bootstrap.html?session=boot'
        }
      };
    },
    startDaemonFn: () => {
      calls.push('start');
      return { pid: 1234 };
    },
    waitForDaemonFn: async ({ request, sendRpcFn }) => {
      calls.push('wait');
      return sendRpcFn({ request });
    }
  });

  assert.deepEqual(calls, ['send', 'start', 'wait', 'send']);
  assert.equal(response.ok, true);
  assert.equal(response.result.daemonStarted, true);
  assert.equal(response.result.daemonPid, 1234);
});

test('ensureStarted waits for extension connection after bootstrap launch', async () => {
  const bootstrapUrl = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/bootstrap.html?session=boot';
  const calls = [];
  const response = await ensureStarted({
    request: {
      id: 'req_2',
      method: 'operator.ensureStarted',
      params: {}
    },
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'cli-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async () => {
      calls.push('send');
      return {
        ok: true,
        result: {
          daemonRunning: true,
          extensionConnected: false,
          bootstrapRequired: true,
          bootstrapUrl
        }
      };
    },
    launchBootstrapFn: ({ bootstrapUrl }) => {
      calls.push(`launch:${bootstrapUrl}`);
      return {
        attempted: true,
        launched: true,
        pid: 4321,
        bootstrapUrl
      };
    },
    waitForExtensionConnectionFn: async ({ request }) => {
      calls.push(`wait:${request.method}`);
      return {
        ok: true,
        result: {
          daemonRunning: true,
          extensionConnected: true,
          bootstrapRequired: false,
          status: {
            connectionState: 'EXTENSION_CONNECTED'
          }
        }
      };
    }
  });

  assert.deepEqual(calls, [
    'send',
    `launch:${bootstrapUrl}`,
    'wait:operator.ensureStarted'
  ]);
  assert.equal(response.ok, true);
  assert.equal(response.result.extensionConnected, true);
  assert.equal(response.result.bootstrapRequired, false);
  assert.equal(response.result.bootstrapLaunch.pid, 4321);
  assert.equal(response.result.extensionWait.attempted, true);
  assert.equal(response.result.extensionWait.connected, true);
});

test('ensureStarted reports diagnostic steps when extension wait times out', async () => {
  const bootstrapUrl = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/bootstrap.html?session=boot';
  const response = await ensureStarted({
    request: {
      id: 'req_3',
      method: 'operator.ensureStarted',
      params: {}
    },
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'cli-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async () => ({
      ok: true,
      result: {
        daemonRunning: true,
        extensionConnected: false,
        bootstrapRequired: true,
        bootstrapUrl
      }
    }),
    launchBootstrapFn: ({ bootstrapUrl }) => ({
      attempted: true,
      launched: true,
      pid: 4321,
      bootstrapUrl
    }),
    waitForExtensionConnectionFn: async () => ({
      ok: true,
      result: {
        daemonRunning: true,
        extensionConnected: false,
        bootstrapRequired: true,
        bootstrapUrl,
        extensionWait: {
          attempted: true,
          connected: false,
          attempts: 3,
          timeoutMs: 750
        },
        status: {
          connectionState: 'DAEMON_RUNNING_EXTENSION_DISCONNECTED'
        }
      }
    })
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.extensionConnected, false);
  assert.equal(response.result.diagnostic.code, 'EXTENSION_WAIT_TIMEOUT');
  assert.match(response.result.diagnostic.message, /extension did not connect/i);
  assert.equal(response.result.diagnostic.bootstrapUrl, bootstrapUrl);
  assert.ok(response.result.diagnostic.nextSteps.includes('Open the bootstrapUrl manually in the configured Chrome profile.'));
});

test('ensureStarted reports diagnostic steps when bootstrap launch fails', async () => {
  const bootstrapUrl = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/bootstrap.html?session=boot';
  const calls = [];
  const response = await ensureStarted({
    request: {
      id: 'req_4',
      method: 'operator.ensureStarted',
      params: {}
    },
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'cli-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async () => ({
      ok: true,
      result: {
        daemonRunning: true,
        extensionConnected: false,
        bootstrapRequired: true,
        bootstrapUrl
      }
    }),
    launchBootstrapFn: () => {
      calls.push('launch');
      return {
        attempted: true,
        launched: false,
        error: {
          code: 'CHROME_NOT_FOUND',
          message: 'Chrome executable was not found for bootstrap launch.'
        }
      };
    },
    waitForExtensionConnectionFn: async () => {
      calls.push('wait');
      return {
        ok: true,
        result: {}
      };
    }
  });

  assert.deepEqual(calls, ['launch']);
  assert.equal(response.ok, true);
  assert.equal(response.result.extensionWait.attempted, false);
  assert.equal(response.result.extensionWait.skippedReason, 'BOOTSTRAP_LAUNCH_FAILED');
  assert.equal(response.result.diagnostic.code, 'BOOTSTRAP_LAUNCH_FAILED');
  assert.equal(response.result.diagnostic.errorCode, 'CHROME_NOT_FOUND');
  assert.equal(response.result.diagnostic.bootstrapUrl, bootstrapUrl);
  assert.ok(response.result.diagnostic.nextSteps.includes('Run install\\doctor.ps1 and check Chrome installation.'));
});

test('buildRpcRequest maps approval and page commands', () => {
  assert.deepEqual(buildRpcRequest(['approve', 'https://example.com']), {
    method: 'operator.approveDomain',
    params: { origin: 'https://example.com' }
  });
  assert.deepEqual(buildRpcRequest(['revoke', 'https://example.com']), {
    method: 'operator.revokeDomain',
    params: { origin: 'https://example.com' }
  });
  assert.deepEqual(buildRpcRequest(['observe', 'https://example.com']), {
    method: 'page.observe',
    params: { origin: 'https://example.com' }
  });
  assert.deepEqual(buildRpcRequest(['visual-observe', 'https://example.com']), {
    method: 'page.visualObserve',
    params: { origin: 'https://example.com' }
  });
  assert.deepEqual(buildRpcRequest(['screenshots-cleanup', '60000']), {
    method: 'operator.screenshots.cleanup',
    params: { olderThanMs: 60000 }
  });
  assert.deepEqual(buildRpcRequest(['audit-tail', '5']), {
    method: 'operator.audit.tail',
    params: { limit: 5 }
  });
  assert.deepEqual(buildRpcRequest(['emergency-stop', 'stop now']), {
    method: 'operator.emergencyStop',
    params: { reason: 'stop now' }
  });
  assert.deepEqual(buildRpcRequest(['emergency-clear']), {
    method: 'operator.emergencyClear',
    params: {}
  });
  assert.deepEqual(buildRpcRequest(['disconnect', 'reconnect please']), {
    method: 'bridge.disconnected',
    params: {
      source: 'operator-cli',
      reason: 'reconnect please'
    }
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
  assert.deepEqual(buildRpcRequest([
    'wait-for',
    'https://example.com',
    '{"type":"textVisible","text":"Draft saved"}',
    '750'
  ]), {
    method: 'page.waitFor',
    params: {
      origin: 'https://example.com',
      condition: {
        type: 'textVisible',
        text: 'Draft saved'
      },
      timeoutMs: 750
    }
  });
});

test('buildRpcRequest maps profile and readiness commands', () => {
  assert.deepEqual(buildRpcRequest(['profiles']), {
    method: 'operator.profiles.discover',
    params: {}
  });
  assert.deepEqual(buildRpcRequest(['profiles', 'C:/Chrome/User Data']), {
    method: 'operator.profiles.discover',
    params: { userDataDir: 'C:/Chrome/User Data' }
  });
  assert.deepEqual(buildRpcRequest(['profile-bind', 'C:/Chrome/User Data', 'Profile 1', 'Play Console']), {
    method: 'operator.profile.bind',
    params: {
      userDataDir: 'C:/Chrome/User Data',
      profileDirectory: 'Profile 1',
      profileLabel: 'Play Console'
    }
  });
  assert.deepEqual(buildRpcRequest(['profile-verify']), {
    method: 'operator.profile.verify',
    params: {}
  });
  assert.deepEqual(buildRpcRequest(['readiness', 'https://example.com/path']), {
    method: 'operator.verifyReadiness',
    params: {
      origin: 'https://example.com'
    }
  });
});

test('buildRpcRequest maps approval lifecycle commands', () => {
  assert.deepEqual(buildRpcRequest(['approvals']), {
    method: 'operator.approvals.list',
    params: {}
  });
  assert.deepEqual(buildRpcRequest(['approval-approve', 'approval_1']), {
    method: 'operator.approvals.approve',
    params: { approvalId: 'approval_1' }
  });
  assert.deepEqual(buildRpcRequest(['approval-reject', 'approval_1']), {
    method: 'operator.approvals.reject',
    params: { approvalId: 'approval_1' }
  });
  assert.deepEqual(buildRpcRequest(['approval-run', 'approval_1']), {
    method: 'operator.approvals.run',
    params: { approvalId: 'approval_1' }
  });
});

test('buildRpcRequest maps bounded full-auto commands', () => {
  const contract = {
    mode: 'bounded-full-auto-v1',
    approvedOrigins: ['https://example.com'],
    taskScope: 'unit bounded task',
    allowedActionKinds: ['observe'],
    limits: { expiresInMinutes: 30 },
    auditRequired: true,
    emergencyStopRequired: true
  };

  assert.deepEqual(buildRpcRequest(['full-auto-start', JSON.stringify(contract)]), {
    method: 'operator.fullAuto.start',
    params: { contract }
  });
  assert.deepEqual(buildRpcRequest(['full-auto-status']), {
    method: 'operator.fullAuto.status',
    params: {}
  });
  assert.deepEqual(buildRpcRequest(['full-auto-stop', 'done']), {
    method: 'operator.fullAuto.stop',
    params: { reason: 'done' }
  });
});

test('buildRpcRequest rejects incomplete commands with usage error', () => {
  assert.throws(() => buildRpcRequest([]), /Usage:/);
  assert.throws(() => buildRpcRequest(['revoke']), /Usage:/);
  assert.throws(() => buildRpcRequest(['fill', 'https://example.com', 'el_0']), /Usage:/);
  assert.throws(() => buildRpcRequest(['profile-bind', 'C:/Chrome/User Data']), /Usage:/);
  assert.throws(() => buildRpcRequest(['approval-run']), /Usage:/);
  assert.throws(() => buildRpcRequest(['full-auto-start']), /Usage:/);
  assert.throws(() => buildRpcRequest(['audit-tail', 'nope']), /Usage:/);
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
