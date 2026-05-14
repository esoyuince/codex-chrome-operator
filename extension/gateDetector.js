(function initGateDetector(root) {
  'use strict';

  const DEFAULT_TIMEOUT_MS = 300000;

  const GATE_DEFINITIONS = [
    {
      type: 'PASSWORD_REQUIRED',
      label: 'password gate',
      fieldPattern: /\b(password|passwd|current-password|new-password)\b/i,
      textPattern: /\b(password|enter your password|confirm password)\b/i,
      recommendedUserAction: 'Complete the password prompt in Chrome.'
    },
    {
      type: 'OTP_REQUIRED',
      label: 'one-time-code gate',
      fieldPattern: /\b(otp|one[-\s]?time|verification[-\s]?code|authenticator|2fa|mfa)\b/i,
      textPattern: /\b(otp|one[-\s]?time code|verification code|authenticator app|2fa|two[-\s]?factor|mfa)\b/i,
      textRequiresField: true,
      recommendedUserAction: 'Enter the one-time code in Chrome.'
    },
    {
      type: 'WEBAUTHN_REQUIRED',
      label: 'passkey or security-key gate',
      textPattern: /\b(passkey|security key|webauthn|touch your key|biometric|fingerprint|face id)\b/i,
      recommendedUserAction: 'Complete the passkey or security-key prompt in Chrome.'
    },
    {
      type: 'CAPTCHA_REQUIRED',
      label: 'captcha gate',
      textPattern: /\b(captcha|recaptcha|hcaptcha|i am not a robot|i'm not a robot)\b/i,
      framePattern: /\b(captcha|recaptcha|hcaptcha)\b/i,
      recommendedUserAction: 'Complete the captcha challenge in Chrome.'
    },
    {
      type: 'PERMISSION_PROMPT_REQUIRED',
      label: 'permission prompt',
      textPattern: /\b(allow access|grant permission|browser permission|site permission|permission prompt)\b/i,
      recommendedUserAction: 'Review and complete the permission prompt in Chrome.'
    },
    {
      type: 'PAYMENT_AUTH_REQUIRED',
      label: 'payment authentication gate',
      textPattern: /\b(3[-\s]?d secure|payment authentication|bank verification|card verification|approve this payment)\b/i,
      recommendedUserAction: 'Complete the payment authentication step in Chrome.'
    },
    {
      type: 'IDENTITY_VERIFICATION_REQUIRED',
      label: 'identity verification gate',
      textPattern: /\b(verify your identity|identity verification|government id|upload id|confirm your identity)\b/i,
      recommendedUserAction: 'Complete the identity verification step in Chrome.'
    },
    {
      type: 'ANTI_ABUSE_CHALLENGE_REQUIRED',
      label: 'anti-abuse challenge',
      textPattern: /\b(suspicious activity|unusual traffic|verify you are human|prove you are human|security challenge)\b/i,
      recommendedUserAction: 'Complete the anti-abuse challenge in Chrome.'
    },
    {
      type: 'ACCOUNT_SECURITY_REAUTH_REQUIRED',
      label: 'account-security reauthentication gate',
      textPattern: /\b(re[-\s]?authenticate|account security|confirm it'?s you|security checkup|sensitive action)\b/i,
      recommendedUserAction: 'Complete the account security check in Chrome.'
    },
    {
      type: 'AUTH_REQUIRED',
      label: 'authentication gate',
      fieldPattern: /\b(username|login|signin|sign-in)\b/i,
      textPattern: /\b(sign in|log in|login required|authentication required|continue to sign in)\b/i,
      recommendedUserAction: 'Sign in through the site in Chrome.'
    }
  ];

  function normalize(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function limit(value, maxLength) {
    return normalize(value).slice(0, maxLength);
  }

  function fieldText(field) {
    return [
      field.tag,
      field.type,
      field.name,
      field.id,
      field.placeholder,
      field.label,
      field.autocomplete,
      field.ariaLabel,
      field.inputMode
    ].map(normalize).filter(Boolean).join(' ');
  }

  function frameText(frame) {
    return [
      frame.title,
      frame.name,
      frame.id,
      frame.src
    ].map(normalize).filter(Boolean).join(' ');
  }

  function hasAuthField(fields) {
    return fields.some((field) => (
      /\b(email|username|login|signin|sign-in|password)\b/i.test(fieldText(field)) ||
      field.type === 'password'
    ));
  }

  function buildGate(definition, evidence, visibleTextSummary) {
    return {
      type: definition.type,
      code: definition.type,
      message: `A ${definition.label} is visible. Please complete it in Chrome; the operator will resume after the page changes.`,
      visiblePageSummary: visibleTextSummary,
      recommendedUserAction: definition.recommendedUserAction,
      resumePolicy: 'wait-and-reobserve',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      taskStatePreserved: true,
      freshObservationRequired: true,
      evidence
    };
  }

  function detectGatesFromSnapshot(snapshot = {}) {
    const visibleText = normalize(snapshot.visibleText || '');
    const visibleTextSummary = limit(visibleText, 500);
    const fields = Array.isArray(snapshot.fields) ? snapshot.fields : [];
    const frames = Array.isArray(snapshot.frames) ? snapshot.frames : [];
    const detected = [];
    const seen = new Set();
    const authFieldPresent = hasAuthField(fields);

    for (const definition of GATE_DEFINITIONS) {
      let evidence = null;
      const matchingField = definition.fieldPattern
        ? fields.find((candidate) => definition.fieldPattern.test(fieldText(candidate)))
        : null;

      if (
        definition.textPattern &&
        definition.textPattern.test(visibleText) &&
        (definition.type !== 'AUTH_REQUIRED' || authFieldPresent) &&
        (!definition.textRequiresField || matchingField)
      ) {
        evidence = { source: 'visibleText' };
      }

      if (!evidence && matchingField) {
        evidence = {
          source: 'field',
          tag: matchingField.tag || null,
          type: matchingField.type || null,
          name: matchingField.name || null,
          id: matchingField.id || null
        };
      }

      if (!evidence && definition.framePattern) {
        const frame = frames.find((candidate) => definition.framePattern.test(frameText(candidate)));
        if (frame) {
          evidence = {
            source: 'frame',
            title: frame.title || null,
            id: frame.id || null
          };
        }
      }

      if (
        definition.type === 'AUTH_REQUIRED' &&
        ['PASSWORD_REQUIRED', 'OTP_REQUIRED', 'WEBAUTHN_REQUIRED'].some((type) => seen.has(type))
      ) {
        continue;
      }

      if (evidence && !seen.has(definition.type)) {
        seen.add(definition.type);
        detected.push(buildGate(definition, evidence, visibleTextSummary));
      }
    }

    return detected;
  }

  function visible(element) {
    if (!element || !element.ownerDocument || !element.ownerDocument.defaultView) {
      return false;
    }
    const view = element.ownerDocument.defaultView;
    const style = view.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      rect.width > 0 &&
      rect.height > 0;
  }

  function closestLabelText(element) {
    if (!element) {
      return '';
    }
    if (element.id) {
      const label = element.ownerDocument.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (label) {
        return label.innerText || '';
      }
    }
    const parentLabel = element.closest('label');
    return parentLabel ? parentLabel.innerText || '' : '';
  }

  function collectGateSnapshot(doc) {
    const fields = [...doc.querySelectorAll('input, textarea, select')]
      .filter(visible)
      .map((field) => ({
        tag: field.tagName.toLowerCase(),
        type: field.getAttribute('type') || null,
        name: field.getAttribute('name') || null,
        id: field.id || null,
        placeholder: field.getAttribute('placeholder') || null,
        label: closestLabelText(field),
        autocomplete: field.getAttribute('autocomplete') || null,
        ariaLabel: field.getAttribute('aria-label') || null,
        inputMode: field.getAttribute('inputmode') || null
      }));
    const frames = [...doc.querySelectorAll('iframe')]
      .filter(visible)
      .map((frame) => ({
        title: frame.getAttribute('title') || null,
        name: frame.getAttribute('name') || null,
        id: frame.id || null,
        src: frame.getAttribute('src') || null
      }));

    return {
      visibleText: doc.body ? doc.body.innerText : '',
      fields,
      frames
    };
  }

  function detectGates(doc) {
    return detectGatesFromSnapshot(collectGateSnapshot(doc));
  }

  function firstGateError(gates) {
    const gate = Array.isArray(gates) ? gates[0] : null;
    if (!gate) {
      return null;
    }
    return {
      code: gate.code,
      message: gate.message,
      gateType: gate.type,
      visiblePageSummary: gate.visiblePageSummary,
      recommendedUserAction: gate.recommendedUserAction,
      resumePolicy: gate.resumePolicy,
      timeoutMs: gate.timeoutMs,
      taskStatePreserved: gate.taskStatePreserved,
      freshObservationRequired: gate.freshObservationRequired
    };
  }

  const api = {
    detectGatesFromSnapshot,
    collectGateSnapshot,
    detectGates,
    firstGateError
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    return;
  }

  root.CodexGateDetector = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
