'use strict';

importScripts('permissionOrigins.js', 'actionPolicy.js', 'visualCapture.js', 'accessibilitySnapshot.js', 'uiGraph.js', 'runtimeLocatorAction.js', 'fileUpload.js', 'cartWorkflow.js', 'debuggerActions.js', 'pageReader.js');

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
const SESSION_TABS_STORAGE_KEY = 'operatorSessionTabs';
const SESSION_NAME_STORAGE_KEY = 'operatorSessionName';
const DEFAULT_SESSION_GROUP_TITLE = 'Codex Operator';
const DELIVERABLE_SESSION_GROUP_TITLE = 'Codex Deliverables';
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
  attachCdpSession,
  detachAllCdpSessions,
  detachCdpSession,
  runCdpCommand,
  runDebuggerAction,
  runFileInputUpload
} = globalThis.CodexDebuggerActions;
const {
  runLocatorActionWithRetry
} = globalThis.CodexRuntimeLocatorAction;

let nativePort = null;
let lastNativeError = null;
let connectionState = 'DISCONNECTED';
let suppressNextNativeReconnect = false;
let warmSessionInFlight = false;
let lastWarmSessionAt = 0;
let lastOffscreenHeartbeat = null;
let sessionStateLoaded = false;
let operatorSessionName = null;
let operatorSessionTabs = new Map();
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

async function sha256Text(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function loadedExtensionHash() {
  try {
    return `sha256:${await sha256Text(JSON.stringify({
      manifest: chrome.runtime.getManifest(),
      bridgeVersion: '0.2.13',
      imports: [
        'permissionOrigins.js',
        'actionPolicy.js',
        'visualCapture.js',
        'accessibilitySnapshot.js',
        'uiGraph.js',
        'runtimeLocatorAction.js',
        'fileUpload.js',
        'cartWorkflow.js',
        'debuggerActions.js',
        'pageReader.js'
      ]
    }))}`;
  } catch {
    return null;
  }
}

async function buildHello() {
  return {
    type: 'HELLO',
    protocolVersion: '1.0',
    extensionId: chrome.runtime.id,
    extensionVersion: chrome.runtime.getManifest().version,
    bridgeVersion: '0.2.13',
    loadedExtensionHash: await loadedExtensionHash(),
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
      'actions.cdp.v1',
      'browserContext.v1',
      'downloads.v1',
      'sessionRecovery.v1',
      'targetCue.v1',
      'operatorIndicator.v1',
      'actionTrace.v1'
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

function sidePanelNativeTimeout(message) {
  const value = Number(message && message.timeoutMs);
  if (!Number.isFinite(value)) {
    return NATIVE_RPC_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.round(value), 500), NATIVE_RPC_TIMEOUT_MS);
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

function updateActionBadge() {
  if (!chrome.action || typeof chrome.action.setBadgeText !== 'function') {
    return;
  }
  const text = nativePort && connectionState === 'CONNECTED' ? 'ON' : '';
  chrome.action.setBadgeText({ text }).catch(() => {});
  if (typeof chrome.action.setBadgeBackgroundColor === 'function') {
    chrome.action.setBadgeBackgroundColor({ color: text ? '#1a73e8' : '#5f6368' }).catch(() => {});
  }
  if (typeof chrome.action.setTitle === 'function') {
    const title = text
      ? 'Codex Operator - connected'
      : `Codex Operator - ${lastNativeError || connectionState.toLowerCase()}`;
    chrome.action.setTitle({ title }).catch(() => {});
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
  updateActionBadge();
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
    updateActionBadge();
    nativePort.onMessage.addListener((message) => {
      handleNativeMessage(message);
    });
    nativePort.onDisconnect.addListener(() => {
      lastNativeError = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
      const shouldReconnect = !suppressNextNativeReconnect;
      suppressNextNativeReconnect = false;
      detachAllCdpSessions({ chromeApi: chrome }).catch(() => {});
      postNativeRpcNoThrow('extension.disconnected', {
        source: 'native-port',
        reason: lastNativeError || 'Native port disconnected.'
      });
      connectionState = 'DISCONNECTED';
      nativePort = null;
      updateActionBadge();
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
    updateActionBadge();
    await clearNativeReconnect();
    await scheduleWarmSession();
    warmActiveSession({ reason: 'native-connected' }).catch(() => {});
    await chrome.storage.local.set({ connectionState, lastNativeError: null });
  } catch (error) {
    lastNativeError = error.message;
    connectionState = 'ERROR';
    nativePort = null;
    updateActionBadge();
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
    pendingUrl: tab.pendingUrl || null,
    origin,
    title: tab.title || null,
    favIconUrl: tab.favIconUrl || null,
    groupId: Number.isInteger(tab.groupId) ? tab.groupId : null,
    active: tab.active === true,
    pinned: tab.pinned === true,
    audible: tab.audible === true,
    muted: Boolean(tab.mutedInfo && tab.mutedInfo.muted),
    lastAccessed: typeof tab.lastAccessed === 'number' && Number.isFinite(tab.lastAccessed)
      ? new Date(tab.lastAccessed).toISOString()
      : null,
    status: tab.status || null,
    loadingState: tab.status === 'loading' ? 'loading' : 'complete'
  };
}

function sessionStorageArea() {
  return chrome.storage && chrome.storage.session ? chrome.storage.session : chrome.storage.local;
}

async function loadSessionTabState() {
  if (sessionStateLoaded) {
    return;
  }
  sessionStateLoaded = true;
  try {
    const stored = await sessionStorageArea().get([
      SESSION_TABS_STORAGE_KEY,
      SESSION_NAME_STORAGE_KEY
    ]);
    operatorSessionName = typeof stored[SESSION_NAME_STORAGE_KEY] === 'string'
      ? stored[SESSION_NAME_STORAGE_KEY]
      : null;
    operatorSessionTabs = new Map();
    for (const tab of stored[SESSION_TABS_STORAGE_KEY] || []) {
      if (tab && Number.isInteger(tab.id)) {
        operatorSessionTabs.set(tab.id, { ...tab });
      }
    }
  } catch {
    operatorSessionName = null;
    operatorSessionTabs = new Map();
  }
}

async function saveSessionTabState() {
  try {
    await sessionStorageArea().set({
      [SESSION_TABS_STORAGE_KEY]: [...operatorSessionTabs.values()],
      [SESSION_NAME_STORAGE_KEY]: operatorSessionName
    });
  } catch {
    // Session tab state is best-effort; Chrome operations remain authoritative.
  }
}

function isClaimableUserTab(tab) {
  if (!tab || !Number.isInteger(tab.id) || typeof tab.url !== 'string' || !tab.url) {
    return false;
  }
  if (isExtensionPageTab(tab)) {
    return false;
  }
  try {
    const url = new URL(tab.url);
    return ['http:', 'https:', 'file:'].includes(url.protocol);
  } catch {
    return false;
  }
}

async function tabGroupTitlesById(tabs) {
  const groupIds = [...new Set(tabs
    .map((tab) => tab.groupId)
    .filter((groupId) => Number.isInteger(groupId) && groupId >= 0))];
  const entries = await Promise.all(groupIds.map(async (groupId) => {
    if (!chrome.tabGroups || typeof chrome.tabGroups.get !== 'function') {
      return null;
    }
    try {
      const group = await boundedChromePromise(chrome.tabGroups.get(groupId));
      if (!group) {
        return null;
      }
      const title = typeof group.title === 'string' ? group.title.trim() : '';
      return title ? [groupId, title] : null;
    } catch {
      return null;
    }
  }));
  return new Map(entries.filter(Boolean));
}

function userTabInfo(tab, groupTitles = new Map()) {
  const lastAccessed = typeof tab.lastAccessed === 'number' && Number.isFinite(tab.lastAccessed)
    ? new Date(tab.lastAccessed).toISOString()
    : null;
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title || null,
    url: tab.url || null,
    favIconUrl: tab.favIconUrl || null,
    groupId: Number.isInteger(tab.groupId) ? tab.groupId : null,
    active: tab.active === true,
    pinned: tab.pinned === true,
    audible: tab.audible === true,
    muted: Boolean(tab.mutedInfo && tab.mutedInfo.muted),
    claimable: true,
    ...(lastAccessed ? { lastAccessed } : {}),
    ...(lastAccessed ? { lastOpened: lastAccessed } : {}),
    ...(groupTitles.has(tab.groupId) ? { tabGroup: groupTitles.get(tab.groupId) } : {})
  };
}

function originMetadata(url) {
  try {
    const parsed = new URL(url);
    return {
      origin: parsed.origin,
      hostname: parsed.hostname,
      protocol: parsed.protocol.replace(/:$/, '')
    };
  } catch {
    return null;
  }
}

function normalizeAgentId(value) {
  return typeof value === 'string' && value.trim() && /^[A-Za-z0-9_.:-]{1,120}$/.test(value.trim())
    ? value.trim()
    : null;
}

function sessionTabInfo(tab, ownership, finalizedStatus = null, options = {}) {
  const ownerAgentId = normalizeAgentId(options.ownerAgentId || tab.ownerAgentId || tab.agentId);
  return {
    ...tabInfo(tab),
    ownership,
    active: tab.active === true,
    finalizedStatus,
    ...(ownerAgentId ? { ownerAgentId } : {}),
    ...(typeof options.leaseId === 'string' && options.leaseId ? { leaseId: options.leaseId } : {}),
    originMetadata: originMetadata(tab && tab.url)
  };
}

function boundedChromePromise(promise, timeoutMs = 1500) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
  ]).catch(() => null);
}

async function groupTabsBestEffort(tabIds, title) {
  if (!chrome.tabs.group || !chrome.tabGroups || !chrome.tabGroups.update || tabIds.length === 0) {
    return null;
  }
  try {
    const groupId = await boundedChromePromise(chrome.tabs.group({
      tabIds: tabIds.length === 1 ? tabIds[0] : tabIds
    }));
    if (!Number.isInteger(groupId)) {
      return null;
    }
    const group = await boundedChromePromise(chrome.tabGroups.update(groupId, {
      title,
      color: title === DELIVERABLE_SESSION_GROUP_TITLE ? 'blue' : 'grey'
    }));
    return { groupId, title: group && group.title ? group.title : title };
  } catch {
    // Tabs may span windows or Chrome may reject grouping. Ownership still works.
    return null;
  }
}

async function syncSessionGroupMetadataFromChrome() {
  await loadSessionTabState();
  const tabs = [];
  for (const tabId of operatorSessionTabs.keys()) {
    try {
      const tab = await boundedChromePromise(chrome.tabs.get(tabId));
      if (!tab) {
        operatorSessionTabs.delete(tabId);
        continue;
      }
      tabs.push(tab);
    } catch {
      operatorSessionTabs.delete(tabId);
    }
  }
  const groupTitles = await tabGroupTitlesById(tabs);
  for (const tab of tabs) {
    const previous = operatorSessionTabs.get(tab.id);
    if (!previous) {
      continue;
    }
      operatorSessionTabs.set(tab.id, {
        ...previous,
        ...sessionTabInfo(tab, previous.ownership, previous.finalizedStatus || null, {
          ownerAgentId: previous.ownerAgentId || null,
          leaseId: previous.leaseId || null
        }),
        ...(groupTitles.has(tab.groupId) ? { tabGroup: groupTitles.get(tab.groupId) } : {})
      });
  }
  await saveSessionTabState();
}

async function refreshSessionTabsFromChrome() {
  await loadSessionTabState();
  const refreshed = [];
  for (const [tabId, record] of operatorSessionTabs.entries()) {
    try {
      const tab = await boundedChromePromise(chrome.tabs.get(tabId));
      if (!tab) {
        operatorSessionTabs.delete(tabId);
        continue;
      }
      const next = {
        ...record,
        ...sessionTabInfo(tab, record.ownership, record.finalizedStatus || null, {
          ownerAgentId: record.ownerAgentId || null,
          leaseId: record.leaseId || null
        })
      };
      operatorSessionTabs.set(tabId, next);
      refreshed.push(next);
    } catch {
      operatorSessionTabs.delete(tabId);
    }
  }
  await saveSessionTabState();
  return refreshed;
}

async function createSessionChromeTab() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const tab = await boundedChromePromise(chrome.tabs.create({
      active: true,
      url: 'about:blank'
    }), 5000);
    if (tab && Number.isInteger(tab.id)) {
      return tab;
    }
    await sleep(150);
  }
  return null;
}

