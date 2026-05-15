const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  buildReleaseChecks,
  extractCleanSmokeEvidence,
  extractDynamicDomSmokeEvidence,
  runReleaseCheck,
  tailText
} = require('../scripts/m1-release-check');

test('buildReleaseChecks includes M1 release gates and keeps clean smoke opt-in', () => {
  const checks = buildReleaseChecks({ includeSmoke: false });
  assert.deepEqual(checks.map((check) => check.name), [
    'unit-tests',
    'syntax-check',
    'mcp-smoke',
    'dynamic-dom-smoke',
    'daemon-doctor',
    'install-doctor-no-install-check'
  ]);
  assert.deepEqual(buildReleaseChecks({ includeSmoke: true }).map((check) => check.name), [
    'unit-tests',
    'syntax-check',
    'mcp-smoke',
    'dynamic-dom-smoke',
    'daemon-doctor',
    'install-doctor-no-install-check',
    'clean-smoke'
  ]);

  assert.equal(checks[0].command, process.execPath);
  assert.equal(checks[1].command, process.execPath);
  assert.equal(checks[2].command, process.execPath);
  assert.equal(checks[0].args[0], '--test');
  assert.equal(checks[2].args[0], path.join('scripts', 'mcp-smoke.js'));
  assert.equal(checks[3].args[0], path.join('scripts', 'dynamic-dom-smoke.js'));
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
    'dynamic-dom-smoke',
    'daemon-doctor',
    'install-doctor-no-install-check',
    'clean-smoke'
  ]);
  assert.equal(report.ok, false);
  assert.equal(report.failedChecks, 1);
  assert.equal(report.checks.length, 7);
  assert.equal(report.checks[4].name, 'daemon-doctor');
  assert.equal(report.checks[4].ok, false);
  assert.equal(report.checks[4].stderrTail, 'doctor failed');
});

