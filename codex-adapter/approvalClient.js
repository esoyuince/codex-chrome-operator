'use strict';

const APPROVAL_ERROR_CODES = new Set([
  'HIGH_RISK_BLOCKED',
  'APPROVAL_REQUIRED'
]);

function buildApprovalHints(error = {}) {
  if (!APPROVAL_ERROR_CODES.has(error.code)) {
    return null;
  }

  const approvalId = error.approvalId || null;
  const nextActions = [{
    kind: 'review-approval',
    approvalId,
    approvalKind: error.approvalKind || null,
    targetSummary: error.targetSummary || null,
    requiresUserDecision: true
  }];

  if (approvalId) {
    nextActions.push(
      {
        kind: 'approve',
        approvalId,
        operatorCli: ['approval-approve', approvalId],
        operatorRpc: 'operator.approvals.approve',
        requiresUserDecision: true
      },
      {
        kind: 'reject',
        approvalId,
        operatorCli: ['approval-reject', approvalId],
        operatorRpc: 'operator.approvals.reject',
        requiresUserDecision: true
      },
      {
        kind: 'run-after-approve',
        approvalId,
        operatorCli: ['approval-run', approvalId],
        operatorRpc: 'operator.approvals.run',
        requiresPriorApproval: true
      }
    );
  }

  return {
    category: 'approval',
    severity: 'high-risk',
    approvalId,
    approvalKind: error.approvalKind || null,
    approvalStatus: error.approvalStatus || null,
    targetSummary: error.targetSummary || null,
    nextActions
  };
}

module.exports = {
  buildApprovalHints
};
