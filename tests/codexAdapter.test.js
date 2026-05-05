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
  const observe = tools.find((tool) => tool.name === 'codex_chrome_observe');
  const status = tools.find((tool) => tool.name === 'codex_chrome_status');
  const profileOnboard = tools.find((tool) => tool.name === 'codex_chrome_profile_onboard');
  const uploadFile = tools.find((tool) => tool.name === 'codex_chrome_upload_file');
  const cartPrepare = tools.find((tool) => tool.name === 'codex_chrome_cart_prepare');
  const extract = tools.find((tool) => tool.name === 'codex_chrome_extract');
  const readPage = tools.find((tool) => tool.name === 'codex_chrome_read_page');
  const batch = tools.find((tool) => tool.name === 'codex_chrome_batch');
  const visualObserve = tools.find((tool) => tool.name === 'codex_chrome_visual_observe');
  const mediaInspect = tools.find((tool) => tool.name === 'codex_chrome_media_inspect');

  assert.equal(ADAPTER_PROTOCOL_VERSION, '1.0');
  assert.ok(status);
  assert.equal(status.inputSchema.type, 'object');
  assert.equal(status.inputSchema.additionalProperties, false);
  assert.deepEqual(status.inputSchema.required, []);
  assert.deepEqual(status.inputSchema.properties.detail.enum, ['compact', 'full']);
  assert.ok(openObserve);
  assert.equal(openObserve.inputSchema.type, 'object');
  assert.equal(openObserve.inputSchema.additionalProperties, false);
  assert.deepEqual(openObserve.inputSchema.required, ['url']);
  assert.deepEqual(openObserve.inputSchema.properties.mode.enum, ['tiny', 'medium', 'full']);
  assert.equal(openObserve.inputSchema.properties.maxActionableHandles.minimum, 1);
  assert.equal(openObserve.inputSchema.properties.summaryMaxChars.minimum, 1);
  assert.equal(openObserve.inputSchema.properties.sincePageStateId.type, 'string');
  assert.equal(openObserve.outputContract.untrusted, true);
  assert.ok(observe);
  assert.deepEqual(observe.inputSchema.properties.mode.enum, ['tiny', 'medium', 'full']);
  assert.equal(observe.inputSchema.properties.maxActionableHandles.minimum, 1);
  assert.equal(observe.inputSchema.properties.summaryMaxChars.minimum, 1);
  assert.equal(observe.inputSchema.properties.sincePageStateId.type, 'string');
  assert.equal(observe.inputSchema.properties.includeFormValues.type, 'boolean');
  assert.equal(observe.inputSchema.properties.maxFieldValueChars.type, 'number');
  assert.equal(observe.inputSchema.properties.includeAx.type, 'boolean');
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
  assert.ok(cartPrepare);
  assert.equal(cartPrepare.inputSchema.type, 'object');
  assert.equal(cartPrepare.inputSchema.additionalProperties, false);
  assert.deepEqual(cartPrepare.inputSchema.required, ['origin', 'query', 'cartActionAllowed']);
  assert.equal(cartPrepare.inputSchema.properties.criteria.additionalProperties, false);
  assert.match(cartPrepare.description, /stop before checkout\/payment/i);
  assert.equal(cartPrepare.outputContract.untrusted, true);
  assert.equal(cartPrepare.outputContract.rawScreenshotBytes, false);
  assert.ok(extract);
  assert.equal(extract.inputSchema.type, 'object');
  assert.equal(extract.inputSchema.additionalProperties, false);
  assert.deepEqual(extract.inputSchema.required, ['origin', 'intent']);
  assert.equal(extract.inputSchema.properties.origin.type, 'string');
  assert.equal(extract.inputSchema.properties.intent.type, 'string');
  assert.equal(extract.inputSchema.properties.maxCandidates.type, 'number');
  assert.equal(extract.inputSchema.properties.maxCandidates.minimum, 1);
  assert.match(extract.description, /intent-scoped/i);
  assert.ok(readPage);
  assert.deepEqual(readPage.inputSchema.required, ['origin']);
  assert.equal(readPage.inputSchema.properties.maxChars.type, 'number');
  assert.equal(readPage.inputSchema.properties.refId.type, 'string');
  assert.equal(readPage.inputSchema.properties.includeFormValues.type, 'boolean');
  assert.equal(readPage.inputSchema.properties.maxFieldValueChars.type, 'number');
  assert.ok(batch);
  assert.deepEqual(batch.inputSchema.required, ['origin', 'actions']);
  assert.equal(batch.inputSchema.properties.actions.type, 'array');
  assert.equal(batch.inputSchema.properties.actions.items.additionalProperties, false);
  assert.ok(visualObserve);
  assert.deepEqual(visualObserve.inputSchema.required, ['origin']);
  assert.equal(visualObserve.inputSchema.properties.maxBytes.minimum, 1);
  assert.deepEqual(visualObserve.inputSchema.properties.mode.enum, ['tiny', 'medium', 'full']);
  assert.equal(visualObserve.inputSchema.properties.reason.type, 'string');
  assert.match(visualObserve.description, /visual verification/i);
  assert.ok(mediaInspect);
  assert.deepEqual(mediaInspect.inputSchema.required, ['origin']);
  assert.equal(mediaInspect.inputSchema.properties.maxItems.minimum, 1);
  assert.match(mediaInspect.description, /media/i);
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
      pollIntervalMs: 25,
      mode: 'medium',
      maxActionableHandles: 35,
      summaryMaxChars: 900,
      sincePageStateId: 'state_1'
    }).ok,
    true
  );
  assert.equal(validateToolInput('codex_chrome_open_observe', {
    url: 'https://example.com',
    mode: 'wide'
  }).error.code, 'INVALID_TOOL_INPUT');
  assert.equal(validateToolInput('codex_chrome_open_observe', {
    url: 'https://example.com',
    maxActionableHandles: 0
  }).error.code, 'INVALID_TOOL_INPUT');
  assert.equal(validateToolInput('codex_chrome_observe', {
    origin: 'https://example.com/path',
    mode: 'tiny',
    maxActionableHandles: 12,
    summaryMaxChars: 300,
    sincePageStateId: 'state_1'
  }).ok, true);
  assert.equal(validateToolInput('codex_chrome_observe', {
    origin: 'https://example.com',
    summaryMaxChars: 0
  }).error.code, 'INVALID_TOOL_INPUT');
  assert.equal(validateToolInput('codex_chrome_status', {}).ok, true);
  assert.equal(validateToolInput('codex_chrome_status', { detail: 'compact' }).ok, true);
  assert.equal(validateToolInput('codex_chrome_status', { detail: 'full' }).ok, true);
  assert.equal(
    validateToolInput('codex_chrome_status', { detail: 'verbose' }).error.code,
    'INVALID_TOOL_INPUT'
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
  assert.equal(
    validateToolInput('codex_chrome_upload_file', {
      origin: 'https://example.com',
      handle: 'el_file',
      files: [{
        role: 'playStoreAppIcon',
        path: 'C:/tmp/icon.png',
        unexpected: true
      }]
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_upload_file', {
      origin: 'https://example.com',
      handle: 'el_file',
      files: [{
        role: 'playStoreAppIcon',
        path: 'C:/tmp/icon.png',
        expectedSha256: 'abc123'
      }]
    }).ok,
    true
  );
  assert.equal(
    validateToolInput('codex_chrome_cart_prepare', {
      origin: 'https://shop.example',
      query: 'portable charger'
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_cart_prepare', {
      origin: 'https://shop.example',
      query: 'portable charger',
      cartActionAllowed: true,
      checkoutAllowed: true
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_cart_prepare', {
      origin: 'https://shop.example',
      query: 'portable charger',
      cartActionAllowed: true,
      criteria: {
        maxPrice: '50'
      }
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_cart_prepare', {
      origin: 'https://shop.example',
      query: 'portable charger',
      cartActionAllowed: true,
      criteria: {
        maxPrice: 50,
        checkout: true
      }
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_cart_prepare', {
      origin: 'https://shop.example/path',
      query: 'portable charger',
      cartActionAllowed: true,
      criteria: {
        minSellerRating: 4.7,
        maxPrice: 50,
        currency: 'USD',
        sort: 'price-asc'
      }
    }).ok,
    true
  );
  assert.equal(
    validateToolInput('codex_chrome_read_page', {
      origin: 'https://example.com/path',
      filter: 'interactive',
      depth: 4,
      maxChars: 12000,
      refId: 'el_state_0',
      includeFormValues: true,
      maxFieldValueChars: 80
    }).ok,
    true
  );
  assert.equal(
    validateToolInput('codex_chrome_extract', {
      origin: 'https://shop.example/path',
      intent: 'shopping.productCandidates',
      maxCandidates: 3
    }).ok,
    true
  );
  assert.equal(
    validateToolInput('codex_chrome_extract', {
      origin: 'https://shop.example',
      intent: 'shopping.productCandidates',
      maxCandidates: 0
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_extract', {
      origin: 'https://shop.example',
      intent: 'shopping.productCandidates',
      includeDom: true
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_visual_observe', {
      origin: 'https://example.com/path',
      mode: 'medium',
      maxBytes: 120000,
      reason: 'DOM confidence low around product tiles'
    }).ok,
    true
  );
  assert.equal(
    validateToolInput('codex_chrome_visual_observe', {
      origin: 'https://example.com/path',
      maxBytes: 0
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_batch', {
      origin: 'https://example.com',
      actions: [{
        action: 'observe',
        sincePageStateId: 'state_previous',
        mode: 'tiny',
        maxActionableHandles: 10,
        summaryMaxChars: 300,
        includeFormValues: true,
        maxFieldValueChars: 80
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
      }],
      stopOnError: true
    }).ok,
    true
  );
  assert.equal(
    validateToolInput('codex_chrome_batch', {
      origin: 'https://example.com',
      actions: [{
        action: 'observe',
        sincePageStateId: 'state_previous'
      }]
    }).ok,
    true
  );
  assert.equal(
    validateToolInput('codex_chrome_fill', {
      origin: 'https://example.com',
      handle: 'el_state_0',
      text: 'Draft',
      postActionSnapshot: 'delta',
      sincePageStateId: 'state_previous',
      maxActionableHandles: 10
    }).ok,
    true
  );
  assert.equal(
    validateToolInput('codex_chrome_fill', {
      origin: 'https://example.com',
      handle: 'el_state_0',
      text: 'Draft',
      postActionSnapshot: 'full'
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
  assert.equal(
    validateToolInput('codex_chrome_batch', {
      origin: 'https://example.com',
      actions: [{
        action: 'fill',
        handle: 'el_state_0',
        text: 'Draft',
        extra: true
      }]
    }).error.code,
    'INVALID_TOOL_INPUT'
  );
});

test('CodexChromeToolAdapter forwards explicit form value observe and read-page options', async () => {
  const calls = [];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async ({ request }) => {
      calls.push(request);
      return { ok: true, result: { method: request.method, params: request.params } };
    }
  });

  const observed = await adapter.executeTool({
    toolName: 'codex_chrome_observe',
    input: {
      origin: 'https://example.com/form',
      mode: 'full',
      includeFormValues: true,
      maxFieldValueChars: 64
    }
  });
  const read = await adapter.executeTool({
    toolName: 'codex_chrome_read_page',
    input: {
      origin: 'https://example.com/form',
      filter: 'all',
      includeFormValues: true,
      maxFieldValueChars: 32
    }
  });

  assert.equal(observed.ok, true);
  assert.equal(read.ok, true);
  assert.deepEqual(calls.map((call) => call.params), [{
    origin: 'https://example.com',
    mode: 'full',
    includeFormValues: true,
    maxFieldValueChars: 64
  }, {
    origin: 'https://example.com',
    filter: 'all',
    includeFormValues: true,
    maxFieldValueChars: 32
  }]);
});

