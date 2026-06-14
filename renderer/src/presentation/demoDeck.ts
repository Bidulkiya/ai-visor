/**
 * 데모 슬라이드 덱 — 사이드카 PPTX 파싱(+2 다음 단계)이 붙기 전까지의
 * 발표 흐름 검증·시연용 더미 데이터.
 *
 * 주제를 "이 앱 자신"으로 둔 이유: 메타 장치(④)와 맞물려, 발표 중 청중
 * 질문이 들어와도 아키텍처 요약에 근거한 정확한 답이 나오는지 검증할 수 있다.
 * 사이드카가 붙으면 normalizeSlideDeck(IPC 데이터)로 대체된다.
 */

import type { SlideDeck } from './slides'

export function createDemoSlideDeck(): SlideDeck {
  return {
    sourceName: 'AI Visor 데모 발표 (더미)',
    slides: [
      {
        number: 1,
        title: 'AI Visor — 감정을 읽는 데스크톱 AI 동반자',
        bodyText: 'VAD 감정 모델, 로컬 SQLite 기억, Electron 데스크톱 앱',
        speakerNotes: '첫인사와 함께 앱이 무엇인지 한 줄로 소개. 컴퓨터 조종이 아니라 동반자가 본질임을 강조.',
        imageDataUrl: null,
      },
      {
        number: 2,
        title: '감정과 기억 — 대화가 쌓이는 방식',
        bodyText: 'VAD 3축 감정 추론과 표정 반영, 세션 요약과 사실 추출, 유대(affection) 어투 변화',
        speakerNotes: '감정 추론이 답변과 같은 LLM 호출에서 일어나 지연이 없다는 점, 기억은 전부 로컬이라는 점을 짚는다.',
        imageDataUrl: null,
      },
      {
        number: 3,
        title: '안전 장치 — 도구 게이트와 격리 구조',
        bodyText: '위험 도구 승인 게이트(risk 태그), 감정의 실행 불개입 원칙, 발표 모듈의 본체 격리',
        speakerNotes: '지금 진행 중인 이 발표 자체가 본체를 모르는 격리 컨트롤러로 돌아간다는 메타 포인트로 마무리.',
        imageDataUrl: null,
      },
    ],
  }
}