async function detachSessionCdpBestEffort(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await detachCdpSession({ chromeApi: chrome, tab });
  } catch {
    // Tab finalization should continue when a tab is already gone or detached.
  }
}

async function handleSessionTabCommand(method, params = {}) {
  await loadSessionTabState();

  if (method === 'operator.tabs.listUser') {
    const tabs = (await chrome.tabs.query({})).filter(isClaimableUserTab);
    const groupTitles = await tabGroupTitlesById(tabs);
    return {
      ok: true,
      result: {
        tabs: tabs.map((tab) => userTabInfo(tab, groupTitles))
      }
    };
  }

  if (method === 'operator.tabs.claim') {
    if (!Number.isInteger(params.tabId) || params.tabId < 0) {
      return { ok: false, error: { code: 'INVALID_SCHEMA', message: 'tabId must be a non-negative integer.' } };
    }
    const tab = await chrome.tabs.get(params.tabId);
    if (!isClaimableUserTab(tab)) {
      return {
        ok: false,
        error: {
          code: 'TAB_NOT_CLAIMABLE',
          message: 'Tab cannot be claimed by the operator.',
          tabId: params.tabId
        }
      };
    }
    const ownerAgentId = normalizeAgentId(params.agentId);
    const record = sessionTabInfo(tab, 'user', null, { ownerAgentId });
    operatorSessionTabs.set(record.id, record);
    await groupTabsBestEffort([...operatorSessionTabs.keys()], operatorSessionName || DEFAULT_SESSION_GROUP_TITLE);
    await syncSessionGroupMetadataFromChrome();
    await saveSessionTabState();
    return { ok: true, result: { tab: record } };
  }

  if (method === 'operator.tabs.create') {
    const tab = await createSessionChromeTab();
    if (!tab) {
      return {
        ok: false,
        error: {
          code: 'TAB_CREATE_FAILED',
          message: 'Chrome did not create a session tab before timeout.'
        }
      };
    }
    const ownerAgentId = normalizeAgentId(params.agentId);
    const record = sessionTabInfo(tab, 'agent', null, { ownerAgentId });
    operatorSessionTabs.set(record.id, record);
    await groupTabsBestEffort([...operatorSessionTabs.keys()], operatorSessionName || DEFAULT_SESSION_GROUP_TITLE);
    await syncSessionGroupMetadataFromChrome();
    await saveSessionTabState();
    return { ok: true, result: { tab: record } };
  }

  if (method === 'operator.tabs.listSession') {
    const ownerAgentId = normalizeAgentId(params.agentId);
    const tabs = await refreshSessionTabsFromChrome();
    return {
      ok: true,
      result: {
        tabs: ownerAgentId
          ? tabs.filter((tab) => !tab.ownerAgentId || tab.ownerAgentId === ownerAgentId)
          : tabs
      }
    };
  }

  if (method === 'operator.tabs.finalize') {
    const ownerAgentId = normalizeAgentId(params.agentId);
    const keep = Array.isArray(params.keep) ? params.keep : [];
    const keepById = new Map(keep.map((entry) => [entry.tabId, entry.status]));
    if (ownerAgentId) {
      for (const entry of keep) {
        const record = operatorSessionTabs.get(entry.tabId);
        if (record && record.ownerAgentId !== ownerAgentId) {
          return {
            ok: false,
            error: {
              code: 'TAB_MISMATCH',
              message: 'Session tab is leased to a different agent.',
              reason: 'agent-lease-mismatch',
              tabId: entry.tabId,
              ownerAgentId: record.ownerAgentId,
              agentId: ownerAgentId
            }
          };
        }
      }
    }
    const kept = [];
    const closed = [];
    const released = [];
    const closeFailed = [];
    for (const [tabId, record] of [...operatorSessionTabs.entries()]) {
      if (ownerAgentId && record.ownerAgentId !== ownerAgentId) {
        continue;
      }
      await detachSessionCdpBestEffort(tabId);
      const status = keepById.get(tabId);
      if (status === 'handoff' || status === 'deliverable') {
        const next = { ...record, finalizedStatus: status };
        operatorSessionTabs.set(tabId, next);
        kept.push({ tabId, status });
        continue;
      }
      if (record.ownership === 'agent') {
        try {
          await chrome.tabs.remove(tabId);
          operatorSessionTabs.delete(tabId);
          closed.push(tabId);
        } catch (error) {
          closeFailed.push({
            tabId,
            message: error && error.message ? error.message : String(error || 'Unknown close failure')
          });
        }
      } else {
        operatorSessionTabs.delete(tabId);
        released.push(tabId);
      }
    }
    const deliverableIds = kept
      .filter((entry) => entry.status === 'deliverable')
      .map((entry) => entry.tabId);
    await groupTabsBestEffort(deliverableIds, DELIVERABLE_SESSION_GROUP_TITLE);
    await syncSessionGroupMetadataFromChrome();
    await saveSessionTabState();
    return { ok: true, result: { kept, closed, released, closeFailed } };
  }

  if (method === 'operator.session.name') {
    const name = typeof params.name === 'string' ? params.name.trim().slice(0, 80) : '';
    if (!name) {
      return { ok: false, error: { code: 'INVALID_SCHEMA', message: 'name must be a non-empty string.' } };
    }
    operatorSessionName = name;
    await groupTabsBestEffort([...operatorSessionTabs.keys()], operatorSessionName || DEFAULT_SESSION_GROUP_TITLE);
    await syncSessionGroupMetadataFromChrome();
    await saveSessionTabState();
    return { ok: true, result: { name } };
  }

  if (method === 'operator.tabs.focus') {
    if (!Number.isInteger(params.tabId) || params.tabId < 0) {
      return { ok: false, error: { code: 'INVALID_SCHEMA', message: 'tabId must be a non-negative integer.' } };
    }
    const tab = await chrome.tabs.get(params.tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    const updated = await chrome.tabs.update(params.tabId, { active: true });
    return { ok: true, result: { tab: tabInfo(updated) } };
  }

  if (method === 'operator.tabs.pin') {
    if (!Number.isInteger(params.tabId) || params.tabId < 0 || typeof params.pinned !== 'boolean') {
      return { ok: false, error: { code: 'INVALID_SCHEMA', message: 'tabId and pinned are required.' } };
    }
    const updated = await chrome.tabs.update(params.tabId, { pinned: params.pinned });
    return { ok: true, result: { tab: tabInfo(updated) } };
  }

  if (method === 'operator.tabs.move') {
    if (!Number.isInteger(params.tabId) || params.tabId < 0 || !Number.isInteger(params.index) || params.index < 0) {
      return { ok: false, error: { code: 'INVALID_SCHEMA', message: 'tabId and index must be non-negative integers.' } };
    }
    const moved = await chrome.tabs.move(params.tabId, {
      index: params.index,
      ...(Number.isInteger(params.windowId) ? { windowId: params.windowId } : {})
    });
    const tab = Array.isArray(moved) ? moved[0] : moved;
    return { ok: true, result: { tab: tabInfo(tab) } };
  }

  if (method === 'operator.tabs.groupRename') {
    if (!Number.isInteger(params.groupId) || params.groupId < 0 || typeof params.title !== 'string' || !params.title.trim()) {
      return { ok: false, error: { code: 'INVALID_SCHEMA', message: 'groupId and title are required.' } };
    }
    const group = await chrome.tabGroups.update(params.groupId, { title: params.title.trim().slice(0, 80) });
    return { ok: true, result: { groupId: group.id, title: group.title || null } };
  }

  return { ok: false, error: { code: 'UNKNOWN_METHOD', message: `Unknown method: ${method}` } };
}

function boundedInteger(value, fallback, min, max) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function basenameFromPath(filePath) {
  if (typeof filePath !== 'string' || !filePath) {
    return null;
  }
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || null;
}

function normalizeHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  return {
    id: entry.id || null,
    url: entry.url || null,
    title: entry.title || null,
    lastVisitTime: typeof entry.lastVisitTime === 'number'
      ? new Date(entry.lastVisitTime).toISOString()
      : null,
    visitCount: typeof entry.visitCount === 'number' ? entry.visitCount : null,
    typedCount: typeof entry.typedCount === 'number' ? entry.typedCount : null
  };
}

function normalizeBookmarkEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  return {
    id: entry.id || null,
    parentId: entry.parentId || null,
    index: typeof entry.index === 'number' ? entry.index : null,
    title: entry.title || null,
    url: entry.url || null,
    dateAdded: typeof entry.dateAdded === 'number'
      ? new Date(entry.dateAdded).toISOString()
      : null
  };
}

function normalizeDownloadItem(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }
  return {
    id: item.id,
    url: item.url || null,
    finalUrl: item.finalUrl || null,
    filename: item.filename || null,
    basename: basenameFromPath(item.filename),
    state: item.state || null,
    danger: item.danger || null,
    exists: item.exists === true,
    fileSize: typeof item.fileSize === 'number' ? item.fileSize : null,
    mime: item.mime || null,
    startTime: item.startTime || null,
    endTime: item.endTime || null,
    error: item.error || null
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function downloadMatches(item, params = {}) {
  if (!item) {
    return false;
  }
  const filenameNeedle = typeof params.filenameContains === 'string'
    ? params.filenameContains.trim().toLowerCase()
    : '';
  const urlNeedle = typeof params.urlContains === 'string'
    ? params.urlContains.trim().toLowerCase()
    : '';
  const state = typeof params.state === 'string' ? params.state.trim() : '';
  const filename = String(item.filename || '').toLowerCase();
  const url = String(item.finalUrl || item.url || '').toLowerCase();
  if (filenameNeedle && !filename.includes(filenameNeedle)) {
    return false;
  }
  if (urlNeedle && !url.includes(urlNeedle)) {
    return false;
  }
  if (state && item.state !== state) {
    return false;
  }
  return true;
}

async function handleBrowserContextCommand(method, params = {}) {
  if (method === 'operator.context.recentTabs') {
    const limit = boundedInteger(params.limit, 20, 1, 100);
    const tabs = (await chrome.tabs.query({})).filter(isClaimableUserTab);
    tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    const groupTitles = await tabGroupTitlesById(tabs);
    return {
      ok: true,
      result: {
        tabs: tabs.slice(0, limit).map((tab) => userTabInfo(tab, groupTitles))
      }
    };
  }

  if (method === 'operator.context.historySearch') {
    const query = typeof params.query === 'string' ? params.query.trim() : '';
    if (!query) {
      return { ok: false, error: { code: 'INVALID_SCHEMA', message: 'query must be a non-empty string.' } };
    }
    const maxResults = boundedInteger(params.maxResults, 10, 1, 50);
    const entries = await chrome.history.search({
      text: query,
      maxResults,
      startTime: 0
    });
    return { ok: true, result: { entries: entries.map(normalizeHistoryEntry).filter(Boolean) } };
  }

  if (method === 'operator.context.bookmarkSearch') {
    const query = typeof params.query === 'string' ? params.query.trim() : '';
    if (!query) {
      return { ok: false, error: { code: 'INVALID_SCHEMA', message: 'query must be a non-empty string.' } };
    }
    const maxResults = boundedInteger(params.maxResults, 10, 1, 50);
    const entries = await chrome.bookmarks.search(query);
    return { ok: true, result: { entries: entries.slice(0, maxResults).map(normalizeBookmarkEntry).filter(Boolean) } };
  }

  return { ok: false, error: { code: 'UNKNOWN_METHOD', message: `Unknown method: ${method}` } };
}

async function handleDownloadCommand(method, params = {}) {
  if (method === 'operator.downloads.show') {
    if (!Number.isInteger(params.downloadId) || params.downloadId < 0) {
      return { ok: false, error: { code: 'INVALID_SCHEMA', message: 'downloadId must be a non-negative integer.' } };
    }
    await chrome.downloads.show(params.downloadId);
    return { ok: true, result: { shown: true, downloadId: params.downloadId } };
  }
  if (method !== 'operator.downloads.wait') {
    return { ok: false, error: { code: 'UNKNOWN_METHOD', message: `Unknown method: ${method}` } };
  }
  const timeoutMs = boundedInteger(params.timeoutMs, 30000, 0, 300000);
  const pollIntervalMs = boundedInteger(params.pollIntervalMs, 500, 50, 5000);
  const deadline = Date.now() + timeoutMs;
  do {
    const items = await chrome.downloads.search({
      orderBy: ['-startTime'],
      limit: 50
    });
    const match = items.find((item) => downloadMatches(item, params));
    if (match) {
      return { ok: true, result: { download: normalizeDownloadItem(match) } };
    }
    if (timeoutMs === 0 || Date.now() >= deadline) {
      break;
    }
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() <= deadline);

  return {
    ok: false,
    error: {
      code: 'DOWNLOAD_NOT_FOUND',
      message: 'No download matched before timeout.',
      filenameContains: params.filenameContains || null,
      urlContains: params.urlContains || null,
      state: params.state || null
    }
  };
}

async function handleSessionRecoveryCommand(method, params = {}) {
  if (method !== 'operator.sessions.reopenClosedTab') {
    return { ok: false, error: { code: 'UNKNOWN_METHOD', message: `Unknown method: ${method}` } };
  }
  const restored = await chrome.sessions.restore(params.sessionId || undefined);
  const tab = restored && restored.tab;
  if (!tab || !Number.isInteger(tab.id)) {
    return {
      ok: false,
      error: {
        code: 'NO_RESTORABLE_TAB',
        message: 'Chrome did not restore a tab for the latest closed session.'
      }
    };
  }
  const ownerAgentId = normalizeAgentId(params.agentId);
  const record = params.claim === true
    ? sessionTabInfo(tab, 'user', null, { ownerAgentId })
    : userTabInfo(tab, await tabGroupTitlesById([tab]));
  if (params.claim === true) {
    await loadSessionTabState();
    operatorSessionTabs.set(record.id, record);
    await groupTabsBestEffort([...operatorSessionTabs.keys()], operatorSessionName || DEFAULT_SESSION_GROUP_TITLE);
    await syncSessionGroupMetadataFromChrome();
    await saveSessionTabState();
  }
  return { ok: true, result: { tab: record } };
}

async function handleCdpCommand(method, params = {}) {
  if (!['operator.cdp.attach', 'operator.cdp.detach', 'operator.cdp.execute'].includes(method)) {
    return { ok: false, error: { code: 'UNKNOWN_METHOD', message: `Unknown method: ${method}` } };
  }
  if (!Number.isInteger(params.tabId) || params.tabId < 0) {
    return { ok: false, error: { code: 'INVALID_SCHEMA', message: 'tabId must be a non-negative integer.' } };
  }
  const tab = await chrome.tabs.get(params.tabId);
  if (method === 'operator.cdp.attach') {
    return attachCdpSession({
      chromeApi: chrome,
      tab
    });
  }
  if (method === 'operator.cdp.detach') {
    return detachCdpSession({
      chromeApi: chrome,
      tab
    });
  }
  return runCdpCommand({
    chromeApi: chrome,
    tab,
    method: params.method,
    params: params.params || {}
  });
}

async function tabForRuntimeCommand(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    return { ok: false, error: { code: 'INVALID_SCHEMA', message: 'tabId must be a non-negative integer.' } };
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.id) {
      return { ok: false, error: { code: 'NO_ACTIVE_TAB' } };
    }
    return { ok: true, tab: tabInfo(tab) };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'TAB_NOT_FOUND',
        message: error.message || String(error),
        tabId
      }
    };
  }
}

