'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const url = require('url');
const { EventEmitter } = require('events');
const certGenerator = require('./cert-generator');

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
  // through unchanged.
  static _applyHeaderSwap(reqHeaders, swapHeaders) {
    const result = { ...reqHeaders };
    for (const [name, value] of Object.entries(swapHeaders || {})) {
      result[name.toLowerCase()] = value;
    }
    return result;
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

    // Remove proxy-specific headers
    const fwdHeaders = { ...headers };
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

    const proxyReq = transport.request(options, (proxyRes) => {
      if (requestId) {
        // Buffer response body
        const chunks = [];
        proxyRes.on('data', chunk => chunks.push(chunk));
        proxyRes.on('end', () => {
          const respBuf = Buffer.concat(chunks);
          let respBody;
          if (respBuf.length > 512 * 1024) {
            respBody = respBuf.slice(0, 512 * 1024).toString('utf8');
          } else {
            respBody = respBuf.toString('utf8');
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
              body: respBuf,
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
              bodyLength: respBuf.length,
              bodyTruncated: respBuf.length > 512 * 1024,
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
              bodyLength: respBuf.length,
              bodyTruncated: respBuf.length > 512 * 1024,
            });
          }
        });
      } else {
        clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(clientRes);
      }
    });

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

    const { statusCode, headers, body, clientRes } = pending;

    switch (decision.action) {
      case 'forward':
        try {
          clientRes.writeHead(statusCode, headers);
          clientRes.end(body);
        } catch {}
        break;

      case 'forward_modified': {
        const newStatus = decision.responseStatus || statusCode;
        const newHeaders = decision.headers || headers;
        const newBody = decision.body != null ? Buffer.from(decision.body, 'utf8') : body;
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
