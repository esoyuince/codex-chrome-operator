'use strict';

const ERROR_CODES = Object.freeze({
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_INVALID: 'AUTH_INVALID',
  CSRF_REJECTED: 'CSRF_REJECTED',
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_SCHEMA: 'INVALID_SCHEMA',
  UNKNOWN_METHOD: 'UNKNOWN_METHOD',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  BODY_TOO_LARGE: 'BODY_TOO_LARGE',
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  EMERGENCY_STOPPED: 'EMERGENCY_STOPPED',

  EXTENSION_NOT_INSTALLED: 'EXTENSION_NOT_INSTALLED',
  EXTENSION_DISABLED_OR_UNREACHABLE: 'EXTENSION_DISABLED_OR_UNREACHABLE',
  EXTENSION_ID_MISMATCH: 'EXTENSION_ID_MISMATCH',
  PROTOCOL_VERSION_MISMATCH: 'PROTOCOL_VERSION_MISMATCH',
  EXTENSION_VERSION_MISMATCH: 'EXTENSION_VERSION_MISMATCH',
  BRIDGE_VERSION_MISMATCH: 'BRIDGE_VERSION_MISMATCH',
  NATIVE_HOST_NOT_REGISTERED: 'NATIVE_HOST_NOT_REGISTERED',
  NATIVE_BRIDGE_FAILED: 'NATIVE_BRIDGE_FAILED',
  BRIDGE_DISCONNECTED: 'BRIDGE_DISCONNECTED',
  EXTENSION_DISCONNECTED: 'EXTENSION_DISCONNECTED',
  BOOTSTRAP_TIMEOUT: 'BOOTSTRAP_TIMEOUT',
  CHROME_NOT_FOUND: 'CHROME_NOT_FOUND',
  CHROME_LAUNCH_FAILED: 'CHROME_LAUNCH_FAILED',

  NO_ACTIVE_TAB: 'NO_ACTIVE_TAB',
  DOMAIN_NOT_APPROVED: 'DOMAIN_NOT_APPROVED',
  HOST_PERMISSION_REQUIRED: 'HOST_PERMISSION_REQUIRED',
  HOST_PERMISSION_NOT_GRANTED: 'HOST_PERMISSION_NOT_GRANTED',
  HOST_PERMISSION_REQUEST_REQUIRED: 'HOST_PERMISSION_REQUEST_REQUIRED',
  HOST_PERMISSION_REVOKED: 'HOST_PERMISSION_REVOKED',
  ACTIVE_TAB_GRANT_UNAVAILABLE: 'ACTIVE_TAB_GRANT_UNAVAILABLE',
  PROFILE_NOT_CONFIGURED: 'PROFILE_NOT_CONFIGURED',
  PROFILE_NOT_FOUND: 'PROFILE_NOT_FOUND',
  PROFILE_MISMATCH: 'PROFILE_MISMATCH',
  PROFILE_BINDING_MISSING: 'PROFILE_BINDING_MISSING',
  PROFILE_BINDING_VERSION_MISMATCH: 'PROFILE_BINDING_VERSION_MISMATCH',
  PROFILE_BINDING_STALE: 'PROFILE_BINDING_STALE',
  PROFILE_EXTENSION_NOT_INSTALLED: 'PROFILE_EXTENSION_NOT_INSTALLED',
  PROFILE_HOST_PERMISSION_MISSING: 'PROFILE_HOST_PERMISSION_MISSING',
  PROFILE_LOGIN_STATE_UNVERIFIED: 'PROFILE_LOGIN_STATE_UNVERIFIED',
  UNSUPPORTED_SCHEME: 'UNSUPPORTED_SCHEME',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  MANUAL_STEP_REQUIRED: 'MANUAL_STEP_REQUIRED',
  HIGH_RISK_BLOCKED: 'HIGH_RISK_BLOCKED',
  PASSWORD_REQUIRED: 'PASSWORD_REQUIRED',
  OTP_REQUIRED: 'OTP_REQUIRED',
  WEBAUTHN_REQUIRED: 'WEBAUTHN_REQUIRED',
  CAPTCHA_REQUIRED: 'CAPTCHA_REQUIRED',
  PERMISSION_PROMPT_REQUIRED: 'PERMISSION_PROMPT_REQUIRED',
  PAYMENT_AUTH_REQUIRED: 'PAYMENT_AUTH_REQUIRED',
  IDENTITY_VERIFICATION_REQUIRED: 'IDENTITY_VERIFICATION_REQUIRED',
  ANTI_ABUSE_CHALLENGE_REQUIRED: 'ANTI_ABUSE_CHALLENGE_REQUIRED',
  ACCOUNT_SECURITY_REAUTH_REQUIRED: 'ACCOUNT_SECURITY_REAUTH_REQUIRED',

  VISUAL_ANALYSIS_UNAVAILABLE: 'VISUAL_ANALYSIS_UNAVAILABLE',
  VISUAL_PROVIDER_NOT_CONFIGURED: 'VISUAL_PROVIDER_NOT_CONFIGURED',
  VISUAL_PROVIDER_POLICY_BLOCKED: 'VISUAL_PROVIDER_POLICY_BLOCKED',
  VISUAL_ARTIFACT_TOO_LARGE: 'VISUAL_ARTIFACT_TOO_LARGE',
  VISUAL_EXTERNAL_ANALYSIS_DISABLED: 'VISUAL_EXTERNAL_ANALYSIS_DISABLED',
  VISUAL_CONFIDENCE_TOO_LOW: 'VISUAL_CONFIDENCE_TOO_LOW',
  VISUAL_AMBIGUITY: 'VISUAL_AMBIGUITY',

  FULL_AUTO_DISABLED: 'FULL_AUTO_DISABLED',
  FULL_AUTO_LIMIT_EXCEEDED: 'FULL_AUTO_LIMIT_EXCEEDED',
  BOUNDED_FULL_AUTO_DISABLED: 'BOUNDED_FULL_AUTO_DISABLED',
  BOUNDED_FULL_AUTO_SCOPE_MISMATCH: 'BOUNDED_FULL_AUTO_SCOPE_MISMATCH',
  BOUNDED_FULL_AUTO_LIMIT_EXCEEDED: 'BOUNDED_FULL_AUTO_LIMIT_EXCEEDED',
  BOUNDED_FULL_AUTO_ACTION_NOT_ALLOWED: 'BOUNDED_FULL_AUTO_ACTION_NOT_ALLOWED',
  BOUNDED_FULL_AUTO_EXPIRED: 'BOUNDED_FULL_AUTO_EXPIRED',
  BOUNDED_FULL_AUTO_PROFILE_MISMATCH: 'BOUNDED_FULL_AUTO_PROFILE_MISMATCH',
  PROMPT_INJECTION_RISK: 'PROMPT_INJECTION_RISK'
});

