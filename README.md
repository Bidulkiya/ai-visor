# 노아 (Noa) — AI Visor

> 감정(VAD)을 읽고 기억을 쌓으며 함께 사는 **로컬 우선 데스크톱 AI 동반자**.

노아는 비서이면서, 곁에서 함께 시간을 보내는 존재다. 사용자의 발화에서 감정을
읽어 표정과 어투에 반영하고, 대화를 단기·장기로 기억하며, 유대가 쌓이면 말투가
조금씩 편안해진다. 컴퓨터 조종(파일·앱·검색)과 발표는 본체 위에 얹은 확장이지
본질이 아니다.

대화·기억·감정은 전부 로컬 SQLite에만 저장되며 클라우드로 나가지 않는다.
LLM 호출에 필요한 API 키는 코드·번들 어디에도 담기지 않고 **앱 실행 후 사용자가
직접 입력**한다.

---

## 핵심 특징

- **감정 3축(VAD)** — Valence·Arousal·Dominance를 답변과 **같은 LLM 호출**에서
  추론한다(추가 왕복 0). 스무딩으로 급변을 막고, 대화가 없으면 중립으로 서서히
  감쇠한다. V·A는 2D 표정으로, D는 어투 강도로 표현한다.
- **2단 메모리** — 세션 단기 캐시 → 종료 시 요약·사실(키-값) 추출 → 로컬 SQLite
  영속. N턴마다 스냅샷으로 크래시에 대비한다.
- **유대(affection)** — 대화가 쌓일수록 깊어지고, 어투 3단계(정중 → 친근 → 편안)로만
  반영된다. 작업 실행 결정에는 개입하지 않는다.
- **안전한 도구 사용** — 모든 능력을 단일 레지스트리에 위험도(safe/caution/dangerous)와
  함께 등록한다. 위험 도구는 실행 직전 승인 게이트를 **코드로** 통과해야 한다.
- **음성·발표** — 푸시투토크 STT, 스트리밍 TTS, 본체를 모르는 격리 발표 컨트롤러.

> 자세한 설계 배경은 [`docs/기획서.md`](docs/기획서.md), 구조·경계는
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), 절대 규칙은 [`CLAUDE.md`](CLAUDE.md) 참조.

---

## 기술 스택

| 구성요소 | 선택 |
|---|---|
| 데스크톱 셸 | Electron |
| 렌더러 (UI + 본체 로직) | Next.js + React + TypeScript |
| 저장소 | 로컬 SQLite (WAL, `better-sqlite3`) |
| LLM | Claude API (`@anthropic-ai/sdk`) |
| STT/TTS · 슬라이드 추출 | Python 사이드카 *(예정)* |
| 패키징 | electron-builder |

---

## 폴더 구조

```
AI_VISOR/
├── electron/              # 메인 프로세스 (OS·창·생명주기)
│   ├── main.ts            # 앱 진입점
│   ├── preload.ts         # contextBridge로 window.aiVisor 노출
│   ├── db/                # better-sqlite3 호스트 (메인 프로세스)
│   ├── tools/             # 도구 실작업 (파일·앱·검색) 호스트
│   ├── ipc/               # 메인 ↔ 렌더러 채널 정의
│   └── sidecar/           # Python 프로세스 생명주기 (골격)
├── renderer/src/
│   ├── core/              # ★ 본체 — 발표·조종을 모른다
│   │   ├── message.ts     #   입력 정규화 (모든 입력의 단일 관문)
│   │   ├── stream.ts      #   출력 단일 이벤트 스트림
│   │   ├── engine.ts      #   대화 엔진 (수명주기·끼어들기)
│   │   ├── llm.ts         #   Claude 호출 (감정+답변 단일 호출)
│   │   ├── session.ts     #   컴포지션 루트
│   │   ├── router.ts      #   경량/고성능 모델 라우팅 (규칙 기반)
│   │   └── affection.ts   #   유대도
│   ├── emotion/           # VAD 타입·스무딩·감쇠·해석
│   ├── memory/            # 2단 메모리 (SQLite, 단기·장기·사실)
│   ├── expression/        # 2D 표정 (스트림 구독자)
│   ├── tools/             # 도구 레지스트리·승인 게이트·감사 로그
│   ├── voice/             # STT(푸시투토크)·TTS(스트리밍)
│   ├── presentation/      # 발표 컨트롤러 (본체를 호출만 함)
│   └── ui/                # React 컴포넌트
├── sidecar/               # Python (STT, PPTX) — 예정
└── docs/                  # 기획서·아키텍처
```

> **설계 원칙**: 본체(`core/`)는 발표·음성·도구의 존재를 모른다. 확장은 본체를
> 수정하지 않고 정해진 접점(Message 객체 + 출력 스트림)에만 끼운다.

---

## 실행 방법

### 사전 요구

- Node.js 20+ (개발은 24에서 검증)
- Windows (현재 패키징 타깃)

### 설치

루트와 렌더러가 각자 `package.json`을 가지므로 둘 다 설치한다.

```bash
npm install
npm install --prefix renderer
```

### 개발 모드 실행

```bash
npm run dev
```

Next 렌더러(http://localhost:3000)가 뜬 뒤 Electron 창이 자동으로 열린다.

### 검증 / 빌드 / 패키징

```bash
npm run typecheck   # tsc --noEmit (electron + renderer)
npm run lint        # eslint
npm run build       # 렌더러 정적 빌드 + electron tsc
npm run package     # electron-builder --win → release/ 에 설치본
```

---

## API 키 입력 (중요)

이 앱은 **키를 코드·번들·환경변수에 담지 않는다.** 처음 실행하면 상단에 키 입력
안내 배너가 뜬다.

1. 앱 우측 하단 **⚙ 설정** 클릭
2. 본인의 Anthropic API 키 입력 후 저장

키는 로컬 프로필 폴더에만 보관되고 런타임에 조회된다. 난독화·암호화 동봉도 하지
않는다(추출 가능하므로). 자세한 근거는 [`CLAUDE.md`](CLAUDE.md) R7 참조.

---

## 라이선스

미정.
