const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const { ensureExtensionKey } = require('../scripts/ensure-extension-key');
const packageJson = require('../package.json');

const ROOT = path.resolve(__dirname, '..');
const INSTALL_SCRIPT = path.join(ROOT, 'install', 'install.ps1');
const DOCTOR_SCRIPT = path.join(ROOT, 'install', 'doctor.ps1');
const UNINSTALL_SCRIPT = path.join(ROOT, 'install', 'uninstall.ps1');

function tempInstallDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-operator-install-'));
}

function runPowerShell(args) {
  return childProcess.spawnSync('powershell', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
}

function runInstall(installDir, extraArgs = []) {
  return runPowerShell([
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    INSTALL_SCRIPT,
    '-InstallDir',
    installDir,
    '-RepoRoot',
    ROOT,
    '-SkipExtensionCopy',
    '-SkipRegistry',
    ...extraArgs
  ]);
}

function runInstallWithExtensionCopy(installDir, extraArgs = []) {
  return runPowerShell([
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    INSTALL_SCRIPT,
    '-InstallDir',
    installDir,
    '-RepoRoot',
    ROOT,
    '-SkipRegistry',
    ...extraArgs
  ]);
}

function runDoctor(installDir, extraArgs = []) {
  return runPowerShell([
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    DOCTOR_SCRIPT,
    '-InstallDir',
    installDir,
    '-NoRegistryCheck',
    ...extraArgs
  ]);
}

function runUninstall(installDir, extraArgs = []) {
  return runPowerShell([
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    UNINSTALL_SCRIPT,
    '-InstallDir',
    installDir,
    '-SkipRegistry',
    ...extraArgs
  ]);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('install derives extension id from the manifest key when ExtensionId is omitted', () => {
  const installDir = tempInstallDir();
  const expectedExtensionId = ensureExtensionKey({ write: false }).extensionId;

  const result = runInstall(installDir);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.readFileSync(path.join(installDir, 'extension-id.txt'), 'ascii'), expectedExtensionId);
  assert.equal(readJson(path.join(installDir, 'config.json')).expectedExtensionId, expectedExtensionId);
  assert.deepEqual(readJson(path.join(installDir, 'com.codex.chrome_operator.json')).allowed_origins, [
    `chrome-extension://${expectedExtensionId}/`
  ]);
});

test('package Node engine matches the installer runtime contract', () => {
  assert.equal(packageJson.engines.node, '>=24');
});

test('install rejects a syntactically valid extension id that does not match the manifest key', () => {
  const installDir = tempInstallDir();
  const result = runInstall(installDir, [
    '-ExtensionId',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match manifest-derived extension id/i);
});

test('doctor verifies installed native host artifacts without requiring registry in test mode', () => {
  const installDir = tempInstallDir();
  const install = runInstall(installDir);
  assert.equal(install.status, 0, install.stderr || install.stdout);

  const doctor = runDoctor(installDir);

  assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.failedCodes, []);
  assert.equal(report.checks.nativeManifest.ok, true);
  assert.equal(report.checks.configExtensionIdMatches.ok, true);
  assert.equal(report.checks.extensionIdFileMatches.ok, true);
  assert.equal(report.checks.launcher.ok, true);
  assert.equal(report.checks.token.ok, true);
  assert.equal(report.checks.userOnlyAcl.ok, true);
  assert.ok(report.checks.userOnlyAcl.details.paths.every((item) => item.currentUserFullControl === true));
  assert.ok(report.checks.userOnlyAcl.details.paths.every((item) => item.denyRules.length === 0));
});

test('doctor fails when installed config extension id drifts from the manifest id', () => {
  const installDir = tempInstallDir();
  const install = runInstall(installDir);
  assert.equal(install.status, 0, install.stderr || install.stdout);

  const configPath = path.join(installDir, 'config.json');
  const config = readJson(configPath);
  config.expectedExtensionId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'ascii');

  const doctor = runDoctor(installDir);

  assert.equal(doctor.status, 1);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.ok, false);
  assert.ok(report.failedCodes.includes('CONFIG_EXTENSION_ID'));
  assert.equal(report.checks.configExtensionIdMatches.ok, false);
  assert.equal(report.checks.extensionIdFileMatches.ok, true);
});

