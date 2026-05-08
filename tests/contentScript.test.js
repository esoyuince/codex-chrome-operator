const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function element(tagName, attrs = {}, children = []) {
  const node = {
    __attrs: { ...attrs },
    tagName: tagName.toUpperCase(),
    id: attrs.id || '',
    value: attrs.value || '',
    checked: Boolean(attrs.checked),
    disabled: Boolean(attrs.disabled),
    multiple: Boolean(attrs.multiple),
    dataset: {
      ...(attrs.dataset || {}),
      ...Object.fromEntries(Object.entries(attrs)
        .filter(([key]) => key.startsWith('data-'))
        .map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), String(value)]))
    },
    children,
    shadowRoot: attrs.shadowRoot || null,
    get contentDocument() {
      if (attrs.contentDocumentThrows) {
        throw new Error('Blocked cross-origin frame');
      }
      return attrs.contentDocument || null;
    },
    childNodes: attrs.text ? [{ nodeType: 3, textContent: attrs.text }] : [],
    innerText: attrs.text || '',
    textContent: attrs.text || '',
    focused: false,
    events: [],
    getAttribute(name) {
      return this.__attrs[name] === undefined ? null : this.__attrs[name];
    },
    setAttribute(name, value) {
      this.__attrs[name] = String(value);
      if (name === 'id') {
        this.id = String(value);
      }
    },
    matches(selector) {
      if (selector === 'input[type="password"], [autocomplete="one-time-code"]') {
        return this.tagName === 'INPUT' && this.__attrs.type === 'password';
      }
      if (selector === 'input[type="file"]') {
        return this.tagName === 'INPUT' && this.__attrs.type === 'file';
      }
      return false;
    },
    querySelector(selector) {
      return flattenElements(this).find((node) => node !== this && selectorMatchesElement(selector, node)) || null;
    },
    querySelectorAll(selector) {
      const selectors = selector.split(',').map((item) => item.trim());
      return flattenElements(this).filter((node) => node !== this && selectors.some((part) => selectorMatchesElement(part, node)));
    },
    getBoundingClientRect() {
      return { x: 10, y: 20, width: 160, height: 32 };
    },
    focus() {
      this.focused = true;
    },
    click() {
      this.events.push('click');
      if (typeof attrs.onClick === 'function') {
        attrs.onClick(this);
      }
    },
    dispatchEvent(event) {
      this.events.push(event.type);
    },
    contains(target) {
      return flattenElements(this).includes(target);
    },
    closest(selector) {
      let current = this.parentElement || null;
      while (current) {
        if (selectorMatchesElement(selector, current)) {
          return current;
        }
        current = current.parentElement || null;
      }
      return null;
    }
  };
  for (const child of children) {
    child.parentElement = node;
  }
  return node;
}

function flattenElements(rootElement) {
  const results = [];
  function visit(node) {
    if (!node || !node.tagName) {
      return;
    }
    results.push(node);
    if (node.shadowRoot) {
      visit(node.shadowRoot);
    }
    try {
      if (node.contentDocument && node.contentDocument.body) {
        visit(node.contentDocument.body);
      }
    } catch {
      // Cross-origin iframe fixture.
    }
    for (const child of node.children || []) {
      visit(child);
    }
  }
  visit(rootElement);
  return results;
}

