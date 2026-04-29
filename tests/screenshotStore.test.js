const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ScreenshotStore,
  parseScreenshotDataUrl
} = require('../operator-daemon/screenshotStore');

test('parseScreenshotDataUrl decodes png data URLs', () => {
  const parsed = parseScreenshotDataUrl('data:image/png;base64,aGVsbG8=');

  assert.equal(parsed.mimeType, 'image/png');
  assert.equal(parsed.bytes.toString('utf8'), 'hello');
});

test('ScreenshotStore saves screenshot bytes as artifact metadata without raw dataUrl', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-screenshot-store-'));
  const store = new ScreenshotStore({
    rootDir,
    idGenerator: () => 'shot_test'
  });

  const artifact = store.saveDataUrl({
    dataUrl: 'data:image/png;base64,aGVsbG8=',
    origin: 'https://example.com',
    reason: 'visualObserve',
    now: new Date('2026-04-29T10:00:00.000Z')
  });

  assert.equal(artifact.artifactId, 'shot_test');
  assert.equal(artifact.mimeType, 'image/png');
  assert.equal(artifact.bytes, 5);
  assert.equal(artifact.sha256, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  assert.equal(Object.prototype.hasOwnProperty.call(artifact, 'dataUrl'), false);
  assert.equal(fs.readFileSync(artifact.path).toString('utf8'), 'hello');

  const metadata = JSON.parse(fs.readFileSync(artifact.metadataPath, 'utf8'));
  assert.equal(metadata.origin, 'https://example.com');
  assert.equal(metadata.reason, 'visualObserve');
  assert.equal(Object.prototype.hasOwnProperty.call(metadata, 'dataUrl'), false);
});

test('ScreenshotStore enforces size limits and cleans old artifacts', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-screenshot-store-'));
  let nextId = 1;
  const store = new ScreenshotStore({
    rootDir,
    maxBytes: 8,
    idGenerator: () => `shot_${nextId++}`
  });

  const oldArtifact = store.saveDataUrl({
    dataUrl: 'data:image/png;base64,b2xk',
    origin: 'https://example.com',
    now: new Date('2026-04-29T10:00:00.000Z')
  });
  const freshArtifact = store.saveDataUrl({
    dataUrl: 'data:image/png;base64,bmV3',
    origin: 'https://example.com',
    now: new Date('2026-04-29T10:01:00.000Z')
  });

  assert.throws(
    () => store.saveDataUrl({
      dataUrl: 'data:image/png;base64,dGhpcyBpcyB0b28gbG9uZw==',
      origin: 'https://example.com'
    }),
    /VISUAL_ARTIFACT_TOO_LARGE/
  );

  const cleanup = store.cleanup({
    olderThanMs: 30000,
    now: new Date('2026-04-29T10:01:00.000Z')
  });

  assert.equal(cleanup.removed.length, 1);
  assert.equal(cleanup.removed[0].artifactId, oldArtifact.artifactId);
  assert.equal(fs.existsSync(oldArtifact.path), false);
  assert.equal(fs.existsSync(freshArtifact.path), true);
});
