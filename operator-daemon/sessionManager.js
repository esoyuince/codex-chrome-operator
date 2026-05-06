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
    'operator.approvals.run'
  ].includes(method) || method.startsWith('page.');
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

class SessionManager {
  constructor(config = {}) {
    this.stateStore = config.stateStore || new OperatorStateStore({ statePath: config.statePath });
    this.config = {
      expectedExtensionId: config.expectedExtensionId || 'development-extension-id',
      expectedProtocolVersion: config.expectedProtocolVersion || '1.0',
      expectedExtensionVersion: config.expectedExtensionVersion || '0.2.11',
      expectedBridgeVersion: config.expectedBridgeVersion || '0.2.11',
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
      domainApprovals: this.stateStore.listDomainApprovals(),
      configuredProfile: this.stateStore.getConfiguredProfile(),
      pendingApprovals: this.listApprovalRecords({ status: 'pending' }),
      activeTab: this.activeTab ? { ...this.activeTab } : null,
      warmSession: this.warmSessionStatus(),
      recentEvents: this.recentEvents.map((event) => cloneJson(event)),
      recentActionLog: this.recentEvents.map((event) => cloneJson(event)),
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
      warmSession: { ...fullStatus.warmSession },
      pendingApprovalCount: fullStatus.pendingApprovals.length,
      emergencyStop: { ...fullStatus.emergencyStop },
      boundedFullAuto: this.compactBoundedFullAutoStatus(fullStatus.boundedFullAuto),
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
      params,
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
    const origin = params && params.origin;
    if (!origin || typeof origin !== 'string') {
      return rpcError(id, {
        code: ERROR_CODES.INVALID_SCHEMA,
        message: 'origin is required.'
      });
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
    const origin = params && params.origin;
    if (!origin || typeof origin !== 'string') {
      return rpcError(id, {
        code: ERROR_CODES.INVALID_SCHEMA,
        message: 'origin is required.'
      });
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
    const origin = params && params.origin;
    if (!origin || typeof origin !== 'string') {
      return rpcError(id, {
        code: ERROR_CODES.INVALID_SCHEMA,
        message: 'origin is required.'
      });
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

    this.stateStore.syncHostPermissions({
      origins: params.origins,
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

      const extensionResponse = await this.enqueueExtensionCommand(method, {
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
      const extensionResponse = await this.enqueueExtensionCommand(method, prepareCart.commandParams);
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
      const extensionResponse = await this.enqueueExtensionCommand(method, batch.commandParams);
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
    const extensionResponse = await this.enqueueExtensionCommand(extensionMethod, {
      ...params,
      ...(target ? { url: target.url } : {}),
      origin
    });
    if (!extensionResponse.ok) {
      return rpcError(id, this.attachApprovalRequest(method, { ...params, origin }, extensionResponse.error));
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
    if (!isLocalMockOrigin(record.origin)) {
      return rpcError(id, {
        code: ERROR_CODES.HIGH_RISK_BLOCKED,
        message: 'M1 manual approval replay is enabled only for local mock origins.'
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
