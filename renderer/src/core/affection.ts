/**
 * affection(유대도) 시스템 (+1 마지막 단계, 기획서 §0 철학)
 *
 * 대화가 쌓일수록 유대가 깊어지고, 유대는 **어투에만** 반영된다.
 * - 갱신: 완료된 대화 턴마다 소폭 증가. 그 턴에서 읽은 사용자 감정 V가
 *   높을수록 추가 증가(공감적 대화), V가 매우 낮으면 소폭 감소.
 *   끊긴 턴(끼어들기·에러)은 세지 않는다 — 완성된 대화만 유대를 쌓는다.
 * - 영속: relationship 테이블 'affection' 행 (R6 — 로컬 SQLite에만).
 * - 어투: 3단계 구간을 시스템 프롬프트 톤 지시로 주입(llm.buildVolatileSystemText).
 *   구간 경계에는 히스테리시스를 둬 경계 근처에서 어투가 턴마다 튀지 않게 한다.
 *
 * R5 — affection은 작업 실행 결정에 개입하지 않는다. 이 모듈은 tools/를
 * import하지 않으며, 외부로 내보내는 것은 어투 지시 문자열과 수치뿐이다.
 * risk 태그·승인 게이트는 affection과 무관한 코드 상수다 (tools/gate.ts).
 */

import type { OutputStream, Unsubscribe } from './stream'
import {
  AFFECTION_INITIAL_VALUE,
  RELATIONSHIP_KEY_AFFECTION,
  type MemoryDatabase,
} from '../memory/db'

export const AFFECTION_MIN = 0
export const AFFECTION_MAX = 1
/** 완료된 턴마다의 기본 증가량 */
export const AFFECTION_BASE_DELTA_PER_TURN = 0.01
/** 사용자 V(0 초과 구간)에 비례한 추가 증가 배율 — V=1.0이면 턴당 +0.01 추가 */
export const AFFECTION_EMPATHY_BONUS_SCALE = 0.01
/** 이 값 이하의 사용자 V는 "매우 낮음" — 그 턴은 유대가 소폭 깎인다 */
export const VERY_NEGATIVE_VALENCE_THRESHOLD = -0.7
/** 매우 낮은 V 턴의 순(純) 변화량 — 기본 증가를 대체한다 */
export const AFFECTION_NEGATIVE_TURN_DELTA = -0.005
/** 어투 구간 경계의 히스테리시스 폭 — 경계 근처 미세 변동으로 어투가 오가지 않게 */
export const TONE_TIER_HYSTERESIS_MARGIN = 0.03

/** 유대 구간 3단계: 초면(0~0.3) → 친근(0.3~0.7) → 편안(0.7~1.0) */
export type AffectionToneTier = 'polite' | 'friendly' | 'comfortable'

interface ToneTierRange {
  lower: number
  upper: number
}

const TONE_TIER_RANGES: Record<AffectionToneTier, ToneTierRange> = {
  polite: { lower: 0, upper: 0.3 },
  friendly: { lower: 0.3, upper: 0.7 },
  comfortable: { lower: 0.7, upper: 1 },
}

/** 구간별 어투 지시 — 시스템 프롬프트에 그대로 들어간다. 어투만 다루고 행동 지시는 금지 */
const TONE_INSTRUCTIONS: Record<AffectionToneTier, string> = {
  polite: '아직 서로 알아가는 사이다. 정중하고 차분한 초면의 어투로, 예의를 지키며 대화한다.',
  friendly: '어느 정도 가까워진 사이다. 친근하되 과하지 않은 어투로 대화한다.',
  comfortable: '오래 함께해 편안한 사이다. 격식을 덜어낸 편안하고 자연스러운 어투로 대화한다.',
}

function clampAffection(value: number): number {
  return Math.min(AFFECTION_MAX, Math.max(AFFECTION_MIN, value))
}

/**
 * 완료된 턴 하나를 반영한 다음 유대도를 계산한다.
 * userTurnValence는 이 턴의 마커에서 읽은 사용자 V(-1~1). 마커가 없었으면
 * null — 기본 증가만 적용한다. 스무딩된 세션 감정이 아니라 턴의 원시 V를
 * 쓴다 — "이 턴의 대화가 어땠는가"를 반영하는 값이므로.
 */
export function computeNextAffection(
  currentAffection: number,
  userTurnValence: number | null,
): number {
  const current = clampAffection(currentAffection)
  if (userTurnValence !== null && userTurnValence <= VERY_NEGATIVE_VALENCE_THRESHOLD) {
    return clampAffection(current + AFFECTION_NEGATIVE_TURN_DELTA)
  }
  const empathyBonus =
    userTurnValence !== null && userTurnValence > 0
      ? userTurnValence * AFFECTION_EMPATHY_BONUS_SCALE
      : 0
  return clampAffection(current + AFFECTION_BASE_DELTA_PER_TURN + empathyBonus)
}

/** 히스테리시스 없는 기본 구간 판정 — 세션 시작 등 이전 구간이 없을 때 쓴다 */
export function resolveToneTier(affection: number): AffectionToneTier {
  const value = clampAffection(affection)
  if (value < TONE_TIER_RANGES.polite.upper) {
    return 'polite'
  }
  if (value < TONE_TIER_RANGES.friendly.upper) {
    return 'friendly'
  }
  return 'comfortable'
}

/**
 * 구간 경계 히스테리시스: 현재 구간의 범위를 양쪽으로 margin만큼 넓혀,
 * 그 밖으로 완전히 벗어났을 때만 구간을 갈아탄다. 경계(0.3/0.7) 근처에서
 * 턴마다 어투가 왔다 갔다 하며 어색해지는 것을 막는다.
 */
