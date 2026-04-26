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

const sitemapTree = {};  // host → { children: { path: { children: {}, requests: [] } } }
let sitemapSelectedNode = null; // { host, path }
let targetHost = null;
let externalGroupExpanded = false;
const expandedNodes = new Set(); // tracks expanded tree node keys (e.g. "host:/path")

function ensureTargetInTree() {
  if (targetHost && !sitemapTree[targetHost]) {
    sitemapTree[targetHost] = { children: {}, requests: [] };
  }
}

function detectTargetHost() {
  chrome.devtools.inspectedWindow.eval('location.host', (result, err) => {
    if (!err && result) {
      targetHost = result;
      ensureTargetInTree();
      renderSitemapTree();
      updateSitemapStats();
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
  if (newHost !== targetHost) {
    Object.keys(sitemapTree).forEach(k => delete sitemapTree[k]);
    sitemapSelectedNode = null;
    expandedNodes.clear();
    externalGroupExpanded = false;
    sitemapDetail.classList.add('hidden');
    targetHost = newHost;
  }
  ensureTargetInTree();
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

const sitemapScanBtn = document.getElementById('sitemap-scan');
sitemapScanBtn.addEventListener('click', scanPage);

function updateScanPageButton() {
  if (sitemapSelectedNode && targetHost && sitemapSelectedNode.host !== targetHost) {
    sitemapScanBtn.disabled = true;
    sitemapScanBtn.title = 'Scan Page is only available for the target host';
  } else {
    sitemapScanBtn.disabled = false;
    sitemapScanBtn.title = '';
  }
}
document.getElementById('sitemap-clear').addEventListener('click', () => {
  Object.keys(sitemapTree).forEach(k => delete sitemapTree[k]);
  sitemapSelectedNode = null;
  expandedNodes.clear();
  externalGroupExpanded = false;
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

function scanPage() {
  const btn = document.getElementById('sitemap-scan');
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
    btn.textContent = 'Scan Page';
    btn.disabled = false;

    if (err) return;

    try {
      const data = JSON.parse(result);
      // Dedup
      data.links = [...new Set(data.links)];
      data.scripts = [...new Set(data.scripts)];
      showScanResults(data);
    } catch { /* ignore parse errors */ }
  });
}

function showScanResults(data) {
  sitemapSelectedNode = null;
  sitemapDetail.classList.remove('hidden');
  sitemapDetailPath.textContent = 'Scan Results';
  sitemapDetailList.innerHTML = '';

  // Summary
  const summary = document.createElement('div');
  summary.className = 'scan-summary';
  summary.innerHTML =
    `<div class="scan-stat"><span class="scan-stat-num">${data.links.length}</span> Links</div>` +
    `<div class="scan-stat"><span class="scan-stat-num">${data.forms.length}</span> Forms</div>` +
    `<div class="scan-stat"><span class="scan-stat-num">${data.scripts.length}</span> Scripts</div>`;
  sitemapDetailList.appendChild(summary);

  // Links section
  buildScanSection('Links', data.links, url => {
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
  buildScanSection('Forms', data.forms, form => {
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
  buildScanSection('Scripts', data.scripts, url => {
    const item = document.createElement('div');
    item.className = 'scan-item-row scan-script';
    item.textContent = url;
    item.title = url;
    return item;
  });
}

function buildScanSection(title, items, renderItem) {
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

  // Split path into segments
  const segments = pathname.split('/').filter(Boolean);

  if (!sitemapTree[host]) {
    sitemapTree[host] = { children: {}, requests: [] };
  }

  // Create path nodes in tree
  let node = sitemapTree[host];
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

  renderSitemapTree();
  updateSitemapStats();
}

function updateSitemapStats() {
  const hosts = Object.keys(sitemapTree).length;
  let endpoints = 0;
  function countNode(node) {
    endpoints += node.requests.length;
    Object.values(node.children).forEach(countNode);
  }
  Object.values(sitemapTree).forEach(countNode);
  sitemapStats.textContent = `${hosts} hosts · ${endpoints} endpoints`;
}

function matchesSitemapFilters(req) {
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

  // External hosts grouped
  const externalHosts = hosts.filter(h => h !== targetHost && nodeHasFilteredRequests(sitemapTree[h]));
  if (externalHosts.length > 0) {
    const extWrapper = document.createElement('div');
    extWrapper.className = 'sitemap-external-group';

    const extRow = document.createElement('div');
    extRow.className = 'sitemap-node sitemap-external-header';
    const extToggle = document.createElement('span');
    extToggle.className = 'sitemap-node-toggle';
    extToggle.textContent = externalGroupExpanded ? '▼' : '▶';
    extRow.appendChild(extToggle);
    const extIcon = document.createElement('span');
    extIcon.className = 'sitemap-node-icon';
    extIcon.textContent = '📡';
    extRow.appendChild(extIcon);
    const extLabel = document.createElement('span');
    extLabel.className = 'sitemap-node-label sitemap-external-label';
    extLabel.textContent = `External (${externalHosts.length})`;
    extRow.appendChild(extLabel);
    extWrapper.appendChild(extRow);

    const extChildren = document.createElement('div');
    extChildren.className = externalGroupExpanded ? 'sitemap-children' : 'sitemap-children collapsed';
    for (const host of externalHosts) {
      const hostEl = buildTreeNode(host, sitemapTree[host], host, '');
      if (hostEl) extChildren.appendChild(hostEl);
    }
    extWrapper.appendChild(extChildren);

    function toggleExternal(e) {
      if (e) e.stopPropagation();
      externalGroupExpanded = !externalGroupExpanded;
      extChildren.classList.toggle('collapsed', !externalGroupExpanded);
      extToggle.textContent = externalGroupExpanded ? '▼' : '▶';
    }
    extToggle.addEventListener('click', toggleExternal);
    extRow.addEventListener('click', () => toggleExternal(null));

    sitemapTreeEl.appendChild(extWrapper);
  }

  // Restore selection state
  if (sitemapSelectedNode) {
    renderSitemapDetail();
  }
  updateScanPageButton();
}

function buildTreeNode(label, node, host, currentPath, forceShow) {
  const hasChildren = Object.keys(node.children).length > 0;
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
  icon.textContent = isHost ? '🌐' : (hasChildren ? '📁' : '📄');
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
  const hostNode = sitemapTree[host];
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
    initiator: harEntry._initiator || null,
    _harEntry: harEntry, // HAR entry reference (for body loading)
  };

  // Site Map always collects
  addToSitemap(req);

  // Network list only when monitoring is ON
  if (!networkMonitoring) return;
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
  networkCount.textContent = `${networkRequests.length} requests`;
  networkTable.innerHTML = networkRequests.map(r => {
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

  // Row click event
  networkTable.querySelectorAll('tr').forEach(row => {
    row.addEventListener('click', () => {
      const reqId = row.dataset.requestId;
      const req = networkRequestMap.get(reqId);
      if (!req) return;

      // Update selection state
      networkTable.querySelectorAll('tr.selected').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      selectedRequestId = reqId;

      // Show detail panel
      networkDetail.classList.remove('hidden');
      networkSplit.classList.add('has-detail');
      showDetail(req);

      // Try loading body if not loaded yet
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
  renderInitiator(req);
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
  // Fetch via inspected page context (same-origin)
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
    // Timeout after 5s
    setTimeout(() => { if (!done) { done = true; clearInterval(poll); callback(null); } }, 5000);
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

      html += `<div class="initiator-frame${sensitiveCls}" data-url="${escapeAttr(f.url || '')}" data-line="${f.lineNumber || 0}">`;
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

  function showInlineSource(url, lineNum, notice) {
    container.querySelectorAll('.initiator-frame').forEach(f => f.classList.remove('active'));
    const activeFrame = container.querySelector(`.initiator-frame[data-url="${CSS.escape(url)}"][data-line="${lineNum}"]`);
    if (activeFrame) activeFrame.classList.add('active');

    const viewer = document.getElementById('initiator-source-viewer');
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
      showInlineSource(url, lineNum);
    });
  });

  // Source link click → try Sources tab, fallback to inline
  container.querySelectorAll('.initiator-frame .source-link').forEach(link => {
    const frame = link.closest('.initiator-frame');
    const url = frame?.dataset.url;
    if (!url) return;
    link.style.cursor = 'pointer';
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      const lineNum = parseInt(frame.dataset.line || '0', 10);

      chrome.devtools.inspectedWindow.getResources((resources) => {
        const exists = resources.some(r => r.url === url);
        if (exists) {
          chrome.devtools.panels.openResource(url, lineNum, () => {});
        } else {
          // Resource not in Sources — show inline with notice
          showInlineSource(url, lineNum,
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
          showInlineSource(url, lineNum);
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

