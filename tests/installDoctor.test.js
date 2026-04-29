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
