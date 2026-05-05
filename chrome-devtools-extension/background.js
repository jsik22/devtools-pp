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
    // Resolve any in-flight register_header_swap calls — used by
    // openNewTabForIntercept to time the launcher navigation correctly.
    if (msg.type === 'header_swap_registered') {
      _flushSwapRegisteredAcks();
    }
    // The proxy fired the swap into a request — drop the new tab's
    // DNR tag rule so subsequent navigations in that tab are not
    // intercepted (one-shot Send-to-Browser semantics).
    if (msg.type === 'header_swap_consumed' && msg.tabId != null) {
      removeNewTabTagRule(parseInt(msg.tabId, 10));
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

    case 'register_header_swap':
      sendToNative(msg);
      break;

    case 'open_new_tab_for_intercept':
      // Async — panel doesn't need a reply, but if anything fails we
      // broadcast a `send_to_browser_error` so the panel can surface it.
      openNewTabForIntercept(msg.payload || {}).catch((err) => {
        broadcastToPanels({
          type: 'send_to_browser_error',
          message: err && err.message ? err.message : String(err),
        });
      });
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

// Clear UI state that the action popup mirrors. The panel writes these
// on apply/start/stop but can't clean up on Chrome shutdown (DevTools
// closes without firing panel teardown), so without this the popup
// reports a scope/monitoring state that no panel is actually enforcing.
// onStartup fires only on profile start, not every SW wake — that's
// what we want, since wake-during-active-session would wipe the panel's
// own persisted state.
chrome.runtime.onStartup.addListener(() => {
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.remove(['globalScopeInput', 'networkMonitoring']);
  }
});

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
// Send-to-Browser: open captured request in a new tab through Intercept
// ============================================================
// New tabs opened from the panel get a separate DNR rule scoped to
// `main_frame` only — subresource fetches (CSS/JS/images) on the
// rendered page should not flood the Intercept queue. The rule is
// removed automatically when the proxy consumes the registered header
// swap, or when the tab closes.
const DNR_RULE_BASE_NEW_TAB = 20000;

async function addNewTabTagRule(tabId) {
  const ruleId = DNR_RULE_BASE_NEW_TAB + tabId;
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
          // main_frame only — render-on-the-page subresources stay
          // untagged and bypass the intercept queue.
          resourceTypes: ['main_frame'],
        },
      }],
    });
  } catch (err) {
    broadcastToPanels({
      type: 'native_error',
      message: 'New-tab DNR rule add failed: ' + err.message,
    });
  }
}

async function removeNewTabTagRule(tabId) {
  const ruleId = DNR_RULE_BASE_NEW_TAB + tabId;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
    });
  } catch {}
}

// Promise queue resolved by `header_swap_registered` messages from
// native. Used so openNewTabForIntercept doesn't surrender control to
// the launcher before the proxy actually has the swap in memory.
let _swapRegisteredAcks = [];
function _flushSwapRegisteredAcks() {
  const list = _swapRegisteredAcks;
  _swapRegisteredAcks = [];
  for (const fn of list) { try { fn(); } catch {} }
}
function waitForSwapRegistered(timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      _swapRegisteredAcks = _swapRegisteredAcks.filter(fn => fn !== resolver);
      reject(new Error('register_header_swap ack timeout'));
    }, timeoutMs || 3000);
    const resolver = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve();
    };
    _swapRegisteredAcks.push(resolver);
  });
}

// Pending payloads keyed by new tab id. The launcher.html page (loaded
// in the new tab) asks for its payload via chrome.runtime.sendMessage
// once it boots; we hand it back and the page navigates / submits.
const pendingLaunches = new Map();
const pendingLaunchWaiters = new Map(); // tabId -> sendResponse fn parked while setup completes

