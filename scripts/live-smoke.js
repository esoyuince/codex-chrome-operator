'use strict';

const { sendRpc } = require('../native-bridge/daemonClient');
const { resolveCliSettings } = require('./operator-cli');

const LIVE_SMOKE_STEPS = [
  { name: 'status', method: 'operator.status', params: { detail: 'compact' } },
  { name: 'policy', method: 'operator.policy.status', params: {} },
  { name: 'recent-tabs', method: 'operator.context.recentTabs', params: { limit: 5 } },
  { name: 'session-tabs', method: 'operator.tabs.listSession', params: {} },
  { name: 'mcp-download-capability', method: 'operator.downloads.wait', params: { timeoutMs: 0 } }
];

async function runLiveSmoke({ sendRpcFn = sendRpc, settings = resolveCliSettings() } = {}) {
  const results = [];
  for (const step of LIVE_SMOKE_STEPS) {
    const response = await sendRpcFn({
      baseUrl: settings.baseUrl,
      token: settings.token,
      request: {
        id: `live_${step.name}_${Date.now()}`,
        method: step.method,
        params: step.params
      }
    });
    results.push({
      name: step.name,
      method: step.method,
      ok: response && response.ok === true,
      error: response && response.ok === false ? response.error : null,
      result: response && response.ok === true ? response.result : null
    });
  }
  return {
    ok: results.every((entry) => entry.ok || entry.method === 'operator.downloads.wait'),
    live: true,
    steps: results
  };
}

if (require.main === module) {
  runLiveSmoke().then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  LIVE_SMOKE_STEPS,
  runLiveSmoke
};
