'use strict';

const os = require('node:os');
const path = require('node:path');
const {
  ERROR_CODES,
  validateHello,
  assertReadyForRealSiteAction
} = require('./protocol');
const { AuditLog } = require('./auditLog');

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

class SessionManager {
  constructor(config = {}) {
    this.config = {
      expectedExtensionId: config.expectedExtensionId || 'development-extension-id',
      expectedProfileBindingId: config.expectedProfileBindingId || 'profbind_developmentBinding01',
      expectedProfileBindingVersion: config.expectedProfileBindingVersion || 1,
      auditLogPath: config.auditLogPath || defaultAuditPath(),
      token: config.token || process.env.CODEX_CHROME_OPERATOR_TOKEN || 'dev-token'
    };
    this.audit = new AuditLog(this.config.auditLogPath);
    this.connectionState = 'DAEMON_RUNNING_EXTENSION_DISCONNECTED';
    this.profileVerified = false;
    this.profileBindingStatus = 'unverified';
    this.approvedOrigins = new Set();
    this.hostPermissions = new Set();
    this.lastError = null;
  }

  status() {
    return {
      connectionState: this.connectionState,
      profileVerified: this.profileVerified,
      profileBindingStatus: this.profileBindingStatus,
      approvedOrigins: [...this.approvedOrigins],
      hostPermissionOrigins: [...this.hostPermissions],
      auditLogPath: this.config.auditLogPath,
      lastError: this.lastError
    };
  }

  handleRpc(request) {
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
        response = this.approveDomain(id, params.origin);
        break;
      case 'extension.hostPermissionGranted':
        response = this.hostPermissionGranted(id, params.origin);
        break;
      case 'page.observe':
        response = this.observe(id, params);
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

  approveDomain(id, origin) {
    if (!origin || typeof origin !== 'string') {
      return rpcError(id, {
        code: ERROR_CODES.INVALID_SCHEMA,
        message: 'origin is required.'
      });
    }
    this.approvedOrigins.add(origin);
    return rpcOk(id, { origin, approved: true });
  }

  hostPermissionGranted(id, origin) {
    if (!origin || typeof origin !== 'string') {
      return rpcError(id, {
        code: ERROR_CODES.INVALID_SCHEMA,
        message: 'origin is required.'
      });
    }
    this.hostPermissions.add(origin);
    return rpcOk(id, { origin, hostPermissionGranted: true });
  }

  observe(id, params) {
    const origin = params.origin;
    const readiness = assertReadyForRealSiteAction({
      profileVerified: this.profileVerified,
      domainApproved: this.approvedOrigins.has(origin),
      hostPermissionGranted: this.hostPermissions.has(origin)
    });

    if (!readiness.ok) {
      return rpcError(id, readiness.error);
    }

    return rpcOk(id, {
      origin,
      title: null,
      url: null,
      elements: [],
      note: 'Extension observation routing is ready for M1.'
    });
  }
}

module.exports = {
  SessionManager,
  defaultAuditPath
};
