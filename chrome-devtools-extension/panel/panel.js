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
let sitemapSelectedNode = null; // { host, path }
let targetHost = null;
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
    addToSitemap(_sitemapPending.shift());
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
    updateSitemapStats();
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
  updateSitemapStats();
});
const sitemapTypeFilter = document.getElementById('sitemap-type-filter');
const sitemapStatusFilter = document.getElementById('sitemap-status-filter');
const sitemapTreeEl = document.getElementById('sitemap-tree');
const sitemapDetail = document.getElementById('sitemap-detail');
const sitemapDetailPath = document.getElementById('sitemap-detail-path');
const sitemapDetailList = document.getElementById('sitemap-detail-list');
const sitemapStats = document.getElementById('sitemap-stats');

const sitemapPageScanBtn = document.getElementById('sitemap-page-scan');
sitemapPageScanBtn.addEventListener('click', runPageScan);

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

function updatePageScanButton() {
  if (sitemapSelectedNode && targetHost && sitemapSelectedNode.host !== targetHost) {
    sitemapPageScanBtn.disabled = true;
    sitemapPageScanBtn.title = 'Page Scan is only available for the target host';
  } else {
    sitemapPageScanBtn.disabled = false;
    sitemapPageScanBtn.title = '';
  }
}
document.getElementById('sitemap-clear').addEventListener('click', () => {
  Object.keys(sitemapTree).forEach(k => delete sitemapTree[k]);
  sitemapSelectedNode = null;
  expandedNodes.clear();
  _sitemapPending.length = 0;
  renderSitemapTree();
  sitemapDetail.classList.add('hidden');
  updateSitemapStats();
});
document.getElementById('sitemap-detail-close').addEventListener('click', () => {
  sitemapSelectedNode = null;
  sitemapDetail.classList.add('hidden');
  renderSitemapTree();
});
sitemapTypeFilter.addEventListener('change', renderSitemapTree);
sitemapStatusFilter.addEventListener('change', renderSitemapTree);

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

function runPageScan() {
  const btn = document.getElementById('sitemap-page-scan');
  btn.textContent = 'Scanning...';
  btn.disabled = true;

  const expression = `
    (function() {
      var results = { links: [], forms: [], scripts: [] };

      // Links: <a href>
      document.querySelectorAll('a[href]').forEach(function(a) {
        var href = a.href;
        if (!href || href.startsWith('javascript:') || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
        results.links.push(href);
      });

      // Forms: <form>
      document.querySelectorAll('form').forEach(function(form) {
        var fields = [];
        form.querySelectorAll('input, select, textarea').forEach(function(el) {
          var name = el.name || el.id || '';
          if (!name) return;
          fields.push({
            tag: el.tagName.toLowerCase(),
            type: el.type || 'text',
            name: name,
            value: el.value || '',
            hidden: el.type === 'hidden'
          });
        });
        results.forms.push({
          action: form.action || window.location.href,
          method: (form.method || 'GET').toUpperCase(),
          id: form.id || '',
          fields: fields
        });
      });

      // Scripts: <script src>
      document.querySelectorAll('script[src]').forEach(function(s) {
        results.scripts.push(s.src);
      });

      return JSON.stringify(results);
    })()
  `;

  chrome.devtools.inspectedWindow.eval(expression, (result, err) => {
    btn.textContent = 'Page Scan';
    btn.disabled = false;

    if (err) return;

    try {
      const data = JSON.parse(result);
      // Dedup
      data.links = [...new Set(data.links)];
      data.scripts = [...new Set(data.scripts)];
      showPageScanResults(data);
    } catch { /* ignore parse errors */ }
  });
}

function showPageScanResults(data) {
  sitemapSelectedNode = null;
  sitemapDetail.classList.remove('hidden');
  sitemapDetailList.innerHTML = '';

  // Single-line header: "Page Scan · 110 Links · 2 Forms · 13 Scripts".
  // Matches the Network detail panel header style (system font,
  // light gray bar). Reset class first so prior path-display state
  // doesn't bleed into the page-scan view.
  sitemapDetailPath.className = 'sitemap-detail-path page-scan-title';
  const links = data.links.length;
  const forms = data.forms.length;
  const scripts = data.scripts.length;
  if (links === 0 && forms === 0 && scripts === 0) {
    sitemapDetailPath.innerHTML = 'Page Scan · <span class="page-scan-empty">No results</span>';
  } else {
    const stat = (n, label) =>
      `<span class="page-scan-stat"><strong>${n}</strong> ${label}</span>`;
    sitemapDetailPath.innerHTML = 'Page Scan · ' +
      stat(links, 'Links') + ' · ' + stat(forms, 'Forms') + ' · ' + stat(scripts, 'Scripts');
  }

  // Links section
  buildPageScanSection('Links', data.links, url => {
    const item = document.createElement('div');
    item.className = 'scan-item-row';
    const urlEl = document.createElement('span');
    urlEl.className = 'scan-item-url';
    urlEl.textContent = url;
    urlEl.title = url;
    item.appendChild(urlEl);
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Replay';
    btn.addEventListener('click', e => {
      e.stopPropagation();
      sendToReplay({ method: 'GET', url, requestHeaders: {}, requestPostData: null });
    });
    item.appendChild(btn);
    return item;
  });

  // Forms section
  buildPageScanSection('Forms', data.forms, form => {
    const wrapper = document.createElement('div');
    const item = document.createElement('div');
    item.className = 'scan-item-row';
    const methodEl = document.createElement('span');
    methodEl.className = `sd-method ${form.method.toLowerCase()}`;
    methodEl.textContent = form.method;
    item.appendChild(methodEl);
    const urlEl = document.createElement('span');
    urlEl.className = 'scan-item-url';
    urlEl.textContent = form.action;
    urlEl.title = form.action;
    item.appendChild(urlEl);
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Replay';
    btn.addEventListener('click', e => {
      e.stopPropagation();
      sendToReplay({
        method: form.method, url: form.action,
        requestHeaders: { 'Content-Type': 'application/x-www-form-urlencoded' },
        requestPostData: form.fields.map(f => encodeURIComponent(f.name) + '=' + encodeURIComponent(f.value)).join('&')
      });
    });
    item.appendChild(btn);
    wrapper.appendChild(item);
    if (form.fields.length > 0) {
      const fieldsEl = document.createElement('div');
      fieldsEl.className = 'sitemap-form-fields';
      fieldsEl.innerHTML = '<span class="sf-label">Fields:</span> ' +
        form.fields.map(f => {
          const cls = f.hidden ? 'sf-field sf-hidden' : 'sf-field';
          const val = f.value ? `=${escapeHtml(f.value.substring(0, 30))}` : '';
          return `<span class="${cls}" title="${escapeHtml(f.type)}">${escapeHtml(f.name)}${val}</span>`;
        }).join(' ');
      wrapper.appendChild(fieldsEl);
    }
    return wrapper;
  });

  // Scripts section
  buildPageScanSection('Scripts', data.scripts, url => {
    const item = document.createElement('div');
    item.className = 'scan-item-row scan-script';
    item.textContent = url;
    item.title = url;
    return item;
  });
}

