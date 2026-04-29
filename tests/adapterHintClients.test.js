const test = require('node:test');
const assert = require('node:assert/strict');

const { buildApprovalHints } = require('../codex-adapter/approvalClient');
const { buildGateHandoffHints } = require('../codex-adapter/gateHandoffClient');
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

test('buildPolicyHints explains permission and profile blockers without bypass steps', () => {
  const hints = buildPolicyHints({
    code: 'HOST_PERMISSION_REQUIRED',
    message: 'Chrome host permission is required before action.',
    origin: 'https://example.com',
    permissionUrl: 'chrome-extension://id/permissionRequest.html?origin=https%3A%2F%2Fexample.com'
  });

  assert.equal(hints.category, 'policy');
  assert.equal(hints.policyCode, 'HOST_PERMISSION_REQUIRED');
  assert.equal(hints.origin, 'https://example.com');
  assert.equal(hints.permissionUrl, 'chrome-extension://id/permissionRequest.html?origin=https%3A%2F%2Fexample.com');
  assert.deepEqual(hints.nextActions.map((action) => action.kind), [
    'open-permission-page',
    'wait-for-user-grant',
    'retry-tool'
  ]);
  assert.equal(hints.nextActions[0].requiresUserGesture, true);
});
