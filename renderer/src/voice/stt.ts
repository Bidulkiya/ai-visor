/**
 * 스트리밍 STT — 푸시투토크 (기획서 §7: 자동 barge-in 없음, 키/버튼 한정)
 *
 * 마이크 → 텍스트. 확정 텍스트는 onFinalTranscript 콜백으로 내보내고,
 * 조립 계층(ui)이 session.sendUserMessage('voice', text)로 주입한다 —
 * R1 정규화는 그 관문에서 일어나며, voice는 core를 import하지 않는다(§2 경계).
 *
 * 엔진 전략: WebSpeech 우선. 사용 불가 환경(Electron은 구글 음성 서비스가
 * 동봉되지 않아 network 오류가 흔함)이 감지되면 다음 캡처부터 녹음→변환기
 * 폴백으로 전환한다. 변환기(Whisper API/사이드카)는 함수로 주입받는다 —
 * 벤더·키를 코드에 박지 않는다(R7).
 *
 * 상태기계: idle → initializing → (web-speech | recorder) → [transcribing] → idle
 * 비동기 구간(initializing/transcribing)에도 상태를 점유해 이중 캡처를 막는다.
 *
 * 지연 측정: 캡처 시작 → 첫 인식 결과까지를 first-token으로 콘솔에 ms 출력.
 */

export interface SttCallbacks {
  /** 말하는 동안의 중간 인식(스트리밍) — WebSpeech 경로에서만 온다 */
  onPartialTranscript?(text: string): void
  /** 푸시투토크 종료 후 확정 텍스트 — 조립 계층이 Message(source:'voice')로 주입 */
  onFinalTranscript(text: string): void
  onError(message: string): void
}

/** 녹음본 → 텍스트 변환기 (Whisper API/사이드카 등) — 주입 전용, 기본 구현 없음 */
export type WhisperTranscriber = (audio: Blob) => Promise<string>

// ── WebSpeech 최소 타입 (lib.dom에 SpeechRecognition 타입이 없어 직접 선언) ──
export interface MinimalRecognitionAlternative {
  transcript: string
}
export interface MinimalRecognitionResult {
  isFinal: boolean
  0: MinimalRecognitionAlternative
}
export interface MinimalRecognitionEvent {
  resultIndex: number
  results: ArrayLike<MinimalRecognitionResult>
}
export interface MinimalSpeechRecognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: MinimalRecognitionEvent) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

/** 푸시투토크 녹음기 최소 계약 — 기본 구현은 MediaRecorder */
export interface MinimalAudioRecorder {
  /** 녹음을 끝내고 전체 음성을 돌려준다 */
  stop(): Promise<Blob>
  /** 결과를 버리고 즉시 정리 */
  cancel(): void
}

export interface SpeechCaptureOptions {
  callbacks: SttCallbacks
  /** WebSpeech 불가 시 폴백 변환기 — 없으면 명확한 안내 에러 */
  transcribeRecording?: WhisperTranscriber
  language?: string
  /** 테스트 주입용 — 미지정 시 브라우저 구현 사용 */
  recognitionFactory?: () => MinimalSpeechRecognition | null
  recorderFactory?: () => Promise<MinimalAudioRecorder>
}

export interface SpeechCapture {
  /** 푸시투토크 시작 (키/버튼 누름). 이미 진행 중이면 무시 */
  start(): Promise<void>
  /** 푸시투토크 종료 (키/버튼 뗌) → 확정 텍스트 전달. 유휴면 무시 */
  stop(): void
  isCapturing(): boolean
  dispose(): void
}

const DEFAULT_LANGUAGE = 'ko-KR'
const RECORDER_AUDIO_MIME_TYPE = 'audio/webm'

const STT_UNAVAILABLE_MESSAGE =
  '이 환경에서 음성 인식을 쓸 수 없어요. (폴백 변환기도 설정되어 있지 않습니다)'
const STT_EMPTY_RESULT_MESSAGE = '음성이 인식되지 않았어요. 다시 말해 볼래요?'
const STT_MIC_FAILED_MESSAGE = '마이크를 열 수 없어요. 권한과 장치를 확인해 주세요.'
const STT_TRANSCRIBE_FAILED_MESSAGE = '음성을 텍스트로 바꾸지 못했어요. 다시 시도해 주세요.'

