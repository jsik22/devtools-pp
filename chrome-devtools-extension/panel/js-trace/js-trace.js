// JS Trace — panel logic (ported from js-auth-trace).
// inspectedWindow.eval로 inject.js / restore.js를 페이지 컨텍스트에 주입,
// 500ms 폴링으로 window.__authTrace 누적분을 splice해 가져와 timeline 렌더.
//
// devtools-pp 통합 시 IIFE로 격리. DOM은 panel.html의 #js-trace section 내부.

(function () {
  const root = document.getElementById('js-trace');
  if (!root) return;

  const startBtn = root.querySelector('#trace-start');
  const stopBtn = root.querySelector('#trace-stop');
  const clearBtn = root.querySelector('#trace-clear');
  const exportBtn = root.querySelector('#trace-export');
  const maskPwChk = root.querySelector('#mask-passwords');
  const searchInput = root.querySelector('#trace-search');
  const searchCountEl = root.querySelector('#search-count');
  const statusEl = root.querySelector('#trace-status');
  const timelineEl = root.querySelector('#timeline');
  const filterInputs = root.querySelectorAll('.filters input[type=checkbox]');
  const tabBtn = document.querySelector('.tab[data-tab="js-trace"]');

  const POLL_INTERVAL_MS = 500;

  let tracing = false;
  let pollTimer = null;
  let injectCode = null;
  let restoreCode = null;
  let traceStartedAt = null;
  let tracedPageURL = null;
  let lastFilterStats = null;
  const events = [];
  const activeCats = new Set(
    Array.from(filterInputs).filter(i => i.checked).map(i => i.dataset.cat)
  );
  let searchQuery = '';

  // ── 부트스트랩: inject/restore 스크립트 텍스트를 미리 로드 ───────────────────
  Promise.all([
    fetch('js-trace/inject.js').then(r => r.text()),
    fetch('js-trace/restore.js').then(r => r.text())
  ]).then(([inject, restore]) => {
    injectCode = inject;
    restoreCode = restore;
    // 패널 헤더의 Auto-start 토글이 켜져 있으면 Monitor와 함께 JS Trace도
    // 자동 시작. panel.js의 initAutoStartMonitoring과 동일 storage key 공유.
    try {
      chrome.storage.local.get(['autoStartMonitoring'], (result) => {
        if (result && result.autoStartMonitoring && !tracing) {
          startBtn.click();
        }
      });
    } catch (e) { /* storage 접근 실패 시 silent */ }
  }).catch(err => {
    setStatus('inject load failed: ' + err.message);
  });

  // ── 헬퍼 ────────────────────────────────────────────────────────────────────

  function setStatus(text, recording) {
    statusEl.textContent = text;
    statusEl.classList.toggle('recording', !!recording);
  }

  function evalInPage(code) {
    return new Promise((resolve, reject) => {
      chrome.devtools.inspectedWindow.eval(code, (result, exceptionInfo) => {
        if (exceptionInfo && (exceptionInfo.isException || exceptionInfo.isError)) {
          // exceptionInfo.description은 "Operation failed: %s" 같은 포맷 문자열이고
          // 실제 사유는 exceptionInfo.details 배열에 들어있음. %s를 details로 치환.
          let msg = exceptionInfo.value || exceptionInfo.description || 'eval failed';
          if (typeof msg === 'string' && Array.isArray(exceptionInfo.details) && msg.indexOf('%s') !== -1) {
            let i = 0;
            msg = msg.replace(/%s/g, () => {
              const v = exceptionInfo.details[i++];
              return v === undefined ? '?' : String(v);
            });
          }
          reject(new Error(msg));
        } else {
          resolve(result);
        }
      });
    });
  }

  function fmtTime(t) {
    if (!traceStartedAt) return '';
    const ms = t - traceStartedAt;
    if (ms < 1000) return ms + 'ms';
    return (ms / 1000).toFixed(2) + 's';
  }

  function buildSearchText(ev) {
    const parts = [ev.kind || ''];
    if (Array.isArray(ev.args)) parts.push(ev.args.join(' '));
    if (ev.result !== undefined) parts.push(String(ev.result));
    if (ev.error) parts.push(ev.error);
    if (ev.stack) parts.push(ev.stack);
    return parts.join(' ').toLowerCase();
  }

  function rowEl(ev) {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.cat = ev.cat;
    row._searchText = buildSearchText(ev);

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = fmtTime(ev.t);

    const marker = document.createElement('span');
    marker.className = 'cat-marker';

    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = ev.kind;

    const args = document.createElement('span');
    args.className = 'args';
    args.textContent = (ev.args || []).filter(Boolean).join('  ·  ');
    args.title = args.textContent;

    const result = document.createElement('span');
    result.className = 'result';
    if (ev.error) {
      result.classList.add('error');
      result.textContent = '✗ ' + ev.error;
    } else if (ev.result !== undefined) {
      result.textContent = ev.result;
    }
    result.title = result.textContent;

    const details = document.createElement('div');
    details.className = 'details';
    let detailText = '';
    if (ev.args && ev.args.length) {
      ev.args.forEach((a, i) => { detailText += `arg[${i}]: ${a}\n`; });
    }
    if (ev.result !== undefined) detailText += `result: ${ev.result}\n`;
    if (ev.error) detailText += `error: ${ev.error}\n`;
    if (ev.durationMs !== undefined) detailText += `duration: ${ev.durationMs}ms\n`;
    details.textContent = detailText;

    const stack = document.createElement('div');
    stack.className = 'stack';
    stack.textContent = ev.stack || '(no stack)';

    row.appendChild(time);
    row.appendChild(marker);
    row.appendChild(kind);
    row.appendChild(args);
    row.appendChild(result);
    row.appendChild(details);
    row.appendChild(stack);

    row.addEventListener('click', (e) => {
      // details/stack 안의 텍스트 선택은 방해하지 않음
      if (e.target.closest('.details') || e.target.closest('.stack')) return;
      row.classList.toggle('open');
    });

    return row;
  }

  function setPlaceholder(text) {
    let ph = timelineEl.querySelector('.placeholder');
    if (events.length > 0) return;
    if (!ph) {
      ph = document.createElement('div');
      ph.className = 'placeholder';
      timelineEl.appendChild(ph);
    }
    ph.innerHTML = text;
  }

  function clearPlaceholder() {
    const ph = timelineEl.querySelector('.placeholder');
    if (ph) ph.remove();
  }

  function renderNewEvents(newEvents) {
    if (newEvents.length === 0) return;
    if (events.length === 0) clearPlaceholder();
    const atBottom = timelineEl.scrollHeight - timelineEl.scrollTop - timelineEl.clientHeight < 40;
    newEvents.forEach(ev => {
      events.push(ev);
      const row = rowEl(ev);
      if (!isRowVisible(row)) row.classList.add('hidden');
      timelineEl.appendChild(row);
    });
    if (atBottom) timelineEl.scrollTop = timelineEl.scrollHeight;
    exportBtn.disabled = false;
    if (searchQuery) {
      const rows = timelineEl.querySelectorAll('.row');
      let shown = 0;
      rows.forEach(r => { if (!r.classList.contains('hidden')) shown++; });
      updateSearchCount(shown, rows.length);
    }
  }

  function isRowVisible(row) {
    if (!activeCats.has(row.dataset.cat)) return false;
    if (searchQuery && row._searchText.indexOf(searchQuery) === -1) return false;
    return true;
  }

  function updateSearchCount(shown, total) {
    if (!searchQuery) {
      searchCountEl.textContent = '';
      searchCountEl.classList.remove('zero');
      return;
    }
    searchCountEl.textContent = shown + ' / ' + total;
    searchCountEl.classList.toggle('zero', shown === 0);
  }

  function applyFilter() {
    let shown = 0;
    const rows = timelineEl.querySelectorAll('.row');
    rows.forEach(row => {
      const visible = isRowVisible(row);
      row.classList.toggle('hidden', !visible);
      if (visible) shown++;
    });
    updateSearchCount(shown, rows.length);
  }

  // ── 폴링 ────────────────────────────────────────────────────────────────────

  async function poll() {
    try {
      const json = await evalInPage(
        '(function(){var a=window.__authTrace;if(!a)return "[]";return JSON.stringify(a.splice(0));})()'
      );
      if (typeof json === 'string' && json.length > 2) {
        const batch = JSON.parse(json);
        renderNewEvents(batch);
      }
      // __authTrace가 없으면 (페이지 네비게이션 등) 재주입 시도
      if (json === '[]' || json === undefined) {
        const stillInstalled = await evalInPage('!!window.__authTraceInstalled');
        if (!stillInstalled && tracing) {
          await evalInPage(injectCode);
        }
      }
    } catch (err) {
      // 페이지 네비게이션 직후 eval이 잠시 실패할 수 있음 — 다음 tick에서 재시도
      console.warn('[js-trace] poll error:', err.message);
    }
  }

  // ── 버튼 핸들러 ─────────────────────────────────────────────────────────────

  startBtn.addEventListener('click', async () => {
    if (!injectCode) {
      setStatus('inject script not loaded yet');
      return;
    }
    try {
      await evalInPage(injectCode);
      tracing = true;
      traceStartedAt = Date.now();
      try { tracedPageURL = await evalInPage('location.href'); } catch (e) { tracedPageURL = null; }
      startBtn.disabled = true;
      stopBtn.disabled = false;
      if (tabBtn) tabBtn.classList.add('recording');
      setStatus('recording…', true);
      setPlaceholder('Recording — interact with the page (login / submit / etc.) to capture trace events.<br><span style="opacity:.6">Tip: try <code>Math.random()</code> in the page console for a quick sanity check.</span>');
      pollTimer = setInterval(poll, POLL_INTERVAL_MS);
    } catch (err) {
      setStatus('inject failed: ' + err.message);
    }
  });

  stopBtn.addEventListener('click', async () => {
    tracing = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    // 마지막으로 남은 이벤트 flush + filter stats 보관 후 wrapper 복원
    try {
      await poll();
      try {
        const raw = await evalInPage('JSON.stringify(window.__authTraceFilterStats || null)');
        if (raw && raw !== 'null') lastFilterStats = JSON.parse(raw);
      } catch (e) { /* ignore */ }
      await evalInPage(restoreCode);
    } catch (err) {
      console.warn('[js-trace] stop error:', err.message);
    }
    startBtn.disabled = false;
    stopBtn.disabled = true;
    if (tabBtn) tabBtn.classList.remove('recording');
    setStatus('stopped — ' + events.length + ' events');
    if (events.length === 0) {
      setPlaceholder('No events captured. The page may not use any of the hooked APIs (Math.random / crypto.* / fetch / XHR) during the recording window.');
    }
  });

  clearBtn.addEventListener('click', () => {
    events.length = 0;
    lastFilterStats = null;
    timelineEl.innerHTML = '<div class="placeholder">No trace recorded yet.</div>';
    exportBtn.disabled = true;
    updateSearchCount(0, 0);
    if (!tracing) setStatus('idle');
  });

  // password 필드 read 이벤트의 result(JSON-stringified 형태)에서 실제 값을 추출.
  // 평문 길이 ≥ 4 인 값만 다른 이벤트의 substring 치환 대상으로 사용 (짧은 prefix는
  // 무관 텍스트를 깨뜨리므로 제외 — 어차피 부분 정보만 누설).
  function isPasswordEvent(ev) {
    return ev.cat === 'input'
      && Array.isArray(ev.args)
      && (ev.args[0] || '').indexOf('type="password"') !== -1;
  }

  function maskExportEvents(rawEvents) {
    const passwords = new Set();
    for (const ev of rawEvents) {
      if (!isPasswordEvent(ev) || typeof ev.result !== 'string') continue;
      try {
        const v = JSON.parse(ev.result);
        if (typeof v === 'string' && v.length >= 4) passwords.add(v);
      } catch (e) { /* truncated/non-JSON preview — skip */ }
    }
    // 비번 값의 인코딩 변형까지 마스킹 대상에 포함.
    // XHR/fetch body는 흔히 URL-encoded이고, JSON body는 unicode escape일 수 있음.
    const variants = new Set();
    for (const pw of passwords) {
      variants.add(pw);                                    // raw
      try { variants.add(encodeURIComponent(pw)); } catch (e) {}  // URL-encoded
      try { variants.add(encodeURI(pw)); } catch (e) {}           // 부분 URL-encoded
      try {
        const j = JSON.stringify(pw);                      // JSON-escaped (따옴표 포함)
        variants.add(j.slice(1, -1));                      // 따옴표 떼고 escape된 내부만
      } catch (e) {}
    }
    // 길이 4 미만은 다른 텍스트와 겹쳐 노이즈 유발 → 제외
    const longestFirst = Array.from(variants).filter(v => v.length >= 4).sort((a, b) => b.length - a.length);

    const scrub = (s) => {
      if (typeof s !== 'string') return s;
      for (const pw of longestFirst) {
        if (s.indexOf(pw) !== -1) {
          s = s.split(pw).join('[REDACTED ' + pw.length + ' chars]');
        }
      }
      return s;
    };

    return rawEvents.map(ev => {
      const out = Object.assign({}, ev);
      if (isPasswordEvent(ev)) {
        let len = '?';
        try { const v = JSON.parse(ev.result); if (typeof v === 'string') len = v.length; } catch (e) {}
        out.result = '[REDACTED ' + len + ' chars]';
      } else if (typeof ev.result === 'string') {
        out.result = scrub(ev.result);
      }
      if (Array.isArray(ev.args)) out.args = ev.args.map(scrub);
      if (typeof ev.error === 'string') out.error = scrub(ev.error);
      if (typeof ev.stack === 'string') out.stack = scrub(ev.stack);
      return out;
    });
  }

  exportBtn.addEventListener('click', async () => {
    if (events.length === 0) return;
    const masked = maskPwChk.checked;
    const exportEvents = masked ? maskExportEvents(events) : events;

    // filter stats: tracing 중이면 live 조회, stopped면 Stop 시점 캐시 사용
    let filterStats = lastFilterStats;
    if (tracing) {
      try {
        const raw = await evalInPage('JSON.stringify(window.__authTraceFilterStats || null)');
        if (raw && raw !== 'null') filterStats = JSON.parse(raw);
      } catch (e) { /* ignore */ }
    }

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const stamp =
      now.getFullYear() +
      pad(now.getMonth() + 1) +
      pad(now.getDate()) + '-' +
      pad(now.getHours()) +
      pad(now.getMinutes()) +
      pad(now.getSeconds());
    const payload = {
      version: 1,
      tool: 'js-trace',
      exportedAt: now.toISOString(),
      startedAt: traceStartedAt ? new Date(traceStartedAt).toISOString() : null,
      pageURL: tracedPageURL,
      eventCount: events.length,
      masked: masked,
      filterStats: filterStats,
      events: exportEvents
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'js-trace-' + stamp + (masked ? '-masked' : '') + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  filterInputs.forEach(input => {
    input.addEventListener('change', () => {
      const cat = input.dataset.cat;
      if (input.checked) activeCats.add(cat);
      else activeCats.delete(cat);
      applyFilter();
    });
  });

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.toLowerCase();
    applyFilter();
  });

  // ── 컬럼 리사이즈 ──────────────────────────────────────────────────────────
  // timeline-header와 row가 CSS var `--js-trace-cols`를 공유하므로 var만 갱신하면
  // 동적으로 추가되는 row까지 일괄 반영. Time / Kind는 right-edge 리사이저,
  // Result는 args/result 경계의 리사이저(inverted sign)로 조정.
  (function setupGridColumnResize() {
    const header = root.querySelector('.timeline-header');
    if (!header) return;
    const cells = Array.from(header.children);
    if (cells.length < 5) return;

    // CSS var의 현재 default를 읽어 cols 배열 초기화.
    function parseCols() {
      const raw = getComputedStyle(root).getPropertyValue('--js-trace-cols').trim();
      return raw.split(/\s+/).map(s => s.endsWith('px') ? parseFloat(s) : s);
    }
    const cols = parseCols(); // [70, 14, 170, '1fr', 110]

    function writeCols() {
      const parts = cols.map(c => typeof c === 'number' ? c + 'px' : c);
      root.style.setProperty('--js-trace-cols', parts.join(' '));
    }

    function addResizer(cell, colIdx, sign) {
      const resizer = document.createElement('div');
      resizer.className = 'col-resizer';
      cell.appendChild(resizer);
      resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startW = typeof cols[colIdx] === 'number' ? cols[colIdx] : 0;
        resizer.classList.add('dragging');
        document.body.classList.add('col-resizing');
        const onMove = (ev) => {
          const delta = (ev.clientX - startX) * sign;
          cols[colIdx] = Math.max(40, startW + delta);
          writeCols();
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          resizer.classList.remove('dragging');
          document.body.classList.remove('col-resizing');
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
      resizer.addEventListener('click', (e) => e.stopPropagation());
    }

    // cells[0]=Time, [1]=Cat dot(fixed), [2]=Kind, [3]=Args(1fr), [4]=Result(last)
    addResizer(cells[0], 0, +1);   // Time 우측 → cols[0] 직접 조정
    addResizer(cells[2], 2, +1);   // Kind 우측 → cols[2] 직접 조정
    addResizer(cells[3], 4, -1);   // Args/Result 경계 → cols[4](Result) 역방향
  })();

  // 페이지 네비게이션 시 wrapper가 사라짐 — tracing 중이면 재주입.
  // 새 frame이 eval 받을 준비가 안 된 시점에 fire될 수 있으므로 짧게 retry.
  // devtools-pp가 이미 onNavigated에 별도 listener를 등록하지만, Chrome multi-listener
  // 지원으로 양쪽 다 동작함.
  chrome.devtools.network.onNavigated.addListener(async () => {
    if (!tracing || !injectCode) return;
    let lastErr;
    for (let i = 0; i < 6; i++) {
      try {
        await evalInPage(injectCode);
        setStatus('recording… (re-injected after nav)', true);
        return;
      } catch (err) {
        lastErr = err;
        await new Promise(r => setTimeout(r, 250));
      }
    }
    setStatus('re-inject failed: ' + (lastErr && lastErr.message || 'unknown'));
  });
})();
