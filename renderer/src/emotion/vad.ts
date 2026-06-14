/**
 * VAD 3축 감정 모델 + 마커 파싱 (기획서 §3)
 *
 * - 세 값 모두 LLM이 직접 추론한다. 룰/하드코딩 금지 (CLAUDE.md §2).
 * - 감정 추론은 답변 생성과 같은 LLM 호출에서, 마커가 답변보다 먼저 출력된다.
 *   예: `<vad>-0.6,0.7,0.3</vad> 무슨 일 있었어?`
 * - 이 모듈은 순수 함수만 둔다 — 상태(현재 VAD)는 호출자가 들고 있다.
 */

export interface VadState {
  /** Valence: 불쾌(-1) ~ 쾌(+1) */
  valence: number
  /** Arousal: 이완(-1) ~ 각성(+1) */
  arousal: number
  /** Dominance: 위축(-1) ~ 주도(+1) */
  dominance: number
}

/** 첫 실행·감쇠 수렴점 — 중립 상태 (기획서 §5.3) */
export const NEUTRAL_VAD: VadState = { valence: 0, arousal: 0, dominance: 0 }

// 마커 형식의 단일 출처 — 스트리밍 스캐너(core/llm.ts)가 여기서 import해 쓴다
export const VAD_MARKER_OPEN = '<vad>'
export const VAD_MARKER_CLOSE = '</vad>'
/** `<vad>` 뒤로 이 길이를 넘도록 닫는 태그가 없으면 마커가 아닌 본문으로 판정한다 */
export const MAX_MARKER_SCAN_LENGTH = 48

const VAD_AXIS_COUNT = 3
const VAD_AXIS_MIN = -1
const VAD_AXIS_MAX = 1

function clampVadAxis(value: number): number {
  return Math.min(VAD_AXIS_MAX, Math.max(VAD_AXIS_MIN, value))
}

/** `V,A,D` 본문을 파싱한다. 형식이 깨졌으면 null (본문은 계속 흘러야 하므로 throw 금지) */
export function parseVadBody(markerBody: string): VadState | null {
  return parseVadValues(markerBody)
}

function parseVadValues(markerBody: string): VadState | null {
  const parts = markerBody.split(',')
  if (parts.length !== VAD_AXIS_COUNT) {
    return null
  }
  const numbers = parts.map((part) => Number(part.trim()))
  if (numbers.some((value) => !Number.isFinite(value))) {
    return null
  }
  return {
    valence: clampVadAxis(numbers[0]),
    arousal: clampVadAxis(numbers[1]),
    dominance: clampVadAxis(numbers[2]),
  }
}

