/**
 * VAD → 사람이 읽는 한국어 해석 (자기상태 주입용)
 *
 * 감정 "추론"이 아니라 이미 추론된 수치의 표시 변환이다 — §2의
 * "룰 금지"는 추론에 대한 규칙이고, 표현 매핑은 expression/face.ts처럼 허용된다.
 * 순수 함수만 둔다. 시스템 프롬프트의 [현재 상태] 한 줄에 들어간다.
 */

import type { VadState } from './vad'

/** 이 절대값 이상이면 해당 축이 "뚜렷하다"고 본다. 체감 튜닝 대상. */
export const VAD_DESCRIPTION_THRESHOLD = 0.3
/** Dominance는 극단일 때만 언급한다 — 어투 강도 축이라 평소엔 드러내지 않음 */
export const DOMINANCE_MENTION_THRESHOLD = 0.5

type AxisLevel = 'low' | 'middle' | 'high'

function toAxisLevel(value: number): AxisLevel {
  if (value >= VAD_DESCRIPTION_THRESHOLD) {
    return 'high'
  }
  if (value <= -VAD_DESCRIPTION_THRESHOLD) {
    return 'low'
  }
  return 'middle'
}

/** A(각성)×V(쾌-불쾌) 조합별 자연스러운 한국어 구 — 조합 수가 작아 표가 가장 명확하다 */
const VAD_PHRASES: Record<AxisLevel, Record<AxisLevel, string>> = {
  // arousal high
  high: { high: '들뜨고 신나는', middle: '긴장된', low: '동요하고 불편한' },
  // arousal middle
  middle: { high: '편안하고 긍정적인', middle: '평온한', low: '조금 가라앉은' },
  // arousal low
  low: { high: '차분하고 긍정적인', middle: '차분하고 덤덤한', low: '가라앉고 우울한' },
}

/**
 * 현재 VAD를 짧은 한국어 구로 해석한다. 예: (차분하고 긍정적인)
 * D는 극단일 때만 덧붙인다: 주도적 / 위축된.
 */
export function describeVadForHumans(vad: VadState): string {
  const arousalLevel = toAxisLevel(vad.arousal)
  const valenceLevel = toAxisLevel(vad.valence)
  const basePhrase = VAD_PHRASES[arousalLevel][valenceLevel]

  if (vad.dominance >= DOMINANCE_MENTION_THRESHOLD) {
    return `${basePhrase}, 주도적인`
  }
  if (vad.dominance <= -DOMINANCE_MENTION_THRESHOLD) {
    return `${basePhrase}, 위축된`
  }
  return basePhrase
}
