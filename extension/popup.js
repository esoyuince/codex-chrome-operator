'use strict';

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: 'operator.status' });
  document.getElementById('connection').textContent = status.connectionState || 'unknown';
  document.getElementById('active-tab').textContent = status.activeTab ? (status.activeTab.title || status.activeTab.url || 'tab') : 'none';
}

document.getElementById('connect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'operator.connectNative' });
  await refresh();
});

refresh();
