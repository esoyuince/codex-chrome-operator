(function initActionPolicy(root) {
  'use strict';

  const HIGH_RISK_RULES = [
    { kind: 'publish', pattern: /\b(publish|submit|post|tweet|send|reply|yan[iı]tla|g[oö]nder|send\s+for\s+review|release|rollout)\b/i },
    { kind: 'payment', pattern: /\b(pay|payment|billing|subscribe|purchase)\b/i },
    { kind: 'checkout', pattern: /\b(checkout)\b/i },
    { kind: 'order-placement', pattern: /\b(place\s+order|order\s+now|submit\s+order)\b/i },
    { kind: 'delete', pattern: /\b(delete|remove|destroy)\b/i },
    { kind: 'permission-grant', pattern: /\b(grant\s+permission|allow\s+access)\b/i },
    { kind: 'account-security', pattern: /\b(password|2fa|two-factor|security)\b/i }
  ];

  function normalize(value) {
    return String(value || '').trim();
  }

  function targetText(target) {
    return [
      target.dataRisk,
      target.label,
      target.name,
      target.role
    ].map(normalize).filter(Boolean).join(' ');
  }

  function targetSummary(target) {
    const tag = normalize(target.tag || 'element');
    const label = normalize(target.label || target.id || target.name || target.dataRisk || '');
    return label ? `${tag}: ${label}` : tag;
  }

  function classifyActionRisk({ action, target } = {}) {
    if (action !== 'click' || !target) {
      return null;
    }

    const explicitRisk = normalize(target.dataRisk);
    if (explicitRisk) {
      return {
        blocked: true,
        code: 'HIGH_RISK_BLOCKED',
        approvalKind: explicitRisk,
        targetSummary: targetSummary(target),
        message: `High-risk action requires explicit approval: ${explicitRisk}`
      };
    }

    const text = targetText(target);
    const rule = HIGH_RISK_RULES.find((candidate) => candidate.pattern.test(text));
    if (!rule) {
      return null;
    }

    return {
      blocked: true,
      code: 'HIGH_RISK_BLOCKED',
      approvalKind: rule.kind,
      targetSummary: targetSummary(target),
      message: `High-risk action requires explicit approval: ${rule.kind}`
    };
  }

  const api = {
    classifyActionRisk
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    return;
  }

  root.CodexActionPolicy = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