async function openNewTabForIntercept(payload) {
  if (!payload || !payload.url || !payload.method) {
    throw new Error('Invalid payload');
  }
  if (!nativePort) {
    throw new Error('Native host not connected — enable Intercept first');
  }

  // Step 1: open a tab with the launcher page. We don't navigate to
  // the captured URL directly because the DNR rule isn't in place yet
  // and we'd race the navigation past an untagged proxy entry.
  const launcherUrl = chrome.runtime.getURL('panel/launcher.html');
  const tab = await chrome.tabs.create({ url: launcherUrl, active: true });
  const newTabId = tab.id;

  try {
    // Step 2: tag this tab's main_frame requests
    await addNewTabTagRule(newTabId);

    // Step 3: register the header swap with the proxy (Authorization,
    // X-*, etc. captured from the original request)
    const ack = waitForSwapRegistered(3000);
    sendToNative({
      type: 'register_header_swap',
      payload: {
        tabId: newTabId,
        url: payload.url,
        headers: payload.headers || {},
      },
    });
    await ack;

    // Step 4: store payload so launcher_ready can fetch it. If the
    // launcher already asked while we were waiting for the ack, fulfill
    // the parked sendResponse now.
    const parked = pendingLaunchWaiters.get(newTabId);
    if (parked) {
      pendingLaunchWaiters.delete(newTabId);
      parked({ ok: true, payload });
    } else {
      pendingLaunches.set(newTabId, payload);
    }
  } catch (err) {
    // Setup failed — clean up the tag rule and tab so we don't leak
    // a half-configured intercept slot.
    removeNewTabTagRule(newTabId);
    pendingLaunches.delete(newTabId);
    pendingLaunchWaiters.delete(newTabId);
    try { await chrome.tabs.remove(newTabId); } catch {}
    throw err;
  }
}

// Launcher page asks for its payload as soon as it loads. We respond
// directly so the page can fire the navigation/form submit.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) return;
  if (!msg || msg.type !== 'launcher_ready') return;
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) {
    sendResponse({ ok: false, error: 'No tab id' });
    return;
  }
  if (pendingLaunches.has(tabId)) {
    const payload = pendingLaunches.get(tabId);
    pendingLaunches.delete(tabId);
    sendResponse({ ok: true, payload });
  } else {
    // Setup not done yet — park sendResponse and let
    // openNewTabForIntercept fulfill it once the ack lands.
    pendingLaunchWaiters.set(tabId, sendResponse);
    return true; // keep the message channel open for async response
  }
});

// Tab closed — drop any rules and pending state for that tab.
chrome.tabs.onRemoved.addListener((tabId) => {
  removeNewTabTagRule(tabId);
  pendingLaunches.delete(tabId);
  const parked = pendingLaunchWaiters.get(tabId);
  if (parked) {
    try { parked({ ok: false, error: 'Tab closed' }); } catch {}
    pendingLaunchWaiters.delete(tabId);
  }
});

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
// 6b. Replay fetch via background (CORS bypass)
//
// The Replay tab normally sends its requests from the inspected page
// context (so the page's cookies, sessionStorage tokens, etc. all
// apply). Cross-origin requests from a page hit the regular CORS
// gates, so a request from www.example.com to static.example.com
// fails when the asset host doesn't return Access-Control-Allow-Origin.
//
// As a fallback the panel can re-issue the same request from the
// service worker, which has <all_urls> host_permissions and is not
// subject to page-level CORS. Cookies still ride along via
// credentials:'include' for SameSite=Lax/None hosts.
// ============================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) return;
  if (!msg || msg.type !== 'replay_fetch') return;

  const init = {
    method: msg.method || 'GET',
    headers: msg.headers || {},
    credentials: 'include',
    redirect: 'follow',
  };
  if (msg.body != null && init.method !== 'GET' && init.method !== 'HEAD') {
    init.body = msg.body;
  }

  const startTime = performance.now();
  fetch(msg.url, init)
    .then(async (resp) => {
      const elapsed = Math.round(performance.now() - startTime);
      const respHeaders = {};
      resp.headers.forEach((v, k) => { respHeaders[k] = v; });
      const text = await resp.text();
      sendResponse({
        ok: true,
        status: resp.status,
        statusText: resp.statusText,
        headers: respHeaders,
        body: text,
        time: elapsed,
        url: resp.url,
        redirected: resp.redirected,
      });
    })
    .catch((err) => {
      const elapsed = Math.round(performance.now() - startTime);
      sendResponse({
        ok: false,
        error: err && err.message ? err.message : String(err),
        time: elapsed,
      });
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