function buildPageScanSection(title, items, renderItem) {
  if (items.length === 0) return;
  const header = document.createElement('div');
  header.className = 'scan-section-header';
  header.innerHTML = `<span class="arrow">&#9660;</span> ${title} (${items.length})`;
  sitemapDetailList.appendChild(header);
  const list = document.createElement('div');
  list.className = 'scan-section-list';
  items.forEach(item => list.appendChild(renderItem(item)));
  sitemapDetailList.appendChild(list);
  let collapsed = false;
  header.addEventListener('click', () => {
    collapsed = !collapsed;
    header.querySelector('.arrow').innerHTML = collapsed ? '&#9654;' : '&#9660;';
    list.style.display = collapsed ? 'none' : '';
  });
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
  updateSitemapStats();
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

function updateSitemapStats() {
  let hosts = 0;
  let endpoints = 0;
  function countNode(node) {
    endpoints += node.requests.length;
    Object.values(node.children).forEach(countNode);
  }
  for (const mainHost of Object.keys(sitemapTree)) {
    hosts++;
    const main = sitemapTree[mainHost];
    countNode(main);
    if (main.external) {
      for (const extHost of Object.keys(main.external)) {
        hosts++;
        countNode(main.external[extHost]);
      }
    }
  }
  sitemapStats.textContent = `${hosts} hosts · ${endpoints} endpoints`;
}

function matchesSitemapFilters(req) {
  // Scope is now a view filter too — out-of-scope previously-captured
  // requests get hidden from the tree until the user clears the scope.
  if (!inGlobalScope(req.url)) return false;

  const typeF = sitemapTypeFilter.value;
  if (typeF && classifyMimeType(req.mimeType) !== typeF) return false;

  const statusF = sitemapStatusFilter.value;
  if (statusF) {
    const s = req.status;
    if (statusF === '2xx' && (s < 200 || s >= 300)) return false;
    if (statusF === '3xx' && (s < 300 || s >= 400)) return false;
    if (statusF === '4xx' && (s < 400 || s >= 500)) return false;
    if (statusF === '5xx' && (s < 500 || s >= 600)) return false;
  }
  return true;
}

function nodeHasFilteredRequests(node) {
  if (node.requests.some(matchesSitemapFilters)) return true;
  return Object.values(node.children).some(nodeHasFilteredRequests);
}

function getNodeMethods(node) {
  const methods = new Set();
  function collect(n) {
    n.requests.filter(matchesSitemapFilters).forEach(r => methods.add(r.method));
    Object.values(n.children).forEach(collect);
  }
  collect(node);
  return methods;
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

  // Restore selection state
  if (sitemapSelectedNode) {
    renderSitemapDetail();
  }
  updatePageScanButton();
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
  const isSelected = sitemapSelectedNode &&
    sitemapSelectedNode.host === host &&
    sitemapSelectedNode.path === fullPath;
  if (isSelected) row.classList.add('selected');
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

  // Method tags
  const methods = getNodeMethods(node);
  if (methods.size > 0) {
    const methodsEl = document.createElement('span');
    methodsEl.className = 'sitemap-node-methods';
    for (const m of methods) {
      const dot = document.createElement('span');
      const mLower = m.toLowerCase();
      const cls = ['get','post','put','patch','delete'].includes(mLower) ? `m-${mLower}` : 'm-other';
      dot.className = `sitemap-method-dot ${cls}`;
      dot.textContent = m;
      methodsEl.appendChild(dot);
    }
    row.appendChild(methodsEl);
  }

  // Request count
  const count = getNodeRequestCount(node);
  if (count > 0) {
    const countEl = document.createElement('span');
    countEl.className = 'sitemap-node-count';
    countEl.textContent = count;
    row.appendChild(countEl);
  }

  // Host-only: "Set Scope" dropdown on hover — pin this domain (or its
  // wildcard form) as the global scope.
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

  // Event: toggle
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const collapsed = childrenEl.classList.toggle('collapsed');
    toggle.textContent = collapsed ? '▶' : '▼';
    if (collapsed) expandedNodes.delete(nodeKey); else expandedNodes.add(nodeKey);
  });

  // Event: node click → detail panel
  row.addEventListener('click', () => {
    sitemapSelectedNode = { host, path: fullPath };
    renderSitemapTree();
    sitemapDetail.classList.remove('hidden');
    renderSitemapDetail();
  });

  return wrapper;
}