function defaultRecognitionFactory(): MinimalSpeechRecognition | null {
  const host = globalThis as {
    SpeechRecognition?: new () => MinimalSpeechRecognition
    webkitSpeechRecognition?: new () => MinimalSpeechRecognition
  }
  const RecognitionConstructor = host.SpeechRecognition ?? host.webkitSpeechRecognition
  return RecognitionConstructor === undefined ? null : new RecognitionConstructor()
}

async function defaultRecorderFactory(): Promise<MinimalAudioRecorder> {
  const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const recorder = new MediaRecorder(mediaStream)
  const audioChunks: Blob[] = []
  recorder.ondataavailable = (event) => {
    audioChunks.push(event.data)
  }
  recorder.start()

  function releaseMicrophone(): void {
    mediaStream.getTracks().forEach((track) => track.stop())
  }

  return {
    stop(): Promise<Blob> {
      return new Promise((resolve) => {
        recorder.onstop = () => {
          releaseMicrophone()
          resolve(new Blob(audioChunks, { type: RECORDER_AUDIO_MIME_TYPE }))
        }
        recorder.stop()
      })
    },
    cancel(): void {
      recorder.onstop = null
      recorder.stop()
      releaseMicrophone()
    },
  }
}

type CaptureState =
  | { kind: 'idle' }
  /** start()의 비동기 준비 구간 — 이중 start 차단용 점유 상태 */
  | { kind: 'initializing' }
  | { kind: 'web-speech'; recognition: MinimalSpeechRecognition; finalParts: string[] }
  | { kind: 'recorder'; recorder: MinimalAudioRecorder }
  /** 녹음 종료 후 변환 대기 — 끝나기 전 재캡처를 막는다 */
  | { kind: 'transcribing' }

