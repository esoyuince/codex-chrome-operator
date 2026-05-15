const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const googlePlayPreviewAssets = require('./rulesets/googlePlayPreviewAssets');
const socialMediaDraftAssets = require('./rulesets/socialMediaDraftAssets');

const ERROR_CODES = {
  fileMissing: 'ASSET_FILE_MISSING',
  fileUnreadable: 'ASSET_FILE_UNREADABLE',
  sha256Mismatch: 'ASSET_SHA256_MISMATCH',
  unsupportedType: 'ASSET_UNSUPPORTED_TYPE',
  dimensionMismatch: 'ASSET_DIMENSION_MISMATCH',
  alphaPolicyBlocked: 'ASSET_ALPHA_POLICY_BLOCKED',
  tooLarge: 'ASSET_TOO_LARGE',
  unknownRole: 'ASSET_UNKNOWN_ROLE',
  unknownRuleset: 'ASSET_UNKNOWN_RULESET'
};

const RULESETS = new Map([
  [googlePlayPreviewAssets.ruleset.id, googlePlayPreviewAssets.ruleset],
  [socialMediaDraftAssets.ruleset.id, socialMediaDraftAssets.ruleset]
]);

const RULESET_ALIASES = new Map([
  ['play-store-draft', googlePlayPreviewAssets.ruleset.id],
  ['social-media-draft', socialMediaDraftAssets.ruleset.id]
]);

function canonicalRulesetId(rulesetId = googlePlayPreviewAssets.ruleset.id) {
  const rawId = typeof rulesetId === 'string' && rulesetId.trim()
    ? rulesetId.trim()
    : googlePlayPreviewAssets.ruleset.id;
  return RULESET_ALIASES.get(rawId) || rawId;
}

function getRuleset(rulesetId = googlePlayPreviewAssets.ruleset.id) {
  return RULESETS.get(canonicalRulesetId(rulesetId)) || null;
}

function makeError(code, message) {
  return { code, message };
}

function baseResult(file, rulesetId) {
  const filePath = file && typeof file.path === 'string' ? file.path : '';
  return {
    basename: path.basename(filePath),
    extension: path.extname(filePath).toLowerCase(),
    bytes: null,
    sha256: null,
    mimeType: null,
    width: null,
    height: null,
    hasAlpha: null,
    role: file ? file.role : undefined,
    ruleset: rulesetId,
    ok: false,
    errors: []
  };
}

function validateAssetFile(file, options = {}) {
  const rulesetId = canonicalRulesetId(options.ruleset);
  const result = baseResult(file, rulesetId);
  const ruleset = getRuleset(rulesetId);
  if (!ruleset) {
    result.errors.push(makeError(ERROR_CODES.unknownRuleset, 'Unknown asset ruleset.'));
    return result;
  }

  const rule = ruleset.roles[result.role];
  if (!rule) {
    result.errors.push(makeError(ERROR_CODES.unknownRole, 'Unknown asset role.'));
    return result;
  }

  let stats;
  try {
    stats = fs.statSync(file.path);
  } catch (error) {
    const code = error && error.code === 'ENOENT' ? ERROR_CODES.fileMissing : ERROR_CODES.fileUnreadable;
    result.errors.push(makeError(code, code === ERROR_CODES.fileMissing ? 'Asset file is missing.' : 'Asset file is unreadable.'));
    return result;
  }

  if (!stats.isFile()) {
    result.errors.push(makeError(ERROR_CODES.fileUnreadable, 'Asset path is not a readable file.'));
    return result;
  }

  let buffer;
  try {
    buffer = fs.readFileSync(file.path);
  } catch {
    result.errors.push(makeError(ERROR_CODES.fileUnreadable, 'Asset file is unreadable.'));
    return result;
  }

  result.bytes = buffer.length;
  result.sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  const metadata = parseImageMetadata(buffer);
  if (!metadata || !rule.extensions.includes(result.extension) || !rule.mimeTypes.includes(metadata.mimeType) || !matchesPngColorType(metadata, rule)) {
    result.errors.push(makeError(ERROR_CODES.unsupportedType, 'Asset file type is not supported for this role.'));
    return finish(result);
  }

  result.mimeType = metadata.mimeType;
  result.width = metadata.width;
  result.height = metadata.height;
  result.hasAlpha = metadata.hasAlpha;

  if (file.expectedSha256 && file.expectedSha256.toLowerCase() !== result.sha256) {
    result.errors.push(makeError(ERROR_CODES.sha256Mismatch, 'Asset SHA-256 does not match expectedSha256.'));
  }

  if (rule.maxBytes && result.bytes > rule.maxBytes) {
    result.errors.push(makeError(ERROR_CODES.tooLarge, 'Asset file exceeds the maximum allowed size.'));
  }

  if (!matchesDimensions(result, rule)) {
    result.errors.push(makeError(ERROR_CODES.dimensionMismatch, 'Asset dimensions do not match the role requirements.'));
  }

  if (rule.alpha === 'required' && !result.hasAlpha) {
    result.errors.push(makeError(ERROR_CODES.alphaPolicyBlocked, 'Asset must include an alpha channel.'));
  }

  if (rule.alpha === 'blocked' && result.hasAlpha) {
    result.errors.push(makeError(ERROR_CODES.alphaPolicyBlocked, 'Asset must not include an alpha channel.'));
  }

  return finish(result);
}

