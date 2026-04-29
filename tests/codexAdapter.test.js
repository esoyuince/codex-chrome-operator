const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ADAPTER_PROTOCOL_VERSION,
  CodexChromeToolAdapter,
  listTools,
  toolDefinitionsHash,
  validateToolInput
} = require('../codex-adapter/toolAdapter');

test('listTools exposes strict versioned Codex browser tool definitions', () => {
  const tools = listTools();
  const openObserve = tools.find((tool) => tool.name === 'codex_chrome_open_observe');
  const profileOnboard = tools.find((tool) => tool.name === 'codex_chrome_profile_onboard');
  const uploadFile = tools.find((tool) => tool.name === 'codex_chrome_upload_file');

  assert.equal(ADAPTER_PROTOCOL_VERSION, '1.0');
  assert.ok(openObserve);
  assert.equal(openObserve.inputSchema.type, 'object');
  assert.equal(openObserve.inputSchema.additionalProperties, false);
  assert.deepEqual(openObserve.inputSchema.required, ['url']);
  assert.equal(openObserve.outputContract.untrusted, true);
  assert.ok(profileOnboard);
  assert.equal(profileOnboard.inputSchema.type, 'object');
  assert.equal(profileOnboard.inputSchema.additionalProperties, false);
  assert.deepEqual(profileOnboard.inputSchema.required, []);
  assert.ok(uploadFile);
  assert.equal(uploadFile.inputSchema.type, 'object');
  assert.equal(uploadFile.inputSchema.additionalProperties, false);
  assert.deepEqual(uploadFile.inputSchema.required, ['origin', 'handle', 'files']);
  assert.equal(uploadFile.inputSchema.properties.files.type, 'array');
  assert.equal(uploadFile.inputSchema.properties.ruleset.type, 'string');
  assert.equal(uploadFile.inputSchema.properties.verifyPreview.type, 'boolean');
  assert.match(toolDefinitionsHash(), /^[a-f0-9]{64}$/);
  assert.equal(toolDefinitionsHash(), toolDefinitionsHash());
});

