const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  assertPathInside,
  clickElement,
  findChromeForTesting,
  resolveSmokeConfig
} = require('../scripts/clean-smoke');

test('assertPathInside accepts child paths and rejects traversal', () => {
  const root = path.join(os.tmpdir(), 'codex-smoke-root');

  assert.doesNotThrow(() => assertPathInside(root, path.join(root, 'profile')));
  assert.throws(() => assertPathInside(root, path.join(os.tmpdir(), 'elsewhere')), /outside/);
});

test('findChromeForTesting selects highest installed browser directory', () => {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-smoke-install-'));
  const oldChrome = path.join(installDir, 'browsers', 'chrome', 'win64-1', 'chrome-win64', 'chrome.exe');
  const newChrome = path.join(installDir, 'browsers', 'chrome', 'win64-2', 'chrome-win64', 'chrome.exe');
  fs.mkdirSync(path.dirname(oldChrome), { recursive: true });
  fs.mkdirSync(path.dirname(newChrome), { recursive: true });
  fs.writeFileSync(oldChrome, '');
  fs.writeFileSync(newChrome, '');

  assert.equal(findChromeForTesting(installDir), newChrome);
});

test('resolveSmokeConfig creates deterministic clean profile and URLs', () => {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-smoke-install-'));
  const chromePath = path.join(installDir, 'browsers', 'chrome', 'win64-9', 'chrome-win64', 'chrome.exe');
  fs.mkdirSync(path.dirname(chromePath), { recursive: true });
  fs.writeFileSync(chromePath, '');
  fs.writeFileSync(path.join(installDir, 'extension-id.txt'), 'abcdefghijklmnopabcdefghijklmnop');

  const config = resolveSmokeConfig({
    installDir,
    root: path.join(os.tmpdir(), 'repo'),
    fixturePort: 18181,
    debugPort: 9231,
    runId: 'unit'
  });

  assert.equal(config.chromeForTestingPath, chromePath);
  assert.equal(config.origin, 'http://127.0.0.1:18181');
  assert.equal(config.debugBaseUrl, 'http://127.0.0.1:9231');
  assert.equal(config.extensionId, 'abcdefghijklmnopabcdefghijklmnop');
  assert.equal(config.profileDir, path.join(installDir, 'clean-smoke-unit'));
});

test('clickElement can fall back to a DOM click for fixture-only controls', async () => {
  const calls = [];
  async function send(method, params = {}) {
    calls.push({ method, params });
    if (method === 'Runtime.evaluate' && params.expression.includes('getBoundingClientRect')) {
      return {
        result: {
          result: {
            value: { x: 10, y: 20 }
          }
        }
      };
    }
    return {};
  }

  await clickElement(send, 'completeGate', { fallbackDomClick: true });

  assert.equal(calls.filter((call) => call.method === 'Input.dispatchMouseEvent').length, 3);
  assert.equal(calls.at(-1).method, 'Runtime.evaluate');
  assert.match(calls.at(-1).params.expression, /completeGate/);
  assert.match(calls.at(-1).params.expression, /\.click\(\)/);
});
