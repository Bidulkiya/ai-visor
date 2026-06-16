/**
 * 채팅 패널 — 대화 목록(사용자/동반자 구분) + 입력창 + 전송/중단.
 * 동반자 답변은 스트림 token이 이어 붙으며 타이핑되듯 표시된다.
 */

'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Mic, Send, Square, Volume2, VolumeX } from 'lucide-react'
import type { ChatMessage } from './useCompanionSession'
import { MarkdownText } from './MarkdownText'

/** 버튼 안 lucide 아이콘 공통 크기·선두께 — 전 화면 일관성 */
const ICON_SIZE = 18
const ICON_STROKE = 1.9

export interface VoiceControls {
  isCapturing: boolean
  isSpeakerEnabled: boolean
  voiceNotice: string
  onTalkStart(): void
  onTalkEnd(): void
  onToggleSpeaker(): void
}

interface ChatPanelProps {
  messages: readonly ChatMessage[]
  isThinking: boolean
  isDisabled: boolean
  /**
   * 입력을 현재 모드로 라우팅한다(문서 질문/청중 질문/일반 채팅 — page.tsx가 분기).
   * 수락되면 null, 거부(읽는 중·답하는 중 등)면 안내 문구를 반환한다 → 입력을 보존하고 문구를 보인다.
   */
  onSend(text: string): string | null
  onInterrupt(): void
  voice: VoiceControls
  /** 입력창 placeholder — 모드에 따라 다른 문구(문서 질문/청중 질문/일반) */
  placeholder: string
}

/** 이 거리(px) 안에 있으면 "맨 아래를 보는 중"으로 간주해 자동 스크롤한다 */
const AUTO_SCROLL_THRESHOLD_PX = 80

export function ChatPanel({
  messages,
  isThinking,
  isDisabled,
  onSend,
  onInterrupt,
  voice,
  placeholder,
}: ChatPanelProps) {
  const [draftText, setDraftText] = useState('')
  /** 입력이 거부됐을 때(읽는 중·답하는 중 등)의 안내 — 보내지면 비운다 */
  const [sendNotice, setSendNotice] = useState('')
  const messageListRef = useRef<HTMLDivElement | null>(null)
  const isNearBottomRef = useRef(true)

  function handleScroll(): void {
    const list = messageListRef.current
    if (list !== null) {
      const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight
      isNearBottomRef.current = distanceFromBottom < AUTO_SCROLL_THRESHOLD_PX
    }
  }

  // 새 토큰을 따라 맨 아래로 — 단, 사용자가 위로 올려 과거를 읽는 중이면 방해하지 않는다
  useEffect(() => {
    const list = messageListRef.current
    if (list !== null && isNearBottomRef.current) {
      list.scrollTop = list.scrollHeight
    }
  }, [messages])

  // 모드(placeholder)가 바뀌면(문서 읽는중→준비됨, 문서 닫힘 등) 이전 모드의 거부 안내는
  // 더 이상 맞지 않으니 정리한다 — 묵은 sendNotice가 모드 전환을 넘어 남지 않게(상태 누수 방지).
  useEffect(() => {
    setSendNotice('')
  }, [placeholder])

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const text = draftText.trim()
    if (text.length === 0 || isDisabled) {
      return
    }
    const notice = onSend(text)
    if (notice === null) {
      setDraftText('')
      setSendNotice('')
    } else {
      // 거부됨(문서 읽는 중·답하는 중 등) — 입력을 지우지 않고 안내만 보여 다시 보낼 수 있게 한다
      setSendNotice(notice)
    }
  }

  return (
    <section className="chat-panel">
      <div id="chat-messages" className="chat-messages" ref={messageListRef} onScroll={handleScroll}>
        {messages.length === 0 && (
          <p className="chat-empty">대화를 시작해 보세요.</p>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            className={`chat-bubble ${message.role === 'user' ? 'chat-bubble-user' : 'chat-bubble-companion'}${message.isError ? ' chat-bubble-error' : ''}`}
            data-role={message.role}
            data-streaming={message.isStreaming ? 'true' : 'false'}
          >
            <div className="chat-markdown">
              <MarkdownText source={message.text} streaming={message.isStreaming} />
            </div>
          </div>
        ))}
        {isThinking && <p className="chat-thinking">…</p>}
      </div>

      {voice.voiceNotice.length > 0 && <p className="voice-notice">{voice.voiceNotice}</p>}
      {sendNotice.length > 0 && <p className="chat-send-notice">{sendNotice}</p>}

      <form className="chat-input-row" onSubmit={handleSubmit}>
        <input
          id="chat-input"
          className="chat-input"
          type="text"
          value={draftText}
          placeholder={isDisabled ? '연결 중…' : placeholder}
          disabled={isDisabled}
          onChange={(event) => {
            setDraftText(event.target.value)
            if (sendNotice.length > 0) {
              setSendNotice('')
            }
          }}
        />
        <button
          id="voice-talk"
          className={`chat-button chat-button-secondary chat-button-icon${voice.isCapturing ? ' chat-button-active' : ''}`}
          type="button"
          title="누르고 있는 동안 말하기 (푸시투토크)"
          aria-label="말하기 (푸시투토크)"
          disabled={isDisabled}
          onMouseDown={voice.onTalkStart}
          onMouseUp={voice.onTalkEnd}
          // isCapturing은 비동기 시작 동안 낡을 수 있다 — 무조건 종료(유휴면 무해한 no-op)
          onMouseLeave={voice.onTalkEnd}
          onTouchStart={voice.onTalkStart}
          onTouchEnd={voice.onTalkEnd}
        >
          <Mic size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </button>
        <button
          id="voice-speaker"
          className="chat-button chat-button-secondary chat-button-icon"
          type="button"
          title={voice.isSpeakerEnabled ? '음성 출력 끄기' : '음성 출력 켜기'}
          aria-label={voice.isSpeakerEnabled ? '음성 출력 끄기' : '음성 출력 켜기'}
          onClick={voice.onToggleSpeaker}
        >
          {voice.isSpeakerEnabled ? (
            <Volume2 size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          ) : (
            <VolumeX size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          )}
        </button>
        <button
          id="chat-send"
          className="chat-button chat-button-icon"
          type="submit"
          title="전송"
          aria-label="전송"
          disabled={isDisabled}
        >
          <Send size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </button>
        <button
          id="chat-interrupt"
          className="chat-button chat-button-secondary chat-button-icon"
          type="button"
          title="중단"
          aria-label="중단"
          onClick={onInterrupt}
        >
          <Square size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </button>
      </form>
    </section>
  )
}
