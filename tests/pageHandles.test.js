const test = require('node:test');
const assert = require('node:assert/strict');

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
