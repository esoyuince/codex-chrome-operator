'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function defaultChromeUserDataDir(env = process.env) {
  return path.join(
    env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'Google',
    'Chrome',
    'User Data'
  );
}

function readProfileLabel(preferencesPath, fallback) {
  try {
    const preferences = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
    return preferences.profile && preferences.profile.name
      ? preferences.profile.name
      : fallback;
  } catch {
    return fallback;
  }
}

function discoverChromeProfiles({ userDataDir = defaultChromeUserDataDir() } = {}) {
  if (!fs.existsSync(userDataDir)) {
    return [];
  }

  return fs.readdirSync(userDataDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const preferencesPath = path.join(userDataDir, entry.name, 'Preferences');
      if (!fs.existsSync(preferencesPath)) {
        return null;
      }
      return {
        userDataDir,
        profileDirectory: entry.name,
        profileLabel: readProfileLabel(preferencesPath, entry.name),
        profilePath: path.join(userDataDir, entry.name),
        preferencesPath
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.profileDirectory.localeCompare(right.profileDirectory));
}

function generateProfileBindingId() {
  return `profbind_${crypto.randomBytes(16).toString('base64url')}`;
}

function buildProfileSetupUrl({ extensionId, profileBindingId, profileBindingVersion }) {
  const params = new URLSearchParams({
    profileBindingId,
    profileBindingVersion: String(profileBindingVersion)
  });
  return `chrome-extension://${extensionId}/profileSetup.html?${params.toString()}`;
}

module.exports = {
  buildProfileSetupUrl,
  defaultChromeUserDataDir,
  discoverChromeProfiles,
  generateProfileBindingId
};
