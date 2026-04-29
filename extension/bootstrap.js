'use strict';

(async () => {
  const status = document.getElementById('status');
  const response = await chrome.runtime.sendMessage({ type: 'operator.refreshHello' });
  status.textContent = response.ok ? `Connection: ${response.connectionState}` : 'Connection failed';
})();
