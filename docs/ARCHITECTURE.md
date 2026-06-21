# ARCHITECTURE.md — 구조와 경계

기획 배경은 `docs/기획서.md`, 절대 규칙은 `CLAUDE.md` 참조.
이 문서는 **어디에 무엇을 두고, 무엇이 무엇을 import 할 수 있는가**를 정의한다.

---

## 1. 최상위 구조 (분리 구조)

상태 표기: `✓` 구현됨 · `◐` 부분 구현(한계 있음) · `○` 미구현(계획).

```
ai-visor/
├── CLAUDE.md                  # 절대 규칙 (항상 읽힘)
├── docs/
│   ├── 기획서.md
│   └── ARCHITECTURE.md        # 이 문서
├── electron/                  # 메인 프로세스 (OS·창·생명주기·DB·사이드카·도구 호스트)
│   ├── main.ts                # ✓ 앱 진입점
│   ├── preload.ts             # ✓ contextBridge로 window.aiVisor 노출 (얇은 통로)
│   ├── db/                    # ✓ better-sqlite3 호스트 (메인 프로세스에서 실행)
│   ├── tools/                 # ✓ 도구 실작업 호스트 (파일·웹·시스템·프로세스)
│   ├── mcp/                   # ✓ MCP 자체 구현 — 외부 SDK 없음
│   │   ├── jsonRpc.ts         #   JSON-RPC 2.0 프레이밍 직접 구현
│   │   ├── stdioClient.ts     #   stdio 서버 spawn + 핸드셰이크
│   │   └── manager.ts         #   서버 생명주기·재연결
│   ├── security/              # ✓ 민감 경로 차단 (sensitivePaths)
│   ├── ipc/                   # ✓ 메인 ↔ 렌더러 통신 채널 정의
│   └── sidecar/               # ✓ Python 프로세스 생명주기 (원칙 5)
│       └── manager.ts         #   spawn/detach/로그리다이렉트/소켓체크
├── renderer/                  # Next.js (UI + 본체 로직)
│   └── src/
│       ├── core/              # ★ 본체 — 발표/음성/도구를 모른다
│       │   ├── message.ts     # ✓ Message 타입 + 입력 정규화 (R1)
│       │   ├── stream.ts      # ✓ 출력 이벤트 스트림 + 구독 (R2)
│       │   ├── engine.ts      # ✓ 대화 엔진: Message → 감정+답변 → 스트림
│       │   ├── llm.ts         # ✓ LLM 호출 (감정+답변 단일 호출, 마커 파싱, 체이닝, 캐싱)
│       │   ├── router.ts      # ✓ 모델 라우팅 (규칙 기반: FAST=Sonnet / SLOW=Opus)
│       │   ├── affection.ts   # ✓ 유대도 (어투에만 반영, 작업 판단 불개입 R5)
│       │   └── session.ts     # ✓ 컴포지션 루트 (본체+기억+감정+도구 배선)
│       ├── emotion/           # ✓ VAD 상태·스무딩·감쇠 (순수 로직)
│       │   ├── vad.ts         #   VAD 타입, 마커 파싱
│       │   ├── smoothing.ts   #   가중평균 (계수 0.35)
│       │   └── decay.ts       #   시간 감쇠 (분당 5%)
│       ├── memory/            # ✓ 두 겹 기억 (로컬 SQLite)
│       │   ├── db.ts          #   SQLite(WAL) 연결, 5테이블 스키마, 단일 쓰기 큐
│       │   ├── shortTerm.ts   #   세션 캐시 (휘발)
│       │   ├── longTerm.ts    #   영속 + 요약 + 주기 스냅샷
│       │   ├── facts.ts       #   사실 키-값 분리 추출 (영속/세션)
│       │   └── toolHistory.ts #   최근 도구 작업을 다음 턴 맥락에 연결
│       ├── expression/        # ✓ 2D 표정 캐릭터 (스트림 구독자)
│       │   ├── face.ts        #   V·A → 표정 매핑 (입·눈썹·눈)
│       │   └── controller.ts  #   스트림 구독 + 프레임 스무딩
│       ├── tools/             # ✓ 통합 도구 레지스트리 (R4) — 내장 23종 + MCP 흡수
│       │   ├── registry.ts    #   도구 등록 + risk 태그
│       │   ├── builtins.ts    #   내장 23종 정의 (IPC 위임)
│       │   ├── gate.ts        #   승인 게이트 (실행 가로채기)
│       │   ├── audit.ts       #   감사 로그 + 롤백 정보
│       │   ├── mcp.ts         #   MCP 도구를 동일 레지스트리로 흡수
│       │   └── assembleToolRuntime.ts  # 레지스트리+게이트+감사 조립
│       ├── voice/             # ◐ STT(푸시투토크)/TTS(스트리밍) — 스트림 구독자
│       │   ├── stt.ts         #   ◐ WebSpeech 1차 + 녹음 폴백(미배선) — STT 한계 §6
│       │   └── tts.ts         #   ✓ WebSpeech speechSynthesis (OS 보이스)
│       ├── presentation/      # ★ ✓ 발표·문서이해 컨트롤러 — 본체를 호출만 함
│       ├── shared/            # ✓ redact (비밀정보 마스킹, R7 경계)
│       └── ui/                # ✓ React 컴포넌트 + 훅
└── sidecar/                   # ✓ Python (문서 추출: PPTX/PDF/DOCX/TXT/MD)
    ├── server.py              #   로컬 HTTP (/health, /extract), 토큰 인증
    ├── document_parser.py     #   확장자별 추출 → 공통 구조 정규화
    ├── pptx_parser.py         #   PPTX 텍스트·노트
    ├── slide_renderer.py      #   LibreOffice→PDF→PNG (PyMuPDF)
    └── requirements.txt       #   (PyInstaller로 freeze 후 번들 가능)
```

