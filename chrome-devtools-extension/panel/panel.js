// ============================================================
// DevTools Inspector Panel - Main Script
// ============================================================

const tabId = chrome.devtools.inspectedWindow.tabId;

// --- Tab switching ---
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab).classList.add('active');
  });
});

// ============================================================
// 0. Site Map — Passive collection + tree view
// ============================================================

// sitemapTree[mainHost] = {
//   children: { path: { children, requests } },
//   requests: [],
//   external: { extHost: { children, requests } },
//   _lastVisitedUrl, _lastVisitedAt
// }
// Top-level keys are always "main hosts" — origins the user actually
// landed on during this session. Cross-origin requests get attributed
// to whichever main host was active at capture time, nested under
// that main host's `external` map.
const sitemapTree = {};
let targetHost = null;
// Currently-selected tree node — drives the right-pane source viewer
// and the row's `.selected` highlight. Cleared by the close button.
let sitemapSelectedNode = null; // { host, path }
const expandedNodes = new Set(); // tracks expanded tree node keys (e.g. "host:/path")

// Requests captured before the first targetHost is known wait here
// and are flushed once we know which main host owns them.
const _sitemapPending = [];

function ensureTargetInTree() {
  if (targetHost && !sitemapTree[targetHost]) {
    sitemapTree[targetHost] = { children: {}, requests: [], external: {} };
  }
  if (targetHost && sitemapTree[targetHost] && !sitemapTree[targetHost].external) {
    sitemapTree[targetHost].external = {};
  }
}

function _flushSitemapPending() {
  if (!targetHost) return;
  while (_sitemapPending.length > 0) {
    const r = _sitemapPending.shift();
    // Pre-targetHost captures missed the _mainHost stamp at capture
    // time. Now that we know the main host, retro-stamp them so they
    // align with the tree's session attribution.
    if (r._mainHost == null) r._mainHost = targetHost;
    addToSitemap(r);
  }
}

function detectTargetHost() {
  // Pull both host and href so the initial page (which doesn't trigger
  // onNavigated) still gets a _lastVisitedUrl — without it the host
  // would later be filtered out of the visited-hosts list when the
  // user navigates away.
  const expr = 'JSON.stringify({host: location.host, href: location.href})';
  chrome.devtools.inspectedWindow.eval(expr, (result, err) => {
    if (err || !result) return;
    let info;
    try { info = JSON.parse(result); } catch { return; }
    if (!info.host) return;
    targetHost = info.host;
    ensureTargetInTree();
    const main = sitemapTree[targetHost];
    if (main && info.href) {
      main._lastVisitedUrl = info.href;
      main._lastVisitedAt = Date.now();
    }
    _flushSitemapPending();
    renderSitemapTree();
    // Tab for the initial inspected page — DevTools++ opened on an
    // already-loaded page won't see an onNavigated event, so seed
    // the tab here so the user has something to scope into.
    if (typeof ensureTab === 'function') {
      ensureTab(targetHost);
      if (typeof setActiveTab === 'function') setActiveTab(targetHost);
    }
  });
}
detectTargetHost();
chrome.devtools.network.onNavigated.addListener((url) => {
  let newHost;
  try {
    newHost = new URL(url).host;
  } catch {
    detectTargetHost();
    return;
  }
  // Preserve-log-style: hosts visited earlier in the session stay in
  // the tree. Only Clear wipes them. The current target moves to the
  // top of the tree; everything else cascades into "External".
  targetHost = newHost;
  if (newHost) {
    if (!sitemapTree[newHost]) {
      sitemapTree[newHost] = { children: {}, requests: [], external: {} };
    }
    if (!sitemapTree[newHost].external) sitemapTree[newHost].external = {};
    // Track the most recent URL/time the user landed on this host so
    // the tree row tooltip can show "where they were last".
    sitemapTree[newHost]._lastVisitedUrl = url;
    sitemapTree[newHost]._lastVisitedAt = Date.now();
  }
  ensureTargetInTree();
  _flushSitemapPending();
  renderSitemapTree();
  // Browser-side navigation = user's analysis focus shifted. Pull the
  // host's tab to active so the list / detail follow. Revisiting an
  // earlier host reuses its existing tab (ensureTab is idempotent
  // and setActiveTab no-ops when already active), so accumulation
  // continues seamlessly.
  if (newHost) {
    if (typeof ensureTab === 'function') {
      ensureTab(newHost);
      if (typeof setActiveTab === 'function') setActiveTab(newHost);
    }
  }
});
const sitemapTreeEl = document.getElementById('sitemap-tree');

// Auto Crawl: drives the inspected tab through a list of URLs while
// Network monitoring records everything. Useful for sweeping a known
// set of targets in one sitting.
const crawlState = {
  active: false,
  urls: [],
  index: 0,
  waitMs: 5000,
  timeoutId: null,
};

function preprocessCrawlUrls(rawText) {
  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
  const seen = new Set();
  const urls = [];
  for (const line of lines) {
    let url = /^https?:\/\//i.test(line) ? line : 'https://' + line;
    try { new URL(url); } catch { continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length >= 200) break;
  }
  return urls;
}

function showCrawlModal() {
  document.getElementById('crawl-modal').classList.remove('hidden');
}
function hideCrawlModal() {
  document.getElementById('crawl-modal').classList.add('hidden');
}

function startCrawl() {
  const text = document.getElementById('crawl-urls').value;
  const urls = preprocessCrawlUrls(text);
  if (urls.length === 0) {
    showToast('No valid URLs.');
    return;
  }
  const waitVal = parseInt(document.getElementById('crawl-wait').value, 10);
  const waitSec = Math.min(30, Math.max(1, isNaN(waitVal) ? 5 : waitVal));

  // Auto-start network monitoring if not already on
  if (!networkMonitoring) startNetworkMonitoring();

  crawlState.active = true;
  crawlState.urls = urls;
  crawlState.index = 0;
  crawlState.waitMs = waitSec * 1000;

  // UI: lock inputs, swap Start → Stop, reveal progress block
  document.getElementById('crawl-urls').disabled = true;
  document.getElementById('crawl-wait').disabled = true;
  document.getElementById('crawl-import-btn').disabled = true;
  document.getElementById('crawl-progress').classList.remove('hidden');
  const btn = document.getElementById('crawl-start');
  btn.textContent = 'Stop';
  btn.className = 'btn btn-danger';

  visitNextCrawl();
}

function visitNextCrawl() {
  if (!crawlState.active) return;
  if (crawlState.index >= crawlState.urls.length) {
    completeCrawl();
    return;
  }
  const url = crawlState.urls[crawlState.index];
  updateCrawlProgress();
  const expr = `location.href = ${JSON.stringify(url)}`;
  chrome.devtools.inspectedWindow.eval(expr, () => {
    // Errors (chrome:// URLs, blocked, etc.) — skip and continue.
    if (!crawlState.active) return;
    crawlState.index++;
    crawlState.timeoutId = setTimeout(visitNextCrawl, crawlState.waitMs);
  });
}

function stopCrawl() {
  if (crawlState.timeoutId) clearTimeout(crawlState.timeoutId);
  crawlState.timeoutId = null;
  crawlState.active = false;
  resetCrawlUI();
}

function completeCrawl() {
  const visited = crawlState.index;
  crawlState.active = false;
  resetCrawlUI();
  showToast(`Visited ${visited} site${visited === 1 ? '' : 's'}.`);
  hideCrawlModal();
}

function resetCrawlUI() {
  document.getElementById('crawl-urls').disabled = false;
  document.getElementById('crawl-wait').disabled = false;
  document.getElementById('crawl-import-btn').disabled = false;
  document.getElementById('crawl-progress').classList.add('hidden');
  const btn = document.getElementById('crawl-start');
  btn.textContent = 'Start';
  btn.className = 'btn btn-primary';
}

function updateCrawlProgress() {
  const total = crawlState.urls.length;
  const idx = crawlState.index;
  const url = crawlState.urls[idx] || '';
  document.querySelector('.crawl-progress-fill').style.width =
    `${(idx / total) * 100}%`;
  document.querySelector('.crawl-progress-text').textContent = `${idx + 1}/${total}`;
  document.querySelector('.crawl-current-url').textContent = url;
}

let _toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById('dtpp-toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('visible');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toast.classList.remove('visible'), 3000);
}

document.getElementById('network-auto-crawl').addEventListener('click', showCrawlModal);
document.getElementById('crawl-modal-close').addEventListener('click', () => {
  if (crawlState.active) stopCrawl();
  hideCrawlModal();
});
document.getElementById('crawl-cancel').addEventListener('click', () => {
  if (crawlState.active) stopCrawl();
  hideCrawlModal();
});
document.getElementById('crawl-start').addEventListener('click', () => {
  if (crawlState.active) stopCrawl();
  else startCrawl();
});

// Import .txt — fills the textarea with the file's contents. The
// textarea stays editable afterward, so users can tweak the imported
// list (drop unwanted hosts, add a few more) before hitting Start.
const _crawlImportFile = document.getElementById('crawl-import-file');
document.getElementById('crawl-import-btn').addEventListener('click', () => {
  _crawlImportFile.click();
});
_crawlImportFile.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  // Soft size cap — 200-URL limit produces a tiny file in normal use,
  // so anything bigger than 256 KB is almost certainly the wrong file.
  if (file.size > 256 * 1024) {
    showToast('File too large (max 256 KB)');
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const textarea = document.getElementById('crawl-urls');
    textarea.value = String(reader.result || '');
  };
  reader.onerror = () => {
    showToast('Failed to read file');
  };
  reader.readAsText(file);
  // Reset so re-selecting the same filename re-fires the change event.
  e.target.value = '';
});

document.getElementById('network-reload').addEventListener('click', () => {
  // Hard reload — bypass the HTTP cache so cached CSS / JS / images
  // come back through the network layer and land in the capture. A
  // normal reload would let the browser serve them from the cache
  // and skip the chrome.devtools.network event entirely, which would
  // leave the tree / list with silent gaps.
  chrome.devtools.inspectedWindow.reload({ ignoreCache: true });
});

function classifyMimeType(mimeType) {
  if (!mimeType) return 'other';
  if (mimeType.includes('json') || mimeType.includes('xml')) return 'api';
  if (mimeType.includes('html')) return 'page';
  if (mimeType.includes('javascript')) return 'script';
  if (mimeType.includes('css')) return 'style';
  if (mimeType.includes('image')) return 'image';
  if (mimeType.includes('font') || mimeType.includes('woff')) return 'font';
  return 'other';
}


function addToSitemap(req) {
  let parsed;
  try { parsed = new URL(req.url); } catch { return; }

  const host = parsed.host;
  const pathname = parsed.pathname || '/';
  const segments = pathname.split('/').filter(Boolean);

  // No main host known yet — buffer until detectTargetHost / onNavigated
  // assigns one, then this request will be replayed.
  if (!targetHost) {
    _sitemapPending.push(req);
    return;
  }

  // Ensure the active main host node exists.
  if (!sitemapTree[targetHost]) {
    sitemapTree[targetHost] = { children: {}, requests: [], external: {} };
  }
  const mainNode = sitemapTree[targetHost];
  if (!mainNode.external) mainNode.external = {};

  // Pick the bucket: same-origin requests go into the main host's own
  // path tree; cross-origin requests go under that main host's
  // `external` map (one entry per external host).
  let node;
  if (host === targetHost) {
    node = mainNode;
  } else {
    if (!mainNode.external[host]) {
      mainNode.external[host] = { children: {}, requests: [] };
    }
    node = mainNode.external[host];
  }

  for (const seg of segments) {
    if (!node.children[seg]) {
      node.children[seg] = { children: {}, requests: [] };
    }
    node = node.children[seg];
  }

  // Dedup: skip if same method + url + status combination exists
  const isDup = node.requests.some(r => r.method === req.method && r.url === req.url && r.status === req.status);
  if (!isDup) {
    node.requests.push(req);
  }

  scheduleSitemapRender();
}

// Throttled tree render for the per-request hot path. Renders at most
// once per animation frame, and defers rendering while the user has a
// control inside the tree focused (open Set Scope <select>) so a
// burst of incoming requests doesn't tear the dropdown down mid-click.
let _sitemapRenderRaf = 0;
function scheduleSitemapRender() {
  if (_sitemapRenderRaf) return;
  _sitemapRenderRaf = requestAnimationFrame(() => {
    _sitemapRenderRaf = 0;
    const active = document.activeElement;
    if (active && active.closest && active.closest('.sitemap-tree')) {
      // Try again next frame — defer until the user finishes
      // interacting with the tree.
      scheduleSitemapRender();
      return;
    }
    renderSitemapTree();
  });
}


function matchesSitemapFilters(req) {
  // Site Map's only filter is the global Scope — out-of-scope captured
  // requests get hidden from the tree until the user clears the scope.
  // Type/Status filtering lives exclusively in the Network tab now.
  return inGlobalScope(req.url);
}

function nodeHasFilteredRequests(node) {
  if (node.requests.some(matchesSitemapFilters)) return true;
  return Object.values(node.children).some(nodeHasFilteredRequests);
}

function getNodeRequestCount(node) {
  let count = 0;
  function countN(n) {
    count += n.requests.filter(matchesSitemapFilters).length;
    Object.values(n.children).forEach(countN);
  }
  countN(node);
  return count;
}

function renderSitemapTree() {
  sitemapTreeEl.innerHTML = '';

  const hosts = Object.keys(sitemapTree).sort();
  if (hosts.length === 0) {
    sitemapTreeEl.innerHTML = '<div class="sitemap-empty">Data is collected automatically as requests are made.</div>';
    return;
  }

  // Target host always shown first
  if (targetHost) {
    ensureTargetInTree();
    const hostNode = sitemapTree[targetHost];
    const hostEl = buildTreeNode(targetHost, hostNode, targetHost, '', true);
    if (hostEl) sitemapTreeEl.appendChild(hostEl);
  }

  // Previously-visited hosts (non-target main hosts the user actually
  // navigated to). Each one renders at the top level beneath the
  // current target; their cross-origin requests live nested inside
  // each main host's own External group (handled by buildTreeNode).
  const visitedHosts = hosts.filter(h =>
    h !== targetHost && sitemapTree[h]._lastVisitedUrl
  );
  for (const host of visitedHosts) {
    const el = buildTreeNode(host, sitemapTree[host], host, '', true);
    if (el) sitemapTreeEl.appendChild(el);
  }
}

// Per-main-host External group. Lives as a child of the main host's
// own tree node so each visited site keeps its third-party traffic
// scoped to itself. Toggle key includes the main host so different
// sites' external groups expand independently.
function buildHostExternalGroup(externalMap, mainHost) {
  const externalHosts = Object.keys(externalMap || {})
    .filter(h => nodeHasFilteredRequests(externalMap[h]))
    .sort();
  if (externalHosts.length === 0) return null;

  const wrapper = document.createElement('div');
  wrapper.className = 'sitemap-external-group';

  const expandKey = `${mainHost}:__external__`;
  const isExpanded = expandedNodes.has(expandKey);

  const row = document.createElement('div');
  row.className = 'sitemap-node sitemap-external-header';
  const toggle = document.createElement('span');
  toggle.className = 'sitemap-node-toggle';
  toggle.textContent = isExpanded ? '▼' : '▶';
  row.appendChild(toggle);
  const icon = document.createElement('span');
  icon.className = 'sitemap-node-icon';
  icon.textContent = '📡';
  row.appendChild(icon);
  const label = document.createElement('span');
  label.className = 'sitemap-node-label sitemap-external-label';
  label.textContent = `External (${externalHosts.length})`;
  row.appendChild(label);
  wrapper.appendChild(row);

  const children = document.createElement('div');
  children.className = isExpanded ? 'sitemap-children' : 'sitemap-children collapsed';
  for (const host of externalHosts) {
    const el = buildTreeNode(host, externalMap[host], host, '');
    if (el) children.appendChild(el);
  }
  wrapper.appendChild(children);

  function toggleGroup(e) {
    if (e) e.stopPropagation();
    if (expandedNodes.has(expandKey)) expandedNodes.delete(expandKey);
    else expandedNodes.add(expandKey);
    children.classList.toggle('collapsed');
    toggle.textContent = children.classList.contains('collapsed') ? '▶' : '▼';
  }
  toggle.addEventListener('click', toggleGroup);
  row.addEventListener('click', () => toggleGroup(null));

  return wrapper;
}

function buildTreeNode(label, node, host, currentPath, forceShow) {
  const isHostNode = currentPath === '';
  const hasPathChildren = Object.keys(node.children).length > 0;
  const hasExternalChildren = isHostNode && node.external && Object.keys(node.external).length > 0;
  const hasChildren = hasPathChildren || hasExternalChildren;
  const hasOwnRequests = node.requests.filter(matchesSitemapFilters).length > 0;

  if (!forceShow && !nodeHasFilteredRequests(node)) return null;

  const wrapper = document.createElement('div');

  // Node row
  const row = document.createElement('div');
  row.className = 'sitemap-node';
  const isHost = currentPath === '';
  const fullPath = currentPath || '/';
  if (sitemapSelectedNode &&
      sitemapSelectedNode.host === host &&
      sitemapSelectedNode.path === fullPath) {
    row.classList.add('selected');
  }
  // Highlight whichever host is the currently-active inspected page,
  // and show "where the user last was on this host" as a tooltip on
  // any host that's been visited during this session.
  if (isHost) {
    if (host === targetHost) row.classList.add('sitemap-node-target');
    if (node._lastVisitedUrl) {
      const ts = node._lastVisitedAt ? new Date(node._lastVisitedAt).toLocaleString() : '';
      row.title = `Last visited: ${node._lastVisitedUrl}${ts ? ` (${ts})` : ''}`;
    }
  }

  // Toggle icon
  const nodeKey = host + ':' + fullPath;
  const isExpanded = expandedNodes.has(nodeKey);
  const toggle = document.createElement('span');
  toggle.className = 'sitemap-node-toggle';
  toggle.textContent = hasChildren ? (isExpanded ? '▼' : '▶') : '';
  row.appendChild(toggle);

  // Icon
  const icon = document.createElement('span');
  icon.className = 'sitemap-node-icon';
  icon.textContent = isHost ? '🌐' : (hasPathChildren ? '📁' : '📄');
  row.appendChild(icon);

  // Label
  const labelEl = document.createElement('span');
  labelEl.className = 'sitemap-node-label';
  labelEl.textContent = label;
  row.appendChild(labelEl);

  const count = getNodeRequestCount(node);
  if (count > 0) {
    const countEl = document.createElement('span');
    countEl.className = 'sitemap-node-count';
    countEl.textContent = count;
    row.appendChild(countEl);
  }

  // Host-only: "Set Scope" dropdown on hover — pin this domain (or its
  // wildcard form) as the global scope. Cuts down on Intercept noise
  // without forcing the user to type the pattern by hand.
  if (isHost) {
    const scopeSelect = document.createElement('select');
    scopeSelect.className = 'btn btn-xs sitemap-scope-select';
    scopeSelect.title = `Set global scope based on ${host}`;

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Set Scope';
    placeholder.disabled = true;
    placeholder.selected = true;
    scopeSelect.appendChild(placeholder);

    const exactOpt = document.createElement('option');
    exactOpt.value = `${host}/*`;
    exactOpt.textContent = `Exact: ${host}`;
    scopeSelect.appendChild(exactOpt);

    const wildcard = wildcardHost(host);
    if (wildcard) {
      const wildcardOpt = document.createElement('option');
      wildcardOpt.value = `${wildcard}/*`;
      wildcardOpt.textContent = `Wildcard: ${wildcard}`;
      scopeSelect.appendChild(wildcardOpt);
    }

    scopeSelect.addEventListener('click', (e) => e.stopPropagation());
    scopeSelect.addEventListener('change', (e) => {
      e.stopPropagation();
      const pattern = scopeSelect.value;
      if (pattern) applyScopePattern(pattern);
      scopeSelect.value = '';
    });

    row.appendChild(scopeSelect);
  }

  wrapper.appendChild(row);

  // Children container (restore expanded state)
  const childrenEl = document.createElement('div');
  childrenEl.className = isExpanded ? 'sitemap-children' : 'sitemap-children collapsed';

  const sortedChildren = Object.keys(node.children).sort();
  for (const childName of sortedChildren) {
    const childPath = currentPath + '/' + childName;
    const childEl = buildTreeNode(childName, node.children[childName], host, childPath);
    if (childEl) childrenEl.appendChild(childEl);
  }

  // Per-host External group — only on the main-host row, only if any
  // external host has filtered requests to show.
  if (hasExternalChildren) {
    const extGroup = buildHostExternalGroup(node.external, host);
    if (extGroup) childrenEl.appendChild(extGroup);
  }

  if (hasChildren) {
    wrapper.appendChild(childrenEl);
  }

  // Toggle helper — expands or collapses this node's children. Used
  // by both the explicit toggle arrow and the row-click fallback.
  function toggleExpanded() {
    const collapsed = childrenEl.classList.toggle('collapsed');
    toggle.textContent = collapsed ? '▶' : '▼';
    if (collapsed) expandedNodes.delete(nodeKey); else expandedNodes.add(nodeKey);
  }

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleExpanded();
  });

  // Row click — opens the source viewer for the latest captured
  // request at this exact node, mirroring DevTools' Sources tab where
  // clicking a file shows its contents on the right. Nodes with no
  // direct request (intermediate paths that only have descendants)
  // fall back to expand/collapse so every row stays clickable.
  // Tree click — when the node has a directly-captured request,
  // jump to it in the Network list (selectNetworkRequest opens the
  // detail panel and highlights the row). Intermediate path nodes
  // with only descendants fall back to expand/collapse so every row
  // stays clickable.
  row.addEventListener('click', (e) => {
    // Ignore clicks that landed on the host's Set Scope dropdown — it
    // has its own change handler and shouldn't double-trigger the row.
    if (e.target.closest('.sitemap-scope-select')) return;
    if (node.requests.length > 0) {
      const latest = node.requests[node.requests.length - 1];
      if (latest && latest.requestId && networkRequestMap.has(latest.requestId)) {
        // Switch the active tab only when the click landed on a main
        // host (top-level in sitemapTree, which == tabHosts entry).
        // External-host nodes (under some main host's `external` map)
        // don't get their own tabs, so leave the current tab alone
        // and just open the detail.
        const reqHost = _reqHost(latest);
        if (reqHost && reqHost !== activeTabHost && tabHosts.indexOf(reqHost) >= 0) {
          setActiveTab(reqHost);
        }
        sitemapSelectedNode = { host, path: fullPath };
        selectNetworkRequest(latest.requestId, { scroll: true });
        renderSitemapTree(); // refresh .selected highlight
        return;
      }
      // Captured outside of monitoring → not in the Network detail
      // map. Surface a hint instead of a silent no-op so the user
      // knows the row was clickable but produced nothing.
      showToast('Start Monitoring to inspect this request');
      return;
    }
    if (hasChildren) toggleExpanded();
  });

  return wrapper;
}

// ============================================================
// Send to Browser — open captured request in a new tab so it goes
// through the proxy and lands in the original panel's Intercept queue.
// ============================================================

// Browser-managed headers we strip from the swap payload — sending
// these would either be redundant or fight with what the new tab's
// browser-set values should naturally be (Cookie comes from the jar,
// Origin/Referer reflect the launcher tab, Content-Type is set by the
// form-submit / GET semantics).
const BROWSER_MANAGED_HEADERS_S2B = new Set([
  'cookie', 'host', 'origin', 'referer', 'user-agent',
  'accept', 'accept-encoding', 'accept-language',
  'connection', 'content-length',
  'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user',
  'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
  'upgrade-insecure-requests',
  'content-type',
]);

function _filterHeadersForSwap(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (BROWSER_MANAGED_HEADERS_S2B.has(name.toLowerCase())) continue;
    // HTTP/2 pseudo-headers (:authority / :method / :path / :scheme /
    // :status) appear in captures whenever Chrome talked to the origin
    // over h2. They are invalid in HTTP/1.1 token names and would crash
    // node's http.request() if forwarded — drop them.
    if (name.startsWith(':')) continue;
    out[name] = value;
  }
  return out;
}

function _getHeaderCI(headers, name) {
  if (!headers) return '';
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return '';
}

function canSendToBrowser(req) {
  if (!req || !req.method || !req.url) {
    return { ok: false, reason: 'No request selected' };
  }
  if (req._imported) {
    return { ok: false, reason: 'Imported requests cannot be re-issued — only live captures' };
  }
  if (req.method === 'GET') return { ok: true };
  if (req.method !== 'POST') {
    return { ok: false, reason: `${req.method} cannot be triggered as a browser navigation — use Replay` };
  }
  const ct = (_getHeaderCI(req.requestHeaders, 'content-type') || '').toLowerCase();
  if (ct.startsWith('application/x-www-form-urlencoded')) return { ok: true };
  if (ct.startsWith('multipart/form-data')) {
    return { ok: false, reason: 'multipart/form-data POST cannot be replayed (file fields are not captured) — use Replay' };
  }
  if (ct.startsWith('application/json')) {
    return { ok: false, reason: 'JSON body cannot be navigated — use Replay' };
  }
  if (!ct) {
    if (!req.requestPostData) return { ok: true };
    return { ok: false, reason: 'POST body has no Content-Type — cannot determine encoding' };
  }
  return { ok: false, reason: `Content-Type "${ct.split(';')[0]}" cannot be browser-navigated — use Replay` };
}

function _parseFormUrlencodedFields(body) {
  if (!body) return [];
  const fields = [];
  for (const part of body.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const rawName = eq < 0 ? part : part.slice(0, eq);
    const rawValue = eq < 0 ? '' : part.slice(eq + 1);
    let name = rawName;
    let value = rawValue;
    try {
      name = decodeURIComponent(rawName.replace(/\+/g, ' '));
      value = decodeURIComponent(rawValue.replace(/\+/g, ' '));
    } catch { /* malformed encoding — pass through raw */ }
    fields.push({ name, value });
  }
  return fields;
}

function sendToBrowserNewTab() {
  const req = networkRequestMap.get(selectedRequestId);
  const check = canSendToBrowser(req);
  if (!check.ok) {
    showToast(check.reason);
    return;
  }
  if (!interceptActive) {
    showToast('Enable Intercept first — the new tab needs the proxy active to be caught');
    return;
  }
  const payload = {
    method: req.method,
    url: req.url,
    headers: _filterHeadersForSwap(req.requestHeaders),
  };
  if (req.method === 'POST') {
    payload.fields = _parseFormUrlencodedFields(req.requestPostData || '');
    payload.enctype = 'application/x-www-form-urlencoded';
  }
  // Background handles tab creation, DNR tagging, and header-swap
  // registration as one async sequence. We get a `send_to_browser_error`
  // broadcast back if anything fails.
  sendToBg({
    type: 'open_new_tab_for_intercept',
    payload,
  });
  const interceptTabBtn = document.querySelector('.tab[data-tab="intercept"]');
  if (interceptTabBtn) interceptTabBtn.click();
  showToast('Opening new tab — watch the Intercept queue');
}

function updateSendToBrowserButton() {
  const btn = document.getElementById('detail-send-to-browser');
  if (!btn) return;
  const req = selectedRequestId ? networkRequestMap.get(selectedRequestId) : null;
  if (!req) {
    btn.disabled = true;
    btn.title = 'Select a request first';
    return;
  }
  // Replay edit mode is mutually exclusive with Send to Browser — the
  // user is editing a request to fire via fetch, sending to a new tab
  // would either compete with that or silently send the un-edited
  // captured request, both of which are surprising. Lock the button
  // until they exit replay edit.
  if (msgReplayEditing) {
    btn.disabled = true;
    btn.title = 'Exit Replay edit (click ↻ Replay again) to use Send to Browser';
    return;
  }
  const check = canSendToBrowser(req);
  btn.disabled = !check.ok;
  btn.title = check.ok
    ? 'Open this request in a new tab so it goes through Intercept (requires Intercept ON).'
    : check.reason;
}

document.getElementById('detail-send-to-browser').addEventListener('click', sendToBrowserNewTab);


// ============================================================
// 1. Network monitoring (using chrome.devtools.network API - no debugger needed)
// ============================================================
const networkRequests = [];
const networkRequestMap = new Map(); // requestId -> request object
let networkMonitoring = false;
let selectedRequestId = null;
let networkIdCounter = 0;

// Per-host tabs above the Network list. Each captured host gets its
// own tab the first time a request lands; the active tab acts as a
// host filter on the global networkRequests array (data isn't
// duplicated per tab — a single source plus a render-time filter).
// Browser navigation auto-switches the active tab; revisiting an
// earlier host reuses its existing tab so accumulation continues.
const tabHosts = []; // ordered list of host strings (display order)
let activeTabHost = null;

// Multi-select for export. Tracks request IDs the user has checked via
// the per-row checkbox or master checkbox; independent from
// selectedRequestId (which drives the detail panel).
const selectedExportIds = new Set();
let _lastCheckedReqId = null; // anchor for shift-click range selection

// View filter — multi-select Type (mime category) + Status (HTTP code
// range). Empty Set on either side means "no filter on that axis";
// when both are empty the filter is fully inactive. Independent of
// Scope (which acts as a domain gate) and Search (which marks but
// doesn't hide). Applied at render time only — captured data stays
// intact in networkRequests so toggling filters never loses anything.
const networkFilter = {
  types: new Set(),    // 'api' | 'page' | 'script' | 'style' | 'image' | 'font' | 'other'
  statuses: new Set(), // '2xx' | '3xx' | '4xx' | '5xx'
};

function networkFilterIsActive() {
  return networkFilter.types.size > 0 || networkFilter.statuses.size > 0;
}

function matchesNetworkFilter(req) {
  if (networkFilter.types.size > 0) {
    if (!networkFilter.types.has(classifyMimeType(req.mimeType))) return false;
  }
  if (networkFilter.statuses.size > 0) {
    const s = req.status;
    let bucket = null;
    if (s >= 200 && s < 300) bucket = '2xx';
    else if (s >= 300 && s < 400) bucket = '3xx';
    else if (s >= 400 && s < 500) bucket = '4xx';
    else if (s >= 500 && s < 600) bucket = '5xx';
    if (!bucket || !networkFilter.statuses.has(bucket)) return false;
  }
  return true;
}

const networkTable = document.querySelector('#network-table tbody');
const networkCount = document.getElementById('network-count');
const networkDetail = document.getElementById('network-detail');
const networkSplit = document.querySelector('.network-split');
const networkTabsEl = document.getElementById('network-tabs');

// Pull the host out of a request URL once. Stored on the request the
// first time it's looked up so repeated tab-filter checks don't
// re-parse the URL on every render frame.
function _reqHost(req) {
  if (req._host != null) return req._host;
  try { req._host = new URL(req.url).host; }
  catch { req._host = ''; }
  return req._host;
}

// Per-tab visibility mode — 'all' (default) shows the full session
// (direct hits + externals captured during that session, mirroring the
// Site Map's main-host → External attribution), 'internal' narrows to
// direct same-host hits only. Per-tab state so the user can keep, e.g.,
// github.com on All while sandboxing a focused look on reddit.com.
const tabFilterMode = new Map(); // host → 'all' | 'internal'
function getTabFilterMode(host) {
  return tabFilterMode.get(host) || 'all';
}

function matchesActiveTab(req) {
  if (!activeTabHost) return true;
  if (_reqHost(req) === activeTabHost) return true;
  // 'internal' mode skips the session-attribution branch — externals
  // (CDN .map files, analytics, ads) drop out of view.
  if (getTabFilterMode(activeTabHost) === 'internal') return false;
  if (req._mainHost === activeTabHost) return true;
  return false;
}

// Make sure a tab exists for the given host. Called from the request
// pipeline (every captured request) and from explicit user actions
// (tree click, navigation event). Returns true if a new tab was
// added — caller can use this to decide whether to redraw.
function ensureTab(host) {
  if (!host) return false;
  if (tabHosts.indexOf(host) >= 0) return false;
  tabHosts.push(host);
  const becameActive = activeTabHost == null;
  if (becameActive) activeTabHost = host;
  renderNetworkTabs();
  if (becameActive) refreshTabModeToggleUI();
  return true;
}

// Switch the active tab. Re-renders all the host-filtered views so
// the list / count / search-match-set / selection-master all reflect
// the new tab in one shot.
function setActiveTab(host) {
  if (!host || activeTabHost === host) return;
  ensureTab(host);
  activeTabHost = host;
  // Stale row highlight from the prior tab — the request might no
  // longer be in the visible set. Clear before re-rendering.
  if (selectedRequestId) {
    const sel = networkRequestMap.get(selectedRequestId);
    if (!sel || _reqHost(sel) !== host) {
      closeDetail();
    }
  }
  renderNetworkTabs();
  refreshTabModeToggleUI();
  renderNetworkTable();
  updateSelectionUI();
  if (searchTerm) {
    recomputeSearchMatches();
    refreshAllRowDots();
    refreshSearchUI();
  }
}

