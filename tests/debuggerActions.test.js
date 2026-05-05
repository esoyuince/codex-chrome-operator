const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRuntimeActionExpression,
  isDebuggerSupportedUrl,
  runDebuggerAction
} = require('../extension/debuggerActions');

function makeChrome({ evaluateValue } = {}) {
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
        if (method === 'Runtime.evaluate') {
          callback({
            result: {
              value: evaluateValue || {
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

test('runtime scroll action scrolls the page even when a handle is present', () => {
  const expression = buildRuntimeActionExpression({
    action: 'scroll',
    handle: 'el_state_0',
    deltaX: 0,
    deltaY: 240
  });
  const context = {
    Number,
    window: {
      scrollX: 0,
      scrollY: 0,
      scrollBy(deltaX, deltaY) {
        this.scrollX += deltaX;
        this.scrollY += deltaY;
      }
    }
  };

  const result = require('node:vm').runInNewContext(expression, context);

  assert.equal(result.ok, true);
  assert.equal(result.result.action, 'scrolled');
  assert.equal(result.result.scrollY, 240);
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