function collectNodeRequests(node) {
  let reqs = [...node.requests];
  Object.values(node.children).forEach(child => {
    reqs = reqs.concat(collectNodeRequests(child));
  });
  return reqs;
}

function getNodeByPath(host, path) {
  // The host might be a top-level main host or an external host
  // nested under any main host's `external` map.
  let hostNode = sitemapTree[host];
  if (!hostNode) {
    for (const mainHost of Object.keys(sitemapTree)) {
      const ext = sitemapTree[mainHost].external;
      if (ext && ext[host]) { hostNode = ext[host]; break; }
    }
  }
  if (!hostNode) return null;
  if (path === '/') return hostNode;
  const segments = path.split('/').filter(Boolean);
  let node = hostNode;
  for (const seg of segments) {
    if (!node.children[seg]) return null;
    node = node.children[seg];
  }
  return node;
}

function renderSitemapDetail() {
  if (!sitemapSelectedNode) return;
  const { host, path } = sitemapSelectedNode;
  const node = getNodeByPath(host, path);
  if (!node) return;

  sitemapDetailPath.className = 'sitemap-detail-path';
  sitemapDetailPath.textContent = host + path;

  const allReqs = collectNodeRequests(node).filter(matchesSitemapFilters);
  sitemapDetailList.innerHTML = '';

  if (allReqs.length === 0) {
    sitemapDetailList.innerHTML = '<div class="sitemap-empty">No requests matching filter</div>';
    return;
  }

  for (const req of allReqs) {
    const item = document.createElement('div');
    item.className = 'sitemap-detail-item';

    const mLower = req.method.toLowerCase();

    // Method
    const methodEl = document.createElement('span');
    methodEl.className = `sd-method ${mLower}`;
    methodEl.textContent = req.method;
    item.appendChild(methodEl);

    // URL
    const urlEl = document.createElement('span');
    urlEl.className = 'sd-url';
    urlEl.textContent = req.url;
    urlEl.title = req.url;
    item.appendChild(urlEl);

    // Status
    const statusEl = document.createElement('span');
    statusEl.className = 'sd-status';
    const s = req.status;
    if (s >= 200 && s < 300) statusEl.classList.add('s-2xx');
    else if (s >= 300 && s < 400) statusEl.classList.add('s-3xx');
    else if (s >= 400) statusEl.classList.add('s-4xx');
    statusEl.textContent = s || (req._discovered ? 'scan' : '-');
    item.appendChild(statusEl);

    // Type
    const typeEl = document.createElement('span');
    typeEl.className = 'sd-type';
    typeEl.textContent = req.type || '-';
    item.appendChild(typeEl);

    // Replay button
    const actionsEl = document.createElement('span');
    actionsEl.className = 'sd-actions';
    const replayBtn = document.createElement('button');
    replayBtn.className = 'btn';
    replayBtn.textContent = 'Replay';
    replayBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      sendToReplay(req);
    });
    actionsEl.appendChild(replayBtn);
    item.appendChild(actionsEl);

    sitemapDetailList.appendChild(item);

    // Show form fields if this is a scanned form
    if (req._formData) {
      const fieldsEl = document.createElement('div');
      fieldsEl.className = 'sitemap-form-fields';
      const f = req._formData;
      let fieldsHtml = '<span class="sf-label">Fields:</span> ';
      fieldsHtml += f.fields.map(field => {
        const cls = field.hidden ? 'sf-field sf-hidden' : 'sf-field';
        const val = field.value ? `=${escapeHtml(field.value.substring(0, 30))}` : '';
        return `<span class="${cls}" title="${escapeHtml(field.type)}">${escapeHtml(field.name)}${val}</span>`;
      }).join(' ');
      fieldsEl.innerHTML = fieldsHtml;
      sitemapDetailList.appendChild(fieldsEl);
    }
  }
}

function sendToReplay(req) {
  // Switch to Network tab + activate Replay tab + populate form
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector('[data-tab="network"]').classList.add('active');
  document.getElementById('network').classList.add('active');

  // Open detail panel + Replay tab
  networkDetail.classList.remove('hidden');
  networkSplit.classList.add('has-detail');
  document.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.detail-content').forEach(c => c.classList.remove('active'));
  document.querySelector('[data-detail="replay"]').classList.add('active');
  document.getElementById('detail-replay').classList.add('active');

  // For scanned forms, build a proper request object with form fields as body
  if (req._formData) {
    const form = req._formData;
    const formReq = {
      method: form.method,
      url: form.action,
      requestHeaders: { 'Content-Type': 'application/x-www-form-urlencoded' },
      requestPostData: form.fields.map(f => encodeURIComponent(f.name) + '=' + encodeURIComponent(f.value)).join('&')
    };
    populateReplayForm(formReq);
  } else {
    populateReplayForm(req);
  }
}

// ============================================================
// 1. Network monitoring (using chrome.devtools.network API - no debugger needed)
// ============================================================
const networkRequests = [];
const networkRequestMap = new Map(); // requestId -> request object
let networkMonitoring = false;
let selectedRequestId = null;
let networkIdCounter = 0;