test('validateToolInput rejects unknown tools, missing fields, and extra fields', () => {
  assert.deepEqual(validateToolInput('missing_tool', {}), {
    ok: false,
    error: {
      code: 'UNKNOWN_TOOL',
      message: 'Unknown Codex Chrome tool: missing_tool.'
    }
  });

  assert.equal(validateToolInput('codex_chrome_open_observe', {}).error.code, 'INVALID_TOOL_INPUT');
  assert.equal(
    validateToolInput('codex_chrome_open_observe', {
      url: 'https://example.com',
      surprise: true
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_open_observe', {
      url: 'https://example.com',
      timeoutMs: 1000,
      pollIntervalMs: 25
    }).ok,
    true
  );
  assert.equal(
    validateToolInput('codex_chrome_upload_file', {
      origin: 'https://example.com',
      handle: 'el_file',
      files: 'not-an-array'
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_upload_file', {
      origin: 'https://example.com',
      handle: 'el_file',
      files: [],
      extra: true
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
});

test('CodexChromeToolAdapter routes upload file with normalized origin and optional controls', async () => {
  const calls = [];
  const files = [{
    role: 'playStoreAppIcon',
    path: 'C:/tmp/icon.png',
    expectedSha256: 'abc123'
  }];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async ({ request }) => {
      calls.push(request);
      return {
        ok: true,
        result: {
          method: request.method,
          params: request.params
        }
      };
    }
  });

  const response = await adapter.executeTool({
    toolName: 'codex_chrome_upload_file',
    input: {
      origin: 'https://example.com/path?x=1',
      handle: 'el_file',
      ruleset: 'play-store-draft',
      verifyPreview: true,
      files
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.method, 'page.uploadFile');
  assert.deepEqual(response.result.params, {
    origin: 'https://example.com',
    target: { handle: 'el_file' },
    ruleset: 'play-store-draft',
    verifyPreview: true,
    files: [{
      role: 'playStoreAppIcon',
      path: '[REDACTED_PATH]',
      expectedSha256: 'abc123'
    }]
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'page.uploadFile');
  assert.deepEqual(calls[0].params.files, files);
});

test('CodexChromeToolAdapter exposes strict visual analyze schema and validation', () => {
  const visualAnalyze = listTools().find((tool) => tool.name === 'codex_chrome_visual_analyze');

  assert.ok(visualAnalyze);
  assert.equal(visualAnalyze.inputSchema.type, 'object');
  assert.equal(visualAnalyze.inputSchema.additionalProperties, false);
  assert.deepEqual(visualAnalyze.inputSchema.required, ['origin']);
  assert.deepEqual(visualAnalyze.inputSchema.properties, {
    origin: { type: 'string' },
    provider: { type: 'string' },
    maxBytes: { type: 'number' },
    allowSensitive: { type: 'boolean' }
  });
  assert.equal(
    validateToolInput('codex_chrome_visual_analyze', {}).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_visual_analyze', {
      origin: 'https://example.com',
      extra: true
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_visual_analyze', {
      origin: 'https://example.com/path',
      provider: 'local',
      maxBytes: 120000,
      allowSensitive: false
    }).ok,
    true
  );
});

test('CodexChromeToolAdapter routes visual analyze with normalized origin and options', async () => {
  const calls = [];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async ({ request }) => {
      calls.push(request);
      return {
        ok: true,
        result: {
          method: request.method,
          params: request.params
        }
      };
    }
  });

  const response = await adapter.executeTool({
    toolName: 'codex_chrome_visual_analyze',
    input: {
      origin: 'https://example.com/deep/path?x=1#section',
      provider: 'local',
      maxBytes: 120000,
      allowSensitive: false
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.method, 'page.visualAnalyze');
  assert.deepEqual(response.result.params, {
    origin: 'https://example.com',
    provider: 'local',
    maxBytes: 120000,
    allowSensitive: false
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'page.visualAnalyze');
});

test('CodexChromeToolAdapter executes open observe through the orchestration path', async () => {
  const calls = [];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    openObserveFn: async ({ settings, request }) => {
      calls.push({
        settings,
        request
      });
      return {
        ok: true,
        result: {
          origin: 'https://example.com',
          url: 'https://example.com/path',
          observation: {
            title: 'Example',
            elements: []
          }
        }
      };
    }
  });

  const response = await adapter.executeTool({
    toolName: 'codex_chrome_open_observe',
    input: {
      url: 'https://example.com/path',
      timeoutMs: 1500,
      pollIntervalMs: 25
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.toolName, 'codex_chrome_open_observe');
  assert.equal(response.protocolVersion, '1.0');
  assert.equal(response.untrusted, true);
  assert.equal(response.result.observation.title, 'Example');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].settings.token, 'adapter-token');
  assert.equal(calls[0].request.method, 'page.observe');
  assert.deepEqual(calls[0].request.params, {
    url: 'https://example.com/path',
    origin: 'https://example.com',
    timeoutMs: 1500,
    pollIntervalMs: 25
  });
});

test('CodexChromeToolAdapter exposes profile readiness and onboarding setup tools', async () => {
  const tools = listTools().map((tool) => tool.name);
  for (const toolName of [
    'codex_chrome_prepare_origin',
    'codex_chrome_readiness',
    'codex_chrome_profile_doctor',
    'codex_chrome_profile_onboard'
  ]) {
    assert.ok(tools.includes(toolName), `${toolName} should be exposed`);
  }

  assert.equal(validateToolInput('codex_chrome_readiness', {}).error.code, 'INVALID_TOOL_INPUT');
  assert.equal(validateToolInput('codex_chrome_profile_onboard', {
    userDataDir: 'C:/Chrome/User Data',
    profileDirectory: 'Profile 1',
    profileLabel: 'Play Console',
    openBootstrap: false
  }).ok, true);

  const calls = [];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async ({ request }) => {
      calls.push({
        kind: 'rpc',
        request
      });
      return {
        ok: true,
        result: { method: request.method, params: request.params }
      };
    },
    prepareOriginFn: async ({ settings, request, openBootstrap }) => {
      calls.push({
        kind: 'prepareOrigin',
        settings,
        request,
        openBootstrap
      });
      return {
        ok: true,
        result: { method: request.method, params: request.params, openBootstrap }
      };
    },
    profileDoctorFn: async ({ settings, request }) => {
      calls.push({
        kind: 'profileDoctor',
        settings,
        request
      });
      return {
        ok: true,
        result: { method: request.method, params: request.params }
      };
    },
    profileOnboardFn: async ({ settings, request, openBootstrap }) => {
      calls.push({
        kind: 'profileOnboard',
        settings,
        request,
        openBootstrap
      });
      return {
        ok: true,
        result: { method: request.method, params: request.params, openBootstrap }
      };
    }
  });

  await adapter.executeTool({
    toolName: 'codex_chrome_prepare_origin',
    input: {
      origin: 'https://example.com/path',
      openBootstrap: false
    }
  });
  await adapter.executeTool({
    toolName: 'codex_chrome_readiness',
    input: {
      origin: 'https://example.com/path'
    }
  });
  await adapter.executeTool({
    toolName: 'codex_chrome_profile_doctor',
    input: {
      origin: 'https://example.com/path'
    }
  });
  await adapter.executeTool({
    toolName: 'codex_chrome_profile_onboard',
    input: {
      userDataDir: 'C:/Chrome/User Data',
      profileDirectory: 'Profile 1',
      profileLabel: 'Play Console',
      openBootstrap: false
    }
  });

  assert.deepEqual(calls.map((call) => call.kind), [
    'prepareOrigin',
    'rpc',
    'profileDoctor',
    'profileOnboard'
  ]);
  assert.equal(calls[0].settings.token, 'adapter-token');
  assert.equal(calls[0].request.method, 'operator.ensureStarted');
  assert.deepEqual(calls[0].request.params, { origin: 'https://example.com' });
  assert.equal(calls[0].openBootstrap, false);
  assert.equal(calls[1].request.method, 'operator.verifyReadiness');
  assert.deepEqual(calls[1].request.params, { origin: 'https://example.com' });
  assert.equal(calls[2].request.method, 'operator.status');
  assert.deepEqual(calls[2].request.params, { origin: 'https://example.com' });
  assert.equal(calls[3].request.method, 'operator.profiles.discover');
  assert.deepEqual(calls[3].request.params, {
    userDataDir: 'C:/Chrome/User Data',
    profileDirectory: 'Profile 1',
    profileLabel: 'Play Console'
  });
  assert.equal(calls[3].openBootstrap, false);
});

