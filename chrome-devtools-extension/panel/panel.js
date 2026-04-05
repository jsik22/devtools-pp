// ============================================================
// DevTools Inspector Panel - 메인 스크립트
// ============================================================

const tabId = chrome.devtools.inspectedWindow.tabId;

// --- 탭 전환 ---
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab).classList.add('active');
  });
});

// ============================================================
// 1. Network 모니터링 (chrome.devtools.network API 사용 - debugger 불필요)
// ============================================================
const networkRequests = [];
const networkRequestMap = new Map(); // requestId -> request object
let networkMonitoring = false;
let selectedRequestId = null;
let networkIdCounter = 0;

const networkTable = document.querySelector('#network-table tbody');
const networkCount = document.getElementById('network-count');
const networkFilter = document.getElementById('network-filter');
const networkDetail = document.getElementById('network-detail');
const networkSplit = document.querySelector('.network-split');

document.getElementById('network-start').addEventListener('click', startNetworkMonitoring);
document.getElementById('network-stop').addEventListener('click', stopNetworkMonitoring);
document.getElementById('network-clear').addEventListener('click', clearNetwork);
networkFilter.addEventListener('input', renderNetworkTable);

// Detail panel 탭 전환
document.querySelectorAll('.detail-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.detail-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('detail-' + tab.dataset.detail).classList.add('active');
  });
});

// Detail panel 닫기
document.getElementById('detail-close').addEventListener('click', closeDetail);

function closeDetail() {
  networkDetail.classList.add('hidden');
  networkSplit.classList.remove('has-detail');
  selectedRequestId = null;
  networkTable.querySelectorAll('tr.selected').forEach(r => r.classList.remove('selected'));
}

// chrome.devtools.network 이벤트 리스너 (항상 동작, 별도 attach 불필요)
chrome.devtools.network.onRequestFinished.addListener((harEntry) => {
  if (!networkMonitoring) return;

  const reqId = 'net_' + (++networkIdCounter);
  const r = harEntry.request;
  const resp = harEntry.response;

  // request headers → object
  const requestHeaders = {};
  (r.headers || []).forEach(h => { requestHeaders[h.name] = h.value; });

  // response headers → object
  const responseHeaders = {};
  (resp.headers || []).forEach(h => { responseHeaders[h.name] = h.value; });

  // post data
  let postData = null;
  if (r.postData) {
    postData = r.postData.text || null;
  }

  const req = {
    requestId: reqId,
    method: r.method,
    url: r.url,
    startTime: null,
    status: resp.status,
    statusText: resp.statusText || '',
    type: resp.content?.mimeType?.split('/').pop() || '-',
    mimeType: resp.content?.mimeType || '',
    size: resp.content?.size ? formatBytes(resp.content.size) : (resp._transferSize ? formatBytes(resp._transferSize) : '-'),
    time: harEntry.time ? Math.round(harEntry.time) + ' ms' : '-',
    protocol: resp.httpVersion || '',
    remoteAddress: '',
    requestHeaders: requestHeaders,
    requestPostData: postData,
    responseHeaders: responseHeaders,
    responseBody: null,
    responseBodyLoaded: false,
    responseBase64: false,
    _harEntry: harEntry, // HAR 원본 참조 (body 로딩용)
  };

  networkRequests.push(req);
  networkRequestMap.set(reqId, req);
  renderNetworkTable();
});

function startNetworkMonitoring() {
  networkMonitoring = true;
  document.getElementById('network-start').disabled = true;
  document.getElementById('network-stop').disabled = false;
}

function stopNetworkMonitoring() {
  networkMonitoring = false;
  document.getElementById('network-start').disabled = false;
  document.getElementById('network-stop').disabled = true;
}

function clearNetwork() {
  networkRequests.length = 0;
  networkRequestMap.clear();
  closeDetail();
  renderNetworkTable();
}

function fetchResponseBody(req) {
  if (req.responseBodyLoaded) return;
  if (!req._harEntry) return;
  req._harEntry.getContent((body, encoding) => {
    if (body !== undefined && body !== null) {
      req.responseBody = body;
      req.responseBase64 = (encoding === 'base64');
      req.responseBodyLoaded = true;
      if (selectedRequestId === req.requestId) {
        renderResponseBody(req);
        renderPreview(req);
      }
    }
  });
}

function renderNetworkTable() {
  const filter = networkFilter.value.toLowerCase();
  const filtered = filter
    ? networkRequests.filter(r => r.url.toLowerCase().includes(filter))
    : networkRequests;

  networkCount.textContent = `${filtered.length} requests`;
  networkTable.innerHTML = filtered.map(r => {
    const statusClass = r.status >= 400 ? 'status-error'
      : r.status >= 300 ? 'status-redirect'
      : r.status >= 200 ? 'status-ok' : '';
    const selectedClass = r.requestId === selectedRequestId ? 'selected' : '';
    return `<tr class="${selectedClass}" data-request-id="${escapeHtml(r.requestId)}">
      <td><strong>${escapeHtml(r.method)}</strong></td>
      <td title="${escapeHtml(r.url)}">${escapeHtml(truncateUrl(r.url))}</td>
      <td class="${statusClass}">${r.status}</td>
      <td>${escapeHtml(r.type)}</td>
      <td>${r.size}</td>
      <td>${r.time}</td>
    </tr>`;
  }).join('');

  // 행 클릭 이벤트
  networkTable.querySelectorAll('tr').forEach(row => {
    row.addEventListener('click', () => {
      const reqId = row.dataset.requestId;
      const req = networkRequestMap.get(reqId);
      if (!req) return;

      // 선택 상태 업데이트
      networkTable.querySelectorAll('tr.selected').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      selectedRequestId = reqId;

      // 상세 패널 표시
      networkDetail.classList.remove('hidden');
      networkSplit.classList.add('has-detail');
      showDetail(req);

      // 아직 body를 못 가져왔으면 시도
      if (!req.responseBodyLoaded) {
        fetchResponseBody(req);
      }
    });
  });
}

// ============================================================
// Network Detail Panel
// ============================================================

function showDetail(req) {
  renderGeneralInfo(req);
  renderHeaders(req);
  renderPayload(req);
  renderResponseBody(req);
  renderPreview(req);
}

function makeSectionHtml(title, id, rows) {
  return `
    <div class="section-title" data-section-id="${id}">
      <span class="arrow" id="arrow-${id}">&#9660;</span>${escapeHtml(title)}
    </div>
    <div class="section-body" id="body-${id}">
      ${rows}
    </div>
  `;
}

// 이벤트 위임으로 section toggle 처리 (인라인 onclick은 MV3 CSP에서 차단됨)
document.addEventListener('click', (e) => {
  const titleEl = e.target.closest('.section-title[data-section-id]');
  if (!titleEl) return;
  const id = titleEl.dataset.sectionId;
  const body = document.getElementById('body-' + id);
  if (!body) return;
  const isCollapsed = body.classList.toggle('collapsed');
  titleEl.classList.toggle('collapsed', isCollapsed);
});

function headerRowsHtml(headers, extraClass) {
  const cls = extraClass || '';
  return Object.entries(headers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) =>
      `<div class="header-row ${cls}">
        <span class="header-name">${escapeHtml(name)}</span>
        <span class="header-value">${escapeHtml(value)}</span>
      </div>`
    ).join('');
}

function renderGeneralInfo(req) {
  const container = document.getElementById('detail-general');
  const general = {
    'Request URL': req.url,
    'Request Method': req.method,
    'Status Code': `${req.status} ${req.statusText}`,
  };
  if (req.remoteAddress) general['Remote Address'] = req.remoteAddress;
  if (req.protocol) general['Protocol'] = req.protocol;

  const rows = Object.entries(general).map(([name, value]) => {
    const statusHtml = name === 'Status Code'
      ? `<span class="${req.status >= 400 ? 'status-error' : req.status >= 300 ? 'status-redirect' : 'status-ok'} status-code">${escapeHtml(value)}</span>`
      : escapeHtml(value);
    return `<div class="header-row general-row">
      <span class="header-name">${escapeHtml(name)}:</span>
      <span class="header-value">${statusHtml}</span>
    </div>`;
  }).join('');

  container.innerHTML = makeSectionHtml('General', 'general', rows);
}

function renderHeaders(req) {
  // Response headers
  const respContainer = document.getElementById('detail-response-headers');
  const respCount = Object.keys(req.responseHeaders).length;
  if (respCount > 0) {
    respContainer.innerHTML = makeSectionHtml(
      `Response Headers (${respCount})`,
      'resp-headers',
      headerRowsHtml(req.responseHeaders)
    );
  } else {
    respContainer.innerHTML = '';
  }

  // Request headers
  const reqContainer = document.getElementById('detail-request-headers');
  const reqCount = Object.keys(req.requestHeaders).length;
  if (reqCount > 0) {
    reqContainer.innerHTML = makeSectionHtml(
      `Request Headers (${reqCount})`,
      'req-headers',
      headerRowsHtml(req.requestHeaders)
    );
  } else {
    reqContainer.innerHTML = '';
  }
}

function renderPayload(req) {
  const queryContainer = document.getElementById('detail-query-params');
  const bodyContainer = document.getElementById('detail-request-body');

  // Query string parameters
  try {
    const url = new URL(req.url);
    const params = Array.from(url.searchParams.entries());
    if (params.length > 0) {
      const rows = params.map(([name, value]) =>
        `<div class="query-param-row">
          <span class="param-name">${escapeHtml(decodeURIComponent(name))}</span>
          <span class="param-value">${escapeHtml(decodeURIComponent(value))}</span>
        </div>`
      ).join('');
      queryContainer.innerHTML = makeSectionHtml(`Query String Parameters (${params.length})`, 'query-params', rows);
    } else {
      queryContainer.innerHTML = '';
    }
  } catch {
    queryContainer.innerHTML = '';
  }

  // Request body (POST data)
  if (req.requestPostData) {
    let bodyHtml;
    // Try to parse as form data
    try {
      const parsed = new URLSearchParams(req.requestPostData);
      const entries = Array.from(parsed.entries());
      if (entries.length > 0 && !req.requestPostData.startsWith('{') && !req.requestPostData.startsWith('[')) {
        const rows = entries.map(([name, value]) =>
          `<div class="query-param-row">
            <span class="param-name">${escapeHtml(name)}</span>
            <span class="param-value">${escapeHtml(value)}</span>
          </div>`
        ).join('');
        bodyHtml = rows;
      } else {
        throw new Error('not form data');
      }
    } catch {
      // Try JSON
      let formatted = req.requestPostData;
      try {
        formatted = JSON.stringify(JSON.parse(req.requestPostData), null, 2);
      } catch { /* keep raw */ }
      bodyHtml = `<div class="response-body-content">${syntaxHighlightJson(formatted)}</div>`;
    }
    bodyContainer.innerHTML = makeSectionHtml('Request Body', 'req-body', bodyHtml);
  } else {
    bodyContainer.innerHTML = '';
  }
}

