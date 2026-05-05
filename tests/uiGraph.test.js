const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canUseStableIndexRecovery,
  resolveTarget
} = require('../extension/uiGraph');

function candidate(overrides = {}) {
  return {
    targetId: overrides.targetId || 'ui_1',
    role: overrides.role || 'button',
    name: overrides.name || 'Reply',
    visibleText: overrides.visibleText || 'Reply',
    states: {
      visible: true,
      enabled: true,
      occluded: false,
      ...(overrides.states || {})
    },
    dom: {
      href: overrides.href || null,
      attributes: {
        ...(overrides.attributes || {})
      }
    },
    location: {
      frameId: overrides.frameId || 'frame-main',
      documentId: overrides.documentId || 'doc-1',
      bbox: overrides.bbox || { x: 100, y: 200, width: 84, height: 36 }
    },
    fingerprints: {
      semantic: overrides.semantic || 'semantic-a',
      layout: overrides.layout || 'layout-a',
      neighborHash: overrides.neighborHash || 'neighbor-a',
      domPathHash: overrides.domPathHash || 'dom-a'
    },
    confidence: overrides.confidence ?? 0.88,
    evidence: overrides.evidence || ['dom-label', 'ax-name']
  };
}

test('resolveTarget selects a unique high-confidence UI graph target with evidence', () => {
  const result = resolveTarget({
    target: {
      role: 'button',
      name: 'Reply',
      testid: 'tweetButton'
    },
    previousDescriptor: {
      fingerprints: {
        semantic: 'semantic-a',
        neighborHash: 'neighbor-a'
      }
    },
    candidates: [
      candidate({
        targetId: 'ui_reply_modal',
        attributes: { 'data-testid': 'tweetButton' }
      }),
      candidate({
        targetId: 'ui_reply_inline',
        attributes: { 'data-testid': 'tweetButtonInline' },
        semantic: 'semantic-b',
        neighborHash: 'neighbor-b',
        bbox: { x: 100, y: 600, width: 84, height: 36 }
      })
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.target.targetId, 'ui_reply_modal');
  assert.equal(result.confidence >= 0.72, true);
  assert.ok(result.evidence.includes('accessible name matched'));
  assert.ok(result.evidence.includes('data-testid matched'));
  assert.ok(result.evidence.includes('semantic fingerprint matched'));
});

test('resolveTarget fails closed when duplicate UI graph targets are not unique', () => {
  const result = resolveTarget({
    target: {
      role: 'button',
      name: 'Reply'
    },
    candidates: [
      candidate({ targetId: 'ui_reply_1', semantic: 'semantic-a', neighborHash: 'neighbor-a' }),
      candidate({ targetId: 'ui_reply_2', semantic: 'semantic-b', neighborHash: 'neighbor-b' })
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'AMBIGUOUS_TARGET');
  assert.equal(result.error.reason, 'TARGET_NOT_UNIQUE');
  assert.equal(result.error.candidates.length, 2);
  assert.equal(result.error.candidates[0].confidence - result.error.candidates[1].confidence < 0.12, true);
});

test('resolveTarget fails closed below the confidence threshold', () => {
  const result = resolveTarget({
    confidenceThreshold: 0.72,
    target: {
      role: 'button',
      name: 'Publish'
    },
    candidates: [
      candidate({
        targetId: 'ui_unknown',
        role: 'link',
        name: 'Drafts',
        visibleText: 'Drafts',
        confidence: 0.4,
        evidence: ['dom-tag']
      })
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'TARGET_CONFIDENCE_TOO_LOW');
  assert.equal(result.error.details.threshold, 0.72);
});

test('canUseStableIndexRecovery requires strong UI graph semantic and context evidence', () => {
  const descriptor = {
    index: 1,
    originalMatchCount: 2,
    fingerprints: {
      semantic: 'semantic-b',
      neighborHash: 'neighbor-b'
    },
    location: {
      frameId: 'frame-main',
      documentId: 'doc-1',
      bbox: { x: 100, y: 600, width: 84, height: 36 }
    }
  };
  const currentSet = [
    candidate({ targetId: 'ui_1', semantic: 'semantic-a', neighborHash: 'neighbor-a' }),
    candidate({
      targetId: 'ui_2',
      semantic: 'semantic-b',
      neighborHash: 'neighbor-b',
      bbox: { x: 102, y: 603, width: 84, height: 36 },
      confidence: 0.84
    })
  ];

  assert.equal(canUseStableIndexRecovery({ descriptor, currentSet }), true);
  assert.equal(canUseStableIndexRecovery({
    descriptor,
    currentSet: currentSet.map((entry, index) => index === 1
      ? { ...entry, confidence: 0.79 }
      : entry)
  }), false);
  assert.equal(canUseStableIndexRecovery({
    descriptor,
    currentSet: currentSet.map((entry, index) => index === 1
      ? { ...entry, fingerprints: { ...entry.fingerprints, neighborHash: 'different' } }
      : entry)
  }), false);
});
