(function initPageWait(root) {
  'use strict';

  const DEFAULT_TIMEOUT_MS = 10000;
  const DEFAULT_POLL_INTERVAL_MS = 250;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isVisible(element, win) {
    if (!element || typeof element.getBoundingClientRect !== 'function') {
      return false;
    }
    const style = win.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      rect.width > 0 &&
      rect.height > 0;
  }

  function targetElement(condition, context) {
    if (condition.handle && typeof context.resolveHandle === 'function') {
      return context.resolveHandle(condition.handle);
    }
    if (condition.selector && context.document && typeof context.document.querySelector === 'function') {
      return context.document.querySelector(condition.selector);
    }
    return null;
  }

  function textIncludes(context, text) {
    const bodyText = context.document && context.document.body
      ? context.document.body.innerText || ''
      : '';
    return bodyText.includes(String(text || ''));
  }

  function nonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function evaluateWaitCondition(condition, context) {
    if (!condition || typeof condition !== 'object' || typeof condition.type !== 'string') {
      return { satisfied: false, valid: false, reason: 'condition.type is required' };
    }

    const type = condition.type;
    if (type === 'navigationComplete') {
      return {
        type,
        valid: true,
        satisfied: context.document && context.document.readyState === 'complete'
      };
    }

    if (type === 'urlMatches') {
      const patternText = condition.pattern || condition.value || '';
      if (!nonEmptyString(patternText)) {
        return {
          type,
          valid: false,
          satisfied: false,
          reason: 'condition.pattern must be a non-empty string'
        };
      }
      try {
        const pattern = new RegExp(patternText);
        return {
          type,
          valid: true,
          satisfied: pattern.test(context.location.href)
        };
      } catch (error) {
        return { type, valid: false, satisfied: false, reason: error.message };
      }
    }

    if (type === 'urlChanged') {
      return {
        type,
        valid: typeof condition.from === 'string',
        satisfied: typeof condition.from === 'string' && context.location.href !== condition.from
      };
    }

    if (type === 'textVisible' || type === 'textGone') {
      if (!nonEmptyString(condition.text)) {
        return {
          type,
          valid: false,
          satisfied: false,
          reason: 'condition.text must be a non-empty string'
        };
      }
      const present = textIncludes(context, condition.text);
      return {
        type,
        valid: typeof condition.text === 'string',
        satisfied: type === 'textVisible' ? present : !present
      };
    }

    if ([
      'elementVisible',
      'elementGone',
      'elementEnabled',
      'elementDisabled'
    ].includes(type)) {
      const element = targetElement(condition, context);
      const visible = isVisible(element, context.window);
      const disabled = Boolean(element && element.disabled);
      const valid = Boolean(condition.handle || condition.selector);
      const satisfied = {
        elementVisible: Boolean(element && visible),
        elementGone: !element || !visible,
        elementEnabled: Boolean(element && !disabled),
        elementDisabled: Boolean(element && disabled)
      }[type];

      return { type, valid, satisfied };
    }

    return { type, valid: false, satisfied: false, reason: `Unsupported wait condition: ${type}` };
  }

  async function waitForCondition({
    condition,
    context,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    now = Date.now,
    sleeper = sleep
  }) {
    const started = now();
    const timeout = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    const pollInterval = Number.isFinite(pollIntervalMs) && pollIntervalMs > 0
      ? pollIntervalMs
      : DEFAULT_POLL_INTERVAL_MS;

    while (true) {
      const state = evaluateWaitCondition(condition, context);
      const elapsedMs = Math.max(0, now() - started);
      if (!state.valid) {
        return {
          ok: false,
          error: {
            code: 'INVALID_SCHEMA',
            message: state.reason || 'Invalid wait condition.',
            condition
          }
        };
      }
      if (state.satisfied) {
        return {
          ok: true,
          result: {
            action: 'waited',
            condition,
            elapsedMs,
            finalState: state
          }
        };
      }
      if (elapsedMs >= timeout) {
        return {
          ok: false,
          error: {
            code: 'TIMEOUT',
            message: `Timed out waiting for ${condition.type}.`,
            condition,
            timeoutMs: timeout,
            elapsedMs,
            finalState: state
          }
        };
      }
      await sleeper(Math.min(pollInterval, timeout - elapsedMs));
    }
  }

  const api = {
    evaluateWaitCondition,
    waitForCondition
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    return;
  }

  root.CodexPageWait = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
