const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SessionManager } = require('../operator-daemon/sessionManager');
const { ERROR_CODES } = require('../operator-daemon/protocol');

function makeSession() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-operator-session-tabs-'));
  const session = new SessionManager({
    auditLogPath: path.join(dir, 'audit.jsonl'),
    statePath: path.join(dir, 'state.json'),
    expectedExtensionId: 'abcdefghijklmnopabcdefghijklmnop'
  });
  session.connectionState = 'EXTENSION_CONNECTED';
  session.connectionId = 'conn_test';
  return session;
}

function saveTargetContract(handle = 'el_current_state_0') {
  return {
    version: 1,
    handle,
    tag: 'button',
    role: 'button',
    label: 'Save settings',
    accessibleName: 'Save settings',
    testid: 'save-button',
    data: { testid: 'save-button' },
    bbox: { x: 10, y: 20, width: 120, height: 32 },
    context: {
      url: 'https://example.com/account',
      viewport: { width: 1280, height: 720 },
      scroll: { x: 0, y: 0 },
      devicePixelRatio: 1
    },
    provenance: {
      shadowDepth: 1,
      frameDepth: 1,
      frameTitle: 'Checkout frame'
    }
  };
}

test('session tabs claim user tab from latest inventory and expose compact status', async () => {
  const session = makeSession();
  const calls = [];
  session.enqueueExtensionCommand = async (method, params) => {
    calls.push({ method, params });
    if (method === 'operator.tabs.listUser') {
      return {
        ok: true,
        result: {
          tabs: [
            { id: 7, title: 'Docs', url: 'https://example.com/docs', lastOpened: '2026-05-08T10:00:00.000Z' }
          ]
        }
      };
    }
    if (method === 'operator.tabs.claim') {
      return {
        ok: true,
        result: {
          tab: { id: 7, title: 'Docs', url: 'https://example.com/docs', ownership: 'user', active: true }
        }
      };
    }
    throw new Error(`Unexpected method ${method}`);
  };

  const listed = await session.handleRpc({
    id: 'list-user',
    method: 'operator.tabs.listUser',
    params: {}
  });
  assert.equal(listed.ok, true);
  assert.equal(listed.result.tabs[0].id, 7);

  const claimed = await session.handleRpc({
    id: 'claim',
    method: 'operator.tabs.claim',
    params: { tabId: 7 }
  });

  assert.equal(claimed.ok, true);
  assert.equal(claimed.result.tab.ownership, 'user');
  assert.deepEqual(calls.map((call) => call.method), ['operator.tabs.listUser', 'operator.tabs.claim']);

  const status = session.status({ detail: 'compact' });
  assert.equal(status.sessionTabs.length, 1);
  assert.equal(status.sessionTabs[0].id, 7);
  assert.equal(status.sessionTabs[0].ownership, 'user');
});

test('browser context tools expose enriched tabs, history, bookmarks, downloads, and session recovery', async () => {
  const session = makeSession();
  const calls = [];
  session.enqueueExtensionCommand = async (method, params) => {
    calls.push({ method, params });
    if (method === 'operator.context.recentTabs') {
      return {
        ok: true,
        result: {
          tabs: [{
            id: 7,
            windowId: 2,
            title: 'Play Console',
            url: 'https://play.google.com/console',
            favIconUrl: 'https://play.google.com/favicon.ico',
            lastAccessed: '2026-05-08T10:00:00.000Z',
            tabGroup: 'Codex Operator',
            claimable: true
          }]
        }
      };
    }
    if (method === 'operator.context.historySearch') {
      return { ok: true, result: { entries: [{ url: 'https://example.com', title: 'Example' }] } };
    }
    if (method === 'operator.context.bookmarkSearch') {
      return { ok: true, result: { entries: [{ id: 'b1', url: 'https://example.com', title: 'Example' }] } };
    }
    if (method === 'operator.downloads.wait') {
      return {
        ok: true,
        result: {
          download: {
            id: 4,
            state: 'complete',
            basename: 'report.csv',
            path: 'C:/Users/example/Downloads/report.csv',
            exists: true,
            fileSize: 42
          }
        }
      };
    }
    if (method === 'operator.sessions.reopenClosedTab') {
      return {
        ok: true,
        result: {
          tab: { id: 9, title: 'Restored', url: 'https://example.com', ownership: 'user', active: true }
        }
      };
    }
    throw new Error(`Unexpected method ${method}`);
  };

  const recent = await session.handleRpc({ id: 'recent', method: 'operator.context.recentTabs', params: { limit: 5 } });
  assert.equal(recent.ok, true);
  assert.equal(recent.result.tabs[0].favIconUrl, 'https://play.google.com/favicon.ico');
  assert.equal(recent.result.tabs[0].claimable, true);

  const history = await session.handleRpc({ id: 'history', method: 'operator.context.historySearch', params: { query: 'example', maxResults: 3 } });
  assert.equal(history.ok, true);
  const bookmarks = await session.handleRpc({ id: 'bookmarks', method: 'operator.context.bookmarkSearch', params: { query: 'example', maxResults: 3 } });
  assert.equal(bookmarks.ok, true);
  const download = await session.handleRpc({ id: 'download', method: 'operator.downloads.wait', params: { filenameContains: 'report', timeoutMs: 10 } });
  assert.equal(download.ok, true);
  assert.equal(download.result.download.basename, 'report.csv');
  const reopened = await session.handleRpc({ id: 'reopen', method: 'operator.sessions.reopenClosedTab', params: { claim: true } });
  assert.equal(reopened.ok, true);
  assert.equal(session.status({ detail: 'compact' }).sessionTabs[0].id, 9);

  assert.deepEqual(calls.map((call) => call.method), [
    'operator.context.recentTabs',
    'operator.context.historySearch',
    'operator.context.bookmarkSearch',
    'operator.downloads.wait',
    'operator.sessions.reopenClosedTab'
  ]);
});

