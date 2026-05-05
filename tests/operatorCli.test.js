const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildRpcRequest,
  ensureStarted,
  findChromeForBootstrap,
  launchBootstrapChrome,
  openObserve,
  prepareOrigin,
  profileDoctor,
  profileOnboard,
  resolveCliSettings,
  waitForActiveTabUrl,
  waitReady
} = require('../scripts/operator-cli');

function writeEmptyFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '', 'utf8');
}

function writeConfiguredProfile(installDir, configuredProfile) {
  fs.writeFileSync(
    path.join(installDir, 'state.json'),
    JSON.stringify({ configuredProfile }),
    'utf8'
  );
}

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

test('configured real profile bootstrap prefers system Chrome over bundled Chrome for Testing', () => {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-operator-cli-'));
  const chromeUserDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-real-chrome-user-data-'));
  const programFiles = path.join(installDir, 'ProgramFiles');
  const localAppData = path.join(installDir, 'LocalAppData');
  const bundledChrome = path.join(installDir, 'browsers', 'chrome', '1234', 'chrome-win64', 'chrome.exe');
  const systemChrome = path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe');
  writeEmptyFile(bundledChrome);
  writeEmptyFile(systemChrome);
  writeConfiguredProfile(installDir, {
    userDataDir: chromeUserDataRoot,
    profileDirectory: 'Profile 1',
    profileLabel: 'Play Console'
  });

  const found = findChromeForBootstrap(installDir, {
    ProgramFiles: programFiles,
    LOCALAPPDATA: localAppData
  });

  assert.equal(found.chromePath, systemChrome);
  assert.equal(found.browserKind, 'system-google-chrome');
  assert.equal(found.profileLaunchMode, 'configured-real-profile');
});

test('configured real profile bootstrap refuses bundled Chrome for Testing when system Chrome is unavailable', () => {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-operator-cli-'));
  const chromeUserDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-real-chrome-user-data-'));
  const localAppData = path.join(installDir, 'LocalAppData');
  const bundledChrome = path.join(installDir, 'browsers', 'chrome', '1234', 'chrome-win64', 'chrome.exe');
  writeEmptyFile(bundledChrome);
  writeConfiguredProfile(installDir, {
    userDataDir: chromeUserDataRoot,
    profileDirectory: 'Profile 1',
    profileLabel: 'Play Console'
  });

  const launched = launchBootstrapChrome({
    installDir,
    bootstrapUrl: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/bootstrap.html?session=boot',
    env: {
      ProgramFiles: path.join(installDir, 'MissingProgramFiles'),
      LOCALAPPDATA: localAppData
    }
  });

  assert.equal(launched.attempted, true);
  assert.equal(launched.launched, false);
  assert.equal(launched.error.code, 'PROFILE_BROWSER_MISMATCH');
  assert.equal(launched.browserKind, 'bundled-chrome-for-testing');
  assert.equal(launched.profileLaunchMode, 'configured-real-profile');
  assert.equal(launched.chromePath, bundledChrome);
});

test('unconfigured isolated smoke profile can bootstrap with bundled Chrome for Testing', () => {
  const originalSpawn = require('node:child_process').spawn;
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-operator-cli-'));
  const bundledChrome = path.join(installDir, 'browsers', 'chrome', '1234', 'chrome-win64', 'chrome.exe');
  const extensionManifest = path.join(installDir, 'extension-unpacked', 'manifest.json');
  writeEmptyFile(bundledChrome);
  writeEmptyFile(extensionManifest);

  const calls = [];
  require('node:child_process').spawn = (chromePath, args, options) => {
    calls.push({ chromePath, args, options });
    return {
      pid: 2468,
      unref() {}
    };
  };

  try {
    const launched = launchBootstrapChrome({
      installDir,
      bootstrapUrl: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/bootstrap.html?session=boot',
      env: {}
    });

    assert.equal(launched.launched, true);
    assert.equal(launched.pid, 2468);
    assert.equal(launched.chromePath, bundledChrome);
    assert.equal(launched.browserKind, 'bundled-chrome-for-testing');
    assert.equal(launched.profileLaunchMode, 'isolated-operator-profile');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].chromePath, bundledChrome);
    assert.ok(calls[0].args.includes(`--user-data-dir=${path.join(installDir, 'chrome-operator-profile')}`));
  } finally {
    require('node:child_process').spawn = originalSpawn;
  }
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

