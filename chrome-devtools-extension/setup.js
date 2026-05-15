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

  let installText, trustText;
  if (currentPlatform === 'mac') {
    installText = `cd "<downloaded>/chrome-devtools-extension/native-proxy"\nchmod +x install.sh\n./install.sh ${extensionId}`;
    trustDesc.textContent = 'Run the following command to add the CA certificate to the macOS system keychain:';
    trustText = `sudo security add-trusted-cert -d -r trustRoot \\\n  -k /Library/Keychains/System.keychain \\\n  ~/.devtools-pp/ca.pem`;
  } else if (currentPlatform === 'win') {
    installText = `cd "<downloaded>\\chrome-devtools-extension\\native-proxy"\ninstall.bat ${extensionId}`;
    trustDesc.textContent = 'Run the following command in an Administrator Command Prompt to trust the CA certificate:';
    trustText = `certutil -addstore -user "Root" "%USERPROFILE%\\.devtools-pp\\ca.pem"`;
  }

  // textContent assignment is XSS-safe and avoids the inline-button
  // hack; data-command holds the raw text the Copy button reads back.
  installCmd.textContent = installText;
  installCmd.dataset.command = installText;
  trustCmd.textContent = trustText;
  trustCmd.dataset.command = trustText;
}

// ============================================================
// Connection check
// ============================================================
function checkConnection() {
  const bar = document.getElementById('status-bar');
  const text = document.getElementById('status-text');

  // Dev/design preview override: ?preview=disconnected forces the
  // not-connected UI regardless of the actual Native Messaging state.
  // Useful for screenshotting / styling the setup flow without
  // uninstalling the host. Leave in place — opt-in via URL only.
  const previewParam = new URLSearchParams(location.search).get('preview');
  if (previewParam === 'disconnected') {
    setDisconnected('preview mode');
    return;
  }

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
function copyCommand(targetId, btn) {
  const el = document.getElementById(targetId);
  if (!el) return;
  const text = el.dataset.command || el.textContent;
  navigator.clipboard.writeText(text).then(() => {
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, 2000);
  }).catch((err) => {
    console.error('Clipboard write failed:', err);
  });
}

// ============================================================
// Event wiring (MV3 CSP forbids inline onclick)
// ============================================================
document.getElementById('verify-btn').addEventListener('click', checkConnection);

document.querySelectorAll('.platform-btn').forEach((btn) => {
  btn.addEventListener('click', () => selectPlatform(btn.dataset.platform));
});

document.querySelectorAll('[data-copy-target]').forEach((btn) => {
  btn.addEventListener('click', () => copyCommand(btn.dataset.copyTarget, btn));
});
