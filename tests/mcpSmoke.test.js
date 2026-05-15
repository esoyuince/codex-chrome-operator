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
          version: '0.2.13'
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
  assert.ok(REQUIRED_MCP_SMOKE_TOOLS.includes('codex_chrome_cart_prepare'));
  assert.ok(REQUIRED_MCP_SMOKE_TOOLS.includes('codex_chrome_user_tabs'));
  assert.ok(REQUIRED_MCP_SMOKE_TOOLS.includes('codex_chrome_claim_tab'));
  assert.ok(REQUIRED_MCP_SMOKE_TOOLS.includes('codex_chrome_session_tabs'));
  assert.ok(REQUIRED_MCP_SMOKE_TOOLS.includes('codex_chrome_new_tab'));
  assert.ok(REQUIRED_MCP_SMOKE_TOOLS.includes('codex_chrome_name_session'));
  assert.ok(REQUIRED_MCP_SMOKE_TOOLS.includes('codex_chrome_finalize_tabs'));
  assert.ok(REQUIRED_MCP_SMOKE_TOOLS.includes('codex_chrome_tab_screenshot'));
  assert.ok(REQUIRED_MCP_SMOKE_TOOLS.includes('codex_chrome_tab_handle_dialog'));
  assert.ok(REQUIRED_MCP_SMOKE_TOOLS.includes('codex_chrome_tab_goto'));
  assert.ok(REQUIRED_MCP_SMOKE_TOOLS.includes('codex_chrome_tab_observe'));
  assert.ok(REQUIRED_MCP_SMOKE_TOOLS.includes('codex_chrome_tab_read_page'));
  assert.ok(REQUIRED_MCP_SMOKE_TOOLS.includes('codex_chrome_tab_locator'));
  assert.ok(REQUIRED_MCP_SMOKE_TOOLS.includes('codex_chrome_download_wait'));
  assert.ok(REQUIRED_MCP_SMOKE_TOOLS.includes('codex_chrome_download_show'));
  assert.ok(REQUIRED_MCP_SMOKE_TOOLS.includes('codex_chrome_tab_focus'));
  assert.ok(REQUIRED_MCP_SMOKE_TOOLS.includes('codex_chrome_tab_pin'));
  assert.ok(REQUIRED_MCP_SMOKE_TOOLS.includes('codex_chrome_tab_move'));
  assert.ok(REQUIRED_MCP_SMOKE_TOOLS.includes('codex_chrome_tab_group_rename'));
  assert.ok(REQUIRED_MCP_SMOKE_TOOLS.includes('codex_chrome_policy_status'));
  assert.ok(REQUIRED_MCP_SMOKE_TOOLS.includes('codex_chrome_policy_update'));

  const toolSchemaVersion = '2026-05-15.session-tabs';
  const responses = [
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        serverInfo: {
          name: 'codex-chrome-operator',
          version: '0.2.13'
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
          toolSchemaVersion,
          inputSchema: {
            type: 'object',
            additionalProperties: false
          },
          outputContract: {
            untrusted: true,
            rawScreenshotBytes: false
          }
        }))
      }
    }
  ];

  assert.deepEqual(buildMcpSmokeReport(responses), {
    ok: true,
    serverName: 'codex-chrome-operator',
    serverVersion: '0.2.13',
    protocolVersion: '2025-06-18',
    adapterProtocolVersion: '1.0',
    toolDefinitionsHash: 'a'.repeat(64),
    toolCount: REQUIRED_MCP_SMOKE_TOOLS.length,
    toolSchemaVersion,
    strictSchemaToolCount: REQUIRED_MCP_SMOKE_TOOLS.length,
    looseSchemaPaths: [],
    rawScreenshotBytesAllowed: [],
    untrustedOutputMissing: [],
    contractPinned: true,
    requiredTools: REQUIRED_MCP_SMOKE_TOOLS,
    missingTools: []
  });
});

test('buildMcpSmokeReport fails closed when adapter contract proof is not pinned', () => {
  const looseTool = REQUIRED_MCP_SMOKE_TOOLS[0];
  const rawScreenshotTool = REQUIRED_MCP_SMOKE_TOOLS[1];
  const trustedOutputTool = REQUIRED_MCP_SMOKE_TOOLS[2];
  const nestedLooseTool = REQUIRED_MCP_SMOKE_TOOLS[3];
  const responses = [
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        serverInfo: {
          name: 'codex-chrome-operator',
          version: '0.2.13'
        },
        adapterProtocolVersion: '1.0'
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
            additionalProperties: name === looseTool,
            ...(name === nestedLooseTool
              ? { properties: { nested: { type: 'object' } } }
              : {})
          },
          outputContract: {
            untrusted: name !== trustedOutputTool,
            rawScreenshotBytes: name === rawScreenshotTool
          }
        }))
      }
    }
  ];

  const report = buildMcpSmokeReport(responses);

  assert.equal(report.ok, false);
  assert.equal(report.toolDefinitionsHash, null);
  assert.equal(report.toolSchemaVersion, null);
  assert.equal(report.strictSchemaToolCount, REQUIRED_MCP_SMOKE_TOOLS.length - 2);
  assert.deepEqual(report.looseSchemaPaths, [
    `${looseTool}.inputSchema`,
    `${nestedLooseTool}.inputSchema.properties.nested`
  ]);
  assert.deepEqual(report.rawScreenshotBytesAllowed, [rawScreenshotTool]);
  assert.deepEqual(report.untrustedOutputMissing, [trustedOutputTool]);
  assert.equal(report.contractPinned, false);
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
  assert.equal(packageJson.scripts['smoke:live'], 'node scripts/live-smoke.js');
});
