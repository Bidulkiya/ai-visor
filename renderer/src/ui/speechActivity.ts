/**
 * 발성 활동 채널 — TTS(voice) → 표정(FaceCanvas)을 잇는 ui 전용 신호.
 *
 * 출력 스트림(R2)이 아니다: 출력 스트림은 LLM→소비자 단방향이라 TTS가 거기로 되쏘지 않는다.
 * TTS 플레이어가 sink로 "말하는 중/단어 경계"를 쓰고, FaceCanvas가 state를 rAF 루프에서 읽어
 * 입 벌어짐(발성 모션)을 그린다. state는 가변 객체라 폴링용 — React 리렌더를 유발하지 않는다
 * (FaceCanvas는 어차피 매 프레임 리렌더하므로 그 안에서 읽으면 충분하다).
 *
 * ★ 표정 매핑(VAD→입꼬리)·blink는 건드리지 않는다. 발성 모션은 입 "벌어짐"만 더한다.
 */

import type { SpeechActivitySink } from '../voice/tts'

export interface SpeechActivityState {
  /** 지금 말하는 중인지 — 입 벌어짐을 켜는 게이트 */
  speaking: boolean
  /** 마지막 단어 경계 시각(performance.now). 음절 펄스용. 없으면 0 */
  lastBoundaryAt: number
}

export interface SpeechActivityChannel {
  /** FaceCanvas가 rAF에서 읽는다(폴링) */
  state: SpeechActivityState
  /** TTS 플레이어에 주입한다 */
  sink: SpeechActivitySink
}

export function createSpeechActivity(): SpeechActivityChannel {
  const state: SpeechActivityState = { speaking: false, lastBoundaryAt: 0 }
  return {
    state,
    sink: {
      setSpeaking(active: boolean): void {
        state.speaking = active
      },
      markBoundary(now: number): void {
        state.lastBoundaryAt = now
      },
    },
  }
}
