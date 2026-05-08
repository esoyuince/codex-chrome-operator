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
