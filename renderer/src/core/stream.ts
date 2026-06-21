/**
 * 출력 단일 이벤트 스트림 (CLAUDE.md R2)
 *
 * LLM 출력은 이 스트림 하나로 흐르고, 소비자(자막·표정·TTS)가 각자 구독한다.
 * 소비자별로 출력을 따로 생성하지 않는다.
 * expression/voice는 이 스트림을 구독만 할 뿐, core 내부 함수를 직접 부르지 않는다.
 *
 * 한 턴의 이벤트 순서 계약 (발행자 = engine):
 *   turn-start → emotion → (token | emotion-shift)* → (turn-end | turn-interrupted | error)
 * - emotion은 토큰보다 먼저 1회 발행된다 (마커가 답변보다 앞서므로). affection·세션 감정은
 *   이 첫 emotion 1회만 쓴다(턴 단위 회계 불변).
 * - emotion-shift는 답변 중 구절 단위로 감정이 바뀔 때 토큰과 섞여 0회 이상 발행된다.
 *   "표정 흐름" 전용이다 — 표정(expression)만 구독해 반영하고, affection·세션·TTS는 무시한다.
 * - turn-interrupted는 끼어들기(푸시투토크) 등으로 턴이 잘렸음을 뜻한다 —
 *   구독자는 진행 중인 재생/렌더를 즉시 멈춰야 한다.
 * - error는 턴의 비정상 종료를 뜻한다.
 * 스트림은 순서를 강제하지 않는다 — 전달만 한다(한 함수 한 역할).
 * 순서 보장은 발행자 책임이다.
 */

import type { VadState } from '../emotion/vad'

export type OutputEvent =
  | { type: 'turn-start' }
  | { type: 'emotion'; vad: VadState }
  /** 답변 중 구절별 감정 전환 — 표정 흐름 전용(affection·세션·TTS는 무시). 토큰과 섞여 0+회 */
  | { type: 'emotion-shift'; vad: VadState }
  | { type: 'token'; text: string }
  | { type: 'turn-end' }
  | { type: 'turn-interrupted' }
  | { type: 'error'; message: string }

export type OutputSubscriber = (event: OutputEvent) => void

export type Unsubscribe = () => void

export interface OutputStream {
  publish(event: OutputEvent): void
  subscribe(subscriber: OutputSubscriber): Unsubscribe
}

/** 같은 함수를 두 번 구독해도 서로 독립이도록 구독마다 고유 래퍼를 둔다 */
interface Subscription {
  notify: OutputSubscriber
}

export function createOutputStream(): OutputStream {
  const subscriptions = new Set<Subscription>()

  function publish(event: OutputEvent): void {
    // 발행 도중의 구독/해지가 현재 발행 순회를 깨지 않도록 스냅샷을 순회한다.
    // 새 구독자는 다음 발행부터 받고, 순회 중 해지된 구독자는 건너뛴다.
    const snapshot = [...subscriptions]
    for (const subscription of snapshot) {
      if (!subscriptions.has(subscription)) {
        continue
      }
      try {
        subscription.notify(event)
      } catch (error) {
        // 한 구독자의 실패가 다른 구독자와 스트림을 죽이면 안 된다 (R2)
        console.error('[OutputStream.publish]: 구독자 처리 중 오류 — 해당 구독자만 건너뜀', error)
      }
    }
  }

  function subscribe(subscriber: OutputSubscriber): Unsubscribe {
    const subscription: Subscription = { notify: subscriber }
    subscriptions.add(subscription)
    return () => {
      // 중복 호출해도 무해하다 (이미 없으면 no-op)
      subscriptions.delete(subscription)
    }
  }

  return { publish, subscribe }
}
