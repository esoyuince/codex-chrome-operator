'use strict';

const els = {
  summary: document.getElementById('summary'),
  badge: document.getElementById('status-badge'),
  connection: document.getElementById('connection'),
  nativeError: document.getElementById('native-error'),
  tabTitle: document.getElementById('active-tab-title'),
  tabOrigin: document.getElementById('active-tab-origin'),
  tabLoading: document.getElementById('active-tab-loading'),
  siteAccess: document.getElementById('site-access'),
  blockedSites: document.getElementById('blocked-sites'),
  blockedSitesDetail: document.getElementById('blocked-sites-detail'),
  saveBlockedSites: document.getElementById('save-blocked-sites'),
  nextStep: document.getElementById('next-step'),
  connect: document.getElementById('connect'),
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

function formatTabTitle(tab) {
  if (!tab) {
    return 'No active tab';
  }
  return tab.title || tab.url || 'Untitled tab';
}

async function readStorage() {
  try {
    return await chrome.storage.local.get([
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

async function readBlockedOriginsStatus(origin) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'operator.blockedOriginsStatus',
      origin
    });
    return {
      blockedOrigins: Array.isArray(response && response.blockedOrigins) ? response.blockedOrigins : [],
      blocked: Boolean(response && response.blocked),
      blockedPattern: response && response.blockedPattern ? response.blockedPattern : null
    };
  } catch (error) {
    return {
      blockedOrigins: [],
      blocked: false,
      blockedPattern: null,
      error: formatError(error)
    };
  }
}

function chooseNextStep({ connectionState, nativeError, statusError, tab, blockedStatus }) {
  if (nativeError || connectionState === 'ERROR') {
    return 'Native bridge error detected. Reinstall or restart the native host, then use Connect.';
  }
  if (connectionState !== 'CONNECTED') {
    return 'Native bridge is disconnected. Start the daemon or native host, then use Connect.';
  }
  if (statusError) {
    return 'Background status failed. Reload the extension, then refresh this panel.';
  }
  if (!tab || !tab.origin || tab.origin === 'null') {
    return 'Open the site you want Codex to operate, then refresh this panel.';
  }
  if (blockedStatus.blocked) {
    return 'Remove the active origin from blocked sites before asking Codex to observe or act.';
  }
  return 'Ready for Codex operator commands on this active origin.';
}

function setBadge(connectionState, blockedStatus, nativeError) {
  els.badge.className = 'badge';
  if (nativeError || connectionState === 'ERROR') {
    els.badge.classList.add('badge-error');
    els.badge.textContent = 'Needs repair';
    return;
  }
  if (connectionState === 'CONNECTED' && !blockedStatus.blocked) {
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
  els.saveBlockedSites.disabled = true;

  const storage = await readStorage();
  const status = await readStatus();
  const fallbackTab = status.ok ? null : await readActiveTabFallback();
  const tab = (status && status.activeTab) || fallbackTab;
  const connectionState = (status && status.connectionState) || storage.connectionState || 'UNKNOWN';
  const nativeError = (status && status.lastNativeError) || storage.lastNativeError || null;
  const statusError = status.statusError || null;
  const blockedStatus = await readBlockedOriginsStatus(tab && tab.origin);

  currentOrigin = tab && tab.origin && tab.origin !== 'null' ? tab.origin : null;

  setText(els.connection, connectionState);
  setText(els.nativeError, nativeError ? `Native error: ${nativeError}` : 'No native error reported.');

  setText(els.tabTitle, formatTabTitle(tab));
  setText(els.tabOrigin, tab && tab.origin ? tab.origin : 'none');
  setText(els.tabLoading, tab && tab.loadingState ? tab.loadingState : 'unknown');
  setText(
    els.siteAccess,
    blockedStatus.blocked ? `Blocked by ${blockedStatus.blockedPattern}` : 'Allowed'
  );
  els.blockedSites.value = blockedStatus.blockedOrigins.join('\n');
  setText(
    els.blockedSitesDetail,
    blockedStatus.error
      ? `Blocked-site settings unavailable: ${blockedStatus.error}`
      : blockedStatus.blockedOrigins.length === 0
        ? 'No blocked sites configured.'
        : `${blockedStatus.blockedOrigins.length} blocked site${blockedStatus.blockedOrigins.length === 1 ? '' : 's'} saved.`
  );

  els.nextStep.textContent = chooseNextStep({
    connectionState,
    nativeError,
    statusError,
    tab,
    blockedStatus
  });
  els.summary.textContent = status.statusError
    ? 'Background status failed; showing storage and tab fallback state.'
    : 'Live status from the extension background service worker.';

  setBadge(connectionState, blockedStatus, nativeError);
  els.connect.disabled = false;
  els.refresh.disabled = false;
  els.saveBlockedSites.disabled = false;
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

els.saveBlockedSites.addEventListener('click', async () => {
  els.saveBlockedSites.disabled = true;
  try {
    const blockedOrigins = els.blockedSites.value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const response = await chrome.runtime.sendMessage({
      type: 'operator.setBlockedOrigins',
      blockedOrigins
    });
    const count = Array.isArray(response && response.blockedOrigins) ? response.blockedOrigins.length : 0;
    els.nextStep.textContent = `Blocked-site settings saved (${count}).`;
  } catch (error) {
    els.nextStep.textContent = `Blocked-site save failed: ${formatError(error) || 'unknown error'}`;
  } finally {
    els.saveBlockedSites.disabled = false;
    await refresh();
  }
});

refresh().catch((error) => {
  setText(els.connection, 'UNKNOWN');
  setText(els.nativeError, `Side panel render failed: ${formatError(error) || 'unknown error'}`);
  els.summary.textContent = 'Side panel rendered in fallback mode.';
  els.nextStep.textContent = 'Reload the extension side panel. If this repeats, inspect the extension console.';
  els.badge.className = 'badge badge-error';
  els.badge.textContent = 'Popup error';
  els.connect.disabled = false;
  els.refresh.disabled = false;
  els.saveBlockedSites.disabled = false;
});