function selectorMatchesElement(selector, node) {
  if (selector === '*') {
    return true;
  }
  if (selector === 'a') {
    return node.tagName === 'A';
  }
  if (selector === 'button') {
    return node.tagName === 'BUTTON';
  }
  if (selector === 'input') {
    return node.tagName === 'INPUT';
  }
  if (selector === 'video') {
    return node.tagName === 'VIDEO';
  }
  if (selector === 'audio') {
    return node.tagName === 'AUDIO';
  }
  if (selector === 'textarea') {
    return node.tagName === 'TEXTAREA';
  }
  if (selector === 'form') {
    return node.tagName === 'FORM';
  }
  if (selector === 'label') {
    return node.tagName === 'LABEL';
  }
  if (selector === 'iframe') {
    return node.tagName === 'IFRAME';
  }
  if (selector === 'select') {
    return node.tagName === 'SELECT';
  }
  if (selector === '[role="button"]') {
    return node.getAttribute('role') === 'button';
  }
  if (selector === '[role="link"]') {
    return node.getAttribute('role') === 'link';
  }
  if (selector === '[contenteditable="true"]') {
    return node.getAttribute('contenteditable') === 'true';
  }
  if (selector === '[data-visual-card="product"]') {
    return node.getAttribute('data-visual-card') === 'product';
  }
  if (selector === '[data-test-id="product-card"]') {
    return node.getAttribute('data-test-id') === 'product-card';
  }
  if (selector === '[data-test-id="product-title"]') {
    return node.getAttribute('data-test-id') === 'product-title';
  }
  if (selector === '[data-test-id="price-current"]') {
    return node.getAttribute('data-test-id') === 'price-current';
  }
  if (selector === '[data-test-id="add-to-cart"]') {
    return node.getAttribute('data-test-id') === 'add-to-cart';
  }
  if (selector === 'a[href]') {
    return node.tagName === 'A' && Boolean(node.getAttribute('href'));
  }
  if (selector === '[data-cart-action="add"]') {
    return node.getAttribute('data-cart-action') === 'add';
  }
  if (selector === '[data-product-id]') {
    return Boolean(node.getAttribute('data-product-id'));
  }
  if (selector === 'article' || selector === 'li' || selector === 'h2' || selector === 'h3' || selector === 'span') {
    return node.tagName.toLowerCase() === selector;
  }
  if (selector === 'main' || selector === 'nav' || selector === 'header' || selector === 'footer' || selector === 'aside') {
    return node.tagName.toLowerCase() === selector;
  }
  if (selector === '[role="main"]') {
    return node.getAttribute('role') === 'main';
  }
  if (selector === '[role="navigation"]') {
    return node.getAttribute('role') === 'navigation';
  }
  if (selector === '[role="banner"]') {
    return node.getAttribute('role') === 'banner';
  }
  if (selector === '[role="contentinfo"]') {
    return node.getAttribute('role') === 'contentinfo';
  }
  if (selector === '[role="complementary"]') {
    return node.getAttribute('role') === 'complementary';
  }
  return false;
}

