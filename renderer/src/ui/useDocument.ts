/**
 * 문서 워크스페이스 배선 훅 — ui와 presentation 레이어의 접점.
 *
 * 발표 컨트롤러와 문서 이해 컨트롤러를 함께 소유하고, 문서 로딩을 한 곳에서 다룬다.
 * 두 컨트롤러는 본체를 호출만 하므로(R3) 여기서는 생성·정리·모드 전환만 한다.
 * 한 번에 한 모드만 — 발표를 열면 이해를 닫고, 이해를 열면 발표를 멈춘다(충돌 방지).
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
import {
  createDocumentUnderstanding,
  type DocumentAskResult,
  type DocumentUnderstanding,
  type DocumentView,
} from '../presentation/documentUnderstanding'
import { documentToSlideDeck } from '../presentation/document'
import type { SlideDeck } from '../presentation/slides'
import { pickAndLoadDocument } from '../presentation/sidecarDocument'

const IDLE_PRESENTATION: PresentationView = {
  stage: { name: 'idle' },
  deck: null,
  researchBySlide: new Map(),
  stopNotice: null,
}
const IDLE_DOCUMENT: DocumentView = { stage: { name: 'idle' }, document: null, notice: null }

export interface DocumentHookView {
  presentationView: PresentationView
  documentView: DocumentView
  isAvailable: boolean
  /** 파일 선택·추출이 진행 중 — 버튼 비활성용 */
  isLoading: boolean
  /** 로딩 안내(미지원·렌더 폴백·실패 사유). 없으면 null */
  loadNotice: string | null
  /** 문서를 열어 이해(요약·질문답변) 모드로 — 사이드카 필요 */
  openForUnderstanding(): Promise<void>
  /** 문서를 열어 발표 모드로 — 사이드카 불가 시 demoFallback */
  openForPresentation(demoFallback: SlideDeck): Promise<void>
  /** 데모 슬라이드로 발표 시작(사이드카 없이도 동작) */
  startDemo(deck: SlideDeck): void
  presentationAsk(questionText: string): Promise<AskQuestionResult>
  presentationStop(): void
  documentAsk(questionText: string): Promise<DocumentAskResult>
  documentClose(): void
}

export function useDocument(
  session: CompanionSession | null,
  toolRuntime: ToolRuntime | null,
): DocumentHookView {
  const presentationRef = useRef<PresentationController | null>(null)
  const understandingRef = useRef<DocumentUnderstanding | null>(null)
  const [presentationView, setPresentationView] = useState<PresentationView>(IDLE_PRESENTATION)
  const [documentView, setDocumentView] = useState<DocumentView>(IDLE_DOCUMENT)
  const [isLoading, setIsLoading] = useState(false)
  const [loadNotice, setLoadNotice] = useState<string | null>(null)

  useEffect(() => {
    if (session === null) {
      return
    }
    const presentation = createPresentationController({ session, toolRuntime })
    const understanding = createDocumentUnderstanding({ session, toolRuntime })
    presentationRef.current = presentation
    understandingRef.current = understanding
    setPresentationView(presentation.getView())
    setDocumentView(understanding.getView())
    const unsubscribePresentation = presentation.subscribe(setPresentationView)
    const unsubscribeUnderstanding = understanding.subscribe(setDocumentView)
    return () => {
      unsubscribePresentation()
      unsubscribeUnderstanding()
      presentation.stopPresentation()
      understanding.close()
      presentationRef.current = null
      understandingRef.current = null
      setPresentationView(IDLE_PRESENTATION)
      setDocumentView(IDLE_DOCUMENT)
    }
  }, [session, toolRuntime])

  /** 파일 선택 + 추출. 동시 중복은 isLoading으로 막는다. cancelled면 null */
  const loadDocument = useCallback(async (): Promise<
    Awaited<ReturnType<typeof pickAndLoadDocument>> | null
  > => {
    if (isLoading) {
      return null
    }
    setIsLoading(true)
    setLoadNotice(null)
    try {
      return await pickAndLoadDocument()
    } finally {
      setIsLoading(false)
    }
  }, [isLoading])

  const openForUnderstanding = useCallback(async (): Promise<void> => {
    presentationRef.current?.stopPresentation() // 한 번에 한 모드
    const result = await loadDocument()
    if (result === null || result.status === 'cancelled') {
      return
    }
    if (result.status === 'loaded') {
      if (result.renderNotice !== null) {
        setLoadNotice(result.renderNotice)
      }
      void understandingRef.current?.openDocument(result.document)
      return
    }
    // 이해 모드는 사이드카가 있어야 한다(데모 폴백 없음) — 사유만 안내
    setLoadNotice(result.message)
  }, [loadDocument])

  const openForPresentation = useCallback(
    async (demoFallback: SlideDeck): Promise<void> => {
      understandingRef.current?.close() // 한 번에 한 모드
      const result = await loadDocument()
      if (result === null || result.status === 'cancelled') {
        return
      }
      switch (result.status) {
        case 'loaded':
          if (result.renderNotice !== null) {
            setLoadNotice(result.renderNotice)
          }
          void presentationRef.current?.startPresentation(documentToSlideDeck(result.document))
          return
        case 'unavailable':
          setLoadNotice(`${result.message} (데모 슬라이드로 진행합니다.)`)
          void presentationRef.current?.startPresentation(demoFallback)
          return
        case 'failed':
          setLoadNotice(result.message)
          return
      }
    },
    [loadDocument],
  )

  const startDemo = useCallback((deck: SlideDeck): void => {
    understandingRef.current?.close()
    setLoadNotice(null)
    void presentationRef.current?.startPresentation(deck)
  }, [])

  const presentationAsk = useCallback(async (questionText: string): Promise<AskQuestionResult> => {
    const controller = presentationRef.current
    if (controller === null) {
      return 'not-presenting'
    }
    return controller.askQuestion(questionText)
  }, [])

  const presentationStop = useCallback((): void => {
    presentationRef.current?.stopPresentation()
  }, [])

  const documentAsk = useCallback(async (questionText: string): Promise<DocumentAskResult> => {
    const controller = understandingRef.current
    if (controller === null) {
      return 'no-document'
    }
    return controller.ask(questionText)
  }, [])

  const documentClose = useCallback((): void => {
    understandingRef.current?.close()
  }, [])

  return {
    presentationView,
    documentView,
    isAvailable: session !== null,
    isLoading,
    loadNotice,
    openForUnderstanding,
    openForPresentation,
    startDemo,
    presentationAsk,
    presentationStop,
    documentAsk,
    documentClose,
  }
}