export function resolveToneTierWithHysteresis(
  currentTier: AffectionToneTier,
  affection: number,
): AffectionToneTier {
  const range = TONE_TIER_RANGES[currentTier]
  const value = clampAffection(affection)
  // 양끝 모두 포함(<=) — 한쪽만 배타면 경계에서 이탈 문턱이 비대칭이 된다
  const isWithinStickyRange =
    value >= range.lower - TONE_TIER_HYSTERESIS_MARGIN &&
    value <= range.upper + TONE_TIER_HYSTERESIS_MARGIN
  if (isWithinStickyRange) {
    return currentTier
  }
  return resolveToneTier(value)
}

export function getAffectionToneInstruction(tier: AffectionToneTier): string {
  return TONE_INSTRUCTIONS[tier]
}

interface RelationshipValueRow {
  value: number
}

export interface AffectionTracker {
  /** DB의 affection 행을 읽어 초기화한다. 행이 없거나 손상이면 기본값(첫 실행) */
  load(): Promise<void>
  getAffection(): number
  getToneTier(): AffectionToneTier
  /** 현재 구간의 어투 지시 — llm 시스템 프롬프트에 주입된다 */
  getToneInstruction(): string
  /**
   * 완료된 턴 하나를 반영하고 영속한다. userTurnValence는 이 턴의 사용자 V(없으면 null).
   * 영속 실패가 대화를 막지 않는다 — 기록만 하고 메모리 값은 유지한다
   * (다음 턴의 쓰기가 최신 값을 통째로 영속하므로 일시 실패는 자기 치유된다).
   */
  recordCompletedTurn(userTurnValence: number | null): Promise<void>
  /** 현재 값을 즉시 영속한다 — 세션 종료 시 마지막 안전망(마지막 턴 쓰기 실패 보정). throw하지 않는다 */
  persist(): Promise<void>
}

const UPSERT_AFFECTION_SQL = `INSERT INTO relationship (key, value, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`

export function createAffectionTracker(database: MemoryDatabase): AffectionTracker {
  let affection: number = AFFECTION_INITIAL_VALUE
  let toneTier: AffectionToneTier = resolveToneTier(affection)

  async function load(): Promise<void> {
    try {
      const row = await database.get<RelationshipValueRow>(
        'SELECT value FROM relationship WHERE key = ?',
        [RELATIONSHIP_KEY_AFFECTION],
      )
      if (row === null || !Number.isFinite(row.value)) {
        // 첫 실행 시드가 행을 만들지만, 시드 실패·손상 값도 기본값으로 흡수한다
        affection = AFFECTION_INITIAL_VALUE
      } else {
        affection = clampAffection(row.value)
      }
    } catch (error) {
      console.error('[affection.load]: 유대도 로딩 실패 — 기본값으로 시작:', error)
      affection = AFFECTION_INITIAL_VALUE
    }
    toneTier = resolveToneTier(affection)
  }

  async function persistCurrentValue(): Promise<void> {
    try {
      await database.write(UPSERT_AFFECTION_SQL, [
        RELATIONSHIP_KEY_AFFECTION,
        affection,
        Date.now(),
      ])
    } catch (error) {
      console.error('[affection.persistCurrentValue]: 유대도 영속 실패 — 메모리 값은 유지:', error)
    }
  }

  async function recordCompletedTurn(userTurnValence: number | null): Promise<void> {
    affection = computeNextAffection(affection, userTurnValence)
    toneTier = resolveToneTierWithHysteresis(toneTier, affection)
    await persistCurrentValue()
  }

  return {
    load,
    getAffection: () => affection,
    getToneTier: () => toneTier,
    getToneInstruction: () => TONE_INSTRUCTIONS[toneTier],
    recordCompletedTurn,
    persist: persistCurrentValue,
  }
}

/**
 * 출력 스트림에서 턴 단위 회계를 수행한다 (R2 — 구독자로만 붙는다):
 * emotion(턴의 사용자 V 포착) → turn-end(반영) / turn-interrupted·error(폐기).
 * 반환된 함수로 구독을 해지한다(세션 종료 시 — DB 닫힌 뒤 쓰기 방지).
 */
export function attachAffectionToOutputStream(
  tracker: AffectionTracker,
  outputStream: OutputStream,
): Unsubscribe {
  let pendingUserValence: number | null = null
  return outputStream.subscribe((event) => {
    switch (event.type) {
      case 'turn-start':
        pendingUserValence = null
        return
      case 'emotion':
        pendingUserValence = event.vad.valence
        return
      case 'emotion-shift':
        // 표정 흐름 전용 — 유대 회계는 턴의 첫 emotion만 쓴다(구절 전환은 무시)
        return
      case 'turn-end': {
        const turnValence = pendingUserValence
        pendingUserValence = null
        if (turnValence === null) {
          // 마커 없는 턴은 기본 증가만 적용된다 — 침묵 누락이 되지 않게 흔적을 남긴다
          console.log('[affection]: 이 턴에 감정 마커 없음 — 기본 증가만 적용')
        }
        // 영속 실패는 recordCompletedTurn 내부에서 처리된다 — 구독자는 던지지 않는다
        void tracker.recordCompletedTurn(turnValence)
        return
      }
      case 'turn-interrupted':
      case 'error':
        pendingUserValence = null
        return
      case 'token':
        return
    }
  })
}
