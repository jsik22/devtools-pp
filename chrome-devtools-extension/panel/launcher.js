'use strict';

// Loaded by panel/launcher.html in a freshly-opened tab. Pulls its
// "what to navigate to" payload from the background service worker
// (which set it up alongside the DNR tag rule + proxy header swap),
// then either changes location.href (GET) or submits a hidden form
// (POST) to trigger the actual request — DNR tags it, proxy catches
// it, the original DevTools++ panel queues it.

const statusEl = document.getElementById('status');

function setError(msg) {
  statusEl.className = 'err';
  statusEl.textContent = msg;
}

chrome.runtime.sendMessage({ type: 'launcher_ready' }, (response) => {
  if (chrome.runtime.lastError) {
    setError('Connection error: ' + chrome.runtime.lastError.message);
    return;
  }
  if (!response || !response.ok) {
    setError((response && response.error) || 'No payload received');
    return;
  }
  const p = response.payload;
  if (!p || !p.url || !p.method) {
    setError('Invalid payload');
    return;
  }
  statusEl.textContent = 'Navigating...';
  if (p.method === 'GET') {
    location.href = p.url;
    return;
  }
  if (p.method === 'POST') {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = p.url;
    form.enctype = p.enctype || 'application/x-www-form-urlencoded';
    const fields = Array.isArray(p.fields) ? p.fields : [];
    for (const f of fields) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = f.name || '';
      input.value = f.value != null ? String(f.value) : '';
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
    return;
  }
  setError('Unsupported method: ' + p.method);
});