// Sync the All / Host-only toggle to the active tab's stored mode.
// Called on tab switch and on each click.
function refreshTabModeToggleUI() {
  const wrap = document.getElementById('network-tab-mode-toggle');
  if (!wrap) return;
  const mode = activeTabHost ? getTabFilterMode(activeTabHost) : 'all';
  wrap.querySelectorAll('.tab-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  // Disable when there's no tab to scope into — toggle is meaningless.
  wrap.classList.toggle('disabled', !activeTabHost);
}

// Close a tab — wipes that host's captured requests from the global
// store and drops the corresponding tree subtree so both views
// agree. The user gets a confirm dialog first because data loss is
// irreversible (no undo / no buffer).
function closeTab(host) {
  if (!host) return;
  // Match the matchesActiveTab predicate so the confirm dialog's count
  // and the actual wipe target are exactly what the user has been
  // looking at — direct host hits AND the session's externals.
  const belongsToTab = r => _reqHost(r) === host || r._mainHost === host;
  const count = networkRequests.filter(belongsToTab).length;
  const msg = count > 0
    ? `Close tab "${host}" and discard its ${count} captured request${count === 1 ? '' : 's'}?`
    : `Close tab "${host}"?`;
  if (!window.confirm(msg)) return;

  // Drop matching requests in place (preserves array reference).
  for (let i = networkRequests.length - 1; i >= 0; i--) {
    if (belongsToTab(networkRequests[i])) {
      const req = networkRequests[i];
      networkRequestMap.delete(req.requestId);
      selectedExportIds.delete(req.requestId);
      networkRequests.splice(i, 1);
    }
  }
  // Tree: drop main host bucket + any external-of-other-hosts that
  // pointed at this host. The ones we own at the top level are the
  // visible tab's subtree.
  if (sitemapTree[host]) delete sitemapTree[host];
  for (const mainHost of Object.keys(sitemapTree)) {
    const ext = sitemapTree[mainHost].external;
    if (ext && ext[host]) delete ext[host];
  }
  // Tab list itself.
  const idx = tabHosts.indexOf(host);
  if (idx >= 0) tabHosts.splice(idx, 1);
  if (activeTabHost === host) {
    activeTabHost = tabHosts.length > 0 ? tabHosts[Math.min(idx, tabHosts.length - 1)] : null;
  }
  // Forget this tab's mode — fresh tabs default to 'all' next time.
  tabFilterMode.delete(host);
  // The selection might have pointed at a now-gone request.
  if (selectedRequestId && !networkRequestMap.has(selectedRequestId)) {
    closeDetail();
  }
  renderNetworkTabs();
  refreshTabModeToggleUI();
  renderNetworkTable();
  renderSitemapTree();
  updateSelectionUI();
  if (searchTerm) {
    recomputeSearchMatches();
    refreshAllRowDots();
    refreshSearchUI();
  }
}

function renderNetworkTabs() {
  if (tabHosts.length === 0) {
    networkTabsEl.classList.add('hidden');
    networkTabsEl.innerHTML = '';
    _updateExportMenuTabLabels(0);
    return;
  }
  networkTabsEl.classList.remove('hidden');
  // Per-tab counts mirror what each tab actually shows: a request is
  // in a tab when its host matches (direct) OR its _mainHost matches
  // (captured during that session). One walk through networkRequests,
  // one request can count toward up to two tabs (its host's tab if
  // any, plus its session host's tab) — that's the correct total
  // because matchesActiveTab admits both.
  const counts = new Map();
  const tabSet = new Set(tabHosts);
  for (const r of networkRequests) {
    const h = _reqHost(r);
    if (tabSet.has(h)) counts.set(h, (counts.get(h) || 0) + 1);
    if (r._mainHost && r._mainHost !== h && tabSet.has(r._mainHost)) {
      counts.set(r._mainHost, (counts.get(r._mainHost) || 0) + 1);
    }
  }
  let html = '';
  for (const host of tabHosts) {
    const isActive = host === activeTabHost;
    const count = counts.get(host) || 0;
    html += `<button class="network-tab${isActive ? ' active' : ''}" data-host="${escapeAttr(host)}">` +
      `<span class="tab-host" title="${escapeAttr(host)}">${escapeHtml(host)}</span>` +
      `<span class="tab-count">${count}</span>` +
      `<span class="tab-close" data-close="${escapeAttr(host)}" title="Close tab">×</span>` +
      `</button>`;
  }
  networkTabsEl.innerHTML = html;
  _updateExportMenuTabLabels(tabHosts.length);
}

// Reflect the current active tab + total tab count in the Export
// menu's section headers so the user can tell at a glance which scope
// each option will write out.
function _updateExportMenuTabLabels(tabCount) {
  const tabSec = document.getElementById('export-menu-section-tab');
  const allSec = document.getElementById('export-menu-section-all');
  if (tabSec) {
    tabSec.textContent = activeTabHost
      ? `Current tab (${activeTabHost})`
      : 'Current tab';
  }
  if (allSec) {
    allSec.textContent = tabCount > 0
      ? `All tabs (${tabCount} host${tabCount === 1 ? '' : 's'})`
      : 'All tabs';
  }
}

// Click delegation — switches active tab on label/count click,
// closes on the X click. data-host carries the target through the
// re-render so we don't need per-element listeners.
networkTabsEl.addEventListener('click', (e) => {
  const closeEl = e.target.closest('.tab-close');
  if (closeEl) {
    e.stopPropagation();
    closeTab(closeEl.dataset.close);
    return;
  }
  const tabEl = e.target.closest('.network-tab');
  if (!tabEl) return;
  setActiveTab(tabEl.dataset.host);
});

document.getElementById('network-start').addEventListener('click', startNetworkMonitoring);
document.getElementById('network-stop').addEventListener('click', stopNetworkMonitoring);
document.getElementById('network-clear').addEventListener('click', clearNetwork);

// All / Host-only toggle. Per-tab — sets the active tab's filter mode
// and re-renders. The other tabs keep their own modes untouched.
document.querySelectorAll('#network-tab-mode-toggle .tab-mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!activeTabHost) return;
    const mode = btn.dataset.mode;
    if (getTabFilterMode(activeTabHost) === mode) return;
    tabFilterMode.set(activeTabHost, mode);
    refreshTabModeToggleUI();
    renderNetworkTable();
    updateSelectionUI();
    if (searchTerm) {
      recomputeSearchMatches();
      refreshAllRowDots();
      refreshSearchUI();
    }
  });
});
refreshTabModeToggleUI();

// Detail panel tab switching
document.querySelectorAll('.detail-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.detail-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    const pane = document.getElementById('detail-' + tab.dataset.detail);
    pane.classList.add('active');
    // When a search is active, scroll the first match in the newly
    // shown tab into view so clicking the 🔍 badge is self-explanatory.
    if (searchTerm) {
      const firstMark = pane.querySelector('mark.network-search-mark');
      if (firstMark) firstMark.scrollIntoView({ block: 'center' });
    }
  });
});

// Detail panel close
document.getElementById('detail-close').addEventListener('click', closeDetail);

function closeDetail() {
  networkDetail.classList.add('hidden');
  networkSplit.classList.remove('has-detail');
  selectedRequestId = null;
  networkTable.querySelectorAll('tr.selected').forEach(r => r.classList.remove('selected'));
  updateSendToBrowserButton();
}

// chrome.devtools.network event listener (always active, no attach needed)
chrome.devtools.network.onRequestFinished.addListener(processNetworkRequest);

// Track URLs+statuses we've already ingested so HAR replay (auto-start)
// doesn't re-add the same entries the live listener already processed.
const _ingestedRequestKeys = new Set();
function _ingestKey(harEntry) {
  const startedDateTime = harEntry.startedDateTime || '';
  return `${harEntry.request.method}|${harEntry.request.url}|${harEntry.response.status}|${startedDateTime}`;
}

function processNetworkRequest(harEntry) {
  // Skip data: URIs entirely — they're inline payloads, not real
  // network traffic, and a single page can produce hundreds of them
  // (icons, etc.) that would only flood the list and slow scanning.
  if (harEntry.request.url.startsWith('data:')) return;

  // Global scope gate — out-of-scope requests are ignored entirely
  // (not added to Site Map or Network lists). Empty scope = all in scope.
  if (!inGlobalScope(harEntry.request.url)) return;

  // Dedup against HAR replay so the same entry doesn't land twice
  // (e.g. live listener fires for a request that's also still in
  // the HAR snapshot taken at auto-start).
  const key = _ingestKey(harEntry);
  if (_ingestedRequestKeys.has(key)) return;
  _ingestedRequestKeys.add(key);

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

  // Raw numeric size/time alongside the display strings — exported for
  // sorting/filtering downstream.
  const rawSize = resp.content?.size ?? resp._transferSize ?? null;
  const rawTime = harEntry.time != null ? Math.round(harEntry.time) : null;

  // HAR-replayed entries can already carry the body inline in
  // response.content.text — use it directly so the request shows its
  // payload immediately without depending on getContent.
  const inlineBody = (resp.content && typeof resp.content.text === 'string') ? resp.content.text : null;
  const inlineBodyBase64 = inlineBody != null && resp.content && resp.content.encoding === 'base64';

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
    rawSize,
    rawTime,
    protocol: resp.httpVersion || '',
    remoteAddress: '',
    requestHeaders: requestHeaders,
    requestPostData: postData,
    responseHeaders: responseHeaders,
    responseBody: inlineBody,
    responseBodyLoaded: inlineBody != null,
    responseBase64: inlineBodyBase64,
    initiator: harEntry._initiator || null,
    // Active main host at capture time — drives session-based tab
    // separation so externals (CDN, .map files, analytics) appear in
    // the same tab as the host that loaded them. Mirrors the
    // attribution Site Map already uses (sitemapTree[main].external).
    // Null when targetHost isn't known yet; _flushSitemapPending
    // back-fills these once detection completes.
    _mainHost: targetHost || null,
    _harEntry: harEntry, // HAR entry reference (for body loading)
  };

  // Replay correlation runs FIRST so the row's displayed headers /
  // body reflect the user's modifications before scan / sitemap /
  // search index pull from req. Page-context fetch silently drops
  // header edits to forbidden names (Cookie, User-Agent, Sec-*, etc.)
  // and the HAR entry only carries the wire-level result; without
  // this override the row would silently appear "reverted" even
  // though Send went through with the user's intent.
  const replayMatch = consumeReplayFireMatch(req.url, req.method);
  if (replayMatch) {
    req._isReplay = true;
    if (replayMatch.displayHeaders) {
      req.requestHeaders = replayMatch.displayHeaders;
    }
    if (replayMatch.displayBody != null && replayMatch.displayBody !== '') {
      req.requestPostData = replayMatch.displayBody;
    }
  }

  // Initial scanner pass — runs against URL/headers/request body and the
  // response status. Body-side findings come on a second pass once the
  // body is loaded below.
  req.scanResults = scanRequest(req);

  // Site Map always collects
  addToSitemap(req);

  // Network list only when monitoring is ON
  if (!networkMonitoring) return;
  networkRequests.push(req);
  networkRequestMap.set(reqId, req);
  reindexRequestForSearch(req);
  // Tabs follow main-host navigation only — third-party / CDN /
  // analytics requests don't get their own tabs (they'd flood the
  // bar). detectTargetHost + onNavigated handle tab creation on
  // browser-side navigation; per-request ensureTab here would
  // create one for every external resource.
  scheduleAppendNetworkRow(req);

  // Eagerly try source-map mapping so the Initiator column reflects
  // the final "↑ Mapped" state without waiting for the user to click
  // into the request. Cheap thanks to sourceMapCache (per-script
  // dedup) and runIdle scheduling.
  if (req.initiator && req.initiator.stack && req.initiator.stack.callFrames) {
    runIdle(() => _eagerEnrichInitiator(req));
  }

  // Eagerly load the body for text-like responses so the scanner can
  // see body-side findings without waiting for the user to click in.
  // Queue caps concurrency; the body scan itself runs in idle time so
  // a flood of requests doesn't block paint.
  if (scanShouldEagerLoadBody(req) && !req.responseBodyLoaded) {
    queueBodyLoad(req, (content, encoding) => {
      if (content == null) return;
      req.responseBody = content;
      req.responseBase64 = encoding === 'base64';
      req.responseBodyLoaded = true;
      runIdle(() => {
        req.scanResults = scanRequest(req);
        updateNetworkRowBadges(req);
        reindexRequestForSearch(req);
        if (selectedRequestId === req.requestId) {
          renderResponsePane(req);
          renderDetection(req);
          applyDetailHighlights(req);
        }
      });
    });
  }
}

// Re-build the search index for a single request and, if a search is
// active, refresh membership / dots / counts. Called on request
// capture and again when a body arrives late or scanResults change.
function reindexRequestForSearch(req) {
  buildSearchIndex(req);
  if (!searchTerm) return;
  recomputeSearchMatches();
  refreshAllRowDots();
  refreshSearchUI();
}

// Replay HAR for everything Chrome already captured before the panel
// opened — auto-start uses this so a user landing on an already-loaded
// page sees its requests instead of an empty table.
function replayExistingNetworkHAR() {
  if (!chrome.devtools || !chrome.devtools.network ||
      typeof chrome.devtools.network.getHAR !== 'function') return;
  chrome.devtools.network.getHAR((har) => {
    if (!har || !Array.isArray(har.entries)) return;
    for (const entry of har.entries) {
      processNetworkRequest(entry);
    }
  });
}

function startNetworkMonitoring() {
  networkMonitoring = true;
  document.getElementById('network-start').disabled = true;
  document.getElementById('network-stop').disabled = false;
  safeStorageSet({ networkMonitoring: true });
}

function stopNetworkMonitoring() {
  networkMonitoring = false;
  document.getElementById('network-start').disabled = false;
  document.getElementById('network-stop').disabled = true;
  safeStorageSet({ networkMonitoring: false });
}

function clearNetwork() {
  networkRequests.length = 0;
  networkRequestMap.clear();
  _pendingNetworkRows.length = 0;
  if (_networkRenderRaf) { cancelAnimationFrame(_networkRenderRaf); _networkRenderRaf = 0; }
  _ingestedRequestKeys.clear();
  selectedExportIds.clear();
  _lastCheckedReqId = null;
  // Tree shares the data the list is built from, so Clear wipes both.
  Object.keys(sitemapTree).forEach(k => delete sitemapTree[k]);
  expandedNodes.clear();
  _sitemapPending.length = 0;
  // Tabs are derived from captured data — wipe them too so the bar
  // reflects the empty state, not a row of orphan host names.
  tabHosts.length = 0;
  activeTabHost = null;
  renderNetworkTabs();
  closeDetail();
  renderNetworkTable();
  renderSitemapTree();
  updateSelectionUI();
  // Drop search matches but preserve the term so the user can keep
  // typing into a freshly cleared list.
  searchMatchedIds = [];
  searchCursor = -1;
  refreshSearchUI();
}

// Shared JSON download helper for the export menu paths.
function _downloadJson(filename, data) {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function _exportTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function _exportMetadata() {
  let extensionVersion = '';
  try { extensionVersion = chrome.runtime.getManifest().version; } catch {}
  return {
    exportedAt: new Date().toISOString(),
    extensionVersion,
    targetHost: targetHost || '',
    scope: globalScope.input || '',
  };
}

// Export every captured request — full headers, bodies (where loaded),
// scan results, and initiator. Source set is determined by scope
// (current tab / all tabs) and selectedOnly (limit to checked rows).
function exportAllRequests(scope, selectedOnly) {
  const source = _exportSource(scope, selectedOnly);
  const items = source.map(r => ({
    request: {
      method: r.method,
      url: r.url,
      status: r.status,
      statusText: r.statusText,
      mimeType: r.mimeType,
      type: r.type,
      size: r.size,
      time: r.time,
      rawSize: r.rawSize ?? null,
      rawTime: r.rawTime ?? null,
    },
    requestHeaders: r.requestHeaders || {},
    requestPostData: r.requestPostData || null,
    responseHeaders: r.responseHeaders || {},
    responseBody: r.responseBody || null,
    responseBodyLoaded: !!r.responseBodyLoaded,
    responseBase64: !!r.responseBase64,
    scanResults: r.scanResults || [],
    initiator: r.initiator || null,
    // Session attribution — preserve so a re-imported file lands in
    // the same per-host tab grouping the original capture had.
    mainHost: r._mainHost || null,
  }));

  _downloadJson(
    `devtoolspp-full-requests-${_exportTimestamp()}.json`,
    Object.assign({}, _exportMetadata(), {
      totalRequests: source.length,
      items,
    })
  );
}

// ============================================================
// Import — load a previously exported JSON back into the panel
// ============================================================
// Accepts either format we produce: Detection-only (items have
// `findings`) or All-requests (items have full request data) — and
// falls back to a flat `requests` array as a defensive alternative.

let _importIdCounter = 0;

function _parseImportJson(text) {
  let data;
  try { data = JSON.parse(text); }
  catch { return { error: 'Invalid file (JSON parse failed)' }; }
  if (!data || typeof data !== 'object') {
    return { error: 'Invalid file' };
  }
  if (!data.exportedAt) {
    return { error: 'Invalid file (missing exportedAt)' };
  }
  const items = Array.isArray(data.items) ? data.items
    : Array.isArray(data.requests) ? data.requests
    : null;
  if (!items) {
    return { error: 'Invalid file (no items / requests array)' };
  }
  return { items };
}

// Convert one imported item into a req object compatible with the
// rest of the panel. Supports wrapped (`{request: {...}, ...}`) and
// flat (`{method, url, ...}`) shapes; pulls scanResults from either
// `findings` (Detection format) or `scanResults` (All format).
function _itemToReq(item) {
  const meta = item.request || item;
  // Session attribution — prefer the export's stamp, fall back to
  // the URL's host so legacy exports (no mainHost) still land in the
  // most-natural tab.
  let mainHost = item.mainHost || null;
  if (!mainHost) {
    try { mainHost = new URL(meta.url || '').host || null; } catch {}
  }
  return {
    requestId: 'imp_' + (++_importIdCounter),
    method: meta.method || 'GET',
    url: meta.url || '',
    status: meta.status ?? 0,
    statusText: meta.statusText || '',
    type: meta.type || '-',
    mimeType: meta.mimeType || '',
    size: meta.size || '-',
    time: meta.time || '-',
    rawSize: meta.rawSize ?? null,
    rawTime: meta.rawTime ?? null,
    protocol: meta.protocol || '',
    requestHeaders: item.requestHeaders || meta.requestHeaders || {},
    requestPostData: item.requestPostData ?? meta.requestPostData ?? null,
    responseHeaders: item.responseHeaders || meta.responseHeaders || {},
    responseBody: item.responseBody !== undefined ? item.responseBody : (meta.responseBody ?? null),
    responseBodyLoaded: item.responseBodyLoaded ?? meta.responseBodyLoaded ?? false,
    responseBase64: !!(item.responseBase64 ?? meta.responseBase64),
    initiator: item.initiator || meta.initiator || null,
    scanResults: item.findings || item.scanResults || meta.scanResults || [],
    _mainHost: mainHost,
    _harEntry: null,
    _imported: true,
  };
}

function _applyImport(reqs, mode, filename) {
  if (mode === 'overwrite') {
    networkRequests.length = 0;
    networkRequestMap.clear();
    selectedExportIds.clear();
    _lastCheckedReqId = null;
    tabHosts.length = 0;
    activeTabHost = null;
    closeDetail();
    renderNetworkTable();
    updateSelectionUI();
  }
  for (const r of reqs) {
    networkRequests.push(r);
    networkRequestMap.set(r.requestId, r);
    buildSearchIndex(r);
  }
  // Rebuild the tab strip from imported _mainHost values so the user
  // gets the same per-session navigation they had at capture time.
  // _mainHost is preserved by export; legacy exports without it get
  // their URL host as the fallback (set in _itemToReq), so a flat
  // import still produces sensible tabs.
  const importedMainHosts = new Set();
  for (const r of reqs) {
    if (r._mainHost) importedMainHosts.add(r._mainHost);
  }
  for (const h of importedMainHosts) ensureTab(h);
  renderNetworkTabs();
  renderNetworkTable();
  updateSelectionUI();
  if (searchTerm) {
    recomputeSearchMatches();
    refreshAllRowDots();
    refreshSearchUI();
  }
  showImportNotice(filename);
  showToast(`Loaded ${reqs.length} request${reqs.length === 1 ? '' : 's'} (${filename})`);
}

function showImportNotice(filename) {
  document.getElementById('network-import-name').textContent = filename;
  document.getElementById('network-import-notice').classList.remove('hidden');
}

function hideImportNotice() {
  document.getElementById('network-import-notice').classList.add('hidden');
}

// Three-way confirmation modal for the overwrite/append decision.
// Single-shot: handlers are detached after a choice is made.
function showImportConfirm(message, onChoice) {
  const modal = document.getElementById('import-confirm-modal');
  document.getElementById('import-confirm-msg').textContent = message;
  modal.classList.remove('hidden');
  const overwriteBtn = document.getElementById('import-confirm-overwrite');
  const appendBtn = document.getElementById('import-confirm-append');
  const cancelBtn = document.getElementById('import-confirm-cancel');
  function cleanup(choice) {
    modal.classList.add('hidden');
    overwriteBtn.removeEventListener('click', onOverwrite);
    appendBtn.removeEventListener('click', onAppend);
    cancelBtn.removeEventListener('click', onCancel);
    onChoice(choice);
  }
  function onOverwrite() { cleanup('overwrite'); }
  function onAppend() { cleanup('append'); }
  function onCancel() { cleanup('cancel'); }
  overwriteBtn.addEventListener('click', onOverwrite);
  appendBtn.addEventListener('click', onAppend);
  cancelBtn.addEventListener('click', onCancel);
}

function importNetworkData(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const result = _parseImportJson(String(reader.result || ''));
    if (result.error) { showToast(result.error); return; }
    const reqs = result.items.map(_itemToReq);
    if (reqs.length === 0) { showToast('No requests in file'); return; }
    if (networkRequests.length > 0) {
      showImportConfirm(
        `${networkRequests.length} request${networkRequests.length === 1 ? '' : 's'} already captured. What would you like to do?`,
        (choice) => {
          if (choice === 'cancel') return;
          _applyImport(reqs, choice, file.name);
        }
      );
    } else {
      _applyImport(reqs, 'overwrite', file.name);
    }
  };
  reader.onerror = () => showToast('Failed to read file');
  reader.readAsText(file);
}

const _importFileInput = document.getElementById('network-import-file');
document.getElementById('network-import').addEventListener('click', () => {
  _importFileInput.click();
});
_importFileInput.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) importNetworkData(file);
  e.target.value = ''; // allow re-selecting the same file
});
document.getElementById('network-import-notice-close').addEventListener('click', hideImportNotice);

// Export-button dropdown — pick scope before downloading.
const _exportBtn = document.getElementById('network-export');
const _exportMenu = document.getElementById('network-export-menu');
_exportBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  _exportMenu.classList.toggle('hidden');
});
document.querySelectorAll('.export-menu-item').forEach(item => {
  item.addEventListener('click', () => {
    if (item.disabled) return;
    const scope = item.dataset.scope;            // 'tab' | 'all'
    const selectedOnly = item.dataset.selected === 'true';
    _exportMenu.classList.add('hidden');
    exportAllRequests(scope, selectedOnly);
  });
});

// Source-set picker for the export menu.
//   scope        : 'tab' (active host only) | 'all' (every capture)
//   selectedOnly : true  → narrow to the rows the user has checked
// The ENTIRE networkRequests array IS the storage; filtering happens
// per call so the data is never duplicated.
function _exportSource(scope, selectedOnly) {
  let base;
  if (scope === 'all') {
    base = networkRequests;
  } else {
    // 'tab' — exactly what the user sees in the active tab. Mirrors
    // matchesActiveTab so the export captures the same session view
    // (direct hits + the session's externals). When no tab is active
    // yet, fall back to all so the file isn't silently empty.
    base = activeTabHost
      ? networkRequests.filter(r => matchesActiveTab(r))
      : networkRequests;
  }
  if (selectedOnly) {
    return base.filter(r => selectedExportIds.has(r.requestId));
  }
  return base;
}
document.addEventListener('click', (e) => {
  if (_exportMenu.classList.contains('hidden')) return;
  if (e.target.closest('.export-dropdown')) return;
  _exportMenu.classList.add('hidden');
});

// ---------- Network Filter (Type / Status multi-select) ----------
const _filterBtn = document.getElementById('network-filter-btn');
const _filterMenu = document.getElementById('network-filter-menu');
_filterBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  _filterMenu.classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  if (_filterMenu.classList.contains('hidden')) return;
  if (e.target.closest('.network-filter-dropdown')) return;
  _filterMenu.classList.add('hidden');
});

// Sync the menu's checkbox state into the networkFilter Sets and re-
// render. Called on every change inside the menu — filtering is
// instant, so toggling a checkbox immediately reflects in the table.
function applyNetworkFilterFromUI() {
  networkFilter.types.clear();
  networkFilter.statuses.clear();
  _filterMenu.querySelectorAll('input[data-filter-type]').forEach(cb => {
    if (cb.checked) networkFilter.types.add(cb.dataset.filterType);
  });
  _filterMenu.querySelectorAll('input[data-filter-status]').forEach(cb => {
    if (cb.checked) networkFilter.statuses.add(cb.dataset.filterStatus);
  });
  _refreshFilterButtonLabel();
  renderNetworkTable();
  // Selection persists across filter toggles (same model as Scope) but
  // master indeterminate ratio depends on what's visible.
  updateSelectionUI();
  // Search match list ANDs with what's visible — a filter change can
  // flip rows in / out of the matched set.
  if (searchTerm) {
    recomputeSearchMatches();
    refreshAllRowDots();
    refreshSearchUI();
  }
}

function _refreshFilterButtonLabel() {
  const total = networkFilter.types.size + networkFilter.statuses.size;
  if (total === 0) {
    _filterBtn.textContent = 'Filter ▾';
    _filterBtn.classList.remove('has-active');
  } else {
    _filterBtn.textContent = `Filter ▾ (${total})`;
    _filterBtn.classList.add('has-active');
  }
}

_filterMenu.querySelectorAll('input[data-filter-type], input[data-filter-status]').forEach(cb => {
  cb.addEventListener('change', applyNetworkFilterFromUI);
});

document.getElementById('network-filter-reset').addEventListener('click', () => {
  _filterMenu.querySelectorAll('input[data-filter-type], input[data-filter-status]').forEach(cb => {
    cb.checked = false;
  });
  applyNetworkFilterFromUI();
});

function fetchResponseBody(req) {
  if (req.responseBodyLoaded) return;
  if (!req._harEntry) return;
  req._harEntry.getContent((body, encoding) => {
    if (body !== undefined && body !== null) {
      req.responseBody = body;
      req.responseBase64 = (encoding === 'base64');
      req.responseBodyLoaded = true;
      reindexRequestForSearch(req);
      if (selectedRequestId === req.requestId) {
        renderResponsePane(req);
        applyDetailHighlights(req);
      }
    }
  });
}

// Bounded-concurrency body loader. The DevTools getContent API isn't
// great when fired hundreds of times at once, so eager loads queue up
// here with a small concurrency cap. User-initiated fetches still go
// through fetchResponseBody (no queue) for snappy detail-panel opens.
const _bodyLoadQueue = [];
let _activeBodyLoads = 0;
const MAX_CONCURRENT_BODY_LOADS = 5;

function queueBodyLoad(req, callback) {
  _bodyLoadQueue.push({ req, callback });
  processBodyLoadQueue();
}

function processBodyLoadQueue() {
  while (_activeBodyLoads < MAX_CONCURRENT_BODY_LOADS && _bodyLoadQueue.length > 0) {
    const { req, callback } = _bodyLoadQueue.shift();
    if (req.responseBodyLoaded) {
      // Body was loaded by a user click while waiting in the queue —
      // hand the cached content back without another getContent call.
      callback(req.responseBody, req.responseBase64 ? 'base64' : null);
      continue;
    }
    if (!req._harEntry) {
      callback(null, null);
      continue;
    }
    _activeBodyLoads++;
    req._harEntry.getContent((content, encoding) => {
      _activeBodyLoads--;
      try { callback(content, encoding); }
      finally { processBodyLoadQueue(); }
    });
  }
}

// Run a function during idle time so heavy scans don't block UI on
// burst loads. Falls back to setTimeout in browsers without rIC.
function runIdle(fn) {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(fn, { timeout: 2000 });
  } else {
    setTimeout(fn, 0);
  }
}

// Maximum visible rows in the network table — older rows are dropped
// from the DOM (data stays in `networkRequests` for export and
// addressing). On busy portal sites a thousand rows is enough to spot
// patterns without melting the renderer.
const MAX_NETWORK_ROWS = 1000;

// Initiator column badge — small text badge on each row reflecting
// the kind of initiator data we have. After enrichFramesWithSourceMaps
// runs and at least one frame maps to original source, the badge
// upgrades to "↑ Mapped".
function renderInitiatorBadge(r) {
  // Tooltip pulls from the same descriptions used inside the Initiator
  // detail tab, so hovering the column badge tells the same story as
  // the type indicator inside the detail view.
  if (r._sourcemapMapped) {
    const t = escapeAttr(INITIATOR_TYPE_DESCRIPTIONS.mapped || '');
    return `<span class="initiator-cell-badge initiator-cell-mapped" title="${t}">↑ Mapped</span>`;
  }
  if (!r.initiator || !r.initiator.type) return '';
  const t = r.initiator.type;
  if (t === 'script') {
    const desc = escapeAttr(INITIATOR_TYPE_DESCRIPTIONS.script || '');
    return `<span class="initiator-cell-badge initiator-cell-script" title="${desc}">script</span>`;
  }
  if (t === 'parser') {
    const desc = escapeAttr(INITIATOR_TYPE_DESCRIPTIONS.parser || '');
    return `<span class="initiator-cell-badge initiator-cell-parser" title="${desc}">parser</span>`;
  }
  return ''; // 'other' / unknown
}

function updateNetworkRowInitiator(req) {
  const row = networkTable.querySelector(
    `tr[data-request-id="${CSS.escape(req.requestId)}"]`
  );
  if (!row) return;
  const cell = row.querySelector('.initiator-cell');
  if (cell) cell.innerHTML = renderInitiatorBadge(req);
}

// Repaint just the URL cell after the user marks/unmarks a request as
// a login from the Auth tab. Saves a full table re-render.
function updateNetworkRowAuth(req) {
  const row = networkTable.querySelector(
    `tr[data-request-id="${CSS.escape(req.requestId)}"]`
  );
  if (!row) return;
  const urlCell = row.querySelector('.url-cell');
  if (!urlCell) return;
  const authBadge = _isReqAuth(req)
    ? '<span class="row-auth-badge" title="Detected as login request — see Auth tab">🔐</span> '
    : '';
  const replayBadge = req._isReplay
    ? '<span class="row-replay-badge" title="Sent via Replay">↻</span> '
    : '';
  urlCell.innerHTML = authBadge + replayBadge + escapeHtml(truncateUrl(req.url));
}

// Build a single <tr> for a request without touching the DOM. Returns
// the element so callers can append/insert as they choose.
function buildNetworkRow(r) {
  const statusClass = r.status >= 400 ? 'status-error'
    : r.status >= 300 ? 'status-redirect'
    : r.status >= 200 ? 'status-ok' : '';
  let host = '';
  try { host = new URL(r.url).host; } catch { /* malformed url */ }
  const hostKindClass = (host && host !== targetHost) ? 'host-cell-external' : 'host-cell-target';
  const tr = document.createElement('tr');
  tr.dataset.requestId = r.requestId;
  if (r.requestId === selectedRequestId) tr.classList.add('selected');
  if (selectedExportIds.has(r.requestId)) tr.classList.add('row-checked');
  if (searchTerm && searchMatchedIds.includes(r.requestId)) tr.classList.add('search-hit');
  if (r._isReplay) tr.classList.add('row-replay');
  const checkedAttr = selectedExportIds.has(r.requestId) ? 'checked' : '';
  // Replay-originated requests get a small ↻ badge prefix in the URL
  // cell so they're distinguishable in the timeline at a glance —
  // user can tell which entries came from their own Replay Sends vs
  // browser-driven captures.
  const replayBadge = r._isReplay
    ? '<span class="row-replay-badge" title="Sent via Replay">↻</span> '
    : '';
  // Login-detected (or manually marked) requests get a small 🔐 prefix
  // so the user can spot auth flows in the list without opening the
  // Auth tab on every row.
  const authBadge = _isReqAuth(r)
    ? '<span class="row-auth-badge" title="Detected as login request — see Auth tab">🔐</span> '
    : '';
  tr.innerHTML =
    `<td class="select-cell"><input type="checkbox" class="row-select" ${checkedAttr}></td>` +
    `<td class="host-cell ${hostKindClass}" title="${escapeHtml(r.url)}">${escapeHtml(host)}</td>` +
    `<td><strong>${escapeHtml(r.method)}</strong></td>` +
    `<td class="url-cell" title="${escapeHtml(r.url)}">${authBadge}${replayBadge}${escapeHtml(truncateUrl(r.url))}</td>` +
    `<td class="${statusClass}">${r.status}</td>` +
    `<td>${escapeHtml(r.type)}</td>` +
    `<td>${r.size}</td>` +
    `<td>${r.time}</td>` +
    `<td class="initiator-cell">${renderInitiatorBadge(r)}</td>` +
    `<td class="scan-badges-cell">${renderScanBadgesInline(r.scanResults)}</td>`;
  return tr;
}

function updateNetworkCount() {
  // The active tab is the user's "session" boundary — counts are
  // tab-scoped so "100 / 271 (filtered)" reads as 100 visible out of
  // the tab's 271, not out of the global 3948 pool. Scope + Type/
  // Status filters are the secondary axis layered on top of the tab.
  const hasTab = activeTabHost != null;
  const hasScope = !!globalScope.regex;
  const hasFilter = networkFilterIsActive();

  let tabTotal = 0; // total in the active tab (or global when no tab)
  let visible = 0;  // after Scope + Type/Status applied
  for (const r of networkRequests) {
    if (hasTab && !matchesActiveTab(r)) continue;
    tabTotal++;
    if (hasScope && !inGlobalScope(r.url)) continue;
    if (hasFilter && !matchesNetworkFilter(r)) continue;
    visible++;
  }

  if (hasScope || hasFilter) {
    networkCount.textContent = visible === tabTotal
      ? `${tabTotal} requests`
      : `${visible} / ${tabTotal} requests (filtered)`;
    return;
  }
  if (tabTotal > MAX_NETWORK_ROWS) {
    networkCount.textContent = `${tabTotal} requests · showing last ${MAX_NETWORK_ROWS}`;
  } else {
    networkCount.textContent = `${tabTotal} requests`;
  }
}

