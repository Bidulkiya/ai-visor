/**
 * 문서 패널 (+2 확장) — 한 패널에서 세 상태를 다룬다:
 *  - 발표 진행 중: 슬라이드·사전조사·발표 상태 (질문은 아래 메인 채팅창으로)
 *  - 문서 이해 중: 헤더(문서명·닫기) + 상태 (질문·답변은 아래 메인 채팅창으로)
 *  - 유휴: 문서 열기(이해) / 발표로 열기 / 데모 슬라이드
 *
 * ★ 입력창은 이 패널에 두지 않는다 — 사용자는 늘 쓰던 아래 메인 채팅창 하나로 문서 질문도,
 *   청중 질문도, 일반 대화도 한다(page.tsx가 모드에 따라 라우팅). 이 패널은 표시만 담당한다.
 * 컨트롤러는 본체를 호출만 하므로(R3) 이 컴포넌트는 상태 표시만 한다.
 */

'use client'

import { FolderOpen, MessageSquare, Play, Presentation, Square, X } from 'lucide-react'
import type { PresentationView } from '../presentation/controller'
import type { DocumentView } from '../presentation/documentUnderstanding'
import { DOCUMENT_TYPE_LABEL } from '../presentation/document'

const ICON_SIZE = 16
const ICON_STROKE = 1.9

interface DocumentPanelProps {
  presentationView: PresentationView
  documentView: DocumentView
  isDisabled: boolean
  isLoading: boolean
  loadNotice: string | null
  onOpenUnderstand(): void
  onOpenPresent(): void
  onStartDemo(): void
  onPresentationStop(): void
  onDocumentClose(): void
}

export function DocumentPanel({
  presentationView,
  documentView,
  isDisabled,
  isLoading,
  loadNotice,
  onOpenUnderstand,
  onOpenPresent,
  onStartDemo,
  onPresentationStop,
  onDocumentClose,
}: DocumentPanelProps) {
  const presentationStage = presentationView.stage.name
  const isPresenting =
    presentationStage === 'researching' ||
    presentationStage === 'presenting' ||
    presentationStage === 'answering'
  const isUnderstanding = documentView.stage.name !== 'idle'

  // ── 발표 진행 중 ── (청중 질문은 아래 메인 채팅창에서 입력 → presentationAsk로 라우팅)
  if (isPresenting) {
    const currentSlide =
      (presentationView.stage.name === 'presenting' || presentationView.stage.name === 'answering') &&
      presentationView.deck !== null
        ? (presentationView.deck.slides[presentationView.stage.slideNumber - 1] ?? null)
        : null
    return (
      <section className="presentation-panel" data-stage={presentationStage}>
        <div className="presentation-header">
          <span className="presentation-title">
            <Presentation size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            발표 모드 — {presentationView.deck?.sourceName ?? ''}
          </span>
          <button
            id="presentation-stop"
            className="chat-button chat-button-secondary"
            type="button"
            onClick={onPresentationStop}
          >
            <Square size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            발표 종료
          </button>
        </div>

        {presentationView.stage.name === 'researching' && (
          <p id="presentation-status" className="presentation-status">
            발표 준비 중... (슬라이드 {presentationView.stage.completedSlides}/
            {presentationView.stage.totalSlides} 조사)
          </p>
        )}

        {currentSlide !== null && presentationView.deck !== null && (
          <div id="presentation-slide" className="presentation-slide">
            <p className="presentation-slide-number">
              슬라이드 {currentSlide.number}/{presentationView.deck.slides.length}
              {presentationView.researchBySlide.has(currentSlide.number) && ' · 사전 조사 반영'}
            </p>
            <h3 className="presentation-slide-title">{currentSlide.title}</h3>
            {currentSlide.imageDataUrl !== null ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className="presentation-slide-image"
                src={currentSlide.imageDataUrl}
                alt={`슬라이드 ${currentSlide.number}: ${currentSlide.title}`}
              />
            ) : (
              currentSlide.bodyText.length > 0 && (
                <p className="presentation-slide-body">{currentSlide.bodyText}</p>
              )
            )}
          </div>
        )}

        {presentationView.stage.name === 'answering' ? (
          <p id="presentation-status" className="presentation-status presentation-status-icon">
            <MessageSquare size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            질문에 답하는 중: “{presentationView.stage.question}”
          </p>
        ) : (
          presentationView.stage.name === 'presenting' && (
            <p className="presentation-status">아래 채팅창에 청중 질문을 입력할 수 있어요.</p>
          )
        )}
      </section>
    )
  }

  // ── 문서 이해 중 ── (질문·답변은 아래 메인 채팅창에서 흐른다)
  if (isUnderstanding && documentView.document !== null) {
    const { document, stage } = documentView
    const statusText =
      stage.name === 'reading'
        ? '내용을 읽고 있어요…'
        : stage.name === 'answering'
          ? '답하는 중…'
          : '아래 채팅창에 이 문서에 대해 물어보세요. (예: "핵심이 뭐야?" "3페이지 설명해줘")'
    return (
      <section className="presentation-panel" data-stage={stage.name}>
        <div className="presentation-header">
          <span className="presentation-title">
            <FolderOpen size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            문서 이해 — {document.sourceName} ({DOCUMENT_TYPE_LABEL[document.docType]})
          </span>
          <button
            id="document-close"
            className="chat-button chat-button-secondary"
            type="button"
            onClick={onDocumentClose}
          >
            <X size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            닫기
          </button>
        </div>

        <p id="document-status" className="presentation-status">
          {statusText}
        </p>
        {documentView.notice !== null && <p className="presentation-notice">{documentView.notice}</p>}
      </section>
    )
  }

  // ── 유휴: 문서 열기 / 발표 / 데모 ──
  return (
    <section className="presentation-panel" data-stage="idle">
      {presentationView.stage.name === 'finished' && (
        <p id="presentation-status" className="presentation-status">
          발표가 끝났어요. 수고하셨습니다.
        </p>
      )}
      {presentationView.stopNotice !== null && (
        <p id="presentation-stop-notice" className="presentation-notice">
          {presentationView.stopNotice}
        </p>
      )}
      {loadNotice !== null && (
        <p id="presentation-load-notice" className="presentation-notice">
          {loadNotice}
        </p>
      )}
      <div className="presentation-start-row">
        <button
          id="document-open-understand"
          className="chat-button"
          type="button"
          disabled={isDisabled || isLoading}
          onClick={onOpenUnderstand}
        >
          <FolderOpen size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          {isLoading ? '여는 중…' : '문서 열기'}
        </button>
        <button
          id="document-open-present"
          className="chat-button chat-button-secondary"
          type="button"
          disabled={isDisabled || isLoading}
          onClick={onOpenPresent}
        >
          <Presentation size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          발표로 열기
        </button>
        <button
          id="presentation-start"
          className="chat-button chat-button-secondary"
          type="button"
          disabled={isDisabled || isLoading}
          onClick={onStartDemo}
        >
          <Play size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          데모 슬라이드
        </button>
      </div>
    </section>
  )
}
