const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createMcpMessageHandler,
  jsonRpcError,
  normalizeToolResult
} = require('../codex-adapter/mcpServer');

const ROOT = path.resolve(__dirname, '..');

test('MCP handler initializes with tool capability and adapter metadata', async () => {
  const handleMessage = createMcpMessageHandler();

  const response = await handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      clientInfo: {
        name: 'unit-client',
        version: '0.0.1'
      }
    }
  });

  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, '2025-06-18');
  assert.deepEqual(response.result.capabilities, { tools: {} });
  assert.equal(response.result.serverInfo.name, 'codex-chrome-operator');
  assert.equal(response.result.adapterProtocolVersion, '1.0');
  assert.match(response.result.toolDefinitionsHash, /^[a-f0-9]{64}$/);
});

test('MCP handler lists strict adapter tool schemas', async () => {
  const handleMessage = createMcpMessageHandler();

  const response = await handleMessage({
    jsonrpc: '2.0',
    id: 'tools',
    method: 'tools/list'
  });

  const openObserve = response.result.tools.find((tool) => tool.name === 'codex_chrome_open_observe');
  const visualAnalyze = response.result.tools.find((tool) => tool.name === 'codex_chrome_visual_analyze');
  const uploadFile = response.result.tools.find((tool) => tool.name === 'codex_chrome_upload_file');
  const profileDoctor = response.result.tools.find((tool) => tool.name === 'codex_chrome_profile_doctor');
  const profileOnboard = response.result.tools.find((tool) => tool.name === 'codex_chrome_profile_onboard');
  assert.ok(openObserve);
  assert.equal(openObserve.inputSchema.additionalProperties, false);
  assert.deepEqual(openObserve.inputSchema.required, ['url']);
  assert.equal(openObserve.adapterProtocolVersion, '1.0');
  assert.ok(visualAnalyze);
  assert.equal(visualAnalyze.inputSchema.additionalProperties, false);
  assert.deepEqual(visualAnalyze.inputSchema.required, ['origin']);
  assert.deepEqual(visualAnalyze.inputSchema.properties, {
    origin: { type: 'string' },
    provider: { type: 'string' },
    maxBytes: { type: 'number' },
    allowSensitive: { type: 'boolean' }
  });
  assert.ok(uploadFile);
  assert.equal(uploadFile.inputSchema.additionalProperties, false);
  assert.deepEqual(uploadFile.inputSchema.required, ['origin', 'handle', 'files']);
  assert.equal(uploadFile.inputSchema.properties.files.type, 'array');
  assert.ok(profileDoctor);
  assert.equal(profileDoctor.inputSchema.additionalProperties, false);
  assert.deepEqual(profileDoctor.inputSchema.required, []);
  assert.ok(profileOnboard);
  assert.equal(profileOnboard.inputSchema.additionalProperties, false);
  assert.deepEqual(profileOnboard.inputSchema.required, []);
});

test('MCP handler calls adapter tools and returns JSON content without raw visual bytes', async () => {
  const calls = [];
  const handleMessage = createMcpMessageHandler({
    adapter: {
      async executeTool(request) {
        calls.push(request);
        return {
          ok: true,
          toolName: request.toolName,
          protocolVersion: '1.0',
          untrusted: true,
          result: {
            title: 'Visual',
            screenshot: {
              artifactId: 'shot_1',
              rawDataRedacted: true
            }
          }
        };
      }
    }
  });

  const response = await handleMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'codex_chrome_visual_observe',
      arguments: {
        origin: 'https://example.com'
      }
    }
  });

  assert.deepEqual(calls, [{
    toolName: 'codex_chrome_visual_observe',
    input: {
      origin: 'https://example.com'
    }
  }]);
  assert.equal(response.result.isError, false);
  assert.equal(response.result.content[0].type, 'text');
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(payload.untrusted, true);
  assert.equal(payload.result.screenshot.artifactId, 'shot_1');
  assert.equal(payload.result.screenshot.dataUrl, undefined);
  assert.equal(response.result.adapterSession.callCount, 1);
  assert.equal(response.result.adapterSession.lastToolName, 'codex_chrome_visual_observe');
});

test('MCP handler exposes explicit task-level session state', async () => {
  const handleMessage = createMcpMessageHandler({
    sessionId: 'task_unit_1',
    adapter: {
      async executeTool(request) {
        return request.toolName === 'codex_chrome_status'
          ? { ok: true, toolName: request.toolName, result: { connectionState: 'EXTENSION_CONNECTED' } }
          : { ok: false, toolName: request.toolName, error: { code: 'UNIT_BLOCKED' } };
      }
    }
  });

  const initialized = await handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {}
  });
  assert.equal(initialized.result.adapterSession.sessionId, 'task_unit_1');
  assert.equal(initialized.result.adapterSession.callCount, 0);

  const first = await handleMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'codex_chrome_status',
      arguments: {}
    }
  });
  assert.equal(first.result.adapterSession.sessionId, 'task_unit_1');
  assert.equal(first.result.adapterSession.callCount, 1);
  assert.equal(first.result.adapterSession.lastToolName, 'codex_chrome_status');
  assert.equal(first.result.adapterSession.lastErrorCode, null);

  const second = await handleMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'missing_tool',
      arguments: {}
    }
  });
  assert.equal(second.result.adapterSession.callCount, 2);
  assert.equal(second.result.adapterSession.lastToolName, 'missing_tool');
  assert.equal(second.result.adapterSession.lastErrorCode, 'UNKNOWN_TOOL');
});

