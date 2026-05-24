# Changelog

DevTools++ 버전별 변경 이력 (최신순). 기능 개요는 [README.md](README.md) 참조.

---

### v0.14.1 변경사항 (2026-05-25)
Eager response-body 로더의 MIME 매칭 누락 fix — `application/x-javascript` 등
legacy javascript variant가 자동 eager load 대상에서 빠져 export에 body가
저장되지 않던 회귀 수정. nexacro 같은 SPA의 `.xfdl.js` 등 모든 클라이언트
JS가 캡처에 자동 포함되도록.

#### `scanShouldEagerLoadBody` regex 확장
- `panel.js`의 eager 조건에서 `application/javascript`·`text/javascript`만
  매칭하던 regex가 **`application/x-javascript` / `application/x-ecmascript` /
  `application/ecmascript`** variant를 모두 누락. 일부 서버(Apache·IIS 등)가
  default로 내려보내는 `x-javascript`가 흔히 쓰임에도 자동 eager 대상에서
  빠져, 캡처에 `responseBodyLoaded: false`로 저장됨
- regex를 `(?:x-)?(?:java|ecma)script`로 확장 → 모든 javascript/ecmascript
  variant 커버
- 영향: 분석 워크플로우(export → distill → AI 분석)에서 클라 코드 자동 회수
  실패가 해소. 이전 캡처에서는 사용자가 패널 detail 클릭 시 lazy fetch한
  body가 export에는 들어가지 않아 SPA 클라 코드 분석이 수동 콘솔 fetch에
  의존했음. fix 후 mms-stg `.xfdl.js` 9/9 자동 회수 검증
- size cap 도입 검토했으나 채택 안 함 — SPA 런타임 번들(nexacro Framework.js
  1.3MB 등)도 분석 가치가 있어 자동 회수가 워크플로우에 더 부합. 매 캡처마다
  export 크기가 증가하는 비용은 자가용 분석 워크스페이스에서 감수

---

### v0.14.0 변경사항 (2026-05-22)
Import 동작 재설계 — 임포트 요청을 라이브 캡처와 격리된 별도 탭(📥)으로
분리 + 확인 모달 제거.

#### 임포트 격리 탭 (📥 prefix)
- 임포트 시 `_itemToReq`가 `_mainHost`에 `📥 ` prefix 자동 부착 → 라이브 캡처
  탭(`host`)과 임포트 탭(`📥 host`) 사이 키 공간 자동 분리. **같은 host의
  라이브+임포트가 동시에 떠 있어도 안 섞임.** 분석 컨텍스트와 실시간 캡처가
  깔끔히 갈림
- 탭 strip 시각화: host가 `📥 `로 시작하면 `.network-tab.imported` 클래스 부여
  → 약한 파랑 톤 + 점선 보더 + 이탤릭(active 시엔 solid). 버튼 `title`에
  "이건 임포트한 탭입니다." hover 안내
- export 시 `_exportItem`이 `📥 ` prefix를 strip → round-trip이 prefix를
  누적하지 않음(재임포트 시 `_itemToReq`가 다시 부착). 원래 `mainHost` 보존

#### 확인 모달 제거
- `import-confirm-modal`(Overwrite / Append / Cancel 3-way) 통째 삭제 — 격리
  덕에 라이브와 임포트 충돌이 원천적으로 없어 매 임포트마다 클릭 요구가 잉여
  마찰. 임포트는 항상 append + 격리 탭 자동 생성
- `showImportConfirm()` 함수 및 모달 HTML/CSS 잔재 제거. "전부 비우기"는
  기존 Clear 버튼으로 그대로 가능 (기능 손실 없음)

#### 탭 leak fix (격리 도입 직후 발견된 회귀)
- 임포트 요청이 URL host 기반 매칭으로 같은 host의 라이브 탭에 새는 문제 —
  5곳에 `!req._imported && _reqHost === host` 게이트 추가:
  - `matchesActiveTab` (활성 탭 표시), `belongsToTab` (탭 닫기/이동),
    `renderNetworkTabs` 카운트, 신규 캡처 후 비활성 탭 배지 갱신, Export 메뉴
    의 "current tab selected" 카운트(`matchesActiveTab` 사용으로 통일)
- 임포트 요청은 `_mainHost`(`📥 …`)로만 매칭, 라이브 요청은 종전대로 URL host
  + `_mainHost` 양쪽 매칭. 임포트 탭에도 라이브 요청은 안 들어감

### v0.13.0 변경사항 (2026-05-21)
Monitor 상세 패널에 Description 탭 신설(요청 단위 사용자 마킹/노트) + 사이트맵 호스트 행에서 Auto Crawl 시드 즉시 추가.

#### Description 탭 (요청 마킹/노트, 결합 모델 A)
- Monitor 상세 패널에 **Description 탭** 신설 — JS Context 우측, `data-detail="note"`. 데이터: `req._userMark`(별표) + `req._userNote`(메모)
- 행 URL 셀의 클릭 가능한 **☆/★ 별표 prefix** (기존 🔐/↻ 패턴 동일 위치). 클릭 시 `_userMark` 토글, 행 클릭(detail open)과 분리(`stopPropagation`, `.row-select`와 동일 패턴)
- 마킹된 행 = `tr.row-marked` 옅은 amber 배경 (selected 시 기존 파랑 우선, row-replay 패턴 동일 처리)
- **결합 A**: 하이라이트는 derived = `_isReqMarked = _userMark || hasNote` → **노트가 있으면 자동 하이라이트**(목록에서 안 잃어버림). 노트 비우고 별표도 꺼야 해제
- Description 탭 textarea — `input` 즉시 `req._userNote` 저장 + `updateNetworkRowMark`로 행 하이라이트 라이브 반영
- **export/import 자동 보존** — `_exportItem`에 `userMark`/`userNote` 추가, `_itemToReq`에서 복원. legacy export는 필드 부재 → 무해(하위호환). 사용자 작업 결과 보존 원칙 적용
- 헬퍼: `_isReqMarked` / `updateNetworkRowMark` / `renderDescription` 분리, `showDetail`에 dispatch 추가

#### 사이트맵 🕷 Auto Crawl 시드 추가
- 좌측 sitemap 트리의 **모든 host 행에 🕷 버튼** — scope 🎯 select 우측, target host의 ↻ reload 좌측
- 클릭 → `https://<host>/`를 `#crawl-urls` 텍스트에어리어에 **append + dedup** → Auto Crawl 모달 자동 오픈
- 행 클릭(노드 확장)과 분리(`stopPropagation`). 크롤 진행 중이면 토스트 안내 후 무시(텍스트에어리어 disabled 상태라 안전)
- 스타일: scope select와 동일 톤 (연회색 배경 + 1px 테두리)

#### 인프라/문서
- `.gitignore`에 `analysis/` 추가 — 버그바운티/리얼월드 분석 워크스페이스(캡처·평문 자격증명·PII 포함) 로컬 전용, 공개 레포·CWS 미노출. CLAUDE.md에 "커밋 안전 — 민감 artifact 노출 방지" 자가점검 체크리스트 명문화
- README 인라인 코드 백틱(`Math.random` 등) + 단일 별표 italic(`*전에*` 등) 포맷 마커 제거 — 텍스트 불변, 굵게(`**`)는 유지

### v0.12.0 변경사항 (2026-05-17)
Auto Crawl을 재귀 스파이더로 전면 재설계 + Export 분할/zip 아키텍처 + 크롤 라이프사이클·요약.

#### Auto Crawl: List → Spider 전면 재설계
- URL 리스트 순차 방문 → **frontier BFS 스파이더**. seen-set dedup(`normalizeUrl` = origin+pathname+search), same-origin ∩ 글로벌 Scope 교집합, destructive-link denylist(logout/delete 등), depth gating
- 페이지 네비게이션을 `inspectedWindow.eval('location.href=')` → `chrome.tabs.update`(background `runtime.sendMessage` 경유)로 전환. long-lived 포트가 cold/stale service worker에서 첫 메시지를 유실해 **cross-origin 시드가 안 넘어가던 버그 fix**. 브라우저 레벨 네비라 page-JS `alert()`/hang에도 면역
- readyState 폴링(origin 일치 + `complete`) + 워치독(race-guard `stepDone`/`settled`)으로 **alert/hang 페이지를 사용자 개입 없이** 통과
- 취약하던 Active form-fill/submit 모드 전면 제거 — passive spider 전용 (페이지 트래픽은 Monitor/JS Trace가 캡처)

#### 크롤 옵션 (모달 UI)
- **캡처 스코프 한정** (기본 ON) — seed origin 밖 요청은 캡처 단계에서 드롭, 메모리/검색 비용 bound
- **Max depth** (0–5), **Max pages** (1–5000, 기본 200) — 천장 1000→5000 상향 (단일파일 export 하드월이 분할/zip으로 제거돼 유계 상향)
- **Fast discovery** (기본 OFF) — Per-page wait 무시(0), 입력 자동 비활성 동기화. 링크/구조 발견 무결성 유지, 페이지별 late/async 트래픽만 감소
- **이미지/폰트 skip** (기본 OFF) — 캡처 단계 드롭, 속도·링크 무결성 무관 순수 메모리/노이즈 절감
- NAV_COMMIT/POLL 등 속도 상수 튜닝

#### 크롤 라이프사이클·요약
- **crawl run 요약 .txt 자동 저장** (체크박스 기본 ON) — 자연 완료 + 수동 Stop 모두. seeds / 시작·종료·소요 / visited / captured / 설정값
- **Monitor 자동 OFF** — 크롤이 Monitor를 자동 ON 했던 경우에만 종료 시 OFF. 사용자가 미리 켜둔 세션은 미간섭. `stopNetworkMonitoring`은 데이터·jsTrace 미삭제 → 종료 후 export 정상 (기존 자동 ON과 대칭)

#### Export: 분할 + zip
- **>1000 요청** → 1000건 단위 `.json` 파트 분할 → 단일 `.zip`. STORE 무압축·무의존 자체 ZIP writer(CRC32 테이블 + local/central/EOCD), unzip/python 검증. 각 파트 = 독립 임포트 가능 봉투(meta + `part:{index,total}` + items)
- **all tabs** → 호스트(`_mainHost`, 없으면 URL host)별 분리해 단일 flat `.zip`. 호스트당 ≤1000 → `<host>.json`, >1000 → `<host>-part-NN-of-MM.json` (중첩 zip 아님). 기존 "호스트 구분 없이 merge" 동작 대체
- `jsTrace`(전역)는 정렬상 첫 호스트 part-01에만 동봉 (중복 0). 재임포트: 첫 파일 Overwrite → 나머지 Append (기존 import 모달·`mainHost` 복원 그대로)
- current tab은 동작 보존 — ≤1000 단일 `.json`(pretty), >1000 분할 zip
- CSV/HTML 인벤토리 export 제거 → JSON-only로 원복 (`_exportItem`/`_buildJsTrace`/`_splitFiles`/`exportAllTabsPerHost` 헬퍼 분리)

#### 버그 fix
- JS Context(`.jstrace-row`)에서 `sessionStorage.setItem` 등 긴 kind가 고정 130px 컬럼을 넘쳐 옆 args 컬럼과 텍스트가 겹쳐 보이던 현상. kind 컬럼 160px + `.jstrace-kind`에 `min-width:0` + overflow ellipsis (args도 `min-width:0` 보강)

### v0.11.0 변경사항 (2026-05-15)
Monitor ↔ JS Trace 양방향 브릿지 + JS Trace를 Monitor 라이프사이클에 종속.

