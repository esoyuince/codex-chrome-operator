const test = require('node:test');
const assert = require('node:assert/strict');

const { runConcurrentTwoTabSmoke } = require('../scripts/live-smoke');

test('runConcurrentTwoTabSmoke drives two same-origin session tabs with separate agent ids', async () => {
  const calls = [];
  const sendRpcFn = async ({ request }) => {
    calls.push({ method: request.method, params: request.params });
    if (request.method === 'operator.approveDomain') {
      return { ok: true, result: { origin: request.params.origin } };
    }
    if (request.method === 'operator.tabs.create') {
      const tabId = request.params.agentId === 'agent-alpha' ? 101 : 102;
      return {
        ok: true,
        result: {
          tab: {
            id: tabId,
            title: request.params.agentId,
            url: 'about:blank',
            ownership: 'agent',
            ownerAgentId: request.params.agentId
          }
        }
      };
    }
    if (request.method === 'operator.runtime.tab.goto') {
      return {
        ok: true,
        result: {
          tab: {
            id: request.params.tabId,
            title: 'Dynamic',
            url: request.params.url,
            ownership: 'agent',
            ownerAgentId: request.params.agentId
          }
        }
      };
    }
    if (request.method === 'operator.runtime.tab.observe') {
      return {
        ok: true,
        result: {
          title: 'Dynamic',
          pageStateId: `state_${request.params.agentId}`,
          handles: []
        }
      };
    }
    if (request.method === 'operator.runtime.tab.readPage') {
      return {
        ok: true,
        result: {
          pageContent: `Dynamic DOM Fixture ${request.params.agentId}`
        }
      };
    }
    if (request.method === 'operator.runtime.tab.locator') {
      return {
        ok: true,
        result: {
          action: request.params.action,
          verified: request.params.requireVerified === true
        }
      };
    }
    if (request.method === 'operator.tabs.finalize') {
      return { ok: true, result: { kept: [], closed: [request.params.agentId], released: [] } };
    }
    throw new Error(`Unexpected method ${request.method}`);
  };

  const report = await runConcurrentTwoTabSmoke({
    fixtureUrl: 'http://127.0.0.1:18888/dynamic-dom.html',
    sendRpcFn,
    settings: { baseUrl: 'http://127.0.0.1:17391', token: 'test-token' }
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.agents.map((agent) => ({
    agentId: agent.agentId,
    tabId: agent.tabId,
    readContainsAgentId: agent.readContainsAgentId,
    fillVerified: agent.fillVerified,
    clickVerified: agent.clickVerified
  })), [{
    agentId: 'agent-alpha',
    tabId: 101,
    readContainsAgentId: true,
    fillVerified: true,
    clickVerified: true
  }, {
    agentId: 'agent-beta',
    tabId: 102,
    readContainsAgentId: true,
    fillVerified: true,
    clickVerified: true
  }]);
  assert.deepEqual(calls.filter((call) => call.method === 'operator.tabs.create').map((call) => call.params.agentId), [
    'agent-alpha',
    'agent-beta'
  ]);
  assert.ok(calls.some((call) => call.method === 'operator.runtime.tab.locator' &&
    call.params.agentId === 'agent-alpha' &&
    call.params.tabId === 101 &&
    call.params.selector === '[data-testid="dynamic-save"]'));
  assert.ok(calls.some((call) => call.method === 'operator.runtime.tab.locator' &&
    call.params.agentId === 'agent-beta' &&
    call.params.tabId === 102 &&
    call.params.selector === '[data-controlled-field="true"]'));
  assert.deepEqual(calls.filter((call) => call.method === 'operator.tabs.finalize').map((call) => call.params), [
    { agentId: 'agent-alpha', keep: [] },
    { agentId: 'agent-beta', keep: [] }
  ]);
});
