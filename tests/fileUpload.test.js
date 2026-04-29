const test = require('node:test');
const assert = require('node:assert/strict');

const { uploadFiles } = require('../extension/fileUpload');

class FakeEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.bubbles = options.bubbles === true;
  }
}

function fakeElement({ tagName = 'div', id = '', attributes = {}, textContent = '' } = {}) {
  const attr = new Map(Object.entries(attributes));
  return {
    tagName: tagName.toUpperCase(),
    id,
    dataset: {},
    textContent,
    value: '',
    multiple: Boolean(attributes.multiple),
    dispatched: [],
    getAttribute(name) {
      return attr.has(name) ? attr.get(name) : null;
    },
    setAttribute(name, value) {
      attr.set(name, String(value));
    },
    matches(selector) {
      if (selector === 'input[type="file"]') {
        return this.tagName === 'INPUT' && this.getAttribute('type') === 'file';
      }
      return false;
    },
    dispatchEvent(event) {
      this.dispatched.push(event.type);
      return true;
    }
  };
}

function fakeMockPlayConsoleDocument() {
  const fixture = fakeElement({
    id: 'mock-play-console-fixture',
    attributes: { 'data-fixture': 'mock-play-console' }
  });
  const input = fakeElement({
    tagName: 'input',
    id: 'appIconUpload',
    attributes: {
      type: 'file',
      'data-upload-role': 'playStoreAppIcon',
      accept: 'image/png'
    }
  });
  const label = fakeElement({
    tagName: 'label',
    id: 'appIconDropzone',
    attributes: {
      for: 'appIconUpload',
      'data-upload-role': 'playStoreAppIcon'
    }
  });
  const preview = fakeElement({
    id: 'appIconPreview',
    attributes: { 'data-preview-role': 'playStoreAppIcon' },
    textContent: 'waiting'
  });
  const status = fakeElement({
    id: 'appIconStatus',
    attributes: { 'data-validation-message': 'playStoreAppIcon' },
    textContent: 'required'
  });
  return {
    label,
    input,
    preview,
    status,
    getElementById(id) {
      return { appIconUpload: input }[id] || null;
    },
    querySelector(selector) {
      return {
        '[data-fixture="mock-play-console"]': fixture,
        '[data-preview-role="playStoreAppIcon"]': preview,
        '[data-validation-message="playStoreAppIcon"]': status
      }[selector] || null;
    }
  };
}

test('uploadFiles updates mock Play Console preview and validation status', async () => {
  const document = fakeMockPlayConsoleDocument();

  const result = await uploadFiles({
    target: { handle: 'el_app_icon' },
    verifyPreview: true,
    files: [{
      role: 'playStoreAppIcon',
      basename: 'icon.png',
      sha256: 'a'.repeat(64),
      width: 512,
      height: 512,
      mimeType: 'image/png'
    }]
  }, {
    document,
    Event: FakeEvent,
    resolveHandle: () => ({ ok: true, element: document.label })
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.action, 'uploaded');
  assert.equal(result.result.previewVerified, true);
  assert.equal(result.result.uploadTarget, 'el_app_icon');
  assert.match(document.preview.textContent, /icon\.png/);
  assert.match(document.status.textContent, /accepted/);
  assert.deepEqual(document.input.dispatched, ['input', 'change']);
  assert.equal(JSON.stringify(result).includes('C:\\'), false);
});

test('uploadFiles returns manual handoff outside the mock fixture without raw paths', async () => {
  const input = fakeElement({
    tagName: 'input',
    id: 'upload',
    attributes: { type: 'file', 'data-upload-role': 'playStoreAppIcon' }
  });
  const result = await uploadFiles({
    target: { handle: 'el_upload' },
    files: [{
      role: 'playStoreAppIcon',
      basename: 'icon.png',
      path: 'C:\\Users\\example\\Pictures\\icon.png',
      sha256: 'a'.repeat(64)
    }]
  }, {
    document: {
      querySelector: () => null,
      getElementById: () => null
    },
    Event: FakeEvent,
    resolveHandle: () => ({ ok: true, element: input })
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MANUAL_STEP_REQUIRED');
  assert.equal(result.error.resumePolicy, 'manual-file-picker');
  assert.equal(result.error.fileSummaries[0].basename, 'icon.png');
  assert.equal(Object.hasOwn(result.error.fileSummaries[0], 'path'), false);
  assert.equal(JSON.stringify(result).includes('C:\\Users\\example'), false);
});
