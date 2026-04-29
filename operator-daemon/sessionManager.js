'use strict';

const os = require('node:os');
const path = require('node:path');
const {
  ERROR_CODES,
  validateHello,
  assertReadyForRealSiteAction
} = require('./protocol');
const { AuditLog } = require('./auditLog');
const {
  buildProfileSetupUrl,
  discoverChromeProfiles,
  generateProfileBindingId
} = require('./profileManager');
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
    'extension.hostPermissionGranted',
    'operator.profile.bind',
    'operator.profile.verify',
    'operator.profiles.discover',
    'extension.hostPermissionsSynced'
  ].includes(method) || method.startsWith('page.');
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
      auditLogPath: config.auditLogPath || defaultAuditPath(),
      token: config.token || process.env.CODEX_CHROME_OPERATOR_TOKEN || 'dev-token'
    };
    this.audit = new AuditLog(this.config.auditLogPath);
    this.connectionState = 'DAEMON_RUNNING_EXTENSION_DISCONNECTED';
    this.profileVerified = false;
    this.profileBindingStatus = 'unverified';
    this.approvedOrigins = new Set(Object.keys(this.stateStore.listDomainApprovals()));
    this.hostPermissions = new Set(this.activeHostPermissionOrigins());
    this.lastError = null;
    this.commandQueue = [];
    this.pendingCommands = new Map();
    this.nextCommandId = 1;
  }

  status() {
    return {
      connectionState: this.connectionState,
      profileVerified: this.profileVerified,
      profileBindingStatus: this.profileBindingStatus,
      approvedOrigins: [...this.approvedOrigins],
      hostPermissionOrigins: [...this.hostPermissions],
      domainApprovals: this.stateStore.listDomainApprovals(),
      configuredProfile: this.stateStore.getConfiguredProfile(),
      auditLogPath: this.config.auditLogPath,
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
        response = this.handleHello(id, params.hello);
        break;
      case 'operator.approveDomain':
        response = this.approveDomain(id, params);
        break;
      case 'extension.hostPermissionGranted':
        response = this.hostPermissionGranted(id, params);
        break;
      case 'extension.hostPermissionsSynced':
        response = this.hostPermissionsSynced(id, params);
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
      sessionId: 'daemon',
      requestId: id,
      method: request.method,
      params,
      result: response.ok ? 'ok' : 'error',
      errorCode: response.error && response.error.code
    });

    if (!response.ok) {
      this.lastError = response.error;
    } else if (clearsLastErrorOnSuccess(request.method)) {
      this.lastError = null;
    }

    return response;
  }

  handleHello(id, hello) {
    const result = validateHello(hello, {
      expectedExtensionId: this.config.expectedExtensionId,
      expectedProfileBindingId: this.config.expectedProfileBindingId,
      expectedProfileBindingVersion: this.config.expectedProfileBindingVersion,
      allowUnboundSetup: true,
      allowDevUnbound: true
    });

    if (!result.ok) {
      this.connectionState = 'DAEMON_RUNNING_EXTENSION_DISCONNECTED';
      this.profileVerified = false;
      this.profileBindingStatus = 'rejected';
      return rpcError(id, result.error);
    }

    this.profileBindingStatus = result.profileBindingStatus;
    this.profileVerified = result.profileBindingStatus === 'verified';
    this.connectionState = this.profileVerified
      ? 'EXTENSION_CONNECTED'
      : 'EXTENSION_CONNECTED_SETUP_ONLY';

    return rpcOk(id, {
      connectionState: this.connectionState,
      profileBindingStatus: this.profileBindingStatus
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
    this.approvedOrigins.add(origin);
    return rpcOk(id, { ...approval, approved: true });
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
    const domainApproved = this.approvedOrigins.has(origin);
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

  async routePageCommand(id, method, params) {
    const origin = params.origin || (params.url ? new URL(params.url).origin : undefined);
    const readiness = assertReadyForRealSiteAction({
      profileVerified: this.profileVerified,
      domainApproved: this.approvedOrigins.has(origin),
      hostPermissionGranted: this.hasHostPermission(origin)
    });

    if (!readiness.ok) {
      return rpcError(id, readiness.error);
    }

    const extensionResponse = await this.enqueueExtensionCommand(method, {
      ...params,
      origin
    });
    if (!extensionResponse.ok) {
      return rpcError(id, extensionResponse.error);
    }
    return rpcOk(id, extensionResponse.result);
  }

  enqueueExtensionCommand(method, params) {
    const commandId = `cmd_${this.nextCommandId++}`;
    const command = {
      type: 'command',
      commandId,
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
    const pending = this.pendingCommands.get(params.commandId);
    if (!pending) {
      return rpcError(id, {
        code: ERROR_CODES.INVALID_REQUEST,
        message: 'Unknown or expired command id.'
      });
    }

    clearTimeout(pending.timeout);
    this.pendingCommands.delete(params.commandId);
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
