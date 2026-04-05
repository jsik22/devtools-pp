'use strict';

const extensionId = chrome.runtime.id;
let currentPlatform = null;

// ============================================================
// Init
// ============================================================
document.getElementById('ext-id').textContent = extensionId;

// Detect OS
function detectOS() {
  const ua = navigator.userAgent;
  if (ua.includes('Macintosh') || ua.includes('Mac OS')) return 'mac';
  if (ua.includes('Windows')) return 'win';
  return 'unknown';
}

const detectedOS = detectOS();
const osLabels = { mac: 'macOS', win: 'Windows', unknown: 'Unknown' };
document.getElementById('detected-os').textContent = osLabels[detectedOS] || detectedOS;

// Auto-select detected platform
selectPlatform(detectedOS === 'unknown' ? 'mac' : detectedOS);

// Check connection on load
checkConnection();

// ============================================================
// Platform selection
// ============================================================
function selectPlatform(platform) {
  currentPlatform = platform;
  document.querySelectorAll('.platform-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.platform === platform);
  });
  updateCommands();
}

// ============================================================
// Generate commands
// ============================================================
function updateCommands() {
  const installCmd = document.getElementById('install-cmd');
  const trustCmd = document.getElementById('trust-cmd');
  const trustDesc = document.getElementById('trust-desc');

  if (currentPlatform === 'mac') {
    installCmd.innerHTML = `<button class="copy-btn" onclick="copyCommand('install-cmd')">Copy</button>`
      + escapeHtml(`cd "<path-to-extension>/native-proxy"\nchmod +x install.sh\n./install.sh ${extensionId}`);

    trustDesc.textContent = 'Run the following command to add the CA certificate to the macOS system keychain:';
    trustCmd.innerHTML = `<button class="copy-btn" onclick="copyCommand('trust-cmd')">Copy</button>`
      + escapeHtml(`sudo security add-trusted-cert -d -r trustRoot \\\n  -k /Library/Keychains/System.keychain \\\n  ~/.devtools-pp/ca.pem`);

  } else if (currentPlatform === 'win') {
    installCmd.innerHTML = `<button class="copy-btn" onclick="copyCommand('install-cmd')">Copy</button>`
      + escapeHtml(`cd "<path-to-extension>\\native-proxy"\ninstall.bat ${extensionId}`);

    trustDesc.textContent = 'Run the following command in an Administrator Command Prompt to trust the CA certificate:';
    trustCmd.innerHTML = `<button class="copy-btn" onclick="copyCommand('trust-cmd')">Copy</button>`
      + escapeHtml(`certutil -addstore -user "Root" "%USERPROFILE%\\.devtools-pp\\ca.pem"`);
  }
}

// ============================================================
// Connection check
// ============================================================
function checkConnection() {
  const bar = document.getElementById('status-bar');
  const text = document.getElementById('status-text');

  bar.className = 'status-bar checking';
  text.textContent = 'Checking Native Messaging connection...';

  chrome.runtime.sendMessage({ type: 'check_native' }, (response) => {
    if (chrome.runtime.lastError || !response) {
      setDisconnected();
      return;
    }

    if (response.connected) {
      bar.className = 'status-bar connected';
      text.textContent = 'Native Messaging host is connected and ready.';
      document.getElementById('setup-section').classList.add('hidden');
      document.getElementById('success-section').classList.remove('hidden');
    } else {
      setDisconnected(response.error);
    }
  });
}

function setDisconnected(error) {
  const bar = document.getElementById('status-bar');
  const text = document.getElementById('status-text');
  bar.className = 'status-bar not-connected';
  text.textContent = 'Native Messaging host is not connected.' + (error ? ' (' + error + ')' : '');
  document.getElementById('setup-section').classList.remove('hidden');
  document.getElementById('success-section').classList.add('hidden');
}

// ============================================================
// Copy to clipboard
// ============================================================
function copyCommand(elementId) {
  const el = document.getElementById(elementId);
  // Get text content excluding the copy button
  const text = el.textContent.replace(/^Copy/, '').trim();
  navigator.clipboard.writeText(text).then(() => {
    const btn = el.querySelector('.copy-btn');
    if (btn) {
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.classList.remove('copied');
      }, 2000);
    }
  });
}

// ============================================================
// Util
// ============================================================
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
