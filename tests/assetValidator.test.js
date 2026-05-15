const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  validateAssetFile,
  validateUploadFiles
} = require('../operator-daemon/assetValidator');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-asset-validator-'));
}

function writeTempFile(dir, name, buffer) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function pngBuffer({ width, height, colorType }) {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = colorType;
  return buffer;
}

function jpegBuffer({ width, height }) {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11,
    0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
    0xff, 0xd9
  ]);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

test('valid 512x512 RGBA PNG app icon passes', () => {
  const dir = tempDir();
  const buffer = pngBuffer({ width: 512, height: 512, colorType: 6 });
  const filePath = writeTempFile(dir, 'icon.png', buffer);

  const result = validateAssetFile({
    role: 'playStoreAppIcon',
    path: filePath,
    expectedSha256: sha256(buffer)
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.basename, 'icon.png');
  assert.equal(result.extension, '.png');
  assert.equal(result.bytes, buffer.length);
  assert.equal(result.sha256, sha256(buffer));
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.width, 512);
  assert.equal(result.height, 512);
  assert.equal(result.hasAlpha, true);
  assert.equal(result.role, 'playStoreAppIcon');
  assert.equal(result.ruleset, 'googlePlayPreviewAssets.v2026');
});

test('app icon with wrong size fails ASSET_DIMENSION_MISMATCH', () => {
  const dir = tempDir();
  const filePath = writeTempFile(dir, 'icon.png', pngBuffer({ width: 256, height: 512, colorType: 6 }));

  const result = validateAssetFile({ role: 'playStoreAppIcon', path: filePath });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ASSET_DIMENSION_MISMATCH');
});

test('feature graphic as RGBA PNG fails ASSET_ALPHA_POLICY_BLOCKED', () => {
  const dir = tempDir();
  const filePath = writeTempFile(dir, 'feature.png', pngBuffer({ width: 1024, height: 500, colorType: 6 }));

  const result = validateAssetFile({ role: 'playStoreFeatureGraphic', path: filePath });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ASSET_ALPHA_POLICY_BLOCKED');
});

test('feature graphic 1024x500 RGB PNG passes', () => {
  const dir = tempDir();
  const filePath = writeTempFile(dir, 'feature.png', pngBuffer({ width: 1024, height: 500, colorType: 2 }));

  const result = validateAssetFile({ role: 'playStoreFeatureGraphic', path: filePath });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.hasAlpha, false);
});

test('feature graphic rejects non-24-bit PNG color type', () => {
  const dir = tempDir();
  const filePath = writeTempFile(dir, 'feature.png', pngBuffer({ width: 1024, height: 500, colorType: 0 }));

  const result = validateAssetFile({ role: 'playStoreFeatureGraphic', path: filePath });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ASSET_UNSUPPORTED_TYPE');
});

test('app icon rejects non-32-bit PNG color type', () => {
  const dir = tempDir();
  const filePath = writeTempFile(dir, 'icon.png', pngBuffer({ width: 512, height: 512, colorType: 4 }));

  const result = validateAssetFile({ role: 'playStoreAppIcon', path: filePath });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ASSET_UNSUPPORTED_TYPE');
});

test('screenshot 1080x1920 JPEG passes', () => {
  const dir = tempDir();
  const filePath = writeTempFile(dir, 'phone.jpg', jpegBuffer({ width: 1080, height: 1920 }));

  const result = validateAssetFile({ role: 'playStorePhoneScreenshot', path: filePath });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.mimeType, 'image/jpeg');
  assert.equal(result.width, 1080);
  assert.equal(result.height, 1920);
  assert.equal(result.hasAlpha, false);
});

test('screenshot with 100x100 fails dimension min', () => {
  const dir = tempDir();
  const filePath = writeTempFile(dir, 'small.jpg', jpegBuffer({ width: 100, height: 100 }));

  const result = validateAssetFile({ role: 'playStorePhoneScreenshot', path: filePath });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ASSET_DIMENSION_MISMATCH');
});

test('expectedSha256 mismatch fails ASSET_SHA256_MISMATCH', () => {
  const dir = tempDir();
  const filePath = writeTempFile(dir, 'icon.png', pngBuffer({ width: 512, height: 512, colorType: 6 }));

  const result = validateAssetFile({
    role: 'playStoreAppIcon',
    path: filePath,
    expectedSha256: '0'.repeat(64)
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ASSET_SHA256_MISMATCH');
});

test('validation result contains basename only and no raw full path string', () => {
  const dir = tempDir();
  const filePath = writeTempFile(dir, 'bad-icon.png', pngBuffer({ width: 100, height: 100, colorType: 2 }));

  const result = validateAssetFile({ role: 'playStoreAppIcon', path: filePath });
  const serialized = JSON.stringify(result);

  assert.equal(result.basename, 'bad-icon.png');
  assert.equal(Object.hasOwn(result, 'path'), false);
  assert.equal(serialized.includes(filePath), false);
  assert.equal(serialized.includes(dir), false);
});

test('validateUploadFiles validates each file with the selected ruleset', () => {
  const dir = tempDir();
  const iconPath = writeTempFile(dir, 'icon.png', pngBuffer({ width: 512, height: 512, colorType: 6 }));
  const screenshotPath = writeTempFile(dir, 'phone.jpg', jpegBuffer({ width: 1080, height: 1920 }));

  const results = validateUploadFiles([
    { role: 'playStoreAppIcon', path: iconPath },
    { role: 'playStorePhoneScreenshot', path: screenshotPath }
  ], { ruleset: 'googlePlayPreviewAssets.v2026' });

  assert.equal(results.ok, true);
  assert.equal(results.files.length, 2);
  assert.deepEqual(results.errors, []);
});

test('social draft screenshot accepts ordinary JPEGs without Play Store dimensions', () => {
  const dir = tempDir();
  const screenshotPath = writeTempFile(dir, 'supermemory-qwen-live-screenshot.jpg', jpegBuffer({
    width: 1912,
    height: 992
  }));

  const result = validateUploadFiles([{
    role: 'screenshot',
    path: screenshotPath
  }], { ruleset: 'social-media-draft' });

  assert.equal(result.ok, true);
  assert.equal(result.ruleset, 'socialMediaDraftAssets.v2026');
  assert.equal(result.files[0].role, 'screenshot');
  assert.equal(result.files[0].mimeType, 'image/jpeg');
  assert.equal(result.files[0].width, 1912);
  assert.equal(result.files[0].height, 992);
});
