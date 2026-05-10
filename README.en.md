# DevTools++

[한국어](README.md) | **English**

> A lightweight web and API analysis tool built into Chrome DevTools — no separate proxy, no context-switching, just open DevTools and start working.

[![Version](https://img.shields.io/badge/version-0.9.2-blue)](#)
[![License](https://img.shields.io/badge/license-MIT-green)](#)
[![Chrome](https://img.shields.io/badge/Chrome-MV3-yellow)](#)

---

## What is DevTools++?

Whatever your role — security, dev, or ops — you can gain visibility into browser traffic, analyze it, and test it without installing a separate tool.

Chrome DevTools is already powerful. But for security analysis and API testing, the workflow is awkward and clunky. DevTools++ surfaces those core capabilities in a more ergonomic form.

DevTools++ is a lightweight web/API testing tool that combines the native feel of Chrome DevTools with the essential features of dedicated testing tools.

```
Native DevTools  →  DevTools++  →  Burp Suite / Postman
  (Notepad)        (Notepad++)      (Full IDE)
```

---

## Screenshots

**Monitor** — global host tree on the left, per-host session tabs above the request list, and the Message detail tab rendering raw HTTP with header colorization.
![Monitor](docs/screenshots/01-monitor.png)

**Replay** — KV editor on the request pane (Method / URL / HTTP version + Headers / Body tabs), forbidden headers locked, response with JSON diff against the original.
![Replay](docs/screenshots/02-replay.png)

**Detection** — automatic security-pattern flagging with per-category guidance for what to test next.
![Detection](docs/screenshots/03-detection.png)

**Intercept** — request and response panels with raw HTTP coloring, header-only side activation, and alternating focus on Forward.
![Intercept](docs/screenshots/04-intercept.png)

**Initiator** — call stack with source-map decoded frames and sensitive-pattern highlighting (auth / token / payment / ...).
![Initiator](docs/screenshots/05-initiator.png)

---

## Features

### 📡 Monitor

The unified workspace for capturing browser traffic, exploring it, and inspecting individual requests. Replaces the separate Network and Site Map tabs from earlier versions.

- **Global host tree** (left pane) — every captured host shown as a path tree, gutter-resizable, **visible in both Monitor and Intercept tabs**. Click a node to jump to that endpoint's request in the list.
- **Per-session tabs** (above the request list) — each main host you visit gets its own tab. Tabs partition by **session**: the github.com tab shows direct github.com requests AND the externals captured during that visit (CDN, .map files, analytics, ads), so it mirrors what actually loaded on the page. Tabs persist across navigation; revisiting a host reuses its tab.
- **All / Host-only toggle** — segmented control per tab. Default `All` (the full session). Flip to `Host only` when externals are noise and you want just the same-origin traffic.
- **Set Scope** dropdown on host rows in the tree — Exact (`host/*`) or Wildcard (`*.parent.com/*`) — pins the global Scope without typing the pattern.
- **Append-only request table** tuned for sites that fire 200+ requests per page (rAF batching, body-load queue, 1,000-row display cap with full history retained).
- **Columns**: Host / Method / URL / Status / Type / Size / Time / Initiator / Detection
- **Detail panel** (right) opens on row click with three tabs:
  - **Message** — Request and Response stacked vertically as on-the-wire raw HTTP. Renders the actual protocol version (HTTP/1.1 vs HTTP/2 — h2 pseudo-headers like `:authority` are detected and reflected on the request line). Header names colorized for scannability. Raw / Pretty toggle per side. **Replay** is a button on the request pane (see below). **Preview** is a button on the response pane (HTML iframe / image / JSON tree).
  - **Initiator** — call-stack from HAR `_initiator`, with sensitive-pattern flagging and source-map decoding.
  - **Detection** — the security-pattern findings for that request.
- **Send to Browser** — re-issue any captured request in a new tab so it actually renders, while the navigation lands in the Intercept queue. Handles HTTP/2 captures correctly (pseudo-headers stripped before forwarding).
- **Auto Crawl** — import a URL list and automatically visit each page, capturing all network traffic.
- **Replay-originated requests** show a yellow tint + ↻ badge in the request list so you can tell live captures from replays at a glance.
- **Auto-start option** — monitoring begins automatically when DevTools opens.
- **Network search** across captured requests (URL, headers, bodies, Detection results) with prev / next navigation.

### 🔍 Detection

Automatically analyzes captured requests and responses for security-relevant patterns. Every finding is a **test point**, not a confirmed vulnerability — use Replay to verify.

**Response analysis**

| Badge | Category | Severity | What it detects |
|---|---|---|---|
| 🔑 | token | HIGH | JWT or API key exposed in response body |
| 🔴 | sensitive | HIGH | Password / secret fields in response or request body |
| 👤 | pii | MEDIUM | Email addresses or phone numbers in response |
| ⚠️ | leak | MEDIUM | Internal IPs (private ranges only), stack traces, server paths |
| 📡 | exposure | MEDIUM/HIGH | Server version headers, AWS keys, GitHub PATs |

**Request analysis**

| Badge | Category | Severity | What it detects |
|---|---|---|---|
| 🔢 | idor | INFO | ID parameters that may allow direct object reference |
| ⚠️ | privilege | HIGH | Role / admin / permission parameters in requests |
| 🔐 | session | MEDIUM | Session tokens passed as request parameters |
| 🔨 | tampering | MEDIUM | Parameters that may influence server-side logic (SQL, path, SSRF, command, debug) |
| 🔍 | check | INFO | 401/403 responses with unexpectedly large bodies |

Each Detection finding includes a contextual guide explaining what to test next.

### 🔓 Auto Decode Layer

Automatically detects and decodes encoded values anywhere in request/response headers and bodies — surfaces as a collapsible **🔍 Decoded** section in the Message tab.

- **JWT** — decodes header and payload inline, warns on `alg: none` and expired tokens
- **Base64** — decodes and pretty-prints JSON if applicable
- **URL-encoded** — shows decoded form
- **Nested JSON** — parses stringified JSON values
- **Unix timestamps** — converts to human-readable ISO dates

### 🔁 Replay & Tamper

Capture a request, edit anything, and resend — without leaving the Message tab.

- One-click `↻ Replay` button on the request pane swaps the raw HTTP view for an inline KV editor: Method dropdown · URL · HTTP version · Headers tab (checkbox + name + value rows) · Body tab.
- **Forbidden header lock** — `Cookie`, `User-Agent`, `Origin`, `Referer`, `Sec-*`, `Proxy-*`, `Access-Control-*` etc. that page-context fetch silently drops are visually locked (🔒) so you don't waste time editing values that won't go on the wire. Rename to a non-forbidden name to unlock.
- **Form-data view for POST bodies** — `application/x-www-form-urlencoded` payloads render as KV rows (toggle + name + value), matching native DevTools' Payload tab. Form ↔ Raw toggle round-trips through the form-urlencoded encoder. Other body types (JSON, multipart) stay as raw text.
- **HTTP version field is editable** — for security testing scenarios that record protocol-version tampering (the wire actually goes out as HTTP/1.1 via fetch).
- **Original / Modified** state button restores the seed.
- Response lands in the response pane with a `(replay)` tag.
- **Automatic JSON diff** against the original captured response.
- **CORS-bypass fallback** — if the page-context fetch fails (typically cross-origin assets without `Access-Control-Allow-Origin`), the panel automatically retries through the service worker (`<all_urls>` host_permissions, no page-level CORS gate). A small toast tells you when the fallback ran.

### 🔎 Initiator

Shows what triggered each request — and traces it back to original source code when source maps are available.

- **script** / **parser** / **↑ Mapped** type indicators in the request table — `↑ Mapped` resolves **proactively** at capture time so the column reflects the final state without having to click into each row first.
- Click an Initiator cell to jump directly to the Initiator detail tab.
- **Source map decoding** — maps minified call-stack frames back to original file and line number (e.g., `bundle.js:1:12345` → `Auth.tsx:42:5`).
- **Sensitive pattern detection** — highlights call-stack frames containing authentication, token, credential, payment, and other security-relevant function names.

### 📦 Import / Export

Save all captured requests and responses as a JSON file and reload them at any time.

- **Full Export** — saves the complete transaction (request/response headers, body, Detection results, Initiator call stack, session attribution) as a single JSON file.
- **Two scopes × two selections** — `Current tab` or `All tabs`, each with `Full requests` or `Selected requests` (rows checked via the per-row checkboxes).
- **Import** — load a previously exported JSON back into DevTools++ for re-analysis. Per-session tab attribution is preserved (or reconstructed from URL host for legacy exports), so the tab strip rebuilds itself.
- **AI-assisted analysis** — hand the exported JSON directly to an AI assistant (ChatGPT, Claude, etc.) to identify vulnerability patterns, generate summary reports, or explain specific API flows.

### 🔀 Intercept (Proxy Mode)

Intercept requests **before** they reach the server and responses **before** they reach the browser.

> ⚠️ **Proxy Mode requires a one-time native setup.** It's not as complicated as it sounds — a single install is all it takes. After that, it works just like any native DevTools feature. [See installation below.](#proxy-mode-setup)

- **Automatic proxy configuration** — enabling Proxy Mode activates the `:8899` proxy setting; no FoxyProxy or manual system proxy needed.
- **Tab-scoped** — only the DevTools-attached tab's requests are intercepted; other tabs, Service Workers, and Chrome's own background traffic pass through untouched.
- **Raw HTTP editor with syntax coloring** — request and response panes match the Monitor Message tab visually: request/status line in blue, header names in red-bold, body verbatim. Edit on top of the colored render in real time.
- **Raw / Pretty body toggle** — pretty-prints JSON bodies in place; headers stay untouched.
- **Request / Response decisions** — Forward · Forward Modified · Drop · Mock Response (request side) and Forward · Forward Modified · Drop (response side). Forward Modified parses the edited raw HTTP and forwards the modified payload.
- **Mock Response** as raw HTTP — write the entire response (`HTTP/1.1 200 OK` + headers + body) in one editor.
- **Header-only side activation** — clicking the body textarea no longer switches the active side, so the next `F`/`G`/`D`/`R` shortcut won't accidentally type into the editor.
- **Alternating focus on Forward** — `F` on the request side auto-switches to the response side when the response arrives; `F` on the response side switches back to the request side if another request is queued. The user can keep pressing `F` and the panel cycles request → response → next request.
- **Captured-pair viewing** — click any resolved log row to re-display the request and response in both editors as read-only, with a `🔒 Viewing captured` banner. Click `×` to exit. Pending live intercepts block log re-display so an inspector view never fights an active decision.
- URL wildcard / Method / extension-based bypass filters.
- Drag-resize gutters between queue, editor, and log so growing content scrolls inside its own pane instead of shrinking the message editors.
- Keyboard shortcuts: `F` Forward · `G` Forward Modified · `D` Drop · `R` Mock · `A` Forward All · `Q` Drop All.

---

## Installation

### Basic Installation

**Option A — Chrome Web Store** *(under review)*

**Option B — Latest release (recommended for non-developers)**

1. Go to [Releases](https://github.com/jsik22/devtools-pp/releases/latest) and download `devtools-pp-vX.Y.Z.zip`
2. Unzip it anywhere on your machine — this gives you a `chrome-devtools-extension/` folder
3. Open `chrome://extensions` → enable **Developer mode** (top right toggle)
4. Click **Load unpacked** → select the `chrome-devtools-extension` folder
5. Open any `https://` page → press `F12` → click the **DevTools++** tab

**Option C — Clone the repository (for development / latest commit)**

```bash
git clone https://github.com/jsik22/devtools-pp.git
```

Then follow steps 3–5 above, pointing **Load unpacked** at `devtools-pp/chrome-devtools-extension`.

> **Note**: DevTools++ panel requires an `https://` page to be open. Set your Chrome startup page to an `https://` site such as `https://google.com` to ensure the panel loads immediately on DevTools open.

---

### Proxy Mode Setup

Intercept requires a one-time installation of a local Native Messaging host.

**Requirements**: Node.js v16+

**macOS / Linux**

```bash
cd chrome-devtools-extension/native-proxy
chmod +x install.sh
./install.sh <extension-id>
```

```bash
# Trust the CA certificate for HTTPS interception

# macOS
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain \
  ~/.devtools-pp/ca.pem

# Linux (Debian/Ubuntu)
sudo cp ~/.devtools-pp/ca.pem /usr/local/share/ca-certificates/devtools-pp-ca.crt
sudo update-ca-certificates
```

**Windows**

```bat
cd chrome-devtools-extension\native-proxy
install.bat <extension-id>
```

```bat
certutil -addstore -user "Root" "%USERPROFILE%\.devtools-pp\ca.pem"
```

> Find your Extension ID at `chrome://extensions`

After installation: Restart Chrome → Open DevTools++ → Intercept tab → click **Proxy OFF** to start.

**What Proxy Mode does:**
- Routes browser traffic through a local MITM proxy at `127.0.0.1:8899`
- CA certificate is generated locally and never transmitted externally
- Verify the source: [`native-proxy/cert-generator.js`](chrome-devtools-extension/native-proxy/cert-generator.js)

> **nvm / fnm / asdf users**: After switching Node.js versions, rerun `install.sh` (or `install.bat`) to refresh the launcher's hard-coded node path.

---

## Architecture

### Why not chrome.debugger?

Chrome allows only one debugger connection per tab. Since the built-in DevTools already occupies that slot, `chrome.debugger.attach()` from a DevTools panel extension **always fails**.

Every feature in DevTools++ is implemented without `chrome.debugger`:

| Feature | Implementation |
|---|---|
| Network capture | `chrome.devtools.network` API |
| Intercept | Native Messaging + local MITM proxy |
| Replay | `fetch()` via `inspectedWindow.eval` |
| Source map decoding | VLQ base64 decoder + `getResources()` |

### Proxy Mode Communication

```
Browser ──proxy settings──▶ proxy-server.js (127.0.0.1:8899)
                                    │
                              stdin/stdout
                              (4-byte LE length prefix + JSON)
                                    │
                           native-messaging-host.js
                                    │
                           Chrome Native Messaging
                                    │
                             background.js (Service Worker)
                                    │
                           chrome.runtime.connect
                                    │
                               panel.js (UI)
```

---

## Known Limitations

| Issue | Details |
|---|---|
| Large bodies | Bodies over 512KB are truncated for performance |
| Service Worker bypass | Requests from Service Workers and Shared Workers are not intercepted (same limitation as FoxyProxy + Burp) |
| Source map availability | Source map decoding requires the `.map` file to be reachable — production sites that don't ship maps or block CORS for them stay unmapped |
| `.map` files in the request list | Chrome fetches source maps internally and caches them across reloads, so `.map` files only appear in the Monitor list on a cold load. Enable "Disable cache" in the main DevTools Network tab for full visibility |

---

## Roadmap

- [ ] Chrome Web Store release
- [ ] Request sequence chaining
- [ ] Multilingual support — Korean / English UI toggle

---

## Privacy

DevTools++ does not collect, transmit, or share any user data. All processing happens locally on your device.

- Captured network data is displayed within the DevTools++ panel only and never leaves your device
- Import / Export data is saved to your local disk only
- All Detection analysis runs locally within the extension
- The Proxy Mode MITM proxy runs at `127.0.0.1:8899` and does not relay traffic to any external server
- The CA certificate is generated locally (`~/.devtools-pp/ca.pem`) and never transmitted externally

See [PRIVACY.md](PRIVACY.md) for full details.

---

## Legal Notice

DevTools++ is intended for use on systems you own or have **explicit written permission** to test. Unauthorized use against third-party systems may violate applicable laws.

---

## License

MIT License — see [LICENSE](LICENSE) for details.

### Third-party

- **node-forge** — BSD-3-Clause license. See [NOTICE](NOTICE) for full attribution.