#### Monitor ↔ JS Trace 브릿지
- Monitor 상세 패널에 **JS Context 탭** 신설 (Message / Initiator / Detection / Auth / JS Context 5개). 요청 발생 ±2초 윈도우의 JS Trace 이벤트를 카테고리별로 묶어 표시. "JS Trace"(마스터)와 "JS Context"(슬라이스) 명칭 분리
- 매칭 키: URL + Method + 시간 윈도우. `findLinkedFetchEvent` (±500ms 정확 매칭, 0 또는 1) / `findContextTraceEvents` (±2s 윈도우 모든 cat)
- JS Trace timeline의 cat=network row 우측에 `↗ Monitor` 점프 버튼. 매칭 요청 없으면 1.5초 빨강 강조
- Cross-module API: `window.__jsTraceAPI` (getEvents / isActive / start / stop / setEnabled / selectEvent / loadEvents), `window.__monitorAPI.jumpToRequest`
- Monitor export payload에 `jsTrace` 필드 추가 (events 0건이면 생략), import 시 `__jsTraceAPI.loadEvents`로 복원 (overwrite/append 무관 항상 덮어쓰기)

#### JS Trace ⊂ Monitor 라이프사이클
- 탭 순서: Monitor / Intercept / JS Trace → **Monitor / JS Trace / Intercept** (부모-자식 인접해 종속 시각화)
- Monitor ON → JS Trace 자동 시작 + 탭/토글 enable. Monitor OFF → JS Trace cascade stop + disable (dim + not-allowed)
- 사용자가 JS 분석 불필요 시 JS Trace 탭에서 수동 OFF 가능 (Monitor 유지). 다음 Monitor restart 시 재자동 시작
- 기존 js-trace.js 독립 auto-start 제거 (panel.js 단독 source of truth). inject 로드 전 start() 호출은 `pendingStart`로 보류 후 fetch 완료 시 자동 처리, stop()은 pendingStart 취소

#### JS Context 카테고리/Kind 설명
- `JSTRACE_CATEGORY_DESCRIPTIONS` 6개 카테고리(random/crypto/network/encoding/input/storage) 한국어 안내 + `_jsTraceKindDescription()` 11종 wrapper kind별 설명 (prefix 매칭, `(capped)` 접미사 strip). Detection 탭의 `.detection-group` 카드 패턴(헤더 + ▾ 토글 + 펼침) 재사용. `.scan-badge-jst-*` 6종 배지
- Context의 network 카테고리는 Linked 이벤트 1개로 한정 — 무관한 다른 fetch/XHR은 제외 (Monitor 자체 행에서 분석). 비-네트워크 카테고리(storage/input/encoding/crypto/random)는 모두 보존

#### UI 정리
- Scope 바를 좌측 트리 패널 하단에서 우측 .content-top 탭 옆으로 원복 (max-width 제한 해제, flex:1). "Scope" 라벨 → 트리 Set Scope와 동일한 🎯 아이콘
- All/Host-only 토글을 Monitor toolbar에서 Host 컬럼 헤더 안으로 이동 (`<th>` display:flex는 table-layout 깨므로 inner `.th-host-wrap`에 flex)
- `.tree-header` / `.content-top` height 32px 통일 (filter-input 자연 높이 ~24px가 content-top을 32px로 키워 좌측과 2px 어긋나던 문제)

#### 버그 fix
- Monitor 응답 패널이 3xx redirect에서 `responseBodyLoaded` false면 헤더까지 통째로 placeholder로 가리던 문제. 헤더는 HAR `resp.headers`에 캡처 시점 항상 존재 → 본문 로드 상태와 무관하게 항상 렌더, 본문 영역만 인라인 노트 (3xx → `[No body — redirect]`, import → `[Body not included in imported file]`, 그 외 → `[Loading response body…]`)

### v0.10.2 변경사항 (2026-05-13)
세 기능 탭(Monitor / Intercept / JS Trace) 컨트롤 일관성 정리 + JS Trace 데이터 관리 강화 패치.

#### 탭 컨트롤 통일
- 단일 Start/Stop 토글 버튼 — Monitor/JS Trace를 Intercept 패턴에 맞춰 두 버튼 → 하나의 토글 (`.btn-toggle-off/on`, OFF 회색 / ON 빨강 펄싱)
- Reload 버튼 — Monitor toolbar에서 제거, sitemap 트리 target host 행에 `↻` 아이콘 인라인 (현재 브라우저 탭 호스트만 노출)
- Set Scope — "Set Scope" 텍스트 select → `🎯` 아이콘, count와 reload 사이 inline
- Auto-start 토글 — panel header에서 확장 아이콘 popup으로 이동 (환경설정 성격, storage key 유지)

#### JS Trace 기능 추가
- Row 체크박스 + 선택 export (master / Cmd-A / Shift+click range, selection pill)
- Export 메뉴 재구성 (Masking 토글 + Full events / Selected events with count, `-selected` suffix)
- Import (이전 export JSON 재구성, tool=`js-trace` 또는 legacy `js-auth-trace`)
- 검색 prev/next/clear (`▲`/`▼`, Shift+Enter/Enter/Esc, 순환 + 노란 막대)
- 테이블 타이틀 헤더 + 컬럼 리사이저 (Time/Cat/Kind/Args/Result)

#### 버그 fix
- JS Trace export 메뉴가 timeline에 가려지던 문제 (toolbar `overflow-x: auto` → `visible`)
- Monitor export 메뉴 섹션 라벨 강제 대문자 → 첫 글자만 ("Current tab" / "All tabs (1 host)")
- JS Trace 검색 카운트 배경 파랑 → Monitor와 동일 회색계열

### v0.10.1 변경사항 (2026-05-13)
JS Trace nexacro 호환성 패치. 기능 추가 없음.

- 증상: `captureStack()`이 `(new Error()).stack`을 무조건 string으로 가정 → **nexacro Platform** 등 `Error.prepareStackTrace`를 override하는 RIA framework 사이트에서 JS Trace 켜면 빈 화면
- 원인: nexacro Framework.js가 `Error.prototype.stack`을 객체로 변형 → `.split('\n')` TypeError → `XHR.send` wrap throw → nexacro dynamic resource loader가 catch해 `CommunicationError(10499)` → `theme.map.js`/`accessibility.xiv.js`/`application.xadl.js` 로딩 실패 → application mount 실패
- 수정: `captureStack()` non-string이면 빈 문자열 fallback. **모든 wrapper**(Math.random/crypto.*/fetch/XHR/btoa·atob/TextEncoder·Decoder/HTMLInputElement.value/HTMLFormElement.submit/Storage.*/document.cookie)에 외부 try/catch 격리 — trace push/preview throw가 caller에 전파 안 됨. named function expression + 동적 `.name`으로 native 위장
- 검증: mms-stg.kmos.kr (nexacro Platform 21) 정상 로드 + 콘솔 에러 0건, 기존 4개 사이트(knvd/dhlottery/kpx/naver) 회귀 없음

### v0.10.0 변경사항 (2026-05-14)
JS Trace 탭 도입 — js-auth-trace 별도 확장의 모든 기능을 devtools-pp 내부로 통합.

#### JS Trace 탭
- 페이지 JS의 인증·세션·토큰 관련 동작을 timeline으로 기록. PortSwigger Authentication 카테고리 (login / MFA / OAuth / JWT / session / cookie) 가시화가 목표
- 11종 wrapper: `Math.random` / `crypto.getRandomValues` / `crypto.subtle.*` / `fetch` / `XMLHttpRequest.send` / `HTMLFormElement.submit` + submit event / `btoa` · `atob` / `TextEncoder.encode` · `TextDecoder.decode` / `HTMLInputElement.value` getter / `Storage.setItem|removeItem|clear` / `document.cookie` getter+setter
- 아키텍처: `chrome.devtools.inspectedWindow.eval`로 `inject.js`를 페이지 메인 world에 주입 → wrapper가 호출 흔적을 `window.__authTrace[]`에 push → panel이 500ms 폴링으로 splice. Stop 시 `restore.js`로 원본 복원
- 노이즈 필터: 호출 사이트 빈도 cap (10회), URL 블랙리스트 (`.js.map`, `favicon.ico`), input.value 연속 동일 값 dedupe
- `pagehide` 시 미플러시 trace + seq counter를 `sessionStorage`에 stash → 다음 페이지 inject 시 복원 (form POST → 302 chain 대응)
- UI: Start/Stop/Clear/Export JSON, mask pw 옵션, substring 검색, 5+1 카테고리 필터, 카테고리별 컬러 dot
- Export JSON: `filterStats` 메타데이터 포함, mask pw 활성 시 password 값과 URL-encoded / JSON-escaped 변형까지 마스킹
- 검증된 실 사이트: knvd.krcert.or.kr / dhlottery.co.kr / mail.kpx.or.kr / nid.naver.com

#### 통합 디테일
- 격리: 모든 코드를 `panel/js-trace/` 서브폴더에 격리 + `js-trace.js`는 IIFE로 포장. 전역 누출 0
- CSS scoping: 모든 selector를 `#js-trace ...`로 prefix. `body`/`html`/`.container` 같은 global rule은 제거하고 devtools-pp 기존 `.btn` / `.toolbar` / `.filter-input` 재사용. 컬러는 devtools-pp light theme에 맞춰 재조정
- DevTools API listener 공존: `chrome.devtools.network.onNavigated`는 devtools-pp와 JS Trace 양쪽이 독립 listener 등록 (Chrome multi-listener 지원). v1에서 JS Trace는 자기 wrapper 재주입에만 사용
- 기존 Monitor / Intercept 흐름과 비충돌 (Network 캡처 / proxy 인터셉트는 그대로 동작)

### v0.9.2 변경사항 (2026-05-10)
헤더 레이아웃 패치. JS 변경 없음 (selector/ID/handler 동일, DOM 위치만 이동).

- 기존: 브랜드 워드마크 + Monitor/Intercept 탭 + Scope 바 + Auto-start가 panel 최상단 한 행. global 트리 패널이 v0.9.0부터 좌측 컬럼인데 탭이 panel top에 있어 트리에도 적용되는 것처럼 보이는 문제
- 변경: 탭 + Scope를 우측 컬럼 상단 content-toolbar로 이동 (활성 섹션 바로 위). 헤더엔 워드마크 + muted tagline + Auto-start만, 트리 컬럼 불변

### v0.9.1 변경사항 (2026-05-09)
v0.9.0 패널 재구조 위 polish. 세션 attribution / header-only 활성화 / 정직한 HTTP 버전 표시 경계를 선명하게.

#### Monitor
- **Per-session 탭** — 탭이 host 필터가 아닌 *방문* 단위. github.com 탭은 CDN/`.map`/analytics/광고 등 그 페이지가 로드한 전체 트래픽 포함 (host equality로 90% 숨기던 것 개선)
- **All / Host-only segmented 토글** — Filter 옆 per-tab 컨트롤. `All` 기본 (세션 전체), `Host only` 동일-host 직접 요청만
- **글로벌 트리 패널** — 좌측 host 트리가 panel-level 레이아웃 컬럼, Monitor/Intercept 양쪽 표시. toolbar 버튼은 트리 우측
- **탭 스코프 카운트** — `100 / 271 requests (filtered)` = 이 탭 기준
- **정직한 HTTP 버전** — h2 origin 캡처는 `GET / HTTP/2`로 렌더 + `:authority`/`:method`/`:path`/`:scheme` pseudo-header를 visible 헤더에서 제외 (이전엔 h2 헤더 블록 + HTTP/1.1 status line 혼재로 오해 소지)
- Initiator 컬럼 캡처 시점 선제 `↑ Mapped`, `.map` cold load 노출

#### Replay
- **KV 에디터** — raw textarea → Method 드롭다운 · URL · HTTP version · Headers(체크박스+name+value) / Body 탭
- **Forbidden 헤더 잠금** — Cookie/User-Agent/Origin/Referer/Sec-*/Proxy-*/Access-Control-* 시각적 잠금 (🔒), 이름 변경 시 해제
- **form-urlencoded POST Form 뷰** — 필드별 KV 행, Form ↔ Raw 토글 (네이티브 Payload 탭 대응)
- HTTP version 필드 편집 가능 (보안 테스트 기록용, wire는 항상 h1.1)
- **CORS 폴백** — 페이지 컨텍스트 fetch 실패(cross-origin ACAO 누락) 시 Service Worker fetch 자동 재시도 (`<all_urls>`), 토스트 안내