test('CodexChromeToolAdapter defaults status to compact, forwards detail, and attaches telemetry', async () => {
  const calls = [];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async ({ request }) => {
      calls.push(request);
      if (request.params.detail === 'compact') {
        return {
          ok: true,
          result: {
            connectionState: 'EXTENSION_CONNECTED',
            pendingApprovalCount: 0,
            approvedOriginCount: 1,
            blockedOriginCount: 0,
            domainApprovalCount: 1,
            hostPermissionOriginCount: 1
          }
        };
      }
      return {
        ok: true,
        result: {
          connectionState: 'EXTENSION_CONNECTED',
          recentEvents: [{ type: 'unit' }],
          approvedOrigins: ['https://example.com']
        }
      };
    }
  });

  const compact = await adapter.executeTool({
    toolName: 'codex_chrome_status',
    input: {}
  });
  const full = await adapter.executeTool({
    toolName: 'codex_chrome_status',
    input: { detail: 'full' }
  });
  const invalid = await adapter.executeTool({
    toolName: 'codex_chrome_status',
    input: { detail: 'verbose' }
  });

  assert.deepEqual(calls.map((call) => call.params), [
    { detail: 'compact' },
    { detail: 'full' }
  ]);
  assert.equal(compact.ok, true);
  assert.equal(compact.telemetry.budgetName, 'codex_chrome_status.compact');
  assert.equal(compact.telemetry.resultChars, JSON.stringify(compact.result).length);
  assert.equal(compact.telemetry.approxResultTokens, Math.ceil(compact.telemetry.resultChars / 4));
  assert.equal(compact.telemetry.approxResponseTokens, Math.ceil(compact.telemetry.responseChars / 4));
  assert.equal(typeof compact.telemetry.responseChars, 'number');
  assert.equal(full.telemetry.budgetName, 'codex_chrome_status');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'INVALID_TOOL_INPUT');
  assert.equal(invalid.telemetry.budgetName, 'codex_chrome_status');
  assert.equal(calls.length, 2);
});

