const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { listTools } = require('../codex-adapter/toolAdapter');

test('codex adapter docs mention every exposed adapter tool', () => {
  const docsPath = path.join(__dirname, '..', 'docs', 'codex-adapter.md');
  const docs = fs.readFileSync(docsPath, 'utf8');
  const missingTools = listTools()
    .map((tool) => tool.name)
    .filter((toolName) => !docs.includes(`\`${toolName}\``));

  assert.deepEqual(missingTools, []);
});

test('README mentions every exposed adapter tool', () => {
  const readmePath = path.join(__dirname, '..', 'README.md');
  const readme = fs.readFileSync(readmePath, 'utf8');
  const missingTools = listTools()
    .map((tool) => tool.name)
    .filter((toolName) => !readme.includes(`\`${toolName}\``));

  assert.deepEqual(missingTools, []);
});