test('MCP handler enriches approval, gate, and policy tool errors with adapter hints', async () => {
  const responses = [
    {
      ok: false,
      error: {
        code: 'HIGH_RISK_BLOCKED',
        message: 'High-risk action blocked.',
        approvalId: 'approval_9',
        approvalKind: 'publish',
        targetSummary: 'button: Publish'
      }
    },
    {
      ok: false,
      error: {
        code: 'PASSWORD_REQUIRED',
        message: 'A password gate is visible.',
        gateType: 'PASSWORD_REQUIRED',
        resumePolicy: 'wait-and-reobserve',
        freshObservationRequired: true
      }
    },
    {
      ok: false,
      error: {
        code: 'HOST_PERMISSION_REQUIRED',
        message: 'Chrome host permission is required before action.',
        origin: 'https://example.com',
        permissionUrl: 'chrome-extension://id/permissionRequest.html?origin=https%3A%2F%2Fexample.com'
      }
    }
  ];
  const handleMessage = createMcpMessageHandler({
    adapter: {
      async executeTool() {
        return responses.shift();
      }
    }
  });

  const approval = await handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'codex_chrome_click',
      arguments: {
        origin: 'https://example.com',
        handle: 'el_1'
      }
    }
  });
  assert.equal(approval.result.structuredContent.adapterHints.category, 'approval');
  assert.equal(approval.result.structuredContent.adapterHints.approvalId, 'approval_9');
  assert.deepEqual(approval.result.structuredContent.adapterHints.nextActions[1].operatorCli, [
    'approval-approve',
    'approval_9'
  ]);

  const gate = await handleMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'codex_chrome_click',
      arguments: {
        origin: 'https://example.com',
        handle: 'el_1'
      }
    }
  });
  assert.equal(gate.result.structuredContent.adapterHints.category, 'gate-handoff');
  assert.equal(gate.result.structuredContent.adapterHints.resumePolicy, 'wait-and-reobserve');
  assert.equal(gate.result.structuredContent.adapterHints.nextActions[1].kind, 'reobserve');

  const policy = await handleMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'codex_chrome_observe',
      arguments: {
        origin: 'https://example.com'
      }
    }
  });
  assert.equal(policy.result.structuredContent.adapterHints.category, 'policy');
  assert.equal(policy.result.structuredContent.adapterHints.permissionUrl, 'chrome-extension://id/permissionRequest.html?origin=https%3A%2F%2Fexample.com');
});

test('MCP handler returns deterministic JSON-RPC errors for malformed calls', async () => {
  const handleMessage = createMcpMessageHandler();

  assert.deepEqual(jsonRpcError('x', -32601, 'Method not found.'), {
    jsonrpc: '2.0',
    id: 'x',
    error: {
      code: -32601,
      message: 'Method not found.'
    }
  });

  const response = await handleMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'missing_tool',
      arguments: {}
    }
  });

  assert.equal(response.result.isError, true);
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'UNKNOWN_TOOL');
});

test('normalizeToolResult preserves structured response and marks errors', () => {
  const result = normalizeToolResult({
    ok: false,
    error: {
      code: 'HOST_PERMISSION_REQUIRED',
      message: 'Chrome host permission is required before action.'
    }
  });

  assert.equal(result.isError, true);
  assert.equal(result.content.length, 1);
  assert.equal(JSON.parse(result.content[0].text).error.code, 'HOST_PERMISSION_REQUIRED');
});

test('package exposes MCP adapter script and docs explain local usage', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const docs = fs.readFileSync(path.join(ROOT, 'docs', 'codex-adapter.md'), 'utf8');

  assert.equal(packageJson.scripts['adapter:mcp'], 'node codex-adapter/mcpServer.js');
  assert.match(docs, /npm run adapter:mcp/);
  assert.match(docs, /tools\/list/);
  assert.match(docs, /tools\/call/);
  assert.match(docs, /adapterSession/);
  assert.match(docs, /adapterHints/);
  assert.match(docs, /codex_chrome_readiness/);
  assert.match(docs, /codex_chrome_visual_analyze/);
  assert.match(docs, /page\.visualAnalyze/);
  assert.match(docs, /codex_chrome_upload_file/);
  assert.match(docs, /page\.uploadFile/);
  assert.match(docs, /guarded\/draft-only/);
  assert.match(docs, /redacted file references/);
  assert.match(docs, /codex_chrome_profile_doctor/);
  assert.match(docs, /codex_chrome_profile_onboard/);
  assert.match(docs, /codex_chrome_approval_approve/);
  assert.match(docs, /userDecision/);
  assert.match(docs, /approval-approve/);
  assert.match(docs, /wait-and-reobserve/);
  assert.match(docs, /untrusted/);
});
