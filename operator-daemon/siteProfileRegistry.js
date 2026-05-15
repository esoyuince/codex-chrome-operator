'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ERROR_CODES } = require('./protocol');

const REQUIRED_CART_BLOCKED_ACTIONS = Object.freeze([
  'checkout',
  'payment',
  'order-placement',
  'address-change'
]);

const REQUIRED_CART_EVIDENCE = Object.freeze([
  'product-card-extraction',
  'detail-recheck',
  'cart-verification',
  'checkout-blocked'
]);

function defaultSiteProfileDir() {
  return path.resolve(__dirname, '..', 'siteProfiles');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function loadJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function validationError(file, message) {
  const error = new Error(`${path.basename(file)}: ${message}`);
  error.code = 'SITE_PROFILE_INVALID';
  return error;
}

function requireString(profile, file, field) {
  if (typeof profile[field] !== 'string' || !profile[field].trim()) {
    throw validationError(file, `${field} must be a non-empty string.`);
  }
}

function requireBoolean(profile, file, field) {
  if (typeof profile[field] !== 'boolean') {
    throw validationError(file, `${field} must be a boolean.`);
  }
}

function requireStringArray(profile, file, field) {
  if (!Array.isArray(profile[field]) || profile[field].some((item) => typeof item !== 'string' || !item.trim())) {
    throw validationError(file, `${field} must be an array of non-empty strings.`);
  }
}

function normalizeProfile(profile, file) {
  if (!isPlainObject(profile)) {
    throw validationError(file, 'profile must be an object.');
  }

  requireString(profile, file, 'id');
  requireString(profile, file, 'kind');
  requireString(profile, file, 'displayName');
  requireBoolean(profile, file, 'enabled');
  requireBoolean(profile, file, 'realSiteEnabled');
  requireStringArray(profile, file, 'origins');
  requireStringArray(profile, file, 'originPatterns');

  if (profile.kind !== 'ecommerce-cart-preparation') {
    throw validationError(file, 'kind must be ecommerce-cart-preparation.');
  }
  if (!isPlainObject(profile.riskPolicy)) {
    throw validationError(file, 'riskPolicy must be an object.');
  }
  if (profile.riskPolicy.allowAddToCart !== true) {
    throw validationError(file, 'riskPolicy.allowAddToCart must be true.');
  }
  requireStringArray(profile.riskPolicy, file, 'blockedActionKinds');
  for (const action of REQUIRED_CART_BLOCKED_ACTIONS) {
    if (!profile.riskPolicy.blockedActionKinds.includes(action)) {
      throw validationError(file, `riskPolicy.blockedActionKinds must include ${action}.`);
    }
  }
  if (profile.riskPolicy.stopAfter !== 'cart-verification') {
    throw validationError(file, 'riskPolicy.stopAfter must be cart-verification.');
  }
  requireStringArray(profile, file, 'evidenceRequirements');
  for (const evidence of REQUIRED_CART_EVIDENCE) {
    if (!profile.evidenceRequirements.includes(evidence)) {
      throw validationError(file, `evidenceRequirements must include ${evidence}.`);
    }
  }

  return {
    ...profile,
    id: profile.id.trim(),
    kind: profile.kind.trim(),
    displayName: profile.displayName.trim(),
    origins: profile.origins.map((origin) => origin.trim()),
    originPatterns: profile.originPatterns.map((origin) => origin.trim()),
    localOnly: profile.localOnly === true
  };
}

function loadSiteProfiles({ profileDir = defaultSiteProfileDir() } = {}) {
  const files = fs.readdirSync(profileDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.join(profileDir, name));
  const profiles = files.map((file) => normalizeProfile(loadJsonFile(file), file));
  const byId = new Map();
  for (const profile of profiles) {
    if (byId.has(profile.id)) {
      throw validationError(profile.id, 'duplicate profile id.');
    }
    byId.set(profile.id, profile);
  }
  return {
    profileDir,
    profiles,
    byId
  };
}

function patternMatches(pattern, origin) {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`).test(origin);
}

function originMatchesProfile(profile, origin) {
  if (!profile || typeof origin !== 'string') {
    return false;
  }
  const normalizedOrigin = origin.trim();
  if (profile.origins.includes(normalizedOrigin)) {
    return true;
  }
  return profile.originPatterns.some((pattern) => patternMatches(pattern, normalizedOrigin));
}

function siteProfileError(reason, message, extra = {}) {
  return {
    ok: false,
    error: {
      code: ERROR_CODES.SITE_PROFILE_UNAVAILABLE,
      message,
      reason,
      ...extra
    }
  };
}

function assertCartProfileAllowed({ profiles, profileId, origin }) {
  const registry = profiles && profiles.byId ? profiles : loadSiteProfiles();
  const profile = registry.byId.get(profileId);
  if (!profile) {
    return siteProfileError('PROFILE_NOT_FOUND', 'Requested cart site profile is not installed.', {
      profileId
    });
  }
  if (profile.enabled !== true) {
    return siteProfileError('PROFILE_DISABLED', 'Requested cart site profile is disabled.', {
      profileId
    });
  }
  if (profile.kind !== 'ecommerce-cart-preparation') {
    return siteProfileError('PROFILE_KIND_UNSUPPORTED', 'Requested site profile does not support cart preparation.', {
      profileId,
      kind: profile.kind
    });
  }
  if (!originMatchesProfile(profile, origin)) {
    return siteProfileError('ORIGIN_NOT_ALLOWED', 'Requested origin is not allowed by the cart site profile.', {
      profileId,
      origin
    });
  }
  if (profile.realSiteEnabled === false && profile.localOnly !== true) {
    return siteProfileError('REAL_SITE_PROFILE_DISABLED', 'Real-site cart preparation is disabled until site-profile tests pass.', {
      profileId,
      origin
    });
  }
  return {
    ok: true,
    profile
  };
}

module.exports = {
  assertCartProfileAllowed,
  defaultSiteProfileDir,
  loadSiteProfiles,
  originMatchesProfile
};
