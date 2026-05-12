'use strict';

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

const CDP_ALLOWED_METHODS = new Set([
  'DOM.scrollIntoViewIfNeeded',
  'Input.dispatchKeyEvent',
  'Input.dispatchMouseEvent',
  'Input.insertText',
  'Page.captureScreenshot',
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
const RUNTIME_LOCATOR_ACTIONS = new Set(['resolve', 'click', 'type', 'fill', 'focus', 'clear']);
const RUNTIME_LOCATOR_MUTATION_METHODS = Object.freeze({
  click: 'page.click',
  type: 'page.type',
  fill: 'page.fill',
  focus: 'page.focus',
  clear: 'page.clear'
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
  'actionTrace',
  'actionTraceLabel',
  'actionTraceDurationMs',
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
  actionTrace: 'boolean',
  actionTraceLabel: 'string',
  actionTraceDurationMs: 'number',
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
const RECENT_ACTION_LOG_LIMIT = 25;
const WARM_CACHE_PRESERVING_ACTION_KINDS = new Set(['observe', 'screenshot', 'wait']);

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
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

  return guardOk({ params });
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
    origin,
    title: typeof tab.title === 'string' ? tab.title : null,
    status: typeof tab.status === 'string' ? tab.status : null,
    loadingState: tab.status === 'loading' ? 'loading' : 'complete',
    updatedAt: new Date().toISOString()
  };
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
  return {
    id: tabId.tabId,
    title: typeof tab.title === 'string' ? tab.title : null,
    url: typeof tab.url === 'string' ? tab.url : null,
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
  if (!selector && !text) {
    return guardError(ERROR_CODES.INVALID_SCHEMA, 'Locator requires selector or text.');
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
  return guardOk({
    action,
    selector: selector || undefined,
    text: text || undefined,
    textValue: typeof params.textValue === 'string' ? params.textValue : undefined
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
    'actionTrace',
    'actionTraceLabel',
    'actionTraceDurationMs',
    'verify'
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

class SessionManager {
  constructor(config = {}) {
    this.stateStore = config.stateStore || new OperatorStateStore({ statePath: config.statePath });
    this.config = {
      expectedExtensionId: config.expectedExtensionId || 'development-extension-id',
      expectedProtocolVersion: config.expectedProtocolVersion || '1.0',
      expectedExtensionVersion: config.expectedExtensionVersion || '0.2.12',
      expectedBridgeVersion: config.expectedBridgeVersion || '0.2.12',
      auditLogPath: config.auditLogPath || defaultAuditPath(),
      screenshotDir: config.screenshotDir || defaultScreenshotDir(),
      visualAnalyzerRegistry: config.visualAnalyzerRegistry || createVisualAnalyzerRegistry(),
      assetValidator: config.assetValidator || defaultAssetValidator,
      siteProfiles: config.siteProfiles || loadSiteProfiles({ profileDir: config.siteProfileDir }),
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
    this.activeTab = null;
    this.recentEvents = [];
    this.emergencyStop = {
      active: false,
      reason: null,
      stoppedAt: null,
      clearedAt: null
    };
    this.boundedFullAuto = this.defaultBoundedFullAutoState();
    this.warmSessionCache = null;
    this.sessionName = null;
    this.sessionTabs = new Map();
    this.lastUserTabInventory = new Map();
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

  status({ detail = 'full' } = {}) {
    const profileConfidence = this.profileConfidence();
    const fullStatus = {
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
      recentEvents: this.recentEvents.map((event) => cloneJson(event)),
      recentActionLog: this.recentEvents.map((event) => cloneJson(event)),
      tokenUsage: { ...this.tokenUsage },
      emergencyStop: { ...this.emergencyStop },
      boundedFullAuto: this.boundedFullAutoStatus(),
      version: {
        protocolVersion: this.config.expectedProtocolVersion,
        extensionVersion: this.config.expectedExtensionVersion,
        bridgeVersion: this.config.expectedBridgeVersion,
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
      case 'operator.cdp.attach':
      case 'operator.cdp.detach':
      case 'operator.cdp.execute':
        response = await this.routeCdpCommand(id, request.method, params);
        break;
      case 'operator.runtime.tab.goto':
      case 'operator.runtime.tab.observe':
      case 'operator.runtime.tab.readPage':
      case 'operator.runtime.tab.locator':
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
      sessionId: 'daemon',
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

  updateSessionTab(tab, fallbackOwnership) {
    const normalized = normalizeSessionTab(tab, fallbackOwnership);
    if (!normalized) {
      return null;
    }
    const previous = this.sessionTabs.get(normalized.id) || {};
    const merged = {
      ...previous,
      ...normalized,
      ownership: normalized.ownership || previous.ownership || fallbackOwnership || null,
      finalizedStatus: normalized.finalizedStatus || previous.finalizedStatus || null
    };
    this.sessionTabs.set(merged.id, merged);
    return { ...merged };
  }

  updateSessionTabs(tabs = []) {
    if (!Array.isArray(tabs)) {
      return this.listSessionTabRecords();
    }
    for (const tab of tabs) {
      this.updateSessionTab(tab, tab && tab.ownership);
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
    if (tab && originFromUrl(tab.url)) {
      return tab;
    }
    if (this.connectionState !== 'EXTENSION_CONNECTED') {
      return tab;
    }
    const extensionResponse = await this.enqueueExtensionCommand('operator.tabs.listSession', {});
    if (extensionResponse.ok) {
      this.updateSessionTabs(extensionResponse.result && extensionResponse.result.tabs);
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
      if (!this.lastUserTabInventory.has(tabId.tabId)) {
        return rpcError(id, {
          code: ERROR_CODES.INVALID_SCHEMA,
          message: 'Tab must come from the latest user tab inventory before it can be claimed.',
          tabId: tabId.tabId
        });
      }
      const extensionResponse = await this.enqueueExtensionCommand(method, { tabId: tabId.tabId });
      if (!extensionResponse.ok) {
        return rpcError(id, extensionResponse.error);
      }
      const tab = this.updateSessionTab(extensionResponse.result && extensionResponse.result.tab, 'user');
      return rpcOk(id, { tab });
    }

    if (method === 'operator.tabs.create') {
      const extensionResponse = await this.enqueueExtensionCommand(method, {});
      if (!extensionResponse.ok) {
        return rpcError(id, extensionResponse.error);
      }
      const tab = this.updateSessionTab(extensionResponse.result && extensionResponse.result.tab, 'agent');
      return rpcOk(id, { tab });
    }

    if (method === 'operator.tabs.listSession') {
      const extensionResponse = await this.enqueueExtensionCommand(method, {});
      if (!extensionResponse.ok) {
        return rpcError(id, extensionResponse.error);
      }
      const tabs = this.updateSessionTabs(extensionResponse.result && extensionResponse.result.tabs);
      return rpcOk(id, { tabs });
    }

    if (method === 'operator.tabs.finalize') {
      const keep = validateFinalizeKeep(params.keep, this.sessionTabs);
      if (!keep.ok) {
        return rpcError(id, keep.error);
      }
      const extensionResponse = await this.enqueueExtensionCommand(method, { keep: keep.keep });
      if (!extensionResponse.ok) {
        return rpcError(id, extensionResponse.error);
      }
      const finalizedResult = extensionResponse.result || {};
      const removedTabIds = [
        ...(Array.isArray(finalizedResult.closed) ? finalizedResult.closed : []),
        ...(Array.isArray(finalizedResult.released) ? finalizedResult.released : [])
      ];
      for (const tabId of removedTabIds) {
        if (Number.isInteger(tabId)) {
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
      const extensionResponse = await this.enqueueExtensionCommand(method, { tabId: tabId.tabId });
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
      if (typeof params.pinned !== 'boolean') {
        return rpcError(id, { code: ERROR_CODES.INVALID_SCHEMA, message: 'pinned must be a boolean.' });
      }
      const extensionResponse = await this.enqueueExtensionCommand(method, {
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
      const index = boundedInteger(params.index, null, 0, 1000);
      if (index === null) {
        return rpcError(id, { code: ERROR_CODES.INVALID_SCHEMA, message: 'index must be a non-negative integer.' });
      }
      const windowId = params.windowId === undefined ? undefined : boundedInteger(params.windowId, null, 0, 1000000);
      if (params.windowId !== undefined && windowId === null) {
        return rpcError(id, { code: ERROR_CODES.INVALID_SCHEMA, message: 'windowId must be a non-negative integer.' });
      }
      const commandParams = { tabId: tabId.tabId, index, ...(windowId === undefined ? {} : { windowId }) };
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
    const tab = await this.refreshSessionTabForOperation(tabId.tabId);
    if (!tab) {
      return rpcError(id, {
        code: ERROR_CODES.INVALID_SCHEMA,
        message: 'CDP commands require a session-owned tab.',
        tabId: tabId.tabId
      });
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
    const extensionResponse = await this.enqueueExtensionCommand(method, {
      ...(sessionId ? { sessionId } : {}),
      claim
    });
    if (!extensionResponse.ok) {
      return rpcError(id, extensionResponse.error);
    }
    const rawTab = extensionResponse.result && extensionResponse.result.tab;
    const tab = claim
      ? this.updateSessionTab(rawTab, 'user')
      : normalizeUserTab(rawTab);
    if (claim && tab) {
      this.lastUserTabInventory.set(tab.id, tab);
    }
    return rpcOk(id, { tab });
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
      'operator.runtime.tab.locator',
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
    const tab = await this.refreshSessionTabForOperation(tabId.tabId);
    if (!tab) {
      return rpcError(id, {
        code: ERROR_CODES.INVALID_SCHEMA,
        message: 'Runtime tab commands require a session-owned tab.',
        tabId: tabId.tabId
      });
    }

    let origin = originFromUrl(tab.url);
    let commandParams = { ...params, tabId: tabId.tabId };
    let policyMethod = 'page.observe';

    if (method === 'operator.runtime.tab.goto') {
      const target = navigationTarget(params.url);
      if (!target.ok) {
        return rpcError(id, target.error);
      }
      origin = target.origin;
      commandParams = { tabId: tabId.tabId, url: target.url };
      policyMethod = 'page.navigate';
    } else {
      if (!origin) {
        return rpcError(id, {
          code: ERROR_CODES.UNSUPPORTED_SCHEME,
          message: 'Runtime tab commands require a regular http:// or https:// session tab.',
          tabId: tabId.tabId
        });
      }
      if (method === 'operator.runtime.tab.locator') {
        const locator = validateRuntimeLocatorParams(params);
        if (!locator.ok) {
          return rpcError(id, locator.error);
        }
        commandParams = {
          tabId: tabId.tabId,
          action: locator.action,
          ...(locator.selector === undefined ? {} : { selector: locator.selector }),
          ...(locator.text === undefined ? {} : { text: locator.text }),
          ...(locator.textValue === undefined ? {} : { textValue: locator.textValue }),
          ...pickRuntimeObservationParams(params)
        };
        policyMethod = RUNTIME_LOCATOR_MUTATION_METHODS[locator.action] || 'page.observe';
      } else if (method === 'operator.runtime.tab.showTarget') {
        const cue = validateTargetCueParams(params);
        if (!cue.ok) {
          return rpcError(id, cue.error);
        }
        commandParams = {
          tabId: tabId.tabId,
          ...pickDefinedLocal(cue, ['handle', 'selector', 'text', 'durationMs'])
        };
        policyMethod = 'page.observe';
      } else if (method === 'operator.runtime.tab.indicator') {
        commandParams = {
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
          tabId: tabId.tabId,
          ...pickRuntimeReadPageParams(params)
        };
      } else {
        commandParams = {
          tabId: tabId.tabId,
          ...pickRuntimeObservationParams(params)
        };
      }
    }

    const readiness = assertReadyForRealSiteAction(this.readinessStateForOrigin(origin));
    if (!readiness.ok) {
      return rpcError(id, readiness.error);
    }
    const boundedFullAuto = this.enforceBoundedFullAuto(policyMethod, origin);
    if (!boundedFullAuto.ok) {
      return rpcError(id, boundedFullAuto.error);
    }

    const extensionResponse = await this.enqueueExtensionCommand(method, commandParams);
    if (!extensionResponse.ok) {
      return rpcError(id, extensionResponse.error);
    }
    if (method === 'operator.runtime.tab.goto') {
      const updatedTab = this.updateSessionTab(extensionResponse.result && extensionResponse.result.tab, tab.ownership);
      return rpcOk(id, {
        ...(extensionResponse.result || {}),
        tab: updatedTab || (extensionResponse.result && extensionResponse.result.tab) || null,
        origin
      });
    }
    if (shouldInvalidateWarmSession(policyMethod)) {
      this.clearWarmSessionCache(policyMethod);
    }
    return rpcOk(id, {
      tabId: tabId.tabId,
      origin,
      ...(extensionResponse.result || {})
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
      this.clearWarmSessionCache('warmup-failed');
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
      this.clearWarmSessionCache('warmup-origin-mismatch');
      return rpcError(id, {
        code: ERROR_CODES.INVALID_SCHEMA,
        message: 'Warm session origin must match the active tab origin.'
      });
    }
    const readiness = assertReadyForRealSiteAction(this.readinessStateForOrigin(origin));
    if (!readiness.ok) {
      this.clearWarmSessionCache('warmup-domain-not-approved');
      return rpcError(id, readiness.error);
    }

    const updatedAtMs = Date.now();
    this.warmSessionCache = {
      origin,
      url: activeTab.url,
      tabId: activeTab.id,
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
    };

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
      this.activeTab = normalized;
      if (
        this.warmSessionCache &&
        (
          this.warmSessionCache.url !== normalized.url ||
          this.warmSessionCache.tabId !== normalized.id
        )
      ) {
        this.clearWarmSessionCache('active-tab-changed');
      }
    }
    return this.activeTab;
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

  clearWarmSessionCache(reason = 'cleared') {
    const previous = this.warmSessionCache;
    this.warmSessionCache = previous
      ? {
        origin: previous.origin,
        url: previous.url,
        tabId: previous.tabId,
        title: previous.title,
        source: previous.source,
        updatedAt: previous.updatedAt,
        expiresAt: previous.expiresAt,
        metadata: previous.metadata || null,
        inactiveAt: new Date().toISOString(),
        inactiveReason: reason,
        observation: null,
        readPage: null
      }
      : {
        inactiveAt: new Date().toISOString(),
        inactiveReason: reason,
        observation: null,
        readPage: null
      };
  }

  warmSessionStatus() {
    const cache = this.warmSessionCache;
    if (!cache) {
      return {
        active: false,
        reason: null
      };
    }

    const expiresAt = Date.parse(cache.expiresAt);
    const expired = Number.isFinite(expiresAt) && Date.now() > expiresAt;
    if (expired) {
      return {
        active: false,
        reason: 'expired',
        origin: cache.origin || null,
        url: cache.url || null,
        tabId: cache.tabId ?? null,
        title: cache.title || null,
        source: cache.source || null,
        updatedAt: cache.updatedAt || null,
        expiresAt: cache.expiresAt || null,
        metadata: cache.metadata || null,
        hasObservation: false,
        hasReadPage: false
      };
    }

    const active = Boolean(cache.observation || cache.readPage);
    return {
      active,
      reason: active ? null : (cache.inactiveReason || 'cleared'),
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

  warmCacheMetadata() {
    const status = this.warmSessionStatus();
    return {
      hit: true,
      source: status.source,
      updatedAt: status.updatedAt,
      expiresAt: status.expiresAt,
      metadata: status.metadata || null
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

  warmCacheHit(method, params = {}, origin) {
    const status = this.warmSessionStatus();
    const cache = this.warmSessionCache;
    if (!status.active || !cache || cache.origin !== origin) {
      return null;
    }
    if (this.activeTab && this.activeTab.url && cache.url !== this.activeTab.url) {
      this.clearWarmSessionCache('active-tab-changed');
      return null;
    }

    if (method === 'page.observe' && cache.observation && this.observeCacheMatches(params, cache.observation)) {
      return {
        ok: true,
        result: {
          ...cloneJson(cache.observation),
          warmCache: this.warmCacheMetadata()
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
          warmCache: this.warmCacheMetadata()
        }
      };
    }

    return null;
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

    return rpcOk(id, {
      connectionState: this.connectionState,
      source: this.lastDisconnect.source,
      previousConnectionId,
      ...cancelled,
      ...cancelledPolls
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
    return rpcOk(id, { origin, revoked });
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

    const warmCache = this.warmCacheHit(method, params, origin);
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
        files: upload.files
      });
      if (!extensionResponse.ok) {
        return rpcError(id, this.attachApprovalRequest(method, {
          origin,
          target: upload.target,
          ruleset: upload.ruleset,
          verifyPreview: upload.verifyPreview,
          files: upload.files
        }, extensionResponse.error));
      }
      if (shouldInvalidateWarmSession(method)) {
        this.clearWarmSessionCache(method);
      }
      return rpcOk(id, {
        ...extensionResponse.result,
        assetValidation: upload.assetValidation
      });
    }

    if (method === 'page.prepareCart') {
      const extensionResponse = await this.enqueueExtensionCommandWithPolicy(method, prepareCart.commandParams);
      if (!extensionResponse.ok) {
        return rpcError(id, this.attachApprovalRequest(method, prepareCart.commandParams, extensionResponse.error));
      }
      if (shouldInvalidateWarmSession(method)) {
        this.clearWarmSessionCache(method);
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
      const extensionResponse = await this.enqueueExtensionCommandWithPolicy(method, batch.commandParams);
      if (!extensionResponse.ok) {
        return rpcError(id, this.attachApprovalRequest(method, batch.commandParams, extensionResponse.error));
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
        this.clearWarmSessionCache(method);
      }
      return rpcOk(id, extensionResponse.result);
    }

    const extensionMethod = method === 'page.visualAnalyze' ? 'page.visualObserve' : method;
    const extensionResponse = await this.enqueueExtensionCommandWithPolicy(extensionMethod, {
      ...params,
      ...(target ? { url: target.url } : {}),
      origin
    });
    if (!extensionResponse.ok) {
      const error = this.remapNavigationSettlingError(method, origin, extensionResponse.error);
      return rpcError(id, this.attachApprovalRequest(method, { ...params, origin }, error));
    }
    if (shouldInvalidateWarmSession(method)) {
      this.clearWarmSessionCache(method);
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
        navigationOriginChange = {
          from: previousOrigin,
          to: origin,
          previousApprovalRevoked
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

    return rpcOk(id, {
      ...this.emergencyStop,
      ...cancelled
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
    const record = {
      approvalId,
      status: 'pending',
      method,
      origin: params.origin,
      params,
      approvalKind,
      targetSummary: error.targetSummary || null,
      createdAt: new Date().toISOString()
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

  approveApproval(id, params) {
    const record = this.approvalRecord(params);
    if (!record) {
      return rpcError(id, {
        code: ERROR_CODES.INVALID_REQUEST,
        message: 'Approval request not found.'
      });
    }
    if (record.status !== 'pending') {
      return rpcError(id, {
        code: ERROR_CODES.INVALID_REQUEST,
        message: `Approval request is ${record.status}.`
      });
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
    if (!record) {
      return rpcError(id, {
        code: ERROR_CODES.INVALID_REQUEST,
        message: 'Approval request not found.'
      });
    }
    if (record.status !== 'approved') {
      return rpcError(id, {
        code: ERROR_CODES.APPROVAL_REQUIRED,
        message: 'Approval request must be approved before replay.'
      });
    }

    const readiness = assertReadyForRealSiteAction({
      ...this.readinessStateForOrigin(record.origin),
      domainApproved: this.approvedOrigins.has(record.origin)
    });
    if (!readiness.ok) {
      return rpcError(id, readiness.error);
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

  enqueueExtensionCommand(method, params) {
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
