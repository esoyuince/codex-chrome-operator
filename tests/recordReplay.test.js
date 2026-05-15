const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTraceRecorder,
  recordRpc,
  replayTrace
} = require('../scripts/record-replay');

test('recordRpc captures bounded RPC steps with DOM, dialog, and policy annotations', async () => {
  const recorder = createTraceRecorder({
    name: 'dynamic-stale-handle',
    fixtureUrl: 'http://127.0.0.1:18888/dynamic-dom.html'
  });
  const response = await recordRpc(recorder, {
    method: 'operator.runtime.tab.locator',
    params: {
      agentId: 'agent-alpha',
      tabId: 101,
      selector: '[data-testid="dynamic-save"]',
      action: 'click'
    },
    annotations: {
      domMutations: [{ afterStep: 'observe', script: 'window.__codexDynamicSmokeReplaceAction()' }],
      dialogs: [{ selector: '[data-testid="open-dialog"]', expected: 'Runtime dialog opened' }],
      policyDecisions: [{ kind: 'stale-handle-retry', expected: 'target-contract' }]
    },
    sendRpcFn: async ({ request }) => ({
      ok: true,
      result: {
        action: request.params.action,
        staleRecovery: 'target-contract'
      }
    })
  });

  assert.equal(response.ok, true);
  assert.equal(recorder.trace.steps.length, 1);
  assert.deepEqual(recorder.trace.steps[0].expect, {
    ok: true,
    errorCode: null,
    result: {
      action: 'click',
      staleRecovery: 'target-contract'
    }
  });
  assert.equal(recorder.trace.steps[0].annotations.domMutations[0].script, 'window.__codexDynamicSmokeReplaceAction()');
});

test('recordRpc captures replay context from live responses without raw screenshot payloads', async () => {
  const recorder = createTraceRecorder({
    name: 'visual-context',
    fixtureUrl: 'http://127.0.0.1:18888/visual.html',
    metadata: {
      agentId: 'agent-alpha',
      tabId: 101
    }
  });

  const response = await recordRpc(recorder, {
    method: 'operator.runtime.tab.visualAnalyze',
    params: {
      agentId: 'agent-alpha',
      tabId: 101
    },
    sendRpcFn: async () => ({
      ok: true,
      result: {
        tabId: 101,
        origin: 'http://127.0.0.1:18888',
        url: 'http://127.0.0.1:18888/visual.html',
        pageStateId: 'state_visual_1',
        screenshot: {
          artifactId: 'shot_1',
          dataUrl: 'data:image/png;base64,AAAA',
          mimeType: 'image/png',
          width: 100,
          height: 80
        },
        visual: {
          analysis: {
            status: 'analyzed',
            regions: [{ kind: 'table', handle: 'table_1' }],
            handleCorrelations: [{ handle: 'table_1' }]
          }
        },
        focusDisturbance: {
          occurred: true,
          restoredActiveTabId: 7
        }
      }
    })
  });

  assert.equal(response.ok, true);
  const step = recorder.trace.steps[0];
  assert.deepEqual(step.context, {
    tabId: 101,
    origin: 'http://127.0.0.1:18888',
    url: 'http://127.0.0.1:18888/visual.html',
    pageStateId: 'state_visual_1',
    screenshot: {
      artifactId: 'shot_1',
      mimeType: 'image/png',
      width: 100,
      height: 80
    },
    visual: {
      status: 'analyzed',
      regionKinds: ['table'],
      regionCount: 1,
      handleCorrelationCount: 1
    },
    focusDisturbance: {
      occurred: true,
      restoredActiveTabId: 7
    }
  });
  assert.equal(JSON.stringify(step).includes('data:image/png'), false);
});

