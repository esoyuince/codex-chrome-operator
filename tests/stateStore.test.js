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
    expiresAt: '2999-01-01T00:00:00.000Z'
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
    expiresAt: '2999-01-01T00:00:00.000Z'
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

test('OperatorStateStore syncs host permissions for one profile binding', () => {
  const statePath = tempStatePath();
  const store = new OperatorStateStore({ statePath });

  store.grantHostPermission('https://keep.example', {
    profileBindingId: 'profbind_current',
    grantedAt: '2026-04-29T12:00:00.000Z'
  });
  store.grantHostPermission('https://remove.example', {
    profileBindingId: 'profbind_current',
    grantedAt: '2026-04-29T12:00:00.000Z'
  });
  store.grantHostPermission('https://other.example', {
    profileBindingId: 'profbind_other',
    grantedAt: '2026-04-29T12:00:00.000Z'
  });

  const synced = store.syncHostPermissions({
    profileBindingId: 'profbind_current',
    origins: ['https://keep.example', 'https://new.example'],
    syncedAt: '2026-04-29T13:00:00.000Z'
  });

  assert.deepEqual(Object.keys(synced).sort(), [
    'https://keep.example',
    'https://new.example'
  ]);
  assert.equal(store.getHostPermission('https://remove.example'), null);
  assert.equal(store.getHostPermission('https://other.example').profileBindingId, 'profbind_other');
  assert.equal(store.getHostPermission('https://new.example').profileBindingId, 'profbind_current');
});

test('OperatorStateStore filters expired approvals and revokes approval state', () => {
  const statePath = tempStatePath();
  const store = new OperatorStateStore({ statePath });
  const now = new Date('2026-04-29T12:00:00.000Z');

  store.approveDomain('https://active.example', {
    expiresAt: '2999-01-01T00:00:00.000Z'
  });
  store.approveDomain('https://expired.example', {
    expiresAt: '2020-01-01T00:00:00.000Z'
  });

  assert.equal(store.isDomainApproved('https://active.example', { now }), true);
  assert.equal(store.isDomainApproved('https://expired.example', { now }), false);
  assert.deepEqual(Object.keys(store.listActiveDomainApprovals({ now })), ['https://active.example']);

  const revoked = store.revokeDomain('https://active.example');
  assert.equal(revoked, true);
  assert.equal(store.getDomainApproval('https://active.example'), null);
  assert.equal(store.isDomainApproved('https://active.example', { now }), false);
});
