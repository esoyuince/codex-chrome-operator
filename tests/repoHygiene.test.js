const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function gitLsFiles(patterns) {
  return execFileSync('git', ['ls-files', ...patterns], {
    cwd: ROOT,
    encoding: 'utf8'
  }).trim().split(/\r?\n/).filter(Boolean);
}

test('repo does not track live browser screenshot artifacts at the project root', () => {
  const tracked = gitLsFiles(['*.png', '*.jpg', '*.jpeg']);
  const liveRootArtifacts = tracked.filter((file) => (
    !file.includes('/') &&
    /(?:^after_|^chrome_|^codex_screen_capture|^tweet_|^x_reply_|_screen_capture\.(?:png|jpe?g)$)/i.test(file)
  ));

  assert.deepEqual(liveRootArtifacts, []);
});

test('gitignore blocks common live browser screenshot artifact names without ignoring extension icons', () => {
  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');

  assert.match(gitignore, /\/after_\*\.png/);
  assert.match(gitignore, /\/tweet_\*\.(?:png|jpg|jpeg|\{png,jpg,jpeg\})/);
  assert.match(gitignore, /\/x_reply_\*\.png/);
  assert.doesNotMatch(gitignore, /^\*\.png$/m);
});

test('version discipline check passes for synchronized release surfaces', () => {
  const result = spawnSync(process.execPath, ['scripts/check-version-discipline.js', '--json'], {
    cwd: ROOT,
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.match(payload.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(payload.mismatches, []);
});
