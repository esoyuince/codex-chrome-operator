'use strict';

const crypto = require('node:crypto');
const { sendRpc } = require('../native-bridge/daemonClient');
const {
  openObserve,
  prepareOrigin,
  profileDoctor,
  profileOnboard,
  resolveCliSettings
} = require('../scripts/operator-cli');
const {
  ADAPTER_PROTOCOL_VERSION,
  TOOL_DEFINITIONS,
  TOOL_SCHEMA_VERSION
} = require('./schema');

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function listTools() {
  return deepClone(TOOL_DEFINITIONS).map((tool) => ({
    ...tool,
    adapterProtocolVersion: ADAPTER_PROTOCOL_VERSION,
    toolSchemaVersion: TOOL_SCHEMA_VERSION
  }));
}

function toolDefinitionsHash(tools = listTools()) {
  return crypto
    .createHash('sha256')
    .update(stableStringify(tools))
    .digest('hex');
}

function toolDefinition(toolName) {
  return TOOL_DEFINITIONS.find((tool) => tool.name === toolName) || null;
}

function validationError(message, details = {}) {
  return {
    ok: false,
    error: {
      code: 'INVALID_TOOL_INPUT',
      message,
      ...details
    }
  };
}

function validateValue(name, value, schema) {
  if (schema.enum && !schema.enum.includes(value)) {
    return validationError(`${name} must be one of: ${schema.enum.join(', ')}.`, { field: name });
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      return validationError(`${name} must be array.`, { field: name });
    }
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        const nested = validateValue(`${name}[${index}]`, value[index], schema.items);
        if (!nested.ok) {
          return nested;
        }
      }
    }
    return { ok: true };
  }
  if (schema.type === 'number') {
    const valid = typeof value === 'number' &&
      Number.isFinite(value) &&
      (schema.minimum === undefined || value >= schema.minimum);
    return valid
      ? { ok: true }
      : validationError(`${name} must be number.`, { field: name });
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return validationError(`${name} must be object.`, { field: name });
    }
    const properties = schema.properties || {};
    const required = schema.required || [];
    for (const field of required) {
      if (value[field] === undefined) {
        return validationError(`${name} requires field: ${field}.`, { field: `${name}.${field}` });
      }
    }
    if (schema.additionalProperties === false) {
      for (const field of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, field)) {
          return validationError(`${name} does not accept field: ${field}.`, { field: `${name}.${field}` });
        }
      }
    }
    for (const [field, nestedValue] of Object.entries(value)) {
      const fieldSchema = properties[field];
      if (fieldSchema) {
        const nested = validateValue(`${name}.${field}`, nestedValue, fieldSchema);
        if (!nested.ok) {
          return nested;
        }
      }
    }
    return { ok: true };
  }
  return typeof value === schema.type
    ? { ok: true }
    : validationError(`${name} must be ${schema.type}.`, { field: name });
}

function validateToolInput(toolName, input = {}) {
  const definition = toolDefinition(toolName);
  if (!definition) {
    return {
      ok: false,
      error: {
        code: 'UNKNOWN_TOOL',
        message: `Unknown Codex Chrome tool: ${toolName}.`
      }
    };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return validationError(`${toolName} input must be an object.`);
  }

  const schema = definition.inputSchema;
  const properties = schema.properties || {};
  const required = schema.required || [];
  for (const field of required) {
    if (input[field] === undefined) {
      return validationError(`${toolName} requires field: ${field}.`, { field });
    }
  }

  if (schema.additionalProperties === false) {
    for (const field of Object.keys(input)) {
      if (!Object.prototype.hasOwnProperty.call(properties, field)) {
        return validationError(`${toolName} does not accept field: ${field}.`, { field });
      }
    }
  }

  for (const [field, value] of Object.entries(input)) {
    const fieldSchema = properties[field];
    if (fieldSchema) {
      const fieldValidation = validateValue(field, value, fieldSchema);
      if (!fieldValidation.ok) {
        return fieldValidation;
      }
    }
    if (field === 'url') {
      try {
        new URL(value);
      } catch {
        return validationError(`${toolName} field url must be an absolute URL.`, { field });
      }
    }
  }

  return {
    ok: true,
    input
  };
}

function redactRawVisualData(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redactRawVisualData(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const redacted = {};
  let removedRawData = false;
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === 'dataUrl') {
      removedRawData = true;
      continue;
    }
    if (key === 'path') {
      redacted[key] = '[REDACTED_PATH]';
      continue;
    }
    redacted[key] = redactRawVisualData(nestedValue);
  }
  if (removedRawData) {
    redacted.rawDataRedacted = true;
  }
  return redacted;
}

