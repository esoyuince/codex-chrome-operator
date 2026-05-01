const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  buildPageStateId,
  describeElements,
  resolveVersionedHandle
} = require('../extension/pageHandles');

function env(url = 'https://example.com/form') {
  return {
    location: { href: url },
    document: { title: 'Fixture' },
    window: { innerWidth: 1280, innerHeight: 720 }
  };
}

function element(attrs = {}) {
  return {
    tagName: attrs.tagName || 'INPUT',
    id: attrs.id || '',
    disabled: Boolean(attrs.disabled),
    getAttribute(name) {
      return attrs[name] || null;
    }
  };
}

test('describeElements creates page-state-bound handles', () => {
  const elements = [
    element({ id: 'appName', name: 'appName', type: 'text' }),
    element({ id: 'saveDraft', 'data-risk': 'draft' })
  ];

  const described = describeElements(elements, env());
  const pageStateId = buildPageStateId(elements, env());

  assert.equal(described.pageStateId, pageStateId);
  assert.equal(described.items[0].handle, `el_${pageStateId}_0`);
  assert.equal(described.items[1].handle, `el_${pageStateId}_1`);
});

test('resolveVersionedHandle rejects handles from a previous page state', () => {
  const elements = [element({ id: 'appName', name: 'appName', type: 'text' })];
  const described = describeElements(elements, env('https://example.com/form'));
  const resolved = resolveVersionedHandle({
    handle: described.items[0].handle,
    elements,
    context: env('https://example.com/other')
  });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.error.code, 'STALE_HANDLE');
  assert.equal(resolved.error.reason, 'PAGE_STATE_CHANGED');
});

test('resolveVersionedHandle recovers a stale handle on the same URL when the target is unique', () => {
  const context = env('https://example.com/form');
  const search = element({ id: 'searchBox', name: 'q', type: 'search', placeholder: 'Search' });
  const described = describeElements([search], context);
  const movedSearch = element({ id: 'searchBox', name: 'q', type: 'search', placeholder: 'Search' });
  const currentElements = [
    element({ id: 'menuButton', role: 'button' }),
    movedSearch
  ];

  const resolved = resolveVersionedHandle({
    handle: described.items[0].handle,
    elements: currentElements,
    context
  });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.element, movedSearch);
  assert.equal(resolved.recovered, true);
  assert.equal(resolved.index, 1);
});

test('resolveVersionedHandle rejects stale recovery when the target is ambiguous', () => {
  const context = env('https://example.com/form');
  const described = describeElements([
    element({ tagName: 'A', href: '/product/1' })
  ], context);

  const resolved = resolveVersionedHandle({
    handle: described.items[0].handle,
    elements: [
      element({ tagName: 'A', href: '/product/1' }),
      element({ tagName: 'A', href: '/product/1' })
    ],
    context
  });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.error.reason, 'RECOVERY_NOT_UNIQUE');
});

test('page handle descriptors survive content script reinjection in the same page world', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'pageHandles.js'), 'utf8');
  const context = vm.createContext({ console });
  vm.runInContext(source, context);
  const firstApi = context.CodexPageHandles;
  const pageContext = env('https://example.com/form');
  const described = firstApi.describeElements([
    element({ id: 'searchBox', name: 'q', type: 'search', placeholder: 'Search' })
  ], pageContext);

  vm.runInContext(source, context);
  const secondApi = context.CodexPageHandles;
  const movedSearch = element({ id: 'searchBox', name: 'q', type: 'search', placeholder: 'Search' });
  const resolved = secondApi.resolveVersionedHandle({
    handle: described.items[0].handle,
    elements: [
      element({ id: 'menuButton', role: 'button' }),
      movedSearch
    ],
    context: pageContext
  });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.recovered, true);
  assert.equal(resolved.element, movedSearch);
});

test('resolveVersionedHandle resolves the same page state and rejects malformed handles', () => {
  const elements = [element({ id: 'appName', name: 'appName', type: 'text' })];
  const context = env();
  const described = describeElements(elements, context);
  const resolved = resolveVersionedHandle({
    handle: described.items[0].handle,
    elements,
    context
  });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.element, elements[0]);

  const invalid = resolveVersionedHandle({
    handle: 'el_0',
    elements,
    context
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'STALE_HANDLE');
  assert.equal(invalid.error.reason, 'UNVERSIONED_HANDLE');
});