test('ensureStarted reports target readiness diagnostic for missing gates', async () => {
  const bootstrapUrl = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/bootstrap.html?session=boot';
  const response = await ensureStarted({
    request: {
      id: 'req_5',
      method: 'operator.ensureStarted',
      params: {
        origin: 'https://example.com'
      }
    },
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'cli-token',
      installDir: 'C:/Operator'
    },
    openBootstrap: false,
    sendRpcFn: async () => ({
      ok: true,
      result: {
        daemonRunning: true,
        extensionConnected: true,
        bootstrapRequired: false,
        bootstrapUrl,
        readiness: {
          origin: 'https://example.com',
          profileVerified: false,
          domainApproved: false,
          hostPermissionGranted: false
        }
      }
    })
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.readiness.ready, false);
  assert.deepEqual(response.result.readiness.missing, ['domainApproval']);
  assert.equal(response.result.diagnostic.code, 'READINESS_INCOMPLETE');
  assert.equal(response.result.diagnostic.origin, 'https://example.com');
  assert.deepEqual(
    response.result.diagnostic.nextActions.map((action) => action.kind),
    ['domainApproval']
  );
  assert.ok(response.result.diagnostic.nextActions[0].command.includes('approve https://example.com'));
});

test('buildRpcRequest maps prepare-origin to operator.ensureStarted', () => {
  assert.deepEqual(buildRpcRequest(['prepare-origin', 'https://example.com/path']), {
    method: 'operator.ensureStarted',
    params: {
      origin: 'https://example.com'
    },
    cliAction: 'prepareOrigin'
  });
});

test('buildRpcRequest maps wait-ready to operator.verifyReadiness', () => {
  assert.deepEqual(buildRpcRequest(['wait-ready', 'https://example.com/path', '1500', '25']), {
    method: 'operator.verifyReadiness',
    params: {
      origin: 'https://example.com',
      timeoutMs: 1500,
      pollIntervalMs: 25
    },
    cliAction: 'waitReady'
  });
});

test('buildRpcRequest maps open-observe to page.observe cli action', () => {
  assert.deepEqual(buildRpcRequest(['open-observe', 'https://example.com/path', '1500', '25']), {
    method: 'page.observe',
    params: {
      url: 'https://example.com/path',
      origin: 'https://example.com',
      timeoutMs: 1500,
      pollIntervalMs: 25
    },
    cliAction: 'openObserve'
  });
});

test('buildRpcRequest maps cart-prepare to guarded page.prepareCart request', () => {
  assert.deepEqual(buildRpcRequest([
    'cart-prepare',
    'https://shop.example/products?ref=codex',
    'portable charger',
    '{"minSellerRating":4.7,"maxPrice":50,"currency":"USD","sort":"price-asc"}',
    'true',
    'profile_1'
  ]), {
    method: 'page.prepareCart',
    params: {
      origin: 'https://shop.example',
      query: 'portable charger',
      criteria: {
        minSellerRating: 4.7,
        maxPrice: 50,
        currency: 'USD',
        sort: 'price-asc'
      },
      cartActionAllowed: true,
      profileId: 'profile_1'
    }
  });

  assert.deepEqual(buildRpcRequest([
    'cart-prepare',
    'https://shop.example/path',
    'usb cable',
    '{}',
    'false'
  ]), {
    method: 'page.prepareCart',
    params: {
      origin: 'https://shop.example',
      query: 'usb cable',
      criteria: {},
      cartActionAllowed: false
    }
  });
});

test('prepareOrigin approves domain and becomes ready without per-site host permission', async () => {
  const calls = [];
  const bootstrapUrl = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/bootstrap.html?session=boot';
  const response = await prepareOrigin({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'cli-token',
      installDir: 'C:/Operator'
    },
    request: {
      id: 'prep_1',
      method: 'operator.ensureStarted',
      params: {
        origin: 'https://example.com'
      }
    },
    ensureStartedFn: async () => {
      calls.push('ensure');
      return {
        ok: true,
        result: {
          extensionConnected: true,
          bootstrapRequired: false,
          bootstrapUrl,
          readiness: {
            origin: 'https://example.com',
            ready: false,
            profileVerified: true,
            domainApproved: false,
            hostPermissionGranted: false,
            siteBlocked: false,
            missing: ['domainApproval']
          },
          diagnostic: {
            code: 'READINESS_INCOMPLETE'
          }
        }
      };
    },
    sendRpcFn: async ({ request }) => {
      calls.push(`${request.method}:${request.params.origin}`);
      if (request.method === 'operator.approveDomain') {
        return {
          ok: true,
          result: {
            origin: request.params.origin,
            approved: true
          }
        };
      }
      if (request.method === 'operator.verifyReadiness') {
        return {
          ok: true,
          result: {
            origin: request.params.origin,
            ready: true,
            profileVerified: true,
            domainApproved: true,
            hostPermissionGranted: false,
            siteBlocked: false,
            missing: []
          }
        };
      }
      throw new Error(`unexpected method ${request.method}`);
    }
  });

  assert.deepEqual(calls, [
    'ensure',
    'operator.approveDomain:https://example.com',
    'operator.verifyReadiness:https://example.com'
  ]);
  assert.equal(response.ok, true);
  assert.equal(response.result.origin, 'https://example.com');
  assert.equal(response.result.applied.domainApproval, true);
  assert.equal(response.result.ready, true);
  assert.equal(response.result.permissionUrl, null);
  assert.equal(response.result.requiresUserGesture, false);
  assert.equal(response.result.nextAction, null);
});

