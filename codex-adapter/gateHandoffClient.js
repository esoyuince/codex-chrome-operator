'use strict';

const GATE_ERROR_CODES = new Set([
  'PASSWORD_REQUIRED',
  'OTP_REQUIRED',
  'WEBAUTHN_REQUIRED',
  'CAPTCHA_REQUIRED',
  'PERMISSION_PROMPT_REQUIRED',
  'PAYMENT_AUTH_REQUIRED',
  'IDENTITY_VERIFICATION_REQUIRED',
  'ANTI_ABUSE_CHALLENGE_REQUIRED',
  'ACCOUNT_SECURITY_REAUTH_REQUIRED'
]);

function buildGateHandoffHints(error = {}) {
  const gateType = error.gateType || error.code;
  if (!GATE_ERROR_CODES.has(gateType)) {
    return null;
  }

  const resumePolicy = error.resumePolicy || 'manual-step';
  const nextActions = [{
    kind: 'manual-step',
    gateType,
    resumePolicy,
    timeoutMs: error.timeoutMs || null,
    taskStatePreserved: error.taskStatePreserved !== false,
    instruction: 'Complete the visible gate in Chrome. Do not send secrets through the adapter.'
  }];

  if (resumePolicy === 'wait-and-reobserve' || error.freshObservationRequired) {
    nextActions.push({
      kind: 'reobserve',
      freshObservationRequired: error.freshObservationRequired !== false,
      operatorCli: error.origin ? ['observe', error.origin] : null
    });
  }

  return {
    category: 'gate-handoff',
    gateType,
    resumePolicy,
    timeoutMs: error.timeoutMs || null,
    taskStatePreserved: error.taskStatePreserved !== false,
    freshObservationRequired: Boolean(error.freshObservationRequired),
    nextActions
  };
}

module.exports = {
  buildGateHandoffHints
};