#### Intercept
- 컬러 syntax raw HTTP 에디터 (Edit/Mock/Response, transparent textarea on colored `<pre>`), Raw/Pretty body 토글
- Mock Response 단일 raw HTTP textarea (status/headers/body 분리 입력 폐기)
- **Header-only 사이드 활성화** — textarea 클릭이 활성 사이드 안 바꿈 (F/G/D/R 오입력 방지). 활성 cue 강화 (solid blue header + 3px accent)
- **Forward 시 교차 포커스** — request 측 F → 응답 도착 시 response 측 자동, response 측 F → 큐에 요청 있으면 request 측. F 연타로 request → response → next 순환
- **HTTP/2 pseudo-header가 native host 죽이던 문제** — `:authority` 등이 `ERR_INVALID_HTTP_TOKEN` 동기 throw → host 사망. forward 전 strip + host에 top-level unhandledRejection/uncaughtException 핸들러

#### Export / Detection
- Detection-only export 모드 제거 (full export에 scanResults 포함). 2 scope(Current tab/All tabs) × 2 selection(Full/Selected). import 시 세션 attribution 복원 (legacy는 URL host fallback)
- 내부 IP 정규식 octet ≤ 255 검증 — `10.669.606.225` 같은 false `leak` 제거 (private 대역 + octet 범위 동시 체크)

### v0.9.0 변경사항 (2026-05-08)
실제 테스트 세션 흐름 중심의 패널 대규모 재구조. Network + Site Map → 단일 Monitor 탭.

#### Monitor 탭 (was Network + Site Map)
- Site Map 탭 제거 → host/path 트리를 Monitor 좌측 pane으로 (gutter 리사이즈). 트리는 늘 Site Map의 핵심 surface였고 탭 전환 비용 제거
- **Per-host 탭 strip** — 메인 host마다 탭 (navigation 시 생성, 재방문 idempotent). 리스트/트리-detail/검색/선택-master 일괄 필터 → 멀티사이트 세션 비혼입
- 트리 **Set Scope** 드롭다운 host-row hover 복원 (Exact/Wildcard)
- Reload 버튼 Monitor toolbar로, **Network → Monitor** 탭 리네임 (verb-action, sibling Intercept와 observe vs intervene 페어)
- Export 메뉴 재섹션 (Current tab / Selected / All tabs)

#### 상세 패널 — Message / Initiator / Detection
- 7개 탭 → 3개. Headers/Payload/Response/Preview/Replay → 단일 **Message** 탭
- Message: Request/Response 상하 배치 on-the-wire raw HTTP (request line/status line + headers + blank + body). native DevTools 헤더 테이블 뷰 대비 차별점
- request/status line 파랑, 헤더명 red-bold. Raw/Pretty 토글 per side
- **Replay는 버튼** (요청 pane, 탭 아님). `↻ Replay` → textarea overlay, Original/Modified 상태 버튼. `inspectedWindow.eval` fire, 응답은 `(replay)` 태그 + JSON diff
- **Preview는 버튼** (응답 pane, HTML iframe/이미지/JSON 트리)
- Replay 발생 요청은 client TTL 큐가 `_isReplay` 태깅 → 노란 tint + ↻ 배지 (서버 비가시, 오염 없음)

#### Intercept — captured-pair viewing + 고정 크기
- 로그 행 클릭 → 양 에디터에 캡처 request/response read-only 재표시 (`readOnly`/`disabled` + CSS). 배너 `×`로 종료. Response 측은 method/URL/status topbar 숨김
- 로그 행 1 요청/응답 사이클당 1행 통일 (`upsertInterceptLog`) — 이전 split-row는 양쪽이 request method/URL로 읽혀 request 반만 클릭 가능했음
- pending intercept(라이브 요청/응답) 있으면 로그 재표시 차단 (활성 결정과 충돌 방지)
- 큐 `flex: 0 0 100px` / 로그 `flex: 0 0 150px` 고정 (height + max-height + overflow:hidden 방어) + 드래그 gutter — 콘텐츠 늘어도 메시지 에디터 안 줄어듦

#### Send to Browser
- 클릭 성공 후 Intercept 탭 자동 전환 (새 탭 요청이 큐에 올 위치에 미리 위치)

### v0.8.1 변경사항 (2026-05-06)
Intercept 응답 압축 디코딩 버그 수정. 기능 추가 없음.

#### Intercept Response 패널에 압축된 raw bytes가 그대로 표시되던 문제
- 증상: gzip/br/deflate로 압축된 응답이 Intercept Response 에디터에 `������Q(K-*��jU2...` 같은 깨진 문자로 노출. 사용자가 본문을 읽을 수도, 의미있게 수정할 수도 없음
- 원인: `proxy-server.js`의 `_forwardRequest` 응답 처리에서 `respBuf.toString('utf8')`만 호출하고 `Content-Encoding` 헤더를 무시 → 압축된 raw bytes를 panel로 직송
- 부수 영향: Forward Modified 시에도 사용자 입력(plain text)이 utf8 bytes로 변환되어 client에 전송되는데 `Content-Encoding: gzip` 헤더는 그대로 → 브라우저가 gzip 해제 시도 실패 → 응답 망가짐
- **수정** (`proxy-server.js` only, panel/bg/native 변경 없음):
  - 신규 `_decodeResponseBody(buf, contentEncoding)` 헬퍼 — `gzip`/`x-gzip` (`gunzipSync`), `deflate` (`inflateSync` → 실패 시 `inflateRawSync` fallback for raw deflate), `br` (`brotliDecompressSync`). `identity` / 빈 문자열은 raw 통과. 디코딩 실패해도 `hadEncoding: true` 반환 (stale 헤더 제거 위해)
  - `_forwardRequest`에서 `Content-Encoding` 보고 디코딩 → panel에 보낼 `body`는 디코딩된 텍스트
  - `pendingResponses` 엔트리 확장: `body` (raw, 압축됨) + `decodedBody` (디코딩됨) + `wasEncoded` (헤더 존재 플래그)
  - `_handleResponseDecision`:
    - `forward`: raw `body` 그대로 → 브라우저가 Content-Encoding 보고 정상 해제 (기존 동작 유지)
    - `forward_modified`: 사용자가 본 것은 plain이니 보내는 것도 plain → `wasEncoded`면 `Content-Encoding` 제거 + `Content-Length` / `Transfer-Encoding` 제거 (Node http가 자동 재계산)
- Network 탭의 응답은 영향 없음 — `chrome.devtools.network` API의 `getContent`는 이미 디코딩된 본문을 반환하므로 항상 정상 표시되어 왔음. 이번 버그는 프록시 경로(Intercept Response)에 한정

### v0.8.0 변경사항 (2026-05-06)
실사용 워크플로우에서 빠져있던 두 축 — **수집 데이터의 선택적 export**와 **캡처 요청을 실제 브라우저에서 인터셉트해서 재현** — 을 추가한 메이저 릴리스.

#### Network 행 선택 + Export Selected
- 각 요청 행 좌측에 체크박스 컬럼 추가 (`select-cell`, 기본 hidden → row hover 또는 checked 시 표시. master는 항상 표시)
- 헤더 행에 master checkbox — visible 전체 select / 부분 선택 시 indeterminate / 전체 선택 시 checked-toggle. **Scope 필터 적용된 view 기준** (`getVisibleRequests`)
- 툴바에 `[N selected] [X]` 카운터 pill (count=0이면 hidden)
- Export 메뉴 재구성: `All requests` 섹션(기존 Detection only / Full requests) + 구분선 + `Selected (N)` 섹션(동일 두 항목, 선택 0이면 disabled). `data-scope="selected"`로 분기. `exportDetectionResults(selectedOnly)` / `exportAllRequests(selectedOnly)`가 source를 `networkRequests.filter(r => selectedExportIds.has(r.requestId))`로 좁힘 — stats/totalRequests도 부분집합 기준
- 키보드: **Cmd/Ctrl+A** = visible 전체 선택 (Network 탭 active + 입력 필드 외 조건). **Shift+click** = 마지막 토글된 체크박스 ↔ 현재 클릭 사이 visible 범위 일괄 선택
- 행 체크박스 클릭과 select-cell padding 클릭은 **detail 패널 안 열림** (별도 워크플로우)
- 검색 매치 노란 막대(`box-shadow: inset 3px 0 0 #fbbf24`)는 select-cell로 위치 이동 — 행의 좌측 끝 시각 위치 보존
- selection 라이프사이클: Clear / overwrite import 시 reset, Scope 변경 시 selection 자체는 보존(`selectedExportIds` 그대로)하고 master indeterminate ratio만 재계산. flushPendingNetworkRows에서 새 unchecked 행 도착 시 master 상태 재계산
- 검색 매치 yellow-bar selector는 첫 컬럼 따라 `td.select-cell`로 이동

#### Send to Browser — 캡처 요청을 새 탭에서 인터셉트
실사용 페인 해결: "이미 수집된 요청을 분석하다 '이거 실제로 브라우저에서 발생시켜서 인터셉트해서 보고싶다'는 생각이 들 때, 사이트 처음부터 다시 들어가서 forward 반복하는 대신 한 번의 클릭으로 처리".

**검토 단계의 결정 트레일** (왜 이 설계로 갔는지):
- 1차 안: `inspectedWindow.eval('fetch(...)')` 페이지 컨텍스트 fetch — 응답이 페이지에 렌더링 안 됨 → reject
- 2차 안: `inspectedWindow.eval('location.href = ...')` 같은 탭 navigation — 페이지 상태 reload, Bearer 토큰 등 헤더 override 불가 → reject
- 3차 안 (채택): **새 탭 + launcher 페이지 + 프록시 헤더 swap + 일회성 DNR 룰**

**아키텍처**:
- 신규 `panel/launcher.html` + `launcher.js` — 새 탭에서 로드되어 `chrome.runtime.sendMessage({type: 'launcher_ready'})` 송신, payload 받아 `location.href = url` (GET) 또는 hidden form submit (POST form-encoded). chrome-extension:// URL이라 프록시 안 거치고 즉시 로드
- `proxy-server.js`: `pendingHeaderSwaps` Map (tabId → {url, headers, expiresAt: 30s TTL}). `_handleRequest`에서 tag 헤더 추출 후 `_consumeHeaderSwap(tabId, fullUrl)` — host+pathname+search 매칭. 매칭 시 `_applyHeaderSwap`로 캡처 헤더 머지 (lowercase 기준 overwrite) + `header_swap_consumed` 이벤트 emit
- `native-messaging-host.js`: `register_header_swap` dispatch + `header_swap_registered` ack, `header_swap_consumed` 이벤트 forward
- `background.js`:
  - `open_new_tab_for_intercept` 핸들러 → async `openNewTabForIntercept(payload)`
  - **별도 DNR 룰 base** `DNR_RULE_BASE_NEW_TAB = 20000` — 기존 `DNR_RULE_BASE = 10000`(inspected tab, 모든 resourceType)과 분리
  - `addNewTabTagRule`: **`main_frame`만** 태그 → 페이지의 subresource(CSS/JS/이미지)는 태그 없이 통과 → Intercept 큐 노이즈 0
  - 시퀀스: `chrome.tabs.create(launcher.html)` → addNewTabTagRule → `register_header_swap` 송신 → ack 대기 (`waitForSwapRegistered` 3s timeout) → `pendingLaunches.set(newTabId, payload)`
  - `header_swap_registered` 수신 → `_flushSwapRegisteredAcks` (Promise queue resolve)
  - `header_swap_consumed` 수신 → `removeNewTabTagRule(tabId)` — **일회성 인터셉트** (그 새 탭의 후속 navigation/링크 클릭은 인터셉트 안 됨, 사이트 자유 탐색 가능)
  - `chrome.runtime.onMessage` for `launcher_ready` — payload 즉시 회신 또는 `pendingLaunchWaiters`에 sendResponse parking (race 안전)
  - `chrome.tabs.onRemoved` cleanup — DNR 룰 + pending state 정리
