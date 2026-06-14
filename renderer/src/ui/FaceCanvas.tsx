/**
 * 2D 표정 캐릭터 렌더러 — expression 컨트롤러를 스트림에 붙이고,
 * rAF 루프로 매 프레임 SVG 모델(깜빡임 포함)을 그린다.
 */

'use client'

import { useEffect, useState } from 'react'
import type { OutputStream } from '../core/stream'
import { createExpressionController, type ExpressionFrame } from '../expression/controller'

interface FaceCanvasProps {
  stream: OutputStream
}

/** 창이 가려져 rAF가 멈춰도 이 주기로는 상태(감쇠 등)를 따라간다 */
const HIDDEN_FALLBACK_TICK_MS = 5000

export function FaceCanvas({ stream }: FaceCanvasProps) {
  const [frame, setFrame] = useState<ExpressionFrame | null>(null)
  const [displayedVad, setDisplayedVad] = useState({ valence: 0, arousal: 0 })

  useEffect(() => {
    const controller = createExpressionController()
    const unsubscribeController = controller.attachToStream(stream)

    const renderOnce = (now: number): void => {
      setFrame(controller.nextFrame(now))
      const vad = controller.getDisplayedVad()
      setDisplayedVad({ valence: vad.valence, arousal: vad.arousal })
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
  return (
    <div className="face-panel">
      <svg
        className="face-svg"
        viewBox={`0 0 ${svg.viewBoxSize} ${svg.viewBoxSize}`}
        role="img"
        aria-label="동반자 표정"
      >
        <circle className="face-outline" cx="50" cy="50" r="46" />
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
        <path className="face-line" d={svg.leftEyebrowPath} />
        <path className="face-line" d={svg.rightEyebrowPath} />
        <path className="face-line" d={svg.mouthPath} />
      </svg>
      <p id="face-status" className="face-status" data-mode={mode}>
        {mode === 'thinking' ? '생각 중…' : '듣고 있어'} · V {displayedVad.valence.toFixed(2)} · A{' '}
        {displayedVad.arousal.toFixed(2)}
      </p>
    </div>
  )
}
