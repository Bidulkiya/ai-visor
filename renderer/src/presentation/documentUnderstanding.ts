/**
 * 문서 이해 컨트롤러 (+2 확장 ②) — 본체 바깥에서 본체를 "운전"하는 격리 레이어 (R3)
 *
 * 발표 컨트롤러와 같은 원칙: 본체와의 유일한 접점은 Message 주입(sendUserMessage)과
 * interrupt다. 본체는 이 모듈을 모른다 — 이 폴더를 지워도 본체는 컴파일·동작한다.
 * 감정·기억·게이트는 본체를 거치므로 문서 모드에서도 자동으로 정상 작동한다.
 *
 * 흐름: openDocument → (문서 주제 1회 조사) → 전체 내용 요약 주입 → ready.
 *       ask(질문) → 문서 내용 + 조사로 답변 주입 → ready 복귀.
 * 세대(generation) 가드로, 닫기·새 문서 열기 때 이전 비동기 턴이 새 상태를 못 건드리게 한다.
 */

import type { SendMessageResult, ToolRuntime } from '../core/session'
import { documentToSlideDeck, type LoadedDocument } from './document'
import { researchDocumentTopic } from './preResearch'
import { buildDocumentOverviewPrompt, buildDocumentQuestionPrompt } from './documentPrompts'

/** 본체에서 컨트롤러가 쓰는 표면 — CompanionSession이 구조적으로 만족한다(발표 컨트롤러와 동일) */
export interface DocumentSessionPort {
  sendUserMessage(rawSource: unknown, rawText: unknown): Promise<SendMessageResult>
  interrupt(): void
}

export type DocumentStage =
  | { name: 'idle' }
  /** 주제 조사 + 전체 요약 진행 중 */
  | { name: 'reading' }
  /** 요약 끝 — 질문을 받을 수 있다 */
  | { name: 'ready' }
  | { name: 'answering' }

export interface DocumentView {
  stage: DocumentStage
  document: LoadedDocument | null
  /** 사용자 안내(요약 실패·바쁨 등) — 정상 흐름은 null */
  notice: string | null
}

export type DocumentAskResult = 'accepted' | 'empty-question' | 'no-document' | 'busy'

export interface DocumentUnderstanding {
  getView(): DocumentView
  subscribe(listener: (view: DocumentView) => void): () => void
  /** 문서를 열어 주제 조사 후 전체 요약을 받는다. 끝나거나 중단되면 resolve */
  openDocument(document: LoadedDocument): Promise<void>
  /** 열린 문서에 대해 질문하고 답을 받는다 */
  ask(questionText: string): Promise<DocumentAskResult>
  /** 문서 모드 종료 — 진행 중 턴이 있으면 함께 끊는다 */
  close(): void
}

export interface DocumentUnderstandingOptions {
  session: DocumentSessionPort
  /** 주제 사전 조사용 — null이면 조사 없이 요약·질문만 */
  toolRuntime: ToolRuntime | null
}

function buildTurnFailureNotice(status: SendMessageResult['status']): string {
  if (status === 'rejected-busy') {
    return '다른 대화가 진행 중이라 잠시 멈췄어요. 잠시 후 다시 시도해 주세요.'
  }
  return '답변 생성에 실패했어요. 채팅의 오류 메시지를 확인해 주세요.'
}

export function createDocumentUnderstanding(
  options: DocumentUnderstandingOptions,
): DocumentUnderstanding {
  const { session, toolRuntime } = options

  let view: DocumentView = { stage: { name: 'idle' }, document: null, notice: null }
  const listeners = new Set<(view: DocumentView) => void>()
  /** 열기·닫기마다 증가 — 이전 세대의 비동기 턴이 새 상태를 못 건드리게 */
  let runGeneration = 0
  /** 문서 주제 조사 결과(요약·질문 프롬프트에 함께 실음). 문서마다 새로 채운다 */
  let researchSummary: string | null = null

  function setView(partial: Partial<DocumentView>): void {
    view = { ...view, ...partial }
    for (const listener of listeners) {
      try {
        listener(view)
      } catch (error) {
        console.error('[documentUnderstanding]: 상태 구독자 오류 — 해당 구독자만 건너뜀:', error)
      }
    }
  }

  async function openDocument(document: LoadedDocument): Promise<void> {
    // 이전 문서의 진행 중 턴을 끊고 세대를 올린다 — 늦은 완료가 새 문서 상태를 못 건드리게
    session.interrupt()
    runGeneration += 1
    const generation = runGeneration
    researchSummary = null
    setView({ document, stage: { name: 'reading' }, notice: null })

    // 문서 주제 1회 조사(실패해도 요약은 진행) — 기존 preResearch 재활용
    const topicSummary = await researchDocumentTopic(documentToSlideDeck(document), toolRuntime)
    if (generation !== runGeneration) {
      return
    }
    researchSummary = topicSummary

    const result = await session.sendUserMessage(
      'presentation',
      buildDocumentOverviewPrompt(document, researchSummary),
    )
    if (generation !== runGeneration) {
      return
    }
    if (result.status === 'completed' || result.status === 'interrupted') {
      setView({ stage: { name: 'ready' } })
      return
    }
    // 요약 턴이 실패해도 문서는 열려 있다 — 질문은 시도할 수 있게 ready로 두고 사유만 안내
    console.error('[documentUnderstanding]: 요약 턴 실패:', result)
    setView({ stage: { name: 'ready' }, notice: buildTurnFailureNotice(result.status) })
  }

  async function ask(questionText: string): Promise<DocumentAskResult> {
    const question = questionText.trim()
    if (question.length === 0) {
      return 'empty-question'
    }
    const document = view.document
    if (document === null) {
      return 'no-document'
    }
    if (view.stage.name !== 'ready') {
      return 'busy'
    }
    const generation = runGeneration
    setView({ stage: { name: 'answering' }, notice: null })

    const result = await session.sendUserMessage(
      'presentation',
      buildDocumentQuestionPrompt({ question, document, researchSummary }),
    )
    if (generation !== runGeneration) {
      return 'accepted'
    }
    if (result.status !== 'completed' && result.status !== 'interrupted') {
      console.error('[documentUnderstanding]: 질문 응답 턴 실패:', result)
      setView({ stage: { name: 'ready' }, notice: buildTurnFailureNotice(result.status) })
      return 'accepted'
    }
    setView({ stage: { name: 'ready' } })
    return 'accepted'
  }

  function close(): void {
    if (view.stage.name === 'idle') {
      return
    }
    runGeneration += 1
    researchSummary = null
    session.interrupt()
    setView({ stage: { name: 'idle' }, document: null, notice: null })
  }

  function subscribe(listener: (view: DocumentView) => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  return {
    getView: () => view,
    subscribe,
    openDocument,
    ask,
    close,
  }
}
