/**
 * 발표 메시지 본문 조립 — 순수 함수만 (+2 ①·④)
 *
 * 본체의 각 턴은 자기완결적이다(이전 턴 전문이 아니라 요약·사실만 이어짐).
 * 따라서 발표 메시지는 매번 슬라이드 내용·노트·사전 조사·아키텍처 요약을
 * 모두 담아야 한다. 조립된 문자열은 Message(source:'presentation')의 text가 된다.
 */

import type { Slide } from './slides'
import { APP_ARCHITECTURE_SUMMARY } from './architectureSummary'

export interface SlideExplanationPromptInput {
  slide: Slide
  totalSlides: number
  /** 사전 조사 캐시 — 없으면 null (조사 실패 슬라이드도 발표는 계속) */
  researchSummary: string | null
  /** 청중 질문 응답 직후의 복귀 턴인가 — "이어서" 어조 지시 */
  isResumeAfterQuestion: boolean
}

function buildSlideFactsSection(slide: Slide, totalSlides: number): string {
  const lines = [
    `- 슬라이드 ${slide.number}/${totalSlides}: "${slide.title}"`,
    `- 본문: ${slide.bodyText.length > 0 ? slide.bodyText : '(없음)'}`,
  ]
  if (slide.speakerNotes.length > 0) {
    lines.push(`- 발표자 노트(설명의 의도): ${slide.speakerNotes}`)
  }
  return lines.join('\n')
}

function buildResearchSection(researchSummary: string | null): string {
  if (researchSummary === null || researchSummary.length === 0) {
    return ''
  }
  return `\n[사전 조사 자료 — 맞는 내용만 자연스럽게 녹여라]\n${researchSummary}\n`
}

const ARCHITECTURE_SECTION = `[이 앱의 아키텍처 — 구조 질문에는 이 사실에 근거해 답하라]\n${APP_ARCHITECTURE_SUMMARY}`

export function buildSlideExplanationPrompt(input: SlideExplanationPromptInput): string {
  const resumeNotice = input.isResumeAfterQuestion
    ? '(방금 청중 질문에 답했다. "그럼 이어서"처럼 자연스럽게 발표로 복귀하라.)\n'
    : ''
  return `[발표 모드] 너는 지금 이 앱(AI Visor)의 데모 발표를 진행하는 발표자다. 청중에게 말하듯 아래 슬라이드를 설명하라.
${resumeNotice}${buildSlideFactsSection(input.slide, input.totalSlides)}
${buildResearchSection(input.researchSummary)}
${ARCHITECTURE_SECTION}

지시: 2~4문장으로 간결하게, 발표자 노트의 의도를 살려 설명한다. "슬라이드 N입니다" 같은 기계적 표현 없이 자연스럽게 잇는다. 설명만 출력한다.`
}

export interface AudienceQuestionPromptInput {
  question: string
  /** 질문 시점의 슬라이드 — 맥락 제공 (발표 시작 전이면 null이 아닌 현재 슬라이드만 지원) */
  slide: Slide
  researchSummary: string | null
}

export function buildAudienceQuestionPrompt(input: AudienceQuestionPromptInput): string {
  return `[발표 모드 — 청중 질문] 발표 도중 청중이 질문했다. 현재 슬라이드 ${input.slide.number} "${input.slide.title}" 맥락이다.
질문: "${input.question}"
${buildResearchSection(input.researchSummary)}
${ARCHITECTURE_SECTION}

지시: 발표자로서 간결하고 정확하게 답한다. 모르는 것은 아는 척하지 말고 모른다고 한다. 답변만 출력한다.`
}
