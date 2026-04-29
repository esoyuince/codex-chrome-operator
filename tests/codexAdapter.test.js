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

  assert.equal(ADAPTER_PROTOCOL_VERSION, '1.0');
  assert.ok(openObserve);
  assert.equal(openObserve.inputSchema.type, 'object');
  assert.equal(openObserve.inputSchema.additionalProperties, false);
  assert.deepEqual(openObserve.inputSchema.required, ['url']);
  assert.equal(openObserve.outputContract.untrusted, true);
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