const HIGH_IMPACT_ACTIONS = new Set([
  'checkout',
  'payment',
  'order-placement',
  'subscription-start',
  'publish',
  'send-for-review',
  'release',
  'rollout',
  'production-deploy',
  'delete',
  'account-security',
  'permission-grant',
  'legal-tax-identity',
  'auth-gate-bypass',
  'secret-reveal',
  'secret-rotate'
]);

function ok(extra = {}) {
  return { ok: true, ...extra };
}

function fail(code, message, extra = {}) {
  return {
    ok: false,
    error: {
      code,
      message,
      ...extra
    }
  };
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateHello(hello, options = {}) {
  if (!isObject(hello)) {
    return fail(ERROR_CODES.INVALID_SCHEMA, 'HELLO must be an object.');
  }

  const required = [
    'type',
    'protocolVersion',
    'extensionId',
    'extensionVersion',
    'bridgeVersion',
    'sessionBootstrapId',
    'profileBindingState',
    'profileBindingSource',
    'capabilities'
  ];

  for (const key of required) {
    if (!hasValue(hello[key])) {
      return fail(ERROR_CODES.INVALID_SCHEMA, `HELLO missing required field: ${key}`);
    }
  }

  if (hello.type !== 'HELLO') {
    return fail(ERROR_CODES.INVALID_SCHEMA, 'HELLO type must be HELLO.');
  }

  if (options.expectedExtensionId && hello.extensionId !== options.expectedExtensionId) {
    return fail(ERROR_CODES.EXTENSION_ID_MISMATCH, 'Extension id does not match configured extension.');
  }

  if (options.expectedProtocolVersion && hello.protocolVersion !== options.expectedProtocolVersion) {
    return fail(ERROR_CODES.PROTOCOL_VERSION_MISMATCH, 'Protocol version does not match daemon.');
  }

  if (options.expectedExtensionVersion && hello.extensionVersion !== options.expectedExtensionVersion) {
    return fail(ERROR_CODES.EXTENSION_VERSION_MISMATCH, 'Extension version does not match daemon.');
  }

  if (options.expectedBridgeVersion && hello.bridgeVersion !== options.expectedBridgeVersion) {
    return fail(ERROR_CODES.BRIDGE_VERSION_MISMATCH, 'Bridge version does not match daemon.');
  }

  if (!Array.isArray(hello.capabilities) || hello.capabilities.length === 0) {
    return fail(ERROR_CODES.INVALID_SCHEMA, 'HELLO capabilities must be a non-empty array.');
  }

  if (hello.profileBindingSource !== 'chrome.storage.local') {
    return fail(ERROR_CODES.INVALID_SCHEMA, 'profileBindingSource must be chrome.storage.local.');
  }

  if (hello.profileBindingState === 'missing') {
    if (hasValue(hello.profileBindingId) || hasValue(hello.profileBindingVersion)) {
      return fail(ERROR_CODES.INVALID_SCHEMA, 'Unbound setup HELLO must omit profile binding id and version.');
    }
    if (!options.allowUnboundSetup) {
      return fail(ERROR_CODES.PROFILE_BINDING_MISSING, 'Profile binding is required for production work.');
    }
    return ok({ profileBindingStatus: 'setup-unbound' });
  }

  if (hello.profileBindingState === 'dev-unbound') {
    if (hasValue(hello.profileBindingId) || hasValue(hello.profileBindingVersion)) {
      return fail(ERROR_CODES.INVALID_SCHEMA, 'Dev-unbound HELLO must omit profile binding id and version.');
    }
    if (!options.allowDevUnbound) {
      return fail(ERROR_CODES.PROFILE_BINDING_MISSING, 'Dev-unbound profile binding is disabled.');
    }
    return ok({ profileBindingStatus: 'dev-unbound' });
  }

  if (hello.profileBindingState !== 'bound') {
    return fail(ERROR_CODES.INVALID_SCHEMA, 'profileBindingState must be bound, missing, or dev-unbound.');
  }

  if (!hasValue(hello.profileBindingId) || !hasValue(hello.profileBindingVersion)) {
    return fail(ERROR_CODES.PROFILE_BINDING_MISSING, 'Bound HELLO requires profile binding id and version.');
  }

  if (
    options.expectedProfileBindingId &&
    hello.profileBindingId !== options.expectedProfileBindingId
  ) {
    return fail(ERROR_CODES.PROFILE_MISMATCH, 'Profile binding id does not match configured profile.');
  }

  if (options.expectedProfileBindingVersion !== undefined) {
    if (hello.profileBindingVersion < options.expectedProfileBindingVersion) {
      return fail(ERROR_CODES.PROFILE_BINDING_STALE, 'Profile binding version is stale.');
    }
    if (hello.profileBindingVersion !== options.expectedProfileBindingVersion) {
      return fail(
        ERROR_CODES.PROFILE_BINDING_VERSION_MISMATCH,
        'Profile binding version does not match configured profile.'
      );
    }
  }

  return ok({ profileBindingStatus: 'verified' });
}

function assertReadyForRealSiteAction(state) {
  if (!state || !state.profileVerified) {
    return fail(ERROR_CODES.PROFILE_BINDING_MISSING, 'Profile binding must be verified first.');
  }
  if (!state.domainApproved) {
    return fail(ERROR_CODES.DOMAIN_NOT_APPROVED, 'Domain approval is required before action.');
  }
  if (!state.hostPermissionGranted) {
    return fail(ERROR_CODES.HOST_PERMISSION_REQUIRED, 'Chrome host permission is required before action.');
  }
  return ok();
}

function validateBoundedFullAutoContract(contract) {
  if (!isObject(contract)) {
    return fail(ERROR_CODES.INVALID_SCHEMA, 'Bounded Full Auto contract must be an object.');
  }
  if (contract.mode !== 'bounded-full-auto-v1') {
    return fail(ERROR_CODES.BOUNDED_FULL_AUTO_DISABLED, 'Only bounded-full-auto-v1 is supported.');
  }
  if (!Array.isArray(contract.approvedOrigins) || contract.approvedOrigins.length === 0) {
    return fail(ERROR_CODES.BOUNDED_FULL_AUTO_SCOPE_MISMATCH, 'At least one approved origin is required.');
  }
  if (!contract.taskScope || typeof contract.taskScope !== 'string') {
    return fail(ERROR_CODES.BOUNDED_FULL_AUTO_SCOPE_MISMATCH, 'Task scope is required.');
  }
  if (!contract.auditRequired || !contract.emergencyStopRequired) {
    return fail(ERROR_CODES.INVALID_SCHEMA, 'Audit and emergency stop are required.');
  }

  const allowed = Array.isArray(contract.allowedActionKinds)
    ? contract.allowedActionKinds
    : [];
  for (const action of allowed) {
    if (HIGH_IMPACT_ACTIONS.has(action)) {
      return fail(
        ERROR_CODES.BOUNDED_FULL_AUTO_ACTION_NOT_ALLOWED,
        `High-impact action is not allowed in Bounded Full Auto v1: ${action}`
      );
    }
  }

  const limits = isObject(contract.limits) ? contract.limits : {};
  if (!Number.isFinite(limits.expiresInMinutes) || limits.expiresInMinutes <= 0) {
    return fail(ERROR_CODES.BOUNDED_FULL_AUTO_LIMIT_EXCEEDED, 'A positive expiry limit is required.');
  }

  return ok();
}

module.exports = {
  ERROR_CODES,
  validateHello,
  assertReadyForRealSiteAction,
  validateBoundedFullAutoContract
};
