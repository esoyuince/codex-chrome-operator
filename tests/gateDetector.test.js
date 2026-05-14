const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectGatesFromSnapshot,
  firstGateError
} = require('../extension/gateDetector');

test('detectGatesFromSnapshot classifies password and OTP gates without secret values', () => {
  const gates = detectGatesFromSnapshot({
    visibleText: 'Sign in to continue. Enter the verification code from your authenticator app.',
    fields: [
      {
        tag: 'input',
        type: 'password',
        name: 'password',
        id: 'password',
        placeholder: 'Password',
        value: 'super-secret'
      },
      {
        tag: 'input',
        type: 'text',
        name: 'otp',
        id: 'otp',
        autocomplete: 'one-time-code',
        placeholder: '6-digit code',
        value: '123456'
      }
    ]
  });

  assert.deepEqual(gates.map((gate) => gate.type), [
    'PASSWORD_REQUIRED',
    'OTP_REQUIRED'
  ]);
  assert.equal(JSON.stringify(gates).includes('super-secret'), false);
  assert.equal(JSON.stringify(gates).includes('123456'), false);
});

test('detectGatesFromSnapshot classifies captcha and WebAuthn gates', () => {
  const gates = detectGatesFromSnapshot({
    visibleText: 'Use your passkey or security key. Complete the reCAPTCHA challenge.',
    frames: [
      {
        title: 'hCaptcha challenge',
        src: 'https://captcha.example/frame'
      }
    ]
  });

  assert.deepEqual(gates.map((gate) => gate.type), [
    'WEBAUTHN_REQUIRED',
    'CAPTCHA_REQUIRED'
  ]);
});

test('detectGatesFromSnapshot ignores auth phrases in normal feed content', () => {
  const gates = detectGatesFromSnapshot({
    visibleText: 'Sam Altman: you can sign in to openclaw with your chatgpt account now and use your subscription there!'
  });

  assert.deepEqual(gates.map((gate) => gate.type), []);
});

test('detectGatesFromSnapshot ignores Cloudflare Security Insights MFA report text without an OTP form', () => {
  const gates = detectGatesFromSnapshot({
    visibleText: [
      'Application security Security Insights',
      'Review and manage potential security risks and vulnerabilities in your IT infrastructure.',
      'Insights by severity Moderate 11 Low 5',
      'Top Insights Domains without HSTS Security.txt not configured Bot Fight Mode not enabled',
      'Users without MFA esoyuince@example.com Weak authentication 11 May, 2026 Details',
      'Scan now Disable Security Center scans'
    ].join(' ')
  });

  assert.deepEqual(gates.map((gate) => gate.type), []);
});

test('detectGatesFromSnapshot does not treat a contact email field as an auth gate', () => {
  const gates = detectGatesFromSnapshot({
    visibleText: 'Content ratings Category Email address This will be used to contact you about your content ratings. Other app types Terms and conditions Next',
    fields: [
      {
        tag: 'input',
        type: 'email',
        id: null,
        name: null,
        placeholder: null,
        label: ''
      }
    ]
  });

  assert.deepEqual(gates.map((gate) => gate.type), []);
});

test('firstGateError returns wait-and-reobserve handoff details', () => {
  const [gate] = detectGatesFromSnapshot({
    visibleText: 'Suspicious activity detected. Verify you are human to continue.'
  });
  const error = firstGateError([gate]);

  assert.equal(error.code, 'ANTI_ABUSE_CHALLENGE_REQUIRED');
  assert.equal(error.resumePolicy, 'wait-and-reobserve');
  assert.equal(error.freshObservationRequired, true);
  assert.equal(error.taskStatePreserved, true);
  assert.equal(error.timeoutMs, 300000);
  assert.match(error.message, /complete it in Chrome/i);
});