- `panel.js`:
  - `↗ Send to Browser` 버튼 (detail header, tabs와 close-X 사이)
  - `BROWSER_MANAGED_HEADERS_S2B` 셋 — Cookie/Origin/Referer/User-Agent/Sec-Fetch-*/Content-Type 등 swap에서 제외 (브라우저가 새 탭 컨텍스트로 자체 결정)
  - `canSendToBrowser(req)` — GET ✅ / POST form-urlencoded ✅ / multipart ❌ / JSON ❌ / 그 외 ❌ + 비활성 사유 툴팁
  - `_parseFormUrlencodedFields` — body를 `{name, value}[]`로 파싱하여 launcher가 hidden input으로 재구성
  - `sendToBrowserNewTab`: 검증 → Intercept ON 체크 (자동 활성화 안 함, 토스트로 안내) → `open_new_tab_for_intercept` 송신
  - `selectNetworkRequest` / `closeDetail`에서 `updateSendToBrowserButton()` 호출 — disabled state + 툴팁 사유
  - `send_to_browser_error` 메시지 핸들러 → 토스트

**핵심 통찰** — 사용자 질문 "원본 탭 panel이 새 탭 요청을 처리 못하지 않아?"에 대한 답:
- **Network 모니터링** 경로 (`chrome.devtools.network.onRequestFinished`)는 탭 격리됨 → 새 탭 요청은 원본 panel의 Network 탭에 안 보임
- **Intercept** 경로는 panel-tab 결합 없음 — 프록시가 잡은 요청은 native messaging → background → **broadcastToPanels** (연결된 모든 panel에 전송) → 원본 panel의 Intercept 큐에 표시. 새 탭에 DevTools 안 열어도 됨

**제약**:
- Origin/Referer가 `chrome-extension://...`로 set됨 (launcher가 발생 origin) — 일부 서버가 CSRF Origin 검증 시 거부 가능. forward 전 Intercept 에디터에서 수동 수정으로 우회
- POST는 form-urlencoded만 지원 — JSON body / multipart file upload 등은 disable
- Intercept OFF 상태에서 자동 활성화 안 함 (이전 시도에서 race/timeout 이슈 발생) — 사용자가 명시적으로 ON 후 사용
- panel.js 수정 시 DevTools 완전 닫고 재오픈 필요 (확장 reload만으로는 panel JS 갱신 안 됨)

### v0.7.11 변경사항 (2026-05-06)
액션 popup의 stale 상태 표시 버그 수정.

#### Popup이 Chrome 재시작 후에도 이전 세션의 Scope/Monitoring을 표시
- panel.js는 scope 변경 / monitoring start·stop 시 `chrome.storage.local`에 `globalScopeInput`/`networkMonitoring`을 기록 → popup이 이를 읽어 표시
- Chrome 종료 시 panel 정리 콜백이 안 돌아 storage에 stale 값이 그대로 남음 → 재시작 후 popup이 "이전 세션의 scope가 활성" / "Monitoring active"처럼 잘못 표시
- 기존에도 `chrome.proxy.settings`가 동일한 cross-restart persistence 문제를 가지고 있어서 `background.js`가 SW 부팅 시 `resetProxySettings()`로 청소하던 패턴이 있었음 — 같은 위치에 storage clear 추가
- **수정**: `chrome.runtime.onStartup` 리스너에서 `globalScopeInput` / `networkMonitoring` 제거. 프로파일 시작에만 발화하므로 SW idle/wake 사이클로 panel의 활성 상태를 잘못 지우는 일은 없음. `autoStartMonitoring`은 사용자 영구 환경설정이라 보존

### v0.7.10 변경사항 (2026-05-05)
Network 탭에 키워드 검색 기능 추가. Scope(URL 도메인 필터)와는 별개로, 수집된 요청들의 **세부정보**에서 키워드를 찾아 매칭된 요청을 dot으로 표시하고 우측 상세 패널에 자동 하이라이트.

#### Network 검색
- **위치**: Network 툴바 끝 (Auto Crawl 옆) — `[Search requests...][X][▲][▼][3 / 12]`
- **검색 대상**: 요청 URL(전체 + 디코딩된 query params), 요청/응답 헤더(키+값), 요청 바디, 응답 바디(text only, base64 제외), Detection scanResults(evidence + location). Initiator 콜스택과 Replay 컴포저는 의도적 제외
- **검색 인덱스**: `req._searchIndex` lower-case 합본 문자열을 요청별 캐시. 캡처 시점에 1차 빌드, body 늦게 도착하면 재빌드(`reindexRequestForSearch`). 본문은 `AUTODECODE_BODY_LIMIT` (512KB)로 클립 — Detection/Auto Decode와 동일 한도 공유
- **Scope AND**: `recomputeSearchMatches`가 `inGlobalScope` 체크 후 매칭 — Scope 필터와 키워드 검색 둘 다 만족하는 요청만
- **좌측 행 표시**: 매칭 행에 `.search-hit` 클래스 → `td:first-child`에 노란 좌측 막대 (`box-shadow: inset 3px 0 0 #fbbf24`). 행은 안 사라짐(필터링 X), 시각 표시만
- **자동 흐름**: 검색어 입력 → debounce 300ms → 첫 매칭 자동 선택 + 우측 패널 오픈 + 매칭 있는 첫 탭으로 자동 전환 + 첫 mark로 스크롤. 활성 탭에 매칭이 있으면 그 탭 유지
- **prev/next 네비**: ▲/▼ 버튼 또는 Shift+Enter / Enter, 매칭 간 순환 이동(modulo). 매칭 0건이면 disabled
- **하이라이트**: `highlightMarksIn(rootEl, term)`이 TreeWalker로 텍스트 노드 walk → `<mark class="network-search-mark">`로 wrap. 4개 탭(Headers/Payload/Response/Detection)에만 적용. 매칭 있는 탭에 `🔍` 배지(`.detail-tab.has-search-match::after`)
- **카운트 표시**: 검색 input 옆 별도 배지(`3 / 12` 또는 `No matches`). 기존 `[N requests]` 배지는 무관하게 유지
- **검색어 비우기**: Esc / X 버튼 / 빈 input → mark/dot/배지 모두 제거, 선택된 요청은 그대로 유지
- **Clear Network**: 검색어는 유지하되 매칭 리스트는 빈 상태로 리셋 (사용자가 새로 채워질 데이터에 같은 검색어 계속 적용)
- **Import / Scope 변경**: `_applyImport`와 `applyGlobalScope`에서 인덱스 빌드 + recompute 자동 호출

#### URL 인덱싱 결정
- 처음엔 "URL은 Scope가 담당" 원칙으로 인덱스에서 제외했으나, Scope의 정체성은 도메인 필터링이고 단어 필터링은 부수 효과라는 사용자 정정에 따라 URL도 인덱스 포함으로 변경
- `req.url` 전체(인코딩된 raw 형태) + `searchParams` 디코딩 값 양쪽 다 인덱스에 추가 → `?q=hello%20world`도 `hello world`로 매칭

### v0.7.9 변경사항 (2026-05-03)
실사용 중 발견한 자잘한 정렬/식별 이슈를 정리한 패치 릴리스. 기능 추가 없음.

#### Scope 매칭 — 비표준 포트 무시
- 패턴이 포트를 명시하지 않은 경우(`*.dhlottery.co.kr/*`), 캡처된 URL의 비표준 포트(`tracer.dhlottery.co.kr:48081/...`)가 매칭에서 누락되던 문제. `inGlobalScope`에서 host+port 매칭 1회 후 host-only(no-port) 매칭 1회를 추가로 시도하는 double-match로 변경

#### Site Map 좌측 트리 간소화
- **Method 배지 제거**: 행 레이아웃에서 GET/POST 등 메서드 배지를 제거. 각 행은 `[toggle][icon][경로/도메인 (flex:1)][카운트 (우측)]` 4요소만. `getNodeMethods` 함수 + 6개 method-dot CSS 클래스도 dead code로 제거
- **호스트 행 정렬 통일**: `.sitemap-scope-select`를 `position: absolute`로 빼서 layout space를 점유하지 않도록 변경. host 행이든 child 행이든 카운트 위치가 동일하게 우측 끝에 정렬됨. 호버 시 scope select는 우측 위에 absolute 배치 (배경색 보존)
- **카운트 박스 스타일 제거**: `background`/`padding`/`border-radius` 등 박스 styling 제거 → 자연스러운 텍스트로 표시. `min-width: 24px` + `text-align: right`로 자릿수 변동 시에도 정렬 유지

#### Site Map 우측 상세 패널
- **컬럼 고정폭 레이아웃**: 각 행을 `[Method 50px][URL flex:1][Status 40px right][Type 90px nowrap+ellipsis][Replay 60px]`로 고정. URL이 길어도 컬럼 정렬 유지, `x-component`/`x-unknown` 같은 Type이 두 줄로 wrap되지 않음
- **Status-Type 시각 분리**: status에 `margin-right: 16px` 추가. 기존 8px gap과 합쳐 24px 시각 분리 — `200 html`이 붙어 보이지 않음
- **호스트 헤더 폰트 통일**: `.sitemap-detail-path`를 시스템 폰트 + weight 500으로 변경 — Page Scan 헤더(`Page Scan · N Links · ...`)와 동일 스타일. monospace `.page-scan-title` 오버라이드 제거

#### Page Scan
- **Links 섹션**: Replay 버튼을 **Open** 버튼으로 교체. 클릭 시 `window.open(url, '_blank')`로 새 탭에서 열기. Forms는 Replay 유지(다양한 method/body 조합 테스트), Scripts는 버튼 없음 유지
- **버튼 활성화 게이트 부활**: 선택된 노드의 host가 현재 inspected 탭의 host와 다르면 비활성화 + 툴팁 `Page Scan only works on the currently open page`. v0.7.7에서 항상 활성화로 풀었던 동작을 selected-vs-target 비교 기준으로 부활. 선택 없거나 host 일치 시 활성화 (Page Scan은 inherently 현재 페이지 DOM 스캔이므로)


실제 사용 중 발견한 행동 차이 두 가지를 정리한 작은 릴리스. 의미 정렬에 가까운 변경이지만 사용자 체감이 큼.

#### Auto-start — HAR 백필 추가
- 문제: Auto-start가 켜져있어도 패널 오픈 직후 테이블이 비어있고, 페이지 새로고침/재방문해야 요청이 잡히기 시작했음. `chrome.devtools.network.onRequestFinished`가 listener attach 이후의 새 요청에만 fire하기 때문 — 이미 로드 완료된 페이지의 historical 요청은 누락
- 해결: listener body를 `processNetworkRequest(harEntry)`로 추출. Auto-start가 monitoring을 켜면 곧바로 `chrome.devtools.network.getHAR()`로 historical entries를 가져와 같은 파이프라인에 통과
  - **dedup**: `_ingestedRequestKeys` Set이 `(method|url|status|startedDateTime)` 키로 live listener와 HAR replay 사이 중복 방지. `clearNetwork`에서 reset
  - **inline body**: HAR-replay된 entry의 `response.content.text`가 이미 채워진 경우 직접 사용 (getContent 호출 절약)
  - **Manual Start는 미적용**: 사용자가 직접 Start를 누르는 건 "지금부터 깨끗이 시작" 의도이므로 backfill 안 함

