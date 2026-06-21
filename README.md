# 노아 (Noa) — AI Visor

> 감정(VAD)을 읽고 기억을 쌓으며 함께 사는 **로컬 우선 데스크톱 AI 동반자**.

**노아**는 캐릭터 이름이고, **AI Visor**는 앱 이름입니다. 노아는 사용자의 발화에서
감정을 읽어 표정과 어투에 반영하고, 대화를 단기·장기로 기억하며, 차분한 존댓말로
곁을 지키는 데스크톱 동반자입니다.

이 프로젝트의 한 줄 정체성은 이렇습니다 — **"도구를 가진 챗봇"이 아니라, "감정과
기억을 가진 동반자가 (필요할 때) 도구를 쓴다".** 컴퓨터 조종·문서 이해·발표는 본체
위에 얹은 확장이지 본질이 아닙니다. 본체(대화 엔진)는 자기를 둘러싼 확장의 존재를
모르도록 설계되어 있습니다.

대화·기억·감정은 전부 **로컬 SQLite에만** 저장되며 클라우드로 나가지 않습니다.
LLM 호출에 필요한 API 키는 코드·번들 어디에도 담기지 않고 **앱 실행 후 사용자가
직접 입력**합니다(R7).

---

## 핵심 기능

| 기능 | 설명 |
|---|---|
| **감정 3축 (VAD)** | Valence·Arousal·Dominance를 답변과 **같은 LLM 호출**에서 추론(추가 왕복 0). 스무딩(계수 0.35)으로 급변을 막고, 대화가 없으면 분당 5%씩 중립으로 감쇠. V·A는 표정으로, D는 어투 강도로 표현. |
| **두 겹 기억** | ① 단기 — 세션 캐시(최근 10턴을 프롬프트에 주입). ② 장기 — 로컬 SQLite에 종료 시 요약 + 10턴마다 스냅샷. 이름·선호 같은 **사실은 키-값으로 따로** 추출·저장. |
| **도구 23종 + MCP** | 파일·웹·시스템·상호작용·프로세스 등 내장 도구 23종. 외부 **MCP 서버**(stdio)를 연결하면 그 도구들을 **같은 레지스트리로 흡수**해 동일한 게이트·감사·체이닝을 적용. |
| **도구 체이닝** | 한 턴에서 여러 도구를 연쇄 호출(최대 16라운드)해 복합 작업을 수행. |
| **승인 게이트** | 모든 도구에 위험도(`safe`/`caution`/`dangerous`)를 코드 상수로 태그. 위험 도구(삭제·프로세스 종료 등)는 **실행 직전 승인 게이트**를 코드로 강제(LLM 판단에 의존하지 않음). 모든 호출은 감사 로그에 남김. |
| **문서 이해** | PDF·DOCX·TXT·MD(·PPTX)를 열어 내용을 묻고 답함. Python 사이드카가 추출을 담당. |
| **발표 모드** | 문서를 슬라이드 덱으로 열어 노아가 발표하고 질문에 실시간 응답. 본체를 **모르는** 격리 컨트롤러로 구현(R3). |
| **2D 표정 캐릭터** | SVG 2D 얼굴이 V·A를 표정(입꼬리·눈썹·눈)으로 매핑. 구체감·눈빛(캐치라이트)·발광 강화. **발성 모션**(TTS 중 입 움직임)과 **구절별 표정 흐름**을 별도 채널로. |
| **TTS (음성 출력)** | 출력 스트림 구독자로 붙는 스트리밍 음성 합성(OS 보이스, `ko-KR`). |
| **비용 절감** | Anthropic **프롬프트 캐싱**(고정 페르소나 캐시) + **모델 라우팅**(가벼운 발화는 Sonnet, 무거운 작업은 Opus) + 일상 잡담 시 도구 정의 생략. |

> 설계 배경은 [`docs/기획서.md`](docs/기획서.md), 구조·경계는
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), 절대 규칙은 [`CLAUDE.md`](CLAUDE.md) 참조.

---

## 기술 스택

| 구성요소 | 선택 |
|---|---|
| 데스크톱 셸 | **Electron** (메인 프로세스 — OS·창·생명주기·사이드카·DB 호스트) |
| 렌더러 (UI + 본체 로직) | **Next.js** + React + TypeScript |
| 저장소 | 로컬 **SQLite** (WAL 모드, `better-sqlite3`) |
| LLM | **Claude API** (`@anthropic-ai/sdk`) — Opus 4.8 / Sonnet 4.6 |
| 문서 추출 (PDF/DOCX/PPTX) | **Python 사이드카** (로컬 HTTP, 토큰 인증) |
| 음성 (STT/TTS) | 브라우저 WebSpeech (렌더러) — *STT는 알려진 한계 있음, 아래 참조* |
| 패키징 | electron-builder (Windows NSIS) |

