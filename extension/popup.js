'use strict';

const els = {
  summary: document.getElementById('summary'),
  badge: document.getElementById('status-badge'),
  connection: document.getElementById('connection'),
  nativeError: document.getElementById('native-error'),
  profileState: document.getElementById('profile-state'),
  profileDetail: document.getElementById('profile-detail'),
  tabTitle: document.getElementById('active-tab-title'),
  tabOrigin: document.getElementById('active-tab-origin'),
  tabLoading: document.getElementById('active-tab-loading'),
  hostPermission: document.getElementById('host-permission'),
  nextStep: document.getElementById('next-step'),
  connect: document.getElementById('connect'),
  grantHost: document.getElementById('grant-host'),
  refresh: document.getElementById('refresh')
};

let currentOrigin = null;

function setText(element, value) {
  element.textContent = value || 'none';
}

function formatError(error) {
  if (!error) {
    return null;
  }
  if (typeof error === 'string') {
    return error;
  }
  return error.message || String(error);
}

function originPattern(origin) {
  const url = new URL(origin);
  return `${url.protocol}//${url.host}/*`;
}

function formatTabTitle(tab) {
  if (!tab) {
    return 'No active tab';
  }
  return tab.title || tab.url || 'Untitled tab';
}

async function readStorage() {
  try {
    return await chrome.storage.local.get([
      'profileBindingId',
      'profileBindingVersion',
      'connectionState',
      'lastNativeError'
    ]);
  } catch (error) {
    return { storageError: formatError(error) };
  }
}

async function readStatus() {
  try {
    return await chrome.runtime.sendMessage({ type: 'operator.status' });
  } catch (error) {
    return {
      ok: false,
      statusError: formatError(error)
    };
  }
}

async function readActiveTabFallback() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      return null;
    }
    let origin = null;
    try {
      origin = tab.url ? new URL(tab.url).origin : null;
    } catch {
      origin = null;
    }
    return {
      id: tab.id,
      title: tab.title || null,
      url: tab.url || null,
      origin,
      loadingState: tab.status === 'loading' ? 'loading' : 'complete'
    };
  } catch {
    return null;
  }
}

async function hasHostPermission(origin) {
  if (!origin || origin === 'null') {
    return { available: false, granted: false, reason: 'No web origin' };
  }
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'operator.hasHostPermission',
      origin
    });
    return {
      available: true,
      granted: Boolean(response && response.granted)
    };
  } catch (messageError) {
    try {
      return {
        available: true,
        granted: await chrome.permissions.contains({ origins: [originPattern(origin)] })
      };
    } catch (permissionError) {
      return {
        available: false,
        granted: false,
        reason: formatError(permissionError) || formatError(messageError)
      };
    }
  }
}

function profileFromStorage(storage) {
  if (storage.profileBindingId && storage.profileBindingVersion) {
    return {
      state: 'bound',
      id: storage.profileBindingId,
      version: storage.profileBindingVersion
    };
  }
  return { state: 'missing' };
}

function chooseNextStep({ connectionState, nativeError, statusError, profile, tab, permission }) {
  if (nativeError || connectionState === 'ERROR') {
    return 'Native bridge error detected. Reinstall or restart the native host, then use Connect.';
  }
  if (connectionState !== 'CONNECTED') {
    return 'Native bridge is disconnected. Start the daemon or native host, then use Connect.';
  }
  if (statusError) {
    return 'Background status failed. Reload the extension, then refresh this panel.';
  }
  if (profile.state !== 'bound') {
    return 'This Chrome profile is not bound. Open the daemon setup link and bind this profile.';
  }
  if (!tab || !tab.origin || tab.origin === 'null') {
    return 'Open the site you want Codex to operate, then refresh this panel.';
  }
  if (!permission.granted) {
    return 'Grant host access for the active origin before asking Codex to observe or act.';
  }
  return 'Ready for Codex operator commands on this active origin.';
}

