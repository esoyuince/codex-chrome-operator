const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_PATH = path.join(ROOT, 'extension', 'runtimeLocatorAction.js');

function loadRuntimeLocatorAction() {
  assert.equal(fs.existsSync(SOURCE_PATH), true, 'runtime locator retry module should exist');
  const sandbox = { globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(SOURCE_PATH, 'utf8'), sandbox, {
    filename: SOURCE_PATH
  });
  return sandbox.CodexRuntimeLocatorAction;
}

test('runtime locator action retries once with a fresh locator when dispatch sees a stale handle', async () => {
  const { runLocatorActionWithRetry } = loadRuntimeLocatorAction();
  const resolvedHandles = [];
  const dispatchedHandles = [];

  const response = await runLocatorActionWithRetry({
    resolveLocator: async ({ attempt }) => {
      const handle = attempt === 1 ? 'el_old_0' : 'el_fresh_0';
      resolvedHandles.push(handle);
      return {
        ok: true,
        result: {
          target: { handle, label: 'Mağaza performansı', tag: 'a' }
        }
      };
    },
    runAction: async ({ locator }) => {
      const handle = locator.result.target.handle;
      dispatchedHandles.push(handle);
      if (handle === 'el_old_0') {
        return {
          ok: false,
          error: {
            code: 'STALE_HANDLE',
            reason: 'PAGE_STATE_CHANGED',
            currentPageStateId: 'fresh',
            handlePageStateId: 'old'
          }
        };
      }
      return { ok: true, result: { action: 'clicked', handle } };
    }
  });

  assert.equal(response.ok, true);
  assert.deepEqual(resolvedHandles, ['el_old_0', 'el_fresh_0']);
  assert.deepEqual(dispatchedHandles, ['el_old_0', 'el_fresh_0']);
  assert.equal(response.result.locatorRetry.recovered, true);
  assert.equal(response.result.locatorRetry.attempts, 2);
  assert.equal(response.result.locatorRetry.previousError.code, 'STALE_HANDLE');
});

test('runtime locator action does not retry non-stale action failures', async () => {
  const { runLocatorActionWithRetry } = loadRuntimeLocatorAction();
  let resolveCount = 0;

  const response = await runLocatorActionWithRetry({
    resolveLocator: async () => {
      resolveCount += 1;
      return { ok: true, result: { target: { handle: 'el_state_0' } } };
    },
    runAction: async () => ({
      ok: false,
      error: {
        code: 'TARGET_OCCLUDED',
        message: 'Target is covered.'
      }
    })
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'TARGET_OCCLUDED');
  assert.equal(resolveCount, 1);
});

test('runtime locator action returns the refresh failure after a stale retry trigger', async () => {
  const { runLocatorActionWithRetry } = loadRuntimeLocatorAction();
  let resolveCount = 0;

  const response = await runLocatorActionWithRetry({
    resolveLocator: async () => {
      resolveCount += 1;
      if (resolveCount === 1) {
        return { ok: true, result: { target: { handle: 'el_old_0' } } };
      }
      return {
        ok: false,
        error: {
          code: 'LOCATOR_NOT_UNIQUE',
          message: 'Locator matched more than one visible actionable element.'
        }
      };
    },
    runAction: async () => ({
      ok: false,
      error: {
        code: 'STALE_HANDLE',
        reason: 'PAGE_STATE_CHANGED'
      }
    })
  });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'LOCATOR_NOT_UNIQUE');
  assert.equal(response.error.locatorRetry.recovered, false);
  assert.equal(response.error.locatorRetry.previousError.code, 'STALE_HANDLE');
  assert.equal(resolveCount, 2);
});
