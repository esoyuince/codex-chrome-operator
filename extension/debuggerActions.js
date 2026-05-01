(function initDebuggerActions(root) {
  'use strict';

  const DEBUGGER_PROTOCOL_VERSION = '1.3';
  const DEBUGGER_ACTION_PROVIDER = 'chrome.debugger.Runtime.evaluate';
  const DEBUGGER_TIMEOUT_MS = 5000;

  function isDebuggerSupportedUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function unsupportedDebuggerPageError(tab) {
    return {
      code: 'DEBUGGER_UNSUPPORTED_PAGE',
      message: 'Chrome debugger actions require a regular http:// or https:// page.',
      url: tab && tab.url ? tab.url : null
    };
  }

  function chromeLastError(chromeApi) {
    return chromeApi && chromeApi.runtime && chromeApi.runtime.lastError
      ? chromeApi.runtime.lastError
      : null;
  }

  function callbackApi(chromeApi, label, register, timeoutMs = DEBUGGER_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      function finish(value) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        const lastError = chromeLastError(chromeApi);
        if (lastError) {
          reject(new Error(lastError.message || String(lastError)));
          return;
        }
        resolve(value);
      }

      try {
        register(finish);
      } catch (error) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  function attachDebugger(chromeApi, target, timeoutMs) {
    return callbackApi(
      chromeApi,
      'chrome.debugger.attach',
      (done) => chromeApi.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION, done),
      timeoutMs
    );
  }

  function detachDebugger(chromeApi, target, timeoutMs) {
    return callbackApi(
      chromeApi,
      'chrome.debugger.detach',
      (done) => chromeApi.debugger.detach(target, done),
      timeoutMs
    );
  }

  function sendCommand(chromeApi, target, method, params = {}, timeoutMs) {
    return callbackApi(
      chromeApi,
      `chrome.debugger.sendCommand(${method})`,
      (done) => chromeApi.debugger.sendCommand(target, method, params, done),
      timeoutMs
    );
  }

  function runtimeActionExecutor(payload) {
    function isVisible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        rect.width > 0 &&
        rect.height > 0;
    }

    function attr(element, name) {
      return element && typeof element.getAttribute === 'function'
        ? element.getAttribute(name) || ''
        : '';
    }

    function hashText(value) {
      let hash = 2166136261;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(36);
    }

    function elementFingerprint(element) {
      return [
        element.tagName || '',
        element.id || '',
        attr(element, 'name'),
        attr(element, 'type'),
        attr(element, 'role'),
        attr(element, 'data-risk'),
        attr(element, 'aria-label'),
        attr(element, 'placeholder')
      ].join('|');
    }

    function collectInteractiveElements() {
      return [...document.querySelectorAll(
        'a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]'
      )].filter(isVisible).slice(0, 200);
    }

    function collectVisualElements() {
      return [...document.querySelectorAll([
        '[data-visual-card]',
        '[data-analyzer-field]',
        '[data-sensitive-page]',
        '[data-visual-policy]',
        '[data-analysis-policy]',
        '[data-rating]',
        '[data-product-id]',
        '[data-preview-role]',
        '[data-validation-message]',
        '[role="dialog"]',
        '[role="status"]',
        '[role="alert"]'
      ].join(','))].filter(isVisible).slice(0, 200);
    }

    function collectObservedElements() {
      return [...new Set([...collectInteractiveElements(), ...collectVisualElements()])].slice(0, 300);
    }

    function buildPageStateId(elements) {
      const viewport = `${window.innerWidth || 0}x${window.innerHeight || 0}`;
      const fingerprints = elements.map(elementFingerprint).join('\n');
      return hashText([location.href, document.title || '', viewport, fingerprints].join('\n'));
    }

    function staleHandle(reason, extra) {
      return {
        ok: false,
        error: {
          code: 'STALE_HANDLE',
          message: 'Handle no longer matches the current page observation.',
          reason,
          ...(extra || {})
        }
      };
    }

    function resolveHandle(handle) {
      const legacy = /^el_\d+$/.test(String(handle || ''));
      if (legacy) {
        return staleHandle('UNVERSIONED_HANDLE');
      }

      const match = /^el_([a-z0-9]+)_(\d+)$/.exec(String(handle || ''));
      if (!match) {
        return staleHandle('MALFORMED_HANDLE');
      }

      const elements = collectObservedElements();
      const handlePageStateId = match[1];
      const index = Number(match[2]);
      const currentPageStateId = buildPageStateId(elements);
      if (handlePageStateId !== currentPageStateId) {
        return staleHandle('PAGE_STATE_CHANGED', {
          handlePageStateId,
          currentPageStateId
        });
      }

      const element = elements[index];
      if (!element) {
        return staleHandle('ELEMENT_NOT_FOUND', {
          handlePageStateId,
          currentPageStateId
        });
      }

      return { ok: true, element, pageStateId: currentPageStateId };
    }

    function dispatchValueEvents(element) {
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function setElementText(element, value) {
      const text = String(value || '');
      element.focus();
      if ('value' in element) {
        element.value = text;
        dispatchValueEvents(element);
      } else if (element.isContentEditable) {
        element.textContent = text;
        dispatchValueEvents(element);
      } else {
        return {
          ok: false,
          error: {
            code: 'TARGET_NOT_EDITABLE',
            message: 'The target element cannot receive typed text.'
          }
        };
      }
      return null;
    }

    function scrollWindow() {
      window.scrollBy(Number(payload.deltaX) || 0, Number(payload.deltaY) || 0);
      return {
        ok: true,
        result: {
          action: 'scrolled',
          scrollX: window.scrollX,
          scrollY: window.scrollY
        }
      };
    }

    if (payload.action === 'scroll') {
      return scrollWindow();
    }

    const resolved = resolveHandle(payload.handle);
    if (!resolved.ok) {
      return resolved;
    }

    const element = resolved.element;
    if (element.disabled) {
      return {
        ok: false,
        error: {
          code: 'TARGET_DISABLED',
          message: 'The target element is disabled.'
        }
      };
    }

    element.scrollIntoView({ block: 'center', inline: 'center' });

    if (payload.action === 'click') {
      element.click();
      return { ok: true, result: { action: 'clicked', handle: payload.handle } };
    }

    if (payload.action === 'fill' || payload.action === 'type') {
      const error = setElementText(element, payload.text ?? payload.value);
      if (error) {
        return error;
      }
      return {
        ok: true,
        result: {
          action: payload.action === 'type' ? 'typed' : 'filled',
          handle: payload.handle
        }
      };
    }

    if (payload.action === 'clear') {
      const error = setElementText(element, '');
      if (error) {
        return error;
      }
      return { ok: true, result: { action: 'cleared', handle: payload.handle } };
    }

    if (payload.action === 'focus') {
      element.focus();
      return { ok: true, result: { action: 'focused', handle: payload.handle } };
    }

    if (payload.action === 'select') {
      if (element.tagName !== 'SELECT') {
        return {
          ok: false,
          error: {
            code: 'TARGET_NOT_SELECT',
            message: 'The target element is not a select control.'
          }
        };
      }
      element.value = payload.value || '';
      dispatchValueEvents(element);
      return { ok: true, result: { action: 'selected', value: element.value, handle: payload.handle } };
    }

    if (payload.action === 'check') {
      if (!('checked' in element)) {
        return {
          ok: false,
          error: {
            code: 'TARGET_NOT_CHECKABLE',
            message: 'The target element cannot be checked.'
          }
        };
      }
      element.checked = payload.checked !== false;
      dispatchValueEvents(element);
      return {
        ok: true,
        result: {
          action: 'checked',
          checked: Boolean(element.checked),
          handle: payload.handle
        }
      };
    }

    if (payload.action === 'scroll') {
      element.scrollBy(Number(payload.deltaX) || 0, Number(payload.deltaY) || 0);
      return {
        ok: true,
        result: {
          action: 'scrolled',
          scrollLeft: element.scrollLeft,
          scrollTop: element.scrollTop,
          handle: payload.handle
        }
      };
    }

    if (payload.action === 'pressKey') {
      element.focus();
      const key = payload.key || 'Enter';
      element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
      return { ok: true, result: { action: 'key-pressed', key, handle: payload.handle } };
    }

    return {
      ok: false,
      error: {
        code: 'UNKNOWN_ACTION',
        message: `Unsupported debugger action: ${payload.action}`
      }
    };
  }

  function buildRuntimeActionExpression(payload) {
    return `(${runtimeActionExecutor.toString()})(${JSON.stringify(payload)})`;
  }

  function normalizeRuntimeActionValue(value) {
    if (!value || typeof value !== 'object') {
      return {
        ok: false,
        error: {
          code: 'DEBUGGER_ACTION_FAILED',
          message: 'Debugger runtime action returned an invalid response.'
        }
      };
    }
    return value;
  }

  async function runDebuggerAction({
    chromeApi,
    tab,
    action,
    params = {},
    timeoutMs = DEBUGGER_TIMEOUT_MS
  }) {
    if (!tab || !tab.id) {
      return { ok: false, error: { code: 'NO_ACTIVE_TAB' } };
    }
    if (!isDebuggerSupportedUrl(tab.url)) {
      return { ok: false, error: unsupportedDebuggerPageError(tab) };
    }

    const target = { tabId: tab.id };
    let attached = false;
    try {
      await attachDebugger(chromeApi, target, timeoutMs);
      attached = true;
      await sendCommand(chromeApi, target, 'Runtime.enable', {}, timeoutMs);
      const response = await sendCommand(chromeApi, target, 'Runtime.evaluate', {
        expression: buildRuntimeActionExpression({ action, ...params }),
        awaitPromise: true,
        returnByValue: true
      }, timeoutMs);
      const value = normalizeRuntimeActionValue(response && response.result && response.result.value);
      if (!value.ok) {
        return value;
      }
      return {
        ok: true,
        result: {
          provider: DEBUGGER_ACTION_PROVIDER,
          ...value.result
        }
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'DEBUGGER_ACTION_FAILED',
          message: error.message || String(error)
        }
      };
    } finally {
      if (attached) {
        try {
          await detachDebugger(chromeApi, target, timeoutMs);
        } catch {
          // Detach failures should not hide the action result.
        }
      }
    }
  }

  const api = {
    DEBUGGER_ACTION_PROVIDER,
    buildRuntimeActionExpression,
    isDebuggerSupportedUrl,
    runDebuggerAction
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    return;
  }

  root.CodexDebuggerActions = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
