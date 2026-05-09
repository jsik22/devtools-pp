'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const url = require('url');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const certGenerator = require('./cert-generator');

// Decompress an upstream response body based on Content-Encoding so
// the panel sees text it can actually read. Returns the decoded buffer
// (or the original on unknown encoding / decompression failure) plus
// `hadEncoding` — true if the upstream claimed any non-identity encoding.
// Forward Modified uses `hadEncoding` to know it must strip
// Content-Encoding before writing the user-edited (plain) body back to
// the browser, regardless of whether decompression actually succeeded.
function _decodeResponseBody(buf, contentEncoding) {
  const enc = (contentEncoding || '').toLowerCase().trim();
  const hadEncoding = enc !== '' && enc !== 'identity';
  if (!hadEncoding) {
    return { body: buf, hadEncoding: false };
  }
  try {
    if (enc === 'gzip' || enc === 'x-gzip') {
      return { body: zlib.gunzipSync(buf), hadEncoding: true };
    }
    if (enc === 'deflate') {
      // Some servers send raw deflate (no zlib wrapper). Try inflate
      // first; on failure, fall back to inflateRaw.
      try { return { body: zlib.inflateSync(buf), hadEncoding: true }; }
      catch { return { body: zlib.inflateRawSync(buf), hadEncoding: true }; }
    }
    if (enc === 'br') {
      return { body: zlib.brotliDecompressSync(buf), hadEncoding: true };
    }
  } catch {
    // Decompression failed — keep raw bytes but still report hadEncoding
    // so Forward Modified strips the (now meaningless) header.
  }
  return { body: buf, hadEncoding: true };
}

class ProxyServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 8899;
    this.bypassPatterns = (options.bypassPatterns || []).map(p => new RegExp(p, 'i'));
    this.urlFilter = null; // RegExp — if set, only intercept matching URLs
    this.methodFilter = ''; // empty string = all
    this.interceptActive = false;
    this.interceptResponse = options.interceptResponse || false;
    this.pendingRequests = new Map();
    this.pendingResponses = new Map();
    // Header swaps registered ahead of a "Send to Browser" navigation in
    // a new tab. Keyed by tabId; the next request from that tab to the
    // matching URL gets the registered headers merged in, then the
    // entry is consumed and a `header_swap_consumed` event fires so the
    // extension can drop the tab's DNR tag rule (one-shot interception).
    this.pendingHeaderSwaps = new Map();
    this.headerSwapTtlMs = options.headerSwapTtlMs || 30000;
    this.requestTimeout = options.requestTimeout || 60000; // 60s default
    this.server = null;
    this._idCounter = 0;
  }

  // Lowercase header name used by the extension's declarativeNetRequest rule
  // to mark requests that originated from the inspected DevTools tab.
  static get TAG_HEADER() { return 'x-devtoolspp-tab'; }

  _makeId() {
    return 'proxy_' + Date.now().toString(36) + '_' + (++this._idCounter);
  }

  _shouldBypass(reqUrl, method) {
    // Method filter: bypass if method doesn't match
    if (this.methodFilter && method && method.toUpperCase() !== this.methodFilter) return true;
    // URL filter (include): match against host+pathname only — never against the
    // query string. Trackers (Google Analytics, Doubleclick, etc.) embed the
    // origin page URL as a query parameter, which would otherwise cause naive
    // substring matching to incorrectly include them.
    if (this.urlFilter) {
      const target = this._filterTarget(reqUrl);
      if (!this.urlFilter.test(target)) return true;
    }
    // Bypass pattern (exclude): bypass if matched (still tested against full URL
    // because bypass patterns commonly target file extensions in the query)
    return this.bypassPatterns.some(re => re.test(reqUrl));
  }

  // Strip protocol/query/hash so the URL filter only sees host + pathname.
  _filterTarget(reqUrl) {
    try {
      const u = new URL(reqUrl);
      return u.host + u.pathname;
    } catch {
      return reqUrl;
    }
  }

  // ============================================================
  // Header swap registry — used by "Send to Browser (new tab)"
  // ============================================================
  registerHeaderSwap(payload) {
    if (!payload || payload.tabId == null || !payload.url) return;
    this.pendingHeaderSwaps.set(String(payload.tabId), {
      url: payload.url,
      headers: payload.headers || {},
      expiresAt: Date.now() + this.headerSwapTtlMs,
    });
  }

  _consumeHeaderSwap(tabId, fullUrl) {
    const key = String(tabId);
    const entry = this.pendingHeaderSwaps.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.pendingHeaderSwaps.delete(key);
      return null;
    }
    if (!ProxyServer._urlsMatchForSwap(entry.url, fullUrl)) return null;
    this.pendingHeaderSwaps.delete(key);
    // Notify so the extension can remove the tab's DNR tag rule —
    // subsequent navigations in that tab should not be intercepted.
    this.emit('header_swap_consumed', { tabId: key, url: fullUrl });
    return entry;
  }

  static _urlsMatchForSwap(a, b) {
    try {
      const ua = new URL(a);
      const ub = new URL(b);
      return ua.host === ub.host
        && ua.pathname === ub.pathname
        && ua.search === ub.search;
    } catch {
      return a === b;
    }
  }

  // Lowercase swap header names overwrite same-named browser-set
  // headers. Anything not in the swap (Cookie, Origin, etc.) passes
  // through unchanged. HTTP/2 pseudo-headers (`:authority`, `:method`,
  // etc.) are dropped — they're invalid in HTTP/1.1 and would throw
  // ERR_INVALID_HTTP_TOKEN when handed to http.request().
  static _applyHeaderSwap(reqHeaders, swapHeaders) {
    const result = { ...reqHeaders };
    for (const [name, value] of Object.entries(swapHeaders || {})) {
      if (name.startsWith(':')) continue;
      result[name.toLowerCase()] = value;
    }
    return result;
  }

  // Strip headers that http.request() would reject. Today this is
  // HTTP/2 pseudo-headers (anything starting with ':') — they sneak in
  // via captured request data on h2 origins. Invalid token characters
  // would otherwise throw synchronously and unwind the message handler.
  static _stripInvalidH1Headers(headers) {
    const out = {};
    for (const [name, value] of Object.entries(headers || {})) {
      if (name.startsWith(':')) continue;
      out[name] = value;
    }
    return out;
  }

  /**
   * Read the full request body from an IncomingMessage
   */
  _readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', () => resolve(Buffer.alloc(0)));
    });
  }

  /**
   * Forward a request to the real server and pipe response back
   */
  _forwardRequest(method, targetUrl, headers, body, clientRes, requestId) {
    const parsed = new URL(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    // Remove proxy-specific headers + any HTTP/2 pseudo-headers that
    // crept in from a captured-on-h2 request (those would throw
    // ERR_INVALID_HTTP_TOKEN inside transport.request below).
    const fwdHeaders = ProxyServer._stripInvalidH1Headers(headers);
    delete fwdHeaders['proxy-connection'];
    delete fwdHeaders['proxy-authorization'];

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: method,
      headers: fwdHeaders,
      rejectUnauthorized: false, // Accept self-signed certs on targets
    };

    let proxyReq;
    try {
      proxyReq = transport.request(options, (proxyRes) => {
      if (requestId) {
        // Buffer response body
        const chunks = [];
        proxyRes.on('data', chunk => chunks.push(chunk));
        proxyRes.on('end', () => {
          const respBuf = Buffer.concat(chunks);
          // Decode based on Content-Encoding so the panel shows readable
          // text instead of compressed garbage. We keep both the raw
          // buffer (for plain Forward — browser decodes natively) and
          // the decoded buffer (for the panel + Forward Modified).
          const contentEncoding = proxyRes.headers['content-encoding'] || '';
          const { body: decodedBuf, hadEncoding } = _decodeResponseBody(respBuf, contentEncoding);
          let respBody;
          if (decodedBuf.length > 512 * 1024) {
            respBody = decodedBuf.slice(0, 512 * 1024).toString('utf8');
          } else {
            respBody = decodedBuf.toString('utf8');
          }

          if (this.interceptResponse) {
            // Hold response for user decision
            const respId = requestId + '_resp';
            const timer = setTimeout(() => {
              if (this.pendingResponses.has(respId)) {
                this.pendingResponses.delete(respId);
                clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
                clientRes.end(respBuf);
                this.emit('request_timeout', { id: respId });
              }
            }, this.requestTimeout);

            this.pendingResponses.set(respId, {
              id: respId,
              statusCode: proxyRes.statusCode,
              headers: { ...proxyRes.headers },
              body: respBuf,           // raw (compressed) — for plain Forward
              decodedBody: decodedBuf, // decompressed — for Forward Modified default
              wasEncoded: hadEncoding, // true → strip Content-Encoding on modified
              clientRes,
              timer,
            });

            this.emit('response_intercepted', {
              id: respId,
              requestId,
              method: method,
              url: targetUrl,
              statusCode: proxyRes.statusCode,
              headers: { ...proxyRes.headers },
              body: respBody,
              bodyLength: decodedBuf.length,
              bodyTruncated: decodedBuf.length > 512 * 1024,
              timestamp: Date.now(),
            });
          } else {
            // Pass through and notify
            clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
            clientRes.end(respBuf);
            this.emit('response_captured', {
              id: requestId,
              statusCode: proxyRes.statusCode,
              headers: proxyRes.headers,
              body: respBody,
              bodyLength: decodedBuf.length,
              bodyTruncated: decodedBuf.length > 512 * 1024,
            });
          }
        });
      } else {
        clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(clientRes);
      }
    });
    } catch (err) {
      // transport.request() validates header tokens synchronously and
      // throws TypeError on names like ":authority". Without this catch
      // the throw becomes an unhandled rejection inside the async
      // message handler and kills the host process — which manifests
      // to the user as Intercept silently turning off mid-flight.
      this.emit('error', new Error('Forward setup failed: ' + err.message));
      try {
        clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
        clientRes.end('Proxy Error: ' + err.message);
      } catch {}
      return;
    }

    proxyReq.on('error', (err) => {
      try {
        clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
        clientRes.end('Proxy Error: ' + err.message);
      } catch {}
    });

    if (body && body.length > 0) {
      proxyReq.write(body);
    }
    proxyReq.end();
  }

  /**
   * Handle an intercepted HTTP request (both plain HTTP and decrypted HTTPS)
   */
  async _handleRequest(req, res, isHttps) {
    const body = await this._readBody(req);

    // Build full URL
    let fullUrl;
    if (req.url.startsWith('http://') || req.url.startsWith('https://')) {
      fullUrl = req.url; // Absolute URL (plain HTTP proxy)
    } else {
      const proto = isHttps ? 'https' : 'http';
      const host = req.headers.host || 'localhost';
      fullUrl = `${proto}://${host}${req.url}`;
    }

    // Tab scoping: the extension injects X-DevToolsPP-Tab on every request
    // from the inspected tab via declarativeNetRequest. Requests without this
    // header come from other tabs / service workers / extensions and must be
    // forwarded untouched. Always strip the header so origin servers never
    // see it.
    const tabIdTag = req.headers[ProxyServer.TAG_HEADER];
    const hasTabTag = tabIdTag != null;
    if (hasTabTag) {
      delete req.headers[ProxyServer.TAG_HEADER];
    }

    // Header-swap consumption for Send-to-Browser. Runs before bypass
    // and intercept-queue checks so the swap-merged headers show up in
    // the queue editor exactly as they will go upstream.
    if (hasTabTag) {
      const swap = this._consumeHeaderSwap(tabIdTag, fullUrl);
      if (swap) {
        req.headers = ProxyServer._applyHeaderSwap(req.headers, swap.headers);
      }
    }

    // Forward immediately if: intercept off, request not from inspected tab,
    // or a bypass rule matches
    if (!this.interceptActive || !hasTabTag || this._shouldBypass(fullUrl, req.method)) {
      this._forwardRequest(req.method, fullUrl, req.headers, body, res);
      return;
    }

    const id = this._makeId();

    // Set up timeout auto-forward
    const timer = setTimeout(() => {
      if (this.pendingRequests.has(id)) {
        this.pendingRequests.delete(id);
        this._forwardRequest(req.method, fullUrl, req.headers, body, res);
        this.emit('request_timeout', { id });
      }
    }, this.requestTimeout);

    // Store pending request
    this.pendingRequests.set(id, {
      id,
      method: req.method,
      url: fullUrl,
      headers: { ...req.headers },
      body,
      clientRes: res,
      timer,
    });

    // Body as string for the extension (truncate large bodies)
    let bodyStr = null;
    if (body.length > 0) {
      if (body.length > 512 * 1024) {
        bodyStr = body.slice(0, 512 * 1024).toString('utf8');
      } else {
        bodyStr = body.toString('utf8');
      }
    }

    // Emit to native messaging host
    this.emit('request_intercepted', {
      id,
      method: req.method,
      url: fullUrl,
      headers: { ...req.headers },
      body: bodyStr,
      bodyLength: body.length,
      bodyTruncated: body.length > 512 * 1024,
      timestamp: Date.now(),
    });
  }

  /**
   * Handle a decision from the extension for a pending request
   */
  handleDecision(id, decision) {
    // Check if this is a response decision
    if (id.endsWith('_resp')) {
      return this._handleResponseDecision(id, decision);
    }

    const pending = this.pendingRequests.get(id);
    if (!pending) return false;

    clearTimeout(pending.timer);
    this.pendingRequests.delete(id);

    const { method, url: reqUrl, headers, body, clientRes } = pending;

    switch (decision.action) {
      case 'forward':
        this._forwardRequest(method, reqUrl, headers, body, clientRes, id);
        break;

      case 'forward_modified': {
        const newMethod = decision.method || method;
        const newUrl = decision.url || reqUrl;
        const newHeaders = decision.headers || headers;
        const newBody = decision.body != null ? Buffer.from(decision.body, 'utf8') : body;
        this._forwardRequest(newMethod, newUrl, newHeaders, newBody, clientRes, id);
        break;
      }

      case 'drop':
        try {
          clientRes.writeHead(444, {});
          clientRes.end();
        } catch {
          try { clientRes.destroy(); } catch {}
        }
        break;

      case 'mock': {
        const mockHeaders = { 'Content-Type': 'text/plain' };
        if (decision.responseHeaders) {
          if (Array.isArray(decision.responseHeaders)) {
            decision.responseHeaders.forEach(h => { mockHeaders[h.name] = h.value; });
          } else {
            Object.assign(mockHeaders, decision.responseHeaders);
          }
        }
        try {
          clientRes.writeHead(decision.responseStatus || 200, mockHeaders);
          clientRes.end(decision.responseBody || '');
        } catch {}
        break;
      }

      default:
        this._forwardRequest(method, reqUrl, headers, body, clientRes);
    }

    return true;
  }

  /**
   * Handle a decision for a held response
   */
  _handleResponseDecision(id, decision) {
    const pending = this.pendingResponses.get(id);
    if (!pending) return false;

    clearTimeout(pending.timer);
    this.pendingResponses.delete(id);

    const { statusCode, headers, body, decodedBody, wasEncoded, clientRes } = pending;

    switch (decision.action) {
      case 'forward':
        // Send the raw (still-compressed) buffer — browser uses the
        // upstream Content-Encoding header to decode natively.
        try {
          clientRes.writeHead(statusCode, headers);
          clientRes.end(body);
        } catch {}
        break;

      case 'forward_modified': {
        const newStatus = decision.responseStatus || statusCode;
        // The user edited a decoded body, so the bytes we're about to
        // send are plain — strip Content-Encoding (and Content-Length,
        // which Node will recompute) so the browser doesn't try to
        // decompress plain bytes. Transfer-Encoding: chunked also
        // becomes stale once we send a single buffer.
        const newHeaders = { ...(decision.headers || headers) };
        if (wasEncoded) {
          delete newHeaders['content-encoding'];
          delete newHeaders['Content-Encoding'];
        }
        delete newHeaders['content-length'];
        delete newHeaders['Content-Length'];
        delete newHeaders['transfer-encoding'];
        delete newHeaders['Transfer-Encoding'];
        const newBody = decision.body != null
          ? Buffer.from(decision.body, 'utf8')
          : (decodedBody || body);
        try {
          clientRes.writeHead(newStatus, newHeaders);
          clientRes.end(newBody);
        } catch {}
        break;
      }

      case 'drop':
        try {
          clientRes.writeHead(444, {});
          clientRes.end();
        } catch {
          try { clientRes.destroy(); } catch {}
        }
        break;

      default:
        try {
          clientRes.writeHead(statusCode, headers);
          clientRes.end(body);
        } catch {}
    }

    return true;
  }

  /**
   * Forward all pending requests (used when stopping intercept)
   */
  forwardAllPending() {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      this._forwardRequest(pending.method, pending.url, pending.headers, pending.body, pending.clientRes);
    }
    this.pendingRequests.clear();
    for (const [id, pending] of this.pendingResponses) {
      clearTimeout(pending.timer);
      try {
        pending.clientRes.writeHead(pending.statusCode, pending.headers);
        pending.clientRes.end(pending.body);
      } catch {}
    }
    this.pendingResponses.clear();
    // Drop swap entries with no navigation behind them so they can't
    // leak into a later intercept session.
    this.pendingHeaderSwaps.clear();
  }

  /**
   * Handle CONNECT method for HTTPS tunneling with MITM
   */
  _handleConnect(req, clientSocket, head) {
    const [hostname, port] = req.url.split(':');
    const targetPort = parseInt(port) || 443;

    // If intercept not active, just tunnel without MITM
    if (!this.interceptActive) {
      const serverSocket = net.connect(targetPort, hostname, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        serverSocket.write(head);
        serverSocket.pipe(clientSocket);
        clientSocket.pipe(serverSocket);
      });
      serverSocket.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => serverSocket.destroy());
      return;
    }

    // MITM: generate cert for this hostname and terminate TLS
    let hostCert;
    try {
      hostCert = certGenerator.generateHostCert(hostname);
    } catch (err) {
      this.emit('error', new Error(`Cert generation failed for ${hostname}: ${err.message}`));
      // Fallback: plain tunnel
      const serverSocket = net.connect(targetPort, hostname, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        serverSocket.write(head);
        serverSocket.pipe(clientSocket);
        clientSocket.pipe(serverSocket);
      });
      serverSocket.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => serverSocket.destroy());
      return;
    }

    // Tell browser the tunnel is established
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    // Create a TLS server socket to decrypt browser's traffic
    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      key: hostCert.key,
      cert: hostCert.cert,
    });

    // Create a mini HTTP server to parse decrypted requests
    const miniServer = http.createServer((req, res) => {
      // Store the target hostname/port for proper forwarding
      if (!req.headers.host) {
        req.headers.host = hostname + (targetPort !== 443 ? ':' + targetPort : '');
      }
      this._handleRequest(req, res, true);
    });

    tlsSocket.on('error', () => {
      try { clientSocket.destroy(); } catch {}
    });

    // Feed decrypted data into the mini server by emitting a connection event
    miniServer.emit('connection', tlsSocket);

    // If there was any head data, push it into the TLS socket
    if (head && head.length > 0) {
      tlsSocket.unshift(head);
    }
  }

  /**
   * Start the proxy server
   */
  start() {
    return new Promise((resolve, reject) => {
      // Ensure CA is ready before starting
      try {
        certGenerator.ensureCA();
      } catch (err) {
        reject(new Error('Failed to initialize CA: ' + err.message));
        return;
      }

      this.server = http.createServer((req, res) => {
        this._handleRequest(req, res, false);
      });

      this.server.on('connect', (req, socket, head) => {
        this._handleConnect(req, socket, head);
      });

      this.server.on('error', (err) => {
        this.emit('error', err);
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        this.emit('status', {
          listening: true,
          port: this.port,
          pendingCount: this.pendingRequests.size,
        });
        resolve(this.port);
      });
    });
  }

  /**
   * Stop the proxy server
   */
  stop() {
    return new Promise((resolve) => {
      this.forwardAllPending();
      this.interceptActive = false;
      if (this.server) {
        const forceTimer = setTimeout(() => {
          if (this.server) {
            this.server = null;
            resolve();
          }
        }, 3000);
        this.server.close(() => {
          clearTimeout(forceTimer);
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(config) {
    if (config.bypassPatterns) {
      this.bypassPatterns = config.bypassPatterns.map(p => new RegExp(p, 'i'));
    }
    if (typeof config.urlFilter === 'string') {
      try {
        this.urlFilter = config.urlFilter ? new RegExp(config.urlFilter, 'i') : null;
      } catch { this.urlFilter = null; }
    }
    if (typeof config.methodFilter === 'string') {
      this.methodFilter = config.methodFilter;
    }
    if (typeof config.interceptActive === 'boolean') {
      this.interceptActive = config.interceptActive;
      if (!config.interceptActive) {
        this.forwardAllPending();
      }
    }
    if (typeof config.interceptResponse === 'boolean') {
      this.interceptResponse = config.interceptResponse;
    }
  }
}

module.exports = ProxyServer;