async function resolveRuntimeTabLocator(tabId, params = {}, { includeTargetContract = false } = {}) {
  if (typeof params.handle === 'string' && params.handle.trim()) {
    const target = await chrome.tabs.sendMessage(tabId, {
      type: 'content.resolveActionTarget',
      action: params.action || 'resolve',
      handle: params.handle.trim()
    });
    if (!target || !target.ok) {
      const fallbackTarget = targetForActionParams(params);
      if (
        fallbackTarget &&
        fallbackTarget.targetContract &&
        target &&
        target.error &&
        target.error.code === 'STALE_HANDLE'
      ) {
        return {
          ok: true,
          result: {
            action: 'resolved',
            target: fallbackTarget,
            staleHandle: target.error
          }
        };
      }
      return target || {
        ok: false,
        error: {
          code: 'LOCATOR_FAILED',
          message: 'Handle target resolution failed without a structured response.'
        }
      };
    }
    return target;
  }
  const locator = await chrome.tabs.sendMessage(tabId, {
    type: 'content.resolveLocator',
    selector: params.selector,
    text: params.text,
    includeFormValues: params.includeFormValues,
    maxFieldValueChars: params.maxFieldValueChars,
    includeTargetContract
  });
  if (!locator || !locator.ok) {
    return locator || {
      ok: false,
      error: {
        code: 'LOCATOR_FAILED',
        message: 'Locator failed without a structured response.'
      }
    };
  }
  return locator;
}

async function dispatchRuntimeTabLocatorAction(tab, action, params, locator) {
  const target = locator.result && locator.result.target;
  const requestedTarget = targetForActionParams({
    ...params,
    handle: target && target.handle,
    target
  });
  const runtimePreflight = await preflightDebuggerAction({ tab }, action, {
    handle: target && target.handle,
    target: requestedTarget,
    approval: params.approval,
    policy: params.policy
  });
  if (!runtimePreflight.ok) {
    return runtimePreflight;
  }
  const observedTarget = targetForActionParams({
    ...params,
    handle: target && target.handle,
    target: (runtimePreflight.result && runtimePreflight.result.target) || requestedTarget
  });
  const actionResponse = await runDebuggerAction({
    chromeApi: chrome,
    tab,
    action,
    params: {
      handle: target.handle,
      target: observedTarget,
      text: params.textValue,
      value: params.value !== undefined ? params.value : params.textValue,
      checked: params.checked,
      deltaX: params.deltaX,
      deltaY: params.deltaY,
      key: params.key,
      approval: params.approval,
      policy: params.policy
    }
  });
  const tracedResponse = await attachActionTraceCue(tab.id, actionResponse, {
    ...params,
    action,
    handle: target.handle,
    target: observedTarget,
    label: params.actionTraceLabel
  });
  return attachPostActionSnapshot(tab.id, tracedResponse, {
    ...params,
    action,
    handle: target.handle,
    target: observedTarget,
    text: params.textValue,
    value: params.value !== undefined ? params.value : params.textValue,
    preActionUrl: tab.url
  });
}

