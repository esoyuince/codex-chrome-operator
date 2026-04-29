'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

function defaultScreenshotDir() {
  return path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'CodexChromeOperator',
    'screenshots'
  );
}

function parseScreenshotDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') {
    throw new Error('INVALID_SCREENSHOT_DATA_URL: screenshot dataUrl must be a string.');
  }
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    throw new Error('INVALID_SCREENSHOT_DATA_URL: expected image data URL.');
  }
  return {
    mimeType: match[1],
    bytes: Buffer.from(match[2], 'base64')
  };
}

function extensionForMimeType(mimeType) {
  if (mimeType === 'image/jpeg') {
    return '.jpg';
  }
  if (mimeType === 'image/webp') {
    return '.webp';
  }
  return '.png';
}

function defaultIdGenerator() {
  return `shot_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

class ScreenshotStore {
  constructor({
    rootDir = defaultScreenshotDir(),
    maxBytes = DEFAULT_MAX_BYTES,
    idGenerator = defaultIdGenerator
  } = {}) {
    this.rootDir = rootDir;
    this.maxBytes = maxBytes;
    this.idGenerator = idGenerator;
    fs.mkdirSync(rootDir, { recursive: true });
  }

  saveDataUrl({
    dataUrl,
    origin,
    reason = 'visualObserve',
    now = new Date()
  } = {}) {
    const parsed = parseScreenshotDataUrl(dataUrl);
    if (parsed.bytes.length > this.maxBytes) {
      throw new Error(`VISUAL_ARTIFACT_TOO_LARGE: screenshot is ${parsed.bytes.length} bytes.`);
    }

    const artifactId = this.idGenerator();
    const filePath = path.join(this.rootDir, `${artifactId}${extensionForMimeType(parsed.mimeType)}`);
    const metadataPath = path.join(this.rootDir, `${artifactId}.json`);
    const sha256 = crypto.createHash('sha256').update(parsed.bytes).digest('hex');
    const capturedAt = now.toISOString();
    const metadata = {
      artifactId,
      mimeType: parsed.mimeType,
      bytes: parsed.bytes.length,
      sha256,
      path: filePath,
      metadataPath,
      origin: origin || null,
      reason,
      capturedAt,
      retention: {
        cleanupEligible: true
      }
    };

    fs.writeFileSync(filePath, parsed.bytes);
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    return { ...metadata };
  }

  metadataFiles() {
    if (!fs.existsSync(this.rootDir)) {
      return [];
    }
    return fs.readdirSync(this.rootDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => path.join(this.rootDir, name));
  }

  cleanup({
    olderThanMs = 0,
    now = new Date()
  } = {}) {
    const cutoffMs = now.getTime() - Number(olderThanMs || 0);
    const removed = [];
    const kept = [];

    for (const metadataPath of this.metadataFiles()) {
      let metadata;
      try {
        metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      } catch {
        continue;
      }

      const capturedAtMs = Date.parse(metadata.capturedAt);
      if (!Number.isFinite(capturedAtMs) || capturedAtMs > cutoffMs) {
        kept.push(metadata);
        continue;
      }

      if (metadata.path && fs.existsSync(metadata.path)) {
        fs.rmSync(metadata.path, { force: true });
      }
      fs.rmSync(metadataPath, { force: true });
      removed.push(metadata);
    }

    return {
      rootDir: this.rootDir,
      removed,
      keptCount: kept.length
    };
  }
}

module.exports = {
  ScreenshotStore,
  defaultScreenshotDir,
  parseScreenshotDataUrl
};