const networkTable = document.querySelector('#network-table tbody');
const networkCount = document.getElementById('network-count');
const networkDetail = document.getElementById('network-detail');
const networkSplit = document.querySelector('.network-split');

document.getElementById('network-start').addEventListener('click', startNetworkMonitoring);
document.getElementById('network-stop').addEventListener('click', stopNetworkMonitoring);
document.getElementById('network-clear').addEventListener('click', clearNetwork);

// Detail panel tab switching
document.querySelectorAll('.detail-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.detail-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('detail-' + tab.dataset.detail).classList.add('active');
  });
});

// Detail panel close
document.getElementById('detail-close').addEventListener('click', closeDetail);

function closeDetail() {
  networkDetail.classList.add('hidden');
  networkSplit.classList.remove('has-detail');
  selectedRequestId = null;
  networkTable.querySelectorAll('tr.selected').forEach(r => r.classList.remove('selected'));
}

// chrome.devtools.network event listener (always active, no attach needed)
chrome.devtools.network.onRequestFinished.addListener((harEntry) => {
  // Skip data: URIs entirely — they're inline payloads, not real
  // network traffic, and a single page can produce hundreds of them
  // (icons, etc.) that would only flood the list and slow scanning.
  if (harEntry.request.url.startsWith('data:')) return;

  // Global scope gate — out-of-scope requests are ignored entirely
  // (not added to Site Map or Network lists). Empty scope = all in scope.
  if (!inGlobalScope(harEntry.request.url)) return;

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
    responseBody: null,
    responseBodyLoaded: false,
    responseBase64: false,
    initiator: harEntry._initiator || null,
    _harEntry: harEntry, // HAR entry reference (for body loading)
  };

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
  scheduleAppendNetworkRow(req);

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
        if (selectedRequestId === req.requestId) {
          renderResponseBody(req);
          renderDetection(req);
        }
      });
    });
  }
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
  _pendingNetworkRows.length = 0;
  if (_networkRenderRaf) { cancelAnimationFrame(_networkRenderRaf); _networkRenderRaf = 0; }
  closeDetail();
  renderNetworkTable();
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

// Export Detection findings as JSON. Slim format aimed at rule tuning:
// only requests with findings, request metadata kept minimal, no
// response bodies. Includes per-category / per-severity totals so
// false-positive-heavy rules show up at a glance.
function exportDetectionResults() {
  const stats = {
    totalRequests: networkRequests.length,
    requestsWithFindings: 0,
    byCategory: {},
    bySeverity: {},
  };
  const items = [];
  for (const r of networkRequests) {
    const findings = r.scanResults || [];
    if (findings.length === 0) continue;
    stats.requestsWithFindings++;
    for (const f of findings) {
      stats.byCategory[f.category] = (stats.byCategory[f.category] || 0) + 1;
      stats.bySeverity[f.severity] = (stats.bySeverity[f.severity] || 0) + 1;
    }
    items.push({
      request: {
        method: r.method,
        url: r.url,
        status: r.status,
        statusText: r.statusText,
        mimeType: r.mimeType,
        type: r.type,
      },
      findings: findings.map(f => ({
        category: f.category,
        severity: f.severity,
        location: f.location,
        evidence: f.evidence,
      })),
    });
  }

  _downloadJson(
    `devtoolspp-detection-${_exportTimestamp()}.json`,
    Object.assign({}, _exportMetadata(), { stats, items })
  );
}

// Export every captured request — full headers, bodies (where loaded),
// scan results, and initiator. Heavier than the detection export; use
// when you need a complete snapshot, e.g. for offline analysis.
function exportAllRequests() {
  const items = networkRequests.map(r => ({
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
  }));

  _downloadJson(
    `devtoolspp-full-requests-${_exportTimestamp()}.json`,
    Object.assign({}, _exportMetadata(), {
      totalRequests: networkRequests.length,
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
    _harEntry: null,
    _imported: true,
  };
}

function _applyImport(reqs, mode, filename) {
  if (mode === 'overwrite') {
    networkRequests.length = 0;
    networkRequestMap.clear();
    closeDetail();
    renderNetworkTable();
  }
  for (const r of reqs) {
    networkRequests.push(r);
    networkRequestMap.set(r.requestId, r);
  }
  // Re-render the visible window — append-only would be fine, but a
  // full re-render keeps the cap logic simple for large imports.
  renderNetworkTable();
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
    const mode = item.dataset.mode;
    _exportMenu.classList.add('hidden');
    if (mode === 'detection') exportDetectionResults();
    else if (mode === 'all') exportAllRequests();
  });
});
document.addEventListener('click', (e) => {
  if (_exportMenu.classList.contains('hidden')) return;
  if (e.target.closest('.export-dropdown')) return;
  _exportMenu.classList.add('hidden');
});

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
  if (r._sourcemapMapped) {
    return '<span class="initiator-cell-badge initiator-cell-mapped">↑ Mapped</span>';
  }
  if (!r.initiator || !r.initiator.type) return '';
  const t = r.initiator.type;
  if (t === 'script') return '<span class="initiator-cell-badge initiator-cell-script">script</span>';
  if (t === 'parser') return '<span class="initiator-cell-badge initiator-cell-parser">parser</span>';
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

