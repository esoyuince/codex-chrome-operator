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
  permissionSafe: document.getElementById('permission-safe'),
  permissionAction: document.getElementById('permission-action'),
  permissionCritical: document.getElementById('permission-critical'),
  guardedActionsToggle: document.getElementById('guarded-actions-toggle'),
  purchaseApprovalsToggle: document.getElementById('purchase-approvals-toggle'),
  sessionTabsCount: document.getElementById('session-tabs-count'),
  lastCommand: document.getElementById('last-command'),
  downloadWatchStatus: document.getElementById('download-watch-status'),
  pendingApprovals: document.getElementById('pending-approvals'),
  blockedSites: document.getElementById('blocked-sites'),
  blockedSitesDetail: document.getElementById('blocked-sites-detail'),
  saveBlockedSites: document.getElementById('save-blocked-sites'),
  nextStep: document.getElementById('next-step'),
  connect: document.getElementById('connect'),
  refresh: document.getElementById('refresh')
};

let currentOrigin = null;
let transientNextStep = null;
const APPROVAL_MESSAGE_TYPES = {
  approve: 'operator.approvals.approve',
  reject: 'operator.approvals.reject',
  run: 'operator.approvals.run'
};

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

function isConnectedState(connectionState) {
  return connectionState === 'CONNECTED' || connectionState === 'EXTENSION_CONNECTED';
}

