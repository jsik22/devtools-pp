// ============================================================
// Background Service Worker - 릴레이 허브
// Native Messaging <-> Panel 통신 + Proxy 설정
// ============================================================

const NATIVE_HOST_NAME = 'com.devtools_pp.proxy';

let nativePort = null;
const panelPorts = new Map(); // tabId -> port

// ============================================================
// 1. Panel 연결 관리
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
    // 이 탭의 DNR tag 룰을 항상 드롭 — 패널이 사라진 상태로 남겨두면
    // 브라우저가 여전히 활성 proxy 설정을 사용 중일 때
    // X-DevToolsPP-Tab 헤더가 origin 서버로 leak될 수 있음.
    removeTabTagRule(tabId);
    // 모든 패널이 닫히면 proxy 중지
    if (panelPorts.size === 0 && nativePort) {
      sendToNative({ type: 'intercept_off' });
      resetProxySettings();
    }
  });
});

// ============================================================
// 2. Native Messaging 연결
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
    // proxy_started 수신 시 브라우저 proxy 설정 적용
    if (msg.type === 'proxy_started') {
      setProxySettings(msg.port || 8899);
    }
    // in-flight register_header_swap 호출 resolve — openNewTabForIntercept
    // 가 launcher navigation 타이밍을 맞추는 데 사용.
    if (msg.type === 'header_swap_registered') {
      _flushSwapRegisteredAcks();
    }
    // 프록시가 swap을 요청에 발화 — 새 탭의 DNR tag 룰을 드롭해서
    // 그 탭의 후속 navigation은 인터셉트되지 않도록 (일회성 Send-to-
    // Browser 시맨틱).
    if (msg.type === 'header_swap_consumed' && msg.tabId != null) {
      removeNewTabTagRule(parseInt(msg.tabId, 10));
    }
    // 프록시 → 모든 패널로 메시지 forward
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
// 3. Panel 메시지 처리
// ============================================================
function handlePanelMessage(tabId, msg) {
  switch (msg.type) {
    case 'intercept_on':
      connectNative();
      // 프록시가 routing을 시작하기 전에 이 inspected 탭의 요청을 태그
      // → 프록시가 그 탭에서 태그 없는(racing) 요청을 보지 않도록.
      addTabTagRule(tabId);
      sendToNative({ type: 'intercept_on', config: msg.config || {} });
      // setProxySettings는 proxy_started 메시지 수신 시 호출됨 (onMessage 리스너)
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
      // Async — 패널이 응답 필요 없음. 실패 시 `send_to_browser_error`
      // 를 브로드캐스트해서 패널이 노출 가능하도록.
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
// 4. Chrome Proxy Settings 관리
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
    // clear 시 에러 무시
  });
}

// service worker 시작 시 이전 세션의 stale proxy 설정 clear.
// chrome.proxy.settings(scope: 'regular')는 브라우저 재시작 사이에
// persistent하므로 Intercept 활성 중 Chrome이 죽으면 사용자는 native
// proxy가 안 돌고 있어서 ERR_PROXY_CONNECTION_FAILED를 만남. 여기서
// 가장 먼저 설정 드롭; 사용자가 Intercept를 재활성화하면 panel.js가
// intercept_on을 발행해 proxy를 재시작하고 설정을 재적용.
resetProxySettings();

// action popup이 미러링하는 UI 상태 clear. 패널은 apply/start/stop
// 시 이걸 쓰지만 Chrome 종료 시 정리 못함(DevTools가 panel teardown
// 없이 닫힘) → 이게 없으면 popup이 어떤 panel도 실제로 enforce하지
// 않는 scope/monitoring 상태를 보고함. onStartup은 profile 시작에서만
// 발화, 모든 SW wake에서가 아님 → 우리가 원하는 것. wake-during-active-
// session은 패널의 자체 persistent 상태를 wipe하면 안 되니까.
chrome.runtime.onStartup.addListener(() => {
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.remove(['globalScopeInput', 'networkMonitoring']);
  }
});

// ============================================================
// 5. declarativeNetRequest를 통한 탭 스코프 요청 태깅
// inspected 탭의 요청만 X-DevToolsPP-Tab 헤더를 가지므로, 로컬 프록시가
// tab 소유권 기반으로 interception을 게이팅 가능. 다른 탭, service
// worker, 확장의 요청은 헤더를 갖지 않아 프록시가 bypass. 프록시는
// origin 서버로 forwarding 전 헤더 제거.
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
// Send-to-Browser: 캡처된 요청을 새 탭에서 Intercept를 통해 오픈
// ============================================================
// 패널에서 열린 새 탭은 `main_frame`만으로 scope된 별도 DNR 룰을
// 받음 — 렌더된 페이지의 subresource fetch(CSS/JS/이미지)가 Intercept
// 큐를 flood하면 안 됨. 룰은 프록시가 등록된 header swap을 consume
// 하거나 탭이 닫힐 때 자동 제거.
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
          // main_frame만 — 페이지 렌더링 subresource는 untagged로
          // 유지되어 intercept 큐를 bypass.
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

