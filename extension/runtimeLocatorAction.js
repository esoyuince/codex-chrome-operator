'use strict';

(function initRuntimeLocatorAction(global) {
  function isRetryableLocatorStaleResponse(response) {
    return Boolean(
      response &&
      response.ok === false &&
      response.error &&
      response.error.code === 'STALE_HANDLE'
    );
  }

  function compactError(error) {
    if (!error || typeof error !== 'object') {
      return null;
    }
    return {
      code: error.code || null,
      reason: error.reason || null,
      message: error.message || null,
      handlePageStateId: error.handlePageStateId || null,
      currentPageStateId: error.currentPageStateId || null
    };
  }

  function withLocatorRetry(response, metadata) {
    if (!metadata || !metadata.previousError || !response) {
      return response;
    }
    const locatorRetry = {
      attempted: true,
      attempts: metadata.attempts,
      recovered: metadata.recovered === true,
      previousError: compactError(metadata.previousError)
    };
    if (response.ok === true) {
      return {
        ...response,
        result: {
          ...(response.result || {}),
          locatorRetry
        }
      };
    }
    return {
      ...response,
      error: {
        ...(response.error || {}),
        locatorRetry
      }
    };
  }

  async function runLocatorActionWithRetry({
    resolveLocator,
    runAction,
    maxAttempts = 2
  } = {}) {
    if (typeof resolveLocator !== 'function' || typeof runAction !== 'function') {
      return {
        ok: false,
        error: {
          code: 'INVALID_RUNTIME_LOCATOR_RETRY',
          message: 'Locator retry requires resolver and action functions.'
        }
      };
    }

    const attempts = Math.max(1, Math.floor(Number(maxAttempts) || 1));
    let locator = await resolveLocator({ attempt: 1, retried: false, previousError: null });
    if (!locator || locator.ok !== true) {
      return locator || {
        ok: false,
        error: {
          code: 'LOCATOR_FAILED',
          message: 'Locator failed without a structured response.'
        }
      };
    }

    let previousError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const response = await runAction({
        locator,
        attempt,
        retried: attempt > 1,
        previousError
      });
      if (!isRetryableLocatorStaleResponse(response) || attempt >= attempts) {
        return previousError
          ? withLocatorRetry(response, {
            attempts: attempt,
            recovered: response && response.ok === true,
            previousError
          })
          : response;
      }

      previousError = response.error;
      locator = await resolveLocator({
        attempt: attempt + 1,
        retried: true,
        previousError
      });
      if (!locator || locator.ok !== true) {
        return withLocatorRetry(locator || {
          ok: false,
          error: {
            code: 'LOCATOR_FAILED',
            message: 'Locator refresh failed without a structured response.'
          }
        }, {
          attempts: attempt + 1,
          recovered: false,
          previousError
        });
      }
    }

    return {
      ok: false,
      error: {
        code: 'LOCATOR_RETRY_EXHAUSTED',
        message: 'Locator retry exhausted without a structured action response.'
      }
    };
  }

  global.CodexRuntimeLocatorAction = {
    isRetryableLocatorStaleResponse,
    runLocatorActionWithRetry
  };
})(globalThis);