// Trim oldest visible rows when the table exceeds MAX_NETWORK_ROWS.
function enforceMaxNetworkRows() {
  while (networkTable.children.length > MAX_NETWORK_ROWS) {
    networkTable.removeChild(networkTable.firstChild);
  }
}

// Update the badges cell of an existing row. No-op if the row was
// already trimmed off the visible window.
function updateNetworkRowBadges(req) {
  const row = networkTable.querySelector(
    `tr[data-request-id="${CSS.escape(req.requestId)}"]`
  );
  if (!row) return;
  const cell = row.querySelector('.scan-badges-cell');
  if (cell) cell.innerHTML = renderScanBadgesInline(req.scanResults);
}

// Full re-render — used on clear / startup, and whenever the global
// Scope changes since Scope is now a view filter too. Streaming events
// use the append/batch path below to avoid O(n²) rebuilds.
function renderNetworkTable() {
  networkTable.innerHTML = '';
  // Apply active-tab + Scope + Type/Status as view filters. All three
  // are pure view filters — networkRequests stays intact, so toggling
  // any of them is reversible without losing data.
  const hasTab = activeTabHost != null;
  const hasScope = !!globalScope.regex;
  const hasFilter = networkFilterIsActive();
  let visible = networkRequests;
  if (hasTab || hasScope || hasFilter) {
    visible = networkRequests.filter(r => {
      if (hasTab && !matchesActiveTab(r)) return false;
      if (hasScope && !inGlobalScope(r.url)) return false;
      if (hasFilter && !matchesNetworkFilter(r)) return false;
      return true;
    });
  }
  const fragment = document.createDocumentFragment();
  const start = Math.max(0, visible.length - MAX_NETWORK_ROWS);
  for (let i = start; i < visible.length; i++) {
    fragment.appendChild(buildNetworkRow(visible[i]));
  }
  networkTable.appendChild(fragment);
  updateNetworkCount();
}

// Streaming append: incoming requests are queued and flushed once per
// animation frame. Keeps a portal site's burst of hundreds of requests
// from triggering hundreds of separate layout/paint cycles.
const _pendingNetworkRows = [];
let _networkRenderRaf = 0;

function scheduleAppendNetworkRow(req) {
  _pendingNetworkRows.push(req);
  if (_networkRenderRaf) return;
  _networkRenderRaf = requestAnimationFrame(() => {
    _networkRenderRaf = 0;
    flushPendingNetworkRows();
  });
}

function flushPendingNetworkRows() {
  if (_pendingNetworkRows.length === 0) return;
  const hasTab = activeTabHost != null;
  const hasFilter = networkFilterIsActive();
  const fragment = document.createDocumentFragment();
  let appended = 0;
  let countTouchedTabs = false;
  for (const r of _pendingNetworkRows) {
    // Streaming row inherits the same filter axes as the full re-
    // render (active tab + Scope + Type/Status). Scope is already
    // enforced upstream in processNetworkRequest so we only re-check
    // tab + filter here. Tabs surface request counts on the bar; if
    // any incoming row's host has a tab, mark for re-render.
    if (hasTab && !matchesActiveTab(r)) {
      // Out-of-tab rows still update the inactive tab's count badge.
      if (tabHosts.includes(_reqHost(r))) countTouchedTabs = true;
      continue;
    }
    if (hasFilter && !matchesNetworkFilter(r)) continue;
    fragment.appendChild(buildNetworkRow(r));
    appended++;
  }
  _pendingNetworkRows.length = 0;
  if (appended > 0) {
    networkTable.appendChild(fragment);
    enforceMaxNetworkRows();
    // The active tab itself just got more rows — refresh its count.
    countTouchedTabs = true;
  }
  if (countTouchedTabs) renderNetworkTabs();
  updateNetworkCount();
  // New unchecked rows can flip master state from checked → indeterminate.
  if (selectedExportIds.size > 0) updateSelectionUI();
}

// Click delegation on tbody — attached once at load so each new row
// doesn't need its own listener. Clicking the Initiator cell jumps
// straight to the Initiator detail tab; clicks on the row checkbox
// only toggle export selection without opening the detail panel.
networkTable.addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-request-id]');
  if (!row) return;
  const reqId = row.dataset.requestId;
  // Row checkbox → toggle export selection. Stop here so the click
  // doesn't fall through to the detail-open path.
  if (e.target.matches('input.row-select')) {
    handleRowCheckboxClick(reqId, e.target.checked, e.shiftKey);
    return;
  }
  // Treat clicks on the select-cell padding (outside the input) as
  // a no-op rather than detail-open — clicking the cell that's "for"
  // the checkbox shouldn't surprise users by opening a detail panel.
  if (e.target.closest('td.select-cell')) return;
  const wantInitiator = !!e.target.closest('.initiator-cell');
  selectNetworkRequest(reqId, {
    scroll: false,
    activateTab: wantInitiator ? 'initiator' : null,
  });
});

// ============================================================
// Multi-select for export
// ============================================================
// `getVisibleRequests` returns requests in the same order as the
// rendered table (active tab + Scope + Type/Status Filter applied).
// All selection ops — select-all, range, Cmd+A — operate on this
// view so what the user sees matches what they select.
function getVisibleRequests() {
  const hasTab = activeTabHost != null;
  const hasScope = !!globalScope.regex;
  const hasFilter = networkFilterIsActive();
  if (!hasTab && !hasScope && !hasFilter) return networkRequests;
  return networkRequests.filter(r => {
    if (hasTab && !matchesActiveTab(r)) return false;
    if (hasScope && !inGlobalScope(r.url)) return false;
    if (hasFilter && !matchesNetworkFilter(r)) return false;
    return true;
  });
}

function setRowCheckedClass(reqId, checked) {
  const row = networkTable.querySelector(
    `tr[data-request-id="${CSS.escape(reqId)}"]`
  );
  if (!row) return;
  row.classList.toggle('row-checked', checked);
  const cb = row.querySelector('input.row-select');
  if (cb && cb.checked !== checked) cb.checked = checked;
}

function toggleSelection(reqId, checked) {
  if (checked) selectedExportIds.add(reqId);
  else selectedExportIds.delete(reqId);
  setRowCheckedClass(reqId, checked);
}

function handleRowCheckboxClick(reqId, checked, shiftKey) {
  // Shift+click extends the previously-checked anchor across the
  // visible range. The new state for the entire range is the state
  // of the just-clicked checkbox (matches Gmail/GitHub UX).
  if (shiftKey && _lastCheckedReqId && _lastCheckedReqId !== reqId) {
    const visible = getVisibleRequests();
    const i = visible.findIndex(r => r.requestId === _lastCheckedReqId);
    const j = visible.findIndex(r => r.requestId === reqId);
    if (i >= 0 && j >= 0) {
      const [lo, hi] = i < j ? [i, j] : [j, i];
      for (let k = lo; k <= hi; k++) {
        toggleSelection(visible[k].requestId, checked);
      }
    } else {
      toggleSelection(reqId, checked);
    }
  } else {
    toggleSelection(reqId, checked);
  }
  _lastCheckedReqId = reqId;
  updateSelectionUI();
}

// Sync the toolbar counter, master-checkbox state, and export-menu
// items with the current selection. Called after any selection change.
function updateSelectionUI() {
  const count = selectedExportIds.size;
  const wrap = document.getElementById('network-selection');
  const label = document.getElementById('network-selection-count');
  if (wrap && label) {
    wrap.classList.toggle('hidden', count === 0);
    label.textContent = `${count} selected`;
  }
  // Master checkbox: checked when every visible row is selected,
  // indeterminate when some are, unchecked when none.
  const master = document.getElementById('network-select-all');
  if (master) {
    const visible = getVisibleRequests();
    let visibleSelected = 0;
    for (const r of visible) {
      if (selectedExportIds.has(r.requestId)) visibleSelected++;
    }
    if (visible.length === 0 || visibleSelected === 0) {
      master.checked = false;
      master.indeterminate = false;
    } else if (visibleSelected === visible.length) {
      master.checked = true;
      master.indeterminate = false;
    } else {
      master.checked = false;
      master.indeterminate = true;
    }
  }
  // Export menu — "Selected requests" items are enabled only when at
  // least one row is checked; their per-item count reflects the
  // matching subset (current tab vs all). The Full requests items
  // always work, no count badge.
  const tabSelected = activeTabHost
    ? networkRequests.filter(r => _reqHost(r) === activeTabHost && selectedExportIds.has(r.requestId)).length
    : count;
  const tabCountEl = document.getElementById('export-tab-selected-count');
  const allCountEl = document.getElementById('export-all-selected-count');
  if (tabCountEl) tabCountEl.textContent = tabSelected ? `(${tabSelected})` : '';
  if (allCountEl) allCountEl.textContent = count ? `(${count})` : '';
  document.querySelectorAll('.export-menu-item[data-selected="true"]').forEach(btn => {
    const scope = btn.dataset.scope;
    btn.disabled = (scope === 'tab' ? tabSelected : count) === 0;
  });
}

function clearExportSelection() {
  if (selectedExportIds.size === 0) return;
  // Snapshot to avoid Set mutation during iteration when removing
  // class from each visible row.
  const ids = Array.from(selectedExportIds);
  selectedExportIds.clear();
  for (const id of ids) setRowCheckedClass(id, false);
  _lastCheckedReqId = null;
  updateSelectionUI();
}

function selectAllVisible() {
  const visible = getVisibleRequests();
  for (const r of visible) toggleSelection(r.requestId, true);
  updateSelectionUI();
}

function deselectAllVisible() {
  const visible = getVisibleRequests();
  for (const r of visible) toggleSelection(r.requestId, false);
  updateSelectionUI();
}

// Master checkbox: if every visible row is selected, deselect them all;
// otherwise select all visible. Indeterminate state defaults to "select all".
document.getElementById('network-select-all').addEventListener('click', (e) => {
  // Use the post-click state to decide direction. If it ended up
  // checked (or was indeterminate flipped to checked), select-all;
  // otherwise deselect.
  if (e.target.checked) selectAllVisible();
  else deselectAllVisible();
});

document.getElementById('network-selection-clear').addEventListener('click', clearExportSelection);

// Cmd/Ctrl+A while the Network tab is active selects all visible rows.
// Skip when the user is typing in a form field.
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'a') return;
  const networkSection = document.getElementById('network');
  if (!networkSection || !networkSection.classList.contains('active')) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  e.preventDefault();
  selectAllVisible();
});

// Move selection to a request, open the detail panel, and (optionally)
// scroll the row into view. Shared by click handlers and keyboard nav.
function selectNetworkRequest(reqId, opts) {
  const req = networkRequestMap.get(reqId);
  if (!req) return;
  networkTable.querySelectorAll('tr.selected').forEach(r => r.classList.remove('selected'));
  const row = networkTable.querySelector(`tr[data-request-id="${CSS.escape(reqId)}"]`);
  if (row) {
    row.classList.add('selected');
    if (opts && opts.scroll) row.scrollIntoView({ block: 'nearest' });
  }
  selectedRequestId = reqId;
  networkDetail.classList.remove('hidden');
  networkSplit.classList.add('has-detail');
  showDetail(req);
  if (!req.responseBodyLoaded) fetchResponseBody(req);
  if (opts && opts.activateTab) {
    const tabBtn = document.querySelector(`.detail-tab[data-detail="${opts.activateTab}"]`);
    if (tabBtn) tabBtn.click();
  }
  updateSendToBrowserButton();
}

// ↑/↓ keyboard navigation through the request list while the Network
// tab is active. Suppresses the browser's default scroll so the keys
// move the selection instead. Operates on the visible-row set so
// keys stay inside what the user can actually see — Tab / Scope /
// Type-Status filters all participate, and the "All hosts" toggle
// flips the navigable pool accordingly.
document.addEventListener('keydown', (e) => {
  const networkSection = document.getElementById('network');
  if (!networkSection || !networkSection.classList.contains('active')) return;
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  // Don't hijack the keys while the user is typing in a form field.
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  const visible = getVisibleRequests();
  if (visible.length === 0) return;
  e.preventDefault();
  const currentIdx = selectedRequestId
    ? visible.findIndex(r => r.requestId === selectedRequestId)
    : -1;
  let newIdx;
  if (currentIdx < 0) {
    newIdx = e.key === 'ArrowDown' ? 0 : visible.length - 1;
  } else if (e.key === 'ArrowUp') {
    newIdx = Math.max(0, currentIdx - 1);
  } else {
    newIdx = Math.min(visible.length - 1, currentIdx + 1);
  }
  if (newIdx === currentIdx) return;
  selectNetworkRequest(visible[newIdx].requestId, { scroll: true });
});

// ============================================================
// Network search — keyword match across request/response detail
//
// Scope (the toolbar URL filter) already covers the URL itself, so
// this search deliberately skips the URL field and looks at:
//   - request headers (key+value)
//   - query string params (key+value, parsed from URL.search)
//   - request body (POST data)
//   - response headers (key+value)
//   - response body (text only; base64 bodies skipped)
//   - Detection scanResults (evidence + location)
//
// A combined lower-cased index string is built per-request and cached
// on req._searchIndex so each keystroke does a single indexOf rather
// than walking every field. The index is rebuilt whenever the body
// arrives late or scanResults change.
// ============================================================

let searchTerm = '';
let searchMatchedIds = [];   // requestIds, in networkRequests order
let searchCursor = -1;       // index into searchMatchedIds
let _searchDebounceTimer = 0;
const SEARCH_DEBOUNCE_MS = 300;

function buildSearchIndex(req) {
  const parts = [];
  // Request headers
  if (req.requestHeaders) {
    for (const [k, v] of Object.entries(req.requestHeaders)) {
      parts.push(k); parts.push(String(v));
    }
  }
  // Response headers
  if (req.responseHeaders) {
    for (const [k, v] of Object.entries(req.responseHeaders)) {
      parts.push(k); parts.push(String(v));
    }
  }
  // Full URL — Scope handles host/path-based filtering, but the search
  // box also indexes the URL itself so a keyword in the path or query
  // is found regardless of which other field carries it.
  parts.push(req.url);
  // Query params (decoded) — searchParams returns URL-decoded values,
  // so "hello world" still matches "?q=hello%20world" even though the
  // raw URL only contains the encoded form.
  try {
    const u = new URL(req.url);
    for (const [k, v] of u.searchParams) {
      parts.push(k); parts.push(v);
    }
  } catch { /* malformed URL */ }
  // Request body
  if (req.requestPostData) {
    const body = req.requestPostData.length > AUTODECODE_BODY_LIMIT
      ? req.requestPostData.slice(0, AUTODECODE_BODY_LIMIT)
      : req.requestPostData;
    parts.push(body);
  }
  // Response body — text only, large bodies clipped to AUTODECODE_BODY_LIMIT
  if (req.responseBody && !req.responseBase64) {
    const body = req.responseBody.length > AUTODECODE_BODY_LIMIT
      ? req.responseBody.slice(0, AUTODECODE_BODY_LIMIT)
      : req.responseBody;
    parts.push(body);
  }
  // Detection findings — surfaced in the Detection tab
  if (req.scanResults) {
    for (const f of req.scanResults) {
      if (f.evidence) parts.push(String(f.evidence));
      if (f.location) parts.push(String(f.location));
    }
  }
  req._searchIndex = parts.join('\n').toLowerCase();
}

function reqMatchesSearch(req) {
  if (!searchTerm) return true;
  if (!req._searchIndex) return false;
  return req._searchIndex.indexOf(searchTerm) !== -1;
}

// Recompute the matched-ids list from scratch. Called after a search
// term change, after Scope changes (search ANDs with Scope), and after
// any data mutation that could flip a request in or out (clear,
// import, late body load).
function recomputeSearchMatches() {
  if (!searchTerm) {
    searchMatchedIds = [];
    searchCursor = -1;
    return;
  }
  const matched = [];
  const hasTab = activeTabHost != null;
  const hasFilter = networkFilterIsActive();
  for (const req of networkRequests) {
    if (hasTab && !matchesActiveTab(req)) continue;
    if (!inGlobalScope(req.url)) continue;
    if (hasFilter && !matchesNetworkFilter(req)) continue;
    if (req._searchIndex == null) buildSearchIndex(req);
    if (reqMatchesSearch(req)) matched.push(req.requestId);
  }
  searchMatchedIds = matched;
  // Preserve the cursor on the same request if it's still in the set;
  // otherwise reset to the first match.
  if (selectedRequestId && matched.includes(selectedRequestId)) {
    searchCursor = matched.indexOf(selectedRequestId);
  } else {
    searchCursor = matched.length > 0 ? 0 : -1;
  }
}

function applySearch(rawTerm) {
  const term = (rawTerm || '').toLowerCase().trim();
  searchTerm = term;
  recomputeSearchMatches();
  refreshAllRowDots();
  refreshSearchUI();
  // Auto-open the first match (only when entering a non-empty term).
  // Keep the existing selection if it already matched, otherwise jump.
  if (term && searchMatchedIds.length > 0) {
    const targetId = searchMatchedIds[searchCursor];
    if (targetId !== selectedRequestId) {
      selectNetworkRequest(targetId, { scroll: true });
      return; // selectNetworkRequest -> showDetail handles highlight
    }
  }
  // Re-render detail of the currently selected request so marks
  // (or their absence) reflect the new term.
  if (selectedRequestId) {
    const req = networkRequestMap.get(selectedRequestId);
    if (req) showDetail(req);
  }
}

function gotoSearchMatch(direction) {
  if (searchMatchedIds.length === 0) return;
  const len = searchMatchedIds.length;
  searchCursor = (searchCursor + direction + len) % len;
  selectNetworkRequest(searchMatchedIds[searchCursor], { scroll: true });
  refreshSearchUI();
}

function refreshSearchUI() {
  const countEl = document.getElementById('network-search-count');
  const prevBtn = document.getElementById('network-search-prev');
  const nextBtn = document.getElementById('network-search-next');
  const clearBtn = document.getElementById('network-search-clear');
  if (!searchTerm) {
    countEl.classList.add('hidden');
    countEl.classList.remove('no-matches');
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    clearBtn.classList.add('hidden');
    return;
  }
  clearBtn.classList.remove('hidden');
  countEl.classList.remove('hidden');
  if (searchMatchedIds.length === 0) {
    countEl.textContent = 'No matches';
    countEl.classList.add('no-matches');
    prevBtn.disabled = true;
    nextBtn.disabled = true;
  } else {
    countEl.textContent = `${searchCursor + 1} / ${searchMatchedIds.length}`;
    countEl.classList.remove('no-matches');
    prevBtn.disabled = false;
    nextBtn.disabled = false;
  }
}

// Toggle the .search-hit class on every visible row to mirror the
// matched-ids set. Cheap relative to a full re-render.
function refreshAllRowDots() {
  const matched = new Set(searchMatchedIds);
  networkTable.querySelectorAll('tr[data-request-id]').forEach(tr => {
    if (matched.has(tr.dataset.requestId)) {
      tr.classList.add('search-hit');
    } else {
      tr.classList.remove('search-hit');
    }
  });
}

// Wrap every occurrence of `term` inside text nodes under `rootEl`
// with <mark class="network-search-mark">. Skips nodes already inside
// a mark (idempotent on re-runs against the same root). Returns the
// number of matches injected.
function highlightMarksIn(rootEl, term) {
  if (!rootEl || !term) return 0;
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentNode;
      if (!p) return NodeFilter.FILTER_REJECT;
      const tag = p.nodeName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
      if (p.classList && p.classList.contains('network-search-mark')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets = [];
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeValue && n.nodeValue.toLowerCase().includes(term)) targets.push(n);
  }
  let count = 0;
  for (const node of targets) {
    const text = node.nodeValue;
    const lower = text.toLowerCase();
    let last = 0;
    let idx;
    const frag = document.createDocumentFragment();
    while ((idx = lower.indexOf(term, last)) !== -1) {
      if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
      const m = document.createElement('mark');
      m.className = 'network-search-mark';
      m.textContent = text.slice(idx, idx + term.length);
      frag.appendChild(m);
      last = idx + term.length;
      count++;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
  return count;
}

// Tabs eligible for body-level highlighting + tab badge. Initiator
// is excluded by design — its content is call-stack frames, not a
// good fit for keyword search.
const SEARCH_TARGET_TABS = ['message', 'detection'];

function applyDetailHighlights(req) {
  // Always clear stale marks/badges so a cleared term wipes the UI.
  for (const key of SEARCH_TARGET_TABS) {
    const btn = document.querySelector(`.detail-tab[data-detail="${key}"]`);
    if (btn) btn.classList.remove('has-search-match');
  }
  if (!searchTerm || !req) return;
  let firstMatchTab = null;
  for (const key of SEARCH_TARGET_TABS) {
    const pane = document.getElementById('detail-' + key);
    if (!pane) continue;
    const count = highlightMarksIn(pane, searchTerm);
    if (count > 0) {
      const btn = document.querySelector(`.detail-tab[data-detail="${key}"]`);
      if (btn) btn.classList.add('has-search-match');
      if (!firstMatchTab) firstMatchTab = key;
    }
  }
  // If the active tab has no match but another tab does, switch to
  // the first matching tab so the user sees results immediately.
  const activeTab = document.querySelector('.detail-tab.active');
  const activeKey = activeTab ? activeTab.dataset.detail : null;
  const activeHasMatch = activeKey
    && document.querySelector(`.detail-tab[data-detail="${activeKey}"].has-search-match`);
  const targetKey = activeHasMatch ? activeKey : firstMatchTab;
  if (targetKey) {
    if (targetKey !== activeKey) {
      document.querySelectorAll('.detail-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.detail-content').forEach(c => c.classList.remove('active'));
      document.querySelector(`.detail-tab[data-detail="${targetKey}"]`).classList.add('active');
      document.getElementById('detail-' + targetKey).classList.add('active');
    }
    // Scroll the first match in the target tab into view.
    const pane = document.getElementById('detail-' + targetKey);
    const firstMark = pane && pane.querySelector('mark.network-search-mark');
    if (firstMark) firstMark.scrollIntoView({ block: 'center' });
  }
}

// Wire up search input + buttons.
(function initNetworkSearch() {
  const input = document.getElementById('network-search');
  const clearBtn = document.getElementById('network-search-clear');
  const prevBtn = document.getElementById('network-search-prev');
  const nextBtn = document.getElementById('network-search-next');
  if (!input) return;
  input.addEventListener('input', () => {
    const value = input.value;
    if (_searchDebounceTimer) clearTimeout(_searchDebounceTimer);
    _searchDebounceTimer = setTimeout(() => {
      _searchDebounceTimer = 0;
      applySearch(value);
    }, SEARCH_DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // Flush any pending debounce so Enter acts on the current value.
      if (_searchDebounceTimer) {
        clearTimeout(_searchDebounceTimer);
        _searchDebounceTimer = 0;
        applySearch(input.value);
      }
      gotoSearchMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      input.value = '';
      applySearch('');
    }
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    applySearch('');
    input.focus();
  });
  prevBtn.addEventListener('click', () => gotoSearchMatch(-1));
  nextBtn.addEventListener('click', () => gotoSearchMatch(1));
})();

// ============================================================
// Network Detail Panel
// ============================================================

function showDetail(req) {
  renderMessageTab(req);
  renderInitiator(req);
  renderDetection(req);
  renderAuth(req);
  applyDetailHighlights(req);
}

// ============================================================
// Message tab — vertical Request / Response split rendering raw HTTP.
// This is the differentiator vs native DevTools: instead of separating
// header-name/value into a table, we show the on-the-wire message
// (request line + headers + blank line + body, response status line +
// headers + blank line + body). Replay edits happen in-place via a
// textarea overlay on the request pane.
// ============================================================

// Per-request UI state for the new tab. Keyed by selectedRequestId so
// switching between requests resets format toggles / replay edit mode
// to a clean default (we don't want a half-edited replay textarea
// surviving a row change).
let msgRequestFormat = 'raw';   // 'raw' | 'pretty'
let msgResponseFormat = 'raw';  // 'raw' | 'pretty'
let msgReplayEditing = false;
let msgPreviewMode = 'raw';     // 'raw' | 'preview'
let msgReplayLastResponse = null; // overrides original response display when set

function renderMessageTab(req) {
  // Reset per-request UI state on row change.
  msgRequestFormat = 'raw';
  msgResponseFormat = 'raw';
  msgReplayEditing = false;
  msgPreviewMode = 'raw';
  msgReplayLastResponse = null;
  // Reset toggles in the DOM so the active class lines up.
  document.querySelectorAll('.msg-format-toggle .msg-format-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.fmt === 'raw');
  });
  document.getElementById('msg-replay-bar').classList.add('hidden');
  document.getElementById('msg-replay-toggle').classList.remove('active');
  document.getElementById('msg-preview-toggle').classList.remove('active');

  renderRequestPane(req);
  renderResponsePane(req);
}

function renderRequestPane(req) {
  const meta = document.getElementById('msg-request-meta');
  // Method only — the full URL lives in the request line of the raw
  // HTTP body below, so duplicating it in the pane header just bloats
  // the strip and forces truncation. Title still carries the URL on
  // hover for quick reference.
  meta.textContent = req.method || '';
  meta.title = req.url || '';

  const bodyEl = document.getElementById('msg-request-body');
  if (msgReplayEditing) {
    // Editor stays in place — text already populated by enter handler.
    return;
  }
  const text = buildRawRequest(req, msgRequestFormat);
  bodyEl.innerHTML = `<pre class="msg-raw">${_renderRawHtml(text)}</pre>`;
}

function renderResponsePane(req) {
  const meta = document.getElementById('msg-response-meta');
  const resp = msgReplayLastResponse;
  if (resp) {
    // Active replay result overrides the captured response display.
    const sCls = _statusClass(resp.status);
    meta.innerHTML = `<span class="${sCls}">${resp.status} ${escapeHtml(resp.statusText || '')}</span> · ${resp.time} ms · ${formatBytes((resp.body || '').length)}` +
      ` <span style="color:#8a6d00">(replay)</span>`;
  } else {
    const sCls = _statusClass(req.status);
    const size = req.size && req.size !== '-' ? ` · ${req.size}` : '';
    const time = req.time && req.time !== '-' ? ` · ${req.time}` : '';
    meta.innerHTML = `<span class="${sCls}">${req.status || '-'}${req.statusText ? ' ' + escapeHtml(req.statusText) : ''}</span>${time}${size}`;
  }

  const bodyEl = document.getElementById('msg-response-body');
  if (msgPreviewMode === 'preview') {
    _renderResponsePreview(bodyEl, req, resp);
    return;
  }

  // Raw / pretty text path — handle imports / unloaded body / base64
  // identically so replay results and captures share the same code.
  const view = resp ? _viewFromReplay(resp) : _viewFromCapture(req);
  if (view.placeholder) {
    bodyEl.innerHTML = `<div class="msg-empty">${escapeHtml(view.placeholder)}</div>`;
    return;
  }
  // Pair the response status line's HTTP version with whatever the
  // request side detected — same connection, same wire protocol.
  // Replay results come back through fetch() (h1.1 to local proxy),
  // so they always render as 1.1 unless we have a captured-h2 origin.
  const text = buildRawResponse(view, msgResponseFormat, resp ? '1.1' : _detectHttpVersion(req));
  let html = `<pre class="msg-raw">${_renderRawHtml(text)}</pre>`;
  // Diff badge for replay results. Always rendered when we have a
  // replay response — _renderReplayDiff handles the case where the
  // original body isn't available so status / availability info still
  // surfaces instead of disappearing silently.
  if (resp && req) {
    html += _renderReplayDiff(req, resp);
  }
  bodyEl.innerHTML = html;
}

function _statusClass(s) {
  if (!s) return '';
  if (s >= 200 && s < 300) return 's-2xx';
  if (s >= 300 && s < 400) return 's-3xx';
  if (s >= 400 && s < 500) return 's-4xx';
  if (s >= 500) return 's-5xx';
  return '';
}

// Wraps a captured request into the shape buildRawResponse expects.
function _viewFromCapture(req) {
  if (req._imported && !req.responseBodyLoaded) {
    return { placeholder: 'Not included in the imported file' };
  }
  if (!req.responseBodyLoaded) {
    return { placeholder: 'Loading response body...' };
  }
  if (req.responseBase64) {
    return {
      status: req.status, statusText: req.statusText, headers: req.responseHeaders || {},
      body: `[Base64 encoded data — ${formatBytes((req.responseBody || '').length)} encoded]`,
      _bin: true,
    };
  }
  return {
    status: req.status, statusText: req.statusText,
    headers: req.responseHeaders || {},
    body: req.responseBody || '',
  };
}

function _viewFromReplay(resp) {
  return {
    status: resp.status, statusText: resp.statusText,
    headers: resp.headers || {}, body: resp.body || '',
  };
}

// Detect whether the captured request was carried over HTTP/2 by
// looking for h2 pseudo-headers (`:authority`, `:method`, `:path`,
// `:scheme`). They only exist on h2 connections, so their presence is
// authoritative. Returns the version string we want on the rendered
// request/status line.
function _detectHttpVersion(req) {
  const headers = (req && req.requestHeaders) || {};
  for (const k of Object.keys(headers)) {
    if (k.startsWith(':')) return '2';
  }
  return '1.1';
}

// Build the raw HTTP request string. Path/query come from the URL so
// the request line matches what went on the wire. Host header is
// derived from the URL when not in the captured headers (browser
// always sends it). Body comes verbatim from requestPostData.
function buildRawRequest(req, format) {
  const method = req.method || 'GET';
  let path = '/';
  let host = '';
  try {
    const u = new URL(req.url);
    path = (u.pathname || '/') + (u.search || '');
    host = u.host;
  } catch { /* fall back */ }

  const headers = req.requestHeaders || {};
  const httpVersion = _detectHttpVersion(req);
  const lines = [`${method} ${path} HTTP/${httpVersion}`];
  // Synthesize Host if absent — readers expect it on a raw HTTP line.
  // For h2 the equivalent is :authority, so don't double-render it.
  if (host && !_findHeaderCI(headers, 'host') && httpVersion !== '2') {
    lines.push(`Host: ${host}`);
  }
  for (const [k, v] of Object.entries(headers)) {
    // h2 pseudo-headers are already encoded in the request line — drop
    // them from the rendered header list to avoid the redundant /
    // misleading ":method: GET" alongside "GET / HTTP/2".
    if (k.startsWith(':')) continue;
    lines.push(`${k}: ${v}`);
  }
  const body = req.requestPostData || '';
  return lines.join('\n') + '\n\n' + (format === 'pretty' ? _prettyBody(body, headers) : body);
}

// Build the raw HTTP response string from a view object (works for
// both captures and replay results since both share {status, headers,
// body}). httpVersion is supplied by the caller — paired with the
// request side so request/response status lines stay consistent.
function buildRawResponse(view, format, httpVersion) {
  const status = view.status || 0;
  const statusText = view.statusText || '';
  const headers = view.headers || {};
  const ver = httpVersion || '1.1';
  const lines = [`HTTP/${ver} ${status}${statusText ? ' ' + statusText : ''}`];
  for (const [k, v] of Object.entries(headers)) {
    if (k.startsWith(':')) continue;
    lines.push(`${k}: ${v}`);
  }
  const body = view.body || '';
  if (view._bin) return lines.join('\n') + '\n\n' + body; // binary placeholder string
  return lines.join('\n') + '\n\n' + (format === 'pretty' ? _prettyBody(body, headers) : body);
}

// Tokenize a built raw HTTP message string into HTML with the request /
// status line in blue and header names in red-bold. The first line
// (request line for requests, status line for responses) is colored
// distinctly; subsequent lines until the first blank line are
// "Header-Name: value" pairs. Everything after the blank line is body
// content rendered as-is.
function _renderRawHtml(text) {
  if (!text) return '';
  const blankIdx = text.indexOf('\n\n');
  const headerPart = blankIdx >= 0 ? text.slice(0, blankIdx) : text;
  const body = blankIdx >= 0 ? text.slice(blankIdx + 2) : '';
  const lines = headerPart.split('\n');
  const out = [];
  if (lines.length > 0) {
    out.push(`<span class="msg-line-status">${escapeHtml(lines[0])}</span>`);
  }
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const colon = line.indexOf(':');
    if (colon < 0) {
      out.push(escapeHtml(line));
    } else {
      const name = line.slice(0, colon);
      const rest = line.slice(colon); // includes ':' + value
      out.push(`<span class="msg-header-name">${escapeHtml(name)}</span>${escapeHtml(rest)}`);
    }
  }
  // Blank separator line between headers and body, then body verbatim.
  return out.join('\n') + '\n\n' + (body ? escapeHtml(body) : '');
}

function _findHeaderCI(headers, name) {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return null;
}

// Pretty-print the body when the Content-Type makes the format clear.
// JSON gets indented to 2 spaces. Anything else stays as-is — partial
// XML / HTML pretty-printing without a parser tends to mangle, and
// the user can always switch back to Raw.
function _prettyBody(body, headers) {
  if (!body || typeof body !== 'string') return body;
  const ct = (_findHeaderCI(headers, 'content-type') || '').toLowerCase();
  if (ct.includes('json') || (body.trimStart().startsWith('{') || body.trimStart().startsWith('['))) {
    try { return JSON.stringify(JSON.parse(body), null, 2); }
    catch { /* not valid JSON — fall through */ }
  }
  return body;
}

