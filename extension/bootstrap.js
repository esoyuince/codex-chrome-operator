'use strict';

(async () => {
  const status = document.getElementById('status');
  const response = await chrome.runtime.sendMessage({ type: 'operator.connectNative' });
  status.textContent = response.ok ? `Connection: ${response.connectionState}` : 'Connection failed';
})();
