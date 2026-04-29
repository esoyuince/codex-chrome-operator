'use strict';

const params = new URLSearchParams(location.search);

document.getElementById('bind').addEventListener('click', async () => {
  const status = document.getElementById('status');
  const profileBindingId = params.get('profileBindingId');
  const rawVersion = params.get('profileBindingVersion') || '1';
  const profileBindingVersion = Number(rawVersion);

  if (!profileBindingId || !Number.isInteger(profileBindingVersion)) {
    status.textContent = 'Missing binding id or version.';
    return;
  }

  await chrome.storage.local.set({ profileBindingId, profileBindingVersion });
  const response = await chrome.runtime.sendMessage({ type: 'operator.refreshHello' });
  status.textContent = response.ok ? 'Profile binding saved.' : 'Profile binding saved; reconnect failed.';
});