// Preview button on the response pane. Toggles between raw text and
// the most useful rendered form for the response's mime type.
function _renderResponsePreview(bodyEl, req, replayResp) {
  const view = replayResp ? _viewFromReplay(replayResp) : _viewFromCapture(req);
  if (view.placeholder) {
    bodyEl.innerHTML = `<div class="msg-empty">${escapeHtml(view.placeholder)}</div>`;
    return;
  }
  const mime = (replayResp ? (_findHeaderCI(view.headers, 'content-type') || '') : (req.mimeType || ''))
    .toLowerCase();
  const body = view.body || '';

  if (mime.includes('html') || mime.includes('xhtml')) {
    bodyEl.innerHTML = `<iframe class="msg-preview-iframe" sandbox srcdoc="${escapeAttr(body)}"></iframe>`;
    return;
  }
  if (mime.startsWith('image/')) {
    const isBase64 = !replayResp && req.responseBase64;
    const src = isBase64 ? `data:${mime};base64,${body}` : `data:${mime};base64,${btoa(body)}`;
    bodyEl.innerHTML = `<div class="msg-preview-image"><img src="${escapeAttr(src)}" alt=""></div>`;
    return;
  }
  // JSON tree
  if (mime.includes('json') || body.trim().startsWith('{') || body.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(body);
      bodyEl.innerHTML = `<div class="msg-preview-tree">${renderJsonTree(parsed)}</div>`;
      return;
    } catch { /* fall through */ }
  }
  // No useful preview — show raw + a notice.
  showToast('No preview available for this content type');
  msgPreviewMode = 'raw';
  document.getElementById('msg-preview-toggle').classList.remove('active');
  renderResponsePane(req);
}

// Format toggle (Raw / Pretty) — delegated. Only toggles the side
// the click landed in; the other side keeps its current mode.
document.querySelectorAll('.msg-format-toggle').forEach(group => {
  const side = group.dataset.pane; // 'request' | 'response'
  group.querySelectorAll('.msg-format-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      group.querySelectorAll('.msg-format-btn').forEach(b => {
        b.classList.toggle('active', b === btn);
      });
      const fmt = btn.dataset.fmt;
      if (side === 'request') {
        msgRequestFormat = fmt;
        // No re-render in replay edit mode — the textarea content is
        // user-owned and shouldn't be reset by a format toggle.
        if (!msgReplayEditing) {
          const req = networkRequestMap.get(selectedRequestId);
          if (req) renderRequestPane(req);
        }
      } else {
        msgResponseFormat = fmt;
        const req = networkRequestMap.get(selectedRequestId);
        if (req) renderResponsePane(req);
      }
    });
  });
});

// Replay button — toggles the request pane between raw view and
// editable textarea. Pressing once enters edit mode and seeds the
// textarea with the current raw request; pressing again cancels.
document.getElementById('msg-replay-toggle').addEventListener('click', () => {
  if (msgReplayEditing) {
    _exitReplayEdit();
    return;
  }
  const req = networkRequestMap.get(selectedRequestId);
  if (!req) return;
  _enterReplayEdit(req);
});

// Snapshot of the captured request's method/URL/headers/body taken when
// replay edit mode opens — drives the Original/Modified state badge
// without relying on string equality of free-form raw text.
let msgReplayOriginalSnapshot = null;

function _enterReplayEdit(req) {
  msgReplayEditing = true;
  msgReplayOriginalSnapshot = _captureReplaySnapshot(req);
  _renderReplayEditor(msgReplayOriginalSnapshot);
  document.getElementById('msg-replay-bar').classList.remove('hidden');
  document.getElementById('msg-replay-toggle').classList.add('active');
  _refreshReplayState();
  updateSendToBrowserButton();
}

// Render (or re-render) the editor's DOM from a snapshot. Called on
// initial entry and when the user clicks the Original/Modified button
// to restore the seed. Event delegation in setupReplayEditorListeners
// covers tab clicks / + Add Header / KV row removes / input tracking,
// so re-rendering doesn't accumulate listeners.
function _renderReplayEditor(snap) {
  const bodyEl = document.getElementById('msg-request-body');
  bodyEl.innerHTML = `
    <div class="replay-editor">
      <div class="replay-editor-topbar">
        <select id="msg-replay-method"></select>
        <input type="text" id="msg-replay-url" class="replay-editor-url" spellcheck="false">
        <input type="text" id="msg-replay-version" class="replay-editor-version" spellcheck="false"
          value="HTTP/1.1"
          title="HTTP version on the request line. Editable for security testing — note that fetch() actually sends as HTTP/1.1 or whatever the server negotiates, so this is cosmetic on the wire.">
      </div>
      <div class="replay-editor-tabs">
        <button class="replay-editor-tab active" data-rtab="headers">Headers</button>
        <button class="replay-editor-tab" data-rtab="body">Body</button>
      </div>
      <div class="replay-editor-pane active" id="msg-replay-pane-headers">
        <div class="replay-editor-toolbar">
          <button id="msg-replay-add-header" class="btn btn-xs">+ Add Header</button>
        </div>
        <div id="msg-replay-headers-list" class="replay-kv-list"></div>
      </div>
      <div class="replay-editor-pane" id="msg-replay-pane-body">
        <div class="replay-body-toolbar">
          <div class="replay-body-format-toggle">
            <button class="replay-body-fmt-btn" data-bfmt="form">Form</button>
            <button class="replay-body-fmt-btn" data-bfmt="raw">Raw</button>
          </div>
          <button id="msg-replay-add-field" class="btn btn-xs">+ Add Field</button>
        </div>
        <div id="msg-replay-body-form" class="replay-kv-list replay-body-form"></div>
        <textarea id="msg-replay-body-input" class="replay-body-editor" spellcheck="false" placeholder="Request body..."></textarea>
      </div>
    </div>
  `;
  const methodSel = document.getElementById('msg-replay-method');
  methodSel.innerHTML = ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']
    .map(m => `<option ${m === snap.method ? 'selected' : ''}>${m}</option>`).join('');
  document.getElementById('msg-replay-url').value = snap.url;
  document.getElementById('msg-replay-version').value = snap.version || 'HTTP/1.1';
  const list = document.getElementById('msg-replay-headers-list');
  for (const { name, value } of snap.headers) {
    _addReplayKvRow(list, name, value, true);
  }
  document.getElementById('msg-replay-body-input').value = snap.body;
  // Decide initial body view based on the seeded body shape. Form
  // view is only useful for x-www-form-urlencoded payloads — JSON or
  // multipart bodies should stay raw to avoid surprising the user.
  const formCapable = _replayBodyLooksFormEncoded(snap);
  _setReplayBodyView(formCapable ? 'form' : 'raw', { populate: true, formCapable });
}

// True when the body looks like form-urlencoded — either by Content-
// Type header or a heuristic on the body string. Used to decide whether
// to default the Body pane to Form view, and whether the Form/Raw
// toggle is offered at all.
function _replayBodyLooksFormEncoded(snap) {
  const ct = (snap.headers || [])
    .find(h => h.name.toLowerCase() === 'content-type');
  if (ct && /application\/x-www-form-urlencoded/i.test(ct.value)) return true;
  // Heuristic for missing Content-Type: body has at least one `=`,
  // no JSON markers, no leading angle bracket, no obvious raw text.
  const body = (snap.body || '').trim();
  if (!body) return false;
  if (body.startsWith('{') || body.startsWith('[')) return false;
  if (body.startsWith('<')) return false;
  if (!body.includes('=')) return false;
  // Reject if it looks like prose (contains lots of spaces / words).
  if (/\s{2,}/.test(body)) return false;
  return true;
}

// Switch the body pane between Form and Raw views. Keeps the underlying
// body content in sync — Form ↔ Raw conversions happen at toggle time
// so edits in one view are visible in the other on switch.
function _setReplayBodyView(view, opts) {
  opts = opts || {};
  const formContainer = document.getElementById('msg-replay-body-form');
  const ta = document.getElementById('msg-replay-body-input');
  const addBtn = document.getElementById('msg-replay-add-field');
  const toggle = document.querySelector('.replay-body-format-toggle');
  if (!formContainer || !ta || !toggle) return;
  // Hide the Form button entirely when the body isn't form-shaped — no
  // point offering a view that can't represent it.
  if (opts.formCapable === false) {
    toggle.classList.add('hidden');
  }
  if (view === 'form' && opts.formCapable === false) view = 'raw';

  if (opts.populate && view === 'form') {
    // Initial population from the textarea value
    formContainer.innerHTML = '';
    const fields = _parseFormUrlencodedFields(ta.value || '');
    if (fields.length === 0) {
      _addReplayBodyField(formContainer, '', '', true);
    } else {
      for (const f of fields) _addReplayBodyField(formContainer, f.name, f.value, true);
    }
  } else if (!opts.populate) {
    // Toggle: convert from the previously-active view to the new one.
    if (view === 'raw') {
      // Form → Raw: encode current fields into textarea.
      ta.value = _encodeReplayBodyForm(formContainer);
    } else {
      // Raw → Form: parse textarea into KV rows.
      formContainer.innerHTML = '';
      const fields = _parseFormUrlencodedFields(ta.value || '');
      if (fields.length === 0) {
        _addReplayBodyField(formContainer, '', '', true);
      } else {
        for (const f of fields) _addReplayBodyField(formContainer, f.name, f.value, true);
      }
    }
  }

  // Apply visibility
  if (view === 'form') {
    formContainer.classList.remove('hidden');
    if (addBtn) addBtn.classList.remove('hidden');
    ta.classList.add('hidden');
  } else {
    formContainer.classList.add('hidden');
    if (addBtn) addBtn.classList.add('hidden');
    ta.classList.remove('hidden');
  }
  toggle.querySelectorAll('.replay-body-fmt-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.bfmt === view);
  });
  // Track active view on the editor element so reads (Send) know which
  // pane carries the source of truth.
  const editor = document.querySelector('.replay-editor');
  if (editor) editor.dataset.bodyView = view;
}

function _addReplayBodyField(container, name, value, enabled) {
  const row = document.createElement('div');
  row.className = 'replay-kv-row replay-body-field' + (enabled ? '' : ' disabled');
  row.innerHTML = `
    <input type="checkbox" class="kv-toggle"${enabled ? ' checked' : ''}>
    <input type="text" class="kv-name" value="${escapeAttr(name)}" placeholder="Name">
    <input type="text" class="kv-value" value="${escapeAttr(value)}" placeholder="Value">
    <button class="kv-remove" title="Remove">&times;</button>
  `;
  container.appendChild(row);
}

// Encode the form-view rows back into application/x-www-form-urlencoded
// for the Send payload (and for the Raw-toggle round-trip). Uses `+`
// for spaces — application/x-www-form-urlencoded convention; encode-
// URIComponent emits %20 which would round-trip differently from
// captured request bodies.
function _encodeReplayBodyForm(container) {
  const parts = [];
  container.querySelectorAll('.replay-kv-row').forEach(row => {
    const enabled = row.querySelector('.kv-toggle').checked;
    if (!enabled) return;
    const name = row.querySelector('.kv-name').value;
    const value = row.querySelector('.kv-value').value;
    if (!name) return;
    parts.push(_formUrlEncode(name) + '=' + _formUrlEncode(value));
  });
  return parts.join('&');
}

function _formUrlEncode(s) {
  return encodeURIComponent(String(s)).replace(/%20/g, '+');
}

// Semantic equality for form-encoded bodies — covers the case where
// the user's untouched form fields re-encode with a slightly different
// byte form (e.g. + vs %20, missing trailing = on empty fields). If
// either body fails to parse cleanly we just say "not equal" and let
// the string compare drive Modified state.
function _replayBodiesFormEqual(a, b) {
  if (a == null || b == null) return false;
  const fa = _parseFormUrlencodedFields(a);
  const fb = _parseFormUrlencodedFields(b);
  if (fa.length === 0 && fb.length === 0) return false;
  if (fa.length !== fb.length) return false;
  for (let i = 0; i < fa.length; i++) {
    if (fa[i].name !== fb[i].name) return false;
    if (fa[i].value !== fb[i].value) return false;
  }
  return true;
}

// Attached once at script init — handles all replay editor interactions
// via delegation so re-rendering the editor (for Original restore) does
// not require re-binding listeners or risk accumulation.
function _setupReplayEditorListeners() {
  const bodyEl = document.getElementById('msg-request-body');
  if (!bodyEl) return;
  bodyEl.addEventListener('click', (e) => {
    if (!msgReplayEditing) return;
    // Tab switching
    const tab = e.target.closest('.replay-editor-tab');
    if (tab) {
      bodyEl.querySelectorAll('.replay-editor-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      bodyEl.querySelectorAll('.replay-editor-pane').forEach(p => p.classList.remove('active'));
      const pane = document.getElementById('msg-replay-pane-' + tab.dataset.rtab);
      if (pane) pane.classList.add('active');
      return;
    }
    // Body Form/Raw format toggle
    const fmtBtn = e.target.closest('.replay-body-fmt-btn');
    if (fmtBtn) {
      _setReplayBodyView(fmtBtn.dataset.bfmt);
      _refreshReplayState();
      return;
    }
    // + Add Header
    if (e.target.id === 'msg-replay-add-header') {
      const list = document.getElementById('msg-replay-headers-list');
      _addReplayKvRow(list, '', '', true);
      _refreshReplayState();
      return;
    }
    // + Add Field (body form view)
    if (e.target.id === 'msg-replay-add-field') {
      const list = document.getElementById('msg-replay-body-form');
      _addReplayBodyField(list, '', '', true);
      _refreshReplayState();
      return;
    }
    // KV remove
    const removeBtn = e.target.closest('.kv-remove');
    if (removeBtn) {
      const row = removeBtn.closest('.replay-kv-row');
      if (row) { row.remove(); _refreshReplayState(); }
      return;
    }
  });
  // Edit-tracking — any input/change inside the editor recomputes
  // Modified state. KV checkbox toggle bubbles change events here too.
  // Also re-evaluates the forbidden-header lock when the user retypes
  // a row's name (e.g. they add a fresh row and type "Cookie" → row
  // value should lock).
  bodyEl.addEventListener('input', (e) => {
    if (!msgReplayEditing) return;
    if (e.target.classList && e.target.classList.contains('kv-name')) {
      const row = e.target.closest('.replay-kv-row');
      if (row) _applyForbiddenLock(row);
    }
    _refreshReplayState();
  });
  bodyEl.addEventListener('change', (e) => {
    if (!msgReplayEditing) return;
    const toggle = e.target.closest('.kv-toggle');
    if (toggle) {
      const row = toggle.closest('.replay-kv-row');
      if (row) row.classList.toggle('disabled', !toggle.checked);
    }
    _refreshReplayState();
  });
}
_setupReplayEditorListeners();

function _exitReplayEdit() {
  msgReplayEditing = false;
  msgReplayOriginalSnapshot = null;
  document.getElementById('msg-replay-bar').classList.add('hidden');
  document.getElementById('msg-replay-toggle').classList.remove('active');
  const req = networkRequestMap.get(selectedRequestId);
  if (req) renderRequestPane(req);
  updateSendToBrowserButton();
}

// Capture the request's editable state in the same shape the editor
// reads/writes, so Modified detection is a structural compare instead
// of a stringy diff.
function _captureReplaySnapshot(req) {
  const headers = [];
  const captured = req.requestHeaders || {};
  for (const [k, v] of Object.entries(captured)) {
    if (k.startsWith(':')) continue;
    headers.push({ name: k, value: Array.isArray(v) ? v.join(', ') : String(v) });
  }
  return {
    method: req.method || 'GET',
    url: req.url || '',
    // The replay editor is HTTP/1.1-only on the wire (fetch's behavior),
    // but the input is editable for security-testing scenarios where
    // the user wants to record an intended-but-unsendable mutation.
    version: 'HTTP/1.1',
    headers,
    body: req.requestPostData || '',
  };
}

function _readReplayEditor() {
  const list = document.getElementById('msg-replay-headers-list');
  if (!list) return null;
  const headers = [];
  list.querySelectorAll('.replay-kv-row').forEach(row => {
    const enabled = row.querySelector('.kv-toggle').checked;
    if (!enabled) return;
    const name = row.querySelector('.kv-name').value.trim();
    const value = row.querySelector('.kv-value').value;
    if (name) headers.push({ name, value });
  });
  // Body is read from whichever view is currently active. Form view
  // re-encodes its rows on every read so the user always sees the
  // same payload regardless of which surface they edited in.
  const editor = document.querySelector('.replay-editor');
  const view = (editor && editor.dataset.bodyView) || 'raw';
  let body;
  if (view === 'form') {
    body = _encodeReplayBodyForm(document.getElementById('msg-replay-body-form'));
  } else {
    body = document.getElementById('msg-replay-body-input').value;
  }
  return {
    method: document.getElementById('msg-replay-method').value,
    url: document.getElementById('msg-replay-url').value,
    version: document.getElementById('msg-replay-version').value,
    headers,
    body,
  };
}

// Headers fetch() silently drops in page-context — browser fills in
// its own value regardless of what's typed. Listed lowercase for the
// per-row check; we also recognize prefix families (Sec-, Proxy-,
// Access-Control-) below.
const _FORBIDDEN_REPLAY_HEADERS = new Set([
  'accept-charset', 'accept-encoding',
  'connection', 'content-length',
  'cookie', 'cookie2',
  'date', 'dnt',
  'expect', 'host',
  'keep-alive', 'origin',
  'referer', 'te', 'trailer',
  'transfer-encoding', 'upgrade',
  'user-agent', 'via',
  'permissions-policy',
]);

function _isForbiddenReplayHeader(name) {
  if (!name) return false;
  const lower = String(name).trim().toLowerCase();
  if (!lower) return false;
  if (_FORBIDDEN_REPLAY_HEADERS.has(lower)) return true;
  if (lower.startsWith('sec-')) return true;
  if (lower.startsWith('proxy-')) return true;
  if (lower.startsWith('access-control-')) return true;
  return false;
}

// Apply / clear the forbidden lock styling on a KV row based on its
// current name. Called both at row build time and from the input
// delegation handler when the user retypes the name.
function _applyForbiddenLock(row) {
  const nameEl = row.querySelector('.kv-name');
  const valueEl = row.querySelector('.kv-value');
  const toggle = row.querySelector('.kv-toggle');
  if (!nameEl || !valueEl) return;
  const forbidden = _isForbiddenReplayHeader(nameEl.value);
  row.classList.toggle('kv-forbidden', forbidden);
  valueEl.readOnly = forbidden;
  if (toggle) toggle.disabled = forbidden;
  const tip = forbidden
    ? 'Browser-managed header — fetch() silently drops edits to this name and sends the browser default. Use Intercept Forward Modified for wire-level tampering.'
    : '';
  valueEl.title = tip;
  nameEl.title = tip;
}

// KV rows are pure DOM — toggle/remove/forbidden-lock are handled by
// event delegation in _setupReplayEditorListeners.
function _addReplayKvRow(list, name, value, enabled) {
  const row = document.createElement('div');
  row.className = 'replay-kv-row' + (enabled ? '' : ' disabled');
  row.innerHTML = `
    <input type="checkbox" class="kv-toggle"${enabled ? ' checked' : ''}>
    <input type="text" class="kv-name" value="${escapeAttr(name)}" placeholder="Name">
    <input type="text" class="kv-value" value="${escapeAttr(value)}" placeholder="Value">
    <button class="kv-remove" title="Remove">&times;</button>
  `;
  list.appendChild(row);
  _applyForbiddenLock(row);
}

function _refreshReplayState() {
  const stateBtn = document.getElementById('msg-replay-state');
  if (!stateBtn || !msgReplayOriginalSnapshot) return;
  const cur = _readReplayEditor();
  if (!cur) return;
  const isModified = !_replaySnapshotEqual(cur, msgReplayOriginalSnapshot);
  stateBtn.textContent = isModified ? 'Modified' : 'Original';
  stateBtn.classList.toggle('modified', isModified);
}

function _replaySnapshotEqual(a, b) {
  if (a.method !== b.method) return false;
  if (a.url !== b.url) return false;
  if (a.version !== b.version) return false;
  if (a.headers.length !== b.headers.length) return false;
  for (let i = 0; i < a.headers.length; i++) {
    if (a.headers[i].name !== b.headers[i].name) return false;
    if (a.headers[i].value !== b.headers[i].value) return false;
  }
  // Body: byte-equal first, then semantic form-encoded compare so
  // round-trip-through-the-Form-view doesn't false-positive Modified.
  if (a.body === b.body) return true;
  if (_replayBodiesFormEqual(a.body, b.body)) return true;
  return false;
}

// Original/Modified button — restores all editor fields to the snapshot.
document.getElementById('msg-replay-state').addEventListener('click', () => {
  if (!msgReplayOriginalSnapshot) return;
  _renderReplayEditor(msgReplayOriginalSnapshot);
  _refreshReplayState();
});

// Send button — read the editor state, build the fetch payload, fire
// it via inspectedWindow.eval (page context, so cookies attach
// naturally), poll for the result, then update the response pane.
document.getElementById('msg-replay-send').addEventListener('click', () => {
  const cur = _readReplayEditor();
  if (!cur) return;
  const req = networkRequestMap.get(selectedRequestId);
  if (!req) return;
  // Resolve the URL against the captured origin so users can edit just
  // the path/query if they want.
  let resolvedUrl;
  try { resolvedUrl = new URL(cur.url, req.url).href; } catch { resolvedUrl = cur.url; }
  // Full set the user typed — fed to the row override so the captured
  // entry shows exactly what was edited, even for headers fetch will
  // silently drop on the wire.
  const displayHeaders = {};
  for (const { name, value } of cur.headers) displayHeaders[name] = value;
  // Wire-allowed subset — what fetch() will actually attempt to send.
  const fetchHeaders = {};
  for (const { name, value } of cur.headers) {
    // fetch() refuses these — the browser sets them itself.
    if (/^(host|content-length)$/i.test(name)) continue;
    fetchHeaders[name] = value;
  }
  _sendReplayFetch(req, {
    method: cur.method,
    url: resolvedUrl,
    headers: fetchHeaders,
    body: cur.body || null,
    displayHeaders,
    displayBody: cur.body || '',
  });
});

// Replay-fire queue — short-TTL list of recent (url, method) tuples
// plus the user's intended request shape, so the network capture
// pipeline can tag matching incoming requests as "_isReplay" AND
// override the row's headers / body display with what the user
// actually typed. Page-context fetch silently drops forbidden header
// modifications (Cookie / User-Agent / Origin / Sec-* / Referer /
// DNT etc.) and replaces them with browser defaults — so HAR alone
// reports the wire view, which doesn't match the user's intent. The
// stashed `displayHeaders` / `displayBody` give the row a faithful
// view of what was sent (or attempted) without contaminating the
// origin server with a tag header.
const _replayFireQueue = [];
const _REPLAY_FIRE_TTL_MS = 10000;

function _markReplayFired(url, method, display) {
  const now = Date.now();
  // Drop expired entries opportunistically — keeps the queue tiny.
  for (let i = _replayFireQueue.length - 1; i >= 0; i--) {
    if (now - _replayFireQueue[i].t > _REPLAY_FIRE_TTL_MS) {
      _replayFireQueue.splice(i, 1);
    }
  }
  _replayFireQueue.push({
    url, method, t: now,
    displayHeaders: (display && display.headers) || null,
    displayBody: (display && 'body' in display) ? display.body : null,
  });
}

// Called from processNetworkRequest. Returns the matched fire-queue
// entry (with displayHeaders/displayBody) and removes it, or null when
// there's no match. URL match is exact (we set it ourselves to the
// same string the page-side fetch was given).
function consumeReplayFireMatch(url, method) {
  const now = Date.now();
  for (let i = 0; i < _replayFireQueue.length; i++) {
    const e = _replayFireQueue[i];
    if (now - e.t > _REPLAY_FIRE_TTL_MS) continue;
    if (e.url === url && e.method === method) {
      _replayFireQueue.splice(i, 1);
      return e;
    }
  }
  return null;
}

// Fire the parsed replay request via the inspected page's context.
// Mirrors the polling pattern the old executeReplay used.
function _sendReplayFetch(originalReq, payload) {
  const sendBtn = document.getElementById('msg-replay-send');
  sendBtn.textContent = 'Sending...';
  sendBtn.disabled = true;
  // Tag this fire so the eventual onRequestFinished can mark the
  // captured row as a replay AND override its displayed headers/body
  // with what the user actually typed (page-context fetch drops a
  // bunch of header modifications silently).
  _markReplayFired(payload.url, payload.method, {
    headers: payload.displayHeaders || payload.headers,
    body: 'displayBody' in payload ? payload.displayBody : payload.body,
  });

  const callbackId = '__replay_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const expr = `(function() {
    window['${callbackId}'] = null;
    var t0 = performance.now();
    fetch(${JSON.stringify(payload.url)}, {
      method: ${JSON.stringify(payload.method)},
      headers: ${JSON.stringify(payload.headers)},
      body: ${payload.body != null ? JSON.stringify(payload.body) : 'null'},
      credentials: 'include',
      redirect: 'follow'
    }).then(function(resp) {
      var elapsed = Math.round(performance.now() - t0);
      var h = {};
      resp.headers.forEach(function(v, k) { h[k] = v; });
      return resp.text().then(function(text) {
        window['${callbackId}'] = JSON.stringify({
          ok: true, status: resp.status, statusText: resp.statusText,
          headers: h, body: text, time: elapsed
        });
      });
    }).catch(function(e) {
      var elapsed = Math.round(performance.now() - t0);
      window['${callbackId}'] = JSON.stringify({
        ok: false, error: e.message, time: elapsed
      });
    });
    return 'started';
  })()`;

  chrome.devtools.inspectedWindow.eval(expr, (_, err) => {
    if (err) {
      sendBtn.textContent = 'Send';
      sendBtn.disabled = false;
      showToast('Replay failed to start: ' + (err.value || JSON.stringify(err)));
      return;
    }
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      if (attempts > 300) {
        clearInterval(poll);
        sendBtn.textContent = 'Send';
        sendBtn.disabled = false;
        chrome.devtools.inspectedWindow.eval(`delete window['${callbackId}']`);
        showToast('Replay timed out (30s)');
        return;
      }
      chrome.devtools.inspectedWindow.eval(`window['${callbackId}']`, (raw) => {
        if (raw == null) return;
        clearInterval(poll);
        sendBtn.textContent = 'Send';
        sendBtn.disabled = false;
        chrome.devtools.inspectedWindow.eval(`delete window['${callbackId}']`);
        let parsed;
        try { parsed = JSON.parse(raw); } catch { showToast('Replay result parse failed'); return; }
        if (!parsed.ok) {
          // Page-context fetch failed — usually CORS for cross-origin
          // assets without ACAO headers. Fall back to a background-
          // service-worker fetch (host_permissions: <all_urls>, no
          // page-level CORS gate). Cookies still ride along via
          // credentials:'include' for SameSite=Lax / None hosts.
          _sendReplayFetchViaBackground(originalReq, payload, parsed.error);
          return;
        }
        msgReplayLastResponse = parsed;
        renderResponsePane(originalReq);
      });
    }, 100);
  });
}

// Background-fetch fallback used when the page-context fetch errors
// out (typically CORS). Doesn't run by default — only after the page
// path actually fails — so the page's session context is preferred
// when reachable.
function _sendReplayFetchViaBackground(originalReq, payload, pageError) {
  const sendBtn = document.getElementById('msg-replay-send');
  sendBtn.textContent = 'Sending (CORS fallback)...';
  sendBtn.disabled = true;
  chrome.runtime.sendMessage({
    type: 'replay_fetch',
    url: payload.url,
    method: payload.method,
    headers: payload.headers,
    body: payload.body,
  }, (resp) => {
    sendBtn.textContent = 'Send';
    sendBtn.disabled = false;
    if (chrome.runtime.lastError) {
      showToast(`Replay error: ${pageError || 'page fetch failed'} (background also failed: ${chrome.runtime.lastError.message})`);
      return;
    }
    if (!resp || !resp.ok) {
      showToast(`Replay error: ${pageError || 'page fetch failed'} (background also failed${resp && resp.error ? ': ' + resp.error : ''})`);
      return;
    }
    msgReplayLastResponse = {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
      body: resp.body,
      time: resp.time,
    };
    showToast('Replay via background (CORS bypass)');
    renderResponsePane(originalReq);
  });
}

// Preview button — toggles the response pane between raw text and
// rendered preview (HTML iframe / image / JSON tree).
document.getElementById('msg-preview-toggle').addEventListener('click', () => {
  msgPreviewMode = msgPreviewMode === 'raw' ? 'preview' : 'raw';
  document.getElementById('msg-preview-toggle').classList.toggle('active', msgPreviewMode === 'preview');
  const req = networkRequestMap.get(selectedRequestId);
  if (req) renderResponsePane(req);
});

// Diff result HTML for a replay response vs the captured original.
// Always renders both Status and Body sections so the user can see at
// a glance which dimensions changed and which didn't — silent missing
// sections were causing confusion (a status change being hidden because
// the body matched, JSON formatting differences showing nothing at all,
// non-JSON differences showing nothing, and so on).
function _renderReplayDiff(originalReq, replayResp) {
  const sections = [];

  // ---- Status section ----
  const oStatus = originalReq.status;
  const nStatus = replayResp.status;
  if (oStatus != null && nStatus != null) {
    if (oStatus !== nStatus) {
      sections.push(
        `<div class="diff-title">Status changed: ` +
        `<span class="${_statusClass(oStatus)}">${oStatus}</span> → ` +
        `<span class="${_statusClass(nStatus)}">${nStatus}</span></div>`
      );
    } else {
      sections.push(
        `<div class="diff-title diff-unchanged">Status unchanged ` +
        `(<span class="${_statusClass(oStatus)}">${oStatus}</span>)</div>`
      );
    }
  }

  // ---- Body section ----
  const bodyAvailable = originalReq.responseBodyLoaded && originalReq.responseBody != null;
  if (!bodyAvailable) {
    sections.push(
      `<div class="diff-title diff-unavailable">` +
      `Original response body not available — cannot diff body</div>`
    );
  } else {
    const oBody = originalReq.responseBody;
    const nBody = replayResp.body || '';
    if (oBody === nBody) {
      sections.push(`<div class="msg-diff-identical">Response body identical to original</div>`);
    } else {
      // Try JSON diff. If both parse and the structures match, the
      // text-level mismatch was just whitespace / key-order — surface
      // that explicitly instead of falling through to silence.
      let handled = false;
      try {
        const origObj = JSON.parse(oBody);
        const newObj = JSON.parse(nBody);
        const diffHtml = generateJsonDiff(origObj, newObj);
        if (diffHtml) {
          sections.push(`<div class="diff-title">Body changes:</div>${diffHtml}`);
        } else {
          sections.push(
            `<div class="msg-diff-identical">` +
            `Response body identical (JSON structure unchanged; text formatting differs)</div>`
          );
        }
        handled = true;
      } catch { /* not JSON — handled below */ }
      if (!handled) {
        // Non-JSON body that differs — show a size-delta line so the
        // user at least knows it changed and by how much.
        sections.push(
          `<div class="diff-title">Body differs ` +
          `(${oBody.length} → ${nBody.length} bytes)</div>`
        );
      }
    }
  }

  return `<div class="msg-diff-badge">${sections.join('')}</div>`;
}


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


// ============================================================
// Initiator — Call stack trace + sensitive pattern detection
// ============================================================

const SENSITIVE_PATTERNS = [
  { pattern: /otp|mfa|2fa|totp/i, label: 'OTP/MFA' },
  { pattern: /auth|login|signin|signout|logout|session/i, label: 'Authentication' },
  { pattern: /token|jwt|bearer/i, label: 'Token' },
  { pattern: /valid|verif|check/i, label: 'Validation' },
  { pattern: /admin|role|permission|privilege|access/i, label: 'Authorization' },
  { pattern: /encrypt|decrypt|hash|sign|cipher|crypto/i, label: 'Crypto' },
  { pattern: /password|passwd|secret|credential/i, label: 'Credential' },
  { pattern: /upload|file|download/i, label: 'File Operation' },
  { pattern: /redirect|navigate|location\.href/i, label: 'Navigation' },
  { pattern: /pay|price|amount|billing|checkout/i, label: 'Payment' },
];

// Severity tier each sensitive pattern carries when surfaced in the
// Initiator tab's findings list. Mirrors how the Detection tab grades
// its categories — auth/credential/business-logic gets HIGH, things
// the server commonly enforces (validation, navigation, crypto
// algorithm) settle at MEDIUM.
const SENSITIVE_PATTERN_SEVERITY = {
  'OTP/MFA': 'high',
  'Authentication': 'high',
  'Token': 'high',
  'Validation': 'medium',
  'Authorization': 'high',
  'Crypto': 'medium',
  'Credential': 'high',
  'File Operation': 'high',
  'Navigation': 'medium',
  'Payment': 'high',
};

// Hover-tooltip text for the Type indicator at the top of the
// Initiator tab. Keyed by initiator.type, plus a synthetic 'mapped'
// entry shown on the Mapped indicator when source-map decoding lands.
const INITIATOR_TYPE_DESCRIPTIONS = {
  script:
    `This request was triggered by JavaScript code.
Check the Call Stack to see which function
initiated this request.
If sensitive function labels (Authentication,
Token, etc.) are highlighted, click that frame
to review the source.`,
  parser:
    `This request was triggered by the HTML parser
reading static markup tags such as
<img src>, <script src>, or <link href>.
If user input is reflected into HTML,
this may be an SSRF or XSS review point.`,
  mapped:
    `Source map decoding succeeded for this request.
The bundled code has been traced back to
the original file name and line number.
Click a frame marked with ↑ to view
the original source inline.
If source maps are accessible in production,
consider reviewing for source map exposure.`,
};

// Hover-tooltip text for the SENSITIVE_PATTERNS labels — both the
// hint badges at the top of the Initiator tab and the per-frame
// sensitive-badge inside the call stack.
const SENSITIVE_PATTERN_DESCRIPTIONS = {
  'OTP/MFA':
    `An OTP or multi-factor authentication handler
is present in the call stack.
This is a key branching point in the auth flow.
Modify the OTP parameter in the Replay tab
and re-send to verify server-side validation.`,
  'Authentication':
    `A login, logout, or session handler
is present in the call stack.
This request is part of the authentication flow.
Modify the credentials in the Replay tab
and re-send to review access control.`,
  'Token':
    `A token issuance, validation, or refresh function
is present in the call stack.
Check the Response tab to see if a token
is exposed in the response body.
If a 🔑 token Detection badge is also present,
trace the full token exposure flow.`,
  'Validation':
    `An input validation function is present
