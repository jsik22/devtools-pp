'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const url = require('url');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const certGenerator = require('./cert-generator');

// Content-Encoding 기반으로 upstream 응답 body 압축 해제 → 패널이
// 실제로 읽을 수 있는 텍스트 보도록. 디코드된 buffer(또는 미지의 인코딩/
// 압축 해제 실패 시 원본) + `hadEncoding`(upstream이 non-identity 인코딩
// 을 주장했으면 true) 반환. Forward Modified가 `hadEncoding`을 보고
// 압축 해제 성공 여부와 무관하게 사용자가 편집한(plain) body를
// 브라우저에 쓰기 전에 Content-Encoding을 제거해야 함을 인지.
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
      // 일부 서버는 raw deflate 전송(zlib wrapper 없음). 먼저 inflate
      // 시도; 실패 시 inflateRaw로 fallback.
      try { return { body: zlib.inflateSync(buf), hadEncoding: true }; }
      catch { return { body: zlib.inflateRawSync(buf), hadEncoding: true }; }
    }
    if (enc === 'br') {
      return { body: zlib.brotliDecompressSync(buf), hadEncoding: true };
    }
  } catch {
    // 압축 해제 실패 — raw bytes 유지하되 hadEncoding은 보고해서
    // Forward Modified가 (이제 의미 없는) 헤더를 strip하도록.
  }
  return { body: buf, hadEncoding: true };
}

// 업스트림 TLS 검증용 CA 번들 — Node 기본 번들 + (지원 시) OS 신뢰 저장소.
// OS 저장소를 합치지 않으면 사내 루트 CA 등 브라우저는 신뢰하는 인증서를
// 프록시가 거부하게 됨. tls.getCACertificates 미지원(구버전 Node)이면 null →
// Node 기본 번들 사용.
let _upstreamCA;
function _getUpstreamCA() {
  if (_upstreamCA !== undefined) return _upstreamCA;
  _upstreamCA = null;
  try {
    if (typeof tls.getCACertificates === 'function') {
      _upstreamCA = [...new Set([
        ...tls.getCACertificates('default'),
        ...tls.getCACertificates('system'),
      ])];
    }
  } catch {
    _upstreamCA = null;
  }
  return _upstreamCA;
}

class ProxyServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 8899;
    this.bypassPatterns = (options.bypassPatterns || []).map(p => new RegExp(p, 'i'));
    this.urlFilter = null; // RegExp — 설정 시 매칭 URL만 인터셉트
    this.methodFilter = ''; // 빈 문자열 = all
    this.interceptActive = false;
    this.interceptResponse = options.interceptResponse || false;
    this.pendingRequests = new Map();
    this.pendingResponses = new Map();
    // 새 탭의 "Send to Browser" navigation 전에 등록된 header swap.
    // tabId 키; 그 탭에서 매칭 URL로 가는 다음 요청은 등록된 헤더가
    // 머지됨, 그 후 entry가 consume되고 `header_swap_consumed` 이벤트
    // 발화 → 확장이 그 탭의 DNR tag 룰을 드롭(일회성 interception).
    this.pendingHeaderSwaps = new Map();
    this.headerSwapTtlMs = options.headerSwapTtlMs || 30000;
    this.requestTimeout = options.requestTimeout || 60000; // 기본 60s
    this.server = null;
    this._idCounter = 0;
    // 인증서 경고를 이미 보낸 호스트 — 같은 호스트로 반복 경고 방지
    this._certWarnedHosts = new Set();
  }

  // 확장의 declarativeNetRequest 룰이 inspected DevTools 탭에서 시작된
  // 요청을 마킹하는 데 쓰는 lowercase 헤더 이름.
  static get TAG_HEADER() { return 'x-devtoolspp-tab'; }

  _makeId() {
    return 'proxy_' + Date.now().toString(36) + '_' + (++this._idCounter);
  }

  _shouldBypass(reqUrl, method) {
    // Method 필터: method 불일치면 bypass
    if (this.methodFilter && method && method.toUpperCase() !== this.methodFilter) return true;
    // URL 필터(include): host+pathname에 대해서만 매칭 — query string에 대해서는
    // 절대 안 함. tracker(Google Analytics, Doubleclick 등)가 origin 페이지 URL을
    // query 파라미터로 임베드 → 단순 substring 매칭이면 잘못 포함됨.
    if (this.urlFilter) {
      const target = this._filterTarget(reqUrl);
      if (!this.urlFilter.test(target)) return true;
    }
    // Bypass 패턴(exclude): 매치되면 bypass (full URL에 대해 테스트 — bypass
    // 패턴은 흔히 query의 파일 확장자를 대상으로 하기 때문)
    return this.bypassPatterns.some(re => re.test(reqUrl));
  }

  // protocol/query/hash 제거 → URL 필터가 host + pathname만 보도록.
  _filterTarget(reqUrl) {
    try {
      const u = new URL(reqUrl);
      return u.host + u.pathname;
    } catch {
      return reqUrl;
    }
  }

  // ============================================================
  // Header swap 레지스트리 — "Send to Browser (새 탭)"이 사용
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
    // 알림 → 확장이 그 탭의 DNR tag 룰을 제거 가능. 그 탭의 후속
    // navigation은 인터셉트되면 안 됨.
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

  // lowercase swap 헤더 이름은 같은 이름의 브라우저 설정 헤더를
  // 덮어씀. swap에 없는 것(Cookie, Origin 등)은 그대로 통과. HTTP/2
  // pseudo-headers(`:authority`, `:method` 등)는 drop — HTTP/1.1에서
  // invalid이고 http.request()에 넘기면 ERR_INVALID_HTTP_TOKEN을
  // 발생시킴.
  static _applyHeaderSwap(reqHeaders, swapHeaders) {
    const result = { ...reqHeaders };
    for (const [name, value] of Object.entries(swapHeaders || {})) {
      if (name.startsWith(':')) continue;
      result[name.toLowerCase()] = value;
    }
    return result;
  }

  // http.request()가 reject할 헤더 제거. 현재는 HTTP/2 pseudo-headers
  // (':'로 시작하는 모든 것) — h2 origin의 캡처 요청 데이터로 끼어듦.
  // invalid 토큰 문자가 있으면 동기적으로 throw해서 메시지 핸들러를
  // unwind함.
  static _stripInvalidH1Headers(headers) {
    const out = {};
    for (const [name, value] of Object.entries(headers || {})) {
      if (name.startsWith(':')) continue;
      out[name] = value;
    }
    return out;
  }

  /**
   * IncomingMessage에서 full request body 읽기
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
   * 실제 서버로 요청 forward + 응답 pipe back
   *
   * allowInvalidCert: true면 업스트림 인증서 오류를 허용(self-signed 스테이징
   * 대상 테스트용)하되 패널에 경고를 보냄. inspected 탭에서 온(태그된) 요청만
   * true — 다른 탭 트래픽은 브라우저와 동일하게 엄격 검증해서, Intercept 중
   * 위조 인증서가 우리 CA로 재서명돼 정상처럼 보이는 일을 막음.
   */
  _forwardRequest(method, targetUrl, headers, body, clientRes, requestId, allowInvalidCert = false) {
    const parsed = new URL(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    // proxy-specific 헤더 제거 + h2 origin의 캡처 요청에서 끼어든
    // HTTP/2 pseudo-header 제거(아래 transport.request 안에서
    // ERR_INVALID_HTTP_TOKEN 발생시킴).
    const fwdHeaders = ProxyServer._stripInvalidH1Headers(headers);
    delete fwdHeaders['proxy-connection'];
    delete fwdHeaders['proxy-authorization'];

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: method,
      headers: fwdHeaders,
      rejectUnauthorized: !allowInvalidCert,
    };
    if (isHttps && !allowInvalidCert) {
      const ca = _getUpstreamCA();
      if (ca) options.ca = ca;
    }

    let proxyReq;
    try {
      proxyReq = transport.request(options, (proxyRes) => {
      if (isHttps && allowInvalidCert && proxyRes.socket && proxyRes.socket.authorized === false
          && !this._certWarnedHosts.has(parsed.host)) {
        this._certWarnedHosts.add(parsed.host);
        this.emit('upstream_cert_warning', {
          host: parsed.host,
          url: targetUrl,
          error: String(proxyRes.socket.authorizationError || 'unknown'),
        });
      }
      if (requestId) {
        // 응답 body 버퍼링
        const chunks = [];
        proxyRes.on('data', chunk => chunks.push(chunk));
        proxyRes.on('end', () => {
          const respBuf = Buffer.concat(chunks);
          // Content-Encoding 기반 디코드 → 패널이 압축된 garbage 대신
          // 읽을 수 있는 텍스트 표시. raw buffer(plain Forward용 —
          // 브라우저가 native 디코드)와 디코드된 buffer(panel + Forward
          // Modified용) 양쪽 모두 보관.
          const contentEncoding = proxyRes.headers['content-encoding'] || '';
          const { body: decodedBuf, hadEncoding } = _decodeResponseBody(respBuf, contentEncoding);
          let respBody;
          if (decodedBuf.length > 512 * 1024) {
            respBody = decodedBuf.slice(0, 512 * 1024).toString('utf8');
          } else {
            respBody = decodedBuf.toString('utf8');
          }

          if (this.interceptResponse) {
            // 사용자 결정까지 응답 hold
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
              body: respBuf,           // raw (압축됨) — plain Forward용
              decodedBody: decodedBuf, // 디코드됨 — Forward Modified 기본용
              wasEncoded: hadEncoding, // true → modified 시 Content-Encoding 제거
              clientRes,
              timer,
            });
            // 브라우저가 요청을 취소(탭 이동·닫기)하면 hold 해제 + 패널에 알림
            clientRes.on('close', () => {
              const p = this.pendingResponses.get(respId);
              if (p && p.clientRes === clientRes) {
                clearTimeout(p.timer);
                this.pendingResponses.delete(respId);
                this.emit('request_aborted', { id: respId });
              }
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
            // 그대로 통과하고 알림
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
      // transport.request()는 헤더 토큰을 동기적으로 검증하고
      // ":authority" 같은 이름에서 TypeError throw. 이 catch가 없으면
      // throw가 async 메시지 핸들러 안에서 unhandled rejection이 되어
      // host 프로세스를 죽임 → 사용자에게는 Intercept가 도중에 silently
      // 꺼지는 것으로 나타남.
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
   * 인터셉트된 HTTP 요청 처리 (plain HTTP와 복호화된 HTTPS 모두)
   */
  async _handleRequest(req, res, isHttps) {
    const body = await this._readBody(req);

    // full URL 구성
    let fullUrl;
    if (req.url.startsWith('http://') || req.url.startsWith('https://')) {
      fullUrl = req.url; // 절대 URL (plain HTTP proxy)
    } else {
      const proto = isHttps ? 'https' : 'http';
      const host = req.headers.host || 'localhost';
      fullUrl = `${proto}://${host}${req.url}`;
    }

    // 탭 스코핑: 확장이 declarativeNetRequest로 inspected 탭의 모든
    // 요청에 X-DevToolsPP-Tab 주입. 이 헤더가 없는 요청은 다른 탭/
    // service worker/확장에서 온 것이므로 손대지 않고 forward. origin
    // 서버에 절대 안 보이도록 헤더는 항상 strip.
    const tabIdTag = req.headers[ProxyServer.TAG_HEADER];
    const hasTabTag = tabIdTag != null;
    if (hasTabTag) {
      delete req.headers[ProxyServer.TAG_HEADER];
    }

    // Send-to-Browser용 header-swap consume. bypass와 intercept-queue
    // 체크 전에 실행 → swap이 머지된 헤더가 큐 에디터에 upstream에
    // 갈 그대로 표시되도록.
    if (hasTabTag) {
      const swap = this._consumeHeaderSwap(tabIdTag, fullUrl);
      if (swap) {
        req.headers = ProxyServer._applyHeaderSwap(req.headers, swap.headers);
      }
    }

    // 즉시 forward 조건: intercept off, inspected 탭 외 요청, 또는
    // bypass 룰 매치
    if (!this.interceptActive || !hasTabTag || this._shouldBypass(fullUrl, req.method)) {
      this._forwardRequest(req.method, fullUrl, req.headers, body, res, undefined, hasTabTag);
      return;
    }

    const id = this._makeId();

    // timeout auto-forward 설정
    const timer = setTimeout(() => {
      if (this.pendingRequests.has(id)) {
        this.pendingRequests.delete(id);
        this._forwardRequest(req.method, fullUrl, req.headers, body, res, undefined, true);
        this.emit('request_timeout', { id });
      }
    }, this.requestTimeout);

    // 브라우저가 hold 중인 요청을 취소(탭 이동·닫기)하면 나중에 timeout으로
    // 뒤늦게 전송되지 않도록 pending에서 제거 + 패널에 알림
    res.on('close', () => {
      const p = this.pendingRequests.get(id);
      if (p) {
        clearTimeout(p.timer);
        this.pendingRequests.delete(id);
        this.emit('request_aborted', { id });
      }
    });

    // pending 요청 저장
    this.pendingRequests.set(id, {
      id,
      method: req.method,
      url: fullUrl,
      headers: { ...req.headers },
      body,
      clientRes: res,
      timer,
    });

    // 확장용 body를 문자열로 (대용량 body는 truncate)
    let bodyStr = null;
    if (body.length > 0) {
      if (body.length > 512 * 1024) {
        bodyStr = body.slice(0, 512 * 1024).toString('utf8');
      } else {
        bodyStr = body.toString('utf8');
      }
    }

    // native messaging host로 emit
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
   * pending 요청에 대한 확장의 결정 처리
   */
  handleDecision(id, decision) {
    // response decision인지 확인
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
        this._forwardRequest(method, reqUrl, headers, body, clientRes, id, true);
        break;

      case 'forward_modified': {
        const newMethod = decision.method || method;
        const newUrl = decision.url || reqUrl;
        const newBody = decision.body != null ? Buffer.from(decision.body, 'utf8') : body;
        // body가 바뀌었을 수 있으므로 Content-Length를 실제 전송 바이트로
        // 재계산. 원본 값을 그대로 두면 짧아진 body는 upstream이 나머지를
        // 기다리며 hang, 길어진 body는 초과분이 다음 요청처럼 해석됨.
        // 단일 buffer 전송이므로 Transfer-Encoding도 제거.
        const newHeaders = { ...(decision.headers || headers) };
        let hadLength = false;
        for (const k of Object.keys(newHeaders)) {
          const lk = k.toLowerCase();
          if (lk === 'content-length') hadLength = true;
          if (lk === 'content-length' || lk === 'transfer-encoding') delete newHeaders[k];
        }
        if (newBody.length > 0 || hadLength) {
          newHeaders['content-length'] = String(newBody.length);
        }
        this._forwardRequest(newMethod, newUrl, newHeaders, newBody, clientRes, id, true);
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
        this._forwardRequest(method, reqUrl, headers, body, clientRes, undefined, true);
    }

    return true;
  }

  /**
   * held response에 대한 결정 처리
   */
  _handleResponseDecision(id, decision) {
    const pending = this.pendingResponses.get(id);
    if (!pending) return false;

    clearTimeout(pending.timer);
    this.pendingResponses.delete(id);

    const { statusCode, headers, body, decodedBody, wasEncoded, clientRes } = pending;

    switch (decision.action) {
      case 'forward':
        // raw(여전히 압축된) buffer 전송 — 브라우저가 upstream의
        // Content-Encoding 헤더로 native 디코드.
        try {
          clientRes.writeHead(statusCode, headers);
          clientRes.end(body);
        } catch {}
        break;

      case 'forward_modified': {
        const newStatus = decision.responseStatus || statusCode;
        // 사용자가 디코드된 body를 편집했으므로 보낼 bytes는 plain —
        // Content-Encoding 제거(Content-Length도; Node가 재계산) →
        // 브라우저가 plain bytes를 압축 해제하려 하지 않도록.
        // Transfer-Encoding: chunked도 단일 buffer 전송 시 stale.
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
   * 모든 pending 요청 forward (intercept 중지 시 사용)
   */
  forwardAllPending() {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      this._forwardRequest(pending.method, pending.url, pending.headers, pending.body, pending.clientRes, undefined, true);
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
    // navigation 없이 남은 swap 항목 드롭 → 이후 intercept 세션에
    // leak되지 않도록.
    this.pendingHeaderSwaps.clear();
  }

  /**
   * MITM과 함께 HTTPS 터널링을 위한 CONNECT 메서드 처리
   */
  _handleConnect(req, clientSocket, head) {
    const [hostname, port] = req.url.split(':');
    const targetPort = parseInt(port) || 443;

    // intercept 비활성이면 MITM 없이 그냥 tunnel
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

    // MITM: 이 hostname용 cert 생성 + TLS 종료
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

    // 브라우저에 tunnel established 알림
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    // 브라우저 트래픽 복호화용 TLS server socket 생성
    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      key: hostCert.key,
      cert: hostCert.cert,
    });

    // 복호화된 요청 파싱용 mini HTTP server 생성
    const miniServer = http.createServer((req, res) => {
      // 적절한 forwarding을 위해 target hostname/port 보관
      if (!req.headers.host) {
        req.headers.host = hostname + (targetPort !== 443 ? ':' + targetPort : '');
      }
      this._handleRequest(req, res, true);
    });

    tlsSocket.on('error', () => {
      try { clientSocket.destroy(); } catch {}
    });

    // connection 이벤트 emit으로 복호화된 데이터를 mini server에 공급
    miniServer.emit('connection', tlsSocket);

    // head 데이터가 있으면 TLS socket에 push
    if (head && head.length > 0) {
      tlsSocket.unshift(head);
    }
  }

  /**
   * proxy server 시작
   */
  start() {
    return new Promise((resolve, reject) => {
      // 시작 전 CA 준비 보장
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
   * proxy server 중지
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
   * 런타임 설정 업데이트
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
