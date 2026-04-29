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
    checks.push({
      name: check.name,
      command: [check.command, ...check.args].join(' '),
      ok: status === 0,
      status,
      durationMs,
      stdoutTail: tailText(result.stdout),
      stderrTail: tailText(result.stderr || (result.error && result.error.message) || '')
    });
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
  parseArgs,
  runReleaseCheck,
  tailText
};