test('CodexChromeToolAdapter exposes and routes basic DOM action tools', async () => {
  const tools = listTools().map((tool) => tool.name);
  for (const toolName of [
    'codex_chrome_type',
    'codex_chrome_clear',
    'codex_chrome_focus',
    'codex_chrome_select',
    'codex_chrome_check',
    'codex_chrome_scroll',
    'codex_chrome_press_key'
  ]) {
    assert.ok(tools.includes(toolName), `${toolName} should be exposed`);
  }

  const calls = [];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async ({ request }) => {
      calls.push(request);
      return {
        ok: true,
        result: { method: request.method, params: request.params }
      };
    }
  });

  const checks = [
    ['codex_chrome_type', 'page.type', { origin: 'https://example.com', handle: 'el_0', text: 'hello' }],
    ['codex_chrome_clear', 'page.clear', { origin: 'https://example.com', handle: 'el_0' }],
    ['codex_chrome_focus', 'page.focus', { origin: 'https://example.com', handle: 'el_0' }],
    ['codex_chrome_select', 'page.select', { origin: 'https://example.com', handle: 'el_1', value: 'tr' }],
    ['codex_chrome_check', 'page.check', { origin: 'https://example.com', handle: 'el_2', checked: false }],
    ['codex_chrome_scroll', 'page.scroll', { origin: 'https://example.com', handle: 'el_4', deltaX: 0, deltaY: 240 }],
    ['codex_chrome_press_key', 'page.pressKey', { origin: 'https://example.com', handle: 'el_0', key: 'Enter' }]
  ];

  for (const [toolName, method, input] of checks) {
    const response = await adapter.executeTool({ toolName, input });
    assert.equal(response.ok, true);
    assert.equal(response.result.method, method);
    assert.deepEqual(response.result.params, input);
  }
  assert.deepEqual(calls.map((request) => request.method), checks.map(([, method]) => method));
});