---

## 실행 가이드

> 새 PC 기준 단계별 안내입니다. **개발 모드 실행**까지가 1차 목표입니다.

### 1. 사전 요구

| 항목 | 권장 | 비고 |
|---|---|---|
| **Node.js** | 20 이상 (개발은 24에서 검증) | 필수 |
| **Git** | 최신 | 필수 |
| **Python** | **3.12 권장** | 문서/발표 기능용(선택). 3.14는 일부 라이브러리(PyMuPDF 등) 휠 미호환 가능 |
| **LibreOffice** | 최신 | 선택 — PPTX 슬라이드를 *이미지로* 보여줄 때만 |

> Python·LibreOffice가 없어도 앱은 **정상 동작**합니다. 일반 대화·감정·기억·도구는
> 사이드카와 무관하며, 문서 기능만 비활성화되거나 데모 슬라이드로 폴백합니다.

### 2. 클론

```bash
git clone <repository-url>
cd ai-visor
```

### 3. 의존성 설치 (루트 + 렌더러 각각)

루트와 렌더러가 각자 `package.json`을 가지므로 **둘 다** 설치합니다.

```bash
npm install
cd renderer && npm install && cd ..
```

### 4. 네이티브 모듈 재빌드 (`better-sqlite3`)

`better-sqlite3`는 네이티브 모듈이라 **Electron의 Node ABI에 맞춰 다시 빌드**해야
합니다. 실행 시 아래 같은 오류가 나면 ABI 불일치입니다:

```
Error: The module '...better_sqlite3.node' was compiled against a different
Node.js version using NODE_MODULE_VERSION xxx. This version of Node.js requires
NODE_MODULE_VERSION yyy.
```

해결:

```bash
npx electron-rebuild
```

> 특정 모듈만 빠르게 재빌드하려면: `npx electron-rebuild -f -w better-sqlite3`
> (이 저장소는 `npmRebuild: false`라 패키징 시 자동 재빌드를 하지 않습니다 — 개발 중엔 위 명령으로 직접 맞춥니다.)

### 5. (선택) 문서/발표 기능 — Python 의존성

PDF·DOCX·PPTX를 열려면 사이드카 의존성을 설치합니다(시스템 Python 사용):

```bash
pip install -r sidecar/requirements.txt
# 또는 직접: pip install python-pptx PyMuPDF python-docx
```

앱은 PATH의 `python`/`python3`/`py -3`를 자동 탐지합니다. 특정 인터프리터를 쓰려면
환경변수 `AIVISOR_PYTHON`에 실행 파일 경로를 지정하세요. 사이드카 로그는
`%APPDATA%/ai-visor/sidecar.log`에 쌓입니다.

### 6. 개발 모드 실행

```bash
npm run dev
```

Next 렌더러(`http://localhost:3000`)가 뜬 뒤 Electron 창이 자동으로 열립니다.

### 7. API 키 입력 (중요)

이 앱은 **키를 코드·번들·환경변수에 담지 않습니다**(R7). `.env`는 git에 포함되지
않습니다. 처음 실행하면 상단에 키 입력 안내 배너가 뜹니다.

1. **⚙ 설정** 클릭
2. 본인의 **Anthropic API 키** 입력 후 저장

키는 로컬 프로필 폴더에만 보관되고 런타임에 조회됩니다. (난독화·암호화 동봉도 하지
않습니다 — 추출 가능하므로.)

### 검증 / 빌드 / 패키징

```bash
npm run typecheck   # tsc --noEmit (electron + renderer)
npm run lint        # eslint (electron + renderer)
npm run build       # 렌더러 정적 빌드 + electron tsc
npm run package     # electron-builder --win → release/ 에 설치본
```

---

## 트러블슈팅

| 증상 | 원인 | 해결 |
|---|---|---|
| `NODE_MODULE_VERSION` 불일치 / `better_sqlite3.node` 오류 | 네이티브 모듈이 Electron ABI와 안 맞음 | `npx electron-rebuild` (위 4단계) |
| 대화 시 "API 키가 설정되지 않았어요" 배너 | 키 미입력 | ⚙ 설정에서 Anthropic 키 입력 |
| PPTX/PDF 열기 시 "Python이 설치돼 있지 않아…" 안내 | 사이드카 Python/의존성 부재 | `pip install -r sidecar/requirements.txt` (Python 3.12 권장) |
| PPTX는 열리는데 슬라이드가 텍스트로만 보임 | LibreOffice 또는 PyMuPDF 부재 | LibreOffice 설치 + `pip install PyMuPDF` (없어도 발표는 계속됨) |
| 발표가 데모 슬라이드로 열림 | 사이드카 사용 불가 → 데모 폴백 | 정상 동작(앱은 멈추지 않음). 실문서를 쓰려면 위 Python 단계 |
| **음성 입력(STT)이 "이 환경에서 음성 인식을 쓸 수 없어요"** | 아래 **알려진 한계** 참조 | 현재 텍스트 입력 사용 |

