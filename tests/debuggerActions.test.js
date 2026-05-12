const test = require('node:test');
const assert = require('node:assert/strict');

const {
  attachCdpSession,
  buildRuntimeActionExpression,
  detachCdpSession,
  isDebuggerSupportedUrl,
  runCdpCommand,
  runDebuggerAction
} = require('../extension/debuggerActions');

function makeChrome({ evaluateValue, evaluateValues, commandResults = {} } = {}) {
  const calls = [];
  let evaluateIndex = 0;
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
        if (Object.hasOwn(commandResults, method)) {
          callback(commandResults[method]);
          return;
        }
        if (method === 'Runtime.evaluate') {
          const runtimeValue = Array.isArray(evaluateValues)
            ? evaluateValues[Math.min(evaluateIndex, evaluateValues.length - 1)]
            : evaluateValue;
          evaluateIndex += 1;
          callback({
            result: {
              value: runtimeValue || {
                ok: true,
                result: { action: 'filled' }
              }
            }
          });
          return;
        }
        callback({});
      }
    }
  };
  return { chromeApi, calls };
}

test('isDebuggerSupportedUrl allows only regular web pages', () => {
  assert.equal(isDebuggerSupportedUrl('https://example.com'), true);
  assert.equal(isDebuggerSupportedUrl('http://127.0.0.1:18180'), true);
  assert.equal(isDebuggerSupportedUrl('chrome://settings'), false);
  assert.equal(isDebuggerSupportedUrl('chrome-extension://abcdefghijklmnop/page.html'), false);
  assert.equal(isDebuggerSupportedUrl('about:blank'), false);
});

