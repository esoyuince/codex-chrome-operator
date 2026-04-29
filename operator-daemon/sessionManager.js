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
  buildProfileSetupUrl,
  discoverChromeProfiles,
  generateProfileBindingId
} = require('./profileManager');
const {
  ScreenshotStore,
  defaultScreenshotDir
} = require('./screenshotStore');
const { OperatorStateStore } = require('./stateStore');

function defaultAuditPath() {
  return path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'CodexChromeOperator',
    'audit',
    'audit.jsonl'
  );
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
    'operator.profile.bind',
    'operator.profile.verify',
    'operator.profiles.discover',
    'extension.hostPermissionsSynced',
    'operator.screenshots.cleanup',
    'operator.emergencyStop',
    'operator.emergencyClear',
    'operator.fullAuto.start',
    'operator.fullAuto.stop',
    'operator.fullAuto.status',
    'operator.audit.tail',
    'operator.approvals.approve',
    'operator.approvals.reject',
    'operator.approvals.run'
  ].includes(method) || method.startsWith('page.');
}

const PAGE_ACTION_KINDS = Object.freeze({
  'page.observe': 'observe',
  'page.visualObserve': 'screenshot',
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

function isLocalMockOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function makeConnectionId() {
  return `conn_${Date.now()}_${Math.random().toString(16).slice(2)}`;
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

function isBoundedFullAutoError(error) {
  return Boolean(error && typeof error.code === 'string' && error.code.startsWith('BOUNDED_FULL_AUTO_'));
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

class SessionManager {
  constructor(config = {}) {
    this.stateStore = config.stateStore || new OperatorStateStore({ statePath: config.statePath });
    const configuredProfile = this.stateStore.getConfiguredProfile();
    this.config = {
      expectedExtensionId: config.expectedExtensionId || 'development-extension-id',
      expectedProfileBindingId: (configuredProfile && configuredProfile.profileBindingId)
        || config.expectedProfileBindingId
        || 'profbind_developmentBinding01',
      expectedProfileBindingVersion: (configuredProfile && configuredProfile.profileBindingVersion)
        || config.expectedProfileBindingVersion
        || 1,
      expectedProtocolVersion: config.expectedProtocolVersion || '1.0',
      expectedExtensionVersion: config.expectedExtensionVersion || '0.1.0',
      expectedBridgeVersion: config.expectedBridgeVersion || '0.1.0',
      auditLogPath: config.auditLogPath || defaultAuditPath(),
      screenshotDir: config.screenshotDir || defaultScreenshotDir(),
      token: config.token || process.env.CODEX_CHROME_OPERATOR_TOKEN || 'dev-token'
    };
    this.audit = new AuditLog(this.config.auditLogPath);
    this.screenshotStore = config.screenshotStore || new ScreenshotStore({
      rootDir: this.config.screenshotDir
    });
    this.connectionState = 'DAEMON_RUNNING_EXTENSION_DISCONNECTED';
    this.profileVerified = false;
    this.profileBindingStatus = 'unverified';
    this.connectionId = null;
    this.lastDisconnect = null;
    this.reconnectCount = 0;
    this.approvedOrigins = new Set(this.activeDomainApprovalOrigins());
    this.hostPermissions = new Set(this.activeHostPermissionOrigins());
    this.lastError = null;
    this.commandQueue = [];
    this.pendingCommands = new Map();
    this.nextCommandId = 1;
    this.pendingApprovals = new Map();
    this.nextApprovalId = 1;
    this.lastVersionMismatch = null;
    this.activeTab = null;
    this.emergencyStop = {
      active: false,
      reason: null,
      stoppedAt: null,
      clearedAt: null
    };
    this.boundedFullAuto = this.defaultBoundedFullAutoState();
  }

  status() {
    return {
      connectionState: this.connectionState,
      connectionId: this.connectionId,
      lastDisconnect: this.lastDisconnect,
      reconnectCount: this.reconnectCount,
      profileVerified: this.profileVerified,
      profileBindingStatus: this.profileBindingStatus,
      approvedOrigins: this.activeDomainApprovalOrigins(),
      hostPermissionOrigins: [...this.hostPermissions],
      domainApprovals: this.stateStore.listDomainApprovals(),
      configuredProfile: this.stateStore.getConfiguredProfile(),
      pendingApprovals: this.listApprovalRecords({ status: 'pending' }),
      activeTab: this.activeTab ? { ...this.activeTab } : null,
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
  }

  async handleRpc(request) {
    const id = request && request.id;
    if (!request || typeof request.method !== 'string') {
      return rpcError(id || null, {
        code: ERROR_CODES.INVALID_REQUEST,
        message: 'RPC request must include method.'
      });
    }

    const params = request.params || {};
    let response;

    switch (request.method) {
      case 'operator.status':
        response = rpcOk(id, this.status());
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
      case 'extension.activeTabUpdated':
        response = this.activeTabUpdated(id, params);
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
      case 'page.visualObserve':
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
        response = this.pollBridge(id);
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

    return response;
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
    const result = validateHello(hello, {
      expectedExtensionId: this.config.expectedExtensionId,
      expectedProtocolVersion: this.config.expectedProtocolVersion,
      expectedExtensionVersion: this.config.expectedExtensionVersion,
      expectedBridgeVersion: this.config.expectedBridgeVersion,
      expectedProfileBindingId: this.config.expectedProfileBindingId,
      expectedProfileBindingVersion: this.config.expectedProfileBindingVersion,
      allowUnboundSetup: true,
      allowDevUnbound: true
    });

    if (!result.ok) {
      this.connectionState = 'DAEMON_RUNNING_EXTENSION_DISCONNECTED';
      this.profileVerified = false;
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
    this.profileVerified = result.profileBindingStatus === 'verified';
    const previousState = this.connectionState;
    this.connectionId = makeConnectionId();
    if (previousState === 'RECONNECTING') {
      this.reconnectCount += 1;
    }
    this.connectionState = this.profileVerified
      ? 'EXTENSION_CONNECTED'
      : 'EXTENSION_CONNECTED_SETUP_ONLY';
    this.updateActiveTab(params.activeTab || null);

    return rpcOk(id, {
      connectionState: this.connectionState,
      connectionId: this.connectionId,
      profileBindingStatus: this.profileBindingStatus
    });
  }

  activeTabUpdated(id, params = {}) {
    this.updateActiveTab(params.activeTab || params.tab || null);
    return rpcOk(id, {
      activeTab: this.activeTab ? { ...this.activeTab } : null
    });
  }

  updateActiveTab(tab) {
    const normalized = normalizeActiveTab(tab);
    if (normalized) {
      this.activeTab = normalized;
    }
    return this.activeTab;
  }

  handleDisconnected(id, params = {}) {
    const previousConnectionId = this.connectionId;
    this.connectionState = 'RECONNECTING';
    this.profileVerified = false;
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

    return rpcOk(id, {
      connectionState: this.connectionState,
      source: this.lastDisconnect.source,
      previousConnectionId,
      ...cancelled
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
    const origin = params && params.origin;
    if (!origin || typeof origin !== 'string') {
      return rpcError(id, {
        code: ERROR_CODES.INVALID_SCHEMA,
        message: 'origin is required.'
      });
    }
    this.stateStore.grantHostPermission(origin, {
      profileBindingId: params.profileBindingId || this.config.expectedProfileBindingId,
      grantedAt: params.grantedAt
    });
    this.hostPermissions = new Set(this.activeHostPermissionOrigins());
    return rpcOk(id, { origin, hostPermissionGranted: true });
  }

  hostPermissionsSynced(id, params) {
    if (!Array.isArray(params.origins)) {
      return rpcError(id, {
        code: ERROR_CODES.INVALID_SCHEMA,
        message: 'origins array is required.'
      });
    }

    const profileBindingId = params.profileBindingId || this.config.expectedProfileBindingId;
    this.stateStore.syncHostPermissions({
      profileBindingId,
      origins: params.origins,
      syncedAt: params.syncedAt
    });
    this.hostPermissions = new Set(this.activeHostPermissionOrigins());

    return rpcOk(id, {
      profileBindingId,
      hostPermissionOrigins: [...this.hostPermissions]
    });
  }

  activeHostPermissionOrigins() {
    return Object.keys(this.stateStore.listHostPermissions())
      .filter((origin) => this.hasHostPermission(origin));
  }

  hasHostPermission(origin) {
    const permission = this.stateStore.getHostPermission(origin);
    if (!permission) {
      return false;
    }

    const configuredProfile = this.stateStore.getConfiguredProfile();
    const expectedProfileBindingId = configuredProfile
      ? configuredProfile.profileBindingId
      : this.config.expectedProfileBindingId;

    return permission.profileBindingId === expectedProfileBindingId;
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

    const profileBindingId = params.profileBindingId || generateProfileBindingId();
    const profileBindingVersion = params.profileBindingVersion || 1;
    const configuredProfile = this.stateStore.setConfiguredProfile({
      userDataDir: params.userDataDir,
      profileDirectory: params.profileDirectory,
      profileLabel: params.profileLabel,
      profileBindingId,
      profileBindingVersion
    });

    this.config.expectedProfileBindingId = profileBindingId;
    this.config.expectedProfileBindingVersion = profileBindingVersion;
    this.profileVerified = false;
    this.profileBindingStatus = 'binding-pending';
    this.connectionState = 'EXTENSION_CONNECTED_SETUP_ONLY';
    this.hostPermissions = new Set(this.activeHostPermissionOrigins());

    return rpcOk(id, {
      ...configuredProfile,
      setupUrl: buildProfileSetupUrl({
        extensionId: this.config.expectedExtensionId,
        profileBindingId,
        profileBindingVersion
      })
    });
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
      profileBindingStatus: this.profileBindingStatus,
      connectionState: this.connectionState
    });
  }

  verifyReadiness(id, params) {
    const origin = params.origin || (params.url ? new URL(params.url).origin : undefined);
    const profileVerified = this.profileVerified;
    const domainApproved = this.hasDomainApproval(origin);
    const hostPermissionGranted = this.hasHostPermission(origin);
    const readiness = assertReadyForRealSiteAction({
      profileVerified,
      domainApproved,
      hostPermissionGranted
    });
    const missing = [];
    if (!profileVerified) {
      missing.push('profile');
    }
    if (!domainApproved) {
      missing.push('domainApproval');
    }
    if (!hostPermissionGranted) {
      missing.push('hostPermission');
    }
    return rpcOk(id, {
      origin,
      ready: readiness.ok,
      profileVerified,
      domainApproved,
      hostPermissionGranted,
      missing,
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

    if (
      contract.profileBindingId &&
      contract.profileBindingId !== this.config.expectedProfileBindingId
    ) {
      return rpcError(id, {
        code: ERROR_CODES.BOUNDED_FULL_AUTO_PROFILE_MISMATCH,
        message: 'Bounded Full Auto contract profile binding does not match configured profile.',
        expectedProfileBindingId: this.config.expectedProfileBindingId,
        actualProfileBindingId: contract.profileBindingId
      });
    }

    if (
      contract.profileBindingVersion !== undefined &&
      contract.profileBindingVersion !== this.config.expectedProfileBindingVersion
    ) {
      return rpcError(id, {
        code: ERROR_CODES.BOUNDED_FULL_AUTO_PROFILE_MISMATCH,
        message: 'Bounded Full Auto contract profile binding version does not match configured profile.',
        expectedProfileBindingVersion: this.config.expectedProfileBindingVersion,
        actualProfileBindingVersion: contract.profileBindingVersion
      });
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

    const origin = params.origin || (params.url ? new URL(params.url).origin : undefined);
    const readiness = assertReadyForRealSiteAction({
      profileVerified: this.profileVerified,
      domainApproved: this.hasDomainApproval(origin),
      hostPermissionGranted: this.hasHostPermission(origin)
    });

    if (!readiness.ok) {
      return rpcError(id, readiness.error);
    }

    const boundedFullAuto = this.enforceBoundedFullAuto(method, origin);
    if (!boundedFullAuto.ok) {
      return rpcError(id, boundedFullAuto.error);
    }

    const extensionResponse = await this.enqueueExtensionCommand(method, {
      ...params,
      origin
    });
    if (!extensionResponse.ok) {
      return rpcError(id, this.attachApprovalRequest(method, { ...params, origin }, extensionResponse.error));
    }
    if (method === 'page.visualObserve') {
      const materialized = this.materializeVisualObservation(extensionResponse.result, origin);
      if (!materialized.ok) {
        return rpcError(id, materialized.error);
      }
      return rpcOk(id, materialized.result);
    }
    return rpcOk(id, extensionResponse.result);
  }

  materializeVisualObservation(result, origin) {
    const screenshot = result && result.screenshot;
    if (!screenshot || !screenshot.dataUrl) {
      return rpcOk(null, result);
    }

    try {
      const { dataUrl, ...screenshotSummary } = screenshot;
      const artifact = this.screenshotStore.saveDataUrl({
        dataUrl,
        origin,
        reason: 'visualObserve'
      });
      return rpcOk(null, {
        ...result,
        visual: {
          ...(result.visual || {}),
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
      ERROR_CODES.APPROVAL_REQUIRED
    ].includes(error.code)) {
      return error;
    }

    const approvalId = `approval_${this.nextApprovalId++}`;
    const record = {
      approvalId,
      status: 'pending',
      method,
      origin: params.origin,
      params,
      approvalKind: error.approvalKind || 'high-risk-action',
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
      profileVerified: this.profileVerified,
      domainApproved: this.approvedOrigins.has(record.origin),
      hostPermissionGranted: this.hasHostPermission(record.origin)
    });
    if (!readiness.ok) {
      return rpcError(id, readiness.error);
    }

    record.status = 'running';
    const extensionResponse = await this.enqueueExtensionCommand(record.method, {
      ...record.params,
      approval: {
        approvalId: record.approvalId,
        allowHighRisk: true,
        approvalKind: record.approvalKind
      }
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
    this.commandQueue.push(command);

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
      }, 30000);

      this.pendingCommands.set(commandId, {
        resolve,
        timeout
      });
    });
  }

  pollBridge(id) {
    return rpcOk(id, {
      command: this.commandQueue.shift() || null
    });
  }

  deliverBridgeResponse(id, params) {
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