in the call stack.
This is a client-side validation point.
Modify the parameter values in the Replay tab
and re-send to verify whether the server
performs its own validation independently.`,
  'Authorization':
    `A permission or access control function
is present in the call stack.
Access control logic may exist on the client side.
Modify privilege-related parameters
in the Replay tab and re-send to check
whether server-side enforcement is in place.`,
  'Crypto':
    `An encryption, hashing, or signing function
is present in the call stack.
Client-side cryptographic logic is involved.
Use DevTools breakpoints to inspect the
plaintext value before encryption,
or review the algorithm and key strength.`,
  'Credential':
    `A password or credential-handling function
is present in the call stack.
Check the Payload tab to see if credentials
are transmitted in plaintext.
Prioritize review if a 🔴 sensitive
Detection badge is also present.`,
  'File Operation':
    `A file upload or download function
is present in the call stack.
Modify file path parameters in the Replay tab
and re-send to check for Path Traversal
or arbitrary file access.`,
  'Navigation':
    `A redirect or page navigation function
is present in the call stack.
This is an SSRF or Open Redirect review point.
Modify URL parameters in the Replay tab
and re-send to check whether redirection
to an external domain is possible.`,
  'Payment':
    `A payment or amount-handling function
is present in the call stack.
This is a business logic vulnerability review point.
Modify price or quantity parameters
in the Replay tab and re-send to verify
whether the server enforces proper validation.`,
};

function detectSensitive(name) {
  if (!name) return null;
  for (const sp of SENSITIVE_PATTERNS) {
    if (sp.pattern.test(name)) return sp.label;
  }
  return null;
}

function shortenUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname;
    const segments = path.split('/');
    return segments[segments.length - 1] || path;
  } catch {
    return url;
  }
}

// Inline source viewer cache: url → source text
const sourceCache = {};

function fetchSource(url, callback) {
  if (sourceCache[url] !== undefined) {
    callback(sourceCache[url]);
    return;
  }
  // Inline data URIs — decode directly, no I/O needed.
  if (url.startsWith('data:')) {
    const text = decodeDataUri(url);
    sourceCache[url] = text;
    callback(text);
    return;
  }
  // DevTools resources first — covers webpack-internal://, eval'd virtual
  // scripts, and avoids re-fetching things the page already loaded
  // (works for cross-origin scripts too, where fetch() would CORS-fail).
  chrome.devtools.inspectedWindow.getResources((resources) => {
    const res = resources && resources.find(r => r.url === url);
    if (res) {
      res.getContent((content, encoding) => {
        if (content != null) {
          const text = encoding === 'base64' ? atob(content) : content;
          sourceCache[url] = text;
          callback(text);
          return;
        }
        fetchSourceViaPage(url, callback);
      });
      return;
    }
    fetchSourceViaPage(url, callback);
  });
}

// Fallback: ask the inspected page to fetch() the URL. Used when the
// DevTools resource cache doesn't have it (e.g. .map files the page
// itself didn't load).
function fetchSourceViaPage(url, callback) {
  const expr = `fetch(${JSON.stringify(url)}).then(r=>r.ok?r.text():null).then(t=>{window.__dtpp_src=t}).catch(()=>{window.__dtpp_src=null})`;
  chrome.devtools.inspectedWindow.eval(expr, () => {
    let done = false;
    const poll = setInterval(() => {
      if (done) return;
      chrome.devtools.inspectedWindow.eval('window.__dtpp_src', (result, err) => {
        if (done) return;
        if (err) { done = true; clearInterval(poll); callback(null); return; }
        if (result !== undefined) {
          done = true;
          clearInterval(poll);
          chrome.devtools.inspectedWindow.eval('delete window.__dtpp_src');
          sourceCache[url] = result;
          callback(result);
        }
      });
    }, 100);
    setTimeout(() => { if (!done) { done = true; clearInterval(poll); callback(null); } }, 5000);
  });
}

// ============================================================
// Source map decoder (Initiator integration)
// ============================================================
// Decodes v3 source maps lazily so a stack frame at bundle.js:1:12345
// can be displayed as Auth.tsx:42:5. Self-contained — no external
// library — and forgiving: a missing/broken map just leaves the
// frame showing the bundled location like before.

const VLQ_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Decode one VLQ value starting at pos. Returns [value, nextPos].
// VLQ chars are base64; bit 5 (0x20) marks continuation, bit 0 of the
// assembled value is the sign bit.
function decodeVlq(str, pos) {
  let result = 0;
  let shift = 0;
  let continuation = true;
  while (continuation) {
    if (pos >= str.length) throw new Error('Truncated VLQ');
    const ch = str[pos++];
    const digit = VLQ_BASE64.indexOf(ch);
    if (digit < 0) throw new Error('Invalid VLQ char: ' + ch);
    continuation = (digit & 32) !== 0;
    result |= (digit & 31) << shift;
    shift += 5;
  }
  const negative = (result & 1) === 1;
  result >>>= 1;
  return [negative ? -result : result, pos];
}

// Parse a v3 "mappings" string. Returns segments[generatedLine] = sorted
// list of { generatedColumn, sourceIndex, originalLine, originalColumn }.
// Source/line/column indices are delta-encoded across the whole map;
// generatedColumn resets per line.
function parseMappings(mappings) {
  const lines = mappings.split(';');
  const result = [];
  let sourceIndex = 0, originalLine = 0, originalColumn = 0;
  for (const lineStr of lines) {
    let generatedColumn = 0;
    const segments = [];
    let pos = 0;
    while (pos < lineStr.length) {
      // A segment ends at ',' or end of line
      const fields = [];
      while (pos < lineStr.length && lineStr[pos] !== ',') {
        const [v, newPos] = decodeVlq(lineStr, pos);
        fields.push(v);
        pos = newPos;
      }
      if (fields.length >= 1) generatedColumn += fields[0];
      // 4 or 5 fields = mapped to a source. 1 field = unmapped marker.
      if (fields.length >= 4) {
        sourceIndex += fields[1];
        originalLine += fields[2];
        originalColumn += fields[3];
        segments.push({ generatedColumn, sourceIndex, originalLine, originalColumn });
      }
      if (lineStr[pos] === ',') pos++;
    }
    result.push(segments);
  }
  return result;
}

// Binary search for the largest segment with generatedColumn <= column
// on the given generated line. Returns the segment or null.
function lookupMapping(segments, line, column) {
  if (line < 0 || line >= segments.length) return null;
  const lineSegs = segments[line];
  if (!lineSegs || lineSegs.length === 0) return null;
  let lo = 0, hi = lineSegs.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineSegs[mid].generatedColumn <= column) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found >= 0 ? lineSegs[found] : null;
}

// scriptUrl → parsed map { sources, sourcesContent, segments, mapUrl } or null.
const sourceMapCache = {};

// Decode a "data:[<mediatype>][;base64],<data>" URI into text. Returns
// null if it can't be parsed or decoded.
function decodeDataUri(uri) {
  const m = uri.match(/^data:([^,]*),([\s\S]*)$/);
  if (!m) return null;
  try {
    return /;base64/i.test(m[1]) ? atob(m[2]) : decodeURIComponent(m[2]);
  } catch {
    return null;
  }
}

// Parse a v3 source map JSON string into the cache-friendly shape we use
// elsewhere. Returns null on any structural problem (unsupported
// version, index map, malformed JSON).
function parseSourceMapText(text, mapUrl) {
  try {
    const map = JSON.parse(text);
    if (map.version !== 3) return null;
    if (map.sections) return null; // Index maps — out of MVP scope.
    return {
      sources: map.sources || [],
      sourcesContent: map.sourcesContent || [],
      segments: parseMappings(map.mappings || ''),
      mapUrl,
    };
  } catch {
    return null;
  }
}

// Fetch a script's source map (resolved from //# sourceMappingURL=) and
// parse it. Cached. Falls through with null on any failure — callers
// should treat that as "no mapping, use bundled location". Handles both
// external .map URLs and inline data: URIs (eval-source-map style).
function getSourceMap(scriptUrl, callback) {
  if (sourceMapCache[scriptUrl] !== undefined) {
    callback(sourceMapCache[scriptUrl]);
    return;
  }
  fetchSource(scriptUrl, (source) => {
    if (!source) { sourceMapCache[scriptUrl] = null; callback(null); return; }
    const tail = source.length > 4096 ? source.slice(-4096) : source;
    const m = tail.match(/\/\/[#@]\s*sourceMappingURL=([^\s'"]+)/);
    if (!m) { sourceMapCache[scriptUrl] = null; callback(null); return; }
    const rawMapUrl = m[1].trim();

    // Inline map — common in webpack's eval-source-map and similar dev modes.
    if (rawMapUrl.startsWith('data:')) {
      const text = decodeDataUri(rawMapUrl);
      const parsed = text ? parseSourceMapText(text, rawMapUrl) : null;
      sourceMapCache[scriptUrl] = parsed;
      callback(parsed);
      return;
    }

    let mapUrl;
    try { mapUrl = new URL(rawMapUrl, scriptUrl).href; }
    catch { sourceMapCache[scriptUrl] = null; callback(null); return; }
    fetchSource(mapUrl, (mapText) => {
      const parsed = mapText ? parseSourceMapText(mapText, mapUrl) : null;
      sourceMapCache[scriptUrl] = parsed;
      callback(parsed);
    });
  });
}

function renderSourceViewer(container, source, targetLine) {
  if (!source) {
    container.innerHTML = '<div class="detail-loading">Failed to fetch source.</div>';
    return;
  }
  const lines = source.split('\n');
  const contextBefore = 10;
  const contextAfter = 10;
  const start = Math.max(0, targetLine - contextBefore);
  const end = Math.min(lines.length, targetLine + contextAfter + 1);

  let html = '<div class="source-viewer">';
  if (start > 0) {
    html += `<div class="source-line source-ellipsis">... (${start} lines above)</div>`;
  }
  for (let i = start; i < end; i++) {
    const lineNum = i + 1; // 1-indexed display
    const isTarget = i === targetLine;
    const cls = isTarget ? 'source-line target-line' : 'source-line';
    html += `<div class="${cls}"><span class="source-linenum">${lineNum}</span><span class="source-code">${escapeHtml(lines[i])}</span></div>`;
  }
  if (end < lines.length) {
    html += `<div class="source-line source-ellipsis">... (${lines.length - end} lines below)</div>`;
  }
  html += '</div>';
  container.innerHTML = html;

  // Scroll target line into view
  const targetEl = container.querySelector('.target-line');
  if (targetEl) targetEl.scrollIntoView({ block: 'center' });
}

function renderInitiator(req) {
  const container = document.getElementById('detail-initiator-body');

  // Reset the tab indicator — async source-map enrichment will re-add
  // it if any frame in the new request maps successfully.
  const initiatorTabBtn = document.querySelector('.detail-tab[data-detail="initiator"]');
  if (initiatorTabBtn) {
    initiatorTabBtn.classList.remove('has-mapped');
    initiatorTabBtn.removeAttribute('title');
  }

  if (!req.initiator) {
    container.innerHTML = '<div class="detail-loading">Initiator data not available.</div>';
    return;
  }

  const init = req.initiator;
  let html = '';

  // Type group — Detection-style header with description card. After
  // sourcemap enrichment lands, the badge upgrades to "↑ Mapped" and
  // the count flips to "<N> frames mapped".
  const typeStr = init.type || 'unknown';
  const typeDesc = INITIATOR_TYPE_DESCRIPTIONS[typeStr] || '';
  const frames = init.stack?.callFrames || [];
  let typeCountText = '';
  if (typeStr === 'script') {
    typeCountText = `Call Stack ${frames.length} frame${frames.length === 1 ? '' : 's'}`;
  } else if (typeStr === 'parser') {
    typeCountText = init.url ? 'triggered by static markup' : '';
  }
  html += `<div class="detection-group" data-init-type-group>
    <div class="detection-group-header">
      <span class="scan-badge scan-badge-init-${escapeAttr(typeStr)}"${typeDesc ? ` title="${escapeAttr(typeDesc)}"` : ''}>${escapeHtml(typeStr)}</span>
      ${typeCountText ? `<span class="detection-group-count">${escapeHtml(typeCountText)}</span>` : ''}
      ${typeDesc ? '<span class="detection-group-toggle">▾</span>' : ''}
    </div>
    ${typeDesc ? `<div class="detection-category-desc hidden">${escapeHtml(typeDesc)}</div>` : ''}
  </div>`;

  // Call stack
  if (frames.length > 0) {
    // Group frames by their detected sensitive pattern (if any).
    const framesByPattern = {};
    frames.forEach(f => {
      const label = detectSensitive(f.functionName);
      if (!label) return;
      if (!framesByPattern[label]) framesByPattern[label] = [];
      framesByPattern[label].push(f);
    });

    // One Detection-style group per matched pattern; the matched
    // frames inside are findings carrying that pattern's severity.
    for (const [label, list] of Object.entries(framesByPattern)) {
      const sev = SENSITIVE_PATTERN_SEVERITY[label] || 'info';
      const desc = SENSITIVE_PATTERN_DESCRIPTIONS[label] || '';
      html += `<div class="detection-group">
        <div class="detection-group-header">
          <span class="scan-badge scan-badge-sens"${desc ? ` title="${escapeAttr(desc)}"` : ''}>⚠️ ${escapeHtml(label)}</span>
          <span class="detection-group-count">${list.length} frame${list.length === 1 ? '' : 's'}</span>
          ${desc ? '<span class="detection-group-toggle">▾</span>' : ''}
        </div>
        ${desc ? `<div class="detection-category-desc hidden">${escapeHtml(desc)}</div>` : ''}
        <div class="detection-findings">`;
      for (const f of list) {
        const funcName = f.functionName || '(anonymous)';
        const fileName = shortenUrl(f.url || '');
        const line = (f.lineNumber ?? -1) + 1;
        const loc = f.url
          ? `${funcName}  ${fileName}:${line}`
          : funcName;
        html += `<div class="detection-finding severity-${sev}">
          <div class="detection-finding-top">
            <span class="detection-severity sev-${sev}">${sev.toUpperCase()}</span>
            <span class="detection-location">${escapeHtml(loc)}</span>
          </div>
        </div>`;
      }
      html += `</div></div>`;
    }

    html += '<div class="initiator-stack-title">Call Stack</div>';
    html += '<div class="initiator-stack">';
    frames.forEach((f, i) => {
      const funcName = f.functionName || '(anonymous)';
      const fileName = shortenUrl(f.url || '');
      const line = (f.lineNumber ?? -1) + 1; // 0-indexed → 1-indexed
      const col = (f.columnNumber ?? 0) + 1;
      const sensitive = detectSensitive(f.functionName);
      const sensitiveCls = sensitive ? ' sensitive' : '';
      const sourceLocation = f.url ? `${escapeHtml(fileName)}:${line}:${col}` : '';

      html += `<div class="initiator-frame${sensitiveCls}" data-url="${escapeAttr(f.url || '')}" data-line="${f.lineNumber || 0}" data-col="${f.columnNumber || 0}">`;
      html += `<span class="frame-index">${i}</span>`;
      html += `<span class="func-name">${escapeHtml(funcName)}</span>`;
      if (sensitive) {
        const sensDesc = SENSITIVE_PATTERN_DESCRIPTIONS[sensitive] || '';
        html += `<span class="sensitive-badge"${sensDesc ? ` title="${escapeAttr(sensDesc)}"` : ''}>${escapeHtml(sensitive)}</span>`;
      }
      if (sourceLocation) {
        html += `<span class="source-link" title="${escapeAttr(f.url + ':' + line)}">${sourceLocation}</span>`;
      }
      html += '</div>';
    });
    html += '</div>';
  } else if (init.url) {
    // Parser-initiated (e.g. <script src>, <link>, <img>)
    html += `<div class="initiator-parser">Initiated by: <span class="source-link" data-url="${escapeAttr(init.url)}" data-line="${init.lineNumber || 0}">${escapeHtml(init.url)}${init.lineNumber != null ? ':' + (init.lineNumber + 1) : ''}</span></div>`;
  } else {
    html += '<div class="detail-loading">No call stack available.</div>';
  }

  // Inline source viewer placeholder
  html += '<div id="initiator-source-viewer"></div>';

  container.innerHTML = html;

  function showInlineSource(url, lineNum, colNum, notice) {
    container.querySelectorAll('.initiator-frame').forEach(f => f.classList.remove('active'));
    const activeFrame = container.querySelector(`.initiator-frame[data-url="${CSS.escape(url)}"][data-line="${lineNum}"]`);
    if (activeFrame) activeFrame.classList.add('active');

    const viewer = document.getElementById('initiator-source-viewer');

    // Prefer the mapped original source when the script has a parsed
    // map and sourcesContent[] inlines the file. Falls through to the
    // bundled fetch otherwise.
    const map = sourceMapCache[url];
    if (map) {
      const mapping = lookupMapping(map.segments, lineNum, colNum || 0);
      if (mapping) {
        const original = map.sourcesContent[mapping.sourceIndex];
        const sourceName = map.sources[mapping.sourceIndex];
        if (original && sourceName) {
          const display = sourceName.split('/').pop() || sourceName;
          viewer.innerHTML =
            `<div class="source-viewer-header">${escapeHtml(display)}:${mapping.originalLine + 1}` +
            `<span class="source-viewer-mapped-tag">↑ source-mapped from ${escapeHtml(shortenUrl(url))}</span></div>`;
          const body = document.createElement('div');
          viewer.appendChild(body);
          renderSourceViewer(body, original, mapping.originalLine);
          if (notice) {
            const noticeEl = document.createElement('div');
            noticeEl.className = 'source-viewer-notice';
            noticeEl.textContent = notice;
            viewer.insertBefore(noticeEl, viewer.children[1]);
          }
          return;
        }
      }
    }

    const header = `${escapeHtml(shortenUrl(url))}:${lineNum + 1}`;
    viewer.innerHTML = `<div class="source-viewer-header">${header}</div><div class="detail-loading">Loading source...</div>`;
    fetchSource(url, (source) => {
      if (source) {
        renderSourceViewer(viewer, source, lineNum);
      } else {
        viewer.innerHTML = `<div class="source-viewer-header">${header}</div><div class="detail-loading">Source not available (cross-origin or network error).</div>`;
      }
      if (notice) {
        const noticeEl = document.createElement('div');
        noticeEl.className = 'source-viewer-notice';
        noticeEl.textContent = notice;
        viewer.insertBefore(noticeEl, viewer.children[1]);
      }
    });
  }

  // Frame body click → inline source viewer
  container.querySelectorAll('.initiator-frame').forEach(el => {
    const url = el.dataset.url;
    if (!url) return;
    el.style.cursor = 'pointer';
    el.addEventListener('click', (e) => {
      // If source-link was clicked, let its own handler take over
      if (e.target.closest('.source-link')) return;
      e.stopPropagation();
      const lineNum = parseInt(el.dataset.line || '0', 10);
      const colNum = parseInt(el.dataset.col || '0', 10);
      showInlineSource(url, lineNum, colNum);
    });
  });

  // Source link click → try Sources tab, fallback to inline. If the
  // script has a usable source map, prefer the mapped inline view —
  // Sources panel only knows about the bundled file.
  container.querySelectorAll('.initiator-frame .source-link').forEach(link => {
    const frame = link.closest('.initiator-frame');
    const url = frame?.dataset.url;
    if (!url) return;
    link.style.cursor = 'pointer';
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      const lineNum = parseInt(frame.dataset.line || '0', 10);
      const colNum = parseInt(frame.dataset.col || '0', 10);

      const map = sourceMapCache[url];
      if (map) {
        const mapping = lookupMapping(map.segments, lineNum, colNum);
        if (mapping && map.sourcesContent[mapping.sourceIndex]) {
          showInlineSource(url, lineNum, colNum);
          return;
        }
      }

      chrome.devtools.inspectedWindow.getResources((resources) => {
        const exists = resources.some(r => r.url === url);
        if (exists) {
          chrome.devtools.panels.openResource(url, lineNum, () => {});
        } else {
          showInlineSource(url, lineNum, colNum,
            'Resource not found in Sources panel — showing fetched source. Click the source link again to open in Sources (the fetch request makes it available).');
        }
      });
    });
  });

  // Parser-initiated source link click
  container.querySelectorAll('.initiator-parser .source-link[data-url]').forEach(link => {
    const url = link.dataset.url;
    if (!url) return;
    link.style.cursor = 'pointer';
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      const lineNum = parseInt(link.dataset.line || '0', 10);
      chrome.devtools.inspectedWindow.getResources((resources) => {
        if (resources.some(r => r.url === url)) {
          chrome.devtools.panels.openResource(url, lineNum, () => {});
        } else {
          showInlineSource(url, lineNum, 0);
        }
      });
    });
  });

  // Click-to-expand for Type and pattern groups — same handler the
  // Detection tab uses, so the two tabs share UX.
  container.addEventListener('click', _onDetectionGroupClick);

  // Async: enrich call-stack frames with source map info. Updates DOM
  // when each script's map resolves. Cache means no repeat fetches.
  if (frames.length > 0) enrichFramesWithSourceMaps(container, frames, req);
}

// Lite version of the source-map enrichment that only updates the
// Initiator column on the row — no DOM rewrite of frame elements.
// Runs proactively at capture time so the column shows "↑ Mapped"
// without the user having to click into the request first.
function _eagerEnrichInitiator(req) {
  if (!req || req._sourcemapMapped) return;
  const frames = (req.initiator && req.initiator.stack && req.initiator.stack.callFrames) || [];
  if (frames.length === 0) return;
  const seen = new Set();
  for (const f of frames) {
    if (!f.url || seen.has(f.url)) continue;
    seen.add(f.url);
    getSourceMap(f.url, (map) => {
      if (!map || req._sourcemapMapped) return;
      // Walk only this script's frames — first match flips the flag.
      for (const ff of frames) {
        if (ff.url !== f.url) continue;
        const mapping = lookupMapping(map.segments, ff.lineNumber || 0, ff.columnNumber || 0);
        if (mapping && map.sources[mapping.sourceIndex]) {
          req._sourcemapMapped = true;
          updateNetworkRowInitiator(req);
          return;
        }
      }
    });
  }
}

// For each unique script URL in the call stack, try to fetch & decode
// its source map, then rewrite the frame's source-link to show the
// mapped (original-file:line:col) location alongside the bundled one.
function enrichFramesWithSourceMaps(container, frames, req) {
  const urlToIndices = {};
  frames.forEach((f, i) => {
    if (!f.url) return;
    if (!urlToIndices[f.url]) urlToIndices[f.url] = [];
    urlToIndices[f.url].push(i);
  });
  let mappedCount = 0;
  const totalFramesWithUrls = Object.values(urlToIndices).reduce((s, arr) => s + arr.length, 0);
  Object.keys(urlToIndices).forEach(url => {
    getSourceMap(url, (map) => {
      if (!map) return;
      const frameEls = container.querySelectorAll('.initiator-frame');
      urlToIndices[url].forEach(idx => {
        const frame = frames[idx];
        const mapping = lookupMapping(
          map.segments,
          frame.lineNumber || 0,
          frame.columnNumber || 0
        );
        if (!mapping) return;
        const sourceName = map.sources[mapping.sourceIndex];
        if (!sourceName) return;
        const frameEl = frameEls[idx];
        if (!frameEl) return;
        const sourceLink = frameEl.querySelector('.source-link');
        if (!sourceLink) return;
        const display = sourceName.split('/').pop() || sourceName;
        const mappedLoc = `${display}:${mapping.originalLine + 1}:${mapping.originalColumn + 1}`;
        const bundledLoc = `${shortenUrl(frame.url)}:${(frame.lineNumber || 0) + 1}`;
        sourceLink.classList.add('mapped');
        sourceLink.title = `Original: ${sourceName}:${mapping.originalLine + 1}\nBundled: ${frame.url}:${(frame.lineNumber || 0) + 1}`;
        sourceLink.innerHTML =
          `<span class="mapped-icon">↑</span>` +
          `<span class="mapped-loc">${escapeHtml(mappedLoc)}</span>` +
          `<span class="bundled-loc">${escapeHtml(bundledLoc)}</span>`;
        mappedCount++;
        // Mark the Initiator tab so the user knows mapping happened
        // even before they click into the tab.
        const tabBtn = document.querySelector('.detail-tab[data-detail="initiator"]');
        if (tabBtn) {
          tabBtn.classList.add('has-mapped');
          tabBtn.title = `Source-mapped frames: ${mappedCount} / ${totalFramesWithUrls}\n\n${INITIATOR_TYPE_DESCRIPTIONS.mapped || ''}`;
        }
        // Promote the row's Initiator cell to "↑ Mapped" on the first
        // successful frame mapping. Flag persists on the req so the
        // cell stays mapped across re-renders.
        if (req && !req._sourcemapMapped) {
          req._sourcemapMapped = true;
          updateNetworkRowInitiator(req);
        }
        // Promote the Type group inside the Initiator detail tab so
        // its badge / count reflect the mapped state.
        const typeGroup = container.querySelector('[data-init-type-group]');
        if (typeGroup) {
          const typeBadge = typeGroup.querySelector('.scan-badge');
          if (typeBadge && !typeBadge.classList.contains('scan-badge-init-mapped')) {
            typeBadge.textContent = '↑ Mapped';
            typeBadge.className = 'scan-badge scan-badge-init-mapped';
            const md = INITIATOR_TYPE_DESCRIPTIONS.mapped || '';
            if (md) typeBadge.title = md;
            // Replace the inline description card with the mapped one.
            const descBlock = typeGroup.querySelector('.detection-category-desc');
            if (descBlock && md) descBlock.textContent = md;
          }
          const cnt = typeGroup.querySelector('.detection-group-count');
          if (cnt) cnt.textContent = `${mappedCount} frame${mappedCount === 1 ? '' : 's'} mapped`;
        }
      });
    });
  });
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
// Auto Decode Layer — JWT, Base64, URL-enc, nested JSON, timestamp
// ============================================================
// Scans the active request's headers + body for common encodings and
// surfaces a "🔍 Decoded" panel beneath the original view. Best-effort:
// false positives are suppressed by strict format checks rather than
// asking the user to disable detectors.

const AUTODECODE_MAX_FINDINGS = 50;

function decodeBase64Url(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return atob(s);
}

// Heuristic: most bytes printable ASCII (incl. \t \n \r). Used to keep
// the Base64 detector from claiming arbitrary alphanumeric strings.
function isPrintableMostly(str, threshold) {
  if (str.length === 0) return false;
  let printable = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if ((c >= 32 && c <= 126) || c === 9 || c === 10 || c === 13) printable++;
  }
  return printable / str.length >= (threshold || 0.95);
}

// Replace numeric epoch fields (exp/iat/nbf/auth_time) with ISO strings
// alongside the original — used when displaying the JWT payload.
function humanizeJwtTimestamps(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const out = { ...payload };
  ['exp', 'iat', 'nbf', 'auth_time'].forEach(f => {
    if (typeof out[f] === 'number') {
      out[`${f} (decoded)`] = new Date(out[f] * 1000).toISOString();
    }
  });
  return out;
}

function detectJWT(str) {
  if (typeof str !== 'string') return null;
  const m = str.match(/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)$/);
  if (!m) return null;
  let header, payload;
  try {
    header = JSON.parse(decodeBase64Url(m[1]));
    payload = JSON.parse(decodeBase64Url(m[2]));
  } catch { return null; }
  if (!header || typeof header !== 'object') return null;
  if (!header.alg && !header.typ) return null;

  const warnings = [];
  if (typeof header.alg === 'string' && header.alg.toLowerCase() === 'none') {
    warnings.push('Algorithm is "none" — token is unsigned and trivially forgeable.');
  }
  if (payload && typeof payload.exp === 'number') {
    const expMs = payload.exp * 1000;
    if (expMs < Date.now()) {
      warnings.push(`Token expired at ${new Date(expMs).toISOString()}.`);
    }
  }
  return {
    type: 'jwt',
    label: 'JWT',
    header,
    payload: humanizeJwtTimestamps(payload),
    signature: m[3],
    warnings,
  };
}

function detectBase64(str) {
  if (typeof str !== 'string') return null;
  if (str.length < 8 || str.length > 8192) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(str)) return null;
  if (str.length % 4 !== 0) return null;
  let decoded;
  try { decoded = atob(str); } catch { return null; }
  if (!isPrintableMostly(decoded, 0.95)) return null;
  let asJson = null;
  try {
    const parsed = JSON.parse(decoded);
    if (typeof parsed === 'object' && parsed !== null) asJson = parsed;
  } catch { /* not JSON */ }
  return { type: 'base64', label: 'Base64', decoded, asJson };
}

function detectUrlEncoded(str) {
  if (typeof str !== 'string') return null;
  // Require at least 2 escape sequences to avoid matching strings that
  // happen to contain a single % literal.
  if (!/(%[0-9A-Fa-f]{2}){2,}/.test(str)) return null;
  let decoded;
  try { decoded = decodeURIComponent(str); } catch { return null; }
  if (decoded === str) return null;
  return { type: 'urlenc', label: 'URL-encoded', decoded };
}

function detectNestedJson(str) {
  if (typeof str !== 'string') return null;
  const trimmed = str.trim();
  if (trimmed.length < 2) return null;
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null;
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  return { type: 'nested-json', label: 'Nested JSON', parsed };
}

function detectUnixTimestamp(val) {
  let n;
  if (typeof val === 'number' && Number.isFinite(val)) {
    n = val;
  } else if (typeof val === 'string' && /^\d{10}(?:\d{3})?$/.test(val)) {
    n = parseInt(val, 10);
  } else {
    return null;
  }
  let ms;
  if (n >= 1e9 && n < 1e10) ms = n * 1000;        // 10-digit seconds (2001–2286)
  else if (n >= 1e12 && n < 1e13) ms = n;          // 13-digit ms
  else return null;
  const date = new Date(ms);
  if (isNaN(date.getTime())) return null;
  return { type: 'timestamp', label: 'Unix timestamp', raw: n, date: date.toISOString() };
}

// Try detectors in priority order; return the first hit. JWT first
// because its three-segment shape is unambiguous, then URL-enc and
// nested JSON which have clear markers, then Base64 last (broadest).
function detectInString(str) {
  return detectJWT(str)
    || detectUrlEncoded(str)
    || detectNestedJson(str)
    || detectBase64(str);
}

// Walk a parsed JSON value (object/array/leaf), collecting findings
// with dotted-path locations. Numbers are checked for timestamps;
// strings go through the full detector chain.
function autoDecodeScanValue(value, path, findings) {
  if (findings.length >= AUTODECODE_MAX_FINDINGS) return;
  if (typeof value === 'string') {
    const f = detectInString(value);
    if (f) findings.push({ ...f, location: path || '(value)' });
    return;
  }
  if (typeof value === 'number') {
    const f = detectUnixTimestamp(value);
    if (f) findings.push({ ...f, location: path || '(value)' });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => autoDecodeScanValue(v, `${path}[${i}]`, findings));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const k of Object.keys(value)) {
      autoDecodeScanValue(value[k], path ? `${path}.${k}` : k, findings);
    }
  }
}

// Scan a flat header map. Strips the "Bearer "/"Basic "/"Token " prefix
// before running detectors — JWTs almost always live under one.
function autoDecodeScanHeaders(headers, sourceLabel) {
  const findings = [];
  for (const [name, value] of Object.entries(headers || {})) {
    if (findings.length >= AUTODECODE_MAX_FINDINGS) break;
    if (typeof value !== 'string') continue;
    let scanStr = value;
    let prefix = '';
    const auth = value.match(/^(Bearer|Basic|Token)\s+(.+)$/i);
    if (auth) { prefix = auth[1]; scanStr = auth[2]; }
    const f = detectInString(scanStr);
    if (f) {
      findings.push({
        ...f,
        location: `${sourceLabel}: ${name}${prefix ? ` (after "${prefix}")` : ''}`,
      });
    }
  }
  return findings;
}

// Scan a body string. Tries JSON first, then urlencoded form, then
// raw string. Each branch calls scanValue/detectInString as appropriate.
//
// Bodies over 500KB are truncated to the first 50KB before scanning so
// a single huge payload can't lock up the panel. The truncation is
// surfaced to the user as a 'notice' finding so they know the result
// is partial.
const AUTODECODE_BODY_LIMIT = 512000;
const AUTODECODE_BODY_TRUNCATE = 51200;

function autoDecodeScanBody(bodyStr, sourceLabel) {
  if (!bodyStr || typeof bodyStr !== 'string') return [];
  const findings = [];
  let scanStr = bodyStr;
  if (bodyStr.length > AUTODECODE_BODY_LIMIT) {
    scanStr = bodyStr.slice(0, AUTODECODE_BODY_TRUNCATE);
    findings.push({
      type: 'notice',
      label: 'TRUNCATED',
      location: `Response too large; analyzed first ${(AUTODECODE_BODY_TRUNCATE / 1024) | 0} KB (total ${(bodyStr.length / 1024).toFixed(1)} KB)`,
    });
  }
  const trimmed = scanStr.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) {
        autoDecodeScanValue(parsed, sourceLabel, findings);
        return findings;
      }
    } catch { /* fall through */ }
  }
  if (scanStr.includes('=') && /^[\w.~%-]+=[^&]*(&[\w.~%-]+=[^&]*)*$/.test(scanStr)) {
    try {
      const params = new URLSearchParams(scanStr);
      for (const [k, v] of params) {
        if (findings.length >= AUTODECODE_MAX_FINDINGS) break;
        const f = detectInString(v);
        if (f) findings.push({ ...f, location: `${sourceLabel}: ${k}` });
      }
      return findings;
    } catch { /* fall through */ }
  }
  const f = detectInString(scanStr);
  if (f) findings.push({ ...f, location: sourceLabel });
  return findings;
}

// Replace any existing decoded section in `container` with one built
// from `findings`. Empty findings → section is removed.
function renderDecodedSection(container, findings) {
  const existing = container.querySelector(':scope > .decoded-section');
  if (existing) existing.remove();
  if (!findings || findings.length === 0) return;
  let html = `<div class="decoded-section">
    <div class="decoded-header"><span>🔍 Decoded</span><span class="decoded-count">${findings.length}</span></div>
    <div class="decoded-list">`;
  findings.forEach(f => { html += renderDecodedFinding(f); });
  html += '</div></div>';
  container.insertAdjacentHTML('beforeend', html);
}

function renderDecodedFinding(f) {
  // Plain notices (e.g. "TRUNCATED") render as a single non-expandable
  // banner — no body, no chevron, no expandable details.
  if (f.type === 'notice') {
    return `<div class="decoded-item decoded-notice">
      <span class="decoded-type-badge type-notice">${escapeHtml(f.label)}</span>
      <span class="decoded-location">${escapeHtml(f.location || '')}</span>
    </div>`;
  }
  const warnings = (f.warnings || []).map(w =>
    `<span class="decoded-warning-badge">⚠️ ${escapeHtml(w)}</span>`
  ).join('');
  let body = '';
  switch (f.type) {
    case 'jwt': {
      const headerStr = JSON.stringify(f.header, null, 2);
      const payloadStr = JSON.stringify(f.payload, null, 2);
      body = `<div class="decoded-subblock">Header</div>
              <pre class="decoded-pretty">${syntaxHighlightJson(headerStr)}</pre>
              <div class="decoded-subblock">Payload</div>
              <pre class="decoded-pretty">${syntaxHighlightJson(payloadStr)}</pre>`;
      break;
    }
    case 'base64': {
      if (f.asJson) {
        const s = JSON.stringify(f.asJson, null, 2);
        body = `<div class="decoded-subblock">Decoded (JSON)</div>
                <pre class="decoded-pretty">${syntaxHighlightJson(s)}</pre>`;
      } else {
        body = `<div class="decoded-subblock">Decoded</div>
                <pre class="decoded-pretty">${escapeHtml(f.decoded)}</pre>`;
      }
      break;
    }
    case 'urlenc':
      body = `<pre class="decoded-pretty">${escapeHtml(f.decoded)}</pre>`;
      break;
    case 'nested-json': {
      const s = JSON.stringify(f.parsed, null, 2);
      body = `<pre class="decoded-pretty">${syntaxHighlightJson(s)}</pre>`;
      break;
    }
    case 'timestamp':
      body = `<pre class="decoded-pretty">${escapeHtml(f.date)} (raw: ${f.raw})</pre>`;
      break;
  }
  return `<details class="decoded-item" open>
    <summary>
      <span class="decoded-type-badge type-${f.type}">${escapeHtml(f.label)}</span>
      <span class="decoded-location">${escapeHtml(f.location || '')}</span>
      ${warnings}
    </summary>
    <div class="decoded-content">${body}</div>
  </details>`;
}

// ============================================================
// Response Pattern Detection — security-oriented findings on a request
// ============================================================
// Inspects URL, request body/headers, response body/status against a
// fixed set of patterns (auth tokens, PII, internal info leaks, sensitive
// fields, IDOR candidates, privilege params, suspicious responses) and
// emits a list of findings stored on the request object as scanResults.
// Body-dependent passes only run when the response body is available;
// large bodies are truncated using the same limits as Auto Decode.

const SCAN_BODY_LIMIT = AUTODECODE_BODY_LIMIT;
const SCAN_BODY_TRUNCATE = AUTODECODE_BODY_TRUNCATE;

// Mimetypes worth eagerly loading the response body for so the scan
// can include body-side findings on the initial pass.
function scanShouldEagerLoadBody(req) {
  const m = req.mimeType || '';
  if (!m) return false;
  return /^(application\/(json|xml|x-www-form-urlencoded|javascript|graphql|ld\+json)|application\/[^;]*\+json|text\/)/i.test(m);
}

// Append a finding only if the same (category, location) hasn't been
// seen yet. Keeps the per-request badge list and the detail panel
// from filling with near-duplicates.
function _scanAdd(findings, seen, finding) {
  const key = `${finding.category}|${finding.location}`;
  if (seen.has(key)) return;
  seen.add(key);
  findings.push(finding);
}

function _scanCheckPrivilegeKey(key) {
  return /^(role|isAdmin|is_admin|admin|privilege|permission)$/i.test(key);
}

// Match ID-like parameter names. Three shapes are recognized so we catch
// resource-ID parameters (userId, account_id, etc.) without firing on
// English words that happen to end in "id" (paid, valid, said).
//   1) "id" / "ID" exactly
//   2) camelCase: <lowercase>I<d|D>$  — userId, orderId, accountID
//   3) separator: _id / -id (any case)
// session_id / sessionId belong to the 'session' category instead, so
// we short-circuit those before falling through to the IDOR shapes.
function _scanCheckIdorKey(key) {
  if (_scanCheckSessionKey(key)) return false;
  if (/^id$/i.test(key)) return true;
  if (/[a-z]I[dD]$/.test(key)) return true;
  if (/[_-]id$/i.test(key)) return true;
  return false;
}

// Session / auth tokens passed as URL parameters or request body fields.
// Distinct from the response-side `token` category, which flags the
// same kinds of secrets *being returned*. Keeping `access_token` out
// of this list — it stays a 'token' concept on the response side.
function _scanCheckSessionKey(key) {
  return /^(session[_-]?id|session[_-]?token|auth[_-]?token)$/i.test(key);
}

// Parameter names that look like IDs but are really analytics /
// tracking handles, never IDOR candidates. Stored normalized
// (lowercase, separators stripped) so snake/camel/kebab all match
// against the same entry.
const IDOR_TRACKING_KEYS_NORMALIZED = new Set([
  'impressionid', 'impid',
  'torosimpid', 'torospagemetaid',
  'teslacontentid',
  'pageviewid',
  'clickid', 'trackingid', 'logid',
  'anonymousid', 'eventid', 'requestid',
]);

function _scanIsIdorTrackingKey(key) {
  return IDOR_TRACKING_KEYS_NORMALIZED.has(
    key.toLowerCase().replace(/[_-]/g, '')
  );
}

// Fixed flag values — semantically not entity IDs even when they
// arrive in an *_id parameter (e.g. id=control for A/B test bucket).
const IDOR_FLAG_VALUES = new Set([
  'control', 'default', 'n', 'y',
  'true', 'false', 'none', 'null', 'undefined',
]);

// Values we filter out as noise: empty, booleans, fixed flags, and a
// handful of well-known ad/SDK ID prefixes (DAN- for Kakao Ads,
// sodar/av- for tracking SDKs).
function _scanIsIdorNoiseValue(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'boolean') return true;
  const s = String(v);
  if (s.length === 0) return true;
  if (IDOR_FLAG_VALUES.has(s.toLowerCase())) return true;
  if (/^DAN-/.test(s)) return true;
  if (/^sodar/i.test(s)) return true;
  if (/^av-/.test(s)) return true;
  return false;
}

// Single-stop decision for IDOR: name shape + tracking-key denylist
// + value-noise filter. Centralized so all three scan locations
// (query / JSON body walk / form body) make the same call.
function _shouldFlagAsIdor(key, value) {
  if (!_scanCheckIdorKey(key)) return false;
  if (_scanIsIdorTrackingKey(key)) return false;
  if (_scanIsIdorNoiseValue(value)) return false;
  return true;
}

// Pull a "<software>/<x.y.z>" version disclosure out of Server /
// X-Powered-By header values. Returns null if the value has no
// version number attached (e.g. just "nginx" or "Express").
function _scanExtractServerVersion(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/([A-Za-z][A-Za-z0-9.-]*)\/(\d+(?:\.\d+)+)/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// File extensions that look like TLDs in the email regex but are really
// asset filenames (e.g. "logo@2x.png"). Used to suppress PII false
// positives. Only includes extensions that are NOT also real TLDs —
// `tv` / `me` / `io` are kept since they're legitimate domains.
const EMAIL_FILE_EXT_DENY = new Set([
  // Images
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'tiff', 'tif', 'avif',
  // Documents
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'csv',
  // Audio / video
  'mp3', 'mp4', 'wav', 'avi', 'mov', 'webm', 'mkv', 'ogg', 'm4a', 'flac', 'aac',
  // Archives
  'zip', 'rar', 'tar', 'gz', 'tgz', 'bz2', '7z',
  // Code / web assets
  'js', 'jsx', 'ts', 'tsx', 'vue', 'css', 'scss', 'sass', 'less', 'html', 'htm', 'php',
  // Data / config
  'json', 'xml', 'yaml', 'yml', 'env', 'lock',
  // Fonts
  'woff', 'woff2', 'ttf', 'eot', 'otf',
]);

// HUNT-style parameter dictionary. Each category lists parameter names
// historically associated with a vuln class — flags candidates worth
// manual probing, not confirmed bugs. Inspired by Bugcrowd's HUNT.
//
// Per-keyword severity overrides are supported via `keywordSeverity`.
// Compound dictionary entries like "return_url" are tokenized during
// build, so the lookup map only holds single words.
const HUNT_CATEGORIES = {
  // The previous five categories (SQLi / LFI / SSRF / RCE / debug)
  // collapsed into a single "Tampering" bucket. The distinction between
  // them in practice was noisy — a parameter named `query` could equally
  // be a SQL search, a URL filter, or a debug toggle. Merging them
  // surfaces the same set of "this parameter influences server logic"
  // candidates with one badge and one MEDIUM severity, and the user
  // moves on to actually probe with payloads in Replay.
  tampering: {
    badge: '🔨 Tampering',
    defaultSeverity: 'medium',
    keywords: [
      // SQLi-flavored
      'query', 'search', 'filter', 'sort', 'where', 'select', 'order',
      'keyword', 'column', 'field', 'report', 'row',
      // LFI-flavored
      'file', 'path', 'dir', 'directory', 'document', 'template',
      'doc', 'folder', 'root', 'pdf', 'pg', 'style', 'page', 'include',
      // SSRF-flavored
      'url', 'redirect', 'dest', 'destination', 'callback', 'return',
      'next', 'host', 'domain', 'uri', 'forward', 'navigate', 'open',
      'feed', 'ref', 'continue',
      // RCE-flavored
      'cmd', 'exec', 'command', 'shell', 'execute', 'run',
      // Debug-flavored
      'debug', 'test', 'dbg', 'config', 'toggle',
      'enable', 'disable', 'reset', 'adm', 'cfg',
    ],
  },
};

// token (lowercased) → { category, badge, severity, matchedKeyword }.
// Severity is resolved per-token: keywordSeverity[tok] || defaultSeverity.
const HUNT_KEYWORD_MAP = (() => {
  const map = new Map();
  for (const [category, def] of Object.entries(HUNT_CATEGORIES)) {
    for (const kw of def.keywords) {
      const tokens = kw.toLowerCase().split(/[_-]/).filter(Boolean);
      for (const tok of tokens) {
        if (!map.has(tok)) {
          const sev = (def.keywordSeverity && def.keywordSeverity[tok])
            || def.defaultSeverity;
          map.set(tok, {
            category, badge: def.badge, severity: sev, matchedKeyword: tok,
          });
        }
      }
    }
  }
  return map;
})();

// Post-match noise filter for HUNT hits. Some keywords overlap with
// browser performance / runtime properties; this lets us keep the
// keyword in the dictionary but suppress the obvious technical
// noise variants.
function _scanIsHuntNoise(tokens, hit) {
  if (hit.category === 'tampering') {
    // 'domain' only flags when the parameter IS exactly "domain" —
    // domainLookupStart / domainLookupEnd are PerformanceTiming.
    if (hit.matchedKeyword === 'domain') {
      if (tokens.length !== 1 || tokens[0] !== 'domain') return true;
    }
    // 'redirect' shouldn't fire on perf-timing variants
    // (redirectStart, redirectEnd, redirectTime, redirectDuration).
    // Genuine redirect_uri / redirect_url tokenize without these.
    if (hit.matchedKeyword === 'redirect') {
      for (const t of tokens) {
        if (t === 'start' || t === 'end' || t === 'time' || t === 'duration') {
          return true;
        }
      }
    }
  }
  return false;
}

// Split a parameter name into lowercase tokens. Handles camelCase
// (filePath → file, path), snake_case (file_path), kebab-case
// (file-path), and dot.notation (data.id → data, id). Words like
// "profile"/"research" stay as a single token, avoiding false
// positives against "file"/"search".
function _scanTokenize(name) {
  if (typeof name !== 'string') return [];
  const snake = name.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase();
  return snake.split(/[_\-.]/).filter(Boolean);
}

// Strict matcher: every token in the parameter name must be a known
// HUNT keyword. Mixed names like isBackForward / open_graph /
// ping_second / operating_system have non-HUNT tokens (is, back,
// graph, second, operating) signaling a different domain — those
// are excluded entirely. redirect_uri / file_path still match
// because both tokens belong to the vocabulary.
function _scanMatchHunt(name) {
  const tokens = _scanTokenize(name);
  if (tokens.length === 0) return null;
  let firstHit = null;
  for (const tok of tokens) {
    const hit = HUNT_KEYWORD_MAP.get(tok);
    if (!hit) return null;
    if (!firstHit && !_scanIsHuntNoise(tokens, hit)) {
      firstHit = hit;
    }
  }
  return firstHit;
}

// Whether any finding has already been recorded at this location, in
// any category. Used to skip HUNT additions when IDOR/privilege/sensitive
// already flagged the same parameter.
function _scanLocationHasFinding(seen, location) {
  for (const key of seen) {
    const sepIdx = key.indexOf('|');
    if (sepIdx >= 0 && key.slice(sepIdx + 1) === location) return true;
  }
  return false;
}

// Run HUNT match against a parameter name and add a finding if it hits
// AND no prior finding exists at the same location.
function _scanAddHunt(findings, seen, location, paramName, value) {
  if (_scanLocationHasFinding(seen, location)) return;
  const hit = _scanMatchHunt(paramName);
  if (!hit) return;
  let evidence = `matched "${hit.matchedKeyword}" in "${paramName}"`;
  if (value !== undefined && value !== null && value !== '') {
    const vs = typeof value === 'object'
      ? JSON.stringify(value).slice(0, 40)
      : String(value).slice(0, 40);
    evidence += ` = ${vs}`;
  }
  _scanAdd(findings, seen, {
    category: hit.category,
    badge: hit.badge,
    severity: hit.severity,
    location,
    evidence,
  });
}

function _scanCheckSensitiveKey(key) {
  return /^(password|passwd|pwd|secret|private[_-]?key|client[_-]?secret)$/i.test(key);
}

function _scanCheckTokenKey(key) {
  return /^(api[_-]?key|access[_-]?token|secret)$/i.test(key);
}

// Walk a parsed object/array, applying field-name-based detectors.
function _scanWalkObject(obj, path, findings, seen) {
  if (typeof obj !== 'object' || obj === null) return;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => _scanWalkObject(v, `${path}[${i}]`, findings, seen));
    return;
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const fullPath = path ? `${path}.${k}` : k;
    const valStr = typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : '');
    if (typeof v === 'string' && v.length > 0) {
      if (_scanCheckSensitiveKey(k)) {
        _scanAdd(findings, seen, {
          category: 'sensitive', badge: '🔴 sensitive', severity: 'high',
          location: `response.body.${fullPath}`,
          evidence: `${k}: ${v.length > 20 ? '(' + v.length + ' chars)' : v}`,
        });
      }
      if (_scanCheckTokenKey(k)) {
        _scanAdd(findings, seen, {
          category: 'token', badge: '🔑 token', severity: 'high',
          location: `response.body.${fullPath}`,
          evidence: `${k}: ${valStr.length > 40 ? valStr.slice(0, 40) + '…' : valStr}`,
        });
      }
    }
    if (typeof v === 'object' && v !== null) {
      _scanWalkObject(v, fullPath, findings, seen);
    }
  }
}

function scanRequest(req) {
  const findings = [];
  const seen = new Set();

  // -------- Request URL: IDOR, privilege query params --------
  // (URL path numeric-segment detection was dropped in 2026-04: build
  // timestamps, version numbers, and ad creative IDs produced 100% FP.)
  try {
    const url = new URL(req.url);
    for (const [k, v] of url.searchParams) {
      if (_shouldFlagAsIdor(k, v)) {
        _scanAdd(findings, seen, {
          category: 'idor', badge: '🔢 IDOR', severity: 'info',
          location: `request.query.${k}`,
          evidence: `${k}=${v}`,
        });
      }
      if (_scanCheckPrivilegeKey(k)) {
        _scanAdd(findings, seen, {
          category: 'privilege', badge: '⚠️ privilege', severity: 'high',
          location: `request.query.${k}`,
          evidence: `${k}=${v}`,
        });
      }
      if (_scanCheckSessionKey(k) && v.length > 0) {
        _scanAdd(findings, seen, {
          category: 'session', badge: '🔐 session', severity: 'medium',
          location: `request.query.${k}`,
          evidence: `${k}: ${v.length > 20 ? '(' + v.length + ' chars)' : v}`,
        });
      }
      _scanAddHunt(findings, seen, `request.query.${k}`, k, v);
    }
  } catch { /* malformed url */ }

  // -------- Request body: privilege + IDOR + sensitive params --------
  if (req.requestPostData && typeof req.requestPostData === 'string') {
    let parsed = null;
    try { parsed = JSON.parse(req.requestPostData); } catch {}
    if (parsed && typeof parsed === 'object') {
      const walk = (o, p) => {
        if (typeof o !== 'object' || o === null) return;
        if (Array.isArray(o)) { o.forEach((v, i) => walk(v, `${p}[${i}]`)); return; }
        for (const k of Object.keys(o)) {
          const fp = p ? `${p}.${k}` : k;
          const v = o[k];
          const evi = typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : v;
          if (_scanCheckPrivilegeKey(k)) {
            _scanAdd(findings, seen, {
              category: 'privilege', badge: '⚠️ privilege', severity: 'high',
              location: `request.body.${fp}`,
              evidence: `${k}: ${evi}`,
            });
          }
          if (_shouldFlagAsIdor(k, v)) {
            _scanAdd(findings, seen, {
              category: 'idor', badge: '🔢 IDOR', severity: 'info',
              location: `request.body.${fp}`,
              evidence: `${k}=${evi}`,
            });
          }
          if (_scanCheckSensitiveKey(k) && typeof v === 'string' && v.length > 0) {
            _scanAdd(findings, seen, {
              category: 'sensitive', badge: '🔴 sensitive', severity: 'high',
              location: `request.body.${fp}`,
              evidence: `${k}: ${v.length > 20 ? '(' + v.length + ' chars)' : v}`,
            });
          }
          if (_scanCheckSessionKey(k) && typeof v === 'string' && v.length > 0) {
            _scanAdd(findings, seen, {
              category: 'session', badge: '🔐 session', severity: 'medium',
              location: `request.body.${fp}`,
              evidence: `${k}: ${v.length > 20 ? '(' + v.length + ' chars)' : v}`,
            });
          }
          _scanAddHunt(findings, seen, `request.body.${fp}`, k, v);
          if (typeof v === 'object' && v !== null) walk(v, fp);
        }
      };
      walk(parsed, '');
    } else {
      try {
        const params = new URLSearchParams(req.requestPostData);
        for (const [k, v] of params) {
          if (_scanCheckPrivilegeKey(k)) {
            _scanAdd(findings, seen, {
              category: 'privilege', badge: '⚠️ privilege', severity: 'high',
              location: `request.body.${k}`,
              evidence: `${k}=${v}`,
            });
          }
          if (_shouldFlagAsIdor(k, v)) {
            _scanAdd(findings, seen, {
              category: 'idor', badge: '🔢 IDOR', severity: 'info',
              location: `request.body.${k}`,
              evidence: `${k}=${v}`,
            });
          }
          if (_scanCheckSensitiveKey(k) && v.length > 0) {
            _scanAdd(findings, seen, {
              category: 'sensitive', badge: '🔴 sensitive', severity: 'high',
              location: `request.body.${k}`,
              evidence: `${k}: ${v.length > 20 ? '(' + v.length + ' chars)' : v}`,
            });
          }
          if (_scanCheckSessionKey(k) && v.length > 0) {
            _scanAdd(findings, seen, {
              category: 'session', badge: '🔐 session', severity: 'medium',
              location: `request.body.${k}`,
              evidence: `${k}: ${v.length > 20 ? '(' + v.length + ' chars)' : v}`,
            });
          }
          _scanAddHunt(findings, seen, `request.body.${k}`, k, v);
        }
      } catch { /* not form */ }
    }
  }

  // -------- Response status: 401/403 with large body --------
  // Skip text/html — SPAs serve their app shell / login page on auth
  // failures, which is normal behavior, not a finding.
  const isHtmlResp = (req.mimeType || '').toLowerCase().includes('text/html');
  if ((req.status === 401 || req.status === 403) &&
      req.responseBody && typeof req.responseBody === 'string' &&
      req.responseBody.length >= 1024 &&
      !isHtmlResp) {
    _scanAdd(findings, seen, {
      category: 'check', badge: '🔍 check', severity: 'info',
      location: `response.status=${req.status}, body=${req.responseBody.length}B`,
      evidence: `Status ${req.status} typically returns a short error message; this body is unusually long.`,
    });
  }

  // -------- Response headers: Server / X-Powered-By version disclosure --------
  if (req.responseHeaders) {
    for (const [name, value] of Object.entries(req.responseHeaders)) {
      const lname = name.toLowerCase();
      if (lname !== 'server' && lname !== 'x-powered-by') continue;
      const ver = _scanExtractServerVersion(value);
      if (ver) {
        _scanAdd(findings, seen, {
          category: 'exposure', badge: '📡 exposure', severity: 'medium',
          location: `response.header.${name}`,
          evidence: `${name}: ${ver}`,
        });
      }
    }
  }

  // -------- Response body: token/PII/leak/sensitive --------
  if (req.responseBody && typeof req.responseBody === 'string' && !req.responseBase64) {
    let body = req.responseBody;
    if (body.length > SCAN_BODY_LIMIT) body = body.slice(0, SCAN_BODY_TRUNCATE);

    // JWT pattern (starts with eyJ — base64url of `{"`)
    const jwtMatches = body.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/);
    if (jwtMatches) {
      const tok = jwtMatches[0];
      // Validate via existing detectJWT to avoid false positives
      if (detectJWT(tok)) {
        _scanAdd(findings, seen, {
          category: 'token', badge: '🔑 token', severity: 'high',
          location: `response.body (JWT-like)`,
          evidence: tok.slice(0, 60) + (tok.length > 60 ? '…' : ''),
        });
      }
    }

    // Email — skip @localhost, @<ipv4>, and TLDs that are really file
    // extensions (e.g. "logo@2x.png" matches the regex but is just a
    // Retina asset filename, not PII).
    const emailMatch = body.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    if (emailMatch) {
      const email = emailMatch[0];
      const domain = email.slice(email.indexOf('@') + 1);
      const tld = domain.split('.').pop().toLowerCase();
      const isLocalhost = /^localhost(:\d+)?$/i.test(domain);
      const isIpv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(domain);
      const isFileExt = EMAIL_FILE_EXT_DENY.has(tld);
      if (!isLocalhost && !isIpv4 && !isFileExt) {
        _scanAdd(findings, seen, {
          category: 'pii', badge: '👤 PII', severity: 'medium',
          location: `response.body (email)`,
          evidence: email,
        });
      }
    }
    // Korean phone numbers
    const phoneMatch = body.match(/01[016789]-\d{3,4}-\d{4}/);
    if (phoneMatch) {
      _scanAdd(findings, seen, {
        category: 'pii', badge: '👤 PII', severity: 'medium',
        location: `response.body (phone)`,
        evidence: phoneMatch[0],
      });
    }

    // Internal IPv4 — narrow to dotted-quad shape via regex, then
    // validate octets ≤ 255 + private-range prefix in JS so a number
    // sequence like 10.669.606.225 doesn't false-positive.
    const ipCandidates = body.matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g);
    let internalIp = null;
    for (const m of ipCandidates) {
      const a = +m[1], b = +m[2], c = +m[3], d = +m[4];
      if (a > 255 || b > 255 || c > 255 || d > 255) continue;
      const isPrivate =
        a === 10 ||
        (a === 192 && b === 168) ||
        (a === 172 && b >= 16 && b <= 31);
      if (isPrivate) { internalIp = m[0]; break; }
    }
    if (internalIp) {
      _scanAdd(findings, seen, {
        category: 'leak', badge: '⚠️ leak', severity: 'medium',
        location: `response.body (internal IP)`,
        evidence: internalIp,
      });
    }
    // Stack-trace keywords
    const stackMatch = body.match(/\b(at Function|at Object|Traceback|NullPointerException|SQLException|stack trace)\b/i);
    if (stackMatch) {
      _scanAdd(findings, seen, {
        category: 'leak', badge: '⚠️ leak', severity: 'medium',
        location: `response.body (stack trace)`,
        evidence: stackMatch[0],
      });
    }
    // Server paths.
    // /home/ tightened: must start with a lowercase letter (drops
    // /home/_next, /home/12345), and must NOT continue into a deeper
    // path like /home/foo/bar — which is normally just a URL prefix,
    // not a server-side filesystem reference.
    const pathMatch = body.match(/(\/var\/www|\/home\/[a-z][a-z0-9_-]*(?![\w\/])|C:\\Users|\/etc\/(?:passwd|shadow|hosts))/);
    if (pathMatch) {
      _scanAdd(findings, seen, {
        category: 'leak', badge: '⚠️ leak', severity: 'medium',
        location: `response.body (server path)`,
        evidence: pathMatch[0],
      });
    }

    // AWS access key ID — fixed AKIA prefix + 16 uppercase alphanumerics
    const awsMatch = body.match(/\bAKIA[A-Z0-9]{16}\b/);
    if (awsMatch) {
      _scanAdd(findings, seen, {
        category: 'exposure', badge: '📡 exposure', severity: 'high',
        location: `response.body (AWS access key)`,
        evidence: awsMatch[0],
      });
    }
    // GitHub PAT — ghp_ / gho_ / ghs_ prefix + 36+ alphanumerics
    const ghMatch = body.match(/\b(ghp|gho|ghs)_[A-Za-z0-9]{36,}\b/);
    if (ghMatch) {
      _scanAdd(findings, seen, {
        category: 'exposure', badge: '📡 exposure', severity: 'high',
        location: `response.body (GitHub PAT)`,
        evidence: ghMatch[0].slice(0, 12) + '…',
      });
    }

    // Field-name-based scan — only meaningful for JSON
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed === 'object' && parsed !== null) {
        _scanWalkObject(parsed, '', findings, seen);
      }
    } catch { /* not JSON */ }
  }

  return findings;
}

