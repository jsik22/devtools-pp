'use strict';

// Version label from manifest
const manifest = chrome.runtime.getManifest();
document.getElementById('version').textContent = 'v' + manifest.version;

// ============================================================
// Native proxy status — query background's check_native handler
// ============================================================
function renderProxyStatus(connected, error) {
  const icon = document.getElementById('proxy-icon');
  const text = document.getElementById('proxy-text');
  const btn = document.getElementById('setup-btn');
  if (connected) {
    icon.textContent = '🟢';
    icon.className = 'row-icon status-ok';
    text.textContent = 'Proxy ready';
    btn.style.display = 'none';
  } else {
    icon.textContent = '🔴';
    icon.className = 'row-icon status-err';
    text.textContent = error
      ? 'Proxy not connected'
      : 'Proxy not connected';
    text.title = error || '';
    btn.style.display = '';
  }
}

document.getElementById('setup-btn').addEventListener('click', () => {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    chrome.tabs.create({ url: chrome.runtime.getURL('setup.html') });
  }
  window.close();
});

chrome.runtime.sendMessage({ type: 'check_native' }, (response) => {
  if (chrome.runtime.lastError || !response) {
    renderProxyStatus(false, chrome.runtime.lastError && chrome.runtime.lastError.message);
    return;
  }
  renderProxyStatus(!!response.connected, response.error);
});

// ============================================================
// Scope + monitoring — read from chrome.storage.local
// ============================================================
chrome.storage.local.get(['globalScopeInput', 'networkMonitoring', 'autoStartMonitoring'], (result) => {
  const scope = (result && result.globalScopeInput || '').trim();
  const scopeIcon = document.querySelector('#row-scope .row-icon');
  const scopeText = document.getElementById('scope-text');
  if (scope) {
    scopeIcon.textContent = '🎯';
    scopeText.textContent = scope;
    scopeText.classList.remove('muted');
  } else {
    scopeIcon.textContent = '🌐';
    scopeText.textContent = 'All traffic';
    scopeText.classList.add('muted');
  }

  const monIcon = document.getElementById('monitor-icon');
  const monText = document.getElementById('monitor-text');
  if (result && result.networkMonitoring) {
    monIcon.textContent = '▶';
    monIcon.className = 'row-icon status-ok';
    monText.textContent = 'Monitoring active';
  } else {
    monIcon.textContent = '⏹';
    monIcon.className = 'row-icon';
    monText.textContent = 'Monitoring stopped';
  }

  document.getElementById('autostart-toggle').checked = !!(result && result.autoStartMonitoring);
});

// Auto-start 토글 — 사용자가 체크 변경 시 storage에 영속화. panel이 열릴 때
// panel.js의 initAutoStartMonitoring과 js-trace.js의 부트스트랩이 이 값을 읽어
// Monitor + JS Trace를 자동 시작.
document.getElementById('autostart-toggle').addEventListener('change', (e) => {
  chrome.storage.local.set({ autoStartMonitoring: e.target.checked });
});
