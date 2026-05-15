'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const {
  ERROR_CODES,
  validateHello,
  assertReadyForRealSiteAction,
  validateBoundedFullAutoContract
} = require('./protocol');
const { AuditLog } = require('./auditLog');
const {
  discoverChromeProfiles
} = require('./profileManager');
const {
  ScreenshotStore,
  defaultScreenshotDir
} = require('./screenshotStore');
const {
  analyzeVisualObservation,
  createVisualAnalyzerRegistry,
  isSensitiveVisualObservation,
  visualPolicyBlockIfNeeded
} = require('./visualAnalyzer');
const defaultAssetValidator = require('./assetValidator');
const { OperatorStateStore } = require('./stateStore');
const {
  assertCartProfileAllowed,
  loadSiteProfiles
} = require('./siteProfileRegistry');

function defaultAuditPath() {
  return path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'CodexChromeOperator',
    'audit',
    'audit.jsonl'
  );
}

function jsonCharLength(value) {
  return JSON.stringify(value === undefined ? null : value).length;
}

function approxTokens(chars) {
  return Math.ceil(chars / 4);
}

function telemetryBudgetName(method) {
  return typeof method === 'string' && method ? method : 'rpc';
}

function attachRpcTelemetry(method, response) {
  if (!response || typeof response !== 'object') {
    return response;
  }
  const resultPayload = response.ok ? response.result : response.error;
  const resultChars = jsonCharLength(resultPayload);
  const telemetry = {
    resultChars,
    responseChars: 0,
    approxResultTokens: approxTokens(resultChars),
    approxResponseTokens: 0,
    budgetName: telemetryBudgetName(method)
  };
  const enriched = {
    ...response,
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

function rpcOk(id, result) {
  return { id, ok: true, result };
}

function rpcError(id, error) {
  return { id, ok: false, error };
}

function clearsLastErrorOnSuccess(method) {
  return [
    'extension.hello',
    'operator.approveDomain',
    'operator.revokeDomain',
    'extension.hostPermissionGranted',
    'extension.blockedOriginsSynced',
    'operator.profile.bind',
    'operator.profile.verify',
    'operator.profiles.discover',
    'extension.hostPermissionsSynced',
    'extension.activeTabWarmup',
    'operator.screenshots.cleanup',
    'operator.emergencyStop',
    'operator.emergencyClear',
    'operator.fullAuto.start',
    'operator.fullAuto.stop',
    'operator.fullAuto.status',
    'operator.audit.tail',
    'operator.audit.timeline',
    'operator.ensureStarted',
    'operator.approvals.approve',
    'operator.approvals.reject',
    'operator.approvals.run',
    'operator.policy.status',
    'operator.policy.update'
  ].includes(method) ||
    method.startsWith('page.') ||
    method.startsWith('operator.tabs.') ||
    method.startsWith('operator.runtime.') ||
    method.startsWith('operator.context.') ||
    method.startsWith('operator.downloads.') ||
    method.startsWith('operator.sessions.') ||
    method.startsWith('operator.chatWatcher.') ||
    method.startsWith('operator.cdp.') ||
    method === 'operator.session.name';
}

const PAGE_ACTION_KINDS = Object.freeze({
  'page.observe': 'observe',
  'page.readPage': 'observe',
  'page.extract': 'observe',
  'page.mediaInspect': 'observe',
  'page.formExtract': 'observe',
  'page.formFillPlan': 'observe',
  'page.formFillExecute': 'fill',
  'page.visualObserve': 'screenshot',
  'page.visualAnalyze': 'screenshot',
  'page.visualInspectTarget': 'screenshot',
  'operator.runtime.tab.visualObserve': 'screenshot',
  'operator.runtime.tab.visualAnalyze': 'screenshot',
  'operator.runtime.tab.visualInspectTarget': 'screenshot',
  'operator.runtime.tab.uploadFile': 'upload',
  'page.uploadFile': 'upload',
  'page.prepareCart': 'cart-preparation',
  'page.batch': 'batch',
  'page.click': 'click',
  'page.type': 'type',
  'page.fill': 'fill',
  'page.clear': 'clear',
  'page.focus': 'focus',
  'page.select': 'select',
  'page.check': 'check',
  'page.scroll': 'scroll',
  'page.pressKey': 'pressKey',
  'page.navigate': 'navigate',
  'page.waitFor': 'wait'
});

const ACTIVE_TAB_MUTATION_METHODS = new Set([
  'page.formFillExecute',
  'page.uploadFile',
  'page.prepareCart',
  'page.click',
  'page.type',
  'page.fill',
  'page.clear',
  'page.focus',
  'page.select',
  'page.check',
  'page.scroll',
  'page.pressKey'
]);

const ACTIVE_TAB_READ_METHODS = new Set([
  'page.observe',
  'page.readPage',
  'page.extract',
  'page.mediaInspect',
  'page.formExtract',
  'page.formFillPlan',
  'page.visualObserve',
  'page.visualAnalyze',
  'page.visualInspectTarget',
  'page.waitFor'
]);

const ACTIVE_TAB_VISUAL_DIAGNOSTIC_METHODS = new Set([
  'page.visualObserve',
  'page.visualAnalyze',
  'page.visualInspectTarget'
]);

const BATCH_ACTION_KINDS = Object.freeze({
  observe: 'observe',
  readPage: 'observe',
  click: 'click',
  type: 'type',
  fill: 'fill',
  clear: 'clear',
  focus: 'focus',
  select: 'select',
  check: 'check',
  scroll: 'scroll',
  pressKey: 'pressKey',
  waitFor: 'wait'
});

const ACTIVE_TAB_MUTATING_BATCH_ACTION_KINDS = new Set([
  'click',
  'type',
  'fill',
  'clear',
  'focus',
  'select',
  'check',
  'scroll',
  'pressKey'
]);

const CDP_ALLOWED_METHODS = new Set([
  'DOM.scrollIntoViewIfNeeded',
  'Input.dispatchKeyEvent',
  'Input.dispatchMouseEvent',
  'Input.insertText',
  'Page.captureScreenshot',
  'Page.handleJavaScriptDialog',
  'Page.getLayoutMetrics',
  'Target.getTargets'
]);
const CDP_METADATA_METHODS = new Set([
  'Target.getTargets'
]);
const TOKEN_USAGE_METHOD_PREFIXES = Object.freeze([
  'page.',
  'operator.runtime.',
  'operator.cdp.',
  'operator.context.',
  'operator.downloads.',
  'operator.sessions.',
  'operator.tabs.'
]);
const RUNTIME_LOCATOR_ACTIONS = new Set([
  'resolve',
  'click',
  'type',
  'fill',
  'focus',
  'clear',
  'select',
  'check',
  'scroll',
  'pressKey'
]);
const RUNTIME_LOCATOR_MUTATION_METHODS = Object.freeze({
  click: 'page.click',
  type: 'page.type',
  fill: 'page.fill',
  focus: 'page.focus',
  clear: 'page.clear',
  select: 'page.select',
  check: 'page.check',
  scroll: 'page.scroll',
  pressKey: 'page.pressKey'
});
const GUARDED_ACTION_KINDS = new Set([
  'navigate',
  'click',
  'type',
  'fill',
  'clear',
  'focus',
  'select',
  'check',
  'upload',
  'cart-preparation',
  'batch',
  'pressKey'
]);
const PURCHASE_APPROVAL_KINDS = new Set([
  'checkout',
  'payment',
  'order-placement',
  'purchase',
  'subscription-start'
]);

const BATCH_ACTION_FIELDS = new Set([
  'action',
  'handle',
  'text',
  'value',
  'checked',
  'deltaX',
  'deltaY',
  'key',
  'condition',
  'timeoutMs',
  'pollIntervalMs',
  'filter',
  'depth',
  'maxChars',
  'refId',
  'mode',
  'maxActionableHandles',
  'summaryMaxChars',
  'sincePageStateId',
  'postActionSnapshot',
  'postActionVerifyDelayMs',
  'actionTrace',
  'actionTraceLabel',
  'actionTraceDurationMs',
  'targetContract',
  'verify'
]);

const BATCH_ACTION_FIELD_TYPES = Object.freeze({
  action: 'string',
  handle: 'string',
  text: 'string',
  value: 'string',
  checked: 'boolean',
  deltaX: 'number',
  deltaY: 'number',
  key: 'string',
  condition: 'string',
  timeoutMs: 'number',
  pollIntervalMs: 'number',
  filter: 'string',
  depth: 'number',
  maxChars: 'number',
  refId: 'string',
  mode: 'string',
  maxActionableHandles: 'number',
  summaryMaxChars: 'number',
  sincePageStateId: 'string',
  postActionSnapshot: 'string',
  postActionVerifyDelayMs: 'number',
  actionTrace: 'boolean',
  actionTraceLabel: 'string',
  actionTraceDurationMs: 'number',
  targetContract: 'object',
  verify: 'object'
});

const BATCH_ACTION_REQUIRED_FIELDS = Object.freeze({
  observe: [],
  readPage: [],
  click: ['handle'],
  type: ['handle', 'text'],
  fill: ['handle', 'text'],
  clear: ['handle'],
  focus: ['handle'],
  select: ['handle', 'value'],
  check: ['handle', 'checked'],
  scroll: ['handle', 'deltaX', 'deltaY'],
  pressKey: ['handle', 'key'],
  waitFor: ['condition']
});

const MIN_PROFILE_CONFIDENCE_FOR_SITE_RISK_ACTION = 0.85;
const PROFILE_CONFIDENCE_REQUIRED_APPROVAL_KINDS = new Set([
  'publish',
  'send-for-review',
  'release',
  'rollout',
  'checkout',
  'payment',
  'order-placement',
  'subscription-start',
  'delete',
  'account-security',
  'permission-grant',
  'legal-tax-identity'
]);

const MAX_BATCH_ACTIONS = 20;
const WARM_SESSION_CACHE_TTL_MS = 10000;
const APPROVAL_TTL_MS = 5 * 60 * 1000;
const RECENT_ACTION_LOG_LIMIT = 25;
const CHAT_WATCHER_EVENT_LIMIT = 50;
const WARM_CACHE_PRESERVING_ACTION_KINDS = new Set(['observe', 'screenshot', 'wait']);
const APPROVAL_INVALIDATABLE_STATUSES = new Set(['pending', 'approved']);
const VERIFY_CONDITION_TYPES = new Set([
  'textAppears',
  'textAppearsInArticle',
  'elementGone',
  'elementEnabled',
  'valueEquals'
]);

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function canonicalJson(value) {
  if (value === undefined) {
    return 'null';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  const entries = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(',')}}`;
}

function stableHash(value) {
  return crypto
    .createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex');
}

function makeOperatorSessionId() {
  return `session_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function pageStateIdFromHandle(handle) {
  if (typeof handle !== 'string' || !handle.startsWith('el_')) {
    return null;
  }
  const lastUnderscore = handle.lastIndexOf('_');
  if (lastUnderscore <= 3) {
    return null;
  }
  const index = handle.slice(lastUnderscore + 1);
  if (!/^\d+$/.test(index)) {
    return null;
  }
  return handle.slice(3, lastUnderscore) || null;
}

function approvalTargetContractFromParams(params = {}, error = {}) {
  if (isPlainObject(params.targetContract)) {
    return params.targetContract;
  }
  if (
    Number.isInteger(error.childActionIndex) &&
    Array.isArray(params.actions) &&
    isPlainObject(params.actions[error.childActionIndex]) &&
    isPlainObject(params.actions[error.childActionIndex].targetContract)
  ) {
    return params.actions[error.childActionIndex].targetContract;
  }
  if (Array.isArray(params.actions)) {
    const actionWithContract = params.actions.find((action) => isPlainObject(action && action.targetContract));
    if (actionWithContract) {
      return actionWithContract.targetContract;
    }
  }
  if (Array.isArray(params.steps)) {
    const stepWithContract = params.steps.find((step) => isPlainObject(step && step.targetContract));
    if (stepWithContract) {
      return stepWithContract.targetContract;
    }
  }
  return null;
}

function approvalTargetHandleFromParams(params = {}, error = {}, targetContract = null) {
  if (targetContract && typeof targetContract.handle === 'string' && targetContract.handle) {
    return targetContract.handle;
  }
  if (
    Number.isInteger(error.childActionIndex) &&
    Array.isArray(params.actions) &&
    typeof params.actions[error.childActionIndex].handle === 'string'
  ) {
    return params.actions[error.childActionIndex].handle;
  }
  if (typeof params.handle === 'string' && params.handle) {
    return params.handle;
  }
  if (Array.isArray(params.actions)) {
    const actionWithHandle = params.actions.find((action) => typeof (action && action.handle) === 'string' && action.handle);
    if (actionWithHandle) {
      return actionWithHandle.handle;
    }
  }
  return null;
}

function approvalContextError(record, reason, extra = {}) {
  return {
    code: ERROR_CODES.APPROVAL_CONTEXT_MISMATCH,
    message: 'Approval replay context no longer matches the approved action.',
    approvalId: record && record.approvalId,
    reason,
    ...extra
  };
}

function flattenObservedTargets(result) {
  const targets = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') {
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry);
      }
      return;
    }
    if (
      typeof value.handle === 'string' ||
      isPlainObject(value.targetContract) ||
      isPlainObject(value.contract)
    ) {
      targets.push(value);
    }
    for (const key of ['elements', 'items', 'actionable', 'controls', 'targets']) {
      if (Array.isArray(value[key])) {
        visit(value[key]);
      }
    }
  };
  visit(result);
  return targets;
}

function observedTargetMatchesApproval(result, record) {
  if (!record.targetContractHash && !record.targetHandle) {
    return true;
  }
  const targets = flattenObservedTargets(result);
  return targets.some((target) => {
    const contract = isPlainObject(target.targetContract)
      ? target.targetContract
      : (isPlainObject(target.contract) ? target.contract : null);
    if (record.targetContractHash && contract && stableHash(contract) === record.targetContractHash) {
      return true;
    }
    if (!record.targetHandle) {
      return false;
    }
    const candidateHandles = [
      typeof target.handle === 'string' ? target.handle : null,
      contract && typeof contract.handle === 'string' ? contract.handle : null
    ].filter(Boolean);
    if (!candidateHandles.includes(record.targetHandle)) {
      return false;
    }
    if (!record.pageStateId) {
      return true;
    }
    return candidateHandles.some((handle) => pageStateIdFromHandle(handle) === record.pageStateId);
  });
}

function guardOk(extra = {}) {
  return { ok: true, ...extra };
}

function guardError(code, message, extra = {}) {
  return {
    ok: false,
    error: {
      code,
      message,
      ...extra
    }
  };
}

function safeUploadErrorDetails(error) {
  if (!error || typeof error !== 'object') {
    return {};
  }

  const blockedKeys = new Set(['path', 'filePath', 'absolutePath']);
  return Object.entries(error).reduce((safe, [key, value]) => {
    if (key !== 'code' && key !== 'message' && !blockedKeys.has(key)) {
      safe[key] = value;
    }
    return safe;
  }, {});
}

function isLocalMockOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateVerifyConditions(verify, extra = {}) {
  if (verify === undefined) {
    return guardOk();
  }
  if (!isPlainObject(verify)) {
    return guardError(ERROR_CODES.INVALID_SCHEMA, 'verify must be an object.', extra);
  }
  if (!Array.isArray(verify.oneOf) || verify.oneOf.length === 0) {
    return guardError(ERROR_CODES.INVALID_SCHEMA, 'verify.oneOf must be a non-empty array.', extra);
  }
  for (let conditionIndex = 0; conditionIndex < verify.oneOf.length; conditionIndex += 1) {
    const condition = verify.oneOf[conditionIndex];
    const details = { ...extra, conditionIndex };
    if (!isPlainObject(condition)) {
      return guardError(ERROR_CODES.INVALID_SCHEMA, 'verify.oneOf entries must be objects.', details);
    }
    const type = condition.type;
    if (!VERIFY_CONDITION_TYPES.has(type)) {
      return guardError(ERROR_CODES.INVALID_SCHEMA, 'Unsupported verify condition type.', {
        ...details,
        type: typeof type === 'string' ? type : null
      });
    }
    for (const field of Object.keys(condition)) {
      if (!['type', 'text', 'handle', 'value'].includes(field)) {
        return guardError(ERROR_CODES.INVALID_SCHEMA, `Verify condition does not accept field: ${field}.`, {
          ...details,
          field
        });
      }
      if (field !== 'type' && typeof condition[field] !== 'string') {
        return guardError(ERROR_CODES.INVALID_SCHEMA, `Verify condition field ${field} must be a string.`, {
          ...details,
          field
        });
      }
    }
  }
  return guardOk();
}

function targetContractError(message, extra = {}) {
  return guardError(ERROR_CODES.INVALID_SCHEMA, message, extra);
}

function targetContractField(prefix, field) {
  return prefix ? `${prefix}.${field}` : field;
}

function validateTargetContractString(contract, field, maxLength, extra, prefix) {
  if (contract[field] === undefined) {
    return guardOk();
  }
  if (typeof contract[field] !== 'string') {
    return targetContractError(`targetContract.${field} must be a string.`, {
      ...extra,
      field: targetContractField(prefix, field)
    });
  }
  if (contract[field].length > maxLength) {
    return targetContractError(`targetContract.${field} is too long.`, {
      ...extra,
      field: targetContractField(prefix, field),
      maxLength
    });
  }
  return guardOk();
}

function validateTargetContractBox(box, extra, prefix) {
  if (box === undefined) {
    return guardOk();
  }
  const boxPrefix = targetContractField(prefix, 'bbox');
  if (!isPlainObject(box)) {
    return targetContractError('targetContract.bbox must be an object.', {
      ...extra,
      field: boxPrefix
    });
  }
  for (const field of Object.keys(box)) {
    if (!['x', 'y', 'width', 'height'].includes(field)) {
      return targetContractError(`targetContract.bbox does not accept field: ${field}.`, {
        ...extra,
        field: `${boxPrefix}.${field}`
      });
    }
  }
  for (const field of ['x', 'y', 'width', 'height']) {
    if (box[field] !== undefined && !Number.isFinite(box[field])) {
      return targetContractError(`targetContract.bbox.${field} must be a finite number.`, {
        ...extra,
        field: `${boxPrefix}.${field}`
      });
    }
  }
  if (box.width !== undefined && box.width <= 0) {
    return targetContractError('targetContract.bbox.width must be positive.', {
      ...extra,
      field: `${boxPrefix}.width`
    });
  }
  if (box.height !== undefined && box.height <= 0) {
    return targetContractError('targetContract.bbox.height must be positive.', {
      ...extra,
      field: `${boxPrefix}.height`
    });
  }
  return guardOk();
}

function validateTargetContractContext(context, extra, prefix) {
  if (context === undefined) {
    return guardOk();
  }
  const contextPrefix = targetContractField(prefix, 'context');
  if (!isPlainObject(context)) {
    return targetContractError('targetContract.context must be an object.', {
      ...extra,
      field: contextPrefix
    });
  }
  for (const field of Object.keys(context)) {
    if (!['url', 'viewport', 'scroll', 'devicePixelRatio'].includes(field)) {
      return targetContractError(`targetContract.context does not accept field: ${field}.`, {
        ...extra,
        field: `${contextPrefix}.${field}`
      });
    }
  }
  if (context.url !== undefined && typeof context.url !== 'string') {
    return targetContractError('targetContract.context.url must be a string.', {
      ...extra,
      field: `${contextPrefix}.url`
    });
  }
  if (context.devicePixelRatio !== undefined && !Number.isFinite(context.devicePixelRatio)) {
    return targetContractError('targetContract.context.devicePixelRatio must be a finite number.', {
      ...extra,
      field: `${contextPrefix}.devicePixelRatio`
    });
  }
  for (const [field, allowedFields] of [
    ['viewport', ['width', 'height']],
    ['scroll', ['x', 'y']]
  ]) {
    const value = context[field];
    if (value === undefined) {
      continue;
    }
    const fieldPrefix = `${contextPrefix}.${field}`;
    if (!isPlainObject(value)) {
      return targetContractError(`targetContract.context.${field} must be an object.`, {
        ...extra,
        field: fieldPrefix
      });
    }
    for (const nestedField of Object.keys(value)) {
      if (!allowedFields.includes(nestedField)) {
        return targetContractError(`targetContract.context.${field} does not accept field: ${nestedField}.`, {
          ...extra,
          field: `${fieldPrefix}.${nestedField}`
        });
      }
      if (!Number.isFinite(value[nestedField])) {
        return targetContractError(`targetContract.context.${field}.${nestedField} must be a finite number.`, {
          ...extra,
          field: `${fieldPrefix}.${nestedField}`
        });
      }
    }
  }
  return guardOk();
}

function validateTargetContractData(data, extra, prefix) {
  if (data === undefined) {
    return guardOk();
  }
  const dataPrefix = targetContractField(prefix, 'data');
  if (!isPlainObject(data)) {
    return targetContractError('targetContract.data must be an object.', {
      ...extra,
      field: dataPrefix
    });
  }
  const keys = Object.keys(data);
  if (keys.length > 20) {
    return targetContractError('targetContract.data has too many fields.', {
      ...extra,
      field: dataPrefix,
      maxFields: 20
    });
  }
  for (const key of keys) {
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(key)) {
      return targetContractError('targetContract.data field names must be short data keys.', {
        ...extra,
        field: `${dataPrefix}.${key}`
      });
    }
    if (typeof data[key] !== 'string') {
      return targetContractError('targetContract.data values must be strings.', {
        ...extra,
        field: `${dataPrefix}.${key}`
      });
    }
    if (data[key].length > 200) {
      return targetContractError('targetContract.data value is too long.', {
        ...extra,
        field: `${dataPrefix}.${key}`,
        maxLength: 200
      });
    }
  }
  return guardOk();
}

function validateTargetContractProvenance(provenance, extra, prefix) {
  if (provenance === undefined) {
    return guardOk();
  }
  const provenancePrefix = targetContractField(prefix, 'provenance');
  if (!isPlainObject(provenance)) {
    return targetContractError('targetContract.provenance must be an object.', {
      ...extra,
      field: provenancePrefix
    });
  }
  for (const field of Object.keys(provenance)) {
    if (!['shadowDepth', 'frameDepth', 'frameTitle', 'frameName', 'frameSrc'].includes(field)) {
      return targetContractError(`targetContract.provenance does not accept field: ${field}.`, {
        ...extra,
        field: `${provenancePrefix}.${field}`
      });
    }
  }
  for (const field of ['shadowDepth', 'frameDepth']) {
    if (provenance[field] !== undefined && (!Number.isFinite(provenance[field]) || provenance[field] < 0)) {
      return targetContractError(`targetContract.provenance.${field} must be a finite non-negative number.`, {
        ...extra,
        field: `${provenancePrefix}.${field}`
      });
    }
  }
  for (const field of ['frameTitle', 'frameName', 'frameSrc']) {
    const validation = validateTargetContractString(provenance, field, field === 'frameSrc' ? 2000 : 300, extra, provenancePrefix);
    if (!validation.ok) {
      return validation;
    }
  }
  return guardOk();
}

function validateTargetContract(contract, extra = {}) {
  const prefix = extra.field || 'targetContract';
  if (contract === undefined) {
    return guardOk();
  }
  if (!isPlainObject(contract)) {
    return targetContractError('targetContract must be an object.', {
      ...extra,
      field: prefix
    });
  }
  const allowed = new Set([
    'version',
    'handle',
    'tag',
    'role',
    'type',
    'id',
    'name',
    'href',
    'placeholder',
    'title',
    'label',
    'accessibleName',
    'testid',
    'data',
    'productId',
    'bbox',
    'context',
    'provenance'
  ]);
  for (const field of Object.keys(contract)) {
    if (!allowed.has(field)) {
      return targetContractError(`targetContract does not accept field: ${field}.`, {
        ...extra,
        field: targetContractField(prefix, field)
      });
    }
  }
  if (contract.version !== undefined && contract.version !== 1) {
    return targetContractError('targetContract.version must be 1.', {
      ...extra,
      field: targetContractField(prefix, 'version')
    });
  }
  for (const [field, maxLength] of [
    ['handle', 160],
    ['tag', 40],
    ['role', 80],
    ['type', 80],
    ['id', 200],
    ['name', 200],
    ['href', 2000],
    ['placeholder', 300],
    ['title', 300],
    ['label', 300],
    ['accessibleName', 300],
    ['testid', 200],
    ['productId', 200]
  ]) {
    const validation = validateTargetContractString(contract, field, maxLength, extra, prefix);
    if (!validation.ok) {
      return validation;
    }
  }
  const dataValidation = validateTargetContractData(contract.data, extra, prefix);
  if (!dataValidation.ok) {
    return dataValidation;
  }
  const boxValidation = validateTargetContractBox(contract.bbox, extra, prefix);
  if (!boxValidation.ok) {
    return boxValidation;
  }
  const contextValidation = validateTargetContractContext(contract.context, extra, prefix);
  if (!contextValidation.ok) {
    return contextValidation;
  }
  const provenanceValidation = validateTargetContractProvenance(contract.provenance, extra, prefix);
  if (!provenanceValidation.ok) {
    return provenanceValidation;
  }
  return guardOk();
}

