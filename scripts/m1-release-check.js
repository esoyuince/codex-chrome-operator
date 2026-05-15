'use strict';

const childProcess = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_TAIL_CHARS = 6000;

function nodeCheck(name, args) {
  return {
    name,
    command: process.execPath,
    args
  };
}

function buildReleaseChecks({ includeSmoke = false } = {}) {
  const checks = [
    nodeCheck('unit-tests', ['--test']),
    nodeCheck('syntax-check', [path.join('scripts', 'check-syntax.js')]),
    nodeCheck('mcp-smoke', [path.join('scripts', 'mcp-smoke.js')]),
    nodeCheck('dynamic-dom-smoke', [path.join('scripts', 'dynamic-dom-smoke.js')]),
    nodeCheck('daemon-doctor', [path.join('operator-daemon', 'daemon.js'), '--doctor']),
    {
      name: 'install-doctor-no-install-check',
      command: 'powershell',
      args: [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join('install', 'doctor.ps1'),
        '-NoInstallCheck'
      ]
    }
  ];

  if (includeSmoke) {
    checks.push(nodeCheck('clean-smoke', [path.join('scripts', 'clean-smoke.js')]));
  }

  return checks;
}

function tailText(value, maxChars = OUTPUT_TAIL_CHARS) {
  const text = String(value || '');
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

function addDefined(target, key, value) {
  if (value !== undefined) {
    target[key] = value;
  }
}

function extractCleanSmokeEvidence(stdout) {
  let smoke;
  try {
    smoke = JSON.parse(String(stdout || '').trim());
  } catch {
    return null;
  }
  if (!smoke || typeof smoke !== 'object' || Array.isArray(smoke)) {
    return null;
  }

  const finalStatus = smoke.finalStatus && typeof smoke.finalStatus === 'object'
    ? smoke.finalStatus
    : {};
  const evidence = {};
  addDefined(evidence, 'ok', smoke.ok);
  addDefined(evidence, 'extensionId', smoke.extensionId);
  addDefined(evidence, 'origin', smoke.origin);
  addDefined(evidence, 'profileVerified', finalStatus.profileVerified);
  addDefined(evidence, 'connectionState', finalStatus.connectionState);
  addDefined(evidence, 'prepareOriginReady', smoke.prepareOriginReady);
  addDefined(evidence, 'prepareOriginRequiresUserGesture', smoke.prepareOriginRequiresUserGesture);
  addDefined(evidence, 'blockedByUserSettings', smoke.blockedByUserSettings);
  addDefined(evidence, 'settingsReady', smoke.waitReadyAfterSettings);
  addDefined(evidence, 'openObserveTitle', smoke.openObserveTitle);
  addDefined(evidence, 'visualScreenshotArtifactId', smoke.visualScreenshotArtifactId);
  addDefined(evidence, 'visualScreenshotBytes', smoke.visualScreenshotBytes);
  addDefined(evidence, 'visualAnalyzeProvider', smoke.visualAnalyzeProvider);
  addDefined(evidence, 'visualAnalyzeStatus', smoke.visualAnalyzeStatus);
  addDefined(evidence, 'visualAnalyzeArtifactId', smoke.visualAnalyzeArtifactId);
  addDefined(evidence, 'visualAnalyzeRegions', smoke.visualAnalyzeRegions);
  addDefined(evidence, 'visualAnalyzeCorrelations', smoke.visualAnalyzeCorrelations);
  addDefined(evidence, 'sensitiveVisualBlocked', smoke.sensitiveVisualBlocked);
  addDefined(evidence, 'sensitiveVisualReason', smoke.sensitiveVisualReason);
  addDefined(evidence, 'gatedVisualBlocked', smoke.gatedVisualBlocked);
  addDefined(evidence, 'gateHandoffBlocked', smoke.gateHandoffBlocked);
  addDefined(evidence, 'gateHandoffResume', smoke.gateHandoffResume);
  addDefined(evidence, 'emergencyBlocked', smoke.emergencyBlocked);
  addDefined(evidence, 'emergencyCleared', smoke.emergencyCleared);
  addDefined(evidence, 'postEmergencyObservedTitle', smoke.postEmergencyObservedTitle);
  addDefined(evidence, 'boundedFullAutoStarted', smoke.boundedFullAutoStarted);
  addDefined(evidence, 'boundedFullAutoActions', smoke.boundedFullAutoActions);
  addDefined(evidence, 'boundedFullAutoStopped', smoke.boundedFullAutoStopped);
  addDefined(evidence, 'boundedFullAutoAudited', smoke.boundedFullAutoAudited);
  addDefined(evidence, 'mockPlayUploadPreviewVerified', smoke.mockPlayUploadPreviewVerified);
  addDefined(evidence, 'mockPlayPreviewEvidenceChanged', smoke.mockPlayPreviewEvidenceChanged);
  addDefined(evidence, 'mockPlayPreviewEvidenceMethod', smoke.mockPlayPreviewEvidenceMethod);
  addDefined(evidence, 'mockPlayUploadStatus', smoke.mockPlayUploadStatus);
  addDefined(evidence, 'mockPlayUploadRole', smoke.mockPlayUploadRole);
  addDefined(evidence, 'invalidAssetBlocked', smoke.invalidAssetBlocked);
  addDefined(evidence, 'mockPlaySendForReviewBlocked', smoke.mockPlaySendForReviewBlocked);
  addDefined(evidence, 'mockCommerceSelectedProductId', smoke.mockCommerceSelectedProductId);
  addDefined(evidence, 'mockCommerceSelectedPrice', smoke.mockCommerceSelectedPrice);
  addDefined(evidence, 'mockCommerceSelectedSellerRating', smoke.mockCommerceSelectedSellerRating);
  addDefined(evidence, 'mockCommerceCartVerified', smoke.mockCommerceCartVerified);
  addDefined(evidence, 'mockCommerceStoppedBeforeCheckout', smoke.mockCommerceStoppedBeforeCheckout);
  addDefined(evidence, 'mockCommerceCheckoutBlocked', smoke.mockCommerceCheckoutBlocked);
  addDefined(evidence, 'mockCommerceExcludedReasons', smoke.mockCommerceExcludedReasons);
  addDefined(evidence, 'dynamicRuntimeTabTitle', smoke.dynamicRuntimeTabTitle);
  addDefined(evidence, 'dynamicRuntimeReadContainsControlledValue', smoke.dynamicRuntimeReadContainsControlledValue);
  addDefined(evidence, 'dynamicRuntimeStaleRecovery', smoke.dynamicRuntimeStaleRecovery);
  addDefined(evidence, 'dynamicRuntimeClickVerified', smoke.dynamicRuntimeClickVerified);
  addDefined(evidence, 'dynamicRuntimeDialogOpened', smoke.dynamicRuntimeDialogOpened);
  addDefined(evidence, 'dynamicRuntimeDialogHandled', smoke.dynamicRuntimeDialogHandled);
  addDefined(evidence, 'dynamicRuntimeControlledValue', smoke.dynamicRuntimeControlledValue);
  addDefined(evidence, 'dynamicRuntimeControlledVerified', smoke.dynamicRuntimeControlledVerified);
  addDefined(evidence, 'dynamicRuntimeScrollY', smoke.dynamicRuntimeScrollY);
  addDefined(evidence, 'dynamicRuntimeScrolled', smoke.dynamicRuntimeScrolled);
  addDefined(evidence, 'concurrentTwoTabOk', smoke.concurrentTwoTabOk);
  if (Array.isArray(smoke.concurrentTwoTabAgents)) {
    evidence.concurrentTwoTabAgents = smoke.concurrentTwoTabAgents.map((agent) => {
      const summary = {};
      addDefined(summary, 'agentId', agent && agent.agentId);
      addDefined(summary, 'tabId', agent && agent.tabId);
      addDefined(summary, 'readContainsAgentId', agent && agent.readContainsAgentId);
      addDefined(summary, 'fillVerified', agent && agent.fillVerified);
      addDefined(summary, 'clickVerified', agent && agent.clickVerified);
      addDefined(summary, 'dialogOpened', agent && agent.dialogOpened);
      addDefined(summary, 'dialogClosed', agent && agent.dialogClosed);
      addDefined(summary, 'scrolled', agent && agent.scrolled);
      return summary;
    }).filter((agent) => Object.keys(agent).length > 0);
  }
  addDefined(evidence, 'highRiskBlocked', smoke.highRiskBlocked);
  addDefined(evidence, 'highRiskApprovalReplay', smoke.highRiskApprovalReplay);
  addDefined(evidence, 'screenshotCleanupRemoved', smoke.screenshotCleanupRemoved);
  addDefined(evidence, 'postRevokeBlocked', smoke.postRevokeBlocked);

  if (smoke.basicDomActions && typeof smoke.basicDomActions === 'object') {
    const basicDomActions = {};
    addDefined(basicDomActions, 'locale', smoke.basicDomActions.locale);
    addDefined(basicDomActions, 'enableBeta', smoke.basicDomActions.enableBeta);
    addDefined(basicDomActions, 'status', smoke.basicDomActions.status);
    if (Object.keys(basicDomActions).length > 0) {
      evidence.basicDomActions = basicDomActions;
    }
  }

  return Object.keys(evidence).length > 0 ? evidence : null;
}

function extractMcpSmokeEvidence(stdout) {
  let smoke;
  try {
    smoke = JSON.parse(String(stdout || '').trim());
  } catch {
    return null;
  }
  if (!smoke || typeof smoke !== 'object' || Array.isArray(smoke)) {
    return null;
  }

  const evidence = {};
  addDefined(evidence, 'toolDefinitionsHash', smoke.toolDefinitionsHash);
  addDefined(evidence, 'toolCount', smoke.toolCount);
  addDefined(evidence, 'toolSchemaVersion', smoke.toolSchemaVersion);
  addDefined(evidence, 'strictSchemaToolCount', smoke.strictSchemaToolCount);
  if (Array.isArray(smoke.looseSchemaPaths) && smoke.looseSchemaPaths.length > 0) {
    addDefined(evidence, 'looseSchemaPaths', smoke.looseSchemaPaths);
  }
  addDefined(evidence, 'contractPinned', smoke.contractPinned);

  return Object.keys(evidence).length > 0 ? evidence : null;
}

function extractDynamicDomSmokeEvidence(stdout) {
  let smoke;
  try {
    smoke = JSON.parse(String(stdout || '').trim());
  } catch {
    return null;
  }
  if (!smoke || typeof smoke !== 'object' || Array.isArray(smoke)) {
    return null;
  }

  const finalState = smoke.finalState && typeof smoke.finalState === 'object'
    ? smoke.finalState
    : {};
  const evidence = {};
  addDefined(evidence, 'ok', smoke.ok);
  addDefined(evidence, 'quietMs', smoke.quietMs);
  addDefined(evidence, 'elapsedMs', smoke.elapsedMs);
  addDefined(evidence, 'mutationBursts', smoke.mutationBursts);
  addDefined(evidence, 'lastMutationAtMs', smoke.lastMutationAtMs);
  addDefined(evidence, 'settledAfterLastMutationMs', smoke.settledAfterLastMutationMs);
  addDefined(evidence, 'finalQuietForMs', finalState.quietForMs);
  addDefined(evidence, 'finalMutationCounter', finalState.mutationCounter);

  return Object.keys(evidence).length > 0 ? evidence : null;
}

function defaultRunner(check) {
  return childProcess.spawnSync(check.command, check.args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
}

function normalizeStatus(result) {
  if (typeof result.status === 'number') {
    return result.status;
  }
  return 1;
}

function runReleaseCheck({
  includeSmoke = false,
  runner = defaultRunner,
  now = () => new Date().toISOString()
} = {}) {
  const startedAt = now();
  const checks = [];

  for (const check of buildReleaseChecks({ includeSmoke })) {
    const startedMs = Date.now();
    const result = runner(check);
    const durationMs = Date.now() - startedMs;
    const status = normalizeStatus(result);
    const checkReport = {
      name: check.name,
      command: [check.command, ...check.args].join(' '),
      ok: status === 0,
      status,
      durationMs,
      stdoutTail: tailText(result.stdout),
      stderrTail: tailText(result.stderr || (result.error && result.error.message) || '')
    };
    if (check.name === 'clean-smoke' && checkReport.ok) {
      const evidence = extractCleanSmokeEvidence(result.stdout);
      if (evidence) {
        checkReport.evidence = evidence;
      }
    }
    if (check.name === 'mcp-smoke') {
      const evidence = extractMcpSmokeEvidence(result.stdout);
      if (evidence) {
        checkReport.evidence = evidence;
      }
    }
    if (check.name === 'dynamic-dom-smoke') {
      const evidence = extractDynamicDomSmokeEvidence(result.stdout);
      if (evidence) {
        checkReport.evidence = evidence;
      }
    }
    checks.push(checkReport);
  }

  const failedChecks = checks.filter((check) => !check.ok).length;
  return {
    ok: failedChecks === 0,
    milestone: 'M1',
    startedAt,
    finishedAt: now(),
    includeSmoke,
    totalChecks: checks.length,
    failedChecks,
    checks
  };
}

function parseArgs(argv) {
  return {
    includeSmoke: argv.includes('--include-smoke')
  };
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  const report = runReleaseCheck(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

module.exports = {
  buildReleaseChecks,
  extractCleanSmokeEvidence,
  extractDynamicDomSmokeEvidence,
  extractMcpSmokeEvidence,
  parseArgs,
  runReleaseCheck,
  tailText
};
