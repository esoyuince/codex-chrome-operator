'use strict';

importScripts('permissionOrigins.js', 'visualCapture.js', 'accessibilitySnapshot.js', 'uiGraph.js', 'fileUpload.js', 'cartWorkflow.js', 'debuggerActions.js', 'pageReader.js');

const NATIVE_HOST = 'com.codex.chrome_operator';
const BLOCKED_ORIGINS_KEY = 'blockedOrigins';
const NATIVE_RECONNECT_ALARM = 'operator.nativeReconnect';
const NATIVE_RECONNECT_PERIOD_MINUTES = 0.5;
const WARM_SESSION_ALARM = 'operator.warmSession';
const WARM_SESSION_PERIOD_MINUTES = 0.5;
const WARM_SESSION_MIN_INTERVAL_MS = 1500;
const WARM_SESSION_READ_MAX_CHARS = 6000;
const NATIVE_RPC_TIMEOUT_MS = 10000;
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const FATAL_NATIVE_ERROR_CODES = new Set([
  'EXTENSION_ID_MISMATCH',
  'PROTOCOL_VERSION_MISMATCH',
  'EXTENSION_VERSION_MISMATCH',
  'BRIDGE_VERSION_MISMATCH'
]);
const {
  hasBroadHostPermission,
  permissionPatternsToOrigins
} = globalThis.CodexPermissionOrigins;
const {
  captureVisibleTabWithBudget
} = globalThis.CodexVisualCapture;
const {
  captureAccessibilityTree
} = globalThis.CodexAccessibilitySnapshot;
const {
  attachUiGraph
} = globalThis.CodexUiGraph;
const {
  runDebuggerAction
} = globalThis.CodexDebuggerActions;

let nativePort = null;
let lastNativeError = null;
let connectionState = 'DISCONNECTED';
let suppressNextNativeReconnect = false;
let warmSessionInFlight = false;
let lastWarmSessionAt = 0;
const pendingNativeRpcs = new Map();

function requestId(prefix = 'ext') {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function getProfileBinding() {
  return {
    profileBindingState: 'not-required',
    profileBindingSource: 'implicit-extension'
  };
}

async function buildHello() {
  return {
    type: 'HELLO',
    protocolVersion: '1.0',
    extensionId: chrome.runtime.id,
    extensionVersion: chrome.runtime.getManifest().version,
  bridgeVersion: '0.2.10',
    sessionBootstrapId: requestId('boot'),
    ...getProfileBinding(),
    capabilities: [
      'observe.v1',
      'readPage.v1',
      'accessibilitySnapshot.v1',
      'uiGraph.v1',
      'visualObserve.v1',
      'visualAnalyze.v1',
      'screenshots.v1',
      'actions.basic.v1',
      'batch.v1',
      'warmSession.v1',
      'fileUpload.v1',
      'cartPreparation.v1',
      'guarded.v1',
      'gateHandoff.v1',
      'actions.cdp.v1'
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

function requestNativeRpc(method, params = {}, { timeoutMs = NATIVE_RPC_TIMEOUT_MS } = {}) {
  if (!nativePort) {
    throw new Error('Native bridge is not connected.');
  }
  const id = requestId('rpc');
  const request = { id, method, params };
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingNativeRpcs.delete(id);
      resolve({
        id,
        ok: false,
        error: {
          code: 'NATIVE_RPC_TIMEOUT',
          message: `Native RPC timed out: ${method}`
        }
      });
    }, timeoutMs);
    pendingNativeRpcs.set(id, { resolve, timeout });
    nativePort.postMessage(request);
  });
}

function settlePendingNativeRpcs(error) {
  for (const [id, pending] of pendingNativeRpcs.entries()) {
    clearTimeout(pending.timeout);
    pending.resolve({
      id,
      ok: false,
      error
    });
  }
  pendingNativeRpcs.clear();
}

