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

function validateFieldType(name, value, schema) {
  if (schema.type === 'number') {
    return typeof value === 'number' &&
      Number.isFinite(value) &&
      (schema.minimum === undefined || value >= schema.minimum);
  }
  return typeof value === schema.type;
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
    if (fieldSchema && !validateFieldType(field, value, fieldSchema)) {
      return validationError(`${toolName} field ${field} must be ${fieldSchema.type}.`, { field });
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
    redacted[key] = redactRawVisualData(nestedValue);
  }
  if (removedRawData) {
    redacted.rawDataRedacted = true;
  }
  return redacted;
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
    return {
      ...base,
      ok: false,
      error: redactRawVisualData(response && response.error ? response.error : {
        code: 'TOOL_EXECUTION_FAILED',
        message: `${toolName} failed without a structured response.`
      })
    };
  }
  return {
    ...base,
    ok: true,
    result: redactRawVisualData(response.result)
  };
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
        response = await this.sendRpc('operator.status', {});
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
        response = await this.sendRpc('page.observe', { origin: input.origin });
        break;
      case 'codex_chrome_visual_observe':
        response = await this.sendRpc('page.visualObserve', { origin: input.origin });
        break;
      case 'codex_chrome_visual_analyze':
        response = await this.sendRpc('page.visualAnalyze', {
          origin: normalizeOrigin(input.origin),
          ...(input.provider === undefined ? {} : { provider: input.provider }),
          ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
          ...(input.allowSensitive === undefined ? {} : { allowSensitive: input.allowSensitive })
        });
        break;
      case 'codex_chrome_fill':
        response = await this.sendRpc('page.fill', {
          origin: input.origin,
          handle: input.handle,
          text: input.text
        });
        break;
      case 'codex_chrome_type':
        response = await this.sendRpc('page.type', {
          origin: input.origin,
          handle: input.handle,
          text: input.text
        });
        break;
      case 'codex_chrome_clear':
        response = await this.sendRpc('page.clear', {
          origin: input.origin,
          handle: input.handle
        });
        break;
      case 'codex_chrome_focus':
        response = await this.sendRpc('page.focus', {
          origin: input.origin,
          handle: input.handle
        });
        break;
      case 'codex_chrome_select':
        response = await this.sendRpc('page.select', {
          origin: input.origin,
          handle: input.handle,
          value: input.value
        });
        break;
      case 'codex_chrome_check':
        response = await this.sendRpc('page.check', {
          origin: input.origin,
          handle: input.handle,
          checked: input.checked
        });
        break;
      case 'codex_chrome_scroll':
        response = await this.sendRpc('page.scroll', {
          origin: input.origin,
          handle: input.handle,
          deltaX: input.deltaX,
          deltaY: input.deltaY
        });
        break;
      case 'codex_chrome_press_key':
        response = await this.sendRpc('page.pressKey', {
          origin: input.origin,
          handle: input.handle,
          key: input.key
        });
        break;
      case 'codex_chrome_click':
        response = await this.sendRpc('page.click', {
          origin: input.origin,
          handle: input.handle
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
      pollIntervalMs: input.pollIntervalMs
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
