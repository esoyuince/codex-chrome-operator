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
    extensionVersion: '0.2.6',
    bridgeVersion: '0.2.6',
    sessionBootstrapId: 'boot_abc',
    profileBindingState: 'bound',
    profileBindingId: 'profbind_8Qw3z6NqfK2p9xV1',
    profileBindingVersion: 3,
    profileBindingSource: 'chrome.storage.local',
    capabilities: ['observe.v1', 'actions.basic.v1'],
    ...overrides
  };
}

test('validateHello accepts extension HELLO without profile binding', () => {
  const result = validateHello(boundHello({
    profileBindingState: 'not-required',
    profileBindingId: undefined,
    profileBindingVersion: undefined,
    profileBindingSource: 'implicit-extension'
  }), {
    expectedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
    allowUnboundSetup: false,
    allowDevUnbound: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.profileBindingStatus, 'not-required');
});

test('validateHello treats missing legacy profile binding as not required', () => {
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

  assert.equal(result.ok, true);
  assert.equal(result.profileBindingStatus, 'not-required');
});

test('validateHello accepts legacy binding fields without using them', () => {
  const result = validateHello(boundHello({
    profileBindingState: 'missing'
  }), {
    expectedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
    allowUnboundSetup: true,
    allowDevUnbound: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.profileBindingStatus, 'not-required');
});

test('validateHello ignores stale legacy profile binding version', () => {
  const result = validateHello(boundHello({ profileBindingVersion: 2 }), {
    expectedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
    expectedProfileBindingId: 'profbind_8Qw3z6NqfK2p9xV1',
    expectedProfileBindingVersion: 3,
    allowUnboundSetup: false,
    allowDevUnbound: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.profileBindingStatus, 'not-required');
});

test('validateHello rejects protocol extension and bridge version mismatch', () => {
  const commonOptions = {
    expectedExtensionId: 'abcdefghijklmnopabcdefghijklmnop',
    expectedProtocolVersion: '1.0',
    expectedExtensionVersion: '0.2.6',
    expectedBridgeVersion: '0.2.6',
    expectedProfileBindingId: 'profbind_8Qw3z6NqfK2p9xV1',
    expectedProfileBindingVersion: 3,
    allowUnboundSetup: false,
    allowDevUnbound: false
  };

  const protocolMismatch = validateHello(boundHello({ protocolVersion: '2.0' }), commonOptions);
  assert.equal(protocolMismatch.error.code, ERROR_CODES.PROTOCOL_VERSION_MISMATCH);
  assert.equal(protocolMismatch.error.expectedProtocolVersion, '1.0');
  assert.equal(protocolMismatch.error.actualProtocolVersion, '2.0');

  const extensionMismatch = validateHello(boundHello({ extensionVersion: '0.3.0' }), commonOptions);
  assert.equal(extensionMismatch.error.code, ERROR_CODES.EXTENSION_VERSION_MISMATCH);
  assert.equal(extensionMismatch.error.expectedExtensionVersion, '0.2.6');
  assert.equal(extensionMismatch.error.actualExtensionVersion, '0.3.0');

  const bridgeMismatch = validateHello(boundHello({ bridgeVersion: '0.3.0' }), commonOptions);
  assert.equal(bridgeMismatch.error.code, ERROR_CODES.BRIDGE_VERSION_MISMATCH);
  assert.equal(bridgeMismatch.error.expectedBridgeVersion, '0.2.6');
  assert.equal(bridgeMismatch.error.actualBridgeVersion, '0.3.0');
});

test('assertReadyForRealSiteAction gates domain and user blocked sites without profile binding', () => {
  assert.equal(assertReadyForRealSiteAction({
    profileVerified: false,
    domainApproved: true,
    hostPermissionGranted: true
  }).ok, true);

  assert.equal(assertReadyForRealSiteAction({
    profileVerified: true,
    domainApproved: true,
    hostPermissionGranted: false
  }).ok, true);

  assert.equal(assertReadyForRealSiteAction({
    profileVerified: true,
    domainApproved: false,
    hostPermissionGranted: true
  }).error.code, ERROR_CODES.DOMAIN_NOT_APPROVED);

  const blocked = assertReadyForRealSiteAction({
    origin: 'https://bank.example',
    profileVerified: true,
    domainApproved: true,
    hostPermissionGranted: false,
    siteBlocked: true,
    blockedPattern: 'bank.example'
  });
  assert.equal(blocked.error.code, ERROR_CODES.SITE_BLOCKED_BY_USER_SETTINGS);
  assert.equal(blocked.error.origin, 'https://bank.example');
  assert.equal(blocked.error.blockedPattern, 'bank.example');
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
