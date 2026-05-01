'use strict';

const childProcess = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_MCP_PROTOCOL_VERSION = '2025-06-18';
const SMOKE_CLIENT_NAME = 'codex-chrome-operator-mcp-smoke';
const SMOKE_CLIENT_VERSION = '0.2.6';
const REQUIRED_MCP_SMOKE_TOOLS = [
  'codex_chrome_status',
  'codex_chrome_prepare_origin',
  'codex_chrome_readiness',
  'codex_chrome_profile_doctor',
  'codex_chrome_profile_onboard',
  'codex_chrome_open_observe',
  'codex_chrome_observe',
  'codex_chrome_read_page',
  'codex_chrome_batch',
  'codex_chrome_visual_observe',
  'codex_chrome_visual_analyze',
  'codex_chrome_upload_file',
  'codex_chrome_cart_prepare',
  'codex_chrome_click',
  'codex_chrome_approval_approve',
  'codex_chrome_emergency_stop'
];

function tailText(value, maxChars = 2000) {
  const text = String(value || '');
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

function buildMcpSmokeMessages({
  protocolVersion = DEFAULT_MCP_PROTOCOL_VERSION
} = {}) {
  return [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion,
        clientInfo: {
          name: SMOKE_CLIENT_NAME,
          version: SMOKE_CLIENT_VERSION
        }
      }
    },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list'
    }
  ];
}

function parseJsonLines(text) {
  const messages = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      messages.push(JSON.parse(trimmed));
    } catch (error) {
      throw new Error(`Invalid JSON line from MCP server: ${error.message}`);
    }
  }
  return messages;
}

function resultForId(responses, id) {
  const message = responses.find((response) => response && response.id === id);
  return message && message.result ? message.result : null;
}

function summarizeToolSchemaVersion(tools) {
  const versions = Array.from(new Set(
    tools
      .map((tool) => tool && tool.toolSchemaVersion)
      .filter((version) => typeof version === 'string' && version.length > 0)
  ));
  return versions.length === 1 ? versions[0] : null;
}

function collectLooseObjectSchemaPaths(schema, pathLabel = 'inputSchema') {
  if (!schema || typeof schema !== 'object') {
    return [];
  }

  const loosePaths = [];
  if (schema.type === 'object' && schema.additionalProperties !== false) {
    loosePaths.push(pathLabel);
  }

  if (schema.properties && typeof schema.properties === 'object') {
    for (const [field, nestedSchema] of Object.entries(schema.properties)) {
      loosePaths.push(...collectLooseObjectSchemaPaths(
        nestedSchema,
        `${pathLabel}.properties.${field}`
      ));
    }
  }
  if (schema.items) {
    loosePaths.push(...collectLooseObjectSchemaPaths(schema.items, `${pathLabel}.items`));
  }
  return loosePaths;
}

function buildMcpSmokeReport(
  responses,
  { requiredTools = REQUIRED_MCP_SMOKE_TOOLS } = {}
) {
  const initialize = resultForId(responses, 1) || {};
  const toolsList = resultForId(responses, 2) || {};
  const tools = Array.isArray(toolsList.tools) ? toolsList.tools : [];
  const toolNames = new Set(tools.map((tool) => tool.name));
  const missingTools = requiredTools.filter((toolName) => !toolNames.has(toolName));
  const looseSchemaPaths = tools.flatMap((tool) => {
    if (!tool || !tool.name) {
      return [];
    }
    return collectLooseObjectSchemaPaths(tool.inputSchema).map((schemaPath) => (
      `${tool.name}.${schemaPath}`
    ));
  });
  const strictSchemaToolCount = tools.filter((tool) => (
    tool &&
    tool.inputSchema &&
    collectLooseObjectSchemaPaths(tool.inputSchema).length === 0
  )).length;
  const rawScreenshotBytesAllowed = tools
    .filter((tool) => tool && tool.outputContract && tool.outputContract.rawScreenshotBytes === true)
    .map((tool) => tool.name);
  const untrustedOutputMissing = tools
    .filter((tool) => !tool || !tool.outputContract || tool.outputContract.untrusted !== true)
    .map((tool) => tool && tool.name)
    .filter(Boolean);
  const toolDefinitionsHash = initialize.toolDefinitionsHash || toolsList.toolDefinitionsHash || null;
  const contractPinned = missingTools.length === 0 &&
    Boolean(toolDefinitionsHash) &&
    strictSchemaToolCount === tools.length &&
    looseSchemaPaths.length === 0 &&
    rawScreenshotBytesAllowed.length === 0 &&
    untrustedOutputMissing.length === 0;

  return {
    ok: contractPinned &&
      initialize.serverInfo &&
      initialize.serverInfo.name === 'codex-chrome-operator',
    serverName: initialize.serverInfo ? initialize.serverInfo.name : null,
    serverVersion: initialize.serverInfo ? initialize.serverInfo.version : null,
    protocolVersion: initialize.protocolVersion || null,
    adapterProtocolVersion: initialize.adapterProtocolVersion || toolsList.adapterProtocolVersion || null,
    toolDefinitionsHash,
    toolCount: tools.length,
    toolSchemaVersion: summarizeToolSchemaVersion(tools),
    strictSchemaToolCount,
    looseSchemaPaths,
    rawScreenshotBytesAllowed,
    untrustedOutputMissing,
    contractPinned,
    requiredTools,
    missingTools
  };
}

function runMcpSmoke({
  nodePath = process.execPath,
  serverScript = path.join(ROOT, 'codex-adapter', 'mcpServer.js'),
  spawnFn = childProcess.spawn,
  timeoutMs = 10000
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(nodePath, [serverScript], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      if (child.kill) {
        child.kill();
      }
      reject(new Error(`Timed out waiting for MCP smoke after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (status) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      let report;
      try {
        report = buildMcpSmokeReport(parseJsonLines(stdout));
      } catch (error) {
        report = {
          ok: false,
          parseError: error.message
        };
      }
      resolve({
        ...report,
        exitCode: typeof status === 'number' ? status : 1,
        stderrTail: tailText(stderr),
        ok: report.ok === true && status === 0
      });
    });

    for (const message of buildMcpSmokeMessages()) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    child.stdin.end();
  });
}

if (require.main === module) {
  runMcpSmoke().then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  REQUIRED_MCP_SMOKE_TOOLS,
  buildMcpSmokeMessages,
  buildMcpSmokeReport,
  parseJsonLines,
  runMcpSmoke
};
