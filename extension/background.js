'use strict';

const NATIVE_HOST = 'com.codex.chrome_operator';
const PROFILE_BINDING_SOURCE = 'chrome.storage.local';

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
      'screenshots.v1',
      'actions.basic.v1',
      'guarded.v1',
      'gateHandoff.v1'
    ]
  };
}

async function connectNative() {
  if (nativePort) {
    return;
  }
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST);
    connectionState = 'CONNECTING';
    nativePort.onMessage.addListener((message) => {
      chrome.storage.local.set({ lastNativeResponse: message });
    });
    nativePort.onDisconnect.addListener(() => {
      lastNativeError = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
      connectionState = 'DISCONNECTED';
      nativePort = null;
      chrome.storage.local.set({ connectionState, lastNativeError });
    });

    const hello = await buildHello();
    nativePort.postMessage({
      id: requestId('hello'),
      method: 'extension.hello',
      params: { hello }
    });
    connectionState = 'CONNECTED';
    await chrome.storage.local.set({ connectionState, lastNativeError: null });
  } catch (error) {
    lastNativeError = error.message;
    connectionState = 'ERROR';
    nativePort = null;
    await chrome.storage.local.set({ connectionState, lastNativeError });
  }
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

async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['contentScript.js']
  });
}

async function activeTabInfo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    return null;
  }
  return {
    id: tab.id,
    url: tab.url || null,
    title: tab.title || null,
    status: tab.status || null
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message && message.type === 'operator.connectNative') {
      await connectNative();
      sendResponse({ ok: true, connectionState, lastNativeError });
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
