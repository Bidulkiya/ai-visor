/**
 * 발표 패널 (+2 ⑤) — 발표 진입/종료, 현재 슬라이드 표시,
 * 사전 조사 진행 표시, 푸시투토크 질문(스페이스바 또는 화면 버튼).
 *
 * 스페이스바는 입력창에 타이핑 중이 아닐 때만 질문 입력으로 포커스를 옮긴다.
 * 음성 질문은 STT 변환기(사이드카 Whisper)가 붙으면 같은 askQuestion 경로를 탄다.
 */

'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { PresentationView } from '../presentation/controller'
import type { AskQuestionResult } from '../presentation/controller'

interface PresentationPanelProps {
  view: PresentationView
  isDisabled: boolean
  onStart(): void
  onStop(): void
  onAskQuestion(questionText: string): Promise<AskQuestionResult>
}

const ASK_RESULT_NOTICES: Record<Exclude<AskQuestionResult, 'accepted'>, string> = {
  'empty-question': '질문 내용을 입력해 주세요.',
  'not-presenting': '발표 중에만 질문할 수 있어요.',
  'already-answering': '앞 질문에 답하는 중이에요 — 끝나면 다시 물어봐 주세요.',
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
}

export function PresentationPanel({ view, isDisabled, onStart, onStop, onAskQuestion }: PresentationPanelProps) {
  const [questionDraft, setQuestionDraft] = useState('')
  const [notice, setNotice] = useState('')
  const questionInputRef = useRef<HTMLInputElement | null>(null)

  const isPresentationActive = view.stage.name !== 'idle' && view.stage.name !== 'finished'

  // 스페이스바 = 질문 푸시투토크 진입(질문 입력으로 포커스) — 발표 중에만
  useEffect(() => {
    if (view.stage.name !== 'presenting' && view.stage.name !== 'answering') {
      return
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || isTypingTarget(event.target)) {
        return
      }
      event.preventDefault()
      questionInputRef.current?.focus()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [view.stage.name])

  async function submitQuestion(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const question = questionDraft.trim()
    const result = await onAskQuestion(question)
    if (result === 'accepted') {
      setQuestionDraft('')
      setNotice('')
      return
    }
    setNotice(ASK_RESULT_NOTICES[result])
  }

  if (!isPresentationActive) {
    return (
      <section className="presentation-panel" data-stage={view.stage.name}>
        {view.stage.name === 'finished' && (
          <p id="presentation-status" className="presentation-status">
            발표가 끝났어요. 수고하셨습니다! 👏
          </p>
        )}
        {view.stopNotice !== null && (
          <p id="presentation-stop-notice" className="presentation-notice">
            {view.stopNotice}
          </p>
        )}
        <button
          id="presentation-start"
          className="chat-button"
          type="button"
          disabled={isDisabled}
          onClick={onStart}
        >
          ▶ 발표 시작 (데모 슬라이드)
        </button>
      </section>
    )
  }

  const currentSlide =
    (view.stage.name === 'presenting' || view.stage.name === 'answering') && view.deck !== null
      ? (view.deck.slides[view.stage.slideNumber - 1] ?? null)
      : null

  return (
    <section className="presentation-panel" data-stage={view.stage.name}>
      <div className="presentation-header">
        <span className="presentation-title">📊 발표 모드 — {view.deck?.sourceName ?? ''}</span>
        <button id="presentation-stop" className="chat-button chat-button-secondary" type="button" onClick={onStop}>
          발표 종료
        </button>
      </div>

      {view.stage.name === 'researching' && (
        <p id="presentation-status" className="presentation-status">
          발표 준비 중... (슬라이드 {view.stage.completedSlides}/{view.stage.totalSlides} 조사)
        </p>
      )}

      {currentSlide !== null && view.deck !== null && (
        <div id="presentation-slide" className="presentation-slide">
          <p className="presentation-slide-number">
            슬라이드 {currentSlide.number}/{view.deck.slides.length}
            {view.researchBySlide.has(currentSlide.number) && ' · 사전 조사 반영'}
          </p>
          <h3 className="presentation-slide-title">{currentSlide.title}</h3>
          <p className="presentation-slide-body">{currentSlide.bodyText}</p>
        </div>
      )}

      {view.stage.name === 'answering' && (
        <p id="presentation-status" className="presentation-status">
          ❓ 질문에 답하는 중: “{view.stage.question}”
        </p>
      )}

      {(view.stage.name === 'presenting' || view.stage.name === 'answering') && (
        <form className="presentation-question-row" onSubmit={(event) => void submitQuestion(event)}>
          <input
            id="presentation-question"
            ref={questionInputRef}
            className="chat-input"
            type="text"
            value={questionDraft}
            placeholder="청중 질문 (Space로 포커스)"
            onChange={(event) => setQuestionDraft(event.target.value)}
          />
          <button id="presentation-ask" className="chat-button chat-button-secondary" type="submit">
            ✋ 질문
          </button>
        </form>
      )}

      {notice.length > 0 && <p className="presentation-notice">{notice}</p>}
    </section>
  )
}
