# Privacy Policy — DevTools++

Last updated: May 2026

## Summary

DevTools++ does not collect, transmit, or share any user data. All processing happens locally on your device.

## Data Collection

DevTools++ collects no data whatsoever.

- No analytics
- No telemetry
- No crash reporting
- No usage statistics
- No personal information

## How DevTools++ Works

DevTools++ operates entirely within your browser and your local machine:

- **Network monitoring**: Captures HTTP requests and responses from the inspected tab using Chrome's built-in DevTools API (`chrome.devtools.network`). This data is displayed in the DevTools++ panel and never leaves your device.
- **Import / Export**: Request and response data is saved to files on your local disk only. No data is uploaded to any server.
- **Detection**: All pattern analysis runs locally in the extension. No request or response content is sent externally.
- **Proxy Mode (Intercept)**: Traffic is routed through a local MITM proxy running on `127.0.0.1:8899`. The proxy process runs entirely on your machine. No traffic is relayed to any external server.
- **CA Certificate**: The certificate used for HTTPS interception is generated locally on your machine and stored at `~/.devtools-pp/ca.pem`. It is never transmitted externally.
- **Source Map Decoding**: Source map files are fetched directly from the URLs already present in the inspected page's scripts. No additional requests are made by DevTools++.

## Permissions

DevTools++ requests the following Chrome permissions:

| Permission | Why it's needed |
|---|---|
| `<all_urls>` (host permission) | Required to monitor network requests across all websites in the inspected tab |
| `activeTab` | Required to identify the currently inspected tab |
| `nativeMessaging` | Required to communicate with the local proxy process for Intercept |
| `proxy` | Required to route the inspected tab's traffic through the local MITM proxy |
| `declarativeNetRequest` | Required to apply tab-scoped proxy routing rules |
| `storage` | Required to persist user settings (scope, auto-start preference, etc.) locally |

All permissions are used solely to provide the features described above. No data accessed through these permissions is transmitted externally.

## Third-party Services

DevTools++ does not use any third-party services, APIs, or SDKs.

The only third-party library used is `node-forge` (BSD-3-Clause license), which runs locally for TLS certificate generation. See [NOTICE](NOTICE) for details.

## Data Sharing

DevTools++ does not sell, share, or transfer any user data to third parties — under any circumstances.

## Contact

If you have any questions about this privacy policy, please open an issue on the GitHub repository.
