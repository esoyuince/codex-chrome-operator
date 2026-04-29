'use strict';

const { NativeMessageDecoder, encodeNativeMessage } = require('../operator-daemon/framing');
const { sendRpc } = require('./daemonClient');

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
    request: message
  });
}

async function runBridge(options = {}) {
  const daemonUrl = options.daemonUrl || argValue('--daemon-url', process.env.CODEX_CHROME_OPERATOR_DAEMON_URL || 'http://127.0.0.1:17391');
  const token = options.token || process.env.CODEX_CHROME_OPERATOR_TOKEN || 'dev-token';
  const decoder = new NativeMessageDecoder();

  process.stdin.on('data', async (chunk) => {
    try {
      for (const message of decoder.push(chunk)) {
        const response = await handleMessage(message, { daemonUrl, token });
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
    process.exit(0);
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
  runBridge,
  handleMessage
};