// Build a single <tr> for a request without touching the DOM. Returns
// the element so callers can append/insert as they choose.
function buildNetworkRow(r) {
  const statusClass = r.status >= 400 ? 'status-error'
    : r.status >= 300 ? 'status-redirect'
    : r.status >= 200 ? 'status-ok' : '';
  const tr = document.createElement('tr');
  tr.dataset.requestId = r.requestId;
  if (r.requestId === selectedRequestId) tr.classList.add('selected');
  tr.innerHTML =
    `<td><strong>${escapeHtml(r.method)}</strong></td>` +
    `<td title="${escapeHtml(r.url)}">${escapeHtml(truncateUrl(r.url))}</td>` +
    `<td class="${statusClass}">${r.status}</td>` +
    `<td>${escapeHtml(r.type)}</td>` +
    `<td>${r.size}</td>` +
    `<td>${r.time}</td>` +
    `<td class="initiator-cell">${renderInitiatorBadge(r)}</td>` +
    `<td class="scan-badges-cell">${renderScanBadgesInline(r.scanResults)}</td>`;
  return tr;
}

function updateNetworkCount() {
  const total = networkRequests.length;
  // When a scope is active, count how many existing requests pass the
  // current view filter so the badge can show "filtered / total".
  if (globalScope.regex) {
    let filtered = 0;
    for (const r of networkRequests) if (inGlobalScope(r.url)) filtered++;
    networkCount.textContent = filtered === total
      ? `${total} requests`
      : `${filtered} / ${total} requests (filtered)`;
    return;
  }
  if (total > MAX_NETWORK_ROWS) {
    networkCount.textContent = `${total} requests · showing last ${MAX_NETWORK_ROWS}`;
  } else {
    networkCount.textContent = `${total} requests`;
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
  // Apply the Scope as a view filter — out-of-scope requests captured
  // earlier are hidden until the user clears the scope.
  const visible = globalScope.regex
    ? networkRequests.filter(r => inGlobalScope(r.url))
    : networkRequests;
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
  const fragment = document.createDocumentFragment();
  for (const r of _pendingNetworkRows) {
    fragment.appendChild(buildNetworkRow(r));
  }
  _pendingNetworkRows.length = 0;
  networkTable.appendChild(fragment);
  enforceMaxNetworkRows();
  updateNetworkCount();
}

// Click delegation on tbody — attached once at load so each new row
// doesn't need its own listener. Clicking the Initiator cell jumps
// straight to the Initiator detail tab; everything else opens the
// detail panel with whatever tab was last active.
networkTable.addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-request-id]');
  if (!row) return;
  const wantInitiator = !!e.target.closest('.initiator-cell');
  selectNetworkRequest(row.dataset.requestId, {
    scroll: false,
    activateTab: wantInitiator ? 'initiator' : null,
  });
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
}

// ↑/↓ keyboard navigation through the request list while the Network
// tab is active. Suppresses the browser's default scroll so the keys
// move the selection instead.
document.addEventListener('keydown', (e) => {
  const networkSection = document.getElementById('network');
  if (!networkSection || !networkSection.classList.contains('active')) return;
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  // Don't hijack the keys while the user is typing in a form field.
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (networkRequests.length === 0) return;
  e.preventDefault();
  const currentIdx = selectedRequestId
    ? networkRequests.findIndex(r => r.requestId === selectedRequestId)
    : -1;
  let newIdx;
  if (currentIdx < 0) {
    newIdx = e.key === 'ArrowDown' ? 0 : networkRequests.length - 1;
  } else if (e.key === 'ArrowUp') {
    newIdx = Math.max(0, currentIdx - 1);
  } else {
    newIdx = Math.min(networkRequests.length - 1, currentIdx + 1);
  }
  if (newIdx === currentIdx) return;
  selectNetworkRequest(networkRequests[newIdx].requestId, { scroll: true });
});

// ============================================================
// Network Detail Panel
// ============================================================

function showDetail(req) {
  renderGeneralInfo(req);
  renderHeaders(req);
  renderPayload(req);
  renderResponseBody(req);
  renderPreview(req);
  renderInitiator(req);
  renderDetection(req);
  populateReplayForm(req);
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

// Section toggle via event delegation (inline onclick blocked by MV3 CSP)
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

  // Auto-decode pass over both header sets
  const findings = [
    ...autoDecodeScanHeaders(req.responseHeaders, 'Response header'),
    ...autoDecodeScanHeaders(req.requestHeaders, 'Request header'),
  ];
  renderDecodedSection(document.getElementById('detail-headers'), findings);
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

  // Auto-decode: query params + request body
  const findings = [];
  try {
    const url = new URL(req.url);
    for (const [k, v] of url.searchParams) {
      if (findings.length >= AUTODECODE_MAX_FINDINGS) break;
      const f = detectInString(v);
      if (f) findings.push({ ...f, location: `Query: ${k}` });
    }
  } catch { /* malformed URL */ }
  if (req.requestPostData) {
    findings.push(...autoDecodeScanBody(req.requestPostData, 'Request body'));
  }
  renderDecodedSection(document.getElementById('detail-payload'), findings);
}

