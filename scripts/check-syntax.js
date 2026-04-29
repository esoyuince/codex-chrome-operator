'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const JS_DIRS = [
  'operator-daemon',
  'native-bridge',
  'extension',
  'scripts',
  'tests'
];

function walk(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

function checkJson(file) {
  JSON.parse(fs.readFileSync(file, 'utf8'));
}

const jsFiles = JS_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)));
let failed = false;

for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(result.stderr || result.stdout);
  }
}

for (const file of ['package.json', 'extension/manifest.json']) {
  try {
    checkJson(path.join(ROOT, file));
  } catch (error) {
    failed = true;
    process.stderr.write(`${file}: ${error.message}\n`);
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  process.stdout.write(`Syntax check passed for ${jsFiles.length} JavaScript files.\n`);
}
