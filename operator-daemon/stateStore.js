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
    blockedOrigins: [],
    configuredProfile: null
  };
}

function normalizeConfiguredProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    return null;
  }
  return {
    userDataDir: profile.userDataDir,
    profileDirectory: profile.profileDirectory,
    profileLabel: profile.profileLabel || null
  };
}

function normalizeHostPermissions(hostPermissions) {
  if (!hostPermissions || typeof hostPermissions !== 'object') {
    return {};
  }
  return Object.fromEntries(
    Object.entries(hostPermissions)
      .map(([origin, permission]) => {
        if (!origin || !permission || typeof permission !== 'object') {
          return null;
        }
        const normalized = {
          origin: permission.origin || origin,
          grantedAt: permission.grantedAt || null
        };
        return [origin, normalized];
      })
      .filter(Boolean)
  );
}

function normalizeBlockedPattern(pattern) {
  if (typeof pattern !== 'string') {
    return null;
  }
  const value = pattern.trim().toLowerCase();
  if (!value) {
    return null;
  }
  if (value.startsWith('*.') && value.length > 2) {
    return value.replace(/\/+$/, '');
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return url.origin;
      }
    } catch {
      return null;
    }
  }
  return value.replace(/\/+$/, '');
}

function blockedPatternMatchesOrigin(pattern, origin) {
  if (!pattern || !origin) {
    return false;
  }
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  const normalizedPattern = normalizeBlockedPattern(pattern);
  if (!normalizedPattern) {
    return false;
  }
  const originValue = url.origin.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  const host = url.host.toLowerCase();

  if (normalizedPattern.includes('://')) {
    return originValue === normalizedPattern;
  }
  if (normalizedPattern.startsWith('*.')) {
    const suffix = normalizedPattern.slice(2);
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }
  if (normalizedPattern.includes(':')) {
    return host === normalizedPattern;
  }
  return hostname === normalizedPattern;
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
      hostPermissions: normalizeHostPermissions(parsed.hostPermissions),
      blockedOrigins: Array.isArray(parsed.blockedOrigins) ? parsed.blockedOrigins : [],
      configuredProfile: normalizeConfiguredProfile(parsed.configuredProfile)
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

  isDomainApproved(origin, { now = new Date() } = {}) {
    const approval = this.getDomainApproval(origin);
    if (!approval) {
      return false;
    }
    if (!approval.expiresAt) {
      return true;
    }

    const expiresAtMs = Date.parse(approval.expiresAt);
    return Number.isFinite(expiresAtMs) && expiresAtMs > now.getTime();
  }

  listActiveDomainApprovals({ now = new Date() } = {}) {
    return Object.fromEntries(
      Object.entries(this.state.domainApprovals)
        .filter(([origin]) => this.isDomainApproved(origin, { now }))
    );
  }

  revokeDomain(origin) {
    if (!this.state.domainApprovals[origin]) {
      return false;
    }
    delete this.state.domainApprovals[origin];
    this.save();
    return true;
  }

  grantHostPermission(origin, metadata = {}) {
    const permission = {
      origin,
      grantedAt: metadata.grantedAt || new Date().toISOString()
    };
    this.state.hostPermissions[origin] = permission;
    this.save();
    return permission;
  }

  syncHostPermissions({ origins, syncedAt = new Date().toISOString() }) {
    const originSet = new Set(origins);
    for (const origin of Object.keys(this.state.hostPermissions)) {
      if (!originSet.has(origin)) {
        delete this.state.hostPermissions[origin];
      }
    }

    for (const origin of originSet) {
      const existing = this.state.hostPermissions[origin];
      this.state.hostPermissions[origin] = {
        origin,
        grantedAt: existing ? existing.grantedAt : syncedAt
      };
    }

    this.save();
    return this.listHostPermissions();
  }

  getHostPermission(origin) {
    return this.state.hostPermissions[origin] || null;
  }

  listHostPermissions() {
    return { ...this.state.hostPermissions };
  }

  setBlockedOrigins(patterns = []) {
    const normalized = Array.isArray(patterns)
      ? patterns
        .map((pattern) => normalizeBlockedPattern(pattern))
        .filter(Boolean)
      : [];
    this.state.blockedOrigins = [...new Set(normalized)].sort();
    this.save();
    return this.listBlockedOrigins();
  }

  listBlockedOrigins() {
    return [...this.state.blockedOrigins].sort();
  }

  blockedOriginMatch(origin) {
    const pattern = this.listBlockedOrigins().find((entry) => blockedPatternMatchesOrigin(entry, origin));
    return pattern ? { origin, pattern } : null;
  }

  isOriginBlocked(origin) {
    return Boolean(this.blockedOriginMatch(origin));
  }

  setConfiguredProfile(profile) {
    this.state.configuredProfile = {
      userDataDir: profile.userDataDir,
      profileDirectory: profile.profileDirectory,
      profileLabel: profile.profileLabel || null
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
  defaultStatePath,
  normalizeBlockedPattern,
  blockedPatternMatchesOrigin
};