#### Detection — SQLi/LFI/SSRF/RCE/debug → Tampering 단일 통합
- 5개 카테고리 distinguish가 실제로는 노이즈였음 (`query` 파라미터가 SQL search인지 URL filter인지 debug toggle인지 이름만으로 구분 불가). 워크플로우는 어차피 Replay 탭에서 페이로드 시도 → 응답 관찰로 동일
- 단일 **🔨 Tampering** (MEDIUM) 카테고리로 합침
  - keywords는 5개 그룹의 union (SQLi의 `string`/`number`, RCE의 `ping`/`system`/`proc`/`process` 등 노이즈성은 제외)
  - LFI의 `page`/`include` per-keyword severity override 제거 — 모두 MEDIUM
  - SSRF의 `redirect`/`return`/`continue` HIGH override, `ref` LOW override도 제거
  - 노이즈 필터(`_scanIsHuntNoise`)는 카테고리 키만 `'ssrf'` → `'tampering'`으로 교체. `domain` 정확매칭/`redirect` timing suffix 제외 로직은 그대로 유지
- **안내 문구 통합**: 5개 안내 → 1개로 축약 + 모든 테스트 패턴 한 번에 (Special chars / Path / External URLs / Command / Template)
- **CSS**: `.scan-badge-{sqli,lfi,ssrf,rce,debug}` 5개 제거, `.scan-badge-tampering` 신규 (amber 톤)
- **자동 반영**: badge dedup / Detection 탭 그룹화 / Export JSON / stats byCategory 모두 finding의 `category` 필드를 통해 작동하므로 별도 코드 수정 없이 자동 통합

### v0.7.7 변경사항 (2026-05-02)
Site Map / Network / Scope의 의미를 멀티-사이트 워크플로우(여러 사이트를 옮겨다니며 데이터 누적 → 분석)에 맞춰 재정의한 릴리스. Detection 추가 정밀화 + 코드베이스 영문 일괄 전환도 함께 반영.

