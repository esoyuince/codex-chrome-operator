const test = require('node:test');
const assert = require('node:assert/strict');

const { buildApprovalHints } = require('../codex-adapter/approvalClient');
const { buildGateHandoffHints } = require('../codex-adapter/gateHandoffClient');
const { buildManualHandoffHints } = require('../codex-adapter/manualHandoffClient');
const { buildPolicyHints } = require('../codex-adapter/policyClient');

test('buildApprovalHints turns high-risk approval errors into actionable handoff metadata', () => {
  const hints = buildApprovalHints({
    code: 'HIGH_RISK_BLOCKED',
    message: 'High-risk action blocked.',
    approvalId: 'approval_42',
    approvalKind: 'publish',
    approvalStatus: 'pending',
    targetSummary: 'button: Publish'
  });

  assert.equal(hints.category, 'approval');
  assert.equal(hints.approvalId, 'approval_42');
  assert.equal(hints.approvalKind, 'publish');
  assert.equal(hints.targetSummary, 'button: Publish');
  assert.deepEqual(hints.nextActions.map((action) => action.kind), [
    'review-approval',
    'approve',
    'reject',
    'run-after-approve'
  ]);
  assert.deepEqual(hints.nextActions[1].operatorCli, ['approval-approve', 'approval_42']);
  assert.deepEqual(hints.nextActions[3].operatorCli, ['approval-run', 'approval_42']);
  assert.equal(hints.nextActions[1].toolName, 'codex_chrome_approval_approve');
  assert.deepEqual(hints.nextActions[1].arguments, {
    approvalId: 'approval_42',
    userDecision: 'approve'
  });
  assert.equal(hints.nextActions[3].toolName, 'codex_chrome_approval_run');
  assert.deepEqual(hints.nextActions[3].arguments, {
    approvalId: 'approval_42'
  });
});

test('buildGateHandoffHints turns auth gates into resume-safe instructions', () => {
  const hints = buildGateHandoffHints({
    code: 'PASSWORD_REQUIRED',
    message: 'A password gate is visible.',
    gateType: 'PASSWORD_REQUIRED',
    resumePolicy: 'wait-and-reobserve',
    timeoutMs: 300000,
    taskStatePreserved: true,
    freshObservationRequired: true
  });

  assert.equal(hints.category, 'gate-handoff');
  assert.equal(hints.gateType, 'PASSWORD_REQUIRED');
  assert.equal(hints.resumePolicy, 'wait-and-reobserve');
  assert.equal(hints.freshObservationRequired, true);
  assert.deepEqual(hints.nextActions.map((action) => action.kind), [
    'manual-step',
    'reobserve'
  ]);
});

test('buildManualHandoffHints turns file picker pauses into safe user steps', () => {
  const hints = buildManualHandoffHints({
    code: 'MANUAL_STEP_REQUIRED',
    message: 'Browser security requires a manual file-picker handoff.',
    resumePolicy: 'manual-file-picker',
    origin: 'https://play.google.com',
    uploadTarget: 'el_upload',
    fileSummaries: [{
      role: 'playStoreAppIcon',
      basename: 'icon.png',
      sha256: 'a'.repeat(64)
    }]
  });

  assert.equal(hints.category, 'manual-handoff');
  assert.equal(hints.resumePolicy, 'manual-file-picker');
  assert.equal(hints.uploadTarget, 'el_upload');
  assert.equal(hints.fileSummaries[0].basename, 'icon.png');
  assert.equal(Object.hasOwn(hints.fileSummaries[0], 'path'), false);
  assert.deepEqual(hints.nextActions.map((action) => action.kind), [
    'manual-file-picker',
    'reobserve',
    'retry-original-tool'
  ]);
  assert.equal(hints.nextActions[0].requiresUserGesture, true);
  assert.deepEqual(hints.nextActions[1].operatorCli, ['observe', 'https://play.google.com']);
});