async function runRuntimeTabUploadFile(tab, params = {}) {
  const filePaths = Array.isArray(params.filePaths) ? params.filePaths : [];
  if (filePaths.length === 0) {
    return {
      ok: false,
      error: {
        code: 'INVALID_SCHEMA',
        message: 'Runtime tab upload requires validated file paths.'
      }
    };
  }

  const prepare = await chrome.tabs.sendMessage(tab.id, {
    type: 'content.prepareFileUpload',
    origin: params.origin,
    target: params.target,
    ruleset: params.ruleset,
    verifyPreview: params.verifyPreview,
    files: params.files
  });
  if (!prepare || !prepare.ok) {
    return prepare || {
      ok: false,
      error: {
        code: 'UPLOAD_TARGET_INVALID',
        message: 'Upload target preparation failed.'
      }
    };
  }

  const prepared = prepare.result || {};
  const cdpUpload = await runFileInputUpload({
    chromeApi: chrome,
    tab,
    selector: prepared.selector,
    files: filePaths
  });
  if (!cdpUpload.ok) {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'content.clearFileUploadMarker',
      uploadToken: prepared.uploadToken
    }).catch(() => null);
    return cdpUpload;
  }

  const completed = await chrome.tabs.sendMessage(tab.id, {
    type: 'content.completeFileUpload',
    origin: params.origin,
    target: params.target,
    ruleset: params.ruleset,
    verifyPreview: params.verifyPreview,
    files: params.files,
    uploadToken: prepared.uploadToken
  });
  if (!completed || !completed.ok) {
    return completed || {
      ok: false,
      error: {
        code: 'UPLOAD_VERIFICATION_FAILED',
        message: 'Upload verification failed after debugger file selection.'
      }
    };
  }
  return {
    ok: true,
    result: {
      ...(completed.result || {}),
      provider: 'chrome.debugger.DOM.setFileInputFiles',
      debuggerUpload: cdpUpload.result || null
    }
  };
}