function resolvePendingNativeRpc(message) {
  if (!message || !message.id || !pendingNativeRpcs.has(message.id)) {
    return false;
  }
  const pending = pendingNativeRpcs.get(message.id);
  pendingNativeRpcs.delete(message.id);
  clearTimeout(pending.timeout);
  pending.resolve(message);
  return true;
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

async function scheduleNativeReconnect() {
  if (!chrome.alarms || !chrome.alarms.create) {
    return;
  }
  await chrome.alarms.create(NATIVE_RECONNECT_ALARM, {
    delayInMinutes: NATIVE_RECONNECT_PERIOD_MINUTES,
    periodInMinutes: NATIVE_RECONNECT_PERIOD_MINUTES
  });
}

async function clearNativeReconnect() {
  if (!chrome.alarms || !chrome.alarms.clear) {
    return;
  }
  await chrome.alarms.clear(NATIVE_RECONNECT_ALARM);
}

async function hasOffscreenDocument() {
  if (!chrome.offscreen) {
    return false;
  }
  if (typeof chrome.offscreen.hasDocument === 'function') {
    return chrome.offscreen.hasDocument();
  }
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
    });
    return contexts.length > 0;
  }
  return false;
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen || typeof chrome.offscreen.createDocument !== 'function') {
    return false;
  }
  if (await hasOffscreenDocument()) {
    return true;
  }
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ['WORKERS'],
    justification: 'Keep the local Codex operator session warm for active-tab observation.'
  });
  return true;
}

async function scheduleWarmSession() {
  await ensureOffscreenDocument().catch(() => false);
  if (!chrome.alarms || !chrome.alarms.create) {
    return;
  }
  await chrome.alarms.create(WARM_SESSION_ALARM, {
    delayInMinutes: WARM_SESSION_PERIOD_MINUTES,
    periodInMinutes: WARM_SESSION_PERIOD_MINUTES
  });
}

function normalizeBlockedPattern(pattern) {
  if (typeof pattern !== 'string') {
    return null;
  }
  const value = pattern.trim().toLowerCase();
  if (!value) {
    return null;
  }
  if (value.startsWith('*.') && value.length > 2) {
    return value.replace(/\/+$/, '');
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return url.origin;
      }
    } catch {
      return null;
    }
  }
  return value.replace(/\/+$/, '');
}

function blockedPatternMatchesOrigin(pattern, origin) {
  if (!pattern || !origin) {
    return false;
  }
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const normalizedPattern = normalizeBlockedPattern(pattern);
  if (!normalizedPattern) {
    return false;
  }
  const originValue = url.origin.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  const host = url.host.toLowerCase();

  if (normalizedPattern.includes('://')) {
    return originValue === normalizedPattern;
  }
  if (normalizedPattern.startsWith('*.')) {
    const suffix = normalizedPattern.slice(2);
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }
  if (normalizedPattern.includes(':')) {
    return host === normalizedPattern;
  }
  return hostname === normalizedPattern;
}

async function getBlockedOrigins() {
  const result = await chrome.storage.local.get([BLOCKED_ORIGINS_KEY]);
  const raw = Array.isArray(result[BLOCKED_ORIGINS_KEY]) ? result[BLOCKED_ORIGINS_KEY] : [];
  return [...new Set(raw.map((pattern) => normalizeBlockedPattern(pattern)).filter(Boolean))].sort();
}

async function setBlockedOrigins(patterns) {
  const blockedOrigins = [...new Set(
    (Array.isArray(patterns) ? patterns : [])
      .map((pattern) => normalizeBlockedPattern(pattern))
      .filter(Boolean)
  )].sort();
  await chrome.storage.local.set({ [BLOCKED_ORIGINS_KEY]: blockedOrigins });
  return blockedOrigins;
}

async function blockedOriginMatch(origin) {
  const blockedOrigins = await getBlockedOrigins();
  const pattern = blockedOrigins.find((entry) => blockedPatternMatchesOrigin(entry, origin));
  return pattern ? { origin, pattern } : null;
}

async function syncBlockedOrigins() {
  if (!nativePort) {
    return;
  }
  postNativeRpc('extension.blockedOriginsSynced', {
    blockedOrigins: await getBlockedOrigins()
  });
}

function isFatalNativeResponse(message) {
  return Boolean(
    message &&
    message.ok === false &&
    message.error &&
    FATAL_NATIVE_ERROR_CODES.has(message.error.code)
  );
}

async function closeNativeAfterFatalResponse(message) {
  const error = message.error || {};
  lastNativeError = error.message || error.code || 'Native handshake rejected.';
  connectionState = 'ERROR';
  await chrome.storage.local.set({
    connectionState,
    lastNativeError,
    lastNativeResponse: message
  });
  settlePendingNativeRpcs(error);
  if (nativePort) {
    const port = nativePort;
    nativePort = null;
    suppressNextNativeReconnect = true;
    try {
      port.disconnect();
    } catch {
      // The native port may have already closed after the rejected HELLO.
    }
  }
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
  const origins = await grantedHostPermissionOrigins();
  if (origins === null) {
    return;
  }

  postNativeRpc('extension.hostPermissionsSynced', {
    origins
  });
}