// Render the small badge cluster shown in the network list. Dedupes
// to one badge per category, with a tooltip listing all evidences.
function renderScanBadgesInline(scanResults) {
  if (!scanResults || scanResults.length === 0) return '';
  const byCat = {};
  scanResults.forEach(f => {
    if (!byCat[f.category]) byCat[f.category] = { badge: f.badge, evidences: [] };
    byCat[f.category].evidences.push(f.location + (f.evidence ? ` — ${f.evidence}` : ''));
  });
  return Object.entries(byCat).map(([cat, info]) =>
    `<span class="scan-badge scan-badge-${cat}" title="${escapeAttr(info.evidences.join('\n'))}">${escapeHtml(info.badge)}</span>`
  ).join(' ');
}

// Per-category guidance shown in the Detection tab. Click the group
// header (or any finding inside it) to toggle visibility — kept
// hidden by default to avoid drowning the findings themselves.
const DETECTION_CATEGORY_DESCRIPTIONS = {
  token:
    `An authentication token appears in the response body.
Tokens returned in the body can leak through CDN
caching, server logs, or shared HAR files.
Use the Replay tab to retry other requests with this
token and see what it can access.`,

  sensitive:
    `A password or sensitive credential was detected.
In the response: the server is including a sensitive
value in the body.
In the request: the value may be reaching an endpoint
that shouldn't receive it.
Review the endpoint and how the value is transmitted.`,

  pii:
    `Likely personal information appears in the response.
Check whether the data is accessible without
authentication, or whether other users' data is
returned alongside it.
Use the Replay tab to retry with credentials removed
or with a different account's identifiers.`,

  leak:
    `Internal information appears in the response.
Internal IPs, server paths, stack traces, and similar
data should not leak from a production environment.
Try sending intentionally invalid input to see what
additional details surface.`,

  exposure:
    `A server software version or a sensitive key was
exposed in the response.
Version disclosure helps attackers map known
vulnerabilities to your stack.
If an AWS key or GitHub PAT was detected, verify its
validity and permission scope immediately.`,

  idor:
    `An ID parameter looks like a direct object reference.
Use the Replay tab to change the ID and resend the
request to see whether another user's data comes
back.`,

  privilege:
    `A role or privilege parameter is being sent.
Check whether the server trusts the client-supplied
value as-is.
Use the Replay tab to change the value and resend.
e.g. role=user → role=admin
     isAdmin=false → isAdmin=true`,

  session:
    `A session or auth token is being sent as a request
parameter.
Session IDs in URLs or request bodies can be exposed
through server logs or browser history.
Try a different session value and resend to confirm
that access control is enforced correctly.`,

  tampering:
    `A parameter that may influence server-side logic
has been detected in this request.

Modify the parameter value in the Replay tab
and review how the server responds.

Suggested tests:
- Special characters: ' " ; -- (SQL Injection)
- Path patterns: ../../../etc/passwd (Path Traversal)
- External URLs: https://169.254.169.254/ (SSRF)
- Command patterns: ; ls , | whoami (Command Injection)
- Template syntax: {{7*7}} \${7*7} (SSTI)`,

  check:
    `The response is 401/403 but the body is larger than
expected.
A normal auth-failure response should carry only a
short error message.
Inspect the body directly to see whether sensitive
information or data leaks alongside the failure.`,
};

// ============================================================
// Auth — login-request detection + safety inspection (MVP)
// ============================================================
// Heuristic detection: a request looks like a login when at least 2 of
// {URL pattern, password-shaped field in body, auth-flavored response}
// match. Per-req `_authMarked` overrides the auto-detect (user can
// mark anything as a login or unmark a false positive).

// Path-only keyword set for "this looks like a login request". Each
// alternative is anchored on a leading slash and constrained by a
// trailing word boundary (or specific extension/suffix) to avoid
// matching unrelated tokens like /loginEvent or /authority. New
// frameworks: extend this list, no other code change needed.
const _AUTH_LOGIN_URL_RE = new RegExp([
  // login / signin / signon — with optional `_word` suffix to cover
  // Symfony's `/login_check`, `/login_submit` etc.
  '\\/(?:login|signin|signon)(?:_\\w+)?\\b',
  // Hyphen / underscore separators
  '\\/sign[-_](?:in|on)\\b',
  // Plain auth + authenticate
  '\\/auth\\b',
  '\\/authenticate\\b',
  // Session(s) — REST style
  '\\/sessions?\\b',
  // OAuth2 / OIDC token + authorize endpoints
  '\\/oauth\\/(?:token|authorize)\\b',
  '\\/connect\\/(?:token|authorize)\\b',
  // SSO / SAML
  '\\/sso(?:\\/|\\b)',
  '\\/saml\\b',
  // WordPress
  '\\/wp-login\\.php',
  // Explicit token issue paths
  '\\/token\\/issue\\b',
].join('|'), 'i');

// Multiple shapes of password-field declarations across body formats.
// First match wins. Covers form-urlencoded, JSON, XML attributes (e.g.
// `<Col id="userPw">…`), XML elements, HTML form `name=`. Catches the
// common typed variants too (passwd / pwd / userPw / user_password).
const _AUTH_PASSWORD_FIELD_NAME = '(password|passwd|pwd|user_?password|user_?pw|userpw)';
const _AUTH_PASSWORD_PATTERNS = [
  // form-urlencoded: password=value
  new RegExp(`(?:^|[&\\n])${_AUTH_PASSWORD_FIELD_NAME}\\s*=`, 'i'),
  // JSON: "password": "value"
  new RegExp(`["']${_AUTH_PASSWORD_FIELD_NAME}["']\\s*:`, 'i'),
  // XML attribute: id="password" / name="userPw"
  new RegExp(`\\b(?:id|name)\\s*=\\s*["']${_AUTH_PASSWORD_FIELD_NAME}["']`, 'i'),
  // XML element: <password> or <userPw>
  new RegExp(`<${_AUTH_PASSWORD_FIELD_NAME}[\\s>]`, 'i'),
];

// Static asset extensions — paths ending in these are never login
// requests, even when the filename contains "login" (e.g.
// /static/login.css). Server-side execution extensions like .do /
// .aspx / .php are explicitly NOT in this list.
const _AUTH_STATIC_ASSET_RE = /\.(?:css|js|map|json|xml|html?|png|jpe?g|gif|svg|webp|woff2?|ttf|otf|eot|ico|mp[34]|webm|wav|ogg|pdf|zip|gz|br)$/i;

