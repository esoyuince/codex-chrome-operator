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
        response = this.approveDomain(id, params.origin);
        break;
      case 'extension.hostPermissionGranted':
        response = this.hostPermissionGranted(id, params.origin);
        break;
      case 'page.observe':
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

  async routePageCommand(id, method, params) {
    const origin = params.origin || (params.url ? new URL(params.url).origin : undefined);
    const readiness = assertReadyForRealSiteAction({
      profileVerified: this.profileVerified,
      domainApproved: this.approvedOrigins.has(origin),
      hostPermissionGranted: this.hostPermissions.has(origin)
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
