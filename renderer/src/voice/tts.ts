/**
 * 스트리밍 TTS — 출력 스트림 구독자 (CLAUDE.md R2, ARCHITECTURE §2)
 *
 * core 함수를 호출하지 않는다 — 접점은 스트림 구독뿐이다.
 * token 이벤트를 문장 단위로 끊어 경계가 완성되는 즉시 합성·재생한다 —
 * 전체 답변을 기다리지 않는 것이 TTFB(첫 소리까지 시간)의 핵심이다(기획서 §7).
 *
 * 끼어들기(turn-interrupted) = 4중 취소 중 TTS 몫(CLAUDE.md §5):
 * 진행 중 재생 하드컷 + 대기열·버퍼 동시 폐기. 하나라도 남으면 겹쳐 말한다.
 *
 * 합성 엔진은 포트로 주입한다 — 기본은 WebSpeech(OS 보이스, 네트워크 0).
 * 저지연 외부 TTS는 같은 포트로 교체하며 TTFB 실측으로 선택한다(기획서 §7).
 */

import type { OutputEvent, OutputStream, Unsubscribe } from '../core/stream'

export interface TtsSpeakHandlers {
  /** 실제 소리가 나기 시작한 순간 — TTFB 측정 지점 */
  onStart(): void
  onEnd(): void
  onError(message: string): void
}

export interface TtsEngine {
  /**
   * 문장 하나를 합성·재생한다. 순차 재생은 엔진이 아니라 플레이어의 직렬 큐가
   * 보장한다 — 일부 환경의 WebSpeech는 speak() 연속 호출 시 이전 발화를 끊으므로
   * 엔진의 자체 큐를 신뢰하지 않는다. 플레이어는 이전 발화의 onEnd/onError 후에만
   * 다음 speak()를 호출한다.
   */
  speak(text: string, handlers: TtsSpeakHandlers): void
  /** 진행 중 재생 + 엔진 내부 대기열 전부 즉시 중단 */
  cancelAll(): void
}

const DEFAULT_LANGUAGE = 'ko-KR'

/** 브라우저/OS 보이스 기반 기본 엔진. 환경에 없으면 null */
export function createWebSpeechTtsEngine(language: string = DEFAULT_LANGUAGE): TtsEngine | null {
  const host = globalThis as {
    speechSynthesis?: SpeechSynthesis
    SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance
  }
  const synthesis = host.speechSynthesis
  const UtteranceConstructor = host.SpeechSynthesisUtterance
  if (synthesis === undefined || UtteranceConstructor === undefined) {
    return null
  }

  return {
    speak(text: string, handlers: TtsSpeakHandlers): void {
      const utterance = new UtteranceConstructor(text)
      utterance.lang = language
      // 발화당 정확히 1회만 종결을 알린다 — 플랫폼별로 cancel 시 onend만,
      // onerror만, 또는 둘 다 올 수 있다. 침묵(0회)은 직렬 큐 잠금을 정체시키고,
      // 이중 통지(2회)는 큐를 이중 펌프해 겹쳐 말하게 한다.
      let hasSettled = false
      const settleAsEnd = (): void => {
        if (!hasSettled) {
          hasSettled = true
          handlers.onEnd()
        }
      }
      utterance.onstart = () => handlers.onStart()
      utterance.onend = settleAsEnd
      utterance.onerror = (event) => {
        // 하드컷(cancel)도 error로 오는 플랫폼이 있다 — 오류가 아니라 '발화 종료'로
        // 알린다(큐 잠금 해제). 진짜 합성 실패만 onError로 넘긴다.
        if (event.error === 'interrupted' || event.error === 'canceled') {
          settleAsEnd()
          return
        }
        if (hasSettled) {
          return
        }
        hasSettled = true
        handlers.onError(`음성 합성 오류(${event.error})`)
      }
      synthesis.speak(utterance)
    },
    cancelAll(): void {
      synthesis.cancel()
    },
  }
}