function setBadge(connectionState, profile, permission, nativeError) {
  els.badge.className = 'badge';
  if (nativeError || connectionState === 'ERROR') {
    els.badge.classList.add('badge-error');
    els.badge.textContent = 'Needs repair';
    return;
  }
  if (connectionState === 'CONNECTED' && profile.state === 'bound' && permission.granted) {
    els.badge.classList.add('badge-ok');
    els.badge.textContent = 'Ready';
    return;
  }
  els.badge.classList.add('badge-warn');
  els.badge.textContent = 'Action needed';
}

async function refresh() {
  els.summary.textContent = 'Checking Chrome operator status...';
  els.connect.disabled = true;
  els.refresh.disabled = true;
  els.grantHost.hidden = true;

  const storage = await readStorage();
  const status = await readStatus();
  const fallbackTab = status.ok ? null : await readActiveTabFallback();
  const tab = (status && status.activeTab) || fallbackTab;
  const profile = profileFromStorage(storage);
  const connectionState = (status && status.connectionState) || storage.connectionState || 'UNKNOWN';
  const nativeError = (status && status.lastNativeError) || storage.lastNativeError || null;
  const statusError = status.statusError || null;
  const permission = await hasHostPermission(tab && tab.origin);

  currentOrigin = tab && tab.origin && tab.origin !== 'null' ? tab.origin : null;

  setText(els.connection, connectionState);
  setText(els.nativeError, nativeError ? `Native error: ${nativeError}` : 'No native error reported.');

  setText(els.profileState, profile.state === 'bound' ? 'Bound' : 'Missing');
  setText(
    els.profileDetail,
    profile.state === 'bound'
      ? `id: ${profile.id} / version: ${profile.version}`
      : storage.storageError
        ? `Storage read failed: ${storage.storageError}`
        : 'No profileBindingId/profileBindingVersion in chrome.storage.local.'
  );

  setText(els.tabTitle, formatTabTitle(tab));
  setText(els.tabOrigin, tab && tab.origin ? tab.origin : 'none');
  setText(els.tabLoading, tab && tab.loadingState ? tab.loadingState : 'unknown');
  setText(
    els.hostPermission,
    permission.available ? (permission.granted ? 'Granted' : 'Missing') : (permission.reason || 'Not available')
  );

  els.nextStep.textContent = chooseNextStep({
    connectionState,
    nativeError,
    statusError,
    profile,
    tab,
    permission
  });
  els.summary.textContent = status.statusError
    ? 'Background status failed; showing storage and tab fallback state.'
    : 'Live status from the extension background service worker.';

  setBadge(connectionState, profile, permission, nativeError);
  els.grantHost.hidden = !currentOrigin || permission.granted;
  els.connect.disabled = false;
  els.refresh.disabled = false;
}

els.connect.addEventListener('click', async () => {
  els.connect.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: 'operator.connectNative' });
  } catch (error) {
    els.nextStep.textContent = `Connect failed: ${formatError(error) || 'unknown error'}`;
  }
  await refresh();
});

els.refresh.addEventListener('click', refresh);

els.grantHost.addEventListener('click', async () => {
  if (!currentOrigin) {
    return;
  }
  els.grantHost.disabled = true;
  try {
    const granted = await chrome.permissions.request({ origins: [originPattern(currentOrigin)] });
    if (granted) {
      await chrome.runtime.sendMessage({
        type: 'operator.hostPermissionGranted',
        origin: currentOrigin
      });
    }
    els.nextStep.textContent = granted ? 'Host access granted.' : 'Host access was not granted.';
  } catch (error) {
    els.nextStep.textContent = `Host access request failed: ${formatError(error) || 'unknown error'}`;
  } finally {
    els.grantHost.disabled = false;
    await refresh();
  }
});

refresh().catch((error) => {
  setText(els.connection, 'UNKNOWN');
  setText(els.nativeError, `Popup render failed: ${formatError(error) || 'unknown error'}`);
  els.summary.textContent = 'Popup rendered in fallback mode.';
  els.nextStep.textContent = 'Reload the extension popup. If this repeats, inspect the extension console.';
  els.badge.className = 'badge badge-error';
  els.badge.textContent = 'Popup error';
  els.connect.disabled = false;
  els.refresh.disabled = false;
});
