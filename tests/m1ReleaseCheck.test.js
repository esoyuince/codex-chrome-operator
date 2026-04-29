const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildReleaseChecks,
  runReleaseCheck,
  tailText
} = require('../scripts/m1-release-check');

test('buildReleaseChecks includes M1 release gates and keeps clean smoke opt-in', () => {
  const checks = buildReleaseChecks({ includeSmoke: false });
  assert.deepEqual(checks.map((check) => check.name), [
    'unit-tests',
    'syntax-check',
    'daemon-doctor',
    'install-doctor-no-install-check'
  ]);
  assert.deepEqual(buildReleaseChecks({ includeSmoke: true }).map((check) => check.name), [
    'unit-tests',
    'syntax-check',
    'daemon-doctor',
    'install-doctor-no-install-check',
    'clean-smoke'
  ]);

  assert.equal(checks[0].command, process.execPath);
  assert.equal(checks[1].command, process.execPath);
  assert.equal(checks[2].command, process.execPath);
  assert.equal(checks[0].args[0], '--test');
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
    'daemon-doctor',
    'install-doctor-no-install-check',
    'clean-smoke'
  ]);
  assert.equal(report.ok, false);
  assert.equal(report.failedChecks, 1);
  assert.equal(report.checks.length, 5);
  assert.equal(report.checks[2].name, 'daemon-doctor');
  assert.equal(report.checks[2].ok, false);
  assert.equal(report.checks[2].stderrTail, 'doctor failed');
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