/** 문장 경계 문자 — 이 문자가 닫히는 즉시 해당 문장을 합성에 넘긴다 */
const SENTENCE_BOUNDARY_CHARACTERS = new Set(['.', '!', '?', '…', '。', '\n'])

/**
 * 음성으로 읽으면 안 되는 기호: 이모지(Extended_Pictographic), 국기(지역 표시자),
 * 피부톤 변형자, 결합자(ZWJ)·변형 선택자(VS16)·키캡 결합문자, 태그 문자.
 * WebSpeech 등 일부 엔진이 이런 문자를 유니코드 이름("스마일링 페이스")으로 읽는다.
 */
const UNSPEAKABLE_SYMBOL_PATTERN =
  /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu

/**
 * "보이는 텍스트"에서 "읽는 텍스트"를 만든다 — 자막(화면)은 원본 그대로,
 * 합성에는 이 결과만 넘긴다. 이모지 제거 후 남는 군더더기 공백도 정리한다.
 */
export function stripUnspeakableSymbols(text: string): string {
  return text.replace(UNSPEAKABLE_SYMBOL_PATTERN, '').replace(/[ \t]{2,}/g, ' ').trim()
}

export interface SentenceExtraction {
  sentences: string[]
  remainder: string
}

/** 경계·공백뿐인 조각인지 — 발화할 내용이 있는 문장만 합성에 넘긴다 */
function hasSpeakableContent(segment: string): boolean {
  for (const character of segment) {
    if (!SENTENCE_BOUNDARY_CHARACTERS.has(character) && character.trim().length > 0) {
      return true
    }
  }
  return false
}

/**
 * 누적 버퍼에서 완성된 문장들을 떼어낸다. 순수 함수.
 * 경계마다 반드시 전진한다 — 발화할 내용이 없는 조각(고립된 구두점 등)은
 * 버리고, '네.' 같은 한 글자 발화도 그대로 살린다.
 */
export function extractCompleteSentences(buffer: string): SentenceExtraction {
  const sentences: string[] = []
  let segmentStart = 0
  for (let index = 0; index < buffer.length; index += 1) {
    if (!SENTENCE_BOUNDARY_CHARACTERS.has(buffer[index])) {
      continue
    }
    const segment = buffer.slice(segmentStart, index + 1).trim()
    if (hasSpeakableContent(segment)) {
      sentences.push(segment)
    }
    segmentStart = index + 1
  }
  return { sentences, remainder: buffer.slice(segmentStart) }
}

export interface SpeechPlayer {
  attachToStream(stream: OutputStream): Unsubscribe
  /** 음소거 토글 — 끄면 진행 중 재생도 즉시 중단 */
  setEnabled(isEnabled: boolean): void
  isEnabled(): boolean
  /** 4중 취소 중 TTS 몫 — 재생 하드컷 + 대기열·버퍼 폐기 */
  cancelAll(): void
}

export interface SpeechPlayerOptions {
  /** 미지정 시 WebSpeech. 환경에 없으면 재생만 조용히 비활성화된다 */
  engine?: TtsEngine | null
}

