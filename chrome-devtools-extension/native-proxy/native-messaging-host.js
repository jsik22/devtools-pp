#!/Users/jsik/.nvm/versions/node/v24.14.1/bin/node
'use strict';

const ProxyServer = require('./proxy-server');

// ============================================================
// Chrome Native Messaging Protocol
// Messages: 4-byte little-endian length prefix + UTF-8 JSON
// ============================================================

let inputBuffer = Buffer.alloc(0);

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  const buf = Buffer.from(json, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  process.stdout.write(header);
  process.stdout.write(buf);
}

function parseMessages(callback) {
  while (inputBuffer.length >= 4) {
    const msgLen = inputBuffer.readUInt32LE(0);
    if (msgLen > 1024 * 1024) {
      // Message too large (Chrome limit is 1MB)
      inputBuffer = Buffer.alloc(0);
      return;
    }
    if (inputBuffer.length < 4 + msgLen) break;
    const jsonStr = inputBuffer.slice(4, 4 + msgLen).toString('utf8');
    inputBuffer = inputBuffer.slice(4 + msgLen);
    try {
      callback(JSON.parse(jsonStr));
    } catch (e) {
      sendMessage({ type: 'error', message: 'Invalid JSON: ' + e.message });
    }
  }
}

// ============================================================
// Proxy Instance
// ============================================================

let proxy = null;

async function startProxy(config = {}) {
  if (proxy) {
    await proxy.stop();
  }

  proxy = new ProxyServer({
    port: config.port || 8899,
    bypassPatterns: config.bypassPatterns || [],
    interceptResponse: config.interceptResponse || false,
  });

  // Apply initial URL/Method filters
  if (config.urlFilter) {
    proxy.updateConfig({ urlFilter: config.urlFilter });
  }
  if (config.methodFilter) {
    proxy.updateConfig({ methodFilter: config.methodFilter });
  }

  proxy.on('request_intercepted', (data) => {
    sendMessage({ type: 'request_intercepted', ...data });
  });

  proxy.on('request_timeout', (data) => {
    sendMessage({ type: 'request_timeout', id: data.id });
  });

  proxy.on('response_captured', (data) => {
    sendMessage({ type: 'response_captured', ...data });
  });

  proxy.on('response_intercepted', (data) => {
    sendMessage({ type: 'response_intercepted', ...data });
  });

  proxy.on('error', (err) => {
    sendMessage({ type: 'error', message: err.message });
  });

  proxy.on('status', (data) => {
    sendMessage({ type: 'status', ...data });
  });

  try {
    const port = await proxy.start();
    proxy.interceptActive = true;
    sendMessage({ type: 'proxy_started', port });
  } catch (err) {
    sendMessage({ type: 'error', message: 'Failed to start proxy: ' + err.message });
  }
}

async function stopProxy() {
  if (proxy) {
    await proxy.stop();
    proxy = null;
    sendMessage({ type: 'proxy_stopped' });
  }
}

// ============================================================
// Message Handler
// ============================================================

async function handleMessage(msg) {
  switch (msg.type) {
    case 'intercept_on':
      await startProxy(msg.config || {});
      break;

    case 'intercept_off':
      if (proxy) {
        proxy.forwardAllPending();
        proxy.interceptActive = false;
        sendMessage({ type: 'intercept_paused' });
      }
      break;

    case 'decision':
      if (proxy) {
        proxy.handleDecision(msg.id, msg);
      }
      break;

    case 'update_config':
      if (proxy) {
        proxy.updateConfig(msg.config || {});
        sendMessage({ type: 'config_updated' });
      }
      break;

    case 'ping':
      sendMessage({
        type: 'pong',
        proxyRunning: !!proxy,
        pendingCount: proxy ? proxy.pendingRequests.size : 0,
      });
      break;

    case 'shutdown':
      stopProxy().then(() => process.exit(0));
      break;

    default:
      sendMessage({ type: 'error', message: 'Unknown message type: ' + msg.type });
  }
}

// ============================================================
// Stdin/Stdout Setup
// ============================================================

process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  parseMessages(handleMessage);
});

process.stdin.on('end', () => {
  // Extension disconnected
  if (proxy) {
    proxy.forwardAllPending();
    proxy.stop().then(() => process.exit(0));
  } else {
    process.exit(0);
  }
});

process.stdin.on('error', () => process.exit(1));
process.stdout.on('error', () => process.exit(1));

// Notify extension that host is ready
sendMessage({ type: 'host_ready', pid: process.pid });
