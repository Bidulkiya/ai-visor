/**
 * 세션 연결 훅 — ui와 core의 접점.
 *
 * - 세션은 모듈 싱글턴으로 한 번만 연결한다 (React StrictMode 이중 effect 안전).
 * - 대화 목록은 출력 스트림 구독으로 만든다: token 이벤트를 이어붙여
 *   타이핑되듯 표시 (R2 — 자막 구독자에 해당).
 */

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  connectCompanionSession,
  type CompanionSession,
  type ConnectSessionResult,
  type ToolRuntime,
} from '../core/session'
import type { OutputEvent, OutputStream } from '../core/stream'
import { getStoredApiKey } from './apiKeySettings'
import type { ApprovalRequester } from '../tools/gate'
import { assembleToolRuntime } from './assembleToolRuntime'

export interface ChatMessage {
  id: number
  role: 'user' | 'companion'
  text: string
  isStreaming: boolean
  isError: boolean
}

export type ConnectionState = 'connecting' | 'connected' | 'no-bridge'

export interface CompanionSessionView {
  connectionState: ConnectionState
  isFirstRun: boolean
  /** 키 미설정이면 안내 배너 표시 + 설정 화면 유도 */
  hasApiKey: boolean
  /** 설정 화면에서 키를 저장/삭제한 뒤 호출 — 배너 상태 갱신 */
  refreshApiKeyStatus(): void
  messages: readonly ChatMessage[]
  isThinking: boolean
  outputStream: OutputStream | null
  /** 발표 컨트롤러 등 확장 레이어가 본체를 호출만 할 때 쓴다 (R3 방향: 확장 → core) */
  session: CompanionSession | null
  /** 게이트·감사(R4)가 조립된 도구 런타임 — 발표 사전 조사 등이 재사용 */
  toolRuntime: ToolRuntime | null
  /** 채팅 입력과 음성 입력 모두 이 관문으로 — source만 다르다 (R1) */
  sendMessage(text: string, source?: 'chat' | 'voice'): Promise<void>
  /**
   * 사용자 말풍선만 화면에 추가한다(전송은 안 함) — 문서·발표 질문은 본체에 증강 프롬프트로
   * 주입되어 말풍선이 안 남으므로, 통합된 메인 채팅에 사용자 질문을 보이게 할 때 쓴다(표시 전용).
   */
  appendUserMessage(text: string): void
  interrupt(): void
}

// 모듈 싱글턴 — StrictMode가 effect를 두 번 돌려도 세션은 하나만 만든다.
// 키 조회(R7)는 설정 저장소를 읽는 함수를 주입한다 — 턴마다 최신 값을 쓴다.
let connectionPromise: Promise<ConnectSessionResult> | null = null
/** 첫 연결에 실제로 쓰인 런타임 — 발표 사전 조사도 같은 게이트·감사 경로를 쓰게 한다 */
let connectedToolRuntime: ToolRuntime | null = null
function getOrConnectSession(toolRuntime: ToolRuntime | null): Promise<ConnectSessionResult> {
  if (connectionPromise === null) {
    connectedToolRuntime = toolRuntime
    connectionPromise = connectCompanionSession({
      getApiKey: getStoredApiKey,
      toolRuntime: toolRuntime ?? undefined,
    })
  }
  return connectionPromise
}