function makeConnectionId() {
  return `conn_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function makeBootstrapSessionId() {
  return `boot_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function originFromParams(params = {}) {
  if (params.origin) {
    return params.origin;
  }
  if (params.url) {
    try {
      return new URL(params.url).origin;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function originFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.origin;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function normalizeHttpOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function normalizeOriginAllowlist(origins = []) {
  if (!Array.isArray(origins)) {
    return new Set();
  }
  return new Set(origins.map((origin) => normalizeHttpOrigin(origin)).filter(Boolean));
}

function invalidOriginResponse(id) {
  return rpcError(id, {
    code: ERROR_CODES.INVALID_SCHEMA,
    message: 'origin must be an http(s) URL or origin.'
  });
}

function safeCdpAuditParams(params = {}) {
  const cdpParams = isPlainObject(params.params) ? params.params : {};
  return {
    tabId: Number.isInteger(params.tabId) ? params.tabId : null,
    method: typeof params.method === 'string' ? params.method : null,
    paramKeys: Object.keys(cdpParams).sort()
  };
}

function focusDisturbanceSummary(response = {}) {
  const focusDisturbance = response &&
    response.ok === true &&
    response.result &&
    isPlainObject(response.result.focusDisturbance)
    ? response.result.focusDisturbance
    : null;
  if (!focusDisturbance) {
    return null;
  }
  return {
    changed: focusDisturbance.changed === true,
    reason: typeof focusDisturbance.reason === 'string' ? focusDisturbance.reason : null,
    targetTabId: Number.isInteger(focusDisturbance.targetTabId)
      ? focusDisturbance.targetTabId
      : null,
    previousActiveTabId: Number.isInteger(focusDisturbance.previousActiveTabId)
      ? focusDisturbance.previousActiveTabId
      : null,
    restored: focusDisturbance.restored === true,
    ...(typeof focusDisturbance.restoreError === 'string'
      ? { restoreError: focusDisturbance.restoreError }
      : {})
  };
}

function cdpParamError(message, extra = {}) {
  return guardError(ERROR_CODES.INVALID_SCHEMA, message, extra);
}

function requireFiniteCdpNumber(params, key) {
  if (!Number.isFinite(params[key])) {
    return cdpParamError(`CDP ${key} must be a finite number.`, { field: `params.${key}` });
  }
  return null;
}

function requireStringLength(params, key, maxLength) {
  if (params[key] === undefined) {
    return null;
  }
  if (typeof params[key] !== 'string') {
    return cdpParamError(`CDP ${key} must be a string.`, { field: `params.${key}` });
  }
  if (params[key].length > maxLength) {
    return cdpParamError(`CDP ${key} is too long.`, {
      field: `params.${key}`,
      maxLength
    });
  }
  return null;
}

function rejectUnknownCdpParams(params, allowedKeys) {
  for (const key of Object.keys(params)) {
    if (!allowedKeys.has(key)) {
      return cdpParamError(`CDP params do not accept field: ${key}.`, {
        field: `params.${key}`
      });
    }
  }
  return null;
}

function validateCdpScreenshotClip(clip) {
  if (clip === undefined) {
    return null;
  }
  if (!isPlainObject(clip)) {
    return cdpParamError('CDP screenshot clip must be an object.', { field: 'params.clip' });
  }
  const unknown = rejectUnknownCdpParams(clip, new Set(['x', 'y', 'width', 'height', 'scale']));
  if (unknown) {
    return unknown;
  }
  for (const key of ['x', 'y', 'width', 'height', 'scale']) {
    if (!Number.isFinite(clip[key])) {
      return cdpParamError(`CDP screenshot clip.${key} must be a finite number.`, {
        field: `params.clip.${key}`
      });
    }
  }
  if (clip.x < 0 || clip.y < 0) {
    return cdpParamError('CDP screenshot clip origin must be non-negative.', {
      field: 'params.clip'
    });
  }
  if (clip.width <= 0 || clip.height <= 0) {
    return cdpParamError('CDP screenshot clip dimensions must be positive.', {
      field: 'params.clip'
    });
  }
  if (clip.width > 10000 || clip.height > 10000) {
    return cdpParamError('CDP screenshot clip dimensions are too large.', {
      field: 'params.clip',
      maxDimension: 10000
    });
  }
  if (clip.scale <= 0 || clip.scale > 10) {
    return cdpParamError('CDP screenshot clip scale must be within 0-10.', {
      field: 'params.clip.scale'
    });
  }
  return null;
}

function validateCdpParamsForMethod(method, params) {
  if (!isPlainObject(params)) {
    return cdpParamError('CDP params must be an object.');
  }

  if (method === 'Input.insertText') {
    const unknown = rejectUnknownCdpParams(params, new Set(['text']));
    if (unknown) {
      return unknown;
    }
    if (typeof params.text !== 'string' || params.text.length === 0) {
      return cdpParamError('CDP Input.insertText requires non-empty text.', { field: 'params.text' });
    }
    if (params.text.length > 2000) {
      return cdpParamError('CDP Input.insertText text is too long.', {
        field: 'params.text',
        maxLength: 2000
      });
    }
    return guardOk({ params });
  }

  if (method === 'Input.dispatchMouseEvent') {
    const allowed = new Set(['type', 'x', 'y', 'button', 'buttons', 'clickCount', 'modifiers', 'deltaX', 'deltaY']);
    const unknown = rejectUnknownCdpParams(params, allowed);
    if (unknown) {
      return unknown;
    }
    if (!['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel'].includes(params.type)) {
      return cdpParamError('CDP mouse event type is not allowed.', { field: 'params.type' });
    }
    const xError = requireFiniteCdpNumber(params, 'x');
    if (xError) {
      return xError;
    }
    const yError = requireFiniteCdpNumber(params, 'y');
    if (yError) {
      return yError;
    }
    if (params.button !== undefined && !['none', 'left', 'middle', 'right', 'back', 'forward'].includes(params.button)) {
      return cdpParamError('CDP mouse button is not allowed.', { field: 'params.button' });
    }
    for (const key of ['buttons', 'clickCount', 'modifiers', 'deltaX', 'deltaY']) {
      if (params[key] !== undefined && !Number.isFinite(params[key])) {
        return cdpParamError(`CDP ${key} must be a finite number.`, { field: `params.${key}` });
      }
    }
    return guardOk({ params });
  }

  if (method === 'Input.dispatchKeyEvent') {
    const allowed = new Set([
      'type',
      'modifiers',
      'timestamp',
      'text',
      'unmodifiedText',
      'keyIdentifier',
      'code',
      'key',
      'windowsVirtualKeyCode',
      'nativeVirtualKeyCode',
      'autoRepeat',
      'isKeypad',
      'isSystemKey',
      'location',
      'commands'
    ]);
    const unknown = rejectUnknownCdpParams(params, allowed);
    if (unknown) {
      return unknown;
    }
    if (!['keyDown', 'keyUp', 'rawKeyDown', 'char'].includes(params.type)) {
      return cdpParamError('CDP key event type is not allowed.', { field: 'params.type' });
    }
    for (const key of ['text', 'unmodifiedText', 'keyIdentifier', 'code', 'key']) {
      const stringError = requireStringLength(params, key, 120);
      if (stringError) {
        return stringError;
      }
    }
    for (const key of ['modifiers', 'timestamp', 'windowsVirtualKeyCode', 'nativeVirtualKeyCode', 'location']) {
      if (params[key] !== undefined && !Number.isFinite(params[key])) {
        return cdpParamError(`CDP ${key} must be a finite number.`, { field: `params.${key}` });
      }
    }
    for (const key of ['autoRepeat', 'isKeypad', 'isSystemKey']) {
      if (params[key] !== undefined && typeof params[key] !== 'boolean') {
        return cdpParamError(`CDP ${key} must be boolean.`, { field: `params.${key}` });
      }
    }
    if (params.commands !== undefined) {
      if (!Array.isArray(params.commands) || params.commands.some((command) => typeof command !== 'string' || command.length > 80)) {
        return cdpParamError('CDP commands must be an array of short strings.', { field: 'params.commands' });
      }
    }
    return guardOk({ params });
  }

  if (method === 'DOM.scrollIntoViewIfNeeded') {
    const allowed = new Set(['nodeId', 'backendNodeId', 'objectId', 'rect']);
    const unknown = rejectUnknownCdpParams(params, allowed);
    if (unknown) {
      return unknown;
    }
    const hasNodeRef = Number.isInteger(params.nodeId) ||
      Number.isInteger(params.backendNodeId) ||
      (typeof params.objectId === 'string' && params.objectId.length > 0);
    if (!hasNodeRef) {
      return cdpParamError('CDP DOM.scrollIntoViewIfNeeded requires nodeId, backendNodeId, or objectId.', {
        field: 'params'
      });
    }
    if (params.rect !== undefined) {
      if (!isPlainObject(params.rect)) {
        return cdpParamError('CDP rect must be an object.', { field: 'params.rect' });
      }
      const rectUnknown = rejectUnknownCdpParams(params.rect, new Set(['x', 'y', 'width', 'height']));
      if (rectUnknown) {
        return rectUnknown;
      }
      for (const key of ['x', 'y', 'width', 'height']) {
        if (params.rect[key] !== undefined && !Number.isFinite(params.rect[key])) {
          return cdpParamError(`CDP rect.${key} must be a finite number.`, {
            field: `params.rect.${key}`
          });
        }
      }
    }
    return guardOk({ params });
  }

  if (method === 'Page.captureScreenshot') {
    const unknown = rejectUnknownCdpParams(params, new Set(['format', 'quality', 'clip', 'fromSurface']));
    if (unknown) {
      return unknown;
    }
    if (params.format !== undefined && !['png', 'jpeg', 'webp'].includes(params.format)) {
      return cdpParamError('CDP screenshot format is not allowed.', { field: 'params.format' });
    }
    if (
      params.quality !== undefined &&
      (!Number.isInteger(params.quality) || params.quality < 0 || params.quality > 100)
    ) {
      return cdpParamError('CDP screenshot quality must be an integer from 0 to 100.', {
        field: 'params.quality'
      });
    }
    if (params.fromSurface !== undefined && typeof params.fromSurface !== 'boolean') {
      return cdpParamError('CDP screenshot fromSurface must be boolean.', {
        field: 'params.fromSurface'
      });
    }
    const clipError = validateCdpScreenshotClip(params.clip);
    if (clipError) {
      return clipError;
    }
    return guardOk({ params });
  }

  if (method === 'Page.handleJavaScriptDialog') {
    const unknown = rejectUnknownCdpParams(params, new Set(['accept', 'promptText']));
    if (unknown) {
      return unknown;
    }
    if (typeof params.accept !== 'boolean') {
      return cdpParamError('CDP Page.handleJavaScriptDialog requires boolean accept.', {
        field: 'params.accept'
      });
    }
    const promptTextError = requireStringLength(params, 'promptText', 500);
    if (promptTextError) {
      return promptTextError;
    }
    return guardOk({ params });
  }

  if (method === 'Page.getLayoutMetrics') {
    const unknown = rejectUnknownCdpParams(params, new Set());
    if (unknown) {
      return unknown;
    }
    return guardOk({ params: {} });
  }

  if (method === 'Target.getTargets') {
    const unknown = rejectUnknownCdpParams(params, new Set());
    if (unknown) {
      return unknown;
    }
    return guardOk({ params: {} });
  }

  return cdpParamError('CDP method has no strict parameter validator.', {
    method
  });
}

function summarizeReadiness({
  origin,
  profileVerified,
  profileConfidence,
  domainApproved,
  hostPermissionGranted,
  siteBlocked = false,
  blockedPattern = null
}) {
  const missing = [];
  if (!domainApproved) {
    missing.push('domainApproval');
  }
  if (siteBlocked) {
    missing.push('siteAllowed');
  }
  return {
    origin,
    ready: missing.length === 0,
    profileVerified,
    profileConfidence,
    domainApproved,
    hostPermissionGranted,
    siteBlocked: Boolean(siteBlocked),
    blockedPattern,
    missing
  };
}

function navigationTarget(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return guardError(ERROR_CODES.INVALID_SCHEMA, 'Navigation URL must be an absolute URL.');
  }

  if (parsed.protocol === 'https:') {
    return guardOk({ url: parsed.href, origin: parsed.origin });
  }

  if (
    parsed.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  ) {
    return guardOk({ url: parsed.href, origin: parsed.origin });
  }

  return guardError(
    ERROR_CODES.UNSUPPORTED_SCHEME,
    'Navigation is limited to https and local development http origins.',
    { scheme: parsed.protocol.replace(/:$/, '') }
  );
}

function isBoundedFullAutoError(error) {
  return Boolean(error && typeof error.code === 'string' && error.code.startsWith('BOUNDED_FULL_AUTO_'));
}

function shouldInvalidateWarmSession(method, childActions = []) {
  if (method === 'page.batch') {
    return childActions.some((childAction) => (
      childAction && !WARM_CACHE_PRESERVING_ACTION_KINDS.has(childAction.actionKind)
    ));
  }

  const actionKind = PAGE_ACTION_KINDS[method];
  return Boolean(actionKind && !WARM_CACHE_PRESERVING_ACTION_KINDS.has(actionKind));
}

function normalizeActiveTab(tab) {
  if (!tab || typeof tab !== 'object') {
    return null;
  }

  let origin = null;
  if (typeof tab.url === 'string' && tab.url) {
    try {
      origin = new URL(tab.url).origin;
    } catch {
      origin = null;
    }
  }

  return {
    id: tab.id ?? null,
    windowId: tab.windowId ?? null,
    url: typeof tab.url === 'string' ? tab.url : null,
    pendingUrl: typeof tab.pendingUrl === 'string' ? tab.pendingUrl : null,
    origin,
    title: typeof tab.title === 'string' ? tab.title : null,
    status: typeof tab.status === 'string' ? tab.status : null,
    loadingState: tab.status === 'loading' ? 'loading' : 'complete',
    updatedAt: new Date().toISOString()
  };
}

function tabOrigin(tab) {
  return (tab && tab.origin) || originFromUrl(tab && tab.url);
}

function pendingNavigationErrorForTab(tab) {
  if (!tab || !tab.pendingUrl || tab.url === tab.pendingUrl) {
    return null;
  }
  return {
    code: ERROR_CODES.NAVIGATION_NOT_SETTLED,
    message: 'Session tab navigation is still pending; wait for the tab URL to settle before issuing runtime commands.',
    tabId: tab.id,
    currentUrl: tab.url || null,
    pendingUrl: tab.pendingUrl,
    currentOrigin: originFromUrl(tab.url),
    pendingOrigin: originFromUrl(tab.pendingUrl),
    loadingState: tab.loadingState || null
  };
}

function tabIdentitySummary(tab, source) {
  return {
    id: tab.id,
    source,
    title: tab.title || null,
    url: tab.url || null,
    active: tab.active === true
  };
}

function guardedActiveTabBatch(batch) {
  return Boolean(
    batch &&
    Array.isArray(batch.childActions) &&
    batch.childActions.some((action) => (
      action &&
      (
        ACTIVE_TAB_MUTATING_BATCH_ACTION_KINDS.has(action.actionKind) ||
        action.actionKind === 'observe'
      )
    ))
  );
}

function requiresActiveTabTargetGuard(method, batch) {
  if (method === 'page.batch') {
    return guardedActiveTabBatch(batch);
  }
  return ACTIVE_TAB_MUTATION_METHODS.has(method) || ACTIVE_TAB_READ_METHODS.has(method);
}

function validateActiveTabDiagnosticParams(method, params = {}) {
  if (!ACTIVE_TAB_VISUAL_DIAGNOSTIC_METHODS.has(method)) {
    return guardOk();
  }
  if (params.diagnosticActiveTab !== true || !Number.isInteger(params.expectedActiveTabId) || params.expectedActiveTabId < 0) {
    return guardError(
      ERROR_CODES.INVALID_SCHEMA,
      'Active-tab visual diagnostics require diagnosticActiveTab=true and expectedActiveTabId.',
      {
        reason: 'ACTIVE_TAB_DIAGNOSTIC_REQUIRED',
        method
      }
    );
  }
  return guardOk();
}

function summarizeActiveTabForEvent(tab) {
  if (!tab || typeof tab !== 'object') {
    return undefined;
  }
  return {
    url: tab.url || null,
    origin: tab.origin || null,
    title: tab.title || null,
    loadingState: tab.loadingState || null
  };
}

function normalizeTabId(value, label = 'tabId') {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return guardError(ERROR_CODES.INVALID_SCHEMA, `${label} must be a non-negative integer.`);
  }
  return guardOk({ tabId: value });
}

function normalizeAgentId(value) {
  if (value === undefined || value === null || value === '') {
    return guardOk({ agentId: null });
  }
  if (typeof value !== 'string') {
    return guardError(ERROR_CODES.INVALID_SCHEMA, 'agentId must be a string.');
  }
  const agentId = value.trim();
  if (!agentId) {
    return guardOk({ agentId: null });
  }
  if (agentId.length > 120 || !/^[A-Za-z0-9_.:-]+$/.test(agentId)) {
    return guardError(ERROR_CODES.INVALID_SCHEMA, 'agentId must be a short stable identifier.', {
      field: 'agentId'
    });
  }
  return guardOk({ agentId });
}

function makeTabLeaseId(sessionId, agentId, tabId) {
  if (!agentId || !Number.isInteger(tabId)) {
    return null;
  }
  return `lease_${stableHash({ sessionId, agentId, tabId }).slice(0, 24)}`;
}

function normalizeSessionTab(tab, fallbackOwnership = null) {
  if (!tab || typeof tab !== 'object') {
    return null;
  }
  const tabId = normalizeTabId(tab.id, 'tab.id');
  if (!tabId.ok) {
    return null;
  }
  const ownership = tab.ownership === 'agent' || tab.ownership === 'user'
    ? tab.ownership
    : fallbackOwnership;
  const ownerAgent = normalizeAgentId(tab.ownerAgentId || tab.agentId);
  return {
    id: tabId.tabId,
    title: typeof tab.title === 'string' ? tab.title : null,
    url: typeof tab.url === 'string' ? tab.url : null,
    pendingUrl: typeof tab.pendingUrl === 'string' && tab.pendingUrl ? tab.pendingUrl : null,
    requestedUrl: typeof tab.requestedUrl === 'string' && tab.requestedUrl ? tab.requestedUrl : null,
    windowId: typeof tab.windowId === 'number' ? tab.windowId : null,
    groupId: typeof tab.groupId === 'number' ? tab.groupId : null,
    favIconUrl: typeof tab.favIconUrl === 'string' ? tab.favIconUrl : null,
    status: typeof tab.status === 'string' ? tab.status : null,
    loadingState: typeof tab.loadingState === 'string' ? tab.loadingState : null,
    pinned: tab.pinned === true,
    audible: tab.audible === true,
    muted: tab.muted === true,
    lastAccessed: typeof tab.lastAccessed === 'string' ? tab.lastAccessed : null,
    ownership: ownership === 'agent' || ownership === 'user' ? ownership : null,
    ownerAgentId: ownerAgent.ok ? ownerAgent.agentId : null,
    leaseId: typeof tab.leaseId === 'string' && tab.leaseId ? tab.leaseId : null,
    active: tab.active === true,
    finalizedStatus: tab.finalizedStatus === 'handoff' || tab.finalizedStatus === 'deliverable'
      ? tab.finalizedStatus
      : null,
    updatedAt: new Date().toISOString()
  };
}

function normalizeUserTab(tab) {
  if (!tab || typeof tab !== 'object') {
    return null;
  }
  const normalized = normalizeSessionTab(tab, null);
  if (!normalized) {
    return null;
  }
  return {
    id: normalized.id,
    windowId: normalized.windowId,
    title: normalized.title,
    url: normalized.url,
    favIconUrl: normalized.favIconUrl,
    groupId: normalized.groupId,
    active: normalized.active,
    pinned: normalized.pinned,
    audible: normalized.audible,
    muted: normalized.muted,
    status: normalized.status,
    loadingState: normalized.loadingState,
    lastAccessed: normalized.lastAccessed || (typeof tab.lastAccessed === 'string' ? tab.lastAccessed : null),
    lastOpened: typeof tab.lastOpened === 'string' ? tab.lastOpened : null,
    tabGroup: typeof tab.tabGroup === 'string' ? tab.tabGroup : null,
    claimable: tab.claimable !== false
  };
}

function validateFinalizeKeep(keep, sessionTabs) {
  if (keep === undefined) {
    return guardOk({ keep: [] });
  }
  if (!Array.isArray(keep)) {
    return guardError(ERROR_CODES.INVALID_SCHEMA, 'keep must be an array.');
  }
  const seen = new Set();
  const normalized = [];
  for (const entry of keep) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return guardError(ERROR_CODES.INVALID_SCHEMA, 'keep entries must be objects.');
    }
    const tabId = normalizeTabId(entry.tabId);
    if (!tabId.ok) {
      return tabId;
    }
    if (!sessionTabs.has(tabId.tabId)) {
      return guardError(ERROR_CODES.INVALID_SCHEMA, `Cannot finalize unknown session tab ${tabId.tabId}.`, {
        tabId: tabId.tabId
      });
    }
    if (seen.has(tabId.tabId)) {
      return guardError(ERROR_CODES.INVALID_SCHEMA, `Duplicate finalize tab id ${tabId.tabId}.`, {
        tabId: tabId.tabId
      });
    }
    if (entry.status !== 'handoff' && entry.status !== 'deliverable') {
      return guardError(ERROR_CODES.INVALID_SCHEMA, 'keep status must be handoff or deliverable.', {
        tabId: tabId.tabId,
        status: entry.status
      });
    }
    seen.add(tabId.tabId);
    normalized.push({ tabId: tabId.tabId, status: entry.status });
  }
  return guardOk({ keep: normalized });
}

function validateRuntimeLocatorParams(params = {}) {
  const action = typeof params.action === 'string' && params.action.trim()
    ? params.action.trim()
    : 'resolve';
  if (!RUNTIME_LOCATOR_ACTIONS.has(action)) {
    return guardError(ERROR_CODES.INVALID_SCHEMA, 'Unsupported locator action.', {
      action
    });
  }
  const selector = typeof params.selector === 'string' ? params.selector.trim() : '';
  const text = typeof params.text === 'string' ? params.text.trim() : '';
  const handle = typeof params.handle === 'string' ? params.handle.trim() : '';
  if (!handle && !selector && !text) {
    return guardError(ERROR_CODES.INVALID_SCHEMA, 'Locator requires handle, selector, or text.');
  }
  if (handle.length > 200) {
    return guardError(ERROR_CODES.INVALID_SCHEMA, 'Locator handle is too long.', {
      maxLength: 200
    });
  }
  if (selector.length > 300) {
    return guardError(ERROR_CODES.INVALID_SCHEMA, 'Locator selector is too long.', {
      maxLength: 300
    });
  }
  if (text.length > 200) {
    return guardError(ERROR_CODES.INVALID_SCHEMA, 'Locator text is too long.', {
      maxLength: 200
    });
  }
  if ((action === 'type' || action === 'fill') && typeof params.textValue !== 'string') {
    return guardError(ERROR_CODES.INVALID_SCHEMA, 'Locator type/fill actions require textValue.');
  }
  if (action === 'select' && typeof params.value !== 'string') {
    return guardError(ERROR_CODES.INVALID_SCHEMA, 'Locator select actions require value.');
  }
  if (action === 'check' && typeof params.checked !== 'boolean') {
    return guardError(ERROR_CODES.INVALID_SCHEMA, 'Locator check actions require checked.');
  }
  if (action === 'scroll') {
    if (typeof params.deltaX !== 'number' || !Number.isFinite(params.deltaX)) {
      return guardError(ERROR_CODES.INVALID_SCHEMA, 'Locator scroll actions require numeric deltaX.');
    }
    if (typeof params.deltaY !== 'number' || !Number.isFinite(params.deltaY)) {
      return guardError(ERROR_CODES.INVALID_SCHEMA, 'Locator scroll actions require numeric deltaY.');
    }
  }
  if (action === 'pressKey' && typeof params.key !== 'string') {
    return guardError(ERROR_CODES.INVALID_SCHEMA, 'Locator pressKey actions require key.');
  }
  const verify = validateVerifyConditions(params.verify);
  if (!verify.ok) {
    return verify;
  }
  const targetContract = validateTargetContract(params.targetContract);
  if (!targetContract.ok) {
    return targetContract;
  }
  return guardOk({
    action,
    handle: handle || undefined,
    selector: selector || undefined,
    text: text || undefined,
    textValue: typeof params.textValue === 'string' ? params.textValue : undefined,
    value: typeof params.value === 'string' ? params.value : undefined,
    checked: typeof params.checked === 'boolean' ? params.checked : undefined,
    deltaX: typeof params.deltaX === 'number' ? params.deltaX : undefined,
    deltaY: typeof params.deltaY === 'number' ? params.deltaY : undefined,
    key: typeof params.key === 'string' ? params.key : undefined
  });
}

function pickRuntimeObservationParams(params = {}) {
  return pickDefinedLocal(params, [
    'mode',
    'maxActionableHandles',
    'summaryMaxChars',
    'sincePageStateId',
    'includeAx',
    'includeFormValues',
    'maxFieldValueChars',
    'postActionSnapshot',
    'requireVerified',
    'postActionVerifyDelayMs',
    'actionTrace',
    'actionTraceLabel',
    'actionTraceDurationMs',
    'targetContract',
    'verify'
  ]);
}

function pickRuntimeVisualObserveParams(params = {}) {
  return pickDefinedLocal(params, [
    'mode',
    'maxActionableHandles',
    'summaryMaxChars',
    'sincePageStateId',
    'includeAx',
    'includeFormValues',
    'maxFieldValueChars'
  ]);
}

function pickRuntimeReadPageParams(params = {}) {
  return pickDefinedLocal(params, [
    'filter',
    'depth',
    'maxChars',
    'refId',
    'includeFormValues',
    'maxFieldValueChars'
  ]);
}

function pickDefinedLocal(input, fields) {
  return Object.fromEntries(
    fields
      .filter((field) => input[field] !== undefined)
      .map((field) => [field, input[field]])
  );
}

function boundedInteger(value, fallback, min, max) {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function validateContextSearchParams(params = {}, label = 'query') {
  const query = typeof params.query === 'string' ? params.query.trim() : '';
  if (!query) {
    return guardError(ERROR_CODES.INVALID_SCHEMA, `${label} must be a non-empty string.`);
  }
  if (query.length > 200) {
    return guardError(ERROR_CODES.INVALID_SCHEMA, `${label} is too long.`, { maxLength: 200 });
  }
  return guardOk({
    query,
    maxResults: boundedInteger(params.maxResults, 10, 1, 50)
  });
}

function normalizeContextEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  return cloneJson(entry);
}

function normalizeDownloadEntry(download) {
  if (!download || typeof download !== 'object') {
    return null;
  }
  return {
    id: download.id,
    url: typeof download.url === 'string' ? download.url : null,
    finalUrl: typeof download.finalUrl === 'string' ? download.finalUrl : null,
    filename: typeof download.filename === 'string' ? download.filename : null,
    basename: typeof download.basename === 'string' ? download.basename : null,
    state: typeof download.state === 'string' ? download.state : null,
    danger: typeof download.danger === 'string' ? download.danger : null,
    exists: download.exists === true,
    fileSize: typeof download.fileSize === 'number' ? download.fileSize : null,
    mime: typeof download.mime === 'string' ? download.mime : null,
    startTime: typeof download.startTime === 'string' ? download.startTime : null,
    endTime: typeof download.endTime === 'string' ? download.endTime : null,
    error: typeof download.error === 'string' ? download.error : null
  };
}

function validateDownloadWaitParams(params = {}) {
  const filenameContains = typeof params.filenameContains === 'string' ? params.filenameContains.trim() : '';
  const urlContains = typeof params.urlContains === 'string' ? params.urlContains.trim() : '';
  const state = typeof params.state === 'string' ? params.state.trim() : '';
  if (state && !['complete', 'in_progress', 'interrupted'].includes(state)) {
    return guardError(ERROR_CODES.INVALID_SCHEMA, 'state must be complete, in_progress, or interrupted.', { state });
  }
  if (filenameContains.length > 200 || urlContains.length > 500) {
    return guardError(ERROR_CODES.INVALID_SCHEMA, 'Download match filters are too long.');
  }
  return guardOk({
    ...(filenameContains ? { filenameContains } : {}),
    ...(urlContains ? { urlContains } : {}),
    ...(state ? { state } : {}),
    timeoutMs: boundedInteger(params.timeoutMs, 30000, 0, 300000),
    pollIntervalMs: boundedInteger(params.pollIntervalMs, 500, 50, 5000)
  });
}

function validateTargetCueParams(params = {}) {
  const handle = typeof params.handle === 'string' ? params.handle.trim() : '';
  const selector = typeof params.selector === 'string' ? params.selector.trim() : '';
  const text = typeof params.text === 'string' ? params.text.trim() : '';
  if (!handle && !selector && !text) {
    return guardError(ERROR_CODES.INVALID_SCHEMA, 'showTarget requires handle, selector, or text.');
  }
  if (selector.length > 300 || text.length > 200 || handle.length > 200) {
    return guardError(ERROR_CODES.INVALID_SCHEMA, 'showTarget target hint is too long.');
  }
  return guardOk({
    ...(handle ? { handle } : {}),
    ...(selector ? { selector } : {}),
    ...(text ? { text } : {}),
    durationMs: boundedInteger(params.durationMs, 1500, 100, 10000)
  });
}