async function connectNative({ refreshHello = false, retryOnFailure = false } = {}) {
  if (nativePort) {
    if (refreshHello) {
      await sendHello();
      await syncGrantedHostPermissions();
      await syncBlockedOrigins();
    }
    await clearNativeReconnect();
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
      const shouldReconnect = !suppressNextNativeReconnect;
      suppressNextNativeReconnect = false;
      postNativeRpcNoThrow('extension.disconnected', {
        source: 'native-port',
        reason: lastNativeError || 'Native port disconnected.'
      });
      connectionState = 'DISCONNECTED';
      nativePort = null;
      settlePendingNativeRpcs({
        code: 'EXTENSION_DISCONNECTED',
        message: lastNativeError || 'Native port disconnected.'
      });
      chrome.storage.local.set({ connectionState, lastNativeError });
      if (shouldReconnect) {
        scheduleNativeReconnect().catch((error) => {
          lastNativeError = error.message;
          chrome.storage.local.set({ lastNativeError });
        });
      }
    });

    await sendHello();
    await syncGrantedHostPermissions();
    await syncBlockedOrigins();
    connectionState = 'CONNECTED';
    await clearNativeReconnect();
    await scheduleWarmSession();
    warmActiveSession({ reason: 'native-connected' }).catch(() => {});
    await chrome.storage.local.set({ connectionState, lastNativeError: null });
  } catch (error) {
    lastNativeError = error.message;
    connectionState = 'ERROR';
    nativePort = null;
    settlePendingNativeRpcs({
      code: 'NATIVE_BRIDGE_FAILED',
      message: error.message
    });
    await chrome.storage.local.set({ connectionState, lastNativeError });
    if (retryOnFailure) {
      await scheduleNativeReconnect();
    }
  }
}

async function handleNativeMessage(message) {
  if (isFatalNativeResponse(message)) {
    await closeNativeAfterFatalResponse(message);
    return;
  }

  if (resolvePendingNativeRpc(message)) {
    await chrome.storage.local.set({ lastNativeResponse: message });
    return;
  }

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
      await syncBlockedOrigins();
    }
  } catch (error) {
    lastNativeError = error.message;
    await chrome.storage.local.set({ lastNativeError });
  }
}

async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['actionPolicy.js', 'gateDetector.js', 'pageHandles.js', 'pageWait.js', 'fileUpload.js', 'cartWorkflow.js', 'pageReader.js', 'intentExtractors.js', 'uiGraph.js', 'contentScript.js']
  });
}

