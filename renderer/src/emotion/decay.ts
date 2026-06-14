/**
 * VAD 시간 감쇠 — 대화 없는 동안 중립으로 서서히 복귀 (CLAUDE.md §2, 기획서 §3.3)
 *
 * 사용자가 화나게 한 뒤 침묵해도 동반자가 영원히 화나 있지 않도록,
 * 유휴 경과 시간 × 감쇠 계수만큼 VAD를 중립(0,0,0)으로 끌어당긴다.
 * 순수 함수 — 마지막 갱신 시각과 상태는 호출자가 들고 있다.
 */

import { NEUTRAL_VAD, type VadState } from './vad'

/** 분당 중립 복귀 비율. 0.05 = 유휴 1분마다 5%씩 중립으로. 체감 튜닝 대상. */
export const VAD_DECAY_FACTOR_PER_MINUTE = 0.05

const MILLISECONDS_PER_MINUTE = 60_000
const PULL_RATIO_MIN = 0
const PULL_RATIO_MAX = 1

/** 경과 시간만큼 중립 방향으로 보간한다. 경과가 충분히 길면 정확히 중립에 도달한다 */
export function decayVadTowardNeutral(
  state: VadState,
  elapsedMilliseconds: number,
  decayFactorPerMinute: number = VAD_DECAY_FACTOR_PER_MINUTE,
): VadState {
  // 시계 역행·NaN 등 비정상 경과 시간은 상태를 건드리지 않는다
  if (!Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds <= 0) {
    return state
  }
  const elapsedMinutes = elapsedMilliseconds / MILLISECONDS_PER_MINUTE
  const pullRatio = Math.min(
    PULL_RATIO_MAX,
    Math.max(PULL_RATIO_MIN, elapsedMinutes * decayFactorPerMinute),
  )
  return {
    valence: state.valence + (NEUTRAL_VAD.valence - state.valence) * pullRatio,
    arousal: state.arousal + (NEUTRAL_VAD.arousal - state.arousal) * pullRatio,
    dominance: state.dominance + (NEUTRAL_VAD.dominance - state.dominance) * pullRatio,
  }
}
