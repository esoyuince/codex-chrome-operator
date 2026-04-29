'use strict';

function originPattern(origin) {
  const url = new URL(origin);
  return `${url.protocol}//${url.host}/*`;
}

const params = new URLSearchParams(location.search);
const origin = params.get('origin');
const visualCapture = params.get('visualCapture') === '1';
document.getElementById('origin').textContent = origin || 'No origin provided';

document.getElementById('grant').addEventListener('click', async () => {
  const status = document.getElementById('status');
  if (!origin) {
    status.textContent = 'Missing origin.';
    return;
  }
  const origins = [originPattern(origin)];
  if (visualCapture) {
    origins.push('<all_urls>');
  }
  const granted = await chrome.permissions.request({ origins });
  if (granted) {
    await chrome.runtime.sendMessage({
      type: 'operator.hostPermissionGranted',
      origin
    });
  }
  status.textContent = granted ? 'Permission granted.' : 'Permission denied.';
});