---

## 아키텍처 절대 규칙 (R1~R7 요약)

본체를 작게 유지하고 확장점을 미리 정의하는 것이 이 프로젝트의 뼈대입니다.
전문은 [`CLAUDE.md`](CLAUDE.md).

- **R1 — 입력은 무조건 `Message` 객체로.** 채팅·음성·발표·시스템 입력 모두 본체에
  들어가기 전 `{ source, text, timestamp }`로 통일. 본체는 source로 분기하지 않음.
- **R2 — 출력은 단일 이벤트 스트림 + 구독.** LLM 출력은 한 스트림으로 흘리고
  자막·표정·TTS가 각자 구독.
- **R3 — 본체는 "발표"를 모른다.** 발표는 본체를 호출만 하는 격리 컨트롤러.
  발표 폴더를 통째로 지워도 본체가 컴파일·동작해야 함.
- **R4 — 위험 도구는 게이트를 거친다(코드로 강제).** `dangerous`는 실행 직전 승인
  필수. 모든 호출은 감사 로그에 기록.
- **R5 — 감정은 작업 실행 결정에 개입하지 않는다.** 유대(affection)가 아무리 높아도
  `dangerous` 게이트는 사라지지 않음. risk 태그는 감정과 무관한 코드 상수.
- **R6 — 기억은 로컬에만 둔다.** 대화·기억·감정은 로컬 SQLite. 클라우드 금지.
- **R7 — API 키를 코드/번들에 박지 않는다.** 사용자가 런타임에 입력. 난독화·암호화
  동봉도 금지.

---

## 알려진 한계

- **음성 입력(STT)은 현재 동작하지 않습니다.** 1차 인식기는 브라우저 Web Speech API
  (`SpeechRecognition`)인데, Electron(Chromium)에는 구글 음성 인식 백엔드·키가
  동봉돼 있지 않아 `start()`가 `network` 오류로 실패합니다(Electron의 알려진 구조적
  한계). 이를 대비한 녹음→변환 폴백(Whisper 등) 슬롯은 코드에 설계돼 있으나 아직
  배선되지 않았습니다. 따라서 현재 입력은 **텍스트 채팅**을 사용하며, **TTS(음성
  출력)는 정상 동작**합니다. 로컬 Whisper/외부 STT API 연동은 향후 과제입니다.
- **TTS 음성 품질은 OS 보이스에 의존**합니다(WebSpeech `speechSynthesis`). 한국어
  보이스가 설치돼 있어야 자연스럽게 들립니다.
- **`computer_use`(화면 조작)는 미구현**입니다. 통합 도구 레지스트리의 위험 도구로
  흡수할 계획(+2)만 문서에 정의돼 있습니다.

---

## 프로젝트 구조 (요약)

```
ai-visor/
├── electron/              # 메인 프로세스 (OS·창·생명주기)
│   ├── main.ts            #   앱 진입점
│   ├── db/                #   better-sqlite3 호스트
│   ├── tools/             #   도구 실작업(파일·앱·검색) 호스트
│   ├── mcp/               #   MCP 자체 구현 (JSON-RPC 2.0 over stdio)
│   ├── ipc/               #   메인 ↔ 렌더러 채널 정의
│   └── sidecar/           #   Python 프로세스 생명주기 관리
├── renderer/src/
│   ├── core/              # ★ 본체 — 발표·음성·도구를 모른다
│   ├── emotion/           #   VAD 스무딩·감쇠
│   ├── memory/            #   두 겹 기억 (SQLite)
│   ├── expression/        #   2D 표정 (스트림 구독자)
│   ├── tools/             #   도구 레지스트리·게이트·감사·MCP 흡수
│   ├── voice/             #   STT(푸시투토크)·TTS(스트리밍)
│   ├── presentation/      #   발표 컨트롤러 (본체를 호출만)
│   └── ui/                #   React 컴포넌트
├── sidecar/               # Python (문서 추출: PPTX/PDF/DOCX/TXT/MD)
└── docs/                  # 기획서·아키텍처
```

> **설계 원칙**: 본체(`core/`)는 발표·음성·도구의 존재를 모릅니다. 확장은 본체를
> 수정하지 않고 정해진 접점(`Message` 객체 + 출력 스트림)에만 끼웁니다. 자세한
> import 경계는 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 참조.

---

## 라이선스

미정.