test('runtime show target requires a session tab and routes a compact visual cue command', async () => {
  const session = makeSession();
  session.sessionTabs.set(7, {
    id: 7,
    title: 'Example',
    url: 'https://example.com/app',
    ownership: 'agent',
    active: true,
    finalizedStatus: null,
    updatedAt: new Date().toISOString()
  });
  await session.handleRpc({
    id: 'approve-example',
    method: 'operator.approveDomain',
    params: { origin: 'https://example.com' }
  });
  const calls = [];
  session.enqueueExtensionCommand = async (method, params) => {
    calls.push({ method, params });
    return {
      ok: true,
      result: {
        highlighted: true,
        target: { handle: 'el_state_0', label: 'Save', bbox: { x: 10, y: 20, width: 80, height: 30 } }
      }
    };
  };

  const response = await session.handleRpc({
    id: 'show-target',
    method: 'operator.runtime.tab.showTarget',
    params: {
      tabId: 7,
      selector: 'button.save',
      durationMs: 1200
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.highlighted, true);
  assert.deepEqual(calls, [{
    method: 'operator.runtime.tab.showTarget',
    params: {
      tabId: 7,
      selector: 'button.save',
      durationMs: 1200
    }
  }]);
});

test('runtime operator indicator routes through session-owned tabs', async () => {
  const session = makeSession();
  session.sessionTabs.set(7, {
    id: 7,
    title: 'Example',
    url: 'https://example.com/app',
    ownership: 'agent',
    active: true,
    finalizedStatus: null,
    updatedAt: new Date().toISOString()
  });
  await session.handleRpc({
    id: 'approve-example',
    method: 'operator.approveDomain',
    params: { origin: 'https://example.com' }
  });
  const calls = [];
  session.enqueueExtensionCommand = async (method, params) => {
    calls.push({ method, params });
    return {
      ok: true,
      result: {
        visible: params.active,
        label: params.label
      }
    };
  };

  const response = await session.handleRpc({
    id: 'indicator',
    method: 'operator.runtime.tab.indicator',
    params: {
      tabId: 7,
      active: true,
      label: 'Codex is active in this tab'
    }
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.visible, true);
  assert.deepEqual(calls, [{
    method: 'operator.runtime.tab.indicator',
    params: {
      tabId: 7,
      active: true,
      label: 'Codex is active in this tab'
    }
  }]);
});

test('policy toggles allow ordinary actions while gating purchase approvals', async () => {
  const session = makeSession();
  await session.handleRpc({
    id: 'approve-local',
    method: 'operator.approveDomain',
    params: { origin: 'http://127.0.0.1:18888' }
  });

  const calls = [];
  session.enqueueExtensionCommand = async (method, params) => {
    calls.push({ method, params });
    if (method === 'page.observe') {
      return { ok: true, result: { title: 'Fixture', elements: [] } };
    }
    if (method === 'page.navigate') {
      return { ok: true, result: { action: 'navigate', url: params.url } };
    }
    return {
      ok: false,
      error: {
        code: ERROR_CODES.HIGH_RISK_BLOCKED,
        approvalKind: 'payment',
        targetSummary: 'button: Pay'
      }
    };
  };

  const disabled = await session.handleRpc({
    id: 'guarded-off',
    method: 'operator.policy.update',
    params: { guardedActionsEnabled: false, bridgeInstanceId: 'bridge_sidepanel' }
  });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.result.policy.guardedActionsEnabled, false);

  const navigation = await session.handleRpc({
    id: 'guarded-off-navigation',
    method: 'page.navigate',
    params: { url: 'http://127.0.0.1:18888/path' }
  });
  assert.equal(navigation.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'page.navigate');

  const observe = await session.handleRpc({
    id: 'observe',
    method: 'page.observe',
    params: { origin: 'http://127.0.0.1:18888' }
  });
  assert.equal(observe.ok, true);
  assert.deepEqual(calls.map((call) => call.method), ['page.navigate', 'page.observe']);

  await session.handleRpc({
    id: 'purchase-off',
    method: 'operator.policy.update',
    params: { purchaseApprovalsEnabled: false }
  });
  const purchaseBlocked = await session.handleRpc({
    id: 'purchase-blocked',
    method: 'page.click',
    params: { origin: 'http://127.0.0.1:18888', handle: 'pay_button' }
  });
  assert.equal(purchaseBlocked.ok, false);
  assert.equal(purchaseBlocked.error.code, ERROR_CODES.HIGH_RISK_BLOCKED);
  assert.equal(purchaseBlocked.error.approvalStatus, 'disabled');
  assert.equal(purchaseBlocked.error.approvalId, undefined);

  await session.handleRpc({
    id: 'purchase-on',
    method: 'operator.policy.update',
    params: { purchaseApprovalsEnabled: true }
  });
  const approvalPrompt = await session.handleRpc({
    id: 'purchase-approval',
    method: 'page.click',
    params: { origin: 'http://127.0.0.1:18888', handle: 'pay_button' }
  });
  assert.equal(approvalPrompt.ok, false);
  assert.equal(approvalPrompt.error.code, ERROR_CODES.HIGH_RISK_BLOCKED);
  assert.match(approvalPrompt.error.approvalId, /^approval_/);
  assert.equal(session.status({ detail: 'compact' }).policy.guardedActionsEnabled, false);
  assert.equal(session.status({ detail: 'compact' }).policy.purchaseApprovalsEnabled, true);
});

test('active-tab page.click rejects when a same-origin claimed tab is no longer active', async () => {
  const session = makeSession();
  session.sessionTabs.set(7, {
    id: 7,
    title: 'Account settings A',
    url: 'https://example.com/account',
    ownership: 'agent',
    active: false,
    finalizedStatus: null,
    updatedAt: new Date().toISOString()
  });
  session.updateActiveTab({
    id: 8,
    title: 'Account settings B',
    url: 'https://example.com/account',
    status: 'complete'
  });
  await session.handleRpc({
    id: 'approve-example',
    method: 'operator.approveDomain',
    params: { origin: 'https://example.com' }
  });

  const calls = [];
  session.enqueueExtensionCommand = async (method, params) => {
    calls.push({ method, params });
    return { ok: true, result: { action: 'clicked' } };
  };

  const clicked = await session.handleRpc({
    id: 'same-origin-click-race',
    method: 'page.click',
    params: {
      origin: 'https://example.com',
      handle: 'el_tab_a_state_0'
    }
  });

  assert.equal(clicked.ok, false);
  assert.equal(clicked.error.code, 'TAB_MISMATCH');
  assert.equal(clicked.error.expectedTabId, 7);
  assert.equal(clicked.error.activeTabId, 8);
  assert.deepEqual(calls, []);
});

test('active-tab page.batch rejects mutating same-origin races before queuing', async () => {
  const session = makeSession();
  session.sessionTabs.set(7, {
    id: 7,
    title: 'Checkout A',
    url: 'https://example.com/checkout',
    ownership: 'agent',
    active: false,
    finalizedStatus: null,
    updatedAt: new Date().toISOString()
  });
  session.updateActiveTab({
    id: 8,
    title: 'Checkout B',
    url: 'https://example.com/checkout',
    status: 'complete'
  });
  await session.handleRpc({
    id: 'approve-example',
    method: 'operator.approveDomain',
    params: { origin: 'https://example.com' }
  });

  const calls = [];
  session.enqueueExtensionCommand = async (method, params) => {
    calls.push({ method, params });
    return { ok: true, result: { results: [{ ok: true, result: { action: 'clicked' } }] } };
  };

  const batched = await session.handleRpc({
    id: 'same-origin-batch-race',
    method: 'page.batch',
    params: {
      origin: 'https://example.com',
      actions: [{
        action: 'click',
        handle: 'el_tab_a_state_0'
      }]
    }
  });

  assert.equal(batched.ok, false);
  assert.equal(batched.error.code, 'TAB_MISMATCH');
  assert.equal(batched.error.expectedTabId, 7);
  assert.equal(batched.error.activeTabId, 8);
  assert.deepEqual(calls, []);
});

test('active-tab page.readPage rejects when a same-origin claimed tab is no longer active', async () => {
  const session = makeSession();
  session.sessionTabs.set(7, {
    id: 7,
    title: 'Inbox A',
    url: 'https://example.com/inbox',
    ownership: 'agent',
    active: false,
    finalizedStatus: null,
    updatedAt: new Date().toISOString()
  });
  session.updateActiveTab({
    id: 8,
    title: 'Inbox B',
    url: 'https://example.com/inbox',
    status: 'complete'
  });
  await session.handleRpc({
    id: 'approve-example',
    method: 'operator.approveDomain',
    params: { origin: 'https://example.com' }
  });

  const calls = [];
  session.enqueueExtensionCommand = async (method, params) => {
    calls.push({ method, params });
    return { ok: true, result: { pageContent: 'wrong active tab text' } };
  };

  const readPage = await session.handleRpc({
    id: 'same-origin-read-race',
    method: 'page.readPage',
    params: {
      origin: 'https://example.com',
      filter: 'interactive'
    }
  });

  assert.equal(readPage.ok, false);
  assert.equal(readPage.error.code, 'TAB_MISMATCH');
  assert.equal(readPage.error.expectedTabId, 7);
  assert.equal(readPage.error.activeTabId, 8);
  assert.deepEqual(calls, []);
});

test('active-tab page.observe rejects when a same-origin claimed tab is no longer active', async () => {
  const session = makeSession();
  session.sessionTabs.set(7, {
    id: 7,
    title: 'Dashboard A',
    url: 'https://example.com/dashboard',
    ownership: 'agent',
    active: false,
    finalizedStatus: null,
    updatedAt: new Date().toISOString()
  });
  session.updateActiveTab({
    id: 8,
    title: 'Dashboard B',
    url: 'https://example.com/dashboard',
    status: 'complete'
  });
  await session.handleRpc({
    id: 'approve-example',
    method: 'operator.approveDomain',
    params: { origin: 'https://example.com' }
  });

  const calls = [];
  session.enqueueExtensionCommand = async (method, params) => {
    calls.push({ method, params });
    return { ok: true, result: { title: 'Wrong active dashboard', elements: [] } };
  };

  const observed = await session.handleRpc({
    id: 'same-origin-observe-race',
    method: 'page.observe',
    params: {
      origin: 'https://example.com',
      mode: 'tiny'
    }
  });

  assert.equal(observed.ok, false);
  assert.equal(observed.error.code, 'TAB_MISMATCH');
  assert.equal(observed.error.expectedTabId, 7);
  assert.equal(observed.error.activeTabId, 8);
  assert.deepEqual(calls, []);
});

test('active-tab page.click carries an active tab lock for extension-side race checks', async () => {
  const session = makeSession();
  session.updateActiveTab({
    id: 7,
    title: 'Account settings',
    url: 'https://example.com/account',
    status: 'complete'
  });
  await session.handleRpc({
    id: 'approve-example',
    method: 'operator.approveDomain',
    params: { origin: 'https://example.com' }
  });

  const calls = [];
  session.enqueueExtensionCommand = async (method, params) => {
    calls.push({ method, params });
    return { ok: true, result: { action: 'clicked' } };
  };

  const clicked = await session.handleRpc({
    id: 'same-origin-click-locked',
    method: 'page.click',
    params: {
      origin: 'https://example.com',
      handle: 'el_current_state_0',
      targetContract: saveTargetContract()
    }
  });

  assert.equal(clicked.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.expectedActiveTabId, 7);
  assert.deepEqual(calls[0].params.targetContract, saveTargetContract());
});

test('active-tab page.click carries relaxed policy when guarded actions are disabled', async () => {
  const session = makeSession();
  session.updateActiveTab({
    id: 7,
    title: 'Publish',
    url: 'https://example.com/publish',
    status: 'complete'
  });
  await session.handleRpc({
    id: 'approve-example',
    method: 'operator.approveDomain',
    params: { origin: 'https://example.com' }
  });
  await session.handleRpc({
    id: 'guarded-off',
    method: 'operator.policy.update',
    params: { guardedActionsEnabled: false }
  });

  const calls = [];
  session.enqueueExtensionCommand = async (method, params) => {
    calls.push({ method, params });
    return { ok: true, result: { action: 'clicked' } };
  };

  const clicked = await session.handleRpc({
    id: 'active-click-policy-disabled',
    method: 'page.click',
    params: {
      origin: 'https://example.com',
      handle: 'el_publish'
    }
  });

  assert.equal(clicked.ok, true);
  assert.deepEqual(calls[0].params.approval, {
    allowHighRisk: true,
    allowSensitiveFormFill: true,
    approvalKind: 'policy-disabled'
  });
  assert.deepEqual(calls[0].params.policy, {
    highRiskEnabled: false,
    sensitiveFormFillEnabled: false
  });
});

test('active-tab page.batch carries relaxed policy when guarded actions are disabled', async () => {
  const session = makeSession();
  session.updateActiveTab({
    id: 7,
    title: 'Publish',
    url: 'https://example.com/publish',
    status: 'complete'
  });
  await session.handleRpc({
    id: 'approve-example',
    method: 'operator.approveDomain',
    params: { origin: 'https://example.com' }
  });
  await session.handleRpc({
    id: 'guarded-off',
    method: 'operator.policy.update',
    params: { guardedActionsEnabled: false }
  });

  const calls = [];
  session.enqueueExtensionCommand = async (method, params) => {
    calls.push({ method, params });
    return {
      ok: true,
      result: {
        results: [{ ok: true, result: { action: 'clicked' } }],
        stoppedOnError: false
      }
    };
  };

  const batched = await session.handleRpc({
    id: 'active-batch-policy-disabled',
    method: 'page.batch',
    params: {
      origin: 'https://example.com',
      actions: [{
        action: 'click',
        handle: 'el_publish',
        targetContract: saveTargetContract('el_publish')
      }]
    }
  });

  assert.equal(batched.ok, true);
  assert.deepEqual(calls[0].params.actions[0].targetContract, saveTargetContract('el_publish'));
  assert.deepEqual(calls[0].params.approval, {
    allowHighRisk: true,
    allowSensitiveFormFill: true,
    approvalKind: 'policy-disabled'
  });
  assert.deepEqual(calls[0].params.policy, {
    highRiskEnabled: false,
    sensitiveFormFillEnabled: false
  });
});

test('active-tab page.click rejects malformed target contracts before queuing', async () => {
  const session = makeSession();
  session.updateActiveTab({
    id: 7,
    title: 'Settings',
    url: 'https://example.com/account',
    status: 'complete'
  });
  await session.handleRpc({
    id: 'approve-example',
    method: 'operator.approveDomain',
    params: { origin: 'https://example.com' }
  });
  let queued = false;
  session.enqueueExtensionCommand = async () => {
    queued = true;
    return { ok: true, result: {} };
  };

  const clicked = await session.handleRpc({
    id: 'invalid-target-contract',
    method: 'page.click',
    params: {
      origin: 'https://example.com',
      handle: 'el_save',
      targetContract: {
        version: 1,
        tag: 'button',
        unsupported: true
      }
    }
  });

  assert.equal(clicked.ok, false);
  assert.equal(clicked.error.code, ERROR_CODES.INVALID_SCHEMA);
  assert.equal(clicked.error.field, 'targetContract.unsupported');
  assert.equal(queued, false);
});

test('active-tab page.click rejects unknown verify condition type before queuing', async () => {
  const session = makeSession();
  let queued = false;
  session.enqueueExtensionCommand = async () => {
    queued = true;
    return { ok: true, result: {} };
  };

  const clicked = await session.handleRpc({
    id: 'invalid-verify-type',
    method: 'page.click',
    params: {
      origin: 'https://example.com',
      handle: 'el_publish',
      postActionSnapshot: 'delta',
      verify: {
        oneOf: [{ type: 'unknownVerifyType', text: 'Saved' }]
      }
    }
  });

  assert.equal(clicked.ok, false);
  assert.equal(clicked.error.code, ERROR_CODES.INVALID_SCHEMA);
  assert.equal(queued, false);
});

test('page.batch rejects unknown child verify condition type', () => {
  const session = makeSession();

  const batch = session.validateBatchCommandParams({
    actions: [{
      action: 'click',
      handle: 'el_publish',
      postActionSnapshot: 'delta',
      verify: {
        oneOf: [{ type: 'unknownVerifyType', text: 'Saved' }]
      }
    }]
  }, 'https://example.com');

  assert.equal(batch.ok, false);
  assert.equal(batch.error.code, ERROR_CODES.INVALID_SCHEMA);
  assert.equal(batch.error.actionIndex, 0);
  assert.equal(batch.error.field, 'verify');
});

test('page.batch rejects malformed child target contracts', () => {
  const session = makeSession();

  const batch = session.validateBatchCommandParams({
    actions: [{
      action: 'click',
      handle: 'el_publish',
      targetContract: {
        version: 1,
        tag: 'button',
        unsupported: true
      }
    }]
  }, 'https://example.com');

  assert.equal(batch.ok, false);
  assert.equal(batch.error.code, ERROR_CODES.INVALID_SCHEMA);
  assert.equal(batch.error.actionIndex, 0);
  assert.equal(batch.error.field, 'targetContract.unsupported');
});

test('download and window tab management commands route through extension bridge', async () => {
  const session = makeSession();
  const calls = [];
  session.enqueueExtensionCommand = async (method, params) => {
    calls.push({ method, params });
    if (method === 'operator.downloads.show') {
      return { ok: true, result: { shown: true, downloadId: params.downloadId } };
    }
    if (method === 'operator.tabs.focus') {
      return { ok: true, result: { tab: { id: params.tabId, title: 'Focused', url: 'https://example.com', ownership: 'user', active: true } } };
    }
    if (method === 'operator.tabs.pin') {
      return { ok: true, result: { tab: { id: params.tabId, title: 'Pinned', url: 'https://example.com', pinned: params.pinned } } };
    }
    if (method === 'operator.tabs.move') {
      return { ok: true, result: { tab: { id: params.tabId, index: params.index, windowId: params.windowId || 1 } } };
    }
    if (method === 'operator.tabs.groupRename') {
      return { ok: true, result: { groupId: params.groupId, title: params.title } };
    }
    throw new Error(`Unexpected method ${method}`);
  };

  const shown = await session.handleRpc({ id: 'show-download', method: 'operator.downloads.show', params: { downloadId: 4 } });
  assert.equal(shown.ok, true);
  assert.equal(shown.result.shown, true);
  const focused = await session.handleRpc({ id: 'focus-tab', method: 'operator.tabs.focus', params: { tabId: 7 } });
  assert.equal(focused.ok, true);
  const pinned = await session.handleRpc({ id: 'pin-tab', method: 'operator.tabs.pin', params: { tabId: 7, pinned: true } });
  assert.equal(pinned.ok, true);
  const moved = await session.handleRpc({ id: 'move-tab', method: 'operator.tabs.move', params: { tabId: 7, index: 1, windowId: 2 } });
  assert.equal(moved.ok, true);
  const renamed = await session.handleRpc({ id: 'rename-group', method: 'operator.tabs.groupRename', params: { groupId: 3, title: 'Work' } });
  assert.equal(renamed.ok, true);

  assert.deepEqual(calls, [
    { method: 'operator.downloads.show', params: { downloadId: 4 } },
    { method: 'operator.tabs.focus', params: { tabId: 7 } },
    { method: 'operator.tabs.pin', params: { tabId: 7, pinned: true } },
    { method: 'operator.tabs.move', params: { tabId: 7, index: 1, windowId: 2 } },
    { method: 'operator.tabs.groupRename', params: { groupId: 3, title: 'Work' } }
  ]);
});

test('session tabs reject guessed claims outside current inventory', async () => {
  const session = makeSession();
  session.enqueueExtensionCommand = async (method) => {
    if (method === 'operator.tabs.listUser') {
      return { ok: true, result: { tabs: [{ id: 3, title: 'Allowed', url: 'https://example.com' }] } };
    }
    throw new Error(`Unexpected method ${method}`);
  };

  await session.handleRpc({
    id: 'list-user',
    method: 'operator.tabs.listUser',
    params: {}
  });

  const guessed = await session.handleRpc({
    id: 'claim-guessed',
    method: 'operator.tabs.claim',
    params: { tabId: 99 }
  });

  assert.equal(guessed.ok, false);
  assert.equal(guessed.error.code, ERROR_CODES.INVALID_SCHEMA);
  assert.match(guessed.error.message, /latest user tab inventory/);
});

test('session tabs create, list, name, and finalize with validated keep states', async () => {
  const session = makeSession();
  session.enqueueExtensionCommand = async (method, params) => {
    if (method === 'operator.tabs.create') {
      return {
        ok: true,
        result: {
          tab: { id: 11, title: 'New tab', url: 'about:blank', ownership: 'agent', active: true }
        }
      };
    }
    if (method === 'operator.tabs.listSession') {
      return {
        ok: true,
        result: {
          tabs: [{ id: 11, title: 'New tab', url: 'about:blank', ownership: 'agent', active: true }]
        }
      };
    }
    if (method === 'operator.session.name') {
      return { ok: true, result: { name: params.name } };
    }
    if (method === 'operator.tabs.finalize') {
      return {
        ok: true,
        result: {
          kept: [{ tabId: 11, status: 'deliverable' }],
          closed: [],
          released: []
        }
      };
    }
    throw new Error(`Unexpected method ${method}`);
  };

  const created = await session.handleRpc({
    id: 'create',
    method: 'operator.tabs.create',
    params: {}
  });
  assert.equal(created.ok, true);
  assert.equal(created.result.tab.ownership, 'agent');

  const named = await session.handleRpc({
    id: 'name',
    method: 'operator.session.name',
    params: { name: 'Firebase cleanup' }
  });
  assert.equal(named.ok, true);
  assert.equal(session.status({ detail: 'compact' }).sessionName, 'Firebase cleanup');

  const listed = await session.handleRpc({
    id: 'list-session',
    method: 'operator.tabs.listSession',
    params: {}
  });
  assert.equal(listed.ok, true);
  assert.equal(listed.result.tabs[0].id, 11);

  const invalidFinalize = await session.handleRpc({
    id: 'finalize-bad',
    method: 'operator.tabs.finalize',
    params: { keep: [{ tabId: 11, status: 'pin' }] }
  });
  assert.equal(invalidFinalize.ok, false);
  assert.equal(invalidFinalize.error.code, ERROR_CODES.INVALID_SCHEMA);

  const finalized = await session.handleRpc({
    id: 'finalize',
    method: 'operator.tabs.finalize',
    params: { keep: [{ tabId: 11, status: 'deliverable' }] }
  });
  assert.equal(finalized.ok, true);
  assert.deepEqual(finalized.result.kept, [{ tabId: 11, status: 'deliverable' }]);
  assert.equal(session.status({ detail: 'compact' }).sessionTabs[0].finalizedStatus, 'deliverable');
});

test('agent-scoped tab leases reject cross-agent runtime access and scoped finalize does not release other agents', async () => {
  const session = makeSession();
  session.sessionTabs.set(7, {
    id: 7,
    title: 'Alpha',
    url: 'https://example.com/alpha',
    ownership: 'agent',
    ownerAgentId: 'agent-alpha',
    leaseId: 'lease_alpha',
    active: true,
    finalizedStatus: null,
    updatedAt: new Date().toISOString()
  });
  session.sessionTabs.set(8, {
    id: 8,
    title: 'Beta',
    url: 'https://example.com/beta',
    ownership: 'agent',
    ownerAgentId: 'agent-beta',
    leaseId: 'lease_beta',
    active: false,
    finalizedStatus: null,
    updatedAt: new Date().toISOString()
  });
  session.sessionTabs.set(9, {
    id: 9,
    title: 'Unowned',
    url: 'https://example.com/unowned',
    ownership: 'agent',
    ownerAgentId: null,
    finalizedStatus: null,
    updatedAt: new Date().toISOString()
  });
  await session.handleRpc({
    id: 'approve-example',
    method: 'operator.approveDomain',
    params: { origin: 'https://example.com' }
  });

  const calls = [];
  session.enqueueExtensionCommand = async (method, params) => {
    calls.push({ method, params });
    if (method === 'operator.tabs.finalize') {
      return {
        ok: true,
        result: {
          kept: params.keep,
          released: [],
          closed: [9]
        }
      };
    }
    return {
      ok: true,
      result: { pageContent: 'wrong agent read should not queue' }
    };
  };

  const betaReadAlpha = await session.handleRpc({
    id: 'beta-read-alpha',
    method: 'operator.runtime.tab.readPage',
    params: { agentId: 'agent-beta', tabId: 7, filter: 'interactive' }
  });
  assert.equal(betaReadAlpha.ok, false);
  assert.equal(betaReadAlpha.error.code, ERROR_CODES.TAB_MISMATCH);
  assert.equal(betaReadAlpha.error.reason, 'agent-lease-mismatch');
  assert.deepEqual(calls, []);

  const alphaKeepBeta = await session.handleRpc({
    id: 'alpha-keep-beta',
    method: 'operator.tabs.finalize',
    params: {
      agentId: 'agent-alpha',
      keep: [{ tabId: 8, status: 'deliverable' }]
    }
  });
  assert.equal(alphaKeepBeta.ok, false);
  assert.equal(alphaKeepBeta.error.code, ERROR_CODES.TAB_MISMATCH);
  assert.equal(alphaKeepBeta.error.reason, 'agent-lease-mismatch');
  assert.deepEqual(calls, []);

  const alphaFinalize = await session.handleRpc({
    id: 'alpha-finalize',
    method: 'operator.tabs.finalize',
    params: {
      agentId: 'agent-alpha',
      keep: [{ tabId: 7, status: 'deliverable' }]
    }
  });
  assert.equal(alphaFinalize.ok, true);
  assert.deepEqual(calls, [{
    method: 'operator.tabs.finalize',
    params: {
      agentId: 'agent-alpha',
      keep: [{ tabId: 7, status: 'deliverable' }]
    }
  }]);
  assert.deepEqual(session.listSessionTabRecords().map((tab) => ({
    id: tab.id,
    ownerAgentId: tab.ownerAgentId,
    finalizedStatus: tab.finalizedStatus
  })), [{
    id: 7,
    ownerAgentId: 'agent-alpha',
    finalizedStatus: 'deliverable'
  }, {
    id: 8,
    ownerAgentId: 'agent-beta',
    finalizedStatus: null
  }, {
    id: 9,
    ownerAgentId: null,
    finalizedStatus: null
  }]);
});

test('agent-scoped listSession pruning does not remove tabs leased to other agents', async () => {
  const session = makeSession();
  for (const tab of [{
    id: 7,
    title: 'Alpha',
    url: 'https://example.com/alpha',
    ownership: 'agent',
    ownerAgentId: 'agent-alpha',
    finalizedStatus: null
  }, {
    id: 8,
    title: 'Beta',
    url: 'https://example.com/beta',
    ownership: 'agent',
    ownerAgentId: 'agent-beta',
    finalizedStatus: null
  }, {
    id: 9,
    title: 'Unowned',
    url: 'https://example.com/unowned',
    ownership: 'agent',
    ownerAgentId: null,
    finalizedStatus: null
  }]) {
    session.sessionTabs.set(tab.id, tab);
  }
  session.enqueueExtensionCommand = async (method, params) => {
    assert.equal(method, 'operator.tabs.listSession');
    assert.deepEqual(params, { agentId: 'agent-alpha' });
    return {
      ok: true,
      result: {
        tabs: [{
          id: 7,
          title: 'Alpha',
          url: 'https://example.com/alpha',
          ownership: 'agent',
          ownerAgentId: 'agent-alpha'
        }]
      }
    };
  };

  const listed = await session.handleRpc({
    id: 'list-session-alpha',
    method: 'operator.tabs.listSession',
    params: { agentId: 'agent-alpha' }
  });

  assert.equal(listed.ok, true);
  assert.deepEqual(listed.result.tabs.map((tab) => tab.id), [7]);
  assert.deepEqual(session.listSessionTabRecords().map((tab) => ({
    id: tab.id,
    ownerAgentId: tab.ownerAgentId
  })), [{
    id: 7,
    ownerAgentId: 'agent-alpha'
  }, {
    id: 8,
    ownerAgentId: 'agent-beta'
  }]);
});

test('finalize removes closed and released tabs from daemon session state', async () => {
  const session = makeSession();
  session.sessionTabs.set(11, {
    id: 11,
    title: 'Kept',
    url: 'https://example.com/kept',
    ownership: 'agent',
    finalizedStatus: null
  });
  session.sessionTabs.set(12, {
    id: 12,
    title: 'Closed',
    url: 'https://example.com/closed',
    ownership: 'agent',
    finalizedStatus: null
  });
  session.sessionTabs.set(13, {
    id: 13,
    title: 'Released',
    url: 'https://example.com/released',
    ownership: 'user',
    finalizedStatus: null
  });
  session.enqueueExtensionCommand = async (method) => {
    assert.equal(method, 'operator.tabs.finalize');
    return {
      ok: true,
      result: {
        kept: [{ tabId: 11, status: 'deliverable' }],
        closed: [12],
        released: [13]
      }
    };
  };

  const finalized = await session.handleRpc({
    id: 'finalize',
    method: 'operator.tabs.finalize',
    params: { keep: [{ tabId: 11, status: 'deliverable' }] }
  });

  assert.equal(finalized.ok, true);
  assert.deepEqual(
    session.status({ detail: 'compact' }).sessionTabs.map((tab) => ({
      id: tab.id,
      finalizedStatus: tab.finalizedStatus
    })),
    [{ id: 11, finalizedStatus: 'deliverable' }]
  );
});

test('finalize keeps close-failed tabs in daemon session state', async () => {
  const session = makeSession();
  session.sessionTabs.set(11, {
    id: 11,
    title: 'Kept',
    url: 'https://example.com/kept',
    ownership: 'agent',
    finalizedStatus: null
  });
  session.sessionTabs.set(12, {
    id: 12,
    title: 'Close failed',
    url: 'https://example.com/close-failed',
    ownership: 'agent',
    finalizedStatus: null
  });
  session.enqueueExtensionCommand = async (method) => {
    assert.equal(method, 'operator.tabs.finalize');
    return {
      ok: true,
      result: {
        kept: [{ tabId: 11, status: 'deliverable' }],
        closed: [],
        released: [],
        closeFailed: [{ tabId: 12, message: 'Cannot close tab' }]
      }
    };
  };

  const finalized = await session.handleRpc({
    id: 'finalize',
    method: 'operator.tabs.finalize',
    params: { keep: [{ tabId: 11, status: 'deliverable' }] }
  });

  assert.equal(finalized.ok, true);
  assert.deepEqual(finalized.result.closeFailed, [{ tabId: 12, message: 'Cannot close tab' }]);
  assert.deepEqual(
    session.status({ detail: 'compact' }).sessionTabs.map((tab) => ({
      id: tab.id,
      finalizedStatus: tab.finalizedStatus
    })),
    [
      { id: 11, finalizedStatus: 'deliverable' },
      { id: 12, finalizedStatus: null }
    ]
  );
});

test('listSession prunes daemon session tabs missing from extension inventory', async () => {
  const session = makeSession();
  session.sessionTabs.set(11, {
    id: 11,
    title: 'Kept',
    url: 'https://example.com/kept',
    ownership: 'agent',
    finalizedStatus: null
  });
  session.sessionTabs.set(12, {
    id: 12,
    title: 'Gone',
    url: 'https://example.com/gone',
    ownership: 'agent',
    finalizedStatus: null
  });
  session.enqueueExtensionCommand = async (method) => {
    assert.equal(method, 'operator.tabs.listSession');
    return {
      ok: true,
      result: {
        tabs: [{
          id: 11,
          title: 'Kept',
          url: 'https://example.com/kept',
          ownership: 'agent'
        }]
      }
    };
  };

  const listed = await session.handleRpc({
    id: 'list-session',
    method: 'operator.tabs.listSession',
    params: {}
  });

  assert.equal(listed.ok, true);
  assert.deepEqual(
    session.status({ detail: 'compact' }).sessionTabs.map((tab) => tab.id),
    [11]
  );
});

test('finalize removes non-kept daemon session tabs even when extension omits them', async () => {
  const session = makeSession();
  session.sessionTabs.set(11, {
    id: 11,
    title: 'Kept',
    url: 'https://example.com/kept',
    ownership: 'agent',
    finalizedStatus: null
  });
  session.sessionTabs.set(12, {
    id: 12,
    title: 'Gone',
    url: 'https://example.com/gone',
    ownership: 'agent',
    finalizedStatus: null
  });
  session.enqueueExtensionCommand = async (method) => {
    assert.equal(method, 'operator.tabs.finalize');
    return {
      ok: true,
      result: {
        kept: [],
        closed: [],
        released: []
      }
    };
  };

  const finalized = await session.handleRpc({
    id: 'finalize',
    method: 'operator.tabs.finalize',
    params: { keep: [{ tabId: 11, status: 'handoff' }] }
  });

  assert.equal(finalized.ok, true);
  assert.deepEqual(
    session.status({ detail: 'compact' }).sessionTabs.map((tab) => ({
      id: tab.id,
      finalizedStatus: tab.finalizedStatus
    })),
    [{ id: 11, finalizedStatus: 'handoff' }]
  );
});

test('guarded CDP commands require session-owned tabs and origin readiness', async () => {
  const session = makeSession();
  const calls = [];
  session.enqueueExtensionCommand = async (method, params) => {
    calls.push({ method, params });
    return {
      ok: true,
      result: {
        provider: `chrome.debugger.${params.method}`,
        response: { ok: true }
      }
    };
  };

  const unknownTab = await session.handleRpc({
    id: 'cdp-unknown-tab',
    method: 'operator.cdp.execute',
    params: {
      tabId: 42,
      method: 'Target.getTargets',
      params: {}
    }
  });
  assert.equal(unknownTab.ok, false);
  assert.equal(unknownTab.error.code, 'INVALID_SCHEMA');
  assert.deepEqual(calls, []);

  session.sessionTabs.set(7, {
    id: 7,
    title: 'Example',
    url: 'https://example.com/app',
    ownership: 'agent',
    active: true,
    finalizedStatus: null,
    updatedAt: new Date().toISOString()
  });

  const disallowed = await session.handleRpc({
    id: 'cdp-disallowed',
    method: 'operator.cdp.execute',
    params: {
      tabId: 7,
      method: 'Runtime.evaluate',
      params: { expression: 'document.cookie' }
    }
  });
  assert.equal(disallowed.ok, false);
  assert.equal(disallowed.error.code, 'CDP_METHOD_NOT_ALLOWED');
  assert.deepEqual(calls, []);
  const auditEntry = session.audit.tail({ limit: 1 })[0];
  assert.equal(auditEntry.params.method, 'Runtime.evaluate');
  assert.deepEqual(auditEntry.params.paramKeys, ['expression']);
  assert.doesNotMatch(JSON.stringify(auditEntry), /document\.cookie/);

  for (const [cdpMethod, cdpParams] of [
    ['Page.captureScreenshot', { format: 'png', unexpected: true }],
    ['Page.getLayoutMetrics', { unexpected: true }],
    ['Target.getTargets', { unexpected: true }],
    ['Page.handleJavaScriptDialog', { accept: true, unexpected: true }]
  ]) {
    const rejectedParams = await session.handleRpc({
      id: `cdp-unknown-param-${cdpMethod}`,
      method: 'operator.cdp.execute',
      params: {
        tabId: 7,
        method: cdpMethod,
        params: cdpParams
      }
    });
    assert.equal(rejectedParams.ok, false);
    assert.equal(rejectedParams.error.code, ERROR_CODES.INVALID_SCHEMA);
    assert.equal(rejectedParams.error.field, 'params.unexpected');
  }
  assert.deepEqual(calls, []);

  const blocked = await session.handleRpc({
    id: 'cdp-readiness',
    method: 'operator.cdp.execute',
    params: {
      tabId: 7,
      method: 'Page.getLayoutMetrics',
      params: {}
    }
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'DOMAIN_NOT_APPROVED');

  const metadata = await session.handleRpc({
    id: 'cdp-metadata',
    method: 'operator.cdp.execute',
    params: {
      tabId: 7,
      method: 'Target.getTargets',
      params: {}
    }
  });
  assert.equal(metadata.ok, true);

  await session.handleRpc({
    id: 'approve-example',
    method: 'operator.approveDomain',
    params: { origin: 'https://example.com' }
  });
  const attached = await session.handleRpc({
    id: 'cdp-attach',
    method: 'operator.cdp.attach',
    params: {
      tabId: 7
    }
  });
  assert.equal(attached.ok, true);

  const invalidInput = await session.handleRpc({
    id: 'cdp-invalid-input',
    method: 'operator.cdp.execute',
    params: {
      tabId: 7,
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x: '1', y: 2 }
    }
  });
  assert.equal(invalidInput.ok, false);
  assert.equal(invalidInput.error.code, ERROR_CODES.INVALID_SCHEMA);

  const invalidDialog = await session.handleRpc({
    id: 'cdp-invalid-dialog',
    method: 'operator.cdp.execute',
    params: {
      tabId: 7,
      method: 'Page.handleJavaScriptDialog',
      params: { accept: 'yes' }
    }
  });
  assert.equal(invalidDialog.ok, false);
  assert.equal(invalidDialog.error.code, ERROR_CODES.INVALID_SCHEMA);
  assert.equal(invalidDialog.error.field, 'params.accept');

  const dialog = await session.handleRpc({
    id: 'cdp-dialog',
    method: 'operator.cdp.execute',
    params: {
      tabId: 7,
      method: 'Page.handleJavaScriptDialog',
      params: { accept: false }
    }
  });
  assert.equal(dialog.ok, true);
  assert.equal(dialog.result.method, 'Page.handleJavaScriptDialog');

  const layout = await session.handleRpc({
    id: 'cdp-layout',
    method: 'operator.cdp.execute',
    params: {
      tabId: 7,
      method: 'Page.getLayoutMetrics',
      params: {}
    }
  });
  assert.equal(layout.ok, true);
  const typed = await session.handleRpc({
    id: 'cdp-insert-text',
    method: 'operator.cdp.execute',
    params: {
      tabId: 7,
      method: 'Input.insertText',
      params: { text: 'hello' }
    }
  });
  assert.equal(typed.ok, true);
  const detached = await session.handleRpc({
    id: 'cdp-detach',
    method: 'operator.cdp.detach',
    params: {
      tabId: 7
    }
  });
  assert.equal(detached.ok, true);
  assert.deepEqual(calls.map((call) => call.method), [
    'operator.cdp.execute',
    'operator.cdp.attach',
    'operator.cdp.execute',
    'operator.cdp.execute',
    'operator.cdp.execute',
    'operator.cdp.detach'
  ]);
  assert.deepEqual(calls[2].params, {
    tabId: 7,
    method: 'Page.handleJavaScriptDialog',
    params: { accept: false }
  });
  assert.deepEqual(calls[3].params, {
    tabId: 7,
    method: 'Page.getLayoutMetrics',
    params: {}
  });
});

test('guarded CDP screenshot stores artifact without returning raw image data', async () => {
  const session = makeSession();
  session.screenshotStore.idGenerator = () => 'shot_cdp_test';
  session.sessionTabs.set(7, {
    id: 7,
    title: 'Example',
    url: 'https://example.com/app',
    ownership: 'agent',
    active: true,
    finalizedStatus: null,
    updatedAt: new Date().toISOString()
  });
  await session.handleRpc({
    id: 'approve-example',
    method: 'operator.approveDomain',
    params: { origin: 'https://example.com' }
  });
  session.enqueueExtensionCommand = async (method, params) => ({
    ok: true,
    result: {
      provider: `chrome.debugger.${params.method}`,
      method: params.method,
      response: {},
      screenshot: {
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,aGVsbG8=',
        bytesApprox: 5
      }
    }
  });

  const captured = await session.handleRpc({
    id: 'cdp-screenshot',
    method: 'operator.cdp.execute',
    params: {
      tabId: 7,
      method: 'Page.captureScreenshot',
      params: { format: 'png' }
    }
  });

  assert.equal(captured.ok, true);
  assert.equal(captured.result.method, 'Page.captureScreenshot');
  assert.equal(captured.result.screenshot.artifactId, 'shot_cdp_test');
  assert.equal(captured.result.screenshot.dataUrl, undefined);
  assert.equal(captured.result.screenshot.rawDataRedacted, undefined);
  assert.equal(captured.result.visual.provider, 'chrome.debugger.Page.captureScreenshot');
  assert.equal(captured.result.visual.artifactBacked, true);
  assert.doesNotMatch(JSON.stringify(captured.result), /aGVsbG8=/);
  const auditEntry = session.audit.tail({ limit: 1 })[0];
  assert.equal(auditEntry.params.method, 'Page.captureScreenshot');
  assert.deepEqual(auditEntry.params.paramKeys, ['format']);
});

test('runtime tab visual tools use session-owned CDP screenshots without active-tab capture', async () => {
  const session = makeSession();
  let shotIndex = 0;
  session.screenshotStore.idGenerator = () => `shot_tab_visual_${shotIndex += 1}`;
  session.sessionTabs.set(7, {
    id: 7,
    title: 'Example',
    url: 'https://example.com/app',
    ownership: 'agent',
    ownerAgentId: 'agent-alpha',
    active: false,
    finalizedStatus: null,
    updatedAt: new Date().toISOString()
  });
  await session.handleRpc({
    id: 'approve-example',
    method: 'operator.approveDomain',
    params: { origin: 'https://example.com' }
  });

  const calls = [];
  session.enqueueExtensionCommand = async (method, params) => {
    calls.push({ method, params });
    if (method === 'operator.runtime.tab.observe') {
      return {
        ok: true,
        result: {
          title: 'Visual Fixture',
          url: 'https://example.com/app',
          pageStateId: 'state_visual_1',
          viewport: { width: 1280, height: 720 },
          elements: [{
            handle: 'el_state_0',
            tag: 'button',
            role: 'button',
            label: 'Save settings',
            bbox: { x: 10, y: 20, width: 120, height: 32 },
            data: { visualRole: 'product-card' }
          }]
        }
      };
    }
    if (method === 'operator.cdp.execute') {
      return {
        ok: true,
        result: {
          provider: 'chrome.debugger.Page.captureScreenshot',
          method: params.method,
          screenshot: {
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,aGVsbG8=',
            bytesApprox: 5,
            width: 1280,
            height: 720
          }
        }
      };
    }
    throw new Error(`Unexpected method ${method}`);
  };

  const observed = await session.handleRpc({
    id: 'tab-visual-observe',
    method: 'operator.runtime.tab.visualObserve',
    params: {
      agentId: 'agent-alpha',
      tabId: 7,
      mode: 'medium',
      maxBytes: 120000,
      reason: 'session visual check'
    }
  });
  const analyzed = await session.handleRpc({
    id: 'tab-visual-analyze',
    method: 'operator.runtime.tab.visualAnalyze',
    params: {
      agentId: 'agent-alpha',
      tabId: 7,
      provider: 'local-basic',
      maxBytes: 120000,
      allowSensitive: false
    }
  });
  const inspected = await session.handleRpc({
    id: 'tab-visual-inspect',
    method: 'operator.runtime.tab.visualInspectTarget',
    params: {
      agentId: 'agent-alpha',
      tabId: 7,
      handle: 'el_state_0',
      maxBytes: 120000,
      reason: 'target visual check'
    }
  });

  assert.equal(observed.ok, true);
  assert.equal(observed.result.screenshot.artifactId, 'shot_tab_visual_1');
  assert.equal(observed.result.screenshot.dataUrl, undefined);
  assert.equal(observed.result.visual.provider, 'chrome.debugger.Page.captureScreenshot');
  assert.equal(analyzed.ok, true);
  assert.equal(analyzed.result.visual.analysis.status, 'analyzed');
  assert.equal(analyzed.result.visual.analysis.artifactId, 'shot_tab_visual_2');
  assert.equal(inspected.ok, true);
  assert.equal(inspected.result.visualTarget.sourceArtifactId, 'shot_tab_visual_3');
  assert.match(inspected.result.visualTarget.regionArtifactId, /^region_/);
  assert.deepEqual(calls.map((call) => call.method), [
    'operator.runtime.tab.observe',
    'operator.cdp.execute',
    'operator.runtime.tab.observe',
    'operator.cdp.execute',
    'operator.runtime.tab.observe',
    'operator.cdp.execute'
  ]);
  assert.equal(calls[1].params.tabId, 7);
  assert.equal(calls[1].params.method, 'Page.captureScreenshot');
  assert.equal(calls[1].params.params.format, undefined);
  assert.equal(calls[1].params.expectedActiveTabId, undefined);
});

test('runtime tab visual policy reports visible gates before generic sensitive content', async () => {
  const session = makeSession();
  session.sessionTabs.set(7, {
    id: 7,
    title: 'Gate',
    url: 'https://example.com/gate',
    ownership: 'agent',
    active: false,
    finalizedStatus: null,
    updatedAt: new Date().toISOString()
  });
  await session.handleRpc({
    id: 'approve-example',
    method: 'operator.approveDomain',
    params: { origin: 'https://example.com' }
  });

  const calls = [];
  session.enqueueExtensionCommand = async (method, params) => {
    calls.push({ method, params });
    assert.equal(method, 'operator.runtime.tab.observe');
    return {
      ok: true,
      result: {
        title: 'Password gate',
        url: 'https://example.com/gate',
        pageStateId: 'state_gate',
        visibleTextSummary: 'Password required',
        detectedGates: [{ type: 'PASSWORD_REQUIRED' }],
        elements: [{
          handle: 'el_gate_0',
          tag: 'input',
          role: 'textbox',
          label: 'Password',
          bbox: { x: 10, y: 20, width: 120, height: 32 }
        }]
      }
    };
  };

  const blocked = await session.handleRpc({
    id: 'tab-visual-gate',
    method: 'operator.runtime.tab.visualObserve',
    params: {
      tabId: 7,
      maxBytes: 120000,
      reason: 'gate visual policy'
    }
  });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, ERROR_CODES.VISUAL_PROVIDER_POLICY_BLOCKED);
  assert.equal(blocked.error.gateType, 'PASSWORD_REQUIRED');
  assert.equal(blocked.error.reason, undefined);
  assert.deepEqual(calls.map((call) => call.method), ['operator.runtime.tab.observe']);
});

test('runtime tab visual policy preserves explicit sensitive visual blocks before gates', async () => {
  const session = makeSession();
  session.sessionTabs.set(7, {
    id: 7,
    title: 'Sensitive',
    url: 'https://example.com/sensitive',
    ownership: 'agent',
    active: false,
    finalizedStatus: null,
    updatedAt: new Date().toISOString()
  });
  await session.handleRpc({
    id: 'approve-example',
    method: 'operator.approveDomain',
    params: { origin: 'https://example.com' }
  });

  session.enqueueExtensionCommand = async (method) => {
    assert.equal(method, 'operator.runtime.tab.observe');
    return {
      ok: true,
      result: {
        title: 'Sensitive policy page',
        url: 'https://example.com/sensitive',
        pageStateId: 'state_sensitive',
        visualPolicy: { explicitBlock: true },
        detectedGates: [{ type: 'ACCOUNT_SECURITY_REAUTH_REQUIRED' }],
        elements: []
      }
    };
  };

  const blocked = await session.handleRpc({
    id: 'tab-visual-sensitive-block',
    method: 'operator.runtime.tab.visualAnalyze',
    params: {
      tabId: 7,
      provider: 'local-basic',
      maxBytes: 120000,
      reason: 'explicit visual policy'
    }
  });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, ERROR_CODES.VISUAL_PROVIDER_POLICY_BLOCKED);
  assert.equal(blocked.error.reason, 'SENSITIVE_VISUAL_CONTENT');
  assert.equal(blocked.error.gateType, undefined);
});