test('openObserve stops before navigation when readiness requires a user gesture', async () => {
  const calls = [];
  const response = await openObserve({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'cli-token',
      installDir: 'C:/Operator'
    },
    request: {
      id: 'open_1',
      method: 'page.observe',
      params: {
        url: 'https://example.com/path',
        origin: 'https://example.com',
        timeoutMs: 1000,
        pollIntervalMs: 1
      }
    },
    prepareOriginFn: async () => {
      calls.push('prepare');
      return {
        ok: true,
        result: {
          origin: 'https://example.com',
          ready: false,
          requiresUserGesture: true,
          permissionUrl: null,
          diagnostic: {
            code: 'READINESS_INCOMPLETE',
            missing: ['siteAllowed']
          },
          nextActions: [{
            kind: 'blockedSiteSettings',
            requiresUserGesture: true
          }]
        }
      };
    },
    waitReadyFn: async () => {
      calls.push('wait-ready');
      return {
        ok: false,
        error: {
          code: 'READINESS_WAIT_TIMEOUT'
        }
      };
    },
    sendRpcFn: async ({ request }) => {
      calls.push(request.method);
      return { ok: true, result: {} };
    }
  });

  assert.deepEqual(calls, ['prepare']);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'READINESS_INCOMPLETE');
  assert.equal(response.error.blockedAt, 'prepare-origin');
  assert.equal(response.error.permissionUrl, null);
  assert.equal(response.error.nextActions[0].kind, 'blockedSiteSettings');
});

test('openObserve navigates and observes after readiness is confirmed', async () => {
  const calls = [];
  const observeParams = [];
  const response = await openObserve({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'cli-token',
      installDir: 'C:/Operator'
    },
    request: {
      id: 'open_2',
      method: 'page.observe',
      params: {
        url: 'https://example.com/path',
        origin: 'https://example.com',
        timeoutMs: 1000,
        pollIntervalMs: 1,
        mode: 'medium',
        maxActionableHandles: 18,
        summaryMaxChars: 500,
        sincePageStateId: 'state_previous'
      }
    },
    prepareOriginFn: async () => {
      calls.push('prepare');
      return {
        ok: true,
        result: {
          origin: 'https://example.com',
          ready: true,
          requiresUserGesture: false
        }
      };
    },
    waitReadyFn: async () => {
      calls.push('wait-ready');
      return {
        ok: true,
        result: {
          ready: true
        }
      };
    },
    sendRpcFn: async ({ request }) => {
      calls.push(request.method === 'operator.status'
        ? 'operator.status'
        : `${request.method}:${request.params.url || request.params.origin}`);
      if (request.method === 'page.navigate') {
        return {
          ok: true,
          result: {
            navigated: true,
            url: request.params.url
          }
        };
      }
      if (request.method === 'operator.status') {
        return {
          ok: true,
          result: {
            activeTab: {
              url: 'https://example.com/path',
              origin: 'https://example.com',
              loadingState: 'complete'
            }
          }
        };
      }
      if (request.method === 'page.observe') {
        observeParams.push(request.params);
        return {
          ok: true,
          result: {
            title: 'Example',
            elements: []
          }
        };
      }
      throw new Error(`unexpected method ${request.method}`);
    }
  });

  assert.deepEqual(calls, [
    'prepare',
    'wait-ready',
    'page.navigate:https://example.com/path',
    'operator.status',
    'page.observe:https://example.com'
  ]);
  assert.deepEqual(observeParams, [{
    origin: 'https://example.com',
    mode: 'medium',
    maxActionableHandles: 18,
    summaryMaxChars: 500,
    sincePageStateId: 'state_previous'
  }]);
  assert.equal(response.ok, true);
  assert.equal(response.result.origin, 'https://example.com');
  assert.equal(response.result.url, 'https://example.com/path');
  assert.equal(response.result.navigation.navigated, true);
  assert.equal(response.result.observation.title, 'Example');
});