test('CodexChromeToolAdapter routes compact read page and batch actions with normalized origins', async () => {
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

  const readPage = await adapter.executeTool({
    toolName: 'codex_chrome_read_page',
    input: {
      origin: 'https://example.com/path?x=1',
      filter: 'interactive',
      depth: 3,
      maxChars: 12000,
      refId: 'el_state_0'
    }
  });
  const batch = await adapter.executeTool({
    toolName: 'codex_chrome_batch',
    input: {
      origin: 'https://example.com/form',
      stopOnError: true,
      actions: [{
        action: 'fill',
        handle: 'el_state_0',
        text: 'Draft'
      }, {
        action: 'pressKey',
        handle: 'el_state_0',
        key: 'Enter'
      }]
    }
  });

  assert.equal(readPage.ok, true);
  assert.equal(batch.ok, true);
  assert.deepEqual(calls.map((call) => call.method), ['page.readPage', 'page.batch']);
  assert.deepEqual(calls[0].params, {
    origin: 'https://example.com',
    filter: 'interactive',
    depth: 3,
    maxChars: 12000,
    refId: 'el_state_0'
  });
  assert.deepEqual(calls[1].params, {
    origin: 'https://example.com',
    stopOnError: true,
    actions: [{
      action: 'fill',
      handle: 'el_state_0',
      text: 'Draft'
    }, {
      action: 'pressKey',
      handle: 'el_state_0',
      key: 'Enter'
    }]
  });
});