function renderResponseBody(req) {
  const container = document.getElementById('detail-response-body');
  if (!req.responseBodyLoaded) {
    container.innerHTML = '<div class="detail-loading">Loading response body...</div>';
    return;
  }
  if (req.responseBody === null || req.responseBody === undefined) {
    container.innerHTML = '<div class="detail-loading">Response body not available.</div>';
    return;
  }
  if (req.responseBase64) {
    container.innerHTML = `<div class="response-body-content" style="color:#999">[Base64 encoded data - ${formatBytes(req.responseBody.length)} encoded]</div>`;
    return;
  }

  let body = req.responseBody;
  // Try to pretty-print JSON
  try {
    const parsed = JSON.parse(body);
    body = JSON.stringify(parsed, null, 2);
    container.innerHTML = `<div class="response-body-content">${syntaxHighlightJson(body)}</div>`;
  } catch {
    container.innerHTML = `<div class="response-body-content">${escapeHtml(body)}</div>`;
  }
}

function renderPreview(req) {
  const container = document.getElementById('detail-preview-body');
  if (!req.responseBodyLoaded || !req.responseBody) {
    container.innerHTML = '<div class="detail-loading">Preview not available.</div>';
    return;
  }

  const mime = req.mimeType || '';

  // JSON preview
  if (mime.includes('json') || (req.responseBody.trim().startsWith('{') || req.responseBody.trim().startsWith('['))) {
    try {
      const parsed = JSON.parse(req.responseBody);
      container.innerHTML = `<div class="response-body-content">${renderJsonTree(parsed)}</div>`;
      return;
    } catch { /* fall through */ }
  }

  // HTML preview
  if (mime.includes('html')) {
    container.innerHTML = `<iframe class="preview-iframe" sandbox srcdoc="${escapeHtml(req.responseBody)}"></iframe>`;
    return;
  }

  // Image preview
  if (mime.startsWith('image/')) {
    const src = req.responseBase64
      ? `data:${mime};base64,${req.responseBody}`
      : `data:${mime};base64,${btoa(req.responseBody)}`;
    container.innerHTML = `<div style="padding:12px"><img src="${src}" style="max-width:100%;height:auto" /></div>`;
    return;
  }

  // Fallback: show raw text
  container.innerHTML = `<div class="response-body-content">${escapeHtml(truncate(req.responseBody, 10000))}</div>`;
}

function syntaxHighlightJson(str) {
  return escapeHtml(str)
    .replace(/"([^"\\]*(\\.[^"\\]*)*)"(\s*:)/g, '<span class="json-key">"$1"</span>$3')
    .replace(/"([^"\\]*(\\.[^"\\]*)*)"/g, '<span class="json-string">"$1"</span>')
    .replace(/\b(-?\d+\.?\d*([eE][+-]?\d+)?)\b/g, '<span class="json-number">$1</span>')
    .replace(/\b(true|false)\b/g, '<span class="json-boolean">$1</span>')
    .replace(/\bnull\b/g, '<span class="json-null">null</span>');
}

function renderJsonTree(obj, indent) {
  indent = indent || 0;
  const pad = '  '.repeat(indent);
  if (obj === null) return `<span class="json-null">null</span>`;
  if (typeof obj === 'boolean') return `<span class="json-boolean">${obj}</span>`;
  if (typeof obj === 'number') return `<span class="json-number">${obj}</span>`;
  if (typeof obj === 'string') return `<span class="json-string">"${escapeHtml(obj)}"</span>`;

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    const items = obj.map(v => pad + '  ' + renderJsonTree(v, indent + 1)).join(',\n');
    return `[\n${items}\n${pad}]`;
  }

  const keys = Object.keys(obj);
  if (keys.length === 0) return '{}';
  const entries = keys.map(k =>
    `${pad}  <span class="json-key">"${escapeHtml(k)}"</span>: ${renderJsonTree(obj[k], indent + 1)}`
  ).join(',\n');
  return `{\n${entries}\n${pad}}`;
}

// ============================================================
// 1b. Replay & Tamper
// ============================================================

const replayHistory = [];
const SKIP_HEADERS = new Set([
  'host', 'connection', 'content-length', 'accept-encoding',
  'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
  'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest',
  'upgrade-insecure-requests',
]);

// 섹션 토글
document.querySelectorAll('.replay-section-title').forEach(title => {
  title.addEventListener('click', (e) => {
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT') return;
    const bodyId = title.dataset.toggle;
    if (!bodyId) return;
    const body = document.getElementById(bodyId);
    if (!body) return;
    body.classList.toggle('collapsed');
    title.classList.toggle('collapsed');
  });
});

// Response 하위 탭
document.querySelectorAll('.replay-resp-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.replay-resp-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.replay-resp-pane').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('replay-resp-' + tab.dataset.rtab + '-pane').classList.add('active');
  });
});

document.getElementById('replay-send').addEventListener('click', executeReplay);
document.getElementById('replay-quick').addEventListener('click', executeQuickReplay);
document.getElementById('replay-add-header').addEventListener('click', (e) => {
  e.stopPropagation();
  addKvRow('replay-headers-list', '', '', true);
});
document.getElementById('replay-add-param').addEventListener('click', (e) => {
  e.stopPropagation();
  addKvRow('replay-params-list', '', '', true);
});
document.getElementById('replay-format-body').addEventListener('click', (e) => {
  e.stopPropagation();
  formatReplayBody();
});
document.getElementById('replay-clear-history').addEventListener('click', (e) => {
  e.stopPropagation();
  replayHistory.length = 0;
  document.getElementById('replay-history-list').innerHTML = '';
});

// URL 변경 시 query params 동기화
document.getElementById('replay-url').addEventListener('blur', syncParamsFromUrl);

// Replay 탭이 활성화될 때 현재 선택된 요청 데이터로 폼 채우기
function populateReplayForm(req) {
  if (!req) return;

  document.getElementById('replay-method').value = req.method;
  document.getElementById('replay-url').value = req.url;

  // Headers
  const headersList = document.getElementById('replay-headers-list');
  headersList.innerHTML = '';
  const headers = req.requestHeaders || {};
  Object.entries(headers).forEach(([name, value]) => {
    if (name.startsWith(':')) return; // skip HTTP/2 pseudo-headers
    const skip = SKIP_HEADERS.has(name.toLowerCase());
    addKvRow('replay-headers-list', name, value, !skip);
  });

  // Query params
  const paramsList = document.getElementById('replay-params-list');
  paramsList.innerHTML = '';
  try {
    const url = new URL(req.url);
    url.searchParams.forEach((value, name) => {
      addKvRow('replay-params-list', name, value, true);
    });
  } catch { /* ignore */ }

  // Body
  const bodyEl = document.getElementById('replay-body');
  const bodyTypeEl = document.getElementById('replay-body-type');
  if (req.requestPostData) {
    bodyEl.value = req.requestPostData;
    // Detect type
    try {
      JSON.parse(req.requestPostData);
      bodyTypeEl.value = 'json';
    } catch {
      if (req.requestPostData.includes('=') && !req.requestPostData.includes('{')) {
        bodyTypeEl.value = 'form';
      } else {
        bodyTypeEl.value = 'raw';
      }
    }
  } else {
    bodyEl.value = '';
    bodyTypeEl.value = 'none';
  }
}

function addKvRow(listId, name, value, enabled) {
  const list = document.getElementById(listId);
  const row = document.createElement('div');
  row.className = 'replay-kv-row' + (enabled ? '' : ' disabled');
  row.innerHTML = `
    <input type="checkbox" class="kv-toggle" ${enabled ? 'checked' : ''}>
    <input type="text" class="kv-name" value="${escapeAttr(name)}" placeholder="Name">
    <input type="text" class="kv-value" value="${escapeAttr(value)}" placeholder="Value">
    <button class="kv-remove" title="Remove">&times;</button>
  `;

  const toggle = row.querySelector('.kv-toggle');
  toggle.addEventListener('change', () => {
    row.classList.toggle('disabled', !toggle.checked);
  });

  row.querySelector('.kv-remove').addEventListener('click', () => row.remove());

  // Query param 변경 시 URL 동기화
  if (listId === 'replay-params-list') {
    row.querySelector('.kv-name').addEventListener('blur', syncUrlFromParams);
    row.querySelector('.kv-value').addEventListener('blur', syncUrlFromParams);
    toggle.addEventListener('change', syncUrlFromParams);
  }

  list.appendChild(row);
}

function getKvEntries(listId) {
  const rows = document.querySelectorAll(`#${listId} .replay-kv-row`);
  const entries = [];
  rows.forEach(row => {
    const enabled = row.querySelector('.kv-toggle').checked;
    if (!enabled) return;
    const name = row.querySelector('.kv-name').value.trim();
    const value = row.querySelector('.kv-value').value;
    if (name) entries.push([name, value]);
  });
  return entries;
}

function syncUrlFromParams() {
  const urlInput = document.getElementById('replay-url');
  try {
    const url = new URL(urlInput.value);
    url.search = '';
    getKvEntries('replay-params-list').forEach(([k, v]) => {
      url.searchParams.append(k, v);
    });
    urlInput.value = url.toString();
  } catch { /* ignore invalid URL */ }
}

function syncParamsFromUrl() {
  const urlInput = document.getElementById('replay-url');
  try {
    const url = new URL(urlInput.value);
    const list = document.getElementById('replay-params-list');
    list.innerHTML = '';
    url.searchParams.forEach((value, name) => {
      addKvRow('replay-params-list', name, value, true);
    });
  } catch { /* ignore */ }
}