function _detectAuthSignals(req) {
  const signals = { url: false, body: false, response: false, signalsHit: [] };
  // 1) URL pattern (skip static-asset extensions)
  try {
    const u = new URL(req.url);
    if (!_AUTH_STATIC_ASSET_RE.test(u.pathname) && _AUTH_LOGIN_URL_RE.test(u.pathname)) {
      signals.url = true;
      signals.signalsHit.push(`URL path matches login pattern (${u.pathname})`);
    }
  } catch {}
  // 2) Body has password-like field (form / JSON / XML)
  const body = req.requestPostData || '';
  if (body) {
    for (const re of _AUTH_PASSWORD_PATTERNS) {
      if (re.test(body)) {
        signals.body = true;
        signals.signalsHit.push('Request body contains a password-shaped field');
        break;
      }
    }
  }
  // 3) Response sets auth-looking artifacts
  const respHeaders = req.responseHeaders || {};
  for (const [k, v] of Object.entries(respHeaders)) {
    if (k.toLowerCase() === 'set-cookie') {
      const lower = String(v).toLowerCase();
      if (/sess|auth|token|jwt|sid|jsessionid|asp\.net_sessionid/.test(lower)) {
        signals.response = true;
        signals.signalsHit.push(`Response sets auth-looking cookie (${String(v).split(';')[0]})`);
        break;
      }
    }
  }
  if (!signals.response) {
    const respBody = req.responseBody || '';
    // JWT pattern
    if (/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/.test(respBody)) {
      signals.response = true;
      signals.signalsHit.push('Response body contains a JWT');
    } else if (/"(access_?token|id_?token|refresh_?token|session_?id|auth_?token)"\s*:/i.test(respBody)) {
      signals.response = true;
      signals.signalsHit.push('Response body contains an auth-token field');
    }
  }
  const score = (signals.url ? 1 : 0) + (signals.body ? 1 : 0) + (signals.response ? 1 : 0);
  // Either signal alone is high-confidence:
  //   * URL `/login` is rarely a coincidence
  //   * a password field in the request body always means an auth attempt
  // Failed logins won't show response artifacts, so we don't require
  // them — they just bump the score.
  const isLogin = signals.url || signals.body;
  return { isLogin, signals, score };
}

function _isReqAuth(req) {
  if (req._authMarked === true) return true;
  if (req._authMarked === false) return false;
  return _detectAuthSignals(req).isLogin;
}

// Parse Set-Cookie header into { name, value, attrs:{Secure, HttpOnly, SameSite} }
function _parseSetCookies(req) {
  const headers = req.responseHeaders || {};
  const out = [];
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== 'set-cookie') continue;
    // multi-cookie: split by newline (Chrome HAR may collapse to one, we
    // also accept a single value containing only one cookie)
    const lines = Array.isArray(v) ? v : String(v).split('\n');
    for (const line of lines) {
      if (!line) continue;
      const parts = line.split(';').map(p => p.trim());
      const [first, ...attrs] = parts;
      const eq = first.indexOf('=');
      const name = eq < 0 ? first : first.slice(0, eq);
      const value = eq < 0 ? '' : first.slice(eq + 1);
      const flags = { Secure: false, HttpOnly: false, SameSite: null };
      for (const a of attrs) {
        const lower = a.toLowerCase();
        if (lower === 'secure') flags.Secure = true;
        else if (lower === 'httponly') flags.HttpOnly = true;
        else if (lower.startsWith('samesite=')) flags.SameSite = a.split('=')[1];
      }
      out.push({ name, value, flags });
    }
  }
  return out;
}

