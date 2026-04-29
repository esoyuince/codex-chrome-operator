(function initPermissionOrigins(root) {
  'use strict';

  function permissionPatternToOrigin(pattern) {
    if (typeof pattern !== 'string' || pattern === '<all_urls>') {
      return null;
    }

    const match = /^(https?):\/\/([^/*]+)\/\*$/.exec(pattern);
    if (!match || match[2].includes('*')) {
      return null;
    }

    return `${match[1]}://${match[2]}`;
  }

  function permissionPatternsToOrigins(patterns) {
    const origins = new Set();
    for (const pattern of patterns || []) {
      const origin = permissionPatternToOrigin(pattern);
      if (origin) {
        origins.add(origin);
      }
    }
    return [...origins];
  }

  const api = {
    permissionPatternToOrigin,
    permissionPatternsToOrigins
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    return;
  }

  root.CodexPermissionOrigins = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