function formatReplayBody() {
  const bodyEl = document.getElementById('replay-body');
  try {
    const parsed = JSON.parse(bodyEl.value);
    bodyEl.value = JSON.stringify(parsed, null, 2);
  } catch { /* not JSON */ }
}

function buildReplayRequest() {
  const method = document.getElementById('replay-method').value;
  const url = document.getElementById('replay-url').value;
  const bodyType = document.getElementById('replay-body-type').value;
  let body = document.getElementById('replay-body').value;

  const headers = {};
  getKvEntries('replay-headers-list').forEach(([k, v]) => {
    if (k.startsWith(':')) return; // skip HTTP/2 pseudo-headers
    headers[k] = v;
  });

  // Auto content-type
  if (bodyType === 'json' && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  } else if (bodyType === 'form' && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  const hasBody = method !== 'GET' && method !== 'HEAD' && bodyType !== 'none' && body;

  return { method, url, headers, body: hasBody ? body : null };
}

function executeQuickReplay() {
  // 원본 요청을 그대로 재전송
  const req = selectedRequestId ? networkRequestMap.get(selectedRequestId) : null;
  if (!req) return;
  populateReplayForm(req);
  executeReplay();
}

function executeReplay() {
  const { method, url, headers, body } = buildReplayRequest();
  if (!url) return;

  const sendBtn = document.getElementById('replay-send');
  const statusEl = document.getElementById('replay-status');
  const timingEl = document.getElementById('replay-timing');
  const sizeEl = document.getElementById('replay-resp-size');
  const bodyPane = document.getElementById('replay-resp-body');
  const headersPane = document.getElementById('replay-resp-headers');

  sendBtn.textContent = 'Sending...';
  sendBtn.disabled = true;
  statusEl.textContent = '';
  statusEl.className = 'replay-status';
  timingEl.textContent = '';
  sizeEl.textContent = '';
  bodyPane.innerHTML = '<span style="color:#8a6d00">Sending request...</span>';
  headersPane.innerHTML = '';

  // eval()은 async를 지원하지 않으므로, 전역 변수에 결과를 저장하고 polling
  const callbackId = '__replay_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const headersJson = JSON.stringify(headers);
  const bodyJson = body ? JSON.stringify(body) : 'null';

  // 1단계: 페이지 컨텍스트에서 fetch 시작, 결과를 window[callbackId]에 저장
  const fetchExpression = `
    (function() {
      window['${callbackId}'] = null;
      var startTime = performance.now();
      fetch(${JSON.stringify(url)}, {
        method: ${JSON.stringify(method)},
        headers: ${headersJson},
        body: ${bodyJson},
        credentials: 'include',
        redirect: 'follow'
      }).then(function(resp) {
        var elapsed = Math.round(performance.now() - startTime);
        var respHeaders = {};
        resp.headers.forEach(function(v, k) { respHeaders[k] = v; });
        return resp.text().then(function(text) {
          window['${callbackId}'] = JSON.stringify({
            ok: true,
            status: resp.status,
            statusText: resp.statusText,
            headers: respHeaders,
            body: text,
            time: elapsed,
            url: resp.url,
            redirected: resp.redirected
          });
        });
      }).catch(function(e) {
        var elapsed = Math.round(performance.now() - startTime);
        window['${callbackId}'] = JSON.stringify({
          ok: false,
          error: e.message,
          time: elapsed
        });
      });
      return 'started';
    })()
  `;

  chrome.devtools.inspectedWindow.eval(fetchExpression, (startResult, startErr) => {
    if (startErr) {
      sendBtn.textContent = 'Send';
      sendBtn.disabled = false;
      statusEl.textContent = 'ERROR';
      statusEl.className = 'replay-status s5xx';
      bodyPane.innerHTML = `<span class="status-error">${escapeHtml(startErr.value || JSON.stringify(startErr))}</span>`;
      return;
    }

    // 2단계: polling으로 결과 확인
    let attempts = 0;
    const maxAttempts = 300; // 30초 타임아웃
    const pollInterval = setInterval(() => {
      attempts++;
      if (attempts > maxAttempts) {
        clearInterval(pollInterval);
        sendBtn.textContent = 'Send';
        sendBtn.disabled = false;
        statusEl.textContent = 'TIMEOUT';
        statusEl.className = 'replay-status s5xx';
        bodyPane.innerHTML = '<span class="status-error">Request timed out (30s)</span>';
        chrome.devtools.inspectedWindow.eval(`delete window['${callbackId}']`);
        return;
      }

      chrome.devtools.inspectedWindow.eval(`window['${callbackId}']`, (result) => {
        if (result === null || result === undefined) return; // 아직 대기 중

        clearInterval(pollInterval);
        sendBtn.textContent = 'Send';
        sendBtn.disabled = false;

        // 전역 변수 정리
        chrome.devtools.inspectedWindow.eval(`delete window['${callbackId}']`);

        handleReplayResult(result, method, url, bodyPane, headersPane, statusEl, timingEl, sizeEl);
      });
    }, 100);
  });
}

function handleReplayResult(result, method, url, bodyPane, headersPane, statusEl, timingEl, sizeEl) {
  try {
    const resp = JSON.parse(result);

    if (!resp.ok) {
      statusEl.textContent = 'FAILED';
      statusEl.className = 'replay-status s5xx';
      timingEl.textContent = resp.time + ' ms';
      bodyPane.innerHTML = `<span class="status-error">Fetch Error: ${escapeHtml(resp.error)}</span>`;
      addReplayHistoryEntry(method, url, 'ERR', resp.time, false);
      return;
    }

    // Status
    const sClass = resp.status < 300 ? 's2xx' : resp.status < 400 ? 's3xx' : resp.status < 500 ? 's4xx' : 's5xx';
    statusEl.textContent = `${resp.status} ${resp.statusText}`;
    statusEl.className = `replay-status ${sClass}`;
    timingEl.textContent = resp.time + ' ms';
    sizeEl.textContent = formatBytes(resp.body.length);

    if (resp.redirected) {
      timingEl.textContent += ` (redirected to ${resp.url})`;
    }

    // Response Body
    let bodyHtml;
    try {
      const parsed = JSON.parse(resp.body);
      const pretty = JSON.stringify(parsed, null, 2);
      bodyHtml = syntaxHighlightJson(pretty);
    } catch {
      bodyHtml = escapeHtml(resp.body);
    }
    bodyPane.innerHTML = bodyHtml;

    // Response Headers
    headersPane.innerHTML = headerRowsHtml(resp.headers);

    // Diff - 원본 응답과 비교
    const originalReq = selectedRequestId ? networkRequestMap.get(selectedRequestId) : null;
    if (originalReq && originalReq.responseBodyLoaded && originalReq.responseBody !== null) {
      renderDiffBadges(originalReq, resp);
    }

    // History
    addReplayHistoryEntry(method, url, resp.status, resp.time, true);

  } catch (e) {
    statusEl.textContent = 'PARSE ERROR';
    statusEl.className = 'replay-status s5xx';
    bodyPane.innerHTML = `<span class="status-error">Failed to parse response: ${escapeHtml(e.message)}</span>`;
  }
}

function renderDiffBadges(originalReq, replayResp) {
  // Status 차이
  const statusEl = document.getElementById('replay-status');
  if (originalReq.status !== replayResp.status) {
    statusEl.textContent += ` (was ${originalReq.status})`;
  }

  // Response body 차이 표시
  const bodyPane = document.getElementById('replay-resp-body');
  if (originalReq.responseBody !== replayResp.body) {
    // Try JSON diff
    try {
      const origObj = JSON.parse(originalReq.responseBody);
      const newObj = JSON.parse(replayResp.body);
      const diffHtml = generateJsonDiff(origObj, newObj);
      if (diffHtml) {
        bodyPane.innerHTML += `\n\n<div style="margin-top:12px;padding-top:12px;border-top:1px solid #d4d4d4">
          <div style="font-weight:600;color:#8a6d00;margin-bottom:8px">Changes from original response:</div>
          ${diffHtml}
        </div>`;
      }
    } catch { /* not JSON, skip diff */ }
  } else {
    bodyPane.innerHTML += `\n\n<div style="margin-top:8px;color:#0b7a3e;font-size:12px">Response identical to original.</div>`;
  }
}

function generateJsonDiff(orig, curr, path) {
  path = path || '';
  const lines = [];

  if (typeof orig !== typeof curr) {
    lines.push(`<div class="diff-changed header-row"><span class="header-name">${escapeHtml(path || '(root)')}</span><span class="header-value"><span class="status-error">${escapeHtml(JSON.stringify(orig))}</span> → <span class="status-ok">${escapeHtml(JSON.stringify(curr))}</span></span></div>`);
    return lines.join('');
  }

  if (orig === null || curr === null || typeof orig !== 'object') {
    if (orig !== curr) {
      lines.push(`<div class="diff-changed header-row"><span class="header-name">${escapeHtml(path || '(root)')}</span><span class="header-value"><span class="status-error">${escapeHtml(JSON.stringify(orig))}</span> → <span class="status-ok">${escapeHtml(JSON.stringify(curr))}</span></span></div>`);
    }
    return lines.join('');
  }

  const allKeys = new Set([...Object.keys(orig), ...Object.keys(curr)]);
  for (const key of allKeys) {
    const subPath = path ? `${path}.${key}` : key;
    if (!(key in orig)) {
      lines.push(`<div class="diff-added header-row"><span class="header-name">+ ${escapeHtml(subPath)}</span><span class="header-value">${escapeHtml(JSON.stringify(curr[key]))}</span></div>`);
    } else if (!(key in curr)) {
      lines.push(`<div class="diff-removed header-row"><span class="header-name">- ${escapeHtml(subPath)}</span><span class="header-value">${escapeHtml(JSON.stringify(orig[key]))}</span></div>`);
    } else {
      const sub = generateJsonDiff(orig[key], curr[key], subPath);
      if (sub) lines.push(sub);
    }
  }

  return lines.join('');
}

function addReplayHistoryEntry(method, url, status, time, success) {
  const entry = { method, url, status, time, timestamp: new Date() };
  replayHistory.unshift(entry);
  if (replayHistory.length > 50) replayHistory.pop();
  renderReplayHistory();
}

function renderReplayHistory() {
  const list = document.getElementById('replay-history-list');
  list.innerHTML = replayHistory.map((h, i) => {
    const sClass = typeof h.status === 'number'
      ? (h.status < 300 ? 'status-ok' : h.status < 400 ? 'status-redirect' : 'status-error')
      : 'status-error';
    let shortUrl;
    try { shortUrl = new URL(h.url).pathname; } catch { shortUrl = h.url; }
    return `<div class="replay-history-item" data-hist-idx="${i}">
      <span class="hist-method">${escapeHtml(h.method)}</span>
      <span class="hist-url" title="${escapeHtml(h.url)}">${escapeHtml(shortUrl)}</span>
      <span class="hist-status ${sClass}">${h.status}</span>
      <span class="hist-time">${h.time} ms</span>
    </div>`;
  }).join('');

  // 히스토리 항목 클릭 → 해당 요청으로 폼 복원
  list.querySelectorAll('.replay-history-item').forEach(item => {
    item.addEventListener('click', () => {
      const idx = parseInt(item.dataset.histIdx);
      const h = replayHistory[idx];
      if (!h) return;
      document.getElementById('replay-method').value = h.method;
      document.getElementById('replay-url').value = h.url;
      syncParamsFromUrl();
    });
  });
}

function escapeAttr(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Detail 탭 전환 시 Replay 폼 자동 채우기
const origDetailTabHandler = document.querySelectorAll('.detail-tab');
origDetailTabHandler.forEach(tab => {
  tab.addEventListener('click', () => {
    if (tab.dataset.detail === 'replay' && selectedRequestId) {
      const req = networkRequestMap.get(selectedRequestId);
      if (req) populateReplayForm(req);
    }
  });
});

// ============================================================
// 1c. Intercept Proxy (Proxy Mode + Legacy In-Page Mode)
// ============================================================

let interceptActive = false;
const reqQueue = [];
const respQueue = [];
const interceptLog = [];
let selectedReqId = null;
let selectedRespId = null;
let activeSide = 'req'; // 'req' or 'resp' — 단축키 대상
let interceptBypassRegex = null;
let interceptIdCounter = 0;
let interceptPollTimer = null;
let interceptMode = 'proxy'; // 'proxy' or 'legacy'

const icptToggleBtn = document.getElementById('icpt-toggle');
const reqQueueEl = document.getElementById('icpt-req-queue');
const respQueueEl = document.getElementById('icpt-resp-queue');
const icptLogEl = document.getElementById('icpt-log');
const icptQueueBadge = document.getElementById('icpt-queue-badge');
const reqBadge = document.getElementById('icpt-req-badge');
const respBadge = document.getElementById('icpt-resp-badge');
const reqEditorContent = document.getElementById('icpt-req-editor-content');
const respEditorContent = document.getElementById('icpt-resp-editor-content');
const reqPlaceholder = document.getElementById('icpt-req-placeholder');
const respPlaceholder = document.getElementById('icpt-resp-placeholder');
const interceptTabBtn = document.querySelector('.intercept-tab');
const icptModeSelect = document.getElementById('icpt-mode-select');
const icptProxyStatus = document.getElementById('icpt-proxy-status');

// 사이드 패널 클릭 시 activeSide 전환
document.querySelectorAll('.icpt-side').forEach(el => {
  el.addEventListener('click', () => {
    activeSide = el.dataset.side;
    document.querySelectorAll('.icpt-side').forEach(s => s.classList.remove('active-side'));
    el.classList.add('active-side');
  });
});
// 초기 활성 사이드
document.querySelector('.icpt-req-side').classList.add('active-side');

// Background Service Worker 포트 연결 (자동 재연결)
let bgPort = null;

function connectBgPort() {
  bgPort = chrome.runtime.connect({ name: `panel-${tabId}` });

  bgPort.onMessage.addListener(handleBgMessage);

  bgPort.onDisconnect.addListener(() => {
    console.warn('[DevTools++] Background port disconnected, reconnecting...');
    bgPort = null;
    // Service Worker 재시작 대기 후 재연결
    setTimeout(connectBgPort, 500);
  });
}

function sendToBg(msg) {
  if (!bgPort) {
    connectBgPort();
  }
  try {
    bgPort.postMessage(msg);
  } catch (err) {
    console.warn('[DevTools++] Port send failed, reconnecting...', err);
    bgPort = null;
    connectBgPort();
    try { bgPort.postMessage(msg); } catch {}
  }
}

function handleBgMessage(msg) {
  switch (msg.type) {
    case 'host_ready':
      updateProxyStatus('ready', 'Proxy: Ready');
      break;

    case 'proxy_started':
      updateProxyStatus('active', `Proxy: :${msg.port}`);
      break;

    case 'proxy_stopped':
    case 'intercept_paused':
      updateProxyStatus('idle', 'Proxy: Stopped');
      break;

    case 'native_disconnected':
      updateProxyStatus('error', 'Proxy: Disconnected');
      if (interceptActive && interceptMode === 'proxy') {
        stopIntercept();
      }
      break;

    case 'native_error':
    case 'proxy_error':
    case 'proxy_settings_error':
      updateProxyStatus('error', `Error: ${msg.message || ''}`);
      if (msg.type === 'native_error' && !interceptActive) {
        showSetupHint();
      }
      break;

    case 'request_intercepted':
      if (interceptMode === 'proxy') {
        handleProxyInterceptedRequest(msg);
      }
      break;

    case 'response_captured':
      handleResponseCaptured(msg);
      break;

    case 'response_intercepted':
      handleResponseIntercepted(msg);
      break;

    case 'request_timeout':
      addInterceptLog('timeout', '', msg.id, 'req');
      break;

    case 'pong':
      updateProxyStatus('active', `Proxy: ${msg.pendingCount || 0} pending`);
      break;

    case 'status':
      if (msg.listening) {
        updateProxyStatus('active', `Proxy: :${msg.port} (${msg.pendingCount} pending)`);
      }
      break;

    case 'error':
      console.warn('[DevTools++] Proxy error:', msg.message);
      break;
  }
}

connectBgPort();

function updateProxyStatus(state, text) {
  icptProxyStatus.textContent = text;
  icptProxyStatus.style.display = interceptMode === 'proxy' ? 'inline-block' : 'none';
  if (state === 'active') {
    icptProxyStatus.style.color = '#0b7a3e';
    icptProxyStatus.style.background = '#e6f4ea';
  } else if (state === 'error') {
    icptProxyStatus.style.color = '#d32f2f';
    icptProxyStatus.style.background = '#fef2f2';
  } else {
    icptProxyStatus.style.color = '#666';
    icptProxyStatus.style.background = '#f3f3f3';
  }
}

function showSetupHint() {
  const setupUrl = chrome.runtime.getURL('setup.html');
  const editor = document.getElementById('icpt-editor');
  const placeholder = editor.querySelector('.icpt-editor-placeholder');
  if (placeholder) {
    placeholder.innerHTML = `<div style="text-align:center">
      <p style="color:#d32f2f;font-weight:600;margin-bottom:8px">Native Messaging host is not installed.</p>
      <p style="color:#666;margin-bottom:12px">Proxy Mode requires a one-time setup.</p>
      <a href="${setupUrl}" target="_blank"
        style="display:inline-block;padding:8px 20px;background:#0078d4;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;font-size:13px">
        Open Setup Guide
      </a>
    </div>`;
  }
}

// 와일드카드 URL 필터를 regex로 변환
// 입력: "*.site.com, api.example.com/v1/*"
// 출력: "(^https?://[^/]*\.site\.com)|(api\.example\.com/v1/.*)" (regex 문자열)
function urlFilterToRegex(input) {
  if (!input) return '';
  const patterns = input.split(',').map(p => p.trim()).filter(Boolean);
  if (patterns.length === 0) return '';
  const regexParts = patterns.map(p => {
    // 와일드카드(*) → 플레이스홀더 치환 후, 특수문자 이스케이프, 복원
    const PH = '\x00WILD\x00';
    let r = p.replace(/\*/g, PH);
    r = r.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); // regex 특수문자 이스케이프
    r = r.replace(new RegExp(PH.replace(/\x00/g, '\\x00'), 'g'), '.*'); // 플레이스홀더 → .*
    // *.domain 패턴은 프로토콜 포함 매칭 (https://sub.domain)
    if (p.startsWith('*.')) {
      r = '^https?://[^/]*' + r.slice(2); // 선행 .* 제거하고 [^/]* 로 대체
    }
    return '(' + r + ')';
  });
  return regexParts.join('|');
}

// URL 필터 매칭 테스트 (캐시)
let _urlFilterCache = { input: '', regex: null };
function testUrlFilter(url) {
  const input = document.getElementById('icpt-url-filter').value.trim();
  if (!input) return true; // 필터 없으면 모두 통과
  if (_urlFilterCache.input !== input) {
    const pattern = urlFilterToRegex(input);
    try {
      _urlFilterCache = { input, regex: pattern ? new RegExp(pattern, 'i') : null };
    } catch {
      _urlFilterCache = { input, regex: null };
    }
  }
  return _urlFilterCache.regex ? _urlFilterCache.regex.test(url) : true;
}

// Proxy Mode에서 인터셉트된 요청 처리
function handleProxyInterceptedRequest(msg) {
  const methodFilter = document.getElementById('icpt-method-filter').value;

  // Method 필터
  if (methodFilter && msg.method !== methodFilter) {
    sendInterceptDecision(msg.id, { action: 'forward' });
    addInterceptLog('bypassed', msg.method, msg.url, 'req');
    return;
  }
  // URL 필터 (와일드카드/다중 패턴)
  if (!testUrlFilter(msg.url)) {
    sendInterceptDecision(msg.id, { action: 'forward' });
    addInterceptLog('bypassed', msg.method, msg.url, 'req');
    return;
  }
  // Bypass 룰
  if (interceptBypassRegex && interceptBypassRegex.test(msg.url)) {
    sendInterceptDecision(msg.id, { action: 'forward' });
    addInterceptLog('bypassed', msg.method, msg.url, 'req');
    return;
  }

  // Request 큐에 추가
  const newItem = {
    id: msg.id,
    reqType: 'proxy',
    method: msg.method,
    url: msg.url,
    headers: msg.headers || {},
    postData: msg.body || '',
  };
  reqQueue.push(newItem);
  if (!selectedReqId) {
    selectedReqId = newItem.id;
    showReqEditor(newItem);
  }
  renderReqQueue();
}

function handleResponseIntercepted(msg) {
  let body = msg.body || '';
  try {
    const parsed = JSON.parse(body);
    body = JSON.stringify(parsed, null, 2);
  } catch {}

  // Response 큐에 추가
  const newItem = {
    id: msg.id,
    method: msg.method,
    url: msg.url,
    statusCode: msg.statusCode,
    headers: msg.headers || {},
    body: body,
    bodyTruncated: msg.bodyTruncated,
  };
  respQueue.push(newItem);
  if (!selectedRespId) {
    selectedRespId = newItem.id;
    showRespEditor(newItem);
  }
  renderRespQueue();
}

// 모드 전환
icptModeSelect.addEventListener('change', () => {
  if (interceptActive) {
    alert('Cannot change mode while intercept is active. Please turn Intercept OFF first.');
    icptModeSelect.value = interceptMode;
    return;
  }
  interceptMode = icptModeSelect.value;
  icptProxyStatus.style.display = interceptMode === 'proxy' ? 'inline-block' : 'none';
});

// Editor 탭 전환 (사이드별 스코핑)
document.querySelectorAll('.icpt-editor-tabs').forEach(tabBar => {
  tabBar.querySelectorAll('.icpt-ed-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const side = tabBar.dataset.side;
      tabBar.querySelectorAll('.icpt-ed-tab').forEach(t => t.classList.remove('active'));
      const parentContent = tabBar.closest('.icpt-editor-content');
      parentContent.querySelectorAll('.icpt-ed-pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('icpt-tab-' + tab.dataset.ictab).classList.add('active');
    });
  });
});