// Look for a CSRF-ish token in the request: header or body field name
// commonly used by frameworks. Returns the location string when found.
function _findCsrfToken(req) {
  const headers = req.requestHeaders || {};
  for (const k of Object.keys(headers)) {
    const lower = k.toLowerCase();
    if (lower === 'x-csrf-token' || lower === 'x-xsrf-token' ||
        lower === 'x-csrftoken' || lower === 'csrf-token') {
      return { where: 'header', name: k, value: headers[k] };
    }
  }
  const body = req.requestPostData || '';
  // form / json field
  const m = body.match(/(?:^|[&"'])([a-zA-Z_-]*csrf[a-zA-Z_-]*|authenticity_token)["']?[=:]\s*["']?([^&"'\s,}]*)/i);
  if (m) {
    return { where: 'body', name: m[1], value: m[2] };
  }
  return null;
}

// Decode the JWT payload (best-effort) for display in the Auth tab.
// Scans the response body AND every response header value (so JWTs
// delivered via Set-Cookie or custom auth headers like X-Auth-Token
// also surface here, matching what the auth detector counts as a
// signal). Returns null when no JWT-shaped string is found anywhere.
// JWT shape: header + payload are JSON objects, both base64url-encoded
// to start with `eyJ`. Signature can be empty for `alg: none`. Length
// minimums kept loose because realistic tokens vary widely (small
// headers like `{"alg":"HS256"}` decode to only 20 chars); the
// downstream JSON decoder filters out random eyJ-prefixed text by
// rejecting unparseable header/payload.
const _AUTH_JWT_RE = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/;

function _extractJwtFromResponse(req) {
  const sources = [];
  if (req.responseBody) sources.push({ where: 'response body', text: req.responseBody });
  const headers = req.responseHeaders || {};
  for (const [k, v] of Object.entries(headers)) {
    if (!v) continue;
    const lower = k.toLowerCase();
    // Set-Cookie often arrives joined as one string with newlines —
    // split so each cookie is scanned individually for clearer
    // source labelling.
    const lines = lower === 'set-cookie' && typeof v === 'string'
      ? v.split('\n').filter(Boolean)
      : [Array.isArray(v) ? v.join(', ') : String(v)];
    for (const line of lines) {
      // For Set-Cookie, label with the cookie name when we can.
      let label = `response header: ${k}`;
      if (lower === 'set-cookie') {
        const eq = line.indexOf('=');
        if (eq > 0) label = `Set-Cookie: ${line.slice(0, eq)}`;
      }
      sources.push({ where: label, text: line });
    }
  }
  const decode = (b64) => {
    try {
      const s = b64.replace(/-/g, '+').replace(/_/g, '/');
      const pad = s.length % 4 === 0 ? s : s + '='.repeat(4 - s.length % 4);
      return JSON.parse(atob(pad));
    } catch { return null; }
  };
  for (const src of sources) {
    const m = src.text.match(_AUTH_JWT_RE);
    if (!m) continue;
    const token = m[0];
    const parts = token.split('.');
    if (parts.length !== 3) continue;
    const header = decode(parts[0]);
    const payload = decode(parts[1]);
    // Need at least one parseable segment to consider it a real JWT —
    // a random `eyJ`-prefixed string in plain text shouldn't slip in.
    if (!header && !payload) continue;
    const issues = [];
    if (header && header.alg === 'none') issues.push('alg: none — token is unsigned');
    if (payload && payload.exp && payload.exp * 1000 < Date.now()) issues.push('Token is expired');
    return { token, header, payload, issues, source: src.where };
  }
  return null;
}

// Per-request store of auth test results (empty-pw / wrong-pw replays).
// Keyed by requestId; persists for the session so re-opening the tab
// doesn't lose results the user just generated.
const _authTestResults = new Map();

function renderAuth(req) {
  const container = document.getElementById('detail-auth-body');
  const tabBtn = document.querySelector('.detail-tab[data-detail="auth"]');
  if (!container) return;

  const detect = _detectAuthSignals(req);
  const isLogin = _isReqAuth(req);
  const isMarked = req._authMarked === true;
  const isUnmarked = req._authMarked === false;

  if (tabBtn) {
    tabBtn.classList.toggle('has-findings', isLogin);
    if (isLogin) tabBtn.setAttribute('data-count', '🔐');
    else tabBtn.removeAttribute('data-count');
  }

  let html = '';

  // ---- Header card: detection state + manual mark toggle ----
  html += `<div class="auth-card">`;
  if (isLogin) {
    html += `<div class="auth-state auth-state-on">🔐 Login request${isMarked ? ' (marked)' : ` (auto, score ${detect.score}/3)`}</div>`;
  } else {
    html += `<div class="auth-state auth-state-off">Not a login request${isUnmarked ? ' (unmarked)' : ` (auto, score ${detect.score}/3)`}</div>`;
  }
  if (detect.signals.signalsHit.length > 0) {
    html += `<ul class="auth-signal-list">`;
    for (const s of detect.signals.signalsHit) html += `<li>${escapeHtml(s)}</li>`;
    html += `</ul>`;
  }
  html += `<button id="auth-mark-toggle" class="btn btn-xs">${isLogin ? 'Unmark as login' : 'Mark as login'}</button>`;
  html += `</div>`;

  if (isLogin) {
    // ---- JWT analysis ----
    const jwt = _extractJwtFromResponse(req);
    html += `<div class="auth-card"><div class="auth-card-title">JWT</div>`;
    if (!jwt) {
      html += `<div class="auth-empty">No JWT found in the response body or headers.</div>`;
    } else {
      html += `<div class="auth-kv"><b>source</b>: ${escapeHtml(jwt.source)}</div>`;
      html += `<pre class="auth-jwt-block">${escapeHtml(jwt.token.slice(0, 60))}…</pre>`;
      if (jwt.header) html += `<div class="auth-kv"><b>header.alg</b>: ${escapeHtml(String(jwt.header.alg || 'unknown'))}</div>`;
      if (jwt.payload) {
        if (jwt.payload.exp) {
          const expDate = new Date(jwt.payload.exp * 1000).toISOString();
          html += `<div class="auth-kv"><b>payload.exp</b>: ${escapeHtml(expDate)}</div>`;
        }
        if (jwt.payload.iss) html += `<div class="auth-kv"><b>payload.iss</b>: ${escapeHtml(String(jwt.payload.iss))}</div>`;
        if (jwt.payload.sub) html += `<div class="auth-kv"><b>payload.sub</b>: ${escapeHtml(String(jwt.payload.sub))}</div>`;
      }
      if (jwt.issues.length > 0) {
        html += `<ul class="auth-issue-list">`;
        for (const i of jwt.issues) html += `<li>⚠️ ${escapeHtml(i)}</li>`;
        html += `</ul>`;
      } else {
        html += `<div class="auth-ok">No obvious JWT issues found.</div>`;
      }
    }
    html += `</div>`;

    // ---- Cookie flags ----
    const cookies = _parseSetCookies(req);
    html += `<div class="auth-card"><div class="auth-card-title">Set-Cookie flags</div>`;
    if (cookies.length === 0) {
      html += `<div class="auth-empty">Response did not set any cookies.</div>`;
    } else {
      html += `<table class="auth-cookie-table"><thead><tr><th>Name</th><th>Secure</th><th>HttpOnly</th><th>SameSite</th></tr></thead><tbody>`;
      for (const c of cookies) {
        const sec = c.flags.Secure ? '<span class="auth-ok-tag">✓</span>' : '<span class="auth-bad-tag">✗</span>';
        const httpOnly = c.flags.HttpOnly ? '<span class="auth-ok-tag">✓</span>' : '<span class="auth-bad-tag">✗</span>';
        // SameSite cell: when set, render the value as escaped text;
        // when missing, render the styled "none" tag. Previously the
        // fallback HTML went through escapeHtml and surfaced as literal
        // markup in the table.
        const ss = c.flags.SameSite
          ? escapeHtml(c.flags.SameSite)
          : '<span class="auth-bad-tag">none</span>';
        html += `<tr><td>${escapeHtml(c.name)}</td><td>${sec}</td><td>${httpOnly}</td><td>${ss}</td></tr>`;
      }
      html += `</tbody></table>`;
    }
    html += `</div>`;

    // ---- CSRF token ----
    const csrf = _findCsrfToken(req);
    html += `<div class="auth-card"><div class="auth-card-title">CSRF token</div>`;
    if (csrf) {
      html += `<div class="auth-ok">Found in <b>${escapeHtml(csrf.where)}</b> — <code>${escapeHtml(csrf.name)}</code> = <code>${escapeHtml(String(csrf.value).slice(0, 24))}…</code></div>`;
    } else {
      html += `<div class="auth-warn">No CSRF token detected. State-changing endpoints without CSRF protection should be reviewed for SameSite cookie reliance and origin checks.</div>`;
    }
    html += `</div>`;

    // ---- Test buttons + results ----
    html += `<div class="auth-card"><div class="auth-card-title">Tests</div>`;
    html += `<div class="auth-test-row">
      <button id="auth-test-empty-pw" class="btn btn-xs">Test: empty password</button>
      <button id="auth-test-wrong-pw" class="btn btn-xs">Test: wrong password</button>
    </div>`;
    html += `<div id="auth-test-result" class="auth-test-result"></div>`;
    html += `<div class="auth-warn-small">Tests fire one replay each. Run only against systems you're authorized to test — repeated wrong passwords may trigger account lockout on strict systems.</div>`;
    html += `</div>`;

    // Restore previous test result if any
    const prev = _authTestResults.get(req.requestId);
    if (prev) {
      // Render after setting innerHTML
    }
  }

  container.innerHTML = html;

  // Wire button handlers
  const markBtn = document.getElementById('auth-mark-toggle');
  if (markBtn) {
    markBtn.addEventListener('click', () => {
      // Toggle: marked → unmarked, unmarked → marked, undefined → opposite of auto
      if (req._authMarked === true) req._authMarked = false;
      else if (req._authMarked === false) req._authMarked = true;
      else req._authMarked = !detect.isLogin;
      renderAuth(req);
      // Refresh the row's URL cell so the 🔐 badge appears/disappears
      // immediately without waiting for a full table re-render.
      updateNetworkRowAuth(req);
    });
  }

  if (isLogin) {
    const emptyBtn = document.getElementById('auth-test-empty-pw');
    if (emptyBtn) emptyBtn.addEventListener('click', () => _runAuthTest(req, 'empty'));
    const wrongBtn = document.getElementById('auth-test-wrong-pw');
    if (wrongBtn) wrongBtn.addEventListener('click', () => _runAuthTest(req, 'wrong'));
    const resultEl = document.getElementById('auth-test-result');
    if (resultEl) {
      const prev = _authTestResults.get(req.requestId);
      if (prev) resultEl.innerHTML = _renderAuthTestResult(prev);
    }
  }
}

// Mutate the password field in the request body — handles JSON,
// form-urlencoded, and XML (incl. XML attributes like id="userPw").
// Falls back to no-op when the body shape isn't recognized.
function _mutatePasswordField(body, mode) {
  if (!body) return body;
  const replacement = mode === 'empty' ? '' : '__dtpp_wrong_' + Math.random().toString(36).slice(2, 10);
  const isPwName = (name) => /^(password|passwd|pwd|user_?password|user_?pw|userpw)$/i.test(name);

  // JSON
  try {
    const obj = JSON.parse(body);
    let touched = false;
    const recurse = (o) => {
      if (!o || typeof o !== 'object') return;
      for (const k of Object.keys(o)) {
        if (isPwName(k)) {
          o[k] = replacement;
          touched = true;
        } else if (typeof o[k] === 'object') {
          recurse(o[k]);
        }
      }
    };
    recurse(obj);
    if (touched) return JSON.stringify(obj);
  } catch {}

  // XML (Nexacro <Col id="userPw">…</Col>, generic <password>…</password>,
  // or <Col name="password">…</Col>). Element-by-attribute and naked
  // element forms covered.
  if (/<\?xml|<\s*\w+[^>]*xmlns/i.test(body)) {
    let out = body;
    let touched = false;
    // <Tag id|name="userPw">value</Tag> → replace value
    out = out.replace(
      /(<\w+[^>]*\b(?:id|name)\s*=\s*["'])([^"']+)(["'][^>]*>)([^<]*)(<\/\w+>)/gi,
      (full, openStart, attrName, openEnd, inner, close) => {
        if (isPwName(attrName)) {
          touched = true;
          return openStart + attrName + openEnd + replacement + close;
        }
        return full;
      }
    );
    // <password>value</password>
    out = out.replace(
      /<(password|passwd|pwd|user_?password|user_?pw|userpw)>([^<]*)<\/\1>/gi,
      (full, name) => { touched = true; return `<${name}>${replacement}</${name}>`; }
    );
    if (touched) return out;
  }

  // Form-urlencoded
  if (body.includes('=')) {
    const fields = body.split('&').map(p => {
      const eq = p.indexOf('=');
      if (eq < 0) return p;
      let name;
      try { name = decodeURIComponent(p.slice(0, eq).replace(/\+/g, ' ')); } catch { name = p.slice(0, eq); }
      if (isPwName(name)) {
        return p.slice(0, eq + 1) + encodeURIComponent(replacement);
      }
      return p;
    });
    return fields.join('&');
  }

  return body;
}

function _runAuthTest(originalReq, mode) {
  const resultEl = document.getElementById('auth-test-result');
  if (resultEl) resultEl.innerHTML = `<div class="auth-test-pending">Running ${escapeHtml(mode === 'empty' ? 'empty password' : 'wrong password')} test...</div>`;
  const headers = {};
  const captured = originalReq.requestHeaders || {};
  for (const [k, v] of Object.entries(captured)) {
    if (k.startsWith(':')) continue;
    if (/^(host|content-length)$/i.test(k)) continue;
    headers[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  const mutatedBody = _mutatePasswordField(originalReq.requestPostData || '', mode);
  const payload = {
    method: originalReq.method,
    url: originalReq.url,
    headers,
    body: mutatedBody || null,
  };
  // Reuse the page-context fetch path used by Replay. The result goes
  // through the message-tab response slot, which is fine here too —
  // we capture it ourselves via the polling expression.
  const callbackId = '__authtest_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const expr = `(function() {
    window['${callbackId}'] = null;
    var t0 = performance.now();
    fetch(${JSON.stringify(payload.url)}, {
      method: ${JSON.stringify(payload.method)},
      headers: ${JSON.stringify(payload.headers)},
      body: ${payload.body != null ? JSON.stringify(payload.body) : 'null'},
      credentials: 'include',
      redirect: 'follow'
    }).then(function(resp) {
      var elapsed = Math.round(performance.now() - t0);
      return resp.text().then(function(text) {
        window['${callbackId}'] = JSON.stringify({
          ok: true, status: resp.status, statusText: resp.statusText, body: text, time: elapsed
        });
      });
    }).catch(function(e) {
      window['${callbackId}'] = JSON.stringify({ ok: false, error: e.message });
    });
  })()`;
  chrome.devtools.inspectedWindow.eval(expr, () => {
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      if (attempts > 200) {
        clearInterval(poll);
        if (resultEl) resultEl.innerHTML = `<div class="auth-test-fail">Timed out (20s)</div>`;
        return;
      }
      chrome.devtools.inspectedWindow.eval(`window['${callbackId}']`, (raw) => {
        if (raw == null) return;
        clearInterval(poll);
        chrome.devtools.inspectedWindow.eval(`delete window['${callbackId}']`);
        let parsed;
        try { parsed = JSON.parse(raw); } catch { return; }
        const result = {
          mode,
          ok: parsed.ok,
          status: parsed.status,
          statusText: parsed.statusText,
          time: parsed.time,
          bodyLen: (parsed.body || '').length,
          bodyPreview: (parsed.body || '').slice(0, 200),
          originalStatus: originalReq.status,
          error: parsed.error,
        };
        _authTestResults.set(originalReq.requestId, result);
        if (resultEl) resultEl.innerHTML = _renderAuthTestResult(result);
      });
    }, 100);
  });
}

function _renderAuthTestResult(r) {
  if (!r.ok) {
    return `<div class="auth-test-fail">Test (${escapeHtml(r.mode)}) failed: ${escapeHtml(r.error || 'unknown')}</div>`;
  }
  const sameStatus = r.status === r.originalStatus;
  return `<div class="auth-test-ok">
    <div><b>Test:</b> ${escapeHtml(r.mode === 'empty' ? 'empty password' : 'wrong password')}</div>
    <div><b>Original status:</b> ${escapeHtml(String(r.originalStatus))} → <b>Test status:</b> ${escapeHtml(String(r.status))} ${escapeHtml(r.statusText || '')} ${sameStatus ? '<span class="auth-warn-tag">⚠ same as success</span>' : '<span class="auth-ok-tag">✓ different</span>'}</div>
    <div><b>Time:</b> ${escapeHtml(String(r.time))}ms · <b>Body:</b> ${escapeHtml(String(r.bodyLen))} bytes</div>
    <div class="auth-body-preview"><b>Body preview:</b> ${escapeHtml(r.bodyPreview)}${r.bodyLen > 200 ? '…' : ''}</div>
  </div>`;
}

function renderDetection(req) {
  const container = document.getElementById('detail-detection-body');
  const tabBtn = document.querySelector('.detail-tab[data-detail="detection"]');
  if (tabBtn) {
    tabBtn.classList.remove('has-findings');
    tabBtn.removeAttribute('data-count');
  }
  if (!container) return;
  const results = req.scanResults || [];
  if (results.length === 0) {
    container.innerHTML = '<div class="detail-loading">No scanner findings.</div>';
    return;
  }
  if (tabBtn) {
    tabBtn.classList.add('has-findings');
    tabBtn.dataset.count = results.length;
  }
  // Group by category, then sort categories by max severity within
  const sevOrder = { high: 0, medium: 1, low: 2, info: 3 };
  const groups = {};
  results.forEach(f => {
    if (!groups[f.category]) groups[f.category] = { badge: f.badge, items: [], maxSev: f.severity };
    groups[f.category].items.push(f);
    if (sevOrder[f.severity] < sevOrder[groups[f.category].maxSev]) {
      groups[f.category].maxSev = f.severity;
    }
  });
  const sortedCats = Object.entries(groups).sort((a, b) => sevOrder[a[1].maxSev] - sevOrder[b[1].maxSev]);
  let html = '';
  for (const [cat, g] of sortedCats) {
    const desc = DETECTION_CATEGORY_DESCRIPTIONS[cat];
    const descBlock = desc
      ? `<div class="detection-category-desc hidden">${escapeHtml(desc)}</div>`
      : '';
    const toggleHint = desc ? '<span class="detection-group-toggle">▾</span>' : '';
    html += `<div class="detection-group" data-category="${cat}">
      <div class="detection-group-header">
        <span class="scan-badge scan-badge-${cat}">${escapeHtml(g.badge)}</span>
        <span class="detection-group-count">${g.items.length} finding${g.items.length === 1 ? '' : 's'}</span>
        ${toggleHint}
      </div>
      ${descBlock}
      <div class="detection-findings">`;
    for (const f of g.items) {
      html += `<div class="detection-finding severity-${f.severity}">
        <div class="detection-finding-top">
          <span class="detection-severity sev-${f.severity}">${f.severity.toUpperCase()}</span>
          <span class="detection-location">${escapeHtml(f.location)}</span>
        </div>
        <div class="detection-evidence">${escapeHtml(f.evidence || '')}</div>
      </div>`;
    }
    html += `</div></div>`;
  }
  container.innerHTML = html;

  // Click on group header OR any finding toggles the category
  // description for that group. Clicks inside the description itself
  // are ignored so users can copy text from the guidance.
  container.addEventListener('click', _onDetectionGroupClick, { once: false });
}

function _onDetectionGroupClick(e) {
  if (e.target.closest('.detection-category-desc')) return;
  const group = e.target.closest('.detection-group');
  if (!group) return;
  const desc = group.querySelector('.detection-category-desc');
  if (!desc) return;
  desc.classList.toggle('hidden');
  const toggle = group.querySelector('.detection-group-toggle');
  if (toggle) toggle.textContent = desc.classList.contains('hidden') ? '▾' : '▴';
}

// Attribute-safe HTML escape (over and above escapeHtml since attrs
// also need to handle the quote character).
function escapeAttr(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Recursive JSON diff used by the Message tab's replay-result diff.
// Walks both trees in lock-step and emits add / remove / changed
// rows. Reused from the older Replay tab — same structure renders
// inside the new replay diff badge.
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


// ============================================================
// 1c. Intercept (Proxy Mode via Native Messaging + local MITM)
// ============================================================

let interceptActive = false;
const reqQueue = [];
const respQueue = [];
const interceptLog = [];
let selectedReqId = null;
let selectedRespId = null;
let activeSide = 'req'; // 'req' or 'resp' — shortcut target

// Request IDs that the user forwarded from the request side and is
// now waiting on a response for. When the matching response intercept
// fires we auto-switch to the response side so the user can act on it
// without manually clicking the title.
const _icptExpectingResp = new Set();
let interceptBypassRegex = null;

const icptToggleBtn = document.getElementById('icpt-toggle');
const reqQueueEl = document.getElementById('icpt-req-queue');
const respQueueEl = document.getElementById('icpt-resp-queue');
const icptLogEl = document.getElementById('icpt-log');
const reqBadge = document.getElementById('icpt-req-badge');
const respBadge = document.getElementById('icpt-resp-badge');
const reqEditorContent = document.getElementById('icpt-req-editor-content');
const respEditorContent = document.getElementById('icpt-resp-editor-content');
const reqPlaceholder = document.getElementById('icpt-req-placeholder');
const respPlaceholder = document.getElementById('icpt-resp-placeholder');
const interceptTabBtn = document.querySelector('.intercept-tab');
const icptProxyStatus = document.getElementById('icpt-proxy-status');

// Switch activeSide via the side header only — clicking inside the
// editor body would otherwise activate the side AND focus the
// textarea, so a follow-up shortcut key (F / G / D / R / A / Q) gets
// typed into the body instead of triggering the action. Limiting the
// trigger to the header keeps activation a deliberate gesture.
function setActiveIcptSide(side) {
  if (side !== 'req' && side !== 'resp') return;
  activeSide = side;
  document.querySelectorAll('.icpt-side').forEach(s => {
    s.classList.toggle('active-side', s.dataset.side === side);
  });
}
document.querySelectorAll('.icpt-side-header').forEach(header => {
  header.addEventListener('click', () => {
    const side = header.parentElement && header.parentElement.dataset.side;
    if (side) setActiveIcptSide(side);
  });
});
// Initial active side
setActiveIcptSide('req');

// Background Service Worker port connection (auto-reconnect)
let bgPort = null;
// One-shot kill switch. When the extension is reloaded/updated/disabled
// while this DevTools panel is still open, every chrome.runtime.* call
// from the now-orphaned panel throws "Extension context invalidated".
// Retrying would spin forever and flood the extension error log; close
// + reopen DevTools is the only way to recover the panel.
let bgReconnectStopped = false;

function isContextInvalidated(err) {
  const msg = (err && err.message) || (typeof err === 'string' ? err : '');
  return /Extension context invalidated|context.*invalidated/i.test(msg);
}

// Storage writes from the panel after the extension has been reloaded
// throw the same "Extension context invalidated" as chrome.runtime.*.
// Wrap them so they no-op silently in that state (and flip the kill
// switch if they ever do throw, just in case the runtime detector
// hasn't caught it yet).
function safeStorageSet(obj) {
  if (bgReconnectStopped) return;
  if (!chrome.storage || !chrome.storage.local) return;
  try {
    chrome.storage.local.set(obj);
  } catch (err) {
    if (isContextInvalidated(err)) bgReconnectStopped = true;
  }
}

function safeStorageGet(keys, callback) {
  if (bgReconnectStopped) return;
  if (!chrome.storage || !chrome.storage.local) return;
  try {
    chrome.storage.local.get(keys, callback);
  } catch (err) {
    if (isContextInvalidated(err)) bgReconnectStopped = true;
  }
}

function connectBgPort() {
  if (bgReconnectStopped) return;
  try {
    bgPort = chrome.runtime.connect({ name: `panel-${tabId}` });
  } catch (err) {
    if (isContextInvalidated(err)) {
      bgReconnectStopped = true;
      // Use console.log (not warn/error) so it doesn't surface on the
      // chrome://extensions error page — context invalidation is a
      // routine consequence of reloading the extension while DevTools
      // is open, and the user's only recovery is close + reopen
      // DevTools, which they're about to do anyway.
      console.log('[DevTools++] Extension context invalidated. Close and reopen DevTools to reconnect.');
      return;
    }
    // Unknown error — back off and try once more.
    bgPort = null;
    setTimeout(connectBgPort, 500);
    return;
  }

  bgPort.onMessage.addListener(handleBgMessage);

  bgPort.onDisconnect.addListener(() => {
    bgPort = null;
    const lastErr = chrome.runtime.lastError;
    if (lastErr && isContextInvalidated(lastErr)) {
      bgReconnectStopped = true;
      return;
    }
    // Service Worker idle-restart is the common case — wait briefly
    // and reconnect.
    setTimeout(connectBgPort, 500);
  });
}

function sendToBg(msg) {
  if (bgReconnectStopped) return;
  if (!bgPort) {
    connectBgPort();
    if (bgReconnectStopped || !bgPort) return;
  }
  try {
    bgPort.postMessage(msg);
  } catch (err) {
    if (isContextInvalidated(err)) {
      bgReconnectStopped = true;
      return;
    }
    bgPort = null;
    connectBgPort();
    if (bgReconnectStopped || !bgPort) return;
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
      updateProxyStatus('idle', 'Proxy: Stopped');
      break;

    case 'intercept_paused':
      updateProxyStatus('idle', 'Proxy: Paused');
      break;

    case 'native_disconnected':
      updateProxyStatus('error', 'Proxy: Disconnected');
      if (interceptActive) {
        stopIntercept();
      }
      break;

    case 'send_to_browser_error':
      showToast(`Send to Browser failed: ${msg.message || 'unknown'}`);
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
      handleProxyInterceptedRequest(msg);
      break;

    case 'response_captured':
      handleResponseCaptured(msg);
      break;

    case 'response_intercepted':
      handleResponseIntercepted(msg);
      break;

    case 'request_timeout': {
      // Pull method/url from the captured snapshot so the log row
      // shows what timed out instead of an empty / / time string.
      const cap = capturedRequests.get(msg.id);
      upsertInterceptLog(msg.id, {
        action: 'timeout',
        method: cap ? cap.method : '',
        url: cap ? cap.url : '',
      });
      break;
    }

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
  // Strip the redundant "Proxy: " prefix used by callers — the pill already
  // sits next to the Intercept toggle, so its context is clear.
  icptProxyStatus.textContent = text.replace(/^Proxy:\s*/, '') || text;
  icptProxyStatus.classList.remove('status-active', 'status-warn', 'status-error');
  if (state === 'active') icptProxyStatus.classList.add('status-active');
  else if (state === 'error') icptProxyStatus.classList.add('status-error');
}

function showSetupHint() {
  const setupUrl = chrome.runtime.getURL('setup.html');
  const hint = `<div style="text-align:center">
    <p style="color:#d32f2f;font-weight:600;margin-bottom:8px">Native Messaging host is not installed.</p>
    <p style="color:#666;margin-bottom:12px">Intercept requires a one-time setup.</p>
    <a href="${setupUrl}" target="_blank"
      style="display:inline-block;padding:8px 20px;background:#0078d4;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;font-size:13px">
      Open Setup Guide
    </a>
  </div>`;
  const reqPlaceholder = document.getElementById('icpt-req-placeholder');
  if (reqPlaceholder) reqPlaceholder.innerHTML = hint;
  const respPlaceholder = document.getElementById('icpt-resp-placeholder');
  if (respPlaceholder) respPlaceholder.innerHTML = hint;
}

// Convert wildcard URL filter to regex.
// Patterns are matched against host+pathname only (no protocol, no query/hash),
// so query-string contents (e.g. tracker payloads carrying the page URL) cannot
// pollute the match.
// Input:  "*.site.com, api.example.com/v1/*"
// Output: "(^[^/]*\.site\.com)|(api\.example\.com/v1/.*)" (regex string)
function urlFilterToRegex(input) {
  if (!input) return '';
  const patterns = input.split(',').map(p => p.trim()).filter(Boolean);
  if (patterns.length === 0) return '';
  const regexParts = patterns.map(p => {
    // Wildcard(*) → placeholder substitution, escape special chars, restore
    const PH = '\x00WILD\x00';
    let r = p.replace(/\*/g, PH);
    r = r.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); // Escape regex special chars
    r = r.replace(new RegExp(PH.replace(/\x00/g, '\\x00'), 'g'), '.*'); // Placeholder → .*
    // *.domain pattern: anchor to start of host (no protocol — we strip it before matching)
    if (p.startsWith('*.')) {
      r = '^[^/]*' + r.slice(2); // Remove leading .* and replace with [^/]*
    }
    return '(' + r + ')';
  });
  return regexParts.join('|');
}

// Strip protocol/query/hash so the filter only sees host + pathname.
// host includes the port when one is present; the noPort variant
// drops it. Both forms feed inGlobalScope so a port-less pattern can
// still match URLs that carry a non-standard port.
function _filterTarget(url) {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return url;
  }
}

function _filterTargetNoPort(url) {
  try {
    const u = new URL(url);
    return u.hostname + u.pathname;
  } catch {
    return url;
  }
}

// Global scope — single source of truth for URL filtering across Site Map,
// Network monitoring, and Intercept. Applied at collection time: out-of-scope
// requests never enter Site Map / Network lists, and the proxy bypasses them
// for Intercept. Empty scope = everything in scope.
// Only updated via applyGlobalScope() (Apply button / Enter / startIntercept).
let globalScope = { input: '', regex: null };

function inGlobalScope(url) {
  if (!globalScope.regex) return true;
  const withPort = _filterTarget(url);
  if (globalScope.regex.test(withPort)) return true;
  // Retry without the port so a pattern like "*.site.com/*" can match
  // URLs that happen to carry a non-standard port (site.com:48081).
  // Patterns that explicitly include ":<port>" still match through the
  // first pass on the with-port form.
  const noPort = _filterTargetNoPort(url);
  return noPort !== withPort && globalScope.regex.test(noPort);
}

// Build regex from input, update the scope, push to proxy (if intercepting),
// and refresh any views that depend on the scope.
function applyGlobalScope() {
  const input = document.getElementById('global-scope-input').value.trim();
  const pattern = urlFilterToRegex(input);
  try {
    globalScope = { input, regex: pattern ? new RegExp(pattern, 'i') : null };
  } catch {
    globalScope = { input, regex: null };
  }
  if (interceptActive) {
    sendToBg({
      type: 'update_config',
      config: {
        urlFilter: pattern,
        methodFilter: document.getElementById('icpt-method-filter').value,
      }
    });
  }
  refreshGlobalScopeButtonState();
  flashGlobalScopeApply();
  // Scope is also a view filter — re-render Network list + tree so
  // already-captured data reflects the new pattern immediately.
  // matchesSitemapFilters consults inGlobalScope via the same path.
  renderNetworkTable();
  // Selection persists across Scope changes, but the master checkbox's
  // visible-vs-selected ratio depends on which rows are visible now.
  updateSelectionUI();
  renderSitemapTree();
  // Search ANDs with Scope, so a Scope change can flip requests in or
  // out of the matched set.
  if (searchTerm) {
    recomputeSearchMatches();
    refreshAllRowDots();
    refreshSearchUI();
  }
  // Persist the last-applied pattern so the action popup can show it
  // even when DevTools is closed.
  safeStorageSet({ globalScopeInput: input });
}

// Toggle dirty highlight on the Apply button when input != applied value.
function refreshGlobalScopeButtonState() {
  const current = document.getElementById('global-scope-input').value.trim();
  const btn = document.getElementById('global-scope-apply');
  if (current !== globalScope.input) {
    btn.classList.add('scope-apply-dirty');
  } else {
    btn.classList.remove('scope-apply-dirty');
  }
}

// Brief green flash to confirm Apply succeeded.
function flashGlobalScopeApply() {
  const btn = document.getElementById('global-scope-apply');
  btn.classList.add('scope-apply-flash');
  setTimeout(() => btn.classList.remove('scope-apply-flash'), 350);
}

// Global scope bar event wiring
document.getElementById('global-scope-apply').addEventListener('click', applyGlobalScope);
document.getElementById('global-scope-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); applyGlobalScope(); }
});
document.getElementById('global-scope-input').addEventListener('input', refreshGlobalScopeButtonState);
document.getElementById('global-scope-clear').addEventListener('click', () => {
  document.getElementById('global-scope-input').value = '';
  applyGlobalScope();
});

// Apply an arbitrary scope pattern (used by the tree's Set Scope dropdown).
function applyScopePattern(pattern) {
  document.getElementById('global-scope-input').value = pattern;
  applyGlobalScope();
}

// Wildcard form of a host: drop the leftmost label for 3+ part hosts
// (www.site.com -> *.site.com), or prepend *. for 2-part hosts
// (site.com -> *.site.com). Returns null for IPs / single-label / IPv6.
function wildcardHost(host) {
  if (!host) return null;
  if (/^[\d.]+$/.test(host)) return null;
  if (host.includes(':')) return null;
  const parts = host.split('.');
  if (parts.length < 2) return null;
  if (parts.length === 2) return `*.${host}`;
  return `*.${parts.slice(1).join('.')}`;
}

// Handle intercepted request from the proxy
function handleProxyInterceptedRequest(msg) {
  // Snapshot the request the moment it arrives, before any bypass
  // logic. Stored so the log strip can re-display the request / pair
  // after it's been resolved. Even bypassed requests get captured so
  // a "bypassed" log row stays inspectable.
  capturedRequests.set(msg.id, {
    method: msg.method,
    url: msg.url,
    headers: msg.headers || {},
    body: msg.body || '',
  });
  if (capturedRequests.size > 200) {
    const oldest = capturedRequests.keys().next().value;
    capturedRequests.delete(oldest);
  }
  // A new live intercept means whatever captured pair was on display
  // is now stale — drop the viewing flag so the editor's action
  // buttons re-enable.
  if (viewingCapturedId) _clearCapturedViewing();

  const methodFilter = document.getElementById('icpt-method-filter').value;

  // Method filter
  if (methodFilter && msg.method !== methodFilter) {
    sendInterceptDecision(msg.id, { action: 'forward' });
    upsertInterceptLog(msg.id, { action: 'bypassed', method: msg.method, url: msg.url });
    return;
  }
  // Global scope gate (defense in depth — the proxy already filters server-side
  // via update_config, but catches any races where a request is dispatched
  // before the config update lands)
  if (!inGlobalScope(msg.url)) {
    sendInterceptDecision(msg.id, { action: 'forward' });
    upsertInterceptLog(msg.id, { action: 'bypassed', method: msg.method, url: msg.url });
    return;
  }
  // Bypass rules
  if (interceptBypassRegex && interceptBypassRegex.test(msg.url)) {
    sendInterceptDecision(msg.id, { action: 'forward' });
    upsertInterceptLog(msg.id, { action: 'bypassed', method: msg.method, url: msg.url });
    return;
  }

  // Add to request queue
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

  // Same reasoning as the request side: a new live intercept means
  // any captured-pair view is now stale.
  if (viewingCapturedId) _clearCapturedViewing();

  // Add to response queue. requestId is the original request id (no
  // _resp suffix) — we keep it on the item so the response decision
  // can update the right log row that the request side opened.
  const newItem = {
    id: msg.id,
    requestId: msg.requestId || msg.id.replace(/_resp$/, ''),
    method: msg.method,
    url: msg.url,
    statusCode: msg.statusCode,
    headers: msg.headers || {},
    body: body,
    bodyTruncated: msg.bodyTruncated,
  };
  respQueue.push(newItem);
  // Auto-activate the response side and select this item when the
  // user just forwarded the matching request — they pressed F (or G)
  // on the request side and the response is what they want to act on
  // next, so pulling focus here saves a click. Otherwise (response
  // for a request someone else forwarded, or a different selection)
  // honor whatever the user is currently doing.
  const expected = _icptExpectingResp.has(newItem.requestId);
  if (expected) {
    _icptExpectingResp.delete(newItem.requestId);
    setActiveIcptSide('resp');
    selectedRespId = newItem.id;
    showRespEditor(newItem);
  } else if (!selectedRespId) {
    selectedRespId = newItem.id;
    showRespEditor(newItem);
  }
  renderRespQueue();
}

// Editor tab switching (scoped by side)
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

// Request side buttons
document.getElementById('icpt-req-forward').addEventListener('click', () => { activeSide = 'req'; forwardSelected(false); });
document.getElementById('icpt-req-forward-modified').addEventListener('click', () => { activeSide = 'req'; forwardSelected(true); });
document.getElementById('icpt-req-drop').addEventListener('click', () => { activeSide = 'req'; dropSelected(); });
document.getElementById('icpt-req-mock').addEventListener('click', () => { activeSide = 'req'; mockResponseSelected(); });

// Response side buttons
document.getElementById('icpt-resp-forward').addEventListener('click', () => { activeSide = 'resp'; forwardSelected(false); });
document.getElementById('icpt-resp-forward-modified').addEventListener('click', () => { activeSide = 'resp'; forwardSelected(true); });
document.getElementById('icpt-resp-drop').addEventListener('click', () => { activeSide = 'resp'; dropSelected(); });

// Format toggle (Raw / Pretty) — reformats the body portion of the
// raw textarea in place. Headers stay unchanged. Switching after the
// user has edited the body is OK; if the body isn't valid JSON the
// toggle is a no-op rather than a destructive parse error.
document.querySelectorAll('.icpt-format-toggle').forEach(group => {
  const target = group.dataset.target; // 'req' | 'resp'
  group.querySelectorAll('.icpt-fmt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      group.querySelectorAll('.icpt-fmt-btn').forEach(b => {
        b.classList.toggle('active', b === btn);
      });
      const fmt = btn.dataset.fmt;
      // Apply to whichever editable raw textarea is on this side.
      // Request side has Edit + Mock — toggle whichever pane is
      // active (the user only sees one at a time).
      if (target === 'req') {
        const activePane = reqEditorContent.querySelector('.icpt-ed-pane.active');
        const ta = activePane ? activePane.querySelector('textarea') : null;
        if (ta) {
          ta.value = _formatIcptRaw(ta.value, fmt);
          // ta.id is icpt-{req|mock}-raw → derive sync key from it.
          _syncIcptRawDisplay(ta.id.replace(/^icpt-(.+)-raw$/, '$1'));
        }
      } else {
        const ta = document.getElementById('icpt-resp-raw');
        if (ta) {
          ta.value = _formatIcptRaw(ta.value, fmt);
          _syncIcptRawDisplay('resp');
        }
      }
    });
  });
});

// Common buttons
document.getElementById('icpt-forward-all').addEventListener('click', forwardAll);
document.getElementById('icpt-drop-all').addEventListener('click', dropAll);
document.getElementById('icpt-clear-log').addEventListener('click', () => {
  interceptLog.length = 0;
  capturedRequests.clear();
  capturedResponses.clear();
  if (viewingCapturedId) _clearCapturedViewing();
  renderInterceptLog();
});
document.getElementById('icpt-bypass-apply').addEventListener('click', applyBypassRule);

// Toggle the auto-forward / bypass rules row (collapsed by default).
document.getElementById('icpt-rules-toggle').addEventListener('click', () => {
  const bar = document.querySelector('.icpt-rules-bar');
  bar.classList.toggle('hidden');
});

// Intercept keyboard shortcuts (F/G/D/R/A/Q) — activeSide based
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

// Auto-apply on extension checkbox change
document.querySelectorAll('.icpt-ext-check input[data-ext]').forEach(cb => {
  cb.addEventListener('change', applyBypassRule);
});

function buildBypassPattern() {
  // Collect checked extensions
  const exts = [];
  document.querySelectorAll('.icpt-ext-check input[data-ext]:checked').forEach(cb => {
    exts.push(cb.dataset.ext);
  });
  // Additional user regex
  const userVal = document.getElementById('icpt-bypass-input').value.trim();

  const parts = [];
  if (exts.length > 0) {
    // woff → woff|woff2 conversion
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
  if (interceptActive) {
    sendToBg({
      type: 'update_config',
      config: { bypassPatterns: combined ? [combined] : [] }
    });
  }
}

function startIntercept() {
  // Apply global scope before setting interceptActive — applyGlobalScope()
  // skips the update_config push when interceptActive is false, which is
  // correct here because we send the scope in the intercept_on config below.
  applyGlobalScope();
  applyBypassRule();

  interceptActive = true;
  icptToggleBtn.textContent = 'Intercept ON';
  icptToggleBtn.className = 'btn btn-intercept-on';
  interceptTabBtn.classList.add('intercepting');
  updateProxyStatus('idle', 'Proxy: Connecting...');

  const combined = buildBypassPattern();
  const interceptResp = document.getElementById('icpt-resp').checked;
  const methodFilter = document.getElementById('icpt-method-filter').value;
  sendToBg({
    type: 'intercept_on',
    config: {
      port: 8899,
      bypassPatterns: combined ? [combined] : [],
      interceptResponse: interceptResp,
      urlFilter: urlFilterToRegex(globalScope.input),
      methodFilter: methodFilter,
    }
  });
}

// Real-time update when Response checkbox changes
document.getElementById('icpt-resp').addEventListener('change', (e) => {
  if (interceptActive) {
    sendToBg({
      type: 'update_config',
      config: { interceptResponse: e.target.checked }
    });
  }
});

// Method filter syncs to proxy immediately on change. Global scope requires
// explicit Apply (button or Enter) so the user always knows what's active.
document.getElementById('icpt-method-filter').addEventListener('change', () => {
  if (interceptActive) {
    sendToBg({
      type: 'update_config',
      config: {
        urlFilter: urlFilterToRegex(globalScope.input),
        methodFilter: document.getElementById('icpt-method-filter').value,
      }
    });
  }
});

function stopIntercept() {
  interceptActive = false;
  icptToggleBtn.textContent = 'Intercept OFF';
  icptToggleBtn.className = 'btn btn-intercept-off';
  interceptTabBtn.classList.remove('intercepting');

  // Forward all remaining queue items
  forwardAll();

  sendToBg({ type: 'intercept_off' });
  updateProxyStatus('idle', 'Proxy: Stopped');
}

function sendInterceptDecision(id, decision) {
  sendToBg({ type: 'decision', id, ...decision });
}

// ---- Queue Rendering ----
function updateBadges() {
  reqBadge.textContent = reqQueue.length;
  respBadge.textContent = respQueue.length;
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
      // User picked a live queue item — drop any captured-view state
      // so the action buttons re-enable for the live intercept.
      if (viewingCapturedId) _clearCapturedViewing();
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

// ---- Editor Display ----
// Build a raw HTTP request string from a queue item. Uses HTTP/1.1 since
// browser→proxy is always h1.1 regardless of origin's wire protocol.
function _buildIcptRawRequest(item) {
  const method = item.method || 'GET';
  let path = '/';
  let host = '';
  try {
    const u = new URL(item.url);
    path = (u.pathname || '/') + (u.search || '');
    host = u.host;
  } catch {}
  const headers = item.headers || {};
  const lines = [`${method} ${path} HTTP/1.1`];
  if (host && !_findHeaderCI(headers, 'host')) lines.push(`Host: ${host}`);
  for (const [k, v] of Object.entries(headers)) {
    if (k.startsWith(':')) continue;
    lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
  }
  return lines.join('\n') + '\n\n' + (item.postData || item.body || '');
}

function _buildIcptRawResponse(item) {
  const status = item.statusCode || 200;
  const headers = item.headers || {};
  const lines = [`HTTP/1.1 ${status}`];
  for (const [k, v] of Object.entries(headers)) {
    if (k.startsWith(':')) continue;
    lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
  }
  return lines.join('\n') + '\n\n' + (item.body || '');
}

// Parse raw HTTP request text → { method, url, headers, body }. URL is
// resolved against `fallbackUrl` so users only need to edit the path.
function _parseIcptRawRequest(text, fallbackUrl) {
  if (!text) return null;
  const blank = text.indexOf('\n\n');
  const headerPart = blank >= 0 ? text.slice(0, blank) : text;
  const body = blank >= 0 ? text.slice(blank + 2) : '';
  const lines = headerPart.split('\n');
  const m = (lines[0] || '').match(/^(\S+)\s+(\S+)\s+HTTP\/[\d.]+/);
  if (!m) return null;
  const method = m[1];
  const path = m[2];
  let url;
  try { url = new URL(path, fallbackUrl).href; } catch { url = path; }
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const k = line.slice(0, colon).trim();
    const v = line.slice(colon + 1).trim();
    if (k && !k.startsWith(':')) headers[k] = v;
  }
  return { method, url, headers, body };
}

// Parse raw HTTP response text → { statusCode, headers, body }.
function _parseIcptRawResponse(text) {
  if (!text) return null;
  const blank = text.indexOf('\n\n');
  const headerPart = blank >= 0 ? text.slice(0, blank) : text;
  const body = blank >= 0 ? text.slice(blank + 2) : '';
  const lines = headerPart.split('\n');
  const m = (lines[0] || '').match(/^HTTP\/[\d.]+\s+(\d+)/);
  const statusCode = m ? parseInt(m[1], 10) : 200;
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const k = line.slice(0, colon).trim();
    const v = line.slice(colon + 1).trim();
    if (k && !k.startsWith(':')) headers[k] = v;
  }
  return { statusCode, headers, body };
}

// Apply pretty / raw formatting to the body portion of an HTTP message,
// leaving headers untouched. JSON is the only target — anything else
// passes through.
function _formatIcptRaw(text, mode) {
  if (!text) return text;
  const blank = text.indexOf('\n\n');
  if (blank < 0) return text;
  const headerPart = text.slice(0, blank);
  const body = text.slice(blank + 2);
  if (!body.trim()) return text;
  try {
    const parsed = JSON.parse(body);
    const formatted = mode === 'pretty'
      ? JSON.stringify(parsed, null, 2)
      : JSON.stringify(parsed);
    return headerPart + '\n\n' + formatted;
  } catch { return text; }
}

// Push the textarea's current value into the colored <pre> overlay so
// the user sees the syntax-highlighted render. Reuses _renderRawHtml
// (the same colorizer Monitor's Message tab uses), keeping the visual
// language consistent across the two surfaces.
function _syncIcptRawDisplay(name) {
  const ta = document.getElementById(`icpt-${name}-raw`);
  const pre = document.getElementById(`icpt-${name}-raw-display`);
  if (!ta || !pre) return;
  // Append a trailing space when the text ends with a newline so the
  // pre allocates a line for it — keeps the textarea's last-line
  // height aligned with the pre below it.
  const v = ta.value;
  const display = v.endsWith('\n') ? v + ' ' : v;
  pre.innerHTML = _renderRawHtml(display);
  // Keep the colored render aligned with the textarea's scroll
  // position so the visible character at any offset overlaps with
  // its colored counterpart.
  pre.scrollTop = ta.scrollTop;
  pre.scrollLeft = ta.scrollLeft;
}

// Attached once at script init. Each Intercept raw editor wraps a
// transparent textarea over a colored <pre>; input + scroll on the
// textarea drive the pre to mirror it.
['req', 'resp', 'mock'].forEach(name => {
  const ta = document.getElementById(`icpt-${name}-raw`);
  const pre = document.getElementById(`icpt-${name}-raw-display`);
  if (!ta || !pre) return;
  ta.addEventListener('input', () => _syncIcptRawDisplay(name));
  ta.addEventListener('scroll', () => {
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  });
});

function showReqEditor(item) {
  reqPlaceholder.style.display = 'none';
  reqEditorContent.classList.remove('hidden');
  document.getElementById('icpt-req-raw').value = _buildIcptRawRequest(item);
  _syncIcptRawDisplay('req');
  // Reset format toggle to Raw on each new item.
  reqEditorContent.querySelectorAll('.icpt-format-toggle .icpt-fmt-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.fmt === 'raw');
  });
  // Default Mock textarea — user-editable starting point.
  const mockTa = document.getElementById('icpt-mock-raw');
  if (!mockTa.value) {
    mockTa.value = 'HTTP/1.1 200 OK\nContent-Type: application/json\n\n{}';
  }
  _syncIcptRawDisplay('mock');
  // Switch to Edit tab
  reqEditorContent.querySelectorAll('.icpt-ed-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.ictab === 'req-edit');
  });
  reqEditorContent.querySelectorAll('.icpt-ed-pane').forEach(p => {
    p.classList.toggle('active', p.id === 'icpt-tab-req-edit');
  });
}

function showRespEditor(item) {
  respPlaceholder.style.display = 'none';
  respEditorContent.classList.remove('hidden');
  document.getElementById('icpt-resp-raw').value = _buildIcptRawResponse(item);
  _syncIcptRawDisplay('resp');
  respEditorContent.querySelectorAll('.icpt-format-toggle .icpt-fmt-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.fmt === 'raw');
  });
}

function hideReqEditor() {
  selectedReqId = null;
  reqEditorContent.classList.add('hidden');
  reqPlaceholder.style.display = '';
  // Wipe Mock so the next selection gets the default seed
  const mockTa = document.getElementById('icpt-mock-raw');
  if (mockTa) mockTa.value = '';
  _syncIcptRawDisplay('mock');
}

function hideRespEditor() {
  selectedRespId = null;
  respEditorContent.classList.add('hidden');
  respPlaceholder.style.display = '';
}

// ---- Queue Operations ----
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

// ---- Actions (based on activeSide) ----
function forwardSelected(modified) {
  if (activeSide === 'req') {
    const item = reqQueue.find(q => q.id === selectedReqId);
    if (!item) return;
    if (modified) {
      const raw = document.getElementById('icpt-req-raw').value;
      const parsed = _parseIcptRawRequest(raw, item.url);
      if (!parsed) {
        showToast('Could not parse the raw request — check the request line and headers');
        return;
      }
      sendInterceptDecision(item.id, {
        action: 'forward_modified',
        method: parsed.method,
        url: parsed.url,
        headers: parsed.headers,
        body: parsed.body,
      });
      upsertInterceptLog(item.id, { action: 'modified', method: parsed.method, url: parsed.url });
    } else {
      sendInterceptDecision(item.id, { action: 'forward' });
      upsertInterceptLog(item.id, { action: 'forwarded', method: item.method, url: item.url });
    }
    // Mark this request so that when the response intercept fires we
    // can auto-switch the active side. Both Forward and Forward
    // Modified produce a wire-level request we expect a response for;
    // Drop / Mock don't, so they skip this.
    _icptExpectingResp.add(item.id);
    removeFromReqQueue(item.id);
  } else {
    const item = respQueue.find(q => q.id === selectedRespId);
    if (!item) return;
    const reqId = item.requestId;
    if (modified) {
      const raw = document.getElementById('icpt-resp-raw').value;
      const parsed = _parseIcptRawResponse(raw);
      if (!parsed) {
        showToast('Could not parse the raw response — check the status line and headers');
        return;
      }
      sendInterceptDecision(item.id, {
        action: 'forward_modified',
        responseStatus: parsed.statusCode,
        headers: parsed.headers,
        body: parsed.body,
      });
      capturedResponses.set(reqId, {
        statusCode: parsed.statusCode, headers: parsed.headers,
        body: parsed.body, bodyLength: (parsed.body || '').length,
      });
      upsertInterceptLog(reqId, { responseAction: 'modified', responseStatus: parsed.statusCode });
    } else {
      sendInterceptDecision(item.id, { action: 'forward' });
      capturedResponses.set(reqId, { statusCode: item.statusCode, headers: item.headers, body: item.body, bodyTruncated: item.bodyTruncated });
      upsertInterceptLog(reqId, { responseAction: 'forwarded', responseStatus: item.statusCode });
    }
    removeFromRespQueue(item.id);
    // After resolving a response, swing focus back to the request side
    // when something's waiting there — completes the alternating
    // request ↔ response loop. If the request queue is empty we leave
    // the active side alone so the next response (if any was queued)
    // can stay in focus.
    if (reqQueue.length > 0) {
      setActiveIcptSide('req');
    }
  }
}

function dropSelected() {
  if (activeSide === 'req') {
    const item = reqQueue.find(q => q.id === selectedReqId);
    if (!item) return;
    sendInterceptDecision(item.id, { action: 'drop' });
    upsertInterceptLog(item.id, { action: 'dropped', method: item.method, url: item.url });
    removeFromReqQueue(item.id);
  } else {
    const item = respQueue.find(q => q.id === selectedRespId);
    if (!item) return;
    const reqId = item.requestId;
    sendInterceptDecision(item.id, { action: 'drop' });
    upsertInterceptLog(reqId, { responseAction: 'dropped' });
    removeFromRespQueue(item.id);
  }
}

function mockResponseSelected() {
  const item = reqQueue.find(q => q.id === selectedReqId);
  if (!item) return;
  const raw = document.getElementById('icpt-mock-raw').value;
  const parsed = _parseIcptRawResponse(raw);
  if (!parsed) {
    showToast('Could not parse the mock response — check the status line and headers');
    return;
  }
  // Default Content-Type if user omitted one — JSON if body parses,
  // text/plain otherwise.
  const hasCT = Object.keys(parsed.headers).some(k => k.toLowerCase() === 'content-type');
  if (!hasCT) {
    try { JSON.parse(parsed.body); parsed.headers['Content-Type'] = 'application/json'; }
    catch { parsed.headers['Content-Type'] = 'text/plain'; }
  }
  // Convert headers map to the array shape proxy expects for mock.
  const headersArr = Object.entries(parsed.headers).map(([name, value]) => ({ name, value }));
  sendInterceptDecision(item.id, {
    action: 'mock',
    responseStatus: parsed.statusCode,
    responseHeaders: headersArr,
    responseBody: parsed.body,
  });
  capturedResponses.set(item.id, {
    statusCode: parsed.statusCode, headers: parsed.headers, body: parsed.body,
  });
  upsertInterceptLog(item.id, {
    action: 'mocked', method: item.method, url: item.url, responseStatus: parsed.statusCode,
  });
  removeFromReqQueue(item.id);
}

function forwardAll() {
  while (reqQueue.length > 0) {
    const item = reqQueue.shift();
    sendInterceptDecision(item.id, { action: 'forward' });
    upsertInterceptLog(item.id, { action: 'forwarded', method: item.method, url: item.url });
  }
  while (respQueue.length > 0) {
    const item = respQueue.shift();
    sendInterceptDecision(item.id, { action: 'forward' });
    capturedResponses.set(item.requestId, { statusCode: item.statusCode, headers: item.headers, body: item.body, bodyTruncated: item.bodyTruncated });
    upsertInterceptLog(item.requestId, { responseAction: 'forwarded', responseStatus: item.statusCode });
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
    upsertInterceptLog(item.id, { action: 'dropped', method: item.method, url: item.url });
  }
  while (respQueue.length > 0) {
    const item = respQueue.shift();
    sendInterceptDecision(item.id, { action: 'drop' });
    upsertInterceptLog(item.requestId, { responseAction: 'dropped' });
  }
  hideReqEditor();
  hideRespEditor();
  renderReqQueue();
  renderRespQueue();
}

// Response + request capture history (id → captured payload). Used by
// the log strip — clicking a log row replays both into the editors so
// the user can re-inspect a request/response pair after it's been
// resolved (forwarded / dropped / etc.). Both maps are bounded at 200
// entries so a long monitoring session doesn't accumulate unbounded
// data.
const capturedResponses = new Map();
const capturedRequests = new Map();
// While a captured pair is on display in the editors (not a live
// pending intercept) this holds the log id. Auto-cleared when a new
// pending intercept arrives or when the user clicks a queue item.
let viewingCapturedId = null;

function handleResponseCaptured(msg) {
  capturedResponses.set(msg.id, {
    statusCode: msg.statusCode,
    headers: msg.headers,
    body: msg.body,
    bodyLength: msg.bodyLength,
    bodyTruncated: msg.bodyTruncated,
  });
  // Record response in log
  const logEntry = interceptLog.find(l => l.id === msg.id);
  if (logEntry) {
    logEntry.responseStatus = msg.statusCode;
    renderInterceptLog();
  }
  // Keep max 200 entries
  if (capturedResponses.size > 200) {
    const oldest = capturedResponses.keys().next().value;
    capturedResponses.delete(oldest);
  }
}

// Upsert a log entry keyed by request id. Each captured request /
// response cycle owns ONE log row — `action` records the request-side
// decision (forwarded / modified / dropped / mocked / bypassed), and
// later events (response intercept decision, response capture) update
// `responseAction` / `responseStatus` on the same row instead of
// adding a duplicate. A request without an id (shouldn't happen in
// practice) still gets a one-shot row by falling back to a synthetic
// key.
function upsertInterceptLog(id, fields) {
  if (!id) {
    interceptLog.unshift({ id: null, time: new Date(), ...fields });
  } else {
    const existing = interceptLog.find(l => l.id === id);
    if (existing) {
      Object.assign(existing, fields);
    } else {
      interceptLog.unshift({ id, time: new Date(), ...fields });
    }
  }
  if (interceptLog.length > 200) interceptLog.pop();
  renderInterceptLog();
}

function renderInterceptLog() {
  icptLogEl.innerHTML = interceptLog.slice(0, 100).map((l) => {
    const cls = 'log-' + (l.action || 'pending');
    let shortUrl;
    try { shortUrl = new URL(l.url || '').pathname; } catch { shortUrl = l.url || ''; }
    const time = l.time.toLocaleTimeString(undefined, { hour12: false });
    const hasReq = l.id && capturedRequests.has(l.id);
    const hasResp = l.id && capturedResponses.has(l.id);
    // Status column: shows the response decision in priority order —
    // explicit "DROP" if the response was dropped, the response code
    // (with ✎ prefix if the response was modified) if known, "—"
    // otherwise (request dropped, or response not yet captured).
    let statusCell;
    if (l.responseAction === 'dropped') {
      statusCell = `<span class="log-resp-drop">DROP</span>`;
    } else if (l.responseStatus != null) {
      const s = l.responseStatus;
      const color = s < 400 ? '#0b7a3e' : '#d32f2f';
      const mark = l.responseAction === 'modified' ? '✎' : '';
      statusCell = `<span class="log-resp-status" style="color:${color}">${mark}${s}</span>`;
    } else {
      statusCell = `<span class="log-resp-status log-resp-none">—</span>`;
    }
    // Any log row with a captured request OR response is clickable;
    // the click handler populates whichever sides have data.
    const clickAttr = (hasReq || hasResp)
      ? `data-log-id="${escapeAttr(l.id)}" style="cursor:pointer"`
      : '';
    const isViewing = l.id && l.id === viewingCapturedId;
    return `<div class="icpt-log-item${isViewing ? ' viewing' : ''}" ${clickAttr}>
      <span class="log-action ${cls}">${l.action || ''}</span>
      <span class="log-method">${escapeHtml(l.method || '')}</span>
      ${statusCell}
      <span class="log-url" title="${escapeAttr(l.url || '')}">${escapeHtml(shortUrl)}</span>
      <span class="log-time">${time}</span>
    </div>`;
  }).join('');
}

// Click on a log row → re-display the captured request + response in
// their respective editors. Blocked while there's an unresolved live
// intercept queued so the user doesn't lose in-progress edits or
// accidentally drop a held connection by switching what the editor
// shows.
icptLogEl.addEventListener('click', (e) => {
  const item = e.target.closest('[data-log-id]');
  if (!item) return;
  if (reqQueue.length > 0 || respQueue.length > 0) {
    showToast('Resolve pending intercepts first (Forward / Drop / Mock)');
    return;
  }
  _viewCapturedById(item.dataset.logId);
});

function _viewCapturedById(id) {
  const req = capturedRequests.get(id);
  const resp = capturedResponses.get(id);
  if (!req && !resp) return;
  viewingCapturedId = id;
  // Mark editors as read-only (CSS hides action buttons + banner +
  // resp topbar/status in this mode).
  reqEditorContent.classList.add('icpt-viewing-captured');
  respEditorContent.classList.add('icpt-viewing-captured');
  if (req) {
    showReqEditor({
      id, reqType: 'captured',
      method: req.method, url: req.url, headers: req.headers, postData: req.body,
    });
  } else {
    hideReqEditor();
  }
  if (resp) {
    showRespEditor({
      id, method: req ? req.method : '', url: req ? req.url : '',
      statusCode: resp.statusCode, headers: resp.headers, body: resp.body,
      bodyTruncated: resp.bodyTruncated,
    });
  } else {
    hideRespEditor();
  }
  // After populating the editors, lock the inputs. CSS readonly/
  // disabled visuals + JS attribute set together so users can't
  // accidentally edit fields they're only meant to inspect.
  _setIcptEditorsReadonly(true);
  // Re-render so the active log row gets the .viewing highlight.
  renderInterceptLog();
}

function _clearCapturedViewing() {
  viewingCapturedId = null;
  if (reqEditorContent) reqEditorContent.classList.remove('icpt-viewing-captured');
  if (respEditorContent) respEditorContent.classList.remove('icpt-viewing-captured');
  _setIcptEditorsReadonly(false);
  renderInterceptLog();
}

// User clicked X on the viewing banner → exit viewing mode AND wipe
// the captured-view content from both editors so they fall back to
// their normal placeholder state. (If a queue item was selected
// before viewing, the natural next action is to live-intercept
// again, not to re-show whatever was left over.)
function _exitViewingExplicit() {
  _clearCapturedViewing();
  hideReqEditor();
  hideRespEditor();
}

// Walk the textareas inside the Intercept editors and toggle their
// inert state. readOnly keeps the textarea selectable (so the user
// can copy text out) but blocks edits. Format toggle buttons stay
// active so they can still switch between raw / pretty views even
// in read-only mode. Action buttons (Forward / Drop / etc.) are
// hidden via CSS already.
function _setIcptEditorsReadonly(on) {
  [reqEditorContent, respEditorContent].forEach(ed => {
    if (!ed) return;
    ed.querySelectorAll('textarea').forEach(el => { el.readOnly = on; });
  });
}

// Close (X) on the viewing banner — delegated so it works for both
// banners (request and response side) without per-element listeners.
document.querySelectorAll('.icpt-viewing-close').forEach(btn => {
  btn.addEventListener('click', _exitViewingExplicit);
});

// ============================================================
// Utility Functions
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
  // data: URIs — strip the payload and just label by mime type so the
  // table doesn't try to render a 100KB base64 string in one cell.
  if (typeof url === 'string' && url.startsWith('data:')) {
    const m = url.match(/^data:([^;,]+)/);
    return m ? `[data URI] ${m[1]}` : '[data URI]';
  }
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

// Resizable split gutters: drag to resize the next sibling pane.
function setupSplitGutter(gutter) {
  const isVertical = gutter.classList.contains('split-gutter-v');
  // Direction: by default the gutter resizes the *next* sibling, with
  // the previous sibling absorbing leftover space via flex-grow. Some
  // layouts (e.g. the Network tree pane on the left) need the
  // opposite — set data-resize="prev" to flip which side gets sized
  // and which side absorbs.
  const resizesPrev = gutter.dataset.resize === 'prev';
  gutter.addEventListener('mousedown', (e) => {
    const target = resizesPrev ? gutter.previousElementSibling : gutter.nextElementSibling;
    if (!target || target.classList.contains('hidden')) return;
    e.preventDefault();
    const rect = target.getBoundingClientRect();
    const startSize = isVertical ? rect.height : rect.width;
    const startPos = isVertical ? e.clientY : e.clientX;
    gutter.classList.add('dragging');
    document.body.style.cursor = isVertical ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';

    function onMove(ev) {
      const cur = isVertical ? ev.clientY : ev.clientX;
      // Default direction: dragging away from the target shrinks it.
      // Prev mode reverses the sign so dragging toward the target's
      // side (right, when target is the left pane) grows it.
      const delta = cur - startPos;
      const newSize = Math.max(80, resizesPrev ? startSize + delta : startSize - delta);
      target.style.flex = `0 0 ${newSize}px`;
      if (isVertical) {
        target.style.maxHeight = 'none';
      }
    }
    function onUp() {
      gutter.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
document.querySelectorAll('.split-gutter').forEach(setupSplitGutter);

// Persisted "Auto-start" toggle — when checked, Network monitoring
// flips on as soon as this panel opens. Default off, so existing
// users see no behavior change.
(function initAutoStartMonitoring() {
  const checkbox = document.getElementById('auto-start-monitoring');
  if (!checkbox) return;
  safeStorageGet(['autoStartMonitoring'], (result) => {
    const enabled = !!(result && result.autoStartMonitoring);
    checkbox.checked = enabled;
    if (enabled && !networkMonitoring) {
      startNetworkMonitoring();
      // The page may already be loaded — without HAR replay the table
      // would stay empty until the next request fires. getHAR backfills
      // everything Chrome already captured.
      replayExistingNetworkHAR();
    }
  });
  checkbox.addEventListener('change', (e) => {
    safeStorageSet({ autoStartMonitoring: e.target.checked });
  });
})();

