(function initVisualCapture(root) {
  'use strict';

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isRetryableCaptureError(error) {
    return Boolean(
      error &&
      /(image readback failed|MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND)/i.test(error.message || String(error))
    );
  }

  async function captureVisibleTabWithRetry({
    captureVisibleTab,
    windowId,
    options = { format: 'png' },
    attempts = 4,
    delayMs = 1100,
    sleeper = sleep
  }) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await captureVisibleTab(windowId, options);
      } catch (error) {
        lastError = error;
        if (!isRetryableCaptureError(error) || attempt === attempts) {
          throw error;
        }
        await sleeper(delayMs);
      }
    }
    throw lastError;
  }

  const api = {
    captureVisibleTabWithRetry,
    isRetryableCaptureError
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    return;
  }

  root.CodexVisualCapture = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
