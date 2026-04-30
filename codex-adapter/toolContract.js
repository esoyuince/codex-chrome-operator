'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  listTools,
  toolDefinitionsHash
} = require('./toolAdapter');
const {
  ADAPTER_PROTOCOL_VERSION,
  TOOL_SCHEMA_VERSION
} = require('./schema');

const SNAPSHOT_PATH = path.join(__dirname, 'tool-contract.snapshot.json');

function loadToolContractSnapshot(snapshotPath = SNAPSHOT_PATH) {
  return JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
}

function projectTool(tool) {
  return {
    name: tool.name,
    inputSchema: tool.inputSchema,
    outputContract: {
      untrusted: tool.outputContract && tool.outputContract.untrusted,
      rawScreenshotBytes: tool.outputContract && tool.outputContract.rawScreenshotBytes
    }
  };
}

function buildCurrentToolContract() {
  const tools = listTools();
  return {
    adapterProtocolVersion: ADAPTER_PROTOCOL_VERSION,
    toolSchemaVersion: TOOL_SCHEMA_VERSION,
    toolDefinitionsHash: toolDefinitionsHash(tools),
    toolCount: tools.length,
    toolNames: tools.map((tool) => tool.name),
    tools: tools.map(projectTool)
  };
}

function collectMismatches(expected, actual, pathSegments = []) {
  if (Object.is(expected, actual)) {
    return [];
  }

  const pathLabel = pathSegments.length ? pathSegments.join('.') : '$';
  if (
    expected === null ||
    actual === null ||
    typeof expected !== 'object' ||
    typeof actual !== 'object' ||
    Array.isArray(expected) !== Array.isArray(actual)
  ) {
    return [{ path: pathLabel, expected, actual }];
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      return [{ path: pathLabel, expected, actual }];
    }
    const mismatches = [];
    if (expected.length !== actual.length) {
      mismatches.push({
        path: `${pathLabel}.length`,
        expected: expected.length,
        actual: actual.length
      });
    }
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      mismatches.push(...collectMismatches(expected[index], actual[index], [
        ...pathSegments,
        String(index)
      ]));
    }
    return mismatches;
  }

  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  return keys.flatMap((key) => (
    collectMismatches(expected[key], actual[key], [...pathSegments, key])
  ));
}

function compareToolContractSnapshot(snapshotPath = SNAPSHOT_PATH) {
  const expected = loadToolContractSnapshot(snapshotPath);
  const actual = buildCurrentToolContract();
  const mismatches = collectMismatches(expected, actual);
  return {
    ok: mismatches.length === 0,
    expected,
    actual,
    mismatches
  };
}

module.exports = {
  buildCurrentToolContract,
  compareToolContractSnapshot,
  loadToolContractSnapshot
};
