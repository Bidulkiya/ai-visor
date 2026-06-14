/**
 * 발표 전 사전 조사 (+2 ③)
 *
 * PPTX 로드 직후, 발표 시작 전에 슬라이드별 핵심 키워드로 search_web을
 * 호출해 결과를 슬라이드별 캐시에 담는다. 발표 중에는 캐시만 쓴다 —
 * 실시간 검색 없음(지연 방지).
 *
 * - 검색은 도구 런타임(ToolRuntime)으로만 호출한다 — 게이트·감사 로그를
 *   그대로 통과한다 (R4). search_web은 risk 'safe'라 승인 없이 실행된다.
 * - 슬라이드 하나의 검색 실패는 그 슬라이드만 캐시 없이 넘어간다 —
 *   사전 조사가 발표를 막는 일은 없다.
 * - 키워드 추출은 형태소 분석 없는 단순 휴리스틱(제목 우선 + 긴 토큰) —
 *   사이드카 단계에서 개선 여지. 순수 함수로 분리해 검증 가능하게 한다.
 */

import type { ToolRuntime } from '../core/session'
import type { Slide, SlideDeck } from './slides'

export const SEARCH_TOOL_NAME = 'search_web'
/** 슬라이드당 캐시 최대 길이 — 발표 프롬프트 예산 보호 */
export const RESEARCH_SUMMARY_MAX_LENGTH = 700
/** 검색어에 넣을 본문 키워드 최대 개수 (제목은 항상 포함) */
const BODY_KEYWORD_MAX_COUNT = 4
/** 이 길이 미만 토큰은 조사·접속사일 가능성이 높아 버린다 */
const KEYWORD_MIN_LENGTH = 2

const TOKEN_SPLIT_PATTERN = /[\s,.!?·…()[\]{}"'`~:;|/\\<>=+*&^%$#@-]+/u

/** 숫자뿐인 토큰은 검색어 가치가 없다 */
function isMeaningfulKeyword(token: string): boolean {
  return token.length >= KEYWORD_MIN_LENGTH && !/^\d+$/.test(token)
}

/**
 * 슬라이드에서 검색어를 만든다. 제목을 그대로 쓰고 본문에서 키워드 몇 개를
 * 보탠다(중복 제거). 만들 게 없으면 null — 그 슬라이드는 조사를 건너뛴다.
 */
export function buildSearchQuery(slide: Slide): string | null {
  const titleTokens = slide.title.split(TOKEN_SPLIT_PATTERN).filter(isMeaningfulKeyword)
  const seenTokens = new Set(titleTokens)
  const bodyKeywords: string[] = []
  for (const token of slide.bodyText.split(TOKEN_SPLIT_PATTERN)) {
    if (bodyKeywords.length >= BODY_KEYWORD_MAX_COUNT) {
      break
    }
    if (isMeaningfulKeyword(token) && !seenTokens.has(token)) {
      seenTokens.add(token)
      bodyKeywords.push(token)
    }
  }
  const query = [...titleTokens, ...bodyKeywords].join(' ').trim()
  return query.length > 0 ? query : null
}

export interface PreResearchProgress {
  completedSlides: number
  totalSlides: number
}

export type PreResearchProgressListener = (progress: PreResearchProgress) => void

export interface PreResearchOptions {
  /** 진행 표시용 — "발표 준비 중... (슬라이드 X/Y 조사)" */
  onProgress?: PreResearchProgressListener
  /** 발표 종료 등으로 조사가 무의미해지면 false — 남은 검색을 중단한다 */
  shouldContinue?: () => boolean
}

/** 한 슬라이드 조사 — 실패는 null로 흡수한다(발표 중단 없음) */
async function researchSingleSlide(slide: Slide, toolRuntime: ToolRuntime): Promise<string | null> {
  const query = buildSearchQuery(slide)
  if (query === null) {
    return null
  }
  try {
    const result = await toolRuntime.invoke(SEARCH_TOOL_NAME, { query })
    if (!result.isSuccess || result.output.trim().length === 0) {
      console.error(`[preResearch]: 슬라이드 ${slide.number} 검색 실패 — 캐시 없이 진행:`, result.output)
      return null
    }
    return result.output.trim().slice(0, RESEARCH_SUMMARY_MAX_LENGTH)
  } catch (error) {
    console.error(`[preResearch]: 슬라이드 ${slide.number} 검색 예외 — 캐시 없이 진행:`, error)
    return null
  }
}

/**
 * 덱 전체를 순차 조사해 슬라이드 번호 → 조사 요약 캐시를 만든다.
 * 순차인 이유: 검색 호스트에 부담을 주지 않고, 진행 표시(X/Y)가 의미를 갖게.
 * toolRuntime이 null이면(도구 미연결 환경) 조사 없이 빈 캐시 — 발표는 가능.
 */
export async function researchSlideDeck(
  deck: SlideDeck,
  toolRuntime: ToolRuntime | null,
  options: PreResearchOptions = {},
): Promise<ReadonlyMap<number, string>> {
  const researchBySlide = new Map<number, string>()
  const totalSlides = deck.slides.length
  if (toolRuntime === null) {
    console.log('[preResearch]: 도구 런타임 없음 — 사전 조사 생략')
    options.onProgress?.({ completedSlides: totalSlides, totalSlides })
    return researchBySlide
  }

  for (const slide of deck.slides) {
    if (options.shouldContinue !== undefined && !options.shouldContinue()) {
      console.log('[preResearch]: 조사 중단 요청 — 남은 슬라이드 건너뜀')
      return researchBySlide
    }
    const summary = await researchSingleSlide(slide, toolRuntime)
    if (summary !== null) {
      researchBySlide.set(slide.number, summary)
    }
    options.onProgress?.({ completedSlides: slide.number, totalSlides })
  }
  console.log(`[preResearch]: 조사 완료 — ${researchBySlide.size}/${totalSlides}장 캐시 확보`)
  return researchBySlide
}
