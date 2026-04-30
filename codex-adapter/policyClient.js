'use strict';

const POLICY_ERROR_CODES = new Set([
  'HOST_PERMISSION_REQUIRED',
  'HOST_PERMISSION_NOT_GRANTED',
  'HOST_PERMISSION_REQUEST_REQUIRED',
  'DOMAIN_NOT_APPROVED',
  'PROFILE_NOT_CONFIGURED',
  'PROFILE_MISMATCH',
  'PROFILE_BINDING_MISSING',
  'PROFILE_BINDING_VERSION_MISMATCH',
  'PROFILE_BINDING_STALE',
  'EXTENSION_DISCONNECTED',
  'EMERGENCY_STOPPED',
  'CHECKOUT_BLOCKED',
  'SITE_PROFILE_UNAVAILABLE',
  'BOUNDED_FULL_AUTO_ACTION_NOT_ALLOWED'
]);

const PROFILE_ERROR_CODES = new Set([
  'PROFILE_NOT_CONFIGURED',
  'PROFILE_MISMATCH',
  'PROFILE_BINDING_MISSING',
  'PROFILE_BINDING_VERSION_MISMATCH',
  'PROFILE_BINDING_STALE'
]);

const STOP_ONLY_ERROR_CODES = new Set([
  'CHECKOUT_BLOCKED',
  'SITE_PROFILE_UNAVAILABLE',
  'BOUNDED_FULL_AUTO_ACTION_NOT_ALLOWED'
]);

function originArguments(origin) {
  return origin ? { origin } : {};
}

function hostPermissionActions(error) {
  const actions = [];
  if (error.permissionUrl) {
    actions.push({
      kind: 'open-permission-page',
      permissionUrl: error.permissionUrl,
      requiresUserGesture: true
    });
  } else {
    actions.push({
      kind: 'prepare-origin',
      origin: error.origin || null,
      operatorCli: error.origin ? ['prepare-origin', error.origin] : null,
      toolName: error.origin ? 'codex_chrome_prepare_origin' : null,
      arguments: error.origin ? { origin: error.origin } : null,
      requiresUserGesture: true
    });
  }
  actions.push(
    {
      kind: 'wait-for-user-grant',
      origin: error.origin || null,
      requiresUserGesture: true
    },
    {
      kind: 'retry-tool',
      origin: error.origin || null,
      toolName: error.origin ? 'codex_chrome_readiness' : null,
      arguments: error.origin ? { origin: error.origin } : null,
      requiresFreshReadiness: true
    }
  );
  return actions;
}

function profileActions(error) {
  const actions = [
    {
      kind: 'profile-doctor',
      origin: error.origin || null,
      toolName: 'codex_chrome_profile_doctor',
      arguments: originArguments(error.origin),
      operatorCli: error.origin ? ['profile-doctor', error.origin] : ['profile-doctor'],
      requiresUserDecision: false
    },
    {
      kind: 'profile-onboard',
      origin: error.origin || null,
      toolName: 'codex_chrome_profile_onboard',
      arguments: {},
      operatorCli: ['profile-onboard'],
      requiresUserGesture: true
    }
  ];

  if (error.origin) {
    actions.push({
      kind: 'retry-readiness',
      origin: error.origin,
      toolName: 'codex_chrome_readiness',
      arguments: {
        origin: error.origin
      },
      requiresFreshReadiness: true
    });
  }

  return actions;
}

function buildPolicyHints(error = {}) {
  if (!POLICY_ERROR_CODES.has(error.code)) {
    return null;
  }

  let nextActions;
  if ([
    'HOST_PERMISSION_REQUIRED',
    'HOST_PERMISSION_NOT_GRANTED',
    'HOST_PERMISSION_REQUEST_REQUIRED'
  ].includes(error.code)) {
    nextActions = hostPermissionActions(error);
  } else if (error.code === 'DOMAIN_NOT_APPROVED') {
    nextActions = [{
      kind: 'approve-domain',
      origin: error.origin || null,
      operatorCli: error.origin ? ['approve', error.origin] : null,
      toolName: error.origin ? 'codex_chrome_prepare_origin' : null,
      arguments: error.origin ? { origin: error.origin } : null,
      requiresUserDecision: true
    }, {
      kind: 'retry-tool',
      origin: error.origin || null,
      toolName: error.origin ? 'codex_chrome_readiness' : null,
      arguments: error.origin ? { origin: error.origin } : null,
      requiresFreshReadiness: true
    }];
  } else if (PROFILE_ERROR_CODES.has(error.code)) {
    nextActions = profileActions(error);
  } else if (STOP_ONLY_ERROR_CODES.has(error.code)) {
    nextActions = [{
      kind: 'stop',
      origin: error.origin || null,
      policyCode: error.code,
      requiresUserDecision: false
    }, {
      kind: 'manual-diagnostic',
      policyCode: error.code,
      requiresUserDecision: true
    }];
  } else {
    nextActions = [{
      kind: 'manual-diagnostic',
      policyCode: error.code,
      requiresUserDecision: true
    }];
  }

  return {
    category: 'policy',
    policyCode: error.code,
    origin: error.origin || null,
    permissionUrl: error.permissionUrl || null,
    nextActions
  };
}

module.exports = {
  buildPolicyHints
};
