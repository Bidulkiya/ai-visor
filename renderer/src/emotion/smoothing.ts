/**
 * VAD 스무딩 — 새 측정값을 이전 상태와 가중평균 (CLAUDE.md §2, 기획서 §3.3)
 *
 * LLM의 VAD 출력은 호출마다 흔들리므로 즉시 반영하지 않는다.
 * 감정이 갑자기 튀지 않고 자연스럽게 변하는 효과도 겸한다.
 * 순수 함수 — 현재 상태는 호출자가 들고 있다.
 */

import type { VadState } from './vad'

/** 새 측정값 반영 비율(0~1). 낮을수록 감정이 천천히 변한다. 체감 튜닝 대상. */
export const VAD_SMOOTHING_FACTOR = 0.35

const FACTOR_MIN = 0
const FACTOR_MAX = 1

/** `이전 × (1-계수) + 새 측정 × 계수` 를 축별로 적용한다 */
export function smoothVad(
  previousState: VadState,
  newMeasurement: VadState,
  smoothingFactor: number = VAD_SMOOTHING_FACTOR,
): VadState {
  const appliedFactor = Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, smoothingFactor))
  const keepRatio = 1 - appliedFactor
  return {
    valence: previousState.valence * keepRatio + newMeasurement.valence * appliedFactor,
    arousal: previousState.arousal * keepRatio + newMeasurement.arousal * appliedFactor,
    dominance: previousState.dominance * keepRatio + newMeasurement.dominance * appliedFactor,
  }
}
