const test = require('node:test');
const assert = require('node:assert/strict');

const {
  compareToolContractSnapshot,
  loadToolContractSnapshot
} = require('../codex-adapter/toolContract');
const { listTools } = require('../codex-adapter/toolAdapter');

function collectLooseObjectSchemas(schema, path = 'inputSchema') {
  if (!schema || typeof schema !== 'object') {
    return [];
  }

  const loose = [];
  if (schema.type === 'object' && schema.additionalProperties !== false) {
    loose.push(path);
  }

  if (schema.properties) {
    for (const [field, nested] of Object.entries(schema.properties)) {
      loose.push(...collectLooseObjectSchemas(nested, `${path}.properties.${field}`));
    }
  }
  if (schema.items) {
    loose.push(...collectLooseObjectSchemas(schema.items, `${path}.items`));
  }
  return loose;
}

test('adapter tool contract matches the pinned snapshot', () => {
  const comparison = compareToolContractSnapshot();

  assert.equal(comparison.ok, true, JSON.stringify(comparison.mismatches, null, 2));
  assert.deepEqual(comparison.actual, comparison.expected);
});

test('adapter tool contract pins strict schemas and safe output contracts', () => {
  const snapshot = loadToolContractSnapshot();

  assert.equal(snapshot.toolCount, snapshot.toolNames.length);
  assert.equal(snapshot.tools.length, snapshot.toolCount);

  for (const tool of snapshot.tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} inputSchema must reject extras`);
    assert.ok(Array.isArray(tool.inputSchema.required), `${tool.name} required fields must be pinned`);
    assert.equal(tool.outputContract.untrusted, true, `${tool.name} output must be marked untrusted`);
    assert.equal(tool.outputContract.rawScreenshotBytes, false, `${tool.name} must not return raw screenshot bytes`);
  }
});

test('adapter tool contract has no loose nested object schemas', () => {
  const looseSchemas = listTools().flatMap((tool) => (
    collectLooseObjectSchemas(tool.inputSchema).map((path) => `${tool.name}.${path}`)
  ));

  assert.deepEqual(looseSchemas, []);
});
