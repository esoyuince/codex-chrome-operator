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
    grantedAt: '2026-04-29T12:00:00.000Z'
  });
});

test('OperatorStateStore persists configured profile selection without binding metadata', () => {
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
    profileLabel: 'Play Console'
  });
});

test('OperatorStateStore strips legacy binding metadata when loading state', () => {
  const statePath = tempStatePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    hostPermissions: {
      'https://example.com': {
        origin: 'https://example.com',
        profileBindingId: 'profbind_legacy',
        grantedAt: '2026-04-29T12:00:00.000Z'
      }
    },
    configuredProfile: {
      userDataDir: 'C:/Chrome/User Data',
      profileDirectory: 'Profile 1',
      profileLabel: 'Play Console',
      profileBindingId: 'profbind_legacy',
      profileBindingVersion: 4
    }
  }), 'utf8');

  const store = new OperatorStateStore({ statePath });

  assert.deepEqual(store.getHostPermission('https://example.com'), {
    origin: 'https://example.com',
    grantedAt: '2026-04-29T12:00:00.000Z'
  });
  assert.deepEqual(store.getConfiguredProfile(), {
    userDataDir: 'C:/Chrome/User Data',
    profileDirectory: 'Profile 1',
    profileLabel: 'Play Console'
  });
});

test('OperatorStateStore recovers from corrupt state with a repair warning', () => {
  const statePath = tempStatePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, '{not valid json', 'utf8');

  const store = new OperatorStateStore({ statePath });

  assert.deepEqual(store.listDomainApprovals(), {});
  assert.equal(store.getConfiguredProfile(), null);
  assert.equal(store.loadError.code, 'STATE_FILE_CORRUPT');
  assert.ok(fs.existsSync(`${statePath}.corrupt`));
});

test('OperatorStateStore syncs host permissions as one profile-independent set', () => {
  const statePath = tempStatePath();
  const store = new OperatorStateStore({ statePath });

  store.grantHostPermission('https://keep.example', {
    grantedAt: '2026-04-29T12:00:00.000Z'
  });
  store.grantHostPermission('https://remove.example', {
    grantedAt: '2026-04-29T12:00:00.000Z'
  });
  store.grantHostPermission('https://other.example', {
    grantedAt: '2026-04-29T12:00:00.000Z'
  });

  const synced = store.syncHostPermissions({
    origins: ['https://keep.example', 'https://new.example'],
    syncedAt: '2026-04-29T13:00:00.000Z'
  });

  assert.deepEqual(Object.keys(synced).sort(), [
    'https://keep.example',
    'https://new.example'
  ]);
  assert.equal(store.getHostPermission('https://remove.example'), null);
  assert.equal(store.getHostPermission('https://other.example'), null);
  assert.deepEqual(store.getHostPermission('https://new.example'), {
    origin: 'https://new.example',
    grantedAt: '2026-04-29T13:00:00.000Z'
  });
});

test('OperatorStateStore persists user blocked site settings', () => {
  const statePath = tempStatePath();
  const first = new OperatorStateStore({ statePath });

  first.setBlockedOrigins([
    'https://bank.example',
    '*.internal.example',
    'news.example'
  ]);

  const second = new OperatorStateStore({ statePath });

  assert.deepEqual(second.listBlockedOrigins(), [
    '*.internal.example',
    'https://bank.example',
    'news.example'
  ]);
  assert.equal(second.isOriginBlocked('https://bank.example'), true);
  assert.equal(second.isOriginBlocked('https://login.internal.example'), true);
  assert.equal(second.isOriginBlocked('https://news.example'), true);
  assert.equal(second.isOriginBlocked('https://safe.example'), false);
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
