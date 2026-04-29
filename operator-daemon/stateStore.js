'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function defaultStatePath() {
  return path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'CodexChromeOperator',
    'state.json'
  );
}

function emptyState() {
  return {
    version: 1,
    domainApprovals: {},
    hostPermissions: {},
    configuredProfile: null
  };
}

class OperatorStateStore {
  constructor({ statePath = defaultStatePath() } = {}) {
    this.statePath = statePath;
    this.state = this.load();
  }

  load() {
    if (!fs.existsSync(this.statePath)) {
      return emptyState();
    }
    const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    return {
      ...emptyState(),
      ...parsed,
      domainApprovals: parsed.domainApprovals || {},
      hostPermissions: parsed.hostPermissions || {},
      configuredProfile: parsed.configuredProfile || null
    };
  }

  save() {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tempPath = `${this.statePath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, this.statePath);
  }

  approveDomain(origin, metadata = {}) {
    const approval = {
      origin,
      mode: metadata.mode || 'guarded',
      taskScope: metadata.taskScope || null,
      expiresAt: metadata.expiresAt || null
    };
    this.state.domainApprovals[origin] = approval;
    this.save();
    return approval;
  }

  getDomainApproval(origin) {
    return this.state.domainApprovals[origin] || null;
  }

  listDomainApprovals() {
    return { ...this.state.domainApprovals };
  }

  grantHostPermission(origin, metadata = {}) {
    const permission = {
      origin,
      profileBindingId: metadata.profileBindingId || null,
      grantedAt: metadata.grantedAt || new Date().toISOString()
    };
    this.state.hostPermissions[origin] = permission;
    this.save();
    return permission;
  }

  syncHostPermissions({ profileBindingId, origins, syncedAt = new Date().toISOString() }) {
    const originSet = new Set(origins);
    for (const [origin, permission] of Object.entries(this.state.hostPermissions)) {
      if (permission.profileBindingId === profileBindingId && !originSet.has(origin)) {
        delete this.state.hostPermissions[origin];
      }
    }

    for (const origin of originSet) {
      const existing = this.state.hostPermissions[origin];
      this.state.hostPermissions[origin] = {
        origin,
        profileBindingId,
        grantedAt: existing && existing.profileBindingId === profileBindingId
          ? existing.grantedAt
          : syncedAt
      };
    }

    this.save();
    return Object.fromEntries(
      Object.entries(this.state.hostPermissions)
        .filter(([, permission]) => permission.profileBindingId === profileBindingId)
    );
  }

  getHostPermission(origin) {
    return this.state.hostPermissions[origin] || null;
  }

  listHostPermissions() {
    return { ...this.state.hostPermissions };
  }

  setConfiguredProfile(profile) {
    this.state.configuredProfile = {
      userDataDir: profile.userDataDir,
      profileDirectory: profile.profileDirectory,
      profileLabel: profile.profileLabel || null,
      profileBindingId: profile.profileBindingId,
      profileBindingVersion: profile.profileBindingVersion
    };
    this.save();
    return this.state.configuredProfile;
  }

  getConfiguredProfile() {
    return this.state.configuredProfile;
  }
}

module.exports = {
  OperatorStateStore,
  defaultStatePath
};
