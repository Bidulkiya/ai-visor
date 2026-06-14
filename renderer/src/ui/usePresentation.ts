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
import { pickAndLoadDeck } from '../presentation/sidecarDeck'

const IDLE_VIEW: PresentationView = {
  stage: { name: 'idle' },
  deck: null,
  researchBySlide: new Map(),
  stopNotice: null,
}

export interface PresentationHookView {
  view: PresentationView
  isAvailable: boolean
  /** PPTX 선택·추출이 진행 중 — 버튼 비활성용 */
  isLoadingDeck: boolean
  /** 덱 로딩 안내(렌더 폴백·데모 폴백·실패 사유). 없으면 null */
  loadNotice: string | null
  start(deck: SlideDeck): void
  /** PPTX 파일 선택 → 추출 → 발표 시작. 사이드카 불가 시 demoFallback으로 진행 */
  openPptx(demoFallback: SlideDeck): Promise<void>
  askQuestion(questionText: string): Promise<AskQuestionResult>
  stop(): void
}

export function usePresentation(
  session: CompanionSession | null,
  toolRuntime: ToolRuntime | null,
): PresentationHookView {
  const controllerRef = useRef<PresentationController | null>(null)
  const [view, setView] = useState<PresentationView>(IDLE_VIEW)
  const [isLoadingDeck, setIsLoadingDeck] = useState(false)
  const [loadNotice, setLoadNotice] = useState<string | null>(null)

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
    setLoadNotice(null)
    void controllerRef.current?.startPresentation(deck)
  }, [])

  /**
   * PPTX 파일 선택 → 사이드카 추출 → 정규화 → 발표 시작.
   * 사이드카(Python)가 없으면 demoFallback으로 진행하고 안내를 남긴다(발표 중단 없음).
   * 동시 중복 실행은 isLoadingDeck로 막는다.
   */
  const openPptx = useCallback(async (demoFallback: SlideDeck): Promise<void> => {
    if (isLoadingDeck) {
      return
    }
    setIsLoadingDeck(true)
    setLoadNotice(null)
    try {
      const result = await pickAndLoadDeck()
      switch (result.status) {
        case 'cancelled':
          return
        case 'loaded':
          if (result.renderNotice !== null) {
            setLoadNotice(result.renderNotice)
          }
          void controllerRef.current?.startPresentation(result.deck)
          return
        case 'unavailable':
          setLoadNotice(`${result.message} (데모 슬라이드로 진행합니다.)`)
          void controllerRef.current?.startPresentation(demoFallback)
          return
        case 'failed':
          setLoadNotice(result.message)
          return
      }
    } finally {
      setIsLoadingDeck(false)
    }
  }, [isLoadingDeck])

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

  return { view, isAvailable: session !== null, isLoadingDeck, loadNotice, start, openPptx, askQuestion, stop }
}
