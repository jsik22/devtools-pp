// ============================================================
// Background Service Worker - Relay Hub
// Native Messaging <-> Panel communication + Proxy settings
// ============================================================

const NATIVE_HOST_NAME = 'com.devtools_pp.proxy';

let nativePort = null;
const panelPorts = new Map(); // tabId -> port

// ============================================================
// 1. Content script 등록 (기존 legacy 모드 유지)
// ============================================================
chrome.scripting.registerContentScripts([{
  id: 'intercept-hook',
  matches: ['<all_urls>'],
  js: ['intercept-hook.js'],
  runAt: 'document_start',
  world: 'MAIN',
  allFrames: true,
}]).catch(() => {
  chrome.scripting.updateContentScripts([{
    id: 'intercept-hook',
    matches: ['<all_urls>'],
    js: ['intercept-hook.js'],
    runAt: 'document_start',
    world: 'MAIN',
    allFrames: true,
  }]).catch(() => {});
});

// ============================================================
// 2. Panel 연결 관리
// ============================================================
chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith('panel-')) return;

  const tabId = parseInt(port.name.split('-')[1]);
  panelPorts.set(tabId, port);

  port.onMessage.addListener((msg) => {
    handlePanelMessage(tabId, msg);
  });

  port.onDisconnect.addListener(() => {
    panelPorts.delete(tabId);
    // 모든 패널이 닫히면 프록시 중지
    if (panelPorts.size === 0 && nativePort) {
      sendToNative({ type: 'intercept_off' });
      resetProxySettings();
    }
  });
});

// ============================================================
// 3. Native Messaging 연결
// ============================================================
function connectNative() {
  if (nativePort) return true;

  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch (err) {
    broadcastToPanels({ type: 'native_error', message: 'Failed to connect: ' + err.message });
    return false;
  }

  nativePort.onMessage.addListener((msg) => {
    // proxy_started 수신 시 브라우저 프록시 설정 적용
    if (msg.type === 'proxy_started') {
      setProxySettings(msg.port || 8899);
    }
    // 프록시에서 온 메시지를 모든 패널에 전달
    broadcastToPanels(msg);
  });

  nativePort.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError;
    nativePort = null;
    resetProxySettings();
    broadcastToPanels({
      type: 'native_disconnected',
      message: error ? error.message : 'Native host disconnected',
    });
  });

  return true;
}

function sendToNative(msg) {
  if (!nativePort) {
    if (!connectNative()) return;
  }
  try {
    nativePort.postMessage(msg);
  } catch (err) {
    broadcastToPanels({ type: 'native_error', message: 'Send failed: ' + err.message });
  }
}

function broadcastToPanels(msg) {
  panelPorts.forEach((port) => {
    try { port.postMessage(msg); } catch {}
  });
}

// ============================================================
// 4. Panel 메시지 핸들링
// ============================================================
function handlePanelMessage(tabId, msg) {
  switch (msg.type) {
    case 'intercept_on':
      connectNative();
      sendToNative({ type: 'intercept_on', config: msg.config || {} });
      // proxy_started 메시지 수신 시 setProxySettings 호출됨 (onMessage 리스너)
      break;

    case 'intercept_off':
      sendToNative({ type: 'intercept_off' });
      resetProxySettings();
      break;

    case 'decision':
      sendToNative(msg);
      break;

    case 'update_config':
      sendToNative(msg);
      break;

    case 'ping':
      sendToNative({ type: 'ping' });
      break;

    case 'shutdown_proxy':
      sendToNative({ type: 'shutdown' });
      resetProxySettings();
      break;
  }
}

// ============================================================
// 5. Chrome Proxy Settings 관리
// ============================================================
function setProxySettings(port) {
  chrome.proxy.settings.set({
    value: {
      mode: 'fixed_servers',
      rules: {
        singleProxy: {
          scheme: 'http',
          host: '127.0.0.1',
          port: port,
        },
        bypassList: [
          '<local>',
          '127.0.0.1',
          'localhost',
          'chrome-extension://*',
          // Chrome 내부 sync/update 도메인
          'clients*.google.com',
          'update.googleapis.com',
          '*.gvt1.com',
          '*.gvt2.com',
          'optimizationguide-pa.googleapis.com',
          'content-autofill.googleapis.com',
          'safebrowsing.googleapis.com',
        ],
      },
    },
    scope: 'regular',
  }, () => {
    if (chrome.runtime.lastError) {
      broadcastToPanels({
        type: 'proxy_settings_error',
        message: chrome.runtime.lastError.message,
      });
    }
  });
}

function resetProxySettings() {
  chrome.proxy.settings.clear({ scope: 'regular' }, () => {
    // ignore errors on clear
  });
}

// ============================================================
// 6. Setup page: check_native handler
// ============================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'check_native') return;

  // Try connecting to the native host to verify it's installed
  let testPort = null;
  try {
    testPort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch (err) {
    sendResponse({ connected: false, error: err.message });
    return;
  }

  const timeout = setTimeout(() => {
    try { testPort.disconnect(); } catch {}
    sendResponse({ connected: false, error: 'Connection timed out' });
  }, 3000);

  testPort.onMessage.addListener((response) => {
    clearTimeout(timeout);
    if (response.type === 'host_ready') {
      // Host is working — shut it down and report success
      try { testPort.disconnect(); } catch {}
      // If no panel was using the native port, keep nativePort null
      sendResponse({ connected: true });
    }
  });

  testPort.onDisconnect.addListener(() => {
    clearTimeout(timeout);
    const error = chrome.runtime.lastError;
    sendResponse({ connected: false, error: error ? error.message : 'Disconnected' });
  });

  return true; // async sendResponse
});

// ============================================================
// 7. Proxy error listener
// ============================================================
chrome.proxy.onProxyError.addListener((details) => {
  broadcastToPanels({
    type: 'proxy_error',
    message: details.error,
    details: details.details,
  });
});
