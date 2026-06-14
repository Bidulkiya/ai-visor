/**
 * 2D 표정 매핑 — V·A 2축 → 도형 파라미터 (기획서 §3.4)
 *
 * - V·A만 사용한다. D(주도-위축)는 어투에 매핑되므로 표정에 쓰지 않는다 (CLAUDE.md §2).
 * - 이산 표정 교체가 아니다 — VAD 연속값이 입꼬리·눈썹·눈 크기 수식에 직접 매핑된다.
 * - SVG 도형(타원 + 이차 베지어) 기반, 외부 에셋 없음. 순수 함수만 둔다.
 */

import type { VadState } from '../emotion/vad'

// ── 감정 → 기하 매핑 계수 (체감 튜닝 대상) ──
/** 입꼬리: V가 방향을 정하고, 각성이 높을수록 표현 폭이 커진다 */
const MOUTH_BASE_GAIN = 0.5
const MOUTH_AROUSAL_GAIN = 0.5
/** 눈썹: V 방향(올림/찌푸림)에 각성이 강도를 싣고, A 단독으로도 살짝 들린다(놀람) */
const EYEBROW_VALENCE_WEIGHT = 0.7
const EYEBROW_AROUSAL_WEIGHT = 0.3
/** 눈: 각성=크게, 이완=가늘게 */
const EYE_OPENNESS_NEUTRAL = 1
const EYE_OPENNESS_AROUSAL_GAIN = 0.35

const AXIS_MIN = -1
const AXIS_MAX = 1

export interface FaceGeometry {
  /** 입꼬리 곡률: -1(처짐) ~ +1(올라감) */
  mouthCurvature: number
  /** 눈썹 높이: -1(찌푸림) ~ +1(치켜올림) */
  eyebrowHeight: number
  /** 눈 크기 배율 (중립 1) */
  eyeOpenness: number
}

/** "생각 중" 연출 프리셋 — turn-start 즉시 전환해 물리 지연을 가린다 (기획서 §7) */
export const THINKING_FACE_GEOMETRY: FaceGeometry = {
  mouthCurvature: 0,
  eyebrowHeight: 0.35,
  eyeOpenness: 0.85,
}

/** 손상 값(NaN/Infinity)은 중립 0으로, 범위 밖은 [-1,1]로 클램프 */
function normalizeAxis(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.min(AXIS_MAX, Math.max(AXIS_MIN, value))
}

/**
 * V·A → 표정 기하. 모든 출력이 입력에 대해 연속이다.
 * - 차분한 기쁨(V+, A-)은 옅은 미소, 들뜬 기쁨(V+, A+)은 활짝 웃음
 * - 분노(V-, A+)는 깊은 찌푸림, 슬픔(V-, A-)은 처진 눈썹·입꼬리
 */
export function computeFaceGeometry(vad: VadState): FaceGeometry {
  const valence = normalizeAxis(vad.valence)
  const arousal = normalizeAxis(vad.arousal)
  /** 각성을 0~1 강도 계수로 */
  const arousalIntensity = (arousal + 1) / 2

  return {
    mouthCurvature: valence * (MOUTH_BASE_GAIN + MOUTH_AROUSAL_GAIN * arousalIntensity),
    eyebrowHeight: normalizeAxis(
      EYEBROW_VALENCE_WEIGHT * valence * arousalIntensity + EYEBROW_AROUSAL_WEIGHT * arousal,
    ),
    eyeOpenness: EYE_OPENNESS_NEUTRAL + EYE_OPENNESS_AROUSAL_GAIN * arousal,
  }
}