test('openObserve waits for navigation to settle before observing', async () => {
  const calls = [];
  let statusChecks = 0;
  let tabSettled = false;
  const response = await openObserve({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'cli-token',
      installDir: 'C:/Operator'
    },
    request: {
      id: 'open_3',
      method: 'page.observe',
      params: {
        url: 'https://example.com/path',
        origin: 'https://example.com',
        timeoutMs: 1000,
        pollIntervalMs: 1
      }
    },
    prepareOriginFn: async () => {
      calls.push('prepare');
      return {
        ok: true,
        result: {
          origin: 'https://example.com',
          ready: true,
          requiresUserGesture: false
        }
      };
    },
    waitReadyFn: async () => {
      calls.push('wait-ready');
      return {
        ok: true,
        result: {
          ready: true
        }
      };
    },
    sendRpcFn: async ({ request }) => {
      if (request.method === 'page.navigate') {
        calls.push('page.navigate');
        return {
          ok: true,
          result: {
            action: 'navigate',
            url: request.params.url
          }
        };
      }
      if (request.method === 'operator.status') {
        statusChecks += 1;
        calls.push(`operator.status:${statusChecks}`);
        if (statusChecks === 1) {
          return {
            ok: true,
            result: {
              activeTab: {
                url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/sidepanel.html',
                origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
                loadingState: 'complete'
              }
            }
          };
        }
        tabSettled = true;
        return {
          ok: true,
          result: {
            activeTab: {
              url: 'https://example.com/path',
              origin: 'https://example.com',
              loadingState: 'complete'
            }
          }
        };
      }
      if (request.method === 'page.observe') {
        calls.push(tabSettled ? 'page.observe:settled' : 'page.observe:early');
        return tabSettled
          ? {
            ok: true,
            result: {
              title: 'Example',
              elements: []
            }
          }
          : {
            ok: false,
            error: {
              code: 'DOMAIN_NOT_APPROVED'
            }
          };
      }
      throw new Error(`unexpected method ${request.method}`);
    }
  });

  assert.deepEqual(calls, [
    'prepare',
    'wait-ready',
    'page.navigate',
    'operator.status:1',
    'operator.status:2',
    'page.observe:settled'
  ]);
  assert.equal(response.ok, true);
  assert.equal(response.result.navigationSettled.activeTab.url, 'https://example.com/path');
  assert.equal(response.result.observation.title, 'Example');
});

test('waitForActiveTabUrl accepts Chrome-normalized root URLs', async () => {
  let calls = 0;
  const response = await waitForActiveTabUrl({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'cli-token'
    },
    requestId: 'wait_root',
    url: 'https://example.com',
    origin: 'https://example.com',
    timeoutMs: 10,
    pollIntervalMs: 1,
    delayFn: async () => {},
    sendRpcFn: async () => {
      calls += 1;
      return {
        ok: true,
        result: {
          activeTab: {
            url: 'https://example.com/',
            origin: 'https://example.com',
            loadingState: 'complete'
          }
        }
      };
    }
  });

  assert.equal(response.ok, true);
  assert.equal(calls > 0, true);
  assert.equal(response.result.activeTab.url, 'https://example.com/');
});

test('waitReady polls verifyReadiness until the origin is ready', async () => {
  const calls = [];
  const readinessResponses = [
    {
      ready: false,
      profileVerified: true,
      domainApproved: true,
      hostPermissionGranted: false,
      siteBlocked: true,
      missing: ['siteAllowed']
    },
    {
      ready: true,
      profileVerified: true,
      domainApproved: true,
      hostPermissionGranted: false,
      siteBlocked: false,
      missing: []
    }
  ];
  const response = await waitReady({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'cli-token',
      installDir: 'C:/Operator'
    },
    request: {
      id: 'wait_1',
      method: 'operator.verifyReadiness',
      params: {
        origin: 'https://example.com',
        timeoutMs: 1000,
        pollIntervalMs: 1
      }
    },
    delayFn: async () => {},
    sendRpcFn: async ({ request }) => {
      calls.push(`${request.id}:${request.method}:${request.params.origin}`);
      const result = readinessResponses.shift();
      return {
        ok: true,
        result: {
          origin: request.params.origin,
          ...result
        }
      };
    }
  });

  assert.deepEqual(calls, [
    'wait_1_wait_ready_1:operator.verifyReadiness:https://example.com',
    'wait_1_wait_ready_2:operator.verifyReadiness:https://example.com'
  ]);
  assert.equal(response.ok, true);
  assert.equal(response.result.ready, true);
  assert.equal(response.result.waitReady.attempted, true);
  assert.equal(response.result.waitReady.attempts, 2);
});

