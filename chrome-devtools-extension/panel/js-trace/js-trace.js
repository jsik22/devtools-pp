// JS Trace — panel logic (ported from js-auth-trace).
// inspectedWindow.eval로 inject.js / restore.js를 페이지 컨텍스트에 주입,
// 500ms 폴링으로 window.__authTrace 누적분을 splice해 가져와 timeline 렌더.
//
// devtools-pp 통합 시 IIFE로 격리. DOM은 panel.html의 #js-trace section 내부.

(function () {
  const root = document.getElementById('js-trace');
  if (!root) return;

  const toggleBtn = root.querySelector('#trace-toggle');
  const clearBtn = root.querySelector('#trace-clear');
  const importBtn = root.querySelector('#trace-import');
  const importFileEl = root.querySelector('#trace-import-file');
  const exportBtn = root.querySelector('#trace-export');
  const exportMenu = root.querySelector('#trace-export-menu');
  const maskPwChk = root.querySelector('#mask-passwords');
  const selectAllChk = root.querySelector('#trace-select-all');
  const selectionPill = root.querySelector('#trace-selection');
  const selectionCountEl = root.querySelector('#trace-selection-count');
  const selectionClearBtn = root.querySelector('#trace-selection-clear');
  const exportSelectedCountEl = root.querySelector('#trace-export-selected-count');
  const searchInput = root.querySelector('#trace-search');
  const searchCountEl = root.querySelector('#search-count');
  const searchClearBtn = root.querySelector('#trace-search-clear');
  const searchPrevBtn = root.querySelector('#trace-search-prev');
  const searchNextBtn = root.querySelector('#trace-search-next');
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
  let searchCurrentIdx = -1; // prev/next 네비 현재 위치 (visible match row 기준)
  // 선택된 이벤트의 seq 집합. seq는 inject.js의 __authTraceSeq가 부여한 단조
  // 증가 번호 (import된 events도 자체 seq를 가짐). row checkbox / master /
  // Cmd-A / Shift-click이 이 set을 변경하면 export menu의 "Selected events"
  // 항목이 활성화됨.
  const selectedSeqs = new Set();
  let lastToggledRow = null; // Shift+click range 시 시작 anchor

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
          toggleBtn.click();
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
    row.dataset.seq = ev.seq;
    row._searchText = buildSearchText(ev);
    if (selectedSeqs.has(ev.seq)) row.classList.add('row-checked');

    const selectCell = document.createElement('span');
    selectCell.className = 'row-select';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selectedSeqs.has(ev.seq);
    selectCell.appendChild(cb);
    row.appendChild(selectCell);

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
    // result 셀에 텍스트와 buttom을 함께 두기 위해 inner span 분리.
    const resultText = document.createElement('span');
    resultText.className = 'result-text';
    if (ev.error) {
      result.classList.add('error');
      resultText.textContent = '✗ ' + ev.error;
    } else if (ev.result !== undefined) {
      resultText.textContent = ev.result;
    }
    result.title = resultText.textContent;
    result.appendChild(resultText);

    // cat=network 이벤트에는 → Monitor 점프 버튼. 매칭 요청 없으면 클릭 시
    // 시각 피드백(빨강 깜빡)으로 표시.
    if (ev.cat === 'network') {
      const jumpBtn = document.createElement('button');
      jumpBtn.className = 'jstrace-jump-btn';
      jumpBtn.textContent = '↗';
      jumpBtn.title = 'Jump to this request in Monitor';
      jumpBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const arg0 = (ev.args && ev.args[0]) || '';
        const sp = arg0.indexOf(' ');
        if (sp === -1) return;
        const method = arg0.slice(0, sp);
        const url = arg0.slice(sp + 1);
        const ok = window.__monitorAPI && window.__monitorAPI.jumpToRequest(method, url, ev.t);
        if (!ok) {
          jumpBtn.classList.add('not-found');
          jumpBtn.title = 'No matching request in Monitor (live capture only)';
          setTimeout(() => jumpBtn.classList.remove('not-found'), 1500);
        }
      });
      result.appendChild(jumpBtn);
    }

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
      // 체크박스 영역(select-cell) click은 selection 토글 — open/close 안 함
      if (e.target.closest('.row-select')) {
        handleRowCheckboxClick(row, e);
        return;
      }
      row.classList.toggle('open');
    });

    return row;
  }

  // Row checkbox / select-cell padding 클릭 처리. Shift+click이면 마지막 토글
  // row와의 visible range 일괄 토글.
  function handleRowCheckboxClick(row, e) {
    const checkbox = row.querySelector('.row-select input');
    if (e.shiftKey && lastToggledRow && lastToggledRow !== row) {
      // Shift+click: 마지막 anchor와 현재 row 사이 visible row 일괄 선택
      const allRows = Array.from(timelineEl.querySelectorAll('.row'));
      const i1 = allRows.indexOf(lastToggledRow);
      const i2 = allRows.indexOf(row);
      if (i1 !== -1 && i2 !== -1) {
        const [from, to] = i1 < i2 ? [i1, i2] : [i2, i1];
        const targetState = !selectedSeqs.has(Number(row.dataset.seq));
        for (let i = from; i <= to; i++) {
          const r = allRows[i];
          if (r.classList.contains('hidden')) continue;
          setRowSelected(r, targetState);
        }
      }
    } else {
      // 단일 토글
      const newState = !selectedSeqs.has(Number(row.dataset.seq));
      setRowSelected(row, newState);
      if (e.target.tagName !== 'INPUT') {
        // padding 클릭 시 input checked 상태도 sync
        checkbox.checked = newState;
      }
    }
    lastToggledRow = row;
    updateSelectionUI();
  }

  function setRowSelected(row, state) {
    const seq = Number(row.dataset.seq);
    if (state) selectedSeqs.add(seq);
    else selectedSeqs.delete(seq);
    row.classList.toggle('row-checked', state);
    const cb = row.querySelector('.row-select input');
    if (cb) cb.checked = state;
  }

  function getVisibleRows() {
    return Array.from(timelineEl.querySelectorAll('.row:not(.hidden)'));
  }

  // Selection UI 갱신: master checkbox 상태(none/some/all), counter pill,
  // export menu의 "Selected events" 항목 활성화 + 카운트 표시.
  function updateSelectionUI() {
    const visible = getVisibleRows();
    const visibleSelected = visible.filter(r => selectedSeqs.has(Number(r.dataset.seq))).length;
    if (visible.length === 0) {
      selectAllChk.checked = false;
      selectAllChk.indeterminate = false;
    } else if (visibleSelected === 0) {
      selectAllChk.checked = false;
      selectAllChk.indeterminate = false;
    } else if (visibleSelected === visible.length) {
      selectAllChk.checked = true;
      selectAllChk.indeterminate = false;
    } else {
      selectAllChk.checked = false;
      selectAllChk.indeterminate = true;
    }
    const totalSelected = selectedSeqs.size;
    if (totalSelected > 0) {
      selectionPill.classList.remove('hidden');
      selectionCountEl.textContent = totalSelected + ' selected';
    } else {
      selectionPill.classList.add('hidden');
    }
    // Export menu "Selected events" 항목
    const selBtn = exportMenu.querySelector('[data-trace-export="selected"]');
    if (selBtn) {
      selBtn.disabled = totalSelected === 0;
      exportSelectedCountEl.textContent = totalSelected > 0 ? `(${totalSelected})` : '';
    }
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
    // 새 row 도착 시 master checkbox/indeterminate 상태 재계산
    updateSelectionUI();
  }

  function isRowVisible(row) {
    if (!activeCats.has(row.dataset.cat)) return false;
    if (searchQuery && row._searchText.indexOf(searchQuery) === -1) return false;
    return true;
  }

  function updateSearchCount(shown, total) {
    if (!searchQuery) {
      searchCountEl.textContent = '';
      searchCountEl.classList.remove('no-matches');
      searchCountEl.classList.add('hidden');
      searchClearBtn.classList.add('hidden');
      searchPrevBtn.disabled = true;
      searchNextBtn.disabled = true;
      return;
    }
    // shown = 매치 row 수 (현재 visible row 수와 동일 — 매치 안 된 row는 hidden)
    searchClearBtn.classList.remove('hidden');
    searchCountEl.classList.remove('hidden');
    if (shown === 0) {
      searchCountEl.textContent = 'No matches';
      searchCountEl.classList.add('no-matches');
      searchPrevBtn.disabled = true;
      searchNextBtn.disabled = true;
    } else {
      const cur = searchCurrentIdx >= 0 ? (searchCurrentIdx + 1) + ' / ' + shown : shown;
      searchCountEl.textContent = cur;
      searchCountEl.classList.remove('no-matches');
      searchPrevBtn.disabled = shown < 2;
      searchNextBtn.disabled = shown < 2;
    }
  }

  // visible row 목록 (= 검색 매치 row). prev/next 네비 대상.
  function getMatchedRows() {
    return Array.from(timelineEl.querySelectorAll('.row:not(.hidden)'));
  }

  function highlightMatch(idx) {
    const rows = getMatchedRows();
    if (rows.length === 0) {
      searchCurrentIdx = -1;
      return;
    }
    if (idx < 0) idx = rows.length - 1;
    if (idx >= rows.length) idx = 0;
    timelineEl.querySelectorAll('.row.search-active').forEach(r => r.classList.remove('search-active'));
    const target = rows[idx];
    target.classList.add('search-active');
    target.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    searchCurrentIdx = idx;
    updateSearchCount(rows.length, rows.length);
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
    updateSelectionUI();
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

  async function startTrace() {
    if (!injectCode) {
      setStatus('inject script not loaded yet');
      return;
    }
    try {
      await evalInPage(injectCode);
      tracing = true;
      traceStartedAt = Date.now();
      try { tracedPageURL = await evalInPage('location.href'); } catch (e) { tracedPageURL = null; }
      toggleBtn.textContent = 'Trace ON';
      toggleBtn.className = 'btn btn-toggle-on';
      if (tabBtn) tabBtn.classList.add('recording');
      setStatus('recording…', true);
      setPlaceholder('Recording — interact with the page (login / submit / etc.) to capture trace events.<br><span style="opacity:.6">Tip: try <code>Math.random()</code> in the page console for a quick sanity check.</span>');
      pollTimer = setInterval(poll, POLL_INTERVAL_MS);
    } catch (err) {
      setStatus('inject failed: ' + err.message);
    }
  }

  async function stopTrace() {
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
    toggleBtn.textContent = 'Trace OFF';
    toggleBtn.className = 'btn btn-toggle-off';
    if (tabBtn) tabBtn.classList.remove('recording');
    setStatus('stopped — ' + events.length + ' events');
    if (events.length === 0) {
      setPlaceholder('No events captured. The page may not use any of the hooked APIs (Math.random / crypto.* / fetch / XHR) during the recording window.');
    }
  }

  toggleBtn.addEventListener('click', () => {
    if (tracing) stopTrace();
    else startTrace();
  });

  clearBtn.addEventListener('click', () => {
    events.length = 0;
    lastFilterStats = null;
    selectedSeqs.clear();
    timelineEl.innerHTML = '<div class="placeholder">No trace recorded yet.</div>';
    exportBtn.disabled = true;
    updateSearchCount(0, 0);
    updateSelectionUI();
    if (!tracing) setStatus('idle');
  });

  // Import — 이전에 export한 JS Trace JSON 파일을 불러와 timeline 재구성.
  // tracing 중에는 차단 (현재 세션과 충돌). 기존 events는 항상 덮어쓰기 —
  // imported 데이터의 traceStartedAt이 fmtTime 기준이 되어야 시간 표시 정상.
  importBtn.addEventListener('click', () => {
    if (tracing) {
      setStatus('Stop tracing before import');
      return;
    }
    importFileEl.click();
  });
  importFileEl.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // 같은 파일 재선택 가능하도록 reset
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        // tool 필드는 'js-trace' 또는 legacy 'js-auth-trace'
        const validTool = data.tool === 'js-trace' || data.tool === 'js-auth-trace';
        if (!validTool || !Array.isArray(data.events)) {
          setStatus('Invalid JS Trace file');
          return;
        }
        // 기존 timeline 클리어 후 imported 데이터로 채움
        events.length = 0;
        selectedSeqs.clear();
        timelineEl.innerHTML = '';
        traceStartedAt = data.startedAt ? new Date(data.startedAt).getTime() : Date.now();
        tracedPageURL = data.pageURL || null;
        lastFilterStats = data.filterStats || null;
        renderNewEvents(data.events);
        updateSelectionUI();
        if (data.events.length === 0) {
          setPlaceholder('Imported file contained 0 events.');
        }
        exportBtn.disabled = data.events.length === 0;
        setStatus('imported — ' + data.events.length + ' events · ' + file.name);
      } catch (err) {
        setStatus('Import failed: ' + err.message);
      }
    };
    reader.onerror = () => setStatus('File read failed');
    reader.readAsText(file);
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

  // Export 버튼 click → 드롭다운 메뉴 toggle. 실제 다운로드는 메뉴 안의
  // "Download JSON" 항목 click으로 트리거. Monitor의 export 메뉴와 동일 패턴.
  exportBtn.addEventListener('click', (e) => {
    if (exportBtn.disabled) return;
    e.stopPropagation();
    exportMenu.classList.toggle('hidden');
  });
  // outside click → menu close
  document.addEventListener('click', (e) => {
    if (exportMenu.classList.contains('hidden')) return;
    if (e.target.closest('.export-dropdown')) return;
    exportMenu.classList.add('hidden');
  });
  // Masking 체크박스 클릭 시 메뉴 닫지 않음 (label 안의 input)
  exportMenu.querySelector('label').addEventListener('click', (e) => {
    e.stopPropagation();
  });

  // Export 메뉴의 Full/Selected 항목 → 해당 source로 다운로드 트리거.
  exportMenu.querySelectorAll('[data-trace-export]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      exportMenu.classList.add('hidden');
      const onlySelected = btn.dataset.traceExport === 'selected';
      const source = onlySelected
        ? events.filter(ev => selectedSeqs.has(ev.seq))
        : events;
      if (source.length === 0) return;
      const masked = maskPwChk.checked;
      const exportEvents = masked ? maskExportEvents(source) : source;

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
        eventCount: source.length,
        masked: masked,
        filterStats: filterStats,
        events: exportEvents
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const suffix = (onlySelected ? '-selected' : '') + (masked ? '-masked' : '');
      a.download = 'js-trace-' + stamp + suffix + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  });

  // Master checkbox — visible row 일괄 select/deselect.
  selectAllChk.addEventListener('click', (e) => {
    e.stopPropagation();
    const visible = getVisibleRows();
    const allSelected = visible.length > 0 && visible.every(r => selectedSeqs.has(Number(r.dataset.seq)));
    const targetState = !allSelected;
    visible.forEach(r => setRowSelected(r, targetState));
    updateSelectionUI();
  });

  // Selection clear pill
  selectionClearBtn.addEventListener('click', () => {
    selectedSeqs.clear();
    timelineEl.querySelectorAll('.row.row-checked').forEach(r => {
      r.classList.remove('row-checked');
      const cb = r.querySelector('.row-select input');
      if (cb) cb.checked = false;
    });
    updateSelectionUI();
  });

  // Cmd/Ctrl+A — visible 전체 선택 (JS Trace 탭 active + 입력 필드 외)
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key !== 'a' && e.key !== 'A') return;
    if (!root.classList.contains('active')) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    const visible = getVisibleRows();
    visible.forEach(r => setRowSelected(r, true));
    updateSelectionUI();
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
    searchCurrentIdx = -1;
    // search-active 강조 제거
    timelineEl.querySelectorAll('.row.search-active').forEach(r => r.classList.remove('search-active'));
    applyFilter();
    // 검색어 비어있지 않으면 첫 매치로 자동 이동
    if (searchQuery) {
      const rows = getMatchedRows();
      if (rows.length > 0) highlightMatch(0);
    }
  });

  // Enter = next, Shift+Enter = prev, Esc = clear
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const rows = getMatchedRows();
      if (rows.length === 0) return;
      highlightMatch(searchCurrentIdx + (e.shiftKey ? -1 : 1));
    } else if (e.key === 'Escape') {
      if (searchInput.value) {
        searchInput.value = '';
        searchInput.dispatchEvent(new Event('input'));
      }
    }
  });

  searchPrevBtn.addEventListener('click', () => {
    const rows = getMatchedRows();
    if (rows.length === 0) return;
    highlightMatch(searchCurrentIdx - 1);
  });
  searchNextBtn.addEventListener('click', () => {
    const rows = getMatchedRows();
    if (rows.length === 0) return;
    highlightMatch(searchCurrentIdx + 1);
  });
  searchClearBtn.addEventListener('click', () => {
    searchInput.value = '';
    searchInput.dispatchEvent(new Event('input'));
    searchInput.focus();
  });

  // ── 컬럼 리사이즈 ──────────────────────────────────────────────────────────
  // timeline-header와 row가 CSS var `--js-trace-cols`를 공유하므로 var만 갱신하면
  // 동적으로 추가되는 row까지 일괄 반영. Time / Kind는 right-edge 리사이저,
  // Result는 args/result 경계의 리사이저(inverted sign)로 조정.
  (function setupGridColumnResize() {
    const header = root.querySelector('.timeline-header');
    if (!header) return;
    const cells = Array.from(header.children);
    if (cells.length < 6) return;

    // CSS var의 현재 default를 읽어 cols 배열 초기화.
    function parseCols() {
      const raw = getComputedStyle(root).getPropertyValue('--js-trace-cols').trim();
      return raw.split(/\s+/).map(s => s.endsWith('px') ? parseFloat(s) : s);
    }
    const cols = parseCols(); // [24, 70, 14, 170, '1fr', 110]

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
    // cells[0]=Select(fixed), [1]=Time, [2]=Cat dot(fixed), [3]=Kind, [4]=Args(1fr), [5]=Result(last)
    addResizer(cells[1], 1, +1);   // Time 우측 → cols[1] 직접 조정
    addResizer(cells[3], 3, +1);   // Kind 우측 → cols[3] 직접 조정
    addResizer(cells[4], 5, -1);   // Args/Result 경계 → cols[5](Result) 역방향
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

  // ── Cross-module API ──────────────────────────────────────────────────────
  // panel.js의 Monitor↔JS Trace 브릿지가 사용하는 controlled API. IIFE 내부
  // events 배열을 직접 노출하지 않고 복사본을 반환해 mutation 차단.
  window.__jsTraceAPI = {
    getEvents() { return events.slice(); },
    isActive() { return tracing; },
    getStartedAt() { return traceStartedAt ? new Date(traceStartedAt).toISOString() : null; },
    getFilterStats() { return lastFilterStats; },
    // Monitor export → Import 시 trace events 적재용. 기존 events 덮어쓰기.
    loadEvents(eventsArr, startedAtIso, filterStats) {
      if (!Array.isArray(eventsArr)) return false;
      events.length = 0;
      selectedSeqs.clear();
      timelineEl.innerHTML = '';
      traceStartedAt = startedAtIso ? new Date(startedAtIso).getTime() : Date.now();
      lastFilterStats = filterStats || null;
      renderNewEvents(eventsArr);
      updateSelectionUI();
      return true;
    },
    // Monitor에서 → JS Trace로 점프할 때 사용. JS Trace 탭이 활성화된 후
    // 해당 seq의 row를 찾아 scrollIntoView + 노란 막대 강조.
    selectEvent(seq) {
      const row = timelineEl.querySelector(`.row[data-seq="${seq}"]`);
      if (!row) return false;
      // 기존 강조 모두 제거 (search-active + bridge-jumped)
      timelineEl.querySelectorAll('.row.search-active, .row.bridge-jumped')
        .forEach(r => r.classList.remove('search-active', 'bridge-jumped'));
      // hidden(검색 필터로 가려진) 경우 일시적으로 보이게
      if (row.classList.contains('hidden')) row.classList.remove('hidden');
      // 자동 펼침 — 이벤트 상세 즉시 보임
      row.classList.add('open');
      row.scrollIntoView({ block: 'center', behavior: 'auto' });
      // 깜빡 강조 — 사용자 시선 유도. 1.5초 후 클래스 제거(재실행 가능)
      // setTimeout 전에 reflow 강제 → 같은 row 연속 호출 시에도 애니메이션 재시작
      void row.offsetWidth;
      row.classList.add('bridge-jumped');
      setTimeout(() => row.classList.remove('bridge-jumped'), 1600);
      return true;
    },
  };
})();