export function createSpeechCapture(options: SpeechCaptureOptions): SpeechCapture {
  const language = options.language ?? DEFAULT_LANGUAGE
  const recognitionFactory = options.recognitionFactory ?? defaultRecognitionFactory
  const recorderFactory = options.recorderFactory ?? defaultRecorderFactory

  let state: CaptureState = { kind: 'idle' }
  let isDisposed = false
  /** initializing(녹음기 준비) 중에 버튼을 뗐으면, 준비 완료 즉시 종료 처리 */
  let hasPendingStop = false
  /** WebSpeech가 한 번 실패하면(서비스 부재 등) 이후 캡처는 폴백으로 직행 */
  let isWebSpeechUnavailable = false
  let captureStartedAt = 0
  let hasLoggedFirstToken = false

  // dispose 이후의 늦은 이벤트가 죽은 React 상태를 건드리지 않게 전부 게이트
  function emitError(message: string): void {
    if (!isDisposed) {
      options.callbacks.onError(message)
    }
  }
  function emitPartial(text: string): void {
    if (!isDisposed) {
      options.callbacks.onPartialTranscript?.(text)
    }
  }
  function emitFinal(transcript: string): void {
    if (isDisposed) {
      return
    }
    const trimmed = transcript.trim()
    if (trimmed.length === 0) {
      emitError(STT_EMPTY_RESULT_MESSAGE)
      return
    }
    options.callbacks.onFinalTranscript(trimmed)
  }

  function logFirstTokenOnce(suffix: string): void {
    if (hasLoggedFirstToken) {
      return
    }
    hasLoggedFirstToken = true
    const elapsedMs = Math.round(performance.now() - captureStartedAt)
    console.log(`[voice.stt] first-token: ${elapsedMs}ms${suffix}`)
  }

  function detachRecognitionHandlers(recognition: MinimalSpeechRecognition): void {
    recognition.onresult = null
    recognition.onerror = null
    recognition.onend = null
  }

  function startWebSpeech(recognition: MinimalSpeechRecognition): void {
    const finalParts: string[] = []
    state = { kind: 'web-speech', recognition, finalParts }

    recognition.lang = language
    recognition.continuous = true
    recognition.interimResults = true

    recognition.onresult = (event) => {
      logFirstTokenOnce(' (webspeech)')
      let interimText = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        if (result.isFinal) {
          finalParts.push(result[0].transcript)
        } else {
          interimText += result[0].transcript
        }
      }
      emitPartial(finalParts.join(' ') + interimText)
    }
    recognition.onerror = (event) => {
      // 서비스 부재(network)·권한 거부 등 — 이번 발화는 살릴 수 없고, 다음부터 폴백으로.
      // 늦은 이벤트가 다시 들어오지 못하게 핸들러를 떼고 엔진도 정리한다.
      isWebSpeechUnavailable = true
      state = { kind: 'idle' }
      detachRecognitionHandlers(recognition)
      recognition.abort()
      emitError(`음성 인식 오류(${event.error}) — 다음부터 녹음 변환으로 전환할게요.`)
    }
    recognition.onend = () => {
      if (state.kind !== 'web-speech') {
        return
      }
      state = { kind: 'idle' }
      detachRecognitionHandlers(recognition)
      emitFinal(finalParts.join(' '))
    }
    recognition.start()
  }

  function stopRecorderCapture(recorder: MinimalAudioRecorder): void {
    const transcribe = options.transcribeRecording
    if (transcribe === undefined) {
      recorder.cancel()
      state = { kind: 'idle' }
      return
    }
    void stopRecorderAndTranscribe(recorder, transcribe)
  }

  async function startRecorderFallback(): Promise<void> {
    if (options.transcribeRecording === undefined) {
      state = { kind: 'idle' }
      emitError(STT_UNAVAILABLE_MESSAGE)
      return
    }
    try {
      const recorder = await recorderFactory()
      if (isDisposed) {
        recorder.cancel()
        state = { kind: 'idle' }
        return
      }
      state = { kind: 'recorder', recorder }
      if (hasPendingStop) {
        // 준비 중에 버튼을 뗐다 — 마이크가 켜진 채 남지 않게 즉시 종료 처리
        hasPendingStop = false
        stopRecorderCapture(recorder)
      }
    } catch (error) {
      console.error('[voice.stt]: 마이크 열기 실패:', error)
      state = { kind: 'idle' }
      emitError(STT_MIC_FAILED_MESSAGE)
    }
  }

  async function stopRecorderAndTranscribe(
    recorder: MinimalAudioRecorder,
    transcribe: WhisperTranscriber,
  ): Promise<void> {
    state = { kind: 'transcribing' }
    const transcribeStartedAt = performance.now()
    try {
      const recordedAudio = await recorder.stop()
      const transcript = await transcribe(recordedAudio)
      const elapsedMs = Math.round(performance.now() - transcribeStartedAt)
      console.log(`[voice.stt] first-token: ${elapsedMs}ms (whisper 폴백 — 일괄 변환)`)
      emitFinal(transcript)
    } catch (error) {
      console.error('[voice.stt]: 폴백 변환 실패:', error)
      emitError(STT_TRANSCRIBE_FAILED_MESSAGE)
    } finally {
      state = { kind: 'idle' }
    }
  }

  return {
    async start(): Promise<void> {
      if (isDisposed || state.kind !== 'idle') {
        return
      }
      // 비동기 준비 동안에도 점유 — 이중 start로 마이크가 두 번 열리지 않게
      state = { kind: 'initializing' }
      hasPendingStop = false
      captureStartedAt = performance.now()
      hasLoggedFirstToken = false

      if (!isWebSpeechUnavailable) {
        const recognition = recognitionFactory()
        if (recognition !== null) {
          startWebSpeech(recognition)
          return
        }
        isWebSpeechUnavailable = true
      }
      await startRecorderFallback()
    },

    stop(): void {
      if (state.kind === 'initializing') {
        // 녹음기 준비 완료 시점에 즉시 종료 처리된다
        hasPendingStop = true
        return
      }
      if (state.kind === 'web-speech') {
        // onend에서 확정 텍스트를 조립한다
        state.recognition.stop()
        return
      }
      if (state.kind === 'recorder') {
        stopRecorderCapture(state.recorder)
      }
      // transcribing이면 finally에서 idle로 정리된다
    },

    isCapturing(): boolean {
      return state.kind === 'web-speech' || state.kind === 'recorder'
    },

    dispose(): void {
      isDisposed = true
      if (state.kind === 'web-speech') {
        detachRecognitionHandlers(state.recognition)
        state.recognition.abort()
      }
      if (state.kind === 'recorder') {
        state.recorder.cancel()
      }
      state = { kind: 'idle' }
    },
  }
}