test('CodexChromeToolAdapter routes cart preparation with normalized origin and safe defaults', async () => {
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
          params: request.params,
          screenshot: {
            dataUrl: 'data:image/png;base64,rawbytes'
          }
        }
      };
    }
  });

  const response = await adapter.executeTool({
    toolName: 'codex_chrome_cart_prepare',
    input: {
      origin: 'https://shop.example/products?ref=codex',
      profileId: 'profile_1',
      query: 'portable charger',
      cartActionAllowed: true
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.untrusted, true);
  assert.equal(response.result.method, 'page.prepareCart');
  assert.deepEqual(response.result.params, {
    origin: 'https://shop.example',
    profileId: 'profile_1',
    query: 'portable charger',
    criteria: {},
    cartActionAllowed: true
  });
  assert.equal(response.result.screenshot.dataUrl, undefined);
  assert.equal(response.result.screenshot.rawDataRedacted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'page.prepareCart');
  assert.deepEqual(calls[0].params, {
    origin: 'https://shop.example',
    profileId: 'profile_1',
    query: 'portable charger',
    criteria: {},
    cartActionAllowed: true
  });
});

test('CodexChromeToolAdapter forwards intent-scoped extraction with normalized origin', async () => {
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

  const response = await adapter.executeTool({
    toolName: 'codex_chrome_extract',
    input: {
      origin: 'https://shop.example/products?q=perfume',
      intent: 'shopping.productCandidates',
      maxCandidates: 4
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.method, 'page.extract');
  assert.deepEqual(response.result.params, {
    origin: 'https://shop.example',
    intent: 'shopping.productCandidates',
    maxCandidates: 4
  });
  assert.deepEqual(calls.map((request) => request.method), ['page.extract']);
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

test('CodexChromeToolAdapter routes media inspect with normalized origin', async () => {
  const calls = [];
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async ({ request }) => {
      calls.push(request);
      return { ok: true, result: { media: [] } };
    }
  });

  const response = await adapter.executeTool({
    toolName: 'codex_chrome_media_inspect',
    input: {
      origin: 'https://example.com/watch?v=1',
      maxItems: 3
    }
  });

  assert.equal(response.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'page.mediaInspect');
  assert.deepEqual(calls[0].params, {
    origin: 'https://example.com',
    maxItems: 3
  });
});

test('CodexChromeToolAdapter routes visual observe with normalized origin and screenshot budget options', async () => {
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
    toolName: 'codex_chrome_visual_observe',
    input: {
      origin: 'https://example.com/deep/path?x=1#section',
      mode: 'medium',
      maxActionableHandles: 12,
      summaryMaxChars: 400,
      sincePageStateId: 'state_visual_1',
      maxBytes: 120000,
      reason: 'visual verification after DOM uncertainty'
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.method, 'page.visualObserve');
  assert.deepEqual(response.result.params, {
    origin: 'https://example.com',
    mode: 'medium',
    maxActionableHandles: 12,
    summaryMaxChars: 400,
    sincePageStateId: 'state_visual_1',
    maxBytes: 120000,
    reason: 'visual verification after DOM uncertainty'
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'page.visualObserve');
});

test('CodexChromeToolAdapter forwards observe options with normalized origins', async () => {
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
    toolName: 'codex_chrome_observe',
    input: {
      origin: 'https://example.com/path?x=1',
      mode: 'medium',
      maxActionableHandles: 15,
      summaryMaxChars: 600,
      sincePageStateId: 'state_previous',
      includeAx: true
    }
  });

  assert.equal(response.ok, true);
  assert.deepEqual(response.result.params, {
    origin: 'https://example.com',
    mode: 'medium',
    maxActionableHandles: 15,
    summaryMaxChars: 600,
    sincePageStateId: 'state_previous',
    includeAx: true
  });
  assert.equal(calls[0].method, 'page.observe');
});

test('CodexChromeToolAdapter telemetry gates compact observe result size', async () => {
  const adapter = new CodexChromeToolAdapter({
    settings: {
      baseUrl: 'http://127.0.0.1:19091',
      token: 'adapter-token',
      installDir: 'C:/Operator'
    },
    sendRpcFn: async () => ({
      ok: true,
      result: {
        origin: 'https://example.com',
        url: 'https://example.com/list',
        title: 'Compact List',
        observationMode: 'tiny',
        visibleTextSummary: 'Search results with a bounded visible summary.',
        elements: Array.from({ length: 30 }, (_, index) => ({
          handle: `el_state_${index}`,
          tag: 'button',
          role: 'button',
          label: `Action ${index}`
        })),
        landmarks: [{ tag: 'main', role: 'main', label: 'Results' }]
      }
    })
  });

  const response = await adapter.executeTool({
    toolName: 'codex_chrome_observe',
    input: {
      origin: 'https://example.com',
      mode: 'tiny'
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.telemetry.budgetName, 'codex_chrome_observe');
  assert.ok(response.telemetry.resultChars < 8000, 'tiny observe should stay under the compact result budget');
  assert.ok(response.telemetry.approxResultTokens < 2000, 'tiny observe should stay under the compact token budget');
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
      pollIntervalMs: 25,
      mode: 'full',
      maxActionableHandles: 80,
      summaryMaxChars: 1800,
      sincePageStateId: 'state_open'
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
    pollIntervalMs: 25,
    mode: 'full',
    maxActionableHandles: 80,
    summaryMaxChars: 1800,
    sincePageStateId: 'state_open'
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
    ['codex_chrome_type', 'page.type', {
      origin: 'https://example.com',
      handle: 'el_0',
      text: 'hello',
      postActionSnapshot: 'delta',
      sincePageStateId: 'state_previous',
      maxActionableHandles: 8
    }],
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
