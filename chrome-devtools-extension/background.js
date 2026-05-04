// ============================================================
// Background Service Worker - Relay Hub
// Native Messaging <-> Panel communication + Proxy settings
// ============================================================

const NATIVE_HOST_NAME = 'com.devtools_pp.proxy';

let nativePort = null;
const panelPorts = new Map(); // tabId -> port

// ============================================================
// 1. Panel connection management
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
    // Always drop this tab's DNR tag rule — leaving it in place while the
    // panel is gone would leak the X-DevToolsPP-Tab header to origin servers
    // if the browser kept using the still-active proxy settings.
    removeTabTagRule(tabId);
    // Stop proxy when all panels are closed
    if (panelPorts.size === 0 && nativePort) {
      sendToNative({ type: 'intercept_off' });
      resetProxySettings();
    }
  });
});

// ============================================================
// 2. Native Messaging connection
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
    // Apply browser proxy settings when proxy_started is received
    if (msg.type === 'proxy_started') {
      setProxySettings(msg.port || 8899);
    }
    // Forward messages from proxy to all panels
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
// 3. Panel message handling
// ============================================================
function handlePanelMessage(tabId, msg) {
  switch (msg.type) {
    case 'intercept_on':
      connectNative();
      // Tag requests from this inspected tab before the proxy starts routing,
      // so the proxy never sees an untagged (racing) request from it.
      addTabTagRule(tabId);
      sendToNative({ type: 'intercept_on', config: msg.config || {} });
      // setProxySettings is called when proxy_started message is received (onMessage listener)
      break;

    case 'intercept_off':
      removeTabTagRule(tabId);
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
// 4. Chrome Proxy Settings management
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
          // Chrome internal sync/update domains
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

// On service worker startup, clear any stale proxy settings left over
// from a previous session. chrome.proxy.settings (scope: 'regular') is
// persistent across browser restarts, so if Chrome was killed while
// Intercept was active the user comes back to ERR_PROXY_CONNECTION_FAILED
// because the native proxy isn't running. The first thing we do here is
// drop the setting; if the user re-enables Intercept, panel.js issues
// intercept_on which restarts the proxy and reapplies settings.
resetProxySettings();

// ============================================================
// 5. Tab-scoped request tagging via declarativeNetRequest
// Only requests from the inspected tab carry an X-DevToolsPP-Tab header,
// so the local proxy can gate interception on tab ownership. Requests from
// other tabs, service workers, or extensions never carry the header and
// are bypassed by the proxy. The proxy strips the header before forwarding
// to the origin server.
// ============================================================
const DNR_RULE_BASE = 10000;
const TAG_HEADER_NAME = 'X-DevToolsPP-Tab';
const DNR_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket',
  'webtransport', 'webbundle', 'other',
];

async function addTabTagRule(tabId) {
  const ruleId = DNR_RULE_BASE + tabId;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [{
        id: ruleId,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: TAG_HEADER_NAME, operation: 'set', value: String(tabId) },
          ],
        },
        condition: {
          tabIds: [tabId],
          resourceTypes: DNR_RESOURCE_TYPES,
        },
      }],
    });
  } catch (err) {
    broadcastToPanels({
      type: 'native_error',
      message: 'DNR tag rule add failed: ' + err.message,
    });
  }
}

async function removeTabTagRule(tabId) {
  const ruleId = DNR_RULE_BASE + tabId;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
    });
  } catch {}
}

// ============================================================
// 6. Setup page: check_native handler
// ============================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only accept messages from this extension's own contexts. Ignore
  // anything from external extensions, content scripts on web pages,
  // or other origins to avoid hostile pages probing the Native
  // Messaging host through us.
  if (!sender || sender.id !== chrome.runtime.id) return;
  if (!msg || msg.type !== 'check_native') return;

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