icptToggleBtn.addEventListener('click', () => {
  if (interceptActive) stopIntercept(); else startIntercept();
});

// Request 사이드 버튼
document.getElementById('icpt-req-forward').addEventListener('click', () => { activeSide = 'req'; forwardSelected(false); });
document.getElementById('icpt-req-forward-modified').addEventListener('click', () => { activeSide = 'req'; forwardSelected(true); });
document.getElementById('icpt-req-drop').addEventListener('click', () => { activeSide = 'req'; dropSelected(); });
document.getElementById('icpt-req-mock').addEventListener('click', () => { activeSide = 'req'; mockResponseSelected(); });
document.getElementById('icpt-req-add-header').addEventListener('click', () => addIcptKvRow('icpt-req-headers-list', '', ''));

// Response 사이드 버튼
document.getElementById('icpt-resp-forward').addEventListener('click', () => { activeSide = 'resp'; forwardSelected(false); });
document.getElementById('icpt-resp-forward-modified').addEventListener('click', () => { activeSide = 'resp'; forwardSelected(true); });
document.getElementById('icpt-resp-drop').addEventListener('click', () => { activeSide = 'resp'; dropSelected(); });
document.getElementById('icpt-resp-add-header').addEventListener('click', () => addIcptKvRow('icpt-resp-headers-list', '', ''));