test('replayTrace reports screenshot artifact drift through context instead of result mismatch', async () => {
  const recorder = createTraceRecorder({
    name: 'visual-artifact-drift'
  });
  await recordRpc(recorder, {
    method: 'operator.runtime.tab.visualAnalyze',
    params: {
      tabId: 101
    },
    sendRpcFn: async () => ({
      ok: true,
      result: {
        tabId: 101,
        origin: 'http://127.0.0.1:18888',
        pageStateId: 'state_visual_1',
        screenshot: {
          artifactId: 'shot_1',
          mimeType: 'image/png',
          width: 100,
          height: 80
        },
        visual: {
          analysis: {
            status: 'analyzed',
            regions: [{ kind: 'table' }],
            handleCorrelations: []
          }
        }
      }
    })
  });

  const report = await replayTrace(recorder.trace, {
    sendRpcFn: async () => ({
      ok: true,
      result: {
        tabId: 101,
        origin: 'http://127.0.0.1:18888',
        pageStateId: 'state_visual_1',
        screenshot: {
          artifactId: 'shot_2',
          mimeType: 'image/png',
          width: 100,
          height: 80
        },
        visual: {
          analysis: {
            status: 'analyzed',
            regions: [{ kind: 'table' }],
            handleCorrelations: []
          }
        }
      }
    })
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.steps[0].contextDrift, [{
    field: 'screenshot.artifactId',
    expected: 'shot_1',
    actual: 'shot_2'
  }]);
});

test('replayTrace fails when an expected policy decision changes', async () => {
  const trace = {
    version: 1,
    name: 'checkout-stop',
    fixtureUrl: 'http://127.0.0.1:18888/mock-commerce.html',
    steps: [{
      method: 'operator.runtime.tab.locator',
      params: {
        agentId: 'agent-alpha',
        tabId: 101,
        selector: '[data-testid="checkout"]',
        action: 'click'
      },
      expect: {
        ok: false,
        errorCode: 'HIGH_RISK_BLOCKED'
      },
      annotations: {
        policyDecisions: [{ kind: 'terminal-stop', expected: 'checkout-blocked' }]
      }
    }]
  };

  await assert.rejects(
    replayTrace(trace, {
      sendRpcFn: async () => ({
        ok: false,
        error: {
          code: 'CHECKOUT_BLOCKED'
        }
      })
    }),
    /expected error HIGH_RISK_BLOCKED/i
  );
});

test('replayTrace accepts matching stale-handle, dialog, file-upload, and checkout traces', async () => {
  const trace = {
    version: 1,
    name: 'dynamic-replay',
    fixtureUrl: 'http://127.0.0.1:18888/dynamic-dom.html',
    steps: [{
      method: 'operator.runtime.tab.locator',
      params: { agentId: 'agent-alpha', tabId: 101, selector: '[data-testid="dynamic-save"]', action: 'click' },
      expect: { ok: true, result: { staleRecovery: 'target-contract' } },
      annotations: { domMutations: [{ afterStep: 'observe', script: 'replace action' }] }
    }, {
      method: 'operator.runtime.tab.locator',
      params: { agentId: 'agent-alpha', tabId: 101, selector: '[data-testid="open-dialog"]', action: 'click' },
      expect: { ok: true, result: { dialogOpened: true } },
      annotations: { dialogs: [{ expected: 'Runtime dialog opened' }] }
    }, {
      method: 'page.uploadFile',
      params: { origin: 'https://play.google.com', target: { handle: 'el_file' }, files: [{ role: 'playStoreAppIcon', path: 'C:/tmp/icon.png' }] },
      expect: { ok: false, errorCode: 'ASSET_DIMENSION_MISMATCH' },
      annotations: { policyDecisions: [{ kind: 'file-upload-validation', expected: 'dimension-block' }] }
    }, {
      method: 'operator.runtime.tab.locator',
      params: { agentId: 'agent-alpha', tabId: 101, selector: '[data-testid="checkout"]', action: 'click' },
      expect: { ok: false, errorCode: 'HIGH_RISK_BLOCKED' },
      annotations: { policyDecisions: [{ kind: 'terminal-stop', expected: 'checkout-blocked' }] }
    }]
  };
  const responses = [
    { ok: true, result: { action: 'click', staleRecovery: 'target-contract', extra: 'ignored' } },
    { ok: true, result: { dialogOpened: true } },
    { ok: false, error: { code: 'ASSET_DIMENSION_MISMATCH' } },
    { ok: false, error: { code: 'HIGH_RISK_BLOCKED' } }
  ];

  const report = await replayTrace(trace, {
    sendRpcFn: async () => responses.shift()
  });

  assert.equal(report.ok, true);
  assert.equal(report.steps.length, 4);
  assert.deepEqual(report.steps.map((step) => step.ok), [true, true, true, true]);
});

test('replayTrace reports context drift for changed page state and visual regions', async () => {
  const trace = {
    version: 1,
    name: 'visual-context',
    steps: [{
      method: 'operator.runtime.tab.visualAnalyze',
      params: { agentId: 'agent-alpha', tabId: 101 },
      expect: { ok: true },
      context: {
        tabId: 101,
        origin: 'http://127.0.0.1:18888',
        pageStateId: 'state_before',
        visual: {
          regionKinds: ['product-card']
        }
      }
    }]
  };

  const report = await replayTrace(trace, {
    sendRpcFn: async () => ({
      ok: true,
      result: {
        tabId: 101,
        origin: 'http://127.0.0.1:18888',
        pageStateId: 'state_after',
        visual: {
          analysis: {
            regions: [{ kind: 'table' }],
            handleCorrelations: []
          }
        }
      }
    })
  });

  assert.equal(report.ok, true);
  assert.equal(report.steps[0].contextDrift.length, 2);
  assert.deepEqual(report.steps[0].contextDrift.map((entry) => entry.field), [
    'pageStateId',
    'visual.regionKinds'
  ]);
});