function loadContentScript(rootElement) {
  let listener = null;
  let listenerCount = 0;
  let removeCount = 0;
  const activeListeners = new Set();
  const allElements = flattenElements(rootElement);
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
      querySelectorAll(selector) {
        const selectors = selector.split(',').map((item) => item.trim());
        return allElements.filter((node) => selectors.some((part) => selectorMatchesElement(part, node)));
      },
      elementFromPoint(x, y) {
        return [...allElements].reverse().find((node) => {
          const rect = node.getBoundingClientRect();
          return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
        }) || null;
      },
      querySelector(selector) {
        const selectors = selector.split(',').map((item) => item.trim());
        return allElements.find((node) => selectors.some((part) => selectorMatchesElement(part, node))) || null;
      },
      getElementById(id) {
        return allElements.find((node) => node.id === id) || null;
      }
    },
    chrome: {
      runtime: {
        getManifest() {
          return { version: '0.2.11' };
        },
        onMessage: {
          addListener(callback) {
            listener = callback;
            activeListeners.add(callback);
            listenerCount += 1;
          },
          removeListener(callback) {
            if (activeListeners.delete(callback)) {
              removeCount += 1;
            }
            if (listener === callback) {
              listener = null;
            }
          }
        }
      }
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  for (const relativePath of [
    'extension/actionPolicy.js',
    'extension/pageHandles.js',
    'extension/pageReader.js',
    'extension/intentExtractors.js',
    'extension/uiGraph.js',
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
    },
    get listenerCount() {
      return listenerCount;
    },
    get removeCount() {
      return removeCount;
    },
    get activeListenerCount() {
      return activeListeners.size;
    },
    runScriptAgain() {
      vm.runInContext(fs.readFileSync(path.join(ROOT, 'extension/contentScript.js'), 'utf8'), context, {
        filename: 'extension/contentScript.js'
      });
      return activeListeners.size;
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

test('content script tolerates duplicate injection without duplicate listener registration', async () => {
  const root = element('main', {}, [
    element('button', { text: 'Save draft' })
  ]);
  const content = loadContentScript(root);

  assert.equal(content.listenerCount, 1);
  assert.equal(content.activeListenerCount, 1);
  assert.equal(content.runScriptAgain(), 1);
  assert.equal(content.listenerCount, 2);
  assert.equal(content.removeCount, 1);
  assert.equal(content.activeListenerCount, 1);
  const observed = await content.send({ type: 'content.observe' });

  assert.equal(observed.origin, 'https://example.com');
  assert.equal(observed.contentScriptVersion, '0.2.11');
  assert.equal(observed.elements.length, 1);
});

test('content readPage can include safe textarea values for long-form copy', async () => {
  const root = element('main', {}, [
    element('textarea', {
      id: 'full-description',
      'aria-label': 'Full description',
      value: 'CaptainCalc ist das Offline-Navigationswerkzeug fuer Kapitaene.'
    })
  ]);
  const content = loadContentScript(root);

  const read = await content.send({
    type: 'content.readPage',
    filter: 'all',
    depth: 4,
    maxChars: 2000,
    includeFormValues: true,
    maxFieldValueChars: 22
  });

  assert.equal(read.ok, true);
  assert.match(read.result.pageContent, /value="CaptainCalc ist das Of"/);
  assert.equal(
    read.result.handles.find((handle) => handle.tag === 'textarea').value,
    'CaptainCalc ist das Of'
  );
});

test('content observe includes safe form values only when explicitly requested', async () => {
  const root = element('main', {}, [
    element('textarea', {
      id: 'full-description',
      'aria-label': 'Full description',
      value: 'CaptainCalc ist das Offline-Navigationswerkzeug fuer Kapitaene.'
    }),
    element('input', {
      id: 'support-email',
      type: 'email',
      value: 'captain@example.com'
    })
  ]);
  const content = loadContentScript(root);

  const observed = await content.send({
    type: 'content.observe',
    mode: 'full',
    includeFormValues: true,
    maxFieldValueChars: 14
  });

  assert.equal(observed.elements.find((entry) => entry.tag === 'textarea').value, 'CaptainCalc is');
  assert.equal(Object.hasOwn(observed.elements.find((entry) => entry.tag === 'input'), 'value'), false);
  assert.equal(observed.elements.find((entry) => entry.tag === 'input').label, '');
  assert.doesNotMatch(JSON.stringify(observed), /captain@example\.com/);
});

test('content observe keeps text input values out of labels unless explicitly requested as values', async () => {
  const root = element('main', {}, [
    element('input', {
      id: 'draft-title',
      type: 'text',
      placeholder: 'Title',
      value: 'Private launch draft'
    })
  ]);
  const content = loadContentScript(root);

  const defaultObserved = await content.send({
    type: 'content.observe',
    mode: 'full'
  });
  const valueObserved = await content.send({
    type: 'content.observe',
    mode: 'full',
    includeFormValues: true,
    maxFieldValueChars: 12
  });

  assert.equal(defaultObserved.elements[0].label, 'Title');
  assert.equal(Object.hasOwn(defaultObserved.elements[0], 'value'), false);
  assert.doesNotMatch(JSON.stringify(defaultObserved), /Private launch draft/);
  assert.equal(valueObserved.elements[0].label, 'Title');
  assert.equal(valueObserved.elements[0].value, 'Private laun');
});

test('content observe defaults to tiny bounded observation', async () => {
  const buttons = Array.from({ length: 55 }, (_, index) => element('button', {
    id: `action-${index}`,
    text: `Action ${index}`
  }));
  const root = element('main', { text: 'Checkout '.repeat(200) }, [
    element('nav', { text: 'Primary navigation' }),
    ...buttons
  ]);
  const content = loadContentScript(root);

  const observed = await content.send({ type: 'content.observe' });

  assert.equal(observed.origin, 'https://example.com');
  assert.equal(observed.title, 'Fixture');
  assert.equal(typeof observed.pageStateId, 'string');
  assert.equal(observed.observationMode, 'tiny');
  assert.equal(observed.elements.length, 30);
  assert.equal(observed.visibleTextSummary.length <= observed.limits.summaryMaxChars, true);
  assert.equal(observed.limits.maxActionableHandles, 30);
  assert.ok(observed.landmarks.some((landmark) => landmark.tag === 'main'));
  assert.equal(observed.visualPolicy.screenshot, 'allowed');
  assert.equal(observed.riskSummary.detectedHighRiskControls.length, 0);
  assert.equal(observed.viewport.width, 1280);
  assert.ok(JSON.stringify(observed).length < 12000, 'tiny observe should stay under the fixture budget');
});

test('content observe supports medium and explicit full modes', async () => {
  const buttons = Array.from({ length: 120 }, (_, index) => element('button', {
    id: `action-${index}`,
    text: `Action ${index}`
  }));
  const root = element('main', { text: 'Catalog '.repeat(500) }, buttons);
  const content = loadContentScript(root);

  const medium = await content.send({
    type: 'content.observe',
    mode: 'medium',
    maxActionableHandles: 45,
    summaryMaxChars: 700
  });
  const full = await content.send({
    type: 'content.observe',
    mode: 'full'
  });

  assert.equal(medium.observationMode, 'medium');
  assert.equal(medium.elements.length, 45);
  assert.equal(medium.visibleTextSummary.length <= 700, true);
  assert.equal(medium.limits.defaultMaxActionableHandles, 80);
  assert.equal(full.observationMode, 'full');
  assert.equal(full.elements.length, 120);
  assert.equal(full.limits.defaultMaxActionableHandles, 300);
  assert.equal(full.visibleTextSummary.length > medium.visibleTextSummary.length, true);
});

test('content observe can include a fallback uiGraph for icon-only accessible buttons', async () => {
  const root = element('main', { text: 'Toolbar' }, [
    element('button', { 'aria-label': 'Search' }),
    element('button', { 'aria-label': 'Close dialog' })
  ]);
  const content = loadContentScript(root);

  const observed = await content.send({
    type: 'content.observe',
    includeAx: true,
    mode: 'medium'
  });

  assert.equal(observed.capabilities.uiGraph, true);
  assert.equal(observed.capabilities.axAvailable, false);
  assert.equal(observed.uiGraph.version, 'uiGraph.v1');
  assert.equal(observed.uiGraph.source, 'dom-fallback');
  assert.deepEqual([...observed.uiGraph.nodes.map((node) => node.name)], ['Search', 'Close dialog']);
  assert.deepEqual([...observed.uiGraph.nodes.map((node) => node.role)], ['button', 'button']);
  assert.match(observed.uiGraph.nodes[0].targetId, /^ui_/);
  assert.equal(observed.uiGraph.nodes[0].target.confidence, observed.uiGraph.nodes[0].confidence);
  assert.ok(observed.uiGraph.nodes[0].target.evidence.includes('dom-label'));
  assert.equal(observed.uiGraph.nodes[0].confidence >= 0.5, true);
  assert.ok(observed.uiGraph.nodes[0].evidence.includes('dom-label'));
});

test('content observe includes controls from open shadow roots and same-origin iframes', async () => {
  const shadowButton = element('button', { 'aria-label': 'Shadow save' });
  const host = element('section', {
    shadowRoot: element('div', {}, [shadowButton])
  });
  const frameButton = element('button', { 'aria-label': 'Frame submit' });
  const iframe = element('iframe', {
    contentDocument: {
      body: element('main', {}, [frameButton])
    }
  });
  const root = element('main', { text: 'Shell' }, [host, iframe]);
  const content = loadContentScript(root);

  const observed = await content.send({
    type: 'content.observe',
    mode: 'medium',
    includeAx: true
  });

  assert.ok(observed.elements.some((entry) => entry.label === 'Shadow save'));
  assert.ok(observed.elements.some((entry) => entry.label === 'Frame submit'));
  assert.ok(observed.uiGraph.nodes.some((node) => node.name === 'Shadow save'));
  assert.ok(observed.uiGraph.nodes.some((node) => node.name === 'Frame submit'));
});

test('content observe marks UI graph nodes occluded when hit testing finds an overlay', async () => {
  const covered = element('button', { 'aria-label': 'Covered action' });
  covered.getBoundingClientRect = () => ({ x: 10, y: 20, width: 160, height: 32 });
  const overlay = element('div', { text: 'Overlay' });
  overlay.getBoundingClientRect = () => ({ x: 10, y: 20, width: 160, height: 32 });
  const root = element('main', {}, [covered, overlay]);
  const content = loadContentScript(root);

  const observed = await content.send({
    type: 'content.observe',
    includeAx: true,
    mode: 'medium'
  });
  const node = observed.uiGraph.nodes.find((entry) => entry.name === 'Covered action');

  assert.equal(node.states.occluded, true);
  assert.ok(node.evidence.includes('hit-test-occluded'));
});

test('content observe reports inaccessible cross-origin iframe boundaries', async () => {
  const root = element('main', {}, [
    element('iframe', {
      src: 'https://video.example/embed/1',
      title: 'Hosted video',
      contentDocumentThrows: true
    })
  ]);
  const content = loadContentScript(root);

  const observed = await content.send({ type: 'content.observe', mode: 'medium' });

  assert.equal(observed.frames.length, 1);
  assert.equal(observed.frames[0].kind, 'iframe');
  assert.equal(observed.frames[0].src, 'https://video.example/embed/1');
  assert.equal(observed.frames[0].title, 'Hosted video');
  assert.equal(observed.frames[0].accessible, false);
  assert.equal(observed.frames[0].errorCode, 'CROSS_ORIGIN_FRAME_INACCESSIBLE');
  assert.equal(observed.frames[0].bbox.width, 160);
});

test('content observe returns compact unchanged delta without element dump', async () => {
  const root = element('main', { text: 'Stable page' }, [
    element('button', {
      id: 'save',
      text: 'Save draft'
    })
  ]);
  const content = loadContentScript(root);

  const first = await content.send({
    type: 'content.observe',
    maxActionableHandles: 10
  });
  const second = await content.send({
    type: 'content.observe',
    sincePageStateId: first.pageStateId,
    maxActionableHandles: 10
  });

  assert.equal(second.pageStateId, first.pageStateId);
  assert.equal(Object.hasOwn(second, 'elements'), false);
  assert.equal(second.delta.unchanged, true);
  assert.equal(second.delta.fromPageStateId, first.pageStateId);
  assert.equal(second.delta.toPageStateId, first.pageStateId);
  assert.equal(second.delta.newHandles.length, 0);
  assert.equal(second.delta.removedHandles.length, 0);
  assert.equal(second.delta.changedElements.length, 0);
});

test('content observe returns bounded changed delta for same-page mutations', async () => {
  const button = element('button', {
    id: 'save',
    'aria-label': 'Save draft',
    text: 'Save draft'
  });
  const root = element('main', { text: 'Draft form' }, [button]);
  const content = loadContentScript(root);

  const first = await content.send({
    type: 'content.observe',
    maxActionableHandles: 1
  });
  button.setAttribute('aria-label', 'Save final draft');
  button.innerText = 'Save final draft';
  const second = await content.send({
    type: 'content.observe',
    sincePageStateId: first.pageStateId,
    maxActionableHandles: 1
  });

  assert.notEqual(second.pageStateId, first.pageStateId);
  assert.equal(second.elements.length, 1);
  assert.equal(second.delta.unchanged, false);
  assert.equal(second.delta.fromPageStateId, first.pageStateId);
  assert.equal(second.delta.toPageStateId, second.pageStateId);
  assert.equal(second.delta.newHandles.length <= 1, true);
  assert.equal(second.delta.removedHandles.length <= 1, true);
  assert.equal(second.delta.changedElements.length, 1);
  assert.equal(second.delta.changedElements[0].id, 'save');
  assert.equal(second.delta.changedElements[0].label, 'Save final draft');
});

test('content observe invalidates delta when base snapshot is missing', async () => {
  const root = element('main', { text: 'Missing base' }, [
    element('button', {
      id: 'continue',
      text: 'Continue'
    })
  ]);
  const content = loadContentScript(root);

  const observed = await content.send({
    type: 'content.observe',
    sincePageStateId: 'missing_state',
    maxActionableHandles: 5
  });

  assert.equal(observed.delta.invalidated, true);
  assert.equal(observed.delta.reason, 'BASE_SNAPSHOT_MISSING');
  assert.equal(observed.delta.fromPageStateId, 'missing_state');
  assert.equal(observed.delta.toPageStateId, observed.pageStateId);
  assert.equal(observed.elements.length, 1);
});

test('content actions can attach post-action delta snapshots when requested', async () => {
  const input = element('input', {
    id: 'email',
    type: 'email',
    placeholder: 'name@example.com'
  });
  const root = element('main', { text: 'Contact form' }, [input]);
  const content = loadContentScript(root);

  const observed = await content.send({
    type: 'content.observe',
    maxActionableHandles: 5
  });
  const inputHandle = observed.elements.find((entry) => entry.tag === 'input').handle;

  const filled = await content.send({
    type: 'content.action',
    action: 'fill',
    handle: inputHandle,
    text: 'captain@example.com',
    postActionSnapshot: 'delta',
    sincePageStateId: observed.pageStateId,
    maxActionableHandles: 5
  });

  assert.equal(filled.ok, true);
  assert.equal(input.value, 'captain@example.com');
  assert.equal(filled.result.dispatch.ok, true);
  assert.equal(filled.result.dispatch.method, 'dom');
  assert.equal(filled.result.verification.status, 'succeeded');
  assert.ok(filled.result.verification.evidence.includes('target value matched requested text'));
  assert.equal(filled.result.postActionSnapshot.pageStateId, observed.pageStateId);
  assert.equal(filled.result.postActionSnapshot.delta.unchanged, true);
  assert.equal(Object.hasOwn(filled.result.postActionSnapshot, 'elements'), false);
});

test('content click reports inconclusive when post-action snapshot is unchanged', async () => {
  const button = element('button', {
    text: 'Preview'
  });
  const root = element('main', { text: 'Static form' }, [button]);
  const content = loadContentScript(root);

  const observed = await content.send({
    type: 'content.observe',
    maxActionableHandles: 5
  });
  const buttonHandle = observed.elements.find((entry) => entry.tag === 'button').handle;
  const clicked = await content.send({
    type: 'content.action',
    action: 'click',
    handle: buttonHandle,
    postActionSnapshot: 'delta',
    sincePageStateId: observed.pageStateId,
    maxActionableHandles: 5
  });

  assert.equal(clicked.ok, true);
  assert.equal(clicked.result.action, 'clicked');
  assert.equal(clicked.result.dispatch.ok, true);
  assert.equal(clicked.result.dispatch.method, 'dom');
  assert.equal(clicked.result.verification.status, 'inconclusive');
  assert.ok(clicked.result.verification.evidence.includes('action dispatched but no observable post-condition changed'));
});

test('content click verifies navigable link handoff when snapshot has not changed yet', async () => {
  const link = element('a', {
    href: 'https://example.com/product',
    text: 'Open product'
  });
  const root = element('main', { text: 'Product result' }, [link]);
  const content = loadContentScript(root);

  const observed = await content.send({
    type: 'content.observe',
    maxActionableHandles: 5
  });
  const linkHandle = observed.elements.find((entry) => entry.tag === 'a').handle;
  const clicked = await content.send({
    type: 'content.action',
    action: 'click',
    handle: linkHandle,
    postActionSnapshot: 'delta',
    sincePageStateId: observed.pageStateId,
    maxActionableHandles: 5
  });

  assert.equal(clicked.ok, true);
  assert.equal(clicked.result.verification.status, 'succeeded');
  assert.ok(clicked.result.verification.evidence.includes('navigation target changed'));
});

test('content action verifies explicit textAppears post-condition', async () => {
  const status = element('div', { text: '' });
  const button = element('button', {
    text: 'Save',
    onClick() {
      status.innerText = 'Saved';
      status.textContent = 'Saved';
    }
  });
  const root = element('main', { text: 'Draft form' }, [button, status]);
  const content = loadContentScript(root);
  const observed = await content.send({ type: 'content.observe' });
  const handle = observed.elements[0].handle;

  const clicked = await content.send({
    type: 'content.action',
    action: 'click',
    handle,
    postActionSnapshot: 'delta',
    verify: {
      oneOf: [{ type: 'textAppears', text: 'Saved' }]
    }
  });

  assert.equal(clicked.ok, true);
  assert.equal(clicked.result.verification.status, 'succeeded');
  assert.ok(clicked.result.verification.evidence.includes('text appeared: Saved'));
});

test('content batch observe and actions carry delta snapshot options', async () => {
  const input = element('input', {
    id: 'email',
    type: 'email',
    placeholder: 'name@example.com'
  });
  const root = element('main', { text: 'Batch form' }, [input]);
  const content = loadContentScript(root);

  const first = await content.send({
    type: 'content.observe',
    maxActionableHandles: 5
  });
  const inputHandle = first.elements.find((entry) => entry.tag === 'input').handle;
  const batch = await content.send({
    type: 'content.batch',
    actions: [{
      action: 'observe',
      sincePageStateId: first.pageStateId,
      maxActionableHandles: 5
    }, {
      action: 'fill',
      handle: inputHandle,
      text: 'deck@example.com',
      postActionSnapshot: 'delta',
      sincePageStateId: first.pageStateId,
      maxActionableHandles: 5
    }]
  });

  assert.equal(batch.ok, true);
  assert.equal(batch.result.results[0].result.delta.unchanged, true);
  assert.equal(batch.result.results[1].result.postActionSnapshot.delta.unchanged, true);
  assert.equal(input.value, 'deck@example.com');
});

test('content batch propagates child action failures to the outer response', async () => {
  const publish = element('button', {
    text: 'Publish',
    'data-risk': 'publish'
  });
  const root = element('main', { text: 'Release controls' }, [publish]);
  const content = loadContentScript(root);
  const observed = await content.send({ type: 'content.observe' });
  const handle = observed.elements.find((entry) => entry.tag === 'button').handle;

  const batch = await content.send({
    type: 'content.batch',
    actions: [{
      action: 'click',
      handle
    }]
  });

  assert.equal(batch.ok, false);
  assert.equal(batch.error.code, 'HIGH_RISK_BLOCKED');
  assert.equal(batch.error.actionIndex, 0);
  assert.equal(batch.result.results.length, 1);
  assert.equal(batch.result.results[0].ok, false);
  assert.equal(batch.result.stoppedOnError, true);
});

test('content extract returns bounded shopping product candidates without generic DOM dump', async () => {
  const add = element('button', {
    'data-cart-action': 'add',
    text: 'Add to cart'
  });
  const card = element('article', {
    'data-visual-card': 'product',
    'data-product-id': 'sku-100',
    'data-price': '129.99',
    'data-currency': 'USD',
    text: 'Acme Eau de Parfum Women 100 ml $129.99'
  }, [add]);
  const other = element('article', {
    'data-visual-card': 'product',
    'data-product-id': 'sku-200',
    'data-price': '88',
    'data-currency': 'EUR',
    text: 'Cedar Cologne Men 50ml EUR 88'
  }, [element('button', { 'data-cart-action': 'add', text: 'Add' })]);
  const root = element('main', { text: 'Perfume catalog' }, [card, other]);
  const content = loadContentScript(root);

  const extracted = await content.send({
    type: 'content.extract',
    intent: 'shopping.productCandidates',
    maxCandidates: 1
  });

  assert.equal(extracted.status, 'ok');
  assert.equal(extracted.intent, 'shopping.productCandidates');
  assert.equal(extracted.origin, 'https://example.com');
  assert.equal(extracted.url, 'https://example.com/form');
  assert.equal(typeof extracted.pageStateId, 'string');
  assert.equal(extracted.productCandidates.length, 1);
  assert.equal(extracted.limits.maxCandidates, 1);
  assert.equal(extracted.limits.defaultMaxCandidates, 20);
  assert.equal(extracted.limits.availableCandidates, 2);
  assert.equal(extracted.productCandidates[0].name, 'Acme Eau de Parfum Women 100 ml $129.99');
  assert.equal(extracted.productCandidates[0].price, 129.99);
  assert.equal(extracted.productCandidates[0].priceLabel, 'USD 129.99');
  assert.equal(extracted.productCandidates[0].volumeMl, 100);
  assert.equal(extracted.productCandidates[0].genderHint, 'women');
  assert.match(extracted.productCandidates[0].addToCartHandle, /^el_/);
  assert.equal(extracted.productCandidates[0].evidence.includes('<article'), false);
  assert.equal(Object.hasOwn(extracted, 'elements'), false);
  assert.equal(Object.hasOwn(extracted, 'pageContent'), false);
  assert.ok(JSON.stringify(extracted).length < 2500, 'intent extractor should stay smaller than a generic page snapshot');
});

test('content extract finds generic product cards with localized prices', async () => {
  const add = element('button', {
    'data-test-id': 'add-to-cart',
    text: 'Sepete ekle'
  });
  const title = element('h3', {
    'data-test-id': 'product-title',
    text: 'Lenovo IdeaPad Gaming 3 Oyuncu Laptop'
  });
  const link = element('a', {
    href: 'https://example.com/lenovo-ideapad-gaming-3',
    text: 'Lenovo IdeaPad Gaming 3 Oyuncu Laptop'
  }, [title]);
  const price = element('span', {
    'data-test-id': 'price-current',
    text: '24.999,00 TL'
  });
  const card = element('li', {
    'data-test-id': 'product-card'
  }, [link, price, add]);
  const root = element('main', { text: 'Laptop catalog' }, [card]);
  const content = loadContentScript(root);

  const extracted = await content.send({
    type: 'content.extract',
    intent: 'shopping.productCandidates',
    maxCandidates: 5
  });

  assert.equal(extracted.status, 'ok');
  assert.equal(extracted.limits.availableCandidates, 1);
  assert.equal(extracted.productCandidates.length, 1);
  assert.equal(extracted.productCandidates[0].name, 'Lenovo IdeaPad Gaming 3 Oyuncu Laptop');
  assert.equal(extracted.productCandidates[0].price, 24999);
  assert.equal(extracted.productCandidates[0].priceLabel, '24.999,00 TL');
  assert.equal(extracted.productCandidates[0].href, 'https://example.com/lenovo-ideapad-gaming-3');
  assert.match(extracted.productCandidates[0].addToCartHandle, /^el_/);
  assert.match(extracted.productCandidates[0].evidence, /generic-product-card/);
  assert.equal(Object.hasOwn(extracted, 'elements'), false);
  assert.equal(Object.hasOwn(extracted, 'pageContent'), false);
  assert.ok(JSON.stringify(extracted).length < 2500, 'generic extraction should stay bounded');
});

test('content extract rejects unsupported intents without dumping DOM', async () => {
  const root = element('main', { text: 'Login form secret-ish content' }, [
    element('input', { id: 'email', type: 'email' })
  ]);
  const content = loadContentScript(root);

  const extracted = await content.send({
    type: 'content.extract',
    intent: 'form.fields'
  });

  assert.equal(extracted.intent, 'form.fields');
  assert.equal(extracted.status, 'unsupported-intent');
  assert.deepEqual([...extracted.supportedIntents], ['shopping.productCandidates']);
  assert.equal(Object.hasOwn(extracted, 'elements'), false);
  assert.equal(Object.hasOwn(extracted, 'pageContent'), false);
});

test('content mediaInspect returns bounded media element state', async () => {
  const video = element('video', {
    id: 'demo-video',
    'aria-label': 'Demo video',
    src: 'https://cdn.example.test/demo.mp4',
    poster: 'https://cdn.example.test/demo.jpg'
  });
  video.currentTime = 12.5;
  video.duration = 90;
  video.paused = true;
  video.muted = false;
  video.volume = 0.75;
  video.readyState = 4;
  video.networkState = 1;
  video.videoWidth = 1280;
  video.videoHeight = 720;
  const root = element('main', { text: 'Video page' }, [video]);
  const content = loadContentScript(root);

  const inspected = await content.send({
    type: 'content.mediaInspect',
    maxItems: 5
  });

  assert.equal(inspected.ok, true);
  assert.equal(inspected.result.media.length, 1);
  assert.equal(inspected.result.media[0].kind, 'video');
  assert.equal(inspected.result.media[0].label, 'Demo video');
  assert.equal(inspected.result.media[0].paused, true);
  assert.equal(inspected.result.media[0].currentTime, 12.5);
  assert.equal(inspected.result.media[0].videoWidth, 1280);
  assert.equal(inspected.result.media[0].videoHeight, 720);
});

test('content form extract plan and execute returns validation state without leaking sensitive values', async () => {
  const email = element('input', {
    id: 'email',
    name: 'email',
    type: 'email',
    'aria-label': 'Email address',
    required: 'required',
    value: ''
  });
  const password = element('input', {
    id: 'password',
    name: 'password',
    type: 'password',
    'aria-label': 'Password',
    value: 'secret-value'
  });
  const form = element('form', { id: 'login' }, [
    email,
    password,
    element('button', { type: 'submit', text: 'Sign in' })
  ]);
  const root = element('main', {}, [form]);
  const content = loadContentScript(root);

  const extracted = await content.send({
    type: 'content.formExtract',
    includeValues: true
  });
  assert.equal(extracted.ok, true);
  assert.equal(extracted.result.forms[0].formId, 'login');
  assert.equal(extracted.result.forms[0].fields.length, 2);
  assert.equal(extracted.result.forms[0].fields[0].label, 'Email address');
  assert.equal(extracted.result.forms[0].fields[0].required, true);
  assert.equal(extracted.result.forms[0].fields[1].sensitive, true);
  assert.equal(extracted.result.forms[0].fields[1].value, '[REDACTED]');

  const plan = await content.send({
    type: 'content.formFillPlan',
    fields: [{ handle: extracted.result.forms[0].fields[0].handle, text: 'captain@example.com' }]
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.result.steps.length, 1);
  assert.equal(plan.result.steps[0].action, 'fill');
  assert.equal(plan.result.steps[0].label, 'Email address');

  const executed = await content.send({
    type: 'content.formFillExecute',
    steps: plan.result.steps
  });
  assert.equal(executed.ok, true);
  assert.equal(email.value, 'captain@example.com');
  assert.equal(executed.result.invalidFields.length, 0);
});

test('content form fill requires explicit approval for sensitive fields', async () => {
  const password = element('input', {
    id: 'password',
    name: 'password',
    type: 'password',
    'aria-label': 'Password'
  });
  const root = element('main', {}, [element('form', { id: 'login' }, [password])]);
  const content = loadContentScript(root);
  const extracted = await content.send({
    type: 'content.formExtract',
    includeValues: false
  });
  const handle = extracted.result.forms[0].fields[0].handle;

  const plan = await content.send({
    type: 'content.formFillPlan',
    fields: [{ handle, text: 'new-secret' }]
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.result.requiresUserApproval, true);
  assert.equal(plan.result.steps[0].sensitive, true);

  const blocked = await content.send({
    type: 'content.formFillExecute',
    steps: plan.result.steps
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'SENSITIVE_FORM_FILL_BLOCKED');
  assert.equal(password.value, '');

  const approved = await content.send({
    type: 'content.formFillExecute',
    steps: plan.result.steps,
    approval: {
      allowSensitiveFormFill: true,
      approvalKind: 'sensitive-form-fill'
    }
  });
  assert.equal(approved.ok, true);
  assert.equal(password.value, 'new-secret');
});
