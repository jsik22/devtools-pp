// JS Auth Trace — wrapper 설치 스크립트.
// chrome.devtools.inspectedWindow.eval로 inspected page의 메인 JS world에 주입됨.
// 호출 흔적을 window.__authTrace[] 에 push하고, panel은 500ms 폴링으로 splice해서 가져감.
//
// 한 번만 설치 (다중 설치 방지 가드). restore.js로 복원.

(function () {
  if (window.__authTraceInstalled) return 'already-installed';

  var trace = window.__authTrace = window.__authTrace || [];
  var originals = window.__authTraceOriginals = {};
  if (typeof window.__authTraceSeq !== 'number') window.__authTraceSeq = 0;

  // 직전 페이지에서 pagehide 시 stash해둔 trace 복원.
  // form POST → 302 chain 같이 panel poll 전에 페이지가 unload되는 케이스를 위함.
  try {
    var pendingRaw = sessionStorage.getItem('__authTracePending');
    if (pendingRaw) {
      var pending = JSON.parse(pendingRaw);
      if (pending && Array.isArray(pending.trace)) {
        Array.prototype.push.apply(trace, pending.trace);
      }
      if (pending && typeof pending.seq === 'number' && pending.seq > window.__authTraceSeq) {
        window.__authTraceSeq = pending.seq;
      }
      sessionStorage.removeItem('__authTracePending');
    }
  } catch (e) { /* private mode / quota — 복원 실패해도 진행 */ }

  // ── 헬퍼 ──────────────────────────────────────────────────────────────────

  function bufPreview(u8, totalLen) {
    var hex = '';
    var len = Math.min(u8.length, 32);
    for (var i = 0; i < len; i++) {
      var h = u8[i].toString(16);
      if (h.length < 2) h = '0' + h;
      hex += h;
    }
    return '[' + (u8.constructor.name || 'bytes') + ' ' + totalLen + 'B] '
      + hex + (totalLen > 32 ? '…' : '');
  }

  function preview(value, depth) {
    depth = depth || 0;
    if (depth > 2) return '…';
    try {
      if (value === null) return 'null';
      if (value === undefined) return 'undefined';
      var t = typeof value;
      if (t === 'string') {
        return value.length > 200 ? JSON.stringify(value.slice(0, 200)) + '…(' + value.length + ')' : JSON.stringify(value);
      }
      if (t === 'number' || t === 'boolean' || t === 'bigint') return String(value);
      if (t === 'function') return '[Function ' + (value.name || '') + ']';
      if (t === 'symbol') return value.toString();

      if (value instanceof ArrayBuffer) {
        return bufPreview(new Uint8Array(value), value.byteLength);
      }
      if (ArrayBuffer.isView(value)) {
        return bufPreview(
          new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
          value.byteLength
        );
      }
      if (typeof CryptoKey !== 'undefined' && value instanceof CryptoKey) {
        return '[CryptoKey ' + value.type + ' '
          + (value.algorithm && value.algorithm.name) + ' '
          + (value.extractable ? 'extractable' : 'non-extractable') + ']';
      }
      if (typeof Request !== 'undefined' && value instanceof Request) {
        return '[Request ' + value.method + ' ' + value.url + ']';
      }
      if (typeof Response !== 'undefined' && value instanceof Response) {
        return '[Response ' + value.status + ' ' + value.url + ']';
      }
      if (typeof URL !== 'undefined' && value instanceof URL) {
        return value.toString();
      }
      if (typeof FormData !== 'undefined' && value instanceof FormData) {
        var parts = [];
        try {
          value.forEach(function (v, k) { parts.push(k + '=' + preview(v, depth + 1)); });
        } catch (e) {}
        return '[FormData ' + parts.join('&') + ']';
      }
      if (typeof Blob !== 'undefined' && value instanceof Blob) {
        return '[Blob ' + value.type + ' size=' + value.size + ']';
      }
      if (Array.isArray(value)) {
        var items = value.slice(0, 5).map(function (v) { return preview(v, depth + 1); });
        return '[' + items.join(', ') + (value.length > 5 ? ', …' + value.length : '') + ']';
      }
      // Plain object
      var keys = Object.keys(value);
      if (keys.length === 0) return '{}';
      var props = keys.slice(0, 8).map(function (k) {
        return k + ': ' + preview(value[k], depth + 1);
      });
      return '{' + props.join(', ') + (keys.length > 8 ? ', …' : '') + '}';
    } catch (e) {
      return '[unpreviewable: ' + (e && e.message || e) + ']';
    }
  }

  function captureStack() {
    var stack = (new Error()).stack || '';
    // v8: 첫 줄 "Error" + captureStack 프레임 + wrapper 프레임 → 3줄 skip
    var lines = stack.split('\n').slice(3, 13);
    return lines.join('\n').trim();
  }

  function push(event) {
    event.t = Date.now();
    event.seq = window.__authTraceSeq++;
    trace.push(event);
  }

  // ── 노이즈 필터 ─────────────────────────────────────────────────────────────
  // 실 데이터(dhlottery: 666건 중 648 Math.random, knvd: 66건 중 48 input.value)
  // 기반으로 3개 축 적용. 보안 critical wrapper(crypto.subtle, fetch, XHR,
  // form.submit)에는 cap 미적용.

  var CALLSITE_CAP = 10;
  var URL_BLACKLIST = [
    /\.js\.map(\?|$)/,
    /\.css\.map(\?|$)/,
    /\/favicon\.ico(\?|$)/
  ];

  var callsiteCounts = window.__authTraceCallsiteCounts = window.__authTraceCallsiteCounts || {};
  var inputDedupe = new WeakMap();
  var stats = window.__authTraceFilterStats = window.__authTraceFilterStats || {
    cappedCallsites: 0, suppressedByCap: 0, blockedURLs: 0, dedupedInputs: 0
  };

  // 호출 사이트 빈도 cap. 결과:
  //   'pass'    → 그대로 push
  //   'notice'  → cap 도달 직후 1회. "capped" 알림 이벤트 push 후 silent
  //   'suppress'→ 완전히 skip
  function checkCallsiteCap(kind, stack) {
    var topFrame = (stack || '').split('\n')[0].trim() || '(no-stack)';
    var key = kind + '|' + topFrame;
    var n = (callsiteCounts[key] || 0) + 1;
    callsiteCounts[key] = n;
    if (n <= CALLSITE_CAP) return 'pass';
    if (n === CALLSITE_CAP + 1) return 'notice';
    stats.suppressedByCap++;
    return 'suppress';
  }

  function emitCapNotice(cat, kind, topFrame) {
    stats.cappedCallsites++;
    push({
      cat: cat,
      kind: kind + ' (capped)',
      args: ['call site: ' + topFrame, 'cap: ' + CALLSITE_CAP],
      result: 'further calls from this site suppressed',
      stack: topFrame
    });
  }

  function isBlockedURL(url) {
    var s = String(url);
    for (var i = 0; i < URL_BLACKLIST.length; i++) {
      if (URL_BLACKLIST[i].test(s)) {
        stats.blockedURLs++;
        return true;
      }
    }
    return false;
  }

  // 같은 element에 대한 연속 동일 value read를 dedupe (Vue v-model 등의 noise).
  function shouldDedupeInput(element, value) {
    if (inputDedupe.get(element) === value) {
      stats.dedupedInputs++;
      return true;
    }
    inputDedupe.set(element, value);
    return false;
  }

  // ── 1. Math.random ────────────────────────────────────────────────────────
  originals.MathRandom = Math.random;
  Math.random = function () {
    var r = originals.MathRandom.apply(Math, arguments);
    var stack = captureStack();
    var verdict = checkCallsiteCap('Math.random', stack);
    if (verdict === 'suppress') return r;
    if (verdict === 'notice') {
      emitCapNotice('random', 'Math.random', stack.split('\n')[0].trim());
      return r;
    }
    push({
      cat: 'random',
      kind: 'Math.random',
      args: [],
      result: String(r),
      stack: stack
    });
    return r;
  };

  // ── 2. crypto.getRandomValues ─────────────────────────────────────────────
  if (window.crypto && crypto.getRandomValues) {
    originals.getRandomValues = crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues = function (array) {
      var stack = captureStack();
      var result = originals.getRandomValues(array);
      var verdict = checkCallsiteCap('crypto.getRandomValues', stack);
      if (verdict === 'suppress') return result;
      if (verdict === 'notice') {
        emitCapNotice('random', 'crypto.getRandomValues', stack.split('\n')[0].trim());
        return result;
      }
      push({
        cat: 'random',
        kind: 'crypto.getRandomValues',
        args: [preview(array)],
        result: preview(result),
        stack: stack
      });
      return result;
    };
  }

  // ── 3. crypto.subtle.* ────────────────────────────────────────────────────
  if (window.crypto && crypto.subtle) {
    var subtle = crypto.subtle;
    var subtleMethods = [
      'digest', 'sign', 'verify',
      'encrypt', 'decrypt',
      'deriveBits', 'deriveKey',
      'importKey', 'exportKey', 'generateKey',
      'wrapKey', 'unwrapKey'
    ];
    originals.subtle = {};
    subtleMethods.forEach(function (m) {
      if (typeof subtle[m] !== 'function') return;
      originals.subtle[m] = subtle[m].bind(subtle);
      subtle[m] = function () {
        var args = Array.prototype.slice.call(arguments);
        var stack = captureStack();
        var startedAt = Date.now();
        var promise;
        try {
          promise = originals.subtle[m].apply(subtle, args);
        } catch (e) {
          push({
            cat: 'crypto',
            kind: 'crypto.subtle.' + m,
            args: args.map(function (a) { return preview(a); }),
            error: String(e && e.message || e),
            stack: stack
          });
          throw e;
        }
        promise.then(function (result) {
          push({
            cat: 'crypto',
            kind: 'crypto.subtle.' + m,
            args: args.map(function (a) { return preview(a); }),
            result: preview(result),
            durationMs: Date.now() - startedAt,
            stack: stack
          });
        }, function (err) {
          push({
            cat: 'crypto',
            kind: 'crypto.subtle.' + m,
            args: args.map(function (a) { return preview(a); }),
            error: String(err && err.message || err),
            durationMs: Date.now() - startedAt,
            stack: stack
          });
        });
        return promise;
      };
    });
  }

  // ── 4. window.fetch ───────────────────────────────────────────────────────
  if (window.fetch) {
    originals.fetch = window.fetch.bind(window);
    window.fetch = function () {
      var args = Array.prototype.slice.call(arguments);
      var stack = captureStack();
      var startedAt = Date.now();
      var input = args[0];
      var init = args[1] || {};
      var method = (init && init.method)
        || (typeof Request !== 'undefined' && input instanceof Request && input.method)
        || 'GET';
      var url = (typeof Request !== 'undefined' && input instanceof Request) ? input.url : String(input);
      var bodyPreview = init && init.body ? preview(init.body) : '';
      var blocked = isBlockedURL(url);

      var promise;
      try {
        promise = originals.fetch.apply(window, args);
      } catch (e) {
        if (!blocked) push({
          cat: 'network',
          kind: 'fetch',
          args: [method + ' ' + url, bodyPreview],
          error: String(e && e.message || e),
          stack: stack
        });
        throw e;
      }
      if (blocked) return promise;
      promise.then(function (res) {
        push({
          cat: 'network',
          kind: 'fetch',
          args: [method + ' ' + url, bodyPreview],
          result: res.status + ' ' + (res.statusText || ''),
          durationMs: Date.now() - startedAt,
          stack: stack
        });
      }, function (err) {
        push({
          cat: 'network',
          kind: 'fetch',
          args: [method + ' ' + url, bodyPreview],
          error: String(err && err.message || err),
          durationMs: Date.now() - startedAt,
          stack: stack
        });
      });
      return promise;
    };
  }

  // ── 5. XMLHttpRequest.send ────────────────────────────────────────────────
  if (window.XMLHttpRequest) {
    var xhrProto = XMLHttpRequest.prototype;
    originals.xhrOpen = xhrProto.open;
    originals.xhrSend = xhrProto.send;

    xhrProto.open = function (method, url) {
      this.__authTraceOpen = { method: method, url: String(url) };
      return originals.xhrOpen.apply(this, arguments);
    };

    xhrProto.send = function (body) {
      var stack = captureStack();
      var startedAt = Date.now();
      var info = this.__authTraceOpen || { method: '?', url: '?' };
      var bodyPreview = body !== undefined && body !== null ? preview(body) : '';
      var self = this;
      if (!isBlockedURL(info.url)) {
        self.addEventListener('loadend', function () {
          push({
            cat: 'network',
            kind: 'XHR.send',
            args: [info.method + ' ' + info.url, bodyPreview],
            result: self.status + ' ' + (self.statusText || ''),
            durationMs: Date.now() - startedAt,
            stack: stack
          });
        });
      }
      return originals.xhrSend.apply(this, arguments);
    };
  }

  // ── 6. btoa / atob ────────────────────────────────────────────────────────
  function wrapEncodingFn(kindName, originalFn, thisArgFactory) {
    return function (input) {
      var stack = captureStack();
      var result = originalFn.apply(thisArgFactory ? thisArgFactory(this) : window, arguments);
      var verdict = checkCallsiteCap(kindName, stack);
      if (verdict === 'suppress') return result;
      if (verdict === 'notice') {
        emitCapNotice('encoding', kindName, stack.split('\n')[0].trim());
        return result;
      }
      push({
        cat: 'encoding',
        kind: kindName,
        args: [preview(input)],
        result: preview(result),
        stack: stack
      });
      return result;
    };
  }
  if (window.btoa) {
    originals.btoa = window.btoa.bind(window);
    window.btoa = wrapEncodingFn('btoa', originals.btoa);
  }
  if (window.atob) {
    originals.atob = window.atob.bind(window);
    window.atob = wrapEncodingFn('atob', originals.atob);
  }

  // ── 7. TextEncoder.encode / TextDecoder.decode ────────────────────────────
  if (window.TextEncoder && TextEncoder.prototype.encode) {
    originals.TextEncoder_encode = TextEncoder.prototype.encode;
    TextEncoder.prototype.encode = wrapEncodingFn(
      'TextEncoder.encode',
      originals.TextEncoder_encode,
      function (self) { return self; }
    );
  }
  if (window.TextDecoder && TextDecoder.prototype.decode) {
    originals.TextDecoder_decode = TextDecoder.prototype.decode;
    TextDecoder.prototype.decode = wrapEncodingFn(
      'TextDecoder.decode',
      originals.TextDecoder_decode,
      function (self) { return self; }
    );
  }

  // ── 8. HTMLInputElement.value getter ──────────────────────────────────────
  // 입력 폼 값을 JS가 읽어가는 시점을 캡처. 평문 비번·OTP 추적 핵심 지점.
  // 빈 문자열 read는 노이즈 컷 (Vue v-model이 매 keystroke마다 빈 값도 읽음).
  if (window.HTMLInputElement) {
    var inputDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (inputDesc && inputDesc.configurable && inputDesc.get && inputDesc.set) {
      originals.inputValueDesc = inputDesc;
      Object.defineProperty(HTMLInputElement.prototype, 'value', {
        configurable: true,
        enumerable: inputDesc.enumerable,
        get: function () {
          var v = inputDesc.get.call(this);
          if (typeof v === 'string' && v.length > 0 && !shouldDedupeInput(this, v)) {
            var type = this.type || 'text';
            var name = this.name || this.id || '';
            push({
              cat: 'input',
              kind: 'input.value get',
              args: ['<input type="' + type + '"' + (name ? ' name="' + name + '"' : '') + '>'],
              result: preview(v),
              stack: captureStack()
            });
          }
          return v;
        },
        set: function (v) {
          inputDesc.set.call(this, v);
        }
      });
    }
  }

  // ── 9. HTMLFormElement submit (form.submit() + 'submit' event) ────────────
  // 한국 레거시 사이트의 form POST 로그인 케이스를 잡기 위함. 두 경로 모두 후킹:
  //   - form.submit() 직접 호출 → 메서드 wrapper (submit 이벤트 firing 안 함)
  //   - 사용자 클릭/Enter/form.requestSubmit() → 'submit' 이벤트
  function captureForm(form, source) {
    try {
      var action = form.action || (typeof location !== 'undefined' ? location.href : '?');
      var method = (form.method || 'GET').toUpperCase();
      var enctype = form.enctype || 'application/x-www-form-urlencoded';
      var fields = [];
      try {
        var fd = new FormData(form);
        fd.forEach(function (value, key) {
          if (typeof File !== 'undefined' && value instanceof File) {
            fields.push(key + '=[File ' + value.name + ' ' + value.size + 'B]');
          } else {
            var sv = String(value);
            if (sv.length > 200) sv = sv.slice(0, 200) + '…(' + sv.length + ')';
            fields.push(key + '=' + sv);
          }
        });
      } catch (e) { /* FormData on detached form throws — skip body */ }
      push({
        cat: 'network',
        kind: 'form.submit (' + source + ')',
        args: [method + ' ' + action + (enctype !== 'application/x-www-form-urlencoded' ? ' enctype=' + enctype : ''), fields.join('&')],
        stack: captureStack()
      });
    } catch (e) {
      push({
        cat: 'network',
        kind: 'form.submit',
        error: String(e && e.message || e),
        stack: captureStack()
      });
    }
  }

  if (window.HTMLFormElement) {
    originals.formSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function () {
      captureForm(this, 'js-call');
      return originals.formSubmit.apply(this, arguments);
    };
    originals.formSubmitListener = function (e) {
      if (e.target instanceof HTMLFormElement) captureForm(e.target, 'submit-event');
    };
    document.addEventListener('submit', originals.formSubmitListener, true);
  }

  // ── 10. Storage (localStorage / sessionStorage) ───────────────────────────
  // JWT / SSO 토큰 / 세션 상태 저장 추적. PortSwigger Session management 카테고리.
  // getItem은 미후킹 (volume 크고 가치 작음).
  function whichStorage(self) {
    if (self === window.localStorage) return 'localStorage';
    if (self === window.sessionStorage) return 'sessionStorage';
    return 'Storage';
  }
  if (window.Storage && Storage.prototype) {
    originals.Storage_setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      var stack = captureStack();
      push({
        cat: 'storage',
        kind: whichStorage(this) + '.setItem',
        args: [String(key), preview(value)],
        stack: stack
      });
      return originals.Storage_setItem.call(this, key, value);
    };
    originals.Storage_removeItem = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key) {
      var stack = captureStack();
      push({
        cat: 'storage',
        kind: whichStorage(this) + '.removeItem',
        args: [String(key)],
        stack: stack
      });
      return originals.Storage_removeItem.call(this, key);
    };
    originals.Storage_clear = Storage.prototype.clear;
    Storage.prototype.clear = function () {
      push({
        cat: 'storage',
        kind: whichStorage(this) + '.clear',
        args: [],
        stack: captureStack()
      });
      return originals.Storage_clear.call(this);
    };
  }

  // ── 11. document.cookie (Document.prototype getter+setter) ────────────────
  // PortSwigger Cookie attacks / Session management 카테고리. 비 HttpOnly 쿠키 추적.
  // getter는 dedup 적용 (같은 값 연속 read 컷, input.value 패턴).
  if (window.Document && Document.prototype) {
    var cookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    if (cookieDesc && cookieDesc.configurable && cookieDesc.get && cookieDesc.set) {
      originals.cookieDesc = cookieDesc;
      var lastCookieRead = null;
      Object.defineProperty(Document.prototype, 'cookie', {
        configurable: true,
        enumerable: cookieDesc.enumerable,
        get: function () {
          var v = cookieDesc.get.call(this);
          if (typeof v === 'string' && v.length > 0 && v !== lastCookieRead) {
            lastCookieRead = v;
            push({
              cat: 'storage',
              kind: 'document.cookie get',
              args: [],
              result: preview(v),
              stack: captureStack()
            });
          }
          return v;
        },
        set: function (value) {
          push({
            cat: 'storage',
            kind: 'document.cookie set',
            args: [preview(value)],
            stack: captureStack()
          });
          return cookieDesc.set.call(this, value);
        }
      });
    }
  }

  // pagehide 시 unflushed trace + seq counter를 sessionStorage로 stash.
  // trace가 비어있어도 seq는 항상 저장 (다음 페이지에서 seq 단조 증가 유지).
  originals.pageHideHandler = function () {
    try {
      sessionStorage.setItem('__authTracePending', JSON.stringify({
        trace: trace,
        seq: window.__authTraceSeq
      }));
    } catch (e) {}
  };
  window.addEventListener('pagehide', originals.pageHideHandler);

  window.__authTraceInstalled = true;
  return 'installed';
})();
