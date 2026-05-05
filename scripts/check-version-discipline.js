'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function readJson(file) {
  return JSON.parse(read(file));
}

function extract(file, label, pattern) {
  const match = read(file).match(pattern);
  return {
    label,
    file,
    version: match ? match[1] : null
  };
}

function collectTestVersionSources() {
  const testDir = path.join(ROOT, 'tests');
  return fs.readdirSync(testDir)
    .filter((name) => name.endsWith('.test.js'))
    .flatMap((name) => {
      const file = path.join('tests', name);
      const content = read(file);
      const versions = [...new Set((content.match(/\b0\.2\.\d+\b/g) || []))];
      return versions.map((version) => ({
        label: `test:${name}`,
        file,
        version
      }));
    });
}

function collectVersionSources() {
  const pkg = readJson('package.json');
  const manifest = readJson('extension/manifest.json');
  return [
    { label: 'package.json', file: 'package.json', version: pkg.version || null },
    { label: 'extension manifest', file: 'extension/manifest.json', version: manifest.version || null },
    extract('extension/background.js', 'extension bridgeVersion', /bridgeVersion:\s*['"]([^'"]+)['"]/),
    extract('operator-daemon/sessionManager.js', 'daemon expectedExtensionVersion', /expectedExtensionVersion:\s*config\.expectedExtensionVersion\s*\|\|\s*['"]([^'"]+)['"]/),
    extract('operator-daemon/sessionManager.js', 'daemon expectedBridgeVersion', /expectedBridgeVersion:\s*config\.expectedBridgeVersion\s*\|\|\s*['"]([^'"]+)['"]/),
    extract('codex-adapter/mcpServer.js', 'mcp server version', /SERVER_VERSION\s*=\s*['"]([^'"]+)['"]/),
    extract('scripts/mcp-smoke.js', 'mcp smoke client version', /SMOKE_CLIENT_VERSION\s*=\s*['"]([^'"]+)['"]/),
    extract('README.md', 'README package version', /Package version:\s*`([^`]+)`/),
    ...collectTestVersionSources()
  ];
}

function checkVersionDiscipline() {
  const sources = collectVersionSources();
  const version = sources[0] ? sources[0].version : null;
  const mismatches = sources.filter((source) => source.version !== version || !source.version);
  return {
    ok: Boolean(version) && mismatches.length === 0,
    version,
    sources,
    mismatches
  };
}

if (require.main === module) {
  const result = checkVersionDiscipline();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(`Version discipline OK: ${result.version}\n`);
  } else {
    process.stderr.write(`Version discipline failed:\n${JSON.stringify(result.mismatches, null, 2)}\n`);
  }
  if (!result.ok) {
    process.exitCode = 1;
  }
}

module.exports = {
  checkVersionDiscipline,
  collectVersionSources
};