function validateChatWatcherStartParams(params = {}) {
  const origin = normalizeHttpOrigin(params.origin) || originFromUrl(params.url);
  if (!origin) {
    return guardError(ERROR_CODES.INVALID_SCHEMA, 'chat watcher origin must be an http(s) URL or origin.');
  }
  const tabId = normalizeTabId(params.tabId);
  if (!tabId.ok) {
    return tabId;
  }
  const unreadSelector = typeof params.unreadSelector === 'string' ? params.unreadSelector.trim() : '';
  if (!unreadSelector) {
    return guardError(ERROR_CODES.INVALID_SCHEMA, 'chat watcher requires unreadSelector.');
  }
  if (unreadSelector.length > 300) {
    return guardError(ERROR_CODES.INVALID_SCHEMA, 'chat watcher unreadSelector is too long.');
  }
  const label = typeof params.label === 'string' && params.label.trim()
    ? params.label.trim().slice(0, 120)
    : null;
  return guardOk({
    origin,
    tabId: tabId.tabId,
    unreadSelector,
    label,
    intervalMs: boundedInteger(params.intervalMs, 30000, 5000, 300000),
    screenshotOnUnread: params.screenshotOnUnread === true
  });
}

function validateChatWatcherId(params = {}) {
  const watcherId = typeof params.watcherId === 'string' ? params.watcherId.trim() : '';
  if (!watcherId) {
    return guardError(ERROR_CODES.INVALID_SCHEMA, 'watcherId is required.');
  }
  return guardOk({ watcherId });
}

class SessionManager {
  constructor(config = {}) {
    this.stateStore = config.stateStore || new OperatorStateStore({ statePath: config.statePath });
    this.config = {
      expectedExtensionId: config.expectedExtensionId || 'development-extension-id',
      expectedProtocolVersion: config.expectedProtocolVersion || '1.0',
      expectedExtensionVersion: config.expectedExtensionVersion || '0.2.13',
      expectedBridgeVersion: config.expectedBridgeVersion || '0.2.13',
      auditLogPath: config.auditLogPath || defaultAuditPath(),
      screenshotDir: config.screenshotDir || defaultScreenshotDir(),
      visualAnalyzerRegistry: config.visualAnalyzerRegistry || createVisualAnalyzerRegistry(),
      assetValidator: config.assetValidator || defaultAssetValidator,
      siteProfiles: config.siteProfiles || loadSiteProfiles({ profileDir: config.siteProfileDir }),
      chatWatcherAllowedOrigins: Array.isArray(config.chatWatcherAllowedOrigins)
        ? config.chatWatcherAllowedOrigins.slice()
        : [],
      token: config.token || process.env.CODEX_CHROME_OPERATOR_TOKEN || 'dev-token'
    };
    this.audit = new AuditLog(this.config.auditLogPath);
    this.screenshotStore = config.screenshotStore || new ScreenshotStore({
      rootDir: this.config.screenshotDir
    });
    this.visualAnalyzerRegistry = this.config.visualAnalyzerRegistry;
    this.assetValidator = this.config.assetValidator;
    this.siteProfiles = this.config.siteProfiles;
    this.connectionState = 'DAEMON_RUNNING_EXTENSION_DISCONNECTED';
    this.sessionId = config.sessionId || makeOperatorSessionId();
    this.profileVerified = false;
    this.profileIdentityVerified = false;
    this.profileVerificationMode = 'not-required';
    this.profileBindingStatus = 'not-required';
    this.bridgeInstanceId = null;
    this.connectionId = null;
    this.lastDisconnect = null;
    this.reconnectCount = 0;
    this.approvedOrigins = new Set(this.activeDomainApprovalOrigins());
    this.hostPermissions = new Set(this.activeHostPermissionOrigins());
    this.lastError = null;
    this.commandQueue = [];
    this.pendingCommands = new Map();
    this.pendingBridgePolls = new Map();
    this.nextCommandId = 1;
    this.nextBridgePollId = 1;
    this.pendingApprovals = new Map();
    this.nextApprovalId = 1;
    this.lastVersionMismatch = null;
    this.loadedExtension = null;
    this.activeTab = null;
    this.recentEvents = [];
    this.emergencyStop = {
      active: false,
      reason: null,
      stoppedAt: null,
      clearedAt: null
    };
    this.boundedFullAuto = this.defaultBoundedFullAutoState();
    this.warmSessionCaches = new Map();
    this.lastWarmSessionInactive = null;
    this.sessionName = null;
    this.sessionTabs = new Map();
    this.lastUserTabInventory = new Map();
    this.tabCommandLocks = new Map();
    this.chatWatcherAllowedOrigins = normalizeOriginAllowlist(this.config.chatWatcherAllowedOrigins);
    this.chatWatchers = new Map();
    this.chatWatcherEvents = [];
    this.nextChatWatcherId = 1;
    this.tokenUsage = this.defaultTokenUsage();
  }

  defaultTokenUsage() {
    return {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      commandCount: 0,
      lastMethod: null,
      lastOrigin: null,
      updatedAt: null
    };
  }

  chatWatcherStatus({ limit = 20 } = {}) {
    const boundedLimit = boundedInteger(limit, 20, 0, CHAT_WATCHER_EVENT_LIMIT);
    return {
      mode: 'observe-only',
      allowlistedOrigins: [...this.chatWatcherAllowedOrigins].sort(),
      watchers: [...this.chatWatchers.values()]
        .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
        .map((watcher) => ({ ...watcher })),
      events: this.chatWatcherEvents.slice(-boundedLimit).map((event) => ({ ...event }))
    };
  }

  status({ detail = 'full' } = {}) {
    const profileConfidence = this.profileConfidence();
    const fullStatus = {
      sessionId: this.sessionId,
      connectionState: this.connectionState,
      connectionId: this.connectionId,
      bridgeInstanceId: this.bridgeInstanceId,
      lastDisconnect: this.lastDisconnect,
      reconnectCount: this.reconnectCount,
      profileVerified: this.profileVerified,
      profileReady: this.profileVerified,
      profileIdentityVerified: this.profileIdentityVerified,
      profileVerificationMode: this.profileVerificationMode,
      profileConfidence,
      profileBindingStatus: this.profileBindingStatus,
      approvedOrigins: this.activeDomainApprovalOrigins(),
      hostPermissionOrigins: [...this.hostPermissions],
      blockedOrigins: this.stateStore.listBlockedOrigins(),
      policy: this.stateStore.getPolicyControls(),
      domainApprovals: this.stateStore.listDomainApprovals(),
      configuredProfile: this.stateStore.getConfiguredProfile(),
      pendingApprovals: this.listApprovalRecords({ status: 'pending' }),
      activeTab: this.activeTab ? { ...this.activeTab } : null,
      sessionName: this.sessionName,
      sessionTabs: this.listSessionTabRecords(),
      warmSession: this.warmSessionStatus(),
      chatWatcher: this.chatWatcherStatus(),
      recentEvents: this.recentEvents.map((event) => cloneJson(event)),
      recentActionLog: this.recentEvents.map((event) => cloneJson(event)),
      tokenUsage: { ...this.tokenUsage },
      emergencyStop: { ...this.emergencyStop },
      boundedFullAuto: this.boundedFullAutoStatus(),
      version: {
        protocolVersion: this.config.expectedProtocolVersion,
        extensionVersion: this.config.expectedExtensionVersion,
        bridgeVersion: this.config.expectedBridgeVersion,
        loadedExtensionVersion: this.loadedExtension && this.loadedExtension.extensionVersion,
        loadedBridgeVersion: this.loadedExtension && this.loadedExtension.bridgeVersion,
        loadedExtensionHash: this.loadedExtension && this.loadedExtension.loadedExtensionHash,
        loadedAt: this.loadedExtension && this.loadedExtension.loadedAt,
        lastMismatch: this.lastVersionMismatch
      },
      auditLogPath: this.config.auditLogPath,
      screenshotDir: this.config.screenshotDir,
      lastError: this.lastError
    };
    return detail === 'compact' ? this.compactStatus(fullStatus) : fullStatus;
  }

  compactStatus(fullStatus = this.status({ detail: 'full' })) {
    return {
      sessionId: fullStatus.sessionId,
      connectionState: fullStatus.connectionState,
      connectionId: fullStatus.connectionId,
      bridgeInstanceId: fullStatus.bridgeInstanceId,
      lastDisconnect: fullStatus.lastDisconnect,
      reconnectCount: fullStatus.reconnectCount,
      profileVerified: fullStatus.profileVerified,
      profileReady: fullStatus.profileReady,
      profileIdentityVerified: fullStatus.profileIdentityVerified,
      profileVerificationMode: fullStatus.profileVerificationMode,
      profileConfidence: fullStatus.profileConfidence,
      profileBindingStatus: fullStatus.profileBindingStatus,
      activeTab: fullStatus.activeTab ? { ...fullStatus.activeTab } : null,
      sessionName: fullStatus.sessionName,
      sessionTabs: fullStatus.sessionTabs.map((tab) => ({ ...tab })),
      warmSession: { ...fullStatus.warmSession },
      chatWatcher: {
        allowlistedOriginCount: fullStatus.chatWatcher.allowlistedOrigins.length,
        watcherCount: fullStatus.chatWatcher.watchers.length,
        eventCount: fullStatus.chatWatcher.events.length,
        pausedCount: fullStatus.chatWatcher.watchers.filter((watcher) => watcher.paused).length,
        lastEvent: fullStatus.chatWatcher.events.length
          ? { ...fullStatus.chatWatcher.events[fullStatus.chatWatcher.events.length - 1] }
          : null
      },
      tokenUsage: { ...fullStatus.tokenUsage },
      pendingApprovalCount: fullStatus.pendingApprovals.length,
      emergencyStop: { ...fullStatus.emergencyStop },
      boundedFullAuto: this.compactBoundedFullAutoStatus(fullStatus.boundedFullAuto),
      policy: { ...fullStatus.policy },
      version: { ...fullStatus.version },
      lastError: fullStatus.lastError,
      approvedOriginCount: fullStatus.approvedOrigins.length,
      blockedOriginCount: fullStatus.blockedOrigins.length,
      domainApprovalCount: Object.keys(fullStatus.domainApprovals).length,
      hostPermissionOriginCount: fullStatus.hostPermissionOrigins.length
    };
  }

  compactBoundedFullAutoStatus(state = this.boundedFullAutoStatus()) {
    const contract = state.contract || {};
    return {
      active: Boolean(state.active),
      mode: contract.mode || null,
      taskScope: contract.taskScope || null,
      approvedOriginCount: Array.isArray(contract.approvedOrigins) ? contract.approvedOrigins.length : 0,
      allowedActionKindCount: Array.isArray(contract.allowedActionKinds) ? contract.allowedActionKinds.length : 0,
      blockedActionKindCount: Array.isArray(contract.blockedActionKinds) ? contract.blockedActionKinds.length : 0,
      limits: contract.limits || {},
      counters: state.counters || {},
      startedAt: state.startedAt || null,
      expiresAt: state.expiresAt || null,
      stoppedAt: state.stoppedAt || null,
      stopReason: state.stopReason || null,
      lastOrigin: state.lastOrigin || null
    };
  }

  async handleRpc(request) {
    const id = request && request.id;
    if (!request || typeof request.method !== 'string') {
      return attachRpcTelemetry('rpc.invalidRequest', rpcError(id || null, {
        code: ERROR_CODES.INVALID_REQUEST,
        message: 'RPC request must include method.'
      }));
    }

    const params = request.params || {};
    let response;

    switch (request.method) {
      case 'operator.status':
        response = rpcOk(id, this.status({ detail: params.detail }));
        break;
      case 'operator.ensureStarted':
        response = this.ensureStarted(id, params);
        break;
      case 'extension.hello':
        response = this.handleHello(id, params.hello, params);
        break;
      case 'operator.approveDomain':
        response = this.approveDomain(id, params);
        break;
      case 'operator.revokeDomain':
        response = this.revokeDomain(id, params);
        break;
      case 'extension.hostPermissionGranted':
        response = this.hostPermissionGranted(id, params);
        break;
      case 'extension.hostPermissionsSynced':
        response = this.hostPermissionsSynced(id, params);
        break;
      case 'extension.blockedOriginsSynced':
        response = this.blockedOriginsSynced(id, params);
        break;
      case 'extension.activeTabUpdated':
        response = this.activeTabUpdated(id, params);
        break;
      case 'extension.activeTabWarmup':
        response = this.activeTabWarmup(id, params);
        break;
      case 'extension.disconnected':
      case 'bridge.disconnected':
        response = this.handleDisconnected(id, {
          ...params,
          source: params.source || (request.method === 'bridge.disconnected' ? 'native-bridge' : 'extension')
        });
        break;
      case 'operator.profiles.discover':
        response = this.discoverProfiles(id, params);
        break;
      case 'operator.profile.bind':
        response = this.bindProfile(id, params);
        break;
      case 'operator.profile.verify':
        response = this.verifyProfile(id);
        break;
      case 'operator.verifyReadiness':
        response = this.verifyReadiness(id, params);
        break;
      case 'operator.approvals.list':
        response = this.listApprovals(id, params);
        break;
      case 'operator.approvals.approve':
        response = this.approveApproval(id, params);
        break;
      case 'operator.approvals.reject':
        response = this.rejectApproval(id, params);
        break;
      case 'operator.approvals.run':
        response = await this.runApproval(id, params);
        break;
      case 'operator.policy.status':
        response = this.policyStatus(id);
        break;
      case 'operator.policy.update':
        response = this.updatePolicy(id, params);
        break;
      case 'operator.tabs.listUser':
      case 'operator.tabs.claim':
      case 'operator.tabs.listSession':
      case 'operator.tabs.create':
      case 'operator.tabs.finalize':
      case 'operator.tabs.focus':
      case 'operator.tabs.pin':
      case 'operator.tabs.move':
      case 'operator.tabs.groupRename':
      case 'operator.session.name':
        response = await this.routeSessionTabCommand(id, request.method, params);
        break;
      case 'operator.context.recentTabs':
      case 'operator.context.historySearch':
      case 'operator.context.bookmarkSearch':
        response = await this.routeBrowserContextCommand(id, request.method, params);
        break;
      case 'operator.downloads.wait':
      case 'operator.downloads.show':
        response = await this.routeDownloadCommand(id, request.method, params);
        break;
      case 'operator.sessions.reopenClosedTab':
        response = await this.routeSessionRecoveryCommand(id, request.method, params);
        break;
      case 'operator.chatWatcher.start':
      case 'operator.chatWatcher.pause':
      case 'operator.chatWatcher.resume':
      case 'operator.chatWatcher.stop':
      case 'operator.chatWatcher.poll':
      case 'operator.chatWatcher.status':
        response = await this.routeChatWatcherCommand(id, request.method, params);
        break;
      case 'operator.cdp.attach':
      case 'operator.cdp.detach':
      case 'operator.cdp.execute':
        response = await this.routeCdpCommand(id, request.method, params);
        break;
      case 'operator.runtime.tab.goto':
      case 'operator.runtime.tab.observe':
      case 'operator.runtime.tab.readPage':
      case 'operator.runtime.tab.visualObserve':
      case 'operator.runtime.tab.visualAnalyze':
      case 'operator.runtime.tab.visualInspectTarget':
      case 'operator.runtime.tab.uploadFile':
      case 'operator.runtime.tab.locator':
      case 'operator.runtime.tab.batch':
      case 'operator.runtime.tab.showTarget':
      case 'operator.runtime.tab.indicator':
        response = await this.routeRuntimeCommand(id, request.method, params);
        break;
      case 'operator.screenshots.cleanup':
        response = this.cleanupScreenshots(id, params);
        break;
      case 'operator.emergencyStop':
        response = this.activateEmergencyStop(id, params);
        break;
      case 'operator.emergencyClear':
        response = this.clearEmergencyStop(id);
        break;
      case 'operator.fullAuto.start':
        response = this.startBoundedFullAuto(id, params);
        break;
      case 'operator.fullAuto.stop':
        response = this.stopBoundedFullAuto(id, params);
        break;
      case 'operator.fullAuto.status':
        response = rpcOk(id, this.boundedFullAutoStatus());
        break;
      case 'operator.audit.tail':
        response = this.tailAudit(id, params);
        break;
      case 'operator.audit.timeline':
        response = this.timelineAudit(id, params);
        break;
      case 'page.observe':
      case 'page.readPage':
      case 'page.extract':
      case 'page.mediaInspect':
      case 'page.formExtract':
      case 'page.formFillPlan':
      case 'page.formFillExecute':
      case 'page.batch':
      case 'page.visualObserve':
      case 'page.visualAnalyze':
      case 'page.visualInspectTarget':
      case 'page.uploadFile':
      case 'page.prepareCart':
        response = await this.routePageCommand(id, request.method, params);
        break;
      case 'page.click':
      case 'page.type':
      case 'page.fill':
      case 'page.clear':
      case 'page.focus':
      case 'page.select':
      case 'page.check':
      case 'page.scroll':
      case 'page.pressKey':
      case 'page.navigate':
      case 'page.waitFor':
        response = await this.routePageCommand(id, request.method, params);
        break;
      case 'bridge.poll':
        response = await this.pollBridge(id, params);
        break;
      case 'bridge.deliver':
        response = this.deliverBridgeResponse(id, params);
        break;
      default:
        response = rpcError(id, {
          code: ERROR_CODES.UNKNOWN_METHOD,
          message: `Unknown method: ${request.method}`
        });
        break;
    }

    response = attachRpcTelemetry(request.method, response);
    this.recordTokenUsage({
      method: request.method,
      params,
      response
    });

    this.audit.append({
      ...this.buildAuditEntry({
        requestId: id,
        method: request.method,
        params,
        response
      })
    });

    if (!response.ok) {
      this.lastError = response.error;
    } else if (clearsLastErrorOnSuccess(request.method)) {
      this.lastError = null;
    }

    this.recordRpcEvent({
      method: request.method,
      params,
      response
    });

    return response;
  }