test('runtime tab commands route through session-owned tabs and fail closed for ambiguous locators', async () => {
  const session = makeSession();
  session.sessionTabs.set(7, {
    id: 7,
    title: 'Example',
    url: 'https://example.com/app',
    ownership: 'agent',
    active: true,
    finalizedStatus: null,
    updatedAt: new Date().toISOString()
  });
  await session.handleRpc({
    id: 'approve-example',
    method: 'operator.approveDomain',
    params: { origin: 'https://example.com' }
  });
  await session.handleRpc({
    id: 'approve-docs',
    method: 'operator.approveDomain',
    params: { origin: 'https://docs.example.com' }
  });
  const calls = [];
  session.enqueueExtensionCommand = async (method, params) => {
    calls.push({ method, params });
    if (method === 'operator.runtime.tab.goto') {
      return {
        ok: true,
        result: {
          action: 'navigate',
          tab: { id: 7, title: 'Docs', url: params.url, ownership: 'agent', active: true }
        }
      };
    }
    if (method === 'operator.runtime.tab.observe') {
      return {
        ok: true,
        result: {
          title: 'Docs',
          elements: []
        }
      };
    }
    if (method === 'operator.runtime.tab.locator') {
      return {
        ok: false,
        error: {
          code: 'LOCATOR_NOT_UNIQUE',
          message: 'Locator matched more than one visible actionable element.',
          matchCount: 2
        }
      };
    }
    throw new Error(`Unexpected method ${method}`);
  };

  const navigated = await session.handleRpc({
    id: 'runtime-goto',
    method: 'operator.runtime.tab.goto',
    params: {
      tabId: 7,
      url: 'https://docs.example.com/page'
    }
  });
  assert.equal(navigated.ok, true);
  assert.equal(session.sessionTabs.get(7).url, 'https://docs.example.com/page');

  const observed = await session.handleRpc({
    id: 'runtime-observe',
    method: 'operator.runtime.tab.observe',
    params: {
      tabId: 7,
      mode: 'tiny'
    }
  });
  assert.equal(observed.ok, true);
  assert.equal(observed.result.origin, 'https://docs.example.com');

  const locator = await session.handleRpc({
    id: 'runtime-locator',
    method: 'operator.runtime.tab.locator',
    params: {
      tabId: 7,
      selector: 'button',
      action: 'click',
      postActionSnapshot: 'delta',
      postActionVerifyDelayMs: 3000
    }
  });
  assert.equal(locator.ok, false);
  assert.equal(locator.error.code, 'LOCATOR_NOT_UNIQUE');
  assert.deepEqual(calls.map((call) => call.method), [
    'operator.runtime.tab.goto',
    'operator.runtime.tab.observe',
    'operator.runtime.tab.locator'
  ]);
  assert.equal(calls[2].params.postActionVerifyDelayMs, 3000);
});