async function openOperatorSidePanel(tab) {
  const tabId = tab && tab.id;
  if (chrome.sidePanel && tabId) {
    await chrome.sidePanel.setOptions({
      tabId,
      path: 'sidepanel.html',
      enabled: true
    });
    await chrome.sidePanel.open({ tabId });
    return;
  }
  await chrome.tabs.create({
    active: true,
    url: chrome.runtime.getURL('sidepanel.html'),
    ...(tab && tab.windowId ? { windowId: tab.windowId } : {})
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
  const [lastFocusedTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (lastFocusedTab) {
    return tabInfo(lastFocusedTab);
  }
  const [currentWindowTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabInfo(currentWindowTab);
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

function isWarmableTab(tab) {
  if (!tab || !tab.id || !tab.url || tab.status === 'loading' || isExtensionPageTab(tab)) {
    return false;
  }
  try {
    const url = new URL(tab.url);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function batchResultByAction(response, actionName) {
  const results = response &&
    response.result &&
    Array.isArray(response.result.results)
    ? response.result.results
    : [];
  const item = results.find((entry) => (
    entry &&
    entry.ok &&
    entry.result &&
    entry.result.action === actionName
  ));
  return item ? item.result : null;
}

function observeOptions(params = {}) {
  return {
    ...(params.mode === undefined ? {} : { mode: params.mode }),
    ...(params.maxActionableHandles === undefined ? {} : { maxActionableHandles: params.maxActionableHandles }),
    ...(params.summaryMaxChars === undefined ? {} : { summaryMaxChars: params.summaryMaxChars }),
    ...(params.sincePageStateId === undefined ? {} : { sincePageStateId: params.sincePageStateId }),
    ...(params.includeAx === undefined ? {} : { includeAx: params.includeAx }),
    ...(params.includeFormValues === undefined ? {} : { includeFormValues: params.includeFormValues }),
    ...(params.maxFieldValueChars === undefined ? {} : { maxFieldValueChars: params.maxFieldValueChars })
  };
}

async function observePage(tabId, params = {}) {
  const observation = await chrome.tabs.sendMessage(tabId, {
    type: 'content.observe',
    ...observeOptions(params)
  });
  if (params.includeAx !== true) {
    return observation;
  }
  const axSnapshot = await captureAccessibilityTree({
    chromeApi: chrome,
    tabId
  });
  return attachUiGraph(observation, { axSnapshot });
}

async function attachPostActionSnapshot(tabId, actionResponse, params = {}) {
  if (!actionResponse || actionResponse.ok !== true || params.postActionSnapshot !== 'delta') {
    return actionResponse;
  }
  try {
    const snapshot = await chrome.tabs.sendMessage(tabId, {
      type: 'content.observe',
      mode: params.mode || 'tiny',
      ...observeOptions(params)
    });
    return {
      ...actionResponse,
      result: {
        ...(actionResponse.result || {}),
        postActionSnapshot: snapshot
      }
    };
  } catch (error) {
    return {
      ...actionResponse,
      result: {
        ...(actionResponse.result || {}),
        postActionSnapshotError: {
          code: 'POST_ACTION_SNAPSHOT_FAILED',
          message: error.message || String(error)
        }
      }
    };
  }
}

async function postWarmSessionFailure(tab, reason, error) {
  if (!nativePort || !tab) {
    return;
  }
  postNativeRpcNoThrow('extension.activeTabWarmup', {
    activeTab: tabInfo(tab),
    warmup: {
      ok: false,
      source: 'content.batch',
      reason,
      error: error ? {
        code: error.code || 'WARM_SESSION_FAILED',
        message: error.message || String(error)
      } : null
    }
  });
}

async function warmActiveSession({ reason = 'manual' } = {}) {
  if (!nativePort) {
    return null;
  }
  const now = Date.now();
  if (warmSessionInFlight || now - lastWarmSessionAt < WARM_SESSION_MIN_INTERVAL_MS) {
    return null;
  }

  const tab = await activeTabInfo();
  if (!isWarmableTab(tab)) {
    return null;
  }

  warmSessionInFlight = true;
  lastWarmSessionAt = now;
  try {
    const origin = new URL(tab.url).origin;
    const blocked = await blockedOriginMatch(origin);
    if (blocked) {
      await postWarmSessionFailure(tab, 'blocked-origin', {
        code: 'SITE_BLOCKED_BY_USER_SETTINGS',
        message: 'Origin is blocked by user extension settings.'
      });
      return null;
    }

    await ensureContentScript(tab.id);
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: 'content.batch',
      origin,
      stopOnError: false,
      actions: [{
        action: 'observe'
      }, {
        action: 'readPage',
        filter: 'interactive',
        maxChars: WARM_SESSION_READ_MAX_CHARS
      }]
    });
    if (!response || !response.ok) {
      await postWarmSessionFailure(tab, 'content-batch-failed', response && response.error);
      return null;
    }

    const observation = batchResultByAction(response, 'observe');
    const readPage = batchResultByAction(response, 'readPage');
    postNativeRpcNoThrow('extension.activeTabWarmup', {
      activeTab: tabInfo(tab),
      reason,
      warmup: {
        ok: true,
        source: 'content.batch',
        readPageFilter: 'interactive',
        observation,
        readPage
      }
    });
    return { observation, readPage };
  } catch (error) {
    await postWarmSessionFailure(tab, 'exception', error);
    return null;
  } finally {
    warmSessionInFlight = false;
  }
}

async function reportAndWarmActiveTab(reason) {
  await reportActiveTab();
  await warmActiveSession({ reason });
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
  const blocked = await blockedOriginMatch(activeOrigin);
  if (blocked) {
    return {
      ok: false,
      error: {
        code: 'SITE_BLOCKED_BY_USER_SETTINGS',
        message: 'Origin is blocked by user extension settings.',
        origin: activeOrigin,
        blockedPattern: blocked.pattern
      }
    };
  }
  await ensureContentScript(tab.id);
  return { ok: true, tab, origin: activeOrigin };
}

async function preflightDebuggerAction(ready, action, params) {
  if (action === 'scroll' && !params.handle) {
    return { ok: true };
  }

  const preflight = await chrome.tabs.sendMessage(ready.tab.id, {
    type: 'content.resolveActionTarget',
    action,
    handle: params.handle
  });
  if (!preflight || !preflight.ok) {
    if (
      params.target &&
      preflight &&
      preflight.error &&
      preflight.error.code === 'STALE_HANDLE'
    ) {
      return { ok: true, result: { target: params.target, risk: null } };
    }
    return preflight || {
      ok: false,
      error: {
        code: 'ACTION_PREFLIGHT_FAILED',
        message: 'Action target preflight failed.'
      }
    };
  }

  const risk = preflight.result && preflight.result.risk;
  const approvedHighRisk = risk &&
    params.approval &&
    params.approval.allowHighRisk === true &&
    params.approval.approvalKind === risk.approvalKind;
  if (risk && !approvedHighRisk) {
    return { ok: false, error: risk };
  }

  return { ok: true, result: preflight.result };
}

async function handleOperatorCommand(command) {
  const params = command.params || {};

  try {
    if (command.method === 'page.navigate') {
      const tab = await activeTabInfo();
      if (!tab || !tab.id) {
        return { ok: false, error: { code: 'NO_ACTIVE_TAB' } };
      }
      const targetOrigin = new URL(params.url).origin;
      const blocked = await blockedOriginMatch(targetOrigin);
      if (blocked) {
        return {
          ok: false,
          error: {
            code: 'SITE_BLOCKED_BY_USER_SETTINGS',
            message: 'Origin is blocked by user extension settings.',
            origin: targetOrigin,
            blockedPattern: blocked.pattern
          }
        };
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
      const observation = await observePage(ready.tab.id, params);
      return { ok: true, result: observation };
    }

    if (command.method === 'page.readPage') {
      return chrome.tabs.sendMessage(ready.tab.id, {
        type: 'content.readPage',
        filter: params.filter,
        depth: params.depth,
        maxChars: params.maxChars,
        refId: params.refId,
        includeFormValues: params.includeFormValues,
        maxFieldValueChars: params.maxFieldValueChars
      });
    }

    if (command.method === 'page.extract') {
      const extraction = await chrome.tabs.sendMessage(ready.tab.id, {
        type: 'content.extract',
        intent: params.intent,
        maxCandidates: params.maxCandidates
      });
      return { ok: true, result: extraction };
    }

    if (command.method === 'page.batch') {
      return chrome.tabs.sendMessage(ready.tab.id, {
        type: 'content.batch',
        origin: params.origin,
        stopOnError: params.stopOnError,
        actions: params.actions
      });
    }

    if (command.method === 'page.visualObserve') {
      const observation = await observePage(ready.tab.id, {
        ...params,
        mode: params.mode || 'medium'
      });
      const policyError = visualPolicyErrorForObservation(observation);
      if (policyError) {
        return { ok: false, error: policyError };
      }
      const dataUrl = await captureVisibleTabWithBudget({
        captureVisibleTab: (windowId, options) => chrome.tabs.captureVisibleTab(windowId, options),
        windowId: ready.tab.windowId,
        format: params.format,
        quality: params.quality,
        maxBytes: params.maxBytes
      });
      const mimeType = dataUrl.startsWith('data:image/jpeg;') ? 'image/jpeg' : 'image/png';
      return {
        ok: true,
        result: {
          ...observation,
          visual: {
            provider: 'chrome.tabs.captureVisibleTab',
            screenshotBacked: true
          },
          screenshot: {
            mimeType,
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

    if (command.method === 'page.uploadFile') {
      return chrome.tabs.sendMessage(ready.tab.id, {
        type: 'content.uploadFile',
        origin: params.origin,
        target: params.target,
        ruleset: params.ruleset,
        verifyPreview: params.verifyPreview,
        files: params.files
      });
    }

    if (command.method === 'page.prepareCart') {
      return chrome.tabs.sendMessage(ready.tab.id, {
        type: 'content.prepareCart',
        origin: params.origin,
        profileId: params.profileId,
        query: params.query,
        criteria: params.criteria,
        cartActionAllowed: params.cartActionAllowed
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

    const preflight = await preflightDebuggerAction(ready, action, params);
    if (!preflight.ok) {
      return preflight;
    }

    const actionResponse = await runDebuggerAction({
      chromeApi: chrome,
      tab: ready.tab,
      action,
      params: {
        handle: params.handle,
        target: params.target || (preflight.result && preflight.result.target),
        text: params.text,
        value: params.value,
        checked: params.checked,
        deltaX: params.deltaX,
        deltaY: params.deltaY,
        key: params.key
      }
    });
    return attachPostActionSnapshot(ready.tab.id, actionResponse, params);
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

    if (message && message.type === 'operator.blockedOriginsStatus') {
      const blockedOrigins = await getBlockedOrigins();
      const match = message.origin
        ? blockedOrigins.find((pattern) => blockedPatternMatchesOrigin(pattern, message.origin))
        : null;
      sendResponse({
        ok: true,
        origin: message.origin || null,
        blockedOrigins,
        blocked: Boolean(match),
        blockedPattern: match || null
      });
      return;
    }

    if (message && message.type === 'operator.setBlockedOrigins') {
      const blockedOrigins = await setBlockedOrigins(message.blockedOrigins);
      await connectNative();
      await syncBlockedOrigins();
      sendResponse({ ok: true, blockedOrigins });
      return;
    }

    if (message && message.type === 'operator.hostPermissionGranted') {
      await connectNative();
      postNativeRpc('extension.hostPermissionGranted', {
        origin: message.origin
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

    if (message && message.type === 'operator.daemonStatus') {
      await connectNative();
      sendResponse(await requestNativeRpc('operator.status'));
      return;
    }

    if (message && message.type === 'operator.approvals.list') {
      await connectNative();
      sendResponse(await requestNativeRpc('operator.approvals.list', {
        ...(message.status ? { status: message.status } : {})
      }));
      return;
    }

    if (message && message.type === 'operator.approvals.approve') {
      await connectNative();
      sendResponse(await requestNativeRpc('operator.approvals.approve', {
        approvalId: message.approvalId,
        userDecision: 'approve',
        source: 'sidepanel'
      }));
      return;
    }

    if (message && message.type === 'operator.approvals.reject') {
      await connectNative();
      sendResponse(await requestNativeRpc('operator.approvals.reject', {
        approvalId: message.approvalId,
        userDecision: 'reject',
        source: 'sidepanel'
      }));
      return;
    }

    if (message && message.type === 'operator.approvals.run') {
      await connectNative();
      sendResponse(await requestNativeRpc('operator.approvals.run', {
        approvalId: message.approvalId,
        source: 'sidepanel'
      }));
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

    if (message && message.type === 'operator.offscreenHeartbeat') {
      if (!nativePort) {
        wakeNativeBridge();
      } else {
        reportAndWarmActiveTab('offscreen-heartbeat').catch(() => {});
      }
      sendResponse({ ok: true });
      return;
    }

    if (message && message.type === 'operator.observeActiveTab') {
      const tab = await activeTabInfo();
      if (!tab || !tab.id || !tab.url) {
        sendResponse({ ok: false, error: { code: 'NO_ACTIVE_TAB' } });
        return;
      }
      const origin = new URL(tab.url).origin;
      const blocked = await blockedOriginMatch(origin);
      if (blocked) {
        sendResponse({
          ok: false,
          error: {
            code: 'SITE_BLOCKED_BY_USER_SETTINGS',
            origin,
            blockedPattern: blocked.pattern
          }
        });
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

function configureSidePanelBehavior() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
}

function wakeNativeBridge() {
  connectNative({ retryOnFailure: true }).catch((error) => {
    lastNativeError = error.message;
    chrome.storage.local.set({ lastNativeError });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ connectionState: 'DISCONNECTED' });
  configureSidePanelBehavior();
  scheduleWarmSession().catch(() => {});
  wakeNativeBridge();
});

chrome.runtime.onStartup.addListener(() => {
  configureSidePanelBehavior();
  scheduleWarmSession().catch(() => {});
  wakeNativeBridge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === NATIVE_RECONNECT_ALARM) {
    wakeNativeBridge();
  }
  if (alarm && alarm.name === WARM_SESSION_ALARM) {
    if (!nativePort) {
      wakeNativeBridge();
      return;
    }
    reportAndWarmActiveTab('warm-session-alarm').catch(() => {});
  }
});

chrome.action.onClicked.addListener((tab) => {
  openOperatorSidePanel(tab).catch((error) => {
    lastNativeError = error.message;
    chrome.storage.local.set({ lastNativeError });
  });
});

chrome.permissions.onAdded.addListener(syncPermissionsAfterChange);
chrome.permissions.onRemoved.addListener(syncPermissionsAfterChange);
chrome.tabs.onActivated.addListener(() => {
  reportAndWarmActiveTab('tab-activated').catch(() => {});
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    return;
  }
  reportAndWarmActiveTab('window-focus-changed').catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status || changeInfo.url || changeInfo.title) {
    if (changeInfo.status === 'complete' || changeInfo.url) {
      reportAndWarmActiveTab('tab-updated').catch(() => {});
      return;
    }
    reportActiveTab();
  }
});