  shouldTrackTokenUsage(method) {
    return TOKEN_USAGE_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix)) &&
      method !== 'operator.tabs.listSession';
  }

  relaxedHighRiskApproval() {
    const policy = this.stateStore.getPolicyControls();
    return policy.guardedActionsEnabled === false
      ? {
        approval: {
          allowHighRisk: true,
          allowSensitiveFormFill: true,
          approvalKind: 'policy-disabled'
        },
        policy: {
          highRiskEnabled: false,
          sensitiveFormFillEnabled: false
        }
      }
      : {};
  }

  withRelaxedHighRiskApproval(params = {}) {
    if (params.approval && typeof params.approval === 'object') {
      return params;
    }
    const relaxed = this.relaxedHighRiskApproval();
    return relaxed.approval ? {
      ...params,
      ...relaxed,
      policy: {
        ...(params.policy && typeof params.policy === 'object' ? params.policy : {}),
        ...relaxed.policy
      }
    } : params;
  }

  highRiskGuardsDisabled() {
    return this.stateStore.getPolicyControls().guardedActionsEnabled === false;
  }

  relaxedRetryApprovalForError(error = {}) {
    if (!this.highRiskGuardsDisabled()) {
      return null;
    }
    if (error.code === ERROR_CODES.HIGH_RISK_BLOCKED) {
      return {
        allowHighRisk: true,
        allowSensitiveFormFill: true,
        approvalKind: error.approvalKind || 'policy-disabled'
      };
    }
    if (error.code === ERROR_CODES.SENSITIVE_FORM_FILL_BLOCKED) {
      return {
        allowHighRisk: true,
        allowSensitiveFormFill: true,
        approvalKind: error.approvalKind || 'sensitive-form-fill'
      };
    }
    return null;
  }

  async enqueueExtensionCommandWithPolicy(method, params = {}) {
    const commandParams = this.withRelaxedHighRiskApproval(params);
    const response = await this.enqueueExtensionCommand(method, commandParams);
    const retryApproval = response && response.ok === false && response.error
      ? this.relaxedRetryApprovalForError(response.error)
      : null;
    if (retryApproval) {
      return this.enqueueExtensionCommand(method, {
        ...commandParams,
        approval: retryApproval,
        policy: {
          ...(commandParams.policy && typeof commandParams.policy === 'object' ? commandParams.policy : {}),
          highRiskEnabled: false,
          sensitiveFormFillEnabled: false
        }
      });
    }
    return response;
  }

  recordTokenUsage({ method, params, response }) {
    if (!this.shouldTrackTokenUsage(method) || !response || !response.telemetry) {
      return;
    }
    const inputTokens = approxTokens(jsonCharLength({
      method,
      params
    }));
    const outputTokens = Number.isFinite(response.telemetry.approxResultTokens)
      ? response.telemetry.approxResultTokens
      : 0;
    this.tokenUsage = {
      inputTokens: this.tokenUsage.inputTokens + inputTokens,
      outputTokens: this.tokenUsage.outputTokens + outputTokens,
      totalTokens: this.tokenUsage.totalTokens + inputTokens + outputTokens,
      commandCount: this.tokenUsage.commandCount + 1,
      lastMethod: method,
      lastOrigin: originFromParams(params) || (response.ok && response.result && response.result.origin) || null,
      updatedAt: new Date().toISOString()
    };
  }

  recordRecentEvent(event) {
    const cleanEvent = Object.fromEntries(
      Object.entries({
        timestamp: new Date().toISOString(),
        ...event
      }).filter(([, value]) => value !== undefined)
    );
    this.recentEvents.push(cleanEvent);
    if (this.recentEvents.length > RECENT_ACTION_LOG_LIMIT) {
      this.recentEvents.splice(0, this.recentEvents.length - RECENT_ACTION_LOG_LIMIT);
    }
  }

  recordRpcEvent({ method, params, response }) {
    const result = response.ok ? 'ok' : 'error';
    const errorCode = response.error && response.error.code;
    const origin = originFromParams(params) || (response.ok && response.result && response.result.origin);
    const actionKind = PAGE_ACTION_KINDS[method];

    if (method === 'extension.hello') {
      this.recordRecentEvent({
        type: 'hello',
        method,
        result,
        errorCode,
        activeTab: summarizeActiveTabForEvent(this.activeTab)
      });
      if (response.ok) {
        this.recordRecentEvent({
          type: 'connect',
          method,
          result,
          activeTab: summarizeActiveTabForEvent(this.activeTab)
        });
      }
      return;
    }

    if (method === 'extension.disconnected' || method === 'bridge.disconnected') {
      this.recordRecentEvent({
        type: 'disconnect',
        method,
        result,
        errorCode
      });
      return;
    }

    if (method === 'extension.activeTabUpdated') {
      this.recordRecentEvent({
        type: 'activeTabUpdated',
        method,
        result,
        errorCode,
        activeTab: summarizeActiveTabForEvent(this.activeTab)
      });
      return;
    }

    if (method === 'extension.activeTabWarmup') {
      this.recordRecentEvent({
        type: 'activeTabWarmup',
        method,
        result,
        errorCode,
        warmSession: response.ok ? this.warmSessionStatus() : null,
        activeTab: summarizeActiveTabForEvent(this.activeTab)
      });
      return;
    }

    if (method === 'operator.approveDomain' || method === 'operator.revokeDomain') {
      this.recordRecentEvent({
        type: 'domainApproval',
        method,
        origin,
        result,
        errorCode
      });
      return;
    }

    if (method.startsWith('operator.tabs.') || method === 'operator.session.name') {
      this.recordRecentEvent({
        type: 'sessionTabs',
        method,
        result,
        errorCode
      });
      return;
    }

    if (method.startsWith('operator.runtime.')) {
      this.recordRecentEvent({
        type: 'runtime',
        method,
        origin,
        result,
        errorCode
      });
      return;
    }

    if (method.startsWith('operator.cdp.')) {
      this.recordRecentEvent({
        type: 'cdp',
        method,
        origin,
        result,
        errorCode
      });
      return;
    }

    if (method.startsWith('operator.chatWatcher.')) {
      this.recordRecentEvent({
        type: 'chatWatcher',
        method,
        origin,
        result,
        errorCode
      });
      return;
    }

    if (method === 'extension.hostPermissionGranted' || method === 'extension.hostPermissionsSynced') {
      this.recordRecentEvent({
        type: 'hostPermission',
        method,
        origin,
        result,
        errorCode
      });
      return;
    }

    if (method === 'extension.blockedOriginsSynced') {
      this.recordRecentEvent({
        type: 'blockedOrigins',
        method,
        result,
        errorCode
      });
      return;
    }

    if (method.startsWith('page.') && !response.ok) {
      this.recordRecentEvent({
        type: 'pageCommandFailed',
        method,
        origin,
        actionKind,
        result,
        errorCode,
        activeTab: summarizeActiveTabForEvent(this.activeTab)
      });
    }
  }

  buildAuditEntry({ requestId, method, params, response }) {
    const origin = originFromParams(params) || (response.ok && response.result && response.result.origin);
    const actionKind = PAGE_ACTION_KINDS[method];
    const mode = this.auditMode(method, response);
    const entry = {
      sessionId: this.sessionId,
      agentId: typeof params.agentId === 'string' && params.agentId.trim()
        ? params.agentId.trim()
        : null,
      connectionId: this.connectionId,
      bridgeInstanceId: this.bridgeInstanceId,
      tabId: Number.isInteger(params.tabId)
        ? params.tabId
        : (Number.isInteger(params.expectedActiveTabId) ? params.expectedActiveTabId : null),
      requestId,
      method,
      mode,
      origin,
      actionKind,
      targetSummary: response.error && response.error.targetSummary,
      params: method.startsWith('operator.cdp.') ? safeCdpAuditParams(params) : params,
      result: response.ok ? 'ok' : 'error',
      errorCode: response.error && response.error.code
    };

    const boundedFullAuto = this.auditBoundedFullAutoSummary(method, response);
    if (boundedFullAuto) {
      entry.boundedFullAuto = boundedFullAuto;
    }
    const focusDisturbance = focusDisturbanceSummary(response);
    if (focusDisturbance) {
      entry.focusDisturbance = focusDisturbance;
    }

    return entry;
  }

  auditMode(method, response) {
    if (
      method.startsWith('operator.fullAuto.') ||
      this.boundedFullAuto.active ||
      isBoundedFullAutoError(response.error)
    ) {
      return 'bounded-full-auto-v1';
    }
    return 'guarded';
  }

  auditBoundedFullAutoSummary(method, response) {
    if (
      !method.startsWith('operator.fullAuto.') &&
      !this.boundedFullAuto.active &&
      !isBoundedFullAutoError(response.error)
    ) {
      return null;
    }

    const state = this.boundedFullAutoStatus();
    const contract = state.contract || {};
    return {
      active: state.active,
      taskScope: contract.taskScope || null,
      approvedOrigins: Array.isArray(contract.approvedOrigins) ? contract.approvedOrigins : [],
      allowedActionKinds: Array.isArray(contract.allowedActionKinds) ? contract.allowedActionKinds : [],
      blockedActionKinds: Array.isArray(contract.blockedActionKinds) ? contract.blockedActionKinds : [],
      limits: contract.limits || {},
      counters: state.counters,
      startedAt: state.startedAt,
      expiresAt: state.expiresAt,
      stoppedAt: state.stoppedAt,
      stopReason: state.stopReason
    };
  }

  listSessionTabRecords() {
    return [...this.sessionTabs.values()]
      .sort((left, right) => left.id - right.id)
      .map((tab) => ({ ...tab }));
  }

  listSessionTabRecordsForAgent(agentId) {
    return this.listSessionTabRecords()
      .filter((tab) => !agentId || !tab.ownerAgentId || tab.ownerAgentId === agentId);
  }

  assertTabLease(tab, agentId) {
    if (!tab) {
      return guardOk();
    }
    if (agentId && tab.ownerAgentId && tab.ownerAgentId !== agentId) {
      return guardError(ERROR_CODES.TAB_MISMATCH, 'Session tab is leased to a different agent.', {
        reason: 'agent-lease-mismatch',
        tabId: tab.id,
        ownerAgentId: tab.ownerAgentId,
        agentId
      });
    }
    return guardOk();
  }

  assertTabFinalizeLease(tab, agentId) {
    if (!agentId || !tab) {
      return guardOk();
    }
    if (tab.ownerAgentId !== agentId) {
      return guardError(ERROR_CODES.TAB_MISMATCH, 'Session tab is leased to a different agent.', {
        reason: 'agent-lease-mismatch',
        tabId: tab.id,
        ownerAgentId: tab.ownerAgentId || null,
        agentId
      });
    }
    return guardOk();
  }

  updateSessionTab(tab, fallbackOwnership, options = {}) {
    const normalized = normalizeSessionTab(tab, fallbackOwnership);
    if (!normalized) {
      return null;
    }
    const previous = this.sessionTabs.get(normalized.id) || {};
    const agentId = normalizeAgentId(options.agentId).agentId ||
      normalized.ownerAgentId ||
      previous.ownerAgentId ||
      null;
    const leaseId = agentId
      ? (
        previous.ownerAgentId === agentId && previous.leaseId
          ? previous.leaseId
          : makeTabLeaseId(this.sessionId, agentId, normalized.id)
      )
      : (normalized.leaseId || previous.leaseId || null);
    const merged = {
      ...previous,
      ...normalized,
      ownership: normalized.ownership || previous.ownership || fallbackOwnership || null,
      ownerAgentId: agentId,
      leaseId,
      finalizedStatus: normalized.finalizedStatus || previous.finalizedStatus || null
    };
    const explicitPendingUrl = normalized.pendingUrl || normalized.requestedUrl || null;
    let pendingUrl = explicitPendingUrl || previous.pendingUrl || null;
    if (pendingUrl && merged.url) {
      const urlChanged = previous.url && merged.url !== previous.url;
      const loadingComplete = merged.loadingState === 'complete' || merged.status === 'complete';
      if (merged.url === pendingUrl || urlChanged || (!explicitPendingUrl && loadingComplete)) {
        pendingUrl = null;
      }
    }
    merged.pendingUrl = pendingUrl;
    merged.requestedUrl = pendingUrl
      ? (normalized.requestedUrl || previous.requestedUrl || pendingUrl)
      : null;
    this.sessionTabs.set(merged.id, merged);
    if (previous.url && merged.url && previous.url !== merged.url) {
      this.clearWarmSessionCache('tab-navigated', {
        tabId: merged.id,
        url: previous.url,
        origin: originFromUrl(previous.url)
      });
      this.invalidateApprovalsForTab(merged.id, 'tab-navigated', {
        previousUrl: previous.url,
        currentUrl: merged.url
      });
    }
    return { ...merged };
  }

  updateSessionTabs(tabs = [], options = {}) {
    if (!Array.isArray(tabs)) {
      return this.listSessionTabRecords();
    }
    const pruneAgentId = normalizeAgentId(options.agentId).agentId || null;
    const seenTabIds = new Set();
    for (const tab of tabs) {
      const updated = this.updateSessionTab(tab, tab && tab.ownership);
      if (updated && Number.isInteger(updated.id)) {
        seenTabIds.add(updated.id);
      }
    }
    if (options.pruneMissing) {
      for (const tabId of [...this.sessionTabs.keys()]) {
        if (!seenTabIds.has(tabId)) {
          const previous = this.sessionTabs.get(tabId);
          if (pruneAgentId && previous && previous.ownerAgentId && previous.ownerAgentId !== pruneAgentId) {
            continue;
          }
          this.clearWarmSessionCache('tab-closed', this.warmCacheContextForTab(previous, { tabId }));
          this.invalidateApprovalsForTab(tabId, 'tab-closed');
          this.sessionTabs.delete(tabId);
        }
      }
    }
    return this.listSessionTabRecords();
  }

  updateUserTabInventory(tabs = []) {
    this.lastUserTabInventory.clear();
    if (!Array.isArray(tabs)) {
      return [];
    }
    const normalized = [];
    for (const tab of tabs) {
      const clean = normalizeUserTab(tab);
      if (clean) {
        this.lastUserTabInventory.set(clean.id, clean);
        normalized.push(clean);
      }
    }
    return normalized;
  }

  async refreshSessionTabForOperation(tabId) {
    let tab = this.sessionTabs.get(tabId) || null;
    if (!tab) {
      return null;
    }
    if (tab && originFromUrl(tab.url) && !tab.pendingUrl) {
      return tab;
    }
    if (this.connectionState !== 'EXTENSION_CONNECTED') {
      return tab;
    }
    const extensionResponse = await this.enqueueExtensionCommand('operator.tabs.listSession', {});
    if (extensionResponse.ok) {
      this.updateSessionTabs(extensionResponse.result && extensionResponse.result.tabs, { pruneMissing: true });
      tab = this.sessionTabs.get(tabId) || tab;
    }
    return tab;
  }

  ensureExtensionConnected(id) {
    if (this.emergencyStop.active) {
      return rpcError(id, this.emergencyStopError());
    }
    if (this.connectionState === 'RECONNECTING' || this.connectionState === 'DAEMON_RUNNING_EXTENSION_DISCONNECTED') {
      return rpcError(id, {
        code: ERROR_CODES.EXTENSION_DISCONNECTED,
        message: 'Extension must reconnect with a fresh HELLO before tab session commands can continue.',
        reconnectRequired: true,
        lastDisconnect: this.lastDisconnect
      });
    }
    return null;
  }

  async routeSessionTabCommand(id, method, params = {}) {
    const disconnected = this.ensureExtensionConnected(id);
    if (disconnected) {
      return disconnected;
    }
    const agent = normalizeAgentId(params.agentId);
    if (!agent.ok) {
      return rpcError(id, agent.error);
    }
    const agentId = agent.agentId;

    if (method === 'operator.tabs.listUser') {
      const extensionResponse = await this.enqueueExtensionCommand(method, {});
      if (!extensionResponse.ok) {
        return rpcError(id, extensionResponse.error);
      }
      const tabs = this.updateUserTabInventory(extensionResponse.result && extensionResponse.result.tabs);
      return rpcOk(id, { tabs });
    }

    if (method === 'operator.tabs.claim') {
      const tabId = normalizeTabId(params.tabId);
      if (!tabId.ok) {
        return rpcError(id, tabId.error);
      }
      const existingLease = this.assertTabLease(this.sessionTabs.get(tabId.tabId), agentId);
      if (!existingLease.ok) {
        return rpcError(id, existingLease.error);
      }
      if (!this.lastUserTabInventory.has(tabId.tabId)) {
        return rpcError(id, {
          code: ERROR_CODES.INVALID_SCHEMA,
          message: 'Tab must come from the latest user tab inventory before it can be claimed.',
          tabId: tabId.tabId
        });
      }
      const extensionResponse = await this.enqueueExtensionCommand(method, {
        ...(agentId ? { agentId } : {}),
        tabId: tabId.tabId
      });
      if (!extensionResponse.ok) {
        return rpcError(id, extensionResponse.error);
      }
      const tab = this.updateSessionTab(extensionResponse.result && extensionResponse.result.tab, 'user', { agentId });
      return rpcOk(id, { tab });
    }

    if (method === 'operator.tabs.create') {
      const extensionResponse = await this.enqueueExtensionCommand(method, agentId ? { agentId } : {});
      if (!extensionResponse.ok) {
        return rpcError(id, extensionResponse.error);
      }
      const tab = this.updateSessionTab(extensionResponse.result && extensionResponse.result.tab, 'agent', { agentId });
      return rpcOk(id, { tab });
    }

    if (method === 'operator.tabs.listSession') {
      const extensionResponse = await this.enqueueExtensionCommand(method, agentId ? { agentId } : {});
      if (!extensionResponse.ok) {
        return rpcError(id, extensionResponse.error);
      }
      const tabs = this.updateSessionTabs(extensionResponse.result && extensionResponse.result.tabs, {
        pruneMissing: true,
        agentId
      });
      return rpcOk(id, { tabs: this.listSessionTabRecordsForAgent(agentId) });
    }

    if (method === 'operator.tabs.finalize') {
      const keep = validateFinalizeKeep(params.keep, this.sessionTabs);
      if (!keep.ok) {
        return rpcError(id, keep.error);
      }
      for (const entry of keep.keep) {
        const lease = this.assertTabFinalizeLease(this.sessionTabs.get(entry.tabId), agentId);
        if (!lease.ok) {
          return rpcError(id, lease.error);
        }
      }
      const extensionResponse = await this.enqueueExtensionCommand(method, {
        ...(agentId ? { agentId } : {}),
        keep: keep.keep
      });
      if (!extensionResponse.ok) {
        return rpcError(id, extensionResponse.error);
      }
      const finalizedResult = extensionResponse.result || {};
      const closeFailedTabIds = new Set(
        (Array.isArray(finalizedResult.closeFailed) ? finalizedResult.closeFailed : [])
          .map((entry) => {
            if (Number.isInteger(entry)) {
              return entry;
            }
            return entry && Number.isInteger(entry.tabId) ? entry.tabId : null;
          })
          .filter(Number.isInteger)
      );
      const removedTabIds = [
        ...(Array.isArray(finalizedResult.closed) ? finalizedResult.closed : []),
        ...(Array.isArray(finalizedResult.released) ? finalizedResult.released : [])
      ];
      for (const tabId of removedTabIds) {
        if (Number.isInteger(tabId)) {
          if (closeFailedTabIds.has(tabId)) {
            continue;
          }
          const previous = this.sessionTabs.get(tabId);
          if (agentId && previous && previous.ownerAgentId !== agentId) {
            continue;
          }
          this.clearWarmSessionCache('tab-closed', this.warmCacheContextForTab(previous, { tabId }));
          this.invalidateApprovalsForTab(tabId, 'tab-closed');
          this.sessionTabs.delete(tabId);
        }
      }
      const keepTabIds = new Set(keep.keep.map((entry) => entry.tabId));
      for (const tabId of [...this.sessionTabs.keys()]) {
        const tab = this.sessionTabs.get(tabId);
        if (agentId && tab && tab.ownerAgentId !== agentId) {
          continue;
        }
        if (closeFailedTabIds.has(tabId)) {
          continue;
        }
        if (!keepTabIds.has(tabId)) {
          const previous = this.sessionTabs.get(tabId);
          this.clearWarmSessionCache('tab-finalized', this.warmCacheContextForTab(previous, { tabId }));
          this.invalidateApprovalsForTab(tabId, 'tab-finalized');
          this.sessionTabs.delete(tabId);
        }
      }
      for (const entry of keep.keep) {
        const tab = this.sessionTabs.get(entry.tabId);
        if (tab) {
          this.sessionTabs.set(entry.tabId, {
            ...tab,
            finalizedStatus: entry.status,
            updatedAt: new Date().toISOString()
          });
        }
      }
      return rpcOk(id, {
        ...(extensionResponse.result || {}),
        keep: keep.keep
      });
    }

    if (method === 'operator.session.name') {
      const name = typeof params.name === 'string' ? params.name.trim().slice(0, 80) : '';
      if (!name) {
        return rpcError(id, {
          code: ERROR_CODES.INVALID_SCHEMA,
          message: 'name must be a non-empty string.'
        });
      }
      const extensionResponse = await this.enqueueExtensionCommand(method, { name });
      if (!extensionResponse.ok) {
        return rpcError(id, extensionResponse.error);
      }
      this.sessionName = name;
      return rpcOk(id, { name });
    }

    if (method === 'operator.tabs.focus') {
      const tabId = normalizeTabId(params.tabId);
      if (!tabId.ok) {
        return rpcError(id, tabId.error);
      }
      const lease = this.assertTabLease(this.sessionTabs.get(tabId.tabId), agentId);
      if (!lease.ok) {
        return rpcError(id, lease.error);
      }
      const extensionResponse = await this.enqueueExtensionCommand(method, {
        ...(agentId ? { agentId } : {}),
        tabId: tabId.tabId
      });
      if (!extensionResponse.ok) {
        return rpcError(id, extensionResponse.error);
      }
      const tab = this.updateSessionTab(extensionResponse.result && extensionResponse.result.tab, null) ||
        normalizeUserTab(extensionResponse.result && extensionResponse.result.tab);
      return rpcOk(id, { ...(extensionResponse.result || {}), tab });
    }

    if (method === 'operator.tabs.pin') {
      const tabId = normalizeTabId(params.tabId);
      if (!tabId.ok) {
        return rpcError(id, tabId.error);
      }
      const lease = this.assertTabLease(this.sessionTabs.get(tabId.tabId), agentId);
      if (!lease.ok) {
        return rpcError(id, lease.error);
      }
      if (typeof params.pinned !== 'boolean') {
        return rpcError(id, { code: ERROR_CODES.INVALID_SCHEMA, message: 'pinned must be a boolean.' });
      }
      const extensionResponse = await this.enqueueExtensionCommand(method, {
        ...(agentId ? { agentId } : {}),
        tabId: tabId.tabId,
        pinned: params.pinned
      });
      if (!extensionResponse.ok) {
        return rpcError(id, extensionResponse.error);
      }
      return rpcOk(id, {
        ...(extensionResponse.result || {}),
        tab: normalizeContextEntry(extensionResponse.result && extensionResponse.result.tab)
      });
    }

    if (method === 'operator.tabs.move') {
      const tabId = normalizeTabId(params.tabId);
      if (!tabId.ok) {
        return rpcError(id, tabId.error);
      }
      const lease = this.assertTabLease(this.sessionTabs.get(tabId.tabId), agentId);
      if (!lease.ok) {
        return rpcError(id, lease.error);
      }
      const index = boundedInteger(params.index, null, 0, 1000);
      if (index === null) {
        return rpcError(id, { code: ERROR_CODES.INVALID_SCHEMA, message: 'index must be a non-negative integer.' });
      }
      const windowId = params.windowId === undefined ? undefined : boundedInteger(params.windowId, null, 0, 1000000);
      if (params.windowId !== undefined && windowId === null) {
        return rpcError(id, { code: ERROR_CODES.INVALID_SCHEMA, message: 'windowId must be a non-negative integer.' });
      }
      const commandParams = {
        ...(agentId ? { agentId } : {}),
        tabId: tabId.tabId,
        index,
        ...(windowId === undefined ? {} : { windowId })
      };
      const extensionResponse = await this.enqueueExtensionCommand(method, commandParams);
      if (!extensionResponse.ok) {
        return rpcError(id, extensionResponse.error);
      }
      return rpcOk(id, {
        ...(extensionResponse.result || {}),
        tab: normalizeContextEntry(extensionResponse.result && extensionResponse.result.tab)
      });
    }

    if (method === 'operator.tabs.groupRename') {
      const groupId = boundedInteger(params.groupId, null, 0, 1000000);
      const title = typeof params.title === 'string' ? params.title.trim().slice(0, 80) : '';
      if (groupId === null) {
        return rpcError(id, { code: ERROR_CODES.INVALID_SCHEMA, message: 'groupId must be a non-negative integer.' });
      }
      if (!title) {
        return rpcError(id, { code: ERROR_CODES.INVALID_SCHEMA, message: 'title must be a non-empty string.' });
      }
      const extensionResponse = await this.enqueueExtensionCommand(method, { groupId, title });
      if (!extensionResponse.ok) {
        return rpcError(id, extensionResponse.error);
      }
      return rpcOk(id, extensionResponse.result || { groupId, title });
    }

    return rpcError(id, {
      code: ERROR_CODES.UNKNOWN_METHOD,
      message: `Unknown method: ${method}`
    });
  }

  async routeCdpCommand(id, method, params = {}) {
    const disconnected = this.ensureExtensionConnected(id);
    if (disconnected) {
      return disconnected;
    }
    if (!['operator.cdp.attach', 'operator.cdp.detach', 'operator.cdp.execute'].includes(method)) {
      return rpcError(id, {
        code: ERROR_CODES.UNKNOWN_METHOD,
        message: `Unknown method: ${method}`
      });
    }

    const tabId = normalizeTabId(params.tabId);
    if (!tabId.ok) {
      return rpcError(id, tabId.error);
    }
    const agent = normalizeAgentId(params.agentId);
    if (!agent.ok) {
      return rpcError(id, agent.error);
    }
    const agentId = agent.agentId;
    const tab = await this.refreshSessionTabForOperation(tabId.tabId);
    if (!tab) {
      return rpcError(id, {
        code: ERROR_CODES.INVALID_SCHEMA,
        message: 'CDP commands require a session-owned tab.',
        tabId: tabId.tabId
      });
    }
    const lease = this.assertTabLease(tab, agentId);
    if (!lease.ok) {
      return rpcError(id, lease.error);
    }

    const origin = originFromUrl(tab.url);
    if (method === 'operator.cdp.attach' || method === 'operator.cdp.detach') {
      if (!origin) {
        return rpcError(id, {
          code: ERROR_CODES.UNSUPPORTED_SCHEME,
          message: 'CDP sessions require a regular http:// or https:// session tab.',
          tabId: tabId.tabId
        });
      }
      const readiness = assertReadyForRealSiteAction(this.readinessStateForOrigin(origin));
      if (!readiness.ok) {
        return rpcError(id, readiness.error);
      }
      const extensionResponse = await this.enqueueExtensionCommand(method, {
        ...(agentId ? { agentId } : {}),
        tabId: tabId.tabId
      });
      if (!extensionResponse.ok) {
        return rpcError(id, extensionResponse.error);
      }
      return rpcOk(id, {
        tabId: tabId.tabId,
        origin,
        ...(extensionResponse.result || {})
      });
    }

    const cdpMethod = typeof params.method === 'string' ? params.method.trim() : '';
    if (!CDP_ALLOWED_METHODS.has(cdpMethod)) {
      return rpcError(id, {
        code: 'CDP_METHOD_NOT_ALLOWED',
        message: 'CDP method is not allowlisted for guarded operator use.',
        method: cdpMethod || null
      });
    }
    const cdpParams = validateCdpParamsForMethod(cdpMethod, params.params || {});
    if (!cdpParams.ok) {
      return rpcError(id, cdpParams.error);
    }

    if (!CDP_METADATA_METHODS.has(cdpMethod)) {
      if (!origin) {
        return rpcError(id, {
          code: ERROR_CODES.UNSUPPORTED_SCHEME,
          message: 'CDP commands require a regular http:// or https:// session tab.',
          tabId: tabId.tabId
        });
      }
      const readiness = assertReadyForRealSiteAction(this.readinessStateForOrigin(origin));
      if (!readiness.ok) {
        return rpcError(id, readiness.error);
      }
    }

    const extensionResponse = await this.enqueueExtensionCommand('operator.cdp.execute', {
      ...(agentId ? { agentId } : {}),
      tabId: tabId.tabId,
      method: cdpMethod,
      params: cdpParams.params
    });
    if (!extensionResponse.ok) {
      return rpcError(id, extensionResponse.error);
    }
    if (cdpMethod === 'Page.captureScreenshot') {
      const result = extensionResponse.result || {};
      const materialized = this.materializeVisualObservation({
        ...result,
        visual: {
          ...(result.visual || {}),
          provider: result.provider || 'chrome.debugger.Page.captureScreenshot',
          artifactBacked: false
        }
      }, origin, {
        reason: 'cdp.captureScreenshot'
      });
      if (!materialized.ok) {
        return rpcError(id, materialized.error);
      }
      return rpcOk(id, {
        tabId: tabId.tabId,
        origin: origin || null,
        method: cdpMethod,
        ...materialized.result
      });
    }
    return rpcOk(id, {
      tabId: tabId.tabId,
      origin: origin || null,
      method: cdpMethod,
      ...(extensionResponse.result || {})
    });
  }

  async routeBrowserContextCommand(id, method, params = {}) {
    const disconnected = this.ensureExtensionConnected(id);
    if (disconnected) {
      return disconnected;
    }

    if (method === 'operator.context.recentTabs') {
      const limit = boundedInteger(params.limit, 20, 1, 100);
      const extensionResponse = await this.enqueueExtensionCommand(method, { limit });
      if (!extensionResponse.ok) {
        return rpcError(id, extensionResponse.error);
      }
      const tabs = this.updateUserTabInventory(extensionResponse.result && extensionResponse.result.tabs);
      return rpcOk(id, { tabs: tabs.slice(0, limit) });
    }

    if (method === 'operator.context.historySearch' || method === 'operator.context.bookmarkSearch') {
      const search = validateContextSearchParams(params);
      if (!search.ok) {
        return rpcError(id, search.error);
      }
      const extensionResponse = await this.enqueueExtensionCommand(method, {
        query: search.query,
        maxResults: search.maxResults
      });
      if (!extensionResponse.ok) {
        return rpcError(id, extensionResponse.error);
      }
      const entries = Array.isArray(extensionResponse.result && extensionResponse.result.entries)
        ? extensionResponse.result.entries.map(normalizeContextEntry).filter(Boolean).slice(0, search.maxResults)
        : [];
      return rpcOk(id, { entries });
    }

    return rpcError(id, {
      code: ERROR_CODES.UNKNOWN_METHOD,
      message: `Unknown method: ${method}`
    });
  }

  async routeDownloadCommand(id, method, params = {}) {
    const disconnected = this.ensureExtensionConnected(id);
    if (disconnected) {
      return disconnected;
    }
    if (method === 'operator.downloads.show') {
      const downloadId = boundedInteger(params.downloadId, null, 0, 1000000000);
      if (downloadId === null) {
        return rpcError(id, { code: ERROR_CODES.INVALID_SCHEMA, message: 'downloadId must be a non-negative integer.' });
      }
      const extensionResponse = await this.enqueueExtensionCommand(method, { downloadId });
      if (!extensionResponse.ok) {
        return rpcError(id, extensionResponse.error);
      }
      return rpcOk(id, extensionResponse.result || { shown: true, downloadId });
    }

    if (method !== 'operator.downloads.wait') {
      return rpcError(id, {
        code: ERROR_CODES.UNKNOWN_METHOD,
        message: `Unknown method: ${method}`
      });
    }
    const waitParams = validateDownloadWaitParams(params);
    if (!waitParams.ok) {
      return rpcError(id, waitParams.error);
    }
    const { ok, ...commandParams } = waitParams;
    const extensionResponse = await this.enqueueExtensionCommand(method, commandParams);
    if (!extensionResponse.ok) {
      return rpcError(id, extensionResponse.error);
    }
    return rpcOk(id, {
      download: normalizeDownloadEntry(extensionResponse.result && extensionResponse.result.download)
    });
  }

  async routeSessionRecoveryCommand(id, method, params = {}) {
    const disconnected = this.ensureExtensionConnected(id);
    if (disconnected) {
      return disconnected;
    }
    if (method !== 'operator.sessions.reopenClosedTab') {
      return rpcError(id, {
        code: ERROR_CODES.UNKNOWN_METHOD,
        message: `Unknown method: ${method}`
      });
    }
    const sessionId = typeof params.sessionId === 'string' && params.sessionId.trim()
      ? params.sessionId.trim()
      : undefined;
    const claim = params.claim === true;
    const agent = normalizeAgentId(params.agentId);
    if (!agent.ok) {
      return rpcError(id, agent.error);
    }
    const agentId = agent.agentId;
    const extensionResponse = await this.enqueueExtensionCommand(method, {
      ...(agentId ? { agentId } : {}),
      ...(sessionId ? { sessionId } : {}),
      claim
    });
    if (!extensionResponse.ok) {
      return rpcError(id, extensionResponse.error);
    }
    const rawTab = extensionResponse.result && extensionResponse.result.tab;
    const tab = claim
      ? this.updateSessionTab(rawTab, 'user', { agentId })
      : normalizeUserTab(rawTab);
    if (claim && tab) {
      this.lastUserTabInventory.set(tab.id, tab);
    }
    return rpcOk(id, { tab });
  }

  async validateChatWatcherContext(id, watcher, agentId = watcher && watcher.agentId) {
    if (!watcher) {
      return rpcError(id, {
        code: ERROR_CODES.CHAT_WATCHER_UNAVAILABLE,
        message: 'Chat watcher is not active.',
        reason: 'WATCHER_NOT_FOUND'
      });
    }
    const tab = await this.refreshSessionTabForOperation(watcher.tabId);
    if (!tab) {
      return rpcError(id, {
        code: ERROR_CODES.CHAT_WATCHER_UNAVAILABLE,
        message: 'Chat watcher tab is no longer session-owned.',
        reason: 'TAB_NOT_SESSION_OWNED',
        tabId: watcher.tabId
      });
    }
    const lease = this.assertTabLease(tab, agentId);
    if (!lease.ok) {
      return rpcError(id, lease.error);
    }
    const currentOrigin = originFromUrl(tab.url);
    if (currentOrigin !== watcher.origin) {
      return rpcError(id, {
        code: ERROR_CODES.CHAT_WATCHER_UNAVAILABLE,
        message: 'Chat watcher origin changed; restart the watcher after re-observing the tab.',
        reason: 'ORIGIN_CHANGED',
        expectedOrigin: watcher.origin,
        actualOrigin: currentOrigin || null,
        tabId: watcher.tabId
      });
    }
    if (!this.chatWatcherAllowedOrigins.has(watcher.origin)) {
      return rpcError(id, {
        code: ERROR_CODES.CHAT_WATCHER_UNAVAILABLE,
        message: 'Chat watcher origin is not allowlisted.',
        reason: 'ORIGIN_NOT_ALLOWLISTED',
        origin: watcher.origin
      });
    }
    const readiness = assertReadyForRealSiteAction(this.readinessStateForOrigin(watcher.origin));
    if (!readiness.ok) {
      return rpcError(id, readiness.error);
    }
    return rpcOk(id, { tab });
  }

  recordChatWatcherEvent(event) {
    const cleanEvent = Object.fromEntries(Object.entries({
      id: `chat_evt_${Date.now()}_${this.chatWatcherEvents.length + 1}`,
      timestamp: new Date().toISOString(),
      ...event
    }).filter(([, value]) => value !== undefined));
    this.chatWatcherEvents.push(cleanEvent);
    if (this.chatWatcherEvents.length > CHAT_WATCHER_EVENT_LIMIT) {
      this.chatWatcherEvents.splice(0, this.chatWatcherEvents.length - CHAT_WATCHER_EVENT_LIMIT);
    }
    return { ...cleanEvent };
  }

  async routeChatWatcherCommand(id, method, params = {}) {
    if (method === 'operator.chatWatcher.status') {
      return rpcOk(id, this.chatWatcherStatus({ limit: params.limit }));
    }

    if (method === 'operator.chatWatcher.start') {
      const start = validateChatWatcherStartParams(params);
      if (!start.ok) {
        return rpcError(id, start.error);
      }
      if (!this.chatWatcherAllowedOrigins.has(start.origin)) {
        return rpcError(id, {
          code: ERROR_CODES.CHAT_WATCHER_UNAVAILABLE,
          message: 'Chat watcher origin is not allowlisted.',
          reason: 'ORIGIN_NOT_ALLOWLISTED',
          origin: start.origin
        });
      }
      const agent = normalizeAgentId(params.agentId);
      if (!agent.ok) {
        return rpcError(id, agent.error);
      }
      const tab = await this.refreshSessionTabForOperation(start.tabId);
      if (!tab) {
        return rpcError(id, {
          code: ERROR_CODES.CHAT_WATCHER_UNAVAILABLE,
          message: 'Chat watcher requires a session-owned tab.',
          reason: 'TAB_NOT_SESSION_OWNED',
          tabId: start.tabId
        });
      }
      const lease = this.assertTabLease(tab, agent.agentId);
      if (!lease.ok) {
        return rpcError(id, lease.error);
      }
      const tabOrigin = originFromUrl(tab.url);
      if (tabOrigin !== start.origin) {
        return rpcError(id, {
          code: ERROR_CODES.CHAT_WATCHER_UNAVAILABLE,
          message: 'Chat watcher origin must match the leased tab origin.',
          reason: 'ORIGIN_MISMATCH',
          expectedOrigin: start.origin,
          actualOrigin: tabOrigin || null,
          tabId: start.tabId
        });
      }
      const readiness = assertReadyForRealSiteAction(this.readinessStateForOrigin(start.origin));
      if (!readiness.ok) {
        return rpcError(id, readiness.error);
      }
      const watcherId = `chat_watch_${this.nextChatWatcherId++}_${stableHash({
        sessionId: this.sessionId,
        agentId: agent.agentId,
        tabId: start.tabId,
        origin: start.origin,
        unreadSelector: start.unreadSelector
      }).slice(0, 10)}`;
      const now = new Date().toISOString();
      const watcher = {
        watcherId,
        status: 'running',
        mode: 'observe-only',
        agentId: agent.agentId || null,
        tabId: start.tabId,
        origin: start.origin,
        label: start.label,
        unreadSelector: start.unreadSelector,
        intervalMs: start.intervalMs,
        screenshotOnUnread: start.screenshotOnUnread,
        paused: false,
        createdAt: now,
        updatedAt: now,
        lastPollAt: null,
        lastUnreadAt: null,
        lastUnreadSummary: null,
        lastUnreadDedupeKey: null,
        lastEventId: null,
        unreadEventCount: 0
      };
      this.chatWatchers.set(watcherId, watcher);
      return rpcOk(id, { origin: watcher.origin, watcher: { ...watcher } });
    }

    const watcherId = validateChatWatcherId(params);
    if (!watcherId.ok) {
      return rpcError(id, watcherId.error);
    }
    const watcher = this.chatWatchers.get(watcherId.watcherId);

    if (method === 'operator.chatWatcher.stop') {
      if (!watcher) {
        return rpcError(id, {
          code: ERROR_CODES.CHAT_WATCHER_UNAVAILABLE,
          message: 'Chat watcher is not active.',
          reason: 'WATCHER_NOT_FOUND'
        });
      }
      this.chatWatchers.delete(watcher.watcherId);
      return rpcOk(id, { origin: watcher.origin, stopped: true, watcher: { ...watcher, status: 'stopped', paused: true } });
    }

    const context = await this.validateChatWatcherContext(id, watcher);
    if (!context.ok) {
      return context;
    }

    if (method === 'operator.chatWatcher.pause' || method === 'operator.chatWatcher.resume') {
      watcher.paused = method === 'operator.chatWatcher.pause';
      watcher.status = watcher.paused ? 'paused' : 'running';
      watcher.updatedAt = new Date().toISOString();
      return rpcOk(id, { origin: watcher.origin, watcher: { ...watcher } });
    }

    if (method !== 'operator.chatWatcher.poll') {
      return rpcError(id, {
        code: ERROR_CODES.UNKNOWN_METHOD,
        message: `Unknown method: ${method}`
      });
    }

    if (watcher.paused) {
      return rpcOk(id, { origin: watcher.origin, watcher: { ...watcher }, event: null, skipped: 'paused' });
    }
    const locator = await this.routeRuntimeCommand(`${id}:unread`, 'operator.runtime.tab.locator', {
      ...(watcher.agentId ? { agentId: watcher.agentId } : {}),
      tabId: watcher.tabId,
      selector: watcher.unreadSelector,
      action: 'resolve',
      mode: 'tiny',
      maxActionableHandles: 5
    });
    watcher.lastPollAt = new Date().toISOString();
    watcher.updatedAt = watcher.lastPollAt;
    if (!locator.ok && locator.error && locator.error.code === 'LOCATOR_NOT_FOUND') {
      watcher.lastUnreadDedupeKey = null;
      watcher.lastUnreadSummary = null;
      return rpcOk(id, { origin: watcher.origin, watcher: { ...watcher }, event: null, unread: false });
    }
    if (!locator.ok) {
      return rpcError(id, locator.error);
    }

    const target = locator.result && locator.result.target;
    const targetSummary = target && target.label
      ? `${target.tag || target.role || 'element'}: ${target.label}`
      : null;
    const dedupeKey = stableHash({
      selector: watcher.unreadSelector,
      handle: target && target.handle ? target.handle : null,
      summary: targetSummary
    });
    watcher.lastUnreadAt = new Date().toISOString();
    watcher.lastUnreadSummary = targetSummary;
    if (watcher.lastUnreadDedupeKey === dedupeKey) {
      return rpcOk(id, {
        origin: watcher.origin,
        watcher: { ...watcher },
        event: null,
        unread: true,
        duplicate: true
      });
    }
    watcher.lastUnreadDedupeKey = dedupeKey;
    watcher.unreadEventCount += 1;
    let screenshot = null;
    if (watcher.screenshotOnUnread) {
      const screenshotResponse = await this.routeCdpCommand(`${id}:screenshot`, 'operator.cdp.execute', {
        ...(watcher.agentId ? { agentId: watcher.agentId } : {}),
        tabId: watcher.tabId,
        method: 'Page.captureScreenshot',
        params: { format: 'png' }
      });
      if (!screenshotResponse.ok) {
        return screenshotResponse;
      }
      screenshot = screenshotResponse.result || null;
    }
    const event = this.recordChatWatcherEvent({
      watcherId: watcher.watcherId,
      agentId: watcher.agentId,
      tabId: watcher.tabId,
      origin: watcher.origin,
      type: 'unread',
      selector: watcher.unreadSelector,
      targetSummary,
      screenshot: screenshot
        ? {
          artifactId: screenshot.screenshot && screenshot.screenshot.artifactId
            ? screenshot.screenshot.artifactId
            : null,
          mimeType: screenshot.screenshot && screenshot.screenshot.mimeType
            ? screenshot.screenshot.mimeType
            : null,
          width: screenshot.screenshot && screenshot.screenshot.width
            ? screenshot.screenshot.width
            : null,
          height: screenshot.screenshot && screenshot.screenshot.height
            ? screenshot.screenshot.height
            : null
        }
        : null
    });
    watcher.lastEventId = event.id;
    return rpcOk(id, {
      origin: watcher.origin,
      watcher: { ...watcher },
      event,
      unread: true,
      duplicate: false
    });
  }

  runtimeVisualPolicyError(observation, params = {}) {
    const allowSensitive = params.allowSensitive === true;
    if (
      !allowSensitive &&
      observation &&
      observation.visualPolicy &&
      observation.visualPolicy.explicitBlock === true
    ) {
      return {
        code: ERROR_CODES.VISUAL_PROVIDER_POLICY_BLOCKED,
        message: 'Screenshot capture is blocked because sensitive page content was detected.',
        reason: 'SENSITIVE_VISUAL_CONTENT',
        resumePolicy: 'manual-sensitive-review',
        freshObservationRequired: true
      };
    }
    const gates = observation && Array.isArray(observation.detectedGates)
      ? observation.detectedGates
      : [];
    if (gates.length > 0) {
      const gate = gates[0];
      return {
        code: ERROR_CODES.VISUAL_PROVIDER_POLICY_BLOCKED,
        message: 'Screenshot capture is blocked while an authentication or anti-abuse gate is visible.',
        gateType: gate.type || gate.code,
        resumePolicy: 'wait-and-reobserve',
        freshObservationRequired: true
      };
    }
    if (!allowSensitive && isSensitiveVisualObservation(observation)) {
      return {
        code: ERROR_CODES.VISUAL_PROVIDER_POLICY_BLOCKED,
        message: 'Screenshot capture is blocked because sensitive page content was detected.',
        reason: 'SENSITIVE_VISUAL_CONTENT',
        resumePolicy: 'manual-sensitive-review',
        freshObservationRequired: true
      };
    }
    return null;
  }

  async routeRuntimeVisualCommand(id, method, { agentId, tabId, origin, params = {} }) {
    const observeResponse = await this.enqueueExtensionCommand('operator.runtime.tab.observe', {
      ...(agentId ? { agentId } : {}),
      tabId,
      ...pickRuntimeVisualObserveParams(params)
    });
    if (!observeResponse.ok) {
      return rpcError(id, this.attachApprovalRequest(method, { ...params, tabId, origin }, observeResponse.error));
    }
    const observation = observeResponse.result || {};
    const policyError = this.runtimeVisualPolicyError(observation, params);
    if (policyError) {
      return rpcError(id, policyError);
    }

    let visualTarget = null;
    if (method === 'operator.runtime.tab.visualInspectTarget') {
      const handle = typeof params.handle === 'string' ? params.handle.trim() : '';
      if (!handle) {
        return rpcError(id, {
          code: ERROR_CODES.INVALID_SCHEMA,
          message: 'visualInspectTarget requires handle.'
        });
      }
      visualTarget = (Array.isArray(observation.elements) ? observation.elements : [])
        .find((element) => element && element.handle === handle);
      if (!visualTarget) {
        return rpcError(id, {
          code: 'TARGET_NOT_FOUND',
          message: 'Target handle was not found in the current visual observation.',
          handle
        });
      }
    }

    const cdpResponse = await this.enqueueExtensionCommand('operator.cdp.execute', {
      ...(agentId ? { agentId } : {}),
      tabId,
      method: 'Page.captureScreenshot',
      params: {}
    });
    if (!cdpResponse.ok) {
      return rpcError(id, cdpResponse.error);
    }
    const cdpResult = cdpResponse.result || {};
    const materialized = this.materializeVisualObservation({
      ...observation,
      visual: {
        ...(observation.visual || {}),
        provider: cdpResult.provider || 'chrome.debugger.Page.captureScreenshot',
        screenshotBacked: true
      },
      screenshot: cdpResult.screenshot
    }, origin, {
      policy: {
        ...(params.maxBytes === undefined ? {} : { maxBytes: params.maxBytes }),
        ...(params.allowSensitive === undefined ? {} : { allowSensitive: params.allowSensitive })
      },
      allowSensitive: params.allowSensitive,
      reason: params.reason || (
        method === 'operator.runtime.tab.visualInspectTarget'
          ? 'tab.visualInspectTarget'
          : method === 'operator.runtime.tab.visualAnalyze'
            ? 'tab.visualAnalyze'
            : 'tab.visualObserve'
      )
    });
    if (!materialized.ok) {
      return rpcError(id, materialized.error);
    }

    const baseResult = {
      tabId,
      origin,
      ...materialized.result
    };

    if (method === 'operator.runtime.tab.visualInspectTarget') {
      return rpcOk(id, this.materializeVisualTargetRegion({
        ...baseResult,
        visual: {
          ...(baseResult.visual || {}),
          targetRegionBacked: true
        },
        visualTarget: {
          handle: params.handle,
          label: visualTarget.label || null,
          tag: visualTarget.tag || null,
          bbox: visualTarget.bbox || null
        }
      }));
    }

    if (method === 'operator.runtime.tab.visualAnalyze') {
      const analysis = analyzeVisualObservation({
        provider: params.provider,
        observation: baseResult,
        screenshot: baseResult.screenshot,
        policy: {
          ...(params.maxBytes === undefined ? {} : { maxBytes: params.maxBytes }),
          ...(params.allowSensitive === undefined ? {} : { allowSensitive: params.allowSensitive })
        }
      }, this.visualAnalyzerRegistry);
      if (!analysis.ok) {
        return rpcError(id, analysis.error);
      }
      return rpcOk(id, {
        ...baseResult,
        visual: {
          ...(baseResult.visual || {}),
          analysis
        }
      });
    }

    return rpcOk(id, baseResult);
  }

  async routeRuntimeCommand(id, method, params = {}) {
    const disconnected = this.ensureExtensionConnected(id);
    if (disconnected) {
      return disconnected;
    }
    if (![
      'operator.runtime.tab.goto',
      'operator.runtime.tab.observe',
      'operator.runtime.tab.readPage',
      'operator.runtime.tab.visualObserve',
      'operator.runtime.tab.visualAnalyze',
      'operator.runtime.tab.visualInspectTarget',
      'operator.runtime.tab.uploadFile',
      'operator.runtime.tab.locator',
      'operator.runtime.tab.batch',
      'operator.runtime.tab.showTarget',
      'operator.runtime.tab.indicator'
    ].includes(method)) {
      return rpcError(id, {
        code: ERROR_CODES.UNKNOWN_METHOD,
        message: `Unknown method: ${method}`
      });
    }

    const tabId = normalizeTabId(params.tabId);
    if (!tabId.ok) {
      return rpcError(id, tabId.error);
    }
    const agent = normalizeAgentId(params.agentId);
    if (!agent.ok) {
      return rpcError(id, agent.error);
    }
    const agentId = agent.agentId;
    const tab = await this.refreshSessionTabForOperation(tabId.tabId);
    if (!tab) {
      return rpcError(id, {
        code: ERROR_CODES.INVALID_SCHEMA,
        message: 'Runtime tab commands require a session-owned tab.',
        tabId: tabId.tabId
      });
    }
    const lease = this.assertTabLease(tab, agentId);
    if (!lease.ok) {
      return rpcError(id, lease.error);
    }
    if (method !== 'operator.runtime.tab.goto') {
      const pendingNavigation = pendingNavigationErrorForTab(tab);
      if (pendingNavigation) {
        return rpcError(id, pendingNavigation);
      }
    }

    let origin = originFromUrl(tab.url);
    let commandParams = { ...params, tabId: tabId.tabId };
    let policyMethod = 'page.observe';
    let runtimeBatch = null;
    let runtimeUpload = null;

    if (method === 'operator.runtime.tab.goto') {
      const target = navigationTarget(params.url);
      if (!target.ok) {
        return rpcError(id, target.error);
      }
      origin = target.origin;
      commandParams = { tabId: tabId.tabId, url: target.url };
      if (agentId) {
        commandParams.agentId = agentId;
      }
      policyMethod = 'page.navigate';
    } else {
      if (!origin) {
        return rpcError(id, {
          code: ERROR_CODES.UNSUPPORTED_SCHEME,
          message: 'Runtime tab commands require a regular http:// or https:// session tab.',
          tabId: tabId.tabId
        });
      }
      if (method === 'operator.runtime.tab.uploadFile') {
        const upload = this.validateUploadCommandParams(params, origin);
        if (!upload.ok) {
          return rpcError(id, upload.error);
        }
        runtimeUpload = upload;
        commandParams = {
          ...(agentId ? { agentId } : {}),
          tabId: tabId.tabId,
          origin,
          target: upload.target,
          ruleset: upload.ruleset,
          verifyPreview: upload.verifyPreview,
          files: upload.files,
          filePaths: upload.filePaths
        };
        policyMethod = 'page.uploadFile';
      } else if (method === 'operator.runtime.tab.locator') {
        const locator = validateRuntimeLocatorParams(params);
        if (!locator.ok) {
          return rpcError(id, locator.error);
        }
        const runtimeOptions = pickRuntimeObservationParams(params);
        if (locator.action === 'resolve') {
          delete runtimeOptions.targetContract;
        }
        commandParams = {
          ...(agentId ? { agentId } : {}),
          tabId: tabId.tabId,
          action: locator.action,
          ...(locator.handle === undefined ? {} : { handle: locator.handle }),
          ...(locator.selector === undefined ? {} : { selector: locator.selector }),
          ...(locator.text === undefined ? {} : { text: locator.text }),
          ...(locator.textValue === undefined ? {} : { textValue: locator.textValue }),
          ...(locator.value === undefined ? {} : { value: locator.value }),
          ...(locator.checked === undefined ? {} : { checked: locator.checked }),
          ...(locator.deltaX === undefined ? {} : { deltaX: locator.deltaX }),
          ...(locator.deltaY === undefined ? {} : { deltaY: locator.deltaY }),
          ...(locator.key === undefined ? {} : { key: locator.key }),
          ...runtimeOptions
        };
        policyMethod = RUNTIME_LOCATOR_MUTATION_METHODS[locator.action] || 'page.observe';
      } else if (method === 'operator.runtime.tab.batch') {
        const batch = this.validateBatchCommandParams(params, origin);
        if (!batch.ok) {
          return rpcError(id, batch.error);
        }
        runtimeBatch = batch;
        commandParams = {
          ...(agentId ? { agentId } : {}),
          tabId: tabId.tabId,
          ...batch.commandParams
        };
        policyMethod = 'page.batch';
      } else if (method === 'operator.runtime.tab.showTarget') {
        const cue = validateTargetCueParams(params);
        if (!cue.ok) {
          return rpcError(id, cue.error);
        }
        commandParams = {
          ...(agentId ? { agentId } : {}),
          tabId: tabId.tabId,
          ...pickDefinedLocal(cue, ['handle', 'selector', 'text', 'durationMs'])
        };
        policyMethod = 'page.observe';
      } else if (method === 'operator.runtime.tab.indicator') {
        commandParams = {
          ...(agentId ? { agentId } : {}),
          tabId: tabId.tabId,
          active: params.active !== false,
          ...(typeof params.label === 'string' && params.label.trim()
            ? { label: params.label.trim().slice(0, 120) }
            : {}),
          ...(typeof params.stopReason === 'string' && params.stopReason.trim()
            ? { stopReason: params.stopReason.trim().slice(0, 160) }
            : {})
        };
        policyMethod = 'page.observe';
      } else if (method === 'operator.runtime.tab.readPage') {
        policyMethod = 'page.readPage';
        commandParams = {
          ...(agentId ? { agentId } : {}),
          tabId: tabId.tabId,
          ...pickRuntimeReadPageParams(params)
        };
      } else if (
        method === 'operator.runtime.tab.visualObserve' ||
        method === 'operator.runtime.tab.visualAnalyze' ||
        method === 'operator.runtime.tab.visualInspectTarget'
      ) {
        policyMethod = method === 'operator.runtime.tab.visualAnalyze'
          ? 'page.visualAnalyze'
          : method === 'operator.runtime.tab.visualInspectTarget'
            ? 'page.visualInspectTarget'
            : 'page.visualObserve';
        commandParams = {
          ...(agentId ? { agentId } : {}),
          tabId: tabId.tabId,
          ...pickRuntimeVisualObserveParams(params),
          ...pickDefinedLocal(params, ['handle', 'provider', 'maxBytes', 'allowSensitive', 'reason'])
        };
      } else {
        commandParams = {
          ...(agentId ? { agentId } : {}),
          tabId: tabId.tabId,
          ...pickRuntimeObservationParams(params)
        };
      }
    }

    const readiness = assertReadyForRealSiteAction(this.readinessStateForOrigin(origin));
    if (!readiness.ok) {
      return rpcError(id, readiness.error);
    }
    const boundedFullAuto = runtimeBatch
      ? this.enforceBoundedFullAutoBatch(runtimeBatch.childActions, origin)
      : this.enforceBoundedFullAuto(policyMethod, origin);
    if (!boundedFullAuto.ok) {
      return rpcError(id, boundedFullAuto.error);
    }

    if (
      method === 'operator.runtime.tab.visualObserve' ||
      method === 'operator.runtime.tab.visualAnalyze' ||
      method === 'operator.runtime.tab.visualInspectTarget'
    ) {
      return this.routeRuntimeVisualCommand(id, method, {
        agentId,
        tabId: tabId.tabId,
        origin,
        params: commandParams
      });
    }

    const runtimeWarmContext = {
      agentId,
      tabId: tabId.tabId,
      url: tab.url,
      origin
    };
    if (method === 'operator.runtime.tab.observe' || method === 'operator.runtime.tab.readPage') {
      const warmCache = this.warmCacheHit(policyMethod, commandParams, origin, runtimeWarmContext);
      if (warmCache) {
        if (!warmCache.ok) {
          return rpcError(id, warmCache.error);
        }
        return rpcOk(id, {
          tabId: tabId.tabId,
          origin,
          ...warmCache.result
        });
      }
    }

    const requiresPolicy = runtimeBatch ||
      runtimeUpload ||
      RUNTIME_LOCATOR_MUTATION_METHODS[commandParams.action];
    const extensionResponse = requiresPolicy
      ? await this.enqueueExtensionCommandWithPolicy(method, commandParams)
      : await this.enqueueExtensionCommand(method, commandParams);
    if (!extensionResponse.ok) {
      const approvalParams = runtimeUpload
        ? Object.fromEntries(Object.entries(commandParams).filter(([key]) => key !== 'filePaths'))
        : commandParams;
      return rpcError(id, this.attachApprovalRequest(method, { ...approvalParams, origin }, extensionResponse.error));
    }
    if (runtimeBatch) {
      const childFailureIndex = Array.isArray(extensionResponse.result && extensionResponse.result.results)
        ? extensionResponse.result.results.findIndex((entry) => !entry || entry.ok === false)
        : -1;
      if (childFailureIndex !== -1) {
        const childFailure = extensionResponse.result.results[childFailureIndex] || {};
        const childError = {
          ...(childFailure.error || {
            code: ERROR_CODES.INVALID_SCHEMA,
            message: 'Batch child action failed without a structured error.'
          }),
          childActionIndex: childFailureIndex,
          childAction: runtimeBatch.childActions[childFailureIndex]
            ? runtimeBatch.childActions[childFailureIndex].action
            : null
        };
        return rpcError(id, this.attachApprovalRequest(method, commandParams, childError));
      }
    }
    if (method === 'operator.runtime.tab.goto') {
      this.clearWarmSessionCache('page.navigate', {
        agentId,
        tabId: tabId.tabId,
        url: tab.url,
        origin: originFromUrl(tab.url)
      });
      const rawUpdatedTab = extensionResponse.result && extensionResponse.result.tab;
      const updatedTab = this.updateSessionTab(
        rawUpdatedTab && extensionResponse.result && extensionResponse.result.requestedUrl
          ? { ...rawUpdatedTab, requestedUrl: extensionResponse.result.requestedUrl }
          : rawUpdatedTab,
        tab.ownership
      );
      return rpcOk(id, {
        ...(extensionResponse.result || {}),
        tab: updatedTab || (extensionResponse.result && extensionResponse.result.tab) || null,
        origin
      });
    }
    if (method === 'operator.runtime.tab.observe' || method === 'operator.runtime.tab.readPage') {
      this.storeRuntimeWarmSessionCache(policyMethod, commandParams, origin, tab, extensionResponse.result || {});
    }
    if (runtimeBatch
      ? shouldInvalidateWarmSession('page.batch', runtimeBatch.childActions)
      : shouldInvalidateWarmSession(policyMethod)) {
      this.clearWarmSessionCache(policyMethod, runtimeWarmContext);
    }
    return rpcOk(id, {
      tabId: tabId.tabId,
      origin,
      ...(extensionResponse.result || {}),
      ...(runtimeUpload ? { assetValidation: runtimeUpload.assetValidation } : {})
    });
  }


  handleHello(id, hello, params = {}) {
    const bridgeInstanceId = typeof params.bridgeInstanceId === 'string' && params.bridgeInstanceId.trim()
      ? params.bridgeInstanceId.trim()
      : null;
    if (
      this.bridgeInstanceId &&
      bridgeInstanceId &&
      bridgeInstanceId !== this.bridgeInstanceId &&
      this.connectionState === 'EXTENSION_CONNECTED'
    ) {
      return rpcError(id, {
        code: ERROR_CODES.EXTENSION_DISCONNECTED,
        message: 'A different native bridge instance already owns this operator session.',
        foreignBridgeIgnored: true,
        currentBridgeInstanceId: this.bridgeInstanceId,
        rejectedBridgeInstanceId: bridgeInstanceId
      });
    }
    const result = validateHello(hello, {
      expectedExtensionId: this.config.expectedExtensionId,
      expectedProtocolVersion: this.config.expectedProtocolVersion,
      expectedExtensionVersion: this.config.expectedExtensionVersion,
      expectedBridgeVersion: this.config.expectedBridgeVersion
    });

    if (!result.ok) {
      this.connectionState = 'DAEMON_RUNNING_EXTENSION_DISCONNECTED';
      this.profileVerified = false;
      this.profileIdentityVerified = false;
      this.profileBindingStatus = 'rejected';
      this.lastVersionMismatch = [
        ERROR_CODES.PROTOCOL_VERSION_MISMATCH,
        ERROR_CODES.EXTENSION_VERSION_MISMATCH,
        ERROR_CODES.BRIDGE_VERSION_MISMATCH
      ].includes(result.error.code)
        ? result.error
        : this.lastVersionMismatch;
      return rpcError(id, result.error);
    }

    this.lastVersionMismatch = null;
    this.profileBindingStatus = result.profileBindingStatus;
    this.profileVerificationMode = result.profileVerificationMode || 'not-required';
    this.profileIdentityVerified = result.profileIdentityVerified === true;
    this.profileVerified = true;
    this.loadedExtension = {
      extensionId: hello.extensionId,
      extensionVersion: hello.extensionVersion,
      bridgeVersion: hello.bridgeVersion,
      loadedExtensionHash: typeof hello.loadedExtensionHash === 'string' && hello.loadedExtensionHash.trim()
        ? hello.loadedExtensionHash.trim()
        : null,
      loadedAt: new Date().toISOString()
    };
    this.bridgeInstanceId = bridgeInstanceId;
    const previousState = this.connectionState;
    this.connectionId = makeConnectionId();
    if (previousState === 'RECONNECTING') {
      this.reconnectCount += 1;
    }
    this.connectionState = 'EXTENSION_CONNECTED';
    this.updateActiveTab(params.activeTab || null);

    return rpcOk(id, {
      connectionState: this.connectionState,
      connectionId: this.connectionId,
      bridgeInstanceId: this.bridgeInstanceId,
      profileReady: this.profileVerified,
      profileIdentityVerified: this.profileIdentityVerified,
      profileVerificationMode: this.profileVerificationMode,
      profileBindingStatus: this.profileBindingStatus
    });
  }

  activeTabUpdated(id, params = {}) {
    const bridgeCheck = this.checkBridgeInstance(params);
    if (!bridgeCheck.ok) {
      return rpcOk(id, {
        ignored: true,
        reason: 'bridgeInstanceMismatch',
        activeTab: this.activeTab ? { ...this.activeTab } : null
      });
    }
    this.updateActiveTab(params.activeTab || params.tab || null);
    return rpcOk(id, {
      activeTab: this.activeTab ? { ...this.activeTab } : null
    });
  }

  activeTabWarmup(id, params = {}) {
    const bridgeCheck = this.checkBridgeInstance(params);
    if (!bridgeCheck.ok) {
      return rpcOk(id, {
        ignored: true,
        reason: 'bridgeInstanceMismatch',
        warmSession: this.warmSessionStatus()
      });
    }

    const activeTab = this.updateActiveTab(params.activeTab || params.tab || null);
    const warmup = params.warmup;
    if (!isPlainObject(warmup)) {
      return rpcError(id, {
        code: ERROR_CODES.INVALID_SCHEMA,
        message: 'extension.activeTabWarmup requires a warmup object.'
      });
    }

    if (warmup.ok !== true) {
      this.clearWarmSessionCache('warmup-failed', this.warmCacheContextForTab(activeTab));
      return rpcOk(id, {
        warmSession: this.warmSessionStatus()
      });
    }

    const observation = this.normalizedWarmResult(warmup.observation);
    const readPage = this.normalizedWarmResult(warmup.readPage);
    const origin = (observation && observation.origin) ||
      (readPage && readPage.origin) ||
      (activeTab && activeTab.origin);
    if (!origin || !activeTab || activeTab.origin !== origin) {
      this.clearWarmSessionCache('warmup-origin-mismatch', this.warmCacheContextForTab(activeTab));
      return rpcError(id, {
        code: ERROR_CODES.INVALID_SCHEMA,
        message: 'Warm session origin must match the active tab origin.'
      });
    }
    const readiness = assertReadyForRealSiteAction(this.readinessStateForOrigin(origin));
    if (!readiness.ok) {
      this.clearWarmSessionCache('warmup-domain-not-approved', this.warmCacheContextForTab(activeTab));
      return rpcError(id, readiness.error);
    }

    const updatedAtMs = Date.now();
    const cache = this.setWarmSessionCache({
      origin,
      url: activeTab.url,
      tabId: activeTab.id,
      agentId: params.agentId,
      title: activeTab.title || (observation && observation.title) || (readPage && readPage.title) || null,
      source: typeof warmup.source === 'string' && warmup.source.trim()
        ? warmup.source.trim()
        : 'extension',
      updatedAt: new Date(updatedAtMs).toISOString(),
      expiresAt: new Date(updatedAtMs + WARM_SESSION_CACHE_TTL_MS).toISOString(),
      observation: observation ? cloneJson(observation) : null,
      readPage: readPage ? cloneJson(readPage) : null,
      readPageFilter: typeof warmup.readPageFilter === 'string' ? warmup.readPageFilter : 'interactive',
      metadata: this.warmResultMetadata(observation, readPage)
    });
    const warmMetadata = cache.metadata || {};
    if (warmMetadata.pageStateId) {
      this.invalidateApprovals('page-state-changed', (record) => (
        APPROVAL_INVALIDATABLE_STATUSES.has(record.status) &&
        record.origin === origin &&
        record.pageStateId &&
        record.pageStateId !== warmMetadata.pageStateId &&
        (!Number.isInteger(record.tabId) || record.tabId === activeTab.id) &&
        (!record.url || record.url === activeTab.url)
      ), {
        origin,
        tabId: activeTab.id,
        pageStateId: warmMetadata.pageStateId
      });
    }

    return rpcOk(id, {
      warmSession: this.warmSessionStatus()
    });
  }

  checkBridgeInstance(params = {}) {
    const bridgeInstanceId = typeof params.bridgeInstanceId === 'string' && params.bridgeInstanceId.trim()
      ? params.bridgeInstanceId.trim()
      : null;
    if (!this.bridgeInstanceId || bridgeInstanceId === this.bridgeInstanceId) {
      return guardOk({ bridgeInstanceId });
    }
    return guardError(ERROR_CODES.EXTENSION_DISCONNECTED, 'Stale native bridge instance cannot control this session.', {
      currentBridgeInstanceId: this.bridgeInstanceId,
      bridgeInstanceId
    });
  }

  updateActiveTab(tab) {
    const normalized = normalizeActiveTab(tab);
    if (normalized) {
      const previous = this.activeTab;
      this.activeTab = normalized;
      if (
        previous &&
        Number.isInteger(previous.id) &&
        previous.id === normalized.id &&
        previous.url &&
        normalized.url &&
        previous.url !== normalized.url
      ) {
        this.clearWarmSessionCache('active-tab-changed', this.warmCacheContextForTab(previous));
      }
      if (
        previous &&
        Number.isInteger(previous.id) &&
        previous.id === normalized.id &&
        previous.url &&
        normalized.url &&
        previous.url !== normalized.url
      ) {
        this.invalidateApprovalsForTab(normalized.id, 'active-tab-navigated', {
          previousUrl: previous.url,
          currentUrl: normalized.url
        });
      }
    }
    return this.activeTab;
  }

  knownSameOriginTabs(origin) {
    const tabsById = new Map();
    const addTab = (tab, source) => {
      if (!tab || !Number.isInteger(tab.id) || tabOrigin(tab) !== origin) {
        return;
      }
      const previous = tabsById.get(tab.id);
      if (previous) {
        previous.sources = Array.from(new Set([...previous.sources, source])).sort();
      } else {
        tabsById.set(tab.id, {
          ...tabIdentitySummary(tab, source),
          sources: [source]
        });
      }
    };

    addTab(this.activeTab, 'active');
    for (const tab of this.sessionTabs.values()) {
      addTab(tab, 'session');
    }
    for (const tab of this.lastUserTabInventory.values()) {
      addTab(tab, 'user');
    }
    return [...tabsById.values()].sort((left, right) => left.id - right.id);
  }

  guardActiveTabTarget(method, origin, batch, expectedActiveTabId = null) {
    if (!origin || !requiresActiveTabTargetGuard(method, batch)) {
      return guardOk();
    }

    const activeTab = this.activeTab;
    const hasExpectedActiveTab = Number.isInteger(expectedActiveTabId);
    if (!activeTab || !Number.isInteger(activeTab.id) || tabOrigin(activeTab) !== origin) {
      if (hasExpectedActiveTab) {
        return guardError(
          ERROR_CODES.TAB_MISMATCH,
          'Active-tab diagnostic target is no longer active on the requested origin.',
          {
            origin,
            expectedActiveTabId,
            activeTabId: activeTab && Number.isInteger(activeTab.id) ? activeTab.id : null,
            activeTabOrigin: activeTab ? tabOrigin(activeTab) : null
          }
        );
      }
      return guardOk();
    }
    if (hasExpectedActiveTab && activeTab.id !== expectedActiveTabId) {
      return guardError(
        ERROR_CODES.TAB_MISMATCH,
        'Active-tab diagnostic expected a different active tab. Re-observe the active tab before retrying.',
        {
          origin,
          expectedActiveTabId,
          activeTabId: activeTab.id
        }
      );
    }

    const sameOriginTabs = this.knownSameOriginTabs(origin);
    const claimedTabs = sameOriginTabs.filter((tab) => tab.sources.includes('session'));
    const singleClaimedTab = claimedTabs.length === 1 ? claimedTabs[0] : null;
    if (singleClaimedTab && singleClaimedTab.id !== activeTab.id) {
      return guardError(
        ERROR_CODES.TAB_MISMATCH,
        'Active-tab command target does not match the claimed same-origin session tab. Use a tab-scoped tool for this action.',
        {
          origin,
          expectedTabId: singleClaimedTab.id,
          activeTabId: activeTab.id,
          sameOriginTabs
        }
      );
    }
    if (sameOriginTabs.length > 1) {
      return guardError(
        ERROR_CODES.TAB_MISMATCH,
        'Active-tab command is ambiguous because multiple same-origin tabs are known. Use a tab-scoped tool for this action.',
        {
          origin,
          expectedTabId: singleClaimedTab ? singleClaimedTab.id : null,
          activeTabId: activeTab.id,
          sameOriginTabs
        }
      );
    }

    return guardOk({ expectedActiveTabId: activeTab.id });
  }

  normalizedWarmResult(value) {
    if (!isPlainObject(value)) {
      return null;
    }
    if (value.ok === true && isPlainObject(value.result)) {
      return value.result;
    }
    if (value.ok === false) {
      return null;
    }
    return value;
  }

  warmResultMetadata(observation, readPage) {
    const source = observation || readPage || {};
    const volatility = source.volatility && typeof source.volatility === 'object'
      ? source.volatility
      : {};
    return {
      pageStateId: source.pageStateId || null,
      documentId: volatility.documentId || null,
      mutationCounter: Number.isFinite(Number(volatility.mutationCounter))
        ? Number(volatility.mutationCounter)
        : null,
      scrollX: Number.isFinite(Number(volatility.scrollX)) ? Number(volatility.scrollX) : null,
      scrollY: Number.isFinite(Number(volatility.scrollY)) ? Number(volatility.scrollY) : null,
      viewport: volatility.viewport || null,
      visibilityState: volatility.visibilityState || null,
      confidence: Number.isFinite(Number(volatility.confidence)) ? Number(volatility.confidence) : 0.5
    };
  }

  normalizeWarmAgentId(agentId) {
    return typeof agentId === 'string' && agentId.trim() ? agentId.trim() : null;
  }

  warmCacheContextForTab(tab, extra = {}) {
    return {
      ...extra,
      tabId: tab && Number.isInteger(tab.id) ? tab.id : extra.tabId,
      url: tab && typeof tab.url === 'string' ? tab.url : extra.url,
      origin: (tab && tabOrigin(tab)) || extra.origin
    };
  }

  warmCacheKey({ agentId, tabId, url, pageStateId } = {}) {
    return [
      this.sessionId,
      this.normalizeWarmAgentId(agentId) || '',
      Number.isInteger(tabId) ? String(tabId) : '',
      url || '',
      pageStateId || ''
    ].join('\x1f');
  }

  warmCacheExpired(cache) {
    const expiresAt = Date.parse(cache && cache.expiresAt);
    return Number.isFinite(expiresAt) && Date.now() > expiresAt;
  }

  warmCacheIsActive(cache) {
    return Boolean(cache && !this.warmCacheExpired(cache) && (cache.observation || cache.readPage));
  }

  warmCacheMatchesContext(cache, context = {}) {
    if (!cache) {
      return false;
    }
    const agentId = this.normalizeWarmAgentId(context.agentId);
    if (cache.sessionId !== this.sessionId) {
      return false;
    }
    if (Object.hasOwn(context, 'agentId') && (cache.agentId || null) !== agentId) {
      return false;
    }
    if (Number.isInteger(context.tabId) && cache.tabId !== context.tabId) {
      return false;
    }
    if (context.url && cache.url !== context.url) {
      return false;
    }
    if (context.origin && cache.origin !== context.origin) {
      return false;
    }
    const cachePageStateId = cache.metadata && cache.metadata.pageStateId;
    if (context.pageStateId && cachePageStateId !== context.pageStateId) {
      return false;
    }
    return true;
  }

  findWarmSessionCache(context = {}, options = {}) {
    const activeOnly = options.activeOnly !== false;
    const candidates = [...this.warmSessionCaches.values()]
      .filter((cache) => this.warmCacheMatchesContext(cache, context))
      .filter((cache) => !activeOnly || this.warmCacheIsActive(cache))
      .sort((left, right) => Date.parse(right.updatedAt || right.inactiveAt || 0) - Date.parse(left.updatedAt || left.inactiveAt || 0));
    return candidates[0] || null;
  }

  setWarmSessionCache(entry = {}) {
    const metadata = entry.metadata || this.warmResultMetadata(entry.observation, entry.readPage);
    const agentId = this.normalizeWarmAgentId(entry.agentId);
    const tabId = Number.isInteger(entry.tabId) ? entry.tabId : null;
    const key = this.warmCacheKey({
      agentId,
      tabId,
      url: entry.url || null,
      pageStateId: metadata && metadata.pageStateId
    });
    const previous = this.warmSessionCaches.get(key) || {};
    const cache = {
      ...previous,
      sessionId: this.sessionId,
      agentId,
      origin: entry.origin || previous.origin || null,
      url: entry.url || previous.url || null,
      tabId,
      title: entry.title || previous.title || null,
      source: entry.source || previous.source || 'extension',
      updatedAt: entry.updatedAt || new Date().toISOString(),
      expiresAt: entry.expiresAt || new Date(Date.now() + WARM_SESSION_CACHE_TTL_MS).toISOString(),
      metadata,
      readPageFilter: entry.readPageFilter || previous.readPageFilter || 'interactive',
      observation: entry.observation !== undefined ? cloneJson(entry.observation) : (previous.observation || null),
      readPage: entry.readPage !== undefined ? cloneJson(entry.readPage) : (previous.readPage || null),
      inactiveAt: null,
      inactiveReason: null
    };
    this.warmSessionCaches.set(key, cache);
    this.lastWarmSessionInactive = null;
    return cache;
  }

  clearWarmSessionCache(reason = 'cleared', context = {}) {
    const fallbackContext = !context || Object.keys(context).length === 0
      ? this.warmCacheContextForTab(this.activeTab)
      : context;
    const inactiveAt = new Date().toISOString();
    let cleared = 0;

    for (const [key, cache] of this.warmSessionCaches.entries()) {
      if (fallbackContext.all === true || this.warmCacheMatchesContext(cache, fallbackContext)) {
        this.warmSessionCaches.set(key, {
          ...cache,
          inactiveAt,
          inactiveReason: reason,
          observation: null,
          readPage: null
        });
        cleared += 1;
      }
    }

    this.lastWarmSessionInactive = {
      active: false,
      reason,
      origin: fallbackContext.origin || null,
      url: fallbackContext.url || null,
      tabId: fallbackContext.tabId ?? null,
      source: null,
      updatedAt: null,
      expiresAt: null,
      metadata: null,
      inactiveAt,
      hasObservation: false,
      hasReadPage: false,
      cleared
    };
  }

  warmSessionStatus(context = {}) {
    const statusContext = Object.keys(context || {}).length > 0
      ? context
      : this.warmCacheContextForTab(this.activeTab);
    const anyCache = this.findWarmSessionCache(statusContext, { activeOnly: false });
    if (!anyCache) {
      return this.lastWarmSessionInactive
        ? { ...this.lastWarmSessionInactive }
        : {
          active: false,
          reason: null
        };
    }

    if (this.warmCacheExpired(anyCache)) {
      return {
        active: false,
        reason: 'expired',
        origin: anyCache.origin || null,
        url: anyCache.url || null,
        tabId: anyCache.tabId ?? null,
        title: anyCache.title || null,
        source: anyCache.source || null,
        updatedAt: anyCache.updatedAt || null,
        expiresAt: anyCache.expiresAt || null,
        metadata: anyCache.metadata || null,
        hasObservation: false,
        hasReadPage: false
      };
    }

    if (!anyCache.observation && !anyCache.readPage) {
      return {
        active: false,
        reason: anyCache.inactiveReason || 'cleared',
        origin: anyCache.origin || null,
        url: anyCache.url || null,
        tabId: anyCache.tabId ?? null,
        title: anyCache.title || null,
        source: anyCache.source || null,
        updatedAt: anyCache.updatedAt || null,
        expiresAt: anyCache.expiresAt || null,
        metadata: anyCache.metadata || null,
        inactiveAt: anyCache.inactiveAt || null,
        hasObservation: false,
        hasReadPage: false
      };
    }

    const cache = anyCache;

    return {
      active: true,
      reason: null,
      origin: cache.origin || null,
      url: cache.url || null,
      tabId: cache.tabId ?? null,
      title: cache.title || null,
      source: cache.source || null,
      updatedAt: cache.updatedAt || null,
      expiresAt: cache.expiresAt || null,
      metadata: cache.metadata || null,
      hasObservation: Boolean(cache.observation),
      hasReadPage: Boolean(cache.readPage)
    };
  }

  warmCacheMetadata(cache) {
    return {
      hit: true,
      sessionId: cache && cache.sessionId ? cache.sessionId : this.sessionId,
      agentId: cache && cache.agentId ? cache.agentId : null,
      tabId: cache && cache.tabId !== undefined ? cache.tabId : null,
      url: cache && cache.url ? cache.url : null,
      source: cache && cache.source ? cache.source : null,
      updatedAt: cache && cache.updatedAt ? cache.updatedAt : null,
      expiresAt: cache && cache.expiresAt ? cache.expiresAt : null,
      metadata: cache && cache.metadata ? cache.metadata : null
    };
  }

  readPageCacheMatches(params = {}) {
    if (params.refId) {
      return false;
    }
    const filter = typeof params.filter === 'string' && params.filter
      ? params.filter
      : 'interactive';
    return filter === 'interactive' || filter === 'controls';
  }

  observeCacheMatches(params = {}, observation = {}) {
    if (params.sincePageStateId) {
      return false;
    }
    if (params.includeAx === true) {
      return false;
    }

    const requestedMode = typeof params.mode === 'string' && params.mode
      ? params.mode
      : 'tiny';
    const cachedMode = typeof observation.observationMode === 'string' && observation.observationMode
      ? observation.observationMode
      : 'tiny';
    if (requestedMode !== cachedMode) {
      return false;
    }

    const limits = observation.limits && typeof observation.limits === 'object'
      ? observation.limits
      : {};
    const requestedHandles = Number(params.maxActionableHandles);
    if (
      params.maxActionableHandles !== undefined &&
      (!Number.isFinite(requestedHandles) || Math.floor(requestedHandles) !== limits.maxActionableHandles)
    ) {
      return false;
    }

    const requestedSummaryChars = Number(params.summaryMaxChars);
    if (
      params.summaryMaxChars !== undefined &&
      (!Number.isFinite(requestedSummaryChars) || Math.floor(requestedSummaryChars) !== limits.summaryMaxChars)
    ) {
      return false;
    }

    return true;
  }

  warmCacheHit(method, params = {}, origin, context = {}) {
    if (!Number.isInteger(context.tabId)) {
      return null;
    }
    const cache = this.findWarmSessionCache({
      ...context,
      origin
    });
    if (!cache || cache.origin !== origin) {
      return null;
    }

    if (method === 'page.observe' && cache.observation && this.observeCacheMatches(params, cache.observation)) {
      return {
        ok: true,
        result: {
          ...cloneJson(cache.observation),
          warmCache: this.warmCacheMetadata(cache)
        }
      };
    }

    if (method === 'page.readPage' && cache.readPage && this.readPageCacheMatches(params)) {
      const pageContent = String(cache.readPage.pageContent || '');
      if (Number.isFinite(params.maxChars) && pageContent.length > params.maxChars) {
        return {
          ok: false,
          error: {
            code: 'PAGE_CONTENT_TOO_LARGE',
            message: 'Cached compact page content exceeds the requested character budget.',
            maxChars: params.maxChars,
            actualChars: pageContent.length
          }
        };
      }
      return {
        ok: true,
        result: {
          ...cloneJson(cache.readPage),
          warmCache: this.warmCacheMetadata(cache)
        }
      };
    }

    return null;
  }

  storeRuntimeWarmSessionCache(method, params = {}, origin, tab, result = {}) {
    if (method !== 'page.observe' && method !== 'page.readPage') {
      return null;
    }
    const tabId = Number.isInteger(params.tabId)
      ? params.tabId
      : (tab && Number.isInteger(tab.id) ? tab.id : null);
    if (!Number.isInteger(tabId)) {
      return null;
    }
    const observation = method === 'page.observe' && isPlainObject(result) ? result : undefined;
    const readPage = method === 'page.readPage' && isPlainObject(result) ? result : undefined;
    const source = method === 'page.observe' ? 'operator.runtime.tab.observe' : 'operator.runtime.tab.readPage';
    return this.setWarmSessionCache({
      agentId: params.agentId,
      origin,
      tabId,
      url: (result && result.url) || (tab && tab.url) || null,
      title: (result && result.title) || (tab && tab.title) || null,
      source,
      observation,
      readPage,
      readPageFilter: typeof params.filter === 'string' && params.filter
        ? params.filter
        : 'interactive',
      metadata: this.warmResultMetadata(observation, readPage)
    });
  }

  ensureStarted(id, params = {}) {
    const status = this.status();
    const extensionConnected = status.connectionState === 'EXTENSION_CONNECTED';
    const bootstrapUrl = `chrome-extension://${this.config.expectedExtensionId}/bootstrap.html?session=${makeBootstrapSessionId()}`;
    let readiness = null;
    if (params.origin || params.url) {
      const origin = originFromParams(params);
      readiness = summarizeReadiness(this.readinessStateForOrigin(origin));
    }

    return rpcOk(id, {
      daemonRunning: true,
      extensionConnected,
      profileReady: this.profileVerified,
      bootstrapRequired: !extensionConnected,
      bootstrapUrl,
      readiness,
      status
    });
  }

  handleDisconnected(id, params = {}) {
    const bridgeInstanceId = typeof params.bridgeInstanceId === 'string' && params.bridgeInstanceId.trim()
      ? params.bridgeInstanceId.trim()
      : null;
    const bridgeOwnedDisconnectWithoutId = !bridgeInstanceId &&
      ['native-port', 'native-bridge', 'extension'].includes(params.source);
    if (params.source !== 'operator-cli' && !bridgeOwnedDisconnectWithoutId) {
      const bridgeCheck = this.checkBridgeInstance(params);
      if (!bridgeCheck.ok) {
        return rpcOk(id, {
          ignored: true,
          reason: 'bridgeInstanceMismatch',
          connectionState: this.connectionState,
          currentBridgeInstanceId: this.bridgeInstanceId
        });
      }
    }
    const previousConnectionId = this.connectionId;
    this.connectionState = 'RECONNECTING';
    this.profileVerified = false;
    this.profileIdentityVerified = false;
    this.bridgeInstanceId = null;
    this.connectionId = null;
    this.lastDisconnect = {
      source: params.source || 'unknown',
      reason: params.reason || null,
      previousConnectionId,
      disconnectedAt: new Date().toISOString()
    };

    const cancelled = this.cancelPendingCommands({
      code: ERROR_CODES.EXTENSION_DISCONNECTED,
      message: params.reason
        ? `Extension disconnected: ${params.reason}`
        : 'Extension disconnected.',
      reconnectRequired: true,
      previousConnectionId
    });
    const cancelledPolls = this.cancelBridgePolls();
    this.clearWarmSessionCache('extension-disconnected', { all: true });
    const invalidatedApprovals = this.invalidateApprovals('extension-disconnected', () => true, {
      previousConnectionId
    });

    return rpcOk(id, {
      connectionState: this.connectionState,
      source: this.lastDisconnect.source,
      previousConnectionId,
      ...cancelled,
      ...cancelledPolls,
      invalidatedApprovals
    });
  }

  approveDomain(id, params) {
    const origin = normalizeHttpOrigin(params && params.origin);
    if (!origin) {
      return invalidOriginResponse(id);
    }
    const approval = this.stateStore.approveDomain(origin, {
      mode: params.mode,
      taskScope: params.taskScope,
      expiresAt: params.expiresAt
    });
    this.approvedOrigins = new Set(this.activeDomainApprovalOrigins());
    return rpcOk(id, { ...approval, approved: true });
  }

  revokeDomain(id, params) {
    const origin = normalizeHttpOrigin(params && params.origin);
    if (!origin) {
      return invalidOriginResponse(id);
    }
    const revoked = this.stateStore.revokeDomain(origin);
    this.approvedOrigins = new Set(this.activeDomainApprovalOrigins());
    this.clearWarmSessionCache('domain-revoked', { origin });
    const invalidatedApprovals = this.invalidateApprovalsForOrigin(origin, 'domain-revoked');
    return rpcOk(id, { origin, revoked, invalidatedApprovals });
  }

  activeDomainApprovalOrigins() {
    return Object.keys(this.stateStore.listActiveDomainApprovals());
  }

  hasDomainApproval(origin) {
    return this.stateStore.isDomainApproved(origin);
  }

  hostPermissionGranted(id, params) {
    const bridgeCheck = this.checkBridgeInstance(params);
    if (!bridgeCheck.ok) {
      return rpcOk(id, {
        ignored: true,
        reason: 'bridgeInstanceMismatch',
        hostPermissionGranted: false
      });
    }
    const origin = normalizeHttpOrigin(params && params.origin);
    if (!origin) {
      return invalidOriginResponse(id);
    }
    this.stateStore.grantHostPermission(origin, { grantedAt: params.grantedAt });
    this.hostPermissions = new Set(this.activeHostPermissionOrigins());
    return rpcOk(id, { origin, hostPermissionGranted: true });
  }

  hostPermissionsSynced(id, params) {
    const bridgeCheck = this.checkBridgeInstance(params);
    if (!bridgeCheck.ok) {
      return rpcOk(id, {
        ignored: true,
        reason: 'bridgeInstanceMismatch',
        hostPermissionOrigins: [...this.hostPermissions]
      });
    }
    if (!Array.isArray(params.origins)) {
      return rpcError(id, {
        code: ERROR_CODES.INVALID_SCHEMA,
        message: 'origins array is required.'
      });
    }

    const origins = params.origins.map((origin) => normalizeHttpOrigin(origin));
    if (origins.some((origin) => !origin)) {
      return invalidOriginResponse(id);
    }

    this.stateStore.syncHostPermissions({
      origins,
      syncedAt: params.syncedAt
    });
    this.hostPermissions = new Set(this.activeHostPermissionOrigins());

    return rpcOk(id, {
      hostPermissionOrigins: [...this.hostPermissions]
    });
  }

  blockedOriginsSynced(id, params) {
    const bridgeCheck = this.checkBridgeInstance(params);
    if (!bridgeCheck.ok) {
      return rpcOk(id, {
        ignored: true,
        reason: 'bridgeInstanceMismatch',
        blockedOrigins: this.stateStore.listBlockedOrigins()
      });
    }
    if (!Array.isArray(params.blockedOrigins)) {
      return rpcError(id, {
        code: ERROR_CODES.INVALID_SCHEMA,
        message: 'blockedOrigins array is required.'
      });
    }

    const blockedOrigins = this.stateStore.setBlockedOrigins(params.blockedOrigins);
    return rpcOk(id, { blockedOrigins });
  }

  activeHostPermissionOrigins() {
    return Object.keys(this.stateStore.listHostPermissions())
      .filter((origin) => this.hasHostPermission(origin));
  }

  hasHostPermission(origin) {
    const permission = this.stateStore.getHostPermission(origin);
    return Boolean(permission);
  }

  blockedOriginMatch(origin) {
    return this.stateStore.blockedOriginMatch(origin);
  }

  readinessStateForOrigin(origin) {
    const blocked = this.blockedOriginMatch(origin);
    return {
      origin,
      profileVerified: this.profileVerified,
      profileConfidence: this.profileConfidence(),
      domainApproved: this.hasDomainApproval(origin),
      hostPermissionGranted: this.hasHostPermission(origin),
      siteBlocked: Boolean(blocked),
      blockedPattern: blocked ? blocked.pattern : null
    };
  }

  profileConfidence() {
    const evidence = ['daemon-session-active'];
    const configuredProfile = this.stateStore.getConfiguredProfile();
    let score = 0.35;
    let status = 'unverified';
    if (configuredProfile) {
      score = 0.65;
      status = 'configured';
      evidence.push('configured-profile-present');
    }
    if (this.profileVerified) {
      score = 0.94;
      status = 'ready';
      evidence.push('extension-profile-ready');
    }
    if (this.connectionState === 'EXTENSION_CONNECTED') {
      evidence.push('extension-connected');
      if (this.lastVersionMismatch === null) {
        evidence.push('version-match');
      }
    }
    return {
      score,
      status,
      evidence
    };
  }

  discoverProfiles(id, params) {
    return rpcOk(id, {
      profiles: discoverChromeProfiles({
        userDataDir: params.userDataDir
      })
    });
  }

  bindProfile(id, params) {
    if (!params.userDataDir || !params.profileDirectory) {
      return rpcError(id, {
        code: ERROR_CODES.INVALID_SCHEMA,
        message: 'userDataDir and profileDirectory are required.'
      });
    }

    const configuredProfile = this.stateStore.setConfiguredProfile({
      userDataDir: params.userDataDir,
      profileDirectory: params.profileDirectory,
      profileLabel: params.profileLabel
    });

    this.profileBindingStatus = 'not-required';
    this.profileVerificationMode = 'not-required';
    this.profileIdentityVerified = false;
    this.hostPermissions = new Set(this.activeHostPermissionOrigins());

    return rpcOk(id, configuredProfile);
  }

  verifyProfile(id) {
    const configuredProfile = this.stateStore.getConfiguredProfile();
    if (!configuredProfile) {
      return rpcError(id, {
        code: ERROR_CODES.PROFILE_NOT_CONFIGURED,
        message: 'Chrome profile is not configured.'
      });
    }
    return rpcOk(id, {
      configuredProfile,
      profileVerified: this.profileVerified,
      profileReady: this.profileVerified,
      profileIdentityVerified: this.profileIdentityVerified,
      profileVerificationMode: this.profileVerificationMode,
      profileBindingStatus: this.profileBindingStatus,
      connectionState: this.connectionState
    });
  }

  verifyReadiness(id, params) {
    const origin = params.origin || (params.url ? new URL(params.url).origin : undefined);
    const readinessState = this.readinessStateForOrigin(origin);
    const summary = summarizeReadiness(readinessState);
    const readiness = assertReadyForRealSiteAction(readinessState);
    return rpcOk(id, {
      ...summary,
      ready: readiness.ok,
      error: readiness.ok ? null : readiness.error
    });
  }

  tailAudit(id, params = {}) {
    return rpcOk(id, {
      auditLogPath: this.config.auditLogPath,
      entries: this.audit.tail({
        limit: params.limit
      })
    });
  }

  timelineAudit(id, params = {}) {
    return rpcOk(id, {
      auditLogPath: this.config.auditLogPath,
      timeline: this.audit.timeline({
        limit: params.limit
      })
    });
  }

  defaultBoundedFullAutoState(overrides = {}) {
    return {
      active: false,
      contract: null,
      startedAt: null,
      expiresAt: null,
      stoppedAt: null,
      stopReason: null,
      counters: {
        browserActions: 0,
        screenshots: 0,
        originChanges: 0
      },
      lastOrigin: null,
      ...overrides
    };
  }

  boundedFullAutoStatus() {
    return cloneJson(this.boundedFullAuto);
  }

  startBoundedFullAuto(id, params = {}) {
    const contract = params.contract;
    const validation = validateBoundedFullAutoContract(contract);
    if (!validation.ok) {
      return rpcError(id, validation.error);
    }

    const startedAtMs = Date.now();
    const expiresAtMs = startedAtMs + (contract.limits.expiresInMinutes * 60 * 1000);
    this.boundedFullAuto = this.defaultBoundedFullAutoState({
      active: true,
      contract: cloneJson(contract),
      startedAt: new Date(startedAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString()
    });

    return rpcOk(id, this.boundedFullAutoStatus());
  }

  stopBoundedFullAuto(id, params = {}) {
    this.boundedFullAuto = {
      ...this.boundedFullAuto,
      active: false,
      stoppedAt: new Date().toISOString(),
      stopReason: typeof params.reason === 'string' && params.reason.trim()
        ? params.reason.trim()
        : 'Bounded Full Auto stopped.'
    };
    return rpcOk(id, this.boundedFullAutoStatus());
  }

  enforceBoundedFullAuto(method, origin) {
    if (!this.boundedFullAuto.active) {
      return guardOk();
    }

    const actionKind = PAGE_ACTION_KINDS[method];
    const contract = this.boundedFullAuto.contract || {};
    const limits = contract.limits || {};
    const expiresAt = Date.parse(this.boundedFullAuto.expiresAt);
    if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
      this.boundedFullAuto = {
        ...this.boundedFullAuto,
        active: false,
        stoppedAt: new Date().toISOString(),
        stopReason: 'Bounded Full Auto expired.'
      };
      return guardError(
        ERROR_CODES.BOUNDED_FULL_AUTO_EXPIRED,
        'Bounded Full Auto session expired.',
        { boundedFullAuto: this.boundedFullAutoStatus() }
      );
    }

    const approvedOrigins = Array.isArray(contract.approvedOrigins)
      ? contract.approvedOrigins
      : [];
    if (!origin || !approvedOrigins.includes(origin)) {
      return guardError(
        ERROR_CODES.BOUNDED_FULL_AUTO_SCOPE_MISMATCH,
        'Origin is outside the Bounded Full Auto contract scope.',
        { origin, approvedOrigins }
      );
    }

    const allowedActionKinds = new Set(Array.isArray(contract.allowedActionKinds)
      ? contract.allowedActionKinds
      : []);
    if (!actionKind || !allowedActionKinds.has(actionKind)) {
      return guardError(
        ERROR_CODES.BOUNDED_FULL_AUTO_ACTION_NOT_ALLOWED,
        'Action kind is not allowed by the Bounded Full Auto contract.',
        { actionKind, allowedActionKinds: [...allowedActionKinds] }
      );
    }

    const counters = this.boundedFullAuto.counters;
    const originChangeIncrement = this.boundedFullAuto.lastOrigin &&
      this.boundedFullAuto.lastOrigin !== origin
      ? 1
      : 0;

    if (
      Number.isFinite(limits.maxBrowserActions) &&
      counters.browserActions + 1 > limits.maxBrowserActions
    ) {
      return guardError(
        ERROR_CODES.BOUNDED_FULL_AUTO_LIMIT_EXCEEDED,
        'Bounded Full Auto browser action limit exceeded.',
        { limit: limits.maxBrowserActions, counter: counters.browserActions }
      );
    }

    if (
      actionKind === 'screenshot' &&
      Number.isFinite(limits.maxScreenshots) &&
      counters.screenshots + 1 > limits.maxScreenshots
    ) {
      return guardError(
        ERROR_CODES.BOUNDED_FULL_AUTO_LIMIT_EXCEEDED,
        'Bounded Full Auto screenshot limit exceeded.',
        { limit: limits.maxScreenshots, counter: counters.screenshots }
      );
    }

    if (
      Number.isFinite(limits.maxOriginChanges) &&
      counters.originChanges + originChangeIncrement > limits.maxOriginChanges
    ) {
      return guardError(
        ERROR_CODES.BOUNDED_FULL_AUTO_LIMIT_EXCEEDED,
        'Bounded Full Auto origin-change limit exceeded.',
        { limit: limits.maxOriginChanges, counter: counters.originChanges }
      );
    }

    counters.browserActions += 1;
    if (actionKind === 'screenshot') {
      counters.screenshots += 1;
    }
    counters.originChanges += originChangeIncrement;
    this.boundedFullAuto.lastOrigin = origin;

    return guardOk({ boundedFullAuto: this.boundedFullAutoStatus() });
  }

  enforceBoundedFullAutoBatch(childActions, origin) {
    if (!this.boundedFullAuto.active) {
      return guardOk();
    }

    const contract = this.boundedFullAuto.contract || {};
    const limits = contract.limits || {};
    const expiresAt = Date.parse(this.boundedFullAuto.expiresAt);
    if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
      this.boundedFullAuto = {
        ...this.boundedFullAuto,
        active: false,
        stoppedAt: new Date().toISOString(),
        stopReason: 'Bounded Full Auto expired.'
      };
      return guardError(
        ERROR_CODES.BOUNDED_FULL_AUTO_EXPIRED,
        'Bounded Full Auto session expired.',
        { boundedFullAuto: this.boundedFullAutoStatus() }
      );
    }

    const approvedOrigins = Array.isArray(contract.approvedOrigins)
      ? contract.approvedOrigins
      : [];
    if (!origin || !approvedOrigins.includes(origin)) {
      return guardError(
        ERROR_CODES.BOUNDED_FULL_AUTO_SCOPE_MISMATCH,
        'Origin is outside the Bounded Full Auto contract scope.',
        { origin, approvedOrigins }
      );
    }

    const allowedActionKinds = new Set(Array.isArray(contract.allowedActionKinds)
      ? contract.allowedActionKinds
      : []);
    for (const childAction of childActions) {
      if (!allowedActionKinds.has(childAction.actionKind)) {
        return guardError(
          ERROR_CODES.BOUNDED_FULL_AUTO_ACTION_NOT_ALLOWED,
          'Batch child action kind is not allowed by the Bounded Full Auto contract.',
          {
            actionKind: childAction.actionKind,
            action: childAction.action,
            actionIndex: childAction.index,
            allowedActionKinds: [...allowedActionKinds]
          }
        );
      }
    }

    const counters = this.boundedFullAuto.counters;
    const browserActionIncrement = childActions.length;
    const screenshotIncrement = childActions.filter((childAction) => (
      childAction.actionKind === 'screenshot'
    )).length;
    const originChangeIncrement = this.boundedFullAuto.lastOrigin &&
      this.boundedFullAuto.lastOrigin !== origin
      ? 1
      : 0;

    if (
      Number.isFinite(limits.maxBrowserActions) &&
      counters.browserActions + browserActionIncrement > limits.maxBrowserActions
    ) {
      return guardError(
        ERROR_CODES.BOUNDED_FULL_AUTO_LIMIT_EXCEEDED,
        'Bounded Full Auto browser action limit exceeded.',
        {
          limit: limits.maxBrowserActions,
          counter: counters.browserActions,
          requested: browserActionIncrement
        }
      );
    }

    if (
      Number.isFinite(limits.maxScreenshots) &&
      counters.screenshots + screenshotIncrement > limits.maxScreenshots
    ) {
      return guardError(
        ERROR_CODES.BOUNDED_FULL_AUTO_LIMIT_EXCEEDED,
        'Bounded Full Auto screenshot limit exceeded.',
        {
          limit: limits.maxScreenshots,
          counter: counters.screenshots,
          requested: screenshotIncrement
        }
      );
    }

    if (
      Number.isFinite(limits.maxOriginChanges) &&
      counters.originChanges + originChangeIncrement > limits.maxOriginChanges
    ) {
      return guardError(
        ERROR_CODES.BOUNDED_FULL_AUTO_LIMIT_EXCEEDED,
        'Bounded Full Auto origin-change limit exceeded.',
        { limit: limits.maxOriginChanges, counter: counters.originChanges }
      );
    }

    counters.browserActions += browserActionIncrement;
    counters.screenshots += screenshotIncrement;
    counters.originChanges += originChangeIncrement;
    this.boundedFullAuto.lastOrigin = origin;

    return guardOk({ boundedFullAuto: this.boundedFullAutoStatus() });
  }

  validateBatchActionField(field, value, actionIndex) {
    const type = BATCH_ACTION_FIELD_TYPES[field];
    if (!type) {
      return guardError(ERROR_CODES.INVALID_SCHEMA, `Batch action field is not supported: ${field}.`, {
        actionIndex,
        field
      });
    }
    if (type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return guardError(ERROR_CODES.INVALID_SCHEMA, `Batch action field ${field} must be a finite number.`, {
          actionIndex,
          field
        });
      }
      if (['depth', 'timeoutMs'].includes(field) && value < 0) {
        return guardError(ERROR_CODES.INVALID_SCHEMA, `Batch action field ${field} must be zero or greater.`, {
          actionIndex,
          field
        });
      }
      if (['maxChars', 'pollIntervalMs'].includes(field) && value < 1) {
        return guardError(ERROR_CODES.INVALID_SCHEMA, `Batch action field ${field} must be one or greater.`, {
          actionIndex,
          field
        });
      }
      if (['maxActionableHandles', 'summaryMaxChars'].includes(field) && value < 1) {
        return guardError(ERROR_CODES.INVALID_SCHEMA, `Batch action field ${field} must be one or greater.`, {
          actionIndex,
          field
        });
      }
      if (field === 'postActionVerifyDelayMs' && value < 0) {
        return guardError(ERROR_CODES.INVALID_SCHEMA, 'Batch action field postActionVerifyDelayMs must be zero or greater.', {
          actionIndex,
          field
        });
      }
      return guardOk();
    }
    if (typeof value !== type) {
      return guardError(ERROR_CODES.INVALID_SCHEMA, `Batch action field ${field} must be ${type}.`, {
        actionIndex,
        field
      });
    }
    if (field === 'mode' && !['tiny', 'medium', 'full'].includes(value)) {
      return guardError(ERROR_CODES.INVALID_SCHEMA, 'Batch action field mode must be tiny, medium, or full.', {
        actionIndex,
        field
      });
    }
    if (field === 'postActionSnapshot' && value !== 'delta') {
      return guardError(ERROR_CODES.INVALID_SCHEMA, 'Batch action field postActionSnapshot must be delta.', {
        actionIndex,
        field
      });
    }
    if (field === 'verify') {
      const verify = validateVerifyConditions(value, { actionIndex, field });
      if (!verify.ok) {
        return verify;
      }
    }
    if (field === 'targetContract') {
      const contract = validateTargetContract(value, {
        actionIndex,
        field: 'targetContract'
      });
      if (!contract.ok) {
        return contract;
      }
    }
    return guardOk();
  }

  validateBatchCommandParams(params = {}, origin) {
    if (!Array.isArray(params.actions) || params.actions.length === 0) {
      return guardError(ERROR_CODES.INVALID_SCHEMA, 'actions must be a non-empty array.');
    }
    if (params.actions.length > MAX_BATCH_ACTIONS) {
      return guardError(ERROR_CODES.INVALID_SCHEMA, `actions must contain ${MAX_BATCH_ACTIONS} or fewer items.`);
    }
    if (params.stopOnError !== undefined && typeof params.stopOnError !== 'boolean') {
      return guardError(ERROR_CODES.INVALID_SCHEMA, 'stopOnError must be a boolean.');
    }

    const actions = [];
    const childActions = [];
    for (let index = 0; index < params.actions.length; index += 1) {
      const action = params.actions[index];
      if (!isPlainObject(action)) {
        return guardError(ERROR_CODES.INVALID_SCHEMA, 'Batch action must be an object.', {
          actionIndex: index
        });
      }
      for (const field of Object.keys(action)) {
        if (!BATCH_ACTION_FIELDS.has(field)) {
          return guardError(ERROR_CODES.INVALID_SCHEMA, `Batch action does not accept field: ${field}.`, {
            actionIndex: index,
            field
          });
        }
      }

      const actionName = typeof action.action === 'string' ? action.action.trim() : '';
      const actionKind = BATCH_ACTION_KINDS[actionName];
      if (!actionName || !actionKind) {
        return guardError(ERROR_CODES.INVALID_SCHEMA, 'Batch action is not supported.', {
          actionIndex: index,
          action: actionName || null
        });
      }

      const commandAction = { action: actionName };
      for (const [field, value] of Object.entries(action)) {
        const fieldValidation = this.validateBatchActionField(field, value, index);
        if (!fieldValidation.ok) {
          return fieldValidation;
        }
        if (field !== 'action') {
          commandAction[field] = value;
        }
      }

      const requiredFields = BATCH_ACTION_REQUIRED_FIELDS[actionName] || [];
      for (const field of requiredFields) {
        if (commandAction[field] === undefined) {
          return guardError(ERROR_CODES.INVALID_SCHEMA, `Batch action ${actionName} requires field: ${field}.`, {
            actionIndex: index,
            field
          });
        }
      }

      actions.push(commandAction);
      childActions.push({
        index,
        action: actionName,
        actionKind
      });
    }

    return guardOk({
      origin,
      actions,
      childActions,
      commandParams: {
        origin,
        actions,
        ...(params.stopOnError === undefined ? {} : { stopOnError: params.stopOnError })
      }
    });
  }

  validateUploadCommandParams(params = {}, origin) {
    const targetHandle = params.target && typeof params.target.handle === 'string'
      ? params.target.handle.trim()
      : '';
    if (!targetHandle) {
      return guardError(
        ERROR_CODES.UPLOAD_TARGET_INVALID,
        'Upload target handle is required.'
      );
    }

    if (!Array.isArray(params.files) || params.files.length === 0) {
      return guardError(
        ERROR_CODES.INVALID_SCHEMA,
        'Upload files must be a non-empty array.'
      );
    }

    const files = params.files.map((file) => {
      const normalized = {
        role: file && file.role,
        path: file && file.path
      };
      if (file && file.expectedSha256 !== undefined) {
        normalized.expectedSha256 = file.expectedSha256;
      }
      return normalized;
    });
    const invalidFile = files.find((file) => (
      !file ||
      typeof file.role !== 'string' ||
      !file.role.trim() ||
      typeof file.path !== 'string' ||
      !file.path.trim()
    ));
    if (invalidFile) {
      return guardError(
        ERROR_CODES.INVALID_SCHEMA,
        'Each upload file must include role and path.'
      );
    }

    const ruleset = typeof params.ruleset === 'string' && params.ruleset.trim()
      ? params.ruleset.trim()
      : 'googlePlayPreviewAssets.v2026';
    const validation = this.assetValidator.validateUploadFiles(files, {
      ruleset,
      expectedOrigin: origin,
      targetHandle
    });

    if (!validation || validation.ok !== true) {
      const firstError = validation && (
        validation.error ||
        (Array.isArray(validation.errors) && validation.errors[0])
      );
      return guardError(
        firstError && firstError.code ? firstError.code : ERROR_CODES.INVALID_SCHEMA,
        firstError && firstError.message ? firstError.message : 'Upload asset validation failed.',
        safeUploadErrorDetails(firstError)
      );
    }

    return guardOk({
      target: { handle: targetHandle },
      ruleset: validation.ruleset || ruleset,
      files: Array.isArray(validation.files) ? validation.files : [],
      filePaths: files.map((file) => file.path),
      verifyPreview: params.verifyPreview === true,
      assetValidation: validation
    });
  }

  validatePrepareCartCommandParams(params = {}) {
    const origin = typeof params.origin === 'string' ? params.origin.trim() : '';
    if (!origin) {
      return guardError(ERROR_CODES.INVALID_SCHEMA, 'origin is required.');
    }

    try {
      const parsedOrigin = new URL(origin);
      if (parsedOrigin.origin !== origin) {
        return guardError(ERROR_CODES.INVALID_SCHEMA, 'origin must be a URL origin.');
      }
    } catch {
      return guardError(ERROR_CODES.INVALID_SCHEMA, 'origin must be a URL origin.');
    }

    const profileId = params.profileId === undefined
      ? 'localTest.ecommerce.v1'
      : (typeof params.profileId === 'string' ? params.profileId.trim() : '');
    if (!profileId) {
      return guardError(ERROR_CODES.INVALID_SCHEMA, 'profileId must be a non-empty string when provided.');
    }

    const siteProfile = assertCartProfileAllowed({
      profiles: this.siteProfiles,
      profileId,
      origin
    });
    if (!siteProfile.ok) {
      return siteProfile;
    }

    const query = typeof params.query === 'string' ? params.query.trim() : '';
    if (!query) {
      return guardError(ERROR_CODES.INVALID_SCHEMA, 'query is required.');
    }

    if (!isPlainObject(params.criteria)) {
      return guardError(ERROR_CODES.INVALID_SCHEMA, 'criteria must be an object.');
    }

    if (typeof params.cartActionAllowed !== 'boolean') {
      return guardError(ERROR_CODES.INVALID_SCHEMA, 'cartActionAllowed must be a boolean.');
    }

    const criteria = {};
    if (params.criteria.minSellerRating === undefined) {
      criteria.minSellerRating = 4;
    } else if (Number.isFinite(params.criteria.minSellerRating)) {
      criteria.minSellerRating = params.criteria.minSellerRating;
    } else {
      return guardError(ERROR_CODES.INVALID_SCHEMA, 'criteria.minSellerRating must be a number.');
    }

    if (params.criteria.maxPrice !== undefined) {
      if (!Number.isFinite(params.criteria.maxPrice)) {
        return guardError(ERROR_CODES.INVALID_SCHEMA, 'criteria.maxPrice must be a number.');
      }
      criteria.maxPrice = params.criteria.maxPrice;
    }

    if (params.criteria.currency !== undefined) {
      if (typeof params.criteria.currency !== 'string') {
        return guardError(ERROR_CODES.INVALID_SCHEMA, 'criteria.currency must be a string.');
      }
      criteria.currency = params.criteria.currency.trim();
    }

    if (params.criteria.sort !== undefined) {
      if (typeof params.criteria.sort !== 'string') {
        return guardError(ERROR_CODES.INVALID_SCHEMA, 'criteria.sort must be a string.');
      }
      criteria.sort = params.criteria.sort.trim();
    }

    return guardOk({
      origin,
      commandParams: {
        origin,
        profileId: siteProfile.profile.id,
        query,
        criteria,
        cartActionAllowed: params.cartActionAllowed
      }
    });
  }

  async routePageCommand(id, method, params) {
    if (this.emergencyStop.active) {
      return rpcError(id, this.emergencyStopError());
    }
    if (this.connectionState === 'RECONNECTING' || this.connectionState === 'DAEMON_RUNNING_EXTENSION_DISCONNECTED') {
      return rpcError(id, {
        code: ERROR_CODES.EXTENSION_DISCONNECTED,
        message: 'Extension must reconnect with a fresh HELLO before browser actions can continue.',
        reconnectRequired: true,
        lastDisconnect: this.lastDisconnect
      });
    }

    const prepareCart = method === 'page.prepareCart'
      ? this.validatePrepareCartCommandParams(params)
      : null;
    if (prepareCart && !prepareCart.ok) {
      return rpcError(id, prepareCart.error);
    }

    const previousOrigin = this.activeTab && this.activeTab.origin;
    const target = method === 'page.navigate' ? navigationTarget(params.url) : null;
    if (target && !target.ok) {
      return rpcError(id, target.error);
    }
    const origin = prepareCart ? prepareCart.origin : (target ? target.origin : originFromParams(params));
    const batch = method === 'page.batch'
      ? this.validateBatchCommandParams(params, origin)
      : null;
    if (batch && !batch.ok) {
      return rpcError(id, batch.error);
    }
    if (!batch) {
      const verify = validateVerifyConditions(params.verify);
      if (!verify.ok) {
        return rpcError(id, verify.error);
      }
      const targetContract = validateTargetContract(params.targetContract);
      if (!targetContract.ok) {
        return rpcError(id, targetContract.error);
      }
    }
    const activeTabDiagnostic = validateActiveTabDiagnosticParams(method, params);
    if (!activeTabDiagnostic.ok) {
      return rpcError(id, activeTabDiagnostic.error);
    }
    const readiness = assertReadyForRealSiteAction(this.readinessStateForOrigin(origin));

    if (!readiness.ok) {
      return rpcError(id, readiness.error);
    }

    const boundedFullAuto = batch
      ? this.enforceBoundedFullAutoBatch(batch.childActions, origin)
      : this.enforceBoundedFullAuto(method, origin);
    if (!boundedFullAuto.ok) {
      return rpcError(id, boundedFullAuto.error);
    }

    const expectedActiveTabId = Number.isInteger(params.expectedActiveTabId)
      ? params.expectedActiveTabId
      : null;
    const activeTabGuard = this.guardActiveTabTarget(method, origin, batch, expectedActiveTabId);
    if (!activeTabGuard.ok) {
      return rpcError(id, activeTabGuard.error);
    }
    const activeTabLock = Number.isInteger(activeTabGuard.expectedActiveTabId)
      ? { expectedActiveTabId: activeTabGuard.expectedActiveTabId }
      : {};
    const activeWarmContext = Number.isInteger(activeTabGuard.expectedActiveTabId)
      ? this.warmCacheContextForTab(this.activeTab, {
        agentId: params.agentId,
        tabId: activeTabGuard.expectedActiveTabId,
        origin
      })
      : {};

    const warmCache = this.warmCacheHit(method, { ...params, ...activeTabLock }, origin, activeWarmContext);
    if (warmCache) {
      if (!warmCache.ok) {
        return rpcError(id, warmCache.error);
      }
      return rpcOk(id, warmCache.result);
    }

    if (method === 'page.uploadFile') {
      const upload = this.validateUploadCommandParams(params, origin);
      if (!upload.ok) {
        return rpcError(id, upload.error);
      }

      const extensionResponse = await this.enqueueExtensionCommandWithPolicy(method, {
        origin,
        target: upload.target,
        ruleset: upload.ruleset,
        verifyPreview: upload.verifyPreview,
        files: upload.files,
        ...activeTabLock
      });
      if (!extensionResponse.ok) {
        return rpcError(id, this.attachApprovalRequest(method, {
          origin,
          target: upload.target,
          ruleset: upload.ruleset,
          verifyPreview: upload.verifyPreview,
          files: upload.files,
          ...activeTabLock
        }, extensionResponse.error));
      }
      if (shouldInvalidateWarmSession(method)) {
        this.clearWarmSessionCache(method, activeWarmContext);
      }
      return rpcOk(id, {
        ...extensionResponse.result,
        assetValidation: upload.assetValidation
      });
    }

    if (method === 'page.prepareCart') {
      const extensionResponse = await this.enqueueExtensionCommandWithPolicy(method, {
        ...prepareCart.commandParams,
        ...activeTabLock
      });
      if (!extensionResponse.ok) {
        return rpcError(id, this.attachApprovalRequest(method, {
          ...prepareCart.commandParams,
          ...activeTabLock
        }, extensionResponse.error));
      }
      if (shouldInvalidateWarmSession(method)) {
        this.clearWarmSessionCache(method, activeWarmContext);
      }
      return rpcOk(id, {
        ...extensionResponse.result,
        policy: {
          ...(extensionResponse.result && extensionResponse.result.policy ? extensionResponse.result.policy : {}),
          actionKind: 'cart-preparation',
          checkoutBlocked: true,
          paymentBlocked: true,
          orderPlacementBlocked: true
        }
      });
    }

    if (method === 'page.batch') {
      const commandParams = {
        ...batch.commandParams,
        ...activeTabLock
      };
      const extensionResponse = await this.enqueueExtensionCommandWithPolicy(method, commandParams);
      if (!extensionResponse.ok) {
        return rpcError(id, this.attachApprovalRequest(method, commandParams, extensionResponse.error));
      }
      const childFailureIndex = Array.isArray(extensionResponse.result && extensionResponse.result.results)
        ? extensionResponse.result.results.findIndex((entry) => !entry || entry.ok === false)
        : -1;
      if (childFailureIndex !== -1) {
        const childFailure = extensionResponse.result.results[childFailureIndex] || {};
        const childError = {
          ...(childFailure.error || {
            code: ERROR_CODES.INVALID_SCHEMA,
            message: 'Batch child action failed without a structured error.'
          }),
          childActionIndex: childFailureIndex,
          childAction: batch.childActions[childFailureIndex]
            ? batch.childActions[childFailureIndex].action
            : null
        };
        return rpcError(id, this.attachApprovalRequest(method, batch.commandParams, childError));
      }
      if (shouldInvalidateWarmSession(method, batch.childActions)) {
        this.clearWarmSessionCache(method, activeWarmContext);
      }
      return rpcOk(id, extensionResponse.result);
    }

    const extensionMethod = method === 'page.visualAnalyze' ? 'page.visualObserve' : method;
    const extensionResponse = await this.enqueueExtensionCommandWithPolicy(extensionMethod, {
      ...params,
      ...(target ? { url: target.url } : {}),
      origin,
      ...activeTabLock
    });
    if (!extensionResponse.ok) {
      const error = this.remapNavigationSettlingError(method, origin, extensionResponse.error);
      return rpcError(id, this.attachApprovalRequest(method, { ...params, origin, ...activeTabLock }, error));
    }
    if (shouldInvalidateWarmSession(method)) {
      this.clearWarmSessionCache(method, activeWarmContext);
    }
    if (method === 'page.visualObserve' || method === 'page.visualAnalyze' || method === 'page.visualInspectTarget') {
      const materialized = this.materializeVisualObservation(extensionResponse.result, origin, {
        policy: {
          ...(params.policy || {}),
          ...(params.maxBytes === undefined ? {} : { maxBytes: params.maxBytes })
        },
        allowSensitive: params.allowSensitive,
        reason: params.reason
      });
      if (!materialized.ok) {
        return rpcError(id, materialized.error);
      }
      if (method === 'page.visualInspectTarget') {
        return rpcOk(id, this.materializeVisualTargetRegion(materialized.result));
      }
      if (method === 'page.visualAnalyze') {
        const analysis = analyzeVisualObservation({
          provider: params.provider,
          observation: materialized.result,
          screenshot: materialized.result.screenshot,
          policy: {
            ...(params.policy || {}),
            ...(params.maxBytes === undefined ? {} : { maxBytes: params.maxBytes }),
            ...(params.allowSensitive === undefined ? {} : { allowSensitive: params.allowSensitive })
          }
        }, this.visualAnalyzerRegistry);
        if (!analysis.ok) {
          return rpcError(id, analysis.error);
        }
        return rpcOk(id, {
          ...materialized.result,
          visual: {
            ...(materialized.result.visual || {}),
            analysis
          }
        });
      }
      return rpcOk(id, materialized.result);
    }
    if (method === 'page.navigate') {
      let navigationOriginChange = null;
      if (previousOrigin && previousOrigin !== origin) {
        const previousApprovalRevoked = this.stateStore.revokeDomain(previousOrigin);
        this.approvedOrigins = new Set(this.activeDomainApprovalOrigins());
        const invalidatedApprovals = this.invalidateApprovalsForOrigin(previousOrigin, 'origin-navigation', {
          newOrigin: origin
        });
        navigationOriginChange = {
          from: previousOrigin,
          to: origin,
          previousApprovalRevoked,
          ...(invalidatedApprovals > 0 ? { invalidatedApprovals } : {})
        };
      }
      return rpcOk(id, {
        ...extensionResponse.result,
        ...(navigationOriginChange ? { navigationOriginChange } : {})
      });
    }
    return rpcOk(id, extensionResponse.result);
  }

  remapNavigationSettlingError(method, origin, error) {
    if (
      !error ||
      ![
        ERROR_CODES.DOMAIN_NOT_APPROVED,
        ERROR_CODES.NO_ACTIVE_TAB
      ].includes(error.code) ||
      method === 'page.navigate'
    ) {
      return error;
    }

    const activeTab = this.activeTab || null;
    const activeTabOrigin = activeTab && activeTab.origin ? activeTab.origin : null;
    const activeTabLoadingState = activeTab && activeTab.loadingState ? activeTab.loadingState : null;
    const activeTabIsElsewhere = activeTabOrigin && activeTabOrigin !== origin;
    const activeTabStillLoading = activeTabOrigin === origin && activeTabLoadingState === 'loading';
    const activeTabIsNavigating = !activeTabOrigin && activeTabLoadingState === 'loading';
    if (!activeTabIsElsewhere && !activeTabStillLoading && !activeTabIsNavigating) {
      return error;
    }

    return {
      ...error,
      code: ERROR_CODES.NAVIGATION_NOT_SETTLED,
      message: 'Active tab has not settled on the requested origin yet. Wait for navigation to complete and retry.',
      origin,
      activeTabOrigin,
      activeTabUrl: activeTab && activeTab.url ? activeTab.url : null,
      activeTabLoadingState,
      retryable: true,
      nextActions: [
        {
          kind: 'wait-and-retry',
          method
        }
      ]
    };
  }

  materializeVisualObservation(result, origin, { policy = {}, allowSensitive, reason } = {}) {
    const screenshot = result && result.screenshot;
    if (!screenshot || !screenshot.dataUrl) {
      return rpcOk(null, result);
    }

    try {
      const { dataUrl, ...screenshotSummary } = screenshot;
      const policyBlock = visualPolicyBlockIfNeeded({
        observation: result,
        screenshot: screenshotSummary,
        policy: {
          allowSensitive: allowSensitive === true || policy.allowSensitive === true,
          allowExternal: false,
          maxBytes: Number.isFinite(policy.maxBytes) ? policy.maxBytes : 5 * 1024 * 1024
        }
      });
      if (policyBlock) {
        return policyBlock;
      }
      const artifact = this.screenshotStore.saveDataUrl({
        dataUrl,
        origin,
        reason: typeof reason === 'string' && reason.trim()
          ? reason.trim().slice(0, 120)
          : 'visualObserve'
      });
      return rpcOk(null, {
        ...result,
        visual: {
          ...(result.visual || {}),
          provider: result.visual && result.visual.provider
            ? result.visual.provider
            : 'chrome.tabs.captureVisibleTab',
          artifactBacked: true
        },
        screenshot: {
          ...screenshotSummary,
          ...artifact
        }
      });
    } catch (error) {
      const code = error.message && error.message.startsWith('VISUAL_ARTIFACT_TOO_LARGE')
        ? ERROR_CODES.VISUAL_ARTIFACT_TOO_LARGE
        : ERROR_CODES.INVALID_SCHEMA;
      return rpcError(null, {
        code,
        message: error.message
      });
    }
  }

  materializeVisualTargetRegion(result) {
    const screenshot = result && result.screenshot;
    const target = result && result.visualTarget;
    if (!screenshot || !screenshot.artifactId || !target || !target.bbox) {
      return result;
    }
    const regionSeed = [
      screenshot.artifactId,
      target.handle || '',
      target.bbox.x,
      target.bbox.y,
      target.bbox.width,
      target.bbox.height
    ].join('_').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 96);
    return {
      ...result,
      visualTarget: {
        ...target,
        sourceArtifactId: screenshot.artifactId,
        regionArtifactId: `region_${regionSeed}`
      }
    };
  }

  cleanupScreenshots(id, params = {}) {
    return rpcOk(id, this.screenshotStore.cleanup({
      olderThanMs: params.olderThanMs
    }));
  }

  emergencyStopError() {
    return {
      code: ERROR_CODES.EMERGENCY_STOPPED,
      message: this.emergencyStop.reason
        ? `Emergency stop is active: ${this.emergencyStop.reason}`
        : 'Emergency stop is active.',
      emergencyStop: { ...this.emergencyStop }
    };
  }

  cancelPendingCommands(error) {
    const cancelledPendingCommands = this.pendingCommands.size;
    const cancelledQueuedCommands = this.commandQueue.length;
    this.commandQueue = [];

    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timeout);
      pending.resolve({
        ok: false,
        error
      });
    }
    this.pendingCommands.clear();

    return {
      cancelledPendingCommands,
      cancelledQueuedCommands
    };
  }

  cancelBridgePolls() {
    const cancelledBridgePolls = this.pendingBridgePolls.size;
    for (const poll of this.pendingBridgePolls.values()) {
      clearTimeout(poll.timeout);
      poll.resolve(rpcOk(poll.requestId, {
        command: null,
        cancelled: true,
        reason: 'bridgeDisconnected'
      }));
    }
    this.pendingBridgePolls.clear();
    return { cancelledBridgePolls };
  }

  activateEmergencyStop(id, params = {}) {
    this.emergencyStop = {
      active: true,
      reason: typeof params.reason === 'string' && params.reason.trim()
        ? params.reason.trim()
        : 'Emergency stop requested.',
      stoppedAt: new Date().toISOString(),
      clearedAt: null
    };
    const cancelled = this.cancelPendingCommands(this.emergencyStopError());
    const invalidatedApprovals = this.invalidateApprovals('emergency-stop', () => true, {
      reason: this.emergencyStop.reason
    });

    return rpcOk(id, {
      ...this.emergencyStop,
      ...cancelled,
      invalidatedApprovals
    });
  }

  clearEmergencyStop(id) {
    this.emergencyStop = {
      ...this.emergencyStop,
      active: false,
      clearedAt: new Date().toISOString()
    };
    return rpcOk(id, { ...this.emergencyStop });
  }

  invalidateApprovalRecord(record, reason, details = {}) {
    if (!record || !APPROVAL_INVALIDATABLE_STATUSES.has(record.status)) {
      return false;
    }
    record.status = 'invalidated';
    record.invalidatedAt = new Date().toISOString();
    record.invalidationReason = reason;
    if (Object.keys(details).length > 0) {
      record.invalidationDetails = cloneJson(details);
    }
    return true;
  }

  invalidateApprovals(reason, predicate = () => true, details = {}) {
    let invalidatedApprovals = 0;
    for (const record of this.pendingApprovals.values()) {
      if (predicate(record) && this.invalidateApprovalRecord(record, reason, details)) {
        invalidatedApprovals += 1;
      }
    }
    return invalidatedApprovals;
  }

  invalidateApprovalsForOrigin(origin, reason, details = {}) {
    if (!origin) {
      return 0;
    }
    return this.invalidateApprovals(reason, (record) => record.origin === origin, {
      origin,
      ...details
    });
  }

  invalidateApprovalsForTab(tabId, reason, details = {}) {
    if (!Number.isInteger(tabId)) {
      return 0;
    }
    return this.invalidateApprovals(reason, (record) => record.tabId === tabId || record.expectedActiveTabId === tabId, {
      tabId,
      ...details
    });
  }

  buildApprovalContext(method, params = {}, error = {}) {
    const targetContract = approvalTargetContractFromParams(params, error);
    const targetHandle = approvalTargetHandleFromParams(params, error, targetContract);
    const expectedActiveTabId = Number.isInteger(params.expectedActiveTabId)
      ? params.expectedActiveTabId
      : null;
    const activeTab = this.activeTab && tabOrigin(this.activeTab) === params.origin
      ? this.activeTab
      : null;
    const tabId = Number.isInteger(params.tabId)
      ? params.tabId
      : (expectedActiveTabId ?? (activeTab && Number.isInteger(activeTab.id) ? activeTab.id : null));
    const sessionTab = Number.isInteger(tabId) ? this.sessionTabs.get(tabId) : null;
    const targetUrl = targetContract &&
      targetContract.context &&
      typeof targetContract.context.url === 'string'
      ? targetContract.context.url
      : null;
    const url = typeof params.url === 'string' && params.url
      ? params.url
      : (targetUrl || (sessionTab && sessionTab.url) || (activeTab && activeTab.url) || null);
    const createdAtMs = Date.now();
    const paramsSnapshot = cloneJson(params || {});
    const pageStateId = pageStateIdFromHandle(targetHandle) ||
      (typeof params.sincePageStateId === 'string' && params.sincePageStateId ? params.sincePageStateId : null);

    return {
      sessionId: this.sessionId,
      agentId: typeof params.agentId === 'string' && params.agentId.trim() ? params.agentId.trim() : null,
      connectionId: this.connectionId,
      bridgeInstanceId: this.bridgeInstanceId,
      tabId,
      expectedActiveTabId,
      url,
      origin: params.origin || originFromParams(params) || null,
      pageStateId,
      targetHandle,
      targetContractHash: targetContract ? stableHash(targetContract) : null,
      paramsHash: stableHash({ method, params: paramsSnapshot }),
      expiresAt: new Date(createdAtMs + APPROVAL_TTL_MS).toISOString()
    };
  }

  attachApprovalRequest(method, params, error) {
    if (!error || ![
      ERROR_CODES.HIGH_RISK_BLOCKED,
      ERROR_CODES.APPROVAL_REQUIRED,
      ERROR_CODES.SENSITIVE_FORM_FILL_BLOCKED
    ].includes(error.code)) {
      return error;
    }

    const approvalKind = error.approvalKind || 'high-risk-action';
    const policy = this.stateStore.getPolicyControls();
    if (PURCHASE_APPROVAL_KINDS.has(approvalKind) && policy.purchaseApprovalsEnabled !== true) {
      return {
        ...error,
        approvalKind,
        approvalStatus: 'disabled',
        policy,
        message: error.message || `Purchase approval is disabled for high-risk action: ${approvalKind}`
      };
    }
    const profileConfidence = this.profileConfidence();
    if (
      !isLocalMockOrigin(params.origin) &&
      PROFILE_CONFIDENCE_REQUIRED_APPROVAL_KINDS.has(approvalKind) &&
      Number(profileConfidence.score) < MIN_PROFILE_CONFIDENCE_FOR_SITE_RISK_ACTION
    ) {
      return {
        ...error,
        code: ERROR_CODES.PROFILE_LOGIN_STATE_UNVERIFIED,
        message: 'Profile confidence is too low for this site-risk action.',
        approvalKind,
        approvalStatus: 'blocked',
        requiredProfileConfidence: MIN_PROFILE_CONFIDENCE_FOR_SITE_RISK_ACTION,
        profileConfidence
      };
    }

    const approvalId = `approval_${this.nextApprovalId++}`;
    const context = this.buildApprovalContext(method, params, error);
    const paramsSnapshot = cloneJson(params || {});
    const record = {
      approvalId,
      status: 'pending',
      method,
      origin: context.origin || params.origin,
      params: paramsSnapshot,
      approvalKind,
      targetSummary: error.targetSummary || null,
      createdAt: new Date().toISOString(),
      expiresAt: context.expiresAt,
      agentId: context.agentId,
      sessionId: context.sessionId,
      connectionId: context.connectionId,
      bridgeInstanceId: context.bridgeInstanceId,
      tabId: context.tabId,
      expectedActiveTabId: context.expectedActiveTabId,
      url: context.url,
      pageStateId: context.pageStateId,
      targetHandle: context.targetHandle,
      targetContractHash: context.targetContractHash,
      paramsHash: context.paramsHash,
      invalidationReason: null
    };
    this.pendingApprovals.set(approvalId, record);

    return {
      ...error,
      approvalId,
      approvalStatus: 'pending'
    };
  }

  approvalRecord(id) {
    const approvalId = id && id.approvalId ? id.approvalId : id;
    return approvalId ? this.pendingApprovals.get(approvalId) || null : null;
  }

  listApprovalRecords({ status } = {}) {
    return [...this.pendingApprovals.values()]
      .filter((record) => !status || record.status === status)
      .map((record) => ({ ...record }));
  }

  policyStatus(id) {
    return rpcOk(id, {
      policy: this.stateStore.getPolicyControls()
    });
  }

  updatePolicy(id, params = {}) {
    const allowed = ['guardedActionsEnabled', 'purchaseApprovalsEnabled'];
    const update = {};
    for (const [key, value] of Object.entries(params || {})) {
      if (key === 'bridgeInstanceId') {
        continue;
      }
      if (!allowed.includes(key)) {
        return rpcError(id, {
          code: ERROR_CODES.INVALID_SCHEMA,
          message: `Unsupported policy setting: ${key}.`
        });
      }
      if (typeof value !== 'boolean') {
        return rpcError(id, {
          code: ERROR_CODES.INVALID_SCHEMA,
          message: `${key} must be a boolean.`
        });
      }
      update[key] = value;
    }
    return rpcOk(id, {
      policy: this.stateStore.updatePolicyControls(update)
    });
  }

  listApprovals(id, params) {
    return rpcOk(id, {
      approvals: this.listApprovalRecords({ status: params.status })
    });
  }

  approvalExpired(record) {
    const expiresAt = Date.parse(record && record.expiresAt);
    return Number.isFinite(expiresAt) && Date.now() > expiresAt;
  }

  failApprovalContext(id, record, reason, extra = {}) {
    this.invalidateApprovalRecord(record, reason, extra);
    return rpcError(id, approvalContextError(record, reason, extra));
  }

  validateApprovalRecordForDecision(id, record, requiredStatus) {
    if (!record) {
      return rpcError(id, {
        code: ERROR_CODES.INVALID_REQUEST,
        message: 'Approval request not found.'
      });
    }
    if (this.approvalExpired(record)) {
      return this.failApprovalContext(id, record, 'approval-expired', {
        expiresAt: record.expiresAt
      });
    }
    if (record.status !== requiredStatus) {
      if (record.status === 'invalidated') {
        return rpcError(id, approvalContextError(record, record.invalidationReason || 'approval-invalidated', {
          invalidatedAt: record.invalidatedAt || null
        }));
      }
      return rpcError(id, {
        code: requiredStatus === 'pending' ? ERROR_CODES.INVALID_REQUEST : ERROR_CODES.APPROVAL_REQUIRED,
        message: requiredStatus === 'pending'
          ? `Approval request is ${record.status}.`
          : 'Approval request must be approved before replay.'
      });
    }
    return null;
  }

  validateApprovalReplayStaticContext(record) {
    if (record.sessionId && record.sessionId !== this.sessionId) {
      return guardError(ERROR_CODES.APPROVAL_CONTEXT_MISMATCH, 'Approval was created for a different daemon session.', {
        reason: 'session-mismatch',
        expectedSessionId: record.sessionId,
        currentSessionId: this.sessionId
      });
    }
    if (record.connectionId && record.connectionId !== this.connectionId) {
      return guardError(ERROR_CODES.APPROVAL_CONTEXT_MISMATCH, 'Approval was created for a different extension connection.', {
        reason: 'connection-mismatch',
        expectedConnectionId: record.connectionId,
        currentConnectionId: this.connectionId
      });
    }
    if (record.paramsHash && stableHash({ method: record.method, params: record.params }) !== record.paramsHash) {
      return guardError(ERROR_CODES.APPROVAL_CONTEXT_MISMATCH, 'Approval parameters changed before replay.', {
        reason: 'params-hash-mismatch'
      });
    }

    if (Number.isInteger(record.expectedActiveTabId)) {
      const activeTab = this.activeTab || null;
      if (
        !activeTab ||
        activeTab.id !== record.expectedActiveTabId ||
        tabOrigin(activeTab) !== record.origin
      ) {
        return guardError(ERROR_CODES.APPROVAL_CONTEXT_MISMATCH, 'Approved active tab is no longer active.', {
          reason: 'active-tab-mismatch',
          expectedActiveTabId: record.expectedActiveTabId,
          activeTabId: activeTab && Number.isInteger(activeTab.id) ? activeTab.id : null,
          activeTabUrl: activeTab && activeTab.url ? activeTab.url : null
        });
      }
      if (record.url && activeTab.url && activeTab.url !== record.url) {
        return guardError(ERROR_CODES.APPROVAL_CONTEXT_MISMATCH, 'Approved active tab URL changed before replay.', {
          reason: 'active-tab-url-mismatch',
          expectedUrl: record.url,
          activeTabUrl: activeTab.url
        });
      }
    } else if (Number.isInteger(record.tabId)) {
      const tab = this.sessionTabs.get(record.tabId) || null;
      if (!tab || originFromUrl(tab.url) !== record.origin) {
        return guardError(ERROR_CODES.APPROVAL_CONTEXT_MISMATCH, 'Approved session tab is no longer available.', {
          reason: 'tab-mismatch',
          tabId: record.tabId,
          currentUrl: tab && tab.url ? tab.url : null
        });
      }
      if (record.url && tab.url && tab.url !== record.url) {
        return guardError(ERROR_CODES.APPROVAL_CONTEXT_MISMATCH, 'Approved session tab URL changed before replay.', {
          reason: 'tab-url-mismatch',
          tabId: record.tabId,
          expectedUrl: record.url,
          currentUrl: tab.url
        });
      }
    }

    return guardOk();
  }

  approvalReobserveCommand(record) {
    if (!record.pageStateId && !record.targetContractHash) {
      return null;
    }
    if (Number.isInteger(record.expectedActiveTabId)) {
      return {
        method: 'page.observe',
        params: {
          origin: record.origin,
          expectedActiveTabId: record.expectedActiveTabId,
          mode: 'tiny',
          maxActionableHandles: 80,
          summaryMaxChars: 2000
        }
      };
    }
    if (Number.isInteger(record.tabId)) {
      return {
        method: 'operator.runtime.tab.observe',
        params: {
          tabId: record.tabId,
          mode: 'tiny',
          maxActionableHandles: 80,
          summaryMaxChars: 2000
        }
      };
    }
    return null;
  }

  async validateApprovalReplayObservedContext(record) {
    const reobserve = this.approvalReobserveCommand(record);
    if (!reobserve) {
      return guardOk();
    }
    const observation = await this.enqueueExtensionCommand(reobserve.method, reobserve.params);
    if (!observation.ok) {
      return guardError(ERROR_CODES.APPROVAL_CONTEXT_MISMATCH, 'Could not re-observe approved target before replay.', {
        reason: 'reobserve-failed',
        reobserveError: observation.error || null
      });
    }

    const result = observation.result || {};
    if (record.url && result.url && result.url !== record.url) {
      return guardError(ERROR_CODES.APPROVAL_CONTEXT_MISMATCH, 'Observed URL no longer matches approval.', {
        reason: 'url-mismatch',
        expectedUrl: record.url,
        observedUrl: result.url
      });
    }
    if (record.pageStateId && result.pageStateId && result.pageStateId !== record.pageStateId) {
      return guardError(ERROR_CODES.APPROVAL_CONTEXT_MISMATCH, 'Observed page state no longer matches approval.', {
        reason: 'page-state-mismatch',
        expectedPageStateId: record.pageStateId,
        observedPageStateId: result.pageStateId
      });
    }
    if (record.targetContractHash && !observedTargetMatchesApproval(result, record)) {
      return guardError(ERROR_CODES.APPROVAL_CONTEXT_MISMATCH, 'Approved target contract was not found during replay re-observe.', {
        reason: 'target-contract-mismatch',
        targetContractHash: record.targetContractHash,
        targetHandle: record.targetHandle || null
      });
    }
    return guardOk();
  }

  approveApproval(id, params) {
    const record = this.approvalRecord(params);
    const invalid = this.validateApprovalRecordForDecision(id, record, 'pending');
    if (invalid) {
      return invalid;
    }
    const policy = this.stateStore.getPolicyControls();
    if (!isLocalMockOrigin(record.origin) && policy.guardedActionsEnabled !== false) {
      return rpcError(id, {
        code: ERROR_CODES.HIGH_RISK_BLOCKED,
        message: 'Manual approval replay for real origins requires guarded actions to be disabled.'
      });
    }

    record.status = 'approved';
    record.approvedAt = new Date().toISOString();
    return rpcOk(id, { ...record });
  }

  rejectApproval(id, params) {
    const record = this.approvalRecord(params);
    if (!record) {
      return rpcError(id, {
        code: ERROR_CODES.INVALID_REQUEST,
        message: 'Approval request not found.'
      });
    }
    record.status = 'rejected';
    record.rejectedAt = new Date().toISOString();
    return rpcOk(id, { ...record });
  }

  async runApproval(id, params) {
    if (this.emergencyStop.active) {
      return rpcError(id, this.emergencyStopError());
    }

    const record = this.approvalRecord(params);
    const invalid = this.validateApprovalRecordForDecision(id, record, 'approved');
    if (invalid) {
      return invalid;
    }

    const readiness = assertReadyForRealSiteAction({
      ...this.readinessStateForOrigin(record.origin),
      domainApproved: this.approvedOrigins.has(record.origin)
    });
    if (!readiness.ok) {
      return rpcError(id, readiness.error);
    }

    const staticContext = this.validateApprovalReplayStaticContext(record);
    if (!staticContext.ok) {
      return this.failApprovalContext(id, record, staticContext.error.reason || 'context-mismatch', staticContext.error);
    }

    const observedContext = await this.validateApprovalReplayObservedContext(record);
    if (!observedContext.ok) {
      return this.failApprovalContext(id, record, observedContext.error.reason || 'context-mismatch', observedContext.error);
    }

    record.status = 'running';
    const approval = {
      approvalId: record.approvalId,
      approvalKind: record.approvalKind
    };
    if (record.approvalKind === 'sensitive-form-fill') {
      approval.allowSensitiveFormFill = true;
    } else {
      approval.allowHighRisk = true;
    }
    const extensionResponse = await this.enqueueExtensionCommand(record.method, {
      ...record.params,
      approval
    });
    if (!extensionResponse.ok) {
      record.status = 'failed';
      record.error = extensionResponse.error;
      return rpcError(id, extensionResponse.error);
    }

    record.status = 'completed';
    record.completedAt = new Date().toISOString();
    return rpcOk(id, extensionResponse.result);
  }

  enqueueExtensionCommand(method, params = {}) {
    const tabId = params && Number.isInteger(params.tabId) ? params.tabId : null;
    if (tabId === null) {
      return this.enqueueExtensionCommandNow(method, params);
    }
    const previous = this.tabCommandLocks.get(tabId);
    const next = previous
      ? previous
        .catch(() => null)
        .then(() => this.enqueueExtensionCommandNow(method, params))
      : this.enqueueExtensionCommandNow(method, params);
    this.tabCommandLocks.set(tabId, next);
    next.finally(() => {
      if (this.tabCommandLocks.get(tabId) === next) {
        this.tabCommandLocks.delete(tabId);
      }
    });
    return next;
  }

  enqueueExtensionCommandNow(method, params) {
    const commandId = `cmd_${this.nextCommandId++}`;
    const command = {
      type: 'command',
      commandId,
      connectionId: this.connectionId,
      method,
      params
    };
    this.recordRecentEvent({
      type: 'pageCommandQueued',
      method,
      origin: originFromParams(params),
      actionKind: PAGE_ACTION_KINDS[method],
      result: 'queued',
      activeTab: summarizeActiveTabForEvent(this.activeTab)
    });
    const commandTimeoutMs = Number.isFinite(params && params.timeoutMs)
      ? Math.max(30000, params.timeoutMs + 5000)
      : 30000;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(commandId);
        resolve({
          ok: false,
          error: {
            code: ERROR_CODES.TIMEOUT,
            message: `Timed out waiting for extension response to ${method}.`
          }
        });
      }, commandTimeoutMs);

      this.pendingCommands.set(commandId, {
        method,
        origin: originFromParams(params),
        actionKind: PAGE_ACTION_KINDS[method],
        resolve,
        timeout
      });
      this.commandQueue.push(command);
      this.flushBridgePolls();
    });
  }

  flushBridgePolls() {
    while (this.pendingBridgePolls.size > 0 && this.commandQueue.length > 0) {
      const [pollId, poll] = this.pendingBridgePolls.entries().next().value;
      this.pendingBridgePolls.delete(pollId);
      clearTimeout(poll.timeout);
      poll.resolve(rpcOk(poll.requestId, {
        command: this.commandQueue.shift()
      }));
    }
  }

  async pollBridge(id, params = {}) {
    const bridgeCheck = this.checkBridgeInstance(params);
    if (!bridgeCheck.ok) {
      return rpcOk(id, {
        command: null,
        ignored: true,
        reason: 'bridgeInstanceMismatch',
        currentBridgeInstanceId: this.bridgeInstanceId
      });
    }
    const command = this.commandQueue.shift() || null;
    if (command || params.wait !== true) {
      return rpcOk(id, { command });
    }

    const requestedTimeoutMs = Number(params.timeoutMs);
    const timeoutMs = Number.isFinite(requestedTimeoutMs)
      ? Math.min(30000, Math.max(100, requestedTimeoutMs))
      : 25000;

    return new Promise((resolve) => {
      const pollId = `poll_${this.nextBridgePollId++}`;
      const timeout = setTimeout(() => {
        this.pendingBridgePolls.delete(pollId);
        resolve(rpcOk(id, { command: null, timedOut: true }));
      }, timeoutMs);
      if (typeof timeout.unref === 'function') {
        timeout.unref();
      }
      this.pendingBridgePolls.set(pollId, {
        requestId: id,
        resolve,
        timeout
      });
      this.flushBridgePolls();
    });
  }

  deliverBridgeResponse(id, params) {
    const bridgeCheck = this.checkBridgeInstance(params);
    if (!bridgeCheck.ok) {
      return rpcError(id, bridgeCheck.error);
    }
    if (params.connectionId && params.connectionId !== this.connectionId) {
      return rpcError(id, {
        code: ERROR_CODES.EXTENSION_DISCONNECTED,
        message: 'Stale extension connection cannot deliver command responses.',
        reconnectRequired: true,
        currentConnectionId: this.connectionId,
        deliveredConnectionId: params.connectionId
      });
    }

    const pending = this.pendingCommands.get(params.commandId);
    if (!pending) {
      return rpcError(id, {
        code: ERROR_CODES.INVALID_REQUEST,
        message: 'Unknown or expired command id.'
      });
    }

    clearTimeout(pending.timeout);
    this.pendingCommands.delete(params.commandId);
    this.updateActiveTab(params.activeTab || null);
    this.recordRecentEvent({
      type: 'pageCommandDelivered',
      method: pending.method,
      origin: pending.origin,
      actionKind: pending.actionKind,
      result: params.response && params.response.ok ? 'ok' : 'error',
      errorCode: params.response && params.response.error && params.response.error.code,
      activeTab: summarizeActiveTabForEvent(this.activeTab)
    });
    pending.resolve(params.response || {
      ok: false,
      error: {
        code: ERROR_CODES.INVALID_REQUEST,
        message: 'Missing command response.'
      }
    });

    return rpcOk(id, {
      commandId: params.commandId,
      delivered: true
    });
  }
}

module.exports = {
  SessionManager,
  defaultAuditPath
};