function renderResponseBody(req) {
  const container = document.getElementById('detail-response-body');
  const tabPane = document.getElementById('detail-response');
  // Imported requests don't have a HAR entry to fetch from, so an
  // unloaded body means the source file simply didn't include it
  // (typical for Detection-only exports).
  if (req._imported && !req.responseBodyLoaded) {
    container.innerHTML = '<div class="detail-loading">Not included in the imported file</div>';
    renderDecodedSection(tabPane, []);
    return;
  }
  if (!req.responseBodyLoaded) {
    container.innerHTML = '<div class="detail-loading">Loading response body...</div>';
    renderDecodedSection(tabPane, []);
    return;
  }
  if (req.responseBody === null || req.responseBody === undefined) {
    container.innerHTML = '<div class="detail-loading">Response body not available.</div>';
    renderDecodedSection(tabPane, []);
    return;
  }
  if (req.responseBase64) {
    container.innerHTML = `<div class="response-body-content" style="color:#999">[Base64 encoded data - ${formatBytes(req.responseBody.length)} encoded]</div>`;
    renderDecodedSection(tabPane, []);
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

  renderDecodedSection(tabPane, autoDecodeScanBody(req.responseBody, 'Response body'));
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

  // Type badge
  html += `<div class="initiator-type">Type: <strong>${escapeHtml(init.type || 'unknown')}</strong></div>`;

  // Call stack
  const frames = init.stack?.callFrames || [];
  if (frames.length > 0) {
    // Detect sensitive patterns in full stack
    const hints = new Set();
    frames.forEach(f => {
      const label = detectSensitive(f.functionName);
      if (label) hints.add(label);
    });

    if (hints.size > 0) {
      html += '<div class="initiator-hints">';
      for (const hint of hints) {
        html += `<span class="initiator-hint">${escapeHtml(hint)}</span>`;
      }
      html += '</div>';
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
        html += `<span class="sensitive-badge">${escapeHtml(sensitive)}</span>`;
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

  // Async: enrich call-stack frames with source map info. Updates DOM
  // when each script's map resolves. Cache means no repeat fetches.
  if (frames.length > 0) enrichFramesWithSourceMaps(container, frames, req);
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
          tabBtn.title = `Source-mapped frames: ${mappedCount} / ${totalFramesWithUrls}`;
        }
        // Promote the row's Initiator cell to "↑ Mapped" on the first
        // successful frame mapping. Flag persists on the req so the
        // cell stays mapped across re-renders.
        if (req && !req._sourcemapMapped) {
          req._sourcemapMapped = true;
          updateNetworkRowInitiator(req);
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
  sqli: {
    badge: '💉 SQLi',
    defaultSeverity: 'high',
    keywords: ['query', 'search', 'filter', 'sort', 'where', 'select', 'order',
               'keyword', 'column', 'field', 'report', 'row', 'string', 'number'],
  },
  lfi: {
    badge: '📁 LFI',
    defaultSeverity: 'high',
    keywords: ['file', 'path', 'dir', 'directory', 'document', 'template',
               'include', 'page', 'doc', 'folder', 'root', 'pdf', 'pg', 'style'],
    keywordSeverity: {
      // Generic page-N navigation parameters — LFI test point but
      // less load-bearing than file/path.
      'page': 'medium',
      // include= often a SPA pattern that's safely whitelisted server-side.
      'include': 'low',
    },
  },
  ssrf: {
    badge: '🌐 SSRF',
    // Most SSRF candidates start out medium-confidence; a few specific
    // post-redirect target params are upgraded.
    defaultSeverity: 'medium',
    // 'window' removed — overlapped with browser performance properties
    // (windowInnerWidth etc.) and produced 100% noise.
    keywords: ['url', 'redirect', 'dest', 'destination', 'callback', 'return',
               'next', 'host', 'domain', 'uri', 'continue', 'forward',
               'navigate', 'open', 'feed', 'ref'],
    keywordSeverity: {
      // Specific redirect / return targets — SSRF and open-redirect risk.
      'redirect': 'high',
      'return': 'high',
      'continue': 'high',
      // Referer-style ref=, weak signal — keep but de-emphasize.
      'ref': 'low',
    },
  },
  rce: {
    badge: '💻 RCE',
    defaultSeverity: 'high',
    keywords: ['cmd', 'exec', 'command', 'shell', 'ping', 'execute',
               'run', 'system', 'proc', 'process'],
  },
  debug: {
    badge: '🔧 debug',
    defaultSeverity: 'medium',
    keywords: ['debug', 'test', 'dbg', 'config', 'toggle',
               'enable', 'disable', 'reset', 'adm', 'cfg'],
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
  if (hit.category === 'ssrf') {
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

    // Internal IPv4
    const ipMatch = body.match(/\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})\b/);
    if (ipMatch) {
      _scanAdd(findings, seen, {
        category: 'leak', badge: '⚠️ leak', severity: 'medium',
        location: `response.body (internal IP)`,
        evidence: ipMatch[0],
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

  sqli:
    `A parameter that could influence a SQL query.
Use the Replay tab to change the value and watch how
the server response differs.
e.g. '  (single quote — does the server error out?)
     1 AND 1=1 vs 1 AND 1=2  (true/false response delta?)`,

  lfi:
    `A parameter that names a file path or template.
Worth checking for LFI or SSTI.
Modify the value and watch how the server responds.
e.g. ../../../etc/passwd  (path traversal probe)
     {{7*7}}  (template evaluation — returning 49 is a red flag)`,

  ssrf:
    `A parameter tied to an outbound request or redirect.
Worth checking for SSRF or Open Redirect.
Use the Replay tab to change the value and resend.
e.g. https://169.254.169.254/  (AWS metadata probe)
     //evil.com  (external-domain redirect probe)`,

  rce:
    `A parameter tied to command execution.
Modify the value and check whether the server behaves
differently.
Watch the response body or downstream behavior for
changes when the value moves away from its default.`,

  debug:
    `A debug or configuration parameter.
Try changing it and see whether the server behaves
differently.
e.g. debug=true or debug=1  (turn on debug mode?)
     test=true              (switch into a test mode?)`,

  check:
    `The response is 401/403 but the body is larger than
expected.
A normal auth-failure response should carry only a
short error message.
Inspect the body directly to see whether sensitive
information or data leaks alongside the failure.`,
};

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

// Section toggle
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

// Response sub-tabs
document.querySelectorAll('.replay-resp-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.replay-resp-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.replay-resp-pane').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('replay-resp-' + tab.dataset.rtab + '-pane').classList.add('active');
  });
});

document.getElementById('replay-send').addEventListener('click', executeReplay);
document.getElementById('replay-state').addEventListener('click', () => {
  if (!replayOriginalSnapshot) return;
  const req = selectedRequestId ? networkRequestMap.get(selectedRequestId) : null;
  if (req) populateReplayForm(req);
});
document.getElementById('replay-add-header').addEventListener('click', (e) => {
  e.stopPropagation();
  addKvRow('replay-headers-list', '', '', true);
  checkReplayModified();
});
document.getElementById('replay-add-param').addEventListener('click', (e) => {
  e.stopPropagation();
  addKvRow('replay-params-list', '', '', true);
  checkReplayModified();
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

// Sync query params when URL changes
document.getElementById('replay-url').addEventListener('blur', syncParamsFromUrl);

// Replay form state tracking
let replayOriginalSnapshot = null;

function captureKvSnapshot(listId) {
  const rows = document.querySelectorAll(`#${listId} .replay-kv-row`);
  const entries = [];
  rows.forEach(row => {
    const enabled = row.querySelector('.kv-toggle').checked;
    const name = row.querySelector('.kv-name').value;
    const value = row.querySelector('.kv-value').value;
    entries.push([enabled, name, value]);
  });
  return entries;
}

function captureReplaySnapshot() {
  return JSON.stringify({
    method: document.getElementById('replay-method').value,
    url: document.getElementById('replay-url').value,
    body: document.getElementById('replay-body').value,
    bodyType: document.getElementById('replay-body-type').value,
    headers: captureKvSnapshot('replay-headers-list'),
    params: captureKvSnapshot('replay-params-list'),
  });
}

function checkReplayModified() {
  const stateBtn = document.getElementById('replay-state');
  if (!replayOriginalSnapshot) {
    stateBtn.textContent = 'Original';
    stateBtn.classList.remove('modified');
    return;
  }
  const current = captureReplaySnapshot();
  const modified = current !== replayOriginalSnapshot;
  stateBtn.textContent = modified ? 'Modified' : 'Original';
  stateBtn.classList.toggle('modified', modified);
}

// Attach change detection to replay form inputs
['replay-method', 'replay-body-type'].forEach(id => {
  document.getElementById(id).addEventListener('change', checkReplayModified);
});
['replay-url', 'replay-body'].forEach(id => {
  document.getElementById(id).addEventListener('input', checkReplayModified);
});
// Event delegation for KV row changes (headers, params)
['replay-headers-list', 'replay-params-list'].forEach(id => {
  const el = document.getElementById(id);
  el.addEventListener('input', checkReplayModified);
  el.addEventListener('change', checkReplayModified);
});

// Populate form with selected request data when Replay tab activates
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

  replayOriginalSnapshot = captureReplaySnapshot();
  checkReplayModified();
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

  row.querySelector('.kv-remove').addEventListener('click', () => {
    row.remove();
    checkReplayModified();
  });

  // Sync URL when query param changes
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

  // eval() doesn't support async, so store result in global variable and poll
  const callbackId = '__replay_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const headersJson = JSON.stringify(headers);
  const bodyJson = body ? JSON.stringify(body) : 'null';

  // Step 1: Start fetch in page context, store result in window[callbackId]
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

    // Step 2: Poll for result
    let attempts = 0;
    const maxAttempts = 300; // 30s timeout
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
        if (result === null || result === undefined) return; // Still waiting

        clearInterval(pollInterval);
        sendBtn.textContent = 'Send';
        sendBtn.disabled = false;

        // Clean up global variable
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

    // Diff - Compare with original response
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
  // Status difference
  const statusEl = document.getElementById('replay-status');
  if (originalReq.status !== replayResp.status) {
    statusEl.textContent += ` (was ${originalReq.status})`;
  }

  // Show response body difference
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

  // History item click → restore form with that request
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

// Auto-populate Replay form on detail tab switch
document.querySelectorAll('.detail-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    if (tab.dataset.detail === 'replay' && selectedRequestId) {
      const req = networkRequestMap.get(selectedRequestId);
      if (req) populateReplayForm(req);
    }
  });
});

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

