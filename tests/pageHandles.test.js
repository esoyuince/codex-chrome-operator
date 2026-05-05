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
    value: attrs.value || '',
    disabled: Boolean(attrs.disabled),
    getBoundingClientRect() {
      return attrs.rect || { x: 0, y: 0, width: 0, height: 0 };
    },
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

test('resolveVersionedHandle uses stable layout to recover repeated action buttons', () => {
  const context = env('https://example.com/thread');
  const targetReply = element({
    tagName: 'BUTTON',
    role: 'button',
    'aria-label': '25 Replies. Reply',
    rect: { x: 471, y: 2063, width: 42, height: 20 }
  });
  const described = describeElements([targetReply], context);

  const resolved = resolveVersionedHandle({
    handle: described.items[0].handle,
    elements: [
      element({
        tagName: 'BUTTON',
        role: 'button',
        'aria-label': '25 Replies. Reply',
        rect: { x: 471, y: 244, width: 46, height: 47 }
      }),
      element({
        tagName: 'BUTTON',
        role: 'button',
        'aria-label': '25 Replies. Reply',
        rect: { x: 471, y: 2063, width: 42, height: 20 }
      })
    ],
    context
  });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.index, 1);
  assert.equal(resolved.recovered, true);
});

test('resolveVersionedHandle recovers unique data-testid controls after layout drift', () => {
  const context = env('https://x.com/intent/post');
  const targetReply = element({
    tagName: 'BUTTON',
    role: 'button',
    type: 'button',
    'data-testid': 'tweetButton',
    rect: { x: 1160, y: 885, width: 84, height: 36 }
  });
  const described = describeElements([targetReply], context);

  const resolved = resolveVersionedHandle({
    handle: described.items[0].handle,
    elements: [
      element({
        tagName: 'BUTTON',
        role: 'button',
        type: 'button',
        'data-testid': 'tweetButtonInline',
        rect: { x: 1094, y: 586, width: 84, height: 36 }
      }),
      element({
        tagName: 'BUTTON',
        role: 'button',
        type: 'button',
        'data-testid': 'tweetButton',
        rect: { x: 1145, y: 886, width: 84, height: 36 }
      })
    ],
    context
  });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.index, 1);
  assert.equal(resolved.recovered, true);
  assert.equal(resolved.recovery.strategy, 'stable-identity');
});

test('resolveVersionedHandle narrows repeated identity controls by previous layout proximity', () => {
  const context = env('https://x.com/intent/post');
  const targetReply = element({
    tagName: 'BUTTON',
    role: 'button',
    type: 'button',
    'data-testid': 'tweetButton',
    rect: { x: 1160, y: 885, width: 84, height: 36 }
  });
  const described = describeElements([targetReply], context);

  const resolved = resolveVersionedHandle({
    handle: described.items[0].handle,
    elements: [
      element({
        tagName: 'BUTTON',
        role: 'button',
        type: 'button',
        'data-testid': 'tweetButton',
        rect: { x: 560, y: 430, width: 84, height: 36 }
      }),
      element({
        tagName: 'BUTTON',
        role: 'button',
        type: 'button',
        'data-testid': 'tweetButton',
        rect: { x: 1145, y: 886, width: 84, height: 36 }
      })
    ],
    context
  });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.index, 1);
  assert.equal(resolved.recovered, true);
  assert.equal(resolved.recovery.strategy, 'stable-identity-layout');
});

test('resolveVersionedHandle rejects stable index recovery without strong context evidence', () => {
  const context = env('https://example.com/thread');
  const buttons = Array.from({ length: 4 }, () => element({
    tagName: 'BUTTON',
    role: 'button',
    'data-testid': 'reply'
  }));
  const described = describeElements(buttons, context);

  const resolved = resolveVersionedHandle({
    handle: described.items[2].handle,
    elements: [
      ...Array.from({ length: 4 }, () => element({
        tagName: 'BUTTON',
        role: 'button',
        'data-testid': 'reply'
      })),
      element({
        tagName: 'BUTTON',
        role: 'button',
        'data-testid': 'like'
      })
    ],
    context
  });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.error.reason, 'RECOVERY_NOT_UNIQUE');
});

test('resolveVersionedHandle uses stable index only with semantic neighbor and layout evidence', () => {
  const context = env('https://example.com/thread');
  const buttons = Array.from({ length: 4 }, (_, index) => element({
    tagName: 'BUTTON',
    role: 'button',
    'data-testid': 'reply',
    'aria-label': 'Reply',
    rect: { x: 24, y: 100 + (index * 48), width: 80, height: 32 }
  }));
  const described = describeElements(buttons, context);

  const resolved = resolveVersionedHandle({
    handle: described.items[2].handle,
    elements: [
      ...Array.from({ length: 4 }, (_, index) => element({
        tagName: 'BUTTON',
        role: 'button',
        'data-testid': 'reply',
        'aria-label': 'Reply',
        rect: { x: 28, y: 104 + (index * 48), width: 80, height: 32 }
      })),
      element({
        tagName: 'BUTTON',
        role: 'button',
        'data-testid': 'like',
        'aria-label': 'Like',
        rect: { x: 28, y: 300, width: 80, height: 32 }
      })
    ],
    context
  });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.index, 2);
  assert.equal(resolved.recovered, true);
  assert.equal(resolved.recovery.strategy, 'stable-index');
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

test('page handle identity does not depend on mutable text input values', () => {
  const context = env('https://example.com/form');
  const original = element({
    id: 'draft-title',
    name: 'title',
    type: 'text',
    placeholder: 'Title',
    value: 'First private draft'
  });
  const described = describeElements([original], context);
  const updated = element({
    id: 'draft-title',
    name: 'title',
    type: 'text',
    placeholder: 'Title',
    value: 'Second private draft'
  });

  const resolved = resolveVersionedHandle({
    handle: described.items[0].handle,
    elements: [
      element({ id: 'other', name: 'other', type: 'text', placeholder: 'Other' }),
      updated
    ],
    context
  });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.recovered, true);
  assert.equal(resolved.element, updated);
});
