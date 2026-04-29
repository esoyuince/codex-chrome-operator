'use strict';

importScripts('permissionOrigins.js', 'visualCapture.js');

const NATIVE_HOST = 'com.codex.chrome_operator';
const PROFILE_BINDING_SOURCE = 'chrome.storage.local';
const {
  hasBroadHostPermission,
  permissionPatternsToOrigins
} = globalThis.CodexPermissionOrigins;
const {
  captureVisibleTabWithRetry
} = globalThis.CodexVisualCapture;

let nativePort = null;
let lastNativeError = null;
let connectionState = 'DISCONNECTED';

function requestId(prefix = 'ext') {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function getProfileBinding() {
  const result = await chrome.storage.local.get([
    'profileBindingId',
    'profileBindingVersion'
  ]);
  if (!result.profileBindingId || !result.profileBindingVersion) {
    return {
      profileBindingState: 'missing',
      profileBindingSource: PROFILE_BINDING_SOURCE
    };
  }
  return {
    profileBindingState: 'bound',
    profileBindingId: result.profileBindingId,
    profileBindingVersion: result.profileBindingVersion,
    profileBindingSource: PROFILE_BINDING_SOURCE
  };
}

async function buildHello() {
  return {
    type: 'HELLO',
    protocolVersion: '1.0',
    extensionId: chrome.runtime.id,
    extensionVersion: chrome.runtime.getManifest().version,
    bridgeVersion: '0.1.0',
    sessionBootstrapId: requestId('boot'),
    ...(await getProfileBinding()),
    capabilities: [
      'observe.v1',
      'visualObserve.v1',
      'visualAnalyze.v1',
      'screenshots.v1',
      'actions.basic.v1',
      'guarded.v1',
      'gateHandoff.v1'
    ]
  };
}

function postNativeRpc(method, params = {}) {
  if (!nativePort) {
    throw new Error('Native bridge is not connected.');
  }
  nativePort.postMessage({
    id: requestId('rpc'),
    method,
    params
  });
}

function postNativeRpcNoThrow(method, params = {}) {
  try {
    postNativeRpc(method, params);
  } catch {
    // The native port may already be gone during disconnect handling.
  }
}

async function sendHello() {
  postNativeRpc('extension.hello', {
    hello: await buildHello(),
    activeTab: await activeTabInfo()
  });
}

async function grantedHostPermissionOrigins() {
  const permissions = await chrome.permissions.getAll();
  const origins = permissions.origins || [];
  if (hasBroadHostPermission(origins)) {
    return null;
  }
  return permissionPatternsToOrigins(origins);
}

async function syncGrantedHostPermissions() {
  const binding = await getProfileBinding();
  if (binding.profileBindingState !== 'bound') {
    return;
  }

  const origins = await grantedHostPermissionOrigins();
  if (origins === null) {
    return;
  }

  postNativeRpc('extension.hostPermissionsSynced', {
    profileBindingId: binding.profileBindingId,
    origins
  });
}

async function connectNative({ refreshHello = false } = {}) {
  if (nativePort) {
    if (refreshHello) {
      await sendHello();
      await syncGrantedHostPermissions();
    }
    return;
  }
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST);
    connectionState = 'CONNECTING';
    nativePort.onMessage.addListener((message) => {
      handleNativeMessage(message);
    });
    nativePort.onDisconnect.addListener(() => {
      lastNativeError = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
      postNativeRpcNoThrow('extension.disconnected', {
        source: 'native-port',
        reason: lastNativeError || 'Native port disconnected.'
      });
      connectionState = 'DISCONNECTED';
      nativePort = null;
      chrome.storage.local.set({ connectionState, lastNativeError });
    });

    await sendHello();
    await syncGrantedHostPermissions();
    connectionState = 'CONNECTED';
    await chrome.storage.local.set({ connectionState, lastNativeError: null });
  } catch (error) {
    lastNativeError = error.message;
    connectionState = 'ERROR';
    nativePort = null;
    await chrome.storage.local.set({ connectionState, lastNativeError });
  }
}

async function handleNativeMessage(message) {
  if (message && message.type === 'command') {
    const response = await handleOperatorCommand(message);
    if (nativePort) {
      nativePort.postMessage({
        id: requestId('deliver'),
        method: 'bridge.deliver',
        params: {
          commandId: message.commandId,
          connectionId: message.connectionId,
          activeTab: await activeTabInfo(),
          response
        }
      });
    }
    return;
  }

  await chrome.storage.local.set({ lastNativeResponse: message });
}

function originPatternFromOrigin(origin) {
  const url = new URL(origin);
  return `${url.protocol}//${url.host}/*`;
}

