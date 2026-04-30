const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  assertCartProfileAllowed,
  loadSiteProfiles,
  originMatchesProfile
} = require('../operator-daemon/siteProfileRegistry');

const PROFILE_DIR = path.resolve(__dirname, '..', 'siteProfiles');

test('loadSiteProfiles loads strict local and Hepsiburada ecommerce profiles', () => {
  const profiles = loadSiteProfiles({ profileDir: PROFILE_DIR });

  assert.ok(profiles.byId.has('localTest.ecommerce.v1'));
  assert.ok(profiles.byId.has('hepsiburada.shopping.v1'));
  assert.equal(profiles.byId.get('localTest.ecommerce.v1').kind, 'ecommerce-cart-preparation');
  assert.equal(profiles.byId.get('hepsiburada.shopping.v1').realSiteEnabled, false);
});

test('originMatchesProfile accepts localhost fixture ports and rejects unrelated origins', () => {
  const { byId } = loadSiteProfiles({ profileDir: PROFILE_DIR });
  const local = byId.get('localTest.ecommerce.v1');

  assert.equal(originMatchesProfile(local, 'http://127.0.0.1:18180'), true);
  assert.equal(originMatchesProfile(local, 'http://localhost:18180'), true);
  assert.equal(originMatchesProfile(local, 'https://www.hepsiburada.com'), false);
});

test('assertCartProfileAllowed keeps real Hepsiburada dry-run disabled until explicitly enabled', () => {
  const profiles = loadSiteProfiles({ profileDir: PROFILE_DIR });

  const local = assertCartProfileAllowed({
    profiles,
    profileId: 'localTest.ecommerce.v1',
    origin: 'http://127.0.0.1:18180'
  });
  assert.equal(local.ok, true);
  assert.equal(local.profile.id, 'localTest.ecommerce.v1');

  const hepsiburada = assertCartProfileAllowed({
    profiles,
    profileId: 'hepsiburada.shopping.v1',
    origin: 'https://www.hepsiburada.com'
  });
  assert.equal(hepsiburada.ok, false);
  assert.equal(hepsiburada.error.code, 'SITE_PROFILE_UNAVAILABLE');
  assert.equal(hepsiburada.error.reason, 'REAL_SITE_PROFILE_DISABLED');
});

test('assertCartProfileAllowed rejects unknown profiles and origin mismatches', () => {
  const profiles = loadSiteProfiles({ profileDir: PROFILE_DIR });

  const unknown = assertCartProfileAllowed({
    profiles,
    profileId: 'missing.profile',
    origin: 'http://127.0.0.1:18180'
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.reason, 'PROFILE_NOT_FOUND');

  const mismatch = assertCartProfileAllowed({
    profiles,
    profileId: 'localTest.ecommerce.v1',
    origin: 'https://www.hepsiburada.com'
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.reason, 'ORIGIN_NOT_ALLOWED');
});
