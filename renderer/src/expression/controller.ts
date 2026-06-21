/**
 * 표정 컨트롤러 — 출력 스트림 구독자 (CLAUDE.md R2, ARCHITECTURE §2)
 *
 * core의 함수를 호출하지 않는다. 본체와의 유일한 접점은 스트림 구독이다.
 * - turn-start → 즉시 "생각 중" 표정 (반응 0초 연출로 물리 지연을 가린다, 기획서 §7)
 * - emotion → 표시용 VAD 갱신(스무딩 — 표정이 갑자기 튀지 않게)
 * - turn-interrupted → 끼어들기 명시적 리셋: 즉시 중립 복귀
 * D축은 어투에 매핑되므로 여기서는 V·A만 표정에 쓴다 (CLAUDE.md §2).
 *
 * 시계(now)는 호출자가 프레임마다 넘긴다 — 일관된 ms 시계면 충분하다.
 */

import type { OutputEvent, OutputStream, Unsubscribe } from '../core/stream'
import { smoothVad } from '../emotion/smoothing'
import { decayVadTowardNeutral } from '../emotion/decay'
import { NEUTRAL_VAD, type VadState } from '../emotion/vad'
import {
  buildFaceSvgModel,
  computeFaceGeometry,
  THINKING_FACE_GEOMETRY,
  type FaceGeometry,
  type FaceSvgModel,
} from './face'
import {
  advanceBlink,
  createInitialBlinkState,
  eyeOpennessFactor,
  type BlinkState,
  type RandomSource,
} from './blink'

export type ExpressionMode = 'idle' | 'thinking'

export interface ExpressionFrame {
  mode: ExpressionMode
  geometry: FaceGeometry
  svg: FaceSvgModel
}

export interface ExpressionController {
  /** 스트림 구독 시작 — 반환된 함수로 해지 */
  attachToStream(stream: OutputStream): Unsubscribe
  /** 렌더 루프가 매 프레임 호출 — 깜빡임을 진행시키고 현재 표정을 돌려준다 */
  nextFrame(now: number): ExpressionFrame
  getMode(): ExpressionMode
  getDisplayedVad(): VadState
  /** 앱 시작 시 영속된 감정을 이어받을 때 사용 */
  setDisplayedVad(vad: VadState): void
}

export interface ExpressionControllerOptions {
  /** 깜빡임 간격용 난수원 — 테스트에서 결정적으로 주입 */
  random?: RandomSource
}

interface ExpressionState {
  mode: ExpressionMode
  displayedVad: VadState
  /** 턴 진행 중에는 유휴 감쇠를 멈춘다 (CLAUDE.md §2 감쇠 = 대화 없는 동안) */
  isTurnActive: boolean
}

/** 스트림 이벤트 → 다음 표정 상태. 순수 전이 함수 — 단독 테스트 가능 */
export function transitionOnEvent(state: ExpressionState, event: OutputEvent): ExpressionState {
  switch (event.type) {
    case 'turn-start':
      // 즉시 전환 — emotion 도착 전까지의 공백을 연출로 메운다
      return { ...state, mode: 'thinking', isTurnActive: true }
    case 'emotion':
      return {
        mode: 'idle',
        displayedVad: smoothVad(state.displayedVad, event.vad),
        isTurnActive: state.isTurnActive,
      }
    case 'emotion-shift':
      // 답변 중 구절별 감정 전환 — 기존 emotion과 같은 스무딩 경로로 표정만 흐르게 한다.
      // 매핑(smoothVad·computeFaceGeometry)은 그대로, 입력(VAD)만 여러 번 들어올 뿐이다.
      return { ...state, displayedVad: smoothVad(state.displayedVad, event.vad) }
    case 'token':
      // 마커 없이 답변이 시작된 턴도 "생각 중"을 끝낸다
      return { ...state, mode: 'idle' }
    case 'turn-interrupted':
      return { mode: 'idle', displayedVad: NEUTRAL_VAD, isTurnActive: false }
    case 'turn-end':
    case 'error':
      return { ...state, mode: 'idle', isTurnActive: false }
  }
}

export function createExpressionController(
  options: ExpressionControllerOptions = {},
): ExpressionController {
  const random = options.random ?? Math.random
  let state: ExpressionState = { mode: 'idle', displayedVad: NEUTRAL_VAD, isTurnActive: false }
  let blinkState: BlinkState | null = null
  let lastFrameAt: number | null = null

  function nextFrame(now: number): ExpressionFrame {
    blinkState =
      blinkState === null ? createInitialBlinkState(now, random) : advanceBlink(blinkState, now, random)

    // 유휴 감쇠 — 대화 중이 아닐 때만 프레임 경과만큼 중립으로 끌어당긴다.
    // 창이 가려져 rAF가 멈췄다 재개해도 elapsed가 실제 유휴 시간이라 그대로 옳다.
    const elapsedMs = lastFrameAt === null ? 0 : now - lastFrameAt
    lastFrameAt = now
    if (!state.isTurnActive && elapsedMs > 0) {
      state = { ...state, displayedVad: decayVadTowardNeutral(state.displayedVad, elapsedMs) }
    }

    const geometry =
      state.mode === 'thinking' ? THINKING_FACE_GEOMETRY : computeFaceGeometry(state.displayedVad)
    return {
      mode: state.mode,
      geometry,
      svg: buildFaceSvgModel(geometry, eyeOpennessFactor(blinkState, now)),
    }
  }

  return {
    attachToStream: (stream: OutputStream): Unsubscribe =>
      stream.subscribe((event) => {
        state = transitionOnEvent(state, event)
      }),
    nextFrame,
    getMode: (): ExpressionMode => state.mode,
    getDisplayedVad: (): VadState => state.displayedVad,
    setDisplayedVad: (vad: VadState): void => {
      state = { ...state, displayedVad: vad }
    },
  }
}