test('doctor fails when installed unpacked extension drifts from repo extension', () => {
  const installDir = tempInstallDir();
  const install = runInstallWithExtensionCopy(installDir);
  assert.equal(install.status, 0, install.stderr || install.stdout);

  const installedBackground = path.join(installDir, 'extension-unpacked', 'background.js');
  fs.appendFileSync(installedBackground, '\n// stale installed extension fixture\n', 'utf8');

  const doctor = runDoctor(installDir);

  assert.equal(doctor.status, 1);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.checks.installedExtensionSync.ok, false);
  assert.ok(report.failedCodes.includes('INSTALLED_EXTENSION_SYNC'));
  assert.notEqual(
    report.checks.installedExtensionSync.details.repoHash,
    report.checks.installedExtensionSync.details.installedHash
  );
  assert.ok(report.checks.installedExtensionSync.details.differentFiles.includes('background.js'));
});

test('uninstall removes runtime artifacts while preserving audit and screenshot logs by default', () => {
  const installDir = tempInstallDir();
  const install = runInstall(installDir);
  assert.equal(install.status, 0, install.stderr || install.stdout);

  const extensionTarget = path.join(installDir, 'extension-unpacked');
  fs.mkdirSync(extensionTarget, { recursive: true });
  fs.writeFileSync(path.join(extensionTarget, 'manifest.json'), '{}', 'utf8');

  const uninstall = runUninstall(installDir);

  assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
  for (const name of [
    'com.codex.chrome_operator.json',
    'codex-chrome-operator-native-bridge.cmd',
    'token.txt',
    'config.json',
    'extension-id.txt',
    'extension-unpacked'
  ]) {
    assert.equal(fs.existsSync(path.join(installDir, name)), false, `${name} should be removed`);
  }
  assert.equal(fs.existsSync(path.join(installDir, 'audit')), true);
  assert.equal(fs.existsSync(path.join(installDir, 'screenshots')), true);
});

test('uninstall RemoveLogs refuses broad custom directories without operator sentinels', () => {
  const unsafeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-unrelated-'));
  const keepFile = path.join(unsafeDir, 'keep.txt');
  fs.writeFileSync(keepFile, 'do-not-delete', 'utf8');

  const uninstall = runUninstall(unsafeDir, ['-RemoveLogs']);

  assert.notEqual(uninstall.status, 0);
  assert.match(uninstall.stderr, /Refusing to recursively remove/i);
  assert.equal(fs.existsSync(keepFile), true);
});

test('doctor fails when token ACL allows Everyone', () => {
  const installDir = tempInstallDir();
  const install = runInstall(installDir);
  assert.equal(install.status, 0, install.stderr || install.stdout);

  const tokenPath = path.join(installDir, 'token.txt');
  const widenAcl = runPowerShell([
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    [
      `$path = ${JSON.stringify(tokenPath)}`,
      '$sid = New-Object System.Security.Principal.SecurityIdentifier("S-1-1-0")',
      '$acl = [System.IO.File]::GetAccessControl($path)',
      '$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, "Read", "Allow")',
      '$acl.AddAccessRule($rule)',
      '[System.IO.File]::SetAccessControl($path, $acl)'
    ].join('; ')
  ]);
  assert.equal(widenAcl.status, 0, widenAcl.stderr || widenAcl.stdout);

  const doctor = runDoctor(installDir);

  assert.equal(doctor.status, 1);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.checks.userOnlyAcl.ok, false);
  assert.ok(report.failedCodes.includes('USER_ONLY_ACL'));
});

test('doctor fails when token value leaks into config', () => {
  const installDir = tempInstallDir();
  const install = runInstall(installDir);
  assert.equal(install.status, 0, install.stderr || install.stdout);

  const token = fs.readFileSync(path.join(installDir, 'token.txt'), 'utf8').trim();
  const configPath = path.join(installDir, 'config.json');
  const config = readJson(configPath);
  config.token = token;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'ascii');

  const doctor = runDoctor(installDir);

  assert.equal(doctor.status, 1);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.checks.tokenSecretStorage.ok, false);
  assert.ok(report.failedCodes.includes('TOKEN_SECRET_STORAGE'));
  assert.doesNotMatch(doctor.stdout, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
