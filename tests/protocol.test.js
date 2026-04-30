const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ERROR_CODES,
  validateHello,
  assertReadyForRealSiteAction,
  validateBoundedFullAutoContract
} = require('../operator-daemon/protocol');

function boundHello(overrides = {}) {
  return {
    type: 'HELLO',
    protocolVersion: '1.0',
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    extensionVersion: '0.1.0',
    bridgeVersion: '0.1.0',
    sessionBootstrapId: 'boot_abc',
    profileBindingState: 'bound',
    profileBindingId: 'profbind_8Qw3z6NqfK2p9xV1',
    profileBindingVersion: 3,
    profileBindingSource: 'chrome.storage.local',
    capabilities: ['observe.v1', 'actions.basic.v1'],
    ...overrides
  };
}

test('validateHello accepts production bound profile metadata', () => {
  const result = validateHello(boundHello(), {
    expectedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
    expectedProfileBindingId: 'profbind_8Qw3z6NqfK2p9xV1',
    expectedProfileBindingVersion: 3,
    allowUnboundSetup: false,
    allowDevUnbound: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.profileBindingStatus, 'verified');
});

test('validateHello rejects missing profile binding for production work', () => {
  const result = validateHello(boundHello({
    profileBindingState: 'missing',
    profileBindingId: undefined,
    profileBindingVersion: undefined
  }), {
    expectedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
    expectedProfileBindingId: 'profbind_8Qw3z6NqfK2p9xV1',
    expectedProfileBindingVersion: 3,
    allowUnboundSetup: false,
    allowDevUnbound: false
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, ERROR_CODES.PROFILE_BINDING_MISSING);
});

test('validateHello accepts unbound setup hello only for setup flows', () => {
  const result = validateHello(boundHello({
    profileBindingState: 'missing',
    profileBindingId: undefined,
    profileBindingVersion: undefined
  }), {
    expectedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
    allowUnboundSetup: true,
    allowDevUnbound: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.profileBindingStatus, 'setup-unbound');
});

test('validateHello rejects unbound setup hello carrying binding fields', () => {
  const result = validateHello(boundHello({
    profileBindingState: 'missing'
  }), {
    expectedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
    allowUnboundSetup: true,
    allowDevUnbound: false
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, ERROR_CODES.INVALID_SCHEMA);
});

test('validateHello rejects stale profile binding version', () => {
  const result = validateHello(boundHello({ profileBindingVersion: 2 }), {
    expectedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
    expectedProfileBindingId: 'profbind_8Qw3z6NqfK2p9xV1',
    expectedProfileBindingVersion: 3,
    allowUnboundSetup: false,
    allowDevUnbound: false
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, ERROR_CODES.PROFILE_BINDING_STALE);
});

test('validateHello rejects protocol extension and bridge version mismatch', () => {
  const commonOptions = {
    expectedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
    expectedProtocolVersion: '1.0',
    expectedExtensionVersion: '0.1.0',
    expectedBridgeVersion: '0.1.0',
    expectedProfileBindingId: 'profbind_8Qw3z6NqfK2p9xV1',
    expectedProfileBindingVersion: 3,
    allowUnboundSetup: false,
    allowDevUnbound: false
  };

  assert.equal(validateHello(boundHello({ protocolVersion: '2.0' }), commonOptions).error.code, ERROR_CODES.PROTOCOL_VERSION_MISMATCH);
  assert.equal(validateHello(boundHello({ extensionVersion: '0.2.0' }), commonOptions).error.code, ERROR_CODES.EXTENSION_VERSION_MISMATCH);
  assert.equal(validateHello(boundHello({ bridgeVersion: '0.2.0' }), commonOptions).error.code, ERROR_CODES.BRIDGE_VERSION_MISMATCH);
});

test('assertReadyForRealSiteAction fails closed without profile or host permission', () => {
  assert.equal(assertReadyForRealSiteAction({
    profileVerified: false,
    domainApproved: true,
    hostPermissionGranted: true
  }).error.code, ERROR_CODES.PROFILE_BINDING_MISSING);

  assert.equal(assertReadyForRealSiteAction({
    profileVerified: true,
    domainApproved: true,
    hostPermissionGranted: false
  }).error.code, ERROR_CODES.HOST_PERMISSION_REQUIRED);

  assert.equal(assertReadyForRealSiteAction({
    profileVerified: true,
    domainApproved: false,
    hostPermissionGranted: true
  }).error.code, ERROR_CODES.DOMAIN_NOT_APPROVED);
});

test('validateBoundedFullAutoContract allows bounded non-final cart preparation only', () => {
  const result = validateBoundedFullAutoContract({
    mode: 'bounded-full-auto-v1',
    approvedOrigins: ['https://www.hepsiburada.com'],
    taskScope: 'Find eligible Mac mini, add to cart, stop before checkout',
    allowedActionKinds: ['observe', 'cart-preparation'],
    blockedActionKinds: ['checkout', 'payment', 'order-placement', 'publish'],
    limits: {
      expiresInMinutes: 30,
      maxBrowserActions: 200,
      maxScreenshots: 80,
      maxUploads: 0,
      maxCartValueTRY: 50000,
      maxCartItems: 1,
      maxDraftSaves: 5,
      maxOriginChanges: 0
    },
    auditRequired: true,
    emergencyStopRequired: true
  });

  assert.equal(result.ok, true);
});

test('validateBoundedFullAutoContract rejects final high-impact allowed actions', () => {
  for (const action of ['checkout', 'payment', 'order-placement', 'publish']) {
    const result = validateBoundedFullAutoContract({
      mode: 'bounded-full-auto-v1',
      approvedOrigins: ['https://play.google.com'],
      taskScope: 'Publish app',
      allowedActionKinds: ['observe', action],
      blockedActionKinds: [],
      limits: { expiresInMinutes: 30 },
      auditRequired: true,
      emergencyStopRequired: true
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, ERROR_CODES.BOUNDED_FULL_AUTO_ACTION_NOT_ALLOWED);
  }
});