test('buildPolicyHints explains permission and profile blockers without bypass steps', () => {
  const hints = buildPolicyHints({
    code: 'HOST_PERMISSION_REQUIRED',
    message: 'Chrome host permission is required before action.',
    origin: 'https://example.com',
    permissionUrl: 'chrome-extension://id/obsolete-host-permission.html?origin=https%3A%2F%2Fexample.com'
  });

  assert.equal(hints.category, 'policy');
  assert.equal(hints.policyCode, 'HOST_PERMISSION_REQUIRED');
  assert.equal(hints.origin, 'https://example.com');
  assert.equal(hints.permissionUrl, null);
  assert.deepEqual(hints.nextActions.map((action) => action.kind), [
    'reload-extension',
    'retry-readiness'
  ]);
  assert.equal(hints.nextActions[0].requiresUserGesture, true);
  assert.equal(hints.nextActions[1].toolName, 'codex_chrome_readiness');
  assert.deepEqual(hints.nextActions[1].arguments, {
    origin: 'https://example.com'
  });
});

test('buildPolicyHints points profile blockers to adapter doctor and onboarding tools', () => {
  const hints = buildPolicyHints({
    code: 'PROFILE_NOT_CONFIGURED',
    message: 'Chrome profile is not configured.',
    origin: 'https://example.com'
  });

  assert.equal(hints.category, 'policy');
  assert.equal(hints.policyCode, 'PROFILE_NOT_CONFIGURED');
  assert.deepEqual(hints.nextActions.map((action) => action.kind), [
    'profile-doctor',
    'profile-onboard',
    'retry-readiness'
  ]);
  assert.equal(hints.nextActions[0].toolName, 'codex_chrome_profile_doctor');
  assert.deepEqual(hints.nextActions[0].arguments, {
    origin: 'https://example.com'
  });
  assert.deepEqual(hints.nextActions[0].operatorCli, [
    'profile-doctor',
    'https://example.com'
  ]);
  assert.equal(hints.nextActions[0].requiresUserDecision, false);
  assert.equal(hints.nextActions[1].toolName, 'codex_chrome_profile_onboard');
  assert.deepEqual(hints.nextActions[1].arguments, {});
  assert.deepEqual(hints.nextActions[1].operatorCli, ['profile-onboard']);
  assert.equal(hints.nextActions[1].requiresUserGesture, false);
  assert.equal(hints.nextActions[2].toolName, 'codex_chrome_readiness');
  assert.deepEqual(hints.nextActions[2].arguments, {
    origin: 'https://example.com'
  });
  assert.equal(hints.nextActions[2].requiresFreshReadiness, true);
});

test('buildPolicyHints does not offer approval or run bypass actions for commerce stop errors', () => {
  const blockedCodes = [
    'CHECKOUT_BLOCKED',
    'SITE_PROFILE_UNAVAILABLE',
    'BOUNDED_FULL_AUTO_ACTION_NOT_ALLOWED'
  ];
  const bypassKinds = new Set(['approve', 'run-after-approve', 'approval-run']);
  const bypassToolNames = new Set([
    'codex_chrome_approval_approve',
    'codex_chrome_approval_run'
  ]);

  for (const code of blockedCodes) {
    const hints = buildPolicyHints({
      code,
      message: `${code} must stop before checkout, payment, or order placement.`,
      origin: 'https://shop.example'
    });

    assert.equal(hints.category, 'policy');
    assert.ok(
      hints.nextActions.some((action) => action.kind === 'stop'),
      `${code} should return terminal stop guidance`
    );
    for (const action of hints.nextActions) {
      assert.equal(bypassKinds.has(action.kind), false, `${code} must not expose ${action.kind}`);
      assert.equal(bypassToolNames.has(action.toolName), false, `${code} must not expose ${action.toolName}`);
      assert.notDeepEqual(action.operatorCli, ['approval-approve', 'approval_1']);
      assert.notDeepEqual(action.operatorCli, ['approval-run', 'approval_1']);
    }
  }
});