// 공통 버튼
document.getElementById('icpt-forward-all').addEventListener('click', forwardAll);
document.getElementById('icpt-drop-all').addEventListener('click', dropAll);
document.getElementById('icpt-clear-log').addEventListener('click', () => { interceptLog.length = 0; renderInterceptLog(); });
document.getElementById('icpt-bypass-apply').addEventListener('click', applyBypassRule);

// 인터셉트 단축키 (F/G/D/R/A/Q) — activeSide 기반
document.addEventListener('keydown', (e) => {
  const interceptSection = document.getElementById('intercept');
  if (!interceptSection || !interceptSection.classList.contains('active')) return;
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  switch (e.key.toLowerCase()) {
    case 'f': e.preventDefault(); forwardSelected(false); break;
    case 'g': e.preventDefault(); forwardSelected(true); break;
    case 'd': e.preventDefault(); dropSelected(); break;
    case 'r': e.preventDefault(); if (activeSide === 'req') mockResponseSelected(); break;
    case 'a': e.preventDefault(); forwardAll(); break;
    case 'q': e.preventDefault(); dropAll(); break;
  }
});

// 확장자 체크박스 변경 시 자동 적용
document.querySelectorAll('.icpt-ext-check input[data-ext]').forEach(cb => {
  cb.addEventListener('change', applyBypassRule);
});

function buildBypassPattern() {
  // 체크된 확장자 수집
  const exts = [];
  document.querySelectorAll('.icpt-ext-check input[data-ext]:checked').forEach(cb => {
    exts.push(cb.dataset.ext);
  });
  // 추가 사용자 regex
  const userVal = document.getElementById('icpt-bypass-input').value.trim();

  const parts = [];
  if (exts.length > 0) {
    // woff → woff|woff2 변환
    const extPatterns = exts.map(e => e === 'woff' ? 'woff2?' : e === 'jpg' ? 'jpe?g' : e);
    parts.push('\\.(' + extPatterns.join('|') + ')(\\?|$)');
  }
  if (userVal) parts.push(userVal);
  return parts.join('|');
}

function applyBypassRule() {
  const combined = buildBypassPattern();
  try {
    interceptBypassRegex = combined ? new RegExp(combined, 'i') : null;
  } catch (e) {
    interceptBypassRegex = null;
    alert('Invalid regex: ' + e.message);
    return;
  }
  // Proxy 모드에서는 서버에도 bypass 패턴 전달
  if (interceptMode === 'proxy' && interceptActive) {
    sendToBg({
      type: 'update_config',
      config: { bypassPatterns: combined ? [combined] : [] }
    });
  }
}

// Intercept 시작 (모드별 분기)
function startIntercept() {
  interceptActive = true;
  icptToggleBtn.textContent = 'Intercept ON';
  icptToggleBtn.className = 'btn btn-intercept-on';
  interceptTabBtn.classList.add('intercepting');
  icptModeSelect.disabled = true;

  if (interceptMode === 'proxy') {
    startProxyIntercept();
  } else {
    startLegacyIntercept();
  }
}

function startProxyIntercept() {
  updateProxyStatus('idle', 'Proxy: Connecting...');
  // 확장자 체크박스 + 사용자 regex 반영
  applyBypassRule();
  const combined = buildBypassPattern();
  const interceptResp = document.getElementById('icpt-resp').checked;
  const urlFilterRaw = document.getElementById('icpt-url-filter').value.trim();
  const methodFilter = document.getElementById('icpt-method-filter').value;
  sendToBg({
    type: 'intercept_on',
    config: {
      port: 8899,
      bypassPatterns: combined ? [combined] : [],
      interceptResponse: interceptResp,
      urlFilter: urlFilterToRegex(urlFilterRaw),
      methodFilter: methodFilter,
    }
  });
}

// Response 체크박스 실시간 반영
document.getElementById('icpt-resp').addEventListener('change', (e) => {
  if (interceptActive && interceptMode === 'proxy') {
    sendToBg({
      type: 'update_config',
      config: { interceptResponse: e.target.checked }
    });
  }
});

// URL 필터 / Method 필터 변경 시 프록시에 실시간 반영
function syncFiltersToProxy() {
  if (interceptActive && interceptMode === 'proxy') {
    const raw = document.getElementById('icpt-url-filter').value.trim();
    sendToBg({
      type: 'update_config',
      config: {
        urlFilter: urlFilterToRegex(raw),
        methodFilter: document.getElementById('icpt-method-filter').value,
      }
    });
  }
}
// URL 필터: 입력 멈춘 후 300ms 뒤 반영 (debounce)
let urlFilterTimer = null;
document.getElementById('icpt-url-filter').addEventListener('input', () => {
  clearTimeout(urlFilterTimer);
  urlFilterTimer = setTimeout(syncFiltersToProxy, 300);
});
document.getElementById('icpt-method-filter').addEventListener('change', syncFiltersToProxy);

function startLegacyIntercept() {
  // 기존 monkey-patch 방식
  chrome.devtools.inspectedWindow.eval('typeof window.__icptActive__', (result) => {
    const activate = () => {
      chrome.devtools.inspectedWindow.eval('window.__icptActive__ = true');
      interceptPollTimer = setInterval(pollInterceptQueue, 150);
    };

    if (result === 'boolean') {
      activate();
    } else {
      injectInterceptHookViaEval(activate);
    }
  });
}

function injectInterceptHookViaEval(callback) {
  var scriptUrl = chrome.runtime.getURL('intercept-hook.js');
  chrome.devtools.inspectedWindow.eval(
    '(function(){' +
    'if(typeof window.__icptActive__!=="undefined")return;' +
    'var s=document.createElement("script");' +
    's.src="' + scriptUrl + '";' +
    'document.documentElement.appendChild(s);' +
    's.onload=function(){s.remove()};' +
    '})()',
    function() { if (callback) setTimeout(callback, 100); }
  );
}

// Intercept 중지 (모드별 분기)
function stopIntercept() {
  interceptActive = false;
  icptToggleBtn.textContent = 'Intercept OFF';
  icptToggleBtn.className = 'btn btn-intercept-off';
  interceptTabBtn.classList.remove('intercepting');
  icptModeSelect.disabled = false;

  // 남아있는 큐 전부 forward
  forwardAll();

  if (interceptMode === 'proxy') {
    sendToBg({ type: 'intercept_off' });
    updateProxyStatus('idle', 'Proxy: Stopped');
  } else {
    if (interceptPollTimer) { clearInterval(interceptPollTimer); interceptPollTimer = null; }
    chrome.devtools.inspectedWindow.eval('window.__icptActive__ = false; window.__icptQueue__ = []');
  }
}

