'use strict';

async function sendRpc({ baseUrl, token, request }) {
  const response = await fetch(`${baseUrl}/v1/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-codex-chrome-operator': '1'
    },
    body: JSON.stringify(request)
  });

  return response.json();
}

function notifyDaemonDisconnect({
  baseUrl,
  token,
  bridgeInstanceId,
  source = 'native-bridge',
  reason = 'Native bridge disconnected.'
}) {
  return sendRpc({
    baseUrl,
    token,
    request: {
      id: `disconnect_${Date.now()}`,
      method: 'bridge.disconnected',
      params: {
        ...(bridgeInstanceId ? { bridgeInstanceId } : {}),
        source,
        reason
      }
    }
  });
}

module.exports = {
  notifyDaemonDisconnect,
  sendRpc
};
