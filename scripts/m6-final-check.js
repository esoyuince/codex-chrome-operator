'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  runReleaseCheck,
  tailText
} = require('./m1-release-check');

const ROOT = path.resolve(__dirname, '..');

function powershellCheck(name, args) {
  return {
    name,
    command: 'powershell',
    args
  };
}

function buildSandboxInstallChecks({ installDir, removeLogs = true }) {
  const installArgs = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join('install', 'install.ps1'),
    '-InstallDir',
    installDir,
    '-SkipRegistry'
  ];
  const doctorArgs = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join('install', 'doctor.ps1'),
    '-InstallDir',
    installDir,
    '-NoRegistryCheck'
  ];
  const uninstallArgs = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join('install', 'uninstall.ps1'),
    '-InstallDir',
    installDir,
    '-SkipRegistry'
  ];
  if (removeLogs) {
    uninstallArgs.push('-RemoveLogs');
  }

  return [
    powershellCheck('sandbox-install', installArgs),
    powershellCheck('sandbox-install-doctor', doctorArgs),
    powershellCheck('sandbox-uninstall', uninstallArgs)
  ];
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
  return typeof result.status === 'number' ? result.status : 1;
}

function checkOk(check) {
  return Boolean(check && check.ok);
}

function extractDoctorEvidence(stdout) {
  let report;
  try {
    report = JSON.parse(String(stdout || '').trim());
  } catch {
    return null;
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return null;
  }

  const checks = report.checks && typeof report.checks === 'object' ? report.checks : {};
  const tokenDetails = checks.token && checks.token.details ? checks.token.details : {};
  return {
    ok: report.ok === true,
    failedCodes: Array.isArray(report.failedCodes) ? report.failedCodes : [],
    nativeManifest: checkOk(checks.nativeManifest),
    configExtensionIdMatches: checkOk(checks.configExtensionIdMatches),
    extensionIdFileMatches: checkOk(checks.extensionIdFileMatches),
    launcher: checkOk(checks.launcher),
    token: checkOk(checks.token),
    ...(typeof tokenDetails.length === 'number' ? { tokenLength: tokenDetails.length } : {}),
    tokenSecretStorage: checkOk(checks.tokenSecretStorage),
    userOnlyAcl: checkOk(checks.userOnlyAcl)
  };
}

function extractReleaseEvidence(report) {
  const mcpSmoke = report.checks.find((check) => check.name === 'mcp-smoke');
  const cleanSmoke = report.checks.find((check) => check.name === 'clean-smoke');
  return {
    releaseOk: report.ok === true,
    milestone: report.milestone,
    includeSmoke: report.includeSmoke,
    totalChecks: report.totalChecks,
    failedChecks: report.failedChecks,
    failedCheckNames: report.checks
      .filter((check) => !check.ok)
      .map((check) => check.name),
    ...(mcpSmoke && mcpSmoke.evidence ? { mcpSmoke: mcpSmoke.evidence } : {}),
    ...(cleanSmoke && cleanSmoke.evidence ? { cleanSmoke: cleanSmoke.evidence } : {})
  };
}

function processCheckReport(check, result) {
  const status = normalizeStatus(result);
  const checkReport = {
    name: check.name,
    command: [check.command, ...check.args].join(' '),
    ok: status === 0,
    status,
    stdoutTail: tailText(result.stdout),
    stderrTail: tailText(result.stderr || (result.error && result.error.message) || '')
  };

  if (check.name === 'sandbox-install-doctor' && checkReport.ok) {
    const evidence = extractDoctorEvidence(result.stdout);
    if (evidence) {
      checkReport.evidence = evidence;
    }
  }

  return checkReport;
}

function defaultInstallDir() {
  return path.join(os.tmpdir(), `codex-chrome-operator-m6-${process.pid}-${Date.now()}`);
}

function runM6FinalCheck({
  includeSmoke = true,
  installDir = defaultInstallDir(),
  keepInstallDir = false,
  runner = defaultRunner,
  pathExists = fs.existsSync,
  now = () => new Date().toISOString()
} = {}) {
  const startedAt = now();
  const resolvedInstallDir = path.resolve(installDir);
  const checks = [];

  const releaseReport = runReleaseCheck({
    includeSmoke,
    runner,
    now
  });
  checks.push({
    name: 'release-gates',
    command: `runReleaseCheck(includeSmoke=${includeSmoke})`,
    ok: releaseReport.ok === true,
    status: releaseReport.ok === true ? 0 : 1,
    evidence: extractReleaseEvidence(releaseReport),
    report: releaseReport
  });

  for (const check of buildSandboxInstallChecks({
    installDir: resolvedInstallDir,
    removeLogs: !keepInstallDir
  })) {
    checks.push(processCheckReport(check, runner(check)));
  }

  if (!keepInstallDir) {
    const removed = !pathExists(resolvedInstallDir);
    checks.push({
      name: 'sandbox-install-dir-removed',
      command: `pathExists(${resolvedInstallDir}) === false`,
      ok: removed,
      status: removed ? 0 : 1,
      evidence: {
        installDir: resolvedInstallDir,
        removed
      }
    });
  }

  const failedCheckNames = checks
    .filter((check) => !check.ok)
    .map((check) => check.name);

  return {
    ok: failedCheckNames.length === 0,
    phase: 'M6',
    startedAt,
    finishedAt: now(),
    includeSmoke,
    installDir: resolvedInstallDir,
    totalChecks: checks.length,
    failedChecks: failedCheckNames.length,
    failedCheckNames,
    checks
  };
}

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

function parseArgs(argv) {
  return {
    includeSmoke: !argv.includes('--skip-clean-smoke'),
    installDir: valueAfter(argv, '--install-dir'),
    keepInstallDir: argv.includes('--keep-install-dir')
  };
}

if (require.main === module) {
  const report = runM6FinalCheck(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

module.exports = {
  buildSandboxInstallChecks,
  extractDoctorEvidence,
  extractReleaseEvidence,
  parseArgs,
  runM6FinalCheck
};
