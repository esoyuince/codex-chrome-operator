'use strict';

const HEARTBEAT_INTERVAL_MS = 25000;

function sendHeartbeat() {
  chrome.runtime.sendMessage({
    type: 'operator.offscreenHeartbeat',
    sentAt: Date.now()
  }).catch(() => {
    // The service worker can be between lifetimes; the next heartbeat will retry.
  });
}

sendHeartbeat();
setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
