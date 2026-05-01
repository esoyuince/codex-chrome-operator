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