async function hasHostPermission(origin) {
  return chrome.permissions.contains({
    origins: [originPatternFromOrigin(origin)]
  });
}

function estimateDataUrlBytes(dataUrl) {
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex === -1) {
    return dataUrl.length;
  }
  return Math.ceil((dataUrl.length - commaIndex - 1) * 3 / 4);
}

function visualPolicyErrorForObservation(observation) {
  if (
    observation &&
    observation.visualPolicy &&
    observation.visualPolicy.explicitBlock === true
  ) {
    return {
      code: 'VISUAL_PROVIDER_POLICY_BLOCKED',
      message: 'Screenshot capture is blocked because sensitive page content was detected.',
      reason: 'SENSITIVE_VISUAL_CONTENT',
      resumePolicy: 'manual-sensitive-review',
      freshObservationRequired: true
    };
  }

  const gates = observation && Array.isArray(observation.detectedGates)
    ? observation.detectedGates
    : [];
  if (gates.length > 0) {
    const gate = gates[0];
    return {
      code: 'VISUAL_PROVIDER_POLICY_BLOCKED',
      message: 'Screenshot capture is blocked while an authentication or anti-abuse gate is visible.',
      gateType: gate.type || gate.code,
      resumePolicy: 'wait-and-reobserve',
      freshObservationRequired: true
    };
  }

  if (
    observation &&
    (
      observation.sensitiveVisualContent === true ||
      (observation.visualPolicy && observation.visualPolicy.sensitive === true)
    )
  ) {
    return {
      code: 'VISUAL_PROVIDER_POLICY_BLOCKED',
      message: 'Screenshot capture is blocked because sensitive page content was detected.',
      reason: 'SENSITIVE_VISUAL_CONTENT',
      resumePolicy: 'manual-sensitive-review',
      freshObservationRequired: true
    };
  }

  return null;
}

async function syncPermissionsAfterChange() {
  try {
    await connectNative();
    if (nativePort) {
      await syncGrantedHostPermissions();
    }
  } catch (error) {
    lastNativeError = error.message;
    await chrome.storage.local.set({ lastNativeError });
  }
}

async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['actionPolicy.js', 'gateDetector.js', 'pageHandles.js', 'pageWait.js', 'contentScript.js']
  });
}

function tabInfo(tab) {
  if (!tab) {
    return null;
  }
  let origin = null;
  if (tab.url) {
    try {
      origin = new URL(tab.url).origin;
    } catch {
      origin = null;
    }
  }
  return {
    id: tab.id,
    windowId: tab.windowId,
    url: tab.url || null,
    origin,
    title: tab.title || null,
    status: tab.status || null,
    loadingState: tab.status === 'loading' ? 'loading' : 'complete'
  };
}

async function activeTabInfo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabInfo(tab);
}

function isExtensionPageTab(tab) {
  return Boolean(tab && typeof tab.url === 'string' && tab.url.startsWith(`chrome-extension://${chrome.runtime.id}/`));
}

async function reportActiveTab() {
  if (!nativePort) {
    return;
  }
  postNativeRpcNoThrow('extension.activeTabUpdated', {
    activeTab: await activeTabInfo()
  });
}

async function requireActiveTabForOrigin(origin) {
  const tab = await activeTabInfo();
  if (!tab || !tab.id || !tab.url) {
    return { ok: false, error: { code: 'NO_ACTIVE_TAB' } };
  }
  const activeOrigin = new URL(tab.url).origin;
  if (origin && activeOrigin !== origin) {
    return {
      ok: false,
      error: {
        code: 'DOMAIN_NOT_APPROVED',
        message: `Active tab origin ${activeOrigin} does not match requested ${origin}.`
      }
    };
  }
  if (!(await hasHostPermission(activeOrigin))) {
    return { ok: false, error: { code: 'HOST_PERMISSION_REQUIRED', origin: activeOrigin } };
  }
  await ensureContentScript(tab.id);
  return { ok: true, tab, origin: activeOrigin };
}