// Legacy 모드 전용: polling
function pollInterceptQueue() {
  if (!interceptActive || interceptMode !== 'legacy') return;

  chrome.devtools.inspectedWindow.eval(
    '(function(){ var q = window.__icptQueue__ || []; window.__icptQueue__ = []; return JSON.stringify(q); })()',
    (result) => {
      if (!result) return;
      try {
        const items = JSON.parse(result);
        items.forEach(item => {
          const methodFilter = document.getElementById('icpt-method-filter').value;

          if (methodFilter && item.method !== methodFilter) {
            sendInterceptDecision(item.id, { action: 'forward' });
            addInterceptLog('bypassed', item.method, item.url, 'req');
            return;
          }
          if (!testUrlFilter(item.url)) {
            sendInterceptDecision(item.id, { action: 'forward' });
            addInterceptLog('bypassed', item.method, item.url, 'req');
            return;
          }
          if (interceptBypassRegex && interceptBypassRegex.test(item.url)) {
            sendInterceptDecision(item.id, { action: 'forward' });
            addInterceptLog('bypassed', item.method, item.url, 'req');
            return;
          }

          const legacyItem = {
            id: item.id,
            reqType: item.type || 'fetch',
            method: item.method,
            url: item.url,
            headers: item.headers || {},
            postData: item.body || '',
          };
          reqQueue.push(legacyItem);
          if (!selectedReqId) {
            selectedReqId = legacyItem.id;
            showReqEditor(legacyItem);
          }
          renderReqQueue();
        });
      } catch {}
    }
  );
}

// Decision 전송 (모드별 분기)
function sendInterceptDecision(id, decision) {
  if (interceptMode === 'proxy') {
    sendToBg({ type: 'decision', id, ...decision });
  } else {
    const decisionJson = JSON.stringify(decision).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    chrome.devtools.inspectedWindow.eval(
      `window.__icptDecisions__['${id}'] = JSON.parse('${decisionJson}')`
    );
  }
}

// ---- Queue 렌더링 ----
function updateBadges() {
  reqBadge.textContent = reqQueue.length;
  respBadge.textContent = respQueue.length;
  icptQueueBadge.textContent = (reqQueue.length + respQueue.length) + ' paused';
}

function renderQueueItems(queue, el, selectedId, side) {
  el.innerHTML = queue.map((item, i) => {
    const selected = item.id === selectedId ? 'selected' : '';
    let shortUrl;
    try { shortUrl = new URL(item.url).pathname + new URL(item.url).search; } catch { shortUrl = item.url; }
    return `<div class="icpt-queue-item ${selected}" data-icpt-idx="${i}" data-side="${side}">
      <span class="q-idx">#${i + 1}</span>
      <span class="q-method">${escapeHtml(item.method)}</span>
      <span class="q-url" title="${escapeHtml(item.url)}">${escapeHtml(shortUrl)}</span>
    </div>`;
  }).join('');

  el.querySelectorAll('.icpt-queue-item').forEach(el2 => {
    el2.addEventListener('click', () => {
      const idx = parseInt(el2.dataset.icptIdx);
      if (side === 'req') {
        const item = reqQueue[idx];
        if (!item) return;
        selectedReqId = item.id;
        activeSide = 'req';
        showReqEditor(item);
        renderReqQueue();
      } else {
        const item = respQueue[idx];
        if (!item) return;
        selectedRespId = item.id;
        activeSide = 'resp';
        showRespEditor(item);
        renderRespQueue();
      }
      document.querySelectorAll('.icpt-side').forEach(s => s.classList.remove('active-side'));
      document.querySelector(`.icpt-${side}-side`).classList.add('active-side');
    });
  });
}

function renderReqQueue() {
  updateBadges();
  renderQueueItems(reqQueue, reqQueueEl, selectedReqId, 'req');
}

function renderRespQueue() {
  updateBadges();
  renderQueueItems(respQueue, respQueueEl, selectedRespId, 'resp');
}

// ---- Editor 표시 ----
function showReqEditor(item) {
  reqPlaceholder.style.display = 'none';
  reqEditorContent.classList.remove('hidden');
  const methodSel = document.getElementById('icpt-req-edit-method');
  methodSel.innerHTML = ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']
    .map(m => `<option ${m === item.method ? 'selected' : ''}>${m}</option>`).join('');
  document.getElementById('icpt-req-edit-url').value = item.url;
  const headersList = document.getElementById('icpt-req-headers-list');
  headersList.innerHTML = '';
  Object.entries(item.headers).forEach(([k, v]) => addIcptKvRow('icpt-req-headers-list', k, Array.isArray(v) ? v.join(', ') : v));
  document.getElementById('icpt-req-edit-body').value = item.postData || '';
}

function showRespEditor(item) {
  respPlaceholder.style.display = 'none';
  respEditorContent.classList.remove('hidden');
  document.getElementById('icpt-resp-edit-method').textContent = item.method || '';
  document.getElementById('icpt-resp-edit-url').value = item.url;
  document.getElementById('icpt-resp-edit-status').value = item.statusCode || 200;
  const headersList = document.getElementById('icpt-resp-headers-list');
  headersList.innerHTML = '';
  if (item.headers && typeof item.headers === 'object') {
    Object.entries(item.headers).forEach(([k, v]) => addIcptKvRow('icpt-resp-headers-list', k, Array.isArray(v) ? v.join(', ') : v));
  }
  document.getElementById('icpt-resp-edit-body').value = item.body || '';
}

function hideReqEditor() {
  selectedReqId = null;
  reqEditorContent.classList.add('hidden');
  reqPlaceholder.style.display = '';
}

function hideRespEditor() {
  selectedRespId = null;
  respEditorContent.classList.add('hidden');
  respPlaceholder.style.display = '';
}

// ---- KV 헬퍼 (공유) ----
function addIcptKvRow(listId, name, value) {
  const list = document.getElementById(listId);
  const row = document.createElement('div');
  row.className = 'replay-kv-row';
  row.innerHTML = `
    <input type="checkbox" class="kv-toggle" checked>
    <input type="text" class="kv-name" value="${escapeAttr(name)}" placeholder="Name">
    <input type="text" class="kv-value" value="${escapeAttr(value)}" placeholder="Value">
    <button class="kv-remove" title="Remove">&times;</button>
  `;
  const toggle = row.querySelector('.kv-toggle');
  toggle.addEventListener('change', () => row.classList.toggle('disabled', !toggle.checked));
  row.querySelector('.kv-remove').addEventListener('click', () => row.remove());
  list.appendChild(row);
}

function getIcptKvEntries(listId) {
  const entries = [];
  document.querySelectorAll(`#${listId} .replay-kv-row`).forEach(row => {
    if (!row.querySelector('.kv-toggle').checked) return;
    const name = row.querySelector('.kv-name').value.trim();
    const value = row.querySelector('.kv-value').value;
    if (name) entries.push({ name, value });
  });
  return entries;
}

// ---- 큐 조작 ----
function removeFromReqQueue(id) {
  const idx = reqQueue.findIndex(q => q.id === id);
  if (idx >= 0) reqQueue.splice(idx, 1);
  if (selectedReqId === id) {
    if (reqQueue.length > 0) { selectedReqId = reqQueue[0].id; showReqEditor(reqQueue[0]); }
    else hideReqEditor();
  }
  renderReqQueue();
}

function removeFromRespQueue(id) {
  const idx = respQueue.findIndex(q => q.id === id);
  if (idx >= 0) respQueue.splice(idx, 1);
  if (selectedRespId === id) {
    if (respQueue.length > 0) { selectedRespId = respQueue[0].id; showRespEditor(respQueue[0]); }
    else hideRespEditor();
  }
  renderRespQueue();
}

// ---- 액션 (activeSide 기반) ----
function forwardSelected(modified) {
  if (activeSide === 'req') {
    const item = reqQueue.find(q => q.id === selectedReqId);
    if (!item) return;
    if (modified) {
      const newMethod = document.getElementById('icpt-req-edit-method').value;
      const newUrl = document.getElementById('icpt-req-edit-url').value;
      const headers = {};
      getIcptKvEntries('icpt-req-headers-list').forEach(h => { headers[h.name] = h.value; });
      const body = document.getElementById('icpt-req-edit-body').value;
      sendInterceptDecision(item.id, { action: 'forward_modified', method: newMethod, url: newUrl, headers, body });
      addInterceptLog('modified', newMethod, newUrl, 'req', item.id);
    } else {
      sendInterceptDecision(item.id, { action: 'forward' });
      addInterceptLog('forwarded', item.method, item.url, 'req', item.id);
    }
    removeFromReqQueue(item.id);
  } else {
    const item = respQueue.find(q => q.id === selectedRespId);
    if (!item) return;
    if (modified) {
      const respStatus = parseInt(document.getElementById('icpt-resp-edit-status').value) || 200;
      const respHeaders = {};
      getIcptKvEntries('icpt-resp-headers-list').forEach(h => { respHeaders[h.name] = h.value; });
      const respBody = document.getElementById('icpt-resp-edit-body').value;
      sendInterceptDecision(item.id, { action: 'forward_modified', responseStatus: respStatus, headers: respHeaders, body: respBody });
      addInterceptLog('modified', respStatus + '', item.url, 'resp', item.id);
    } else {
      sendInterceptDecision(item.id, { action: 'forward' });
      addInterceptLog('forwarded', item.method || (item.statusCode + ''), item.url, 'resp', item.id);
    }
    removeFromRespQueue(item.id);
  }
}

function dropSelected() {
  if (activeSide === 'req') {
    const item = reqQueue.find(q => q.id === selectedReqId);
    if (!item) return;
    sendInterceptDecision(item.id, { action: 'drop' });
    addInterceptLog('dropped', item.method, item.url, 'req');
    removeFromReqQueue(item.id);
  } else {
    const item = respQueue.find(q => q.id === selectedRespId);
    if (!item) return;
    sendInterceptDecision(item.id, { action: 'drop' });
    addInterceptLog('dropped', item.method, item.url, 'resp');
    removeFromRespQueue(item.id);
  }
}

function mockResponseSelected() {
  const item = reqQueue.find(q => q.id === selectedReqId);
  if (!item) return;
  // Mock Response용 body — Request 사이드에는 Response 편집 영역이 없으므로 빈 body로 처리
  // 사용자가 원하는 mock 응답은 별도 입력 필요 → 기존 동작 유지를 위해 기본값
  sendInterceptDecision(item.id, {
    action: 'mock',
    responseStatus: 200,
    responseHeaders: [{ name: 'Content-Type', value: 'text/plain' }],
    responseBody: ''
  });
  addInterceptLog('mocked', item.method, item.url, 'req');
  removeFromReqQueue(item.id);
}

