const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { OperatorStateStore } = require('../operator-daemon/stateStore');

function tempStatePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-operator-state-'));
  return path.join(dir, 'state.json');
}

test('OperatorStateStore persists domain approvals and host permissions', () => {
  const statePath = tempStatePath();
  const first = new OperatorStateStore({ statePath });

  first.approveDomain('https://example.com', {
    mode: 'guarded',
    taskScope: 'fixture test',
    expiresAt: '2026-04-30T00:00:00.000Z'
  });
  first.grantHostPermission('https://example.com', {
    profileBindingId: 'profbind_test',
    grantedAt: '2026-04-29T12:00:00.000Z'
  });

  const second = new OperatorStateStore({ statePath });
  assert.deepEqual(second.getDomainApproval('https://example.com'), {
    origin: 'https://example.com',
    mode: 'guarded',
    taskScope: 'fixture test',
    expiresAt: '2026-04-30T00:00:00.000Z'
  });
  assert.deepEqual(second.getHostPermission('https://example.com'), {
    origin: 'https://example.com',
    profileBindingId: 'profbind_test',
    grantedAt: '2026-04-29T12:00:00.000Z'
  });
});

test('OperatorStateStore persists configured profile binding', () => {
  const statePath = tempStatePath();
  const first = new OperatorStateStore({ statePath });

  first.setConfiguredProfile({
    userDataDir: 'C:/Chrome/User Data',
    profileDirectory: 'Profile 1',
    profileLabel: 'Play Console',
    profileBindingId: 'profbind_profile',
    profileBindingVersion: 4
  });

  const second = new OperatorStateStore({ statePath });
  assert.deepEqual(second.getConfiguredProfile(), {
    userDataDir: 'C:/Chrome/User Data',
    profileDirectory: 'Profile 1',
    profileLabel: 'Play Console',
    profileBindingId: 'profbind_profile',
    profileBindingVersion: 4
  });
});
