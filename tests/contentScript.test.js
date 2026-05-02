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

function flattenElements(rootElement) {
  const results = [];
  function visit(node) {
    if (!node || !node.tagName) {
      return;
    }
    results.push(node);
    for (const child of node.children || []) {
      visit(child);
    }
  }
  visit(rootElement);
  return results;
}

function selectorMatchesElement(selector, node) {
  if (selector === 'a') {
    return node.tagName === 'A';
  }
  if (selector === 'button') {
    return node.tagName === 'BUTTON';
  }
  if (selector === 'input') {
    return node.tagName === 'INPUT';
  }
  if (selector === 'textarea') {
    return node.tagName === 'TEXTAREA';
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
    'extension/intentExtractors.js',
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
  assert.equal(filled.result.postActionSnapshot.pageStateId, observed.pageStateId);
  assert.equal(filled.result.postActionSnapshot.delta.unchanged, true);
  assert.equal(Object.hasOwn(filled.result.postActionSnapshot, 'elements'), false);
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