function forwardAll() {
  while (reqQueue.length > 0) {
    const item = reqQueue.shift();
    sendInterceptDecision(item.id, { action: 'forward' });
    addInterceptLog('forwarded', item.method, item.url, 'req', item.id);
  }
  while (respQueue.length > 0) {
    const item = respQueue.shift();
    sendInterceptDecision(item.id, { action: 'forward' });
    addInterceptLog('forwarded', item.method || (item.statusCode + ''), item.url, 'resp', item.id);
  }
  hideReqEditor();
  hideRespEditor();
  renderReqQueue();
  renderRespQueue();
}

function dropAll() {
  while (reqQueue.length > 0) {
    const item = reqQueue.shift();
    sendInterceptDecision(item.id, { action: 'drop' });
    addInterceptLog('dropped', item.method, item.url, 'req');
  }
  while (respQueue.length > 0) {
    const item = respQueue.shift();
    sendInterceptDecision(item.id, { action: 'drop' });
    addInterceptLog('dropped', item.method, item.url, 'resp');
  }
  hideReqEditor();
  hideRespEditor();
  renderReqQueue();
  renderRespQueue();
}

// 응답 캡처 히스토리 (id → response)
const capturedResponses = new Map();

function handleResponseCaptured(msg) {
  capturedResponses.set(msg.id, {
    statusCode: msg.statusCode,
    headers: msg.headers,
    body: msg.body,
    bodyLength: msg.bodyLength,
    bodyTruncated: msg.bodyTruncated,
  });
  // 로그에 응답 기록
  const logEntry = interceptLog.find(l => l.id === msg.id);
  if (logEntry) {
    logEntry.responseStatus = msg.statusCode;
    renderInterceptLog();
  }
  // 최대 200건 유지
  if (capturedResponses.size > 200) {
    const oldest = capturedResponses.keys().next().value;
    capturedResponses.delete(oldest);
  }
}

function addInterceptLog(action, method, url, stage, id) {
  interceptLog.unshift({ action, method, url, stage, time: new Date(), id: id || null });
  if (interceptLog.length > 200) interceptLog.pop();
  renderInterceptLog();
}

function renderInterceptLog() {
  icptLogEl.innerHTML = interceptLog.slice(0, 100).map((l, idx) => {
    const cls = 'log-' + l.action;
    let shortUrl;
    try { shortUrl = new URL(l.url).pathname; } catch { shortUrl = l.url; }
    const time = l.time.toLocaleTimeString('ko-KR', { hour12: false });
    const hasResp = l.id && capturedResponses.has(l.id);
    const respStatus = l.responseStatus ? `<span style="color:${l.responseStatus < 400 ? '#0b7a3e' : '#d32f2f'};min-width:28px">${l.responseStatus}</span>` : '';
    const clickAttr = hasResp ? `data-resp-id="${l.id}" style="cursor:pointer"` : '';
    return `<div class="icpt-log-item" ${clickAttr}>
      <span class="log-action ${cls}">${l.action}</span>
      <span style="color:#0451a5;min-width:36px">${escapeHtml(l.method)}</span>
      ${respStatus}
      <span class="log-url" title="${escapeHtml(l.url)}">${escapeHtml(shortUrl)}</span>
      <span style="color:#999">${time}</span>
    </div>`;
  }).join('');
}

// 로그 클릭 시 응답 상세 표시
icptLogEl.addEventListener('click', (e) => {
  const item = e.target.closest('[data-resp-id]');
  if (!item) return;
  const resp = capturedResponses.get(item.dataset.respId);
  if (!resp) return;
  showCapturedResponse(resp);
});

function showCapturedResponse(resp) {
  // Response 사이드 에디터에 캡처된 응답 표시
  respPlaceholder.style.display = 'none';
  respEditorContent.classList.remove('hidden');

  document.getElementById('icpt-resp-edit-method').textContent = '';
  document.getElementById('icpt-resp-edit-url').value = '';
  document.getElementById('icpt-resp-edit-status').value = resp.statusCode || 200;

  const headersList = document.getElementById('icpt-resp-headers-list');
  headersList.innerHTML = '';
  if (resp.headers && typeof resp.headers === 'object') {
    Object.entries(resp.headers).forEach(([name, value]) => {
      addIcptKvRow('icpt-resp-headers-list', name, Array.isArray(value) ? value.join(', ') : value);
    });
  }

  const bodyEl = document.getElementById('icpt-resp-edit-body');
  let body = resp.body || '';
  try {
    const parsed = JSON.parse(body);
    body = JSON.stringify(parsed, null, 2);
  } catch {}
  bodyEl.value = body;
  if (resp.bodyTruncated) {
    bodyEl.value += '\n\n--- [truncated at 512KB] ---';
  }
}

// ============================================================
// 2. DOM 검사
// ============================================================

document.getElementById('dom-inspect').addEventListener('click', inspectDOM);
document.getElementById('dom-query').addEventListener('click', queryDOM);
document.getElementById('dom-highlight').addEventListener('click', highlightElement);

function inspectDOM() {
  const expression = `
    (function() {
      function serialize(el, depth) {
        if (depth > 4) return '  ...';
        if (el.nodeType === 3) return el.textContent.trim() ? JSON.stringify(el.textContent.trim()) : null;
        if (el.nodeType !== 1) return null;

        const tag = el.tagName.toLowerCase();
        const attrs = Array.from(el.attributes || []).map(a => a.name + '="' + a.value + '"').join(' ');
        const children = Array.from(el.childNodes)
          .map(c => serialize(c, depth + 1))
          .filter(Boolean);

        const attrStr = attrs ? ' ' + attrs : '';
        if (children.length === 0) return '<' + tag + attrStr + ' />';
        if (children.length === 1 && !children[0].startsWith('<'))
          return '<' + tag + attrStr + '>' + children[0] + '</' + tag + '>';

        return '<' + tag + attrStr + '>\\n' +
          children.map(c => '  ' + c.split('\\n').join('\\n  ')).join('\\n') +
          '\\n</' + tag + '>';
      }
      return serialize(document.documentElement, 0);
    })()
  `;

  chrome.devtools.inspectedWindow.eval(expression, (result, err) => {
    const domTree = document.getElementById('dom-tree');
    if (err) {
      domTree.textContent = 'Error: ' + (err.value || err.description || JSON.stringify(err));
      return;
    }
    domTree.textContent = result || 'Unable to retrieve DOM.';
    syntaxHighlightDOM(domTree);
  });
}

function queryDOM() {
  const selector = document.getElementById('dom-selector').value;
  if (!selector) return;

  const expression = `
    (function() {
      try {
        const elements = document.querySelectorAll(${JSON.stringify(selector)});
        return JSON.stringify({
          count: elements.length,
          elements: Array.from(elements).slice(0, 20).map(el => ({
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            classes: Array.from(el.classList),
            text: el.textContent?.substring(0, 100) || '',
            rect: el.getBoundingClientRect ? {
              x: Math.round(el.getBoundingClientRect().x),
              y: Math.round(el.getBoundingClientRect().y),
              width: Math.round(el.getBoundingClientRect().width),
              height: Math.round(el.getBoundingClientRect().height)
            } : null
          }))
        });
      } catch(e) { return JSON.stringify({ error: e.message }); }
    })()
  `;

  chrome.devtools.inspectedWindow.eval(expression, (result, err) => {
    const info = document.getElementById('dom-info');
    if (err) {
      info.innerHTML = `<span class="status-error">Error: ${escapeHtml(err.value || '')}</span>`;
      return;
    }
    try {
      const data = JSON.parse(result);
      if (data.error) {
        info.innerHTML = `<span class="status-error">${escapeHtml(data.error)}</span>`;
        return;
      }
      info.innerHTML = `<strong>${data.count} elements found</strong><br><br>` +
        data.elements.map(el => {
          const id = el.id ? `#${el.id}` : '';
          const cls = el.classes.length ? `.${el.classes.join('.')}` : '';
          return `<div style="margin-bottom:6px">
            <span class="dom-tag">&lt;${el.tag}${id}${cls}&gt;</span>
            <span class="dom-text">${escapeHtml(el.text.substring(0, 80))}</span>
            ${el.rect ? `<span style="color:#999"> [${el.rect.width}x${el.rect.height} @ ${el.rect.x},${el.rect.y}]</span>` : ''}
          </div>`;
        }).join('');
    } catch {
      info.textContent = result;
    }
  });
}

function highlightElement() {
  const selector = document.getElementById('dom-selector').value;
  if (!selector) return;

  const expression = `
    (function() {
      document.querySelectorAll('.__devtools_highlight__').forEach(el => {
        el.style.outline = el.dataset.origOutline || '';
        el.classList.remove('__devtools_highlight__');
      });
      const els = document.querySelectorAll(${JSON.stringify(selector)});
      els.forEach(el => {
        el.dataset.origOutline = el.style.outline;
        el.style.outline = '2px solid #007acc';
        el.classList.add('__devtools_highlight__');
      });
      return els.length + ' elements highlighted';
    })()
  `;

  chrome.devtools.inspectedWindow.eval(expression, (result) => {
    const info = document.getElementById('dom-info');
    info.innerHTML = `<span class="status-ok">${escapeHtml(result)}</span>`;
  });
}

function syntaxHighlightDOM(el) {
  const text = el.textContent;
  el.innerHTML = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/(&lt;\/?)([\w-]+)/g, '$1<span class="dom-tag">$2</span>')
    .replace(/([\w-]+)(=&quot;)/g, '<span class="dom-attr-name">$1</span>$2')
    .replace(/=&quot;([^&]*)&quot;/g, '=<span class="dom-attr-value">"$1"</span>');
}

// ============================================================
// 3. Console 로그 캡처 (페이지에 hook 주입, debugger 불필요)
// ============================================================
const consoleLogs = [];
let consoleCapturing = false;
let consolePollTimer = null;

