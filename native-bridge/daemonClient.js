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

module.exports = {
  sendRpc
};
