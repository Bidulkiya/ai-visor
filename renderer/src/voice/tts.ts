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
  /** 단어/구절 경계(엔진이 지원하면) — 발성 모션의 음절 펄스용. 미지원 엔진은 호출 안 함 */
  onBoundary?(): void
}

/**
 * 발성 활동 싱크 — TTS가 "말하는 중/단어 경계"를 외부(표정 등)에 알리는 통로. ui가 구현 주입.
 * 출력 스트림(R2)과 별개 채널이다: 출력 스트림은 LLM→소비자 단방향이라 TTS가 거기로 되쏘지 않는다.
 */
export interface SpeechActivitySink {
  setSpeaking(active: boolean): void
  markBoundary(now: number): void
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
      utterance.onboundary = () => handlers.onBoundary?.()
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

/**
 * 마크다운 인라인 기호를 음성에서 걷어낸다 — '보이는 텍스트(자막)'는 스트림 원본을
 * 유지하고, 합성에는 이 결과만 넘긴다(이모지 필터와 같은 원리). 본문(설명·대화)은
 * 보존하고, 읽으면 거슬리는 강조(**, *, _, ~)·인라인 코드(`)·제목(#)·인용(>)·
 * 링크([텍스트](url))만 정리한다. 코드블록·목록·표는 줄 단위로 따로 처리한다(SpeechPlayer).
 */
const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*\]\([^)]*\)/g
const MARKDOWN_LINK_PATTERN = /\[([^\]]*)\]\([^)]*\)/g
const HEADING_PREFIX_PATTERN = /^\s*#{1,6}\s*/
const BLOCKQUOTE_PREFIX_PATTERN = /^\s*>+\s?/
// 강조용 밑줄(_기울임_, __굵게__)만 벗긴다 — snake_case 식별자는 단어 경계로 보호한다.
// __dunder__(예: __init__)는 __굵게__와 구분 불가라 음성에선 내용만 남는다("이닛").
// 기호("언더바")를 낭독하지 않는 게 목적이므로 의도된 절충이다 — 자막은 원본을 유지한다.
const UNDERSCORE_EMPHASIS_PATTERN =
  /(?<![\p{L}\p{N}_])_{1,2}(?=\S)([^_]+?)(?<=\S)_{1,2}(?![\p{L}\p{N}_])/gu
