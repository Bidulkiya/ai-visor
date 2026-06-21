/**
 * 음성 입출력 배선 훅 — voice 모듈과 세션의 접점.
 *
 * STT 확정 텍스트는 onTranscript로 올라가고, 호출자(page)가
 * session.sendUserMessage('voice', text)로 주입한다 (R1 관문).
 * TTS는 출력 스트림 구독자로 붙는다 (R2).
 */

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { OutputStream } from '../core/stream'
import { createSpeechCapture, type SpeechCapture } from '../voice/stt'
import { createSpeechPlayer, type SpeechPlayer } from '../voice/tts'
import { createSpeechActivity, type SpeechActivityState } from './speechActivity'

export interface VoiceView {
  isCapturing: boolean
  isSpeakerEnabled: boolean
  /** STT 오류 등 사용자 안내 — 비어 있으면 표시 안 함 */
  voiceNotice: string
  startTalk(): void
  stopTalk(): void
  toggleSpeaker(): void
  /** TTS 발성 신호 — FaceCanvas가 입 발성 모션(벌어짐)에 읽는다(폴링, 표정 매핑과 무관) */
  speechActivity: SpeechActivityState
}

export function useVoice(
  stream: OutputStream | null,
  onTranscript: (text: string) => void,
): VoiceView {
  const captureRef = useRef<SpeechCapture | null>(null)
  const playerRef = useRef<SpeechPlayer | null>(null)
  const onTranscriptRef = useRef(onTranscript)
  onTranscriptRef.current = onTranscript

  const [isCapturing, setIsCapturing] = useState(false)
  const [isSpeakerEnabled, setIsSpeakerEnabled] = useState(true)
  const [voiceNotice, setVoiceNotice] = useState('')
  // 발성 활동 채널(세션 동안 안정) — TTS가 sink로 쓰고 FaceCanvas가 state를 읽는다
  const [speechActivity] = useState(() => createSpeechActivity())

  // TTS: 스트림 구독자로 부착
  useEffect(() => {
    if (stream === null) {
      return
    }
    const player = createSpeechPlayer({ speechActivity: speechActivity.sink })
    playerRef.current = player
    const unsubscribe = player.attachToStream(stream)
    return () => {
      unsubscribe()
      player.cancelAll()
      playerRef.current = null
    }
  }, [stream, speechActivity])

  // STT: 푸시투토크 캡처 (한 번만 생성)
  useEffect(() => {
    const capture = createSpeechCapture({
      callbacks: {
        onFinalTranscript: (text) => {
          setVoiceNotice('')
          onTranscriptRef.current(text)
        },
        onError: (message) => {
          setIsCapturing(false)
          setVoiceNotice(message)
        },
      },
      // TODO(+1 계속): Whisper 변환기(사이드카/외부 API)를 설정에서 주입
    })
    captureRef.current = capture
    return () => {
      capture.dispose()
      captureRef.current = null
    }
  }, [])

  /** 버튼이 실제로 눌려 있는지 — React 상태는 비동기 start 동안 낡을 수 있어 ref로 추적 */
  const isPressedRef = useRef(false)

  const startTalk = useCallback((): void => {
    const capture = captureRef.current
    if (capture === null) {
      return
    }
    isPressedRef.current = true
    setVoiceNotice('')
    void capture.start().then(() => {
      if (!isPressedRef.current) {
        // 준비되는 사이에 버튼을 뗐다 — 마이크가 켜진 채 남지 않게 즉시 종료
        capture.stop()
        setIsCapturing(false)
        return
      }
      setIsCapturing(capture.isCapturing())
    })
  }, [])

  const stopTalk = useCallback((): void => {
    isPressedRef.current = false
    captureRef.current?.stop()
    setIsCapturing(false)
  }, [])

  const toggleSpeaker = useCallback((): void => {
    const player = playerRef.current
    if (player === null) {
      return
    }
    const nextEnabled = !player.isEnabled()
    player.setEnabled(nextEnabled)
    setIsSpeakerEnabled(nextEnabled)
  }, [])

  return {
    isCapturing,
    isSpeakerEnabled,
    voiceNotice,
    startTalk,
    stopTalk,
    toggleSpeaker,
    speechActivity: speechActivity.state,
  }
}