// native에서 오는 `header_swap_registered` 메시지로 resolve되는 Promise
// 큐. openNewTabForIntercept가 프록시가 swap을 실제로 메모리에 갖기
// 전에 launcher로 제어권 넘기지 않도록 사용.
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

// 새 탭 id 키의 pending payload. launcher.html 페이지(새 탭에 로드)가
// 부팅하면 chrome.runtime.sendMessage로 페이로드를 요청; 우리가 돌려주면
// 페이지가 navigate/submit.
const pendingLaunches = new Map();
const pendingLaunchWaiters = new Map(); // tabId -> setup 완료까지 대기 중인 sendResponse fn

async function openNewTabForIntercept(payload) {
  if (!payload || !payload.url || !payload.method) {
    throw new Error('Invalid payload');
  }
  if (!nativePort) {
    throw new Error('Native host not connected — enable Intercept first');
  }

  // Step 1: launcher 페이지로 탭 오픈. 캡처된 URL로 직접 navigate
  // 안 함 — DNR 룰이 아직 없는 상태고 navigation을 untagged proxy
  // entry 너머로 race할 수 있음.
  const launcherUrl = chrome.runtime.getURL('panel/launcher.html');
  const tab = await chrome.tabs.create({ url: launcherUrl, active: true });
  const newTabId = tab.id;

  try {
    // Step 2: 이 탭의 main_frame 요청 태그
    await addNewTabTagRule(newTabId);

    // Step 3: 원본 요청에서 캡처된 header swap(Authorization, X-* 등)
    // 을 프록시에 등록
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

    // Step 4: payload 저장 → launcher_ready가 fetch 가능. ack 대기
    // 중에 launcher가 이미 물었다면 parked된 sendResponse를 지금
    // fulfill.
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

// launcher 페이지가 로드되자마자 페이로드 요청. 우리가 직접 응답해서
// 페이지가 navigation/form submit을 발화 가능하도록.
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
    // Setup 아직 미완 — sendResponse를 park하고 ack 도착 시
    // openNewTabForIntercept가 fulfill하도록.
    pendingLaunchWaiters.set(tabId, sendResponse);
    return true; // async 응답을 위해 메시지 채널 열린 상태 유지
  }
});

// 탭 닫힘 — 그 탭의 룰과 pending 상태 모두 드롭.
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
// 6. Setup 페이지: check_native 핸들러
// ============================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 이 확장의 자체 컨텍스트에서 오는 메시지만 수락. 외부 확장,
  // 웹 페이지의 content script, 다른 origin은 무시 → 적대적 페이지가
  // 우리를 통해 Native Messaging 호스트를 probe하는 것을 방지.
  if (!sender || sender.id !== chrome.runtime.id) return;
  if (!msg || msg.type !== 'check_native') return;

  // native host 연결 시도 → 설치 여부 확인
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
      // 호스트 동작 — 종료하고 성공 보고
      try { testPort.disconnect(); } catch {}
      // 어떤 panel도 native port를 쓰고 있지 않았으면 nativePort는 null 유지
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
// 6b. Background를 통한 Replay fetch (CORS bypass)
//
// Replay 탭은 보통 inspected 페이지 컨텍스트에서 요청을 보냄(페이지의
// 쿠키, sessionStorage 토큰 등이 적용되도록). 페이지에서의 cross-origin
// 요청은 일반 CORS 게이트에 걸리므로, www.example.com에서
// static.example.com으로의 요청은 자산 호스트가 Access-Control-Allow-
// Origin을 반환하지 않으면 실패.
//
// fallback으로 panel은 같은 요청을 service worker에서 재발행 가능.
// service worker는 <all_urls> host_permissions가 있고 page-level
// CORS 적용을 받지 않음. 쿠키는 credentials:'include'로 SameSite=Lax/
// None 호스트에 여전히 따라감.
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
// 7. Proxy 에러 리스너
// ============================================================
chrome.proxy.onProxyError.addListener((details) => {
  broadcastToPanels({
    type: 'proxy_error',
    message: details.error,
    details: details.details,
  });
});
