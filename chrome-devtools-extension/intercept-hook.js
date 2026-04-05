// intercept-hook.js - MAIN world에서 document_start에 실행
// 페이지의 어떤 JS보다 먼저 fetch/XHR/form/link/beacon을 프록시로 교체

(function() {
  // ============================================================
  // 원본 저장
  // ============================================================
  var origFetch = window.fetch;
  var OrigXHR = window.XMLHttpRequest;
  var origSendBeacon = navigator.sendBeacon.bind(navigator);

  // ============================================================
  // 공유 상태
  // ============================================================
  window.__icptActive__ = false;
  window.__icptQueue__ = [];
  window.__icptDecisions__ = {};

  // 결정 대기 공통 함수
  function waitForDecision(id, timeout, callback) {
    var checks = 0;
    var timer = setInterval(function() {
      checks++;
      var decision = window.__icptDecisions__[id];
      if (!decision && checks < timeout) return;
      clearInterval(timer);
      delete window.__icptDecisions__[id];
      callback(decision);
    }, 100);
  }

  function makeId() {
    return '__icpt_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  }

  function extractHeaders(src) {
    var headers = {};
    if (!src) return headers;
    if (src instanceof Headers) {
      src.forEach(function(v, k) { headers[k] = v; });
    } else if (typeof src === 'object') {
      Object.keys(src).forEach(function(k) { headers[k] = src[k]; });
    }
    return headers;
  }

  // ============================================================
  // 1. fetch 프록시
  // ============================================================
  window.fetch = function(input, init) {
    if (!window.__icptActive__) return origFetch.apply(this, arguments);

    init = init || {};
    var url = (typeof input === 'string') ? input : (input instanceof Request ? input.url : String(input));
    var method = (init.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
    var headers = extractHeaders(init.headers || (input instanceof Request ? input.headers : null));

    var bodyText = null;
    if (init.body) {
      if (typeof init.body === 'string') bodyText = init.body;
      else { try { bodyText = JSON.stringify(init.body); } catch(e) { bodyText = String(init.body); } }
    }

    var id = makeId();
    window.__icptQueue__.push({
      id: id, type: 'fetch', method: method, url: url,
      headers: headers, body: bodyText, timestamp: Date.now()
    });

    return new Promise(function(resolve, reject) {
      waitForDecision(id, 600, function(d) {
        if (!d || d.action === 'forward') {
          resolve(origFetch(input, init));
        } else if (d.action === 'forward_modified') {
          var newInit = {
            method: d.method || method,
            headers: d.headers || headers,
            credentials: init.credentials || 'same-origin'
          };
          if (d.body && d.method !== 'GET' && d.method !== 'HEAD') newInit.body = d.body;
          resolve(origFetch(d.url || url, newInit));
        } else if (d.action === 'drop') {
          reject(new TypeError('Request blocked by DevTools++ Intercept'));
        } else if (d.action === 'mock') {
          var mh = new Headers();
          if (d.responseHeaders) d.responseHeaders.forEach(function(h) { mh.append(h.name, h.value); });
          resolve(new Response(d.responseBody || '', { status: d.responseStatus || 200, headers: mh }));
        } else {
          resolve(origFetch(input, init));
        }
      });
    });
  };

  // ============================================================
  // 2. XMLHttpRequest 프록시
  // ============================================================
  window.XMLHttpRequest = function() {
    var xhr = new OrigXHR();
    var _method = 'GET', _url = '', _headers = {}, _async = true;

    var origOpen = xhr.open;
    xhr.open = function(method, url, async) {
      _method = (method || 'GET').toUpperCase();
      _url = url;
      _async = async !== false;
      return origOpen.apply(xhr, arguments);
    };

    var origSetHeader = xhr.setRequestHeader;
    xhr.setRequestHeader = function(name, value) {
      _headers[name] = value;
      return origSetHeader.apply(xhr, arguments);
    };

    var origSend = xhr.send;
    xhr.send = function(body) {
      if (!window.__icptActive__) return origSend.call(xhr, body);

      var id = makeId();
      var bodyText = null;
      if (body) {
        if (typeof body === 'string') bodyText = body;
        else { try { bodyText = JSON.stringify(body); } catch(e) { bodyText = String(body); } }
      }

      window.__icptQueue__.push({
        id: id, type: 'xhr', method: _method, url: _url,
        headers: Object.assign({}, _headers), body: bodyText, timestamp: Date.now()
      });

      waitForDecision(id, 600, function(d) {
        if (!d || d.action === 'forward') {
          origSend.call(xhr, body);
        } else if (d.action === 'forward_modified') {
          origOpen.call(xhr, d.method || _method, d.url || _url, _async);
          if (d.headers) Object.keys(d.headers).forEach(function(k) {
            try { origSetHeader.call(xhr, k, d.headers[k]); } catch(e) {}
          });
          origSend.call(xhr, d.body !== undefined ? d.body : body);
        } else if (d.action === 'drop') {
          Object.defineProperty(xhr, 'readyState', { get: function() { return 4; }, configurable: true });
          Object.defineProperty(xhr, 'status', { get: function() { return 0; }, configurable: true });
          xhr.dispatchEvent(new Event('error'));
          xhr.dispatchEvent(new Event('loadend'));
        } else if (d.action === 'mock') {
          Object.defineProperty(xhr, 'readyState', { get: function() { return 4; }, configurable: true });
          Object.defineProperty(xhr, 'status', { get: function() { return d.responseStatus || 200; }, configurable: true });
          Object.defineProperty(xhr, 'responseText', { get: function() { return d.responseBody || ''; }, configurable: true });
          Object.defineProperty(xhr, 'response', { get: function() { return d.responseBody || ''; }, configurable: true });
          xhr.dispatchEvent(new Event('readystatechange'));
          xhr.dispatchEvent(new Event('load'));
          xhr.dispatchEvent(new Event('loadend'));
        } else {
          origSend.call(xhr, body);
        }
      });
    };

    return xhr;
  };
  window.XMLHttpRequest.prototype = OrigXHR.prototype;
  window.XMLHttpRequest.UNSENT = 0;
  window.XMLHttpRequest.OPENED = 1;
  window.XMLHttpRequest.HEADERS_RECEIVED = 2;
  window.XMLHttpRequest.LOADING = 3;
  window.XMLHttpRequest.DONE = 4;

  // ============================================================
  // 3. <form> submit 인터셉트
  // ============================================================
  document.addEventListener('submit', function(e) {
    if (!window.__icptActive__) return;

    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;

    e.preventDefault();
    e.stopPropagation();

    var method = (form.method || 'GET').toUpperCase();
    var action = form.action || window.location.href;
    var formData = new FormData(form);

    // FormData → 직렬화
    var bodyText = '';
    var headers = {};
    var enctype = form.enctype || 'application/x-www-form-urlencoded';

    if (method === 'GET') {
      // GET: query string에 추가
      var url = new URL(action, window.location.href);
      formData.forEach(function(v, k) { url.searchParams.append(k, v); });
      action = url.toString();
      bodyText = null;
    } else if (enctype === 'application/x-www-form-urlencoded') {
      var params = new URLSearchParams();
      formData.forEach(function(v, k) { params.append(k, v); });
      bodyText = params.toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (enctype === 'multipart/form-data') {
      // multipart는 문자열로 직렬화 어려움 → 키-값 목록으로 표시
      var parts = [];
      formData.forEach(function(v, k) {
        if (v instanceof File) parts.push(k + '=[File: ' + v.name + ']');
        else parts.push(k + '=' + v);
      });
      bodyText = parts.join('&');
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else {
      bodyText = new URLSearchParams(formData).toString();
      headers['Content-Type'] = enctype;
    }

    var id = makeId();
    window.__icptQueue__.push({
      id: id, type: 'form', method: method, url: action,
      headers: headers, body: bodyText, timestamp: Date.now(),
      _formRef: form  // 원본 form 참조 (forward 시 재사용)
    });

    waitForDecision(id, 600, function(d) {
      if (!d || d.action === 'forward') {
        // 원본 form 그대로 submit
        form.removeEventListener('submit', arguments.callee);
        HTMLFormElement.prototype.submit.call(form);
      } else if (d.action === 'forward_modified') {
        // 수정된 내용으로 fetch 실행
        var fetchInit = {
          method: d.method || method,
          headers: d.headers || headers,
          credentials: 'include'
        };
        if (d.body && d.method !== 'GET' && d.method !== 'HEAD') {
          fetchInit.body = d.body;
        }
        var targetUrl = d.url || action;
        origFetch(targetUrl, fetchInit).then(function(resp) {
          // form submit 결과는 보통 페이지 이동 → 응답 HTML로 이동
          if (resp.redirected) {
            window.location.href = resp.url;
          } else {
            return resp.text().then(function(html) {
              // 같은 페이지에 결과 반영
              if (resp.headers.get('content-type') && resp.headers.get('content-type').includes('text/html')) {
                document.open();
                document.write(html);
                document.close();
              } else {
                window.location.href = targetUrl;
              }
            });
          }
        }).catch(function() {
          window.location.href = targetUrl;
        });
      } else if (d.action === 'drop') {
        // 아무것도 안 함 (요청 차단)
        console.log('[DevTools++] Form submission dropped:', action);
      } else if (d.action === 'mock') {
        // mock 응답을 페이지에 표시
        if (d.responseBody) {
          document.open();
          document.write(d.responseBody);
          document.close();
        }
      } else {
        HTMLFormElement.prototype.submit.call(form);
      }
    });
  }, true); // capture phase로 등록 → 다른 핸들러보다 먼저 실행

  // ============================================================
  // 4. <a> 링크 클릭 인터셉트
  // ============================================================
  document.addEventListener('click', function(e) {
    if (!window.__icptActive__) return;

    // 클릭된 요소에서 가장 가까운 <a> 찾기
    var link = e.target.closest ? e.target.closest('a[href]') : null;
    if (!link) return;

    var href = link.href;
    if (!href) return;

    // javascript:, #, mailto: 등은 무시
    if (href.startsWith('javascript:') || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;

    // 새 탭 열기(target="_blank")도 무시 (사용자 의도 보존)
    if (link.target === '_blank') return;

    e.preventDefault();
    e.stopPropagation();

    var id = makeId();
    window.__icptQueue__.push({
      id: id, type: 'navigation', method: 'GET', url: href,
      headers: {}, body: null, timestamp: Date.now()
    });

    waitForDecision(id, 600, function(d) {
      if (!d || d.action === 'forward') {
        window.location.href = href;
      } else if (d.action === 'forward_modified') {
        window.location.href = d.url || href;
      } else if (d.action === 'drop') {
        console.log('[DevTools++] Navigation dropped:', href);
      } else {
        window.location.href = href;
      }
    });
  }, true);

  // ============================================================
  // 5. navigator.sendBeacon 프록시
  // ============================================================
  navigator.sendBeacon = function(url, data) {
    if (!window.__icptActive__) return origSendBeacon(url, data);

    var bodyText = null;
    if (data) {
      if (typeof data === 'string') bodyText = data;
      else if (data instanceof URLSearchParams) bodyText = data.toString();
      else if (data instanceof Blob) bodyText = '[Blob: ' + data.size + ' bytes]';
      else { try { bodyText = JSON.stringify(data); } catch(e) { bodyText = String(data); } }
    }

    var id = makeId();
    window.__icptQueue__.push({
      id: id, type: 'beacon', method: 'POST', url: url,
      headers: {}, body: bodyText, timestamp: Date.now()
    });

    // sendBeacon은 boolean 반환 → 즉시 true 반환하고 비동기로 처리
    waitForDecision(id, 600, function(d) {
      if (!d || d.action === 'forward') {
        origSendBeacon(url, data);
      } else if (d.action === 'forward_modified') {
        origSendBeacon(d.url || url, d.body || data);
      }
      // drop이면 아무것도 안 함
    });
    return true;
  };

  // ============================================================
  // 6. window.location 변경 인터셉트
  // ============================================================
  var origLocation = window.location;
  var locationDesc = Object.getOwnPropertyDescriptor(window, 'location');

  // location.href setter 오버라이드
  try {
    var origHrefDesc = Object.getOwnPropertyDescriptor(window.Location.prototype, 'href');
    if (origHrefDesc && origHrefDesc.set) {
      var origHrefSet = origHrefDesc.set;
      Object.defineProperty(window.Location.prototype, 'href', {
        get: origHrefDesc.get,
        set: function(val) {
          if (!window.__icptActive__) return origHrefSet.call(this, val);

          var id = makeId();
          window.__icptQueue__.push({
            id: id, type: 'location', method: 'GET', url: val,
            headers: {}, body: null, timestamp: Date.now()
          });

          waitForDecision(id, 600, function(d) {
            if (!d || d.action === 'forward') {
              origHrefSet.call(origLocation, val);
            } else if (d.action === 'forward_modified') {
              origHrefSet.call(origLocation, d.url || val);
            }
            // drop이면 아무것도 안 함
          });
        },
        configurable: true
      });
    }
  } catch(e) {
    // 일부 브라우저에서 location 오버라이드 불가 → 무시
  }

  // location.assign 오버라이드
  var origAssign = window.Location.prototype.assign;
  window.Location.prototype.assign = function(url) {
    if (!window.__icptActive__) return origAssign.call(this, url);

    var id = makeId();
    window.__icptQueue__.push({
      id: id, type: 'location', method: 'GET', url: url,
      headers: {}, body: null, timestamp: Date.now()
    });

    waitForDecision(id, 600, function(d) {
      if (!d || d.action === 'forward') {
        origAssign.call(origLocation, url);
      } else if (d.action === 'forward_modified') {
        origAssign.call(origLocation, d.url || url);
      }
    });
  };

  // location.replace 오버라이드
  var origReplace = window.Location.prototype.replace;
  window.Location.prototype.replace = function(url) {
    if (!window.__icptActive__) return origReplace.call(this, url);

    var id = makeId();
    window.__icptQueue__.push({
      id: id, type: 'location', method: 'GET', url: url,
      headers: {}, body: null, timestamp: Date.now()
    });

    waitForDecision(id, 600, function(d) {
      if (!d || d.action === 'forward') {
        origReplace.call(origLocation, url);
      } else if (d.action === 'forward_modified') {
        origReplace.call(origLocation, d.url || url);
      }
    });
  };

})();