#### Site Map — Preserve-log + per-main-host External
- **navigation 시 트리 wipe 제거**: 이전엔 cross-origin 이동 시 sitemapTree 전체 비웠는데, 이제 호스트별 누적. 사용자가 siteA → siteB → siteC 이동해도 모두 트리에 보존
- **`_lastVisitedUrl` / `_lastVisitedAt` 메타** 호스트별 기록. host 노드 hover 시 "Last visited: <url> (timestamp)" 툴팁
- **`detectTargetHost`가 `location.href`까지 fetch**: 초기 페이지(`onNavigated` 미발화)도 메타 설정 → 첫 site 누락 버그 수정
- **현재 target host 시각 강조**: `.sitemap-node-target` 클래스로 파란 + bold (#1a73e8). 이전 방문 host는 일반 표시
- **per-main-host External 그룹**: 단일 전역 External → 각 main host의 자체 External 자식 그룹
  - 데이터 모델: `sitemapTree[mainHost] = { children, requests, external: { extHost: { children, requests } } }`
  - `addToSitemap`: request의 host === targetHost → main 트리, 아니면 → main host의 `external[host]`
  - `_sitemapPending` 큐 — targetHost 미설정 시 버퍼링, detect/navigate 시 flush
  - `expandedNodes`에 `${mainHost}:__external__` 키로 사이트별 External 펼침 독립 관리
  - `getNodeByPath` fallback 검색으로 external 노드 클릭 → 상세 패널 정상 동작
- **render throttling**: `scheduleSitemapRender` (rAF 배칭 + sitemap-tree 내부 focus 시 deferral)로 burst 트래픽에서 Set Scope select가 destroy되지 않도록
- **Page Scan 결과 헤더 통합**: 별도 summary 블록 → 단일 헤더 `Page Scan · 110 Links · 2 Forms · 13 Scripts` (Network 상세 패널 헤더와 톤 일치)
- **Page Scan 버튼 항상 활성화**: 이전엔 비-target host 노드 선택 시 비활성화됐는데, preserve-log 환경에서 부적절하여 항상 활성화 (Page Scan은 늘 현재 inspected page를 스캔)

#### Network — 컬럼 확장 + Initiator/Host 시각화
- **Host 컬럼 추가**: Method 앞에 첫 컬럼으로. 150px 고정. 호스트네임만 표시(URL 컬럼은 path+search 그대로). target host는 일반 색, external은 italic + 회색으로 시각 구분. title 속성에 full URL
- **Initiator 컬럼 추가**: Time과 Detection 사이. `↑ Mapped` (소스맵 매핑 성공) / `script` / `parser` / 빈 칸 4가지 상태. 매핑 결과는 `req._sourcemapMapped` 플래그로 sticky. **셀 클릭 시 Detail panel의 Initiator 탭으로 자동 포커스** (selectNetworkRequest의 `opts.activateTab`)
- **최종 Network 컬럼 순서**: Host / Method / URL / Status / Type / Size / Time / Initiator / Detection

#### Scope — capture 필터 + view 필터 통합
- **이중 필터 동작**: 기존 `inGlobalScope`로 onRequestFinished에서 capture 게이팅하던 것에 더해, 이미 캡처된 데이터도 같은 패턴으로 view 필터링
  - `matchesSitemapFilters` 진입부에 `inGlobalScope` 체크 추가 → Site Map 트리 / 노드 카운트 / 메서드 dot / 상세 패널 모두 자동 반영
  - `renderNetworkTable`이 `networkRequests`를 `inGlobalScope`로 사전 필터링 후 렌더
  - `applyGlobalScope`/`Clear` 버튼 → Network/Site Map 즉시 재렌더
- **Network 카운트 표시**: scope 활성 시 `142 / 823 requests (filtered)` 형식. 비활성 시 기존대로
- **placeholder 갱신**: `*.site.com, api.example.com — empty = show all`

#### Detection 추가 튜닝
- **HUNT 토큰 strict 매칭**: `_scanMatchHunt`가 모든 토큰이 HUNT 키워드여야 매칭. 한 토큰이라도 비-HUNT면 즉시 null 반환. `isBackForward` / `open_graph` / `ping_second` / `operating_system` 같은 false positive 제거. `_scanTokenize`에 dot(`.`) 분리 추가 — `data.id` → `[data, id]`
- **LEAK `/home/` 정밀화**: `[A-Za-z0-9_-]+` → `[a-z][a-z0-9_-]*(?![\w/])`. `/home/_next` (Next.js 자산) / `/home/12345` (숫자만) / `/home/foo/bar` (URL 경로) 모두 제외. `/home/<lowercase 단어>`로 끝나는 경우만 매칭

#### 코드베이스 영문 일괄 전환
- 모든 in-code 한국어 텍스트를 영어로 (UI 라벨, placeholder, toast, 에러, 로딩 메시지, Detection 카테고리 안내 14개)
- CLAUDE.md changelog 및 사용자 conversation은 한국어 유지
- `feedback_english_only` 메모리 강화 — GitHub 공개 대비 코드베이스는 영문이 기본

#### Initiator 탭 — Detection-style 그룹으로 통일
- **Type 그룹**: 단일 라인 plain text → `.detection-group` 카드 (Detection 탭과 동일 클래스 재사용)
  - `[script] · Call Stack N frames` / `[parser] · triggered by static markup` / 매핑 후 `[↑ Mapped] · N frames mapped`로 자동 승격
  - 헤더 클릭 시 description card 펼침/접힘. 호버 tooltip도 동시 유지
- **Pattern 그룹들**: 매칭된 sensitive 패턴별로 1개씩 `.detection-group` 생성 — 헤더(badge + 카운트 + chevron) + description card + findings list
  - findings 각 항목은 `.detection-finding`으로 severity 배지(HIGH/MEDIUM/LOW/INFO) + funcName + file:line 표시
- **신규 `SENSITIVE_PATTERN_SEVERITY` 맵**: HIGH (OTP/MFA, Authentication, Token, Authorization, Credential, File Operation, Payment) / MEDIUM (Validation, Crypto, Navigation)
- **클릭 핸들러 통합**: `_onDetectionGroupClick`을 컨테이너에 attach해서 Detection 탭과 동일한 toggle UX
- **enrichFramesWithSourceMaps 갱신**: 매핑 성공 시 Type 그룹 badge `script` → `↑ Mapped`, description card 내용도 mapped 설명으로 swap, count `N frames mapped`로 갱신
- **CSS 정리**:
  - 추가: `.scan-badge-init-{script,parser,mapped,unknown,other}`, `.scan-badge-sens` (모두 `.scan-badge` 베이스)
  - 제거: `.initiator-type` / `.initiator-type-block` / `.initiator-type-desc` / `.initiator-info-toggle` / `.initiator-hint` / `.initiator-hint-desc`
- **Call Stack 섹션 보존**: 기존 frame-by-frame 리스트 + 인라인 source viewer + 소스맵 ↑ 표시 그대로 유지 (소스 브라우징 기능 유지)

### v0.7.6 변경사항 (2026-05-01)
실사용 데이터 분석 결과를 기반으로 한 Detection 룰 정밀화 + Import/Export 사이클 + 자동화 보조 기능. 룰 기반 라벨링 도구의 사용성을 모의해킹 워크플로우 전반으로 확장한 릴리스.

#### Detection 룰 튜닝 (실측 분석 기반)
- **IDOR 정밀화**:
  - URL path 숫자 세그먼트 검출 **전체 제거** (실측 결과 빌드 timestamp / 버전 / 광고 creative ID 100% 오탐)
  - 키 매칭은 유지하되 `_shouldFlagAsIdor(key, value)` 단일 결정점으로 통합
  - **트래킹 키 denylist** (정규화 비교): `impression_id`/`imp_id`/`toros_imp_id`/`toros_page_meta_id`/`tesla_content_id`/`pageview_id`/`click_id`/`tracking_id`/`log_id`/`anonymous_id`/`event_id`/`request_id`
  - **광고/SDK 값 prefix 필터**: `DAN-` (Kakao Ads), `sodar`, `av-`
  - **고정 플래그값 필터**: `control` / `default` / `N` / `Y` / `true` / `false` / `none` / `null` / `undefined`
  - 빈 값 / boolean 필터
  - `_scanIsYearLike` 헬퍼 제거 (URL path 검출과 함께 죽은 코드)
- **SSRF 정밀화 + per-keyword severity**:
  - `HUNT_CATEGORIES` 구조 확장: `defaultSeverity` + 옵션 `keywordSeverity` (per-token override)
  - `window` 키워드 **제거** (windowInnerWidth 등 브라우저 속성 노이즈)
  - `_scanIsHuntNoise` post-match 필터:
    - `domain`은 정확히 `domain` 토큰만 매칭 (domainLookupStart/End 제외)
    - `redirect`는 timing suffix(`Start`/`End`/`Time`/`Duration`) 동반 시 제외
  - severity: HIGH(`redirect`/`return`/`continue`) / MEDIUM 기본(`url`/`callback`/`next`/`host`/`domain`/`uri`/`forward`/`navigate`/`open`/`feed`/`dest`/`destination`) / LOW(`ref`)
  - 컴파운드 entry (`return_url`/`redirect_uri`/`redirect_url`) 제거 (토큰화로 자동 처리)
- **LFI per-keyword severity**:
  - 키워드 모두 유지 (`page=1` 같은 숫자값도 LFI 테스트 포인트)
  - severity: HIGH 기본(`file`/`path`/`dir`/`directory`/`document`/`template`/`doc`/`folder`/`root`/`pdf`/`pg`/`style`) / MEDIUM(`page`) / LOW(`include`)
- **신규 `low` severity 등급**: `sevOrder = { high: 0, medium: 1, low: 2, info: 3 }`. CSS `.detection-severity.sev-low` (회색 톤)

#### Detection 카테고리별 안내 문구
- `DETECTION_CATEGORY_DESCRIPTIONS` 맵 — 14개 카테고리 모두 한국어 안내 추가
- 카테고리 의미 + 위험성 + Replay 검토 방법 + 페이로드 예시 (SQLi/LFI/SSRF/Privilege/debug 등)
- Detection 탭에서 그룹 헤더 또는 finding 클릭 → 안내 토글 (`▾`/`▴` chevron)
- 안내 블록 자체 클릭은 무시 → 텍스트 복사/선택 보호
- 헤더 hover 시 배경 강조

#### Network Import (Export 역방향)
- **Import 버튼** Network toolbar에 추가, Export 옆 배치
- 두 가지 export 포맷 모두 지원:
  - Detection-only: `items` 배열 + `findings`
  - All-requests: `items` 배열 + `requestHeaders`/`responseBody`/`scanResults`/`initiator` 등 전체
  - 방어적: `requests` 배열도 fallback 인식
  - flat 형태(`{method, url, ...}` 직접) / wrapped 형태(`{request: {...}, ...}`) 둘 다 지원
- **Validation**: `exportedAt` + `items|requests` 필드 검증, 실패 시 에러 토스트
- **3-way 확인 모달**: 기존 데이터 있을 때 `덮어쓰기` / `기존에 추가` / `취소`
- Import된 요청은 `_imported: true` + `_harEntry: null` 마커 → `fetchResponseBody` 단락 평가
- **Detection-only import의 Response 탭**: "imported file에 포함되지 않은 데이터입니다" 표시 (renderResponseBody 분기)
- **Import notice bar**: Network 테이블 위에 `📂 imported: <filename>` 표시 (X로 dismiss)
- **Replay/Detection은 정상 동작**: 임포트된 데이터도 url/method/headers/body 있으면 replay 가능, scanResults는 그대로 표시

#### Export 개선
- **Export 드롭다운**: 단일 버튼 → `Export ▾` 드롭다운으로 전환. `Detection only` / `All requests` 선택
- **파일명에서 host 제거**: `devtoolspp-detection-<host>-<ts>.json` → `devtoolspp-detection-<ts>.json` / `devtoolspp-full-requests-<ts>.json`
- **All-requests 포맷에 size/time/rawSize/rawTime 추가**:
  - `size`/`time`: 표시용 문자열 ("2.3 KB", "120 ms")
  - `rawSize`/`rawTime`: 정렬·필터용 숫자 (bytes, ms)
  - 라이브 캡처 req 객체에도 `rawSize`/`rawTime` 항상 보관 → export round-trip lossless
- 헬퍼 추출: `_downloadJson` / `_exportTimestamp` / `_exportMetadata` 두 export 경로 공유

#### Auto Crawl
- **위치 이동**: Site Map → Network toolbar (`Clear / Import / Export ▾ / Auto Crawl` 순서)
- **`.txt` 파일 import**: 모달의 "Import .txt" 버튼 → 파일 선택 → URL 텍스트영역 자동 채움 (256KB cap)
- 텍스트영역은 import 후에도 편집 가능. 크롤 진행 중에는 import 비활성

#### Auto-start 모니터링 환경설정
- 헤더 우측에 `[☐ Auto-start]` 체크박스
- `chrome.storage.local`에 `autoStartMonitoring` 영속화
- 패널 열기 시 storage 읽어 활성화돼 있으면 `startNetworkMonitoring()` 자동 호출
- manifest에 `storage` 권한 재추가 (v0.5에서 미사용으로 제거됐던 것)

### v0.7.5 변경사항 (2026-04-30)
Detection 룰 확장 + Network 성능 대폭 개선 + Auto Crawl/Export 기능 추가. 모의해킹 워크플로우(정찰→수집→분석)에 필요한 도구가 한 묶음으로 들어왔습니다.

#### Detection — HUNT 스타일 파라미터 사전 (5개 신규 카테고리)
Bugcrowd HUNT를 참고로, 취약점 종류별로 자주 연관되는 파라미터 이름 사전 기반 후보 라벨링.
- **💉 SQLi** (HIGH): query, search, filter, sort, where, select, order, keyword, column, field, report, row, string, number
- **📁 LFI** (HIGH): file, path, dir, directory, document, template, include, page, doc, folder, root, pdf, pg, style
- **🌐 SSRF** (HIGH): url, redirect, dest, destination, callback, return, next, host, domain, uri, continue, forward, window, navigate, open, feed, ref, return_url, redirect_uri, redirect_url
- **💻 RCE** (HIGH): cmd, exec, command, shell, ping, execute, run, system, proc, process
- **🔧 debug** (MEDIUM): debug, test, dbg, config, toggle, enable, disable, reset, adm, cfg
- **토큰 기반 매칭**: `_scanTokenize` (camelCase → snake_case → split). `file_path`/`upload_file`/`filePath` 모두 매칭, `profile`/`research` 같은 영단어는 단일 토큰이라 false positive 회피
- **합성 키워드 처리**: `return_url` 같은 dictionary entry는 빌드 시점에 토큰 분해되어 단일 토큰만 lookup map에 저장
- **위치 기반 dedup**: `_scanLocationHasFinding`로 IDOR/privilege/sensitive 등이 이미 같은 location을 검출했으면 HUNT skip
- evidence 형식: `matched "<token>" in "<paramName>" = <value>` — 어떤 키워드가 매칭됐는지 명시

#### Detection — 신규 'session' 카테고리
- **🔐 session** (MEDIUM): 요청 query/body의 `session_id`/`sessionId`/`session_token`/`sessionToken`/`auth_token`/`authToken` 검출. 값이 비어있지 않을 때만
- **token vs session 분리**: token = 응답측에서 토큰 노출, session = 요청측에서 세션/인증값 전달 (의미 분리)
- `access_token`은 의도적으로 session에서 제외 — 응답측 token 카테고리만 남김
- IDOR 검사 진입부에서 `_scanCheckSessionKey` 단락 평가로 `session_id`/`sessionId`가 IDOR 발화 안 함 (session으로 단일화)
- 긴 값은 `(N chars)`로 마스킹

#### Network 성능 대폭 개선 (대량 요청 사이트 대응)
대형 포털(daum 등)에서 200+ 요청 burst 시 UI 버벅임 해결.
- **Append-only 렌더링**: 기존 `renderNetworkTable` 매번 innerHTML 통째 재구성 → `buildNetworkRow(req)`로 단일 row만 빌드해 append. DocumentFragment 사용해 reflow 1회
- **requestAnimationFrame 배칭**: `_pendingNetworkRows` 큐 + `_networkRenderRaf` ID. burst가 와도 한 frame당 1번 flush
- **`MAX_NETWORK_ROWS = 1000` cap**: 초과 시 가장 오래된 DOM row 제거. count 배지 `5234 requests · showing last 1000` 형식. 데이터 자체(`networkRequests`)는 유지 → export, requestId 접근 가능
- **Body 로드 큐 (`MAX_CONCURRENT_BODY_LOADS = 5`)**: `harEntry.getContent` 동시 5개 제한. race-safe (큐에서 꺼낼 때 `responseBodyLoaded` 재확인). 사용자 클릭은 큐 우회 (`fetchResponseBody`)
- **`requestIdleCallback`로 body scan 비동기화**: 1차 스캔(URL/headers, 빠름)은 sync 유지, body 로드 후 무거운 scan은 idle time
- **클릭 핸들러 delegation**: row마다 listener 부착 → tbody 1개 delegation으로 전환
- **data: URI 수집 차단**: `onRequestFinished` 진입부에서 `startsWith('data:')` 체크 후 즉시 return. 인라인 base64 이미지 폭주 방지
- **`truncateUrl` 방어**: 이미 수집된 data: URI는 `[data URI] image/png` 형식으로 축약 표시

#### Auto Crawl
- Site Map 탭에 `Auto Crawl` 버튼 + 모달 (URL 목록 textarea + 페이지당 대기시간 입력)
- 줄바꿈 구분 URL 목록 → 전처리 (dedup, `https://` 자동 prepend, `new URL()` 검증, 200개 cap)
- 모니터링 OFF면 자동 ON. 순차 방문은 `inspectedWindow.eval('location.href = ...')` + setTimeout 페이싱
- Stop / Cancel / 모달 X 모두 즉시 중단, 현재 페이지 유지, 모니터링 계속
- 진행 표시: 파란 fill bar + `N/total` 카운트 + 현재 URL
- 완료 시 하단 중앙 토스트 (`완료: N개 사이트 방문`) + 모달 자동 닫힘
- 에러 URL은 skip하고 계속 진행
- 사용 시나리오: 여러 사이트 일괄 방문 → Detection 누적 → Export로 수집

#### Detection Export (JSON)
- Network toolbar에 `Export` 버튼 추가
- 룰 튜닝/오탐 분석에 최적화된 슬림 JSON 포맷:
  - 메타: `exportedAt`, `extensionVersion`, `targetHost`, `scope`
  - `stats`: `totalRequests`, `requestsWithFindings`, `byCategory`, `bySeverity`
  - `items`: finding이 있는 요청만 포함 — `request` (method/url/status/mimeType/type) + `findings` 배열
- 응답 본문 미포함 (룰 튜닝엔 evidence 문자열로 충분)
- 파일명: `devtoolspp-detection-<host>-<timestamp>.json`
- 사용 시나리오: 여러 사이트 데이터 수집 → 분석가에게 전달 → false positive 패턴 식별 → 룰 조정

### v0.7.4 변경사항 (2026-04-28)
모의해킹/보안 워크플로우 강화 — 정찰(Detection 자동 라벨링), 페이로드 분석(Auto Decode), 콜스택 추적(소스맵 디코딩) 3축이 한 번에 추가되었습니다.

#### Initiator 소스맵 디코딩
- v3 source map 자체 디코더 (외부 라이브러리 0). VLQ base64 디코더 + delta-encoded segment 파서 + 이진 탐색 lookup
- `//# sourceMappingURL=` 추출 → 외부 .map URL 또는 `data:` URI 인라인 맵 둘 다 지원 (webpack `eval-source-map` 등 dev 환경 커버). Index source maps(`sections`) 미지원
- `fetchSource` 리팩토링: `chrome.devtools.inspectedWindow.getResources()` 우선 시도 → `webpack-internal://` 가상 URL과 cross-origin 스크립트도 접근 가능. 실패 시 기존 `inspectedWindow.eval(fetch...)` 폴백
- 콜스택 프레임 비동기 enrichment: `script.js:42:5` → `↑ Auth.tsx:42:5  script.js:42` 형태로 매핑된 위치 + 번들 위치 양쪽 표시
- 인라인 소스 뷰어: `sourcesContent[idx]` 인라인된 경우 원본 직접 표시. 없으면 번들 fallback
- Initiator 탭 라벨에 `↑` 인디케이터 — 매핑된 프레임이 1개라도 있으면 표시. 툴팁에 `Source-mapped frames: N / M`. 새 요청 선택 시 리셋
- 상수: `sourceMapCache` (스크립트 URL → 파싱된 맵 또는 null) 세션 전체 캐시

#### Auto Decode Layer (Headers / Payload / Response)
- 5개 디텍터: **JWT** (3-segment + base64url + JSON 검증, `alg: none` / `exp` 만료 경고, payload의 `exp/iat/nbf/auth_time` 자동 humanize), **Base64** (8~8192자, 4 배수, 95% 이상 printable), **URL-encoded** (`%XX` ≥ 2회), **Nested JSON** (`{`/`[` 시작 + JSON.parse), **Unix timestamp** (10자리 초 또는 13자리 ms, 2001~2286 범위)
- 우선순위: JWT → URL-enc → Nested JSON → Base64 (한 문자열당 첫 매치)
- 스캐너: `autoDecodeScanValue` (재귀 walk), `autoDecodeScanHeaders` (Bearer/Basic/Token prefix 자동 strip), `autoDecodeScanBody` (JSON / form-urlencoded / raw 자동 분기)
- **본문 크기 제한**: 500KB 초과 시 앞 50KB만 분석 + `TRUNCATED` notice (펼침 없는 인라인 배너)
- MAX_FINDINGS 50 안전 한도
- `<details>` 기반 접이식 카드, 타입별 색상 배지 (JWT 빨강, Base64 주황, URL-enc 초록, Nested JSON 보라, Timestamp 회색, Notice 노랑)

#### Response Pattern Detection (Network 탭)
- 새 "Detection" detail 탭 + Network 목록 우측에 "Detection" 컬럼 (인라인 배지 클러스터)
- 8개 카테고리:
  - 🔑 **token** (HIGH): 응답 body의 JWT 패턴(`eyJ...`, `detectJWT`로 검증), JSON의 `api_key/access_token/secret` 필드
  - 👤 **PII** (MEDIUM): 이메일, 한국 휴대폰 (010/011/016/017/018/019-xxxx-xxxx). 이메일 도메인이 `localhost(:port)` 또는 IPv4면 제외 (내부 서비스 참조)
  - ⚠️ **leak** (MEDIUM): 내부 IPv4 (10.x, 172.16-31.x, 192.168.x), 스택트레이스 키워드, 서버 경로 (`/var/www`, `/home/`, `C:\Users`, `/etc/passwd|shadow|hosts`)
  - 🔴 **sensitive** (HIGH): JSON의 `password/passwd/pwd/secret/private_key/client_secret` 필드 — **요청 body와 응답 body 양쪽** 스캔
  - 🔢 **IDOR** (INFO): URL 경로의 3+ 자리 숫자 세그먼트(연도 1900–2099 제외), query/body 키 — `id` 단독, 카멜케이스 `xxxId`/`xxxID`, 구분자 `xxx_id`/`xxx-id` 매칭. `paid`/`valid` 같은 영단어는 false positive 회피
  - ⚠️ **privilege** (HIGH): query/body의 `role/isAdmin/admin/privilege/permission`
  - 🔍 **check** (INFO): 401/403 + body ≥ 1KB. `Content-Type: text/html`이면 제외 (SPA 앱 셸/로그인 페이지 정상 동작 무시)
  - 📡 **exposure**: 응답 헤더 `Server`/`X-Powered-By`의 `<software>/<x.y.z>` 버전 노출 (MEDIUM, 헬퍼 `_scanExtractServerVersion`), 응답 body의 AWS 액세스 키(`\bAKIA[A-Z0-9]{16}\b`, HIGH), GitHub PAT(`\b(ghp|gho|ghs)_[A-Za-z0-9]{36,}\b`, HIGH — evidence는 prefix만 노출하여 토큰 유출 방지)
- `req.scanResults`에 findings 배열 저장. (category, location)별 dedup
- `onRequestFinished`에서 즉시 1차 스캔(URL/query/body/status), text-like mimetype이면 `harEntry.getContent`로 본문 eager load 후 2차 스캔. 2차 스캔은 해당 row의 badge cell만 inline 갱신 (전체 re-render 회피)
- 본문 500KB 초과 시 앞 50KB만 분석 (Auto Decode 상수 재사용)
- Detection 탭: 카테고리별 그룹, 심각도(HIGH/MEDIUM/INFO) 색 구분, 최대 심각도 순 정렬, 탭 라벨에 빨간 카운트 배지

#### Network 키보드 네비게이션
- ↑/↓로 요청 목록 이동 (input/textarea/select/contentEditable 포커스 중에는 비활성)
- click 핸들러를 `selectNetworkRequest(reqId, opts)`로 추출. click은 `scroll: false`, 키보드는 `scroll: true` (block: 'nearest')
- 양 끝에서 정지 (순환 안 함). 선택 없을 때 ↓는 첫 항목, ↑는 마지막 항목

#### 명칭 변경
- Site Map: "Scan Page" → **"Page Scan"** (`sitemap-page-scan` id, `runPageScan` / `showPageScanResults` / `buildPageScanSection` / `updatePageScanButton`, `.page-scan-summary` CSS)
- Network detail tab: "Scanner" → "Inspector" → 최종 **"Detection"** (`detail-detection`, `data-detail="detection"`, `renderDetection`, `.detection-*` CSS)
- Network 컬럼 헤더: "Scan" → **"Detection"**

### v0.7.3 변경사항 (2026-04-26)
기능 추가/제거 없이 UI 정리 및 시각 정체성 개편에 집중한 릴리스.

- **분할 패널 리사이즈**: 4곳의 split (Site Map 트리↔상세, Network 목록↔상세, Intercept Request↔Response, Intercept dual↔Log strip) 모두 드래그로 크기 조정 가능. 공통 `.split-gutter` 컴포넌트 — 4px wide bar, hover/drag 시 파란색, 다음 sibling 패널을 inline `flex-basis`로 리사이즈, min-size 80px clamp, 인접 pane이 `.hidden`일 때 `:has(+ .hidden)`로 자동 숨김
- **Site Map "Set Scope" 드롭다운**: 호스트 노드(top-level)에 hover 시 표시되는 `<select>`. 두 옵션 — Exact: `<host>` (그대로) / Wildcard: 좌측 라벨 1개 제거(3+ 라벨) 또는 prepend `*.` (2 라벨). IPv4/IPv6/단일 라벨은 와일드카드 옵션 비표시. 선택 즉시 글로벌 Scope 입력에 `<pattern>/*`로 채우고 `applyGlobalScope()` 호출
- **헤더 단일 행 압축**: 기존 3행(타이틀/탭/Scope) → 1행. 좌측 고정(타이틀+탭), 우측 `flex: 1` Scope bar. 탭/Scope 사이 `border-left` 세로 구분선 + 14px padding으로 시각 분리. 탭 추가 시 Scope 입력창이 자동으로 줄어듦
- **Intercept 상단 정리**: 3행 toolbar(controls/rules/shortcuts) → 1행 + 토글 행
  - 메인 toolbar: Intercept 토글, status pill, Req/Resp, Method 필터, spacer, Forward All/Drop All(`btn-xs`), `⚙ Rules` 토글, `?` 단축키 도움말
  - Rules 행 (자동 통과 확장자 8개 + bypass regex)는 기본 숨김, `⚙ Rules` 클릭 시 펼침
  - 단축키 도움말 행 제거 → `?` 버튼 title 툴팁으로 통합
  - 중복 표시 제거: rules 행의 `0 paused` 배지(사이드 헤더와 중복), 응답 에디터 상단 `RESPONSE` 배지(사이드 헤더와 중복)
  - 프록시 status: 인라인 스타일 → `.icpt-status-pill` + `.status-active`/`.status-warn`/`.status-error` 클래스. "Proxy: " prefix는 렌더 시점에 strip
- **시각 정체성**: 타이틀 `DevTools++` Google 컬러 — `DevTools` `#4285F4`(Blue) / 첫 `+` `#EA4335`(Red) / 둘째 `+` `#FBBC04`(Yellow). 폰트 사이즈 14px → 12px (탭과 동일)
- **활성 탭 스타일**: 하단 underline → 둥근 박스 (배경 `#E8F0FE` / 테두리 `#C5D9FB` / 텍스트 `#1A73E8` / weight 500). 비활성 탭은 transparent 1px border로 dimensions 동일 (active 토글 시 layout shift 없음)
- **Intercept 탭 컬러 정상화**: `.intercept-tab`의 `color: #d32f2f !important` 등 모든 빨강 override 제거 — 다른 탭과 동일한 색상. Intercepting 활성 상태는 `::before` pseudo-element의 작은 펄싱 빨간 점(6px, opacity 펄스)으로 보존
- **Scope Apply/Clear 버튼 크기 통일**: Apply가 `btn`, Clear가 `btn-xs`였던 불일치 → 둘 다 `btn-xs`
- **데드 코드 제거**: `.icpt-shortcut-bar`, `.icpt-stage-badge`, `.icpt-stage-req`, `.icpt-stage-resp` CSS 규칙, `icptQueueBadge` JS 변수

### v0.7.2 변경사항 (2026-04-14)
- **글로벌 URL 스코프 도입**: 기존 각 탭에 분산되어 있던 URL 필터 3종(`sitemap-search`, `network-filter`, `icpt-url-filter`)을 패널 헤더의 단일 **Scope** 입력으로 통합
  - 적용 단계가 수집 시점: 스코프 밖 요청은 `onRequestFinished`에서 즉시 드롭되어 Site Map / Network 리스트에 들어오지 않음 (display 필터가 아닌 collection 게이트)
  - Intercept도 동일 스코프를 proxy 서버(`urlFilter`)로 전파하여 서버 레벨에서 bypass — `inGlobalScope()`로 클라이언트 측 방어 게이팅 유지 (race 방지)
  - 스코프 문법은 기존 Intercept URL 필터와 동일: 쉼표 구분 와일드카드(`*.site.com, api.example.com/v1/*`), host+pathname 매칭, 빈 입력 = 전 범위
  - Apply 버튼 + Enter / Clear 버튼, dirty/flash 상태 표시는 기존 Intercept UX 그대로 이식 (`scope-apply-dirty`, `scope-apply-flash`)
- **패널.js 변수 리네이밍**: `_urlFilterCache` → `globalScope`, `applyUrlFilter` → `applyGlobalScope`, `testUrlFilter` → `inGlobalScope`, `refreshUrlFilterButtonState` → `refreshGlobalScopeButtonState`, `flashUrlFilterApply` → `flashGlobalScopeApply`
- **모의해킹 workflow와의 정렬**: "지금 테스트 중인 대상"을 한 곳에서 설정 → 세 기능 모두 동일 데이터셋 기준으로 동작. Burp Target Scope와 유사한 개념이지만 단일 입력으로 경량화
- **버그 수정 및 코드 정리 (2026-04-16)**:
  - `sendToReplay()`가 `detail-open` 클래스를 사용하여 CSS `.has-detail` 리사이즈가 미적용되고 `closeDetail()`로 닫히지 않던 문제 수정
  - Intercept 로그 타임스탬프 `'ko-KR'` 하드코딩 → 시스템 로캘 사용
  - `showSetupHint()`가 존재하지 않는 `#icpt-editor`를 참조하여 Native Messaging 미설치 시 가이드가 표시되지 않던 문제 → `#icpt-req-placeholder` / `#icpt-resp-placeholder` 양쪽에 표시하도록 수정
  - `fetchSource()` 5초 타임아웃과 poll이 동시에 callback을 호출할 수 있던 race condition → `done` 플래그로 단일 호출 보장
  - `proxy-server.js stop()` 에서 `close()` 콜백과 3초 강제 타이머가 둘 다 `resolve()` 호출 가능 → `clearTimeout`으로 이중 resolve 방지
  - `startIntercept()`가 `applyGlobalScope()` 로직을 복붙 → 직접 호출로 중복 제거
  - `intercept_paused` 수신 시 `'Proxy: Stopped'` 표시 → `'Proxy: Paused'` (서버는 여전히 리스닝 중)
  - 데드 코드 제거: `interceptIdCounter` (미사용), `origDetailTabHandler` (불필요 변수), `content_scripts: []` (v0.6 잔재), `.highlight` CSS (v0.4 잔재)
- **manifest 권한 경량화**: `declarativeNetRequestWithHostAccess` → `declarativeNetRequest` (세션 룰만 사용하므로 WithHostAccess 불필요, 설치 시 권한 경고 감소)
- **popup.html 갱신**: v0.5에서 제거된 DOM/Console/Performance/Storage 대신 현재 기능(Site Map, Network+Initiator, Intercept, Replay, Global Scope) 표시

### v0.7.1 변경사항 (2026-04-14)
- **Intercept 탭 스코핑**: `chrome.proxy.settings`가 브라우저 전역 적용임에도 불구하고, **DevTools가 열린 탭의 요청만** 큐잉/홀딩되도록 개선. 다른 탭, Service Worker, 확장, Chrome 내부 요청의 노이즈 제거
  - `declarativeNetRequest` 세션 룰로 inspected tab 요청에 `X-DevToolsPP-Tab: <tabId>` 헤더 주입 (`background.js` +50줄)
  - `proxy-server.js _handleRequest`에서 태그 헤더 체크 → 없으면 즉시 bypass, 있으면 strip 후 기존 인터셉트 흐름 (+12줄)
  - `intercept_on`/`intercept_off`/패널 disconnect 시 세션 룰 add/remove 자동 관리 (leak 방지)
- **manifest 권한**: `declarativeNetRequest` (세션 룰 전용, `<all_urls>` host_permissions 범위 내)
- **한계**: Service Worker / Shared Worker는 `tabId=-1`이라 DNR 태깅 불가 → 무조건 bypass. 도구 정체성(DevTools 열린 탭 외는 노이즈)과 일치하여 의도된 동작

### v0.7 변경사항 (2026-04-12)
- **Initiator 탭 신설**: Network 상세 패널에 Initiator 탭 추가. HAR `_initiator`에서 JS 콜스택 추출, 민감 함수명 패턴 자동 감지(10개 카테고리), 인라인 소스 뷰어(fetch 기반, 타깃 라인 하이라이트, sourceCache), Sources 탭 연동(getResources 확인 후 openResource 또는 인라인 폴백)
- **콜스택 클릭 동작 분리**: 함수명 클릭 → 인라인 소스 뷰어, 소스 링크 클릭 → Sources 탭 이동 (리소스 미존재 시 인라인 폴백 + notice)

### v0.6.3 변경사항 (2026-04-12)
- **Site Map 타깃 호스트 중심 트리**: `inspectedWindow.eval('location.host')` + `onNavigated` 이벤트로 현재 페이지 호스트를 감지. 타깃 호스트를 트리 최상위에 항상 표시하고, 외부 참조 호스트는 "External (N)" 접힌 그룹 하위로 이동. 패널 생성 시점에 타깃 호스트 빈 노드 선제 생성(`ensureTargetInTree`)하여 최초 접속 시에도 즉시 표시
- **Site Map 트리 펼침 상태 보존**: `expandedNodes` Set + `externalGroupExpanded` 변수로 트리 재렌더링 시에도 노드 펼침/접힘 상태 유지 (새 요청 도착, 노드 선택 등에 의한 재렌더링에서 트리가 닫히지 않음)
- **타깃 호스트 변경 시 트리 초기화**: `onNavigated`에서 호스트가 변경되면 `sitemapTree` 전체 초기화 후 새 타깃으로 시작 (동일 호스트 내 네비게이션은 유지)
- **Scan Page 버튼 범위 제한**: 외부 호스트 또는 그 하위 노드 선택 시 Scan Page 버튼 자동 비활성화 + 툴팁 안내. Scan Page는 항상 현재 페이지(타깃) DOM을 스캔하므로 외부 호스트 선택 시 오해 방지

### v0.6.2 변경사항 (2026-04-12)
- **Replay 폼 갱신 버그 수정**: `showDetail()`에서 `populateReplayForm()` 미호출로 다른 요청 클릭 시 Replay 탭만 갱신되지 않던 문제 수정
- **Replay 상태 버튼 (Original/Modified)**: 기존 Send + Replay 버튼을 Send + 상태 표시 버튼으로 교체. 폼 원본 상태면 "Original" (초록), 수정 시 "Modified" (주황). Modified 클릭으로 원본 복원. method/URL/headers/params/body 전체 변경 감지 (`captureReplaySnapshot` + `checkReplayModified`). KV 행 추가/삭제/수정 모두 이벤트 위임으로 감지
- **`executeQuickReplay()` 제거**: 원본 복원 기능이 상태 버튼으로 이전

### v0.6.1 변경사항 (2026-04-12)
- **URL 필터 substring 매칭 버그 수정**: URL 필터가 전체 URL(쿼리 스트링 포함)에 대해 단순 substring 매칭을 해서, Google Analytics / Doubleclick 같은 트래커가 페이지 URL을 `dl=` / `url=` 같은 쿼리 파라미터로 전송할 때 그 안의 도메인 문자열에 의해 잘못 매칭되어 큐에 잡히던 문제. 클라이언트(`testUrlFilter`) + 서버(`_shouldBypass`) 둘 다 매칭 대상을 `host + pathname`으로 정규화하여 쿼리/프래그먼트 오염을 차단. `*.` 와일드카드 패턴의 protocol prefix(`^https?://[^/]*`)도 `^[^/]*`로 변경
- **URL 필터 Apply 버튼 추가**: 기존에는 입력 후 300ms debounce로 자동 적용되었지만 사용자가 적용 시점을 직관적으로 알 수 없었음. 명시적인 Apply 버튼으로 변경 — 입력값과 적용값이 다르면 버튼이 파란색(dirty)으로 강조, Apply 시 초록색 깜빡임으로 피드백. Enter 키도 Apply 트리거. Intercept ON 시에는 현재 입력값이 자동 Apply (사용자가 두 번 클릭할 필요 없음). `_urlFilterCache`는 이제 *적용된* 값만 보관 (라이브 입력값 미사용)

### v0.6 변경사항 (2026-04-12)
- **Legacy In-Page Mode 제거**: Intercept를 Proxy Mode 단일 방식으로 전환. Legacy Mode는 monkey-patch 기반(`fetch`/XHR/`<form>`/`<a>`/`sendBeacon`/`location.href`)으로 커버리지가 매우 제한적이고 응답 인터셉트도 불가능. 알려진 우회 경로(`form.submit()` 직접 호출, multipart 파일 업로드, Web/Service Worker 내부 fetch, WebSocket/EventSource, 모든 서브리소스 등)가 너무 많아서 도구의 신뢰성을 떨어뜨림
- **삭제된 파일**: `intercept-hook.js` (424줄), `content.js` (사용 안 하는 stub 1줄)
- **panel.js 정리**: `interceptMode` 변수, mode select 핸들러, `startLegacyIntercept()`, `injectInterceptHookViaEval()`, `pollInterceptQueue()`, `sendInterceptDecision()` 분기 모두 제거. `startIntercept()`/`stopIntercept()` 단일 흐름화
- **panel.html 정리**: Intercept 탭의 mode select 드롭다운 제거. Proxy 상태 배지는 상시 표시
- **background.js 정리**: `chrome.scripting.registerContentScripts` 호출 제거, 섹션 번호 재정렬
- **manifest 정리**: `web_accessible_resources` 필드 삭제(intercept-hook.js 노출 전용이었음), `scripting` 권한 삭제(`chrome.scripting` 호출 0회) → 설치 시 권한 경고 추가 감소

## 개발 컨벤션
- UI: VS Code 다크 테마 스타일 (#1e1e1e 배경)
- 언어 정책 (2026-05-10 reversal 이후):
  - 코드 주석 / description-type UI 텍스트(Detection 카테고리 설명, Auth 안내, Initiator 안내, toast/alert) → **한국어 기본**
  - 정적 UI 라벨(Monitor / Intercept / Reload / Method / Status / URL 같은 HTTP·API 기술 용어) → 영문 유지 (한글로 옮기면 어색)
  - 변수/함수/클래스명 / CSS 클래스 / data-* 속성 → 영문
  - `console.*` / `throw new Error` 메시지 → 영문 (디버깅 컨벤션)
  - HTTP/JWT/MV3/CORS 같은 기술 약어 → 한국어 문장 안에서도 영문 그대로
  - README: 루트 `README.md` 한국어만 유지 (v0.10.0부터 영문 버전 제거 — 필요 시 사용자가 번역 도구 사용)
- No chrome.debugger (conflicts with DevTools panel)
- Async results: Native Messaging messages (intercept), or global variable + polling (replay/eval)
- Intercept: Proxy Mode only (Native Messaging + 로컬 MITM). Legacy in-page hook은 v0.6에서 제거됨
- No inline event handlers (onclick etc.) in innerHTML — blocked by MV3 CSP. Use data attributes + event delegation

## 향후 고려 기능
- Monitor ↔ JS Trace correlation (Network 요청 발생 시점 전후의 JS Trace 이벤트 자동 연결: 어떤 random/crypto 호출이 어떤 요청 헤더·바디 생성에 기여했는지 추적)
- Initiator 소스맵 지원 (번들/난독화 JS → 원본 파일/라인 역매핑, v2 목표)
- Comparer: 두 응답 비교 (diff)
- 자동화된 파라미터 fuzzing
- Request 시퀀스 체이닝 (A 응답의 토큰을 B 요청에 자동 삽입)
- 토큰/세션 분석 (Sequencer 대응)
- cURL/Python 코드 복사 (요청 → 코드 변환)
- 요청/응답 내보내기/불러오기
### v0.5 변경사항 (2026-04-11)
- **Console / Performance / Storage 탭 제거**: 세 기능 모두 native Chrome DevTools 대비 명확한 메리트 없음 (Console: 객체 트리/스택트레이스/멀티라인 eval 부재 + 500ms polling 누락 위험. Storage: 읽기 전용, 쿠키 속성/IndexedDB/Cache 미지원. Performance: native Console에서 1줄로 대체 가능). API 테스팅 + intercept/replay/site map이라는 도구 정체성에 집중
- **코드 정리**: panel.js -299줄, panel.html -55줄, panel.css -82줄 (총 -436줄). 미사용 `formatPreview()` 함수 + leftover `.dom-node` 스타일도 함께 제거
- **manifest 정리**: description에서 "DOM inspection, console capture" 제거. 미사용 권한 `debugger`(코드에서 호출 0회, 정책상으로도 사용 금지) / `storage`(`chrome.storage` 호출 0회) 삭제 → 설치 시 권한 경고 감소

### v0.4.1 변경사항 (2026-04-08)
- **Scan Page 결과 분리**: 스캔 결과(Links/Forms/Scripts)를 좌측 트리에 혼입하지 않고 우측 상세 패널에만 표시
- **상세 패널 3개 섹션**: Links(URL + Replay), Forms(method/action/fields + Replay), Scripts(URL) 각각 접기/펼치기
- **카운트 요약**: 상단에 Links/Forms/Scripts 건수 표시

### v0.4 변경사항 (2026-04-07)
- **DOM 탭 제거**: 독립 DOM 검사 기능을 삭제하고, 유용한 기능을 Site Map에 통합
- **Scan Page 기능**: Site Map에서 DOM 스캔으로 엔드포인트 자동 발견 → 우측 상세 패널에 결과 표시
  - Links/Forms/Scripts 3개 섹션으로 분리 표시 (트리에는 추가하지 않음)
  - Links: `<a href>` URL (중복 제거) + Replay 버튼
  - Forms: method/action/input fields(hidden 노란색) + Replay 시 form-urlencoded body 자동 채움
  - Scripts: `<script src>` URL 목록

### v0.3 변경사항 (2026-04-07)
- **Site Map 탭 추가**: Network 모니터링 데이터를 패시브 수집하여 도메인→경로→엔드포인트 트리 구조로 표시. 뷰 필터(MIME/Status/검색), Replay 연동
- **Site Map 항상 수집**: Network 모니터링 ON/OFF와 무관하게 `onRequestFinished` 이벤트에서 자동 수집
- **전체 코드/주석/UI 영문화**: 모든 한국어 주석, UI 라벨, placeholder를 영문으로 변환
- **install.sh macOS + Linux 통합**: OS 감지(`uname -s`)로 NM 매니페스트 경로 분기 + CA 신뢰 등록 안내 분기

### v0.2 변경사항 (2026-04-06)
- **Intercept UI 좌우 분리**: 기존 단일 큐+에디터를 Request(좌)/Response(우) 듀얼 패널로 분리. `interceptQueue` → `reqQueue`/`respQueue` 독립 관리, 각 사이드별 에디터/액션 버튼/자동선택
- **Mock Response 탭 신설**: Request 사이드에 Mock 탭 추가. Status, Headers, Body 입력 후 서버 없이 가짜 응답 전달. 기본 Content-Type 헤더 자동 추가
- **activeSide 기반 단축키**: 패널 클릭으로 활성 사이드 전환, 단축키가 해당 사이드에만 적용 (`R` Mock은 Request 사이드에서만)

