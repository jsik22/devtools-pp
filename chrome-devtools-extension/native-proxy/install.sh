#!/bin/bash
set -e

# ============================================================
# DevTools++ Native Proxy Installer (macOS / Linux)
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_NAME="com.devtools_pp.proxy"
HOST_PATH="$SCRIPT_DIR/native-messaging-host.js"

# Detect OS
OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="macos" ;;
  Linux)  PLATFORM="linux" ;;
  *)
    echo "[ERROR] Unsupported OS: $OS"
    echo "This installer supports macOS and Linux only."
    echo "For Windows, use install.bat instead."
    exit 1
    ;;
esac

# Chrome / Chromium NM host manifest directories (per-user)
if [ "$PLATFORM" = "macos" ]; then
  CHROME_NM_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  CHROMIUM_NM_DIR="$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
else
  CHROME_NM_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
  CHROMIUM_NM_DIR="$HOME/.config/chromium/NativeMessagingHosts"
fi

# ============================================================
# 1. Extension ID
# ============================================================
EXTENSION_ID="${1:-}"

if [ -z "$EXTENSION_ID" ]; then
  echo ""
  echo "============================================"
  echo "  DevTools++ Native Proxy Installer"
  echo "============================================"
  echo ""
  echo "Usage: ./install.sh <extension-id>"
  echo ""
  echo "How to find your Extension ID:"
  echo "  1. Open chrome://extensions in Chrome"
  echo "  2. Enable Developer Mode"
  echo "  3. Copy the ID of the DevTools++ extension"
  echo "     (e.g., abcdefghijklmnopqrstuvwxyz123456)"
  echo ""
  exit 1
fi

echo ""
echo "============================================"
echo "  DevTools++ Native Proxy Installer"
echo "  Platform: $PLATFORM"
echo "============================================"
echo ""

# ============================================================
# 2. Check Node.js
# ============================================================
if ! command -v node &> /dev/null; then
  echo "[ERROR] Node.js is not installed."
  echo "Please install it from https://nodejs.org and try again."
  exit 1
fi

NODE_VERSION=$(node -v)
echo "[OK] Node.js $NODE_VERSION detected"

# ============================================================
# 3. npm dependencies
# ============================================================
echo ""
echo "[1/4] Installing npm dependencies..."
cd "$SCRIPT_DIR"
npm install --production 2>&1 | tail -1
echo "[OK] Dependencies installed"

# ============================================================
# 4. CA certificate
# ============================================================
echo ""
echo "[2/4] Generating CA certificate..."
CA_PATH=$(node -e "
  const cg = require('./cert-generator');
  cg.ensureCA();
  console.log(cg.getCACertPath());
")
echo "[OK] CA certificate: $CA_PATH"

# ============================================================
# 5. Native Messaging Host manifest
# ============================================================
echo ""
echo "[3/4] Registering Native Messaging Host..."

# Make host script executable
chmod +x "$HOST_PATH"

register_nm_host() {
  local nm_dir="$1"
  local browser_name="$2"

  mkdir -p "$nm_dir"
  cat > "$nm_dir/$HOST_NAME.json" << NMEOF
{
  "name": "$HOST_NAME",
  "description": "DevTools++ MITM Proxy Host",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
NMEOF
  echo "[OK] $browser_name NM Host registered: $nm_dir/$HOST_NAME.json"
}

register_nm_host "$CHROME_NM_DIR" "Chrome"

# Register for Chromium if directory exists
if [ "$PLATFORM" = "macos" ]; then
  CHROMIUM_CHECK="$HOME/Library/Application Support/Chromium"
else
  CHROMIUM_CHECK="$HOME/.config/chromium"
fi
if [ -d "$CHROMIUM_CHECK" ]; then
  register_nm_host "$CHROMIUM_NM_DIR" "Chromium"
fi

# ============================================================
# 6. Done
# ============================================================
echo ""
echo "[4/4] Installation complete!"
echo ""
echo "============================================"
echo "  Trust CA Certificate (for HTTPS)"
echo "============================================"
echo ""

if [ "$PLATFORM" = "macos" ]; then
  echo "Run the following command:"
  echo ""
  echo "  sudo security add-trusted-cert -d -r trustRoot \\"
  echo "    -k /Library/Keychains/System.keychain \\"
  echo "    $CA_PATH"
  echo ""
  echo "Or use Keychain Access:"
  echo "  1. Open Keychain Access app"
  echo "  2. File > Import Items > select $CA_PATH"
  echo "  3. Double-click 'DevTools++ MITM CA'"
  echo "  4. Trust > When using this certificate > Always Trust"
else
  echo "Option A — System-wide (requires root):"
  echo ""
  echo "  sudo cp $CA_PATH /usr/local/share/ca-certificates/devtools-pp-ca.crt"
  echo "  sudo update-ca-certificates"
  echo ""
  echo "Option B — Chrome only:"
  echo ""
  echo "  certutil -d sql:\$HOME/.pki/nssdb -A \\"
  echo "    -t \"C,,\" -n \"DevTools++ MITM CA\" \\"
  echo "    -i $CA_PATH"
  echo ""
  echo "  (Install libnss3-tools if certutil is not found:"
  echo "   sudo apt install libnss3-tools)"
fi

echo ""
echo "If you skip this, HTTP interception will still work"
echo "but HTTPS will show certificate errors."
echo ""
echo "============================================"
echo "  Summary"
echo "============================================"
echo "  Platform     : $PLATFORM"
echo "  Extension ID : $EXTENSION_ID"
echo "  Proxy Host   : $HOST_PATH"
echo "  CA Cert      : $CA_PATH"
echo "  Proxy Port   : 8899 (default)"
echo "============================================"
echo ""
echo "Restart Chrome, then open DevTools++ Intercept tab"
echo "and select 'Proxy Mode'."
echo ""
