'use strict';

const HEARTBEAT_INTERVAL_MS = 25000;
const KEEPALIVE_KIND = 'SW_KEEPALIVE';
let heartbeatSequence = 0;

function sendHeartbeat() {
  heartbeatSequence += 1;
  chrome.runtime.sendMessage({
    type: 'operator.offscreenHeartbeat',
    keepaliveKind: KEEPALIVE_KIND,
    heartbeatSequence,
    sentAt: Date.now()
  }).catch(() => {
    // The service worker can be between lifetimes; the next heartbeat will retry.
  });
}

sendHeartbeat();
setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
