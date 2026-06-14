/**
 * 경량 모델 라우팅 (기획서 §1 +1, §9 재활용 자산)
 *
 * 사용자 메시지를 보고 빠른 모델(haiku급)과 느린 모델(opus급) 중 하나를 고른다.
 * 판단은 LLM 호출 없이 규칙 기반(길이·키워드·문장 구조)이다 — 라우팅을 위해
 * LLM을 또 부르면 단일 호출 합치기(CLAUDE.md §2, 딜레이 0)와 충돌한다.
 *
 * 원칙: 모호하면 느린 모델. 라우팅은 지연·비용 최적화이지 품질 도박이 아니다.
 * 순수 함수 — 로깅은 적용 지점(llm.ts)에서 한다.
 */

import type { Message } from './message'

export type ModelTier = 'fast' | 'slow'

export interface RoutingDecision {
  model: string
  tier: ModelTier
  /** 콘솔 출력용 판단 근거 — 사람이 읽는 한국어 */
  reason: string
}

/** 빠른 모델 — 인사·감정 반응·단순 질문용 */
export const FAST_MODEL_ID = 'claude-haiku-4-5'
/** 느린 모델 — 복잡한 추론·작업 수행용 (현재 기본 모델과 동일) */
export const SLOW_MODEL_ID = 'claude-opus-4-8'

/** 이 길이를 넘으면 보통 맥락 있는 요청 — 한국어 기준 토큰 수의 근사치 */
const LONG_MESSAGE_CHAR_THRESHOLD = 80
/** 이 길이 이하 + 작업 신호 없음 = 가벼운 발화 */
const SHORT_MESSAGE_CHAR_THRESHOLD = 30
/** 문장이 이보다 많으면 구조적으로 복잡한 입력 */
const MAX_FAST_SENTENCE_COUNT = 2

/** 작업·추론 신호 — 하나라도 있으면 느린 모델 */
const SLOW_TASK_KEYWORDS: readonly string[] = [
  '설명해',
  '분석',
  '정리해',
  '요약해',
  '비교',
  '계획',
  '만들어',
  '작성',
  '써줘',
  '코드',
  '구현',
  '단계',
  '자세히',
  '왜 그런',
  '어떻게 하면',
  '추천해',
  '알려줘',
]

/** 인사·감정 반응 신호 — 빠른 모델로 충분 */
const FAST_SOCIAL_KEYWORDS: readonly string[] = [
  '안녕',
  '하이',
  '반가',
  '좋은 아침',
  '잘 자',
  '잘자',
  '고마워',
  '감사',
  '미안',
  '기분',
  '좋아',
  '신난다',
  '슬퍼',
  '힘들',
  '피곤',
  'ㅋㅋ',
  'ㅎㅎ',
  'ㅠㅠ',
]

const SENTENCE_BOUNDARY_PATTERN = /[.!?…\n]+/

function countSentences(text: string): number {
  return text
    .split(SENTENCE_BOUNDARY_PATTERN)
    .filter((segment) => segment.trim().length > 0).length
}

function findKeyword(text: string, keywords: readonly string[]): string | null {
  for (const keyword of keywords) {
    if (text.includes(keyword)) {
      return keyword
    }
  }
  return null
}

function decideFast(reason: string): RoutingDecision {
  return { model: FAST_MODEL_ID, tier: 'fast', reason }
}

function decideSlow(reason: string): RoutingDecision {
  return { model: SLOW_MODEL_ID, tier: 'slow', reason }
}

/**
 * 규칙 우선순위 (위에서 먼저 맞는 것):
 * 1. 작업·추론 키워드 → slow (사용자가 일을 시켰다)
 * 2. 긴 입력 → slow (맥락 있는 요청일 가능성)
 * 3. 문장 3개 이상 → slow (구조적으로 복잡)
 * 4. 인사·감정 키워드 → fast
 * 5. 짧은 발화 → fast (단순 질문·반응)
 * 6. 그 외 → slow (안전 기본값)
 */
export function routeModel(message: Message): RoutingDecision {
  const text = message.text

  const slowKeyword = findKeyword(text, SLOW_TASK_KEYWORDS)
  if (slowKeyword !== null) {
    return decideSlow(`작업·추론 키워드 '${slowKeyword}'`)
  }
  if (text.length > LONG_MESSAGE_CHAR_THRESHOLD) {
    return decideSlow(`긴 입력 (${text.length}자 > ${LONG_MESSAGE_CHAR_THRESHOLD}자)`)
  }
  const sentenceCount = countSentences(text)
  if (sentenceCount > MAX_FAST_SENTENCE_COUNT) {
    return decideSlow(`문장 ${sentenceCount}개 — 구조적으로 복잡`)
  }

  const fastKeyword = findKeyword(text, FAST_SOCIAL_KEYWORDS)
  if (fastKeyword !== null) {
    return decideFast(`인사·감정 키워드 '${fastKeyword}'`)
  }
  if (text.length <= SHORT_MESSAGE_CHAR_THRESHOLD) {
    return decideFast(`짧은 발화 (${text.length}자 ≤ ${SHORT_MESSAGE_CHAR_THRESHOLD}자)`)
  }

  return decideSlow('모호함 — 품질 우선 기본값')
}
