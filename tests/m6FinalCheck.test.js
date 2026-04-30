const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildSandboxInstallChecks,
  extractDoctorEvidence,
  parseArgs,
  runM6FinalCheck
} = require('../scripts/m6-final-check');

const ROOT = path.resolve(__dirname, '..');

test('buildSandboxInstallChecks runs install, doctor, and uninstall against one sandbox dir', () => {
  const installDir = 'C:/Temp/codex-operator-m6';
  const checks = buildSandboxInstallChecks({ installDir, removeLogs: true });

  assert.deepEqual(checks.map((check) => check.name), [
    'sandbox-install',
    'sandbox-install-doctor',
    'sandbox-uninstall'
  ]);
  assert.deepEqual(checks[0].args, [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join('install', 'install.ps1'),
    '-InstallDir',
    installDir,
    '-SkipRegistry'
  ]);
  assert.deepEqual(checks[1].args, [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join('install', 'doctor.ps1'),
    '-InstallDir',
    installDir,
    '-NoRegistryCheck'
  ]);
  assert.deepEqual(checks[2].args, [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join('install', 'uninstall.ps1'),
    '-InstallDir',
    installDir,
    '-SkipRegistry',
    '-RemoveLogs'
  ]);
});

test('extractDoctorEvidence keeps only install readiness facts', () => {
  const evidence = extractDoctorEvidence(JSON.stringify({
    ok: true,
    failedCodes: [],
    checks: {
      nativeManifest: { ok: true },
      configExtensionIdMatches: { ok: true },
      extensionIdFileMatches: { ok: true },
      launcher: { ok: true },
      token: { ok: true, details: { length: 43 } },
      tokenSecretStorage: { ok: true },
      userOnlyAcl: { ok: true },
      registryKey: { ok: false }
    }
  }));

  assert.deepEqual(evidence, {
    ok: true,
    failedCodes: [],
    nativeManifest: true,
    configExtensionIdMatches: true,
    extensionIdFileMatches: true,
    launcher: true,
    token: true,
    tokenLength: 43,
    tokenSecretStorage: true,
    userOnlyAcl: true
  });
});

test('runM6FinalCheck combines release gates with sandbox install lifecycle', () => {
  const calls = [];
  const report = runM6FinalCheck({
    includeSmoke: false,
    installDir: 'C:/Temp/codex-operator-m6',
    pathExists: () => false,
    now: (() => {
      let tick = 0;
      return () => new Date(Date.UTC(2026, 3, 30, 12, 0, tick++)).toISOString();
    })(),
    runner: (check) => {
      calls.push(check.name);
      return {
        status: 0,
        stdout: check.name === 'sandbox-install-doctor'
          ? JSON.stringify({
            ok: true,
            failedCodes: [],
            checks: {
              nativeManifest: { ok: true },
              configExtensionIdMatches: { ok: true },
              extensionIdFileMatches: { ok: true },
              launcher: { ok: true },
              token: { ok: true, details: { length: 43 } },
              tokenSecretStorage: { ok: true },
              userOnlyAcl: { ok: true }
            }
          })
          : `${check.name} ok`,
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
    'sandbox-install',
    'sandbox-install-doctor',
    'sandbox-uninstall'
  ]);
  assert.equal(report.ok, true);
  assert.equal(report.phase, 'M6');
  assert.equal(report.includeSmoke, false);
  assert.equal(report.failedChecks, 0);
  assert.equal(report.checks[0].name, 'release-gates');
  assert.equal(report.checks[0].evidence.releaseOk, true);
  assert.equal(report.checks[0].evidence.totalChecks, 5);
  assert.equal(report.checks[2].evidence.tokenLength, 43);
  assert.equal(report.checks[4].name, 'sandbox-install-dir-removed');
  assert.equal(report.checks[4].ok, true);
});

test('runM6FinalCheck fails closed when sandbox uninstall leaves files behind', () => {
  const report = runM6FinalCheck({
    includeSmoke: false,
    installDir: 'C:/Temp/codex-operator-m6',
    pathExists: () => true,
    runner: () => ({
      status: 0,
      stdout: '{}',
      stderr: ''
    })
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.failedCheckNames, ['sandbox-install-dir-removed']);
});

test('parseArgs supports smoke and install-dir options', () => {
  assert.deepEqual(parseArgs([
    '--skip-clean-smoke',
    '--install-dir',
    'C:/Temp/custom',
    '--keep-install-dir'
  ]), {
    includeSmoke: false,
    installDir: 'C:/Temp/custom',
    keepInstallDir: true
  });
});

test('package and Windows runbook expose the M6 final check path', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const runbook = fs.readFileSync(path.join(ROOT, 'docs', 'windows-install-runbook.md'), 'utf8');

  assert.equal(packageJson.scripts['release:m6'], 'node scripts/m6-final-check.js');
  assert.match(runbook, /npm run release:m6/);
  assert.match(runbook, /install\\install\.ps1/);
  assert.match(runbook, /install\\doctor\.ps1/);
  assert.match(runbook, /profile-onboard/);
  assert.match(runbook, /prepare-origin/);
});