function setTransientNextStep(message) {
  transientNextStep = message || null;
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

async function readDaemonStatus() {
  try {
    return await chrome.runtime.sendMessage({ type: 'operator.daemonStatus' });
  } catch (error) {
    return {
      ok: false,
      statusError: formatError(error)
    };
  }
}

async function readApprovals() {
  try {
    return await chrome.runtime.sendMessage({ type: 'operator.approvals.list' });
  } catch (error) {
    return {
      ok: false,
      statusError: formatError(error)
    };
  }
}

async function readPolicyStatus() {
  try {
    return await chrome.runtime.sendMessage({ type: 'operator.policy.status' });
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

function chooseNextStep({
  connectionState,
  nativeError,
  statusError,
  policyError,
  tab,
  blockedStatus,
  approvals
}) {
  if (nativeError || connectionState === 'ERROR') {
    return 'Native bridge error detected. Reinstall or restart the native host, then use Connect.';
  }
  if (!isConnectedState(connectionState)) {
    return 'Native bridge is disconnected. Start the daemon or native host, then use Connect.';
  }
  if (statusError) {
    return 'Background status failed. Reload the extension, then refresh this panel.';
  }
  if (policyError) {
    return `Policy controls unavailable: ${policyError}`;
  }
  if (!tab || !tab.origin || tab.origin === 'null') {
    return 'Open the site you want Codex to operate, then refresh this panel.';
  }
  if (blockedStatus.blocked) {
    return 'Remove the active origin from blocked sites before asking Codex to observe or act.';
  }
  const pendingCount = approvals.filter((approval) => approval.status === 'pending').length;
  if (pendingCount > 0) {
    return `${pendingCount} risky approval${pendingCount === 1 ? '' : 's'} waiting for a user decision.`;
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
  if (isConnectedState(connectionState) && !blockedStatus.blocked) {
    els.badge.classList.add('badge-ok');
    els.badge.textContent = 'Ready';
    return;
  }
  els.badge.classList.add('badge-warn');
  els.badge.textContent = 'Action needed';
}

function setMiniBadge(element, state, text) {
  element.className = `mini-badge ${state}`;
  element.textContent = text;
}

function renderPermissions({ connectionState, tab, blockedStatus, policy, policyError }) {
  const connected = isConnectedState(connectionState);
  const ready = connected && tab && tab.origin && tab.origin !== 'null' && !blockedStatus.blocked;
  const policyReady = connected && !policyError;
  const guardedOn = policy.guardedActionsEnabled !== false;
  const purchaseOn = policy.purchaseApprovalsEnabled === true;
  setMiniBadge(els.permissionSafe, ready ? 'ok' : 'warn', ready ? 'Ready' : 'Blocked');
  setMiniBadge(els.permissionAction, policyReady && guardedOn ? 'warn' : 'disabled', policyReady && guardedOn ? 'Guarded' : 'Off');
  setMiniBadge(els.permissionCritical, policyReady && purchaseOn ? 'danger' : 'disabled', policyReady && purchaseOn ? 'Approval' : 'Off');
  els.guardedActionsToggle.checked = guardedOn;
  els.purchaseApprovalsToggle.checked = purchaseOn;
  els.guardedActionsToggle.disabled = !policyReady;
  els.purchaseApprovalsToggle.disabled = !policyReady;
}

function approvalTitle(approval) {
  const kind = approval.approvalKind || 'high-risk-action';
  if (['checkout', 'payment', 'order-placement', 'purchase'].includes(kind)) {
    return 'Purchase approval';
  }
  return `${kind} approval`;
}

function renderApproval(approval) {
  const article = document.createElement('article');
  article.className = `approval-card approval-${approval.status || 'unknown'}`;
  const title = document.createElement('div');
  title.className = 'approval-title';
  title.textContent = approvalTitle(approval);

  const meta = document.createElement('div');
  meta.className = 'detail';
  meta.textContent = [
    approval.origin || 'unknown origin',
    approval.targetSummary || null,
    approval.status ? `status: ${approval.status}` : null
  ].filter(Boolean).join(' | ');

  const actions = document.createElement('div');
  actions.className = 'approval-actions';
  if (approval.status === 'pending') {
    actions.append(
      approvalButton(approval.approvalId, 'approve', 'Approve once'),
      approvalButton(approval.approvalId, 'reject', 'Reject')
    );
  } else if (approval.status === 'approved') {
    actions.append(approvalButton(approval.approvalId, 'run', 'Run approved'));
  }

  article.append(title, meta, actions);
  return article;
}

function approvalButton(approvalId, action, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.dataset.approvalId = approvalId;
  button.dataset.approvalAction = action;
  if (action !== 'approve') {
    button.className = 'secondary';
  }
  return button;
}

function renderApprovals(approvals, error) {
  els.pendingApprovals.innerHTML = '';
  if (error) {
    const detail = document.createElement('div');
    detail.className = 'detail';
    detail.textContent = `Approval status unavailable: ${error}`;
    els.pendingApprovals.append(detail);
    return;
  }

  const visibleApprovals = approvals.filter((approval) => (
    ['pending', 'approved'].includes(approval.status)
  ));
  if (visibleApprovals.length === 0) {
    els.pendingApprovals.textContent = 'No pending approvals.';
    return;
  }

  for (const approval of visibleApprovals) {
    els.pendingApprovals.append(renderApproval(approval));
  }
}

async function refresh() {
  els.summary.textContent = 'Checking Chrome operator status...';
  els.connect.disabled = true;
  els.refresh.disabled = true;
  els.saveBlockedSites.disabled = true;

  const storage = await readStorage();
  const status = await readStatus();
  const daemonStatus = await readDaemonStatus();
  const approvalsStatus = await readApprovals();
  const policyStatus = await readPolicyStatus();
  const fallbackTab = status.ok ? null : await readActiveTabFallback();
  const daemonResult = daemonStatus && daemonStatus.ok ? daemonStatus.result : null;
  const tab = (status && status.activeTab) || (daemonResult && daemonResult.activeTab) || fallbackTab;
  const connectionState = (daemonResult && daemonResult.connectionState) ||
    (status && status.connectionState) ||
    storage.connectionState ||
    'UNKNOWN';
  const nativeError = (daemonResult && daemonResult.lastError) ||
    (status && status.lastNativeError) ||
    storage.lastNativeError ||
    null;
  const statusError = status.statusError || daemonStatus.statusError || null;
  const approvals = approvalsStatus && approvalsStatus.ok && approvalsStatus.result
    ? approvalsStatus.result.approvals || []
    : daemonResult && Array.isArray(daemonResult.pendingApprovals)
      ? daemonResult.pendingApprovals
      : [];
  const policy = policyStatus && policyStatus.ok && policyStatus.result && policyStatus.result.policy
    ? policyStatus.result.policy
    : daemonResult && daemonResult.policy
      ? daemonResult.policy
      : { guardedActionsEnabled: true, purchaseApprovalsEnabled: false };
  const policyError = policyStatus && !policyStatus.ok
    ? formatError(policyStatus.error) || policyStatus.statusError || 'unknown policy error'
    : policyStatus.statusError || null;
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
  renderPermissions({ connectionState, tab, blockedStatus, policy, policyError });
  setText(els.sessionTabsCount, daemonResult && Array.isArray(daemonResult.sessionTabs)
    ? String(daemonResult.sessionTabs.length)
    : '0');
  const recentEvent = daemonResult && Array.isArray(daemonResult.recentEvents) && daemonResult.recentEvents.length
    ? daemonResult.recentEvents[daemonResult.recentEvents.length - 1]
    : null;
  setText(els.lastCommand, recentEvent && recentEvent.method ? recentEvent.method : 'none');
  setText(els.downloadWatchStatus, 'Available via codex_chrome_download_wait');
  renderApprovals(approvals, approvalsStatus.statusError || null);
  els.blockedSites.value = blockedStatus.blockedOrigins.join('\n');
  setText(
    els.blockedSitesDetail,
    blockedStatus.error
      ? `Blocked-site settings unavailable: ${blockedStatus.error}`
      : blockedStatus.blockedOrigins.length === 0
        ? 'No blocked sites configured.'
        : `${blockedStatus.blockedOrigins.length} blocked site${blockedStatus.blockedOrigins.length === 1 ? '' : 's'} saved.`
  );

  els.nextStep.textContent = transientNextStep || chooseNextStep({
    connectionState,
    nativeError,
    statusError,
    policyError,
    tab,
    blockedStatus,
    approvals
  });
  transientNextStep = null;
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

async function updatePolicyToggle(update) {
  els.guardedActionsToggle.disabled = true;
  els.purchaseApprovalsToggle.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'operator.policy.update',
      ...update
    });
    if (!response || !response.ok) {
      setTransientNextStep(`Policy update failed: ${formatError(response && response.error) || 'unknown error'}`);
    } else {
      setTransientNextStep('Policy updated.');
    }
  } catch (error) {
    setTransientNextStep(`Policy update failed: ${formatError(error) || 'unknown error'}`);
  } finally {
    await refresh();
  }
}

els.guardedActionsToggle.addEventListener('change', () => {
  updatePolicyToggle({ guardedActionsEnabled: els.guardedActionsToggle.checked });
});

els.purchaseApprovalsToggle.addEventListener('change', () => {
  updatePolicyToggle({ purchaseApprovalsEnabled: els.purchaseApprovalsToggle.checked });
});

els.pendingApprovals.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-approval-action]');
  if (!button) {
    return;
  }
  if (button.disabled) {
    return;
  }
  const { approvalId, approvalAction } = button.dataset;
  const messageType = APPROVAL_MESSAGE_TYPES[approvalAction];
  if (!messageType) {
    return;
  }
  button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: messageType,
      approvalId
    });
    if (!response || !response.ok) {
      els.nextStep.textContent = `Approval ${approvalAction} failed: ${formatError(response && response.error) || 'unknown error'}`;
    } else {
      els.nextStep.textContent = `Approval ${approvalAction} completed.`;
    }
  } catch (error) {
    els.nextStep.textContent = `Approval ${approvalAction} failed: ${formatError(error) || 'unknown error'}`;
  } finally {
    await refresh();
  }
});

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
