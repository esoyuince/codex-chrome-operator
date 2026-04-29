const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  buildReleaseChecks,
  extractCleanSmokeEvidence,
  runReleaseCheck,
  tailText
} = require('../scripts/m1-release-check');

test('buildReleaseChecks includes M1 release gates and keeps clean smoke opt-in', () => {
  const checks = buildReleaseChecks({ includeSmoke: false });
  assert.deepEqual(checks.map((check) => check.name), [
    'unit-tests',
    'syntax-check',
    'mcp-smoke',
    'daemon-doctor',
    'install-doctor-no-install-check'
  ]);
  assert.deepEqual(buildReleaseChecks({ includeSmoke: true }).map((check) => check.name), [
    'unit-tests',
    'syntax-check',
    'mcp-smoke',
    'daemon-doctor',
    'install-doctor-no-install-check',
    'clean-smoke'
  ]);

  assert.equal(checks[0].command, process.execPath);
  assert.equal(checks[1].command, process.execPath);
  assert.equal(checks[2].command, process.execPath);
  assert.equal(checks[0].args[0], '--test');
  assert.equal(checks[2].args[0], path.join('scripts', 'mcp-smoke.js'));
  assert.ok(!checks.some((check) => /npm(?:\.cmd)?$/i.test(check.command)));
});

test('runReleaseCheck executes every gate and reports failures as JSON-safe data', () => {
  const calls = [];
  const report = runReleaseCheck({
    includeSmoke: true,
    now: (() => {
      let tick = 0;
      return () => new Date(Date.UTC(2026, 3, 29, 12, 0, tick++)).toISOString();
    })(),
    runner: (check) => {
      calls.push(check.name);
      if (check.name === 'daemon-doctor') {
        return {
          status: 1,
          stdout: '{"ok":false}',
          stderr: 'doctor failed'
        };
      }
      return {
        status: 0,
        stdout: `${check.name} ok`,
        stderr: ''
      };
    }
  });

  assert.deepEqual(calls, [
    'unit-tests',
    'syntax-check',
    'mcp-smoke',
    'daemon-doctor',
    'install-doctor-no-install-check',
    'clean-smoke'
  ]);
  assert.equal(report.ok, false);
  assert.equal(report.failedChecks, 1);
  assert.equal(report.checks.length, 6);
  assert.equal(report.checks[3].name, 'daemon-doctor');
  assert.equal(report.checks[3].ok, false);
  assert.equal(report.checks[3].stderrTail, 'doctor failed');
});

test('extractCleanSmokeEvidence summarizes live browser proof without full daemon state', () => {
  const evidence = extractCleanSmokeEvidence(JSON.stringify({
    ok: true,
    extensionId: 'fgkcpjfdphcpihkpbkjnhcdijocihiod',
    origin: 'http://127.0.0.1:18180',
    waitReadyAfterPermission: true,
    blockedBeforeHostPermission: 'HOST_PERMISSION_REQUIRED',
    openObserveTitle: 'Codex Operator Basic Fixture',
    visualScreenshotArtifactId: 'shot_1',
    visualScreenshotBytes: 2048,
    gatedVisualBlocked: 'VISUAL_PROVIDER_POLICY_BLOCKED',
    gateHandoffBlocked: 'PASSWORD_REQUIRED',
    gateHandoffResume: 'Gate resumed',
    emergencyBlocked: 'EMERGENCY_STOPPED',
    emergencyCleared: true,
    reconnectBlocked: 'EXTENSION_DISCONNECTED',
    reconnectRecoveredTitle: 'Codex Operator Basic Fixture',
    boundedFullAutoStarted: true,
    boundedFullAutoActions: 4,
    boundedFullAutoStopped: true,
    boundedFullAutoAudited: true,
    highRiskBlocked: 'HIGH_RISK_BLOCKED',
    highRiskApprovalReplay: 'clicked',
    screenshotCleanupRemoved: true,
    postRevokeBlocked: 'DOMAIN_NOT_APPROVED',
    basicDomActions: {
      locale: 'tr',
      enableBeta: true,
      status: 'Pressed Enter'
    },
    finalStatus: {
      profileVerified: true,
      connectionState: 'EXTENSION_CONNECTED',
      approvedOrigins: ['http://127.0.0.1:18180'],
      domainApprovals: {
        'http://127.0.0.1:18180': { origin: 'http://127.0.0.1:18180' }
      }
    }
  }));

  assert.deepEqual(evidence, {
    ok: true,
    extensionId: 'fgkcpjfdphcpihkpbkjnhcdijocihiod',
    origin: 'http://127.0.0.1:18180',
    profileVerified: true,
    connectionState: 'EXTENSION_CONNECTED',
    hostPermissionReady: true,
    blockedBeforeHostPermission: 'HOST_PERMISSION_REQUIRED',
    openObserveTitle: 'Codex Operator Basic Fixture',
    visualScreenshotArtifactId: 'shot_1',
    visualScreenshotBytes: 2048,
    gatedVisualBlocked: 'VISUAL_PROVIDER_POLICY_BLOCKED',
    gateHandoffBlocked: 'PASSWORD_REQUIRED',
    gateHandoffResume: 'Gate resumed',
    emergencyBlocked: 'EMERGENCY_STOPPED',
    emergencyCleared: true,
    reconnectBlocked: 'EXTENSION_DISCONNECTED',
    reconnectRecoveredTitle: 'Codex Operator Basic Fixture',
    boundedFullAutoStarted: true,
    boundedFullAutoActions: 4,
    boundedFullAutoStopped: true,
    boundedFullAutoAudited: true,
    highRiskBlocked: 'HIGH_RISK_BLOCKED',
    highRiskApprovalReplay: 'clicked',
    screenshotCleanupRemoved: true,
    postRevokeBlocked: 'DOMAIN_NOT_APPROVED',
    basicDomActions: {
      locale: 'tr',
      enableBeta: true,
      status: 'Pressed Enter'
    }
  });
});

test('runReleaseCheck attaches clean smoke evidence when the smoke gate succeeds', () => {
  const report = runReleaseCheck({
    includeSmoke: true,
    runner: (check) => ({
      status: 0,
      stdout: check.name === 'clean-smoke'
        ? JSON.stringify({
          ok: true,
          origin: 'http://127.0.0.1:18180',
          waitReadyAfterPermission: true,
          finalStatus: {
            profileVerified: true,
            connectionState: 'EXTENSION_CONNECTED'
          }
        })
        : `${check.name} ok`,
      stderr: ''
    })
  });

  const cleanSmoke = report.checks.find((check) => check.name === 'clean-smoke');
  assert.equal(cleanSmoke.ok, true);
  assert.deepEqual(cleanSmoke.evidence, {
    ok: true,
    origin: 'http://127.0.0.1:18180',
    profileVerified: true,
    connectionState: 'EXTENSION_CONNECTED',
    hostPermissionReady: true
  });
  assert.equal(report.checks[0].evidence, undefined);
});

test('runReleaseCheck fails closed when a process exits without a numeric status', () => {
  const report = runReleaseCheck({
    runner: () => ({
      status: null,
      stdout: '',
      stderr: '',
      signal: 'SIGTERM'
    })
  });

  assert.equal(report.ok, false);
  assert.equal(report.failedChecks, report.totalChecks);
  assert.equal(report.checks[0].status, 1);
});

test('tailText limits long command output without changing short output', () => {
  assert.equal(tailText('short', 20), 'short');
  assert.equal(tailText('0123456789abcdef', 6), 'abcdef');
});