`★` = 경계가 핵심인 모듈.

---

## 2. import 경계 (어기면 안 되는 의존 방향)

의존은 **한 방향**으로만 흐른다. 역방향·교차 import 금지.

```
ui ──▶ core ──▶ emotion
            └─▶ memory
expression ──▶ (stream 구독만)        # core를 직접 호출하지 않음
voice ──────▶ (stream 구독 + message 주입만)
tools ──────▶ core (도구 실행은 core가 호출)
presentation ─▶ core (호출만)          # core는 presentation을 절대 import 안 함
```

핵심 금지:
- **core 는 presentation / voice / expression / tools 를 import 하지 않는다.**
  본체는 자기를 둘러싼 확장의 존재를 모른다. (R3)
- expression·voice 는 출력 **스트림을 구독**할 뿐, core 내부 함수를 직접 부르지 않는다. (R2)
- presentation 은 core 를 호출하되, core 내부를 수정·참조하지 않는다. (R3)
- stream.ts 는 emotion/vad 에서 **VAD 타입만** import 한다(런타임 의존 없음). 감정 로직을
  실행하는 import 가 추가되면 경계 위반.

검증법: `core/` 안에서 `import ... from '../presentation'` 류가 하나라도 있으면 위반.

**MCP 흡수 경로 (외부 도구)**: 외부 MCP 서버는 메인 프로세스(`electron/mcp/`)가 stdio로
띄우고, 렌더러(`tools/mcp.ts`)가 IPC로 그 도구를 받아 **빌트인과 같은 레지스트리에
register** 한다. 따라서 MCP 도구도 게이트(R4)·감사·redact(R7)·체이닝을 빌트인과 동일하게
거친다. 네임스페이스 `mcp__<서버>__<도구>`로 빌트인 덮어쓰기를 막는다. core 는 도구가
빌트인인지 MCP인지 모른다(도구는 전부 동일한 "도구").

---

## 3. 데이터 흐름 (한 턴)

```
입력(채팅/음성/발표) 
  → Message 정규화 (core/message.ts)          # R1
  → engine: LLM 단일 호출(감정 마커 + 답변)     # 감정·답변 동시
  → 마커 파싱 → emotion 갱신(스무딩)            # emotion/
  → 답변 토큰을 출력 스트림으로 흘림            # core/stream.ts, R2
       ├─▶ 자막/채팅 렌더 (ui)
       ├─▶ 표정 갱신 (expression, V·A) + 어투(D는 답변 생성 시 반영)
       └─▶ TTS 재생 (voice, +1)
  → 턴 종료 시 단기기억 갱신 (memory/shortTerm)
  → 주기적으로 스냅샷 (memory/longTerm)
앱 종료 시: 단기 → 요약 + 사실분리 → 장기 (memory)
유휴 시: emotion decay 진행
```

---