test('waitReady timeout returns last readiness next actions', async () => {
  const response = await waitReady({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'cli-token',
      installDir: 'C:/Operator'
    },
    request: {
      id: 'wait_2',
      method: 'operator.verifyReadiness',
      params: {
        origin: 'https://example.com',
        timeoutMs: 1,
        pollIntervalMs: 1
      }
    },
    delayFn: async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
    },
    sendRpcFn: async ({ request }) => ({
      ok: true,
      result: {
        origin: request.params.origin,
        ready: false,
        profileVerified: true,
        domainApproved: true,
        hostPermissionGranted: false,
        siteBlocked: true,
        missing: ['siteAllowed']
      }
    })
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'READINESS_WAIT_TIMEOUT');
  assert.deepEqual(response.error.lastReadiness.missing, ['siteAllowed']);
  assert.deepEqual(response.error.nextActions.map((action) => action.kind), ['blockedSiteSettings']);
  assert.equal(response.error.nextActions[0].requiresUserGesture, true);
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
  assert.deepEqual(buildRpcRequest([
    'read-page',
    'https://example.com',
    'all',
    '12000',
    'true',
    '4000'
  ]), {
    method: 'page.readPage',
    params: {
      origin: 'https://example.com',
      filter: 'all',
      maxChars: 12000,
      includeFormValues: true,
      maxFieldValueChars: 4000
    }
  });
  assert.deepEqual(buildRpcRequest(['visual-observe', 'https://example.com']), {
    method: 'page.visualObserve',
    params: { origin: 'https://example.com' }
  });
  assert.deepEqual(buildRpcRequest(['visual-analyze', 'https://example.com', 'local-basic']), {
    method: 'page.visualAnalyze',
    params: {
      origin: 'https://example.com',
      provider: 'local-basic'
    }
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
  assert.deepEqual(buildRpcRequest(['type', 'https://example.com', 'el_0', 'hello world']), {
    method: 'page.type',
    params: {
      origin: 'https://example.com',
      handle: 'el_0',
      text: 'hello world'
    }
  });
  assert.deepEqual(buildRpcRequest(['clear', 'https://example.com', 'el_0']), {
    method: 'page.clear',
    params: {
      origin: 'https://example.com',
      handle: 'el_0'
    }
  });
  assert.deepEqual(buildRpcRequest(['focus', 'https://example.com', 'el_0']), {
    method: 'page.focus',
    params: {
      origin: 'https://example.com',
      handle: 'el_0'
    }
  });
  assert.deepEqual(buildRpcRequest(['select', 'https://example.com', 'el_1', 'tr']), {
    method: 'page.select',
    params: {
      origin: 'https://example.com',
      handle: 'el_1',
      value: 'tr'
    }
  });
  assert.deepEqual(buildRpcRequest(['check', 'https://example.com', 'el_2', 'false']), {
    method: 'page.check',
    params: {
      origin: 'https://example.com',
      handle: 'el_2',
      checked: false
    }
  });
  assert.deepEqual(buildRpcRequest(['scroll', 'https://example.com', 'el_4', '0', '240']), {
    method: 'page.scroll',
    params: {
      origin: 'https://example.com',
      handle: 'el_4',
      deltaX: 0,
      deltaY: 240
    }
  });
  assert.deepEqual(buildRpcRequest(['press-key', 'https://example.com', 'el_0', 'Enter']), {
    method: 'page.pressKey',
    params: {
      origin: 'https://example.com',
      handle: 'el_0',
      key: 'Enter'
    }
  });
  assert.deepEqual(buildRpcRequest(['click', 'https://example.com', 'el_2']), {
    method: 'page.click',
    params: {
      origin: 'https://example.com',
      handle: 'el_2'
    }
  });
  const targetJsonPath = path.join(os.tmpdir(), `codex-target-${process.pid}-${Date.now()}.json`);
  const observedTarget = {
    tag: 'button',
    role: 'button',
    type: 'button',
    label: 'Yanıtla',
    data: { 'data-test-id': 'tweetButton' },
    bbox: { x: 100, y: 900, width: 84, height: 36 },
    context: {
      url: 'https://example.com',
      viewport: { width: 1280, height: 720 },
      scroll: { x: 0, y: 0 }
    }
  };
  fs.writeFileSync(targetJsonPath, JSON.stringify(observedTarget), 'utf8');
  try {
    assert.deepEqual(buildRpcRequest([
      'click',
      'https://example.com',
      'el_2',
      '--target-json',
      targetJsonPath
    ]), {
      method: 'page.click',
      params: {
        origin: 'https://example.com',
        handle: 'el_2',
        target: observedTarget
      }
    });
    assert.deepEqual(buildRpcRequest([
      'type',
      'https://example.com',
      'el_0',
      'hello world',
      '--target-json',
      targetJsonPath
    ]), {
      method: 'page.type',
      params: {
        origin: 'https://example.com',
        handle: 'el_0',
        text: 'hello world',
        target: observedTarget
      }
    });
    assert.deepEqual(buildRpcRequest([
      'focus',
      'https://example.com',
      'el_0',
      '--target-json',
      targetJsonPath
    ]), {
      method: 'page.focus',
      params: {
        origin: 'https://example.com',
        handle: 'el_0',
        target: observedTarget
      }
    });
    assert.deepEqual(buildRpcRequest([
      'press-key',
      'https://example.com',
      'el_0',
      'Enter',
      '--target-json',
      targetJsonPath
    ]), {
      method: 'page.pressKey',
      params: {
        origin: 'https://example.com',
        handle: 'el_0',
        key: 'Enter',
        target: observedTarget
      }
    });
  } finally {
    fs.rmSync(targetJsonPath, { force: true });
  }
  assert.deepEqual(buildRpcRequest([
    'upload-file',
    'https://example.com',
    'el_file',
    'play-store-draft',
    '[{"role":"playStoreAppIcon","path":"C:/tmp/icon.png","expectedSha256":"abc123"}]'
  ]), {
    method: 'page.uploadFile',
    params: {
      origin: 'https://example.com',
      target: { handle: 'el_file' },
      ruleset: 'play-store-draft',
      files: [{
        role: 'playStoreAppIcon',
        path: 'C:/tmp/icon.png',
        expectedSha256: 'abc123'
      }]
    }
  });
  assert.deepEqual(buildRpcRequest([
    'upload-file',
    'https://example.com',
    'el_file',
    'play-store-draft',
    '[{"role":"playStoreAppIcon","path":"C:/tmp/icon.png"}]',
    'true'
  ]), {
    method: 'page.uploadFile',
    params: {
      origin: 'https://example.com',
      target: { handle: 'el_file' },
      ruleset: 'play-store-draft',
      files: [{
        role: 'playStoreAppIcon',
        path: 'C:/tmp/icon.png'
      }],
      verifyPreview: true
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
  assert.deepEqual(buildRpcRequest(['profile-doctor']), {
    method: 'operator.status',
    params: {},
    cliAction: 'profileDoctor'
  });
  assert.deepEqual(buildRpcRequest(['profile-doctor', 'https://example.com/path']), {
    method: 'operator.status',
    params: {
      origin: 'https://example.com'
    },
    cliAction: 'profileDoctor'
  });
  assert.deepEqual(buildRpcRequest(['profile-onboard']), {
    method: 'operator.profiles.discover',
    params: {},
    cliAction: 'profileOnboard'
  });
  assert.deepEqual(buildRpcRequest([
    'profile-onboard',
    'C:/Chrome/User Data',
    'Profile 1',
    'Play Console'
  ]), {
    method: 'operator.profiles.discover',
    params: {
      userDataDir: 'C:/Chrome/User Data',
      profileDirectory: 'Profile 1',
      profileLabel: 'Play Console'
    },
    cliAction: 'profileOnboard'
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
  assert.throws(() => buildRpcRequest(['cart-prepare', 'https://shop.example', 'query', '{}']), /Usage:/);
  assert.throws(() => buildRpcRequest(['cart-prepare', 'https://shop.example', 'query', 'not-json', 'true']), /criteria-json must be valid JSON/);
  assert.throws(() => buildRpcRequest(['cart-prepare', 'https://shop.example', 'query', '{}', 'yes']), /Usage:/);
  assert.throws(() => buildRpcRequest(['upload-file', 'https://example.com', 'el_0', 'ruleset']), /Usage:/);
  assert.throws(() => buildRpcRequest(['upload-file', 'https://example.com', 'el_0', 'ruleset', 'not-json']), /files-json must be valid JSON/);
  assert.throws(() => buildRpcRequest(['profile-bind', 'C:/Chrome/User Data']), /Usage:/);
  assert.throws(() => buildRpcRequest(['approval-run']), /Usage:/);
  assert.throws(() => buildRpcRequest(['full-auto-start']), /Usage:/);
  assert.throws(() => buildRpcRequest(['audit-tail', 'nope']), /Usage:/);
  assert.throws(() => buildRpcRequest(['wat']), /Usage:/);
});

test('profileDoctor reports configured profile, active tab, and readiness in one JSON result', async () => {
  const calls = [];
  const response = await profileDoctor({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'cli-token',
      installDir: 'C:/Operator'
    },
    request: {
      id: 'profile_doctor_1',
      method: 'operator.status',
      params: {
        origin: 'https://example.com'
      }
    },
    sendRpcFn: async ({ request }) => {
      calls.push(`${request.id}:${request.method}:${request.params.origin || ''}`);
      if (request.method === 'operator.status') {
        return {
          ok: true,
          result: {
            connectionState: 'EXTENSION_CONNECTED',
            profileVerified: true,
            profileBindingStatus: 'verified',
            configuredProfile: {
              userDataDir: 'C:/Chrome/User Data',
              profileDirectory: 'Profile 1',
              profileLabel: 'Play Console',
              profileBindingId: 'profbind_profile01',
              profileBindingVersion: 1
            },
            activeTab: {
              url: 'https://example.com/app',
              origin: 'https://example.com',
              loadingState: 'complete'
            },
            version: {
              lastMismatch: null
            }
          }
        };
      }
      assert.equal(request.method, 'operator.verifyReadiness');
      return {
        ok: true,
        result: {
          origin: 'https://example.com',
          ready: true,
          profileVerified: true,
          domainApproved: true,
          hostPermissionGranted: true
        }
      };
    }
  });

  assert.equal(response.ok, true);
  assert.deepEqual(calls, [
    'profile_doctor_1_status:operator.status:',
    'profile_doctor_1_readiness:operator.verifyReadiness:https://example.com'
  ]);
  assert.equal(response.result.checks.daemon.ok, true);
  assert.equal(response.result.checks.configuredProfile.ok, true);
  assert.equal(response.result.checks.extensionConnected.ok, true);
  assert.equal(response.result.checks.activeTabOrigin.ok, true);
  assert.equal(response.result.checks.readiness.ok, true);
  assert.deepEqual(response.result.nextActions, []);
});

test('profileDoctor does not block on an unconfigured profile', async () => {
  const response = await profileDoctor({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'cli-token',
      installDir: 'C:/Operator'
    },
    request: {
      id: 'profile_doctor_unconfigured',
      method: 'operator.status',
      params: {}
    },
    sendRpcFn: async ({ request }) => {
      assert.equal(request.method, 'operator.status');
      return {
        ok: true,
        result: {
          connectionState: 'EXTENSION_CONNECTED',
          profileVerified: true,
          profileBindingStatus: 'not-required',
          configuredProfile: null
        }
      };
    }
  });

  assert.equal(response.ok, true);
  const profileActions = response.result.nextActions.filter((action) => action.kind === 'profile');
  assert.equal(profileActions.length, 0);
  assert.equal(response.result.checks.extensionConnected.ok, true);
});

test('profileOnboard asks for an explicit profile when discovery finds multiple profiles', async () => {
  const calls = [];
  const response = await profileOnboard({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'cli-token',
      installDir: 'C:/Operator'
    },
    request: {
      id: 'profile_onboard_1',
      method: 'operator.profiles.discover',
      params: {
        userDataDir: 'C:/Chrome/User Data'
      }
    },
    sendRpcFn: async ({ request }) => {
      calls.push(`${request.id}:${request.method}`);
      assert.equal(request.method, 'operator.profiles.discover');
      return {
        ok: true,
        result: {
          profiles: [
            {
              userDataDir: 'C:/Chrome/User Data',
              profileDirectory: 'Default',
              profileLabel: 'Work'
            },
            {
              userDataDir: 'C:/Chrome/User Data',
              profileDirectory: 'Profile 1',
              profileLabel: 'Play Console'
            }
          ]
        }
      };
    }
  });

  assert.deepEqual(calls, ['profile_onboard_1_discover_profiles:operator.profiles.discover']);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'PROFILE_SELECTION_REQUIRED');
  assert.equal(response.error.profiles.length, 2);
  assert.deepEqual(response.error.nextActions.map((action) => action.kind), [
    'profileSelection',
    'profileSelection'
  ]);
  assert.match(response.error.nextActions[1].command, /profile-onboard/);
  assert.match(response.error.nextActions[1].command, /Profile 1/);
});

test('profileOnboard saves the only discovered profile and runs doctor without setup', async () => {
  const calls = [];
  const response = await profileOnboard({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'cli-token',
      installDir: 'C:/Operator'
    },
    request: {
      id: 'profile_onboard_2',
      method: 'operator.profiles.discover',
      params: {}
    },
    sendRpcFn: async ({ request }) => {
      calls.push(`${request.id}:${request.method}`);
      if (request.method === 'operator.profiles.discover') {
        return {
          ok: true,
          result: {
            profiles: [
              {
                userDataDir: 'C:/Chrome/User Data',
                profileDirectory: 'Profile 1',
                profileLabel: 'Play Console'
              }
            ]
          }
        };
      }
      assert.equal(request.method, 'operator.profile.bind');
      assert.deepEqual(request.params, {
        userDataDir: 'C:/Chrome/User Data',
        profileDirectory: 'Profile 1',
        profileLabel: 'Play Console'
      });
      return {
        ok: true,
        result: {
          userDataDir: 'C:/Chrome/User Data',
          profileDirectory: 'Profile 1',
          profileLabel: 'Play Console'
        }
      };
    },
    launchBootstrapFn: ({ installDir, bootstrapUrl }) => {
      calls.push(`launch:${installDir}:${bootstrapUrl}`);
      return {
        attempted: true,
        launched: true,
        pid: 4321,
        bootstrapUrl
      };
    },
    profileDoctorFn: async ({ request }) => {
      calls.push(`${request.id}:${request.method}:doctor`);
      return {
        id: request.id,
        ok: true,
        result: {
          failedChecks: [],
          nextActions: [],
          status: {
            profileVerified: true
          }
        }
      };
    }
  });

  assert.deepEqual(calls, [
    'profile_onboard_2_discover_profiles:operator.profiles.discover',
    'profile_onboard_2_bind_profile:operator.profile.bind',
    'profile_onboard_2_doctor:operator.status:doctor'
  ]);
  assert.equal(response.ok, true);
  assert.equal(response.result.selection.autoSelected, true);
  assert.equal(response.result.selectedProfile.profileDirectory, 'Profile 1');
  assert.equal(response.result.bind.profileBindingId, undefined);
  assert.equal(response.result.setupUrl, null);
  assert.equal(response.result.bootstrapLaunch.skippedReason, 'PROFILE_SELECTION_ONLY');
  assert.equal(response.result.profileWait.skippedReason, 'PROFILE_SELECTION_ONLY');
  assert.equal(response.result.doctor.ok, true);
});

test('profileDoctor gives next actions when the active tab and origin are not ready', async () => {
  const response = await profileDoctor({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'cli-token',
      installDir: 'C:/Operator'
    },
    request: {
      id: 'profile_doctor_2',
      method: 'operator.status',
      params: {
        origin: 'https://example.com'
      }
    },
    sendRpcFn: async ({ request }) => {
      if (request.method === 'operator.status') {
        return {
          ok: true,
          result: {
            connectionState: 'EXTENSION_CONNECTED',
            profileVerified: true,
            profileBindingStatus: 'not-required',
            configuredProfile: {
              userDataDir: 'C:/Chrome/User Data',
              profileDirectory: 'Profile 1',
              profileLabel: 'Play Console'
            },
            activeTab: {
              url: 'https://other.example/app',
              origin: 'https://other.example',
              loadingState: 'complete'
            },
            version: {
              lastMismatch: null
            },
            lastError: null
          }
        };
      }
      return {
        ok: true,
        result: {
          origin: 'https://example.com',
          ready: false,
          profileVerified: true,
          domainApproved: false,
          hostPermissionGranted: false
        }
      };
    }
  });

  assert.equal(response.ok, false);
  assert.equal(response.result.checks.extensionConnected.ok, true);
  assert.equal(response.result.checks.activeTabOrigin.ok, false);
  assert.equal(response.result.checks.readiness.ok, false);
  assert.deepEqual(response.result.checks.readiness.details.missing, [
    'domainApproval'
  ]);
  const profileActions = response.result.nextActions.filter((action) => action.kind === 'profile');
  assert.equal(profileActions.length, 0);
  assert.ok(response.result.nextActions.some((action) => action.kind === 'domainApproval'));
  assert.equal(response.result.nextActions.some((action) => action.kind === 'hostPermission'), false);
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