test('runtime tab commands fail closed while navigation is still pending on the previous URL', async () => {
  const session = makeSession();
  session.sessionTabs.set(7, {
    id: 7,
    title: 'Old',
    url: 'https://old.example/app',
    ownership: 'agent',
    active: true,
    finalizedStatus: null,
    updatedAt: new Date().toISOString()
  });
  await session.handleRpc({
    id: 'approve-old',
    method: 'operator.approveDomain',
    params: { origin: 'https://old.example' }
  });
  await session.handleRpc({
    id: 'approve-new',
    method: 'operator.approveDomain',
    params: { origin: 'https://new.example' }
  });

  const calls = [];
  session.enqueueExtensionCommand = async (method, params) => {
    calls.push({ method, params });
    if (method === 'operator.runtime.tab.goto') {
      return {
        ok: true,
        result: {
          action: 'navigate',
          requestedUrl: params.url,
          tab: {
            id: 7,
            title: 'Old',
            url: 'https://old.example/app',
            pendingUrl: params.url,
            ownership: 'agent',
            status: 'loading',
            loadingState: 'loading'
          }
        }
      };
    }
    if (method === 'operator.tabs.listSession') {
      return {
        ok: true,
        result: {
          tabs: [{
            id: 7,
            title: 'Old',
            url: 'https://old.example/app',
            pendingUrl: 'https://new.example/page',
            ownership: 'agent',
            status: 'loading',
            loadingState: 'loading'
          }]
        }
      };
    }
    throw new Error(`Unexpected method ${method}`);
  };

  const navigated = await session.handleRpc({
    id: 'runtime-goto-pending',
    method: 'operator.runtime.tab.goto',
    params: {
      tabId: 7,
      url: 'https://new.example/page'
    }
  });
  assert.equal(navigated.ok, true);
  assert.equal(session.sessionTabs.get(7).url, 'https://old.example/app');
  assert.equal(session.sessionTabs.get(7).pendingUrl, 'https://new.example/page');

  const observed = await session.handleRpc({
    id: 'runtime-observe-pending',
    method: 'operator.runtime.tab.observe',
    params: { tabId: 7 }
  });

  assert.equal(observed.ok, false);
  assert.equal(observed.error.code, ERROR_CODES.NAVIGATION_NOT_SETTLED);
  assert.equal(observed.error.tabId, 7);
  assert.equal(observed.error.currentUrl, 'https://old.example/app');
  assert.equal(observed.error.pendingUrl, 'https://new.example/page');
  assert.deepEqual(calls.map((call) => call.method), [
    'operator.runtime.tab.goto',
    'operator.tabs.listSession'
  ]);
});

