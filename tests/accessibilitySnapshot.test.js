const test = require('node:test');
const assert = require('node:assert/strict');

const {
  captureAccessibilityTree,
  normalizeAxNode
} = require('../extension/accessibilitySnapshot');

test('normalizeAxNode extracts role, name, value, and states from CDP AX nodes', () => {
  const normalized = normalizeAxNode({
    nodeId: '12',
    backendDOMNodeId: 42,
    role: { value: 'button' },
    name: { value: 'Search' },
    value: { value: '' },
    description: { value: 'Icon button' },
    properties: [
      { name: 'disabled', value: { value: false } },
      { name: 'focused', value: { value: true } },
      { name: 'expanded', value: { value: false } },
      { name: 'invalid', value: { value: 'false' } }
    ]
  });

  assert.deepEqual(normalized, {
    axNodeId: '12',
    backendDOMNodeId: 42,
    role: 'button',
    name: 'Search',
    value: '',
    description: 'Icon button',
    disabled: false,
    focused: true,
    checked: null,
    selected: false,
    expanded: false,
    required: false,
    invalid: 'false'
  });
});

test('captureAccessibilityTree returns normalized AX nodes and always detaches', async () => {
  const calls = [];
  const chromeApi = {
    runtime: {},
    debugger: {
      attach(target, protocolVersion, callback) {
        calls.push({ method: 'attach', target, protocolVersion });
        callback();
      },
      detach(target, callback) {
        calls.push({ method: 'detach', target });
        callback();
      },
      sendCommand(target, method, params, callback) {
        calls.push({ method, target, params });
        if (method === 'Accessibility.getFullAXTree') {
          callback({
            nodes: [{
              nodeId: '1',
              backendDOMNodeId: 100,
              role: { value: 'button' },
              name: { value: 'Close dialog' },
              properties: []
            }]
          });
          return;
        }
        callback({});
      }
    }
  };

  const result = await captureAccessibilityTree({
    chromeApi,
    tabId: 7
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.axAvailable, true);
  assert.equal(result.result.rawNodeCount, 1);
  assert.equal(result.result.nodes[0].name, 'Close dialog');
  assert.deepEqual(calls.map((call) => call.method), [
    'attach',
    'Accessibility.enable',
    'Accessibility.getFullAXTree',
    'detach'
  ]);
});

test('captureAccessibilityTree fails closed when AX capture errors', async () => {
  const calls = [];
  const chromeApi = {
    runtime: {},
    debugger: {
      attach(target, protocolVersion, callback) {
        calls.push({ method: 'attach', target, protocolVersion });
        callback();
      },
      detach(target, callback) {
        calls.push({ method: 'detach', target });
        callback();
      },
      sendCommand(target, method, params, callback) {
        calls.push({ method, target, params });
        chromeApi.runtime.lastError = { message: 'AX unavailable' };
        callback({});
        chromeApi.runtime.lastError = null;
      }
    }
  };

  const result = await captureAccessibilityTree({
    chromeApi,
    tabId: 7
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'AX_TREE_CAPTURE_FAILED');
  assert.match(result.error.message, /AX unavailable/);
  assert.equal(calls.at(-1).method, 'detach');
});