export function createSpeechPlayer(options: SpeechPlayerOptions = {}): SpeechPlayer {
  const engine = options.engine === undefined ? createWebSpeechTtsEngine() : options.engine
  if (engine === null) {
    console.error('[voice.tts]: 음성 합성을 지원하지 않는 환경 — 재생 비활성화')
  }

  let pendingText = ''
  let isPlayerEnabled = true
  let turnStartedAt = 0
  let hasLoggedFirstByte = false

  // ── 직렬 재생 큐 ──
  // speak() 동시 호출 경로를 차단한다: 다음 문장은 이전 발화의 onEnd/onError에서만
  // 꺼낸다. 일부 환경의 WebSpeech가 연속 speak()에서 이전 발화를 끊기 때문이다.
  let sentenceQueue: string[] = []
  /** 발화가 엔진에 들어가 끝나지 않은 동안 true — 큐 펌프의 유일한 잠금 */
  let isSpeaking = false
  /** 하드컷마다 증가 — 취소된 발화의 늦은 콜백이 새 턴의 큐를 건드리지 못하게 */
  let playbackGeneration = 0

  function pumpQueue(): void {
    if (engine === null || !isPlayerEnabled || isSpeaking) {
      return
    }
    const nextSentence = sentenceQueue.shift()
    if (nextSentence === undefined) {
      return
    }
    isSpeaking = true
    const generation = playbackGeneration
    // 엔진이 종결(onEnd/onError)을 두 번 알려도 큐를 이중 펌프하지 않게,
    // 그리고 하드컷 이후의 늦은 콜백(세대 불일치)은 무시하게 — 발화당 1회만 정착
    let hasSettled = false
    const settleUtterance = (): boolean => {
      if (hasSettled || generation !== playbackGeneration) {
        return false
      }
      hasSettled = true
      isSpeaking = false
      return true
    }
    engine.speak(nextSentence, {
      onStart: () => {
        if (generation !== playbackGeneration || hasLoggedFirstByte) {
          return
        }
        hasLoggedFirstByte = true
        const elapsedMs = Math.round(performance.now() - turnStartedAt)
        console.log(`[voice.tts] first-byte: ${elapsedMs}ms (턴 시작 기준)`)
      },
      onEnd: () => {
        if (settleUtterance()) {
          pumpQueue()
        }
      },
      onError: (message) => {
        console.error('[voice.tts]:', message)
        // 실패한 문장은 건너뛰고 계속 — 한 문장의 오류가 턴 전체 발화를 막지 않게
        if (settleUtterance()) {
          pumpQueue()
        }
      },
    })
  }

  function speakSentence(sentence: string): void {
    if (engine === null || !isPlayerEnabled) {
      return
    }
    // 합성 직전 분리: 화면 자막은 원본(스트림)이고, 여기서는 읽는 텍스트만 만든다.
    // 이모지를 걷어내고 발화할 내용이 없으면 그 조각은 합성을 건너뛴다.
    const speakableText = stripUnspeakableSymbols(sentence)
    if (!hasSpeakableContent(speakableText)) {
      return
    }
    sentenceQueue.push(speakableText)
    pumpQueue()
  }

  function hardCut(): void {
    pendingText = ''
    // 큐·잠금·세대를 함께 리셋 — 하나라도 남으면 겹쳐 말하거나 큐가 정체된다 (CLAUDE.md §5)
    sentenceQueue = []
    isSpeaking = false
    playbackGeneration += 1
    engine?.cancelAll()
  }

  function handleStreamEvent(event: OutputEvent): void {
    switch (event.type) {
      case 'turn-start':
        // 새 턴이 시작되면 이전 답변의 잔여 발화를 정리한다 (겹쳐 말하기 방지)
        hardCut()
        turnStartedAt = performance.now()
        hasLoggedFirstByte = false
        return
      case 'token': {
        pendingText += event.text
        const { sentences, remainder } = extractCompleteSentences(pendingText)
        pendingText = remainder
        sentences.forEach(speakSentence)
        return
      }
      case 'turn-end': {
        const finalSegment = pendingText.trim()
        pendingText = ''
        if (finalSegment.length > 0) {
          speakSentence(finalSegment)
        }
        return
      }
      case 'turn-interrupted':
      case 'error':
        // 끼어들기 하드컷 — 재생·대기열·버퍼를 함께 버린다 (CLAUDE.md §5)
        hardCut()
        return
      case 'emotion':
        return
    }
  }

  return {
    attachToStream(stream: OutputStream): Unsubscribe {
      return stream.subscribe(handleStreamEvent)
    },
    setEnabled(isEnabled: boolean): void {
      isPlayerEnabled = isEnabled
      if (!isEnabled) {
        hardCut()
      }
    },
    isEnabled(): boolean {
      return isPlayerEnabled
    },
    cancelAll: hardCut,
  }
}