test('runCdpCommand rejects non-allowlisted CDP methods before attaching', async () => {
  const { chromeApi, calls } = makeChrome();

  const result = await runCdpCommand({
    chromeApi,
    tab: { id: 7, url: 'https://example.com/app' },
    method: 'Runtime.evaluate',
    params: { expression: 'document.cookie' }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CDP_METHOD_NOT_ALLOWED');
  assert.deepEqual(calls, []);
});

test('runCdpCommand executes allowlisted CDP method with scoped attach and detach', async () => {
  const { chromeApi, calls } = makeChrome({
    commandResults: {
      'Page.getLayoutMetrics': {
        layoutViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 720 }
      }
    }
  });

  const result = await runCdpCommand({
    chromeApi,
    tab: { id: 7, url: 'https://example.com/app' },
    method: 'Page.getLayoutMetrics',
    params: {}
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.provider, 'chrome.debugger.Page.getLayoutMetrics');
  assert.deepEqual(result.result.response.layoutViewport.clientWidth, 1280);
  assert.deepEqual(calls.map((call) => call.method), [
    'attach',
    'Page.getLayoutMetrics',
    'detach'
  ]);
});

test('managed CDP attach keeps later execute on the same debugger session until detach', async () => {
  const { chromeApi, calls } = makeChrome({
    commandResults: {
      'Input.insertText': {}
    }
  });
  const tab = { id: 17, url: 'https://example.com/app' };

  const attached = await attachCdpSession({ chromeApi, tab });
  const executed = await runCdpCommand({
    chromeApi,
    tab,
    method: 'Input.insertText',
    params: { text: 'hello' }
  });
  const detached = await detachCdpSession({ chromeApi, tab });

  assert.equal(attached.ok, true);
  assert.equal(executed.ok, true);
  assert.equal(executed.result.managedSession, true);
  assert.equal(detached.ok, true);
  assert.deepEqual(calls.map((call) => call.method), [
    'attach',
    'Input.insertText',
    'detach'
  ]);
});

test('runCdpCommand maps Page.captureScreenshot bytes into screenshot data URL', async () => {
  const { chromeApi, calls } = makeChrome({
    commandResults: {
      'Page.captureScreenshot': {
        data: 'aGVsbG8='
      }
    }
  });

  const result = await runCdpCommand({
    chromeApi,
    tab: { id: 7, url: 'https://example.com/app' },
    method: 'Page.captureScreenshot',
    params: { format: 'jpeg', quality: 80 }
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.provider, 'chrome.debugger.Page.captureScreenshot');
  assert.equal(result.result.screenshot.mimeType, 'image/jpeg');
  assert.equal(result.result.screenshot.dataUrl, 'data:image/jpeg;base64,aGVsbG8=');
  assert.equal(Object.hasOwn(result.result.response, 'data'), false);
  assert.deepEqual(calls.map((call) => call.method), [
    'attach',
    'Page.captureScreenshot',
    'detach'
  ]);
});

test('runDebuggerAction refuses restricted browser pages before attaching', async () => {
  const { chromeApi, calls } = makeChrome();

  const result = await runDebuggerAction({
    chromeApi,
    tab: { id: 7, url: 'chrome://settings' },
    action: 'click',
    params: { handle: 'el_state_0' }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'DEBUGGER_UNSUPPORTED_PAGE');
  assert.deepEqual(calls, []);
});

test('runDebuggerAction executes DOM actions through the Chrome debugger runtime', async () => {
  const { chromeApi, calls } = makeChrome({
    evaluateValue: {
      ok: true,
      result: { action: 'filled', handle: 'el_state_0' }
    }
  });

  const result = await runDebuggerAction({
    chromeApi,
    tab: { id: 7, url: 'https://example.com/form' },
    action: 'fill',
    params: { handle: 'el_state_0', text: 'hello' }
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.provider, 'chrome.debugger.Runtime.evaluate');
  assert.equal(result.result.action, 'filled');
  assert.deepEqual(calls.map((call) => call.method), [
    'attach',
    'Runtime.enable',
    'Runtime.evaluate',
    'detach'
  ]);
  const evaluate = calls.find((call) => call.method === 'Runtime.evaluate');
  assert.equal(evaluate.params.awaitPromise, true);
  assert.equal(evaluate.params.returnByValue, true);
  assert.match(evaluate.params.expression, /"action":"fill"/);
  assert.match(evaluate.params.expression, /"text":"hello"/);
});

test('runDebuggerAction types text through CDP insertText after focusing the target', async () => {
  const { chromeApi, calls } = makeChrome({
    evaluateValues: [
      {
        ok: true,
        result: { action: 'focused', handle: 'el_state_0' }
      },
      {
        ok: true,
        result: {
          action: 'verified-text-inserted',
          handle: 'el_state_0',
          verification: {
            type: 'text-inserted',
            expected: 'hello from cdp',
            actual: 'hello from cdp',
            actualLength: 14
          }
        }
      }
    ]
  });

  const result = await runDebuggerAction({
    chromeApi,
    tab: { id: 7, url: 'https://example.com/composer' },
    action: 'type',
    params: { handle: 'el_state_0', text: 'hello from cdp' }
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.provider, 'chrome.debugger.Input.insertText');
  assert.equal(result.result.action, 'typed');
  assert.equal(result.result.verification.type, 'text-inserted');
  assert.deepEqual(calls.map((call) => call.method), [
    'attach',
    'Runtime.enable',
    'Runtime.evaluate',
    'Input.insertText',
    'Runtime.evaluate',
    'detach'
  ]);
  const evaluations = calls.filter((call) => call.method === 'Runtime.evaluate');
  assert.match(evaluations[0].params.expression, /"action":"focus"/);
  assert.match(evaluations[1].params.expression, /"action":"verifyInsertedText"/);
  const insert = calls.find((call) => call.method === 'Input.insertText');
  assert.deepEqual(insert.params, { text: 'hello from cdp' });
});

test('runDebuggerAction falls back to verified runtime typing when CDP inserted text is not observed', async () => {
  const { chromeApi, calls } = makeChrome({
    evaluateValues: [
      {
        ok: true,
        result: { action: 'focused', handle: 'el_state_0' }
      },
      {
        ok: false,
        error: {
          code: 'ACTION_VERIFICATION_FAILED',
          reason: 'TEXT_INSERTION_NOT_OBSERVED',
          action: 'type',
          expected: 'hello from fallback',
          actual: ''
        }
      },
      {
        ok: true,
        result: {
          action: 'typed',
          handle: 'el_state_0',
          verification: {
            type: 'text-value',
            expected: 'hello from fallback',
            actual: 'hello from fallback',
            actualLength: 19
          }
        }
      }
    ]
  });

  const result = await runDebuggerAction({
    chromeApi,
    tab: { id: 7, url: 'https://example.com/composer' },
    action: 'type',
    params: { handle: 'el_state_0', text: 'hello from fallback' }
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.provider, 'chrome.debugger.Input.insertText+Runtime.evaluate');
  assert.equal(result.result.action, 'typed');
  assert.equal(result.result.verification.type, 'text-value');
  assert.equal(result.result.fallback.reason, 'TEXT_INSERTION_NOT_OBSERVED');
  assert.equal(result.result.fallback.provider, 'chrome.debugger.Runtime.evaluate');
  assert.deepEqual(calls.map((call) => call.method), [
    'attach',
    'Runtime.enable',
    'Runtime.evaluate',
    'Input.insertText',
    'Runtime.evaluate',
    'Runtime.evaluate',
    'detach'
  ]);
  const evaluations = calls.filter((call) => call.method === 'Runtime.evaluate');
  assert.match(evaluations[0].params.expression, /"action":"focus"/);
  assert.match(evaluations[1].params.expression, /"action":"verifyInsertedText"/);
  assert.match(evaluations[2].params.expression, /"action":"type"/);
});

test('runDebuggerAction fails when CDP inserted text and runtime fallback are not observed', async () => {
  const { chromeApi, calls } = makeChrome({
    evaluateValues: [
      {
        ok: true,
        result: { action: 'focused', handle: 'el_state_0' }
      },
      {
        ok: false,
        error: {
          code: 'ACTION_VERIFICATION_FAILED',
          reason: 'TEXT_INSERTION_NOT_OBSERVED',
          action: 'type',
          expected: 'lost text',
          actual: ''
        }
      },
      {
        ok: false,
        error: {
          code: 'ACTION_VERIFICATION_FAILED',
          reason: 'TARGET_VALUE_MISMATCH',
          action: 'type',
          expected: 'lost text',
          actual: ''
        }
      }
    ]
  });

  const result = await runDebuggerAction({
    chromeApi,
    tab: { id: 7, url: 'https://example.com/composer' },
    action: 'type',
    params: { handle: 'el_state_0', text: 'lost text' }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ACTION_VERIFICATION_FAILED');
  assert.equal(result.error.reason, 'TARGET_VALUE_MISMATCH');
  assert.equal(result.error.cdpReason, 'TEXT_INSERTION_NOT_OBSERVED');
  assert.deepEqual(calls.map((call) => call.method), [
    'attach',
    'Runtime.enable',
    'Runtime.evaluate',
    'Input.insertText',
    'Runtime.evaluate',
    'Runtime.evaluate',
    'detach'
  ]);
});

test('runDebuggerAction clicks with Chrome input pointer events', async () => {
  const { chromeApi, calls } = makeChrome({
    evaluateValue: {
      ok: true,
      result: {
        action: 'resolved-pointer-target',
        handle: 'el_state_2',
        x: 180,
        y: 240
      }
    }
  });

  const result = await runDebuggerAction({
    chromeApi,
    tab: { id: 7, url: 'https://example.com/products' },
    action: 'click',
    params: {
      handle: 'el_state_2',
      target: {
        tag: 'a',
        testid: 'product-link',
        href: 'https://example.com/products/keyboard',
        label: 'Keyboard'
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.provider, 'chrome.debugger.Input.dispatchMouseEvent');
  assert.equal(result.result.action, 'clicked');
  assert.equal(result.result.pointer, true);
  assert.deepEqual(calls.map((call) => call.method), [
    'attach',
    'Runtime.enable',
    'Runtime.evaluate',
    'Input.dispatchMouseEvent',
    'Input.dispatchMouseEvent',
    'Input.dispatchMouseEvent',
    'detach'
  ]);
  const evaluate = calls.find((call) => call.method === 'Runtime.evaluate');
  assert.match(evaluate.params.expression, /"action":"resolvePointerTarget"/);
  assert.match(evaluate.params.expression, /"testid":"product-link"/);
  assert.match(evaluate.params.expression, /"href":"https:\/\/example.com\/products\/keyboard"/);
  const pointerCalls = calls.filter((call) => call.method === 'Input.dispatchMouseEvent');
  assert.deepEqual(pointerCalls.map((call) => call.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.deepEqual(pointerCalls.map((call) => [call.params.x, call.params.y]), [[180, 240], [180, 240], [180, 240]]);
});

test('runtime scroll action scrolls the resolved element when a handle is present', () => {
  const scrollable = {
    tagName: 'DIV',
    id: 'results-pane',
    innerText: 'Results',
    disabled: false,
    scrollLeft: 0,
    scrollTop: 0,
    getAttribute(name) {
      if (name === 'role') return 'region';
      if (name === 'aria-label') return 'Results';
      return '';
    },
    getBoundingClientRect() {
      return { left: 12, top: 40, right: 312, bottom: 240, width: 300, height: 200 };
    },
    scrollIntoView() {
      this.scrolledIntoView = true;
    },
    scrollBy(deltaX, deltaY) {
      this.scrollLeft += deltaX;
      this.scrollTop += deltaY;
    }
  };
  const expression = buildRuntimeActionExpression({
    action: 'scroll',
    handle: 'el_oldstate_0',
    target: {
      tag: 'div',
      role: 'region',
      id: 'results-pane',
      label: 'Results'
    },
    deltaX: 0,
    deltaY: 240
  });
  const context = {
    URL,
    location: { href: 'https://example.com/search' },
    document: {
      title: 'Search',
      querySelectorAll() {
        return [scrollable];
      }
    },
    Number,
    window: {
      scrollX: 0,
      scrollY: 0,
      innerWidth: 1280,
      innerHeight: 720,
      devicePixelRatio: 1,
      getComputedStyle() {
        return { visibility: 'visible', display: 'block' };
      },
      scrollBy(deltaX, deltaY) {
        this.scrollX += deltaX;
        this.scrollY += deltaY;
      }
    }
  };

  const result = require('node:vm').runInNewContext(expression, context);

  assert.equal(result.ok, true);
  assert.equal(result.result.action, 'scrolled');
  assert.equal(result.result.scrollTop, 240);
  assert.equal(result.result.handle, 'el_oldstate_0');
  assert.equal(scrollable.scrolledIntoView, true);
  assert.equal(context.window.scrollY, 0);
});

test('runtime target recovery includes ARIA switch controls', () => {
  const switchControl = {
    tagName: 'DIV',
    id: 'email-alerts',
    innerText: 'Email alerts',
    disabled: false,
    getAttribute(name) {
      if (name === 'role') return 'switch';
      if (name === 'aria-label') return 'Email alerts';
      if (name === 'aria-checked') return 'false';
      return '';
    },
    getBoundingClientRect() {
      return { left: 20, top: 80, right: 120, bottom: 120, width: 100, height: 40 };
    },
    scrollIntoView() {}
  };
  const expression = buildRuntimeActionExpression({
    action: 'resolvePointerTarget',
    handle: 'el_oldstate_0',
    target: { tag: 'div', role: 'switch', id: 'email-alerts', label: 'Email alerts' }
  });
  const context = {
    URL,
    location: { href: 'https://example.com/settings' },
    document: {
      title: 'Settings',
      querySelectorAll(selector) {
        return String(selector).includes('[role="switch"]') ? [switchControl] : [];
      }
    },
    window: {
      innerWidth: 400,
      innerHeight: 300,
      devicePixelRatio: 1,
      getComputedStyle() {
        return { visibility: 'visible', display: 'block' };
      }
    }
  };

  const result = require('node:vm').runInNewContext(expression, context);

  assert.equal(result.ok, true);
  assert.equal(result.result.recovered, true);
  assert.equal(result.result.x, 70);
});

test('runtime fill reports a verification failure when the value is not retained', () => {
  const events = [];
  const input = {
    tagName: 'INPUT',
    id: 'email',
    disabled: false,
    lastAssigned: null,
    get value() {
      return '';
    },
    set value(next) {
      this.lastAssigned = next;
    },
    focus() {
      this.focused = true;
    },
    dispatchEvent(event) {
      events.push(event.type);
    },
    scrollIntoView() {},
    getAttribute(name) {
      if (name === 'type') return 'text';
      if (name === 'placeholder') return 'Email';
      return '';
    },
    getBoundingClientRect() {
      return { left: 20, top: 80, right: 220, bottom: 120, width: 200, height: 40 };
    }
  };
  const expression = buildRuntimeActionExpression({
    action: 'fill',
    handle: 'el_oldstate_0',
    target: { tag: 'input', id: 'email', type: 'text', label: 'Email' },
    text: 'ender@example.com'
  });
  const context = {
    URL,
    Event: function Event(type) {
      this.type = type;
    },
    location: { href: 'https://example.com/form' },
    document: {
      title: 'Form',
      querySelectorAll() {
        return [input];
      }
    },
    window: {
      innerWidth: 400,
      innerHeight: 300,
      getComputedStyle() {
        return { visibility: 'visible', display: 'block' };
      }
    }
  };

  const result = require('node:vm').runInNewContext(expression, context);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ACTION_VERIFICATION_FAILED');
  assert.equal(result.error.reason, 'TARGET_VALUE_MISMATCH');
  assert.equal(result.error.expected, 'ender@example.com');
  assert.equal(result.error.actual, '');
  assert.equal(input.lastAssigned, 'ender@example.com');
  assert.deepEqual(events, ['input', 'change']);
});

test('runtime select verifies the selected value after dispatch', () => {
  let selectedValue = 'basic';
  const select = {
    tagName: 'SELECT',
    id: 'plan',
    disabled: false,
    get value() {
      return selectedValue;
    },
    set value(next) {
      if (next === 'basic') {
        selectedValue = next;
      }
    },
    dispatchEvent() {},
    scrollIntoView() {},
    getAttribute() {
      return '';
    },
    getBoundingClientRect() {
      return { left: 20, top: 80, right: 220, bottom: 120, width: 200, height: 40 };
    }
  };
  const expression = buildRuntimeActionExpression({
    action: 'select',
    handle: 'el_oldstate_0',
    target: { tag: 'select', id: 'plan', role: 'combobox' },
    value: 'premium'
  });
  const context = {
    URL,
    Event: function Event(type) {
      this.type = type;
    },
    location: { href: 'https://example.com/form' },
    document: {
      title: 'Form',
      querySelectorAll() {
        return [select];
      }
    },
    window: {
      innerWidth: 400,
      innerHeight: 300,
      getComputedStyle() {
        return { visibility: 'visible', display: 'block' };
      }
    }
  };

  const result = require('node:vm').runInNewContext(expression, context);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ACTION_VERIFICATION_FAILED');
  assert.equal(result.error.reason, 'TARGET_VALUE_MISMATCH');
  assert.equal(result.error.expected, 'premium');
  assert.equal(result.error.actual, 'basic');
});

test('runtime check supports and verifies ARIA switch controls', () => {
  const events = [];
  let ariaChecked = 'false';
  const switchControl = {
    tagName: 'DIV',
    id: 'email-alerts',
    innerText: 'Email alerts',
    disabled: false,
    setAttribute(name, value) {
      if (name === 'aria-checked') {
        ariaChecked = value;
      }
    },
    getAttribute(name) {
      if (name === 'role') return 'switch';
      if (name === 'aria-label') return 'Email alerts';
      if (name === 'aria-checked') return ariaChecked;
      return '';
    },
    dispatchEvent(event) {
      events.push(event.type);
    },
    scrollIntoView() {},
    getBoundingClientRect() {
      return { left: 20, top: 80, right: 120, bottom: 120, width: 100, height: 40 };
    }
  };
  const expression = buildRuntimeActionExpression({
    action: 'check',
    handle: 'el_oldstate_0',
    target: { tag: 'div', role: 'switch', id: 'email-alerts', label: 'Email alerts' },
    checked: true
  });
  const context = {
    URL,
    Event: function Event(type) {
      this.type = type;
    },
    location: { href: 'https://example.com/settings' },
    document: {
      title: 'Settings',
      querySelectorAll() {
        return [switchControl];
      }
    },
    window: {
      innerWidth: 400,
      innerHeight: 300,
      getComputedStyle() {
        return { visibility: 'visible', display: 'block' };
      }
    }
  };

  const result = require('node:vm').runInNewContext(expression, context);

  assert.equal(result.ok, true);
  assert.equal(result.result.action, 'checked');
  assert.equal(result.result.checked, true);
  assert.equal(result.result.verification.type, 'checked-state');
  assert.equal(ariaChecked, 'true');
  assert.deepEqual(events, ['input', 'change']);
});

test('runtime target recovery uses targetContract when unstable ids change', () => {
  const saveButton = {
    tagName: 'BUTTON',
    id: 'save-new',
    innerText: 'Save settings',
    disabled: false,
    scrollIntoView() {},
    getAttribute(name) {
      if (name === 'type') return 'button';
      return '';
    },
    getBoundingClientRect() {
      return { left: 40, top: 80, right: 180, bottom: 120, width: 140, height: 40 };
    }
  };
  const expression = buildRuntimeActionExpression({
    action: 'resolvePointerTarget',
    handle: 'el_oldstate_0',
    target: {
      tag: 'button',
      id: 'save-old',
      label: 'Save settings',
      targetContract: {
        version: 1,
        tag: 'button',
        role: 'button',
        accessibleName: 'Save settings',
        label: 'Save settings'
      }
    }
  });
  const context = {
    URL,
    location: { href: 'https://example.com/settings' },
    document: {
      title: 'Settings',
      querySelectorAll() {
        return [saveButton];
      }
    },
    window: {
      innerWidth: 400,
      innerHeight: 300,
      getComputedStyle() {
        return { visibility: 'visible', display: 'block' };
      }
    }
  };

  const result = require('node:vm').runInNewContext(expression, context);

  assert.equal(result.ok, true);
  assert.equal(result.result.recovered, true);
  assert.equal(result.result.recovery.strategy, 'target-contract');
  assert.equal(result.result.x, 110);
  assert.equal(result.result.targetSnapshot.bbox.x, 40);
  assert.equal(result.result.targetSnapshot.bbox.y, 80);
  assert.equal(result.result.targetSnapshot.bbox.width, 140);
  assert.equal(result.result.targetSnapshot.bbox.height, 40);
  assert.equal(result.result.targetSnapshot.label, 'Save settings');
});

test('runtime pointer target refuses occluded click targets', () => {
  const overlay = {
    tagName: 'DIV',
    id: 'sticky-overlay',
    innerText: 'Sticky overlay',
    getAttribute(name) {
      if (name === 'role') return 'dialog';
      return '';
    }
  };
  const saveButton = {
    tagName: 'BUTTON',
    id: 'save',
    innerText: 'Save settings',
    disabled: false,
    scrollIntoView() {},
    getAttribute(name) {
      if (name === 'type') return 'button';
      return '';
    },
    contains(candidate) {
      return candidate === this;
    },
    getBoundingClientRect() {
      return { left: 40, top: 80, right: 180, bottom: 120, width: 140, height: 40 };
    }
  };
  const expression = buildRuntimeActionExpression({
    action: 'resolvePointerTarget',
    handle: 'el_oldstate_0',
    target: { tag: 'button', role: 'button', id: 'save', label: 'Save settings' }
  });
  const context = {
    URL,
    location: { href: 'https://example.com/settings' },
    document: {
      title: 'Settings',
      querySelectorAll() {
        return [saveButton];
      },
      elementFromPoint() {
        return overlay;
      }
    },
    window: {
      innerWidth: 400,
      innerHeight: 300,
      getComputedStyle() {
        return { visibility: 'visible', display: 'block', pointerEvents: 'auto' };
      }
    }
  };

  const result = require('node:vm').runInNewContext(expression, context);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ACTIONABILITY_FAILED');
  assert.equal(result.error.reason, 'TARGET_OCCLUDED');
  assert.equal(result.error.freshObservationRequired, true);
  assert.equal(result.error.blocker.tag, 'div');
  assert.equal(result.error.blocker.role, 'dialog');
});

test('runtime pointer target trusts fresh observed occlusion metadata', () => {
  const skipButton = {
    tagName: 'BUTTON',
    id: '',
    innerText: 'Skip to timeline',
    disabled: false,
    scrollIntoView() {},
    getAttribute(name) {
      if (name === 'role') return 'button';
      if (name === 'type') return 'button';
      return '';
    },
    contains(candidate) {
      return candidate === this;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 36, bottom: 36, width: 36, height: 36 };
    }
  };
  const expression = buildRuntimeActionExpression({
    action: 'resolvePointerTarget',
    handle: 'el_oldstate_0',
    target: {
      tag: 'button',
      role: 'button',
      label: 'Skip to timeline',
      occluded: true,
      bbox: { x: 0, y: 0, width: 36, height: 36 },
      context: {
        url: 'https://x.com/home',
        viewport: { width: 1280, height: 687 },
        scroll: { x: 0, y: 0 },
        devicePixelRatio: 1.5
      }
    }
  });
  const context = {
    URL,
    location: { href: 'https://x.com/home' },
    document: {
      title: 'X',
      querySelectorAll() {
        return [skipButton];
      },
      elementFromPoint() {
        return skipButton;
      }
    },
    window: {
      innerWidth: 1280,
      innerHeight: 687,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 1.5,
      getComputedStyle() {
        return { visibility: 'visible', display: 'block', pointerEvents: 'auto' };
      }
    }
  };

  const result = require('node:vm').runInNewContext(expression, context);

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ACTIONABILITY_FAILED');
  assert.equal(result.error.reason, 'TARGET_OCCLUDED');
  assert.equal(result.error.blocker, null);
  assert.equal(result.error.point.x, 18);
  assert.equal(result.error.point.y, 18);
});

test('runtime target recovery narrows repeated test ids with label text', () => {
  function button(label, left) {
    return {
      tagName: 'BUTTON',
      id: '',
      innerText: label,
      disabled: false,
      scrollIntoView() {},
      getAttribute(name) {
        if (name === 'data-testid') return 'reply';
        if (name === 'type') return 'button';
        return '';
      },
      getBoundingClientRect() {
        return { left, top: 100, right: left + 40, bottom: 140, width: 40, height: 40 };
      }
    };
  }

  const buttons = [button('12 Yanıt. Yanıt', 10), button('32 Yanıt. Yanıt', 80)];
  const expression = buildRuntimeActionExpression({
    action: 'resolvePointerTarget',
    handle: 'el_oldstate_0',
    target: { tag: 'button', testid: 'reply', label: '32 Yanıt. Yanıt' }
  });
  const context = {
    URL,
    location: { href: 'https://x.com/status/1' },
    document: {
      title: 'X',
      querySelectorAll() {
        return buttons;
      }
    },
    window: {
      innerWidth: 400,
      innerHeight: 300,
      getComputedStyle() {
        return { visibility: 'visible', display: 'block' };
      }
    }
  };

  const result = require('node:vm').runInNewContext(expression, context);

  assert.equal(result.ok, true);
  assert.equal(result.result.recovered, true);
  assert.equal(result.result.x, 100);
});

test('runtime target recovery uses data-testid from content target summaries', () => {
  function button(testid, top) {
    return {
      tagName: 'BUTTON',
      id: '',
      innerText: 'Yanıtla',
      disabled: false,
      scrollIntoView() {},
      getAttribute(name) {
        if (name === 'data-testid') return testid;
        if (name === 'type') return 'button';
        if (name === 'role') return 'button';
        return '';
      },
      getBoundingClientRect() {
        return { left: 100, top, right: 184, bottom: top + 36, width: 84, height: 36 };
      }
    };
  }

  const buttons = [
    button('tweetButton', 900),
    button('tweetButtonInline', 580)
  ];
  const expression = buildRuntimeActionExpression({
    action: 'resolvePointerTarget',
    handle: 'el_oldstate_0',
    target: {
      tag: 'button',
      role: 'button',
      type: 'button',
      data: { testid: 'tweetButtonInline' },
      label: 'Yanıtla'
    }
  });
  const context = {
    URL,
    location: { href: 'https://x.com/intent/post' },
    document: {
      title: 'X',
      querySelectorAll() {
        return buttons;
      }
    },
    window: {
      innerWidth: 1400,
      innerHeight: 1000,
      getComputedStyle() {
        return { visibility: 'visible', display: 'block' };
      }
    }
  };

  const result = require('node:vm').runInNewContext(expression, context);

  assert.equal(result.ok, true);
  assert.equal(result.result.recovered, true);
  assert.equal(result.result.y, 598);
});

test('runtime target recovery matches native controls with implicit role/type and data-test-id', () => {
  const button = {
    tagName: 'BUTTON',
    id: '',
    type: 'button',
    innerText: 'Yanıtla',
    disabled: false,
    scrollIntoView() {},
    getAttribute(name) {
      if (name === 'data-test-id') return 'tweetButton';
      return '';
    },
    getBoundingClientRect() {
      return { left: 100, top: 900, right: 184, bottom: 936, width: 84, height: 36 };
    }
  };
  const expression = buildRuntimeActionExpression({
    action: 'resolvePointerTarget',
    handle: 'el_oldstate_0',
    target: {
      tag: 'button',
      role: 'button',
      type: 'button',
      data: { 'data-test-id': 'tweetButton' },
      label: 'Yanıtla'
    }
  });
  const context = {
    URL,
    location: { href: 'https://x.com/intent/post' },
    document: {
      title: 'X',
      querySelectorAll() {
        return [button];
      }
    },
    window: {
      innerWidth: 1400,
      innerHeight: 1000,
      scrollX: 0,
      scrollY: 0,
      getComputedStyle() {
        return { visibility: 'visible', display: 'block' };
      }
    }
  };

  const result = require('node:vm').runInNewContext(expression, context);

  assert.equal(result.ok, true);
  assert.equal(result.result.recovered, true);
  assert.equal(result.result.y, 918);
});

test('runtime target recovery narrows duplicate controls by target bbox', () => {
  function button(top) {
    return {
      tagName: 'BUTTON',
      id: '',
      innerText: 'Yanıtla',
      disabled: false,
      scrollIntoView() {},
      getAttribute(name) {
        if (name === 'data-testid') return 'tweetButton';
        if (name === 'type') return 'button';
        if (name === 'role') return 'button';
        return '';
      },
      getBoundingClientRect() {
        return { left: 100, top, right: 184, bottom: top + 36, width: 84, height: 36 };
      }
    };
  }

  const buttons = [button(580), button(900)];
  const expression = buildRuntimeActionExpression({
    action: 'resolvePointerTarget',
    handle: 'el_oldstate_0',
    target: {
      tag: 'button',
      role: 'button',
      type: 'button',
      testid: 'tweetButton',
      label: 'Yanıtla',
      bbox: { x: 100, y: 900, width: 84, height: 36 },
      context: {
        url: 'https://x.com/intent/post',
        viewport: { width: 1400, height: 1000 },
        scroll: { x: 0, y: 0 },
        devicePixelRatio: 1
      }
    }
  });
  const context = {
    URL,
    location: { href: 'https://x.com/intent/post' },
    document: {
      title: 'X',
      querySelectorAll() {
        return buttons;
      }
    },
    window: {
      innerWidth: 1400,
      innerHeight: 1000,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 1,
      getComputedStyle() {
        return { visibility: 'visible', display: 'block' };
      }
    }
  };

  const result = require('node:vm').runInNewContext(expression, context);

  assert.equal(result.ok, true);
  assert.equal(result.result.recovered, true);
  assert.equal(result.result.y, 918);
});

test('runtime target recovery refuses bbox narrowing when snapshot layout context drifted', () => {
  function button(top) {
    return {
      tagName: 'BUTTON',
      id: '',
      innerText: 'Yanıtla',
      disabled: false,
      scrollIntoView() {},
      getAttribute(name) {
        if (name === 'data-testid') return 'tweetButton';
        if (name === 'type') return 'button';
        if (name === 'role') return 'button';
        return '';
      },
      getBoundingClientRect() {
        return { left: 100, top, right: 184, bottom: top + 36, width: 84, height: 36 };
      }
    };
  }

  const buttons = [button(580), button(900)];
  const expression = buildRuntimeActionExpression({
    action: 'resolvePointerTarget',
    handle: 'el_oldstate_0',
    target: {
      tag: 'button',
      role: 'button',
      type: 'button',
      testid: 'tweetButton',
      label: 'Yanıtla',
      bbox: { x: 100, y: 900, width: 84, height: 36 },
      context: {
        url: 'https://x.com/intent/post',
        viewport: { width: 1400, height: 1000 },
        scroll: { x: 0, y: 600 },
        devicePixelRatio: 1
      }
    }
  });
  const context = {
    URL,
    location: { href: 'https://x.com/intent/post' },
    document: {
      title: 'X',
      querySelectorAll() {
        return buttons;
      }
    },
    window: {
      innerWidth: 1400,
      innerHeight: 1000,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 1,
      getComputedStyle() {
        return { visibility: 'visible', display: 'block' };
      }
    }
  };

  const result = require('node:vm').runInNewContext(expression, context);

  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'RECOVERY_NOT_UNIQUE');
  assert.equal(result.error.matchCount, 2);
});