// Switch activeSide on side panel click
document.querySelectorAll('.icpt-side').forEach(el => {
  el.addEventListener('click', () => {
    activeSide = el.dataset.side;
    document.querySelectorAll('.icpt-side').forEach(s => s.classList.remove('active-side'));
    el.classList.add('active-side');
  });
});
// Initial active side
document.querySelector('.icpt-req-side').classList.add('active-side');

// Background Service Worker port connection (auto-reconnect)
let bgPort = null;

function connectBgPort() {
  bgPort = chrome.runtime.connect({ name: `panel-${tabId}` });

  bgPort.onMessage.addListener(handleBgMessage);

  bgPort.onDisconnect.addListener(() => {
    console.warn('[DevTools++] Background port disconnected, reconnecting...');
    bgPort = null;
    // Wait for Service Worker restart then reconnect
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
// Falls back to the raw url if it can't be parsed.
function _filterTarget(url) {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
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
  return globalScope.regex.test(_filterTarget(url));
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
  // Scope is also a view filter — re-render Network table and Site
  // Map tree so already-captured data reflects the new pattern
  // immediately. updateSitemapStats picks up scope through
  // matchesSitemapFilters via getNodeRequestCount.
  renderNetworkTable();
  renderSitemapTree();
  updateSitemapStats();
}

// Apply an arbitrary scope pattern (used by Site Map "Set Scope" dropdown).
function applyScopePattern(pattern) {
  document.getElementById('global-scope-input').value = pattern;
  applyGlobalScope();
}

// Wildcard form of a host: drop the leftmost label for 3+ part hosts
// (www.site.com -> *.site.com), or prepend *. for 2-part hosts
// (site.com -> *.site.com, meaning subdomains). Returns null for IPs,
// single-label hosts, and anything we can't safely wildcard.
function wildcardHost(host) {
  if (!host) return null;
  if (/^[\d.]+$/.test(host)) return null; // IPv4
  if (host.includes(':')) return null; // IPv6 or host:port
  const parts = host.split('.');
  if (parts.length < 2) return null; // e.g. "localhost"
  if (parts.length === 2) return `*.${host}`;
  return `*.${parts.slice(1).join('.')}`;
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

// Handle intercepted request from the proxy
function handleProxyInterceptedRequest(msg) {
  const methodFilter = document.getElementById('icpt-method-filter').value;

  // Method filter
  if (methodFilter && msg.method !== methodFilter) {
    sendInterceptDecision(msg.id, { action: 'forward' });
    addInterceptLog('bypassed', msg.method, msg.url, 'req');
    return;
  }
  // Global scope gate (defense in depth — the proxy already filters server-side
  // via update_config, but catches any races where a request is dispatched
  // before the config update lands)
  if (!inGlobalScope(msg.url)) {
    sendInterceptDecision(msg.id, { action: 'forward' });
    addInterceptLog('bypassed', msg.method, msg.url, 'req');
    return;
  }
  // Bypass rules
  if (interceptBypassRegex && interceptBypassRegex.test(msg.url)) {
    sendInterceptDecision(msg.id, { action: 'forward' });
    addInterceptLog('bypassed', msg.method, msg.url, 'req');
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

  // Add to response queue
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
document.getElementById('icpt-req-add-header').addEventListener('click', () => addIcptKvRow('icpt-req-headers-list', '', ''));
document.getElementById('icpt-mock-add-header').addEventListener('click', () => addIcptKvRow('icpt-mock-headers-list', '', ''));

// Response side buttons
document.getElementById('icpt-resp-forward').addEventListener('click', () => { activeSide = 'resp'; forwardSelected(false); });
document.getElementById('icpt-resp-forward-modified').addEventListener('click', () => { activeSide = 'resp'; forwardSelected(true); });
document.getElementById('icpt-resp-drop').addEventListener('click', () => { activeSide = 'resp'; dropSelected(); });
document.getElementById('icpt-resp-add-header').addEventListener('click', () => addIcptKvRow('icpt-resp-headers-list', '', ''));

// Common buttons
document.getElementById('icpt-forward-all').addEventListener('click', forwardAll);
document.getElementById('icpt-drop-all').addEventListener('click', dropAll);
document.getElementById('icpt-clear-log').addEventListener('click', () => { interceptLog.length = 0; renderInterceptLog(); });
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
  // Initialize Mock tab
  document.getElementById('icpt-mock-status').value = 200;
  document.getElementById('icpt-mock-headers-list').innerHTML = '';
  addIcptKvRow('icpt-mock-headers-list', 'Content-Type', 'application/json');
  document.getElementById('icpt-mock-body').value = '';
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

// ---- KV Helper (shared) ----
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
  const status = parseInt(document.getElementById('icpt-mock-status').value) || 200;
  const headers = getIcptKvEntries('icpt-mock-headers-list');
  const body = document.getElementById('icpt-mock-body').value;

  if (!headers.some(h => h.name.toLowerCase() === 'content-type')) {
    try { JSON.parse(body); headers.push({ name: 'Content-Type', value: 'application/json' }); }
    catch { headers.push({ name: 'Content-Type', value: 'text/plain' }); }
  }

  sendInterceptDecision(item.id, {
    action: 'mock',
    responseStatus: status,
    responseHeaders: headers,
    responseBody: body
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

// Response capture history (id → response)
const capturedResponses = new Map();

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
    const time = l.time.toLocaleTimeString(undefined, { hour12: false });
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

// Show response detail on log click
icptLogEl.addEventListener('click', (e) => {
  const item = e.target.closest('[data-resp-id]');
  if (!item) return;
  const resp = capturedResponses.get(item.dataset.respId);
  if (!resp) return;
  showCapturedResponse(resp);
});

function showCapturedResponse(resp) {
  // Display captured response in Response side editor
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
  gutter.addEventListener('mousedown', (e) => {
    const target = gutter.nextElementSibling;
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
      const newSize = Math.max(80, startSize - (cur - startPos));
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
  if (!chrome.storage || !chrome.storage.local) return;
  chrome.storage.local.get(['autoStartMonitoring'], (result) => {
    const enabled = !!(result && result.autoStartMonitoring);
    checkbox.checked = enabled;
    if (enabled && !networkMonitoring) startNetworkMonitoring();
  });
  checkbox.addEventListener('change', (e) => {
    chrome.storage.local.set({ autoStartMonitoring: e.target.checked });
  });
})();

