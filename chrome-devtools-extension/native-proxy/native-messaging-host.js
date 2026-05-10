#!/usr/bin/env node
// 참고: 이 shebang은 파일이 직접 실행될 때만 사용됨. Chrome의 Native
// Messaging launcher는 실제로는 사용자 머신의 node 바이너리 절대경로를
// 박은 per-machine wrapper script(`native-messaging-host.sh`,
// install.sh가 생성)를 통해 이걸 호출. Chrome NM 환경의 제한된 PATH는
// env로 `node`를 resolve 못하는 경우가 많아서 wrapper 간접 호출이
// nvm/fnm/asdf/시스템 설치 전반에서 host를 runnable하게 만드는 핵심.
'use strict';

const ProxyServer = require('./proxy-server');

// ============================================================
// Chrome Native Messaging 프로토콜
// 메시지: 4-byte little-endian 길이 prefix + UTF-8 JSON
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
      // 메시지가 너무 큼 (Chrome 한도는 1MB)
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
// Proxy 인스턴스
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

  // 초기 URL/Method 필터 적용
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

  proxy.on('header_swap_consumed', (data) => {
    sendMessage({ type: 'header_swap_consumed', ...data });
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
// 메시지 핸들러
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

    case 'register_header_swap':
      if (proxy) {
        proxy.registerHeaderSwap(msg.payload || {});
        sendMessage({ type: 'header_swap_registered' });
      } else {
        sendMessage({ type: 'error', message: 'Proxy not running — cannot register header swap' });
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
// Stdin/Stdout 설정
// ============================================================

process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  parseMessages(handleMessage);
});

process.stdin.on('end', () => {
  // 확장이 disconnect
  if (proxy) {
    proxy.forwardAllPending();
    proxy.stop().then(() => process.exit(0));
  } else {
    process.exit(0);
  }
});

process.stdin.on('error', () => process.exit(1));
process.stdout.on('error', () => process.exit(1));

// Defense-in-depth: async 경로가 throw해도 host를 살려둠 → 단일
// bad request가 proxy를 죽여서 Intercept를 explanation 없이 off-line
// 으로 만들지 않도록. 에러는 다시 보고되어 패널이 silently disconnect
// 대신 노출 가능.
process.on('unhandledRejection', (reason) => {
  try {
    sendMessage({
      type: 'error',
      message: 'unhandledRejection: ' + (reason && reason.message ? reason.message : String(reason)),
    });
  } catch {}
});
process.on('uncaughtException', (err) => {
  try {
    sendMessage({
      type: 'error',
      message: 'uncaughtException: ' + (err && err.message ? err.message : String(err)),
    });
  } catch {}
});

// 확장에 host ready 알림
sendMessage({ type: 'host_ready', pid: process.pid });
