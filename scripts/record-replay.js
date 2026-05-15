'use strict';

const fs = require('node:fs');
const { sendRpc } = require('../native-bridge/daemonClient');
const { resolveCliSettings } = require('./operator-cli');

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function requestId(prefix = 'replay') {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function responseExpectation(response = {}) {
  if (response.ok === true) {
    return {
      ok: true,
      errorCode: null,
      ...(response.result === undefined ? {} : { result: cloneJson(response.result) })
    };
  }
  return {
    ok: false,
    errorCode: response.error && response.error.code ? response.error.code : null
  };
}

function createTraceRecorder({
  name = 'operator-trace',
  fixtureUrl = null,
  metadata = {}
} = {}) {
  return {
    trace: {
      version: 1,
      name,
      fixtureUrl,
      metadata: cloneJson(metadata),
      createdAt: new Date().toISOString(),
      steps: []
    }
  };
}

function normalizeAnnotations(annotations = {}) {
  return {
    domMutations: Array.isArray(annotations.domMutations) ? cloneJson(annotations.domMutations) : [],
    dialogs: Array.isArray(annotations.dialogs) ? cloneJson(annotations.dialogs) : [],
    policyDecisions: Array.isArray(annotations.policyDecisions) ? cloneJson(annotations.policyDecisions) : []
  };
}

async function recordRpc(recorder, {
  method,
  params = {},
  annotations = {},
  sendRpcFn = sendRpc,
  settings = resolveCliSettings()
} = {}) {
  if (!recorder || !recorder.trace || !Array.isArray(recorder.trace.steps)) {
    throw new Error('recordRpc requires a trace recorder.');
  }
  if (typeof method !== 'string' || !method.trim()) {
    throw new Error('recordRpc requires method.');
  }

  const request = {
    id: requestId('record'),
    method,
    params: cloneJson(params)
  };
  const response = await sendRpcFn({
    baseUrl: settings.baseUrl,
    token: settings.token,
    request
  });
  recorder.trace.steps.push({
    method,
    params: cloneJson(params),
    expect: responseExpectation(response),
    annotations: normalizeAnnotations(annotations),
    recordedAt: new Date().toISOString()
  });
  return response;
}

function resultContainsSubset(actual, expected) {
  if (expected === undefined) {
    return true;
  }
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) {
    return Object.is(actual, expected);
  }
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
    return false;
  }
  return Object.entries(expected).every(([key, value]) => resultContainsSubset(actual[key], value));
}

async function replayTrace(trace, {
  sendRpcFn = sendRpc,
  settings = resolveCliSettings()
} = {}) {
  if (!trace || trace.version !== 1 || !Array.isArray(trace.steps)) {
    throw new Error('Replay trace must be a version 1 trace with steps.');
  }

  const steps = [];
  for (let index = 0; index < trace.steps.length; index += 1) {
    const step = trace.steps[index];
    const response = await sendRpcFn({
      baseUrl: settings.baseUrl,
      token: settings.token,
      request: {
        id: requestId('replay'),
        method: step.method,
        params: cloneJson(step.params || {})
      }
    });
    const expect = step.expect || {};
    if (expect.ok === true && response.ok !== true) {
      throw new Error(`Replay step ${index} expected ok response.`);
    }
    if (expect.ok === false) {
      const actualCode = response.error && response.error.code;
      if (response.ok !== false || actualCode !== expect.errorCode) {
        throw new Error(`Replay step ${index} expected error ${expect.errorCode}, got ${actualCode || 'ok'}.`);
      }
    }
    if (expect.result !== undefined && !resultContainsSubset(response.result, expect.result)) {
      throw new Error(`Replay step ${index} result did not match expected subset.`);
    }
    steps.push({
      index,
      method: step.method,
      ok: true,
      annotations: normalizeAnnotations(step.annotations)
    });
  }

  return {
    ok: true,
    version: trace.version,
    name: trace.name || null,
    fixtureUrl: trace.fixtureUrl || null,
    steps
  };
}

async function main() {
  const tracePath = process.argv[2];
  if (!tracePath) {
    throw new Error('Usage: node scripts/record-replay.js <trace.json>');
  }
  const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
  const report = await replayTrace(trace);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  createTraceRecorder,
  recordRpc,
  replayTrace
};