test('runtime tab debugger focus disturbance is preserved in audit timeline', async () => {
  const session = makeSession();
  session.sessionTabs.set(7, {
    id: 7,
    title: 'Example',
    url: 'https://example.com/app',
    ownership: 'agent',
    ownerAgentId: 'agent-alpha',
    active: false,
    finalizedStatus: null,
    updatedAt: new Date().toISOString()
  });
  await session.handleRpc({
    id: 'approve-example',
    method: 'operator.approveDomain',
    params: { origin: 'https://example.com' }
  });

  session.enqueueExtensionCommand = async (method) => {
    assert.equal(method, 'operator.runtime.tab.locator');
    return {
      ok: true,
      result: {
        action: 'clicked',
        origin: 'https://example.com',
        focusDisturbance: {
          changed: true,
          reason: 'cdp-input-requires-active-tab',
          targetTabId: 7,
          previousActiveTabId: 5,
          restored: true
        }
      }
    };
  };

  const clicked = await session.handleRpc({
    id: 'runtime-locator-focus',
    method: 'operator.runtime.tab.locator',
    params: {
      agentId: 'agent-alpha',
      tabId: 7,
      selector: 'button.save',
      action: 'click'
    }
  });

  assert.equal(clicked.ok, true);
  const auditEntry = session.audit.tail({ limit: 1 })[0];
  assert.deepEqual(auditEntry.focusDisturbance, {
    changed: true,
    reason: 'cdp-input-requires-active-tab',
    targetTabId: 7,
    previousActiveTabId: 5,
    restored: true
  });
  const timelineEntry = session.audit.timeline({ limit: 1 })[0];
  assert.deepEqual(timelineEntry.focusDisturbance, auditEntry.focusDisturbance);
});

