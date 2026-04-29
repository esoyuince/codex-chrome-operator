const test = require('node:test');
const assert = require('node:assert/strict');

const {
  captureVisibleTabWithRetry,
  isRetryableCaptureError
} = require('../extension/visualCapture');

test('isRetryableCaptureError detects Chrome image readback failures only', () => {
  assert.equal(isRetryableCaptureError(new Error('Failed to capture tab: image readback failed')), true);
  assert.equal(isRetryableCaptureError(new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.')), true);
  assert.equal(isRetryableCaptureError(new Error('Missing host permission')), false);
});

test('captureVisibleTabWithRetry retries image readback failures', async () => {
  let attempts = 0;
  const dataUrl = await captureVisibleTabWithRetry({
    windowId: 1,
    options: { format: 'png' },
    delayMs: 0,
    sleeper: async () => {},
    captureVisibleTab: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('Failed to capture tab: image readback failed');
      }
      return 'data:image/png;base64,aGVsbG8=';
    }
  });

  assert.equal(dataUrl, 'data:image/png;base64,aGVsbG8=');
  assert.equal(attempts, 3);
});

test('captureVisibleTabWithRetry does not retry non-readback failures', async () => {
  let attempts = 0;
  await assert.rejects(
    () => captureVisibleTabWithRetry({
      windowId: 1,
      delayMs: 0,
      sleeper: async () => {},
      captureVisibleTab: async () => {
        attempts += 1;
        throw new Error('Missing host permission');
      }
    }),
    /Missing host permission/
  );

  assert.equal(attempts, 1);
});

test('captureVisibleTabWithRetry uses a quota-safe default retry delay', async () => {
  const delays = [];
  await captureVisibleTabWithRetry({
    windowId: 1,
    sleeper: async (delayMs) => {
      delays.push(delayMs);
    },
    captureVisibleTab: async () => {
      if (delays.length === 0) {
        throw new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.');
      }
      return 'data:image/png;base64,aGVsbG8=';
    }
  });

  assert.deepEqual(delays, [1100]);
});