function jsonCharLength(value) {
  return JSON.stringify(value === undefined ? null : value).length;
}

function approxTokens(chars) {
  return Math.ceil(chars / 4);
}

function budgetNameForResponse(toolName, payload) {
  if (
    toolName === 'codex_chrome_status' &&
    payload &&
    payload.ok === true &&
    payload.result &&
    Object.prototype.hasOwnProperty.call(payload.result, 'pendingApprovalCount') &&
    !Object.prototype.hasOwnProperty.call(payload.result, 'recentEvents') &&
    !Object.prototype.hasOwnProperty.call(payload.result, 'approvedOrigins')
  ) {
    return 'codex_chrome_status.compact';
  }
  return toolName;
}

function attachTelemetry(toolName, payload) {
  const resultPayload = payload.ok ? payload.result : payload.error;
  const resultChars = jsonCharLength(resultPayload);
  const telemetry = {
    resultChars,
    responseChars: 0,
    approxResultTokens: approxTokens(resultChars),
    approxResponseTokens: 0,
    budgetName: budgetNameForResponse(toolName, payload)
  };
  const enriched = {
    ...payload,
    telemetry
  };
  let responseChars = jsonCharLength(enriched);
  for (let index = 0; index < 3; index += 1) {
    enriched.telemetry.responseChars = responseChars;
    enriched.telemetry.approxResponseTokens = approxTokens(responseChars);
    const nextResponseChars = jsonCharLength(enriched);
    if (nextResponseChars === responseChars) {
      break;
    }
    responseChars = nextResponseChars;
  }
  enriched.telemetry.responseChars = jsonCharLength(enriched);
  enriched.telemetry.approxResponseTokens = approxTokens(enriched.telemetry.responseChars);
  return enriched;
}

function wrapToolResponse(toolName, response) {
  const base = {
    toolName,
    protocolVersion: ADAPTER_PROTOCOL_VERSION,
    toolSchemaVersion: TOOL_SCHEMA_VERSION,
    toolDefinitionsHash: toolDefinitionsHash(),
    untrusted: true
  };
  if (!response || !response.ok) {
    return attachTelemetry(toolName, {
      ...base,
      ok: false,
      error: redactRawVisualData(response && response.error ? response.error : {
        code: 'TOOL_EXECUTION_FAILED',
        message: `${toolName} failed without a structured response.`
      })
    });
  }
  return attachTelemetry(toolName, {
    ...base,
    ok: true,
    result: redactRawVisualData(response.result)
  });
}

function invalidToolInput(toolName, message, details = {}) {
  return wrapToolResponse(toolName, {
    ok: false,
    error: {
      code: 'INVALID_TOOL_INPUT',
      message,
      ...details
    }
  });
}