test('runtime tab reads use per-tab warm cache without same-origin bleed', async () => {
  const session = makeSession();
  session.sessionTabs.set(7, {
    id: 7,
    title: 'Alpha',
    url: 'https://example.com/alpha',
    ownership: 'agent',
    active: false,
    finalizedStatus: null,
    updatedAt: new Date().toISOString()
  });
  session.sessionTabs.set(8, {
    id: 8,
    title: 'Beta',
    url: 'https://example.com/beta',
    ownership: 'agent',
    active: true,
    finalizedStatus: null,
    updatedAt: new Date().toISOString()
  });
  await session.handleRpc({
    id: 'approve-example',
    method: 'operator.approveDomain',
    params: { origin: 'https://example.com' }
  });

  for (const tab of [
    { id: 7, url: 'https://example.com/alpha', title: 'Alpha', state: 'alpha_state', text: 'Alpha cached text [el_alpha_0]' },
    { id: 8, url: 'https://example.com/beta', title: 'Beta', state: 'beta_state', text: 'Beta cached text [el_beta_0]' }
  ]) {
    const warmed = await session.handleRpc({
      id: `warm-${tab.id}`,
      method: 'extension.activeTabWarmup',
      params: {
        activeTab: {
          id: tab.id,
          windowId: 1,
          url: tab.url,
          title: tab.title,
          status: 'complete'
        },
        warmup: {
          ok: true,
          source: 'unit-warmup',
          observation: {
            origin: 'https://example.com',
            url: tab.url,
            title: tab.title,
            observationMode: 'tiny',
            pageStateId: tab.state,
            elements: [{ handle: `el_${tab.state}_0`, label: tab.title }]
          },
          readPage: {
            origin: 'https://example.com',
            url: tab.url,
            title: tab.title,
            pageStateId: tab.state,
            pageContent: tab.text,
            handles: [{ handle: `el_${tab.state}_0`, label: tab.title }]
          }
        }
      }
    });
    assert.equal(warmed.ok, true);
  }

  const calls = [];
  session.enqueueExtensionCommand = async (method, params) => {
    calls.push({ method, params });
    return {
      ok: false,
      error: {
        code: 'UNEXPECTED_QUEUE',
        message: 'Per-tab warm cache should satisfy runtime tab reads.'
      }
    };
  };

  const alphaRead = await session.handleRpc({
    id: 'alpha-read',
    method: 'operator.runtime.tab.readPage',
    params: { tabId: 7, filter: 'interactive', maxChars: 1000 }
  });
  const betaRead = await session.handleRpc({
    id: 'beta-read',
    method: 'operator.runtime.tab.readPage',
    params: { tabId: 8, filter: 'interactive', maxChars: 1000 }
  });
  const alphaObserve = await session.handleRpc({
    id: 'alpha-observe',
    method: 'operator.runtime.tab.observe',
    params: { tabId: 7, mode: 'tiny' }
  });
  const betaObserve = await session.handleRpc({
    id: 'beta-observe',
    method: 'operator.runtime.tab.observe',
    params: { tabId: 8, mode: 'tiny' }
  });

  assert.equal(alphaRead.ok, true);
  assert.equal(alphaRead.result.pageContent, 'Alpha cached text [el_alpha_0]');
  assert.equal(alphaRead.result.warmCache.tabId, 7);
  assert.equal(betaRead.ok, true);
  assert.equal(betaRead.result.pageContent, 'Beta cached text [el_beta_0]');
  assert.equal(betaRead.result.warmCache.tabId, 8);
  assert.equal(alphaObserve.ok, true);
  assert.equal(alphaObserve.result.title, 'Alpha');
  assert.equal(alphaObserve.result.warmCache.tabId, 7);
  assert.equal(betaObserve.ok, true);
  assert.equal(betaObserve.result.title, 'Beta');
  assert.equal(betaObserve.result.warmCache.tabId, 8);
  assert.deepEqual(calls, []);
});