// ── SVG 좌표계 (viewBox 0 0 100 100 기준) ──
const FACE_VIEW_BOX_SIZE = 100
const EYE_CENTER_Y = 42
const EYE_OFFSET_X = 18
const EYE_RADIUS_X = 7
const EYE_RADIUS_Y_BASE = 8
const EYEBROW_BASE_Y = 30
/** eyebrowHeight +1 → 6px 위로 (SVG y축은 아래가 양수) */
const EYEBROW_MAX_LIFT = 6
const EYEBROW_HALF_WIDTH = 9
const EYEBROW_NATURAL_ARC = 2
const MOUTH_CENTER_Y = 68
const MOUTH_HALF_WIDTH = 16
/** mouthCurvature ±1 → 베지어 제어점 ±14px (U=웃음, ∩=찌푸림) */
const MOUTH_MAX_CURVE_DEPTH = 14

export interface EllipseShape {
  centerX: number
  centerY: number
  radiusX: number
  radiusY: number
}

export interface FaceSvgModel {
  viewBoxSize: number
  leftEye: EllipseShape
  rightEye: EllipseShape
  leftEyebrowPath: string
  rightEyebrowPath: string
  mouthPath: string
}

function roundCoordinate(value: number): number {
  return Math.round(value * 100) / 100
}

function buildEyebrowPath(eyeCenterX: number, eyebrowHeight: number): string {
  const eyebrowY = roundCoordinate(EYEBROW_BASE_Y - eyebrowHeight * EYEBROW_MAX_LIFT)
  const startX = roundCoordinate(eyeCenterX - EYEBROW_HALF_WIDTH)
  const endX = roundCoordinate(eyeCenterX + EYEBROW_HALF_WIDTH)
  const arcPeakY = roundCoordinate(eyebrowY - EYEBROW_NATURAL_ARC)
  return `M ${startX} ${eyebrowY} Q ${eyeCenterX} ${arcPeakY} ${endX} ${eyebrowY}`
}

/**
 * 기하 파라미터 → 그릴 수 있는 SVG 모델.
 * eyeBlinkFactor(0=감음, 1=뜸)는 blink 모듈이 계산해 곱한다.
 */
export function buildFaceSvgModel(geometry: FaceGeometry, eyeBlinkFactor: number = 1): FaceSvgModel {
  const faceCenterX = FACE_VIEW_BOX_SIZE / 2
  const appliedBlinkFactor = Math.min(1, Math.max(0, eyeBlinkFactor))
  const eyeRadiusY = roundCoordinate(
    Math.max(0, EYE_RADIUS_Y_BASE * geometry.eyeOpenness * appliedBlinkFactor),
  )

  const leftEyeCenterX = faceCenterX - EYE_OFFSET_X
  const rightEyeCenterX = faceCenterX + EYE_OFFSET_X
  const buildEye = (centerX: number): EllipseShape => ({
    centerX,
    centerY: EYE_CENTER_Y,
    radiusX: EYE_RADIUS_X,
    radiusY: eyeRadiusY,
  })

  // 웃음(곡률+)은 U자(제어점 아래), 찌푸림(곡률-)은 ∩자(제어점 위)
  const mouthStartX = roundCoordinate(faceCenterX - MOUTH_HALF_WIDTH)
  const mouthEndX = roundCoordinate(faceCenterX + MOUTH_HALF_WIDTH)
  const mouthControlY = roundCoordinate(MOUTH_CENTER_Y + geometry.mouthCurvature * MOUTH_MAX_CURVE_DEPTH)
  const mouthPath = `M ${mouthStartX} ${MOUTH_CENTER_Y} Q ${faceCenterX} ${mouthControlY} ${mouthEndX} ${MOUTH_CENTER_Y}`

  return {
    viewBoxSize: FACE_VIEW_BOX_SIZE,
    leftEye: buildEye(leftEyeCenterX),
    rightEye: buildEye(rightEyeCenterX),
    leftEyebrowPath: buildEyebrowPath(leftEyeCenterX, geometry.eyebrowHeight),
    rightEyebrowPath: buildEyebrowPath(rightEyeCenterX, geometry.eyebrowHeight),
    mouthPath,
  }
}
