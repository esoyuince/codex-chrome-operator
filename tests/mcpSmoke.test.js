const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  REQUIRED_MCP_SMOKE_TOOLS,
  buildMcpSmokeMessages,
  buildMcpSmokeReport,
  parseJsonLines
} = require('../scripts/mcp-smoke');

const ROOT = path.resolve(__dirname, '..');

test('buildMcpSmokeMessages sends initialize then tools/list over stdio JSON-RPC', () => {
  assert.deepEqual(buildMcpSmokeMessages(), [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        clientInfo: {
          name: 'codex-chrome-operator-mcp-smoke',
          version: '0.1.0'
        }
      }
    },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list'
    }
  ]);
});

test('buildMcpSmokeReport summarizes required adapter tool availability', () => {
  const responses = [
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        serverInfo: {
          name: 'codex-chrome-operator',
          version: '0.1.0'
        },
        adapterProtocolVersion: '1.0',
        toolDefinitionsHash: 'a'.repeat(64)
      }
    },
    {
      jsonrpc: '2.0',
      id: 2,
      result: {
        tools: REQUIRED_MCP_SMOKE_TOOLS.map((name) => ({
          name,
          inputSchema: {
            type: 'object',
            additionalProperties: false
          }
        }))
      }
    }
  ];

  assert.deepEqual(buildMcpSmokeReport(responses), {
    ok: true,
    serverName: 'codex-chrome-operator',
    serverVersion: '0.1.0',
    protocolVersion: '2025-06-18',
    adapterProtocolVersion: '1.0',
    toolDefinitionsHash: 'a'.repeat(64),
    toolCount: REQUIRED_MCP_SMOKE_TOOLS.length,
    requiredTools: REQUIRED_MCP_SMOKE_TOOLS,
    missingTools: []
  });
});

test('buildMcpSmokeReport fails closed when a required tool is missing', () => {
  const report = buildMcpSmokeReport([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        serverInfo: { name: 'codex-chrome-operator' },
        adapterProtocolVersion: '1.0'
      }
    },
    {
      jsonrpc: '2.0',
      id: 2,
      result: {
        tools: []
      }
    }
  ]);

  assert.equal(report.ok, false);
  assert.deepEqual(report.missingTools, REQUIRED_MCP_SMOKE_TOOLS);
});

test('parseJsonLines ignores blank lines and rejects malformed JSON', () => {
  assert.deepEqual(parseJsonLines('\n{"id":1}\r\n\n{"id":2}\n'), [
    { id: 1 },
    { id: 2 }
  ]);
  assert.throws(() => parseJsonLines('not-json'), /Invalid JSON line/);
});

test('package exposes the MCP smoke script', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  assert.equal(packageJson.scripts['smoke:mcp'], 'node scripts/mcp-smoke.js');
});
