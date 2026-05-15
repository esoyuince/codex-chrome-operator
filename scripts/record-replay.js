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
    const result = sanitizeExpectationResult(response.result);
    return {
      ok: true,
      errorCode: null,
      ...(result === undefined ? {} : { result })
    };
  }
  return {
    ok: false,
    errorCode: response.error && response.error.code ? response.error.code : null
  };
}

const CONTEXT_RESULT_KEYS = new Set([
  'tabId',
  'origin',
  'url',
  'pageStateId',
  'screenshot',
  'focusDisturbance',
  'target'
]);

function sanitizeExpectationResult(value, depth = 0) {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeExpectationResult(item, depth + 1));
  }
  if (!value || typeof value !== 'object') {
    return cloneJson(value);
  }
  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'dataUrl' || key === 'path') {
      continue;
    }
    if (depth === 0 && (CONTEXT_RESULT_KEYS.has(key) || key === 'visual')) {
      continue;
    }
    const sanitized = sanitizeExpectationResult(nested, depth + 1);
    if (sanitized !== undefined) {
      result[key] = sanitized;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeReplayValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeReplayValue(item));
  }
  if (!value || typeof value !== 'object') {
    return cloneJson(value);
  }
  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'dataUrl' || key === 'path') {
      continue;
    }
    result[key] = sanitizeReplayValue(nested);
  }
  return result;
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

function compactScreenshot(screenshot = {}) {
  if (!screenshot || typeof screenshot !== 'object') {
    return null;
  }
  const compact = {};
  for (const key of ['artifactId', 'mimeType', 'bytes', 'width', 'height', 'sha256']) {
    if (screenshot[key] !== undefined && screenshot[key] !== null) {
      compact[key] = cloneJson(screenshot[key]);
    }
  }
  return Object.keys(compact).length > 0 ? compact : null;
}

function visualAnalysisContext(result = {}) {
  const analysis = result.visual && result.visual.analysis
    ? result.visual.analysis
    : result.analysis;
  if (!analysis || typeof analysis !== 'object') {
    return null;
  }
  const regions = Array.isArray(analysis.regions) ? analysis.regions : [];
  const handleCorrelations = Array.isArray(analysis.handleCorrelations) ? analysis.handleCorrelations : [];
  return {
    ...(analysis.status ? { status: analysis.status } : {}),
    regionKinds: regions.map((region) => region && region.kind).filter(Boolean),
    regionCount: regions.length,
    handleCorrelationCount: handleCorrelations.length
  };
}

function extractReplayContext(response = {}) {
  if (!response || response.ok !== true || !response.result || typeof response.result !== 'object') {
    return null;
  }
  const result = response.result;
  const context = {};
  for (const key of ['tabId', 'origin', 'url', 'pageStateId']) {
    if (result[key] !== undefined && result[key] !== null) {
      context[key] = cloneJson(result[key]);
    }
  }
  const screenshot = compactScreenshot(result.screenshot);
  if (screenshot) {
    context.screenshot = screenshot;
  }
  const visual = visualAnalysisContext(result);
  if (visual) {
    context.visual = visual;
  }
  if (result.focusDisturbance && typeof result.focusDisturbance === 'object') {
    context.focusDisturbance = sanitizeReplayValue(result.focusDisturbance);
  }
  if (result.target && typeof result.target === 'object') {
    context.target = sanitizeReplayValue({
      handle: result.target.handle,
      tag: result.target.tag,
      role: result.target.role,
      label: result.target.label
    });
  }
  return Object.keys(context).length > 0 ? context : null;
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
    ...(extractReplayContext(response) ? { context: extractReplayContext(response) } : {}),
    annotations: normalizeAnnotations(annotations),
    recordedAt: new Date().toISOString()
  });
  return response;
}

function arrayEqual(left = [], right = []) {
  return Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));
}

function contextDrift(expected = {}, actual = {}) {
  const drift = [];
  for (const field of ['tabId', 'origin', 'url', 'pageStateId']) {
    if (expected[field] !== undefined && !Object.is(expected[field], actual[field])) {
      drift.push({ field, expected: expected[field], actual: actual[field] });
    }
  }
  if (expected.screenshot && typeof expected.screenshot === 'object') {
    const actualScreenshot = actual.screenshot && typeof actual.screenshot === 'object'
      ? actual.screenshot
      : {};
    for (const field of ['artifactId', 'mimeType', 'bytes', 'width', 'height', 'sha256']) {
      if (expected.screenshot[field] !== undefined && !Object.is(expected.screenshot[field], actualScreenshot[field])) {
        drift.push({
          field: `screenshot.${field}`,
          expected: expected.screenshot[field],
          actual: actualScreenshot[field]
        });
      }
    }
  }
  if (
    expected.visual &&
    Array.isArray(expected.visual.regionKinds) &&
    !arrayEqual(expected.visual.regionKinds, actual.visual && actual.visual.regionKinds)
  ) {
    drift.push({
      field: 'visual.regionKinds',
      expected: expected.visual.regionKinds,
      actual: actual.visual && Array.isArray(actual.visual.regionKinds)
        ? actual.visual.regionKinds
        : []
    });
  }
  return drift;
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
    const actualContext = extractReplayContext(response);
    steps.push({
      index,
      method: step.method,
      ok: true,
      ...(actualContext ? { context: actualContext } : {}),
      ...(step.context ? { contextDrift: contextDrift(step.context, actualContext || {}) } : {}),
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
