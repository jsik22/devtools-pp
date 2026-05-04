# DevTools++

> Chrome DevTools에 내장된 경량 웹/API 분석 도구 — 별도 프록시 없이, 컨텍스트 전환 없이, DevTools를 열면 바로 시작합니다.

[![Version](https://img.shields.io/badge/version-0.7.9-blue)](#)
[![License](https://img.shields.io/badge/license-MIT-green)](#)
[![Chrome](https://img.shields.io/badge/Chrome-MV3-yellow)](#)

---

## DevTools++를 만든 이유

Burp Suite 같은 보안 테스트 도구나 Postman 같은 API 테스트 전문 도구는 강력하지만, 별도 애플리케이션 설치와 프록시 설정, 그리고 끊임없는 도구 전환이 필요합니다. 하지만 많은 경우에 이 도구들의 극히 일부 기능만을 사용하거나 필요로 합니다.

DevTools++는 이미 매일 열어두고 있는 Chrome DevTools 안에서 동작합니다.

**한 번 설치. 항상 준비.**

한 번만 설치해두면 별도 앱 실행도, 프록시 설정 토글도, 작업 흐름 중단도 없습니다. DevTools를 열면 바로 시작할 수 있습니다.

```
기본 DevTools  →  DevTools++  →  Burp Suite / Postman
   (메모장)        (메모장++)         (전문 IDE)
```

---

## 이런 상황에서 씁니다

**"보안팀 모의해킹 보고서를 받았는데, 직접 재현해서 검증해봐야 해요"**

보안팀의 웹 모의해킹 보고서에는 대부분 Burp Suite로 요청을 위변조한 결과가 담겨 있습니다. 개발/운영팀 입장에서는 조치 후 같은 방식으로 직접 검증하고 싶지만 현실은 이렇습니다.

> *"저희도 Burp를 설치해서 배워야 하나요?"*

Burp는 강력하지만 설치, 프록시 설정, 인증서 등록, 사용법 학습까지 — 보안이 본업이 아닌 개발/운영팀에게는 높은 진입장벽입니다. 그렇다고 보고서의 재현 절차를 그냥 믿고 조치 완료 처리하기엔 찜찜하죠.

DevTools++는 이 간극을 채우기 위해 만들었습니다. 보안팀이 Burp로 했던 것 — 요청 헤더 조작, 파라미터 변조, 응답 확인 — 을 개발/운영팀이 별도 도구 없이 Chrome 안에서 직접 재현하고 검증할 수 있습니다.

| 보안팀 (Burp) | 개발/운영팀 (DevTools++) |
|---|---|
| Proxy로 요청 인터셉트 | Intercept 탭에서 요청 홀딩 |
| Repeater로 파라미터 변조 후 재전송 | Replay 탭에서 편집 후 재전송 |
| 응답 코드/바디 확인 | Network / Replay 응답 패널에서 확인 |
| Target → Site Map으로 엔드포인트 파악 | Site Map 탭에서 자동 수집 |

---

## 주요 기능

### 🗺 Site Map

네트워크 요청을 패시브하게 수집해 **도메인 → 경로 → 엔드포인트** 트리 구조로 시각화합니다. 페이지를 사용하는 것만으로 API 구조가 자동으로 그려집니다.

- **Page Scan**: 현재 페이지 DOM에서 링크(`<a>`), 폼(`<form>`), 스크립트(`<script>`) 자동 추출
- **Set Scope** (전역 설정): 특정 호스트/경로로 캡처 범위를 지정하고 이미 수집된 데이터도 즉시 필터링
- 호스트별 External 분리 — 각 메인 호스트마다 별도 External 하위 트리
- 노드 클릭 시 해당 경로의 요청 목록 및 상세 정보를 우측 패널에서 확인

### 📡 Network 모니터링

`chrome.debugger` 없이 모든 완료된 요청을 캡처합니다. DevTools가 열려있는 것만으로 동작합니다.

- 페이지당 200개 이상의 요청이 발생하는 사이트에 최적화된 테이블 렌더링 (rAF 배치 처리, 바디 로드 큐, 최대 1,000행 표시 / 전체 히스토리 유지)
- **컬럼**: Host / Method / URL / Status / Type / Size / Time / Initiator / Detection
- **상세 탭**: Headers / Payload / Response / Preview / Initiator / Detection / Replay
- **Auto Crawl**: URL 목록을 임포트해 자동으로 페이지를 순차 방문하며 트래픽 전체 캡처
- **Auto Decode**: 헤더, Payload, Response에서 JWT / Base64 / URL-encoded / 중첩 JSON / Unix 타임스탬프 자동 감지 및 인라인 디코딩 (크기 제한 적용)
- **Initiator**: HAR `_initiator` 콜스택 기반 요청 발생 추적, 인증/토큰/암호화/결제 등 민감 함수명 패턴 감지, 번들/난독화 스크립트 소스맵 디코딩
- Import / Export: Detection만 또는 전체 요청 (JSON)
- Auto-start 옵션: DevTools 열릴 때 자동으로 모니터링 시작

### 🔍 Detection

캡처된 요청과 응답을 자동으로 분석해 보안 관련 패턴을 감지합니다. 모든 finding은 **확정된 취약점이 아니라 테스트 포인트**입니다 — Replay 탭으로 직접 검증하세요.

**응답(Response) 분석**

| 배지 | 카테고리 | 심각도 | 감지 내용 |
|---|---|---|---|
| 🔑 | token | HIGH | 응답 본문에 JWT 또는 API 키 노출 |
| 🔴 | sensitive | HIGH | 응답 또는 요청 본문에 비밀번호/시크릿 필드 |
| 👤 | pii | MEDIUM | 응답에 이메일 주소 또는 전화번호 |
| ⚠️ | leak | MEDIUM | 내부 IP, 스택 트레이스, 서버 경로 |
| 📡 | exposure | MEDIUM/HIGH | 서버 버전 헤더, AWS 키, GitHub PAT |

**요청(Request) 분석**

| 배지 | 카테고리 | 심각도 | 감지 내용 |
|---|---|---|---|
| 🔢 | idor | INFO | 직접 객체 참조가 가능한 ID 파라미터 |
| ⚠️ | privilege | HIGH | 요청에 role / admin / permission 파라미터 |
| 🔐 | session | MEDIUM | 요청 파라미터로 전달되는 세션 토큰 |
| 🔨 | tampering | MEDIUM | 서버 로직에 영향을 줄 수 있는 파라미터 (SQL, 경로, SSRF, 명령어, 디버그) |
| 🔍 | check | INFO | 본문이 예상보다 큰 401/403 응답 |

각 Detection finding은 다음 테스트 방향을 안내하는 가이드 문구를 포함합니다.

### 🔓 Auto Decode Layer

요청/응답 헤더와 본문 어디에서든 인코딩된 값을 자동으로 감지하고 디코딩합니다. 외부 도구에 복사해서 붙여넣을 필요가 없습니다.

- **JWT**: 헤더와 페이로드를 인라인으로 디코딩, `alg: none` 및 만료 토큰 경고
- **Base64**: 디코딩 후 JSON이면 pretty-print
- **URL-encoded**: 디코딩된 원문 표시
- **중첩 JSON**: 문자열 안에 JSON이 있으면 자동 파싱
- **Unix 타임스탬프**: 사람이 읽기 쉬운 ISO 날짜로 변환

Headers, Payload, Response 탭 하단에 접을 수 있는 **🔍 Decoded** 섹션으로 표시됩니다.

### 🔁 Replay & Tamper

캡처한 요청을 선택해 무엇이든 수정 후 즉시 재전송합니다 — DevTools 밖으로 나갈 필요가 없습니다.

- Method / URL / Headers / Query Params / Body 자유 편집
- JSON / Form / Raw 바디 타입 지원
- 원본 응답과 자동 JSON diff
- 최근 50건 재전송 히스토리 보존

### 📦 Import / Export

캡처한 모든 요청과 응답을 JSON 파일로 저장하고, 언제든 다시 불러올 수 있습니다.

- **Full Export**: 요청/응답 헤더, 바디, Detection 결과, Initiator 콜스택까지 전체 트랜잭션을 JSON으로 저장
- **Detection Export**: Detection 결과만 추출해 경량 보고서 형태로 저장
- **Import**: 저장된 JSON을 불러와 DevTools++ 안에서 그대로 재분석 — 테스트 세션 재현, 동료와 데이터 공유
- **AI 분석 연동**: Export한 JSON을 ChatGPT, Claude 등 AI에게 그대로 전달해 취약점 패턴 분석, 요약 보고서 생성, 특정 API 흐름 설명 요청 가능
- 모니터링을 종료한 후에도 전체 세션 이력을 파일로 보존 — 나중에 다시 열어 확인 가능

### 🔎 Initiator

각 요청이 무엇에 의해 발생했는지 보여주고, 소스맵이 있으면 원본 소스코드까지 역추적합니다.

- Network 테이블에 **script** / **parser** / **↑ Mapped** 타입 표시
- Initiator 셀 클릭 시 Initiator 탭으로 바로 이동
- **소스맵 디코딩**: 번들된 콜스택 프레임을 원본 파일명과 라인으로 역추적 (예: `bundle.js:1:12345` → `Auth.tsx:42:5`)
- **민감 패턴 감지**: 인증, 토큰, 자격증명, 결제 등 보안 관련 함수명이 있는 콜스택 프레임 강조

### 🔀 Intercept (Proxy Mode)

요청이 서버로 전달되기 **전**, 응답이 브라우저에 도달하기 **전** — 양방향으로 잡아서 수정하거나 차단합니다.

> ⚠️ **Proxy Mode는 별도 설치가 필요합니다.** 번거롭지 않습니다. 단 한 번의 최초 설치만으로 이후부터는 native DevTools 기능처럼 사용할 수 있습니다. [설치 방법 바로가기](#proxy-mode-설치)

- **프록시 자동 설정**: Proxy Mode 활성화 시 `:8899` 프록시 설정이 자동으로 적용됩니다. FoxyProxy 등 별도 프록시 확장 프로그램이나 시스템 프록시 설정이 필요 없습니다
- **탭 스코프**: DevTools가 연결된 탭의 요청만 인터셉트 — 다른 탭, Service Worker, Chrome 백그라운드 트래픽은 영향 없이 정상 통과
- **요청 인터셉트**: Forward / Forward Modified / Drop / Mock Response
- **응답 인터셉트**: 서버 응답을 브라우저 전달 전 확인 및 수정
- **Mock Response**: 서버 없이 직접 작성한 가짜 응답을 브라우저에 반환
- URL 와일드카드 / Method / 확장자 기반 자동 통과(bypass) 필터
- 키보드 단축키: `F` Forward · `G` Forward Modified · `D` Drop · `R` Mock · `A` Forward All · `Q` Drop All

---

## 설치

### 기본 설치 (Site Map / Network / Replay / Detection)

**방법 A — Chrome 웹 스토어** *(등록 예정)*

**방법 B — 압축 해제 로드 (GitHub)**

1. 이 저장소를 다운로드하거나 클론
2. `chrome://extensions` 열기
3. **개발자 모드** 활성화 (우측 상단 토글)
4. **압축 해제된 확장 프로그램 로드** 클릭 → `chrome-devtools-extension` 폴더 선택
5. 아무 `https://` 페이지 열기 → `F12` → **DevTools++** 탭 클릭

> **참고**: DevTools++ 패널은 `https://` 페이지가 열려있어야 표시됩니다. Chrome 시작 페이지를 `https://google.com` 등의 https 사이트로 설정해두면 DevTools를 열자마자 패널이 바로 나타납니다.

---

### Proxy Mode 설치

Intercept 기능은 로컬 Native Messaging 호스트의 일회성 설치가 필요합니다.

**요구사항**: Node.js v16 이상

**macOS / Linux**

```bash
cd chrome-devtools-extension/native-proxy
chmod +x install.sh
./install.sh <extension-id>
```

```bash
# HTTPS 인터셉트를 위한 CA 인증서 신뢰 등록

# macOS
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain \
  ~/.devtools-pp/ca.pem

# Linux (Debian/Ubuntu)
sudo cp ~/.devtools-pp/ca.pem /usr/local/share/ca-certificates/devtools-pp-ca.crt
sudo update-ca-certificates
```

**Windows**

```bat
cd chrome-devtools-extension\native-proxy
install.bat <extension-id>
```

```bat
certutil -addstore -user "Root" "%USERPROFILE%\.devtools-pp\ca.pem"
```

> Extension ID는 `chrome://extensions`에서 확인할 수 있습니다.

설치 후: Chrome 재시작 → DevTools++ 열기 → Intercept 탭 → **Proxy OFF** 클릭으로 시작.

**Proxy Mode가 하는 일:**
- 브라우저 트래픽을 로컬 MITM 프록시(`127.0.0.1:8899`)를 통해 라우팅
- CA 인증서는 로컬에서만 생성되며 외부로 전송되지 않음
- 소스코드에서 직접 확인: [`native-proxy/cert-generator.js`](chrome-devtools-extension/native-proxy/cert-generator.js)

> **nvm / fnm 사용자**: Node.js 버전 변경 시 `native-messaging-host.js` 상단의 shebang 절대경로를 업데이트하세요.

---

## 아키텍처

### chrome.debugger를 사용하지 않는 이유

Chrome은 탭당 debugger 연결을 1개만 허용합니다. DevTools가 열려있으면 내장 DevTools가 이미 슬롯을 점유하므로, DevTools 패널 확장에서 `chrome.debugger.attach()`는 **무조건 실패**합니다.

DevTools++의 모든 기능은 `chrome.debugger` 없이 구현되었습니다:

| 기능 | 구현 방식 |
|---|---|
| Network 모니터링 | `chrome.devtools.network` API |
| Intercept | Native Messaging + 로컬 MITM 프록시 |
| Replay | `inspectedWindow.eval` + `fetch()` |
| 소스맵 디코딩 | VLQ base64 디코더 + `getResources()` |

### Proxy Mode 통신 흐름

```
Browser ──프록시 설정──▶ proxy-server.js (127.0.0.1:8899)
                                │
                          stdin/stdout
                          (4-byte LE 길이 prefix + JSON)
                                │
                       native-messaging-host.js
                                │
                       Chrome Native Messaging
                                │
                         background.js (Service Worker)
                                │
                       chrome.runtime.connect
                                │
                           panel.js (UI)
```

---

## 알려진 한계

| 이슈 | 상세 |
|---|---|
| 대용량 바디 | 성능을 위해 512KB 초과 시 truncate |
| Service Worker bypass | Service Worker에서 발생하는 요청은 인터셉트 불가 (FoxyProxy + Burp와 동일한 한계) |
| 소스맵 접근성 | inspected 페이지가 fetch할 수 있는 `.map` 파일이 있을 때만 소스맵 디코딩 동작 |

---

## 향후 계획

- [ ] Chrome 웹 스토어 등록
- [ ] 요청 시퀀스 체이닝 (A 응답의 토큰을 B 요청에 자동 삽입)
- [ ] 다국어 지원 — 한국어 / 영어 UI 전환

---

## 개인정보 보호

DevTools++는 어떠한 사용자 데이터도 수집하거나 전송하지 않습니다. 모든 처리는 사용자의 기기 내에서만 이루어집니다.

- 네트워크 캡처 데이터는 DevTools++ 패널 안에서만 표시되며 외부로 전송되지 않음
- Import / Export 데이터는 로컬 디스크에만 저장됨
- Detection 분석은 전적으로 로컬에서 실행됨
- Proxy Mode의 MITM 프록시는 `127.0.0.1:8899`에서만 동작하며 외부 서버로 트래픽을 전달하지 않음
- CA 인증서는 로컬에서 생성되며(`~/.devtools-pp/ca.pem`) 외부로 전송되지 않음

자세한 내용은 [PRIVACY.md](PRIVACY.md)를 참조하세요.

---

## 법적 고지

DevTools++는 **본인 소유 시스템 또는 명시적으로 허가된 시스템**에서만 사용하십시오. 허가받지 않은 시스템에 대한 사용은 관련 법령에 따라 처벌받을 수 있습니다.

---

## 라이선스

MIT License — 자세한 내용은 [LICENSE](LICENSE) 파일을 참조하세요.

### 서드파티

- **node-forge** — BSD-3-Clause 라이선스. 전체 고지는 [NOTICE](NOTICE) 파일을 참조하세요.