## 4. 상태 저장 위치

| 상태 | 위치 |
|---|---|
| 현재 세션 대화 | 단기 캐시 (메모리/임시) |
| 누적 기억·요약 | 로컬 SQLite |
| 추출된 사실(선호·이름 등) | SQLite 별도 테이블 |
| 감정 상태(VAD) | 세션 메모리 + 종료 시 영속 |
| affection(+1) | SQLite (스키마에 자리 미리 확보) |
| 감사 로그 | SQLite 또는 로그 파일 |

SQLite 스키마는 확장 대비로 테이블을 분리한다. 현재 5테이블: `memories`(요약+스냅샷),
`emotion_state`(VAD 단일 행), `relationship`(affection 등 키-값 확장 자리), `facts`(사실
키-값), `audit_log`(도구 감사 + 롤백). 컬럼 추가 대신 키-값 보조 구조로 확장을 흡수한다.

---

## 5. 단계별 구현 (이 순서 고정)

- **Core**: message → stream → engine → llm(단일호출/마커) → emotion(스무딩/감쇠) → memory(2단/스냅샷/사실/첫실행) → expression(2D) → 최소 ui.
- **+1**: voice(STT/TTS 스트림) → 저지연 파이프라인 → tools registry/gate 실제 도구 → 경량모델 라우팅 → affection.
- **+2**: presentation 컨트롤러 → sidecar PPTX 추출/렌더 → computer_use(도구로 흡수).

각 단계 진입 전 골격(빈 폴더 + 인터페이스)은 Core 단계에서 미리 만들되 **구현은 비워둔다**(빈 placeholder 파일 남발 금지 — 폴더와 핵심 인터페이스만).

---

## 6. 구현 현황 (현재 코드 기준)

위 단계는 대부분 구현됐다. 현재 상태 요약(`✓` 구현 · `◐` 부분 · `○` 미구현):

- **Core** ✓ — 입력 정규화·출력 스트림·대화 엔진·VAD 단일호출/마커·스무딩(0.35)/감쇠
  (분당 5%)·두 겹 기억(단기 캐시 + SQLite 요약/스냅샷 + 사실 키-값)·첫 실행 온보딩·2D 표정.
- **+1** ◐ — TTS(스트리밍, WebSpeech) ✓ · 도구 레지스트리/게이트/감사 + 내장 23종 ✓ ·
  도구 체이닝(최대 16라운드) ✓ · 모델 라우팅(규칙 기반 FAST=Sonnet 4.6 / SLOW=Opus 4.8) ✓ ·
  프롬프트 캐싱(고정 페르소나) ✓ · affection ✓ · **STT ◐**(WebSpeech가 Electron에서
  구조적으로 동작 불가, 폴백 변환기 미배선 — §6-1 참조).
- **+2** ◐ — 발표 컨트롤러(격리, R3) ✓ · 문서 이해 범용화(PPTX/PDF/DOCX/TXT/MD) ✓ ·
  사이드카 문서 추출 ✓ · 데모 덱 폴백 ✓ · **computer_use ○**(미구현, 통합 레지스트리의
  dangerous 도구로 흡수할 계획만 존재).
- **추가** — MCP 자체 구현(외부 SDK 없이 JSON-RPC 2.0 over stdio, 외부 도구 흡수) ✓ ·
  입력 통합(채팅·음성이 단일 라우팅: 문서 > 발표 > 일반) ✓ · API 경계/사실/종료 전사
  redact(R7) ✓.

### 6-1. STT 한계 (알려진 함정)

1차 인식기는 브라우저 Web Speech API(`SpeechRecognition`)다. Electron(Chromium)에는 구글
음성 인식 백엔드·키가 동봉돼 있지 않아 `start()`가 `network` 오류로 실패한다(Electron의
구조적 한계). 이를 대비한 녹음→변환 폴백 슬롯(`transcribeRecording`)이 `voice/stt.ts`에
설계돼 있으나 아직 주입(배선)되지 않았다. 따라서 **현재 음성 입력은 동작하지 않으며**,
입력은 텍스트 채팅을 사용한다(TTS 출력은 정상). 로컬 Whisper(사이드카) 또는 외부 STT API
연동이 향후 과제다. 사이드카(`electron/sidecar/manager.ts`)는 이 확장을 예견해
`waitUntilReady` 계약을 남겨 뒀다.