function validateUploadFiles(files, options = {}) {
  const results = files.map((file) => validateAssetFile(file, options));
  const errors = results.flatMap((result) => result.errors.map((error) => ({
    ...error,
    basename: result.basename,
    role: result.role
  })));

  return {
    ok: results.every((result) => result.ok),
    ruleset: canonicalRulesetId(options.ruleset),
    files: results,
    errors
  };
}

function finish(result) {
  result.ok = result.errors.length === 0;
  return result;
}

function matchesDimensions(result, rule) {
  if (rule.width && result.width !== rule.width) {
    return false;
  }
  if (rule.height && result.height !== rule.height) {
    return false;
  }
  if (rule.minDimension && Math.min(result.width, result.height) < rule.minDimension) {
    return false;
  }
  if (rule.maxDimension && Math.max(result.width, result.height) > rule.maxDimension) {
    return false;
  }
  if (rule.maxAspectRatio && Math.max(result.width, result.height) > Math.min(result.width, result.height) * rule.maxAspectRatio) {
    return false;
  }
  return true;
}

function parseImageMetadata(buffer) {
  return parsePngMetadata(buffer) || parseJpegMetadata(buffer);
}

function parsePngMetadata(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 26 || !buffer.subarray(0, 8).equals(signature)) {
    return null;
  }

  const firstChunkType = buffer.toString('ascii', 12, 16);
  if (firstChunkType !== 'IHDR') {
    return null;
  }

  const colorType = buffer[25];
  return {
    mimeType: 'image/png',
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType,
    hasAlpha: colorType === 4 || colorType === 6
  };
}

function matchesPngColorType(metadata, rule) {
  if (metadata.mimeType !== 'image/png' || !rule.pngColorTypes) {
    return true;
  }
  return metadata.bitDepth === 8 && rule.pngColorTypes.includes(metadata.colorType);
}

function parseJpegMetadata(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    let marker = buffer[offset + 1];
    while (marker === 0xff) {
      offset += 1;
      marker = buffer[offset + 1];
    }

    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }

    if (offset + 4 > buffer.length) {
      return null;
    }

    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > buffer.length) {
      return null;
    }

    if (isStartOfFrame(marker)) {
      if (segmentLength < 7) {
        return null;
      }
      return {
        mimeType: 'image/jpeg',
        width: buffer.readUInt16BE(offset + 7),
        height: buffer.readUInt16BE(offset + 5),
        hasAlpha: false
      };
    }

    offset += 2 + segmentLength;
  }

  return null;
}

function isStartOfFrame(marker) {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    ![0xc4, 0xc8, 0xcc].includes(marker)
  );
}

module.exports = {
  ERROR_CODES,
  canonicalRulesetId,
  getRuleset,
  validateAssetFile,
  validateUploadFiles
};
