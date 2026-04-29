const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyActionRisk
} = require('../extension/actionPolicy');

test('classifyActionRisk blocks explicitly marked high-risk click targets', () => {
  const risk = classifyActionRisk({
    action: 'click',
    target: {
      tag: 'button',
      id: 'publish',
      label: 'Publish',
      dataRisk: 'publish'
    }
  });

  assert.equal(risk.blocked, true);
  assert.equal(risk.code, 'HIGH_RISK_BLOCKED');
  assert.equal(risk.approvalKind, 'publish');
  assert.match(risk.targetSummary, /Publish/);
});

test('classifyActionRisk blocks common final-action labels', () => {
  assert.equal(classifyActionRisk({
    action: 'click',
    target: { tag: 'button', label: 'Send for review' }
  }).approvalKind, 'publish');

  assert.equal(classifyActionRisk({
    action: 'click',
    target: { tag: 'button', label: 'Place order' }
  }).approvalKind, 'order-placement');
});

test('classifyActionRisk allows low-risk draft controls', () => {
  const risk = classifyActionRisk({
    action: 'click',
    target: {
      tag: 'button',
      id: 'saveDraft',
      label: 'Save Draft'
    }
  });

  assert.equal(risk, null);
});