async function handleOperatorCommand(command) {
  const params = command.params || {};

  try {
    if (command.method === 'page.navigate') {
      const tab = await activeTabInfo();
      if (!tab || !tab.id) {
        return { ok: false, error: { code: 'NO_ACTIVE_TAB' } };
      }
      const targetTab = isExtensionPageTab(tab)
        ? await chrome.tabs.create({ active: true, url: params.url, windowId: tab.windowId })
        : await chrome.tabs.update(tab.id, { active: true, url: params.url });
      return {
        ok: true,
        result: {
          action: 'navigate',
          url: params.url,
          tab: tabInfo(targetTab),
          openedNewTab: isExtensionPageTab(tab)
        }
      };
    }

    const ready = await requireActiveTabForOrigin(params.origin);
    if (!ready.ok) {
      return ready;
    }

    if (command.method === 'page.observe') {
      const observation = await chrome.tabs.sendMessage(ready.tab.id, { type: 'content.observe' });
      return { ok: true, result: observation };
    }

    if (command.method === 'page.visualObserve') {
      const observation = await chrome.tabs.sendMessage(ready.tab.id, { type: 'content.observe' });
      const policyError = visualPolicyErrorForObservation(observation);
      if (policyError) {
        return { ok: false, error: policyError };
      }
      const dataUrl = await captureVisibleTabWithRetry({
        captureVisibleTab: (windowId, options) => chrome.tabs.captureVisibleTab(windowId, options),
        windowId: ready.tab.windowId,
        options: { format: 'png' }
      });
      return {
        ok: true,
        result: {
          ...observation,
          visual: {
            provider: 'chrome.tabs.captureVisibleTab',
            screenshotBacked: true
          },
          screenshot: {
            mimeType: 'image/png',
            dataUrl,
            bytesApprox: estimateDataUrlBytes(dataUrl)
          }
        }
      };
    }

    if (command.method === 'page.waitFor') {
      return chrome.tabs.sendMessage(ready.tab.id, {
        type: 'content.waitFor',
        condition: params.condition,
        timeoutMs: params.timeoutMs,
        pollIntervalMs: params.pollIntervalMs
      });
    }

    const actionMap = {
      'page.click': 'click',
      'page.type': 'type',
      'page.fill': 'fill',
      'page.clear': 'clear',
      'page.focus': 'focus',
      'page.select': 'select',
      'page.check': 'check',
      'page.scroll': 'scroll',
      'page.pressKey': 'pressKey'
    };
    const action = actionMap[command.method];
    if (!action) {
      return { ok: false, error: { code: 'UNKNOWN_METHOD' } };
    }

    return chrome.tabs.sendMessage(ready.tab.id, {
      type: 'content.action',
      action,
      handle: params.handle,
      text: params.text,
      value: params.value,
      checked: params.checked,
      deltaX: params.deltaX,
      deltaY: params.deltaY,
      key: params.key,
      approval: params.approval
    });
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'EXTENSION_COMMAND_FAILED',
        message: error.message
      }
    };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message && message.type === 'operator.connectNative') {
      await connectNative();
      sendResponse({ ok: true, connectionState, lastNativeError });
      return;
    }

    if (message && message.type === 'operator.refreshHello') {
      await connectNative({ refreshHello: true });
      sendResponse({ ok: true, connectionState, lastNativeError });
      return;
    }

    if (message && message.type === 'operator.hostPermissionGranted') {
      await connectNative();
      const binding = await getProfileBinding();
      postNativeRpc('extension.hostPermissionGranted', {
        origin: message.origin,
        profileBindingId: binding.profileBindingId
      });
      await syncGrantedHostPermissions();
      sendResponse({ ok: true, origin: message.origin });
      return;
    }

    if (message && message.type === 'operator.status') {
      sendResponse({
        ok: true,
        connectionState,
        lastNativeError,
        activeTab: await activeTabInfo()
      });
      return;
    }

    if (message && message.type === 'operator.hasHostPermission') {
      sendResponse({
        ok: true,
        origin: message.origin,
        granted: await hasHostPermission(message.origin)
      });
      return;
    }

    if (message && message.type === 'operator.observeActiveTab') {
      const tab = await activeTabInfo();
      if (!tab || !tab.id || !tab.url) {
        sendResponse({ ok: false, error: { code: 'NO_ACTIVE_TAB' } });
        return;
      }
      const origin = new URL(tab.url).origin;
      if (!(await hasHostPermission(origin))) {
        sendResponse({ ok: false, error: { code: 'HOST_PERMISSION_REQUIRED', origin } });
        return;
      }
      await ensureContentScript(tab.id);
      const observation = await chrome.tabs.sendMessage(tab.id, { type: 'content.observe' });
      sendResponse({ ok: true, result: observation });
      return;
    }

    sendResponse({ ok: false, error: { code: 'UNKNOWN_MESSAGE' } });
  })();
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ connectionState: 'DISCONNECTED' });
});

chrome.permissions.onAdded.addListener(syncPermissionsAfterChange);
chrome.permissions.onRemoved.addListener(syncPermissionsAfterChange);
chrome.tabs.onActivated.addListener(() => {
  reportActiveTab();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status || changeInfo.url || changeInfo.title) {
    reportActiveTab();
  }
});
