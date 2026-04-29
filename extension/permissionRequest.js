'use strict';

function originPattern(origin) {
  const url = new URL(origin);
  return `${url.protocol}//${url.host}/*`;
}

const params = new URLSearchParams(location.search);
const origin = params.get('origin');
document.getElementById('origin').textContent = origin || 'No origin provided';

document.getElementById('grant').addEventListener('click', async () => {
  const status = document.getElementById('status');
  if (!origin) {
    status.textContent = 'Missing origin.';
    return;
  }
  const granted = await chrome.permissions.request({ origins: [originPattern(origin)] });
  status.textContent = granted ? 'Permission granted.' : 'Permission denied.';
});
