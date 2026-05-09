const test = require('node:test');
const assert = require('node:assert/strict');

const {
  generatePageSnapshot
} = require('../extension/pageReader');

function node(tagName, attrs = {}, children = []) {
  const element = {
    tagName: tagName.toUpperCase(),
    id: attrs.id || '',
    value: attrs.value || '',
    disabled: Boolean(attrs.disabled),
    children,
    childNodes: attrs.text ? [{ nodeType: 3, textContent: attrs.text }] : [],
    dataset: attrs.dataset || {},
    getAttribute(name) {
      return attrs[name] === undefined ? null : attrs[name];
    },
    matches(selector) {
      if (selector === 'input[type="password"], [autocomplete="one-time-code"]') {
        return this.tagName === 'INPUT' && attrs.type === 'password';
      }
      return false;
    },
    getBoundingClientRect() {
      return attrs.hidden
        ? { x: 0, y: 0, width: 0, height: 0 }
        : { x: 10, y: 20, width: 100, height: 24 };
    }
  };
  for (const child of children) {
    child.parentElement = element;
  }
  return element;
}

function env(rootElement) {
  const described = new Map();
  return {
    rootElement,
    location: { href: 'https://example.com/form', origin: 'https://example.com' },
    document: {
      title: 'Fixture',
      body: rootElement
    },
    window: {
      innerWidth: 1280,
      innerHeight: 720,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 1,
      getComputedStyle(target) {
        return {
          display: target.getAttribute('data-hidden') === 'true' ? 'none' : 'block',
          visibility: 'visible',
          opacity: '1'
        };
      }
    },
    describeElements(elements) {
      return {
        pageStateId: 'state1',
        items: elements.map((element, index) => {
          const handle = `el_state1_${index}`;
          described.set(handle, element);
          return { element, handle };
        })
      };
    },
    resolveHandle(handle) {
      const element = described.get(handle);
      return element ? { ok: true, element } : { ok: false, error: { code: 'STALE_HANDLE' } };
    }
  };
}

test('generatePageSnapshot returns compact accessibility-like content with stable handles', () => {
  const root = node('main', {}, [
    node('h1', { text: 'Checkout' }),
    node('label', { for: 'email', text: 'Email address' }),
    node('input', { id: 'email', type: 'email', placeholder: 'name@example.com' }),
    node('button', { text: 'Save draft', 'aria-label': 'Save draft' }),
    node('script', { text: 'ignored' })
  ]);
  const snapshot = generatePageSnapshot(env(root), {
    filter: 'all',
    depth: 4,
    maxChars: 1200
  });

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.result.title, 'Fixture');
  assert.match(snapshot.result.pageContent, /main \[el_state1_0\]/);
  assert.match(snapshot.result.pageContent, /heading "Checkout" \[el_state1_1\]/);
  assert.match(snapshot.result.pageContent, /textbox "name@example.com" \[el_state1_3\] type="email" placeholder="name@example.com"/);
  assert.match(snapshot.result.pageContent, /button "Save draft" \[el_state1_4\]/);
  assert.doesNotMatch(snapshot.result.pageContent, /ignored/);
});

test('generatePageSnapshot can include safe form values without leaking sensitive fields', () => {
  const root = node('main', {}, [
    node('textarea', {
      id: 'full-description',
      'aria-label': 'Full description',
      value: 'CaptainCalc ist das Offline-Navigationswerkzeug fuer Kapitaene.'
    }),
    node('input', {
      id: 'support-email',
      type: 'email',
      value: 'captain@example.com'
    }),
    node('input', {
      id: 'api-token',
      type: 'text',
      value: 'secret-token-123'
    }),
    node('input', {
      id: 'public-title',
      type: 'text',
      value: 'CaptainCalc'
    })
  ]);
  const snapshot = generatePageSnapshot(env(root), {
    filter: 'all',
    depth: 4,
    maxChars: 2000,
    includeFormValues: true,
    maxFieldValueChars: 18
  });

  assert.equal(snapshot.ok, true);
  assert.match(snapshot.result.pageContent, /textbox "Full description" \[el_state1_1\] value="CaptainCalc ist da"/);
  assert.match(snapshot.result.pageContent, /textbox "public-title" \[el_state1_4\] type="text" value="CaptainCalc"/);
  assert.doesNotMatch(snapshot.result.pageContent, /captain@example\.com/);
  assert.doesNotMatch(snapshot.result.pageContent, /secret-token-123/);
  assert.equal(
    snapshot.result.handles.find((handle) => handle.tag === 'textarea').value,
    'CaptainCalc ist da'
  );
  assert.equal(snapshot.result.handles.some((handle) => handle.value === 'captain@example.com'), false);
  assert.equal(snapshot.result.handles.some((handle) => handle.value === 'secret-token-123'), false);
});

test('generatePageSnapshot keeps text input values out of labels unless explicitly requested as values', () => {
  const root = node('main', {}, [
    node('input', {
      id: 'draft-title',
      type: 'text',
      value: 'Private launch draft',
      placeholder: 'Title'
    })
  ]);

  const defaultSnapshot = generatePageSnapshot(env(root), {
    filter: 'all',
    depth: 4,
    maxChars: 1200
  });
  const valueSnapshot = generatePageSnapshot(env(root), {
    filter: 'all',
    depth: 4,
    maxChars: 1200,
    includeFormValues: true,
    maxFieldValueChars: 12
  });

  assert.equal(defaultSnapshot.ok, true);
  assert.doesNotMatch(defaultSnapshot.result.pageContent, /Private launch draft/);
  assert.equal(defaultSnapshot.result.handles.find((handle) => handle.tag === 'input').label, 'Title');
  assert.equal(Object.hasOwn(defaultSnapshot.result.handles.find((handle) => handle.tag === 'input'), 'value'), false);

  assert.equal(valueSnapshot.ok, true);
  assert.match(valueSnapshot.result.pageContent, /textbox "Title" \[el_state1_1\] type="text" placeholder="Title" value="Private laun"/);
  assert.equal(valueSnapshot.result.handles.find((handle) => handle.tag === 'input').label, 'Title');
  assert.equal(valueSnapshot.result.handles.find((handle) => handle.tag === 'input').value, 'Private laun');
});

test('generatePageSnapshot can focus an existing handle and enforces maxChars', () => {
  const root = node('main', {}, [
    node('section', { 'aria-label': 'Large panel' }, [
      node('button', { text: 'Confirm publishing' })
    ])
  ]);
  const context = env(root);
  const full = generatePageSnapshot(context, {
    filter: 'all',
    depth: 4,
    maxChars: 1200
  });
  const sectionHandle = full.result.handles.find((handle) => handle.label === 'Large panel').handle;

  const focused = generatePageSnapshot(context, {
    refId: sectionHandle,
    depth: 2,
    maxChars: 1200
  });
  assert.equal(focused.ok, true);
  assert.match(focused.result.pageContent, /^region "Large panel"/);
  assert.match(focused.result.pageContent, /button "Confirm publishing"/);

  const tooLarge = generatePageSnapshot(context, {
    filter: 'all',
    depth: 4,
    maxChars: 10
  });
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.error.code, 'PAGE_CONTENT_TOO_LARGE');
  assert.deepEqual(tooLarge.error.suggestedFixes, [
    'Increase maxChars.',
    'Use filter="interactive" for controls only.',
    'Use depth to narrow the tree.',
    'Use refId to read a focused subtree.'
  ]);
});
