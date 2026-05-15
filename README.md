# DevTools++

> Chrome DevTools 안에서 동작하는 경량 web/API 보안 테스트 도구. 별도 프록시 설치 없이 패널 하나로 모니터링 · 인터셉트 · 리플레이 · JS 분석.

[![Version](https://img.shields.io/badge/version-0.11.0-blue)](#)
[![License](https://img.shields.io/badge/license-MIT-green)](#)
[![Chrome](https://img.shields.io/badge/Chrome-MV3-yellow)](#)

---

## 무엇인가

Chrome DevTools는 이미 강력한 도구입니다. 하지만 보안 분석이나 API 테스트 관점에서는 워크플로우가 불편하고 복잡한 부분이 많습니다. DevTools++는 그 핵심 기능을 더 편리하게 꺼내 씁니다.

DevTools++는 Chrome DevTools의 native함과 전문 테스트 도구의 핵심 기능을 합친 경량 web/API 테스트 도구입니다.

특히 DevTools++는 웹 요청 모니터링 뿐만 아니라 웹 요청이 생성되기 전 JS 레이어에서 발생되는 인증·세션·토큰 관련 동작을 가시화하고 하나의 흐름으로 분석할 수 있게 도와줍니다.

---

## 설치

### 기본 (Monitor / JS Trace / Replay)

1. [Releases](https://github.com/jsik22/devtools-pp/releases/latest)에서 zip 다운로드 → 압축 해제
2. `chrome://extensions` → 개발자 모드 → **압축 해제된 확장 프로그램 로드** → 해제한 폴더 선택
3. `https://` 페이지에서 F12 → **DevTools++** 탭

### Intercept (선택)

로컬 MITM 프록시. Node.js v16+ 필요, 한 번만 설치.

```bash
cd chrome-devtools-extension/native-proxy
./install.sh <extension-id>      # macOS / Linux
# install.bat <extension-id>     # Windows
```

CA 인증서 신뢰 등록 안내가 콘솔에 출력됩니다. Extension ID는 `chrome://extensions`에서 확인.

> nvm/fnm/asdf 사용자는 Node 버전 변경 시 install 스크립트 재실행 필요.

---

## 워크플로우 예시

### 예시 1 — 액세스 제어 검증 (서버 vs 클라이언트 판정 구분)

**상황**: 어떤 페이지가 "내부에서만 접속 가능" 알림을 띄울 때, 그 판정이 클라이언트 JS인지 서버 응답인지 식별.

1. **Monitor ON** (켜면 JS Trace 자동 시작) → 페이지 진입 → 알림 액션 수행
2. 알림 페이지의 Monitor 행 클릭 → **Message 탭**의 응답 크기/body 확인
   - 응답이 작고 (예: 200 B) `<script>alert(...);history.back();</script>` 형태면 → **서버 단 판정** 확정. 우회는 HTTP 헤더 조작 쪽으로 (`X-Forwarded-For` 등 비표준 프록시 헤더를 Intercept로 추가해 응답 변화 관찰)
   - 응답이 정상 크기면 → 다음 단계
3. 같은 행의 **JS Context 탭** → ±2초 윈도우의 JS 호출 카테고리별 확인. `fetch`/`XHR.send`로 외부 IP 조회, `input.value get`으로 입력 추출, `crypto.subtle.*`로 해시 등이 보이면 그게 판정 경로
4. **Monitor 검색**에 `internal` / `chkIP` / `history.back` 등 의심 키워드 입력 → 로드된 JS 파일 내 매칭 위치 식별

### 예시 2 — 요청 변조로 권한 우회 시도

1. Monitor 행 클릭 → **Message** 탭 → **↻ Replay** → KV 에디터로 전환
2. URL / 헤더 / body 수정. `Cookie`, `Origin`, `Referer`, `Sec-*` 등 Forbidden 헤더는 자동 잠금(🔒) — 페이지 컨텍스트 fetch가 silently drop하는 헤더 시각화
3. **Send** → 응답 패널에 결과 + 원본 응답과의 JSON diff 자동 표시
4. 더 깊이 변조하려면 **Intercept ON** → 같은 요청 재트리거 → request 큐 hold → raw HTTP 에디터에서 자유 변조 → **Forward Modified**

---

## 둘러보기

**Monitor** — 좌측 호스트 트리, 요청 목록, Message 상세 탭의 raw HTTP (Request/Response).
![Monitor](docs/screenshots/01-monitor.png)

**JS Trace** — 페이지 JS의 인증·세션·토큰 호출 timeline. 카테고리별 컬러 dot 필터.
![JS Trace](docs/screenshots/02-jstrace.png)

**Initiator** — 요청 발생 콜스택 + 소스맵 디코딩 + 민감 함수명 강조.
![Initiator](docs/screenshots/03-initiator.png)

**Detection** — 캡처된 요청/응답의 자동 보안 패턴 플래깅.
![Detection](docs/screenshots/04-detection.png)

**JS Context** — Monitor 요청과 ±2초 윈도우의 JS 호출을 카테고리별로 묶어 표시 (Monitor ↔ JS Trace 브릿지).
![JS Context](docs/screenshots/05-jscontext.png)

**Intercept** — 요청/응답 양방향 hold, raw HTTP 컬러 에디터, 하단 공유 로그.
![Intercept](docs/screenshots/06-intercept.png)

---

## 주요 기능 요약

| 영역 | 핵심 |
|---|---|
| **Monitor** | 라이브 캡처 · 호스트별 세션 탭 · Send to Browser · Auto Crawl · Import/Export |
| **JS Trace** | 11종 wrapper로 `Math.random`/`crypto.*`/`fetch`·XHR/`input.value`/Storage/cookie 추적. Monitor 행의 **JS Context 탭**에서 ±2초 시간 연관 가시화 |
| **Intercept** | request/response 양방향 hold · raw HTTP 컬러 에디터 · Mock Response · 키보드 단축키 (F/G/D/R) |
| **Replay** | KV 에디터 · forbidden 헤더 자동 잠금 · 응답 JSON diff · CORS 자동 폴백 (Service Worker fetch) |
| **Detection** | 응답 측 (token/sensitive/pii/leak/exposure) + 요청 측 (idor/privilege/session/tampering/check) 자동 플래깅 + 카테고리별 테스트 가이드 |
| **Auto Decode** | JWT / Base64 / URL-encoded / 중첩 JSON / Unix timestamp 인라인 디코딩 |
| **Initiator** | HAR 콜스택 + 소스맵 디코딩 + 민감 함수명 강조 (auth/token/credential/payment 등) |

---

## 아키텍처 요약

- `chrome.debugger` 미사용 (DevTools 패널 확장에서 attach 불가) → `chrome.devtools.network` + `inspectedWindow.eval` + Native Messaging 조합
- Proxy Mode 흐름: `panel.js ⇄ background SW ⇄ Native Messaging Host ⇄ proxy-server.js (127.0.0.1:8899)`
- 버전별 변경 이력: [CHANGELOG.md](CHANGELOG.md)

---

## 개인정보 / 법적 고지

- 모든 분석은 로컬에서만. 외부 서버로 어떤 데이터도 전송되지 않음
- CA 인증서는 로컬 생성(`~/.devtools-pp/ca.pem`), 외부 전송 없음
- **본인 소유 또는 명시적으로 허가된 시스템에서만 사용하십시오.** 무단 사용은 법적 처벌 대상

[PRIVACY.md](PRIVACY.md) · [LICENSE](LICENSE) (MIT) · [NOTICE](NOTICE) (node-forge BSD-3-Clause)
