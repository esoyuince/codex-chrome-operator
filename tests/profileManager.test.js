const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildProfileSetupUrl,
  discoverChromeProfiles
} = require('../operator-daemon/profileManager');

function writePreferences(profileDir, label) {
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'Preferences'), JSON.stringify({
    profile: { name: label }
  }), 'utf8');
}

test('discoverChromeProfiles returns profile directories with labels', () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-chrome-user-data-'));
  writePreferences(path.join(userDataDir, 'Default'), 'Work');
  writePreferences(path.join(userDataDir, 'Profile 1'), 'Play Console');
  fs.mkdirSync(path.join(userDataDir, 'Crashpad'), { recursive: true });

  const profiles = discoverChromeProfiles({ userDataDir });

  assert.deepEqual(profiles.map((profile) => ({
    profileDirectory: profile.profileDirectory,
    profileLabel: profile.profileLabel,
    userDataDir: profile.userDataDir
  })), [
    {
      profileDirectory: 'Default',
      profileLabel: 'Work',
      userDataDir
    },
    {
      profileDirectory: 'Profile 1',
      profileLabel: 'Play Console',
      userDataDir
    }
  ]);
});

test('buildProfileSetupUrl includes binding id and version', () => {
  const url = buildProfileSetupUrl({
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    profileBindingId: 'profbind_abc',
    profileBindingVersion: 7
  });

  assert.equal(
    url,
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/profileSetup.html?profileBindingId=profbind_abc&profileBindingVersion=7'
  );
});
