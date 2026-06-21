/**
 * 2D 표정 캐릭터 렌더러 — expression 컨트롤러를 스트림에 붙이고,
 * rAF 루프로 매 프레임 SVG 모델(깜빡임 포함)을 그린다.
 */

'use client'

import { useEffect, useRef, useState } from 'react'
import type { OutputStream } from '../core/stream'
import { createExpressionController, type ExpressionFrame } from '../expression/controller'
import type { SpeechActivityState } from './speechActivity'

interface FaceCanvasProps {
  stream: OutputStream
  /** TTS 발성 신호(선택) — 말하는 동안 입이 벌어진다(발성 모션). 없으면 입은 VAD 표정만 따른다 */
  speechActivity?: SpeechActivityState
}

/** 창이 가려져 rAF가 멈춰도 이 주기로는 상태(감쇠 등)를 따라간다 */
const HIDDEN_FALLBACK_TICK_MS = 5000
/** 발성 모션 — 입 벌어짐 최대치(viewBox 단위). 과하지 않게(차분함 유지) */
const MOUTH_APERTURE_MAX = 5.5
/** 발성 레벨 이징 계수(프레임당) — 발성 시작/끝과 진동을 부드럽게 */
const TALK_EASE = 0.35
/** 단어 경계 펄스 지속(ms) — 음절 느낌 */
const BOUNDARY_PULSE_MS = 170

/**
 * 발성 레벨(입 벌어짐 0..1)을 한 프레임 갱신한다 — 순수 함수.
 * 말하는 동안: 기본 진동(늘 움직임) + 단어 경계 펄스(음절 팝). 평소: 0으로 이징(입 닫힘).
 * 진짜 음량이 아니라 발성 리듬 근사다(WebSpeech는 음량을 노출하지 않음). 표정 매핑과 무관.
 */
export function nextTalkLevel(
  previous: number,
  activity: SpeechActivityState | undefined,
  now: number,
  reducedMotion: boolean,
): number {
  let target = 0
  // 모션 줄이기(prefers-reduced-motion)면 발성 진동을 끈다 — 입은 VAD 표정선만 따른다.
  // 감정 반영(VAD·emotion-shift)은 기능이라 유지하고, 장식적 발성 진동만 접근성에 맞춰 끈다.
  if (activity?.speaking === true && !reducedMotion) {
    const oscillation = 0.32 + 0.28 * (0.5 + 0.5 * Math.sin(now / 75))
    const sinceBoundary = now - activity.lastBoundaryAt
    const pulse = sinceBoundary < BOUNDARY_PULSE_MS ? (1 - sinceBoundary / BOUNDARY_PULSE_MS) * 0.3 : 0
    target = Math.min(1, oscillation + pulse)
  }
  return previous + (target - previous) * TALK_EASE
}

