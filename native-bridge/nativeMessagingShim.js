'use strict';

const { NativeMessageDecoder, encodeNativeMessage } = require('../operator-daemon/framing');
const { notifyDaemonDisconnect, sendRpc } = require('./daemonClient');

function makeBridgeInstanceId() {
  return `bridge_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function attachBridgeInstance(request, bridgeInstanceId) {
  return {
    ...request,
    params: {
      ...(request && request.params ? request.params : {}),
      bridgeInstanceId
    }
  };
}

function printHelp() {
  process.stderr.write(`Codex Chrome Operator Native Messaging bridge

Usage:
  node native-bridge/nativeMessagingShim.js [--daemon-url http://127.0.0.1:17391]

stdout is reserved for Chrome Native Messaging frames.
`);
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) {
    return fallback;
  }
  return process.argv[index + 1];
}

async function handleMessage(message, options) {
  return sendRpc({
    baseUrl: options.daemonUrl,
    token: options.token,
    request: attachBridgeInstance(message, options.bridgeInstanceId)
  });
}

async function pollOnce(options, output = process.stdout) {
  const response = await sendRpc({
    baseUrl: options.daemonUrl,
    token: options.token,
    request: {
      id: `poll_${Date.now()}`,
      method: 'bridge.poll',
      params: {
        bridgeInstanceId: options.bridgeInstanceId
      }
    }
  });

  if (response.ok && response.result && response.result.command) {
    output.write(encodeNativeMessage(response.result.command));
  }

  return response;
}

function startPolling(options) {
  let busy = false;
  const interval = setInterval(async () => {
    if (busy) {
      return;
    }
    busy = true;
    try {
      await pollOnce(options);
    } catch (error) {
      process.stderr.write(`${error.stack || error.message}\n`);
    } finally {
      busy = false;
    }
  }, options.pollIntervalMs || 250);
  return interval;
}

async function runBridge(options = {}) {
  const daemonUrl = options.daemonUrl || argValue('--daemon-url', process.env.CODEX_CHROME_OPERATOR_DAEMON_URL || 'http://127.0.0.1:17391');
  const token = options.token || process.env.CODEX_CHROME_OPERATOR_TOKEN || 'dev-token';
  const bridgeInstanceId = options.bridgeInstanceId || makeBridgeInstanceId();
  const decoder = new NativeMessageDecoder();
  const pollInterval = startPolling({
    daemonUrl,
    token,
    bridgeInstanceId,
    pollIntervalMs: options.pollIntervalMs
  });

  process.stdin.on('data', async (chunk) => {
    try {
      for (const message of decoder.push(chunk)) {
        const response = await handleMessage(message, { daemonUrl, token, bridgeInstanceId });
        process.stdout.write(encodeNativeMessage(response));
      }
    } catch (error) {
      process.stderr.write(`${error.stack || error.message}\n`);
      const response = {
        id: null,
        ok: false,
        error: {
          code: 'NATIVE_BRIDGE_FAILED',
          message: error.message
        }
      };
      process.stdout.write(encodeNativeMessage(response));
    }
  });

  process.stdin.on('end', () => {
    clearInterval(pollInterval);
    notifyDaemonDisconnect({
      baseUrl: daemonUrl,
      token,
      bridgeInstanceId,
      source: 'native-bridge',
      reason: 'stdin closed'
    }).finally(() => process.exit(0));
  });
}

if (require.main === module) {
  if (process.argv.includes('--help')) {
    printHelp();
  } else {
    runBridge();
  }
}

module.exports = {
  attachBridgeInstance,
  runBridge,
  handleMessage,
  makeBridgeInstanceId,
  pollOnce,
  startPolling
};
