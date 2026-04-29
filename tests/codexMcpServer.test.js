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
  assert.ok(openObserve);
  assert.equal(openObserve.inputSchema.additionalProperties, false);
  assert.deepEqual(openObserve.inputSchema.required, ['url']);
  assert.equal(openObserve.adapterProtocolVersion, '1.0');
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
  assert.match(docs, /untrusted/);
});
