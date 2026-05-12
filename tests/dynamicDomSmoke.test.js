const test = require('node:test');
const assert = require('node:assert/strict');

const { runDynamicDomSmoke } = require('../scripts/dynamic-dom-smoke');

test('dynamic DOM smoke waits for the DOM to stay quiet after late mutations', async () => {
  const report = await runDynamicDomSmoke({
    quietMs: 120,
    timeoutMs: 600,
    pollIntervalMs: 40
  });

  assert.equal(report.ok, true);
  assert.equal(report.smoke, 'dynamic-dom');
  assert.equal(report.mutationBursts, 2);
  assert.equal(report.lastMutationAtMs, 80);
  assert.equal(report.finalState.type, 'domQuiet');
  assert.equal(report.finalState.quietForMs, 120);
  assert.equal(report.finalState.mutationCounter, 2);
  assert.equal(report.settledAfterLastMutationMs, 120);
});
