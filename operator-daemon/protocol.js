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
  NAVIGATION_NOT_SETTLED: 'NAVIGATION_NOT_SETTLED',
  SITE_BLOCKED_BY_USER_SETTINGS: 'SITE_BLOCKED_BY_USER_SETTINGS',
  HOST_PERMISSION_REQUIRED: 'HOST_PERMISSION_REQUIRED',
  HOST_PERMISSION_NOT_GRANTED: 'HOST_PERMISSION_NOT_GRANTED',
  HOST_PERMISSION_REQUEST_REQUIRED: 'HOST_PERMISSION_REQUEST_REQUIRED',
  HOST_PERMISSION_REVOKED: 'HOST_PERMISSION_REVOKED',
  ACTIVE_TAB_GRANT_UNAVAILABLE: 'ACTIVE_TAB_GRANT_UNAVAILABLE',
  DEBUGGER_UNSUPPORTED_PAGE: 'DEBUGGER_UNSUPPORTED_PAGE',
  DEBUGGER_ACTION_FAILED: 'DEBUGGER_ACTION_FAILED',
  ACTION_PREFLIGHT_FAILED: 'ACTION_PREFLIGHT_FAILED',
  PROFILE_NOT_CONFIGURED: 'PROFILE_NOT_CONFIGURED',
  PROFILE_NOT_FOUND: 'PROFILE_NOT_FOUND',
  PROFILE_MISMATCH: 'PROFILE_MISMATCH',
  PROFILE_EXTENSION_NOT_INSTALLED: 'PROFILE_EXTENSION_NOT_INSTALLED',
  PROFILE_HOST_PERMISSION_MISSING: 'PROFILE_HOST_PERMISSION_MISSING',
  PROFILE_LOGIN_STATE_UNVERIFIED: 'PROFILE_LOGIN_STATE_UNVERIFIED',
  UNSUPPORTED_SCHEME: 'UNSUPPORTED_SCHEME',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  MANUAL_STEP_REQUIRED: 'MANUAL_STEP_REQUIRED',
  HIGH_RISK_BLOCKED: 'HIGH_RISK_BLOCKED',
  SENSITIVE_FORM_FILL_BLOCKED: 'SENSITIVE_FORM_FILL_BLOCKED',
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
  ASSET_FILE_MISSING: 'ASSET_FILE_MISSING',
  ASSET_FILE_UNREADABLE: 'ASSET_FILE_UNREADABLE',
  ASSET_SHA256_MISMATCH: 'ASSET_SHA256_MISMATCH',
  ASSET_UNSUPPORTED_TYPE: 'ASSET_UNSUPPORTED_TYPE',
  ASSET_DIMENSION_MISMATCH: 'ASSET_DIMENSION_MISMATCH',
  ASSET_ALPHA_POLICY_BLOCKED: 'ASSET_ALPHA_POLICY_BLOCKED',
  ASSET_TOO_LARGE: 'ASSET_TOO_LARGE',
  ASSET_UNKNOWN_ROLE: 'ASSET_UNKNOWN_ROLE',
  ASSET_UNKNOWN_RULESET: 'ASSET_UNKNOWN_RULESET',
  UPLOAD_TARGET_INVALID: 'UPLOAD_TARGET_INVALID',
  SITE_PROFILE_UNAVAILABLE: 'SITE_PROFILE_UNAVAILABLE',
  CART_CANDIDATE_NOT_FOUND: 'CART_CANDIDATE_NOT_FOUND',
  CART_RECHECK_FAILED: 'CART_RECHECK_FAILED',
  CHECKOUT_BLOCKED: 'CHECKOUT_BLOCKED',

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
    return fail(ERROR_CODES.EXTENSION_ID_MISMATCH, 'Extension id does not match configured extension.', {
      expectedExtensionId: options.expectedExtensionId,
      actualExtensionId: hello.extensionId
    });
  }

  if (options.expectedProtocolVersion && hello.protocolVersion !== options.expectedProtocolVersion) {
    return fail(ERROR_CODES.PROTOCOL_VERSION_MISMATCH, 'Protocol version does not match daemon.', {
      expectedProtocolVersion: options.expectedProtocolVersion,
      actualProtocolVersion: hello.protocolVersion
    });
  }

  if (options.expectedExtensionVersion && hello.extensionVersion !== options.expectedExtensionVersion) {
    return fail(ERROR_CODES.EXTENSION_VERSION_MISMATCH, 'Extension version does not match daemon.', {
      expectedExtensionVersion: options.expectedExtensionVersion,
      actualExtensionVersion: hello.extensionVersion
    });
  }

  if (options.expectedBridgeVersion && hello.bridgeVersion !== options.expectedBridgeVersion) {
    return fail(ERROR_CODES.BRIDGE_VERSION_MISMATCH, 'Bridge version does not match daemon.', {
      expectedBridgeVersion: options.expectedBridgeVersion,
      actualBridgeVersion: hello.bridgeVersion
    });
  }

  if (!Array.isArray(hello.capabilities) || hello.capabilities.length === 0) {
    return fail(ERROR_CODES.INVALID_SCHEMA, 'HELLO capabilities must be a non-empty array.');
  }

  const bindingState = hello.profileBindingState || 'not-required';
  if (!['not-required', 'missing', 'dev-unbound', 'bound'].includes(bindingState)) {
    return fail(ERROR_CODES.INVALID_SCHEMA, 'profileBindingState must be not-required, bound, missing, or dev-unbound.');
  }

  return ok({
    profileBindingStatus: 'not-required',
    profileVerificationMode: 'not-required',
    profileIdentityVerified: false
  });
}

function assertReadyForRealSiteAction(state) {
  if (!state.domainApproved) {
    return fail(ERROR_CODES.DOMAIN_NOT_APPROVED, 'Domain approval is required before action.');
  }
  if (state.siteBlocked) {
    return fail(
      ERROR_CODES.SITE_BLOCKED_BY_USER_SETTINGS,
      'Origin is blocked by user extension settings.',
      {
        origin: state.origin || null,
        blockedPattern: state.blockedPattern || null
      }
    );
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