test('same-tab extension commands are mutexed until the previous response is delivered', async () => {
  const session = makeSession();

  const first = session.enqueueExtensionCommand('operator.runtime.tab.observe', { tabId: 7 });
  const second = session.enqueueExtensionCommand('operator.runtime.tab.readPage', { tabId: 7 });

  const firstPoll = await session.handleRpc({
    id: 'poll-1',
    method: 'bridge.poll',
    params: {}
  });
  assert.equal(firstPoll.ok, true);
  assert.equal(firstPoll.result.command.method, 'operator.runtime.tab.observe');

  const emptyPoll = await session.handleRpc({
    id: 'poll-empty',
    method: 'bridge.poll',
    params: {}
  });
  assert.equal(emptyPoll.ok, true);
  assert.equal(emptyPoll.result.command, null);

  const firstDelivery = await session.handleRpc({
    id: 'deliver-1',
    method: 'bridge.deliver',
    params: {
      commandId: firstPoll.result.command.commandId,
      connectionId: 'conn_test',
      response: { ok: true, result: { name: 'first' } }
    }
  });
  assert.equal(firstDelivery.ok, true);
  assert.deepEqual(await first, { ok: true, result: { name: 'first' } });

  const secondPoll = await session.handleRpc({
    id: 'poll-2',
    method: 'bridge.poll',
    params: {}
  });
  assert.equal(secondPoll.ok, true);
  assert.equal(secondPoll.result.command.method, 'operator.runtime.tab.readPage');

  const secondDelivery = await session.handleRpc({
    id: 'deliver-2',
    method: 'bridge.deliver',
    params: {
      commandId: secondPoll.result.command.commandId,
      connectionId: 'conn_test',
      response: { ok: true, result: { name: 'second' } }
    }
  });
  assert.equal(secondDelivery.ok, true);
  assert.deepEqual(await second, { ok: true, result: { name: 'second' } });
});