async function handleRuntimeCommand(method, params = {}) {
  const readyTab = await tabForRuntimeCommand(params.tabId);
  if (!readyTab.ok) {
    return readyTab;
  }
  const tab = readyTab.tab;

  if (method === 'operator.runtime.tab.goto') {
    const targetTab = await chrome.tabs.update(tab.id, {
      url: params.url
    });
    const nextTab = tabInfo(targetTab);
    if (operatorSessionTabs.has(tab.id)) {
      const previous = operatorSessionTabs.get(tab.id);
      operatorSessionTabs.set(tab.id, {
        ...previous,
        ...nextTab,
        ownership: previous.ownership,
        finalizedStatus: previous.finalizedStatus || null,
        updatedAt: new Date().toISOString()
      });
      await saveSessionTabState();
    }
    return {
      ok: true,
      result: {
        action: 'navigate',
        requestedUrl: params.url,
        tab: nextTab
      }
    };
  }

  await ensureContentScript(tab.id);

  if (method === 'operator.runtime.tab.observe') {
    const observation = await observePage(tab.id, params);
    return { ok: true, result: observation };
  }

  if (method === 'operator.runtime.tab.readPage') {
    return chrome.tabs.sendMessage(tab.id, {
      type: 'content.readPage',
      filter: params.filter,
      depth: params.depth,
      maxChars: params.maxChars,
      refId: params.refId,
      includeFormValues: params.includeFormValues,
      maxFieldValueChars: params.maxFieldValueChars
    });
  }

  if (method === 'operator.runtime.tab.showTarget') {
    return chrome.tabs.sendMessage(tab.id, {
      type: 'content.showTarget',
      handle: params.handle,
      selector: params.selector,
      text: params.text,
      durationMs: params.durationMs
    });
  }

  if (method === 'operator.runtime.tab.indicator') {
    return chrome.tabs.sendMessage(tab.id, {
      type: 'content.operatorIndicator',
      active: params.active !== false,
      label: params.label,
      stopReason: params.stopReason
    });
  }

  if (method === 'operator.runtime.tab.locator') {
    const action = params.action || 'resolve';
    if (action === 'resolve') {
      return resolveRuntimeTabLocator(tab.id, params);
    }
    return runLocatorActionWithRetry({
      resolveLocator: () => resolveRuntimeTabLocator(tab.id, params, { includeTargetContract: true }),
      runAction: ({ locator }) => dispatchRuntimeTabLocatorAction(tab, action, params, locator)
    });
  }

  if (method === 'operator.runtime.tab.uploadFile') {
    return runRuntimeTabUploadFile(tab, params);
  }

  if (method === 'operator.runtime.tab.batch') {
    return chrome.tabs.sendMessage(tab.id, {
      type: 'content.batch',
      origin: params.origin,
      stopOnError: params.stopOnError,
      approval: params.approval,
      policy: params.policy,
      actions: params.actions
    });
  }

  return { ok: false, error: { code: 'UNKNOWN_METHOD', message: `Unknown method: ${method}` } };
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

function dispatchMethodForActionResult(result = {}) {
  if (result.provider === 'chrome.debugger.Input.dispatchMouseEvent') {
    return 'cdp.mouse';
  }
  if (result.provider === 'chrome.debugger.Input.insertText') {
    return 'cdp.keyboard';
  }
  if (result.provider === 'chrome.debugger.Runtime.evaluate') {
    return 'dom';
  }
  return 'dom';
}

function snapshotHasObservableChange(snapshot) {
  return Boolean(snapshot && snapshot.delta && snapshot.delta.unchanged === false);
}

function hashText(value) {
  const text = String(value || '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function textAppearsInElementSummary(element, text) {
  if (!element || !text) {
    return false;
  }
  const pieces = [
    element.label,
    element.accessibleName,
    element.value,
    element.targetContract && element.targetContract.label,
    element.targetContract && element.targetContract.accessibleName
  ];
  return pieces.some((piece) => String(piece || '').includes(text));
}

function articleTextAppearsInSnapshot(snapshot, text) {
  const expected = String(text || '').trim();
  if (!expected || !snapshot || !Array.isArray(snapshot.elements)) {
    return false;
  }
  return snapshot.elements.some((element) => {
    const tag = String(element && element.tag || '').toLowerCase();
    const role = String(element && element.role || '').toLowerCase();
    return (tag === 'article' || role === 'article') && textAppearsInElementSummary(element, expected);
  });
}

function verificationValueMatchesCondition(verification, condition) {
  if (!verification || !condition) {
    return false;
  }
  const expected = String(condition.value ?? '');
  const actual = verification.actual === undefined ? verification.expected : verification.actual;
  if (String(actual ?? '') === expected) {
    return true;
  }
  const actualLength = Number(verification.actualLength);
  const expectedLength = Number(verification.expectedLength);
  const actualHash = String(verification.actualHash || '');
  const expectedHash = String(verification.expectedHash || '');
  const conditionHash = hashText(expected);
  if (Number.isFinite(actualLength) && actualHash) {
    return actualLength === expected.length && actualHash === conditionHash;
  }
  if (Number.isFinite(expectedLength) && expectedHash) {
    return expectedLength === expected.length && expectedHash === conditionHash;
  }
  return false;
}

function verifyBackgroundExplicitConditions(params = {}, snapshot) {
  const conditions = params.verify && Array.isArray(params.verify.oneOf)
    ? params.verify.oneOf
    : [];
  if (conditions.length === 0) {
    return null;
  }
  const evidence = [];
  const observed = [];
  for (const condition of conditions) {
    if (!condition || typeof condition.type !== 'string') {
      continue;
    }
    if (condition.type === 'textAppears') {
      const text = String(condition.text || '').trim();
      if (text && String(snapshot && snapshot.visibleTextSummary || '').includes(text)) {
        evidence.push(`text appeared: ${text}`);
        observed.push(`text appeared: ${text}`);
      }
    } else if (condition.type === 'textAppearsInArticle') {
      const text = String(condition.text || '').trim();
      if (articleTextAppearsInSnapshot(snapshot, text)) {
        evidence.push(`article text appeared: ${text}`);
        observed.push(`article text appeared: ${text}`);
      }
    } else if (condition.type === 'elementGone') {
      const handle = condition.handle || params.handle;
      const present = (snapshot && Array.isArray(snapshot.elements) ? snapshot.elements : [])
        .some((element) => element.handle === handle);
      if (handle && !present) {
        evidence.push(`element gone: ${handle}`);
        observed.push(`element gone: ${handle}`);
      }
    } else if (condition.type === 'elementEnabled') {
      const handle = condition.handle || params.handle;
      const element = (snapshot && Array.isArray(snapshot.elements) ? snapshot.elements : [])
        .find((entry) => entry.handle === handle);
      if (element && element.disabled === false) {
        evidence.push(`element enabled: ${handle}`);
        observed.push(`element enabled: ${handle}`);
      }
    } else if (condition.type === 'valueEquals') {
      const handle = condition.handle || params.handle;
      const element = (snapshot && Array.isArray(snapshot.elements) ? snapshot.elements : [])
        .find((entry) => entry.handle === handle);
      if (element && String(element.value || '') === String(condition.value || '')) {
        evidence.push(`value matched: ${handle}`);
        observed.push(`value matched: ${handle}`);
      }
    }
  }
  if (evidence.length > 0) {
    return {
      status: 'succeeded',
      expected: conditions.map((condition) => condition.type),
      observed,
      evidence
    };
  }
  return {
    status: 'failed',
    expected: conditions.map((condition) => condition.type),
    observed: ['no explicit post-condition matched'],
    evidence: ['explicit post-condition did not match']
  };
}

function actionResponseRuntimeVerificationMatches(verification, params = {}) {
  if (!verification || typeof verification !== 'object' || typeof verification.type !== 'string') {
    return false;
  }
  const conditions = params.verify && Array.isArray(params.verify.oneOf)
    ? params.verify.oneOf
    : [];
  if (conditions.length === 0) {
    return true;
  }
  return conditions.some((condition) => {
    if (!condition || condition.type !== 'valueEquals') {
      return false;
    }
    return verificationValueMatchesCondition(verification, condition);
  });
}

function runtimeVerificationForActionResponse(actionResponse, params = {}) {
  const verification = actionResponse && actionResponse.result && actionResponse.result.verification;
  if (!actionResponse || actionResponse.ok !== true || !actionResponseRuntimeVerificationMatches(verification, params)) {
    return null;
  }
  const type = verification.type || 'action';
  return {
    status: 'succeeded',
    expected: [`runtime ${type}`],
    observed: [`runtime verified ${type}`],
    evidence: [`runtime verified ${type}`]
  };
}

function verifyBackgroundAction(actionResponse, snapshot, params = {}) {
  const explicit = verifyBackgroundExplicitConditions(params, snapshot);
  if (explicit && explicit.status === 'succeeded') {
    return explicit;
  }
  const runtimeVerified = runtimeVerificationForActionResponse(actionResponse, params);
  if (runtimeVerified) {
    return runtimeVerified;
  }
  if (explicit) {
    return explicit;
  }
  const navigationHref = navigationHrefForTarget(params.target, params.preActionUrl);
  if (params.action === 'click' && navigationHref) {
    return {
      status: 'succeeded',
      expected: ['navigation handoff'],
      observed: ['click target had a navigable href'],
      evidence: ['navigation target changed']
    };
  }
  if (snapshotHasObservableChange(snapshot)) {
    return {
      status: 'succeeded',
      expected: ['observable page state change'],
      observed: ['post-action snapshot changed'],
      evidence: ['post-action snapshot changed']
    };
  }
  return {
    status: 'inconclusive',
    expected: ['observable page state change'],
    observed: ['post-action snapshot unchanged'],
    evidence: ['action dispatched but no observable post-condition changed']
  };
}

function navigationHrefForTarget(target, baseUrl) {
  if (!target) {
    return null;
  }
  const href = String(target.href || '').trim();
  if (!href || href.startsWith('#') || /^javascript:/i.test(href)) {
    return null;
  }
  if (typeof URL !== 'function') {
    return /^https?:\/\//i.test(href) ? href : null;
  }
  try {
    const resolved = new URL(href, baseUrl || undefined);
    return ['http:', 'https:'].includes(resolved.protocol) ? resolved.href : null;
  } catch (_error) {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shouldRetryPostActionVerification(verification, params = {}) {
  return params.requireVerified === true &&
    params.action === 'click' &&
    verification &&
    verification.status === 'inconclusive';
}

function postActionVerifyDelayMs(params = {}) {
  const delay = Number(params.postActionVerifyDelayMs);
  if (!Number.isFinite(delay) || delay <= 0) {
    return 0;
  }
  return Math.min(10000, Math.floor(delay));
}

async function attachPostActionSnapshot(tabId, actionResponse, params = {}) {
  if (!actionResponse || actionResponse.ok !== true || params.postActionSnapshot !== 'delta') {
    return actionResponse;
  }
  try {
    const verifyDelayMs = postActionVerifyDelayMs(params);
    if (verifyDelayMs > 0) {
      await sleep(verifyDelayMs);
    }
    let snapshot = await chrome.tabs.sendMessage(tabId, {
      type: 'content.observe',
      mode: params.mode || 'tiny',
      ...observeOptions(params)
    });
    let verification = verifyBackgroundAction(actionResponse, snapshot, params);
    if (shouldRetryPostActionVerification(verification, params)) {
      await sleep(Number.isFinite(params.postActionRetryDelayMs) ? params.postActionRetryDelayMs : 1000);
      snapshot = await chrome.tabs.sendMessage(tabId, {
        type: 'content.observe',
        mode: params.mode || 'tiny',
        ...observeOptions(params)
      });
      verification = verifyBackgroundAction(actionResponse, snapshot, params);
    }
    if (params.requireVerified === true && verification.status !== 'succeeded') {
      return {
        ok: false,
        error: {
          code: 'ACTION_RESULT_UNVERIFIED',
          message: 'Action dispatch was not treated as success because the required post-action verification did not pass.',
          verification
        },
        result: {
          ...(actionResponse.result || {}),
          verification,
          postActionSnapshot: snapshot
        }
      };
    }
    return {
      ...actionResponse,
      result: {
        ...(actionResponse.result || {}),
        dispatch: {
          ok: true,
          method: dispatchMethodForActionResult(actionResponse.result || {}),
          provider: actionResponse.result && actionResponse.result.provider ? actionResponse.result.provider : null
        },
        verification,
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

async function attachActionTraceCue(tabId, actionResponse, params = {}) {
  if (!actionResponse || actionResponse.ok !== true || params.actionTrace !== true) {
    return actionResponse;
  }
  const actionResult = actionResponse.result || {};
  const resolvedTarget = actionResult.targetSnapshot && typeof actionResult.targetSnapshot === 'object'
    ? actionResult.targetSnapshot
    : {};
  const target = {
    ...(params.target || {}),
    ...resolvedTarget,
    bbox: resolvedTarget.bbox || (params.target && params.target.bbox)
  };
  if (!target.bbox) {
    return actionResponse;
  }
  const action = params.action || null;
  const point = Number.isFinite(Number(actionResult.x)) && Number.isFinite(Number(actionResult.y))
    ? { x: Number(actionResult.x), y: Number(actionResult.y) }
    : null;
  const label = typeof params.actionTraceLabel === 'string' && params.actionTraceLabel.trim()
    ? params.actionTraceLabel.trim().slice(0, 120)
    : `${action || 'action'} ${target.label || target.tag || 'target'}`.slice(0, 120);
  let cue = null;
  try {
    cue = await chrome.tabs.sendMessage(tabId, {
      type: 'content.actionTrace',
      action,
      label,
      bbox: target.bbox,
      durationMs: params.actionTraceDurationMs
    });
  } catch (error) {
    cue = {
      ok: false,
      error: {
        code: 'ACTION_TRACE_CUE_FAILED',
        message: error.message || String(error)
      }
    };
  }
  return {
    ...actionResponse,
    result: {
      ...(actionResponse.result || {}),
      actionTrace: {
        action,
        label,
        source: Object.keys(resolvedTarget).length > 0 ? 'resolved-target' : 'requested-target',
        target: {
          handle: params.handle || target.handle || null,
          tag: target.tag || null,
          label: target.label || null,
          bbox: target.bbox
        },
        actionability: actionResult.actionability || null,
        point,
        recovery: actionResult.recovery || null,
        cue
      }
    }
  };
}

async function approvedForWarmSession(origin) {
  const readiness = await requestNativeRpc('operator.verifyReadiness', { origin }, { timeoutMs: 2000 });
  return Boolean(readiness && readiness.ok === true && readiness.result && readiness.result.ready === true);
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
    if (!await approvedForWarmSession(origin)) {
      await postWarmSessionFailure(tab, 'domain-not-approved', {
        code: 'DOMAIN_NOT_APPROVED',
        message: 'Domain approval is required before active-tab warmup reads page content.'
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

async function requireActiveTabForOrigin(origin, options = {}) {
  const tab = await activeTabInfo();
  if (!tab || !tab.id || !tab.url) {
    return { ok: false, error: { code: 'NO_ACTIVE_TAB' } };
  }
  const expectedTabId = Number.isInteger(options.expectedTabId) ? options.expectedTabId : null;
  if (expectedTabId !== null && tab.id !== expectedTabId) {
    return {
      ok: false,
      error: {
        code: 'TAB_MISMATCH',
        message: 'Active tab changed before the queued page action could dispatch.',
        expectedTabId,
        activeTabId: tab.id,
        activeTab: tabInfo(tab)
      }
    };
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

function firstTargetValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return undefined;
}

function compactTarget(target) {
  return Object.fromEntries(
    Object.entries(target).filter(([, value]) => value !== undefined && value !== null)
  );
}

function targetForActionParams(params = {}) {
  const suppliedTarget = params.target && typeof params.target === 'object' && !Array.isArray(params.target)
    ? params.target
    : null;
  const targetContract = params.targetContract && typeof params.targetContract === 'object' && !Array.isArray(params.targetContract)
    ? params.targetContract
    : suppliedTarget &&
        suppliedTarget.targetContract &&
        typeof suppliedTarget.targetContract === 'object' &&
        !Array.isArray(suppliedTarget.targetContract)
      ? suppliedTarget.targetContract
      : null;

  if (!suppliedTarget && !targetContract) {
    return undefined;
  }

  const data = targetContract && targetContract.data && typeof targetContract.data === 'object' && !Array.isArray(targetContract.data)
    ? targetContract.data
    : {};
  return compactTarget({
    ...(suppliedTarget || {}),
    handle: firstTargetValue(suppliedTarget && suppliedTarget.handle, params.handle, targetContract && targetContract.handle),
    tag: firstTargetValue(suppliedTarget && suppliedTarget.tag, targetContract && targetContract.tag),
    role: firstTargetValue(suppliedTarget && suppliedTarget.role, targetContract && targetContract.role),
    type: firstTargetValue(suppliedTarget && suppliedTarget.type, targetContract && targetContract.type),
    id: firstTargetValue(suppliedTarget && suppliedTarget.id, targetContract && targetContract.id),
    name: firstTargetValue(suppliedTarget && suppliedTarget.name, targetContract && targetContract.name),
    href: firstTargetValue(suppliedTarget && suppliedTarget.href, targetContract && targetContract.href),
    placeholder: firstTargetValue(suppliedTarget && suppliedTarget.placeholder, targetContract && targetContract.placeholder),
    title: firstTargetValue(suppliedTarget && suppliedTarget.title, targetContract && targetContract.title),
    label: firstTargetValue(
      suppliedTarget && suppliedTarget.label,
      targetContract && targetContract.label,
      targetContract && targetContract.accessibleName
    ),
    accessibleName: firstTargetValue(
      suppliedTarget && suppliedTarget.accessibleName,
      targetContract && targetContract.accessibleName,
      targetContract && targetContract.label
    ),
    dataRisk: firstTargetValue(
      suppliedTarget && suppliedTarget.dataRisk,
      targetContract && targetContract.dataRisk,
      data.risk
    ),
    testid: firstTargetValue(
      suppliedTarget && suppliedTarget.testid,
      targetContract && targetContract.testid,
      data.testid,
      data.testId,
      data.testID,
      data.test
    ),
    productId: firstTargetValue(suppliedTarget && suppliedTarget.productId, targetContract && targetContract.productId),
    bbox: firstTargetValue(suppliedTarget && suppliedTarget.bbox, targetContract && targetContract.bbox),
    context: firstTargetValue(suppliedTarget && suppliedTarget.context, targetContract && targetContract.context),
    targetContract: targetContract || undefined
  });
}

function approvedHighRiskForRisk(params = {}, risk = null) {
  return Boolean(
    risk &&
    params.approval &&
    params.approval.allowHighRisk === true &&
    (params.approval.approvalKind === risk.approvalKind ||
      params.approval.approvalKind === 'policy-disabled')
  );
}

async function preflightDebuggerAction(ready, action, params) {
  const highRiskPolicyEnabled = !(params.policy && params.policy.highRiskEnabled === false);
  if (action === 'scroll' && !params.handle) {
    return { ok: true };
  }

  const requestedRisk = params.target
    ? globalThis.CodexActionPolicy.classifyActionRisk({
        action,
        target: params.target
      })
    : null;
  if (
    requestedRisk &&
    highRiskPolicyEnabled &&
    !approvedHighRiskForRisk(params, requestedRisk)
  ) {
    return { ok: false, error: requestedRisk };
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
      const risk = globalThis.CodexActionPolicy.classifyActionRisk({
        action,
        target: params.target
      });
      if (risk && highRiskPolicyEnabled && !approvedHighRiskForRisk(params, risk)) {
        return { ok: false, error: risk };
      }
      return { ok: true, result: { target: params.target, risk } };
    }
    return preflight || {
      ok: false,
      error: {
        code: 'ACTION_PREFLIGHT_FAILED',
        message: 'Action target preflight failed.'
      }
    };
  }

  const resolvedRisk = preflight.result && preflight.result.risk;
  const effectiveRisk = resolvedRisk || requestedRisk;
  if (effectiveRisk && highRiskPolicyEnabled && !approvedHighRiskForRisk(params, effectiveRisk)) {
    return { ok: false, error: effectiveRisk };
  }

  return {
    ok: true,
    result: effectiveRisk && preflight.result
      ? { ...preflight.result, risk: effectiveRisk }
      : preflight.result
  };
}

async function handleOperatorCommand(command) {
  const params = command.params || {};

  try {
    if (command.method && command.method.startsWith('operator.cdp.')) {
      return handleCdpCommand(command.method, params);
    }

    if (command.method && command.method.startsWith('operator.runtime.')) {
      return handleRuntimeCommand(command.method, params);
    }

    if (command.method && (command.method.startsWith('operator.tabs.') || command.method === 'operator.session.name')) {
      return handleSessionTabCommand(command.method, params);
    }

    if (command.method && command.method.startsWith('operator.context.')) {
      return handleBrowserContextCommand(command.method, params);
    }

    if (command.method && command.method.startsWith('operator.downloads.')) {
      return handleDownloadCommand(command.method, params);
    }

    if (command.method && command.method.startsWith('operator.sessions.')) {
      return handleSessionRecoveryCommand(command.method, params);
    }

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

    const ready = await requireActiveTabForOrigin(params.origin, {
      expectedTabId: params.expectedActiveTabId
    });
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

    if (command.method === 'page.mediaInspect') {
      return chrome.tabs.sendMessage(ready.tab.id, {
        type: 'content.mediaInspect',
        maxItems: params.maxItems
      });
    }

    if (command.method === 'page.formExtract') {
      return chrome.tabs.sendMessage(ready.tab.id, {
        type: 'content.formExtract',
        includeValues: params.includeValues
      });
    }

    if (command.method === 'page.formFillPlan') {
      return chrome.tabs.sendMessage(ready.tab.id, {
        type: 'content.formFillPlan',
        fields: params.fields
      });
    }

    if (command.method === 'page.formFillExecute') {
      return chrome.tabs.sendMessage(ready.tab.id, {
        type: 'content.formFillExecute',
        steps: params.steps,
        approval: params.approval,
        policy: params.policy
      });
    }

    if (command.method === 'page.visualInspectTarget') {
      const observation = await observePage(ready.tab.id, {
        ...params,
        mode: params.mode || 'medium'
      });
      const policyError = visualPolicyErrorForObservation(observation);
      if (policyError) {
        return { ok: false, error: policyError };
      }
      const target = (observation.elements || []).find((element) => element.handle === params.handle);
      if (!target) {
        return {
          ok: false,
          error: {
            code: 'TARGET_NOT_FOUND',
            message: 'Target handle was not found in the current visual observation.',
            handle: params.handle
          }
        };
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
            screenshotBacked: true,
            targetRegionBacked: true
          },
          visualTarget: {
            handle: params.handle,
            label: target.label || null,
            tag: target.tag || null,
            bbox: target.bbox || null
          },
          screenshot: {
            mimeType,
            dataUrl,
            bytesApprox: estimateDataUrlBytes(dataUrl)
          }
        }
      };
    }

    if (command.method === 'page.batch') {
      return chrome.tabs.sendMessage(ready.tab.id, {
        type: 'content.batch',
        origin: params.origin,
        stopOnError: params.stopOnError,
        approval: params.approval,
        policy: params.policy,
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

    const requestedTarget = targetForActionParams(params);
    const preflight = await preflightDebuggerAction(ready, action, {
      ...params,
      target: requestedTarget
    });
    if (!preflight.ok) {
      return preflight;
    }
    const observedTarget = targetForActionParams({
      ...params,
      target: (preflight.result && preflight.result.target) || requestedTarget
    });

    const actionResponse = await runDebuggerAction({
      chromeApi: chrome,
      tab: ready.tab,
      action,
      params: {
        handle: params.handle,
        target: observedTarget,
        text: params.text,
        value: params.value,
        checked: params.checked,
        deltaX: params.deltaX,
        deltaY: params.deltaY,
        key: params.key
      }
    });
    const tracedResponse = await attachActionTraceCue(ready.tab.id, actionResponse, {
      ...params,
      action,
      handle: params.handle,
      target: observedTarget
    });
    return attachPostActionSnapshot(ready.tab.id, tracedResponse, {
      ...params,
      action,
      preActionUrl: ready.tab.url,
      target: observedTarget
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
        lastOffscreenHeartbeat,
        activeTab: await activeTabInfo()
      });
      return;
    }

    if (message && message.type === 'operator.daemonStatus') {
      await connectNative();
      sendResponse(await requestNativeRpc('operator.status', {}, {
        timeoutMs: sidePanelNativeTimeout(message)
      }));
      return;
    }

    if (message && message.type === 'operator.approvals.list') {
      await connectNative();
      sendResponse(await requestNativeRpc('operator.approvals.list', {
        ...(message.status ? { status: message.status } : {})
      }, {
        timeoutMs: sidePanelNativeTimeout(message)
      }));
      return;
    }

    if (message && message.type === 'operator.policy.status') {
      await connectNative();
      sendResponse(await requestNativeRpc('operator.policy.status', {}, {
        timeoutMs: sidePanelNativeTimeout(message)
      }));
      return;
    }

    if (message && message.type === 'operator.audit.timeline') {
      await connectNative();
      sendResponse(await requestNativeRpc('operator.audit.timeline', {
        ...(Number.isFinite(Number(message.limit)) ? { limit: Number(message.limit) } : {})
      }, {
        timeoutMs: sidePanelNativeTimeout(message)
      }));
      return;
    }

    if (message && message.type === 'operator.policy.update') {
      await connectNative();
      sendResponse(await requestNativeRpc('operator.policy.update', {
        ...(typeof message.guardedActionsEnabled === 'boolean'
          ? { guardedActionsEnabled: message.guardedActionsEnabled }
          : {}),
        ...(typeof message.purchaseApprovalsEnabled === 'boolean'
          ? { purchaseApprovalsEnabled: message.purchaseApprovalsEnabled }
          : {})
      }, {
        timeoutMs: sidePanelNativeTimeout(message)
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

    if (message && message.type === 'operator.emergencyStop') {
      await connectNative();
      sendResponse(await requestNativeRpc('operator.emergencyStop', {
        reason: message.reason || 'Emergency stop requested from page indicator.',
        source: message.source || 'page-indicator'
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
      lastOffscreenHeartbeat = {
        keepaliveKind: message.keepaliveKind || null,
        heartbeatSequence: Number.isFinite(Number(message.heartbeatSequence))
          ? Number(message.heartbeatSequence)
          : null,
        sentAt: Number.isFinite(Number(message.sentAt)) ? Number(message.sentAt) : null,
        receivedAt: Date.now()
      };
      chrome.storage.local.set({ lastOffscreenHeartbeat }).catch(() => {});
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
  updateActionBadge();
  configureSidePanelBehavior();
  scheduleWarmSession().catch(() => {});
  wakeNativeBridge();
});

chrome.runtime.onStartup.addListener(() => {
  updateActionBadge();
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
chrome.tabs.onRemoved.addListener((tabId) => {
  if (!operatorSessionTabs.has(tabId)) {
    return;
  }
  operatorSessionTabs.delete(tabId);
  saveSessionTabState().catch(() => {});
});