test('extractCleanSmokeEvidence summarizes live browser proof without full daemon state', () => {
  const evidence = extractCleanSmokeEvidence(JSON.stringify({
    ok: true,
    extensionId: 'fgkcpjfdphcpihkpbkjnhcdijocihiod',
    origin: 'http://127.0.0.1:18180',
    prepareOriginReady: true,
    prepareOriginRequiresUserGesture: false,
    waitReadyAfterSettings: true,
    blockedByUserSettings: 'SITE_BLOCKED_BY_USER_SETTINGS',
    openObserveTitle: 'Codex Operator Basic Fixture',
    visualScreenshotArtifactId: 'shot_1',
    visualScreenshotBytes: 2048,
    visualAnalyzeProvider: 'local-basic',
    visualAnalyzeStatus: 'analyzed',
    visualAnalyzeArtifactId: 'shot_2',
    visualAnalyzeRegions: ['product-card', 'rating-stars'],
    visualAnalyzeCorrelations: 6,
    sensitiveVisualBlocked: 'VISUAL_PROVIDER_POLICY_BLOCKED',
    sensitiveVisualReason: 'SENSITIVE_VISUAL_CONTENT',
    gatedVisualBlocked: 'VISUAL_PROVIDER_POLICY_BLOCKED',
    gateHandoffBlocked: 'PASSWORD_REQUIRED',
    gateHandoffResume: 'Gate resumed',
    emergencyBlocked: 'EMERGENCY_STOPPED',
    emergencyCleared: true,
    postEmergencyObservedTitle: 'Codex Operator Basic Fixture',
    boundedFullAutoStarted: true,
    boundedFullAutoActions: 4,
    boundedFullAutoStopped: true,
    boundedFullAutoAudited: true,
    mockPlayUploadPreviewVerified: true,
    mockPlayPreviewEvidenceChanged: true,
    mockPlayPreviewEvidenceMethod: 'dom-preview-snapshot',
    mockPlayUploadStatus: 'uploaded',
    mockPlayUploadRole: 'playStoreAppIcon',
    invalidAssetBlocked: 'ASSET_DIMENSION_MISMATCH',
    mockPlaySendForReviewBlocked: 'HIGH_RISK_BLOCKED',
    mockCommerceSelectedProductId: 'mac-mini-eligible-base',
    mockCommerceSelectedPrice: 24999,
    mockCommerceSelectedSellerRating: 4.5,
    mockCommerceCartVerified: true,
    mockCommerceStoppedBeforeCheckout: true,
    mockCommerceCheckoutBlocked: 'HIGH_RISK_BLOCKED',
    mockCommerceExcludedReasons: ['seller-rating-below-threshold', 'out-of-stock'],
    dynamicRuntimeTabTitle: 'Codex Operator Dynamic DOM Fixture',
    dynamicRuntimeReadContainsControlledValue: true,
    dynamicRuntimeStaleRecovery: 'target-contract',
    dynamicRuntimeClickVerified: true,
    dynamicRuntimeDialogOpened: true,
    dynamicRuntimeDialogHandled: true,
    dynamicRuntimeControlledValue: 'Runtime tab smoke',
    dynamicRuntimeControlledVerified: true,
    dynamicRuntimeScrollY: 620,
    dynamicRuntimeScrolled: true,
    concurrentTwoTabOk: true,
    concurrentTwoTabAgents: [{
      agentId: 'agent-alpha',
      tabId: 101,
      readContainsAgentId: true,
      fillVerified: true,
      clickVerified: true,
      dialogOpened: true,
      dialogClosed: true,
      scrolled: true
    }, {
      agentId: 'agent-beta',
      tabId: 102,
      readContainsAgentId: true,
      fillVerified: true,
      clickVerified: true,
      dialogOpened: true,
      dialogClosed: true,
      scrolled: true
    }],
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
    prepareOriginReady: true,
    prepareOriginRequiresUserGesture: false,
    blockedByUserSettings: 'SITE_BLOCKED_BY_USER_SETTINGS',
    settingsReady: true,
    openObserveTitle: 'Codex Operator Basic Fixture',
    visualScreenshotArtifactId: 'shot_1',
    visualScreenshotBytes: 2048,
    visualAnalyzeProvider: 'local-basic',
    visualAnalyzeStatus: 'analyzed',
    visualAnalyzeArtifactId: 'shot_2',
    visualAnalyzeRegions: ['product-card', 'rating-stars'],
    visualAnalyzeCorrelations: 6,
    sensitiveVisualBlocked: 'VISUAL_PROVIDER_POLICY_BLOCKED',
    sensitiveVisualReason: 'SENSITIVE_VISUAL_CONTENT',
    gatedVisualBlocked: 'VISUAL_PROVIDER_POLICY_BLOCKED',
    gateHandoffBlocked: 'PASSWORD_REQUIRED',
    gateHandoffResume: 'Gate resumed',
    emergencyBlocked: 'EMERGENCY_STOPPED',
    emergencyCleared: true,
    postEmergencyObservedTitle: 'Codex Operator Basic Fixture',
    boundedFullAutoStarted: true,
    boundedFullAutoActions: 4,
    boundedFullAutoStopped: true,
    boundedFullAutoAudited: true,
    mockPlayUploadPreviewVerified: true,
    mockPlayPreviewEvidenceChanged: true,
    mockPlayPreviewEvidenceMethod: 'dom-preview-snapshot',
    mockPlayUploadStatus: 'uploaded',
    mockPlayUploadRole: 'playStoreAppIcon',
    invalidAssetBlocked: 'ASSET_DIMENSION_MISMATCH',
    mockPlaySendForReviewBlocked: 'HIGH_RISK_BLOCKED',
    mockCommerceSelectedProductId: 'mac-mini-eligible-base',
    mockCommerceSelectedPrice: 24999,
    mockCommerceSelectedSellerRating: 4.5,
    mockCommerceCartVerified: true,
    mockCommerceStoppedBeforeCheckout: true,
    mockCommerceCheckoutBlocked: 'HIGH_RISK_BLOCKED',
    mockCommerceExcludedReasons: ['seller-rating-below-threshold', 'out-of-stock'],
    dynamicRuntimeTabTitle: 'Codex Operator Dynamic DOM Fixture',
    dynamicRuntimeReadContainsControlledValue: true,
    dynamicRuntimeStaleRecovery: 'target-contract',
    dynamicRuntimeClickVerified: true,
    dynamicRuntimeDialogOpened: true,
    dynamicRuntimeDialogHandled: true,
    dynamicRuntimeControlledValue: 'Runtime tab smoke',
    dynamicRuntimeControlledVerified: true,
    dynamicRuntimeScrollY: 620,
    dynamicRuntimeScrolled: true,
    concurrentTwoTabOk: true,
    concurrentTwoTabAgents: [{
      agentId: 'agent-alpha',
      tabId: 101,
      readContainsAgentId: true,
      fillVerified: true,
      clickVerified: true,
      dialogOpened: true,
      dialogClosed: true,
      scrolled: true
    }, {
      agentId: 'agent-beta',
      tabId: 102,
      readContainsAgentId: true,
      fillVerified: true,
      clickVerified: true,
      dialogOpened: true,
      dialogClosed: true,
      scrolled: true
    }],
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
          waitReadyAfterSettings: true,
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
    settingsReady: true
  });
  assert.equal(report.checks[0].evidence, undefined);
});

test('runReleaseCheck attaches compact MCP contract evidence when the MCP smoke gate succeeds', () => {
  const mcpSmokeOutput = {
    ok: true,
    serverName: 'codex-chrome-operator',
    toolDefinitionsHash: 'b'.repeat(64),
    toolCount: 14,
    toolSchemaVersion: '2026-05-15.operator-maturity',
    strictSchemaToolCount: 14,
    contractPinned: true,
    requiredTools: ['codex_chrome_status'],
    missingTools: [],
    rawScreenshotBytesAllowed: [],
    untrustedOutputMissing: [],
    tools: [{ name: 'codex_chrome_status', inputSchema: { type: 'object' } }]
  };
  const report = runReleaseCheck({
    runner: (check) => ({
      status: 0,
      stdout: check.name === 'mcp-smoke'
        ? JSON.stringify(mcpSmokeOutput)
        : `${check.name} ok`,
      stderr: ''
    })
  });

  const mcpSmoke = report.checks.find((check) => check.name === 'mcp-smoke');
  assert.equal(mcpSmoke.ok, true);
  assert.deepEqual(mcpSmoke.evidence, {
    toolDefinitionsHash: 'b'.repeat(64),
    toolCount: 14,
    toolSchemaVersion: '2026-05-15.operator-maturity',
    strictSchemaToolCount: 14,
    contractPinned: true
  });
  assert.equal(Object.hasOwn(mcpSmoke.evidence, 'tools'), false);
  assert.equal(Object.hasOwn(mcpSmoke.evidence, 'requiredTools'), false);
});

test('runReleaseCheck attaches compact dynamic DOM evidence when the smoke gate succeeds', () => {
  const dynamicDomOutput = {
    ok: true,
    smoke: 'dynamic-dom',
    quietMs: 120,
    elapsedMs: 200,
    mutationBursts: 2,
    lastMutationAtMs: 80,
    settledAfterLastMutationMs: 120,
    finalState: {
      type: 'domQuiet',
      quietForMs: 120,
      mutationCounter: 2
    }
  };
  const report = runReleaseCheck({
    runner: (check) => ({
      status: 0,
      stdout: check.name === 'dynamic-dom-smoke'
        ? JSON.stringify(dynamicDomOutput)
        : `${check.name} ok`,
      stderr: ''
    })
  });

  const dynamicDomSmoke = report.checks.find((check) => check.name === 'dynamic-dom-smoke');
  assert.equal(dynamicDomSmoke.ok, true);
  assert.deepEqual(dynamicDomSmoke.evidence, {
    ok: true,
    quietMs: 120,
    elapsedMs: 200,
    mutationBursts: 2,
    lastMutationAtMs: 80,
    settledAfterLastMutationMs: 120,
    finalQuietForMs: 120,
    finalMutationCounter: 2
  });
});

test('extractDynamicDomSmokeEvidence ignores invalid JSON output', () => {
  assert.equal(extractDynamicDomSmokeEvidence('not json'), null);
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
