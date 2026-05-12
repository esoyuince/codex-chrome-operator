'use strict';

const { waitForCondition } = require('../extension/pageWait');

function smokeContext(mutationState) {
  return {
    location: { href: 'https://example.test/dynamic-dom' },
    window: {
      __codexMutationCounter: mutationState.count,
      getComputedStyle(target) {
        return target.style || { visibility: 'visible', display: 'block' };
      }
    },
    document: {
      readyState: 'complete',
      body: { innerText: 'Dynamic fixture settled' },
      querySelector() {
        return null;
      }
    },
    mutationCounter() {
      return mutationState.count;
    }
  };
}

async function runDynamicDomSmoke({
  quietMs = 120,
  timeoutMs = 600,
  pollIntervalMs = 40
} = {}) {
  let now = 0;
  const mutationState = { count: 0 };
  const mutationSchedule = new Map([
    [40, 'first-render'],
    [80, 'hydration-update']
  ]);
  const mutations = [];
  const context = smokeContext(mutationState);
  const result = await waitForCondition({
    condition: { type: 'domQuiet', quietMs },
    context,
    timeoutMs,
    pollIntervalMs,
    now: () => now,
    sleeper: async (delayMs) => {
      now += delayMs;
      if (mutationSchedule.has(now)) {
        mutationState.count += 1;
        context.window.__codexMutationCounter = mutationState.count;
        mutations.push({
          atMs: now,
          name: mutationSchedule.get(now),
          counter: mutationState.count
        });
      }
    }
  });
  const finalState = result.ok ? result.result.finalState : result.error.finalState;
  const lastMutationAtMs = mutations.length > 0 ? mutations[mutations.length - 1].atMs : 0;
  const settledAfterLastMutationMs = result.ok
    ? Math.max(0, result.result.elapsedMs - lastMutationAtMs)
    : 0;

  return {
    ok: result.ok === true && settledAfterLastMutationMs >= quietMs,
    smoke: 'dynamic-dom',
    quietMs,
    timeoutMs,
    pollIntervalMs,
    elapsedMs: result.ok ? result.result.elapsedMs : result.error.elapsedMs,
    mutationBursts: mutations.length,
    lastMutationAtMs,
    settledAfterLastMutationMs,
    finalState,
    mutations,
    ...(result.ok ? {} : { error: result.error })
  };
}

if (require.main === module) {
  runDynamicDomSmoke()
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = report.ok ? 0 : 1;
    })
    .catch((error) => {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        smoke: 'dynamic-dom',
        error: {
          code: 'DYNAMIC_DOM_SMOKE_FAILED',
          message: error.message || String(error)
        }
      }, null, 2)}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  runDynamicDomSmoke
};
