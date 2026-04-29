const test = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateWaitCondition,
  waitForCondition
} = require('../extension/pageWait');

function element({ visible = true, disabled = false } = {}) {
  return {
    disabled,
    style: {
      display: visible ? 'block' : 'none',
      visibility: visible ? 'visible' : 'hidden'
    },
    getBoundingClientRect() {
      return visible
        ? { width: 12, height: 8 }
        : { width: 0, height: 0 };
    }
  };
}

function context({
  href = 'https://example.com/done',
  text = 'Draft saved',
  readyState = 'complete',
  selectors = {},
  handles = {}
} = {}) {
  return {
    location: { href },
    window: {
      getComputedStyle(target) {
        return target.style;
      }
    },
    document: {
      readyState,
      body: { innerText: text },
      querySelector(selector) {
        return selectors[selector] || null;
      }
    },
    resolveHandle(handle) {
      return handles[handle] || null;
    }
  };
}

test('evaluateWaitCondition supports URL, text, and element state conditions', () => {
  const saveButton = element();
  const disabledInput = element({ disabled: true });
  const hiddenPanel = element({ visible: false });
  const env = context({
    selectors: {
      '#save': saveButton,
      '#field': disabledInput,
      '#panel': hiddenPanel
    },
    handles: {
      el_0: saveButton
    }
  });

  assert.equal(evaluateWaitCondition({ type: 'navigationComplete' }, env).satisfied, true);
  assert.equal(evaluateWaitCondition({ type: 'urlMatches', pattern: '/done$' }, env).satisfied, true);
  assert.equal(evaluateWaitCondition({ type: 'urlChanged', from: 'https://example.com/start' }, env).satisfied, true);
  assert.equal(evaluateWaitCondition({ type: 'textVisible', text: 'Draft saved' }, env).satisfied, true);
  assert.equal(evaluateWaitCondition({ type: 'textGone', text: 'Publishing' }, env).satisfied, true);
  assert.equal(evaluateWaitCondition({ type: 'elementVisible', selector: '#save' }, env).satisfied, true);
  assert.equal(evaluateWaitCondition({ type: 'elementVisible', handle: 'el_0' }, env).satisfied, true);
  assert.equal(evaluateWaitCondition({ type: 'elementGone', selector: '#panel' }, env).satisfied, true);
  assert.equal(evaluateWaitCondition({ type: 'elementEnabled', selector: '#save' }, env).satisfied, true);
  assert.equal(evaluateWaitCondition({ type: 'elementDisabled', selector: '#field' }, env).satisfied, true);
});

test('waitForCondition polls until the condition is satisfied', async () => {
  let now = 0;
  const env = context({ text: 'Loading' });
  const result = await waitForCondition({
    condition: { type: 'textVisible', text: 'Ready' },
    context: env,
    timeoutMs: 500,
    pollIntervalMs: 50,
    now: () => now,
    sleeper: async (delayMs) => {
      now += delayMs;
      env.document.body.innerText = 'Ready';
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.condition.type, 'textVisible');
  assert.equal(result.result.elapsedMs, 50);
});

test('waitForCondition returns a deterministic timeout error', async () => {
  let now = 0;
  const result = await waitForCondition({
    condition: { type: 'textVisible', text: 'Never appears' },
    context: context({ text: 'Still loading' }),
    timeoutMs: 100,
    pollIntervalMs: 50,
    now: () => now,
    sleeper: async (delayMs) => {
      now += delayMs;
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'TIMEOUT');
  assert.equal(result.error.condition.type, 'textVisible');
  assert.equal(result.error.timeoutMs, 100);
});
