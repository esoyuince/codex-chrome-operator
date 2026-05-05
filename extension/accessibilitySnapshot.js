(function initAccessibilitySnapshot(root) {
  'use strict';

  const DEBUGGER_PROTOCOL_VERSION = '1.3';
  const DEBUGGER_TIMEOUT_MS = 5000;
  const DEFAULT_MAX_AX_NODES = 400;

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

  function axValue(entry) {
    if (!entry || typeof entry !== 'object') {
      return null;
    }
    if (
      entry.value &&
      typeof entry.value === 'object' &&
      Object.prototype.hasOwnProperty.call(entry.value, 'value')
    ) {
      return entry.value.value;
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'value')) {
      return entry.value;
    }
    return null;
  }

  function axProp(node, name) {
    const properties = Array.isArray(node && node.properties) ? node.properties : [];
    const match = properties.find((property) => property && property.name === name);
    return match ? axValue(match) : null;
  }

  function booleanAxProp(node, name) {
    return axProp(node, name) === true;
  }

  function normalizeAxNode(node = {}) {
    return {
      axNodeId: node.nodeId || null,
      backendDOMNodeId: node.backendDOMNodeId ?? null,
      role: axValue(node.role),
      name: axValue(node.name),
      value: axValue(node.value),
      description: axValue(node.description),
      disabled: booleanAxProp(node, 'disabled'),
      focused: booleanAxProp(node, 'focused'),
      checked: axProp(node, 'checked'),
      selected: booleanAxProp(node, 'selected'),
      expanded: axProp(node, 'expanded'),
      required: booleanAxProp(node, 'required'),
      invalid: axProp(node, 'invalid')
    };
  }

  function failClosed(error) {
    return {
      ok: false,
      error: {
        code: 'AX_TREE_CAPTURE_FAILED',
        message: error && error.message ? error.message : String(error)
      }
    };
  }

  async function captureAccessibilityTree({
    chromeApi = root.chrome,
    tabId,
    maxNodes = DEFAULT_MAX_AX_NODES,
    timeoutMs = DEBUGGER_TIMEOUT_MS
  } = {}) {
    if (!chromeApi || !chromeApi.debugger || tabId === undefined || tabId === null) {
      return failClosed(new Error('Chrome debugger API and tabId are required.'));
    }

    const target = { tabId };
    let attached = false;
    try {
      await attachDebugger(chromeApi, target, timeoutMs);
      attached = true;
      await sendCommand(chromeApi, target, 'Accessibility.enable', {}, timeoutMs);
      const tree = await sendCommand(chromeApi, target, 'Accessibility.getFullAXTree', {}, timeoutMs);
      const rawNodes = Array.isArray(tree && tree.nodes) ? tree.nodes : [];
      const limit = Math.max(0, Math.floor(Number(maxNodes) || DEFAULT_MAX_AX_NODES));
      return {
        ok: true,
        result: {
          axAvailable: true,
          rawNodeCount: rawNodes.length,
          truncated: rawNodes.length > limit,
          nodes: rawNodes.slice(0, limit).map(normalizeAxNode)
        }
      };
    } catch (error) {
      return failClosed(error);
    } finally {
      if (attached) {
        try {
          await detachDebugger(chromeApi, target, timeoutMs);
        } catch {
          // The caller still gets the capture result; detach errors are non-actionable here.
        }
      }
    }
  }

  const api = {
    captureAccessibilityTree,
    normalizeAxNode,
    axProp,
    axValue
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    return;
  }

  root.CodexAccessibilitySnapshot = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