export function useCompanionSession(requestApproval: ApprovalRequester): CompanionSessionView {
  const sessionRef = useRef<CompanionSession | null>(null)
  const nextMessageIdRef = useRef(0)
  const requestApprovalRef = useRef(requestApproval)
  requestApprovalRef.current = requestApproval
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting')
  const [isFirstRun, setIsFirstRun] = useState(false)
  const [hasApiKey, setHasApiKey] = useState(false)
  const [messages, setMessages] = useState<readonly ChatMessage[]>([])
  const [isThinking, setIsThinking] = useState(false)
  const [outputStream, setOutputStream] = useState<OutputStream | null>(null)
  const [connectedSession, setConnectedSession] = useState<CompanionSession | null>(null)
  const [toolRuntime, setToolRuntime] = useState<ToolRuntime | null>(null)

  /** 현재 스트리밍 중인 동반자 말풍선 id — 토큰이 이어 붙을 대상 */
  const streamingMessageIdRef = useRef<number | null>(null)

  const appendMessage = useCallback((message: Omit<ChatMessage, 'id'>): number => {
    nextMessageIdRef.current += 1
    const withId: ChatMessage = { ...message, id: nextMessageIdRef.current }
    setMessages((previous) => [...previous, withId])
    return withId.id
  }, [])

  const removeMessage = useCallback((messageId: number): void => {
    setMessages((previous) => previous.filter((message) => message.id !== messageId))
  }, [])

  // 문서·발표 질문은 본체에 증강 프롬프트로 주입돼 사용자 말풍선이 안 남는다 — 통합 채팅에서
  // 사용자가 친 질문을 보이게 표시만 더한다(전송·기억은 컨트롤러의 주입이 담당, 여기는 표시 전용).
  const appendUserMessage = useCallback(
    (text: string): void => {
      appendMessage({ role: 'user', text, isStreaming: false, isError: false })
    },
    [appendMessage],
  )

  /** 스트리밍 중인 동반자 말풍선에 토큰을 잇거나, 없으면 새로 연다 */
  const appendCompanionToken = useCallback((tokenText: string): void => {
    const streamingId = streamingMessageIdRef.current
    if (streamingId !== null) {
      setMessages((previous) =>
        previous.map((message) =>
          message.id === streamingId ? { ...message, text: message.text + tokenText } : message,
        ),
      )
      return
    }
    nextMessageIdRef.current += 1
    const newId = nextMessageIdRef.current
    streamingMessageIdRef.current = newId
    setMessages((previous) => [
      ...previous,
      { id: newId, role: 'companion', text: tokenText, isStreaming: true, isError: false },
    ])
  }, [])

  const finalizeStreamingMessage = useCallback((): void => {
    streamingMessageIdRef.current = null
    setMessages((previous) =>
      previous.map((message) => (message.isStreaming ? { ...message, isStreaming: false } : message)),
    )
  }, [])

  useEffect(() => {
    let isCancelled = false
    let unsubscribe: (() => void) | null = null

    const handleStreamEvent = (event: OutputEvent): void => {
      switch (event.type) {
        case 'turn-start':
          setIsThinking(true)
          return
        case 'token':
          setIsThinking(false)
          appendCompanionToken(event.text)
          return
        case 'turn-end':
        case 'turn-interrupted':
          setIsThinking(false)
          finalizeStreamingMessage()
          return
        case 'error':
          setIsThinking(false)
          finalizeStreamingMessage()
          appendMessage({ role: 'companion', text: event.message, isStreaming: false, isError: true })
          return
        case 'emotion':
        case 'emotion-shift':
          // 표정은 FaceCanvas가 같은 스트림을 직접 구독한다(대화 목록과 무관)
          return
      }
    }

    // 승인자는 ref로 감싸 안정 — 도구 런타임은 첫 연결 때 한 번만 조립된다
    // signal까지 forward — 끼어들기 시 대기 중 승인이 자동 거부되게 (체인 즉시 중단)
    const toolRuntime = assembleToolRuntime((request, signal) =>
      requestApprovalRef.current(request, signal),
    )
    getOrConnectSession(toolRuntime)
      .then((result) => {
        if (isCancelled) {
          return
        }
        if (result.status === 'no-bridge') {
          setConnectionState('no-bridge')
          return
        }
        sessionRef.current = result.session
        setIsFirstRun(result.startup.isFirstRun)
        setHasApiKey(getStoredApiKey() !== null)
        setOutputStream(result.session.outputStream)
        setConnectedSession(result.session)
        setToolRuntime(connectedToolRuntime)
        unsubscribe = result.session.outputStream.subscribe(handleStreamEvent)
        setConnectionState('connected')
      })
      .catch((error: unknown) => {
        console.error('[useCompanionSession]: 세션 연결 실패:', error)
        if (!isCancelled) {
          setConnectionState('no-bridge')
        }
      })

    return () => {
      isCancelled = true
      unsubscribe?.()
    }
  }, [appendCompanionToken, appendMessage, finalizeStreamingMessage])

  const sendMessage = useCallback(
    async (text: string, source: 'chat' | 'voice' = 'chat'): Promise<void> => {
      const session = sessionRef.current
      if (session === null) {
        return
      }
      const userMessageId = appendMessage({ role: 'user', text, isStreaming: false, isError: false })
      const result = await session.sendUserMessage(source, text)
      if (result.status === 'invalid-input' || result.status === 'rejected-busy') {
        // 전송되지 않은 메시지가 보낸 것처럼 남지 않게 말풍선을 거둔다
        removeMessage(userMessageId)
        appendMessage({
          role: 'companion',
          text:
            result.status === 'rejected-busy'
              ? '잠깐, 아직 말하는 중이야! 끝나면 다시 보내줘.'
              : '빈 메시지는 보낼 수 없어.',
          isStreaming: false,
          isError: true,
        })
      }
      // completed/interrupted/failed는 스트림 이벤트가 이미 화면에 반영함
    },
    [appendMessage, removeMessage],
  )

  const interrupt = useCallback((): void => {
    sessionRef.current?.interrupt()
  }, [])

  const refreshApiKeyStatus = useCallback((): void => {
    setHasApiKey(getStoredApiKey() !== null)
  }, [])

  return {
    connectionState,
    isFirstRun,
    hasApiKey,
    refreshApiKeyStatus,
    messages,
    isThinking,
    outputStream,
    session: connectedSession,
    toolRuntime,
    sendMessage,
    appendUserMessage,
    interrupt,
  }
}
