'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'extension', 'manifest.json');

function extensionIdFromPublicKeyDer(publicKeyDer) {
  const digest = crypto.createHash('sha256').update(publicKeyDer).digest('hex').slice(0, 32);
  return digest.replace(/[0-9a-f]/g, (char) => String.fromCharCode('a'.charCodeAt(0) + Number.parseInt(char, 16)));
}

function generateManifestKey() {
  const { publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'der'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  });
  return publicKey.toString('base64');
}

function readManifest(manifestPath = MANIFEST_PATH) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function writeManifest(manifest, manifestPath = MANIFEST_PATH) {
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function ensureExtensionKey({ manifestPath = MANIFEST_PATH, write = true } = {}) {
  const manifest = readManifest(manifestPath);
  let wroteKey = false;
  if (!manifest.key) {
    if (!write) {
      throw new Error('Manifest key is missing.');
    }
    manifest.key = generateManifestKey();
    writeManifest(manifest, manifestPath);
    wroteKey = true;
  }

  const publicKeyDer = Buffer.from(manifest.key, 'base64');
  return {
    extensionId: extensionIdFromPublicKeyDer(publicKeyDer),
    manifestPath,
    wroteKey
  };
}

if (require.main === module) {
  const result = ensureExtensionKey();
  process.stdout.write(`${result.extensionId}\n`);
}

module.exports = {
  ensureExtensionKey,
  extensionIdFromPublicKeyDer
};
