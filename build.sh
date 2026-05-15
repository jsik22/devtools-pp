#!/usr/bin/env bash
# DevTools++ release packager.
#
# Produces two zips from chrome-devtools-extension/:
#
#   1. devtools-pp-v<ver>.zip      — GitHub release / "load unpacked".
#      Top-level folder is chrome-devtools-extension/. Includes native-proxy/
#      (GitHub users need it for Intercept). Excludes node_modules, generated
#      per-machine launchers, .DS_Store.
#
#   2. devtools-pp-cws-v<ver>.zip  — Chrome Web Store upload.
#      manifest.json at ZIP ROOT (CWS requirement). Excludes native-proxy/
#      entirely: the CWS-installed extension dir is version-stamped and wiped
#      on every update, so the proxy can't reliably run from there — CWS users
#      obtain native-proxy from GitHub (see setup.html Step 1). Dropping it
#      also shrinks the package and reduces review surface (no bundled MITM
#      proxy / shell installers).
#
# Both zips are gitignored build artifacts. Usage: ./build.sh

set -euo pipefail
cd "$(dirname "$0")"

SRC="chrome-devtools-extension"
VER="$(grep '"version"' "$SRC/manifest.json" | head -1 | sed 's/[^0-9.]*//g')"
if [ -z "$VER" ]; then
  echo "[ERROR] could not read version from $SRC/manifest.json" >&2
  exit 1
fi

GH_ZIP="devtools-pp-v${VER}.zip"
CWS_ZIP="devtools-pp-cws-v${VER}.zip"

# Shared exclusions (paths are relative to the zip's internal layout).
COMMON_EX=( '*/node_modules/*' '*/.DS_Store' '.DS_Store' \
            '*/native-messaging-host.sh' '*/native-messaging-host.bat' )

echo "==> Building $GH_ZIP (GitHub / load-unpacked, native-proxy included)"
rm -f "$GH_ZIP"
zip -rq "$GH_ZIP" "$SRC" -x "${COMMON_EX[@]}"

echo "==> Building $CWS_ZIP (Chrome Web Store, manifest at root, native-proxy excluded)"
rm -f "$CWS_ZIP"
( cd "$SRC" && zip -rq "../$CWS_ZIP" . -x "${COMMON_EX[@]}" 'native-proxy/*' )

echo
echo "GitHub : $GH_ZIP   ($(unzip -l "$GH_ZIP"  | tail -1 | awk '{print $2}') files)"
echo "CWS    : $CWS_ZIP  ($(unzip -l "$CWS_ZIP" | tail -1 | awk '{print $2}') files)"
echo
echo "Sanity — CWS zip manifest must be at root:"
if unzip -Z1 "$CWS_ZIP" | grep -qx 'manifest.json'; then echo "  OK: manifest.json at root"; else echo "  FAIL: manifest.json not at root" >&2; exit 1; fi
echo "Sanity — CWS zip must NOT contain native-proxy:"
if unzip -Z1 "$CWS_ZIP" | grep -q '^native-proxy/'; then echo "  FAIL: native-proxy present in CWS zip" >&2; exit 1; else echo "  OK: native-proxy excluded"; fi
