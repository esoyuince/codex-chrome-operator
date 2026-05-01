const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function element(tagName, attrs = {}, children = []) {
  const node = {
    tagName: tagName.toUpperCase(),
    id: attrs.id || '',
    value: attrs.value || '',
    checked: Boolean(attrs.checked),
    disabled: Boolean(attrs.disabled),
    multiple: Boolean(attrs.multiple),
    dataset: attrs.dataset || {},
    children,
    childNodes: attrs.text ? [{ nodeType: 3, textContent: attrs.text }] : [],
    innerText: attrs.text || '',
    textContent: attrs.text || '',
    focused: false,
    events: [],
    getAttribute(name) {
      return attrs[name] === undefined ? null : attrs[name];
    },
    matches(selector) {
      if (selector === 'input[type="password"], [autocomplete="one-time-code"]') {
        return this.tagName === 'INPUT' && attrs.type === 'password';
      }
      if (selector === 'input[type="file"]') {
        return this.tagName === 'INPUT' && attrs.type === 'file';
      }
      return false;
    },
    querySelector() {
      return null;
    },
    getBoundingClientRect() {
      return { x: 10, y: 20, width: 160, height: 32 };
    },
    focus() {
      this.focused = true;
    },
    dispatchEvent(event) {
      this.events.push(event.type);
    }
  };
  for (const child of children) {
    child.parentElement = node;
  }
  return node;
}

function loadContentScript(rootElement) {
  let listener = null;
  const context = {
    console,
    location: { href: 'https://example.com/form', origin: 'https://example.com' },
    Event: function Event(type) {
      this.type = type;
    },
    KeyboardEvent: function KeyboardEvent(type, options = {}) {
      this.type = type;
      this.key = options.key || '';
    },
    window: {
      innerWidth: 1280,
      innerHeight: 720,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 1,
      getComputedStyle() {
        return {
          display: 'block',
          visibility: 'visible',
          opacity: '1'
        };
      },
      scrollBy(deltaX = 0, deltaY = 0) {
        this.scrollX += deltaX;
        this.scrollY += deltaY;
      }
    },
    document: {
      title: 'Fixture',
      body: rootElement,
      activeElement: null,
      querySelectorAll() {
        return [];
      },
      querySelector() {
        return null;
      },
      getElementById() {
        return null;
      }
    },
    chrome: {
      runtime: {
        onMessage: {
          addListener(callback) {
            listener = callback;
          }
        }
      }
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  for (const relativePath of [
    'extension/pageHandles.js',
    'extension/pageReader.js',
    'extension/contentScript.js'
  ]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'), context, {
      filename: relativePath
    });
  }
  assert.equal(typeof listener, 'function');
  return {
    async send(message) {
      return new Promise((resolve) => {
        listener(message, {}, resolve);
      });
    }
  };
}

test('content script can use compact read_page handles for follow-up DOM actions', async () => {
  const input = element('input', {
    id: 'email',
    type: 'email',
    placeholder: 'name@example.com'
  });
  const root = element('main', {}, [
    element('h1', { text: 'Checkout' }),
    input
  ]);
  const content = loadContentScript(root);

  const read = await content.send({
    type: 'content.readPage',
    filter: 'all',
    depth: 4,
    maxChars: 1200
  });
  assert.equal(read.ok, true);
  const inputHandle = read.result.handles.find((handle) => handle.tag === 'input').handle;

  const filled = await content.send({
    type: 'content.action',
    action: 'fill',
    handle: inputHandle,
    text: 'captain@example.com'
  });
  assert.equal(filled.ok, true);
  assert.equal(input.value, 'captain@example.com');
  assert.deepEqual(input.events, ['input', 'change']);
});