document.getElementById('console-start').addEventListener('click', startConsoleCapture);
document.getElementById('console-stop').addEventListener('click', stopConsoleCapture);
document.getElementById('console-clear').addEventListener('click', clearConsole);
document.getElementById('console-execute').addEventListener('click', executeExpression);
document.getElementById('console-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') executeExpression();
});
document.getElementById('console-level-filter').addEventListener('change', renderConsoleLogs);

function startConsoleCapture() {
  consoleCapturing = true;
  document.getElementById('console-start').disabled = true;
  document.getElementById('console-stop').disabled = false;

  // 페이지에 console hook 주입
  const hookExpr = `
    (function() {
      if (window.__consoleHooked__) return 'already';
      window.__consoleHooked__ = true;
      window.__consoleLogs__ = [];
      var orig = {};
      ['log','warn','error','info','debug'].forEach(function(level) {
        orig[level] = console[level];
        console[level] = function() {
          var args = Array.prototype.slice.call(arguments).map(function(a) {
            if (typeof a === 'string') return a;
            try { return JSON.stringify(a); } catch(e) { return String(a); }
          });
          window.__consoleLogs__.push({ level: level === 'warn' ? 'warning' : level, message: args.join(' '), time: Date.now() });
          if (window.__consoleLogs__.length > 500) window.__consoleLogs__.shift();
          orig[level].apply(console, arguments);
        };
      });
      // Capture errors
      window.addEventListener('error', function(e) {
        window.__consoleLogs__.push({ level: 'error', message: e.message + ' at ' + e.filename + ':' + e.lineno, time: Date.now() });
      });
      window.addEventListener('unhandledrejection', function(e) {
        window.__consoleLogs__.push({ level: 'error', message: 'Unhandled rejection: ' + (e.reason && e.reason.message || e.reason), time: Date.now() });
      });
      return 'hooked';
    })()
  `;
  chrome.devtools.inspectedWindow.eval(hookExpr);

  // Polling으로 로그 수집
  consolePollTimer = setInterval(pollConsoleLogs, 500);
}

function pollConsoleLogs() {
  if (!consoleCapturing) return;
  chrome.devtools.inspectedWindow.eval(
    '(function() { var l = window.__consoleLogs__ || []; window.__consoleLogs__ = []; return JSON.stringify(l); })()',
    (result) => {
      if (!result) return;
      try {
        const entries = JSON.parse(result);
        entries.forEach(e => {
          consoleLogs.push({
            level: e.level,
            message: e.message,
            timestamp: new Date(e.time)
          });
        });
        if (entries.length > 0) renderConsoleLogs();
      } catch { /* ignore */ }
    }
  );
}

function stopConsoleCapture() {
  consoleCapturing = false;
  document.getElementById('console-start').disabled = false;
  document.getElementById('console-stop').disabled = true;
  if (consolePollTimer) { clearInterval(consolePollTimer); consolePollTimer = null; }
}

function clearConsole() {
  consoleLogs.length = 0;
  renderConsoleLogs();
}

function executeExpression() {
  const input = document.getElementById('console-input');
  const expr = input.value.trim();
  if (!expr) return;

  consoleLogs.push({
    level: 'input',
    message: '> ' + expr,
    timestamp: new Date()
  });

  chrome.devtools.inspectedWindow.eval(expr, (result, err) => {
    if (err) {
      consoleLogs.push({
        level: 'error-result',
        message: err.value || err.description || JSON.stringify(err),
        timestamp: new Date()
      });
    } else {
      consoleLogs.push({
        level: 'result',
        message: typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result),
        timestamp: new Date()
      });
    }
    renderConsoleLogs();
  });

  input.value = '';
}

function renderConsoleLogs() {
  const output = document.getElementById('console-output');
  const filter = document.getElementById('console-level-filter').value;

  const filtered = filter === 'all'
    ? consoleLogs
    : consoleLogs.filter(l => l.level === filter || l.level === 'input' || l.level === 'result' || l.level === 'error-result');

  output.innerHTML = filtered.map(log => {
    let levelClass = `level-${log.level}`;
    let extraClass = '';
    if (log.level === 'result') extraClass = 'console-result';
    if (log.level === 'error-result') extraClass = 'console-error-result';

    const time = log.timestamp.toLocaleTimeString('ko-KR', { hour12: false });
    return `<div class="console-entry ${extraClass}">
      <span class="level ${levelClass}">${log.level}</span>
      <span class="message">${escapeHtml(log.message)}</span>
      <span class="timestamp">${time}</span>
    </div>`;
  }).join('');

  output.scrollTop = output.scrollHeight;
}

// ============================================================
// 4. Performance 정보
// ============================================================

document.getElementById('perf-collect').addEventListener('click', collectPerformance);
document.getElementById('perf-refresh').addEventListener('click', collectPerformance);

function collectPerformance() {
  const expression = `
    (function() {
      const perf = performance;
      const nav = perf.getEntriesByType('navigation')[0] || {};
      const paint = perf.getEntriesByType('paint') || [];
      const resources = perf.getEntriesByType('resource') || [];

      const fcp = paint.find(p => p.name === 'first-contentful-paint');

      return JSON.stringify({
        timing: {
          dns: Math.round(nav.domainLookupEnd - nav.domainLookupStart) || 0,
          tcp: Math.round(nav.connectEnd - nav.connectStart) || 0,
          ttfb: Math.round(nav.responseStart - nav.requestStart) || 0,
          download: Math.round(nav.responseEnd - nav.responseStart) || 0,
          domParsing: Math.round(nav.domInteractive - nav.responseEnd) || 0,
          domComplete: Math.round(nav.domComplete - nav.domInteractive) || 0,
          loadEvent: Math.round(nav.loadEventEnd - nav.loadEventStart) || 0,
          total: Math.round(nav.loadEventEnd - nav.startTime) || 0,
        },
        fcp: fcp ? Math.round(fcp.startTime) : null,
        resourceCount: resources.length,
        totalTransferred: resources.reduce((sum, r) => sum + (r.transferSize || 0), 0),
        jsHeap: performance.memory ? {
          used: performance.memory.usedJSHeapSize,
          total: performance.memory.totalJSHeapSize,
          limit: performance.memory.jsHeapSizeLimit
        } : null,
        domNodes: document.querySelectorAll('*').length
      });
    })()
  `;

  chrome.devtools.inspectedWindow.eval(expression, (result, err) => {
    const container = document.getElementById('perf-metrics');
    if (err) {
      container.innerHTML = `<div class="metric-card"><div class="label">Error</div><div class="value" style="font-size:14px;color:#d32f2f">${escapeHtml(err.value || '')}</div></div>`;
      return;
    }

    try {
      const data = JSON.parse(result);
      const t = data.timing;

      const cards = [
        { label: 'DNS Lookup', value: t.dns, unit: 'ms' },
        { label: 'TCP Connection', value: t.tcp, unit: 'ms' },
        { label: 'Time to First Byte', value: t.ttfb, unit: 'ms' },
        { label: 'Content Download', value: t.download, unit: 'ms' },
        { label: 'DOM Parsing', value: t.domParsing, unit: 'ms' },
        { label: 'DOM Complete', value: t.domComplete, unit: 'ms' },
        { label: 'Total Load Time', value: t.total, unit: 'ms' },
        { label: 'First Contentful Paint', value: data.fcp || '-', unit: data.fcp ? 'ms' : '' },
        { label: 'DOM Nodes', value: data.domNodes.toLocaleString(), unit: '' },
        { label: 'Resources Loaded', value: data.resourceCount, unit: '' },
        { label: 'Total Transferred', value: formatBytes(data.totalTransferred), unit: '' },
      ];

      if (data.jsHeap) {
        cards.push(
          { label: 'JS Heap Used', value: formatBytes(data.jsHeap.used), unit: '' },
          { label: 'JS Heap Total', value: formatBytes(data.jsHeap.total), unit: '' },
        );
      }

      container.innerHTML = cards.map(c => `
        <div class="metric-card">
          <div class="label">${c.label}</div>
          <div class="value">${c.value}<span class="unit">${c.unit}</span></div>
        </div>
      `).join('');
    } catch {
      container.textContent = result;
    }
  });
}

// ============================================================
// 5. Storage 조회
// ============================================================

document.getElementById('storage-load').addEventListener('click', loadStorage);

function loadStorage() {
  const type = document.getElementById('storage-type').value;
  let expression;

  if (type === 'cookies') {
    expression = `
      (function() {
        return JSON.stringify(
          document.cookie.split(';').filter(Boolean).map(c => {
            const [key, ...rest] = c.trim().split('=');
            return { key: key, value: rest.join('=') };
          })
        );
      })()
    `;
  } else {
    expression = `
      (function() {
        const s = ${type};
        const items = [];
        for (let i = 0; i < s.length; i++) {
          const key = s.key(i);
          items.push({ key: key, value: s.getItem(key) });
        }
        return JSON.stringify(items);
      })()
    `;
  }

  chrome.devtools.inspectedWindow.eval(expression, (result, err) => {
    const tbody = document.querySelector('#storage-table tbody');
    if (err) {
      tbody.innerHTML = `<tr><td colspan="2" class="status-error">Error: ${escapeHtml(err.value || '')}</td></tr>`;
      return;
    }

    try {
      const items = JSON.parse(result);
      if (items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="2" style="color:#999">No items found.</td></tr>`;
        return;
      }
      tbody.innerHTML = items.map(item => `
        <tr>
          <td><strong>${escapeHtml(item.key)}</strong></td>
          <td title="${escapeHtml(item.value)}">${escapeHtml(truncate(item.value, 200))}</td>
        </tr>
      `).join('');
    } catch {
      tbody.innerHTML = `<tr><td colspan="2">${escapeHtml(result)}</td></tr>`;
    }
  });
}

// ============================================================
// 유틸리티 함수
// ============================================================

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function truncateUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url.length > 80 ? url.substring(0, 80) + '...' : url;
  }
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.substring(0, max) + '...' : str;
}

function formatPreview(preview) {
  if (preview.type === 'object') {
    if (preview.subtype === 'array') {
      return `[${preview.properties.map(p => p.value).join(', ')}]`;
    }
    return `{${preview.properties.map(p => `${p.name}: ${p.value}`).join(', ')}}`;
  }
  return preview.description || '[object]';
}
