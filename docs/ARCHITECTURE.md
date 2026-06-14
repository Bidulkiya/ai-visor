# ARCHITECTURE.md — 구조와 경계

기획 배경은 `docs/기획서.md`, 절대 규칙은 `CLAUDE.md` 참조.
이 문서는 **어디에 무엇을 두고, 무엇이 무엇을 import 할 수 있는가**를 정의한다.

---

## 1. 최상위 구조 (분리 구조)

```
ai-companion/
├── CLAUDE.md                  # 절대 규칙 (항상 읽힘)
├── docs/
│   ├── 기획서.md
│   └── ARCHITECTURE.md        # 이 문서
├── electron/                  # 메인 프로세스 (OS·창·생명주기·사이드카 관리)
│   ├── main.ts                # 앱 진입점
│   ├── sidecar/               # Python 프로세스 생명주기 관리 (원칙 5)
│   │   └── manager.ts         # spawn/detach/로그리다이렉트/소켓체크
│   └── ipc/                   # 메인 ↔ 렌더러 통신 채널 정의
├── renderer/                  # Next.js (UI + 본체 로직)
│   └── src/
│       ├── core/              # ★ 본체 — 발표/조종을 모른다
│       │   ├── message.ts     # Message 타입 + 입력 정규화 (R1)
│       │   ├── stream.ts      # 출력 이벤트 스트림 + 구독 (R2)
│       │   ├── engine.ts      # 대화 엔진: Message → 감정+답변 → 스트림
│       │   └── llm.ts         # LLM 호출 (감정+답변 단일 호출, 마커 파싱)
│       ├── emotion/           # VAD 상태·스무딩·감쇠 (순수 로직)
│       │   ├── vad.ts         # VAD 타입, 마커 파싱
│       │   ├── smoothing.ts   # 가중평균
│       │   └── decay.ts       # 시간 감쇠
│       ├── memory/            # 2단 메모리 (로컬 SQLite)
│       │   ├── db.ts          # SQLite(WAL) 연결, 스키마
│       │   ├── shortTerm.ts   # 세션 캐시
│       │   ├── longTerm.ts    # 영속 + 요약 + 스냅샷
│       │   └── facts.ts       # 사실 키-값 분리 추출
│       ├── expression/        # 2D 표정 캐릭터 (스트림 구독자)
│       │   ├── face.ts        # V·A → 표정 매핑
│       │   └── blink.ts       # 눈 깜빡임 타이머
│       ├── tools/             # 통합 도구 레지스트리 (R4) — +1부터 채움
│       │   ├── registry.ts    # 도구 등록 + risk 태그
│       │   ├── gate.ts        # 승인 게이트 (실행 가로채기)
│       │   └── audit.ts       # 감사 로그 + 롤백 정보
│       ├── voice/             # STT/TTS 스트림 (+1) — 스트림 구독자
│       ├── presentation/      # ★ 발표 컨트롤러 (+2) — 본체를 호출만 함
│       └── ui/                # React 컴포넌트
└── sidecar/                   # Python (STT, PPTX 추출/렌더) — +1/+2
    └── (PyInstaller로 freeze 후 번들)
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

검증법: `core/` 안에서 `import ... from '../presentation'` 류가 하나라도 있으면 위반.

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

SQLite 스키마는 확장 대비로 테이블 분리(기억/감정/관계/메타). affection 등 확장 필드는 미리 자리를 잡거나 키-값 보조 테이블로.

---

## 5. 단계별 구현 (이 순서 고정)

- **Core**: message → stream → engine → llm(단일호출/마커) → emotion(스무딩/감쇠) → memory(2단/스냅샷/사실/첫실행) → expression(2D) → 최소 ui.
- **+1**: voice(STT/TTS 스트림) → 저지연 파이프라인 → tools registry/gate 실제 도구 → 경량모델 라우팅 → affection.
- **+2**: presentation 컨트롤러 → sidecar PPTX 추출/렌더 → computer_use(도구로 흡수).

각 단계 진입 전 골격(빈 폴더 + 인터페이스)은 Core 단계에서 미리 만들되 **구현은 비워둔다**(빈 placeholder 파일 남발 금지 — 폴더와 핵심 인터페이스만).
