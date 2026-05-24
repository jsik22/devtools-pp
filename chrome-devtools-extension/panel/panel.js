// ============================================================
// DevTools Inspector Panel - 메인 스크립트
// ============================================================

const tabId = chrome.devtools.inspectedWindow.tabId;

// --- 탭 전환 ---
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab).classList.add('active');
  });
});

// ============================================================
// 0. Site Map — 패시브 수집 + 트리 뷰
// ============================================================

// sitemapTree[mainHost] = {
//   children: { path: { children, requests } },
//   requests: [],
//   external: { extHost: { children, requests } },
//   _lastVisitedUrl, _lastVisitedAt
// }
// 최상위 키는 항상 "main hosts" — 이번 세션에서 사용자가 실제로
// 방문한 origin. cross-origin 요청은 캡처 시점에 활성화된 main host에
// 귀속되어 해당 main host의 `external` map 아래로 들어간다.
const sitemapTree = {};
let targetHost = null;
// 현재 선택된 트리 노드 — 우측 패널 소스 뷰어와 행의 `.selected`
// 하이라이트를 결정. close 버튼으로 해제.
let sitemapSelectedNode = null; // { host, path }
const expandedNodes = new Set(); // 펼쳐진 트리 노드 키 추적 (예: "host:/path")

// 첫 targetHost 확정 전에 캡처된 요청은 여기 대기하다가
// 어느 main host에 귀속되는지 확정되면 flush.
const _sitemapPending = [];

function ensureTargetInTree() {
  if (targetHost && !sitemapTree[targetHost]) {
    sitemapTree[targetHost] = { children: {}, requests: [], external: {} };
  }
  if (targetHost && sitemapTree[targetHost] && !sitemapTree[targetHost].external) {
    sitemapTree[targetHost].external = {};
  }
}

function _flushSitemapPending() {
  if (!targetHost) return;
  while (_sitemapPending.length > 0) {
    const r = _sitemapPending.shift();
    // targetHost 확정 이전에 캡처된 요청은 _mainHost 스탬프가 없음.
    // 이제 main host를 알게 됐으니 retro-stamp 해서 트리의 세션 귀속과
    // 정렬.
    if (r._mainHost == null) r._mainHost = targetHost;
    addToSitemap(r);
  }
}

function detectTargetHost() {
  // host와 href 둘 다 가져와서 초기 페이지(onNavigated가 발화하지 않는
  // 케이스)도 _lastVisitedUrl을 갖도록 함 — 없으면 사용자가 다른 곳으로
  // 이동했을 때 visited-hosts 목록에서 host가 필터링돼 사라짐.
  const expr = 'JSON.stringify({host: location.host, href: location.href})';
  chrome.devtools.inspectedWindow.eval(expr, (result, err) => {
    if (err || !result) return;
    let info;
    try { info = JSON.parse(result); } catch { return; }
    if (!info.host) return;
    targetHost = info.host;
    ensureTargetInTree();
    const main = sitemapTree[targetHost];
    if (main && info.href) {
      main._lastVisitedUrl = info.href;
      main._lastVisitedAt = Date.now();
    }
    _flushSitemapPending();
    renderSitemapTree();
    // 초기 inspected 페이지의 tab — DevTools++가 이미 로드된 페이지에서
    // 열리면 onNavigated 이벤트가 발화하지 않으므로 여기서 tab을 시드해서
    // 사용자가 곧바로 scope에 잡을 수 있게 함.
    if (typeof ensureTab === 'function') {
      ensureTab(targetHost);
      if (typeof setActiveTab === 'function') setActiveTab(targetHost);
    }
  });
}
detectTargetHost();
chrome.devtools.network.onNavigated.addListener((url) => {
  let newHost;
  try {
    newHost = new URL(url).host;
  } catch {
    detectTargetHost();
    return;
  }
  // Preserve-log 방식: 세션에서 먼저 방문한 host는 트리에 남음.
  // Clear만 트리를 비움. 현재 target이 트리 상단으로 이동하고
  // 나머지는 모두 "External"로 들어감.
  targetHost = newHost;
  if (newHost) {
    if (!sitemapTree[newHost]) {
      sitemapTree[newHost] = { children: {}, requests: [], external: {} };
    }
    if (!sitemapTree[newHost].external) sitemapTree[newHost].external = {};
    // 사용자가 이 host에서 마지막으로 머문 URL/시간을 추적해서
    // 트리 행 툴팁에 "where they were last"를 표시할 수 있게 함.
    sitemapTree[newHost]._lastVisitedUrl = url;
    sitemapTree[newHost]._lastVisitedAt = Date.now();
  }
  ensureTargetInTree();
  _flushSitemapPending();
  renderSitemapTree();
  // 브라우저 측 navigation = 사용자의 분석 포커스가 이동. 해당 host의
  // 탭을 활성화해서 list/detail이 따라오게 함. 이전 host로 돌아가면
  // 기존 tab을 재사용 (ensureTab은 idempotent, setActiveTab은 이미
  // 활성이면 no-op) → 누적이 자연스럽게 이어짐.
  if (newHost) {
    if (typeof ensureTab === 'function') {
      ensureTab(newHost);
      if (typeof setActiveTab === 'function') setActiveTab(newHost);
    }
  }
});
const sitemapTreeEl = document.getElementById('sitemap-tree');

// Auto Crawl: Network 모니터링이 모두 기록하는 동안 inspected tab을
// URL 리스트대로 순차 방문. 한 번에 알려진 타겟을 일괄 훑을 때 유용.
// Spider 엔진 상태. crawlState.active = "크롤 실행 중" 플래그(기존 의미 유지).
// frontier = BFS 큐 [{url, depth}], seen = enqueue/visit dedup 키 집합.
const crawlState = {
  active: false,
  waitMs: 5000,
  timeoutId: null,
  watchdogId: null,
  pollId: null,
  // Spider
  frontier: [],
  seen: new Set(),
  seedOrigins: new Set(),
  maxDepth: 2,
  maxPages: 200,
  visitedCount: 0,
  currentUrl: '',
  // 크롤 중 캡처를 seed origin으로 한정 (third-party 노이즈 드롭). 기본 ON.
  scopeCapture: true,
  // 고속 발견 모드 — Per-page wait 무시(0). 링크/구조 발견 무결성은 유지
  // (추출은 wait 전에 끝남), 페이지별 늦은 async 트래픽 캡처만 감소.
  fastDiscovery: false,
  // 크롤 중 이미지/폰트 캡처 스킵 — 메모리/노이즈 절감 (속도·무결성 무관).
  skipAssets: false,
  // 크롤 종료(완료/Stop) 시 run 요약 .txt 자동 저장. 기본 ON.
  metaFile: true,
  // run 요약용 메타 (종료 후에도 보존).
  seeds: [],
  startedAt: null,
  endedAt: null,
  // 크롤이 Monitor를 자동으로 켰는지 → 종료 시 자동 OFF 여부 판단.
  monitorAutoStarted: false,
};
// 크롤 asset-skip 시 확장자 fallback (mimeType 누락/오라벨 대비).
const SPIDER_ASSET_RE = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico|woff2?|ttf|otf|eot)(?:[?#]|$)/i;
// 고속 발견 모드의 페이지 간 wait. 0이라도 NAV_COMMIT+로드+GRACE(~1s)
// 자연 바닥이 있어 서버를 연타하진 않음.
const SPIDER_FAST_WAIT_MS = 0;
// 절대 천장 — 시드 입력 sanity cap + Max pages 입력의 상한. 실제 크롤
// 한도는 사용자 설정 crawlState.maxPages (기본 200, ≤ 이 값).
const SPIDER_MAX_PAGES = 5000;
// 페이지 1스텝(이동→로드완료 폴링)의 무응답 상한. alert/confirm/무한
// 스크립트 등으로 로드완료가 안 잡히면 이 시간 후 그 페이지 버리고 다음으로.
const SPIDER_WATCHDOG_MS = 10000;
// tabs.update 후 네비게이션 commit(이전 문서 unload) 대기 — 이전 페이지의
// 잔여 readyState='complete'를 새 페이지로 오인하지 않도록. 200ms면 실무상
// 네비 commit에 충분하면서 페이지당 오버헤드 최소화 (무결성 영향 없음).
const SPIDER_NAV_COMMIT_MS = 200;
// readyState 폴링 간격 — 로드완료를 감지하는 주기일 뿐이라 짧을수록
// 빠르고 결과는 동일(무결성 무관).
const SPIDER_POLL_MS = 100;
// 로드 완료 후 링크 추출 전 짧은 grace — load 직후 JS가 추가하는 링크까지
// 포착. 옛 blind settle(최대 3s 추측)을 대체하는 작은 고정 쿠션.
const SPIDER_POST_LOAD_GRACE_MS = 600;
// spider 네비게이션 — background가 chrome.tabs.update로 inspected 탭을
// 브라우저 레벨 이동(페이지 JS 안 거침 → 다이얼로그/행에 면역, 막힌
// 다이얼로그도 부수 취소). 로드 완료 판정은 패널이 inspectedWindow.eval
// readyState 폴링으로 직접 수행.
//
// long-lived 포트(sendToBg)가 아니라 chrome.runtime.sendMessage 사용 —
// 포트는 cold/stale SW에서 첫 메시지를 유실(드롭, 버퍼 없음)해 cross-origin
// 시드 첫 이동이 안 되던 근본 원인. sendMessage는 SW를 깨워 전달 보장.
// tabId는 inspected tab(파일 상단 const tabId)을 명시 전달.
function spiderNavigate(url) {
  if (bgReconnectStopped) return;
  try {
    chrome.runtime.sendMessage({ type: 'spider_navigate', url, tabId });
  } catch (err) {
    if (isContextInvalidated(err)) bgReconnectStopped = true;
  }
}
const DESTRUCTIVE_URL_RE = /(logout|sign-?out|delete|remove|destroy|withdraw|deactivate)/i;

function normalizeUrl(u) {
  try { const x = new URL(u); return x.origin + x.pathname + x.search; }
  catch { return null; }
}

function isDestructiveUrl(u) { return DESTRUCTIVE_URL_RE.test(u); }

// 크롤 진행 중 캡처 한정 — 크롤 대상 seed origin 밖 요청은 캡처 단계에서
// 드롭(메모리/검색 비용 bound). 크롤 비활성이거나 옵션 OFF면 영향 없음.
function crawlCaptureBlocks(url) {
  if (!crawlState.active || !crawlState.scopeCapture) return false;
  try { return !crawlState.seedOrigins.has(new URL(url).origin); }
  catch { return false; }
}

// 크롤 중 이미지/폰트 캡처 스킵 — 메모리/노이즈 절감용. 속도·링크 발견
// 무결성과 무관(이미지/폰트는 링크 소스 아님). 크롤 비활성/옵션 OFF면 무영향.
function crawlSkipsAsset(harEntry) {
  if (!crawlState.active || !crawlState.skipAssets) return false;
  const mt = ((harEntry.response && harEntry.response.content &&
    harEntry.response.content.mimeType) || '').toLowerCase();
  if (mt.startsWith('image/') || mt.startsWith('font/') ||
      mt === 'application/font-woff' || mt === 'application/vnd.ms-fontobject') return true;
  try { return SPIDER_ASSET_RE.test(new URL(harEntry.request.url).pathname); }
  catch { return false; }
}

// same-origin(시드 origin) 한정 + 글로벌 Scope 교집합(Scope 없으면 통과).
function inSpiderScope(u) {
  let x;
  try { x = new URL(u); } catch { return false; }
  if (x.protocol !== 'http:' && x.protocol !== 'https:') return false;
  if (!crawlState.seedOrigins.has(x.origin)) return false;
  return inGlobalScope(u);
}

// 시드 텍스트 → 절대 URL 배열 (trim, https:// prepend, dedup, 검증).
function preprocessCrawlUrls(rawText) {
  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
  const seen = new Set();
  const urls = [];
  for (const line of lines) {
    let url = /^https?:\/\//i.test(line) ? line : 'https://' + line;
    try { new URL(url); } catch { continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length >= SPIDER_MAX_PAGES) break;
  }
  return urls;
}

function showCrawlModal() {
  document.getElementById('crawl-modal').classList.remove('hidden');
}
function hideCrawlModal() {
  document.getElementById('crawl-modal').classList.add('hidden');
}

function startCrawl() {
  const seeds = preprocessCrawlUrls(document.getElementById('crawl-urls').value);
  if (seeds.length === 0) {
    showToast('No valid seed URLs.');
    return;
  }
  const waitVal = parseInt(document.getElementById('crawl-wait').value, 10);
  const waitSec = Math.min(30, Math.max(1, isNaN(waitVal) ? 5 : waitVal));
  const depthVal = parseInt(document.getElementById('crawl-depth').value, 10);
  const maxDepth = Math.min(5, Math.max(0, isNaN(depthVal) ? 2 : depthVal));
  const pagesVal = parseInt(document.getElementById('crawl-max-pages').value, 10);
  const maxPages = Math.min(SPIDER_MAX_PAGES, Math.max(1, isNaN(pagesVal) ? 200 : pagesVal));

  // 모니터링이 꺼져 있으면 자동으로 켜기. 이때 "크롤이 켰다"를 기록 →
  // 크롤 종료 시 자동 OFF. 사용자가 미리 켜둔 세션이면 건드리지 않음.
  crawlState.monitorAutoStarted = !networkMonitoring;
  if (!networkMonitoring) startNetworkMonitoring();

  crawlState.fastDiscovery = document.getElementById('crawl-fast-discovery').checked;

  crawlState.active = true;
  crawlState.waitMs = crawlState.fastDiscovery ? SPIDER_FAST_WAIT_MS : waitSec * 1000;
  crawlState.maxDepth = maxDepth;
  crawlState.maxPages = maxPages;
  crawlState.frontier = [];
  crawlState.seen = new Set();
  crawlState.seedOrigins = new Set();
  crawlState.visitedCount = 0;
  crawlState.currentUrl = '';
  for (const s of seeds) {
    const key = normalizeUrl(s);
    if (!key || crawlState.seen.has(key)) continue;
    try { crawlState.seedOrigins.add(new URL(s).origin); } catch { continue; }
    crawlState.seen.add(key);
    crawlState.frontier.push({ url: s, depth: 0 });
  }

  crawlState.scopeCapture = document.getElementById('crawl-scope-capture').checked;
  crawlState.skipAssets = document.getElementById('crawl-skip-assets').checked;
  crawlState.metaFile = document.getElementById('crawl-meta-file').checked;
  crawlState.seeds = seeds.slice();
  crawlState.startedAt = Date.now();
  crawlState.endedAt = null;

  // UI: 입력 잠금, Start → Stop으로 교체, progress 블록 표시
  ['crawl-urls', 'crawl-wait', 'crawl-depth', 'crawl-max-pages', 'crawl-import-btn',
   'crawl-scope-capture', 'crawl-fast-discovery', 'crawl-skip-assets', 'crawl-meta-file'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = true;
  });
  document.getElementById('crawl-progress').classList.remove('hidden');
  const btn = document.getElementById('crawl-start');
  btn.textContent = 'Stop';
  btn.className = 'btn btn-danger';

  visitNextCrawl();
}

// frontier BFS 한 스텝: 다음 유효 항목 navigate → 로드완료(readyState
// 'complete' + origin 일치) 폴링 → grace → (depth<max면) same-origin 링크
// 추출·enqueue → wait → 반복. 로드완료가 안 잡히면(alert/hang/너무 느림)
// 워치독이 그 페이지 버리고 다음으로 → 다음 스텝의 spiderNavigate(브라우저
// 레벨)가 막힌 다이얼로그를 부수적으로 취소.
function visitNextCrawl() {
  if (!crawlState.active) return;

  let item = null;
  while (crawlState.frontier.length) {
    const cand = crawlState.frontier.shift();
    if (!inSpiderScope(cand.url) || isDestructiveUrl(cand.url)) continue;
    item = cand;
    break;
  }
  if (!item || crawlState.visitedCount >= crawlState.maxPages) {
    completeCrawl();
    return;
  }

  crawlState.visitedCount++;
  crawlState.currentUrl = item.url;
  updateCrawlProgress(item);

  let expectedOrigin = null;
  try { expectedOrigin = new URL(item.url).origin; } catch { /* keep null */ }

  // 이 스텝은 readyState 폴링 성공 또는 워치독 중 먼저 오는 쪽만 1회 처리.
  let stepDone = false;
  const finishStep = (loaded) => {
    if (stepDone) return;
    stepDone = true;
    if (crawlState.pollId) { clearInterval(crawlState.pollId); crawlState.pollId = null; }
    if (crawlState.watchdogId) { clearTimeout(crawlState.watchdogId); crawlState.watchdogId = null; }
    if (!crawlState.active) return;
    if (loaded) {
      // 실제 로드 완료 → 짧은 grace 후 링크 추출.
      crawlState.timeoutId = setTimeout(() => {
        if (!crawlState.active) return;
        collectLinksThenContinue(item);
      }, SPIDER_POST_LOAD_GRACE_MS);
    } else {
      // 로드완료 안 잡힘(alert/hang/너무 느림) → 이 페이지 추출 생략,
      // 다음으로. 다음 spiderNavigate(브라우저 레벨)가 막힌 다이얼로그를
      // 부수적으로 취소시키며 빠져나감.
      crawlState.timeoutId = setTimeout(visitNextCrawl, crawlState.waitMs);
    }
  };

  // 브라우저 레벨 이동 (background tabs.update). 페이지 JS 안 거침.
  spiderNavigate(item.url);

  // commit 대기 후, inspectedWindow.eval로 새 페이지 로드 완료를 폴링.
  // origin이 기대값과 일치 + readyState 'complete'여야 통과 → 이전 문서의
  // 잔여 'complete'를 새 페이지로 오인하지 않음. alert가 페이지를 막으면
  // 이 eval이 응답 안 함 → 워치독이 stuck 처리.
  crawlState.timeoutId = setTimeout(() => {
    if (!crawlState.active || stepDone) return;
    const probe = `JSON.stringify({rs:document.readyState,o:location.origin})`;
    crawlState.pollId = setInterval(() => {
      if (!crawlState.active || stepDone) {
        if (crawlState.pollId) { clearInterval(crawlState.pollId); crawlState.pollId = null; }
        return;
      }
      chrome.devtools.inspectedWindow.eval(probe, (raw, err) => {
        if (err || stepDone || !crawlState.active) return;
        let st;
        try { st = JSON.parse(raw); } catch { return; }
        if (st && st.rs === 'complete' &&
            (expectedOrigin === null || st.o === expectedOrigin)) {
          finishStep(true);
        }
      });
    }, SPIDER_POLL_MS);
  }, SPIDER_NAV_COMMIT_MS);

  crawlState.watchdogId = setTimeout(() => {
    crawlState.watchdogId = null;
    finishStep(false);
  }, SPIDER_WATCHDOG_MS);
}

// 현재 페이지에서 same-origin 앵커를 추출해 frontier에 enqueue(depth+1)한 뒤,
// wait → 다음 스텝. (passive 전용 — 페이지 트래픽은 Monitor/JS Trace가 캡처)
//
// 여기 도달 = visitNextCrawl에서 이미 readyState 'complete'를 확인한 뒤
// (grace 경과)라 보통 추출 eval은 즉시 응답. 다만 로드 *완료 후* 타이머
// 등으로 뒤늦게 뜨는 alert가 추출 eval을 막을 수 있어 보조 워치독을 둔다 —
// eval 콜백 vs 워치독 중 먼저 오는 쪽이 이기고(race guard) 다른 쪽은 무시.
// 워치독이 이기면 추출 생략하고 진행 → 다음 visitNextCrawl의 spiderNavigate
// (브라우저 레벨)가 막힌 다이얼로그를 부수적으로 취소시키며 빠져나감.
function collectLinksThenContinue(item) {
  let settled = false;
  const proceed = () => {
    if (settled) return;
    settled = true;
    if (crawlState.watchdogId) { clearTimeout(crawlState.watchdogId); crawlState.watchdogId = null; }
    if (!crawlState.active) return;
    crawlState.timeoutId = setTimeout(visitNextCrawl, crawlState.waitMs);
  };

  if (item.depth >= crawlState.maxDepth) { proceed(); return; }

  // 원인 불문 워치독 — eval이 막혀 무응답이면 stuck 처리하고 진행.
  crawlState.watchdogId = setTimeout(() => {
    crawlState.watchdogId = null;
    proceed();
  }, SPIDER_WATCHDOG_MS);

  const expr = `JSON.stringify((function(){try{
    return Array.prototype.slice.call(document.querySelectorAll('a[href]'))
      .map(function(a){ return a.href; });
  }catch(e){ return []; }})())`;
  chrome.devtools.inspectedWindow.eval(expr, (raw) => {
    if (settled || !crawlState.active) return;
    try {
      const hrefs = JSON.parse(raw || '[]');
      for (const h of hrefs) {
        if (crawlState.seen.size >= crawlState.maxPages) break;
        const key = normalizeUrl(h);
        if (!key || crawlState.seen.has(key)) continue;
        if (!inSpiderScope(h) || isDestructiveUrl(h)) continue;
        crawlState.seen.add(key);
        crawlState.frontier.push({ url: h, depth: item.depth + 1 });
      }
    } catch { /* malformed — skip enqueue */ }
    proceed();
  });
}

// 크롤이 Monitor를 자동으로 켰던 경우에만 종료 시 자동 OFF.
// stopNetworkMonitoring은 데이터를 안 지움(clear는 별개) → 캡처된 크롤
// 결과·jsTrace 보존되어 이후 export 정상. 사용자가 도중 수동 OFF 했으면
// (networkMonitoring=false) 재토글 안 함.
function maybeStopMonitorAfterCrawl() {
  if (crawlState.monitorAutoStarted && networkMonitoring) {
    stopNetworkMonitoring();
  }
  crawlState.monitorAutoStarted = false;
}

function stopCrawl() {
  if (crawlState.timeoutId) clearTimeout(crawlState.timeoutId);
  crawlState.timeoutId = null;
  if (crawlState.watchdogId) clearTimeout(crawlState.watchdogId);
  crawlState.watchdogId = null;
  if (crawlState.pollId) clearInterval(crawlState.pollId);
  crawlState.pollId = null;
  crawlState.active = false;
  crawlState.endedAt = Date.now();
  saveCrawlMeta();
  maybeStopMonitorAfterCrawl();
  resetCrawlUI();
}

function completeCrawl() {
  const n = crawlState.visitedCount;
  crawlState.active = false;
  crawlState.endedAt = Date.now();
  saveCrawlMeta();
  maybeStopMonitorAfterCrawl();
  resetCrawlUI();
  showToast(`Crawled ${n} page${n === 1 ? '' : 's'}.`);
  hideCrawlModal();
}

function resetCrawlUI() {
  ['crawl-urls', 'crawl-wait', 'crawl-depth', 'crawl-max-pages', 'crawl-import-btn',
   'crawl-scope-capture', 'crawl-fast-discovery', 'crawl-skip-assets', 'crawl-meta-file'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = false;
  });
  document.getElementById('crawl-progress').classList.add('hidden');
  const btn = document.getElementById('crawl-start');
  btn.textContent = 'Start';
  btn.className = 'btn btn-primary';
  // 입력 재활성화 후, fast 모드면 per-page wait는 다시 비활성 유지
  // (fast 모드에선 무의미 — waitMs가 0으로 강제됨).
  syncFastModeUI();
}

// fast 모드 체크 시 Per-page wait 입력 비활성화 (값이 무시되므로 혼선 방지).
function syncFastModeUI() {
  const fast = document.getElementById('crawl-fast-discovery');
  const wait = document.getElementById('crawl-wait');
  if (fast && wait && !crawlState.active) wait.disabled = fast.checked;
}

function updateCrawlProgress(item) {
  const visited = crawlState.visitedCount;
  const remaining = crawlState.frontier.length;
  const total = visited + remaining;
  const pct = total ? (visited / total) * 100 : 0;
  document.querySelector('.crawl-progress-fill').style.width = `${pct}%`;
  document.querySelector('.crawl-progress-text').textContent =
    `visited ${visited} · queued ${remaining}` +
    (item ? ` · depth ${item.depth}` : '');
  document.querySelector('.crawl-current-url').textContent = item ? item.url : '--';
}

let _toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById('dtpp-toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('visible');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toast.classList.remove('visible'), 3000);
}

document.getElementById('network-auto-crawl').addEventListener('click', showCrawlModal);
document.getElementById('crawl-modal-close').addEventListener('click', () => {
  if (crawlState.active) stopCrawl();
  hideCrawlModal();
});
document.getElementById('crawl-cancel').addEventListener('click', () => {
  if (crawlState.active) stopCrawl();
  hideCrawlModal();
});
document.getElementById('crawl-start').addEventListener('click', () => {
  if (crawlState.active) stopCrawl();
  else startCrawl();
});

// fast 모드 토글 → Per-page wait 활성/비활성 동기화 (+ 초기 1회).
document.getElementById('crawl-fast-discovery').addEventListener('change', syncFastModeUI);
syncFastModeUI();

// Import .txt — 파일 내용을 textarea에 채움. import 후에도 textarea는
// 편집 가능 → 사용자가 import한 목록을 다듬을 수 있음(원치 않는 host 제거,
// 몇 개 추가) → Start 누르기 전에.
const _crawlImportFile = document.getElementById('crawl-import-file');
document.getElementById('crawl-import-btn').addEventListener('click', () => {
  _crawlImportFile.click();
});
_crawlImportFile.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  // 소프트 사이즈 상한 — 200-URL 제한이라 정상 사용 시 파일이 매우 작음.
  // 256 KB 초과면 거의 확실히 잘못된 파일.
  if (file.size > 256 * 1024) {
    showToast('File too large (max 256 KB)');
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const textarea = document.getElementById('crawl-urls');
    textarea.value = String(reader.result || '');
  };
  reader.onerror = () => {
    showToast('Failed to read file');
  };
  reader.readAsText(file);
  // 동일 파일명 재선택 시에도 change 이벤트 재발화하도록 reset.
  e.target.value = '';
});

function classifyMimeType(mimeType) {
  if (!mimeType) return 'other';
  if (mimeType.includes('json') || mimeType.includes('xml')) return 'api';
  if (mimeType.includes('html')) return 'page';
  if (mimeType.includes('javascript')) return 'script';
  if (mimeType.includes('css')) return 'style';
  if (mimeType.includes('image')) return 'image';
  if (mimeType.includes('font') || mimeType.includes('woff')) return 'font';
  return 'other';
}


function addToSitemap(req) {
  let parsed;
  try { parsed = new URL(req.url); } catch { return; }

  const host = parsed.host;
  const pathname = parsed.pathname || '/';
  const segments = pathname.split('/').filter(Boolean);

  // 아직 main host가 확정되지 않음 — detectTargetHost/onNavigated가
  // 할당할 때까지 버퍼에 보관, 그 후 이 요청을 replay.
  if (!targetHost) {
    _sitemapPending.push(req);
    return;
  }

  // 활성 main host 노드 보장.
  if (!sitemapTree[targetHost]) {
    sitemapTree[targetHost] = { children: {}, requests: [], external: {} };
  }
  const mainNode = sitemapTree[targetHost];
  if (!mainNode.external) mainNode.external = {};

  // 버킷 선택: same-origin 요청은 main host의 path 트리로,
  // cross-origin 요청은 해당 main host의 `external` map 아래로
  // (external host당 1 엔트리).
  let node;
  if (host === targetHost) {
    node = mainNode;
  } else {
    if (!mainNode.external[host]) {
      mainNode.external[host] = { children: {}, requests: [] };
    }
    node = mainNode.external[host];
  }

  for (const seg of segments) {
    if (!node.children[seg]) {
      node.children[seg] = { children: {}, requests: [] };
    }
    node = node.children[seg];
  }

  // Dedup: 동일 method + url + status 조합 있으면 skip
  const isDup = node.requests.some(r => r.method === req.method && r.url === req.url && r.status === req.status);
  if (!isDup) {
    node.requests.push(req);
  }

  scheduleSitemapRender();
}

// per-request hot path용 throttled 트리 렌더. animation frame당 최대
// 1회 렌더링하고, 사용자가 트리 내부 컨트롤(열려 있는 Set Scope
// <select>)에 포커스 중이면 렌더링 deferral → burst로 들어오는 요청이
// dropdown을 클릭 도중에 destroy하지 않도록.
let _sitemapRenderRaf = 0;
function scheduleSitemapRender() {
  if (_sitemapRenderRaf) return;
  _sitemapRenderRaf = requestAnimationFrame(() => {
    _sitemapRenderRaf = 0;
    const active = document.activeElement;
    if (active && active.closest && active.closest('.sitemap-tree')) {
      // 다음 frame에 재시도 — 사용자가 트리와의 상호작용을 끝낼
      // 때까지 defer.
      scheduleSitemapRender();
      return;
    }
    renderSitemapTree();
  });
}


function matchesSitemapFilters(req) {
  // Site Map의 유일한 필터는 글로벌 Scope — 스코프 밖 캡처 요청은
  // 사용자가 scope를 clear할 때까지 트리에서 숨김.
  // Type/Status 필터링은 이제 Network 탭에만 있음.
  return inGlobalScope(req.url);
}

function nodeHasFilteredRequests(node) {
  if (node.requests.some(matchesSitemapFilters)) return true;
  return Object.values(node.children).some(nodeHasFilteredRequests);
}

function getNodeRequestCount(node) {
  let count = 0;
  function countN(n) {
    count += n.requests.filter(matchesSitemapFilters).length;
    Object.values(n.children).forEach(countN);
  }
  countN(node);
  return count;
}

function renderSitemapTree() {
  sitemapTreeEl.innerHTML = '';

  const hosts = Object.keys(sitemapTree).sort();
  if (hosts.length === 0) {
    sitemapTreeEl.innerHTML = '<div class="sitemap-empty">Data is collected automatically as requests are made.</div>';
    return;
  }

  // Target host 항상 먼저 표시
  if (targetHost) {
    ensureTargetInTree();
    const hostNode = sitemapTree[targetHost];
    const hostEl = buildTreeNode(targetHost, hostNode, targetHost, '', true);
    if (hostEl) sitemapTreeEl.appendChild(hostEl);
  }

  // 이전 방문 host (사용자가 실제로 이동한 non-target main host).
  // 각각 현재 target 아래 최상위 레벨로 렌더; 그들의 cross-origin
  // 요청은 각 main host의 자체 External 그룹 안에 중첩됨
  // (buildTreeNode가 처리).
  const visitedHosts = hosts.filter(h =>
    h !== targetHost && sitemapTree[h]._lastVisitedUrl
  );
  for (const host of visitedHosts) {
    const el = buildTreeNode(host, sitemapTree[host], host, '', true);
    if (el) sitemapTreeEl.appendChild(el);
  }
}

// per-main-host External 그룹. main host 자체 트리 노드의 자식으로
// 존재해서 각 방문 site가 자기 third-party 트래픽을 분리 보관. toggle
// key에 main host를 포함하여 사이트마다 external 그룹이 독립적으로
// 펼쳐짐.
function buildHostExternalGroup(externalMap, mainHost) {
  const externalHosts = Object.keys(externalMap || {})
    .filter(h => nodeHasFilteredRequests(externalMap[h]))
    .sort();
  if (externalHosts.length === 0) return null;

  const wrapper = document.createElement('div');
  wrapper.className = 'sitemap-external-group';

  const expandKey = `${mainHost}:__external__`;
  const isExpanded = expandedNodes.has(expandKey);

  const row = document.createElement('div');
  row.className = 'sitemap-node sitemap-external-header';
  const toggle = document.createElement('span');
  toggle.className = 'sitemap-node-toggle';
  toggle.textContent = isExpanded ? '▼' : '▶';
  row.appendChild(toggle);
  const icon = document.createElement('span');
  icon.className = 'sitemap-node-icon';
  icon.textContent = '📡';
  row.appendChild(icon);
  const label = document.createElement('span');
  label.className = 'sitemap-node-label sitemap-external-label';
  label.textContent = `External (${externalHosts.length})`;
  row.appendChild(label);
  wrapper.appendChild(row);

  const children = document.createElement('div');
  children.className = isExpanded ? 'sitemap-children' : 'sitemap-children collapsed';
  for (const host of externalHosts) {
    const el = buildTreeNode(host, externalMap[host], host, '');
    if (el) children.appendChild(el);
  }
  wrapper.appendChild(children);

  function toggleGroup(e) {
    if (e) e.stopPropagation();
    if (expandedNodes.has(expandKey)) expandedNodes.delete(expandKey);
    else expandedNodes.add(expandKey);
    children.classList.toggle('collapsed');
    toggle.textContent = children.classList.contains('collapsed') ? '▶' : '▼';
  }
  toggle.addEventListener('click', toggleGroup);
  row.addEventListener('click', () => toggleGroup(null));

  return wrapper;
}

function buildTreeNode(label, node, host, currentPath, forceShow) {
  const isHostNode = currentPath === '';
  const hasPathChildren = Object.keys(node.children).length > 0;
  const hasExternalChildren = isHostNode && node.external && Object.keys(node.external).length > 0;
  const hasChildren = hasPathChildren || hasExternalChildren;
  const hasOwnRequests = node.requests.filter(matchesSitemapFilters).length > 0;

  if (!forceShow && !nodeHasFilteredRequests(node)) return null;

  const wrapper = document.createElement('div');

  // 노드 행
  const row = document.createElement('div');
  row.className = 'sitemap-node';
  const isHost = currentPath === '';
  const fullPath = currentPath || '/';
  if (sitemapSelectedNode &&
      sitemapSelectedNode.host === host &&
      sitemapSelectedNode.path === fullPath) {
    row.classList.add('selected');
  }
  // 현재 활성 inspected 페이지인 host를 강조하고, 이번 세션에 방문한
  // 모든 host에 "이 host에서 마지막으로 머문 곳"을 툴팁으로 표시.
  if (isHost) {
    if (host === targetHost) row.classList.add('sitemap-node-target');
    if (node._lastVisitedUrl) {
      const ts = node._lastVisitedAt ? new Date(node._lastVisitedAt).toLocaleString() : '';
      row.title = `Last visited: ${node._lastVisitedUrl}${ts ? ` (${ts})` : ''}`;
    }
  }

  // Toggle 아이콘
  const nodeKey = host + ':' + fullPath;
  const isExpanded = expandedNodes.has(nodeKey);
  const toggle = document.createElement('span');
  toggle.className = 'sitemap-node-toggle';
  toggle.textContent = hasChildren ? (isExpanded ? '▼' : '▶') : '';
  row.appendChild(toggle);

  // 아이콘
  const icon = document.createElement('span');
  icon.className = 'sitemap-node-icon';
  icon.textContent = isHost ? '🌐' : (hasPathChildren ? '📁' : '📄');
  row.appendChild(icon);

  // 라벨
  const labelEl = document.createElement('span');
  labelEl.className = 'sitemap-node-label';
  labelEl.textContent = label;
  row.appendChild(labelEl);

  const count = getNodeRequestCount(node);
  if (count > 0) {
    const countEl = document.createElement('span');
    countEl.className = 'sitemap-node-count';
    countEl.textContent = count;
    row.appendChild(countEl);
  }

  // host 전용: "Set Scope" 드롭다운 — 이 도메인(또는 와일드카드
  // 형태)을 글로벌 scope로 고정. 사용자가 패턴을 직접 입력하지 않고
  // Intercept 노이즈를 줄일 수 있게 함.
  if (isHost) {
    const scopeSelect = document.createElement('select');
    scopeSelect.className = 'btn btn-xs sitemap-scope-select';
    scopeSelect.title = `Set global scope based on ${host}`;

    // 닫힌 상태에서 표시될 placeholder — scope 의미의 표적 아이콘.
    // 펼치면 native select dropdown으로 Exact/Wildcard 옵션 노출.
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '🎯';
    placeholder.disabled = true;
    placeholder.selected = true;
    scopeSelect.appendChild(placeholder);

    const exactOpt = document.createElement('option');
    exactOpt.value = `${host}/*`;
    exactOpt.textContent = `Exact: ${host}`;
    scopeSelect.appendChild(exactOpt);

    const wildcard = wildcardHost(host);
    if (wildcard) {
      const wildcardOpt = document.createElement('option');
      wildcardOpt.value = `${wildcard}/*`;
      wildcardOpt.textContent = `Wildcard: ${wildcard}`;
      scopeSelect.appendChild(wildcardOpt);
    }

    scopeSelect.addEventListener('click', (e) => e.stopPropagation());
    scopeSelect.addEventListener('change', (e) => {
      e.stopPropagation();
      const pattern = scopeSelect.value;
      if (pattern) applyScopePattern(pattern);
      scopeSelect.value = '';
    });

    row.appendChild(scopeSelect);

    // host 전용: 🕷 Auto Crawl 시드 추가. 그 호스트를 크롤 모달 텍스트
    // 에어리어에 append(dedup) 후 모달 오픈. 행 클릭(상세 확장)과 분리.
    // 크롤 진행 중이면 텍스트에어리어가 disabled라 토스트 안내 후 무시.
    const crawlAddBtn = document.createElement('button');
    crawlAddBtn.className = 'btn btn-xs sitemap-crawl-add';
    crawlAddBtn.textContent = '🕷';
    crawlAddBtn.title = `Add ${host} to Auto Crawl seeds`;
    crawlAddBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (crawlState.active) {
        showToast('Auto Crawl 진행 중 — 종료 후 다시 시도');
        return;
      }
      const ta = document.getElementById('crawl-urls');
      const seed = `https://${host}/`;
      const existing = (ta.value || '').split('\n').map(s => s.trim()).filter(Boolean);
      if (!existing.includes(seed)) {
        existing.push(seed);
        ta.value = existing.join('\n');
      }
      showCrawlModal();
    });
    row.appendChild(crawlAddBtn);
  }

  // host 전용 (target host만): Hard reload 버튼 — 브라우저에서 실제 열려있는
  // 호스트에 대해서만 의미 있는 동작이므로 target host 노드에만 노출.
  // `chrome.devtools.inspectedWindow.reload({ignoreCache:true})`는 inspected
  // tab만 reload하므로 다른 host(이전 방문 / external) 노드에서는 무의미.
  if (isHost && host === targetHost) {
    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'btn btn-xs sitemap-host-reload';
    reloadBtn.textContent = '↻';
    reloadBtn.title = 'Hard reload the inspected tab (bypasses cache so cached CSS/JS/images get re-captured)';
    reloadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.devtools.inspectedWindow.reload({ ignoreCache: true });
    });
    row.appendChild(reloadBtn);
  }

  wrapper.appendChild(row);

  // 자식 컨테이너 (펼침 상태 복원)
  const childrenEl = document.createElement('div');
  childrenEl.className = isExpanded ? 'sitemap-children' : 'sitemap-children collapsed';

  const sortedChildren = Object.keys(node.children).sort();
  for (const childName of sortedChildren) {
    const childPath = currentPath + '/' + childName;
    const childEl = buildTreeNode(childName, node.children[childName], host, childPath);
    if (childEl) childrenEl.appendChild(childEl);
  }

  // per-host External 그룹 — main-host 행에만, external host 중 표시할
  // 필터링된 요청이 있을 때만.
  if (hasExternalChildren) {
    const extGroup = buildHostExternalGroup(node.external, host);
    if (extGroup) childrenEl.appendChild(extGroup);
  }

  if (hasChildren) {
    wrapper.appendChild(childrenEl);
  }

  // Toggle helper — 이 노드의 자식을 펼치거나 접음. 명시적 toggle
  // 화살표와 row-click fallback 양쪽에서 사용.
  function toggleExpanded() {
    const collapsed = childrenEl.classList.toggle('collapsed');
    toggle.textContent = collapsed ? '▶' : '▼';
    if (collapsed) expandedNodes.delete(nodeKey); else expandedNodes.add(nodeKey);
  }

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleExpanded();
  });

  // 트리 클릭 — 노드에 직접 캡처된 요청이 있으면 Network 리스트의
  // 그 요청으로 점프 (selectNetworkRequest가 detail 패널을 열고 행을
  // 강조). 자식만 있는 중간 경로 노드는 expand/collapse로 fallback해서
  // 모든 행이 클릭 가능하게 유지.
  row.addEventListener('click', (e) => {
    // host의 Set Scope 드롭다운에 떨어진 클릭은 무시 — 자체 change
    // 핸들러가 있고 row를 이중 트리거하면 안 됨.
    if (e.target.closest('.sitemap-scope-select')) return;
    if (node.requests.length > 0) {
      const latest = node.requests[node.requests.length - 1];
      if (latest && latest.requestId && networkRequestMap.has(latest.requestId)) {
        // main host(sitemapTree의 최상위 = tabHosts entry)에 떨어진
        // 클릭일 때만 활성 탭 전환. external-host 노드(어떤 main host의
        // `external` map 아래)는 자체 탭이 없으므로 현재 탭은 그대로
        // 두고 detail만 연다.
        const reqHost = _reqHost(latest);
        if (reqHost && reqHost !== activeTabHost && tabHosts.indexOf(reqHost) >= 0) {
          setActiveTab(reqHost);
        }
        sitemapSelectedNode = { host, path: fullPath };
        selectNetworkRequest(latest.requestId, { scroll: true });
        renderSitemapTree(); // .selected 하이라이트 갱신
        return;
      }
      // 모니터링 밖에서 캡처됨 → Network detail map에 없음. silent no-op
      // 대신 힌트를 띄워서 사용자가 행이 클릭 가능했지만 결과가 없었다는
      // 걸 알게 함.
      showToast('Start Monitoring to inspect this request');
      return;
    }
    if (hasChildren) toggleExpanded();
  });

  return wrapper;
}

// ============================================================
// Send to Browser — 캡처된 요청을 새 탭에서 열어 프록시를 거쳐
// 원본 패널의 Intercept 큐에 도착하게 함.
// ============================================================

// 브라우저가 관리하는 헤더는 swap payload에서 제거 — 보내봐야
// 새 탭의 브라우저 자체 값과 충돌하거나 중복임 (Cookie는 jar에서,
// Origin/Referer는 launcher 탭이 결정, Content-Type은 form-submit/GET
// 의미가 결정).
const BROWSER_MANAGED_HEADERS_S2B = new Set([
  'cookie', 'host', 'origin', 'referer', 'user-agent',
  'accept', 'accept-encoding', 'accept-language',
  'connection', 'content-length',
  'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user',
  'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
  'upgrade-insecure-requests',
  'content-type',
]);

function _filterHeadersForSwap(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (BROWSER_MANAGED_HEADERS_S2B.has(name.toLowerCase())) continue;
    // HTTP/2 pseudo-headers (:authority / :method / :path / :scheme /
    // :status)는 Chrome이 origin과 h2로 통신할 때 캡처에 들어옴.
    // HTTP/1.1 token 이름으로는 invalid라 forward하면 node http.request()
    // 가 crash — drop.
    if (name.startsWith(':')) continue;
    out[name] = value;
  }
  return out;
}

function _getHeaderCI(headers, name) {
  if (!headers) return '';
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return '';
}

function canSendToBrowser(req) {
  if (!req || !req.method || !req.url) {
    return { ok: false, reason: 'No request selected' };
  }
  if (req._imported) {
    return { ok: false, reason: 'Imported requests cannot be re-issued — only live captures' };
  }
  if (req.method === 'GET') return { ok: true };
  if (req.method !== 'POST') {
    return { ok: false, reason: `${req.method} cannot be triggered as a browser navigation — use Replay` };
  }
  const ct = (_getHeaderCI(req.requestHeaders, 'content-type') || '').toLowerCase();
  if (ct.startsWith('application/x-www-form-urlencoded')) return { ok: true };
  if (ct.startsWith('multipart/form-data')) {
    return { ok: false, reason: 'multipart/form-data POST cannot be replayed (file fields are not captured) — use Replay' };
  }
  if (ct.startsWith('application/json')) {
    return { ok: false, reason: 'JSON body cannot be navigated — use Replay' };
  }
  if (!ct) {
    if (!req.requestPostData) return { ok: true };
    return { ok: false, reason: 'POST body has no Content-Type — cannot determine encoding' };
  }
  return { ok: false, reason: `Content-Type "${ct.split(';')[0]}" cannot be browser-navigated — use Replay` };
}

function _parseFormUrlencodedFields(body) {
  if (!body) return [];
  const fields = [];
  for (const part of body.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const rawName = eq < 0 ? part : part.slice(0, eq);
    const rawValue = eq < 0 ? '' : part.slice(eq + 1);
    let name = rawName;
    let value = rawValue;
    try {
      name = decodeURIComponent(rawName.replace(/\+/g, ' '));
      value = decodeURIComponent(rawValue.replace(/\+/g, ' '));
    } catch { /* 잘못된 인코딩 — raw 그대로 통과 */ }
    fields.push({ name, value });
  }
  return fields;
}

function sendToBrowserNewTab() {
  const req = networkRequestMap.get(selectedRequestId);
  const check = canSendToBrowser(req);
  if (!check.ok) {
    showToast(check.reason);
    return;
  }
  if (!interceptActive) {
    showToast('Enable Intercept first — the new tab needs the proxy active to be caught');
    return;
  }
  const payload = {
    method: req.method,
    url: req.url,
    headers: _filterHeadersForSwap(req.requestHeaders),
  };
  if (req.method === 'POST') {
    payload.fields = _parseFormUrlencodedFields(req.requestPostData || '');
    payload.enctype = 'application/x-www-form-urlencoded';
  }
  // Background가 tab 생성/DNR 태깅/header-swap 등록을 한 묶음의 async
  // 시퀀스로 처리. 실패하면 `send_to_browser_error` 브로드캐스트가
  // 돌아옴.
  sendToBg({
    type: 'open_new_tab_for_intercept',
    payload,
  });
  const interceptTabBtn = document.querySelector('.tab[data-tab="intercept"]');
  if (interceptTabBtn) interceptTabBtn.click();
  showToast('Opening new tab — watch the Intercept queue');
}

function updateSendToBrowserButton() {
  const btn = document.getElementById('detail-send-to-browser');
  if (!btn) return;
  const req = selectedRequestId ? networkRequestMap.get(selectedRequestId) : null;
  if (!req) {
    btn.disabled = true;
    btn.title = 'Select a request first';
    return;
  }
  // Replay edit 모드는 Send to Browser와 상호 배타 — 사용자가 fetch로
  // 발화할 요청을 편집 중인데 새 탭으로 보내면 그것과 경쟁하거나
  // 편집되지 않은 캡처 요청이 silently 전송됨. 둘 다 놀라움. replay
  // edit 종료까지 버튼 잠금.
  if (msgReplayEditing) {
    btn.disabled = true;
    btn.title = 'Exit Replay edit (click ↻ Replay again) to use Send to Browser';
    return;
  }
  const check = canSendToBrowser(req);
  btn.disabled = !check.ok;
  btn.title = check.ok
    ? 'Open this request in a new tab so it goes through Intercept (requires Intercept ON).'
    : check.reason;
}

document.getElementById('detail-send-to-browser').addEventListener('click', sendToBrowserNewTab);


// ============================================================
// 1. Network 모니터링 (chrome.devtools.network API 사용 — debugger 불필요)
// ============================================================
const networkRequests = [];
const networkRequestMap = new Map(); // requestId -> request 객체
let networkMonitoring = false;
let selectedRequestId = null;
let networkIdCounter = 0;

// Network 리스트 상단의 host별 탭. 각 캡처된 host는 첫 요청이 떨어질
// 때 자체 탭을 받음; 활성 탭은 전역 networkRequests 배열에 host 필터로
// 작동(탭마다 데이터 복제 없음 — 단일 소스 + 렌더 타임 필터).
// 브라우저 navigation은 활성 탭 자동 전환; 이전 host로 돌아오면 기존
// 탭 재사용해서 누적 이어짐.
const tabHosts = []; // host 문자열 정렬 리스트 (표시 순서)
let activeTabHost = null;

// Export용 멀티 선택. 사용자가 행별 체크박스 또는 master 체크박스로
// 체크한 request ID 추적; selectedRequestId(detail 패널 드라이브)와는
// 독립.
const selectedExportIds = new Set();
let _lastCheckedReqId = null; // shift-click 범위 선택의 앵커

// 뷰 필터 — 멀티 선택 Type (mime 카테고리) + Status (HTTP code 범위).
// 한 쪽이 빈 Set이면 "그 축은 필터 없음"; 둘 다 비면 필터 완전 비활성.
// Scope(도메인 게이트)와 Search(마크하지만 숨기지 않음)와는 독립.
// 렌더 시점에만 적용 — 캡처 데이터는 networkRequests에 그대로 보존되어
// 필터 토글로 잃지 않음.
const networkFilter = {
  types: new Set(),    // 'api' | 'page' | 'script' | 'style' | 'image' | 'font' | 'other'
  statuses: new Set(), // '2xx' | '3xx' | '4xx' | '5xx'
};

function networkFilterIsActive() {
  return networkFilter.types.size > 0 || networkFilter.statuses.size > 0;
}

function matchesNetworkFilter(req) {
  if (networkFilter.types.size > 0) {
    if (!networkFilter.types.has(classifyMimeType(req.mimeType))) return false;
  }
  if (networkFilter.statuses.size > 0) {
    const s = req.status;
    let bucket = null;
    if (s >= 200 && s < 300) bucket = '2xx';
    else if (s >= 300 && s < 400) bucket = '3xx';
    else if (s >= 400 && s < 500) bucket = '4xx';
    else if (s >= 500 && s < 600) bucket = '5xx';
    if (!bucket || !networkFilter.statuses.has(bucket)) return false;
  }
  return true;
}

const networkTable = document.querySelector('#network-table tbody');
const networkCount = document.getElementById('network-count');
const networkDetail = document.getElementById('network-detail');
const networkSplit = document.querySelector('.network-split');
const networkTabsEl = document.getElementById('network-tabs');

// 요청 URL에서 host를 한 번만 추출. 처음 조회될 때 요청에 저장해서
// 반복되는 tab-filter 체크가 매 렌더 frame마다 URL을 re-parse하지
// 않도록.
function _reqHost(req) {
  if (req._host != null) return req._host;
  try { req._host = new URL(req.url).host; }
  catch { req._host = ''; }
  return req._host;
}

// per-tab 가시성 모드 — 'all' (기본)은 전체 세션 표시(direct hit +
// 그 세션 동안 캡처된 externals, Site Map의 main-host → External 귀속과
// 동일), 'internal'은 direct same-host hit만으로 좁힘. per-tab 상태라
// 사용자가 예를 들어 github.com은 All로 두고 reddit.com은 좁혀서 볼 수
// 있음.
const tabFilterMode = new Map(); // host → 'all' | 'internal'
function getTabFilterMode(host) {
  return tabFilterMode.get(host) || 'all';
}

function matchesActiveTab(req) {
  if (!activeTabHost) return true;
  // 임포트 요청은 _mainHost(`📥 …`) 매칭만. URL host는 plain이라 같은 host의
  // 라이브 탭과 매칭되면 양쪽 탭에 출현하는 버그 → 게이팅.
  if (!req._imported && _reqHost(req) === activeTabHost) return true;
  // 'internal' 모드는 session-attribution 분기를 건너뜀 — externals
  // (CDN .map 파일, analytics, ads)이 뷰에서 빠짐.
  if (getTabFilterMode(activeTabHost) === 'internal') return false;
  if (req._mainHost === activeTabHost) return true;
  return false;
}

// 주어진 host의 탭이 존재하도록 보장. 요청 파이프라인(모든 캡처 요청)
// 과 명시적 사용자 액션(트리 클릭, navigation 이벤트) 양쪽에서 호출.
// 새 탭이 추가됐으면 true 반환 — caller가 재렌더 여부 결정에 사용.
function ensureTab(host) {
  if (!host) return false;
  if (tabHosts.indexOf(host) >= 0) return false;
  tabHosts.push(host);
  const becameActive = activeTabHost == null;
  if (becameActive) activeTabHost = host;
  renderNetworkTabs();
  if (becameActive) refreshTabModeToggleUI();
  return true;
}

// 활성 탭 전환. host-필터링된 모든 뷰를 재렌더해서 list/count/
// search-match-set/selection-master가 새 탭을 한 번에 반영.
function setActiveTab(host) {
  if (!host || activeTabHost === host) return;
  ensureTab(host);
  activeTabHost = host;
  // 이전 탭의 stale 행 하이라이트 — 요청이 이제 보이는 집합에 없을
  // 수 있음. 재렌더 전 clear.
  if (selectedRequestId) {
    const sel = networkRequestMap.get(selectedRequestId);
    if (!sel || _reqHost(sel) !== host) {
      closeDetail();
    }
  }
  renderNetworkTabs();
  refreshTabModeToggleUI();
  renderNetworkTable();
  updateSelectionUI();
  if (searchTerm) {
    recomputeSearchMatches();
    refreshAllRowDots();
    refreshSearchUI();
  }
}

// All / Host-only 토글을 활성 탭의 저장된 모드와 동기화.
// 탭 전환 시 + 매 클릭 시 호출.
function refreshTabModeToggleUI() {
  const wrap = document.getElementById('network-tab-mode-toggle');
  if (!wrap) return;
  const mode = activeTabHost ? getTabFilterMode(activeTabHost) : 'all';
  wrap.querySelectorAll('.tab-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  // scope 잡을 탭이 없으면 disable — 토글이 무의미.
  wrap.classList.toggle('disabled', !activeTabHost);
}

// 탭 close — 해당 host의 캡처 요청을 전역 store에서 wipe하고 대응되는
// 트리 서브트리도 드롭해서 두 뷰가 일치하도록. 데이터 손실이 비가역
// (undo/버퍼 없음)이라 confirm 다이얼로그를 먼저 띄움.
function closeTab(host) {
  if (!host) return;
  // matchesActiveTab predicate와 매칭해서 confirm 다이얼로그의 카운트와
  // 실제 wipe 대상이 사용자가 보고 있던 것과 정확히 일치하도록 —
  // direct host hits + 그 세션의 externals.
  // 임포트 요청은 _mainHost 매칭만 — matchesActiveTab과 동일 정책.
  const belongsToTab = r => (!r._imported && _reqHost(r) === host) || r._mainHost === host;
  const count = networkRequests.filter(belongsToTab).length;
  const msg = count > 0
    ? `Close tab "${host}" and discard its ${count} captured request${count === 1 ? '' : 's'}?`
    : `Close tab "${host}"?`;
  if (!window.confirm(msg)) return;

  // 매칭 요청을 in-place로 드롭 (배열 참조 보존).
  for (let i = networkRequests.length - 1; i >= 0; i--) {
    if (belongsToTab(networkRequests[i])) {
      const req = networkRequests[i];
      networkRequestMap.delete(req.requestId);
      selectedExportIds.delete(req.requestId);
      networkRequests.splice(i, 1);
    }
  }
  // 트리: main host 버킷 + 이 host를 가리키던 다른 host들의 external
  // 항목 모두 드롭. 최상위에 있는 것이 보이는 탭의 서브트리.
  if (sitemapTree[host]) delete sitemapTree[host];
  for (const mainHost of Object.keys(sitemapTree)) {
    const ext = sitemapTree[mainHost].external;
    if (ext && ext[host]) delete ext[host];
  }
  // 탭 리스트 자체.
  const idx = tabHosts.indexOf(host);
  if (idx >= 0) tabHosts.splice(idx, 1);
  if (activeTabHost === host) {
    activeTabHost = tabHosts.length > 0 ? tabHosts[Math.min(idx, tabHosts.length - 1)] : null;
  }
  // 이 탭의 모드 forget — 다음에 열리는 탭은 기본 'all'.
  tabFilterMode.delete(host);
  // selection이 이제 사라진 요청을 가리키고 있을 수 있음.
  if (selectedRequestId && !networkRequestMap.has(selectedRequestId)) {
    closeDetail();
  }
  renderNetworkTabs();
  refreshTabModeToggleUI();
  renderNetworkTable();
  renderSitemapTree();
  updateSelectionUI();
  if (searchTerm) {
    recomputeSearchMatches();
    refreshAllRowDots();
    refreshSearchUI();
  }
}

function renderNetworkTabs() {
  if (tabHosts.length === 0) {
    networkTabsEl.classList.add('hidden');
    networkTabsEl.innerHTML = '';
    _updateExportMenuTabLabels(0);
    return;
  }
  networkTabsEl.classList.remove('hidden');
  // per-tab 카운트는 각 탭이 실제로 보여주는 것과 일치: host가 매칭
  // (direct) 되거나 _mainHost가 매칭(그 세션 동안 캡처됨)된 요청이
  // 탭에 있음. networkRequests를 한 번 walk; 한 요청이 최대 2개 탭에
  // 카운트될 수 있음 (host 탭 + session host 탭) — matchesActiveTab이
  // 둘 다 admit하므로 이 합계가 정확함.
  const counts = new Map();
  const tabSet = new Set(tabHosts);
  for (const r of networkRequests) {
    const h = _reqHost(r);
    // 임포트 요청은 URL host 기반 카운트에서 제외 — 같은 host 라이브 탭이
    // 있어도 라이브 카운트가 부풀지 않게(매칭 정책과 동일).
    if (!r._imported && tabSet.has(h)) counts.set(h, (counts.get(h) || 0) + 1);
    if (r._mainHost && r._mainHost !== h && tabSet.has(r._mainHost)) {
      counts.set(r._mainHost, (counts.get(r._mainHost) || 0) + 1);
    }
  }
  let html = '';
  for (const host of tabHosts) {
    const isActive = host === activeTabHost;
    const count = counts.get(host) || 0;
    const imported = host.startsWith('📥 ');
    const btnCls = `network-tab${isActive ? ' active' : ''}${imported ? ' imported' : ''}`;
    const btnTitle = imported ? '이건 임포트한 탭입니다.' : '';
    html += `<button class="${btnCls}" data-host="${escapeAttr(host)}"${btnTitle ? ` title="${escapeAttr(btnTitle)}"` : ''}>` +
      `<span class="tab-host" title="${escapeAttr(host)}">${escapeHtml(host)}</span>` +
      `<span class="tab-count">${count}</span>` +
      `<span class="tab-close" data-close="${escapeAttr(host)}" title="Close tab">×</span>` +
      `</button>`;
  }
  networkTabsEl.innerHTML = html;
  _updateExportMenuTabLabels(tabHosts.length);
}

// Export 메뉴 섹션 헤더에 현재 활성 탭 + 전체 탭 카운트를 반영해서
// 사용자가 각 옵션이 어떤 스코프로 export하는지 한눈에 파악 가능.
function _updateExportMenuTabLabels(tabCount) {
  const tabSec = document.getElementById('export-menu-section-tab');
  const allSec = document.getElementById('export-menu-section-all');
  if (tabSec) {
    tabSec.textContent = activeTabHost
      ? `Current tab (${activeTabHost})`
      : 'Current tab';
  }
  if (allSec) {
    allSec.textContent = tabCount > 0
      ? `All tabs (${tabCount} host${tabCount === 1 ? '' : 's'})`
      : 'All tabs';
  }
}

// 클릭 위임 — label/count 클릭 시 활성 탭 전환, X 클릭 시 close.
// data-host로 re-render 이후에도 타깃을 전달하므로 element별 리스너
// 불필요.
networkTabsEl.addEventListener('click', (e) => {
  const closeEl = e.target.closest('.tab-close');
  if (closeEl) {
    e.stopPropagation();
    closeTab(closeEl.dataset.close);
    return;
  }
  const tabEl = e.target.closest('.network-tab');
  if (!tabEl) return;
  setActiveTab(tabEl.dataset.host);
});

document.getElementById('network-toggle').addEventListener('click', () => {
  if (networkMonitoring) stopNetworkMonitoring();
  else startNetworkMonitoring();
});
document.getElementById('network-clear').addEventListener('click', clearNetwork);

// All / Host-only 토글. per-tab — 활성 탭의 필터 모드를 설정하고
// re-render. 다른 탭들은 자기 모드 그대로 유지.
document.querySelectorAll('#network-tab-mode-toggle .tab-mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!activeTabHost) return;
    const mode = btn.dataset.mode;
    if (getTabFilterMode(activeTabHost) === mode) return;
    tabFilterMode.set(activeTabHost, mode);
    refreshTabModeToggleUI();
    renderNetworkTable();
    updateSelectionUI();
    if (searchTerm) {
      recomputeSearchMatches();
      refreshAllRowDots();
      refreshSearchUI();
    }
  });
});
refreshTabModeToggleUI();

// Detail 패널 탭 전환
document.querySelectorAll('.detail-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.detail-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    const pane = document.getElementById('detail-' + tab.dataset.detail);
    pane.classList.add('active');
    // 검색 활성 시, 새로 보이는 탭의 첫 매치를 view에 스크롤해서
    // 🔍 배지 클릭의 의도가 자체 설명되도록.
    if (searchTerm) {
      const firstMark = pane.querySelector('mark.network-search-mark');
      if (firstMark) firstMark.scrollIntoView({ block: 'center' });
    }
  });
});

// Detail 패널 close
document.getElementById('detail-close').addEventListener('click', closeDetail);

function closeDetail() {
  networkDetail.classList.add('hidden');
  networkSplit.classList.remove('has-detail');
  selectedRequestId = null;
  networkTable.querySelectorAll('tr.selected').forEach(r => r.classList.remove('selected'));
  updateSendToBrowserButton();
}

// chrome.devtools.network 이벤트 리스너 (항상 활성, attach 불필요)
chrome.devtools.network.onRequestFinished.addListener(processNetworkRequest);

// 이미 인제스트한 URL+status 추적 — HAR replay(auto-start)가 라이브
// 리스너가 이미 처리한 동일 entry를 중복 추가하지 않도록.
const _ingestedRequestKeys = new Set();
function _ingestKey(harEntry) {
  const startedDateTime = harEntry.startedDateTime || '';
  return `${harEntry.request.method}|${harEntry.request.url}|${harEntry.response.status}|${startedDateTime}`;
}

function processNetworkRequest(harEntry) {
  // data: URI는 완전히 skip — 인라인 페이로드라 실제 네트워크 트래픽이
  // 아니고, 한 페이지에서 수백 개(아이콘 등)가 나올 수 있어서 리스트만
  // 범람시키고 스캐닝을 느리게 만듦.
  if (harEntry.request.url.startsWith('data:')) return;

  // 글로벌 스코프 게이트 — 스코프 밖 요청은 완전히 무시(Site Map과
  // Network 리스트에도 추가 안 함). 빈 스코프 = 전 범위 in scope.
  if (!inGlobalScope(harEntry.request.url)) return;

  // 크롤 중 캡처 스코프 — 크롤 대상 사이트(seed origin) 밖 요청 드롭.
  // 200페이지 스파이더링 시 third-party(광고/analytics/CDN) 노이즈가
  // networkRequests에 쌓여 메모리·검색 비용을 키우는 것 방지.
  if (crawlCaptureBlocks(harEntry.request.url)) return;

  // 크롤 중 이미지/폰트 캡처 스킵 (옵션, 기본 OFF) — 메모리/노이즈 절감.
  if (crawlSkipsAsset(harEntry)) return;

  // Auth 탭 probe — 테스트 버튼이 발화하는 `fetch()` 변종이
  // onRequestFinished로 돌아옴. 완전히 드롭해서 Monitor 타임라인이
  // 실제 사용자/페이지 트래픽만 보이도록.
  if (consumeAuthTestFireMatch(harEntry.request.url, harEntry.request.method)) return;

  // HAR replay와의 dedup — 같은 entry가 두 번 들어가지 않도록
  // (예: 라이브 리스너가 발화한 요청이 auto-start 시점 HAR 스냅샷에도
  // 여전히 있는 경우).
  const key = _ingestKey(harEntry);
  if (_ingestedRequestKeys.has(key)) return;
  _ingestedRequestKeys.add(key);

  const reqId = 'net_' + (++networkIdCounter);
  const r = harEntry.request;
  const resp = harEntry.response;

  // request headers → object
  const requestHeaders = {};
  (r.headers || []).forEach(h => { requestHeaders[h.name] = h.value; });

  // response headers → object
  const responseHeaders = {};
  (resp.headers || []).forEach(h => { responseHeaders[h.name] = h.value; });

  // post 데이터
  let postData = null;
  if (r.postData) {
    postData = r.postData.text || null;
  }

  // 표시용 문자열과 함께 raw 숫자 size/time 보존 — 다운스트림 정렬/
  // 필터를 위해 export.
  const rawSize = resp.content?.size ?? resp._transferSize ?? null;
  const rawTime = harEntry.time != null ? Math.round(harEntry.time) : null;

  // HAR-replay된 entry는 response.content.text에 이미 인라인 body를
  // 가지고 있을 수 있음 — 직접 사용해서 getContent에 의존하지 않고
  // 즉시 페이로드 표시.
  const inlineBody = (resp.content && typeof resp.content.text === 'string') ? resp.content.text : null;
  const inlineBodyBase64 = inlineBody != null && resp.content && resp.content.encoding === 'base64';

  const req = {
    requestId: reqId,
    method: r.method,
    url: r.url,
    startTime: null,
    status: resp.status,
    statusText: resp.statusText || '',
    type: resp.content?.mimeType?.split('/').pop() || '-',
    mimeType: resp.content?.mimeType || '',
    size: resp.content?.size ? formatBytes(resp.content.size) : (resp._transferSize ? formatBytes(resp._transferSize) : '-'),
    time: harEntry.time ? Math.round(harEntry.time) + ' ms' : '-',
    rawSize,
    rawTime,
    protocol: resp.httpVersion || '',
    remoteAddress: '',
    requestHeaders: requestHeaders,
    requestPostData: postData,
    responseHeaders: responseHeaders,
    responseBody: inlineBody,
    responseBodyLoaded: inlineBody != null,
    responseBase64: inlineBodyBase64,
    initiator: harEntry._initiator || null,
    // 캡처 시점의 활성 main host — externals(CDN, .map 파일, analytics)
    // 가 그것을 로드한 host와 같은 탭에 나타나도록 session 기반 탭
    // 분리 드라이브. Site Map이 이미 쓰는 귀속(sitemapTree[main].external)
    // 과 동일. targetHost가 아직 모를 때는 null; _flushSitemapPending이
    // detection 완료 후 back-fill.
    _mainHost: targetHost || null,
    _harEntry: harEntry, // HAR entry 참조 (body 로딩용)
  };

  // Replay 상관관계가 먼저 실행돼서 row의 표시 headers/body가 scan/
  // sitemap/search index가 req에서 pull하기 전에 사용자 수정사항을
  // 반영. 페이지 컨텍스트 fetch는 forbidden name(Cookie, User-Agent,
  // Sec-*)에 대한 헤더 수정을 silently drop하고, HAR entry는 wire-level
  // 결과만 가짐; 이 override가 없으면 Send가 사용자 의도대로 갔어도
  // row는 silently "reverted"로 보임.
  const replayMatch = consumeReplayFireMatch(req.url, req.method);
  if (replayMatch) {
    req._isReplay = true;
    if (replayMatch.displayHeaders) {
      req.requestHeaders = replayMatch.displayHeaders;
    }
    if (replayMatch.displayBody != null && replayMatch.displayBody !== '') {
      req.requestPostData = replayMatch.displayBody;
    }
  }

  // 초기 스캐너 패스 — URL/headers/request body와 response status에
  // 대해 실행. body-side finding은 아래 body 로드 후 2차 패스에서.
  req.scanResults = scanRequest(req);

  // Site Map은 항상 수집
  addToSitemap(req);

  // Network 리스트는 monitoring ON일 때만
  if (!networkMonitoring) return;
  networkRequests.push(req);
  networkRequestMap.set(reqId, req);
  reindexRequestForSearch(req);
  // 탭은 main-host navigation만 따라감 — third-party/CDN/analytics
  // 요청은 자체 탭을 받지 않음(바를 범람시킬 수 있음).
  // detectTargetHost + onNavigated가 브라우저 측 navigation에서 탭
  // 생성을 처리; 여기서 per-request ensureTab을 하면 모든 external
  // resource에 대해 탭을 만들게 됨.
  scheduleAppendNetworkRow(req);

  // source-map 매핑을 eager하게 시도해서 Initiator 컬럼이 사용자가
  // 요청을 클릭하기 전에 최종 "↑ Mapped" 상태를 반영. sourceMapCache
  // (per-script dedup)와 runIdle 스케줄링 덕분에 cheap.
  if (req.initiator && req.initiator.stack && req.initiator.stack.callFrames) {
    runIdle(() => _eagerEnrichInitiator(req));
  }

  // text-like 응답은 body를 eager 로드해서 사용자가 클릭하기 전에
  // 스캐너가 body-side finding을 볼 수 있게. 큐가 동시성 제한;
  // body scan 자체는 idle time에 실행되어 요청 폭주가 paint를
  // 차단하지 않도록.
  if (scanShouldEagerLoadBody(req) && !req.responseBodyLoaded) {
    queueBodyLoad(req, (content, encoding) => {
      if (content == null) return;
      req.responseBody = content;
      req.responseBase64 = encoding === 'base64';
      req.responseBodyLoaded = true;
      runIdle(() => {
        req.scanResults = scanRequest(req);
        updateNetworkRowBadges(req);
        reindexRequestForSearch(req);
        if (selectedRequestId === req.requestId) {
          renderResponsePane(req);
          renderDetection(req);
          applyDetailHighlights(req);
        }
      });
    });
  }
}

// 단일 요청의 검색 인덱스 재빌드, 검색 활성 시 membership/dots/count
// 갱신. 요청 캡처 시점과 body가 늦게 도착하거나 scanResults가 바뀔 때
// 재호출.
function reindexRequestForSearch(req) {
  buildSearchIndex(req);
  if (!searchTerm) return;
  recomputeSearchMatches();
  refreshAllRowDots();
  refreshSearchUI();
}

// 패널이 열리기 전에 Chrome이 이미 캡처한 모든 것에 대해 HAR replay —
// auto-start가 이를 써서 이미 로드된 페이지에 들어온 사용자가 빈
// 테이블 대신 그 요청들을 보게 함.
function replayExistingNetworkHAR() {
  if (!chrome.devtools || !chrome.devtools.network ||
      typeof chrome.devtools.network.getHAR !== 'function') return;
  chrome.devtools.network.getHAR((har) => {
    if (!har || !Array.isArray(har.entries)) return;
    for (const entry of har.entries) {
      processNetworkRequest(entry);
    }
  });
}

function startNetworkMonitoring() {
  networkMonitoring = true;
  const btn = document.getElementById('network-toggle');
  btn.textContent = 'Monitor ON';
  btn.className = 'btn btn-toggle-on';
  document.querySelector('.tab[data-tab="network"]').classList.add('recording');
  safeStorageSet({ networkMonitoring: true });
  // JS Trace는 Monitor에 종속 — Monitor ON 시 자동 시작 + 탭 enable.
  // 사용자가 JS 분석 불필요하면 JS Trace 탭에서 수동 OFF 가능.
  if (window.__jsTraceAPI) {
    window.__jsTraceAPI.setEnabled(true);
    window.__jsTraceAPI.start();
  }
}

function stopNetworkMonitoring() {
  networkMonitoring = false;
  const btn = document.getElementById('network-toggle');
  btn.textContent = 'Monitor OFF';
  btn.className = 'btn btn-toggle-off';
  document.querySelector('.tab[data-tab="network"]').classList.remove('recording');
  safeStorageSet({ networkMonitoring: false });
  // Monitor OFF → JS Trace cascade stop + 탭 disable.
  if (window.__jsTraceAPI) {
    window.__jsTraceAPI.stop();
    window.__jsTraceAPI.setEnabled(false);
  }
}

function clearNetwork() {
  networkRequests.length = 0;
  networkRequestMap.clear();
  _pendingNetworkRows.length = 0;
  if (_networkRenderRaf) { cancelAnimationFrame(_networkRenderRaf); _networkRenderRaf = 0; }
  _ingestedRequestKeys.clear();
  selectedExportIds.clear();
  _lastCheckedReqId = null;
  // 트리는 리스트가 만들어진 데이터를 공유하므로 Clear가 둘 다 wipe.
  Object.keys(sitemapTree).forEach(k => delete sitemapTree[k]);
  expandedNodes.clear();
  _sitemapPending.length = 0;
  // 탭은 캡처 데이터에서 파생 — 함께 wipe해서 바가 orphan host name
  // 행이 아닌 빈 상태를 반영.
  tabHosts.length = 0;
  activeTabHost = null;
  renderNetworkTabs();
  closeDetail();
  renderNetworkTable();
  renderSitemapTree();
  updateSelectionUI();
  // 검색 매치는 드롭하되 검색어는 보존해서 새로 비워진 리스트에 사용자가
  // 같은 검색어로 계속 타이핑 가능하도록.
  searchMatchedIds = [];
  searchCursor = -1;
  refreshSearchUI();
}

// export 메뉴 경로들이 공유하는 JSON 다운로드 헬퍼.
function _downloadJson(filename, data) {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function _downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function _downloadBlobObject(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// items가 이 수치를 초과하면 export를 N개 .json으로 쪼개 단일 .zip으로 묶음.
// (split unit이자 임계값 — "1000 초과 시 1000개씩 분할")
const EXPORT_SPLIT_THRESHOLD = 1000;

// ZIP STORE writer — 무압축·무의존. 압축률 0(용량 동일)이지만 거대 export를
// 열람·재임포트 가능한 1000건 단위 파트로 쪼개 단일 컨테이너로 제공.
// realistic 데이터(수십만 요청 이하)에선 32-bit 필드로 충분 → ZIP64 미사용.
let _crc32Table = null;
function _crc32(bytes) {
  if (!_crc32Table) {
    _crc32Table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      _crc32Table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ _crc32Table[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function _dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

// files: [{ name: string, bytes: Uint8Array }] → Blob(application/zip)
function _buildStoreZip(files) {
  const enc = new TextEncoder();
  const { time: dosTime, date: dosDate } = _dosDateTime(new Date());
  const parts = [];      // local header + name + data 순차
  const central = [];    // central directory records
  let offset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = f.bytes;
    const crc = _crc32(data);
    const size = data.length;

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);   // local file header sig
    lh.setUint16(4, 20, true);           // version needed
    lh.setUint16(6, 0, true);            // flags
    lh.setUint16(8, 0, true);            // method: 0 = STORE
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);        // compressed size
    lh.setUint32(22, size, true);        // uncompressed size
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);           // extra len
    const lhBytes = new Uint8Array(lh.buffer);
    parts.push(lhBytes, nameBytes, data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);   // central dir header sig
    ch.setUint16(4, 20, true);           // version made by
    ch.setUint16(6, 20, true);           // version needed
    ch.setUint16(8, 0, true);            // flags
    ch.setUint16(10, 0, true);           // method
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true);
    ch.setUint32(24, size, true);
    ch.setUint16(28, nameBytes.length, true);
    ch.setUint16(30, 0, true);           // extra len
    ch.setUint16(32, 0, true);           // comment len
    ch.setUint16(34, 0, true);           // disk #
    ch.setUint16(36, 0, true);           // internal attrs
    ch.setUint32(38, 0, true);           // external attrs
    ch.setUint32(42, offset, true);      // local header offset
    central.push(new Uint8Array(ch.buffer), nameBytes);

    offset += 30 + nameBytes.length + size;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) centralSize += c.length;

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);   // EOCD sig
  eocd.setUint16(4, 0, true);            // disk #
  eocd.setUint16(6, 0, true);            // central dir disk
  eocd.setUint16(8, files.length, true); // records this disk
  eocd.setUint16(10, files.length, true);// total records
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, centralStart, true);
  eocd.setUint16(20, 0, true);           // comment len

  return new Blob([...parts, ...central, new Uint8Array(eocd.buffer)],
    { type: 'application/zip' });
}

// 크롤 1회 run 요약 텍스트. startCrawl이 seeds/startedAt,
// stop/completeCrawl이 endedAt을 세팅한 뒤 호출.
function _crawlMetaText() {
  const meta = _exportMetadata();
  const started = crawlState.startedAt;
  const ended = crawlState.endedAt || Date.now();
  const sec = Math.max(0, Math.round((ended - started) / 1000));
  const elapsed = sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const L = [];
  L.push('DevTools++ — crawl run summary');
  L.push('');
  L.push(`exportedAt        : ${meta.exportedAt}`);
  L.push(`extensionVersion  : ${meta.extensionVersion}`);
  L.push(`globalScope       : ${meta.scope || '(none)'}`);
  L.push(`capturedRequests  : ${networkRequests.length}`);
  L.push('');
  L.push('-- crawl run --');
  L.push(`seeds             : ${crawlState.seeds.join(', ')}`);
  L.push(`startedAt         : ${new Date(started).toISOString()}`);
  L.push(`endedAt           : ${new Date(ended).toISOString()}`);
  L.push(`elapsed           : ${elapsed}`);
  L.push(`visitedPages      : ${crawlState.visitedCount}`);
  L.push(`maxDepth          : ${crawlState.maxDepth}`);
  L.push(`maxPages          : ${crawlState.maxPages}`);
  L.push(`perPageWait       : ${crawlState.fastDiscovery ? 'fast (0ms)' : (crawlState.waitMs / 1000) + 's'}`);
  L.push(`fastDiscovery     : ${crawlState.fastDiscovery}`);
  L.push(`scopeCapture      : ${crawlState.scopeCapture}`);
  L.push(`skipAssets        : ${crawlState.skipAssets}`);
  return L.join('\n') + '\n';
}

// 크롤 종료(완료/Stop) 시 run 요약 .txt 자동 저장.
// metaFile ON + 실제 run이 있었을(startedAt) 때만.
function saveCrawlMeta() {
  if (!crawlState.metaFile || crawlState.startedAt == null) return;
  const parts = ['devtoolspp', 'crawl'];
  if (activeTabHost) parts.push(_sanitizeForFilename(activeTabHost));
  parts.push(_exportTimestamp());
  _downloadText(parts.join('-') + '.txt', _crawlMetaText());
}

// 파일명용 timestamp — local time 기준 (UTC가 아닌 사용자 wall clock).
// JSON 안의 metadata.exportedAt은 UTC ISO 그대로 유지 — 머신 파싱 용도.
function _exportTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 파일명 안전 문자열로 변환 — 호스트명에 들어갈 수 있는 ':' / ',' 같은
// 특수문자를 '_'로 치환. 60자로 잘라서 OS 파일명 한도를 안 넘게.
function _sanitizeForFilename(s) {
  return String(s || '').replace(/[^a-zA-Z0-9.-]/g, '_').slice(0, 60);
}

// Export 파일명 빌더. 규칙:
//   devtoolspp-<full|selected>[-<host>][-<N>req]-<timestamp>.json
//
//   scope='tab' + 활성 host 있음 → host 포함
//   selectedOnly=true            → '<N>req' 카운트 포함, 접두사 'selected'
//   selectedOnly=false           → 접두사 'full'
//
// 예시:
//   devtoolspp-full-2026-05-12T11-22-13.json
//   devtoolspp-full-example.com-2026-05-12T11-22-13.json
//   devtoolspp-selected-5req-2026-05-12T11-22-13.json
//   devtoolspp-selected-example.com-5req-2026-05-12T11-22-13.json
function _exportFilename(scope, selectedOnly, count) {
  const parts = ['devtoolspp', selectedOnly ? 'selected' : 'full'];
  if (scope === 'tab' && activeTabHost) {
    parts.push(_sanitizeForFilename(activeTabHost));
  }
  if (selectedOnly) {
    parts.push(count + 'req');
  }
  parts.push(_exportTimestamp());
  return parts.join('-') + '.json';
}

function _exportMetadata() {
  let extensionVersion = '';
  try { extensionVersion = chrome.runtime.getManifest().version; } catch {}
  return {
    exportedAt: new Date().toISOString(),
    extensionVersion,
    targetHost: targetHost || '',
    scope: globalScope.input || '',
  };
}


// 캡처된 모든 요청을 export — full headers, bodies(로드된 경우),
// scan results, initiator. 소스 집합은 scope(current tab / all tabs)와
// selectedOnly(checked 행으로 제한)로 결정.
// 캡처 요청 → export 아이템. headers/body(로드된 경우)/scan/initiator +
// auth 수동상태 + session 귀속(mainHost) 보존.
function _exportItem(r) {
  return {
    request: {
      method: r.method,
      url: r.url,
      status: r.status,
      statusText: r.statusText,
      mimeType: r.mimeType,
      type: r.type,
      size: r.size,
      time: r.time,
      rawSize: r.rawSize ?? null,
      rawTime: r.rawTime ?? null,
    },
    requestHeaders: r.requestHeaders || {},
    requestPostData: r.requestPostData || null,
    responseHeaders: r.responseHeaders || {},
    responseBody: r.responseBody || null,
    responseBodyLoaded: !!r.responseBodyLoaded,
    responseBase64: !!r.responseBase64,
    scanResults: r.scanResults || [],
    initiator: r.initiator || null,
    authMarked: r._authMarked,
    authTestResults: _authTestResults.has(r.requestId)
      ? _authTestResults.get(r.requestId) : null,
    // 사용자 마킹/디스크립션 — 사용자 작업 결과라 export 보존, import 복원.
    userMark: r._userMark === true,
    userNote: r._userNote || null,
    // 임포트 탭 prefix(📥)는 export 시 strip — 라운드트립이 prefix를 누적
    // 안 하게(재임포트 시 _itemToReq가 재부착). 원래 mainHost 보존.
    mainHost: r._mainHost ? r._mainHost.replace(/^📥 /, '') : null,
  };
}

// JS Trace events — Monitor export의 시간 윈도우 매칭용. 전역 데이터라
// 분할/per-host 시 한 곳(part-01)에만 동봉. 0건/미연결이면 null.
function _buildJsTrace() {
  if (window.__jsTraceAPI && typeof window.__jsTraceAPI.getEvents === 'function') {
    const ev = window.__jsTraceAPI.getEvents();
    if (ev.length > 0) {
      return {
        events: ev,
        startedAt: window.__jsTraceAPI.getStartedAt
          ? window.__jsTraceAPI.getStartedAt() : null,
        filterStats: window.__jsTraceAPI.getFilterStats
          ? window.__jsTraceAPI.getFilterStats() : null,
      };
    }
  }
  return null;
}

// items[] → zip에 넣을 파일 배열. ≤threshold면 baseName.json 1개,
// 초과면 baseName-part-NN-of-MM.json 다수. 각 파일 = 독립 임포트 가능
// 봉투(meta + totalRequests + (part) + items). jsTrace는 (있으면)
// 첫 파트에만. compact JSON (zip 내부·다중 파일).
function _splitFiles(items, baseMeta, jsTrace, baseName) {
  const enc = new TextEncoder();
  if (items.length <= EXPORT_SPLIT_THRESHOLD) {
    const payload = Object.assign({}, baseMeta, { totalRequests: items.length, items });
    if (jsTrace) payload.jsTrace = jsTrace;
    return [{ name: baseName + '.json', bytes: enc.encode(JSON.stringify(payload)) }];
  }
  const total = Math.ceil(items.length / EXPORT_SPLIT_THRESHOLD);
  const out = [];
  for (let i = 0; i < total; i++) {
    const chunk = items.slice(i * EXPORT_SPLIT_THRESHOLD, (i + 1) * EXPORT_SPLIT_THRESHOLD);
    const part = Object.assign({}, baseMeta, {
      totalRequests: items.length,
      part: { index: i + 1, total },
      items: chunk,
    });
    if (i === 0 && jsTrace) part.jsTrace = jsTrace;
    const nn = String(i + 1).padStart(2, '0');
    const mm = String(total).padStart(2, '0');
    out.push({ name: `${baseName}-part-${nn}-of-${mm}.json`, bytes: enc.encode(JSON.stringify(part)) });
  }
  return out;
}

// all tabs → 호스트(_mainHost, 없으면 URL host)별로 분리해 단일 .zip(flat).
// 호스트당 ≤1000 → <host>.json, >1000 → <host>-part-NN-of-MM.json.
// jsTrace(전역)는 정렬상 첫 호스트의 part-01에만. 재임포트: 첫 파일
// Overwrite → 나머지 Append (기존 import 모달 그대로).
function exportAllTabsPerHost(source, selectedOnly, baseMeta, jsTrace) {
  if (source.length === 0) {
    _downloadJson(_exportFilename('all', selectedOnly, 0),
      Object.assign({}, baseMeta, { totalRequests: 0, items: [] }));
    return;
  }
  const groups = new Map();
  for (const r of source) {
    const key = r._mainHost || _reqHost(r) || 'unknown-host';
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); }
    g.push(r);
  }
  const hosts = Array.from(groups.keys()).sort();
  const files = [];
  hosts.forEach((host, idx) => {
    const hostItems = groups.get(host).map(_exportItem);
    const jt = idx === 0 ? jsTrace : null;   // 전역 jsTrace는 한 번만
    for (const f of _splitFiles(hostItems, baseMeta, jt, _sanitizeForFilename(host))) {
      files.push(f);
    }
  });
  const zipName = `devtoolspp-alltabs${selectedOnly ? '-sel' : ''}-${_exportTimestamp()}.zip`;
  _downloadBlobObject(zipName, _buildStoreZip(files));
  showToast(`${source.length} requests · ${hosts.length} hosts → ${files.length} files (.zip)`);
}

function exportAllRequests(scope, selectedOnly) {
  const source = _exportSource(scope, selectedOnly);
  const baseMeta = _exportMetadata();
  const jsTrace = _buildJsTrace();

  if (scope === 'all') {
    exportAllTabsPerHost(source, selectedOnly, baseMeta, jsTrace);
    return;
  }

  // ===== current tab — 단일 호스트 뷰, 기존 동작 보존 =====
  const items = source.map(_exportItem);
  if (items.length <= EXPORT_SPLIT_THRESHOLD) {
    // 기존과 동일: 단일 .json (pretty-print, _downloadJson)
    const payload = Object.assign({}, baseMeta, { totalRequests: source.length, items });
    if (jsTrace) payload.jsTrace = jsTrace;
    _downloadJson(_exportFilename(scope, selectedOnly, source.length), payload);
    return;
  }
  // > threshold → 1000건 단위 분할 → 단일 .zip (기존 동작)
  const base = _exportFilename(scope, selectedOnly, source.length).replace(/\.json$/, '');
  const files = _splitFiles(items, baseMeta, jsTrace, base);
  _downloadBlobObject(base + '.zip', _buildStoreZip(files));
  showToast(`${items.length} requests → ${files.length} parts (.zip)`);
}

// ============================================================
// Import — 이전에 export한 JSON을 패널로 다시 로드
// ============================================================
// 우리가 만드는 두 포맷 모두 수용: Detection-only(아이템이 `findings`
// 보유) 또는 All-requests(아이템이 전체 요청 데이터 보유) — 그리고
// 방어적 대안으로 flat `requests` 배열도 fallback.

let _importIdCounter = 0;

function _parseImportJson(text) {
  let data;
  try { data = JSON.parse(text); }
  catch { return { error: 'Invalid file (JSON parse failed)' }; }
  if (!data || typeof data !== 'object') {
    return { error: 'Invalid file' };
  }
  if (!data.exportedAt) {
    return { error: 'Invalid file (missing exportedAt)' };
  }
  const items = Array.isArray(data.items) ? data.items
    : Array.isArray(data.requests) ? data.requests
    : null;
  if (!items) {
    return { error: 'Invalid file (no items / requests array)' };
  }
  return { items, jsTrace: data.jsTrace || null };
}

// 임포트된 아이템 1개를 패널의 나머지와 호환되는 req 객체로 변환.
// wrapped (`{request: {...}, ...}`)와 flat (`{method, url, ...}`) 형태
// 모두 지원; scanResults는 `findings`(Detection 포맷) 또는 `scanResults`
// (All 포맷)에서 가져옴.
// 임포트 탭 prefix — 라이브 캡처 탭과 키 공간이 갈리도록 `📥 ` 붙임.
// 같은 host의 라이브 탭이 동시에 떠 있어도 섞이지 않음. export 시 strip됨
// (_exportItem) — 라운드트립이 prefix를 누적하지 않음.
const IMPORT_TAB_MARK = '📥 ';

function _itemToReq(item) {
  const meta = item.request || item;
  // Session 귀속 — export의 스탬프 우선, URL의 host로 fallback해서
  // legacy export(mainHost 없음)도 가장 자연스러운 탭에 들어가도록.
  let mainHost = item.mainHost || null;
  if (!mainHost) {
    try { mainHost = new URL(meta.url || '').host || null; } catch {}
  }
  // 임포트 탭 격리: prefix 붙여 새 탭 키 생성. 이미 붙어있으면(중복 임포트
  // 케이스) 그대로.
  if (mainHost && !mainHost.startsWith(IMPORT_TAB_MARK)) {
    mainHost = IMPORT_TAB_MARK + mainHost;
  } else if (!mainHost) {
    mainHost = IMPORT_TAB_MARK + 'unknown';
  }
  const req = {
    requestId: 'imp_' + (++_importIdCounter),
    method: meta.method || 'GET',
    url: meta.url || '',
    status: meta.status ?? 0,
    statusText: meta.statusText || '',
    type: meta.type || '-',
    mimeType: meta.mimeType || '',
    size: meta.size || '-',
    time: meta.time || '-',
    rawSize: meta.rawSize ?? null,
    rawTime: meta.rawTime ?? null,
    protocol: meta.protocol || '',
    requestHeaders: item.requestHeaders || meta.requestHeaders || {},
    requestPostData: item.requestPostData ?? meta.requestPostData ?? null,
    responseHeaders: item.responseHeaders || meta.responseHeaders || {},
    responseBody: item.responseBody !== undefined ? item.responseBody : (meta.responseBody ?? null),
    responseBodyLoaded: item.responseBodyLoaded ?? meta.responseBodyLoaded ?? false,
    responseBase64: !!(item.responseBase64 ?? meta.responseBase64),
    initiator: item.initiator || meta.initiator || null,
    scanResults: item.findings || item.scanResults || meta.scanResults || [],
    _mainHost: mainHost,
    _harEntry: null,
    _imported: true,
  };
  // Auth — 수동 마크 / 테스트 결과 복원 (legacy export엔 없음 → undefined로 무해)
  if (item.authMarked === true || item.authMarked === false) {
    req._authMarked = item.authMarked;
  }
  if (item.authTestResults) {
    _authTestResults.set(req.requestId, item.authTestResults);
  }
  // 사용자 마킹/디스크립션 복원 (legacy export엔 없음 → 무해)
  if (item.userMark === true) req._userMark = true;
  if (typeof item.userNote === 'string' && item.userNote) {
    req._userNote = item.userNote;
  }
  return req;
}

function _applyImport(reqs, mode, filename) {
  if (mode === 'overwrite') {
    networkRequests.length = 0;
    networkRequestMap.clear();
    selectedExportIds.clear();
    _lastCheckedReqId = null;
    tabHosts.length = 0;
    activeTabHost = null;
    closeDetail();
    renderNetworkTable();
    updateSelectionUI();
  }
  for (const r of reqs) {
    networkRequests.push(r);
    networkRequestMap.set(r.requestId, r);
    buildSearchIndex(r);
  }
  // 임포트된 _mainHost 값으로 탭 strip 재구성 — 캡처 시점과 동일한
  // per-session navigation을 사용자에게 제공. _mainHost는 export가
  // 보존; 그게 없는 legacy export는 URL host로 fallback(_itemToReq에서
  // 설정), 그래서 flat import도 sensible한 탭을 만들어냄.
  const importedMainHosts = new Set();
  for (const r of reqs) {
    if (r._mainHost) importedMainHosts.add(r._mainHost);
  }
  for (const h of importedMainHosts) ensureTab(h);
  renderNetworkTabs();
  renderNetworkTable();
  updateSelectionUI();
  if (searchTerm) {
    recomputeSearchMatches();
    refreshAllRowDots();
    refreshSearchUI();
  }
  showImportNotice(filename);
  showToast(`Loaded ${reqs.length} request${reqs.length === 1 ? '' : 's'} (${filename})`);
}

function showImportNotice(filename) {
  document.getElementById('network-import-name').textContent = filename;
  document.getElementById('network-import-notice').classList.remove('hidden');
}

function hideImportNotice() {
  document.getElementById('network-import-notice').classList.add('hidden');
}

function importNetworkData(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const result = _parseImportJson(String(reader.result || ''));
    if (result.error) { showToast(result.error); return; }
    const reqs = result.items.map(_itemToReq);
    if (reqs.length === 0) { showToast('No requests in file'); return; }
    // 임포트는 항상 append — _itemToReq가 _mainHost에 `📥 ` prefix를 붙여
    // 라이브 캡처 탭과 키 공간이 자동 격리되므로 충돌이 원천적으로 없음.
    // 기존 overwrite/append/cancel 3-way 모달은 잉여라 제거.
    _applyImport(reqs, 'append', file.name);
    if (result.jsTrace && Array.isArray(result.jsTrace.events)
        && window.__jsTraceAPI && typeof window.__jsTraceAPI.loadEvents === 'function') {
      window.__jsTraceAPI.loadEvents(
        result.jsTrace.events,
        result.jsTrace.startedAt,
        result.jsTrace.filterStats
      );
    }
  };
  reader.onerror = () => showToast('Failed to read file');
  reader.readAsText(file);
}

const _importFileInput = document.getElementById('network-import-file');
document.getElementById('network-import').addEventListener('click', () => {
  _importFileInput.click();
});
_importFileInput.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) importNetworkData(file);
  e.target.value = ''; // 동일 파일 재선택 허용
});
document.getElementById('network-import-notice-close').addEventListener('click', hideImportNotice);

// Export 버튼 드롭다운 — 다운로드 전 scope 선택.
const _exportBtn = document.getElementById('network-export');
const _exportMenu = document.getElementById('network-export-menu');
_exportBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  _exportMenu.classList.toggle('hidden');
});
document.querySelectorAll('.export-menu-item').forEach(item => {
  item.addEventListener('click', () => {
    if (item.disabled) return;
    const scope = item.dataset.scope;            // 'tab' | 'all'
    _exportMenu.classList.add('hidden');
    const selectedOnly = item.dataset.selected === 'true';
    exportAllRequests(scope, selectedOnly);
  });
});

// export 메뉴의 소스셋 picker.
//   scope        : 'tab' (활성 host만) | 'all' (전체 캡처)
//   selectedOnly : true  → 사용자가 체크한 행으로 좁힘
// 전체 networkRequests 배열이 storage; 필터링은 호출 시점에 일어나서
// 데이터가 중복되지 않음.
function _exportSource(scope, selectedOnly) {
  let base;
  if (scope === 'all') {
    base = networkRequests;
  } else {
    // 'tab' — 활성 탭에서 사용자가 보는 그대로. matchesActiveTab을
    // 미러링해서 export가 동일한 session view(direct hits + 그 세션의
    // externals)를 캡처. 아직 활성 탭이 없을 때는 all로 fallback해서
    // 파일이 silently 비지 않도록.
    base = activeTabHost
      ? networkRequests.filter(r => matchesActiveTab(r))
      : networkRequests;
  }
  if (selectedOnly) {
    return base.filter(r => selectedExportIds.has(r.requestId));
  }
  return base;
}
document.addEventListener('click', (e) => {
  if (_exportMenu.classList.contains('hidden')) return;
  if (e.target.closest('.export-dropdown')) return;
  _exportMenu.classList.add('hidden');
});

// ---------- Network 필터 (Type / Status 멀티 선택) ----------
const _filterBtn = document.getElementById('network-filter-btn');
const _filterMenu = document.getElementById('network-filter-menu');
_filterBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  _filterMenu.classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  if (_filterMenu.classList.contains('hidden')) return;
  if (e.target.closest('.network-filter-dropdown')) return;
  _filterMenu.classList.add('hidden');
});

// 메뉴의 체크박스 상태를 networkFilter Set으로 동기화 + 재렌더.
// 메뉴 내부의 모든 변경 시 호출 — 필터링은 즉시 반영되어 체크박스
// 토글이 곧바로 테이블에 적용됨.
function applyNetworkFilterFromUI() {
  networkFilter.types.clear();
  networkFilter.statuses.clear();
  _filterMenu.querySelectorAll('input[data-filter-type]').forEach(cb => {
    if (cb.checked) networkFilter.types.add(cb.dataset.filterType);
  });
  _filterMenu.querySelectorAll('input[data-filter-status]').forEach(cb => {
    if (cb.checked) networkFilter.statuses.add(cb.dataset.filterStatus);
  });
  _refreshFilterButtonLabel();
  renderNetworkTable();
  // selection은 필터 토글 사이에 지속됨(Scope와 동일 모델), 단 master
  // indeterminate 비율은 visible 항목에 따라 달라짐.
  updateSelectionUI();
  // 검색 매치 리스트는 visible 항목과 AND — 필터 변경이 매칭 집합에서
  // 행을 in/out으로 뒤집을 수 있음.
  if (searchTerm) {
    recomputeSearchMatches();
    refreshAllRowDots();
    refreshSearchUI();
  }
}

function _refreshFilterButtonLabel() {
  const total = networkFilter.types.size + networkFilter.statuses.size;
  if (total === 0) {
    _filterBtn.textContent = 'Filter ▾';
    _filterBtn.classList.remove('has-active');
  } else {
    _filterBtn.textContent = `Filter ▾ (${total})`;
    _filterBtn.classList.add('has-active');
  }
}

_filterMenu.querySelectorAll('input[data-filter-type], input[data-filter-status]').forEach(cb => {
  cb.addEventListener('change', applyNetworkFilterFromUI);
});

document.getElementById('network-filter-reset').addEventListener('click', () => {
  _filterMenu.querySelectorAll('input[data-filter-type], input[data-filter-status]').forEach(cb => {
    cb.checked = false;
  });
  applyNetworkFilterFromUI();
});

function fetchResponseBody(req) {
  if (req.responseBodyLoaded) return;
  if (!req._harEntry) return;
  req._harEntry.getContent((body, encoding) => {
    if (body !== undefined && body !== null) {
      req.responseBody = body;
      req.responseBase64 = (encoding === 'base64');
      req.responseBodyLoaded = true;
      reindexRequestForSearch(req);
      if (selectedRequestId === req.requestId) {
        renderResponsePane(req);
        applyDetailHighlights(req);
      }
    }
  });
}

// 동시성 제한 body 로더. DevTools getContent API가 한 번에 수백 번
// 발화되면 좋지 않아서 eager 로드는 작은 동시성 cap으로 큐잉.
// 사용자 발화 fetch는 여전히 fetchResponseBody(큐 없음)로 빠른
// detail 패널 오픈.
const _bodyLoadQueue = [];
let _activeBodyLoads = 0;
const MAX_CONCURRENT_BODY_LOADS = 5;

function queueBodyLoad(req, callback) {
  _bodyLoadQueue.push({ req, callback });
  processBodyLoadQueue();
}

function processBodyLoadQueue() {
  while (_activeBodyLoads < MAX_CONCURRENT_BODY_LOADS && _bodyLoadQueue.length > 0) {
    const { req, callback } = _bodyLoadQueue.shift();
    if (req.responseBodyLoaded) {
      // 큐 대기 중에 사용자 클릭으로 body가 로드됨 — 다른 getContent
      // 호출 없이 캐시된 내용 반환.
      callback(req.responseBody, req.responseBase64 ? 'base64' : null);
      continue;
    }
    if (!req._harEntry) {
      callback(null, null);
      continue;
    }
    _activeBodyLoads++;
    req._harEntry.getContent((content, encoding) => {
      _activeBodyLoads--;
      try { callback(content, encoding); }
      finally { processBodyLoadQueue(); }
    });
  }
}

// idle time에 함수를 실행해서 무거운 스캔이 burst 로드 시 UI를 막지
// 않도록. rIC가 없는 브라우저에서는 setTimeout으로 fallback.
function runIdle(fn) {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(fn, { timeout: 2000 });
  } else {
    setTimeout(fn, 0);
  }
}

// network 테이블의 최대 가시 행 — 오래된 행은 DOM에서 드롭(데이터는
// export와 addressing을 위해 `networkRequests`에 남음). 바쁜 포털
// 사이트에서 천 행이면 렌더러를 녹이지 않고 패턴 식별이 가능.
const MAX_NETWORK_ROWS = 1000;

// Initiator 컬럼 배지 — 각 행의 작은 텍스트 배지로 우리가 가진
// initiator 데이터 종류를 반영. enrichFramesWithSourceMaps 실행 후
// 한 프레임이라도 원본 소스로 매핑되면 배지가 "↑ Mapped"로 업그레이드.
function renderInitiatorBadge(r) {
  // 툴팁은 Initiator detail 탭 안에서 쓰는 동일 설명에서 가져옴 →
  // 컬럼 배지에 hover하면 detail view 안 type 인디케이터와 같은
  // 정보를 보여줌.
  if (r._sourcemapMapped) {
    const t = escapeAttr(INITIATOR_TYPE_DESCRIPTIONS.mapped || '');
    return `<span class="initiator-cell-badge initiator-cell-mapped" title="${t}">↑ Mapped</span>`;
  }
  if (!r.initiator || !r.initiator.type) return '';
  const t = r.initiator.type;
  if (t === 'script') {
    const desc = escapeAttr(INITIATOR_TYPE_DESCRIPTIONS.script || '');
    return `<span class="initiator-cell-badge initiator-cell-script" title="${desc}">script</span>`;
  }
  if (t === 'parser') {
    const desc = escapeAttr(INITIATOR_TYPE_DESCRIPTIONS.parser || '');
    return `<span class="initiator-cell-badge initiator-cell-parser" title="${desc}">parser</span>`;
  }
  return ''; // 'other' / 알 수 없음
}

function updateNetworkRowInitiator(req) {
  const row = networkTable.querySelector(
    `tr[data-request-id="${CSS.escape(req.requestId)}"]`
  );
  if (!row) return;
  const cell = row.querySelector('.initiator-cell');
  if (cell) cell.innerHTML = renderInitiatorBadge(req);
}

// 사용자가 Auth 탭에서 요청을 login으로 mark/unmark 한 뒤 URL 셀만
// 다시 그림. 전체 테이블 재렌더 절약.
function updateNetworkRowAuth(req) {
  const row = networkTable.querySelector(
    `tr[data-request-id="${CSS.escape(req.requestId)}"]`
  );
  if (!row) return;
  const urlCell = row.querySelector('.url-cell');
  if (!urlCell) return;
  const authBadge = _isReqAuth(req)
    ? '<span class="row-auth-badge" title="Detected as login request — see Auth tab">🔐</span> '
    : '';
  const replayBadge = req._isReplay
    ? '<span class="row-replay-badge" title="Sent via Replay">↻</span> '
    : '';
  urlCell.innerHTML = authBadge + replayBadge + escapeHtml(truncateUrl(req.url));
}

// 요청에 대한 단일 <tr>을 DOM 건드리지 않고 빌드. element를 반환해서
// caller가 원하는 대로 append/insert.
// 결합(A) — 명시적 별표(_userMark) 또는 비어있지 않은 노트가 있으면
// 행을 하이라이트. "노트 있으면 무조건 표시"가 이 derived 규칙으로 보장됨
// (노트 지우고 별표도 꺼야 해제).
function _isReqMarked(r) {
  return r._userMark === true || !!(r._userNote && r._userNote.trim());
}

// 단일 행의 mark 배지/하이라이트 클래스 갱신 (trim된 행이면 no-op).
function updateNetworkRowMark(req) {
  const row = networkTable.querySelector(
    `tr[data-request-id="${CSS.escape(req.requestId)}"]`
  );
  if (!row) return;
  const marked = _isReqMarked(req);
  row.classList.toggle('row-marked', marked);
  const badge = row.querySelector('.row-mark-badge');
  if (badge) badge.textContent = marked ? '★' : '☆';
}

function buildNetworkRow(r) {
  const statusClass = r.status >= 400 ? 'status-error'
    : r.status >= 300 ? 'status-redirect'
    : r.status >= 200 ? 'status-ok' : '';
  let host = '';
  try { host = new URL(r.url).host; } catch { /* malformed url */ }
  const hostKindClass = (host && host !== targetHost) ? 'host-cell-external' : 'host-cell-target';
  const tr = document.createElement('tr');
  tr.dataset.requestId = r.requestId;
  if (r.requestId === selectedRequestId) tr.classList.add('selected');
  if (selectedExportIds.has(r.requestId)) tr.classList.add('row-checked');
  if (searchTerm && searchMatchedIds.includes(r.requestId)) tr.classList.add('search-hit');
  if (r._isReplay) tr.classList.add('row-replay');
  const marked = _isReqMarked(r);
  if (marked) tr.classList.add('row-marked');
  const checkedAttr = selectedExportIds.has(r.requestId) ? 'checked' : '';
  // 사용자 마킹 — URL 셀 leading edge의 클릭 가능한 별표. 클릭 시 행
  // 클릭(detail open)과 분리해 _userMark 토글 (.row-select 패턴 동일).
  const markBadge =
    `<span class="row-mark-badge" title="Mark / unmark — highlight in list (Description 탭에서 메모 작성)">${marked ? '★' : '☆'}</span> `;
  // Replay에서 시작한 요청은 URL 셀에 작은 ↻ 배지 prefix를 받아서
  // 타임라인에서 한눈에 구분 가능 — 사용자가 자기 Replay Send에서
  // 온 항목 vs 브라우저 발화 캡처를 알 수 있음.
  const replayBadge = r._isReplay
    ? '<span class="row-replay-badge" title="Sent via Replay">↻</span> '
    : '';
  // Login 감지(또는 수동 마킹) 요청은 작은 🔐 prefix를 받아서 사용자가
  // 모든 행마다 Auth 탭을 열지 않고도 인증 흐름을 식별 가능.
  const authBadge = _isReqAuth(r)
    ? '<span class="row-auth-badge" title="Detected as login request — see Auth tab">🔐</span> '
    : '';
  tr.innerHTML =
    `<td class="select-cell"><input type="checkbox" class="row-select" ${checkedAttr}></td>` +
    `<td class="host-cell ${hostKindClass}" title="${escapeHtml(r.url)}">${escapeHtml(host)}</td>` +
    `<td><strong>${escapeHtml(r.method)}</strong></td>` +
    `<td class="url-cell" title="${escapeHtml(r.url)}">${markBadge}${authBadge}${replayBadge}${escapeHtml(truncateUrl(r.url))}</td>` +
    `<td class="${statusClass}">${r.status}</td>` +
    `<td>${escapeHtml(r.type)}</td>` +
    `<td>${r.size}</td>` +
    `<td>${r.time}</td>` +
    `<td class="initiator-cell">${renderInitiatorBadge(r)}</td>` +
    `<td class="scan-badges-cell">${renderScanBadgesInline(r.scanResults)}</td>`;
  return tr;
}

function updateNetworkCount() {
  // 활성 탭이 사용자의 "세션" 경계 — count는 tab-scope이므로
  // "100 / 271 (filtered)"이 글로벌 3948 풀이 아닌 탭의 271 중 100
  // visible로 읽힘. Scope + Type/Status 필터는 탭 위에 layering된
  // 보조 축.
  const hasTab = activeTabHost != null;
  const hasScope = !!globalScope.regex;
  const hasFilter = networkFilterIsActive();

  let tabTotal = 0; // 활성 탭(또는 탭 없을 때 글로벌)의 총합
  let visible = 0;  // Scope + Type/Status 적용 후
  for (const r of networkRequests) {
    if (hasTab && !matchesActiveTab(r)) continue;
    tabTotal++;
    if (hasScope && !inGlobalScope(r.url)) continue;
    if (hasFilter && !matchesNetworkFilter(r)) continue;
    visible++;
  }

  if (hasScope || hasFilter) {
    networkCount.textContent = visible === tabTotal
      ? `${tabTotal} requests`
      : `${visible} / ${tabTotal} requests (filtered)`;
    return;
  }
  if (tabTotal > MAX_NETWORK_ROWS) {
    networkCount.textContent = `${tabTotal} requests · showing last ${MAX_NETWORK_ROWS}`;
  } else {
    networkCount.textContent = `${tabTotal} requests`;
  }
}

// 테이블이 MAX_NETWORK_ROWS 초과 시 가장 오래된 visible 행 trim.
function enforceMaxNetworkRows() {
  while (networkTable.children.length > MAX_NETWORK_ROWS) {
    networkTable.removeChild(networkTable.firstChild);
  }
}

// 기존 행의 배지 셀 업데이트. 행이 visible window에서 이미 trim된
// 경우 no-op.
function updateNetworkRowBadges(req) {
  const row = networkTable.querySelector(
    `tr[data-request-id="${CSS.escape(req.requestId)}"]`
  );
  if (!row) return;
  const cell = row.querySelector('.scan-badges-cell');
  if (cell) cell.innerHTML = renderScanBadgesInline(req.scanResults);
}

// 전체 재렌더 — clear/startup, 그리고 글로벌 Scope가 바뀔 때마다
// 사용 (Scope도 이제 view 필터). 스트리밍 이벤트는 아래 append/batch
// 경로를 써서 O(n²) rebuild 회피.
function renderNetworkTable() {
  networkTable.innerHTML = '';
  // active-tab + Scope + Type/Status를 view 필터로 적용. 셋 다 순수
  // view 필터 — networkRequests는 그대로라 어떤 것을 토글해도 데이터
  // 손실 없이 reversible.
  const hasTab = activeTabHost != null;
  const hasScope = !!globalScope.regex;
  const hasFilter = networkFilterIsActive();
  let visible = networkRequests;
  if (hasTab || hasScope || hasFilter) {
    visible = networkRequests.filter(r => {
      if (hasTab && !matchesActiveTab(r)) return false;
      if (hasScope && !inGlobalScope(r.url)) return false;
      if (hasFilter && !matchesNetworkFilter(r)) return false;
      return true;
    });
  }
  const fragment = document.createDocumentFragment();
  const start = Math.max(0, visible.length - MAX_NETWORK_ROWS);
  for (let i = start; i < visible.length; i++) {
    fragment.appendChild(buildNetworkRow(visible[i]));
  }
  networkTable.appendChild(fragment);
  updateNetworkCount();
}

// 스트리밍 append: 들어오는 요청을 큐잉해서 animation frame당 한 번
// flush. 포털 사이트의 수백 요청 burst가 수백 개의 별도 layout/paint
// 사이클을 트리거하지 않도록.
const _pendingNetworkRows = [];
let _networkRenderRaf = 0;

function scheduleAppendNetworkRow(req) {
  _pendingNetworkRows.push(req);
  if (_networkRenderRaf) return;
  _networkRenderRaf = requestAnimationFrame(() => {
    _networkRenderRaf = 0;
    flushPendingNetworkRows();
  });
}

function flushPendingNetworkRows() {
  if (_pendingNetworkRows.length === 0) return;
  const hasTab = activeTabHost != null;
  const hasFilter = networkFilterIsActive();
  const fragment = document.createDocumentFragment();
  let appended = 0;
  let countTouchedTabs = false;
  for (const r of _pendingNetworkRows) {
    // 스트리밍 행도 전체 재렌더와 동일한 필터 축(active tab + Scope +
    // Type/Status)을 상속. Scope는 processNetworkRequest 상류에서
    // 이미 enforce되므로 여기서는 tab + filter만 다시 체크. 탭은 바에
    // request count를 표시; 들어오는 행의 host가 탭을 가지고 있으면
    // re-render 마크.
    if (hasTab && !matchesActiveTab(r)) {
      // out-of-tab 행도 비활성 탭의 카운트 배지는 업데이트.
      // 임포트 요청은 URL host 기반 라이브 탭 카운트와 무관(매칭 정책 동일).
      if (!r._imported && tabHosts.includes(_reqHost(r))) countTouchedTabs = true;
      continue;
    }
    if (hasFilter && !matchesNetworkFilter(r)) continue;
    fragment.appendChild(buildNetworkRow(r));
    appended++;
  }
  _pendingNetworkRows.length = 0;
  if (appended > 0) {
    networkTable.appendChild(fragment);
    enforceMaxNetworkRows();
    // 활성 탭 자체에 행이 더 추가됨 — 카운트 갱신.
    countTouchedTabs = true;
  }
  if (countTouchedTabs) renderNetworkTabs();
  updateNetworkCount();
  // 새로 들어온 unchecked 행이 master 상태를 checked → indeterminate로
  // 뒤집을 수 있음.
  if (selectedExportIds.size > 0) updateSelectionUI();
}

// tbody에 클릭 위임 — 로드 시 한 번만 attach해서 새 행마다 자체
// listener가 필요하지 않도록. Initiator 셀 클릭 시 Initiator detail
// 탭으로 바로 점프; row 체크박스 클릭은 detail 패널을 열지 않고
// export 선택만 토글.
networkTable.addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-request-id]');
  if (!row) return;
  const reqId = row.dataset.requestId;
  // Row 체크박스 → export 선택 토글. 여기서 멈춰서 클릭이 detail-open
  // 경로로 떨어지지 않도록.
  if (e.target.matches('input.row-select')) {
    handleRowCheckboxClick(reqId, e.target.checked, e.shiftKey);
    return;
  }
  // 별표 배지 → 명시적 마크 토글. detail-open로 안 떨어지게 여기서 멈춤.
  // 노트가 있으면 _isReqMarked가 여전히 true라 하이라이트 유지(결합 A).
  if (e.target.classList.contains('row-mark-badge')) {
    const mreq = networkRequestMap.get(reqId);
    if (mreq) {
      mreq._userMark = !(mreq._userMark === true);
      updateNetworkRowMark(mreq);
    }
    return;
  }
  // select-cell padding(input 바깥) 클릭은 detail-open이 아닌 no-op로
  // 처리 — 체크박스용 셀을 클릭하면 detail 패널이 열려서 사용자를
  // 놀라게 하지 않도록.
  if (e.target.closest('td.select-cell')) return;
  const wantInitiator = !!e.target.closest('.initiator-cell');
  selectNetworkRequest(reqId, {
    scroll: false,
    activateTab: wantInitiator ? 'initiator' : null,
  });
});

// ============================================================
// export용 멀티 선택
// ============================================================
// `getVisibleRequests`는 렌더된 테이블과 같은 순서로 요청 반환
// (active tab + Scope + Type/Status 필터 적용). select-all, range,
// Cmd+A 등 모든 selection 작업이 이 view를 기준으로 동작 → 사용자가
// 보는 것과 선택하는 것이 일치.
function getVisibleRequests() {
  const hasTab = activeTabHost != null;
  const hasScope = !!globalScope.regex;
  const hasFilter = networkFilterIsActive();
  if (!hasTab && !hasScope && !hasFilter) return networkRequests;
  return networkRequests.filter(r => {
    if (hasTab && !matchesActiveTab(r)) return false;
    if (hasScope && !inGlobalScope(r.url)) return false;
    if (hasFilter && !matchesNetworkFilter(r)) return false;
    return true;
  });
}

function setRowCheckedClass(reqId, checked) {
  const row = networkTable.querySelector(
    `tr[data-request-id="${CSS.escape(reqId)}"]`
  );
  if (!row) return;
  row.classList.toggle('row-checked', checked);
  const cb = row.querySelector('input.row-select');
  if (cb && cb.checked !== checked) cb.checked = checked;
}

function toggleSelection(reqId, checked) {
  if (checked) selectedExportIds.add(reqId);
  else selectedExportIds.delete(reqId);
  setRowCheckedClass(reqId, checked);
}

function handleRowCheckboxClick(reqId, checked, shiftKey) {
  // Shift+click은 이전 체크된 anchor를 visible 범위에 걸쳐 확장.
  // 전체 범위의 새 상태는 방금 클릭된 체크박스의 상태(Gmail/GitHub UX
  // 와 동일).
  if (shiftKey && _lastCheckedReqId && _lastCheckedReqId !== reqId) {
    const visible = getVisibleRequests();
    const i = visible.findIndex(r => r.requestId === _lastCheckedReqId);
    const j = visible.findIndex(r => r.requestId === reqId);
    if (i >= 0 && j >= 0) {
      const [lo, hi] = i < j ? [i, j] : [j, i];
      for (let k = lo; k <= hi; k++) {
        toggleSelection(visible[k].requestId, checked);
      }
    } else {
      toggleSelection(reqId, checked);
    }
  } else {
    toggleSelection(reqId, checked);
  }
  _lastCheckedReqId = reqId;
  updateSelectionUI();
}

// 툴바 카운터, master 체크박스 상태, export 메뉴 아이템을 현재 선택과
// 동기화. selection 변경 후에 호출.
function updateSelectionUI() {
  const count = selectedExportIds.size;
  const wrap = document.getElementById('network-selection');
  const label = document.getElementById('network-selection-count');
  if (wrap && label) {
    wrap.classList.toggle('hidden', count === 0);
    label.textContent = `${count} selected`;
  }
  // Master 체크박스: 모든 visible 행이 선택되면 checked, 일부면
  // indeterminate, 없으면 unchecked.
  const master = document.getElementById('network-select-all');
  if (master) {
    const visible = getVisibleRequests();
    let visibleSelected = 0;
    for (const r of visible) {
      if (selectedExportIds.has(r.requestId)) visibleSelected++;
    }
    if (visible.length === 0 || visibleSelected === 0) {
      master.checked = false;
      master.indeterminate = false;
    } else if (visibleSelected === visible.length) {
      master.checked = true;
      master.indeterminate = false;
    } else {
      master.checked = false;
      master.indeterminate = true;
    }
  }
  // Export 메뉴 — "Selected requests" 항목은 적어도 한 행이 체크된
  // 경우만 활성; 각 항목의 카운트는 매칭 서브셋(current tab vs all)을
  // 반영. Full requests 항목은 항상 작동, 카운트 배지 없음.
  // matchesActiveTab을 사용 — 임포트/라이브 탭 분리 정책과 일관(임포트 요청이
  // 같은 URL host의 라이브 탭 선택 카운트에 새지 않게).
  const tabSelected = activeTabHost
    ? networkRequests.filter(r => matchesActiveTab(r) && selectedExportIds.has(r.requestId)).length
    : count;
  const tabCountEl = document.getElementById('export-tab-selected-count');
  const allCountEl = document.getElementById('export-all-selected-count');
  if (tabCountEl) tabCountEl.textContent = tabSelected ? `(${tabSelected})` : '';
  if (allCountEl) allCountEl.textContent = count ? `(${count})` : '';
  document.querySelectorAll('.export-menu-item[data-selected="true"]').forEach(btn => {
    const scope = btn.dataset.scope;
    btn.disabled = (scope === 'tab' ? tabSelected : count) === 0;
  });
}

function clearExportSelection() {
  if (selectedExportIds.size === 0) return;
  // 각 visible 행에서 class를 제거하는 동안 Set 변형을 피하기 위해
  // 스냅샷.
  const ids = Array.from(selectedExportIds);
  selectedExportIds.clear();
  for (const id of ids) setRowCheckedClass(id, false);
  _lastCheckedReqId = null;
  updateSelectionUI();
}

function selectAllVisible() {
  const visible = getVisibleRequests();
  for (const r of visible) toggleSelection(r.requestId, true);
  updateSelectionUI();
}

function deselectAllVisible() {
  const visible = getVisibleRequests();
  for (const r of visible) toggleSelection(r.requestId, false);
  updateSelectionUI();
}

// Master 체크박스: 모든 visible 행이 선택돼 있으면 전부 deselect,
// 아니면 모두 select. indeterminate 상태는 기본 "select all".
document.getElementById('network-select-all').addEventListener('click', (e) => {
  // post-click 상태로 방향 결정. checked로 끝났으면(또는
  // indeterminate가 checked로 뒤집혔으면) select-all, 아니면 deselect.
  if (e.target.checked) selectAllVisible();
  else deselectAllVisible();
});

document.getElementById('network-selection-clear').addEventListener('click', clearExportSelection);

// Network 탭 활성 시 Cmd/Ctrl+A로 모든 visible 행 선택.
// 사용자가 폼 필드에 타이핑 중이면 skip.
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'a') return;
  const networkSection = document.getElementById('network');
  if (!networkSection || !networkSection.classList.contains('active')) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  e.preventDefault();
  selectAllVisible();
});

// 요청으로 selection 이동, detail 패널 오픈, (옵션으로) 행을 view로
// 스크롤. click 핸들러와 keyboard nav가 공유.
function selectNetworkRequest(reqId, opts) {
  const req = networkRequestMap.get(reqId);
  if (!req) return;
  networkTable.querySelectorAll('tr.selected').forEach(r => r.classList.remove('selected'));
  const row = networkTable.querySelector(`tr[data-request-id="${CSS.escape(reqId)}"]`);
  if (row) {
    row.classList.add('selected');
    if (opts && opts.scroll) row.scrollIntoView({ block: 'nearest' });
  }
  selectedRequestId = reqId;
  networkDetail.classList.remove('hidden');
  networkSplit.classList.add('has-detail');
  showDetail(req);
  if (!req.responseBodyLoaded) fetchResponseBody(req);
  if (opts && opts.activateTab) {
    const tabBtn = document.querySelector(`.detail-tab[data-detail="${opts.activateTab}"]`);
    if (tabBtn) tabBtn.click();
  }
  updateSendToBrowserButton();
}

// Network 탭 활성 시 ↑/↓ 키보드로 요청 리스트 navigation. 브라우저
// 기본 스크롤을 억제해서 키가 선택을 이동하게 함. visible-row set에
// 작동해서 키가 사용자가 실제로 볼 수 있는 범위 안에 머묾 — Tab/
// Scope/Type-Status 필터가 모두 참여하고, "All hosts" 토글이
// 그에 맞게 navigable pool을 뒤집음.
document.addEventListener('keydown', (e) => {
  const networkSection = document.getElementById('network');
  if (!networkSection || !networkSection.classList.contains('active')) return;
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  // 사용자가 폼 필드에 타이핑 중이면 키를 hijack하지 않음.
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  const visible = getVisibleRequests();
  if (visible.length === 0) return;
  e.preventDefault();
  const currentIdx = selectedRequestId
    ? visible.findIndex(r => r.requestId === selectedRequestId)
    : -1;
  let newIdx;
  if (currentIdx < 0) {
    newIdx = e.key === 'ArrowDown' ? 0 : visible.length - 1;
  } else if (e.key === 'ArrowUp') {
    newIdx = Math.max(0, currentIdx - 1);
  } else {
    newIdx = Math.min(visible.length - 1, currentIdx + 1);
  }
  if (newIdx === currentIdx) return;
  selectNetworkRequest(visible[newIdx].requestId, { scroll: true });
});

// ============================================================
// Network 검색 — 요청/응답 detail에 걸친 키워드 매칭
//
// Scope(툴바 URL 필터)가 이미 URL 자체를 커버하지만, 도메인 필터의
// 부수 효과 외에 단어 단위 검색도 필요하므로 URL도 인덱스에 포함.
// 검색 대상:
//   - request headers (key+value)
//   - query string params (key+value, URL.search에서 파싱)
//   - request body (POST data)
//   - response headers (key+value)
//   - response body (text only; base64 body는 skip)
//   - Detection scanResults (evidence + location)
//
// 요청별로 합쳐진 lower-case 인덱스 문자열을 빌드해서 req._searchIndex에
// 캐시 → 매 키스트로크가 모든 필드를 walking하는 대신 indexOf 1회만.
// body가 늦게 도착하거나 scanResults가 바뀌면 인덱스 재빌드.
// ============================================================

let searchTerm = '';
let searchMatchedIds = [];   // requestId, networkRequests 순서
let searchCursor = -1;       // searchMatchedIds 안 인덱스
let _searchDebounceTimer = 0;
const SEARCH_DEBOUNCE_MS = 300;

function buildSearchIndex(req) {
  const parts = [];
  // 요청 헤더
  if (req.requestHeaders) {
    for (const [k, v] of Object.entries(req.requestHeaders)) {
      parts.push(k); parts.push(String(v));
    }
  }
  // 응답 헤더
  if (req.responseHeaders) {
    for (const [k, v] of Object.entries(req.responseHeaders)) {
      parts.push(k); parts.push(String(v));
    }
  }
  // Full URL — Scope가 host/path 기반 필터링을 처리하지만, 검색 박스도
  // URL 자체를 인덱싱해서 path나 query에 있는 키워드가 어떤 다른
  // 필드가 들고 있든 발견되도록.
  parts.push(req.url);
  // Query params (decoded) — searchParams는 URL-decoded 값을 반환하므로
  // "hello world"가 raw URL에 인코딩된 형태("?q=hello%20world")만
  // 있어도 매칭됨.
  try {
    const u = new URL(req.url);
    for (const [k, v] of u.searchParams) {
      parts.push(k); parts.push(v);
    }
  } catch { /* malformed URL */ }
  // 요청 body
  if (req.requestPostData) {
    const body = req.requestPostData.length > AUTODECODE_BODY_LIMIT
      ? req.requestPostData.slice(0, AUTODECODE_BODY_LIMIT)
      : req.requestPostData;
    parts.push(body);
  }
  // Response body — text only, 대용량은 AUTODECODE_BODY_LIMIT으로 clip
  if (req.responseBody && !req.responseBase64) {
    const body = req.responseBody.length > AUTODECODE_BODY_LIMIT
      ? req.responseBody.slice(0, AUTODECODE_BODY_LIMIT)
      : req.responseBody;
    parts.push(body);
  }
  // Detection findings — Detection 탭에 노출
  if (req.scanResults) {
    for (const f of req.scanResults) {
      if (f.evidence) parts.push(String(f.evidence));
      if (f.location) parts.push(String(f.location));
    }
  }
  req._searchIndex = parts.join('\n').toLowerCase();
}

function reqMatchesSearch(req) {
  if (!searchTerm) return true;
  if (!req._searchIndex) return false;
  return req._searchIndex.indexOf(searchTerm) !== -1;
}

// matched-id 리스트를 처음부터 재계산. 검색어 변경 후, Scope 변경 후
// (검색은 Scope와 AND), 그리고 요청을 in/out으로 뒤집을 수 있는 데이터
// 변경 후(clear, import, 늦은 body 로드) 호출.
function recomputeSearchMatches() {
  if (!searchTerm) {
    searchMatchedIds = [];
    searchCursor = -1;
    return;
  }
  const matched = [];
  const hasTab = activeTabHost != null;
  const hasFilter = networkFilterIsActive();
  for (const req of networkRequests) {
    if (hasTab && !matchesActiveTab(req)) continue;
    if (!inGlobalScope(req.url)) continue;
    if (hasFilter && !matchesNetworkFilter(req)) continue;
    if (req._searchIndex == null) buildSearchIndex(req);
    if (reqMatchesSearch(req)) matched.push(req.requestId);
  }
  searchMatchedIds = matched;
  // 같은 요청이 여전히 set 안에 있으면 cursor 보존; 아니면 첫 매치로
  // reset.
  if (selectedRequestId && matched.includes(selectedRequestId)) {
    searchCursor = matched.indexOf(selectedRequestId);
  } else {
    searchCursor = matched.length > 0 ? 0 : -1;
  }
}

function applySearch(rawTerm) {
  const term = (rawTerm || '').toLowerCase().trim();
  searchTerm = term;
  recomputeSearchMatches();
  refreshAllRowDots();
  refreshSearchUI();
  // 첫 매치 자동 오픈 (비어있지 않은 검색어 입력 시에만).
  // 이미 매칭된 selection이 있으면 유지, 아니면 점프.
  if (term && searchMatchedIds.length > 0) {
    const targetId = searchMatchedIds[searchCursor];
    if (targetId !== selectedRequestId) {
      selectNetworkRequest(targetId, { scroll: true });
      return; // selectNetworkRequest -> showDetail가 highlight 처리
    }
  }
  // 현재 선택된 요청의 detail 재렌더 → mark(또는 부재)가 새 검색어를
  // 반영하도록.
  if (selectedRequestId) {
    const req = networkRequestMap.get(selectedRequestId);
    if (req) showDetail(req);
  }
}

function gotoSearchMatch(direction) {
  if (searchMatchedIds.length === 0) return;
  const len = searchMatchedIds.length;
  searchCursor = (searchCursor + direction + len) % len;
  selectNetworkRequest(searchMatchedIds[searchCursor], { scroll: true });
  refreshSearchUI();
}

function refreshSearchUI() {
  const countEl = document.getElementById('network-search-count');
  const prevBtn = document.getElementById('network-search-prev');
  const nextBtn = document.getElementById('network-search-next');
  const clearBtn = document.getElementById('network-search-clear');
  if (!searchTerm) {
    countEl.classList.add('hidden');
    countEl.classList.remove('no-matches');
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    clearBtn.classList.add('hidden');
    return;
  }
  clearBtn.classList.remove('hidden');
  countEl.classList.remove('hidden');
  if (searchMatchedIds.length === 0) {
    countEl.textContent = 'No matches';
    countEl.classList.add('no-matches');
    prevBtn.disabled = true;
    nextBtn.disabled = true;
  } else {
    countEl.textContent = `${searchCursor + 1} / ${searchMatchedIds.length}`;
    countEl.classList.remove('no-matches');
    prevBtn.disabled = false;
    nextBtn.disabled = false;
  }
}

// 모든 visible 행의 .search-hit 클래스 토글로 matched-ids set 미러.
// 전체 재렌더 대비 cheap.
function refreshAllRowDots() {
  const matched = new Set(searchMatchedIds);
  networkTable.querySelectorAll('tr[data-request-id]').forEach(tr => {
    if (matched.has(tr.dataset.requestId)) {
      tr.classList.add('search-hit');
    } else {
      tr.classList.remove('search-hit');
    }
  });
}

// `rootEl` 아래 텍스트 노드 안의 `term` 모든 발생을
// <mark class="network-search-mark">로 wrap. 이미 mark 안의 노드는
// skip(같은 root에 재실행 시 idempotent). 주입된 매치 수 반환.
function highlightMarksIn(rootEl, term) {
  if (!rootEl || !term) return 0;
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentNode;
      if (!p) return NodeFilter.FILTER_REJECT;
      const tag = p.nodeName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
      if (p.classList && p.classList.contains('network-search-mark')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets = [];
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeValue && n.nodeValue.toLowerCase().includes(term)) targets.push(n);
  }
  let count = 0;
  for (const node of targets) {
    const text = node.nodeValue;
    const lower = text.toLowerCase();
    let last = 0;
    let idx;
    const frag = document.createDocumentFragment();
    while ((idx = lower.indexOf(term, last)) !== -1) {
      if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
      const m = document.createElement('mark');
      m.className = 'network-search-mark';
      m.textContent = text.slice(idx, idx + term.length);
      frag.appendChild(m);
      last = idx + term.length;
      count++;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
  return count;
}

// body-level 하이라이트 + 탭 배지 대상 탭. Initiator는 의도적 제외 —
// 내용이 call-stack 프레임이라 키워드 검색에 적합하지 않음.
const SEARCH_TARGET_TABS = ['message', 'detection'];

function applyDetailHighlights(req) {
  // stale mark/배지를 항상 clear → 검색어 비우면 UI도 비도록.
  for (const key of SEARCH_TARGET_TABS) {
    const btn = document.querySelector(`.detail-tab[data-detail="${key}"]`);
    if (btn) btn.classList.remove('has-search-match');
  }
  if (!searchTerm || !req) return;
  let firstMatchTab = null;
  for (const key of SEARCH_TARGET_TABS) {
    const pane = document.getElementById('detail-' + key);
    if (!pane) continue;
    const count = highlightMarksIn(pane, searchTerm);
    if (count > 0) {
      const btn = document.querySelector(`.detail-tab[data-detail="${key}"]`);
      if (btn) btn.classList.add('has-search-match');
      if (!firstMatchTab) firstMatchTab = key;
    }
  }
  // 활성 탭에 매치가 없는데 다른 탭에 있으면 첫 매칭 탭으로 전환 →
  // 사용자가 즉시 결과를 보도록.
  const activeTab = document.querySelector('.detail-tab.active');
  const activeKey = activeTab ? activeTab.dataset.detail : null;
  const activeHasMatch = activeKey
    && document.querySelector(`.detail-tab[data-detail="${activeKey}"].has-search-match`);
  const targetKey = activeHasMatch ? activeKey : firstMatchTab;
  if (targetKey) {
    if (targetKey !== activeKey) {
      document.querySelectorAll('.detail-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.detail-content').forEach(c => c.classList.remove('active'));
      document.querySelector(`.detail-tab[data-detail="${targetKey}"]`).classList.add('active');
      document.getElementById('detail-' + targetKey).classList.add('active');
    }
    // 대상 탭의 첫 매치를 view로 스크롤.
    const pane = document.getElementById('detail-' + targetKey);
    const firstMark = pane && pane.querySelector('mark.network-search-mark');
    if (firstMark) firstMark.scrollIntoView({ block: 'center' });
  }
}

// 검색 input + 버튼 wire up.
(function initNetworkSearch() {
  const input = document.getElementById('network-search');
  const clearBtn = document.getElementById('network-search-clear');
  const prevBtn = document.getElementById('network-search-prev');
  const nextBtn = document.getElementById('network-search-next');
  if (!input) return;
  input.addEventListener('input', () => {
    const value = input.value;
    if (_searchDebounceTimer) clearTimeout(_searchDebounceTimer);
    _searchDebounceTimer = setTimeout(() => {
      _searchDebounceTimer = 0;
      applySearch(value);
    }, SEARCH_DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // pending debounce를 flush해서 Enter가 현재 값에 작동하도록.
      if (_searchDebounceTimer) {
        clearTimeout(_searchDebounceTimer);
        _searchDebounceTimer = 0;
        applySearch(input.value);
      }
      gotoSearchMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      input.value = '';
      applySearch('');
    }
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    applySearch('');
    input.focus();
  });
  prevBtn.addEventListener('click', () => gotoSearchMatch(-1));
  nextBtn.addEventListener('click', () => gotoSearchMatch(1));
})();

// ============================================================
// Network Detail 패널
// ============================================================

function showDetail(req) {
  renderMessageTab(req);
  renderInitiator(req);
  renderDetection(req);
  renderAuth(req);
  renderJsTraceBridge(req);
  renderDescription(req);
  applyDetailHighlights(req);
}

// Description 탭 — 요청별 사용자 메모. 입력 즉시 req에 저장하고,
// 결합(A)상 _isReqMarked가 노트를 보므로 행 하이라이트 자동 반영.
function renderDescription(req) {
  const body = document.getElementById('detail-note-body');
  if (!body) return;
  body.innerHTML =
    '<div class="note-editor">' +
      '<div class="note-label">이 요청에 대한 메모. 메모가 있거나 별표(★)된 요청은 목록에서 하이라이트됩니다.</div>' +
      '<textarea id="detail-note-textarea" class="note-textarea" ' +
        'placeholder="이 요청에 대한 메모를 작성하세요…"></textarea>' +
    '</div>';
  const ta = document.getElementById('detail-note-textarea');
  ta.value = req._userNote || '';
  ta.addEventListener('input', () => {
    req._userNote = ta.value;
    updateNetworkRowMark(req);
  });
}

// JS Trace 카테고리별 안내 — Detection 탭 톤과 동일. JS Context의 카테고리
// 그룹 헤더 클릭 시 카드로 펼침.
const JSTRACE_CATEGORY_DESCRIPTIONS = {
  random:
    `난수 생성 호출입니다.
CSRF 토큰, 세션 ID, 일회성 nonce, UUID 등을 만드는 데 쓰이며,
요청 헤더/바디에 어떤 random 값이 주입됐는지 추적하는 단서가 됩니다.
호출 빈도가 비정상적으로 높거나 직전 호출 결과가 그대로 요청에
실리면 토큰 생성 로직의 진입점입니다.`,

  crypto:
    `Web Crypto API 호출입니다.
encrypt / decrypt / digest / sign / verify / generateKey 등 클라이언트
측 암호화 / 해시 / 서명 처리. 페이로드 인코딩 직전에 발화하면 그 함수가
요청 바디를 가공한 위치이며, key import/export는 키 자체가 클라이언트에
존재한다는 신호 — 분석 표적.`,

  network:
    `fetch / XMLHttpRequest.send / <form>.submit 호출입니다.
Monitor 탭의 캡처 데이터와 같은 통신이지만 "JS가 어디서 어떻게 호출했는가"
관점. Linked 섹션이 ±500ms 정확 매칭이며, 직전·직후 ±2초 안에 잡힌
다른 network 이벤트는 같은 click handler 흐름의 일부일 가능성.`,

  encoding:
    `Base64 / 텍스트 인코딩 변환입니다.
btoa / atob (Base64), TextEncoder.encode / TextDecoder.decode (UTF-8).
요청 직전에 발화한 encoding 호출의 결과를 요청 헤더/바디에서 찾아 비교하면
어떤 raw 값이 인코딩돼서 서버로 전달됐는지 식별 가능 (Bearer 토큰, basic
auth, 커스텀 페이로드 등).`,

  input:
    `<input>.value getter 호출입니다.
JS가 사용자 입력 필드를 읽어가는 시점. 로그인 폼 submit 직전에 password /
id를 읽어 가공·전송하는 흐름이 여기서 잡힙니다. 같은 input을 반복 읽으면
연속 동일값은 dedupe됨 — 진짜 의미 있는 read만 노출.`,

  storage:
    `localStorage / sessionStorage / document.cookie 변경입니다.
세션 토큰 저장, 인증 상태 플래그, 사용자 식별자 캐싱이 주로 일어나는
곳. setItem / removeItem / clear / cookie set 모두 추적.
값이 토큰 형태면 다른 요청의 Authorization 헤더 / 쿠키와 대조하여
어디서 발생해 어디서 사용되는지 흐름 추적.`,
};

// kind 단위 설명 — kind에서 " (capped)" 접미사는 제거 후 매칭.
// 11개 wrapper의 emit kind들을 prefix 매칭으로 커버.
function _jsTraceKindDescription(kind) {
  const k = String(kind || '').replace(/\s*\(capped\)$/, '');
  if (k === 'Math.random')
    return 'JS 내장 PRNG. 암호학적 안전성 없음 (Mersenne Twister 기반). 토큰 생성에 쓰이면 보안 약점 후보.';
  if (k === 'crypto.getRandomValues')
    return '암호학적으로 안전한 난수. UUID v4 / nonce / salt 생성에 정상 사용. 결과 바이트가 base64/hex로 인코딩돼 요청에 실리는 패턴을 추적.';
  if (k.startsWith('crypto.subtle.'))
    return 'Web Crypto SubtleCrypto API. encrypt / decrypt / digest / sign 등 비동기 암호 연산. args에 알고리즘, result에 출력 또는 promise resolved 값.';
  if (k === 'fetch')
    return 'fetch() 호출. args에 method + URL, result에 status code. Monitor 탭에서 동일 요청을 행 단위로 다시 볼 수 있음 (Linked 섹션 자동 매칭).';
  if (k === 'XHR.send')
    return 'XMLHttpRequest.send() 호출. send() 시점에 URL/method/body가 확정됨. 응답 status는 readystate 4 시점에 result에 기록.';
  if (k.startsWith('form.submit'))
    return '<form>.submit() 또는 submit 이벤트. 페이지 navigation을 동반하므로 직후 pagehide → trace stash 발생 (다음 페이지에서 복원).';
  if (k === 'btoa')
    return 'Base64 인코딩. 입력 문자열의 일부를 args에 preview로 보존. Basic auth / 커스텀 인증 헤더 인코딩에 자주 등장.';
  if (k === 'atob')
    return 'Base64 디코딩. 서버에서 받은 인코딩된 값을 클라이언트가 풀어 쓸 때 발화. JWT payload 디코딩 등.';
  if (k === 'TextEncoder.encode')
    return '문자열 → UTF-8 Uint8Array. crypto.subtle.* 입력 직전 또는 fetch body 가공에 사용.';
  if (k === 'TextDecoder.decode')
    return 'Uint8Array → 문자열. crypto.subtle.* 결과 또는 응답 바이너리 해석.';
  if (k === 'input.value get')
    return 'HTMLInputElement.value getter. 페이지 코드가 input 값을 읽는 순간 — 로그인 폼 submit 직전 password 추출 등이 여기로 잡힘. type/마스킹 여부는 args의 outerHTML preview에서 확인.';
  if (/^(local|session)Storage\.setItem$/.test(k))
    return '브라우저 스토리지 쓰기. args[0]은 키, args[1]은 값. 인증 토큰이 여기에 저장되면 XSS 시 직접 탈취 가능 (HttpOnly cookie 대비 노출).';
  if (/^(local|session)Storage\.removeItem$/.test(k))
    return '스토리지 항목 삭제. 로그아웃 / 세션 만료 처리 흔적.';
  if (/^(local|session)Storage\.clear$/.test(k))
    return '스토리지 전체 비움. 로그아웃 시점 단서.';
  if (k === 'document.cookie get')
    return 'document.cookie getter — JS가 쿠키 값을 읽는 시점. HttpOnly가 아닌 쿠키만 노출. 토큰을 cookie에서 읽어 Authorization 헤더로 옮기는 패턴 추적.';
  if (k === 'document.cookie set')
    return 'document.cookie setter — JS가 쿠키를 set/update. args는 "name=value; ..." 형태. expires/path/domain 속성 함께 분석.';
  return null;
}

// JS Trace 브릿지 — Monitor 행 선택 시 해당 요청 시점의 trace 이벤트들을 묶어
// 표시. JS Trace 탭이 비활성/이벤트 없음/매칭 없음 등을 안내. cat별 색상 dot
// 으로 시각화, 이벤트 클릭 시 JS Trace 탭으로 점프.
function renderJsTraceBridge(req) {
  const body = document.getElementById('detail-jstrace-body');
  if (!body) return;
  const traceEvents = (window.__jsTraceAPI && window.__jsTraceAPI.getEvents) ? window.__jsTraceAPI.getEvents() : [];
  const isActive = !!(window.__jsTraceAPI && window.__jsTraceAPI.isActive && window.__jsTraceAPI.isActive());

  if (traceEvents.length === 0) {
    body.innerHTML = `<div class="jstrace-notice">${
      isActive
        ? 'JS Trace is running but no events captured yet. Interact with the page.'
        : 'JS Trace is not running. Open the JS Trace tab and Start Trace to see context for this request.'
    }</div>`;
    return;
  }

  const reqMs = _getRequestStartMs(req);
  if (reqMs === null) {
    body.innerHTML = '<div class="jstrace-notice">This request has no start time (imported data?). Bridge needs live capture.</div>';
    return;
  }

  const linked = findLinkedFetchEvent(req, traceEvents);
  const context = findContextTraceEvents(req, traceEvents, 2000);

  const reqClock = new Date(reqMs).toLocaleTimeString();

  const linkedHtml = linked
    ? `<div class="jstrace-row jstrace-linked" data-seq="${linked.seq}" title="Click to jump to this event in JS Trace tab">
         <span class="cat-dot cat-${linked.cat}"></span>
         <span class="jstrace-kind">${escHtml(linked.kind)}</span>
         <span class="jstrace-args">${escHtml((linked.args || []).join(' · '))}</span>
         <span class="jstrace-t">${_msToOffset(linked.t, reqMs)}</span>
       </div>`
    : '<div class="jstrace-empty">No linked fetch/XHR event (within ±500ms)</div>';

  // Context 이벤트를 카테고리로 그룹화 → Detection 탭과 동일 카드 구조
  // (헤더 + 펼침 description + 이벤트 list). description 카드에는 카테고리
  // 설명 + 이번 그룹에 등장한 kind들의 개별 설명을 같이 노출 (옵션 C).
  let contextHtml;
  if (context.length === 0) {
    contextHtml = '<div class="jstrace-empty">No JS activity within ±2 seconds</div>';
  } else {
    const byCat = {}; // cat → { events: [...], kinds: Map<kindNormalized, originalKind> }
    for (const ev of context) {
      // Network 카테고리는 linked 이벤트 1개로 한정 — 다른 fetch/XHR 호출은
      // 이 Monitor 요청과 무관한 별도 호출이므로 Context에서 제거 (해당 호출은
      // Monitor 자체 행에서 별도 분석). Linked가 없으면 network 카테고리
      // 자체가 안 뜸. 비-네트워크 카테고리는 모두 보존 (이 요청의 원료/부산물).
      if (ev.cat === 'network' && (!linked || ev.seq !== linked.seq)) continue;
      if (!byCat[ev.cat]) byCat[ev.cat] = { events: [], kinds: new Map() };
      byCat[ev.cat].events.push(ev);
      const normalized = String(ev.kind).replace(/\s*\(capped\)$/, '');
      if (!byCat[ev.cat].kinds.has(normalized)) {
        byCat[ev.cat].kinds.set(normalized, ev.kind);
      }
    }
    const catOrder = ['network', 'storage', 'input', 'encoding', 'crypto', 'random'];
    const sortedCats = Object.keys(byCat).sort((a, b) => {
      const ia = catOrder.indexOf(a), ib = catOrder.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    // 필터링 후 모든 그룹이 비면 (모든 컨텍스트가 unlinked network라서 제외됐다면)
    // 빈 안내 메시지로 fallback.
    if (sortedCats.length === 0) {
      contextHtml = '<div class="jstrace-empty">No JS activity within ±2 seconds (unrelated network events filtered out)</div>';
    } else {
      contextHtml = sortedCats.map(cat => {
      const g = byCat[cat];
      const catDesc = JSTRACE_CATEGORY_DESCRIPTIONS[cat] || '';
      // kind별 설명 — 이 그룹에 실제로 등장한 kind만
      const kindLines = Array.from(g.kinds.keys())
        .map(k => {
          const d = _jsTraceKindDescription(k);
          return d ? `<li><b>${escHtml(k)}</b> — ${escHtml(d)}</li>` : `<li><b>${escHtml(k)}</b></li>`;
        })
        .join('');
      const descBlock = (catDesc || kindLines)
        ? `<div class="detection-category-desc hidden">${
            catDesc ? escHtml(catDesc) : ''
          }${kindLines ? `<ul class="jstrace-kind-list">${kindLines}</ul>` : ''}</div>`
        : '';
      const rowsHtml = g.events.map(ev => `
        <div class="jstrace-row ${linked && ev.seq === linked.seq ? 'jstrace-is-linked' : ''}" data-seq="${ev.seq}" title="Click to jump to this event in JS Trace tab">
          <span class="cat-dot cat-${ev.cat}"></span>
          <span class="jstrace-kind">${escHtml(ev.kind)}</span>
          <span class="jstrace-args">${escHtml((ev.args || []).slice(0, 2).join(' · '))}</span>
          <span class="jstrace-t">${_msToOffset(ev.t, reqMs)}</span>
        </div>`).join('');
      return `<div class="detection-group jstrace-cat-group" data-jst-cat="${cat}">
        <div class="detection-group-header">
          <span class="scan-badge scan-badge-jst-${cat}"><span class="cat-dot cat-${cat}"></span> ${escHtml(cat)}</span>
          <span class="detection-group-count">${g.events.length} event${g.events.length === 1 ? '' : 's'}</span>
          ${(catDesc || kindLines) ? '<span class="detection-group-toggle">▾</span>' : ''}
        </div>
        ${descBlock}
        <div class="jstrace-cat-events">${rowsHtml}</div>
      </div>`;
      }).join('');
    }
  }

  body.innerHTML = `
    <div class="jstrace-section">
      <div class="jstrace-section-title">Linked fetch / XHR</div>
      ${linkedHtml}
    </div>
    <div class="jstrace-section">
      <div class="jstrace-section-title">Context (±2s · ${context.length} events · request @ ${reqClock})</div>
      ${contextHtml}
    </div>
  `;

  // Row 클릭 시 JS Trace 탭으로 점프
  body.querySelectorAll('.jstrace-row[data-seq]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const seq = Number(el.dataset.seq);
      jumpToTraceEvent(seq);
    });
  });

  // 카테고리 그룹 헤더 클릭 → description 카드 토글 (Detection과 동일 UX).
  // description 내부 클릭은 텍스트 선택/복사를 위해 무시.
  body.querySelectorAll('.jstrace-cat-group').forEach(group => {
    group.addEventListener('click', (e) => {
      if (e.target.closest('.detection-category-desc')) return;
      if (e.target.closest('.jstrace-row')) return; // row 자체 click은 점프 핸들러 담당
      const desc = group.querySelector('.detection-category-desc');
      if (!desc) return;
      desc.classList.toggle('hidden');
      const toggle = group.querySelector('.detection-group-toggle');
      if (toggle) toggle.textContent = desc.classList.contains('hidden') ? '▾' : '▴';
    });
  });
}

function _msToOffset(eventMs, refMs) {
  const delta = eventMs - refMs;
  const sign = delta >= 0 ? '+' : '−';
  const abs = Math.abs(delta);
  return abs < 1000 ? `${sign}${abs}ms` : `${sign}${(abs / 1000).toFixed(2)}s`;
}

function escHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ============================================================
// Message 탭 — raw HTTP를 렌더링하는 수직 Request/Response split.
// native DevTools 대비 차별점: header-name/value를 테이블로 분리하는
// 대신 on-the-wire 메시지를 그대로 표시(request line + headers + 빈
// 줄 + body, response status line + headers + 빈 줄 + body). Replay
// 편집은 request pane에 textarea overlay로 in-place.
// ============================================================

// 새 탭의 per-request UI 상태. selectedRequestId 기준이라 요청 사이를
// 전환하면 format toggle/replay edit mode가 깨끗한 기본값으로 reset
// (한 행을 바꿨는데 절반 편집된 replay textarea가 남으면 안 됨).
let msgRequestFormat = 'raw';   // 'raw' | 'pretty'
let msgResponseFormat = 'raw';  // 'raw' | 'pretty'
// pane별 Auto Decode 토글 — Raw/Pretty와 독립. 켜지면 raw HTTP 텍스트
// 안의 인코딩된 substring(JWT/Base64/URL-encoded/Unix timestamp/
// nested JSON)이 디코딩된 형태로 교체되며, dotted underline + 옅은
// 노란 tint로 마킹되어 사용자가 디코딩된 콘텐츠 위치를 한눈에 볼 수
// 있음. hover 시 원본 인코딩 값을 보여줌.
let msgRequestDecode = false;
let msgResponseDecode = false;
let msgRequestWrap = false;
let msgResponseWrap = false;
let msgReplayEditing = false;
let msgPreviewMode = 'raw';     // 'raw' | 'preview'
let msgReplayLastResponse = null; // 설정 시 원본 응답 표시를 override

function renderMessageTab(req) {
  // 행 변경 시 per-request UI 상태 reset.
  msgRequestFormat = 'raw';
  msgResponseFormat = 'raw';
  msgRequestDecode = false;
  msgResponseDecode = false;
  msgRequestWrap = false;
  msgResponseWrap = false;
  msgReplayEditing = false;
  msgPreviewMode = 'raw';
  msgReplayLastResponse = null;
  // DOM 토글 reset → active 클래스가 맞춰지도록.
  document.querySelectorAll('.msg-format-toggle .msg-format-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.fmt === 'raw');
  });
  document.querySelectorAll('.msg-decode-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.msg-wrap-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('msg-replay-bar').classList.add('hidden');
  document.getElementById('msg-replay-toggle').classList.remove('active');
  document.getElementById('msg-preview-toggle').classList.remove('active');

  renderRequestPane(req);
  renderResponsePane(req);
}

function renderRequestPane(req) {
  const meta = document.getElementById('msg-request-meta');
  // Method만 — full URL은 아래 raw HTTP body의 request line에 있어서
  // pane 헤더에 중복하면 strip만 부풀고 truncation 강요됨. Title은
  // 여전히 URL을 들고 있어 hover로 빠르게 확인 가능.
  meta.textContent = req.method || '';
  meta.title = req.url || '';

  const bodyEl = document.getElementById('msg-request-body');
  if (msgReplayEditing) {
    // 에디터는 in place 유지 — 텍스트는 이미 enter 핸들러가 채움.
    _toggleDecodeBtn('request', false);
    return;
  }
  const text = buildRawRequest(req, msgRequestFormat);
  const wrapCls = msgRequestWrap ? ' wrap' : '';
  bodyEl.innerHTML = `<pre class="msg-raw${wrapCls}">${_renderRawHtml(text)}</pre>`;
  const hasDecodable = _paneHasDecodable(text);
  _toggleDecodeBtn('request', hasDecodable);
  if (hasDecodable && msgRequestDecode) _applyDecodeMarks(bodyEl);
}

function renderResponsePane(req) {
  const meta = document.getElementById('msg-response-meta');
  const resp = msgReplayLastResponse;
  if (resp) {
    // 활성 replay 결과가 캡처된 응답 표시를 override.
    const sCls = _statusClass(resp.status);
    meta.innerHTML = `<span class="${sCls}">${resp.status} ${escapeHtml(resp.statusText || '')}</span> · ${resp.time} ms · ${formatBytes((resp.body || '').length)}` +
      ` <span style="color:#8a6d00">(replay)</span>`;
  } else {
    const sCls = _statusClass(req.status);
    const size = req.size && req.size !== '-' ? ` · ${req.size}` : '';
    const time = req.time && req.time !== '-' ? ` · ${req.time}` : '';
    meta.innerHTML = `<span class="${sCls}">${req.status || '-'}${req.statusText ? ' ' + escapeHtml(req.statusText) : ''}</span>${time}${size}`;
  }

  const bodyEl = document.getElementById('msg-response-body');
  if (msgPreviewMode === 'preview') {
    _renderResponsePreview(bodyEl, req, resp);
    _toggleDecodeBtn('response', false);
    return;
  }

  // Raw / pretty text 경로 — import/unloaded body/base64를 동일하게
  // 처리해서 replay 결과와 캡처가 같은 코드를 공유.
  const view = resp ? _viewFromReplay(resp) : _viewFromCapture(req);
  if (view.placeholder) {
    bodyEl.innerHTML = `<div class="msg-empty">${escapeHtml(view.placeholder)}</div>`;
    _toggleDecodeBtn('response', false);
    return;
  }
  // response status line의 HTTP version을 request side가 감지한 것과
  // 짝맞춤 — 같은 연결, 같은 wire protocol. Replay 결과는 fetch()로
  // 돌아옴(local proxy로 h1.1)이므로 captured-h2 origin이 없으면 항상
  // 1.1로 렌더.
  const text = buildRawResponse(view, msgResponseFormat, resp ? '1.1' : _detectHttpVersion(req));
  const wrapCls = msgResponseWrap ? ' wrap' : '';
  let html = `<pre class="msg-raw${wrapCls}">${_renderRawHtml(text)}</pre>`;
  // replay 결과의 diff 배지. replay 응답이 있으면 항상 렌더 —
  // _renderReplayDiff가 원본 body가 없는 경우도 처리해서 status/
  // availability 정보가 silently 사라지지 않고 노출되도록.
  if (resp && req) {
    html += _renderReplayDiff(req, resp);
  }
  bodyEl.innerHTML = html;
  const hasDecodable = _paneHasDecodable(text);
  _toggleDecodeBtn('response', hasDecodable);
  if (hasDecodable && msgResponseDecode) _applyDecodeMarks(bodyEl);
}

function _statusClass(s) {
  if (!s) return '';
  if (s >= 200 && s < 300) return 's-2xx';
  if (s >= 300 && s < 400) return 's-3xx';
  if (s >= 400 && s < 500) return 's-4xx';
  if (s >= 500) return 's-5xx';
  return '';
}

// 캡처된 요청을 buildRawResponse가 기대하는 모양으로 wrap.
// 헤더는 HAR resp.headers에서 캡처 시점에 항상 채워지므로 본문 로드 상태와
// 무관하게 항상 렌더. 본문이 아직 안 들어왔거나 (3xx redirect처럼) 비어있는
// 경우는 본문 영역 인라인 노트로만 표시 — 헤더는 그대로 노출 (Location,
// Set-Cookie 등 redirect의 핵심 정보 가시화).
function _viewFromCapture(req) {
  if (req.responseBase64) {
    return {
      status: req.status, statusText: req.statusText, headers: req.responseHeaders || {},
      body: `[Base64 encoded data — ${formatBytes((req.responseBody || '').length)} encoded]`,
      _bin: true,
    };
  }
  let body = req.responseBody || '';
  if (!req.responseBodyLoaded) {
    if (req._imported) body = '[Body not included in imported file]';
    else if (req.status >= 300 && req.status < 400) body = '[No body — redirect]';
    else body = '[Loading response body…]';
  }
  return {
    status: req.status, statusText: req.statusText,
    headers: req.responseHeaders || {},
    body,
  };
}

function _viewFromReplay(resp) {
  return {
    status: resp.status, statusText: resp.statusText,
    headers: resp.headers || {}, body: resp.body || '',
  };
}

// 캡처된 요청이 HTTP/2로 전달됐는지 감지 — h2 pseudo-headers
// (`:authority`, `:method`, `:path`, `:scheme`) 검사. h2 연결에서만
// 존재하므로 그 존재가 authoritative. 렌더된 request/status line에
// 표시할 version 문자열 반환.
function _detectHttpVersion(req) {
  const headers = (req && req.requestHeaders) || {};
  for (const k of Object.keys(headers)) {
    if (k.startsWith(':')) return '2';
  }
  return '1.1';
}

// raw HTTP request 문자열 빌드. path/query는 URL에서 가져와서 request
// line이 wire에 나간 그대로와 일치. 캡처된 헤더에 Host가 없으면 URL
// 에서 파생(브라우저는 항상 보냄). Body는 requestPostData에서 그대로.
function buildRawRequest(req, format) {
  const method = req.method || 'GET';
  let path = '/';
  let host = '';
  try {
    const u = new URL(req.url);
    path = (u.pathname || '/') + (u.search || '');
    host = u.host;
  } catch { /* fallback */ }

  const headers = req.requestHeaders || {};
  const httpVersion = _detectHttpVersion(req);
  const lines = [`${method} ${path} HTTP/${httpVersion}`];
  // Host가 없으면 합성 — 읽는 입장에서 raw HTTP line에 있을 거라 기대.
  // h2의 등가물은 :authority라 이중 렌더 안 함.
  if (host && !_findHeaderCI(headers, 'host') && httpVersion !== '2') {
    lines.push(`Host: ${host}`);
  }
  for (const [k, v] of Object.entries(headers)) {
    // h2 pseudo-headers는 이미 request line에 인코딩되어 있음 — 렌더된
    // 헤더 목록에서 드롭해서 "GET / HTTP/2"와 함께 ":method: GET"이
    // 중복/오인되지 않도록.
    if (k.startsWith(':')) continue;
    lines.push(`${k}: ${v}`);
  }
  const body = req.requestPostData || '';
  return lines.join('\n') + '\n\n' + (format === 'pretty' ? _prettyBody(body, headers) : body);
}

// view 객체에서 raw HTTP response 문자열 빌드 (캡처와 replay 결과
// 모두 {status, headers, body}를 공유하므로 양쪽 다 작동). httpVersion
// 은 caller가 공급 — request side와 짝맞춰서 request/response status
// line이 일관되도록.
function buildRawResponse(view, format, httpVersion) {
  const status = view.status || 0;
  const statusText = view.statusText || '';
  const headers = view.headers || {};
  const ver = httpVersion || '1.1';
  const lines = [`HTTP/${ver} ${status}${statusText ? ' ' + statusText : ''}`];
  for (const [k, v] of Object.entries(headers)) {
    if (k.startsWith(':')) continue;
    lines.push(`${k}: ${v}`);
  }
  const body = view.body || '';
  if (view._bin) return lines.join('\n') + '\n\n' + body; // 바이너리 placeholder 문자열
  return lines.join('\n') + '\n\n' + (format === 'pretty' ? _prettyBody(body, headers) : body);
}

// 빌드된 raw HTTP 메시지 문자열을 토큰화해서 request/status line은
// 파랑, 헤더 이름은 red-bold인 HTML로. 첫 줄(request의 request line,
// response의 status line)은 distinct하게 색칠; 이후 첫 빈 줄까지의
// 줄은 "Header-Name: value" 쌍. 빈 줄 이후는 body 콘텐츠를 그대로
// 렌더.
function _renderRawHtml(text) {
  if (!text) return '';
  const blankIdx = text.indexOf('\n\n');
  const headerPart = blankIdx >= 0 ? text.slice(0, blankIdx) : text;
  const body = blankIdx >= 0 ? text.slice(blankIdx + 2) : '';
  const lines = headerPart.split('\n');
  const out = [];
  if (lines.length > 0) {
    out.push(`<span class="msg-line-status">${escapeHtml(lines[0])}</span>`);
  }
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const colon = line.indexOf(':');
    if (colon < 0) {
      out.push(escapeHtml(line));
    } else {
      const name = line.slice(0, colon);
      const rest = line.slice(colon); // ':' + value 포함
      out.push(`<span class="msg-header-name">${escapeHtml(name)}</span>${escapeHtml(rest)}`);
    }
  }
  // 헤더와 body 사이 빈 구분 줄, 이후 body 그대로.
  return out.join('\n') + '\n\n' + (body ? escapeHtml(body) : '');
}

// ---- Auto Decode (인라인 치환) ----
// plain-text 스니펫 안의 모든 인코딩된 substring 위치 + 파싱된 finding
// 반환. 우선순위: JWT > URL-encoded > Base64. 겹치는 매치는 필터링 —
// earliest non-overlapping 승리 (우선순위 중요: 그 순서로 스캔하고
// start 위치로 dedupe).
function _scanEncodedPositions(text) {
  if (!text || typeof text !== 'string') return [];
  const results = [];
  let m;

  // 1. JWT — 3-segment, header와 payload 모두 eyJ로 시작
  const jwtRe = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
  while ((m = jwtRe.exec(text)) !== null) {
    const f = detectJWT(m[0]);
    if (f) results.push({ start: m.index, end: m.index + m[0].length, finding: f });
  }
  // 2. URL-encoded — 2+ %XX 연속 (주변에 url-safe 문자)
  const urlRe = /[A-Za-z0-9~._!*'()\-+]*(?:%[0-9A-Fa-f]{2}[A-Za-z0-9~._!*'()\-+]*){2,}/g;
  while ((m = urlRe.exec(text)) !== null) {
    const f = detectUrlEncoded(m[0]);
    if (f) results.push({ start: m.index, end: m.index + m[0].length, finding: f });
  }
  // 3. Base64 — 넓은 모양, detectBase64로 검증 (출력 가능성 +
  //    길이 + padding 정렬).
  const b64Re = /[A-Za-z0-9+/]{16,}={0,2}/g;
  while ((m = b64Re.exec(text)) !== null) {
    const f = detectBase64(m[0]);
    if (f) results.push({ start: m.index, end: m.index + m[0].length, finding: f });
  }

  // 겹침 해결 (stable sort + skip으로 earlier scan order 승리).
  results.sort((a, b) => a.start - b.start);
  const filtered = [];
  let lastEnd = -1;
  for (const r of results) {
    if (r.start >= lastEnd) {
      filtered.push(r);
      lastEnd = r.end;
    }
  }
  return filtered;
}

// 인라인 치환을 위한 compact, single-line 표시 문자열.
// multi-line 디코딩 값은 raw HTTP 들여쓰기를 깨뜨릴 수 있으므로
// JSON 값은 compact serialization 사용. 원본은 wrapping span의
// `title` 속성에 보존.
function _decodedDisplay(finding) {
  switch (finding.type) {
    case 'jwt': {
      const h = JSON.stringify(finding.header || {});
      const p = JSON.stringify(finding.payload || {});
      return `JWT: ${h} • ${p}`;
    }
    case 'urlenc': return finding.decoded;
    case 'base64': return finding.decoded;
    case 'nested-json': return JSON.stringify(finding.parsed);
    case 'timestamp': return finding.date;
    default: return '?';
  }
}

// `rootEl` 안의 텍스트 노드를 walk하면서 인코딩된 substring을
// 디코딩된 형태를 담은 styled span으로 교체. 원본 인코딩 텍스트는
// span의 title 속성으로 이동 → 사용자가 hover로 무엇이 디코딩됐는지
// 확인 가능.
function _applyDecodeMarks(rootEl) {
  if (!rootEl) return;
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.textContent;
    const positions = _scanEncodedPositions(text);
    if (positions.length === 0) continue;
    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const p of positions) {
      if (p.start > cursor) {
        frag.appendChild(document.createTextNode(text.slice(cursor, p.start)));
      }
      const span = document.createElement('span');
      span.className = 'decode-replaced';
      span.dataset.decodeType = p.finding.type;
      span.title = `${p.finding.label} — original: ${text.slice(p.start, p.end)}`;
      span.textContent = _decodedDisplay(p.finding);
      frag.appendChild(span);
      cursor = p.end;
    }
    if (cursor < text.length) {
      frag.appendChild(document.createTextNode(text.slice(cursor)));
    }
    node.parentNode.replaceChild(frag, node);
  }
}

// raw pane 텍스트에 Decode 토글이 rewrite 가능한 인코딩된 substring이
// 최소 하나 있으면 true. Decode 버튼 가시성 게이트에 사용 → 디코드할
// 게 있을 때만 버튼이 나타남.
function _paneHasDecodable(text) {
  if (!text) return false;
  return _scanEncodedPositions(text).length > 0;
}

// 주어진 pane의 Decode 버튼을 show/hide. 숨길 때는 active 상태와
// 동반 플래그를 reset해서 다시 토글할 때 이전 요청의 stale "active"
// 상태를 상속하지 않도록.
function _toggleDecodeBtn(pane, show) {
  const btn = document.querySelector(`.msg-decode-btn[data-pane="${pane}"]`);
  if (!btn) return;
  btn.classList.toggle('hidden', !show);
  if (!show) {
    btn.classList.remove('active');
    if (pane === 'request') msgRequestDecode = false;
    else msgResponseDecode = false;
  }
}

function _findHeaderCI(headers, name) {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return null;
}

// Content-Type이 포맷을 분명히 할 때 body를 pretty-print.
// JSON은 2 space 들여쓰기. 그 외에는 그대로 — parser 없이 부분 XML/HTML
// pretty-print는 mangle되기 쉽고, 사용자는 언제든 Raw로 돌릴 수 있음.
function _prettyBody(body, headers) {
  if (!body || typeof body !== 'string') return body;
  const ct = (_findHeaderCI(headers, 'content-type') || '').toLowerCase();
  if (ct.includes('json') || (body.trimStart().startsWith('{') || body.trimStart().startsWith('['))) {
    try { return JSON.stringify(JSON.parse(body), null, 2); }
    catch { /* 유효 JSON 아님 — fall through */ }
  }
  return body;
}

// response pane의 Preview 버튼. raw 텍스트와 응답 mime type에 가장
// 유용한 렌더 형태를 토글.
function _renderResponsePreview(bodyEl, req, replayResp) {
  const view = replayResp ? _viewFromReplay(replayResp) : _viewFromCapture(req);
  if (view.placeholder) {
    bodyEl.innerHTML = `<div class="msg-empty">${escapeHtml(view.placeholder)}</div>`;
    return;
  }
  const mime = (replayResp ? (_findHeaderCI(view.headers, 'content-type') || '') : (req.mimeType || ''))
    .toLowerCase();
  const body = view.body || '';

  if (mime.includes('html') || mime.includes('xhtml')) {
    bodyEl.innerHTML = `<iframe class="msg-preview-iframe" sandbox srcdoc="${escapeAttr(body)}"></iframe>`;
    return;
  }
  if (mime.startsWith('image/')) {
    const isBase64 = !replayResp && req.responseBase64;
    const src = isBase64 ? `data:${mime};base64,${body}` : `data:${mime};base64,${btoa(body)}`;
    bodyEl.innerHTML = `<div class="msg-preview-image"><img src="${escapeAttr(src)}" alt=""></div>`;
    return;
  }
  // JSON tree
  if (mime.includes('json') || body.trim().startsWith('{') || body.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(body);
      bodyEl.innerHTML = `<div class="msg-preview-tree">${renderJsonTree(parsed)}</div>`;
      return;
    } catch { /* fall through */ }
  }
  // 유용한 preview 없음 — raw + 안내 표시.
  showToast('No preview available for this content type');
  msgPreviewMode = 'raw';
  document.getElementById('msg-preview-toggle').classList.remove('active');
  renderResponsePane(req);
}

// Format 토글 (Raw / Pretty) — 위임. 클릭이 떨어진 쪽만 토글하고
// 다른 쪽은 현재 모드 유지.
document.querySelectorAll('.msg-format-toggle').forEach(group => {
  const side = group.dataset.pane; // 'request' | 'response'
  group.querySelectorAll('.msg-format-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      group.querySelectorAll('.msg-format-btn').forEach(b => {
        b.classList.toggle('active', b === btn);
      });
      const fmt = btn.dataset.fmt;
      if (side === 'request') {
        msgRequestFormat = fmt;
        // replay edit 모드에서는 재렌더 안 함 — textarea 내용은
        // 사용자 소유라 format 토글로 reset되면 안 됨.
        if (!msgReplayEditing) {
          const req = networkRequestMap.get(selectedRequestId);
          if (req) renderRequestPane(req);
        }
      } else {
        msgResponseFormat = fmt;
        const req = networkRequestMap.get(selectedRequestId);
        if (req) renderResponsePane(req);
      }
    });
  });
});

// Decode 토글 — Raw/Pretty와 독립. 활성 시 pane의 raw 텍스트의
// 인코딩된 substring이 인라인으로 교체됨 (pane renderer에서 호출되는
// _applyDecodeMarks가 처리). 활성화 시 첫 디코딩된 span을 view로
// 스크롤 → 사용자가 결과를 보도록.
document.querySelectorAll('.msg-decode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const side = btn.dataset.pane;
    const next = !btn.classList.contains('active');
    btn.classList.toggle('active', next);
    if (side === 'request') {
      msgRequestDecode = next;
      if (!msgReplayEditing) {
        const req = networkRequestMap.get(selectedRequestId);
        if (req) renderRequestPane(req);
      }
    } else {
      msgResponseDecode = next;
      const req = networkRequestMap.get(selectedRequestId);
      if (req) renderResponsePane(req);
    }
    if (next) {
      const paneId = side === 'request' ? 'msg-request-body' : 'msg-response-body';
      const first = document.getElementById(paneId).querySelector('.decode-replaced');
      if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  });
});

// Wrap 토글 — pane의 <pre>에서 white-space: pre ↔ pre-wrap 뒤집기.
// per-pane 상태로 살며, 같은 요청 선택 내에서 format/decode 토글 후
// 에도 보존.
document.querySelectorAll('.msg-wrap-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const side = btn.dataset.pane;
    const next = !btn.classList.contains('active');
    btn.classList.toggle('active', next);
    if (side === 'request') {
      msgRequestWrap = next;
      if (!msgReplayEditing) {
        const req = networkRequestMap.get(selectedRequestId);
        if (req) renderRequestPane(req);
      }
    } else {
      msgResponseWrap = next;
      const req = networkRequestMap.get(selectedRequestId);
      if (req) renderResponsePane(req);
    }
  });
});

// Replay 버튼 — request pane을 raw 뷰와 편집 가능한 textarea 사이에서
// 토글. 한 번 누르면 edit 모드 진입 + textarea를 현재 raw request로
// 시드; 다시 누르면 취소.
document.getElementById('msg-replay-toggle').addEventListener('click', () => {
  if (msgReplayEditing) {
    _exitReplayEdit();
    return;
  }
  const req = networkRequestMap.get(selectedRequestId);
  if (!req) return;
  _enterReplayEdit(req);
});

// replay edit 모드가 열릴 때 찍은 캡처 요청의 method/URL/headers/body
// 스냅샷 — free-form raw text의 string 비교에 의존하지 않고
// Original/Modified 상태 배지를 드라이브.
let msgReplayOriginalSnapshot = null;

function _enterReplayEdit(req) {
  msgReplayEditing = true;
  msgReplayOriginalSnapshot = _captureReplaySnapshot(req);
  _renderReplayEditor(msgReplayOriginalSnapshot);
  document.getElementById('msg-replay-bar').classList.remove('hidden');
  document.getElementById('msg-replay-toggle').classList.add('active');
  _refreshReplayState();
  updateSendToBrowserButton();
}

// 스냅샷에서 에디터의 DOM을 렌더(또는 재렌더). 초기 진입 시와
// 사용자가 Original/Modified 버튼으로 시드를 복원할 때 호출.
// setupReplayEditorListeners의 이벤트 위임이 탭 클릭 / + Add Header
// / KV row 제거 / input 추적을 커버하므로 재렌더로 listener가
// 누적되지 않음.
function _renderReplayEditor(snap) {
  const bodyEl = document.getElementById('msg-request-body');
  bodyEl.innerHTML = `
    <div class="replay-editor">
      <div class="replay-editor-topbar">
        <select id="msg-replay-method"></select>
        <input type="text" id="msg-replay-url" class="replay-editor-url" spellcheck="false">
        <input type="text" id="msg-replay-version" class="replay-editor-version" spellcheck="false"
          value="HTTP/1.1"
          title="HTTP version on the request line. Editable for security testing — note that fetch() actually sends as HTTP/1.1 or whatever the server negotiates, so this is cosmetic on the wire.">
      </div>
      <div class="replay-editor-tabs">
        <button class="replay-editor-tab active" data-rtab="headers">Headers</button>
        <button class="replay-editor-tab" data-rtab="body">Body</button>
      </div>
      <div class="replay-editor-pane active" id="msg-replay-pane-headers">
        <div class="replay-editor-toolbar">
          <button id="msg-replay-add-header" class="btn btn-xs">+ Add Header</button>
        </div>
        <div id="msg-replay-headers-list" class="replay-kv-list"></div>
      </div>
      <div class="replay-editor-pane" id="msg-replay-pane-body">
        <div class="replay-body-toolbar">
          <div class="replay-body-format-toggle">
            <button class="replay-body-fmt-btn" data-bfmt="form">Form</button>
            <button class="replay-body-fmt-btn" data-bfmt="raw">Raw</button>
          </div>
          <button id="msg-replay-add-field" class="btn btn-xs">+ Add Field</button>
        </div>
        <div id="msg-replay-body-form" class="replay-kv-list replay-body-form"></div>
        <textarea id="msg-replay-body-input" class="replay-body-editor" spellcheck="false" placeholder="Request body..."></textarea>
      </div>
    </div>
  `;
  const methodSel = document.getElementById('msg-replay-method');
  methodSel.innerHTML = ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']
    .map(m => `<option ${m === snap.method ? 'selected' : ''}>${m}</option>`).join('');
  document.getElementById('msg-replay-url').value = snap.url;
  document.getElementById('msg-replay-version').value = snap.version || 'HTTP/1.1';
  const list = document.getElementById('msg-replay-headers-list');
  for (const { name, value } of snap.headers) {
    _addReplayKvRow(list, name, value, true);
  }
  document.getElementById('msg-replay-body-input').value = snap.body;
  // 시드된 body 모양에 따라 초기 body view 결정. Form view는
  // x-www-form-urlencoded 페이로드에만 유용 — JSON이나 multipart body는
  // 사용자를 놀라게 하지 않도록 raw 유지.
  const formCapable = _replayBodyLooksFormEncoded(snap);
  _setReplayBodyView(formCapable ? 'form' : 'raw', { populate: true, formCapable });
}

// body가 form-urlencoded처럼 보일 때 true — Content-Type 헤더 또는
// body 문자열 휴리스틱 둘 중 하나. Body pane을 Form 뷰로 기본 설정할지,
// 그리고 Form/Raw 토글을 제공할지 결정.
function _replayBodyLooksFormEncoded(snap) {
  const ct = (snap.headers || [])
    .find(h => h.name.toLowerCase() === 'content-type');
  if (ct && /application\/x-www-form-urlencoded/i.test(ct.value)) return true;
  // Content-Type이 없을 때의 휴리스틱: body에 최소 1개 `=`, JSON 마커
  // 없음, 선두 angle bracket 없음, 명백한 raw text 아님.
  const body = (snap.body || '').trim();
  if (!body) return false;
  if (body.startsWith('{') || body.startsWith('[')) return false;
  if (body.startsWith('<')) return false;
  if (!body.includes('=')) return false;
  // prose처럼 보이면(공백/단어 많음) reject.
  if (/\s{2,}/.test(body)) return false;
  return true;
}

// body pane을 Form과 Raw 뷰 사이에서 전환. 기저 body 내용을
// 동기화 유지 — Form ↔ Raw 변환은 토글 시점에 일어나므로 한 뷰의
// 편집이 전환 시 다른 뷰에서 보임.
function _setReplayBodyView(view, opts) {
  opts = opts || {};
  const formContainer = document.getElementById('msg-replay-body-form');
  const ta = document.getElementById('msg-replay-body-input');
  const addBtn = document.getElementById('msg-replay-add-field');
  const toggle = document.querySelector('.replay-body-format-toggle');
  if (!formContainer || !ta || !toggle) return;
  // body가 form 모양이 아니면 Form 버튼을 완전히 숨김 — 표현 불가능한
  // 뷰를 제공할 의미 없음.
  if (opts.formCapable === false) {
    toggle.classList.add('hidden');
  }
  if (view === 'form' && opts.formCapable === false) view = 'raw';

  if (opts.populate && view === 'form') {
    // textarea 값에서 초기 population
    formContainer.innerHTML = '';
    const fields = _parseFormUrlencodedFields(ta.value || '');
    if (fields.length === 0) {
      _addReplayBodyField(formContainer, '', '', true);
    } else {
      for (const f of fields) _addReplayBodyField(formContainer, f.name, f.value, true);
    }
  } else if (!opts.populate) {
    // 토글: 이전 활성 뷰에서 새 뷰로 변환.
    if (view === 'raw') {
      // Form → Raw: 현재 필드를 textarea로 인코드.
      ta.value = _encodeReplayBodyForm(formContainer);
    } else {
      // Raw → Form: textarea를 KV 행으로 파싱.
      formContainer.innerHTML = '';
      const fields = _parseFormUrlencodedFields(ta.value || '');
      if (fields.length === 0) {
        _addReplayBodyField(formContainer, '', '', true);
      } else {
        for (const f of fields) _addReplayBodyField(formContainer, f.name, f.value, true);
      }
    }
  }

  // 가시성 적용
  if (view === 'form') {
    formContainer.classList.remove('hidden');
    if (addBtn) addBtn.classList.remove('hidden');
    ta.classList.add('hidden');
  } else {
    formContainer.classList.add('hidden');
    if (addBtn) addBtn.classList.add('hidden');
    ta.classList.remove('hidden');
  }
  toggle.querySelectorAll('.replay-body-fmt-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.bfmt === view);
  });
  // editor element에 활성 뷰 추적 → read(Send) 시점에 어느 pane이
  // source of truth인지 알 수 있도록.
  const editor = document.querySelector('.replay-editor');
  if (editor) editor.dataset.bodyView = view;
}

function _addReplayBodyField(container, name, value, enabled) {
  const row = document.createElement('div');
  row.className = 'replay-kv-row replay-body-field' + (enabled ? '' : ' disabled');
  row.innerHTML = `
    <input type="checkbox" class="kv-toggle"${enabled ? ' checked' : ''}>
    <input type="text" class="kv-name" value="${escapeAttr(name)}" placeholder="Name">
    <input type="text" class="kv-value" value="${escapeAttr(value)}" placeholder="Value">
    <button class="kv-remove" title="Remove">&times;</button>
  `;
  container.appendChild(row);
}

// form-view 행을 application/x-www-form-urlencoded로 다시 인코드
// (Send 페이로드 + Raw 토글 round-trip용). 공백은 `+` 사용 —
// application/x-www-form-urlencoded 관행; encodeURIComponent는 %20을
// 내보내는데 캡처된 request body와 round-trip이 달라짐.
function _encodeReplayBodyForm(container) {
  const parts = [];
  container.querySelectorAll('.replay-kv-row').forEach(row => {
    const enabled = row.querySelector('.kv-toggle').checked;
    if (!enabled) return;
    const name = row.querySelector('.kv-name').value;
    const value = row.querySelector('.kv-value').value;
    if (!name) return;
    parts.push(_formUrlEncode(name) + '=' + _formUrlEncode(value));
  });
  return parts.join('&');
}

function _formUrlEncode(s) {
  return encodeURIComponent(String(s)).replace(/%20/g, '+');
}

// form-encoded body의 시맨틱 동등성 — 사용자가 건드리지 않은 form
// 필드가 약간 다른 byte 형태로 re-encode되는 경우(예: + vs %20, 빈
// 필드의 trailing = 누락)를 커버. 한쪽 body가 파싱에 실패하면 "not
// equal"이라 보고 string 비교가 Modified 상태를 드라이브하게 둠.
function _replayBodiesFormEqual(a, b) {
  if (a == null || b == null) return false;
  const fa = _parseFormUrlencodedFields(a);
  const fb = _parseFormUrlencodedFields(b);
  if (fa.length === 0 && fb.length === 0) return false;
  if (fa.length !== fb.length) return false;
  for (let i = 0; i < fa.length; i++) {
    if (fa[i].name !== fb[i].name) return false;
    if (fa[i].value !== fb[i].value) return false;
  }
  return true;
}

// 스크립트 init 시 한 번만 attach — 모든 replay editor 상호작용을
// 위임으로 처리해서 에디터 재렌더(Original 복원용) 시 listener
// 재바인딩이 필요 없고 누적 위험도 없음.
function _setupReplayEditorListeners() {
  const bodyEl = document.getElementById('msg-request-body');
  if (!bodyEl) return;
  bodyEl.addEventListener('click', (e) => {
    if (!msgReplayEditing) return;
    // 탭 전환
    const tab = e.target.closest('.replay-editor-tab');
    if (tab) {
      bodyEl.querySelectorAll('.replay-editor-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      bodyEl.querySelectorAll('.replay-editor-pane').forEach(p => p.classList.remove('active'));
      const pane = document.getElementById('msg-replay-pane-' + tab.dataset.rtab);
      if (pane) pane.classList.add('active');
      return;
    }
    // Body Form/Raw 포맷 토글
    const fmtBtn = e.target.closest('.replay-body-fmt-btn');
    if (fmtBtn) {
      _setReplayBodyView(fmtBtn.dataset.bfmt);
      _refreshReplayState();
      return;
    }
    // + Add Header
    if (e.target.id === 'msg-replay-add-header') {
      const list = document.getElementById('msg-replay-headers-list');
      _addReplayKvRow(list, '', '', true);
      _refreshReplayState();
      return;
    }
    // + Add Field (body form view)
    if (e.target.id === 'msg-replay-add-field') {
      const list = document.getElementById('msg-replay-body-form');
      _addReplayBodyField(list, '', '', true);
      _refreshReplayState();
      return;
    }
    // KV 제거
    const removeBtn = e.target.closest('.kv-remove');
    if (removeBtn) {
      const row = removeBtn.closest('.replay-kv-row');
      if (row) { row.remove(); _refreshReplayState(); }
      return;
    }
  });
  // Edit 추적 — 에디터 내부의 input/change가 Modified 상태 재계산.
  // KV 체크박스 토글의 change 이벤트도 여기로 bubble.
  // 사용자가 row의 name을 다시 입력할 때(예: 새 row 추가 후 "Cookie"
  // 입력) forbidden-header 잠금도 재평가.
  bodyEl.addEventListener('input', (e) => {
    if (!msgReplayEditing) return;
    if (e.target.classList && e.target.classList.contains('kv-name')) {
      const row = e.target.closest('.replay-kv-row');
      if (row) _applyForbiddenLock(row);
    }
    _refreshReplayState();
  });
  bodyEl.addEventListener('change', (e) => {
    if (!msgReplayEditing) return;
    const toggle = e.target.closest('.kv-toggle');
    if (toggle) {
      const row = toggle.closest('.replay-kv-row');
      if (row) row.classList.toggle('disabled', !toggle.checked);
    }
    _refreshReplayState();
  });
}
_setupReplayEditorListeners();

function _exitReplayEdit() {
  msgReplayEditing = false;
  msgReplayOriginalSnapshot = null;
  document.getElementById('msg-replay-bar').classList.add('hidden');
  document.getElementById('msg-replay-toggle').classList.remove('active');
  const req = networkRequestMap.get(selectedRequestId);
  if (req) renderRequestPane(req);
  updateSendToBrowserButton();
}

// 요청의 편집 가능 상태를 에디터의 read/write 모양과 동일하게 캡처 →
// Modified 감지가 stringy diff가 아닌 구조적 비교가 되도록.
function _captureReplaySnapshot(req) {
  const headers = [];
  const captured = req.requestHeaders || {};
  for (const [k, v] of Object.entries(captured)) {
    if (k.startsWith(':')) continue;
    headers.push({ name: k, value: Array.isArray(v) ? v.join(', ') : String(v) });
  }
  return {
    method: req.method || 'GET',
    url: req.url || '',
    // replay editor는 wire 상에서 HTTP/1.1 only(fetch 동작)지만,
    // 입력은 편집 가능 — 사용자가 의도된 but unsendable 변형을 기록
    // 하려는 보안 테스트 시나리오를 위해.
    version: 'HTTP/1.1',
    headers,
    body: req.requestPostData || '',
  };
}

function _readReplayEditor() {
  const list = document.getElementById('msg-replay-headers-list');
  if (!list) return null;
  const headers = [];
  list.querySelectorAll('.replay-kv-row').forEach(row => {
    const enabled = row.querySelector('.kv-toggle').checked;
    if (!enabled) return;
    const name = row.querySelector('.kv-name').value.trim();
    const value = row.querySelector('.kv-value').value;
    if (name) headers.push({ name, value });
  });
  // body는 현재 활성 뷰에서 read. Form view는 매 read마다 rows를
  // re-encode → 사용자가 어느 surface에서 편집했든 항상 같은
  // 페이로드를 보게 됨.
  const editor = document.querySelector('.replay-editor');
  const view = (editor && editor.dataset.bodyView) || 'raw';
  let body;
  if (view === 'form') {
    body = _encodeReplayBodyForm(document.getElementById('msg-replay-body-form'));
  } else {
    body = document.getElementById('msg-replay-body-input').value;
  }
  return {
    method: document.getElementById('msg-replay-method').value,
    url: document.getElementById('msg-replay-url').value,
    version: document.getElementById('msg-replay-version').value,
    headers,
    body,
  };
}

// 페이지 컨텍스트에서 fetch()가 silently drop하는 헤더 — 무엇을
// 입력하든 브라우저가 자체 값으로 채움. per-row 체크용으로 lowercase
// 리스트; prefix 패밀리(Sec-, Proxy-, Access-Control-)는 아래에서
// 별도 인식.
const _FORBIDDEN_REPLAY_HEADERS = new Set([
  'accept-charset', 'accept-encoding',
  'connection', 'content-length',
  'cookie', 'cookie2',
  'date', 'dnt',
  'expect', 'host',
  'keep-alive', 'origin',
  'referer', 'te', 'trailer',
  'transfer-encoding', 'upgrade',
  'user-agent', 'via',
  'permissions-policy',
]);

function _isForbiddenReplayHeader(name) {
  if (!name) return false;
  const lower = String(name).trim().toLowerCase();
  if (!lower) return false;
  if (_FORBIDDEN_REPLAY_HEADERS.has(lower)) return true;
  if (lower.startsWith('sec-')) return true;
  if (lower.startsWith('proxy-')) return true;
  if (lower.startsWith('access-control-')) return true;
  return false;
}

// KV row의 현재 name에 따라 forbidden lock 스타일링을 적용/해제.
// 행 빌드 시점과 사용자가 name을 다시 입력할 때 input 위임 핸들러
// 양쪽에서 호출.
function _applyForbiddenLock(row) {
  const nameEl = row.querySelector('.kv-name');
  const valueEl = row.querySelector('.kv-value');
  const toggle = row.querySelector('.kv-toggle');
  if (!nameEl || !valueEl) return;
  const forbidden = _isForbiddenReplayHeader(nameEl.value);
  row.classList.toggle('kv-forbidden', forbidden);
  valueEl.readOnly = forbidden;
  if (toggle) toggle.disabled = forbidden;
  const tip = forbidden
    ? 'Browser-managed header — fetch() silently drops edits to this name and sends the browser default. Use Intercept Forward Modified for wire-level tampering.'
    : '';
  valueEl.title = tip;
  nameEl.title = tip;
}

// KV row는 순수 DOM — toggle/remove/forbidden-lock은
// _setupReplayEditorListeners의 이벤트 위임이 처리.
function _addReplayKvRow(list, name, value, enabled) {
  const row = document.createElement('div');
  row.className = 'replay-kv-row' + (enabled ? '' : ' disabled');
  row.innerHTML = `
    <input type="checkbox" class="kv-toggle"${enabled ? ' checked' : ''}>
    <input type="text" class="kv-name" value="${escapeAttr(name)}" placeholder="Name">
    <input type="text" class="kv-value" value="${escapeAttr(value)}" placeholder="Value">
    <button class="kv-remove" title="Remove">&times;</button>
  `;
  list.appendChild(row);
  _applyForbiddenLock(row);
}

function _refreshReplayState() {
  const stateBtn = document.getElementById('msg-replay-state');
  if (!stateBtn || !msgReplayOriginalSnapshot) return;
  const cur = _readReplayEditor();
  if (!cur) return;
  const isModified = !_replaySnapshotEqual(cur, msgReplayOriginalSnapshot);
  stateBtn.textContent = isModified ? 'Modified' : 'Original';
  stateBtn.classList.toggle('modified', isModified);
}

function _replaySnapshotEqual(a, b) {
  if (a.method !== b.method) return false;
  if (a.url !== b.url) return false;
  if (a.version !== b.version) return false;
  if (a.headers.length !== b.headers.length) return false;
  for (let i = 0; i < a.headers.length; i++) {
    if (a.headers[i].name !== b.headers[i].name) return false;
    if (a.headers[i].value !== b.headers[i].value) return false;
  }
  // Body: byte-equal 먼저, 그 다음 시맨틱 form-encoded 비교 →
  // Form-view를 통한 round-trip이 Modified로 false-positive 안 되도록.
  if (a.body === b.body) return true;
  if (_replayBodiesFormEqual(a.body, b.body)) return true;
  return false;
}

// Original/Modified 버튼 — 모든 에디터 필드를 스냅샷으로 복원.
document.getElementById('msg-replay-state').addEventListener('click', () => {
  if (!msgReplayOriginalSnapshot) return;
  _renderReplayEditor(msgReplayOriginalSnapshot);
  _refreshReplayState();
});

// Send 버튼 — 에디터 상태 read, fetch payload 빌드, inspectedWindow.eval
// 로 발화(page context이므로 쿠키가 자연스럽게 attach), 결과 polling,
// response pane 업데이트.
document.getElementById('msg-replay-send').addEventListener('click', () => {
  const cur = _readReplayEditor();
  if (!cur) return;
  const req = networkRequestMap.get(selectedRequestId);
  if (!req) return;
  // 사용자가 path/query만 편집할 수 있도록 캡처 origin에 대해 URL 해결.
  let resolvedUrl;
  try { resolvedUrl = new URL(cur.url, req.url).href; } catch { resolvedUrl = cur.url; }
  // 사용자가 입력한 전체 set — row override에 공급해서 fetch가 wire
  // 상에서 silently drop하는 헤더라도 캡처된 항목이 편집된 그대로
  // 보이도록.
  const displayHeaders = {};
  for (const { name, value } of cur.headers) displayHeaders[name] = value;
  // wire 허용 subset — fetch()가 실제로 보낼 시도를 할 헤더.
  const fetchHeaders = {};
  for (const { name, value } of cur.headers) {
    // fetch()는 이걸 거부 — 브라우저가 자체 설정.
    if (/^(host|content-length)$/i.test(name)) continue;
    fetchHeaders[name] = value;
  }
  _sendReplayFetch(req, {
    method: cur.method,
    url: resolvedUrl,
    headers: fetchHeaders,
    body: cur.body || null,
    displayHeaders,
    displayBody: cur.body || '',
  });
});

// Replay-fire 큐 — 최근 (url, method) 튜플 + 사용자가 의도한 요청
// 모양의 short-TTL 리스트. network 캡처 파이프라인이 매칭되는
// 들어오는 요청을 "_isReplay"로 태그하고 row의 headers/body 표시를
// 사용자가 실제로 입력한 것으로 override 가능. 페이지 컨텍스트 fetch는
// forbidden 헤더 수정(Cookie/User-Agent/Origin/Sec-*/Referer/DNT 등)
// 을 silently drop하고 브라우저 기본값으로 교체 — 따라서 HAR만으로는
// wire 뷰만 보고되어 사용자 의도와 일치하지 않음. stash된
// `displayHeaders`/`displayBody`가 row에 faithful한 뷰를 제공 →
// origin 서버에 tag 헤더로 오염시키지 않고.
const _replayFireQueue = [];
const _REPLAY_FIRE_TTL_MS = 10000;

function _markReplayFired(url, method, display) {
  const now = Date.now();
  // 기회적으로 만료 항목 제거 — 큐를 작게 유지.
  for (let i = _replayFireQueue.length - 1; i >= 0; i--) {
    if (now - _replayFireQueue[i].t > _REPLAY_FIRE_TTL_MS) {
      _replayFireQueue.splice(i, 1);
    }
  }
  _replayFireQueue.push({
    url, method, t: now,
    displayHeaders: (display && display.headers) || null,
    displayBody: (display && 'body' in display) ? display.body : null,
  });
}

// processNetworkRequest에서 호출. 매칭된 fire-queue 항목
// (displayHeaders/displayBody 포함)을 반환하고 제거, 매치 없으면 null.
// URL 매치는 정확(우리가 page-side fetch에 준 것과 같은 문자열로 설정).
function consumeReplayFireMatch(url, method) {
  const now = Date.now();
  for (let i = 0; i < _replayFireQueue.length; i++) {
    const e = _replayFireQueue[i];
    if (now - e.t > _REPLAY_FIRE_TTL_MS) continue;
    if (e.url === url && e.method === method) {
      _replayFireQueue.splice(i, 1);
      return e;
    }
  }
  return null;
}

// Auth test fire 큐 — Auth 탭의 "Test: empty/wrong password" 버튼이
// Replay와 마찬가지로 inspectedWindow.eval로 변종 fetch를 발화하는데,
// 이것들은 *내부 probe*라서 사용자의 Monitor 타임라인에 나타나면 안
// 됨. processNetworkRequest가 networkRequests에 요청을 추가하기 전에
// 이 큐를 체크; 매치되면 캡처가 완전히 드롭(row 없음, scan 없음,
// sitemap 항목 없음).
const _authTestFireQueue = [];
const _AUTH_TEST_FIRE_TTL_MS = 10000;

function _markAuthTestFired(url, method) {
  const now = Date.now();
  for (let i = _authTestFireQueue.length - 1; i >= 0; i--) {
    if (now - _authTestFireQueue[i].t > _AUTH_TEST_FIRE_TTL_MS) {
      _authTestFireQueue.splice(i, 1);
    }
  }
  _authTestFireQueue.push({ url, method, t: now });
}

function consumeAuthTestFireMatch(url, method) {
  const now = Date.now();
  for (let i = 0; i < _authTestFireQueue.length; i++) {
    const e = _authTestFireQueue[i];
    if (now - e.t > _AUTH_TEST_FIRE_TTL_MS) continue;
    if (e.url === url && e.method === method) {
      _authTestFireQueue.splice(i, 1);
      return true;
    }
  }
  return false;
}

// 파싱된 replay 요청을 inspected 페이지의 컨텍스트로 발화.
// 예전 executeReplay가 쓰던 polling 패턴 미러링.
function _sendReplayFetch(originalReq, payload) {
  const sendBtn = document.getElementById('msg-replay-send');
  sendBtn.textContent = 'Sending...';
  sendBtn.disabled = true;
  // 이 발화를 태그 → 결과적으로 onRequestFinished가 캡처된 row를
  // replay로 마크하고 표시 headers/body를 사용자가 실제 입력한 것으로
  // override 가능 (page-context fetch는 헤더 수정 일부를 silently drop).
  _markReplayFired(payload.url, payload.method, {
    headers: payload.displayHeaders || payload.headers,
    body: 'displayBody' in payload ? payload.displayBody : payload.body,
  });

  const callbackId = '__replay_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const expr = `(function() {
    window['${callbackId}'] = null;
    var t0 = performance.now();
    fetch(${JSON.stringify(payload.url)}, {
      method: ${JSON.stringify(payload.method)},
      headers: ${JSON.stringify(payload.headers)},
      body: ${payload.body != null ? JSON.stringify(payload.body) : 'null'},
      credentials: 'include',
      redirect: 'follow'
    }).then(function(resp) {
      var elapsed = Math.round(performance.now() - t0);
      var h = {};
      resp.headers.forEach(function(v, k) { h[k] = v; });
      return resp.text().then(function(text) {
        window['${callbackId}'] = JSON.stringify({
          ok: true, status: resp.status, statusText: resp.statusText,
          headers: h, body: text, time: elapsed
        });
      });
    }).catch(function(e) {
      var elapsed = Math.round(performance.now() - t0);
      window['${callbackId}'] = JSON.stringify({
        ok: false, error: e.message, time: elapsed
      });
    });
    return 'started';
  })()`;

  chrome.devtools.inspectedWindow.eval(expr, (_, err) => {
    if (err) {
      sendBtn.textContent = 'Send';
      sendBtn.disabled = false;
      showToast('Replay failed to start: ' + (err.value || JSON.stringify(err)));
      return;
    }
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      if (attempts > 300) {
        clearInterval(poll);
        sendBtn.textContent = 'Send';
        sendBtn.disabled = false;
        chrome.devtools.inspectedWindow.eval(`delete window['${callbackId}']`);
        showToast('Replay timed out (30s)');
        return;
      }
      chrome.devtools.inspectedWindow.eval(`window['${callbackId}']`, (raw) => {
        if (raw == null) return;
        clearInterval(poll);
        sendBtn.textContent = 'Send';
        sendBtn.disabled = false;
        chrome.devtools.inspectedWindow.eval(`delete window['${callbackId}']`);
        let parsed;
        try { parsed = JSON.parse(raw); } catch { showToast('Replay result parse failed'); return; }
        if (!parsed.ok) {
          // page-context fetch 실패 — 보통 ACAO 헤더 없는 cross-origin
          // 자산의 CORS. background-service-worker fetch로 fallback
          // (host_permissions: <all_urls>, page-level CORS 게이트
          // 없음). 쿠키는 credentials:'include'로 SameSite=Lax/None
          // 호스트에 여전히 따라 감.
          _sendReplayFetchViaBackground(originalReq, payload, parsed.error);
          return;
        }
        msgReplayLastResponse = parsed;
        renderResponsePane(originalReq);
      });
    }, 100);
  });
}

// page-context fetch가 에러(보통 CORS)일 때 사용하는 background-fetch
// fallback. 기본 실행 안 함 — page 경로가 실제로 실패한 후에만 →
// 페이지의 session 컨텍스트가 도달 가능할 때 우선.
function _sendReplayFetchViaBackground(originalReq, payload, pageError) {
  const sendBtn = document.getElementById('msg-replay-send');
  sendBtn.textContent = 'Sending (CORS fallback)...';
  sendBtn.disabled = true;
  chrome.runtime.sendMessage({
    type: 'replay_fetch',
    url: payload.url,
    method: payload.method,
    headers: payload.headers,
    body: payload.body,
  }, (resp) => {
    sendBtn.textContent = 'Send';
    sendBtn.disabled = false;
    if (chrome.runtime.lastError) {
      showToast(`Replay error: ${pageError || 'page fetch failed'} (background also failed: ${chrome.runtime.lastError.message})`);
      return;
    }
    if (!resp || !resp.ok) {
      showToast(`Replay error: ${pageError || 'page fetch failed'} (background also failed${resp && resp.error ? ': ' + resp.error : ''})`);
      return;
    }
    msgReplayLastResponse = {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
      body: resp.body,
      time: resp.time,
    };
    showToast('Replay via background (CORS bypass)');
    renderResponsePane(originalReq);
  });
}

// Preview 버튼 — response pane을 raw 텍스트와 렌더된 preview(HTML
// iframe/이미지/JSON tree) 사이에서 토글.
document.getElementById('msg-preview-toggle').addEventListener('click', () => {
  msgPreviewMode = msgPreviewMode === 'raw' ? 'preview' : 'raw';
  document.getElementById('msg-preview-toggle').classList.toggle('active', msgPreviewMode === 'preview');
  const req = networkRequestMap.get(selectedRequestId);
  if (req) renderResponsePane(req);
});

// 캡처된 원본 vs replay 응답의 diff 결과 HTML. Status와 Body 섹션을
// 항상 렌더 → 사용자가 어떤 차원이 변했는지/안 변했는지 한눈에 파악.
// silent 누락 섹션이 혼란을 유발했음(body 매치라서 status 변경이 숨김,
// JSON 포매팅 차이만 있으면 아무것도 안 보임, 비-JSON 차이가 안
// 보임 등).
function _renderReplayDiff(originalReq, replayResp) {
  const sections = [];

  // ---- Status 섹션 ----
  const oStatus = originalReq.status;
  const nStatus = replayResp.status;
  if (oStatus != null && nStatus != null) {
    if (oStatus !== nStatus) {
      sections.push(
        `<div class="diff-title">Status changed: ` +
        `<span class="${_statusClass(oStatus)}">${oStatus}</span> → ` +
        `<span class="${_statusClass(nStatus)}">${nStatus}</span></div>`
      );
    } else {
      sections.push(
        `<div class="diff-title diff-unchanged">Status unchanged ` +
        `(<span class="${_statusClass(oStatus)}">${oStatus}</span>)</div>`
      );
    }
  }

  // ---- Body 섹션 ----
  const bodyAvailable = originalReq.responseBodyLoaded && originalReq.responseBody != null;
  if (!bodyAvailable) {
    sections.push(
      `<div class="diff-title diff-unavailable">` +
      `Original response body not available — cannot diff body</div>`
    );
  } else {
    const oBody = originalReq.responseBody;
    const nBody = replayResp.body || '';
    if (oBody === nBody) {
      sections.push(`<div class="msg-diff-identical">Response body identical to original</div>`);
    } else {
      // JSON diff 시도. 둘 다 파싱되고 구조가 일치하면 text-level
      // 불일치는 공백/key-order 차이일 뿐 — silence로 fall through하지
      // 말고 명시적으로 노출.
      let handled = false;
      try {
        const origObj = JSON.parse(oBody);
        const newObj = JSON.parse(nBody);
        const diffHtml = generateJsonDiff(origObj, newObj);
        if (diffHtml) {
          sections.push(`<div class="diff-title">Body changes:</div>${diffHtml}`);
        } else {
          sections.push(
            `<div class="msg-diff-identical">` +
            `Response body identical (JSON structure unchanged; text formatting differs)</div>`
          );
        }
        handled = true;
      } catch { /* JSON 아님 — 아래에서 처리 */ }
      if (!handled) {
        // 다른 비-JSON body — size-delta 줄 표시 → 사용자가 적어도
        // 변경된 사실과 변경량을 알 수 있도록.
        sections.push(
          `<div class="diff-title">Body differs ` +
          `(${oBody.length} → ${nBody.length} bytes)</div>`
        );
      }
    }
  }

  return `<div class="msg-diff-badge">${sections.join('')}</div>`;
}


function headerRowsHtml(headers, extraClass) {
  const cls = extraClass || '';
  return Object.entries(headers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) =>
      `<div class="header-row ${cls}">
        <span class="header-name">${escapeHtml(name)}</span>
        <span class="header-value">${escapeHtml(value)}</span>
      </div>`
    ).join('');
}


// ============================================================
// Initiator — Call stack trace + 민감 패턴 감지
// ============================================================

const SENSITIVE_PATTERNS = [
  { pattern: /otp|mfa|2fa|totp/i, label: 'OTP/MFA' },
  { pattern: /auth|login|signin|signout|logout|session/i, label: 'Authentication' },
  { pattern: /token|jwt|bearer/i, label: 'Token' },
  { pattern: /valid|verif|check/i, label: 'Validation' },
  { pattern: /admin|role|permission|privilege|access/i, label: 'Authorization' },
  { pattern: /encrypt|decrypt|hash|sign|cipher|crypto/i, label: 'Crypto' },
  { pattern: /password|passwd|secret|credential/i, label: 'Credential' },
  { pattern: /upload|file|download/i, label: 'File Operation' },
  { pattern: /redirect|navigate|location\.href/i, label: 'Navigation' },
  { pattern: /pay|price|amount|billing|checkout/i, label: 'Payment' },
];

// Initiator 탭의 findings 리스트에 노출될 때 각 민감 패턴이 갖는
// severity 등급. Detection 탭이 카테고리에 매기는 방식 미러링 —
// auth/credential/비즈니스 로직은 HIGH, 서버에서 흔히 강제되는 것
// (validation, navigation, crypto algorithm)은 MEDIUM.
const SENSITIVE_PATTERN_SEVERITY = {
  'OTP/MFA': 'high',
  'Authentication': 'high',
  'Token': 'high',
  'Validation': 'medium',
  'Authorization': 'high',
  'Crypto': 'medium',
  'Credential': 'high',
  'File Operation': 'high',
  'Navigation': 'medium',
  'Payment': 'high',
};

// Initiator 탭 상단 Type 인디케이터의 호버 툴팁 텍스트. initiator.type
// 키, source-map 디코딩 성공 시 Mapped 인디케이터에 표시될 합성
// 'mapped' 엔트리도 포함.
const INITIATOR_TYPE_DESCRIPTIONS = {
  script:
    `이 요청은 JavaScript 코드에 의해 발생했습니다.
어떤 함수가 요청을 시작했는지 Call Stack에서
확인하세요.
민감 함수 라벨(Authentication, Token 등)이
강조 표시되어 있으면 해당 프레임을 클릭해
소스를 검토하세요.`,
  parser:
    `이 요청은 HTML 파서가 정적 마크업 태그
(<img src>, <script src>, <link href> 등)를
읽으면서 발생했습니다.
사용자 입력이 HTML에 반영되는 구조라면
SSRF 또는 XSS 검토 지점이 될 수 있습니다.`,
  mapped:
    `이 요청에 대해 소스맵 디코딩이 성공했습니다.
번들된 코드가 원본 파일명과 라인 번호로
역매핑되어 있습니다.
↑ 표시가 있는 프레임을 클릭하면 인라인으로
원본 소스를 볼 수 있습니다.
운영 환경에서 소스맵이 접근 가능하다면
소스맵 노출 여부 검토를 고려하세요.`,
};

// SENSITIVE_PATTERNS 라벨의 호버 툴팁 텍스트 — Initiator 탭 상단의
// 힌트 배지와 call stack 안의 per-frame sensitive 배지 양쪽 모두.
const SENSITIVE_PATTERN_DESCRIPTIONS = {
  'OTP/MFA':
    `OTP 또는 다중 인증 핸들러가
콜스택에 포함되어 있습니다.
인증 플로우의 핵심 분기점입니다.
Replay 탭에서 OTP 파라미터를 수정해
재전송하여 서버측 검증을 확인하세요.`,
  'Authentication':
    `로그인 / 로그아웃 / 세션 핸들러가
콜스택에 포함되어 있습니다.
이 요청은 인증 플로우의 일부입니다.
Replay 탭에서 자격 증명을 수정해
재전송하여 접근 통제를 검토하세요.`,
  'Token':
    `토큰 발급 / 검증 / 갱신 함수가
콜스택에 포함되어 있습니다.
Response 탭에서 응답 본문에 토큰이
노출되는지 확인하세요.
🔑 token Detection 배지가 함께 있으면
전체 토큰 노출 경로를 추적하세요.`,
  'Validation':
    `입력 검증 함수가 콜스택에
포함되어 있습니다.
클라이언트측 검증 지점입니다.
Replay 탭에서 파라미터 값을 수정해
재전송하여 서버가 독립적으로
검증을 수행하는지 확인하세요.`,
  'Authorization':
    `권한 / 접근 통제 함수가
콜스택에 포함되어 있습니다.
클라이언트측에 접근 통제 로직이
존재할 수 있습니다.
Replay 탭에서 권한 관련 파라미터를
수정해 재전송하여 서버측 강제 적용
여부를 확인하세요.`,
  'Crypto':
    `암호화 / 해싱 / 서명 함수가
콜스택에 포함되어 있습니다.
클라이언트측 암호 로직이 관여하고 있습니다.
DevTools 브레이크포인트로 암호화 이전의
평문 값을 확인하거나,
알고리즘 / 키 강도를 검토하세요.`,
  'Credential':
    `비밀번호 / 자격 증명 처리 함수가
콜스택에 포함되어 있습니다.
Payload 탭에서 자격 증명이 평문으로
전송되는지 확인하세요.
🔴 sensitive Detection 배지가 함께 있으면
우선 검토하세요.`,
  'File Operation':
    `파일 업로드 / 다운로드 함수가
콜스택에 포함되어 있습니다.
Replay 탭에서 파일 경로 파라미터를
수정해 재전송하여 Path Traversal 또는
임의 파일 접근 가능성을 확인하세요.`,
  'Navigation':
    `리다이렉트 / 페이지 네비게이션 함수가
콜스택에 포함되어 있습니다.
SSRF 또는 Open Redirect 검토 지점입니다.
Replay 탭에서 URL 파라미터를 수정해
재전송하여 외부 도메인으로의 리다이렉션이
가능한지 확인하세요.`,
  'Payment':
    `결제 / 금액 처리 함수가
콜스택에 포함되어 있습니다.
비즈니스 로직 취약점 검토 지점입니다.
Replay 탭에서 금액 / 수량 파라미터를
수정해 재전송하여 서버가 적절한
검증을 적용하는지 확인하세요.`,
};

function detectSensitive(name) {
  if (!name) return null;
  for (const sp of SENSITIVE_PATTERNS) {
    if (sp.pattern.test(name)) return sp.label;
  }
  return null;
}

function shortenUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname;
    const segments = path.split('/');
    return segments[segments.length - 1] || path;
  } catch {
    return url;
  }
}

// 인라인 소스 뷰어 캐시: url → 소스 텍스트
const sourceCache = {};

function fetchSource(url, callback) {
  if (sourceCache[url] !== undefined) {
    callback(sourceCache[url]);
    return;
  }
  // 인라인 data URI — 직접 디코드, I/O 불필요.
  if (url.startsWith('data:')) {
    const text = decodeDataUri(url);
    sourceCache[url] = text;
    callback(text);
    return;
  }
  // DevTools resources 먼저 — webpack-internal://, eval된 가상 스크립트
  // 커버, 페이지가 이미 로드한 것을 재 fetch 안 함 (cross-origin
  // 스크립트에도 작동, 거기서는 fetch()가 CORS-fail).
  chrome.devtools.inspectedWindow.getResources((resources) => {
    const res = resources && resources.find(r => r.url === url);
    if (res) {
      res.getContent((content, encoding) => {
        if (content != null) {
          const text = encoding === 'base64' ? atob(content) : content;
          sourceCache[url] = text;
          callback(text);
          return;
        }
        fetchSourceViaPage(url, callback);
      });
      return;
    }
    fetchSourceViaPage(url, callback);
  });
}

// Fallback: inspected 페이지에 URL을 fetch()해달라고 요청. DevTools
// resource 캐시에 없을 때 사용 (예: 페이지 자체가 로드하지 않은 .map
// 파일).
function fetchSourceViaPage(url, callback) {
  const expr = `fetch(${JSON.stringify(url)}).then(r=>r.ok?r.text():null).then(t=>{window.__dtpp_src=t}).catch(()=>{window.__dtpp_src=null})`;
  chrome.devtools.inspectedWindow.eval(expr, () => {
    let done = false;
    const poll = setInterval(() => {
      if (done) return;
      chrome.devtools.inspectedWindow.eval('window.__dtpp_src', (result, err) => {
        if (done) return;
        if (err) { done = true; clearInterval(poll); callback(null); return; }
        if (result !== undefined) {
          done = true;
          clearInterval(poll);
          chrome.devtools.inspectedWindow.eval('delete window.__dtpp_src');
          sourceCache[url] = result;
          callback(result);
        }
      });
    }, 100);
    setTimeout(() => { if (!done) { done = true; clearInterval(poll); callback(null); } }, 5000);
  });
}

// ============================================================
// Source map 디코더 (Initiator 통합)
// ============================================================
// v3 source map을 lazy 디코드 → bundle.js:1:12345의 stack frame을
// Auth.tsx:42:5로 표시. 자체 포함 — 외부 라이브러리 없음 — 너그러움:
// map이 없거나 깨졌으면 frame에 번들 위치 그대로 표시.

const VLQ_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// pos에서 시작해 VLQ 값 1개 디코드. [value, nextPos] 반환.
// VLQ 문자는 base64; bit 5 (0x20)이 continuation 마크, 조립된 값의
// bit 0이 부호 비트.
function decodeVlq(str, pos) {
  let result = 0;
  let shift = 0;
  let continuation = true;
  while (continuation) {
    if (pos >= str.length) throw new Error('Truncated VLQ');
    const ch = str[pos++];
    const digit = VLQ_BASE64.indexOf(ch);
    if (digit < 0) throw new Error('Invalid VLQ char: ' + ch);
    continuation = (digit & 32) !== 0;
    result |= (digit & 31) << shift;
    shift += 5;
  }
  const negative = (result & 1) === 1;
  result >>>= 1;
  return [negative ? -result : result, pos];
}

// v3 "mappings" 문자열 파싱. segments[generatedLine] = 정렬된
// { generatedColumn, sourceIndex, originalLine, originalColumn } 리스트
// 반환. source/line/column 인덱스는 map 전체에 걸쳐 delta-encoded;
// generatedColumn은 line마다 reset.
function parseMappings(mappings) {
  const lines = mappings.split(';');
  const result = [];
  let sourceIndex = 0, originalLine = 0, originalColumn = 0;
  for (const lineStr of lines) {
    let generatedColumn = 0;
    const segments = [];
    let pos = 0;
    while (pos < lineStr.length) {
      // segment는 ',' 또는 line 끝에서 종료
      const fields = [];
      while (pos < lineStr.length && lineStr[pos] !== ',') {
        const [v, newPos] = decodeVlq(lineStr, pos);
        fields.push(v);
        pos = newPos;
      }
      if (fields.length >= 1) generatedColumn += fields[0];
      // 4개 또는 5개 필드 = source로 매핑. 1개 필드 = unmapped 마커.
      if (fields.length >= 4) {
        sourceIndex += fields[1];
        originalLine += fields[2];
        originalColumn += fields[3];
        segments.push({ generatedColumn, sourceIndex, originalLine, originalColumn });
      }
      if (lineStr[pos] === ',') pos++;
    }
    result.push(segments);
  }
  return result;
}

// 주어진 generated line에서 generatedColumn <= column인 가장 큰
// segment를 binary search. segment 또는 null 반환.
function lookupMapping(segments, line, column) {
  if (line < 0 || line >= segments.length) return null;
  const lineSegs = segments[line];
  if (!lineSegs || lineSegs.length === 0) return null;
  let lo = 0, hi = lineSegs.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineSegs[mid].generatedColumn <= column) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found >= 0 ? lineSegs[found] : null;
}

// scriptUrl → 파싱된 map { sources, sourcesContent, segments, mapUrl } 또는 null.
const sourceMapCache = {};

// "data:[<mediatype>][;base64],<data>" URI를 텍스트로 디코드. 파싱
// 또는 디코드 실패 시 null 반환.
function decodeDataUri(uri) {
  const m = uri.match(/^data:([^,]*),([\s\S]*)$/);
  if (!m) return null;
  try {
    return /;base64/i.test(m[1]) ? atob(m[2]) : decodeURIComponent(m[2]);
  } catch {
    return null;
  }
}

// v3 source map JSON 문자열을 다른 곳에서 쓰는 cache-friendly 모양으로
// 파싱. 구조적 문제(미지원 version, index map, malformed JSON) 시
// null 반환.
function parseSourceMapText(text, mapUrl) {
  try {
    const map = JSON.parse(text);
    if (map.version !== 3) return null;
    if (map.sections) return null; // Index map은 MVP 범위 밖.
    return {
      sources: map.sources || [],
      sourcesContent: map.sourcesContent || [],
      segments: parseMappings(map.mappings || ''),
      mapUrl,
    };
  } catch {
    return null;
  }
}

// 스크립트의 source map(//# sourceMappingURL=에서 해결)을 fetch +
// 파싱. 캐시됨. 실패 시 null로 fall through — caller는 "매핑 없음,
// 번들 위치 사용"으로 처리. 외부 .map URL과 inline data: URI
// (eval-source-map 스타일) 둘 다 처리.
function getSourceMap(scriptUrl, callback) {
  if (sourceMapCache[scriptUrl] !== undefined) {
    callback(sourceMapCache[scriptUrl]);
    return;
  }
  fetchSource(scriptUrl, (source) => {
    if (!source) { sourceMapCache[scriptUrl] = null; callback(null); return; }
    const tail = source.length > 4096 ? source.slice(-4096) : source;
    const m = tail.match(/\/\/[#@]\s*sourceMappingURL=([^\s'"]+)/);
    if (!m) { sourceMapCache[scriptUrl] = null; callback(null); return; }
    const rawMapUrl = m[1].trim();

    // 인라인 map — webpack의 eval-source-map 같은 dev 모드에서 흔함.
    if (rawMapUrl.startsWith('data:')) {
      const text = decodeDataUri(rawMapUrl);
      const parsed = text ? parseSourceMapText(text, rawMapUrl) : null;
      sourceMapCache[scriptUrl] = parsed;
      callback(parsed);
      return;
    }

    let mapUrl;
    try { mapUrl = new URL(rawMapUrl, scriptUrl).href; }
    catch { sourceMapCache[scriptUrl] = null; callback(null); return; }
    fetchSource(mapUrl, (mapText) => {
      const parsed = mapText ? parseSourceMapText(mapText, mapUrl) : null;
      sourceMapCache[scriptUrl] = parsed;
      callback(parsed);
    });
  });
}

function renderSourceViewer(container, source, targetLine) {
  if (!source) {
    container.innerHTML = '<div class="detail-loading">Failed to fetch source.</div>';
    return;
  }
  const lines = source.split('\n');
  const contextBefore = 10;
  const contextAfter = 10;
  const start = Math.max(0, targetLine - contextBefore);
  const end = Math.min(lines.length, targetLine + contextAfter + 1);

  let html = '<div class="source-viewer">';
  if (start > 0) {
    html += `<div class="source-line source-ellipsis">... (${start} lines above)</div>`;
  }
  for (let i = start; i < end; i++) {
    const lineNum = i + 1; // 1-indexed 표시
    const isTarget = i === targetLine;
    const cls = isTarget ? 'source-line target-line' : 'source-line';
    html += `<div class="${cls}"><span class="source-linenum">${lineNum}</span><span class="source-code">${escapeHtml(lines[i])}</span></div>`;
  }
  if (end < lines.length) {
    html += `<div class="source-line source-ellipsis">... (${lines.length - end} lines below)</div>`;
  }
  html += '</div>';
  container.innerHTML = html;

  // target line을 view로 스크롤
  const targetEl = container.querySelector('.target-line');
  if (targetEl) targetEl.scrollIntoView({ block: 'center' });
}

function renderInitiator(req) {
  const container = document.getElementById('detail-initiator-body');

  // 탭 인디케이터 reset — async source-map enrichment가 새 요청의
  // 한 프레임이라도 성공적으로 매핑되면 다시 추가.
  const initiatorTabBtn = document.querySelector('.detail-tab[data-detail="initiator"]');
  if (initiatorTabBtn) {
    initiatorTabBtn.classList.remove('has-mapped');
    initiatorTabBtn.removeAttribute('title');
  }

  if (!req.initiator) {
    container.innerHTML = '<div class="detail-loading">Initiator data not available.</div>';
    return;
  }

  const init = req.initiator;
  let html = '';

  // Type 그룹 — description 카드와 Detection 스타일 헤더. sourcemap
  // enrichment가 떨어지면 배지가 "↑ Mapped"로 업그레이드되고 카운트는
  // "<N> frames mapped"로 뒤집힘.
  const typeStr = init.type || 'unknown';
  const typeDesc = INITIATOR_TYPE_DESCRIPTIONS[typeStr] || '';
  const frames = init.stack?.callFrames || [];
  let typeCountText = '';
  if (typeStr === 'script') {
    typeCountText = `Call Stack ${frames.length} frame${frames.length === 1 ? '' : 's'}`;
  } else if (typeStr === 'parser') {
    typeCountText = init.url ? 'triggered by static markup' : '';
  }
  html += `<div class="detection-group" data-init-type-group>
    <div class="detection-group-header">
      <span class="scan-badge scan-badge-init-${escapeAttr(typeStr)}"${typeDesc ? ` title="${escapeAttr(typeDesc)}"` : ''}>${escapeHtml(typeStr)}</span>
      ${typeCountText ? `<span class="detection-group-count">${escapeHtml(typeCountText)}</span>` : ''}
      ${typeDesc ? '<span class="detection-group-toggle">▾</span>' : ''}
    </div>
    ${typeDesc ? `<div class="detection-category-desc hidden">${escapeHtml(typeDesc)}</div>` : ''}
  </div>`;

  // 콜 스택
  if (frames.length > 0) {
    // 감지된 sensitive 패턴(있으면)별로 프레임 그룹.
    const framesByPattern = {};
    frames.forEach(f => {
      const label = detectSensitive(f.functionName);
      if (!label) return;
      if (!framesByPattern[label]) framesByPattern[label] = [];
      framesByPattern[label].push(f);
    });

    // 매칭된 패턴마다 Detection 스타일 그룹 1개; 안의 매칭 프레임이
    // 그 패턴의 severity를 담은 finding.
    for (const [label, list] of Object.entries(framesByPattern)) {
      const sev = SENSITIVE_PATTERN_SEVERITY[label] || 'info';
      const desc = SENSITIVE_PATTERN_DESCRIPTIONS[label] || '';
      html += `<div class="detection-group">
        <div class="detection-group-header">
          <span class="scan-badge scan-badge-sens"${desc ? ` title="${escapeAttr(desc)}"` : ''}>⚠️ ${escapeHtml(label)}</span>
          <span class="detection-group-count">${list.length} frame${list.length === 1 ? '' : 's'}</span>
          ${desc ? '<span class="detection-group-toggle">▾</span>' : ''}
        </div>
        ${desc ? `<div class="detection-category-desc hidden">${escapeHtml(desc)}</div>` : ''}
        <div class="detection-findings">`;
      for (const f of list) {
        const funcName = f.functionName || '(anonymous)';
        const fileName = shortenUrl(f.url || '');
        const line = (f.lineNumber ?? -1) + 1;
        const loc = f.url
          ? `${funcName}  ${fileName}:${line}`
          : funcName;
        html += `<div class="detection-finding severity-${sev}">
          <div class="detection-finding-top">
            <span class="detection-severity sev-${sev}">${sev.toUpperCase()}</span>
            <span class="detection-location">${escapeHtml(loc)}</span>
          </div>
        </div>`;
      }
      html += `</div></div>`;
    }

    html += '<div class="initiator-stack-title">Call Stack</div>';
    html += '<div class="initiator-stack">';
    frames.forEach((f, i) => {
      const funcName = f.functionName || '(anonymous)';
      const fileName = shortenUrl(f.url || '');
      const line = (f.lineNumber ?? -1) + 1; // 0-indexed → 1-indexed
      const col = (f.columnNumber ?? 0) + 1;
      const sensitive = detectSensitive(f.functionName);
      const sensitiveCls = sensitive ? ' sensitive' : '';
      const sourceLocation = f.url ? `${escapeHtml(fileName)}:${line}:${col}` : '';

      html += `<div class="initiator-frame${sensitiveCls}" data-url="${escapeAttr(f.url || '')}" data-line="${f.lineNumber || 0}" data-col="${f.columnNumber || 0}">`;
      html += `<span class="frame-index">${i}</span>`;
      html += `<span class="func-name">${escapeHtml(funcName)}</span>`;
      if (sensitive) {
        const sensDesc = SENSITIVE_PATTERN_DESCRIPTIONS[sensitive] || '';
        html += `<span class="sensitive-badge"${sensDesc ? ` title="${escapeAttr(sensDesc)}"` : ''}>${escapeHtml(sensitive)}</span>`;
      }
      if (sourceLocation) {
        html += `<span class="source-link" title="${escapeAttr(f.url + ':' + line)}">${sourceLocation}</span>`;
      }
      html += '</div>';
    });
    html += '</div>';
  } else if (init.url) {
    // 파서 발화 (예: <script src>, <link>, <img>)
    html += `<div class="initiator-parser">Initiated by: <span class="source-link" data-url="${escapeAttr(init.url)}" data-line="${init.lineNumber || 0}">${escapeHtml(init.url)}${init.lineNumber != null ? ':' + (init.lineNumber + 1) : ''}</span></div>`;
  } else {
    html += '<div class="detail-loading">No call stack available.</div>';
  }

  // 인라인 소스 뷰어 placeholder
  html += '<div id="initiator-source-viewer"></div>';

  container.innerHTML = html;

  function showInlineSource(url, lineNum, colNum, notice) {
    container.querySelectorAll('.initiator-frame').forEach(f => f.classList.remove('active'));
    const activeFrame = container.querySelector(`.initiator-frame[data-url="${CSS.escape(url)}"][data-line="${lineNum}"]`);
    if (activeFrame) activeFrame.classList.add('active');

    const viewer = document.getElementById('initiator-source-viewer');

    // 스크립트에 파싱된 map이 있고 sourcesContent[]가 파일을 inline
    // 으로 포함하면 매핑된 원본 소스를 우선 사용. 없으면 번들 fetch
    // 로 fall through.
    const map = sourceMapCache[url];
    if (map) {
      const mapping = lookupMapping(map.segments, lineNum, colNum || 0);
      if (mapping) {
        const original = map.sourcesContent[mapping.sourceIndex];
        const sourceName = map.sources[mapping.sourceIndex];
        if (original && sourceName) {
          const display = sourceName.split('/').pop() || sourceName;
          viewer.innerHTML =
            `<div class="source-viewer-header">${escapeHtml(display)}:${mapping.originalLine + 1}` +
            `<span class="source-viewer-mapped-tag">↑ source-mapped from ${escapeHtml(shortenUrl(url))}</span></div>`;
          const body = document.createElement('div');
          viewer.appendChild(body);
          renderSourceViewer(body, original, mapping.originalLine);
          if (notice) {
            const noticeEl = document.createElement('div');
            noticeEl.className = 'source-viewer-notice';
            noticeEl.textContent = notice;
            viewer.insertBefore(noticeEl, viewer.children[1]);
          }
          return;
        }
      }
    }

    const header = `${escapeHtml(shortenUrl(url))}:${lineNum + 1}`;
    viewer.innerHTML = `<div class="source-viewer-header">${header}</div><div class="detail-loading">Loading source...</div>`;
    fetchSource(url, (source) => {
      if (source) {
        renderSourceViewer(viewer, source, lineNum);
      } else {
        viewer.innerHTML = `<div class="source-viewer-header">${header}</div><div class="detail-loading">Source not available (cross-origin or network error).</div>`;
      }
      if (notice) {
        const noticeEl = document.createElement('div');
        noticeEl.className = 'source-viewer-notice';
        noticeEl.textContent = notice;
        viewer.insertBefore(noticeEl, viewer.children[1]);
      }
    });
  }

  // 프레임 본체 클릭 → 인라인 소스 뷰어
  container.querySelectorAll('.initiator-frame').forEach(el => {
    const url = el.dataset.url;
    if (!url) return;
    el.style.cursor = 'pointer';
    el.addEventListener('click', (e) => {
      // source-link 클릭이면 그 핸들러가 처리하도록 양보
      if (e.target.closest('.source-link')) return;
      e.stopPropagation();
      const lineNum = parseInt(el.dataset.line || '0', 10);
      const colNum = parseInt(el.dataset.col || '0', 10);
      showInlineSource(url, lineNum, colNum);
    });
  });

  // 소스 링크 클릭 → Sources 탭 시도, 인라인으로 fallback. 스크립트에
  // 사용 가능한 source map이 있으면 매핑된 인라인 뷰 선호 — Sources
  // 패널은 번들 파일만 인식.
  container.querySelectorAll('.initiator-frame .source-link').forEach(link => {
    const frame = link.closest('.initiator-frame');
    const url = frame?.dataset.url;
    if (!url) return;
    link.style.cursor = 'pointer';
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      const lineNum = parseInt(frame.dataset.line || '0', 10);
      const colNum = parseInt(frame.dataset.col || '0', 10);

      const map = sourceMapCache[url];
      if (map) {
        const mapping = lookupMapping(map.segments, lineNum, colNum);
        if (mapping && map.sourcesContent[mapping.sourceIndex]) {
          showInlineSource(url, lineNum, colNum);
          return;
        }
      }

      chrome.devtools.inspectedWindow.getResources((resources) => {
        const exists = resources.some(r => r.url === url);
        if (exists) {
          chrome.devtools.panels.openResource(url, lineNum, () => {});
        } else {
          showInlineSource(url, lineNum, colNum,
            'Resource not found in Sources panel — showing fetched source. Click the source link again to open in Sources (the fetch request makes it available).');
        }
      });
    });
  });

  // 파서 발화 소스 링크 클릭
  container.querySelectorAll('.initiator-parser .source-link[data-url]').forEach(link => {
    const url = link.dataset.url;
    if (!url) return;
    link.style.cursor = 'pointer';
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      const lineNum = parseInt(link.dataset.line || '0', 10);
      chrome.devtools.inspectedWindow.getResources((resources) => {
        if (resources.some(r => r.url === url)) {
          chrome.devtools.panels.openResource(url, lineNum, () => {});
        } else {
          showInlineSource(url, lineNum, 0);
        }
      });
    });
  });

  // Type 및 패턴 그룹의 click-to-expand — Detection 탭이 쓰는 동일
  // 핸들러라 두 탭이 UX를 공유.
  container.addEventListener('click', _onDetectionGroupClick);

  // Async: call-stack 프레임을 source map 정보로 enrich. 각 스크립트의
  // map이 해결될 때 DOM 업데이트. 캐시가 있어 재 fetch 없음.
  if (frames.length > 0) enrichFramesWithSourceMaps(container, frames, req);
}

// 행의 Initiator 컬럼만 업데이트하는 source-map enrichment의 lite
// 버전 — 프레임 요소의 DOM 재작성 없음. 캡처 시점에 사전 실행해서
// 사용자가 요청을 클릭하기 전에도 컬럼에 "↑ Mapped"가 표시되도록.
function _eagerEnrichInitiator(req) {
  if (!req || req._sourcemapMapped) return;
  const frames = (req.initiator && req.initiator.stack && req.initiator.stack.callFrames) || [];
  if (frames.length === 0) return;
  const seen = new Set();
  for (const f of frames) {
    if (!f.url || seen.has(f.url)) continue;
    seen.add(f.url);
    getSourceMap(f.url, (map) => {
      if (!map || req._sourcemapMapped) return;
      // 이 스크립트의 프레임만 walk — 첫 매치가 플래그 뒤집음.
      for (const ff of frames) {
        if (ff.url !== f.url) continue;
        const mapping = lookupMapping(map.segments, ff.lineNumber || 0, ff.columnNumber || 0);
        if (mapping && map.sources[mapping.sourceIndex]) {
          req._sourcemapMapped = true;
          updateNetworkRowInitiator(req);
          return;
        }
      }
    });
  }
}

// call stack의 각 고유 스크립트 URL에 대해 source map을 fetch & 디코드
// 시도, 그 후 프레임의 source-link를 매핑된 (original-file:line:col)
// 위치를 번들된 위치와 함께 표시하도록 다시 그림.
function enrichFramesWithSourceMaps(container, frames, req) {
  const urlToIndices = {};
  frames.forEach((f, i) => {
    if (!f.url) return;
    if (!urlToIndices[f.url]) urlToIndices[f.url] = [];
    urlToIndices[f.url].push(i);
  });
  let mappedCount = 0;
  const totalFramesWithUrls = Object.values(urlToIndices).reduce((s, arr) => s + arr.length, 0);
  Object.keys(urlToIndices).forEach(url => {
    getSourceMap(url, (map) => {
      if (!map) return;
      const frameEls = container.querySelectorAll('.initiator-frame');
      urlToIndices[url].forEach(idx => {
        const frame = frames[idx];
        const mapping = lookupMapping(
          map.segments,
          frame.lineNumber || 0,
          frame.columnNumber || 0
        );
        if (!mapping) return;
        const sourceName = map.sources[mapping.sourceIndex];
        if (!sourceName) return;
        const frameEl = frameEls[idx];
        if (!frameEl) return;
        const sourceLink = frameEl.querySelector('.source-link');
        if (!sourceLink) return;
        const display = sourceName.split('/').pop() || sourceName;
        const mappedLoc = `${display}:${mapping.originalLine + 1}:${mapping.originalColumn + 1}`;
        const bundledLoc = `${shortenUrl(frame.url)}:${(frame.lineNumber || 0) + 1}`;
        sourceLink.classList.add('mapped');
        sourceLink.title = `Original: ${sourceName}:${mapping.originalLine + 1}\nBundled: ${frame.url}:${(frame.lineNumber || 0) + 1}`;
        sourceLink.innerHTML =
          `<span class="mapped-icon">↑</span>` +
          `<span class="mapped-loc">${escapeHtml(mappedLoc)}</span>` +
          `<span class="bundled-loc">${escapeHtml(bundledLoc)}</span>`;
        mappedCount++;
        // Initiator 탭을 마킹해서 사용자가 탭 클릭 전에도 매핑이
        // 일어났음을 인지하도록.
        const tabBtn = document.querySelector('.detail-tab[data-detail="initiator"]');
        if (tabBtn) {
          tabBtn.classList.add('has-mapped');
          tabBtn.title = `Source-mapped frames: ${mappedCount} / ${totalFramesWithUrls}\n\n${INITIATOR_TYPE_DESCRIPTIONS.mapped || ''}`;
        }
        // 첫 성공 프레임 매핑 시 행의 Initiator 셀을 "↑ Mapped"로
        // 승격. 플래그는 req에 유지되므로 재렌더 사이에도 셀이 매핑
        // 상태 유지.
        if (req && !req._sourcemapMapped) {
          req._sourcemapMapped = true;
          updateNetworkRowInitiator(req);
        }
        // Initiator detail 탭 안의 Type 그룹도 승격해서 배지/카운트가
        // 매핑된 상태를 반영.
        const typeGroup = container.querySelector('[data-init-type-group]');
        if (typeGroup) {
          const typeBadge = typeGroup.querySelector('.scan-badge');
          if (typeBadge && !typeBadge.classList.contains('scan-badge-init-mapped')) {
            typeBadge.textContent = '↑ Mapped';
            typeBadge.className = 'scan-badge scan-badge-init-mapped';
            const md = INITIATOR_TYPE_DESCRIPTIONS.mapped || '';
            if (md) typeBadge.title = md;
            // 인라인 description 카드도 mapped 버전으로 교체.
            const descBlock = typeGroup.querySelector('.detection-category-desc');
            if (descBlock && md) descBlock.textContent = md;
          }
          const cnt = typeGroup.querySelector('.detection-group-count');
          if (cnt) cnt.textContent = `${mappedCount} frame${mappedCount === 1 ? '' : 's'} mapped`;
        }
      });
    });
  });
}

function syntaxHighlightJson(str) {
  return escapeHtml(str)
    .replace(/"([^"\\]*(\\.[^"\\]*)*)"(\s*:)/g, '<span class="json-key">"$1"</span>$3')
    .replace(/"([^"\\]*(\\.[^"\\]*)*)"/g, '<span class="json-string">"$1"</span>')
    .replace(/\b(-?\d+\.?\d*([eE][+-]?\d+)?)\b/g, '<span class="json-number">$1</span>')
    .replace(/\b(true|false)\b/g, '<span class="json-boolean">$1</span>')
    .replace(/\bnull\b/g, '<span class="json-null">null</span>');
}

function renderJsonTree(obj, indent) {
  indent = indent || 0;
  const pad = '  '.repeat(indent);
  if (obj === null) return `<span class="json-null">null</span>`;
  if (typeof obj === 'boolean') return `<span class="json-boolean">${obj}</span>`;
  if (typeof obj === 'number') return `<span class="json-number">${obj}</span>`;
  if (typeof obj === 'string') return `<span class="json-string">"${escapeHtml(obj)}"</span>`;

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    const items = obj.map(v => pad + '  ' + renderJsonTree(v, indent + 1)).join(',\n');
    return `[\n${items}\n${pad}]`;
  }

  const keys = Object.keys(obj);
  if (keys.length === 0) return '{}';
  const entries = keys.map(k =>
    `${pad}  <span class="json-key">"${escapeHtml(k)}"</span>: ${renderJsonTree(obj[k], indent + 1)}`
  ).join(',\n');
  return `{\n${entries}\n${pad}}`;
}

// ============================================================
// Auto Decode Layer — JWT, Base64, URL-enc, nested JSON, timestamp
// ============================================================
// 활성 요청의 headers + body를 스캔해서 흔한 인코딩을 찾고 원본 뷰
// 아래에 "🔍 Decoded" 패널을 노출. best-effort: 탐지기 비활성화를
// 요구하기보다 strict 포맷 체크로 false positive를 억제.

const AUTODECODE_MAX_FINDINGS = 50;

function decodeBase64Url(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return atob(s);
}

// 휴리스틱: 대부분 바이트가 출력 가능한 ASCII(\t \n \r 포함). Base64
// 탐지기가 임의의 영숫자 문자열을 주장하지 못하도록 사용.
function isPrintableMostly(str, threshold) {
  if (str.length === 0) return false;
  let printable = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if ((c >= 32 && c <= 126) || c === 9 || c === 10 || c === 13) printable++;
  }
  return printable / str.length >= (threshold || 0.95);
}

// 숫자 epoch 필드(exp/iat/nbf/auth_time)를 원본과 함께 ISO 문자열로
// 교체 — JWT payload 표시 시 사용.
function humanizeJwtTimestamps(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const out = { ...payload };
  ['exp', 'iat', 'nbf', 'auth_time'].forEach(f => {
    if (typeof out[f] === 'number') {
      out[`${f} (decoded)`] = new Date(out[f] * 1000).toISOString();
    }
  });
  return out;
}

function detectJWT(str) {
  if (typeof str !== 'string') return null;
  const m = str.match(/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)$/);
  if (!m) return null;
  let header, payload;
  try {
    header = JSON.parse(decodeBase64Url(m[1]));
    payload = JSON.parse(decodeBase64Url(m[2]));
  } catch { return null; }
  if (!header || typeof header !== 'object') return null;
  if (!header.alg && !header.typ) return null;

  const warnings = [];
  if (typeof header.alg === 'string' && header.alg.toLowerCase() === 'none') {
    warnings.push('Algorithm is "none" — token is unsigned and trivially forgeable.');
  }
  if (payload && typeof payload.exp === 'number') {
    const expMs = payload.exp * 1000;
    if (expMs < Date.now()) {
      warnings.push(`Token expired at ${new Date(expMs).toISOString()}.`);
    }
  }
  return {
    type: 'jwt',
    label: 'JWT',
    header,
    payload: humanizeJwtTimestamps(payload),
    signature: m[3],
    warnings,
  };
}

function detectBase64(str) {
  if (typeof str !== 'string') return null;
  if (str.length < 8 || str.length > 8192) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(str)) return null;
  if (str.length % 4 !== 0) return null;
  let decoded;
  try { decoded = atob(str); } catch { return null; }
  if (!isPrintableMostly(decoded, 0.95)) return null;
  let asJson = null;
  try {
    const parsed = JSON.parse(decoded);
    if (typeof parsed === 'object' && parsed !== null) asJson = parsed;
  } catch { /* JSON 아님 */ }
  return { type: 'base64', label: 'Base64', decoded, asJson };
}

function detectUrlEncoded(str) {
  if (typeof str !== 'string') return null;
  // 단일 % 리터럴을 가진 문자열에 매칭되지 않도록 escape sequence
  // 최소 2개 요구.
  if (!/(%[0-9A-Fa-f]{2}){2,}/.test(str)) return null;
  let decoded;
  try { decoded = decodeURIComponent(str); } catch { return null; }
  if (decoded === str) return null;
  return { type: 'urlenc', label: 'URL-encoded', decoded };
}

function detectNestedJson(str) {
  if (typeof str !== 'string') return null;
  const trimmed = str.trim();
  if (trimmed.length < 2) return null;
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null;
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  return { type: 'nested-json', label: 'Nested JSON', parsed };
}

function detectUnixTimestamp(val) {
  let n;
  if (typeof val === 'number' && Number.isFinite(val)) {
    n = val;
  } else if (typeof val === 'string' && /^\d{10}(?:\d{3})?$/.test(val)) {
    n = parseInt(val, 10);
  } else {
    return null;
  }
  let ms;
  if (n >= 1e9 && n < 1e10) ms = n * 1000;        // 10자리 초 (2001–2286)
  else if (n >= 1e12 && n < 1e13) ms = n;          // 13자리 ms
  else return null;
  const date = new Date(ms);
  if (isNaN(date.getTime())) return null;
  return { type: 'timestamp', label: 'Unix timestamp', raw: n, date: date.toISOString() };
}

// 우선순위 순서로 탐지기 시도; 첫 hit 반환. JWT 먼저 — 3-segment
// 모양이 명확. 그 다음 URL-enc과 nested JSON(명확한 마커), Base64는
// 마지막(가장 넓음).
function detectInString(str) {
  return detectJWT(str)
    || detectUrlEncoded(str)
    || detectNestedJson(str)
    || detectBase64(str);
}

// 파싱된 JSON 값(object/array/leaf)을 walk하면서 dotted-path location과
// 함께 finding 수집. 숫자는 timestamp 체크; 문자열은 전체 탐지기
// 체인을 통과.
function autoDecodeScanValue(value, path, findings) {
  if (findings.length >= AUTODECODE_MAX_FINDINGS) return;
  if (typeof value === 'string') {
    const f = detectInString(value);
    if (f) findings.push({ ...f, location: path || '(value)' });
    return;
  }
  if (typeof value === 'number') {
    const f = detectUnixTimestamp(value);
    if (f) findings.push({ ...f, location: path || '(value)' });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => autoDecodeScanValue(v, `${path}[${i}]`, findings));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const k of Object.keys(value)) {
      autoDecodeScanValue(value[k], path ? `${path}.${k}` : k, findings);
    }
  }
}

// flat header map 스캔. 탐지기 실행 전 "Bearer "/"Basic "/"Token "
// prefix를 제거 — JWT는 거의 항상 그 아래 있음.
function autoDecodeScanHeaders(headers, sourceLabel) {
  const findings = [];
  for (const [name, value] of Object.entries(headers || {})) {
    if (findings.length >= AUTODECODE_MAX_FINDINGS) break;
    if (typeof value !== 'string') continue;
    let scanStr = value;
    let prefix = '';
    const auth = value.match(/^(Bearer|Basic|Token)\s+(.+)$/i);
    if (auth) { prefix = auth[1]; scanStr = auth[2]; }
    const f = detectInString(scanStr);
    if (f) {
      findings.push({
        ...f,
        location: `${sourceLabel}: ${name}${prefix ? ` (after "${prefix}")` : ''}`,
      });
    }
  }
  return findings;
}

// body 문자열 스캔. JSON 먼저 시도, 그 다음 urlencoded form, 그 다음
// raw 문자열. 각 분기가 적절히 scanValue/detectInString을 호출.
//
// 500KB 초과 body는 스캔 전 첫 50KB로 truncate → 거대한 페이로드
// 하나가 패널을 잠그지 않도록. truncation은 'notice' finding으로
// 사용자에게 노출되어 결과가 부분적임을 알 수 있게 함.
const AUTODECODE_BODY_LIMIT = 512000;
const AUTODECODE_BODY_TRUNCATE = 51200;

function autoDecodeScanBody(bodyStr, sourceLabel) {
  if (!bodyStr || typeof bodyStr !== 'string') return [];
  const findings = [];
  let scanStr = bodyStr;
  if (bodyStr.length > AUTODECODE_BODY_LIMIT) {
    scanStr = bodyStr.slice(0, AUTODECODE_BODY_TRUNCATE);
    findings.push({
      type: 'notice',
      label: 'TRUNCATED',
      location: `Response too large; analyzed first ${(AUTODECODE_BODY_TRUNCATE / 1024) | 0} KB (total ${(bodyStr.length / 1024).toFixed(1)} KB)`,
    });
  }
  const trimmed = scanStr.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) {
        autoDecodeScanValue(parsed, sourceLabel, findings);
        return findings;
      }
    } catch { /* fall through */ }
  }
  if (scanStr.includes('=') && /^[\w.~%-]+=[^&]*(&[\w.~%-]+=[^&]*)*$/.test(scanStr)) {
    try {
      const params = new URLSearchParams(scanStr);
      for (const [k, v] of params) {
        if (findings.length >= AUTODECODE_MAX_FINDINGS) break;
        const f = detectInString(v);
        if (f) findings.push({ ...f, location: `${sourceLabel}: ${k}` });
      }
      return findings;
    } catch { /* fall through */ }
  }
  const f = detectInString(scanStr);
  if (f) findings.push({ ...f, location: sourceLabel });
  return findings;
}

// `container`의 기존 decoded 섹션을 `findings`로 빌드된 것으로 교체.
// finding이 비어 있으면 섹션 제거.
function renderDecodedSection(container, findings) {
  const existing = container.querySelector(':scope > .decoded-section');
  if (existing) existing.remove();
  if (!findings || findings.length === 0) return;
  let html = `<div class="decoded-section">
    <div class="decoded-header"><span>🔍 Decoded</span><span class="decoded-count">${findings.length}</span></div>
    <div class="decoded-list">`;
  findings.forEach(f => { html += renderDecodedFinding(f); });
  html += '</div></div>';
  container.insertAdjacentHTML('beforeend', html);
}

function renderDecodedFinding(f) {
  // 일반 notice(예: "TRUNCATED")는 single non-expandable 배너로 렌더 —
  // body 없음, chevron 없음, expandable detail 없음.
  if (f.type === 'notice') {
    return `<div class="decoded-item decoded-notice">
      <span class="decoded-type-badge type-notice">${escapeHtml(f.label)}</span>
      <span class="decoded-location">${escapeHtml(f.location || '')}</span>
    </div>`;
  }
  const warnings = (f.warnings || []).map(w =>
    `<span class="decoded-warning-badge">⚠️ ${escapeHtml(w)}</span>`
  ).join('');
  let body = '';
  switch (f.type) {
    case 'jwt': {
      const headerStr = JSON.stringify(f.header, null, 2);
      const payloadStr = JSON.stringify(f.payload, null, 2);
      body = `<div class="decoded-subblock">Header</div>
              <pre class="decoded-pretty">${syntaxHighlightJson(headerStr)}</pre>
              <div class="decoded-subblock">Payload</div>
              <pre class="decoded-pretty">${syntaxHighlightJson(payloadStr)}</pre>`;
      break;
    }
    case 'base64': {
      if (f.asJson) {
        const s = JSON.stringify(f.asJson, null, 2);
        body = `<div class="decoded-subblock">Decoded (JSON)</div>
                <pre class="decoded-pretty">${syntaxHighlightJson(s)}</pre>`;
      } else {
        body = `<div class="decoded-subblock">Decoded</div>
                <pre class="decoded-pretty">${escapeHtml(f.decoded)}</pre>`;
      }
      break;
    }
    case 'urlenc':
      body = `<pre class="decoded-pretty">${escapeHtml(f.decoded)}</pre>`;
      break;
    case 'nested-json': {
      const s = JSON.stringify(f.parsed, null, 2);
      body = `<pre class="decoded-pretty">${syntaxHighlightJson(s)}</pre>`;
      break;
    }
    case 'timestamp':
      body = `<pre class="decoded-pretty">${escapeHtml(f.date)} (raw: ${f.raw})</pre>`;
      break;
  }
  return `<details class="decoded-item" open>
    <summary>
      <span class="decoded-type-badge type-${f.type}">${escapeHtml(f.label)}</span>
      <span class="decoded-location">${escapeHtml(f.location || '')}</span>
      ${warnings}
    </summary>
    <div class="decoded-content">${body}</div>
  </details>`;
}

// ============================================================
// Response Pattern Detection — 요청에 대한 보안 지향 finding
// ============================================================
// URL, request body/headers, response body/status를 고정 패턴 집합
// (auth tokens, PII, 내부 정보 leak, 민감 필드, IDOR 후보, 권한
// 파라미터, 의심 응답)에 대해 검사하고 요청 객체의 scanResults에
// 저장되는 finding 리스트를 emit. body 의존 패스는 응답 body가
// 가용할 때만 실행; 대용량 body는 Auto Decode와 같은 한도로 truncate.

const SCAN_BODY_LIMIT = AUTODECODE_BODY_LIMIT;
const SCAN_BODY_TRUNCATE = AUTODECODE_BODY_TRUNCATE;

// 초기 패스에 body-side finding을 포함할 수 있도록 응답 body를
// eager 로드할 가치가 있는 mimetype.
// (x-)?javascript / (x-)?ecmascript variant를 모두 포함 — `application/x-javascript`
// 같은 흔한 legacy variant가 누락되면 nexacro의 .xfdl.js 등이 캡처에 body 없이
// 저장되어 분석 워크플로우(export → distill)에서 클라 코드 회수가 빠짐.
// size cap 없음 — SPA 런타임 번들(nexacro Framework.js 1.3MB 등)도 분석 가치가
// 있어 자동 회수가 워크플로우에 더 부합. 매 캡처마다 export 크기가 증가하는
// 비용은 자가용 분석 워크스페이스에서 감수.
function scanShouldEagerLoadBody(req) {
  const m = req.mimeType || '';
  if (!m) return false;
  return /^(application\/(json|xml|x-www-form-urlencoded|(?:x-)?(?:java|ecma)script|graphql|ld\+json)|application\/[^;]*\+json|text\/)/i.test(m);
}

// 같은 (category, location)이 아직 보이지 않은 경우에만 finding 추가.
// per-request 배지 리스트와 detail 패널이 near-duplicate로 채워지지
// 않도록.
function _scanAdd(findings, seen, finding) {
  const key = `${finding.category}|${finding.location}`;
  if (seen.has(key)) return;
  seen.add(key);
  findings.push(finding);
}

function _scanCheckPrivilegeKey(key) {
  return /^(role|isAdmin|is_admin|admin|privilege|permission)$/i.test(key);
}

// ID-like 파라미터 이름 매칭. 3가지 모양 인식 → resource-ID 파라미터
// (userId, account_id 등)를 잡되 "id"로 끝나는 영단어(paid, valid,
// said)는 발화하지 않음.
//   1) "id" / "ID" 정확
//   2) camelCase: <lowercase>I<d|D>$ — userId, orderId, accountID
//   3) separator: _id / -id (대소문자 무관)
// session_id / sessionId는 'session' 카테고리에 속하므로 IDOR 모양으로
// fall through하기 전에 short-circuit.
function _scanCheckIdorKey(key) {
  if (_scanCheckSessionKey(key)) return false;
  if (/^id$/i.test(key)) return true;
  if (/[a-z]I[dD]$/.test(key)) return true;
  if (/[_-]id$/i.test(key)) return true;
  return false;
}

// URL 파라미터나 request body 필드로 전달되는 session/auth 토큰.
// 같은 종류의 비밀이 *반환되는* 것을 플래그하는 response-side
// `token` 카테고리와 별개. `access_token`은 이 리스트에서 제외 —
// response side의 'token' 개념으로 유지.
function _scanCheckSessionKey(key) {
  return /^(session[_-]?id|session[_-]?token|auth[_-]?token)$/i.test(key);
}

// ID처럼 보이지만 실제로는 analytics/tracking handle인 파라미터 이름,
// IDOR 후보 아님. 정규화 저장(lowercase, separator 제거)이라
// snake/camel/kebab이 같은 entry에 매칭.
const IDOR_TRACKING_KEYS_NORMALIZED = new Set([
  'impressionid', 'impid',
  'torosimpid', 'torospagemetaid',
  'teslacontentid',
  'pageviewid',
  'clickid', 'trackingid', 'logid',
  'anonymousid', 'eventid', 'requestid',
]);

function _scanIsIdorTrackingKey(key) {
  return IDOR_TRACKING_KEYS_NORMALIZED.has(
    key.toLowerCase().replace(/[_-]/g, '')
  );
}

// 고정 플래그 값 — *_id 파라미터로 전달돼도 시맨틱적으로 entity ID가
// 아님 (예: A/B 테스트 버킷의 id=control).
const IDOR_FLAG_VALUES = new Set([
  'control', 'default', 'n', 'y',
  'true', 'false', 'none', 'null', 'undefined',
]);

// 노이즈로 필터링할 값들: 빈 값, boolean, 고정 플래그, 그리고 잘 알려진
// 광고/SDK ID prefix 몇 개(Kakao Ads의 DAN-, tracking SDK의 sodar/av-).
function _scanIsIdorNoiseValue(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'boolean') return true;
  const s = String(v);
  if (s.length === 0) return true;
  if (IDOR_FLAG_VALUES.has(s.toLowerCase())) return true;
  if (/^DAN-/.test(s)) return true;
  if (/^sodar/i.test(s)) return true;
  if (/^av-/.test(s)) return true;
  return false;
}

// IDOR을 위한 single-stop 결정: 이름 모양 + tracking-key denylist
// + value-noise 필터. 3개 스캔 위치(query / JSON body walk / form
// body)가 모두 같은 호출을 하도록 중앙화.
function _shouldFlagAsIdor(key, value) {
  if (!_scanCheckIdorKey(key)) return false;
  if (_scanIsIdorTrackingKey(key)) return false;
  if (_scanIsIdorNoiseValue(value)) return false;
  return true;
}

// Server / X-Powered-By 헤더 값에서 "<software>/<x.y.z>" 버전 노출
// 추출. 값에 버전 숫자가 없으면(예: 그냥 "nginx" 또는 "Express")
// null 반환.
function _scanExtractServerVersion(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/([A-Za-z][A-Za-z0-9.-]*)\/(\d+(?:\.\d+)+)/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// 이메일 정규식에서 TLD처럼 보이지만 실제로는 자산 파일명인 확장자
// (예: "logo@2x.png"). PII false positive 억제용. 진짜 TLD가 아닌
// 확장자만 포함 — `tv`/`me`/`io`는 유효한 도메인이므로 유지.
const EMAIL_FILE_EXT_DENY = new Set([
  // 이미지
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'tiff', 'tif', 'avif',
  // 문서
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'csv',
  // 오디오/비디오
  'mp3', 'mp4', 'wav', 'avi', 'mov', 'webm', 'mkv', 'ogg', 'm4a', 'flac', 'aac',
  // 압축
  'zip', 'rar', 'tar', 'gz', 'tgz', 'bz2', '7z',
  // 코드/웹 자산
  'js', 'jsx', 'ts', 'tsx', 'vue', 'css', 'scss', 'sass', 'less', 'html', 'htm', 'php',
  // 데이터/설정
  'json', 'xml', 'yaml', 'yml', 'env', 'lock',
  // 폰트
  'woff', 'woff2', 'ttf', 'eot', 'otf',
]);

// HUNT 스타일 파라미터 사전. 각 카테고리는 역사적으로 vuln 클래스와
// 연관된 파라미터 이름 나열 — 수동 probing 가치가 있는 후보를 플래그
// 하지 확정 버그는 아님. Bugcrowd HUNT 영감.
//
// per-keyword severity override는 `keywordSeverity`로 지원.
// "return_url" 같은 합성 사전 엔트리는 빌드 시 토큰화되어 lookup
// map에는 단일 단어만 보관.
const HUNT_CATEGORIES = {
  // 이전 5개 카테고리(SQLi / LFI / SSRF / RCE / debug)를 단일
  // "Tampering" 버킷으로 합침. 실제로 그 사이의 구분은 노이즈였음 —
  // `query`라는 파라미터가 SQL search, URL filter, debug 토글일 수
  // 있음. 합치면 "이 파라미터가 서버 로직에 영향" 후보 같은 집합을
  // 1개 배지 + 1개 MEDIUM severity로 노출하고, 사용자는 Replay에서
  // 페이로드로 실제 probing을 진행.
  tampering: {
    badge: '🔨 Tampering',
    defaultSeverity: 'medium',
    keywords: [
      // SQLi 계열
      'query', 'search', 'filter', 'sort', 'where', 'select', 'order',
      'keyword', 'column', 'field', 'report', 'row',
      // LFI 계열
      'file', 'path', 'dir', 'directory', 'document', 'template',
      'doc', 'folder', 'root', 'pdf', 'pg', 'style', 'page', 'include',
      // SSRF 계열
      'url', 'redirect', 'dest', 'destination', 'callback', 'return',
      'next', 'host', 'domain', 'uri', 'forward', 'navigate', 'open',
      'feed', 'ref', 'continue',
      // RCE 계열
      'cmd', 'exec', 'command', 'shell', 'execute', 'run',
      // Debug 계열
      'debug', 'test', 'dbg', 'config', 'toggle',
      'enable', 'disable', 'reset', 'adm', 'cfg',
    ],
  },
};

// token (lowercased) → { category, badge, severity, matchedKeyword }.
// severity는 토큰별로 해결: keywordSeverity[tok] || defaultSeverity.
const HUNT_KEYWORD_MAP = (() => {
  const map = new Map();
  for (const [category, def] of Object.entries(HUNT_CATEGORIES)) {
    for (const kw of def.keywords) {
      const tokens = kw.toLowerCase().split(/[_-]/).filter(Boolean);
      for (const tok of tokens) {
        if (!map.has(tok)) {
          const sev = (def.keywordSeverity && def.keywordSeverity[tok])
            || def.defaultSeverity;
          map.set(tok, {
            category, badge: def.badge, severity: sev, matchedKeyword: tok,
          });
        }
      }
    }
  }
  return map;
})();

// HUNT hit의 post-match 노이즈 필터. 일부 키워드는 브라우저
// performance / runtime 속성과 겹침; 사전에는 그 키워드를 유지하되
// 명백한 기술적 노이즈 변종은 억제.
function _scanIsHuntNoise(tokens, hit) {
  if (hit.category === 'tampering') {
    // 'domain'은 파라미터가 정확히 "domain"일 때만 플래그 —
    // domainLookupStart / domainLookupEnd는 PerformanceTiming.
    if (hit.matchedKeyword === 'domain') {
      if (tokens.length !== 1 || tokens[0] !== 'domain') return true;
    }
    // 'redirect'는 perf-timing 변종(redirectStart, redirectEnd,
    // redirectTime, redirectDuration)에서 발화하면 안 됨.
    // 진짜 redirect_uri / redirect_url은 이런 토큰 없이 토큰화됨.
    if (hit.matchedKeyword === 'redirect') {
      for (const t of tokens) {
        if (t === 'start' || t === 'end' || t === 'time' || t === 'duration') {
          return true;
        }
      }
    }
  }
  return false;
}

// 파라미터 이름을 lowercase 토큰으로 분할. camelCase(filePath →
// file, path), snake_case(file_path), kebab-case(file-path), dot
// notation(data.id → data, id) 처리. "profile"/"research" 같은
// 단어는 단일 토큰으로 유지 → "file"/"search"에 대한 false positive
// 회피.
function _scanTokenize(name) {
  if (typeof name !== 'string') return [];
  const snake = name.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase();
  return snake.split(/[_\-.]/).filter(Boolean);
}

// strict 매처: 파라미터 이름의 모든 토큰이 알려진 HUNT 키워드여야
// 함. isBackForward / open_graph / ping_second / operating_system
// 같은 혼합 이름은 비-HUNT 토큰(is, back, graph, second, operating)
// 이 다른 도메인을 시사 → 완전히 제외. redirect_uri / file_path는
// 두 토큰 모두 어휘에 속하므로 여전히 매치.
function _scanMatchHunt(name) {
  const tokens = _scanTokenize(name);
  if (tokens.length === 0) return null;
  let firstHit = null;
  for (const tok of tokens) {
    const hit = HUNT_KEYWORD_MAP.get(tok);
    if (!hit) return null;
    if (!firstHit && !_scanIsHuntNoise(tokens, hit)) {
      firstHit = hit;
    }
  }
  return firstHit;
}

// 어떤 카테고리든 이 location에 이미 finding이 기록됐는지 여부.
// IDOR/privilege/sensitive가 이미 같은 파라미터를 플래그한 경우
// HUNT 추가를 skip하는 데 사용.
function _scanLocationHasFinding(seen, location) {
  for (const key of seen) {
    const sepIdx = key.indexOf('|');
    if (sepIdx >= 0 && key.slice(sepIdx + 1) === location) return true;
  }
  return false;
}

// 파라미터 이름에 HUNT 매치 실행 → hit이 있고 같은 location에 prior
// finding이 없으면 finding 추가.
function _scanAddHunt(findings, seen, location, paramName, value) {
  if (_scanLocationHasFinding(seen, location)) return;
  const hit = _scanMatchHunt(paramName);
  if (!hit) return;
  let evidence = `matched "${hit.matchedKeyword}" in "${paramName}"`;
  if (value !== undefined && value !== null && value !== '') {
    const vs = typeof value === 'object'
      ? JSON.stringify(value).slice(0, 40)
      : String(value).slice(0, 40);
    evidence += ` = ${vs}`;
  }
  _scanAdd(findings, seen, {
    category: hit.category,
    badge: hit.badge,
    severity: hit.severity,
    location,
    evidence,
  });
}

function _scanCheckSensitiveKey(key) {
  return /^(password|passwd|pwd|secret|private[_-]?key|client[_-]?secret)$/i.test(key);
}

function _scanCheckTokenKey(key) {
  return /^(api[_-]?key|access[_-]?token|secret)$/i.test(key);
}

// 파싱된 object/array를 walk하면서 field-name 기반 탐지기 적용.
function _scanWalkObject(obj, path, findings, seen) {
  if (typeof obj !== 'object' || obj === null) return;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => _scanWalkObject(v, `${path}[${i}]`, findings, seen));
    return;
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const fullPath = path ? `${path}.${k}` : k;
    const valStr = typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : '');
    if (typeof v === 'string' && v.length > 0) {
      if (_scanCheckSensitiveKey(k)) {
        _scanAdd(findings, seen, {
          category: 'sensitive', badge: '🔴 sensitive', severity: 'high',
          location: `response.body.${fullPath}`,
          evidence: `${k}: ${v.length > 20 ? '(' + v.length + ' chars)' : v}`,
        });
      }
      if (_scanCheckTokenKey(k)) {
        _scanAdd(findings, seen, {
          category: 'token', badge: '🔑 token', severity: 'high',
          location: `response.body.${fullPath}`,
          evidence: `${k}: ${valStr.length > 40 ? valStr.slice(0, 40) + '…' : valStr}`,
        });
      }
    }
    if (typeof v === 'object' && v !== null) {
      _scanWalkObject(v, fullPath, findings, seen);
    }
  }
}

function scanRequest(req) {
  const findings = [];
  const seen = new Set();

  // -------- Request URL: IDOR, privilege query params --------
  // (URL path 숫자 세그먼트 감지는 2026-04에 폐기: 빌드 timestamp,
  // 버전 번호, 광고 creative ID가 100% FP를 생산함.)
  try {
    const url = new URL(req.url);
    for (const [k, v] of url.searchParams) {
      if (_shouldFlagAsIdor(k, v)) {
        _scanAdd(findings, seen, {
          category: 'idor', badge: '🔢 IDOR', severity: 'info',
          location: `request.query.${k}`,
          evidence: `${k}=${v}`,
        });
      }
      if (_scanCheckPrivilegeKey(k)) {
        _scanAdd(findings, seen, {
          category: 'privilege', badge: '⚠️ privilege', severity: 'high',
          location: `request.query.${k}`,
          evidence: `${k}=${v}`,
        });
      }
      if (_scanCheckSessionKey(k) && v.length > 0) {
        _scanAdd(findings, seen, {
          category: 'session', badge: '🔐 session', severity: 'medium',
          location: `request.query.${k}`,
          evidence: `${k}: ${v.length > 20 ? '(' + v.length + ' chars)' : v}`,
        });
      }
      _scanAddHunt(findings, seen, `request.query.${k}`, k, v);
    }
  } catch { /* malformed url */ }

  // -------- Request body: privilege + IDOR + sensitive 파라미터 --------
  if (req.requestPostData && typeof req.requestPostData === 'string') {
    let parsed = null;
    try { parsed = JSON.parse(req.requestPostData); } catch {}
    if (parsed && typeof parsed === 'object') {
      const walk = (o, p) => {
        if (typeof o !== 'object' || o === null) return;
        if (Array.isArray(o)) { o.forEach((v, i) => walk(v, `${p}[${i}]`)); return; }
        for (const k of Object.keys(o)) {
          const fp = p ? `${p}.${k}` : k;
          const v = o[k];
          const evi = typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : v;
          if (_scanCheckPrivilegeKey(k)) {
            _scanAdd(findings, seen, {
              category: 'privilege', badge: '⚠️ privilege', severity: 'high',
              location: `request.body.${fp}`,
              evidence: `${k}: ${evi}`,
            });
          }
          if (_shouldFlagAsIdor(k, v)) {
            _scanAdd(findings, seen, {
              category: 'idor', badge: '🔢 IDOR', severity: 'info',
              location: `request.body.${fp}`,
              evidence: `${k}=${evi}`,
            });
          }
          if (_scanCheckSensitiveKey(k) && typeof v === 'string' && v.length > 0) {
            _scanAdd(findings, seen, {
              category: 'sensitive', badge: '🔴 sensitive', severity: 'high',
              location: `request.body.${fp}`,
              evidence: `${k}: ${v.length > 20 ? '(' + v.length + ' chars)' : v}`,
            });
          }
          if (_scanCheckSessionKey(k) && typeof v === 'string' && v.length > 0) {
            _scanAdd(findings, seen, {
              category: 'session', badge: '🔐 session', severity: 'medium',
              location: `request.body.${fp}`,
              evidence: `${k}: ${v.length > 20 ? '(' + v.length + ' chars)' : v}`,
            });
          }
          _scanAddHunt(findings, seen, `request.body.${fp}`, k, v);
          if (typeof v === 'object' && v !== null) walk(v, fp);
        }
      };
      walk(parsed, '');
    } else {
      try {
        const params = new URLSearchParams(req.requestPostData);
        for (const [k, v] of params) {
          if (_scanCheckPrivilegeKey(k)) {
            _scanAdd(findings, seen, {
              category: 'privilege', badge: '⚠️ privilege', severity: 'high',
              location: `request.body.${k}`,
              evidence: `${k}=${v}`,
            });
          }
          if (_shouldFlagAsIdor(k, v)) {
            _scanAdd(findings, seen, {
              category: 'idor', badge: '🔢 IDOR', severity: 'info',
              location: `request.body.${k}`,
              evidence: `${k}=${v}`,
            });
          }
          if (_scanCheckSensitiveKey(k) && v.length > 0) {
            _scanAdd(findings, seen, {
              category: 'sensitive', badge: '🔴 sensitive', severity: 'high',
              location: `request.body.${k}`,
              evidence: `${k}: ${v.length > 20 ? '(' + v.length + ' chars)' : v}`,
            });
          }
          if (_scanCheckSessionKey(k) && v.length > 0) {
            _scanAdd(findings, seen, {
              category: 'session', badge: '🔐 session', severity: 'medium',
              location: `request.body.${k}`,
              evidence: `${k}: ${v.length > 20 ? '(' + v.length + ' chars)' : v}`,
            });
          }
          _scanAddHunt(findings, seen, `request.body.${k}`, k, v);
        }
      } catch { /* form 아님 */ }
    }
  }

  // -------- Response status: 401/403 + 큰 body --------
  // text/html은 skip — SPA는 auth 실패 시 app shell/login 페이지를
  // 서빙. 정상 동작이지 finding이 아님.
  const isHtmlResp = (req.mimeType || '').toLowerCase().includes('text/html');
  if ((req.status === 401 || req.status === 403) &&
      req.responseBody && typeof req.responseBody === 'string' &&
      req.responseBody.length >= 1024 &&
      !isHtmlResp) {
    _scanAdd(findings, seen, {
      category: 'check', badge: '🔍 check', severity: 'info',
      location: `response.status=${req.status}, body=${req.responseBody.length}B`,
      evidence: `Status ${req.status} typically returns a short error message; this body is unusually long.`,
    });
  }

  // -------- Response headers: Server / X-Powered-By 버전 노출 --------
  if (req.responseHeaders) {
    for (const [name, value] of Object.entries(req.responseHeaders)) {
      const lname = name.toLowerCase();
      if (lname !== 'server' && lname !== 'x-powered-by') continue;
      const ver = _scanExtractServerVersion(value);
      if (ver) {
        _scanAdd(findings, seen, {
          category: 'exposure', badge: '📡 exposure', severity: 'medium',
          location: `response.header.${name}`,
          evidence: `${name}: ${ver}`,
        });
      }
    }
  }

  // -------- Response body: token/PII/leak/sensitive --------
  if (req.responseBody && typeof req.responseBody === 'string' && !req.responseBase64) {
    let body = req.responseBody;
    if (body.length > SCAN_BODY_LIMIT) body = body.slice(0, SCAN_BODY_TRUNCATE);

    // JWT 패턴 (eyJ로 시작 — `{"`의 base64url)
    const jwtMatches = body.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/);
    if (jwtMatches) {
      const tok = jwtMatches[0];
      // false positive 회피를 위해 기존 detectJWT로 검증
      if (detectJWT(tok)) {
        _scanAdd(findings, seen, {
          category: 'token', badge: '🔑 token', severity: 'high',
          location: `response.body (JWT-like)`,
          evidence: tok.slice(0, 60) + (tok.length > 60 ? '…' : ''),
        });
      }
    }

    // 이메일 — @localhost, @<ipv4>, 그리고 사실 파일 확장자인 TLD는
    // skip (예: "logo@2x.png"이 regex에 매치되지만 Retina 자산 파일명일
    // 뿐 PII 아님).
    const emailMatch = body.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    if (emailMatch) {
      const email = emailMatch[0];
      const domain = email.slice(email.indexOf('@') + 1);
      const tld = domain.split('.').pop().toLowerCase();
      const isLocalhost = /^localhost(:\d+)?$/i.test(domain);
      const isIpv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(domain);
      const isFileExt = EMAIL_FILE_EXT_DENY.has(tld);
      if (!isLocalhost && !isIpv4 && !isFileExt) {
        _scanAdd(findings, seen, {
          category: 'pii', badge: '👤 PII', severity: 'medium',
          location: `response.body (email)`,
          evidence: email,
        });
      }
    }
    // 한국 휴대폰 번호
    const phoneMatch = body.match(/01[016789]-\d{3,4}-\d{4}/);
    if (phoneMatch) {
      _scanAdd(findings, seen, {
        category: 'pii', badge: '👤 PII', severity: 'medium',
        location: `response.body (phone)`,
        evidence: phoneMatch[0],
      });
    }

    // 내부 IPv4 — regex로 dotted-quad 모양으로 좁히고, JS에서 octet
    // ≤ 255 + private-range prefix 검증 → 10.669.606.225 같은 숫자
    // 시퀀스가 false-positive 안 되도록.
    const ipCandidates = body.matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g);
    let internalIp = null;
    for (const m of ipCandidates) {
      const a = +m[1], b = +m[2], c = +m[3], d = +m[4];
      if (a > 255 || b > 255 || c > 255 || d > 255) continue;
      const isPrivate =
        a === 10 ||
        (a === 192 && b === 168) ||
        (a === 172 && b >= 16 && b <= 31);
      if (isPrivate) { internalIp = m[0]; break; }
    }
    if (internalIp) {
      _scanAdd(findings, seen, {
        category: 'leak', badge: '⚠️ leak', severity: 'medium',
        location: `response.body (internal IP)`,
        evidence: internalIp,
      });
    }
    // 스택트레이스 키워드
    const stackMatch = body.match(/\b(at Function|at Object|Traceback|NullPointerException|SQLException|stack trace)\b/i);
    if (stackMatch) {
      _scanAdd(findings, seen, {
        category: 'leak', badge: '⚠️ leak', severity: 'medium',
        location: `response.body (stack trace)`,
        evidence: stackMatch[0],
      });
    }
    // 서버 경로.
    // /home/ 정밀화: lowercase 글자로 시작해야 함(/home/_next,
    // /home/12345 제외), /home/foo/bar 같은 더 깊은 경로로 이어지면
    // 안 됨 — 그건 보통 server-side 파일시스템 참조가 아닌 URL
    // prefix.
    const pathMatch = body.match(/(\/var\/www|\/home\/[a-z][a-z0-9_-]*(?![\w\/])|C:\\Users|\/etc\/(?:passwd|shadow|hosts))/);
    if (pathMatch) {
      _scanAdd(findings, seen, {
        category: 'leak', badge: '⚠️ leak', severity: 'medium',
        location: `response.body (server path)`,
        evidence: pathMatch[0],
      });
    }

    // AWS access key ID — 고정 AKIA prefix + 16개 대문자 영숫자
    const awsMatch = body.match(/\bAKIA[A-Z0-9]{16}\b/);
    if (awsMatch) {
      _scanAdd(findings, seen, {
        category: 'exposure', badge: '📡 exposure', severity: 'high',
        location: `response.body (AWS access key)`,
        evidence: awsMatch[0],
      });
    }
    // GitHub PAT — ghp_ / gho_ / ghs_ prefix + 36+ 영숫자
    const ghMatch = body.match(/\b(ghp|gho|ghs)_[A-Za-z0-9]{36,}\b/);
    if (ghMatch) {
      _scanAdd(findings, seen, {
        category: 'exposure', badge: '📡 exposure', severity: 'high',
        location: `response.body (GitHub PAT)`,
        evidence: ghMatch[0].slice(0, 12) + '…',
      });
    }

    // 필드명 기반 스캔 — JSON에만 의미 있음
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed === 'object' && parsed !== null) {
        _scanWalkObject(parsed, '', findings, seen);
      }
    } catch { /* JSON 아님 */ }
  }

  return findings;
}

// network 리스트에 표시되는 작은 배지 cluster 렌더. 카테고리당 1개
// 배지로 dedupe, 모든 evidence를 나열하는 툴팁 포함.
function renderScanBadgesInline(scanResults) {
  if (!scanResults || scanResults.length === 0) return '';
  const byCat = {};
  scanResults.forEach(f => {
    if (!byCat[f.category]) byCat[f.category] = { badge: f.badge, evidences: [] };
    byCat[f.category].evidences.push(f.location + (f.evidence ? ` — ${f.evidence}` : ''));
  });
  return Object.entries(byCat).map(([cat, info]) =>
    `<span class="scan-badge scan-badge-${cat}" title="${escapeAttr(info.evidences.join('\n'))}">${escapeHtml(info.badge)}</span>`
  ).join(' ');
}

// Detection 탭에 표시되는 카테고리별 안내. 그룹 헤더(또는 안의 finding)
// 클릭으로 표시 토글 — finding 자체를 가리지 않도록 기본 숨김.
const DETECTION_CATEGORY_DESCRIPTIONS = {
  token:
    `응답 본문에 인증 토큰이 등장합니다.
본문으로 반환되는 토큰은 CDN 캐싱,
서버 로그, 공유된 HAR 파일을 통해
유출될 수 있습니다.
Replay 탭에서 이 토큰으로 다른 요청을
재전송하여 어떤 자원에 접근 가능한지
확인하세요.`,

  sensitive:
    `비밀번호 또는 민감 자격 증명이 검출되었습니다.
응답: 서버가 민감한 값을 본문에 포함시키고 있습니다.
요청: 받지 말아야 할 엔드포인트로 값이 전달되고
있을 수 있습니다.
엔드포인트와 값의 전송 경로를 검토하세요.`,

  pii:
    `응답에 개인정보로 보이는 데이터가 등장합니다.
인증 없이 접근 가능한지, 또는 다른 사용자의
데이터가 함께 반환되는지 확인하세요.
Replay 탭에서 자격 증명을 제거하거나 다른 계정
식별자로 재전송하세요.`,

  leak:
    `응답에 내부 정보가 등장합니다.
내부 IP, 서버 경로, 스택 트레이스 등은
운영 환경에서 노출되어선 안 됩니다.
의도적으로 유효하지 않은 입력을 보내
어떤 추가 정보가 드러나는지 확인하세요.`,

  exposure:
    `응답에 서버 소프트웨어 버전 또는 민감 키가
노출되었습니다.
버전 노출은 공격자가 알려진 취약점을 매핑하는 데
활용됩니다.
AWS 키 또는 GitHub PAT가 검출된 경우 즉시
유효성과 권한 범위를 확인하세요.`,

  idor:
    `ID 파라미터가 직접 객체 참조처럼 보입니다.
Replay 탭에서 ID를 변경해 재전송하여 다른
사용자의 데이터가 반환되는지 확인하세요.`,

  privilege:
    `role 또는 privilege 파라미터가 전송되고 있습니다.
서버가 클라이언트 제공 값을 그대로 신뢰하는지
확인하세요.
Replay 탭에서 값을 변경해 재전송하세요.
예: role=user → role=admin
    isAdmin=false → isAdmin=true`,

  session:
    `세션 또는 인증 토큰이 요청 파라미터로
전송되고 있습니다.
URL이나 요청 본문에 포함된 세션 ID는 서버 로그나
브라우저 히스토리를 통해 노출될 수 있습니다.
다른 세션 값으로 재전송하여 접근 통제가 올바르게
적용되는지 확인하세요.`,

  tampering:
    `서버측 로직에 영향을 줄 수 있는 파라미터가
이 요청에서 검출되었습니다.

Replay 탭에서 파라미터 값을 수정하고
서버 응답을 검토하세요.

테스트 패턴:
- 특수문자: ' " ; -- (SQL Injection)
- 경로 패턴: ../../../etc/passwd (Path Traversal)
- 외부 URL: https://169.254.169.254/ (SSRF)
- 명령 패턴: ; ls , | whoami (Command Injection)
- 템플릿 문법: {{7*7}} \${7*7} (SSTI)`,

  check:
    `응답 코드는 401/403인데 본문 크기가 예상보다
큽니다.
정상적인 인증 실패 응답은 짧은 에러 메시지만
담아야 합니다.
본문을 직접 확인하여 실패 응답에 민감 정보나
데이터가 함께 노출되는지 검사하세요.`,
};

// ============================================================
// Auth — login 요청 감지 + 안전성 검사 (MVP)
// ============================================================
// 휴리스틱 감지: {URL 패턴, body의 password 모양 필드, auth 색채 응답}
// 중 최소 2개 매치 시 login으로 보임. per-req `_authMarked`가 자동
// 감지를 override (사용자가 무엇이든 login으로 마킹하거나 false
// positive를 해제 가능).

// "이건 login 요청처럼 보임"용 path 전용 키워드 셋. 각 대안은
// leading slash로 anchor되고 trailing word boundary(또는 특정 확장자/
// suffix)로 제한 → /loginEvent나 /authority 같은 무관 토큰 매칭 회피.
// 새 프레임워크: 이 리스트만 확장, 다른 코드 변경 불필요.
const _AUTH_LOGIN_URL_RE = new RegExp([
  // login / signin / signon — Symfony의 `/login_check`, `/login_submit`
  // 등을 커버하기 위한 옵션 `_word` suffix.
  '\\/(?:login|signin|signon)(?:_\\w+)?\\b',
  // 하이픈/언더스코어 구분자
  '\\/sign[-_](?:in|on)\\b',
  // plain auth + authenticate
  '\\/auth\\b',
  '\\/authenticate\\b',
  // Session(s) — REST 스타일
  '\\/sessions?\\b',
  // OAuth2 / OIDC token + authorize 엔드포인트
  '\\/oauth\\/(?:token|authorize)\\b',
  '\\/connect\\/(?:token|authorize)\\b',
  // SSO / SAML
  '\\/sso(?:\\/|\\b)',
  '\\/saml\\b',
  // WordPress
  '\\/wp-login\\.php',
  // 명시적 token issue 경로
  '\\/token\\/issue\\b',
].join('|'), 'i');

// body 포맷에 걸친 password 필드 선언의 다양한 모양. 첫 매치 승리.
// form-urlencoded, JSON, XML 속성(예: `<Col id="userPw">…`), XML
// element, HTML form `name=` 커버. 흔한 타입 변종도 잡음
// (passwd / pwd / userPw / user_password).
const _AUTH_PASSWORD_FIELD_NAME = '(password|passwd|pwd|user_?password|user_?pw|userpw)';
const _AUTH_PASSWORD_PATTERNS = [
  // form-urlencoded: password=value
  new RegExp(`(?:^|[&\\n])${_AUTH_PASSWORD_FIELD_NAME}\\s*=`, 'i'),
  // JSON: "password": "value"
  new RegExp(`["']${_AUTH_PASSWORD_FIELD_NAME}["']\\s*:`, 'i'),
  // XML 속성: id="password" / name="userPw"
  new RegExp(`\\b(?:id|name)\\s*=\\s*["']${_AUTH_PASSWORD_FIELD_NAME}["']`, 'i'),
  // XML 요소: <password> 또는 <userPw>
  new RegExp(`<${_AUTH_PASSWORD_FIELD_NAME}[\\s>]`, 'i'),
];

// 정적 자산 확장자 — 이걸로 끝나는 경로는 파일명에 "login"이 들어있어도
// (예: /static/login.css) 절대 login 요청 아님. .do/.aspx/.php 같은
// 서버 측 실행 확장자는 명시적으로 이 리스트에 없음.
const _AUTH_STATIC_ASSET_RE = /\.(?:css|js|map|json|xml|html?|png|jpe?g|gif|svg|webp|woff2?|ttf|otf|eot|ico|mp[34]|webm|wav|ogg|pdf|zip|gz|br)$/i;

function _detectAuthSignals(req) {
  const signals = { url: false, body: false, response: false, signalsHit: [] };
  // 1) URL 패턴 (정적 자산 확장자는 skip)
  try {
    const u = new URL(req.url);
    if (!_AUTH_STATIC_ASSET_RE.test(u.pathname) && _AUTH_LOGIN_URL_RE.test(u.pathname)) {
      signals.url = true;
      signals.signalsHit.push(`URL path matches login pattern (${u.pathname})`);
    }
  } catch {}
  // 2) body에 password-like 필드 (form / JSON / XML)
  const body = req.requestPostData || '';
  if (body) {
    for (const re of _AUTH_PASSWORD_PATTERNS) {
      if (re.test(body)) {
        signals.body = true;
        signals.signalsHit.push('Request body contains a password-shaped field');
        break;
      }
    }
  }
  // 3) 응답이 auth-looking artifact 설정
  const respHeaders = req.responseHeaders || {};
  for (const [k, v] of Object.entries(respHeaders)) {
    if (k.toLowerCase() === 'set-cookie') {
      const lower = String(v).toLowerCase();
      if (/sess|auth|token|jwt|sid|jsessionid|asp\.net_sessionid/.test(lower)) {
        signals.response = true;
        signals.signalsHit.push(`Response sets auth-looking cookie (${String(v).split(';')[0]})`);
        break;
      }
    }
  }
  if (!signals.response) {
    const respBody = req.responseBody || '';
    // JWT 패턴
    if (/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/.test(respBody)) {
      signals.response = true;
      signals.signalsHit.push('Response body contains a JWT');
    } else if (/"(access_?token|id_?token|refresh_?token|session_?id|auth_?token)"\s*:/i.test(respBody)) {
      signals.response = true;
      signals.signalsHit.push('Response body contains an auth-token field');
    }
  }
  const score = (signals.url ? 1 : 0) + (signals.body ? 1 : 0) + (signals.response ? 1 : 0);
  // 어느 한 시그널만 있어도 high-confidence:
  //   * URL `/login`은 우연인 경우가 드뭄
  //   * request body의 password 필드는 항상 auth 시도를 의미
  // 로그인 실패는 응답 artifact를 안 보여주므로 그건 요구하지 않음 —
  // 점수만 올림.
  const isLogin = signals.url || signals.body;
  return { isLogin, signals, score };
}

function _isReqAuth(req) {
  if (req._authMarked === true) return true;
  if (req._authMarked === false) return false;
  return _detectAuthSignals(req).isLogin;
}

// Set-Cookie 헤더를 { name, value, attrs:{Secure, HttpOnly, SameSite} }로 파싱
function _parseSetCookies(req) {
  const headers = req.responseHeaders || {};
  const out = [];
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== 'set-cookie') continue;
    // 다중 쿠키: 줄바꿈으로 split (Chrome HAR이 하나로 collapse할 수
    // 있고, 쿠키 하나만 담은 단일 값도 수용)
    const lines = Array.isArray(v) ? v : String(v).split('\n');
    for (const line of lines) {
      if (!line) continue;
      const parts = line.split(';').map(p => p.trim());
      const [first, ...attrs] = parts;
      const eq = first.indexOf('=');
      const name = eq < 0 ? first : first.slice(0, eq);
      const value = eq < 0 ? '' : first.slice(eq + 1);
      const flags = { Secure: false, HttpOnly: false, SameSite: null };
      for (const a of attrs) {
        const lower = a.toLowerCase();
        if (lower === 'secure') flags.Secure = true;
        else if (lower === 'httponly') flags.HttpOnly = true;
        else if (lower.startsWith('samesite=')) flags.SameSite = a.split('=')[1];
      }
      out.push({ name, value, flags });
    }
  }
  return out;
}

// 요청에서 CSRF-ish 토큰 찾기: 프레임워크가 흔히 쓰는 헤더 또는 body
// 필드 이름. 발견 시 location 문자열 반환.
function _findCsrfToken(req) {
  const headers = req.requestHeaders || {};
  for (const k of Object.keys(headers)) {
    const lower = k.toLowerCase();
    if (lower === 'x-csrf-token' || lower === 'x-xsrf-token' ||
        lower === 'x-csrftoken' || lower === 'csrf-token') {
      return { where: 'header', name: k, value: headers[k] };
    }
  }
  const body = req.requestPostData || '';
  // form / json 필드
  const m = body.match(/(?:^|[&"'])([a-zA-Z_-]*csrf[a-zA-Z_-]*|authenticity_token)["']?[=:]\s*["']?([^&"'\s,}]*)/i);
  if (m) {
    return { where: 'body', name: m[1], value: m[2] };
  }
  return null;
}

// Auth 탭 표시용 JWT payload 디코드 (best-effort).
// 응답 body와 모든 응답 header 값을 스캔(Set-Cookie나 X-Auth-Token
// 같은 커스텀 auth 헤더로 전달된 JWT도 여기 노출 → auth 탐지기가
// 시그널로 세는 것과 일치). 어디에도 JWT 모양 문자열이 없으면 null.
// JWT 모양: header + payload는 JSON 객체, 둘 다 `eyJ`로 시작하는
// base64url-encoded. Signature는 `alg: none`이면 비어있을 수 있음.
// 길이 최소값은 느슨하게 유지 — 실제 토큰은 폭이 넓음(`{"alg":"HS256"}`
// 같은 작은 헤더는 20자만 디코드); 다운스트림 JSON 디코더가 파싱
// 안 되는 header/payload를 reject해서 random eyJ-prefixed 텍스트를
// 필터링.
const _AUTH_JWT_RE = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/;

function _extractJwtFromResponse(req) {
  const sources = [];
  if (req.responseBody) sources.push({ where: 'response body', text: req.responseBody });
  const headers = req.responseHeaders || {};
  for (const [k, v] of Object.entries(headers)) {
    if (!v) continue;
    const lower = k.toLowerCase();
    // Set-Cookie는 종종 줄바꿈으로 join된 단일 문자열로 도착 —
    // 각 쿠키를 개별 스캔하도록 split해서 source labelling을
    // 명확하게.
    const lines = lower === 'set-cookie' && typeof v === 'string'
      ? v.split('\n').filter(Boolean)
      : [Array.isArray(v) ? v.join(', ') : String(v)];
    for (const line of lines) {
      // Set-Cookie에는 가능한 경우 쿠키 이름으로 라벨.
      let label = `response header: ${k}`;
      if (lower === 'set-cookie') {
        const eq = line.indexOf('=');
        if (eq > 0) label = `Set-Cookie: ${line.slice(0, eq)}`;
      }
      sources.push({ where: label, text: line });
    }
  }
  const decode = (b64) => {
    try {
      const s = b64.replace(/-/g, '+').replace(/_/g, '/');
      const pad = s.length % 4 === 0 ? s : s + '='.repeat(4 - s.length % 4);
      return JSON.parse(atob(pad));
    } catch { return null; }
  };
  for (const src of sources) {
    const m = src.text.match(_AUTH_JWT_RE);
    if (!m) continue;
    const token = m[0];
    const parts = token.split('.');
    if (parts.length !== 3) continue;
    const header = decode(parts[0]);
    const payload = decode(parts[1]);
    // 진짜 JWT로 간주하려면 최소 하나의 파싱 가능 segment 필요 —
    // plain text의 random `eyJ`-prefixed 문자열이 끼어들면 안 됨.
    if (!header && !payload) continue;
    const issues = [];
    if (header && header.alg === 'none') issues.push('alg: none — token is unsigned');
    if (payload && payload.exp && payload.exp * 1000 < Date.now()) issues.push('Token is expired');
    return { token, header, payload, issues, source: src.where };
  }
  return null;
}

// per-request 단위 auth 테스트 결과 저장 (empty-pw / wrong-pw replay).
// requestId 키; 세션 동안 지속 → 탭을 다시 열어도 사용자가 방금
// 생성한 결과를 잃지 않음.
const _authTestResults = new Map();

function renderAuth(req) {
  const container = document.getElementById('detail-auth-body');
  const tabBtn = document.querySelector('.detail-tab[data-detail="auth"]');
  if (!container) return;

  const detect = _detectAuthSignals(req);
  const isLogin = _isReqAuth(req);
  const isMarked = req._authMarked === true;
  const isUnmarked = req._authMarked === false;

  if (tabBtn) {
    tabBtn.classList.toggle('has-findings', isLogin);
    if (isLogin) tabBtn.setAttribute('data-count', '🔐');
    else tabBtn.removeAttribute('data-count');
  }

  let html = '';

  // ---- Header 카드: 감지 상태 + 수동 마크 토글 ----
  html += `<div class="auth-card">`;
  if (isLogin) {
    html += `<div class="auth-state auth-state-on">🔐 로그인 요청${isMarked ? ' (수동 표시)' : ` (자동 감지, 점수 ${detect.score}/3)`}</div>`;
  } else {
    html += `<div class="auth-state auth-state-off">로그인 요청 아님${isUnmarked ? ' (수동 해제)' : ` (자동 감지, 점수 ${detect.score}/3)`}</div>`;
  }
  if (detect.signals.signalsHit.length > 0) {
    html += `<ul class="auth-signal-list">`;
    for (const s of detect.signals.signalsHit) html += `<li>${escapeHtml(s)}</li>`;
    html += `</ul>`;
  }
  html += `<button id="auth-mark-toggle" class="btn btn-xs">${isLogin ? '로그인 표시 해제' : '로그인으로 표시'}</button>`;
  html += `</div>`;

  if (isLogin) {
    // ---- JWT 분석 ----
    const jwt = _extractJwtFromResponse(req);
    html += `<div class="auth-card"><div class="auth-card-title">JWT</div>`;
    if (!jwt) {
      html += `<div class="auth-empty">응답 본문 또는 헤더에서 JWT를 찾지 못했습니다.</div>`;
    } else {
      html += `<div class="auth-kv"><b>source</b>: ${escapeHtml(jwt.source)}</div>`;
      html += `<pre class="auth-jwt-block">${escapeHtml(jwt.token.slice(0, 60))}…</pre>`;
      if (jwt.header) html += `<div class="auth-kv"><b>header.alg</b>: ${escapeHtml(String(jwt.header.alg || 'unknown'))}</div>`;
      if (jwt.payload) {
        if (jwt.payload.exp) {
          const expDate = new Date(jwt.payload.exp * 1000).toISOString();
          html += `<div class="auth-kv"><b>payload.exp</b>: ${escapeHtml(expDate)}</div>`;
        }
        if (jwt.payload.iss) html += `<div class="auth-kv"><b>payload.iss</b>: ${escapeHtml(String(jwt.payload.iss))}</div>`;
        if (jwt.payload.sub) html += `<div class="auth-kv"><b>payload.sub</b>: ${escapeHtml(String(jwt.payload.sub))}</div>`;
      }
      if (jwt.issues.length > 0) {
        html += `<ul class="auth-issue-list">`;
        for (const i of jwt.issues) html += `<li>⚠️ ${escapeHtml(i)}</li>`;
        html += `</ul>`;
      } else {
        html += `<div class="auth-ok">눈에 띄는 JWT 문제 없음.</div>`;
      }
    }
    html += `</div>`;

    // ---- Cookie 플래그 ----
    const cookies = _parseSetCookies(req);
    html += `<div class="auth-card"><div class="auth-card-title">Set-Cookie flags</div>`;
    if (cookies.length === 0) {
      html += `<div class="auth-empty">응답에서 설정된 쿠키가 없습니다.</div>`;
    } else {
      html += `<table class="auth-cookie-table"><thead><tr><th>Name</th><th>Secure</th><th>HttpOnly</th><th>SameSite</th></tr></thead><tbody>`;
      for (const c of cookies) {
        const sec = c.flags.Secure ? '<span class="auth-ok-tag">✓</span>' : '<span class="auth-bad-tag">✗</span>';
        const httpOnly = c.flags.HttpOnly ? '<span class="auth-ok-tag">✓</span>' : '<span class="auth-bad-tag">✗</span>';
        // SameSite 셀: 설정 시 값을 escaped 텍스트로 렌더; 누락 시
        // styled "none" 태그 렌더. 이전에는 fallback HTML이 escapeHtml
        // 을 거쳐 테이블에 리터럴 마크업으로 노출됐음.
        const ss = c.flags.SameSite
          ? escapeHtml(c.flags.SameSite)
          : '<span class="auth-bad-tag">none</span>';
        html += `<tr><td>${escapeHtml(c.name)}</td><td>${sec}</td><td>${httpOnly}</td><td>${ss}</td></tr>`;
      }
      html += `</tbody></table>`;
    }
    html += `</div>`;

    // ---- CSRF 토큰 ----
    const csrf = _findCsrfToken(req);
    html += `<div class="auth-card"><div class="auth-card-title">CSRF token</div>`;
    if (csrf) {
      html += `<div class="auth-ok"><b>${escapeHtml(csrf.where)}</b>에서 발견 — <code>${escapeHtml(csrf.name)}</code> = <code>${escapeHtml(String(csrf.value).slice(0, 24))}…</code></div>`;
    } else {
      html += `<div class="auth-warn">CSRF 토큰이 검출되지 않았습니다. CSRF 보호가 없는 상태 변경 엔드포인트는 SameSite 쿠키 의존성과 origin 검증을 함께 검토해야 합니다.</div>`;
    }
    html += `</div>`;

    // ---- Test 버튼 + 결과 ----
    html += `<div class="auth-card"><div class="auth-card-title">Tests</div>`;
    html += `<div class="auth-test-row">
      <button id="auth-test-empty-pw" class="btn btn-xs">테스트: 빈 비밀번호</button>
      <button id="auth-test-wrong-pw" class="btn btn-xs">테스트: 잘못된 비밀번호</button>
    </div>`;
    html += `<div id="auth-test-result" class="auth-test-result"></div>`;
    html += `<div class="auth-warn-small">각 테스트는 1회 replay를 발사합니다. 권한이 있는 시스템에서만 실행하세요 — 엄격한 시스템에서는 반복된 비밀번호 오류가 계정 잠금을 유발할 수 있습니다.</div>`;
    html += `</div>`;

    // 이전 테스트 결과가 있으면 복원
    const prev = _authTestResults.get(req.requestId);
    if (prev) {
      // innerHTML 설정 후 렌더
    }
  }

  container.innerHTML = html;

  // 버튼 핸들러 wire up
  const markBtn = document.getElementById('auth-mark-toggle');
  if (markBtn) {
    markBtn.addEventListener('click', () => {
      // 토글: marked → unmarked, unmarked → marked, undefined → 자동의 반대
      if (req._authMarked === true) req._authMarked = false;
      else if (req._authMarked === false) req._authMarked = true;
      else req._authMarked = !detect.isLogin;
      renderAuth(req);
      // row의 URL 셀 갱신 → 전체 테이블 재렌더 대기 없이 🔐 배지가
      // 즉시 나타나거나 사라지도록.
      updateNetworkRowAuth(req);
    });
  }

  if (isLogin) {
    const emptyBtn = document.getElementById('auth-test-empty-pw');
    if (emptyBtn) emptyBtn.addEventListener('click', () => _runAuthTest(req, 'empty'));
    const wrongBtn = document.getElementById('auth-test-wrong-pw');
    if (wrongBtn) wrongBtn.addEventListener('click', () => _runAuthTest(req, 'wrong'));
    const resultEl = document.getElementById('auth-test-result');
    if (resultEl) {
      const prev = _authTestResults.get(req.requestId);
      if (prev) resultEl.innerHTML = _renderAuthTestResult(prev);
    }
  }
}

// 요청 body의 password 필드 변형 — JSON, form-urlencoded, XML
// (id="userPw" 같은 XML 속성 포함) 처리. body 모양이 인식되지 않으면
// no-op으로 fallback.
function _mutatePasswordField(body, mode) {
  if (!body) return body;
  const replacement = mode === 'empty' ? '' : '__dtpp_wrong_' + Math.random().toString(36).slice(2, 10);
  const isPwName = (name) => /^(password|passwd|pwd|user_?password|user_?pw|userpw)$/i.test(name);

  // JSON
  try {
    const obj = JSON.parse(body);
    let touched = false;
    const recurse = (o) => {
      if (!o || typeof o !== 'object') return;
      for (const k of Object.keys(o)) {
        if (isPwName(k)) {
          o[k] = replacement;
          touched = true;
        } else if (typeof o[k] === 'object') {
          recurse(o[k]);
        }
      }
    };
    recurse(obj);
    if (touched) return JSON.stringify(obj);
  } catch {}

  // XML (Nexacro <Col id="userPw">…</Col>, generic <password>…</password>,
  // 또는 <Col name="password">…</Col>). Element-by-attribute와 naked
  // element 형태 둘 다 커버.
  if (/<\?xml|<\s*\w+[^>]*xmlns/i.test(body)) {
    let out = body;
    let touched = false;
    // <Tag id|name="userPw">value</Tag> → value 교체
    out = out.replace(
      /(<\w+[^>]*\b(?:id|name)\s*=\s*["'])([^"']+)(["'][^>]*>)([^<]*)(<\/\w+>)/gi,
      (full, openStart, attrName, openEnd, inner, close) => {
        if (isPwName(attrName)) {
          touched = true;
          return openStart + attrName + openEnd + replacement + close;
        }
        return full;
      }
    );
    // <password>value</password>
    out = out.replace(
      /<(password|passwd|pwd|user_?password|user_?pw|userpw)>([^<]*)<\/\1>/gi,
      (full, name) => { touched = true; return `<${name}>${replacement}</${name}>`; }
    );
    if (touched) return out;
  }

  // Form-urlencoded
  if (body.includes('=')) {
    const fields = body.split('&').map(p => {
      const eq = p.indexOf('=');
      if (eq < 0) return p;
      let name;
      try { name = decodeURIComponent(p.slice(0, eq).replace(/\+/g, ' ')); } catch { name = p.slice(0, eq); }
      if (isPwName(name)) {
        return p.slice(0, eq + 1) + encodeURIComponent(replacement);
      }
      return p;
    });
    return fields.join('&');
  }

  return body;
}

function _runAuthTest(originalReq, mode) {
  const resultEl = document.getElementById('auth-test-result');
  if (resultEl) resultEl.innerHTML = `<div class="auth-test-pending">Running ${escapeHtml(mode === 'empty' ? 'empty password' : 'wrong password')} test...</div>`;
  const headers = {};
  const captured = originalReq.requestHeaders || {};
  for (const [k, v] of Object.entries(captured)) {
    if (k.startsWith(':')) continue;
    if (/^(host|content-length)$/i.test(k)) continue;
    headers[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  const mutatedBody = _mutatePasswordField(originalReq.requestPostData || '', mode);
  const payload = {
    method: originalReq.method,
    url: originalReq.url,
    headers,
    body: mutatedBody || null,
  };
  // 이 발화를 태그 → processNetworkRequest가 매칭 캡처를 Monitor
  // 리스트에서 드롭하도록. auth 테스트는 내부 probe라 사용자
  // 트래픽이 아니고 타임라인을 오염시키면 안 됨.
  _markAuthTestFired(payload.url, payload.method);
  // Replay가 쓰는 page-context fetch 경로 재사용. 결과는 message-tab
  // response slot으로 가지만 여기서도 괜찮음 — polling 표현식으로
  // 직접 캡처.
  const callbackId = '__authtest_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const expr = `(function() {
    window['${callbackId}'] = null;
    var t0 = performance.now();
    fetch(${JSON.stringify(payload.url)}, {
      method: ${JSON.stringify(payload.method)},
      headers: ${JSON.stringify(payload.headers)},
      body: ${payload.body != null ? JSON.stringify(payload.body) : 'null'},
      credentials: 'include',
      redirect: 'follow'
    }).then(function(resp) {
      var elapsed = Math.round(performance.now() - t0);
      return resp.text().then(function(text) {
        window['${callbackId}'] = JSON.stringify({
          ok: true, status: resp.status, statusText: resp.statusText, body: text, time: elapsed
        });
      });
    }).catch(function(e) {
      window['${callbackId}'] = JSON.stringify({ ok: false, error: e.message });
    });
  })()`;
  chrome.devtools.inspectedWindow.eval(expr, () => {
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      if (attempts > 200) {
        clearInterval(poll);
        if (resultEl) resultEl.innerHTML = `<div class="auth-test-fail">Timed out (20s)</div>`;
        return;
      }
      chrome.devtools.inspectedWindow.eval(`window['${callbackId}']`, (raw) => {
        if (raw == null) return;
        clearInterval(poll);
        chrome.devtools.inspectedWindow.eval(`delete window['${callbackId}']`);
        let parsed;
        try { parsed = JSON.parse(raw); } catch { return; }
        const result = {
          mode,
          ok: parsed.ok,
          status: parsed.status,
          statusText: parsed.statusText,
          time: parsed.time,
          bodyLen: (parsed.body || '').length,
          bodyPreview: (parsed.body || '').slice(0, 200),
          originalStatus: originalReq.status,
          // 캡처된 원본 body를 스냅샷 → 결과 렌더가 body 내용을
          // 테스트 응답과 diff할 수 있도록. 많은 API가 auth 실패에도
          // HTTP 200으로 응답(RESTful "200 + body의 error")하므로
          // status만 비교하면 그것들을 성공으로 잘못 플래그함.
          originalBody: originalReq.responseBodyLoaded ? (originalReq.responseBody || '') : null,
          testBody: parsed.body || '',
          error: parsed.error,
        };
        _authTestResults.set(originalReq.requestId, result);
        if (resultEl) resultEl.innerHTML = _renderAuthTestResult(result);
      });
    }, 100);
  });
}

function _renderAuthTestResult(r) {
  if (!r.ok) {
    return `<div class="auth-test-fail">테스트 (${escapeHtml(r.mode)}) 실패: ${escapeHtml(r.error || 'unknown')}</div>`;
  }
  // 서버가 잘못된 시도와 원본 성공 응답을 구분했다면 status 또는 body 중
  // 어느 하나라도 달라야 함. status만 비교하면 HTTP 200으로 응답하면서
  // 본문에 RESTful 에러 봉투를 담는 API({"resType":"RES_ERROR"} 등)를
  // 놓치게 됨.
  const sameStatus = r.status === r.originalStatus;
  let verdict;
  if (!sameStatus) {
    verdict = '<span class="auth-ok-tag">✓ 응답 다름 (status 변경)</span>';
  } else if (r.originalBody == null) {
    // status는 같지만 원본 본문을 로드한 적이 없음 → body 레벨 비교 불가.
    // 추측 대신 모호성 그대로 보고.
    verdict = '<span class="auth-warn-tag">⚠ status 동일 · 비교용 원본 body 없음</span>';
  } else if (r.testBody === r.originalBody) {
    verdict = '<span class="auth-warn-tag">⚠ 응답 동일 — 서버가 구분하지 못함</span>';
  } else {
    verdict = '<span class="auth-ok-tag">✓ 응답 다름 (body 변경)</span>';
  }
  return `<div class="auth-test-ok">
    <div><b>테스트:</b> ${escapeHtml(r.mode === 'empty' ? '빈 비밀번호' : '잘못된 비밀번호')}</div>
    <div><b>원본 status:</b> ${escapeHtml(String(r.originalStatus))} → <b>테스트 status:</b> ${escapeHtml(String(r.status))} ${escapeHtml(r.statusText || '')} ${verdict}</div>
    <div><b>소요 시간:</b> ${escapeHtml(String(r.time))}ms · <b>본문:</b> ${escapeHtml(String(r.bodyLen))} bytes</div>
    <div class="auth-body-preview"><b>본문 미리보기:</b> ${escapeHtml(r.bodyPreview)}${r.bodyLen > 200 ? '…' : ''}</div>
  </div>`;
}

function renderDetection(req) {
  const container = document.getElementById('detail-detection-body');
  const tabBtn = document.querySelector('.detail-tab[data-detail="detection"]');
  if (tabBtn) {
    tabBtn.classList.remove('has-findings');
    tabBtn.removeAttribute('data-count');
  }
  if (!container) return;
  const results = req.scanResults || [];
  if (results.length === 0) {
    container.innerHTML = '<div class="detail-loading">No scanner findings.</div>';
    return;
  }
  if (tabBtn) {
    tabBtn.classList.add('has-findings');
    tabBtn.dataset.count = results.length;
  }
  // 카테고리별 그룹, 그 다음 그룹 내 최대 severity로 카테고리 정렬
  const sevOrder = { high: 0, medium: 1, low: 2, info: 3 };
  const groups = {};
  results.forEach(f => {
    if (!groups[f.category]) groups[f.category] = { badge: f.badge, items: [], maxSev: f.severity };
    groups[f.category].items.push(f);
    if (sevOrder[f.severity] < sevOrder[groups[f.category].maxSev]) {
      groups[f.category].maxSev = f.severity;
    }
  });
  const sortedCats = Object.entries(groups).sort((a, b) => sevOrder[a[1].maxSev] - sevOrder[b[1].maxSev]);
  let html = '';
  for (const [cat, g] of sortedCats) {
    const desc = DETECTION_CATEGORY_DESCRIPTIONS[cat];
    const descBlock = desc
      ? `<div class="detection-category-desc hidden">${escapeHtml(desc)}</div>`
      : '';
    const toggleHint = desc ? '<span class="detection-group-toggle">▾</span>' : '';
    html += `<div class="detection-group" data-category="${cat}">
      <div class="detection-group-header">
        <span class="scan-badge scan-badge-${cat}">${escapeHtml(g.badge)}</span>
        <span class="detection-group-count">${g.items.length} finding${g.items.length === 1 ? '' : 's'}</span>
        ${toggleHint}
      </div>
      ${descBlock}
      <div class="detection-findings">`;
    for (const f of g.items) {
      html += `<div class="detection-finding severity-${f.severity}">
        <div class="detection-finding-top">
          <span class="detection-severity sev-${f.severity}">${f.severity.toUpperCase()}</span>
          <span class="detection-location">${escapeHtml(f.location)}</span>
        </div>
        <div class="detection-evidence">${escapeHtml(f.evidence || '')}</div>
      </div>`;
    }
    html += `</div></div>`;
  }
  container.innerHTML = html;

  // 그룹 헤더 또는 안의 finding 클릭 → 그 그룹의 카테고리 description
  // 토글. description 자체 안의 클릭은 무시 → 사용자가 안내에서 텍스트
  // 복사 가능하도록.
  container.addEventListener('click', _onDetectionGroupClick, { once: false });
}

function _onDetectionGroupClick(e) {
  if (e.target.closest('.detection-category-desc')) return;
  const group = e.target.closest('.detection-group');
  if (!group) return;
  const desc = group.querySelector('.detection-category-desc');
  if (!desc) return;
  desc.classList.toggle('hidden');
  const toggle = group.querySelector('.detection-group-toggle');
  if (toggle) toggle.textContent = desc.classList.contains('hidden') ? '▾' : '▴';
}

// 속성에 안전한 HTML escape (escapeHtml 이상 — 속성은 quote 문자도
// 처리해야 함).
function escapeAttr(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Message 탭의 replay 결과 diff가 사용하는 재귀 JSON diff. 두 트리를
// 동기적으로 walk하면서 add/remove/changed 행 emit. 예전 Replay 탭에서
// 재사용 — 같은 구조가 새 replay diff 배지 안에 렌더.
function generateJsonDiff(orig, curr, path) {
  path = path || '';
  const lines = [];
  if (typeof orig !== typeof curr) {
    lines.push(`<div class="diff-changed header-row"><span class="header-name">${escapeHtml(path || '(root)')}</span><span class="header-value"><span class="status-error">${escapeHtml(JSON.stringify(orig))}</span> → <span class="status-ok">${escapeHtml(JSON.stringify(curr))}</span></span></div>`);
    return lines.join('');
  }
  if (orig === null || curr === null || typeof orig !== 'object') {
    if (orig !== curr) {
      lines.push(`<div class="diff-changed header-row"><span class="header-name">${escapeHtml(path || '(root)')}</span><span class="header-value"><span class="status-error">${escapeHtml(JSON.stringify(orig))}</span> → <span class="status-ok">${escapeHtml(JSON.stringify(curr))}</span></span></div>`);
    }
    return lines.join('');
  }
  const allKeys = new Set([...Object.keys(orig), ...Object.keys(curr)]);
  for (const key of allKeys) {
    const subPath = path ? `${path}.${key}` : key;
    if (!(key in orig)) {
      lines.push(`<div class="diff-added header-row"><span class="header-name">+ ${escapeHtml(subPath)}</span><span class="header-value">${escapeHtml(JSON.stringify(curr[key]))}</span></div>`);
    } else if (!(key in curr)) {
      lines.push(`<div class="diff-removed header-row"><span class="header-name">- ${escapeHtml(subPath)}</span><span class="header-value">${escapeHtml(JSON.stringify(orig[key]))}</span></div>`);
    } else {
      const sub = generateJsonDiff(orig[key], curr[key], subPath);
      if (sub) lines.push(sub);
    }
  }
  return lines.join('');
}


// ============================================================
// 1c. Intercept (Native Messaging + 로컬 MITM 통한 Proxy 모드)
// ============================================================

let interceptActive = false;
const reqQueue = [];
const respQueue = [];
const interceptLog = [];
let selectedReqId = null;
let selectedRespId = null;
let activeSide = 'req'; // 'req' 또는 'resp' — 단축키 대상

// 사용자가 request side에서 forward하고 응답을 기다리는 중인 request
// ID. 매칭 response intercept가 발화하면 자동으로 response side로
// 전환 → 사용자가 제목을 수동 클릭하지 않고도 처리 가능.
const _icptExpectingResp = new Set();
let interceptBypassRegex = null;

const icptToggleBtn = document.getElementById('icpt-toggle');
const reqQueueEl = document.getElementById('icpt-req-queue');
const respQueueEl = document.getElementById('icpt-resp-queue');
const icptLogEl = document.getElementById('icpt-log');
const reqBadge = document.getElementById('icpt-req-badge');
const respBadge = document.getElementById('icpt-resp-badge');
const reqEditorContent = document.getElementById('icpt-req-editor-content');
const respEditorContent = document.getElementById('icpt-resp-editor-content');
const reqPlaceholder = document.getElementById('icpt-req-placeholder');
const respPlaceholder = document.getElementById('icpt-resp-placeholder');
const interceptTabBtn = document.querySelector('.intercept-tab');
const icptProxyStatus = document.getElementById('icpt-proxy-status');

// activeSide 전환은 side header로만 — 에디터 본체 안 클릭은 side를
// 활성화하면서 동시에 textarea에 focus되어 후속 단축키(F/G/D/R/A/Q)가
// action 트리거 대신 본체에 타이핑됨. 트리거를 header로 제한하면
// 활성화가 의도적인 제스처로 유지됨.
function setActiveIcptSide(side) {
  if (side !== 'req' && side !== 'resp') return;
  activeSide = side;
  document.querySelectorAll('.icpt-side').forEach(s => {
    s.classList.toggle('active-side', s.dataset.side === side);
  });
}
document.querySelectorAll('.icpt-side-header').forEach(header => {
  header.addEventListener('click', () => {
    const side = header.parentElement && header.parentElement.dataset.side;
    if (side) setActiveIcptSide(side);
  });
});
// 초기 active side
setActiveIcptSide('req');

// Background Service Worker port 연결 (자동 재연결)
let bgPort = null;
// 일회성 kill switch. 이 DevTools 패널이 열린 채로 확장이
// reload/update/disable되면, orphaned 패널의 모든 chrome.runtime.*
// 호출이 "Extension context invalidated"를 throw. 재시도하면 무한히
// 돌면서 확장 에러 로그를 flood; 패널 복구 유일한 방법은 DevTools
// 닫고 다시 열기.
let bgReconnectStopped = false;

function isContextInvalidated(err) {
  const msg = (err && err.message) || (typeof err === 'string' ? err : '');
  return /Extension context invalidated|context.*invalidated/i.test(msg);
}

// 확장이 reload된 뒤 패널에서의 storage write도 chrome.runtime.*
// 와 같은 "Extension context invalidated"를 throw. 그 상태에서 silently
// no-op하도록 wrap (그리고 throw하면 kill switch도 뒤집어서 runtime
// 탐지기가 아직 못 잡은 경우에도 대비).
function safeStorageSet(obj) {
  if (bgReconnectStopped) return;
  if (!chrome.storage || !chrome.storage.local) return;
  try {
    chrome.storage.local.set(obj);
  } catch (err) {
    if (isContextInvalidated(err)) bgReconnectStopped = true;
  }
}

function safeStorageGet(keys, callback) {
  if (bgReconnectStopped) return;
  if (!chrome.storage || !chrome.storage.local) return;
  try {
    chrome.storage.local.get(keys, callback);
  } catch (err) {
    if (isContextInvalidated(err)) bgReconnectStopped = true;
  }
}

function connectBgPort() {
  if (bgReconnectStopped) return;
  try {
    bgPort = chrome.runtime.connect({ name: `panel-${tabId}` });
  } catch (err) {
    if (isContextInvalidated(err)) {
      bgReconnectStopped = true;
      // console.log 사용(warn/error 아님) → chrome://extensions 에러
      // 페이지에 노출 안 됨. context invalidation은 DevTools가 열린
      // 채로 확장 reload 시의 일상적 결과고, 사용자 복구는 DevTools
      // 닫고 다시 열기뿐 — 어차피 그렇게 할 거라.
      console.log('[DevTools++] Extension context invalidated. Close and reopen DevTools to reconnect.');
      return;
    }
    // 알 수 없는 에러 — back off 후 한 번 더 시도.
    bgPort = null;
    setTimeout(connectBgPort, 500);
    return;
  }

  bgPort.onMessage.addListener(handleBgMessage);

  bgPort.onDisconnect.addListener(() => {
    bgPort = null;
    const lastErr = chrome.runtime.lastError;
    if (lastErr && isContextInvalidated(lastErr)) {
      bgReconnectStopped = true;
      return;
    }
    // Service Worker idle-restart이 흔한 케이스 — 잠깐 기다렸다 재연결.
    setTimeout(connectBgPort, 500);
  });
}

function sendToBg(msg) {
  if (bgReconnectStopped) return;
  if (!bgPort) {
    connectBgPort();
    if (bgReconnectStopped || !bgPort) return;
  }
  try {
    bgPort.postMessage(msg);
  } catch (err) {
    if (isContextInvalidated(err)) {
      bgReconnectStopped = true;
      return;
    }
    bgPort = null;
    connectBgPort();
    if (bgReconnectStopped || !bgPort) return;
    try { bgPort.postMessage(msg); } catch {}
  }
}

function handleBgMessage(msg) {
  switch (msg.type) {
    case 'host_ready':
      updateProxyStatus('ready', 'Proxy: Ready');
      break;

    case 'proxy_started':
      updateProxyStatus('active', `Proxy: :${msg.port}`);
      break;

    case 'proxy_stopped':
      updateProxyStatus('idle', 'Proxy: Stopped');
      break;

    case 'intercept_paused':
      updateProxyStatus('idle', 'Proxy: Paused');
      break;

    case 'native_disconnected':
      updateProxyStatus('error', 'Proxy: Disconnected');
      if (interceptActive) {
        stopIntercept();
      }
      break;

    case 'send_to_browser_error':
      showToast(`Send to Browser failed: ${msg.message || 'unknown'}`);
      break;

    case 'native_error':
    case 'proxy_error':
    case 'proxy_settings_error':
      updateProxyStatus('error', `Error: ${msg.message || ''}`);
      if (msg.type === 'native_error' && !interceptActive) {
        showSetupHint();
      }
      break;

    case 'request_intercepted':
      handleProxyInterceptedRequest(msg);
      break;

    case 'response_captured':
      handleResponseCaptured(msg);
      break;

    case 'response_intercepted':
      handleResponseIntercepted(msg);
      break;

    case 'request_timeout': {
      // 캡처된 스냅샷에서 method/url 가져오기 → log 행이 빈
      // / / time 문자열 대신 timeout된 항목을 표시.
      const cap = capturedRequests.get(msg.id);
      upsertInterceptLog(msg.id, {
        action: 'timeout',
        method: cap ? cap.method : '',
        url: cap ? cap.url : '',
      });
      break;
    }

    case 'pong':
      updateProxyStatus('active', `Proxy: ${msg.pendingCount || 0} pending`);
      break;

    case 'status':
      if (msg.listening) {
        updateProxyStatus('active', `Proxy: :${msg.port} (${msg.pendingCount} pending)`);
      }
      break;

    case 'error':
      console.warn('[DevTools++] Proxy error:', msg.message);
      break;
  }
}

connectBgPort();

function updateProxyStatus(state, text) {
  // caller가 쓰는 중복된 "Proxy: " prefix 제거 — pill이 이미 Intercept
  // 토글 옆에 있어서 맥락이 분명함.
  icptProxyStatus.textContent = text.replace(/^Proxy:\s*/, '') || text;
  icptProxyStatus.classList.remove('status-active', 'status-warn', 'status-error');
  if (state === 'active') icptProxyStatus.classList.add('status-active');
  else if (state === 'error') icptProxyStatus.classList.add('status-error');
}

function showSetupHint() {
  const setupUrl = chrome.runtime.getURL('setup.html');
  const hint = `<div style="text-align:center">
    <p style="color:#d32f2f;font-weight:600;margin-bottom:8px">Native Messaging host is not installed.</p>
    <p style="color:#666;margin-bottom:12px">Intercept requires a one-time setup.</p>
    <a href="${setupUrl}" target="_blank"
      style="display:inline-block;padding:8px 20px;background:#0078d4;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;font-size:13px">
      Open Setup Guide
    </a>
  </div>`;
  const reqPlaceholder = document.getElementById('icpt-req-placeholder');
  if (reqPlaceholder) reqPlaceholder.innerHTML = hint;
  const respPlaceholder = document.getElementById('icpt-resp-placeholder');
  if (respPlaceholder) respPlaceholder.innerHTML = hint;
}

// 와일드카드 URL 필터를 regex로 변환.
// 패턴은 host+pathname에 대해서만 매칭(프로토콜 없음, query/hash 없음)
// → 쿼리 스트링 내용(예: 페이지 URL을 담은 tracker 페이로드)이 매치를
// 오염시킬 수 없음.
// 입력:  "*.site.com, api.example.com/v1/*"
// 출력:  "(^[^/]*\.site\.com)|(api\.example\.com/v1/.*)" (regex 문자열)
function urlFilterToRegex(input) {
  if (!input) return '';
  const patterns = input.split(',').map(p => p.trim()).filter(Boolean);
  if (patterns.length === 0) return '';
  const regexParts = patterns.map(p => {
    // 와일드카드(*) → 플레이스홀더 치환, 특수문자 escape, 복원
    const PH = '\x00WILD\x00';
    let r = p.replace(/\*/g, PH);
    r = r.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); // regex 특수문자 escape
    r = r.replace(new RegExp(PH.replace(/\x00/g, '\\x00'), 'g'), '.*'); // 플레이스홀더 → .*
    // *.domain 패턴: host 시작에 anchor (프로토콜 없음 — 매칭 전에 제거함)
    if (p.startsWith('*.')) {
      r = '^[^/]*' + r.slice(2); // leading .* 제거 후 [^/]*로 교체
    }
    return '(' + r + ')';
  });
  return regexParts.join('|');
}

// protocol/query/hash 제거 → 필터가 host + pathname만 보도록.
// host는 port가 있으면 포함; noPort 변종은 port 제거. 두 형태 모두
// inGlobalScope에 공급되어 port 없는 패턴도 비표준 port를 가진 URL에
// 매칭 가능.
function _filterTarget(url) {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return url;
  }
}

function _filterTargetNoPort(url) {
  try {
    const u = new URL(url);
    return u.hostname + u.pathname;
  } catch {
    return url;
  }
}

// Global scope — Site Map, Network 모니터링, Intercept 전반에 걸친
// URL 필터링의 single source of truth. 수집 시점에 적용: 스코프 밖
// 요청은 Site Map/Network 리스트에 들어가지 않고, 프록시는 Intercept
// 용으로 bypass. 빈 스코프 = 전 범위 in scope.
// applyGlobalScope()(Apply 버튼/Enter/startIntercept)로만 업데이트.
let globalScope = { input: '', regex: null };

function inGlobalScope(url) {
  if (!globalScope.regex) return true;
  const withPort = _filterTarget(url);
  if (globalScope.regex.test(withPort)) return true;
  // port 없이 재시도 → "*.site.com/*" 같은 패턴이 비표준 port를 가진
  // URL(site.com:48081)에도 매칭. ":<port>"를 명시적으로 포함하는
  // 패턴은 with-port 형태에서 첫 번째 패스로 여전히 매칭.
  const noPort = _filterTargetNoPort(url);
  return noPort !== withPort && globalScope.regex.test(noPort);
}

// 입력에서 regex 빌드, scope 업데이트, (intercept 중이면) proxy에
// push, 그리고 scope에 의존하는 뷰들 refresh.
function applyGlobalScope() {
  const input = document.getElementById('global-scope-input').value.trim();
  const pattern = urlFilterToRegex(input);
  try {
    globalScope = { input, regex: pattern ? new RegExp(pattern, 'i') : null };
  } catch {
    globalScope = { input, regex: null };
  }
  if (interceptActive) {
    sendToBg({
      type: 'update_config',
      config: {
        urlFilter: pattern,
        methodFilter: document.getElementById('icpt-method-filter').value,
      }
    });
  }
  refreshGlobalScopeButtonState();
  flashGlobalScopeApply();
  // Scope는 view 필터이기도 함 — Network 리스트와 트리 재렌더해서
  // 이미 캡처된 데이터가 새 패턴을 즉시 반영하도록.
  // matchesSitemapFilters는 같은 경로로 inGlobalScope를 참조.
  renderNetworkTable();
  // selection은 Scope 변경 사이에 지속되지만 master 체크박스의
  // visible-vs-selected 비율은 지금 보이는 행에 따라 달라짐.
  updateSelectionUI();
  renderSitemapTree();
  // 검색은 Scope와 AND, 따라서 Scope 변경이 매칭 집합에서 요청을 in/out
  // 으로 뒤집을 수 있음.
  if (searchTerm) {
    recomputeSearchMatches();
    refreshAllRowDots();
    refreshSearchUI();
  }
  // 마지막 적용 패턴을 persist → DevTools가 닫혀 있어도 action popup이
  // 표시할 수 있도록.
  safeStorageSet({ globalScopeInput: input });
}

// 입력값과 적용값이 다르면 Apply 버튼에 dirty 강조 토글.
function refreshGlobalScopeButtonState() {
  const current = document.getElementById('global-scope-input').value.trim();
  const btn = document.getElementById('global-scope-apply');
  if (current !== globalScope.input) {
    btn.classList.add('scope-apply-dirty');
  } else {
    btn.classList.remove('scope-apply-dirty');
  }
}

// Apply 성공 확인용 짧은 초록 flash.
function flashGlobalScopeApply() {
  const btn = document.getElementById('global-scope-apply');
  btn.classList.add('scope-apply-flash');
  setTimeout(() => btn.classList.remove('scope-apply-flash'), 350);
}

// Global scope 바 이벤트 wire up
document.getElementById('global-scope-apply').addEventListener('click', applyGlobalScope);
document.getElementById('global-scope-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); applyGlobalScope(); }
});
document.getElementById('global-scope-input').addEventListener('input', refreshGlobalScopeButtonState);
document.getElementById('global-scope-clear').addEventListener('click', () => {
  document.getElementById('global-scope-input').value = '';
  applyGlobalScope();
});

// 임의의 scope 패턴 적용 (트리의 Set Scope 드롭다운이 사용).
function applyScopePattern(pattern) {
  document.getElementById('global-scope-input').value = pattern;
  applyGlobalScope();
}

// host의 와일드카드 형태: 3+ part host는 가장 왼쪽 label 제거
// (www.site.com → *.site.com), 또는 2-part host는 *. prepend
// (site.com → *.site.com). IP/single-label/IPv6는 null 반환.
function wildcardHost(host) {
  if (!host) return null;
  if (/^[\d.]+$/.test(host)) return null;
  if (host.includes(':')) return null;
  const parts = host.split('.');
  if (parts.length < 2) return null;
  if (parts.length === 2) return `*.${host}`;
  return `*.${parts.slice(1).join('.')}`;
}

// 프록시에서 인터셉트된 요청 처리
function handleProxyInterceptedRequest(msg) {
  // 도착 즉시 어떤 bypass 로직 전에 요청 스냅샷. log strip이 resolve된
  // 후에 요청/페어를 재표시할 수 있도록 저장. bypass된 요청도 캡처되어
  // "bypassed" log 행이 inspectable 유지.
  capturedRequests.set(msg.id, {
    method: msg.method,
    url: msg.url,
    headers: msg.headers || {},
    body: msg.body || '',
  });
  if (capturedRequests.size > 200) {
    const oldest = capturedRequests.keys().next().value;
    capturedRequests.delete(oldest);
  }
  // 새 live intercept = 표시 중이던 captured pair는 이제 stale —
  // viewing 플래그를 drop해서 에디터의 action 버튼이 재활성화되도록.
  if (viewingCapturedId) _clearCapturedViewing();

  const methodFilter = document.getElementById('icpt-method-filter').value;

  // Method 필터
  if (methodFilter && msg.method !== methodFilter) {
    sendInterceptDecision(msg.id, { action: 'forward' });
    upsertInterceptLog(msg.id, { action: 'bypassed', method: msg.method, url: msg.url });
    return;
  }
  // Global scope 게이트 (defense in depth — 프록시가 update_config를
  // 통해 서버 측에서 이미 필터링하지만, config 업데이트가 도착하기
  // 전에 dispatch된 race는 여기서 잡음)
  if (!inGlobalScope(msg.url)) {
    sendInterceptDecision(msg.id, { action: 'forward' });
    upsertInterceptLog(msg.id, { action: 'bypassed', method: msg.method, url: msg.url });
    return;
  }
  // Bypass 룰
  if (interceptBypassRegex && interceptBypassRegex.test(msg.url)) {
    sendInterceptDecision(msg.id, { action: 'forward' });
    upsertInterceptLog(msg.id, { action: 'bypassed', method: msg.method, url: msg.url });
    return;
  }

  // request 큐에 추가
  const newItem = {
    id: msg.id,
    reqType: 'proxy',
    method: msg.method,
    url: msg.url,
    headers: msg.headers || {},
    postData: msg.body || '',
  };
  reqQueue.push(newItem);
  if (!selectedReqId) {
    selectedReqId = newItem.id;
    showReqEditor(newItem);
  }
  renderReqQueue();
}

function handleResponseIntercepted(msg) {
  let body = msg.body || '';
  try {
    const parsed = JSON.parse(body);
    body = JSON.stringify(parsed, null, 2);
  } catch {}

  // request side와 같은 이유: 새 live intercept = captured-pair 뷰는
  // 이제 stale.
  if (viewingCapturedId) _clearCapturedViewing();

  // response 큐에 추가. requestId는 원본 request id (_resp suffix
  // 없음) — item에 보관해서 response decision이 request side가 연
  // 올바른 log 행을 업데이트할 수 있도록.
  const newItem = {
    id: msg.id,
    requestId: msg.requestId || msg.id.replace(/_resp$/, ''),
    method: msg.method,
    url: msg.url,
    statusCode: msg.statusCode,
    headers: msg.headers || {},
    body: body,
    bodyTruncated: msg.bodyTruncated,
  };
  respQueue.push(newItem);
  // 사용자가 방금 매칭 요청을 forward한 경우 response side를 자동
  // 활성화하고 이 item 선택 — request side에서 F(또는 G)를 눌렀고
  // 다음에 작업하고 싶은 게 응답이라 여기로 focus 끌어당기면 클릭
  // 한 번 절약. 그 외(다른 누군가 forward한 요청의 응답, 또는 다른
  // selection)에서는 사용자가 현재 하는 것을 존중.
  const expected = _icptExpectingResp.has(newItem.requestId);
  if (expected) {
    _icptExpectingResp.delete(newItem.requestId);
    setActiveIcptSide('resp');
    selectedRespId = newItem.id;
    showRespEditor(newItem);
  } else if (!selectedRespId) {
    selectedRespId = newItem.id;
    showRespEditor(newItem);
  }
  renderRespQueue();
}

// Editor 탭 전환 (side로 scope)
document.querySelectorAll('.icpt-editor-tabs').forEach(tabBar => {
  tabBar.querySelectorAll('.icpt-ed-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const side = tabBar.dataset.side;
      tabBar.querySelectorAll('.icpt-ed-tab').forEach(t => t.classList.remove('active'));
      const parentContent = tabBar.closest('.icpt-editor-content');
      parentContent.querySelectorAll('.icpt-ed-pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('icpt-tab-' + tab.dataset.ictab).classList.add('active');
    });
  });
});

icptToggleBtn.addEventListener('click', () => {
  if (interceptActive) stopIntercept(); else startIntercept();
});

// Request side 버튼
document.getElementById('icpt-req-forward').addEventListener('click', () => { activeSide = 'req'; forwardSelected(false); });
document.getElementById('icpt-req-forward-modified').addEventListener('click', () => { activeSide = 'req'; forwardSelected(true); });
document.getElementById('icpt-req-drop').addEventListener('click', () => { activeSide = 'req'; dropSelected(); });
document.getElementById('icpt-req-mock').addEventListener('click', () => { activeSide = 'req'; mockResponseSelected(); });

// Response side 버튼
document.getElementById('icpt-resp-forward').addEventListener('click', () => { activeSide = 'resp'; forwardSelected(false); });
document.getElementById('icpt-resp-forward-modified').addEventListener('click', () => { activeSide = 'resp'; forwardSelected(true); });
document.getElementById('icpt-resp-drop').addEventListener('click', () => { activeSide = 'resp'; dropSelected(); });

// Format 토글 (Raw / Pretty) — raw textarea의 body 부분을 in-place
// 재포맷. headers는 그대로. 사용자가 body를 편집한 뒤 전환해도 괜찮음;
// body가 유효 JSON이 아니면 destructive parse error 대신 no-op.
document.querySelectorAll('.icpt-format-toggle').forEach(group => {
  const target = group.dataset.target; // 'req' | 'resp'
  group.querySelectorAll('.icpt-fmt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      group.querySelectorAll('.icpt-fmt-btn').forEach(b => {
        b.classList.toggle('active', b === btn);
      });
      const fmt = btn.dataset.fmt;
      // 이 side의 편집 가능 raw textarea에 적용. Request side는 Edit
      // + Mock — 활성화된 pane을 토글(사용자는 한 번에 하나만 봄).
      if (target === 'req') {
        const activePane = reqEditorContent.querySelector('.icpt-ed-pane.active');
        const ta = activePane ? activePane.querySelector('textarea') : null;
        if (ta) {
          ta.value = _formatIcptRaw(ta.value, fmt);
          // ta.id는 icpt-{req|mock}-raw → 거기서 sync key 도출.
          _syncIcptRawDisplay(ta.id.replace(/^icpt-(.+)-raw$/, '$1'));
        }
      } else {
        const ta = document.getElementById('icpt-resp-raw');
        if (ta) {
          ta.value = _formatIcptRaw(ta.value, fmt);
          _syncIcptRawDisplay('resp');
        }
      }
    });
  });
});

// 공통 버튼
document.getElementById('icpt-forward-all').addEventListener('click', forwardAll);
document.getElementById('icpt-drop-all').addEventListener('click', dropAll);
document.getElementById('icpt-clear-log').addEventListener('click', () => {
  interceptLog.length = 0;
  capturedRequests.clear();
  capturedResponses.clear();
  if (viewingCapturedId) _clearCapturedViewing();
  renderInterceptLog();
});
document.getElementById('icpt-bypass-apply').addEventListener('click', applyBypassRule);

// auto-forward / bypass rules 행 토글 (기본 접힘).
document.getElementById('icpt-rules-toggle').addEventListener('click', () => {
  const bar = document.querySelector('.icpt-rules-bar');
  bar.classList.toggle('hidden');
});

// Intercept 키보드 단축키 (F/G/D/R/A/Q) — activeSide 기반
document.addEventListener('keydown', (e) => {
  const interceptSection = document.getElementById('intercept');
  if (!interceptSection || !interceptSection.classList.contains('active')) return;
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  switch (e.key.toLowerCase()) {
    case 'f': e.preventDefault(); forwardSelected(false); break;
    case 'g': e.preventDefault(); forwardSelected(true); break;
    case 'd': e.preventDefault(); dropSelected(); break;
    case 'r': e.preventDefault(); if (activeSide === 'req') mockResponseSelected(); break;
    case 'a': e.preventDefault(); forwardAll(); break;
    case 'q': e.preventDefault(); dropAll(); break;
  }
});

// 확장자 체크박스 변경 시 자동 적용
document.querySelectorAll('.icpt-ext-check input[data-ext]').forEach(cb => {
  cb.addEventListener('change', applyBypassRule);
});

function buildBypassPattern() {
  // 체크된 확장자 수집
  const exts = [];
  document.querySelectorAll('.icpt-ext-check input[data-ext]:checked').forEach(cb => {
    exts.push(cb.dataset.ext);
  });
  // 사용자 추가 regex
  const userVal = document.getElementById('icpt-bypass-input').value.trim();

  const parts = [];
  if (exts.length > 0) {
    // woff → woff|woff2 변환
    const extPatterns = exts.map(e => e === 'woff' ? 'woff2?' : e === 'jpg' ? 'jpe?g' : e);
    parts.push('\\.(' + extPatterns.join('|') + ')(\\?|$)');
  }
  if (userVal) parts.push(userVal);
  return parts.join('|');
}

function applyBypassRule() {
  const combined = buildBypassPattern();
  try {
    interceptBypassRegex = combined ? new RegExp(combined, 'i') : null;
  } catch (e) {
    interceptBypassRegex = null;
    alert('Invalid regex: ' + e.message);
    return;
  }
  if (interceptActive) {
    sendToBg({
      type: 'update_config',
      config: { bypassPatterns: combined ? [combined] : [] }
    });
  }
}

function startIntercept() {
  // interceptActive 설정 전에 global scope 적용 — applyGlobalScope()는
  // interceptActive가 false면 update_config push를 skip하는데, 아래
  // intercept_on config로 scope를 보내므로 여기서는 그 동작이 맞음.
  applyGlobalScope();
  applyBypassRule();

  interceptActive = true;
  icptToggleBtn.textContent = 'Intercept ON';
  icptToggleBtn.className = 'btn btn-toggle-on';
  interceptTabBtn.classList.add('recording');
  updateProxyStatus('idle', 'Proxy: Connecting...');

  const combined = buildBypassPattern();
  const interceptResp = document.getElementById('icpt-resp').checked;
  const methodFilter = document.getElementById('icpt-method-filter').value;
  sendToBg({
    type: 'intercept_on',
    config: {
      port: 8899,
      bypassPatterns: combined ? [combined] : [],
      interceptResponse: interceptResp,
      urlFilter: urlFilterToRegex(globalScope.input),
      methodFilter: methodFilter,
    }
  });
}

// Response 체크박스 변경 시 실시간 업데이트
document.getElementById('icpt-resp').addEventListener('change', (e) => {
  if (interceptActive) {
    sendToBg({
      type: 'update_config',
      config: { interceptResponse: e.target.checked }
    });
  }
});

// Method 필터는 변경 즉시 프록시와 동기화. Global scope는 명시적 Apply
// (버튼 또는 Enter)가 필요 → 사용자가 무엇이 활성인지 항상 인지하도록.
document.getElementById('icpt-method-filter').addEventListener('change', () => {
  if (interceptActive) {
    sendToBg({
      type: 'update_config',
      config: {
        urlFilter: urlFilterToRegex(globalScope.input),
        methodFilter: document.getElementById('icpt-method-filter').value,
      }
    });
  }
});

function stopIntercept() {
  interceptActive = false;
  icptToggleBtn.textContent = 'Intercept OFF';
  icptToggleBtn.className = 'btn btn-toggle-off';
  interceptTabBtn.classList.remove('recording');

  // 남은 모든 큐 아이템 forward
  forwardAll();

  sendToBg({ type: 'intercept_off' });
  updateProxyStatus('idle', 'Proxy: Stopped');
}

function sendInterceptDecision(id, decision) {
  sendToBg({ type: 'decision', id, ...decision });
}

// ---- 큐 렌더링 ----
function updateBadges() {
  reqBadge.textContent = reqQueue.length;
  respBadge.textContent = respQueue.length;
}

function renderQueueItems(queue, el, selectedId, side) {
  el.innerHTML = queue.map((item, i) => {
    const selected = item.id === selectedId ? 'selected' : '';
    let shortUrl;
    try { shortUrl = new URL(item.url).pathname + new URL(item.url).search; } catch { shortUrl = item.url; }
    return `<div class="icpt-queue-item ${selected}" data-icpt-idx="${i}" data-side="${side}">
      <span class="q-idx">#${i + 1}</span>
      <span class="q-method">${escapeHtml(item.method)}</span>
      <span class="q-url" title="${escapeHtml(item.url)}">${escapeHtml(shortUrl)}</span>
    </div>`;
  }).join('');

  el.querySelectorAll('.icpt-queue-item').forEach(el2 => {
    el2.addEventListener('click', () => {
      // 사용자가 live 큐 아이템 선택 — 모든 captured-view 상태를
      // 드롭해서 action 버튼이 live intercept용으로 재활성화되도록.
      if (viewingCapturedId) _clearCapturedViewing();
      const idx = parseInt(el2.dataset.icptIdx);
      if (side === 'req') {
        const item = reqQueue[idx];
        if (!item) return;
        selectedReqId = item.id;
        activeSide = 'req';
        showReqEditor(item);
        renderReqQueue();
      } else {
        const item = respQueue[idx];
        if (!item) return;
        selectedRespId = item.id;
        activeSide = 'resp';
        showRespEditor(item);
        renderRespQueue();
      }
      document.querySelectorAll('.icpt-side').forEach(s => s.classList.remove('active-side'));
      document.querySelector(`.icpt-${side}-side`).classList.add('active-side');
    });
  });
}

function renderReqQueue() {
  updateBadges();
  renderQueueItems(reqQueue, reqQueueEl, selectedReqId, 'req');
}

function renderRespQueue() {
  updateBadges();
  renderQueueItems(respQueue, respQueueEl, selectedRespId, 'resp');
}

// ---- Editor 표시 ----
// 큐 item에서 raw HTTP request 문자열 빌드. HTTP/1.1 사용 — origin의
// wire 프로토콜과 무관하게 browser→proxy는 항상 h1.1.
function _buildIcptRawRequest(item) {
  const method = item.method || 'GET';
  let path = '/';
  let host = '';
  try {
    const u = new URL(item.url);
    path = (u.pathname || '/') + (u.search || '');
    host = u.host;
  } catch {}
  const headers = item.headers || {};
  const lines = [`${method} ${path} HTTP/1.1`];
  if (host && !_findHeaderCI(headers, 'host')) lines.push(`Host: ${host}`);
  for (const [k, v] of Object.entries(headers)) {
    if (k.startsWith(':')) continue;
    lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
  }
  return lines.join('\n') + '\n\n' + (item.postData || item.body || '');
}

function _buildIcptRawResponse(item) {
  const status = item.statusCode || 200;
  const headers = item.headers || {};
  const lines = [`HTTP/1.1 ${status}`];
  for (const [k, v] of Object.entries(headers)) {
    if (k.startsWith(':')) continue;
    lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
  }
  return lines.join('\n') + '\n\n' + (item.body || '');
}

// raw HTTP request 텍스트 → { method, url, headers, body } 파싱.
// URL은 `fallbackUrl`에 대해 resolve → 사용자는 path만 편집.
function _parseIcptRawRequest(text, fallbackUrl) {
  if (!text) return null;
  const blank = text.indexOf('\n\n');
  const headerPart = blank >= 0 ? text.slice(0, blank) : text;
  const body = blank >= 0 ? text.slice(blank + 2) : '';
  const lines = headerPart.split('\n');
  const m = (lines[0] || '').match(/^(\S+)\s+(\S+)\s+HTTP\/[\d.]+/);
  if (!m) return null;
  const method = m[1];
  const path = m[2];
  let url;
  try { url = new URL(path, fallbackUrl).href; } catch { url = path; }
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const k = line.slice(0, colon).trim();
    const v = line.slice(colon + 1).trim();
    if (k && !k.startsWith(':')) headers[k] = v;
  }
  return { method, url, headers, body };
}

// raw HTTP response 텍스트 → { statusCode, headers, body } 파싱.
function _parseIcptRawResponse(text) {
  if (!text) return null;
  const blank = text.indexOf('\n\n');
  const headerPart = blank >= 0 ? text.slice(0, blank) : text;
  const body = blank >= 0 ? text.slice(blank + 2) : '';
  const lines = headerPart.split('\n');
  const m = (lines[0] || '').match(/^HTTP\/[\d.]+\s+(\d+)/);
  const statusCode = m ? parseInt(m[1], 10) : 200;
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const k = line.slice(0, colon).trim();
    const v = line.slice(colon + 1).trim();
    if (k && !k.startsWith(':')) headers[k] = v;
  }
  return { statusCode, headers, body };
}

// HTTP 메시지의 body 부분에 pretty/raw 포매팅 적용, headers는 그대로.
// JSON만 대상 — 다른 건 통과.
function _formatIcptRaw(text, mode) {
  if (!text) return text;
  const blank = text.indexOf('\n\n');
  if (blank < 0) return text;
  const headerPart = text.slice(0, blank);
  const body = text.slice(blank + 2);
  if (!body.trim()) return text;
  try {
    const parsed = JSON.parse(body);
    const formatted = mode === 'pretty'
      ? JSON.stringify(parsed, null, 2)
      : JSON.stringify(parsed);
    return headerPart + '\n\n' + formatted;
  } catch { return text; }
}

// textarea의 현재 값을 컬러 <pre> 오버레이로 push → 사용자가 syntax
// highlighted 렌더를 봄. _renderRawHtml(Monitor의 Message 탭이 쓰는
// 동일 colorizer) 재사용 → 두 surface 사이에 시각 언어 일관성 유지.
function _syncIcptRawDisplay(name) {
  const ta = document.getElementById(`icpt-${name}-raw`);
  const pre = document.getElementById(`icpt-${name}-raw-display`);
  if (!ta || !pre) return;
  // 텍스트가 newline으로 끝날 때 trailing space 추가 → pre가 그 줄
  // 자리를 할당하도록. textarea의 마지막 줄 높이가 아래 pre와 정렬
  // 유지되게 함.
  const v = ta.value;
  const display = v.endsWith('\n') ? v + ' ' : v;
  pre.innerHTML = _renderRawHtml(display);
  // 컬러 렌더를 textarea의 스크롤 위치와 정렬 유지 → 어떤 offset의
  // 보이는 문자도 컬러 카운터파트와 겹치도록.
  pre.scrollTop = ta.scrollTop;
  pre.scrollLeft = ta.scrollLeft;
}

// 스크립트 init 시 한 번만 attach. 각 Intercept raw 에디터는 컬러
// <pre> 위에 투명 textarea를 wrap; textarea의 input + scroll이 pre를
// 미러하도록 드라이브.
['req', 'resp', 'mock'].forEach(name => {
  const ta = document.getElementById(`icpt-${name}-raw`);
  const pre = document.getElementById(`icpt-${name}-raw-display`);
  if (!ta || !pre) return;
  ta.addEventListener('input', () => _syncIcptRawDisplay(name));
  ta.addEventListener('scroll', () => {
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  });
});

function showReqEditor(item) {
  reqPlaceholder.style.display = 'none';
  reqEditorContent.classList.remove('hidden');
  document.getElementById('icpt-req-raw').value = _buildIcptRawRequest(item);
  _syncIcptRawDisplay('req');
  // 새 아이템마다 Format 토글을 Raw로 reset.
  reqEditorContent.querySelectorAll('.icpt-format-toggle .icpt-fmt-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.fmt === 'raw');
  });
  // Mock textarea 기본값 — 사용자 편집 가능 시작점.
  const mockTa = document.getElementById('icpt-mock-raw');
  if (!mockTa.value) {
    mockTa.value = 'HTTP/1.1 200 OK\nContent-Type: application/json\n\n{}';
  }
  _syncIcptRawDisplay('mock');
  // Edit 탭으로 전환
  reqEditorContent.querySelectorAll('.icpt-ed-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.ictab === 'req-edit');
  });
  reqEditorContent.querySelectorAll('.icpt-ed-pane').forEach(p => {
    p.classList.toggle('active', p.id === 'icpt-tab-req-edit');
  });
}

function showRespEditor(item) {
  respPlaceholder.style.display = 'none';
  respEditorContent.classList.remove('hidden');
  document.getElementById('icpt-resp-raw').value = _buildIcptRawResponse(item);
  _syncIcptRawDisplay('resp');
  respEditorContent.querySelectorAll('.icpt-format-toggle .icpt-fmt-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.fmt === 'raw');
  });
}

function hideReqEditor() {
  selectedReqId = null;
  reqEditorContent.classList.add('hidden');
  reqPlaceholder.style.display = '';
  // Mock wipe → 다음 선택이 기본 seed를 받도록
  const mockTa = document.getElementById('icpt-mock-raw');
  if (mockTa) mockTa.value = '';
  _syncIcptRawDisplay('mock');
}

function hideRespEditor() {
  selectedRespId = null;
  respEditorContent.classList.add('hidden');
  respPlaceholder.style.display = '';
}

// ---- 큐 연산 ----
function removeFromReqQueue(id) {
  const idx = reqQueue.findIndex(q => q.id === id);
  if (idx >= 0) reqQueue.splice(idx, 1);
  if (selectedReqId === id) {
    if (reqQueue.length > 0) { selectedReqId = reqQueue[0].id; showReqEditor(reqQueue[0]); }
    else hideReqEditor();
  }
  renderReqQueue();
}

function removeFromRespQueue(id) {
  const idx = respQueue.findIndex(q => q.id === id);
  if (idx >= 0) respQueue.splice(idx, 1);
  if (selectedRespId === id) {
    if (respQueue.length > 0) { selectedRespId = respQueue[0].id; showRespEditor(respQueue[0]); }
    else hideRespEditor();
  }
  renderRespQueue();
}

// ---- Action (activeSide 기반) ----
function forwardSelected(modified) {
  if (activeSide === 'req') {
    const item = reqQueue.find(q => q.id === selectedReqId);
    if (!item) return;
    if (modified) {
      const raw = document.getElementById('icpt-req-raw').value;
      const parsed = _parseIcptRawRequest(raw, item.url);
      if (!parsed) {
        showToast('Could not parse the raw request — check the request line and headers');
        return;
      }
      sendInterceptDecision(item.id, {
        action: 'forward_modified',
        method: parsed.method,
        url: parsed.url,
        headers: parsed.headers,
        body: parsed.body,
      });
      upsertInterceptLog(item.id, { action: 'modified', method: parsed.method, url: parsed.url });
    } else {
      sendInterceptDecision(item.id, { action: 'forward' });
      upsertInterceptLog(item.id, { action: 'forwarded', method: item.method, url: item.url });
    }
    // 이 요청을 마킹 → response intercept가 발화할 때 active side를
    // 자동 전환 가능. Forward와 Forward Modified 둘 다 응답을 기대하는
    // wire-level 요청을 만들어냄; Drop/Mock은 그렇지 않으므로 skip.
    _icptExpectingResp.add(item.id);
    removeFromReqQueue(item.id);
  } else {
    const item = respQueue.find(q => q.id === selectedRespId);
    if (!item) return;
    const reqId = item.requestId;
    if (modified) {
      const raw = document.getElementById('icpt-resp-raw').value;
      const parsed = _parseIcptRawResponse(raw);
      if (!parsed) {
        showToast('Could not parse the raw response — check the status line and headers');
        return;
      }
      sendInterceptDecision(item.id, {
        action: 'forward_modified',
        responseStatus: parsed.statusCode,
        headers: parsed.headers,
        body: parsed.body,
      });
      capturedResponses.set(reqId, {
        statusCode: parsed.statusCode, headers: parsed.headers,
        body: parsed.body, bodyLength: (parsed.body || '').length,
      });
      upsertInterceptLog(reqId, { responseAction: 'modified', responseStatus: parsed.statusCode });
    } else {
      sendInterceptDecision(item.id, { action: 'forward' });
      capturedResponses.set(reqId, { statusCode: item.statusCode, headers: item.headers, body: item.body, bodyTruncated: item.bodyTruncated });
      upsertInterceptLog(reqId, { responseAction: 'forwarded', responseStatus: item.statusCode });
    }
    removeFromRespQueue(item.id);
    // response를 resolve한 후, request side에 대기 중인 게 있으면
    // 그쪽으로 focus 전환 — 교대하는 request ↔ response 루프 완성.
    // request 큐가 비어 있으면 active side를 그대로 두고, 다음 response
    // (큐에 있다면)가 focus 유지하도록.
    if (reqQueue.length > 0) {
      setActiveIcptSide('req');
    }
  }
}

function dropSelected() {
  if (activeSide === 'req') {
    const item = reqQueue.find(q => q.id === selectedReqId);
    if (!item) return;
    sendInterceptDecision(item.id, { action: 'drop' });
    upsertInterceptLog(item.id, { action: 'dropped', method: item.method, url: item.url });
    removeFromReqQueue(item.id);
  } else {
    const item = respQueue.find(q => q.id === selectedRespId);
    if (!item) return;
    const reqId = item.requestId;
    sendInterceptDecision(item.id, { action: 'drop' });
    upsertInterceptLog(reqId, { responseAction: 'dropped' });
    removeFromRespQueue(item.id);
  }
}

function mockResponseSelected() {
  const item = reqQueue.find(q => q.id === selectedReqId);
  if (!item) return;
  const raw = document.getElementById('icpt-mock-raw').value;
  const parsed = _parseIcptRawResponse(raw);
  if (!parsed) {
    showToast('Could not parse the mock response — check the status line and headers');
    return;
  }
  // 사용자가 Content-Type을 안 넣었으면 기본값 — body가 파싱되면 JSON,
  // 아니면 text/plain.
  const hasCT = Object.keys(parsed.headers).some(k => k.toLowerCase() === 'content-type');
  if (!hasCT) {
    try { JSON.parse(parsed.body); parsed.headers['Content-Type'] = 'application/json'; }
    catch { parsed.headers['Content-Type'] = 'text/plain'; }
  }
  // headers map을 mock용 프록시가 기대하는 배열 모양으로 변환.
  const headersArr = Object.entries(parsed.headers).map(([name, value]) => ({ name, value }));
  sendInterceptDecision(item.id, {
    action: 'mock',
    responseStatus: parsed.statusCode,
    responseHeaders: headersArr,
    responseBody: parsed.body,
  });
  capturedResponses.set(item.id, {
    statusCode: parsed.statusCode, headers: parsed.headers, body: parsed.body,
  });
  upsertInterceptLog(item.id, {
    action: 'mocked', method: item.method, url: item.url, responseStatus: parsed.statusCode,
  });
  removeFromReqQueue(item.id);
}

function forwardAll() {
  while (reqQueue.length > 0) {
    const item = reqQueue.shift();
    sendInterceptDecision(item.id, { action: 'forward' });
    upsertInterceptLog(item.id, { action: 'forwarded', method: item.method, url: item.url });
  }
  while (respQueue.length > 0) {
    const item = respQueue.shift();
    sendInterceptDecision(item.id, { action: 'forward' });
    capturedResponses.set(item.requestId, { statusCode: item.statusCode, headers: item.headers, body: item.body, bodyTruncated: item.bodyTruncated });
    upsertInterceptLog(item.requestId, { responseAction: 'forwarded', responseStatus: item.statusCode });
  }
  hideReqEditor();
  hideRespEditor();
  renderReqQueue();
  renderRespQueue();
}

function dropAll() {
  while (reqQueue.length > 0) {
    const item = reqQueue.shift();
    sendInterceptDecision(item.id, { action: 'drop' });
    upsertInterceptLog(item.id, { action: 'dropped', method: item.method, url: item.url });
  }
  while (respQueue.length > 0) {
    const item = respQueue.shift();
    sendInterceptDecision(item.id, { action: 'drop' });
    upsertInterceptLog(item.requestId, { responseAction: 'dropped' });
  }
  hideReqEditor();
  hideRespEditor();
  renderReqQueue();
  renderRespQueue();
}

// Response + request 캡처 히스토리 (id → 캡처된 페이로드). log strip
// 이 사용 — log 행 클릭 시 둘 다 에디터에 재생해서 사용자가 resolved
// 된 (forwarded/dropped 등) request/response 페어를 재검토 가능. 두
// map은 200 항목 제한이라 긴 모니터링 세션이 unbounded 데이터를 누적
// 하지 않음.
const capturedResponses = new Map();
const capturedRequests = new Map();
// captured pair가 에디터에 표시 중일 때(live pending intercept가 아님)
// 이게 log id를 보관. 새 pending intercept가 도착하거나 사용자가 큐
// 아이템을 클릭하면 자동 clear.
let viewingCapturedId = null;

function handleResponseCaptured(msg) {
  capturedResponses.set(msg.id, {
    statusCode: msg.statusCode,
    headers: msg.headers,
    body: msg.body,
    bodyLength: msg.bodyLength,
    bodyTruncated: msg.bodyTruncated,
  });
  // log에 응답 기록
  const logEntry = interceptLog.find(l => l.id === msg.id);
  if (logEntry) {
    logEntry.responseStatus = msg.statusCode;
    renderInterceptLog();
  }
  // 최대 200 항목 유지
  if (capturedResponses.size > 200) {
    const oldest = capturedResponses.keys().next().value;
    capturedResponses.delete(oldest);
  }
}

// request id 키로 log 항목 upsert. 캡처된 request/response 사이클마다
// log 행 1개 — `action`은 request-side 결정(forwarded/modified/dropped/
// mocked/bypassed) 기록, 이후 이벤트(response intercept 결정, response
// 캡처)는 중복 추가 대신 같은 행의 `responseAction`/`responseStatus`를
// 업데이트. id가 없는 요청(실제로는 발생하지 않음)도 합성 key로
// fallback해서 일회성 행 받음.
function upsertInterceptLog(id, fields) {
  if (!id) {
    interceptLog.unshift({ id: null, time: new Date(), ...fields });
  } else {
    const existing = interceptLog.find(l => l.id === id);
    if (existing) {
      Object.assign(existing, fields);
    } else {
      interceptLog.unshift({ id, time: new Date(), ...fields });
    }
  }
  if (interceptLog.length > 200) interceptLog.pop();
  renderInterceptLog();
}

function renderInterceptLog() {
  icptLogEl.innerHTML = interceptLog.slice(0, 100).map((l) => {
    const cls = 'log-' + (l.action || 'pending');
    let shortUrl;
    try { shortUrl = new URL(l.url || '').pathname; } catch { shortUrl = l.url || ''; }
    const time = l.time.toLocaleTimeString(undefined, { hour12: false });
    const hasReq = l.id && capturedRequests.has(l.id);
    const hasResp = l.id && capturedResponses.has(l.id);
    // Status 컬럼: 우선순위 순으로 응답 결정 표시 — 응답 dropped면
    // 명시적 "DROP", 응답 코드 알려져 있으면 코드(modified면 ✎ prefix),
    // 그 외는 "—" (request dropped, 또는 응답 아직 미캡처).
    let statusCell;
    if (l.responseAction === 'dropped') {
      statusCell = `<span class="log-resp-drop">DROP</span>`;
    } else if (l.responseStatus != null) {
      const s = l.responseStatus;
      const color = s < 400 ? '#0b7a3e' : '#d32f2f';
      const mark = l.responseAction === 'modified' ? '✎' : '';
      statusCell = `<span class="log-resp-status" style="color:${color}">${mark}${s}</span>`;
    } else {
      statusCell = `<span class="log-resp-status log-resp-none">—</span>`;
    }
    // 캡처된 request 또는 response가 있는 모든 log 행이 클릭 가능;
    // 클릭 핸들러가 데이터가 있는 사이드 모두 채움.
    const clickAttr = (hasReq || hasResp)
      ? `data-log-id="${escapeAttr(l.id)}" style="cursor:pointer"`
      : '';
    const isViewing = l.id && l.id === viewingCapturedId;
    return `<div class="icpt-log-item${isViewing ? ' viewing' : ''}" ${clickAttr}>
      <span class="log-action ${cls}">${l.action || ''}</span>
      <span class="log-method">${escapeHtml(l.method || '')}</span>
      ${statusCell}
      <span class="log-url" title="${escapeAttr(l.url || '')}">${escapeHtml(shortUrl)}</span>
      <span class="log-time">${time}</span>
    </div>`;
  }).join('');
}

// log 행 클릭 → 캡처된 request + response를 각 에디터에 재표시.
// 미해결 live intercept가 큐에 있으면 차단 → 사용자가 진행 중 편집을
// 잃지 않고, 에디터 표시 전환으로 held connection을 실수로 드롭하지
// 않도록.
icptLogEl.addEventListener('click', (e) => {
  const item = e.target.closest('[data-log-id]');
  if (!item) return;
  if (reqQueue.length > 0 || respQueue.length > 0) {
    showToast('Resolve pending intercepts first (Forward / Drop / Mock)');
    return;
  }
  _viewCapturedById(item.dataset.logId);
});

function _viewCapturedById(id) {
  const req = capturedRequests.get(id);
  const resp = capturedResponses.get(id);
  if (!req && !resp) return;
  viewingCapturedId = id;
  // 에디터를 read-only로 마킹 (CSS가 이 모드에서 action 버튼 + banner
  // + resp topbar/status 숨김).
  reqEditorContent.classList.add('icpt-viewing-captured');
  respEditorContent.classList.add('icpt-viewing-captured');
  if (req) {
    showReqEditor({
      id, reqType: 'captured',
      method: req.method, url: req.url, headers: req.headers, postData: req.body,
    });
  } else {
    hideReqEditor();
  }
  if (resp) {
    showRespEditor({
      id, method: req ? req.method : '', url: req ? req.url : '',
      statusCode: resp.statusCode, headers: resp.headers, body: resp.body,
      bodyTruncated: resp.bodyTruncated,
    });
  } else {
    hideRespEditor();
  }
  // 에디터를 채운 후 입력 잠금. CSS readonly/disabled visual + JS
  // 속성을 함께 설정 → 사용자가 inspection만 의도한 필드를 실수로
  // 편집하지 않도록.
  _setIcptEditorsReadonly(true);
  // 재렌더 → active log 행이 .viewing 하이라이트를 받도록.
  renderInterceptLog();
}

function _clearCapturedViewing() {
  viewingCapturedId = null;
  if (reqEditorContent) reqEditorContent.classList.remove('icpt-viewing-captured');
  if (respEditorContent) respEditorContent.classList.remove('icpt-viewing-captured');
  _setIcptEditorsReadonly(false);
  renderInterceptLog();
}

// 사용자가 viewing 배너의 X 클릭 → viewing 모드 종료 + 두 에디터의
// captured-view 내용 wipe → 정상 placeholder 상태로 fallback.
// (viewing 전에 큐 아이템이 선택돼 있었어도 자연스러운 다음 액션은
// 다시 live-intercept지 남은 것 재표시가 아님.)
function _exitViewingExplicit() {
  _clearCapturedViewing();
  hideReqEditor();
  hideRespEditor();
}

// Intercept 에디터 안의 textarea를 walk하면서 inert 상태 토글.
// readOnly는 textarea를 selectable 유지(텍스트 복사 가능)하되 편집
// 차단. Format 토글 버튼은 활성 유지 → read-only 모드에서도 raw/
// pretty 뷰 전환 가능. Action 버튼(Forward/Drop 등)은 이미 CSS로
// 숨김.
function _setIcptEditorsReadonly(on) {
  [reqEditorContent, respEditorContent].forEach(ed => {
    if (!ed) return;
    ed.querySelectorAll('textarea').forEach(el => { el.readOnly = on; });
  });
}

// viewing 배너의 Close (X) — 두 배너(request/response side)에서 모두
// 동작하도록 위임 → element별 listener 불필요.
document.querySelectorAll('.icpt-viewing-close').forEach(btn => {
  btn.addEventListener('click', _exitViewingExplicit);
});

// ============================================================
// 유틸리티 함수
// ============================================================

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function truncateUrl(url) {
  // data: URI — 페이로드 제거 후 mime type으로만 라벨 → 테이블이
  // 100KB base64 문자열을 한 셀에 렌더링하지 않도록.
  if (typeof url === 'string' && url.startsWith('data:')) {
    const m = url.match(/^data:([^;,]+)/);
    return m ? `[data URI] ${m[1]}` : '[data URI]';
  }
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url.length > 80 ? url.substring(0, 80) + '...' : url;
  }
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.substring(0, max) + '...' : str;
}

// 리사이즈 가능 split gutter: 드래그로 next sibling pane 크기 조정.
function setupSplitGutter(gutter) {
  const isVertical = gutter.classList.contains('split-gutter-v');
  // 방향: 기본은 gutter가 *next* sibling을 리사이즈, previous sibling은
  // flex-grow로 남는 공간 흡수. 일부 레이아웃(예: 좌측 Network 트리
  // pane)은 반대가 필요 — data-resize="prev"로 어느 쪽이 sized되고
  // 어느 쪽이 흡수할지 뒤집음.
  const resizesPrev = gutter.dataset.resize === 'prev';
  gutter.addEventListener('mousedown', (e) => {
    const target = resizesPrev ? gutter.previousElementSibling : gutter.nextElementSibling;
    if (!target || target.classList.contains('hidden')) return;
    e.preventDefault();
    const rect = target.getBoundingClientRect();
    const startSize = isVertical ? rect.height : rect.width;
    const startPos = isVertical ? e.clientY : e.clientX;
    gutter.classList.add('dragging');
    document.body.style.cursor = isVertical ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';

    function onMove(ev) {
      const cur = isVertical ? ev.clientY : ev.clientX;
      // 기본 방향: target에서 멀어지는 드래그 = 줄어듦. Prev 모드는
      // 부호 반전 → target side(좌측 pane이 target일 때 오른쪽으로)로
      // 드래그 = 커짐.
      const delta = cur - startPos;
      const newSize = Math.max(80, resizesPrev ? startSize + delta : startSize - delta);
      target.style.flex = `0 0 ${newSize}px`;
      if (isVertical) {
        target.style.maxHeight = 'none';
      }
    }
    function onUp() {
      gutter.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
document.querySelectorAll('.split-gutter').forEach(setupSplitGutter);

// ── 컬럼 리사이즈 ──────────────────────────────────────────────────────────
// table-layout:fixed인 테이블의 각 thead th 우측에 .col-resizer를 부착해
// 드래그로 컬럼 폭 조정. 마지막 컬럼은 우측 공간이 없어 skip.
// js-trace의 grid 기반 리사이즈는 js-trace.js가 별도 구현 (CSS var 갱신).
function setupTableColumnResize(table) {
  if (!table) return;
  const ths = Array.from(table.querySelectorAll('thead th'));
  ths.forEach((th, idx) => {
    if (idx === ths.length - 1) return;
    if (th.querySelector('.col-resizer')) return;
    const resizer = document.createElement('div');
    resizer.className = 'col-resizer';
    th.appendChild(resizer);

    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = th.offsetWidth;
      resizer.classList.add('dragging');
      document.body.classList.add('col-resizing');
      const onMove = (ev) => {
        const newW = Math.max(40, startW + (ev.clientX - startX));
        th.style.width = newW + 'px';
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
    // 헤더의 정렬 등 click 동작을 가로채지 않도록.
    resizer.addEventListener('click', (e) => e.stopPropagation());
  });
}
setupTableColumnResize(document.getElementById('network-table'));

// ── Monitor ↔ JS Trace 브릿지 ─────────────────────────────────────────────
// 매칭 키 = URL + Method + 시작 시각(±500ms). 동일 URL+method가 짧은 시간에
// 여러 번 발생하면 가장 가까운 시간의 trace 이벤트를 채택.
// Linked fetch: 정확 매칭(0 또는 1), Context: ±2s 모든 cat (input/storage/
// crypto 등 포함, 요청 전후 JS 흐름 시각화).

function _getRequestStartMs(req) {
  if (req && req._harEntry && req._harEntry.startedDateTime) {
    return new Date(req._harEntry.startedDateTime).getTime();
  }
  return null;
}

function _parseTraceFetchArg(arg0) {
  // "POST https://.../cmm/login" 또는 "GET /some/path" 형식 — preview()의
  // 출력 포맷과 일치.
  if (!arg0 || typeof arg0 !== 'string') return null;
  const sp = arg0.indexOf(' ');
  if (sp === -1) return null;
  return { method: arg0.slice(0, sp), url: arg0.slice(sp + 1) };
}

function findLinkedFetchEvent(req, traceEvents) {
  const reqMs = _getRequestStartMs(req);
  if (reqMs === null) return null;
  const candidates = traceEvents.filter(ev => {
    if (ev.cat !== 'network') return false;
    if (typeof ev.t !== 'number') return false;
    if (Math.abs(ev.t - reqMs) > 500) return false;
    const parsed = _parseTraceFetchArg(ev.args && ev.args[0]);
    if (!parsed) return false;
    if (parsed.method !== req.method) return false;
    // 한쪽이 다른 쪽을 포함하면 매칭 (full URL ↔ path-only 둘 다 호환)
    return req.url.includes(parsed.url) || parsed.url.includes(req.url);
  });
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => Math.abs(a.t - reqMs) - Math.abs(b.t - reqMs))[0];
}

function findContextTraceEvents(req, traceEvents, windowMs) {
  if (windowMs === undefined) windowMs = 2000;
  const reqMs = _getRequestStartMs(req);
  if (reqMs === null) return [];
  return traceEvents
    .filter(ev => typeof ev.t === 'number' && Math.abs(ev.t - reqMs) <= windowMs)
    .sort((a, b) => a.t - b.t);
}

// Monitor 행에서 → JS Trace로 점프. 탭 전환 + selectEvent(seq).
function jumpToTraceEvent(seq) {
  const traceTabBtn = document.querySelector('.tab[data-tab="js-trace"]');
  if (traceTabBtn) traceTabBtn.click();
  // 탭 전환 직후엔 DOM rendered 되어 있어도 안전하게 다음 tick으로 미룸.
  setTimeout(() => {
    if (window.__jsTraceAPI && typeof window.__jsTraceAPI.selectEvent === 'function') {
      window.__jsTraceAPI.selectEvent(seq);
    }
  }, 30);
}

// JS Trace의 → Monitor 버튼이 호출하는 API. method+url+t로 매칭 요청 찾아
// Monitor 탭 전환 + select + scroll.
window.__monitorAPI = {
  jumpToRequest(method, url, tMs) {
    if (!method || !url || typeof tMs !== 'number') return false;
    const candidates = networkRequests.filter(r => {
      if (r.method !== method) return false;
      if (!(r.url.includes(url) || url.includes(r.url))) return false;
      const reqMs = _getRequestStartMs(r);
      if (reqMs === null) return false;
      return Math.abs(reqMs - tMs) < 500;
    });
    if (candidates.length === 0) return false;
    const best = candidates.sort((a, b) => {
      return Math.abs(_getRequestStartMs(a) - tMs) - Math.abs(_getRequestStartMs(b) - tMs);
    })[0];
    document.querySelector('.tab[data-tab="network"]').click();
    setTimeout(() => selectNetworkRequest(best.requestId, { scroll: true }), 30);
    return true;
  },
};

// 영속화된 "Auto-start" 토글 — 사용자가 popup(확장 아이콘)에서 켜두면
// 이 패널이 열리는 즉시 Network 모니터링 활성화. UI는 popup.html에 있고
// panel은 storage만 읽음 (panel.js는 read-only consumer).
(function initAutoStartMonitoring() {
  safeStorageGet(['autoStartMonitoring'], (result) => {
    const enabled = !!(result && result.autoStartMonitoring);
    if (enabled && !networkMonitoring) {
      startNetworkMonitoring();
      // 페이지가 이미 로드되어 있을 수 있음 — HAR replay 없이는 다음
      // 요청 발화까지 테이블이 비어 있음. getHAR이 Chrome이 이미
      // 캡처한 모든 것을 backfill.
      replayExistingNetworkHAR();
    }
  });
})();

