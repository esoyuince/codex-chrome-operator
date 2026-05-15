const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SessionManager } = require('../operator-daemon/sessionManager');
const { ERROR_CODES } = require('../operator-daemon/protocol');

function makeSession({ allowedOrigins = ['https://chat.example'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-operator-chat-watcher-'));
  const session = new SessionManager({
    auditLogPath: path.join(dir, 'audit.jsonl'),
    screenshotDir: path.join(dir, 'screenshots'),
    statePath: path.join(dir, 'state.json'),
    chatWatcherAllowedOrigins: allowedOrigins,
    expectedExtensionId: 'abcdefghijklmnopabcdefghijklmnop'
  });
  session.connectionState = 'EXTENSION_CONNECTED';
  session.connectionId = 'conn_test';
  session.profileVerified = true;
  return session;
}

function seedChatTab(session, { agentId = 'agent-alpha', tabId = 42, origin = 'https://chat.example' } = {}) {
  session.stateStore.approveDomain(origin);
  return session.updateSessionTab({
    id: tabId,
    title: 'Allowed chat',
    url: `${origin}/room`,
    ownership: 'created',
    active: false
  }, 'created', { agentId });
}

test('chat watcher start is allowlist and agent lease scoped', async () => {
  const session = makeSession({ allowedOrigins: ['https://chat.example'] });
  seedChatTab(session, { agentId: 'agent-alpha' });

  const notAllowlisted = await session.handleRpc({
    id: 'watcher-disallowed',
    method: 'operator.chatWatcher.start',
    params: {
      agentId: 'agent-alpha',
      tabId: 42,
      origin: 'https://other.example',
      unreadSelector: '[data-unread]'
    }
  });
  assert.equal(notAllowlisted.ok, false);
  assert.equal(notAllowlisted.error.code, ERROR_CODES.CHAT_WATCHER_UNAVAILABLE);
  assert.equal(notAllowlisted.error.reason, 'ORIGIN_NOT_ALLOWLISTED');

  const crossAgent = await session.handleRpc({
    id: 'watcher-cross-agent',
    method: 'operator.chatWatcher.start',
    params: {
      agentId: 'agent-beta',
      tabId: 42,
      origin: 'https://chat.example',
      unreadSelector: '[data-unread]'
    }
  });
  assert.equal(crossAgent.ok, false);
  assert.equal(crossAgent.error.code, ERROR_CODES.TAB_MISMATCH);

  const started = await session.handleRpc({
    id: 'watcher-start',
    method: 'operator.chatWatcher.start',
    params: {
      agentId: 'agent-alpha',
      tabId: 42,
      origin: 'https://chat.example',
      unreadSelector: '[data-unread]',
      screenshotOnUnread: true
    }
  });
  assert.equal(started.ok, true);
  assert.equal(started.result.watcher.mode, 'observe-only');
  assert.equal(started.result.watcher.screenshotOnUnread, true);

  const status = session.status({ detail: 'compact' });
  assert.equal(status.chatWatcher.allowlistedOriginCount, 1);
  assert.equal(status.chatWatcher.watcherCount, 1);
});

test('chat watcher pause, resume, and stop preserve observe-only state', async () => {
  const session = makeSession();
  seedChatTab(session);

  const started = await session.handleRpc({
    id: 'watcher-start',
    method: 'operator.chatWatcher.start',
    params: {
      agentId: 'agent-alpha',
      tabId: 42,
      origin: 'https://chat.example',
      unreadSelector: '[data-unread]'
    }
  });
  const watcherId = started.result.watcher.watcherId;

  const paused = await session.handleRpc({
    id: 'watcher-pause',
    method: 'operator.chatWatcher.pause',
    params: { watcherId }
  });
  assert.equal(paused.ok, true);
  assert.equal(paused.result.watcher.status, 'paused');

  const resumed = await session.handleRpc({
    id: 'watcher-resume',
    method: 'operator.chatWatcher.resume',
    params: { watcherId }
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.result.watcher.status, 'running');

  const stopped = await session.handleRpc({
    id: 'watcher-stop',
    method: 'operator.chatWatcher.stop',
    params: { watcherId }
  });
  assert.equal(stopped.ok, true);
  assert.equal(session.chatWatcherStatus().watchers.length, 0);
});

test('chat watcher poll records unread events and artifact-backed screenshots only when configured', async () => {
  const session = makeSession();
  seedChatTab(session);
  const calls = [];
  session.enqueueExtensionCommand = async (method, params) => {
    calls.push({ method, params });
    if (method === 'operator.runtime.tab.locator') {
      return {
        ok: true,
        result: {
          target: {
            tag: 'button',
            role: 'button',
            label: '3 unread messages'
          }
        }
      };
    }
    if (method === 'operator.cdp.execute') {
      return {
        ok: true,
        result: {
          screenshot: {
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,AA==',
            width: 1,
            height: 1
          },
          provider: 'chrome.debugger.Page.captureScreenshot'
        }
      };
    }
    throw new Error(`Unexpected method ${method}`);
  };

  const started = await session.handleRpc({
    id: 'watcher-start',
    method: 'operator.chatWatcher.start',
    params: {
      agentId: 'agent-alpha',
      tabId: 42,
      origin: 'https://chat.example',
      unreadSelector: '[data-unread]',
      screenshotOnUnread: true
    }
  });
  const poll = await session.handleRpc({
    id: 'watcher-poll',
    method: 'operator.chatWatcher.poll',
    params: { watcherId: started.result.watcher.watcherId }
  });

  assert.equal(poll.ok, true);
  assert.equal(poll.result.unread, true);
  assert.equal(poll.result.event.type, 'unread');
  assert.equal(poll.result.event.screenshot.mimeType, 'image/png');
  assert.deepEqual(calls.map((call) => call.method), [
    'operator.runtime.tab.locator',
    'operator.cdp.execute'
  ]);
  assert.equal(calls[0].params.action, 'resolve');
  assert.equal(calls[0].params.selector, '[data-unread]');
  assert.equal(calls[1].params.method, 'Page.captureScreenshot');
});