// 별표·백틱·물결은 한국어 본문에 쓰임이 없어 전부 제거해도 안전하다.
const INLINE_MARKDOWN_SYMBOLS_PATTERN = /[*`~]/g

/** 한 조각(문장/줄)에서 음성에 부적합한 마크다운 인라인 기호를 정리한다. 순수 함수. */
export function toSpeakableText(text: string): string {
  const withoutInlineMarkdown = text
    .replace(MARKDOWN_IMAGE_PATTERN, '')
    .replace(MARKDOWN_LINK_PATTERN, '$1')
    .replace(HEADING_PREFIX_PATTERN, '')
    .replace(BLOCKQUOTE_PREFIX_PATTERN, '')
    .replace(UNDERSCORE_EMPHASIS_PATTERN, '$1')
    .replace(INLINE_MARKDOWN_SYMBOLS_PATTERN, '')
  return stripUnspeakableSymbols(withoutInlineMarkdown)
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

/**
 * 줄 단위 마크다운 구조 분류 — 목록·코드펜스·표는 줄 단위 구조라 문장 분리로는 오인된다
 * (특히 "1." 순서목록은 마침표가 문장 경계로 잘려 "일"로 읽힌다). 그래서 합성은 완성된
 * '줄'을 보고 분류한 뒤, 산문 줄만 문장으로 쪼개 읽는다(SpeechPlayer).
 */
const CODE_FENCE_LINE_PATTERN = /^(`{3,}|~{3,})[A-Za-z0-9+#._-]*$/
const LIST_ITEM_LINE_PATTERN = /^([-*+]\s+|\d+[.)]\s+)/
const THEMATIC_BREAK_LINE_PATTERN = /^([-*_=])\1{2,}$/
// 미완성 줄이 이 마커로 시작하면 산문이 아닐 수 있어 줄 완성까지 보류한다.
// 숫자+마침표로 시작하는 줄(순서목록 "1." 또는 소수 "3.14")은 보류한다 — 줄이 완성되면
// consumeLine이 통째로 읽어 소수가 "삼 점 일 사"로 정확히 발음된다(미리 쪼개면 "삼"+"십사"로 깨짐).
const STRUCTURAL_LINE_START_PATTERN = /^\s*([-*+>|#`~]|\d+[.)])/

/** 코드블록 펜스 줄(```/~~~, 언어 태그 허용) — 안의 내용은 음성에서 통째로 제외 */
export function isCodeFenceLine(trimmedLine: string): boolean {
  return CODE_FENCE_LINE_PATTERN.test(trimmedLine)
}
/** 목록 항목 줄(-, *, +, "1.", "1)") — 나열은 읽지 않고 화면 안내로 축약 */
export function isListItemLine(trimmedLine: string): boolean {
  return LIST_ITEM_LINE_PATTERN.test(trimmedLine)
}
/** 표 행 줄(| …) — 목록과 함께 화면 안내로 축약 */
export function isTableRowLine(trimmedLine: string): boolean {
  return trimmedLine.startsWith('|')
}
/** 구분선 줄(---, ***, ___, ===) — 음성에선 조용히 건너뛴다 */
export function isThematicBreakLine(trimmedLine: string): boolean {
  return THEMATIC_BREAK_LINE_PATTERN.test(trimmedLine)
}
/** 미완성 줄을 미리 문장 단위로 읽어도 되는가(산문 시작) — 구조 마커로 시작하면 보류 */
export function startsLikeProse(incompleteLine: string): boolean {
  if (incompleteLine.trim().length === 0) {
    return false
  }
  return !STRUCTURAL_LINE_START_PATTERN.test(incompleteLine)
}

/** 목록·표를 음성으로 나열하는 대신 화면을 보게 안내하는 축약 문구(요구: 나열 방지) */
const LIST_VOICE_SUBSTITUTE = '자세한 내용은 화면을 확인해 주세요.'

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
  /** 발성 모션용 — 말하는 동안/단어 경계를 표정(FaceCanvas)에 전달. 미지정이면 발성 모션 없음 */
  speechActivity?: SpeechActivitySink
}

export function createSpeechPlayer(options: SpeechPlayerOptions = {}): SpeechPlayer {
  const engine = options.engine === undefined ? createWebSpeechTtsEngine() : options.engine
  if (engine === null) {
    console.error('[voice.tts]: 음성 합성을 지원하지 않는 환경 — 재생 비활성화')
  }
  // 발성 모션 채널(선택) — 말하는 동안/단어 경계를 표정에 전달. 없으면 발성 모션 미동작
  const speechActivity = options.speechActivity

  let pendingText = ''
  let isPlayerEnabled = true
  let turnStartedAt = 0
  let hasLoggedFirstByte = false
  // 줄 단위 마크다운 상태 — 코드블록 안인지, 연속 목록 구간인지 (턴마다 hardCut에서 리셋)
  let isInsideCodeBlock = false
  let isInListRun = false

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
    /** 이 발화가 끝났을 때 다음이 없으면 발성 종료를 알린다(입 닫힘). 다음이 있으면 유지(깜빡임 방지) */
    const settleAndPump = (): void => {
      if (!settleUtterance()) {
        return
      }
      if (sentenceQueue.length === 0) {
        speechActivity?.setSpeaking(false)
      }
      pumpQueue()
    }
    engine.speak(nextSentence, {
      onStart: () => {
        if (generation !== playbackGeneration) {
          return
        }
        // 실제 소리 시작 = 발성 중(입 벌어짐 시작). 발화마다 알린다.
        speechActivity?.setSpeaking(true)
        if (hasLoggedFirstByte) {
          return
        }
        hasLoggedFirstByte = true
        const elapsedMs = Math.round(performance.now() - turnStartedAt)
        console.log(`[voice.tts] first-byte: ${elapsedMs}ms (턴 시작 기준)`)
      },
      onBoundary: () => {
        if (generation !== playbackGeneration) {
          return
        }
        speechActivity?.markBoundary(performance.now())
      },
      onEnd: settleAndPump,
      onError: (message) => {
        console.error('[voice.tts]:', message)
        // 실패한 문장은 건너뛰고 계속 — 한 문장의 오류가 턴 전체 발화를 막지 않게
        settleAndPump()
      },
    })
  }

  /** 큐에 정리된 발화 1건을 넣고 재생을 펌프한다(이미 읽는 텍스트로 정리된 상태) */
  function enqueueSpeakable(text: string): void {
    if (engine === null || !isPlayerEnabled) {
      return
    }
    sentenceQueue.push(text)
    pumpQueue()
  }

  /**
   * 산문 한 조각을 읽는 텍스트로 정리해 큐에 넣는다 — 화면 자막은 스트림 원본이고
   * 여기서는 합성용만 만든다(R2 단일 스트림 유지). 비면 그 조각은 건너뛴다(기존 동작).
   */
  function enqueueProse(rawText: string): void {
    const speakableText = toSpeakableText(rawText)
    if (!hasSpeakableContent(speakableText)) {
      return
    }
    enqueueSpeakable(speakableText)
  }

  /** 목록/표 구간 시작에서 한 번만 화면 안내 문구를 읽는다(확장자·코드 나열 방지) */
  function announceListOnce(): void {
    if (isInListRun) {
      return
    }
    isInListRun = true
    enqueueSpeakable(LIST_VOICE_SUBSTITUTE)
  }

  /**
   * 완성된 한 줄을 분류해 합성으로 보낸다. 코드블록 안은 통째로 제외하고, 목록·표는
   * 화면 안내로 축약하며, 그 외(제목·인용·일반 산문)는 정리해 읽는다.
   */
  function consumeLine(line: string): void {
    const trimmedLine = line.trim()
    if (isCodeFenceLine(trimmedLine)) {
      isInsideCodeBlock = !isInsideCodeBlock
      isInListRun = false
      return
    }
    if (isInsideCodeBlock) {
      return
    }
    if (trimmedLine.length === 0 || isThematicBreakLine(trimmedLine)) {
      isInListRun = false
      return
    }
    if (isListItemLine(trimmedLine) || isTableRowLine(trimmedLine)) {
      announceListOnce()
      return
    }
    isInListRun = false
    enqueueProse(line)
  }

  /** 버퍼에서 개행까지 완성된 줄들을 떼어 줄 단위로 합성한다 */
  function flushCompletedLines(): void {
    const lastNewlineIndex = pendingText.lastIndexOf('\n')
    if (lastNewlineIndex < 0) {
      return
    }
    const completedBlock = pendingText.slice(0, lastNewlineIndex)
    pendingText = pendingText.slice(lastNewlineIndex + 1)
    for (const line of completedBlock.split('\n')) {
      consumeLine(line)
    }
  }

  /**
   * 미완성 줄이 산문이면 문장 단위로 미리 읽어 TTFB를 확보한다(기획서 §7). 목록·코드·표·
   * 제목 등 구조 줄은 줄이 완성돼야 정확히 분류되므로 개행까지 보류한다.
   */
  function flushProseRemainder(): void {
    if (isInsideCodeBlock || !startsLikeProse(pendingText)) {
      return
    }
    const { sentences, remainder } = extractCompleteSentences(pendingText)
    pendingText = remainder
    sentences.forEach(enqueueProse)
  }

  /** 턴 종료 시 남은 미완성 줄을 줄 분류를 거쳐 마저 합성한다(끝까지 목록/코드면 안 읽음) */
  function flushFinalRemainder(): void {
    const finalLine = pendingText
    pendingText = ''
    if (finalLine.trim().length === 0) {
      return
    }
    consumeLine(finalLine)
  }

  function hardCut(): void {
    pendingText = ''
    // 큐·잠금·세대를 함께 리셋 — 하나라도 남으면 겹쳐 말하거나 큐가 정체된다 (CLAUDE.md §5)
    sentenceQueue = []
    isSpeaking = false
    playbackGeneration += 1
    // 줄 단위 마크다운 상태도 함께 리셋 — 이전 턴의 코드블록/목록 구간이 새 턴으로 새지 않게
    isInsideCodeBlock = false
    isInListRun = false
    // 발성 종료 알림 — 끼어들기·음소거·새 턴 시 입도 즉시 닫힌다(4중 취소 정신, CLAUDE.md §5)
    speechActivity?.setSpeaking(false)
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
        // 완성된 줄을 먼저 줄 단위로 처리하고(목록·코드 정확 분류), 남은 산문은 미리 읽는다
        flushCompletedLines()
        flushProseRemainder()
        return
      }
      case 'turn-end': {
        flushFinalRemainder()
        return
      }
      case 'turn-interrupted':
      case 'error':
        // 끼어들기 하드컷 — 재생·대기열·버퍼를 함께 버린다 (CLAUDE.md §5)
        hardCut()
        return
      case 'emotion':
      case 'emotion-shift':
        // 감정 마커는 발화와 무관 — 표정만 쓴다
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
