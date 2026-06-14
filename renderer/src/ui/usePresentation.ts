/**
 * 발표 컨트롤러 배선 훅 — ui와 presentation 레이어의 접점.
 *
 * 세션이 연결되면 컨트롤러를 만들고 상태 구독을 React 상태로 미러링한다.
 * 컨트롤러는 본체를 호출만 하므로(R3) 여기서는 생성·정리와 콜백 노출만 한다.
 */

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CompanionSession, ToolRuntime } from '../core/session'
import {
  createPresentationController,
  type AskQuestionResult,
  type PresentationController,
  type PresentationView,
} from '../presentation/controller'
import type { SlideDeck } from '../presentation/slides'

const IDLE_VIEW: PresentationView = {
  stage: { name: 'idle' },
  deck: null,
  researchBySlide: new Map(),
  stopNotice: null,
}

export interface PresentationHookView {
  view: PresentationView
  isAvailable: boolean
  start(deck: SlideDeck): void
  askQuestion(questionText: string): Promise<AskQuestionResult>
  stop(): void
}

export function usePresentation(
  session: CompanionSession | null,
  toolRuntime: ToolRuntime | null,
): PresentationHookView {
  const controllerRef = useRef<PresentationController | null>(null)
  const [view, setView] = useState<PresentationView>(IDLE_VIEW)

  useEffect(() => {
    if (session === null) {
      return
    }
    const controller = createPresentationController({ session, toolRuntime })
    controllerRef.current = controller
    setView(controller.getView())
    const unsubscribe = controller.subscribe(setView)
    return () => {
      unsubscribe()
      controller.stopPresentation()
      controllerRef.current = null
      setView(IDLE_VIEW)
    }
  }, [session, toolRuntime])

  const start = useCallback((deck: SlideDeck): void => {
    void controllerRef.current?.startPresentation(deck)
  }, [])

  const askQuestion = useCallback(async (questionText: string): Promise<AskQuestionResult> => {
    const controller = controllerRef.current
    if (controller === null) {
      return 'not-presenting'
    }
    return controller.askQuestion(questionText)
  }, [])

  const stop = useCallback((): void => {
    controllerRef.current?.stopPresentation()
  }, [])

  return { view, isAvailable: session !== null, start, askQuestion, stop }
}
