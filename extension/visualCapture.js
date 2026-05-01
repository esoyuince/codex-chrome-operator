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

  function estimateDataUrlBytes(dataUrl) {
    const commaIndex = String(dataUrl || '').indexOf(',');
    if (commaIndex === -1) {
      return String(dataUrl || '').length;
    }
    return Math.ceil((String(dataUrl).length - commaIndex - 1) * 3 / 4);
  }

  function normalizeFormat(format) {
    const value = String(format || '').toLowerCase();
    if (value === 'jpg' || value === 'jpeg') {
      return 'jpeg';
    }
    if (value === 'png') {
      return 'png';
    }
    return null;
  }

  function normalizeQuality(quality) {
    const value = Number(quality);
    if (!Number.isFinite(value)) {
      return null;
    }
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  function captureOptions(format, quality) {
    const options = { format };
    if (format === 'jpeg' && quality !== null) {
      options.quality = quality;
    }
    return options;
  }

  function withinBudget(dataUrl, maxBytes) {
    const budget = Number(maxBytes);
    return !Number.isFinite(budget) || budget <= 0 || estimateDataUrlBytes(dataUrl) <= budget;
  }

  function tooLargeError(dataUrl, maxBytes) {
    const error = new Error('Screenshot capture exceeds the requested byte budget.');
    error.code = 'SCREENSHOT_TOO_LARGE';
    error.maxBytes = maxBytes;
    error.actualBytes = estimateDataUrlBytes(dataUrl);
    return error;
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

  async function captureVisibleTabWithBudget({
    captureVisibleTab,
    windowId,
    format,
    quality,
    maxBytes,
    qualities = [90, 80, 70, 60, 50, 40],
    attempts,
    delayMs,
    sleeper
  }) {
    const explicitFormat = normalizeFormat(format);
    const explicitQuality = normalizeQuality(quality);
    const attempted = new Set();
    let lastDataUrl = null;

    async function captureWithOptions(options) {
      const key = `${options.format}:${options.quality ?? ''}`;
      if (attempted.has(key)) {
        return null;
      }
      attempted.add(key);
      const dataUrl = await captureVisibleTabWithRetry({
        captureVisibleTab,
        windowId,
        options,
        attempts,
        delayMs,
        sleeper
      });
      lastDataUrl = dataUrl;
      return withinBudget(dataUrl, maxBytes) ? dataUrl : null;
    }

    if (explicitFormat) {
      const dataUrl = await captureWithOptions(captureOptions(explicitFormat, explicitQuality));
      if (dataUrl) {
        return dataUrl;
      }
    } else {
      const dataUrl = await captureWithOptions({ format: 'png' });
      if (dataUrl) {
        return dataUrl;
      }
    }

    const ladder = [explicitQuality, ...qualities.map(normalizeQuality)]
      .filter((value) => value !== null);
    for (const nextQuality of ladder) {
      const dataUrl = await captureWithOptions(captureOptions('jpeg', nextQuality));
      if (dataUrl) {
        return dataUrl;
      }
    }

    throw tooLargeError(lastDataUrl || '', Number(maxBytes));
  }

  const api = {
    captureVisibleTabWithBudget,
    captureVisibleTabWithRetry,
    estimateDataUrlBytes,
    isRetryableCaptureError
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    return;
  }

  root.CodexVisualCapture = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
