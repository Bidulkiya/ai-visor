/**
 * 대화 엔진 — 본체의 심장 (ARCHITECTURE.md §3 데이터 흐름)
 *
 * Message를 받아 LLM 한 번 호출(감정 마커 + 답변, R5/기획서 §3.2)을 소비하고,
 * 결과를 출력 스트림 하나로 흘린다 (R2).
 *
 * 스트림 수명 주기 계약(stream.ts)의 순서 보장은 이 모듈의 책임이다:
 *   turn-start → emotion(최대 1회, 토큰 전) → token* → (turn-end | turn-interrupted | error)
 * - turn-start는 runTurn 진입 즉시(첫 await 전) 발행한다 — 구독자가 지연 없이
 *   "생각 중" 연출을 시작할 수 있도록 (기획서 §7).
 * - 끼어들기 트리거 시점: interrupt() 호출 → AbortSignal 발화 → 진행 중인
 *   LLM 생성에 취소 전파 + 다음 청크 경계에서 소비 중단 → 종결 이벤트는
 *   turn-interrupted 하나만 발행. 재생/TTS 측 취소는 구독자가
 *   turn-interrupted를 받아 수행한다 (CLAUDE.md §5 끼어들기 함정).
 *
 * 이 모듈은 source로 동작을 분기하지 않는다 (R1). 발표 개념을 모른다 (R3).
 */

import type { Message } from './message'
import type { OutputStream } from './stream'
import type { VadState } from '../emotion/vad'
import type { ShortTermMemory } from '../memory/shortTerm'
import type { LongTermMemory } from '../memory/longTerm'

/** LLM 모듈(llm.ts)이 구현할 포트 — engine은 이 계약만 안다 */
export interface LlmTurnProvider {
  /**
   * 단일 LLM 호출의 스트리밍 결과.
   * 계약: emotion 청크는 토큰보다 먼저 최대 1회. signal 발화 시 생성을 취소한다.
   */
  streamTurn(message: Message, signal: AbortSignal): AsyncIterable<LlmTurnChunk>
}

export type LlmTurnChunk =
  | { type: 'emotion'; vad: VadState }
  /** 답변 중 구절별 감정 전환 — 표정 흐름 전용. 토큰과 섞여 0회 이상 */
  | { type: 'emotion-shift'; vad: VadState }
  | { type: 'token'; text: string }

export type TurnResult =
  | { status: 'completed' }
  | { status: 'interrupted' }
  | { status: 'failed'; errorMessage: string }
  /** 진행 중인 턴이 있으면 거부 — 끼어들려면 호출자가 먼저 interrupt() */
  | { status: 'rejected-busy' }

export interface ConversationEngine {
  runTurn(message: Message): Promise<TurnResult>
  interrupt(): void
  isTurnActive(): boolean
}

/**
 * 턴 종료 시 단기기억 기록 + 주기 스냅샷 연결 (ARCHITECTURE §3).
 * 없으면(테스트 등) 기억 없이 동작한다.
 */
export interface EngineMemoryBindings {
  shortTerm: ShortTermMemory
  longTerm: LongTermMemory
}

const UNKNOWN_ERROR_MESSAGE = '알 수 없는 오류로 답변 생성에 실패했습니다'

/** 턴 동안 답변 텍스트를 모은다 — 기억 기록용 (중단 시 부분 텍스트 보존) */
interface AssistantTextCollector {
  text: string
}

export function createConversationEngine(
  llmProvider: LlmTurnProvider,
  outputStream: OutputStream,
  memoryBindings?: EngineMemoryBindings,
): ConversationEngine {
  let activeTurnAbort: AbortController | null = null

  async function consumeLlmChunks(
    message: Message,
    signal: AbortSignal,
    collector: AssistantTextCollector,
  ): Promise<void> {
    let hasEmotionPublished = false
    let hasTokenStarted = false

    // for-await의 break는 iterator.return()을 호출하므로 provider 정리가 보장된다
    for await (const chunk of llmProvider.streamTurn(message, signal)) {
      if (signal.aborted) {
        break
      }
      if (chunk.type === 'emotion') {
        if (hasEmotionPublished || hasTokenStarted) {
          // 계약 위반(중복/지각 emotion)은 스트림에 흘리지 않고 기록만 한다
          console.error('[engine.consumeLlmChunks]: emotion 청크 계약 위반 — 무시함')
          continue
        }
        hasEmotionPublished = true
        outputStream.publish({ type: 'emotion', vad: chunk.vad })
        continue
      }
      if (chunk.type === 'emotion-shift') {
        // 구절별 표정 전환 — 토큰 중간에 와도 그대로 흘린다(첫 emotion 계약과 별개, 표정 전용)
        outputStream.publish({ type: 'emotion-shift', vad: chunk.vad })
        continue
      }
      hasTokenStarted = true
      collector.text += chunk.text
      outputStream.publish({ type: 'token', text: chunk.text })
    }
  }

  /**
   * 완료·중단된 턴을 단기기억에 기록하고 N턴 주기 스냅샷을 시도한다.
   * 실패 턴과 빈 답변 턴(답변 시작 전 끊김 등)은 기록하지 않는다 —
   * 기억 노이즈·스냅샷 주기 오염 방지. 다음 입력이 사용자 의도를 다시 전달한다.
   * 스냅샷은 실패해도 throw하지 않으므로(상태 반환) 기억 문제가 대화를 깨지 않는다.
   */
  async function recordTurnInMemory(message: Message, assistantText: string): Promise<void> {
    if (memoryBindings === undefined) {
      return
    }
    if (assistantText.trim().length === 0) {
      return
    }
    memoryBindings.shortTerm.appendTurn({
      userText: message.text,
      assistantText,
      timestamp: message.timestamp,
    })
    await memoryBindings.longTerm.recordTurnAndMaybeSnapshot(memoryBindings.shortTerm)
  }

  async function runTurn(message: Message): Promise<TurnResult> {
    if (activeTurnAbort !== null) {
      return { status: 'rejected-busy' }
    }
    const abortController = new AbortController()
    activeTurnAbort = abortController
    const collector: AssistantTextCollector = { text: '' }

    outputStream.publish({ type: 'turn-start' })
    try {
      await consumeLlmChunks(message, abortController.signal, collector)
      if (abortController.signal.aborted) {
        outputStream.publish({ type: 'turn-interrupted' })
        await recordTurnInMemory(message, collector.text)
        return { status: 'interrupted' }
      }
      outputStream.publish({ type: 'turn-end' })
      await recordTurnInMemory(message, collector.text)
      return { status: 'completed' }
    } catch (error) {
      // 중단 직후 provider가 던진 예외는 실패가 아니라 중단의 일부다
      if (abortController.signal.aborted) {
        outputStream.publish({ type: 'turn-interrupted' })
        await recordTurnInMemory(message, collector.text)
        return { status: 'interrupted' }
      }
      const errorMessage = error instanceof Error ? error.message : UNKNOWN_ERROR_MESSAGE
      console.error('[engine.runTurn]:', error)
      outputStream.publish({ type: 'error', message: errorMessage })
      return { status: 'failed', errorMessage }
    } finally {
      activeTurnAbort = null
    }
  }

  function interrupt(): void {
    if (activeTurnAbort === null) {
      return
    }
    activeTurnAbort.abort()
  }

  function isTurnActive(): boolean {
    return activeTurnAbort !== null
  }

  return { runTurn, interrupt, isTurnActive }
}