test('CodexChromeToolAdapter exposes approval lifecycle tools with explicit user decisions', async () => {
  const tools = listTools().map((tool) => tool.name);
  for (const toolName of [
    'codex_chrome_approvals_list',
    'codex_chrome_approval_approve',
    'codex_chrome_approval_reject',
    'codex_chrome_approval_run'
  ]) {
    assert.ok(tools.includes(toolName), `${toolName} should be exposed`);
  }

  assert.equal(validateToolInput('codex_chrome_approval_approve', {
    approvalId: 'approval_1'
  }).error.code, 'INVALID_TOOL_INPUT');
  assert.equal(validateToolInput('codex_chrome_approval_approve', {
    approvalId: 'approval_1',
    userDecision: 'approve'
  }).ok, true);

  const calls = [];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async ({ request }) => {
      calls.push(request);
      return {
        ok: true,
        result: { method: request.method, params: request.params }
      };
    }
  });

  const checks = [
    ['codex_chrome_approvals_list', 'operator.approvals.list', { status: 'pending' }, { status: 'pending' }],
    [
      'codex_chrome_approval_approve',
      'operator.approvals.approve',
      { approvalId: 'approval_1', userDecision: 'approve' },
      { approvalId: 'approval_1' }
    ],
    [
      'codex_chrome_approval_reject',
      'operator.approvals.reject',
      { approvalId: 'approval_1', userDecision: 'reject' },
      { approvalId: 'approval_1' }
    ],
    ['codex_chrome_approval_run', 'operator.approvals.run', { approvalId: 'approval_1' }, { approvalId: 'approval_1' }]
  ];

  for (const [toolName, method, input, params] of checks) {
    const response = await adapter.executeTool({ toolName, input });
    assert.equal(response.ok, true);
    assert.equal(response.result.method, method);
    assert.deepEqual(response.result.params, params);
  }
  assert.deepEqual(calls.map((request) => request.method), checks.map(([, method]) => method));
});

test('CodexChromeToolAdapter refuses approval decision tools with mismatched decision text', async () => {
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async () => {
      throw new Error('approval decision should not reach daemon');
    }
  });

  const approve = await adapter.executeTool({
    toolName: 'codex_chrome_approval_approve',
    input: {
      approvalId: 'approval_1',
      userDecision: 'reject'
    }
  });
  assert.equal(approve.ok, false);
  assert.equal(approve.error.code, 'INVALID_TOOL_INPUT');

  const reject = await adapter.executeTool({
    toolName: 'codex_chrome_approval_reject',
    input: {
      approvalId: 'approval_1',
      userDecision: 'approve'
    }
  });
  assert.equal(reject.ok, false);
  assert.equal(reject.error.code, 'INVALID_TOOL_INPUT');
});

test('validateToolInput enforces typed basic action parameters', () => {
  assert.equal(validateToolInput('codex_chrome_check', {
    origin: 'https://example.com',
    handle: 'el_2',
    checked: 'false'
  }).error.code, 'INVALID_TOOL_INPUT');
  assert.equal(validateToolInput('codex_chrome_scroll', {
    origin: 'https://example.com',
    handle: 'el_4',
    deltaX: 0,
    deltaY: '240'
  }).error.code, 'INVALID_TOOL_INPUT');
});

test('CodexChromeToolAdapter redacts raw visual data URLs from tool responses', async () => {
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async () => ({
      ok: true,
      result: {
        title: 'Visual Page',
        screenshot: {
          artifactId: 'shot_1',
          dataUrl: 'data:image/png;base64,rawbytes'
        }
      }
    })
  });

  const response = await adapter.executeTool({
    toolName: 'codex_chrome_visual_observe',
    input: {
      origin: 'https://example.com'
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.screenshot.artifactId, 'shot_1');
  assert.equal(response.result.screenshot.dataUrl, undefined);
  assert.equal(response.result.screenshot.rawDataRedacted, true);
});

test('CodexChromeToolAdapter redacts path fields without redacting basename or hash', async () => {
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async () => ({
      ok: true,
      result: {
        file: {
          basename: 'icon.png',
          expectedSha256: 'abc123',
          path: 'C:/tmp/icon.png'
        }
      }
    })
  });

  const response = await adapter.executeTool({
    toolName: 'codex_chrome_upload_file',
    input: {
      origin: 'https://example.com',
      handle: 'el_file',
      files: []
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.file.basename, 'icon.png');
  assert.equal(response.result.file.expectedSha256, 'abc123');
  assert.equal(response.result.file.path, '[REDACTED_PATH]');
});
