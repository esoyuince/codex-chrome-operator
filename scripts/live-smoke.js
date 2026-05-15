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

function smokeRequest(method, params = {}) {
  return {
    id: `live_${method.replace(/[^a-z0-9]+/gi, '_')}_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    method,
    params
  };
}

async function sendLiveRpc(sendRpcFn, settings, method, params = {}) {
  return sendRpcFn({
    baseUrl: settings.baseUrl,
    token: settings.token,
    request: smokeRequest(method, params)
  });
}

function assertLiveOk(label, response) {
  if (!response || response.ok !== true) {
    const error = response && response.error ? response.error : response;
    throw new Error(`${label} failed: ${JSON.stringify(error)}`);
  }
  return response.result || {};
}

async function runAgentFixtureFlow({ agentId, tabId, fixtureUrl, sendRpcFn, settings }) {
  const observe = assertLiveOk(`${agentId} observe`, await sendLiveRpc(
    sendRpcFn,
    settings,
    'operator.runtime.tab.observe',
    {
      agentId,
      tabId,
      mode: 'tiny',
      maxActionableHandles: 60,
      summaryMaxChars: 2000
    }
  ));
  const read = assertLiveOk(`${agentId} read`, await sendLiveRpc(
    sendRpcFn,
    settings,
    'operator.runtime.tab.readPage',
    {
      agentId,
      tabId,
      filter: 'interactive',
      maxChars: 4000
    }
  ));
  const fill = assertLiveOk(`${agentId} fill`, await sendLiveRpc(
    sendRpcFn,
    settings,
    'operator.runtime.tab.locator',
    {
      agentId,
      tabId,
      selector: '[data-controlled-field="true"]',
      action: 'fill',
      textValue: `Runtime ${agentId}`,
      requireVerified: true,
      verify: {
        oneOf: [{
          type: 'valueEquals',
          value: `Runtime ${agentId}`
        }]
      },
      postActionSnapshot: 'delta'
    }
  ));
  const click = assertLiveOk(`${agentId} click`, await sendLiveRpc(
    sendRpcFn,
    settings,
    'operator.runtime.tab.locator',
    {
      agentId,
      tabId,
      selector: '[data-testid="dynamic-save"]',
      action: 'click',
      requireVerified: true,
      verify: {
        oneOf: [{
          type: 'textAppears',
          text: 'Dynamic action saved'
        }]
      },
      postActionSnapshot: 'delta'
    }
  ));
  const dialogOpen = assertLiveOk(`${agentId} dialog open`, await sendLiveRpc(
    sendRpcFn,
    settings,
    'operator.runtime.tab.locator',
    {
      agentId,
      tabId,
      selector: '[data-testid="open-dialog"]',
      action: 'click',
      requireVerified: true,
      verify: {
        oneOf: [{
          type: 'textAppears',
          text: 'Runtime dialog opened'
        }]
      },
      postActionSnapshot: 'delta'
    }
  ));
  const dialogClose = assertLiveOk(`${agentId} dialog close`, await sendLiveRpc(
    sendRpcFn,
    settings,
    'operator.runtime.tab.locator',
    {
      agentId,
      tabId,
      selector: '[data-testid="dialog-close"]',
      action: 'click',
      requireVerified: true,
      verify: {
        oneOf: [{
          type: 'textAppears',
          text: 'Dialog closed'
        }]
      },
      postActionSnapshot: 'delta'
    }
  ));
  const scroll = assertLiveOk(`${agentId} scroll`, await sendLiveRpc(
    sendRpcFn,
    settings,
    'operator.runtime.tab.locator',
    {
      agentId,
      tabId,
      selector: '[data-testid="scroll-target"]',
      action: 'scroll',
      deltaX: 0,
      deltaY: 650,
      postActionSnapshot: 'delta'
    }
  ));

  return {
    agentId,
    tabId,
    fixtureUrl,
    pageStateId: observe.pageStateId || null,
    readContainsAgentId: String(read.pageContent || '').includes(agentId),
    fillVerified: fill.verified !== false,
    clickVerified: click.verified !== false,
    dialogOpened: dialogOpen.verified !== false,
    dialogClosed: dialogClose.verified !== false,
    scrolled: scroll.ok !== false
  };
}

async function runConcurrentTwoTabSmoke({
  fixtureUrl,
  sendRpcFn = sendRpc,
  settings = resolveCliSettings(),
  cleanup = true
} = {}) {
  if (!fixtureUrl) {
    throw new Error('runConcurrentTwoTabSmoke requires fixtureUrl.');
  }
  const origin = new URL(fixtureUrl).origin;
  assertLiveOk('approve origin', await sendLiveRpc(sendRpcFn, settings, 'operator.approveDomain', { origin }));

  const agents = ['agent-alpha', 'agent-beta'];
  const created = await Promise.all(agents.map(async (agentId) => {
    const result = assertLiveOk(`${agentId} create tab`, await sendLiveRpc(
      sendRpcFn,
      settings,
      'operator.tabs.create',
      { agentId }
    ));
    const tabId = result.tab && result.tab.id;
    if (!Number.isInteger(tabId)) {
      throw new Error(`${agentId} create tab did not return a tab id.`);
    }
    return { agentId, tabId };
  }));

  try {
    await Promise.all(created.map(async ({ agentId, tabId }) => assertLiveOk(`${agentId} goto`, await sendLiveRpc(
      sendRpcFn,
      settings,
      'operator.runtime.tab.goto',
      {
        agentId,
        tabId,
        url: `${fixtureUrl}${fixtureUrl.includes('?') ? '&' : '?'}agent=${encodeURIComponent(agentId)}`
      }
    ))));

    const results = await Promise.all(created.map((entry) => runAgentFixtureFlow({
      ...entry,
      fixtureUrl,
      sendRpcFn,
      settings
    })));
    return {
      ok: results.every((result) => (
        result.readContainsAgentId &&
        result.fillVerified &&
        result.clickVerified &&
        result.dialogOpened &&
        result.dialogClosed
      )),
      live: true,
      mode: 'concurrent-two-tab',
      origin,
      agents: results
    };
  } finally {
    if (cleanup) {
      await Promise.all(created.map(({ agentId }) => sendLiveRpc(
        sendRpcFn,
        settings,
        'operator.tabs.finalize',
        { agentId, keep: [] }
      ).catch(() => null)));
    }
  }
}

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
  const twoTabIndex = process.argv.indexOf('--two-tab-fixture');
  const run = twoTabIndex === -1
    ? runLiveSmoke()
    : runConcurrentTwoTabSmoke({ fixtureUrl: process.argv[twoTabIndex + 1] });
  run.then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  LIVE_SMOKE_STEPS,
  runConcurrentTwoTabSmoke,
  runLiveSmoke
};