function rpcRequest(method, params = {}) {
  return {
    id: `adapter_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    method,
    params
  };
}

function normalizeOrigin(value) {
  if (!value) {
    return value;
  }
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

function pickDefined(input, fields) {
  return Object.fromEntries(
    fields
      .filter((field) => input[field] !== undefined)
      .map((field) => [field, input[field]])
  );
}

function observeOptions(input) {
  return pickDefined(input, [
    'mode',
    'maxActionableHandles',
    'summaryMaxChars',
    'sincePageStateId',
    'includeFormValues',
    'maxFieldValueChars'
  ]);
}

function postActionSnapshotOptions(input) {
  return pickDefined(input, [
    'postActionSnapshot',
    'sincePageStateId',
    'mode',
    'maxActionableHandles',
    'summaryMaxChars'
  ]);
}

function visualObserveOptions(input) {
  return pickDefined(input, [
    'mode',
    'maxActionableHandles',
    'summaryMaxChars',
    'sincePageStateId',
    'maxBytes',
    'reason'
  ]);
}

class CodexChromeToolAdapter {
  constructor({
    settings,
    sendRpcFn = sendRpc,
    openObserveFn = openObserve,
    prepareOriginFn = prepareOrigin,
    profileDoctorFn = profileDoctor,
    profileOnboardFn = profileOnboard
  } = {}) {
    this.settings = settings || resolveCliSettings();
    this.sendRpcFn = sendRpcFn;
    this.openObserveFn = openObserveFn;
    this.prepareOriginFn = prepareOriginFn;
    this.profileDoctorFn = profileDoctorFn;
    this.profileOnboardFn = profileOnboardFn;
  }

  async executeTool({ toolName, input = {} }) {
    const validation = validateToolInput(toolName, input);
    if (!validation.ok) {
      return wrapToolResponse(toolName, validation);
    }

    let response;
    switch (toolName) {
      case 'codex_chrome_status':
        response = await this.sendRpc('operator.status', {
          detail: input.detail || 'compact'
        });
        break;
      case 'codex_chrome_prepare_origin':
        response = await this.prepareOrigin(input);
        break;
      case 'codex_chrome_readiness':
        response = await this.sendRpc('operator.verifyReadiness', {
          origin: normalizeOrigin(input.origin)
        });
        break;
      case 'codex_chrome_profile_doctor':
        response = await this.profileDoctor(input);
        break;
      case 'codex_chrome_profile_onboard':
        response = await this.profileOnboard(input);
        break;
      case 'codex_chrome_open_observe':
        response = await this.openObserve(input);
        break;
      case 'codex_chrome_observe':
        response = await this.sendRpc('page.observe', {
          origin: normalizeOrigin(input.origin),
          ...observeOptions(input)
        });
        break;
      case 'codex_chrome_read_page':
        response = await this.sendRpc('page.readPage', {
          origin: normalizeOrigin(input.origin),
          ...pickDefined(input, [
            'filter',
            'depth',
            'maxChars',
            'refId',
            'includeFormValues',
            'maxFieldValueChars'
          ])
        });
        break;
      case 'codex_chrome_extract':
        response = await this.sendRpc('page.extract', {
          origin: normalizeOrigin(input.origin),
          intent: input.intent,
          ...(input.maxCandidates === undefined ? {} : { maxCandidates: input.maxCandidates })
        });
        break;
      case 'codex_chrome_batch':
        response = await this.sendRpc('page.batch', {
          origin: normalizeOrigin(input.origin),
          actions: input.actions.map((action) => ({ ...action })),
          ...(input.stopOnError === undefined ? {} : { stopOnError: input.stopOnError })
        });
        break;
      case 'codex_chrome_visual_observe':
        response = await this.sendRpc('page.visualObserve', {
          origin: normalizeOrigin(input.origin),
          ...visualObserveOptions(input)
        });
        break;
      case 'codex_chrome_visual_analyze':
        response = await this.sendRpc('page.visualAnalyze', {
          origin: normalizeOrigin(input.origin),
          ...(input.provider === undefined ? {} : { provider: input.provider }),
          ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
          ...(input.allowSensitive === undefined ? {} : { allowSensitive: input.allowSensitive })
        });
        break;
      case 'codex_chrome_upload_file':
        response = await this.sendRpc('page.uploadFile', {
          origin: normalizeOrigin(input.origin),
          target: { handle: input.handle },
          files: input.files,
          ...(input.ruleset === undefined ? {} : { ruleset: input.ruleset }),
          ...(input.verifyPreview === undefined ? {} : { verifyPreview: input.verifyPreview })
        });
        break;
      case 'codex_chrome_cart_prepare':
        response = await this.sendRpc('page.prepareCart', {
          origin: normalizeOrigin(input.origin),
          ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
          query: input.query,
          criteria: input.criteria || {},
          cartActionAllowed: input.cartActionAllowed
        });
        break;
      case 'codex_chrome_fill':
        response = await this.sendRpc('page.fill', {
          origin: input.origin,
          handle: input.handle,
          text: input.text,
          ...postActionSnapshotOptions(input)
        });
        break;
      case 'codex_chrome_type':
        response = await this.sendRpc('page.type', {
          origin: input.origin,
          handle: input.handle,
          text: input.text,
          ...postActionSnapshotOptions(input)
        });
        break;
      case 'codex_chrome_clear':
        response = await this.sendRpc('page.clear', {
          origin: input.origin,
          handle: input.handle,
          ...postActionSnapshotOptions(input)
        });
        break;
      case 'codex_chrome_focus':
        response = await this.sendRpc('page.focus', {
          origin: input.origin,
          handle: input.handle,
          ...postActionSnapshotOptions(input)
        });
        break;
      case 'codex_chrome_select':
        response = await this.sendRpc('page.select', {
          origin: input.origin,
          handle: input.handle,
          value: input.value,
          ...postActionSnapshotOptions(input)
        });
        break;
      case 'codex_chrome_check':
        response = await this.sendRpc('page.check', {
          origin: input.origin,
          handle: input.handle,
          checked: input.checked,
          ...postActionSnapshotOptions(input)
        });
        break;
      case 'codex_chrome_scroll':
        response = await this.sendRpc('page.scroll', {
          origin: input.origin,
          handle: input.handle,
          deltaX: input.deltaX,
          deltaY: input.deltaY,
          ...postActionSnapshotOptions(input)
        });
        break;
      case 'codex_chrome_press_key':
        response = await this.sendRpc('page.pressKey', {
          origin: input.origin,
          handle: input.handle,
          key: input.key,
          ...postActionSnapshotOptions(input)
        });
        break;
      case 'codex_chrome_click':
        response = await this.sendRpc('page.click', {
          origin: input.origin,
          handle: input.handle,
          ...postActionSnapshotOptions(input)
        });
        break;
      case 'codex_chrome_approvals_list':
        response = await this.sendRpc('operator.approvals.list', {
          status: input.status
        });
        break;
      case 'codex_chrome_approval_approve':
        if (input.userDecision !== 'approve') {
          return invalidToolInput(
            toolName,
            'codex_chrome_approval_approve requires userDecision: approve.',
            { field: 'userDecision' }
          );
        }
        response = await this.sendRpc('operator.approvals.approve', {
          approvalId: input.approvalId
        });
        break;
      case 'codex_chrome_approval_reject':
        if (input.userDecision !== 'reject') {
          return invalidToolInput(
            toolName,
            'codex_chrome_approval_reject requires userDecision: reject.',
            { field: 'userDecision' }
          );
        }
        response = await this.sendRpc('operator.approvals.reject', {
          approvalId: input.approvalId
        });
        break;
      case 'codex_chrome_approval_run':
        response = await this.sendRpc('operator.approvals.run', {
          approvalId: input.approvalId
        });
        break;
      case 'codex_chrome_emergency_stop':
        response = await this.sendRpc('operator.emergencyStop', {
          reason: input.reason
        });
        break;
      case 'codex_chrome_emergency_clear':
        response = await this.sendRpc('operator.emergencyClear', {});
        break;
      default:
        response = {
          ok: false,
          error: {
            code: 'UNKNOWN_TOOL',
            message: `Unknown Codex Chrome tool: ${toolName}.`
          }
        };
    }
    return wrapToolResponse(toolName, response);
  }

  async sendRpc(method, params) {
    return this.sendRpcFn({
      baseUrl: this.settings.baseUrl,
      token: this.settings.token,
      request: rpcRequest(method, params)
    });
  }

  async openObserve(input) {
    const url = input.url;
    const request = rpcRequest('page.observe', {
      url,
      origin: new URL(url).origin,
      timeoutMs: input.timeoutMs,
      pollIntervalMs: input.pollIntervalMs,
      ...observeOptions(input)
    });
    return this.openObserveFn({
      settings: this.settings,
      request,
      sendRpcFn: this.sendRpcFn
    });
  }

  async prepareOrigin(input) {
    const request = rpcRequest('operator.ensureStarted', {
      origin: normalizeOrigin(input.origin)
    });
    return this.prepareOriginFn({
      settings: this.settings,
      request,
      sendRpcFn: this.sendRpcFn,
      openBootstrap: input.openBootstrap !== false
    });
  }

  async profileDoctor(input) {
    const params = input.origin ? { origin: normalizeOrigin(input.origin) } : {};
    const request = rpcRequest('operator.status', params);
    return this.profileDoctorFn({
      settings: this.settings,
      request,
      sendRpcFn: this.sendRpcFn
    });
  }

  async profileOnboard(input) {
    const params = {
      ...(input.userDataDir === undefined ? {} : { userDataDir: input.userDataDir }),
      ...(input.profileDirectory === undefined ? {} : { profileDirectory: input.profileDirectory }),
      ...(input.profileLabel === undefined ? {} : { profileLabel: input.profileLabel })
    };
    const request = rpcRequest('operator.profiles.discover', params);
    return this.profileOnboardFn({
      settings: this.settings,
      request,
      sendRpcFn: this.sendRpcFn,
      openBootstrap: input.openBootstrap !== false
    });
  }
}

module.exports = {
  ADAPTER_PROTOCOL_VERSION,
  CodexChromeToolAdapter,
  listTools,
  redactRawVisualData,
  toolDefinitionsHash,
  validateToolInput
};