export function FaceCanvas({ stream, speechActivity }: FaceCanvasProps) {
  const [frame, setFrame] = useState<ExpressionFrame | null>(null)
  const [displayedVad, setDisplayedVad] = useState({ valence: 0, arousal: 0 })
  // 발성 모션 — 매 프레임 이징되는 입 벌어짐(0..1). frame이 이미 매 프레임 리렌더를 일으키므로
  // 별도 setState 없이 ref로 들고, 렌더에서 읽는다(불필요한 리렌더 방지).
  const talkLevelRef = useRef(0)
  // speechActivity는 안정 객체지만, effect 재실행 없이 최신을 읽도록 ref로 감싼다
  const speechActivityRef = useRef(speechActivity)
  speechActivityRef.current = speechActivity
  // 모션 줄이기 선호 — 발성 진동을 끄는 데 쓴다(접근성). 매 프레임 matchMedia 호출을 피해 ref에 캐시.
  const reducedMotionRef = useRef(false)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    reducedMotionRef.current = query.matches
    const handleChange = (): void => {
      reducedMotionRef.current = query.matches
    }
    query.addEventListener('change', handleChange)
    return () => query.removeEventListener('change', handleChange)
  }, [])

  useEffect(() => {
    const controller = createExpressionController()
    const unsubscribeController = controller.attachToStream(stream)

    const renderOnce = (now: number): void => {
      setFrame(controller.nextFrame(now))
      const vad = controller.getDisplayedVad()
      setDisplayedVad({ valence: vad.valence, arousal: vad.arousal })
      // 발성 모션 갱신 — rAF가 매 프레임 불러 부드럽게 진동한다(표정 매핑과 독립).
      // 모션 줄이기면 진동을 끈다(접근성).
      talkLevelRef.current = nextTalkLevel(
        talkLevelRef.current,
        speechActivityRef.current,
        now,
        reducedMotionRef.current,
      )
    }

    // rAF는 창이 가려지면 멈춘다(backgroundThrottling) — 상태 전환(생각 중·감정·
    // 중립 복귀)은 스트림 이벤트에서 즉시, 유휴 감쇠는 저빈도 틱으로도 따라가
    // 가시성과 무관하게 상태가 일관되게 유지된다. 깜빡임만 rAF 전담.
    renderOnce(performance.now())
    const unsubscribeEvents = stream.subscribe(() => {
      renderOnce(performance.now())
    })
    const fallbackTickId = setInterval(() => {
      renderOnce(performance.now())
    }, HIDDEN_FALLBACK_TICK_MS)

    let animationFrameId = 0
    const renderLoop = (now: number): void => {
      renderOnce(now)
      animationFrameId = requestAnimationFrame(renderLoop)
    }
    animationFrameId = requestAnimationFrame(renderLoop)

    return () => {
      cancelAnimationFrame(animationFrameId)
      clearInterval(fallbackTickId)
      unsubscribeEvents()
      unsubscribeController()
    }
  }, [stream])

  if (frame === null) {
    return <div className="face-panel" />
  }

  const { svg, mode } = frame
  // 캐치라이트 가시성 — 눈 크기(A·blink가 정한 모델값 ry)에 따라. 감으면 자연히 사라진다.
  // 표정 매핑은 손대지 않는다: 모델이 준 ry를 "그리는 방식"에만 쓴다.
  const eyeOpenFactor = Math.min(1, svg.leftEye.radiusY / 6)
  const catchlightOffsetY = roundToHundredth(svg.leftEye.radiusY * 0.4)
  // 발성 모션 — 말할 때 입 벌어짐(0이면 닫힘=평소 표정). VAD 입꼬리(곡률)는 그대로 둔다.
  const mouthApertureRy = roundToHundredth(talkLevelRef.current * MOUTH_APERTURE_MAX)
  return (
    <div className="face-panel">
      <svg
        className="face-svg"
        viewBox={`0 0 ${svg.viewBoxSize} ${svg.viewBoxSize}`}
        role="img"
        aria-label="동반자 표정"
      >
        <defs>
          {/* 얼굴 디스크 — 위쪽 광원으로 부드러운 구체감 */}
          <radialGradient id="noa-disc" cx="42%" cy="34%" r="78%">
            <stop offset="0%" stopColor="var(--face-disc-hi)" />
            <stop offset="58%" stopColor="var(--face-disc-mid)" />
            <stop offset="100%" stopColor="var(--face-disc-lo)" />
          </radialGradient>
          {/* 은은한 아우라 — 다크 배경에서 face가 떠 보이게 */}
          <radialGradient id="noa-halo" cx="50%" cy="50%" r="50%">
            <stop offset="52%" stopColor="var(--face-halo)" />
            <stop offset="100%" stopColor="transparent" />
          </radialGradient>
          {/* 눈 — 위가 밝은 부드러운 표면 */}
          <radialGradient id="noa-eye" cx="42%" cy="30%" r="82%">
            <stop offset="0%" stopColor="var(--face-eye-hi)" />
            <stop offset="100%" stopColor="var(--face-eye-lo)" />
          </radialGradient>
          {/* 눈썹·입 — 위에서 아래로 미묘한 그라데이션(또렷하되 평면적이지 않게).
              userSpaceOnUse(절대 좌표): 평온 시 입은 높이 0인 가로선이라, 기본 objectBoundingBox로는
              bbox 높이 0 → 'none'으로 렌더돼 입이 사라진다(SVG 명세). 절대 y축 그라데이션이면
              bbox와 무관하게 칠해져 일자 입도 보인다. 눈썹·입 모두 같은 위→아래 광원으로 일관. */}
          <linearGradient id="noa-feature" x1="0" y1="28" x2="0" y2="72" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="var(--face-feature-hi)" />
            <stop offset="100%" stopColor="var(--face-feature-lo)" />
          </linearGradient>
        </defs>

        {/* 정적 요소(아우라·디스크·림) — 매 프레임 동일 props라 브라우저가 재계산하지 않는다.
            색(그라데이션 fill/stroke)은 globals.css의 .face-* 규칙으로 — 동적 좌표만 여기 인라인 */}
        <circle className="face-halo" cx="50" cy="51" r="49" />
        <circle className="face-disc" cx="50" cy="50" r="45.5" />
        <circle className="face-rim" cx="50" cy="50" r="45.5" />

        <ellipse
          className="face-eye"
          cx={svg.leftEye.centerX}
          cy={svg.leftEye.centerY}
          rx={svg.leftEye.radiusX}
          ry={svg.leftEye.radiusY}
        />
        <ellipse
          className="face-eye"
          cx={svg.rightEye.centerX}
          cy={svg.rightEye.centerY}
          rx={svg.rightEye.radiusX}
          ry={svg.rightEye.radiusY}
        />
        {/* 캐치라이트 — "살아있는" 눈빛. blink/각성에 따라 가시성이 변한다(필터 없이 가볍게) */}
        <circle
          className="face-catchlight"
          cx={roundToHundredth(svg.leftEye.centerX - 2.1)}
          cy={roundToHundredth(svg.leftEye.centerY - catchlightOffsetY)}
          r="1.5"
          opacity={eyeOpenFactor}
        />
        <circle
          className="face-catchlight"
          cx={roundToHundredth(svg.rightEye.centerX - 2.1)}
          cy={roundToHundredth(svg.rightEye.centerY - catchlightOffsetY)}
          r="1.5"
          opacity={eyeOpenFactor}
        />

        <path className="face-line" d={svg.leftEyebrowPath} />
        <path className="face-line" d={svg.rightEyebrowPath} />
        {/* 발성 모션 — 말할 때 벌어지는 입 안(솔리드 다크). ry=0이면 보이지 않아 평소엔 일자 입.
            입꼬리 곡률(V)은 아래 입선이 그대로 담당 — 벌어짐만 발성에 반응(요구: 둘 공존) */}
        <ellipse
          className="face-mouth-cavity"
          cx="50"
          cy={roundToHundredth(68 + mouthApertureRy * 0.35)}
          rx="9"
          ry={mouthApertureRy}
        />
        <path className="face-line" d={svg.mouthPath} />
      </svg>
      <p id="face-status" className="face-status" data-mode={mode}>
        {mode === 'thinking' ? '생각 중…' : '듣고 있어'} · V {displayedVad.valence.toFixed(2)} · A{' '}
        {displayedVad.arousal.toFixed(2)}
      </p>
    </div>
  )
}

/** 좌표 소수 정리 — SVG 속성이 매 프레임 미세 변동으로 흔들리지 않게 */
function roundToHundredth(value: number): number {
  return Math.round(value * 100) / 100
}