test('runtime tab locator accepts handle actions without depending on the active tab', async () => {
  const session = makeSession();
  session.sessionTabs.set(7, {
    id: 7,
    title: 'Example',
    url: 'https://example.com/app',
    ownership: 'agent',
    active: false,
    finalizedStatus: null,
    updatedAt: new Date().toISOString()
  });
  session.updateActiveTab({
    id: 8,
    title: 'Other Example',
    url: 'https://example.com/app',
    status: 'complete'
  });
  await session.handleRpc({
    id: 'approve-example',
    method: 'operator.approveDomain',
    params: { origin: 'https://example.com' }
  });

  const calls = [];
  session.enqueueExtensionCommand = async (method, params) => {
    calls.push({ method, params });
    return { ok: true, result: { action: 'clicked' } };
  };

  const clicked = await session.handleRpc({
    id: 'runtime-handle-click',
    method: 'operator.runtime.tab.locator',
    params: {
      tabId: 7,
      handle: 'el_state_0',
      action: 'click',
      postActionSnapshot: 'delta'
    }
  });

  assert.equal(clicked.ok, true);
  assert.deepEqual(calls, [{
    method: 'operator.runtime.tab.locator',
    params: {
      tabId: 7,
      handle: 'el_state_0',
      action: 'click',
      postActionSnapshot: 'delta'
    }
  }]);
});

test('runtime tab batch routes through a session-owned tab when the same-origin active tab differs', async () => {
  const session = makeSession();
  session.sessionTabs.set(7, {
    id: 7,
    title: 'Claimed Example',
    url: 'https://example.com/app',
    ownership: 'agent',
    active: false,
    finalizedStatus: null,
    updatedAt: new Date().toISOString()
  });
  session.updateActiveTab({
    id: 8,
    title: 'Unclaimed Example',
    url: 'https://example.com/app',
    status: 'complete'
  });
  await session.handleRpc({
    id: 'approve-example',
    method: 'operator.approveDomain',
    params: { origin: 'https://example.com' }
  });

  const calls = [];
  session.enqueueExtensionCommand = async (method, params) => {
    calls.push({ method, params });
    return {
      ok: true,
      result: {
        results: [{ ok: true, result: { action: 'clicked' } }],
        stoppedOnError: false
      }
    };
  };

  const batched = await session.handleRpc({
    id: 'runtime-tab-batch',
    method: 'operator.runtime.tab.batch',
    params: {
      tabId: 7,
      stopOnError: true,
      actions: [{
        action: 'click',
        handle: 'el_state_0'
      }]
    }
  });

  assert.equal(batched.ok, true);
  assert.deepEqual(calls, [{
    method: 'operator.runtime.tab.batch',
    params: {
      tabId: 7,
      origin: 'https://example.com',
      stopOnError: true,
      actions: [{
        action: 'click',
        handle: 'el_state_0'
      }]
    }
  }]);
});

test('runtime tab locator carries relaxed policy when guarded actions are disabled', async () => {
  const session = makeSession();
  session.sessionTabs.set(7, {
    id: 7,
    title: 'Example',
    url: 'https://example.com/app',
    ownership: 'agent',
    active: true,
    finalizedStatus: null,
    updatedAt: new Date().toISOString()
  });
  await session.handleRpc({
    id: 'approve-example',
    method: 'operator.approveDomain',
    params: { origin: 'https://example.com' }
  });
  await session.handleRpc({
    id: 'guarded-off',
    method: 'operator.policy.update',
    params: { guardedActionsEnabled: false }
  });

  const calls = [];
  session.enqueueExtensionCommand = async (method, params) => {
    calls.push({ method, params });
    return { ok: true, result: { action: 'clicked' } };
  };

  const clicked = await session.handleRpc({
    id: 'runtime-locator-click',
    method: 'operator.runtime.tab.locator',
    params: {
      tabId: 7,
      selector: 'button[data-testid="publish"]',
      action: 'click',
      targetContract: saveTargetContract('el_publish')
    }
  });

  assert.equal(clicked.ok, true);
  assert.deepEqual(calls, [{
    method: 'operator.runtime.tab.locator',
    params: {
      tabId: 7,
      selector: 'button[data-testid="publish"]',
      action: 'click',
      targetContract: saveTargetContract('el_publish'),
      approval: {
        allowHighRisk: true,
        allowSensitiveFormFill: true,
        approvalKind: 'policy-disabled'
      },
      policy: {
        highRiskEnabled: false,
        sensitiveFormFillEnabled: false
      }
    }
  }]);
});

test('runtime tab locator resolve does not carry relaxed policy when guarded actions are disabled', async () => {
  const session = makeSession();
  session.sessionTabs.set(7, {
    id: 7,
    title: 'Example',
    url: 'https://example.com/app',
    ownership: 'agent',
    active: true,
    finalizedStatus: null,
    updatedAt: new Date().toISOString()
  });
  await session.handleRpc({
    id: 'approve-example',
    method: 'operator.approveDomain',
    params: { origin: 'https://example.com' }
  });
  await session.handleRpc({
    id: 'guarded-off',
    method: 'operator.policy.update',
    params: { guardedActionsEnabled: false }
  });

  const calls = [];
  session.enqueueExtensionCommand = async (method, params) => {
    calls.push({ method, params });
    return { ok: true, result: { target: { handle: 'el_button' } } };
  };

  const resolved = await session.handleRpc({
    id: 'runtime-locator-resolve-policy-disabled',
    method: 'operator.runtime.tab.locator',
    params: {
      tabId: 7,
      selector: 'button[data-testid="publish"]',
      action: 'resolve'
    }
  });

  assert.equal(resolved.ok, true);
  assert.equal(calls[0].params.approval, undefined);
  assert.equal(calls[0].params.policy, undefined);
});

test('runtime tab locator rejects malformed target contracts before queuing', async () => {
  const session = makeSession();
  session.sessionTabs.set(7, {
    id: 7,
    title: 'Example',
    url: 'https://example.com/app',
    ownership: 'agent',
    active: true,
    finalizedStatus: null,
    updatedAt: new Date().toISOString()
  });
  await session.handleRpc({
    id: 'approve-example',
    method: 'operator.approveDomain',
    params: { origin: 'https://example.com' }
  });
  let queued = false;
  session.enqueueExtensionCommand = async () => {
    queued = true;
    return { ok: true, result: {} };
  };

  const clicked = await session.handleRpc({
    id: 'runtime-locator-invalid-target-contract',
    method: 'operator.runtime.tab.locator',
    params: {
      tabId: 7,
      selector: 'button[data-testid="publish"]',
      action: 'click',
      targetContract: {
        version: 1,
        tag: 'button',
        unsupported: true
      }
    }
  });

  assert.equal(clicked.ok, false);
  assert.equal(clicked.error.code, ERROR_CODES.INVALID_SCHEMA);
  assert.equal(clicked.error.field, 'targetContract.unsupported');
  assert.equal(queued, false);
});

test('runtime tab locator retries extension high-risk blocks when guarded actions are disabled', async () => {
  const session = makeSession();
  session.sessionTabs.set(7, {
    id: 7,
    title: 'Example',
    url: 'https://example.com/app',
    ownership: 'agent',
    active: true,
    finalizedStatus: null,
    updatedAt: new Date().toISOString()
  });
  await session.handleRpc({
    id: 'approve-example',
    method: 'operator.approveDomain',
    params: { origin: 'https://example.com' }
  });
  await session.handleRpc({
    id: 'guarded-off',
    method: 'operator.policy.update',
    params: { guardedActionsEnabled: false }
  });

  const calls = [];
  session.enqueueExtensionCommand = async (method, params) => {
    calls.push({ method, params });
    if (calls.length === 1) {
      return {
        ok: false,
        error: {
          code: ERROR_CODES.HIGH_RISK_BLOCKED,
          approvalKind: 'publish',
          targetSummary: 'button: Publish'
        }
      };
    }
    return { ok: true, result: { action: 'clicked' } };
  };

  const clicked = await session.handleRpc({
    id: 'runtime-locator-click-retry',
    method: 'operator.runtime.tab.locator',
    params: {
      tabId: 7,
      selector: 'button[data-testid="publish"]',
      action: 'click'
    }
  });

  assert.equal(clicked.ok, true);
  assert.deepEqual(calls.map((call) => call.params.approval), [
    {
      allowHighRisk: true,
      allowSensitiveFormFill: true,
      approvalKind: 'policy-disabled'
    },
    {
      allowHighRisk: true,
      allowSensitiveFormFill: true,
      approvalKind: 'publish'
    }
  ]);
  assert.deepEqual(session.listApprovalRecords(), []);
});
