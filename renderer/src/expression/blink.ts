/**
 * 눈 깜빡임 — 타이머 기반 (기획서 §3.4)
 *
 * 순수 로직: 시계(now)와 난수원을 주입받고, 상태는 호출자가 들고 있다.
 * 호출자는 렌더 루프마다 advanceBlink로 상태를 전이시키고
 * eyeOpennessFactor를 눈 크기에 곱한다.
 */

export const BLINK_INTERVAL_MIN_MS = 2000
export const BLINK_INTERVAL_MAX_MS = 6000
export const BLINK_DURATION_MS = 150

/** [0,1) 난수원 — 테스트에서 결정적으로 주입 가능 */
export type RandomSource = () => number

export interface BlinkState {
  /** 다음 깜빡임 시작 예정 시각 (ms) */
  nextBlinkAt: number
  /** 진행 중인 깜빡임의 시작 시각 — 없으면 null */
  blinkStartedAt: number | null
}

function pickNextInterval(random: RandomSource): number {
  return BLINK_INTERVAL_MIN_MS + random() * (BLINK_INTERVAL_MAX_MS - BLINK_INTERVAL_MIN_MS)
}

export function createInitialBlinkState(now: number, random: RandomSource = Math.random): BlinkState {
  return { nextBlinkAt: now + pickNextInterval(random), blinkStartedAt: null }
}

/** 상태 전이. 변화가 없으면 같은 객체를 그대로 반환한다(불변·참조 비교 가능) */
export function advanceBlink(
  state: BlinkState,
  now: number,
  random: RandomSource = Math.random,
): BlinkState {
  if (state.blinkStartedAt !== null) {
    if (now - state.blinkStartedAt < BLINK_DURATION_MS) {
      return state
    }
    // 깜빡임 종료 — 다음 깜빡임을 랜덤 간격(2~6초)으로 예약
    return { nextBlinkAt: now + pickNextInterval(random), blinkStartedAt: null }
  }
  if (now >= state.nextBlinkAt) {
    return { nextBlinkAt: state.nextBlinkAt, blinkStartedAt: now }
  }
  return state
}

/**
 * 눈 뜬 정도 0(감음)~1(뜸).
 * 깜빡임 동안 사인 곡선으로 부드럽게 감았다 뜬다 (중간 지점에서 완전히 감음).
 */
export function eyeOpennessFactor(state: BlinkState, now: number): number {
  if (state.blinkStartedAt === null) {
    return 1
  }
  const progress = (now - state.blinkStartedAt) / BLINK_DURATION_MS
  if (progress <= 0 || progress >= 1) {
    return 1
  }
  return 1 - Math.sin(progress * Math.PI)
}
