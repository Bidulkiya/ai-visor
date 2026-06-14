/**
 * 발표 컨트롤러 (+2 ①) — 본체 바깥에서 본체를 "운전"하는 격리 레이어 (R3, 기획서 원칙 4)
 *
 * 본체와의 유일한 접점:
 * - 입력: sendUserMessage('presentation', text) — Message 주입 (R1 관문 통과)
 * - 출력: 본체의 단일 출력 스트림은 자막·표정·TTS가 이미 구독 중이다 (R2).
 *   컨트롤러는 스트림을 따로 구독하지 않고 턴 결과(Promise)로 진행을 제어한다 —
 *   설명이 끝나면(턴 완료) 다음 슬라이드로 넘긴다.
 * 본체는 이 모듈의 존재를 모른다. 이 폴더를 지워도 본체는 컴파일·동작한다.
 * 감정·기억은 본체를 거치므로 발표 중에도 자동으로 정상 작동한다.
 *
 * 끼어들기(푸시투토크) 흐름: askQuestion → 단계를 'answering'으로 바꾼 뒤
 * interrupt → 진행 중이던 설명 턴이 정착하면 질문을 주입 → 답변 완료 후
 * 현재 슬라이드부터 "이어서" 재개. 단계를 먼저 바꾸는 이유는 설명 루프가
 * 'interrupted' 결과를 봤을 때 누가 끊었는지(질문 vs 종료) 구분하기 위해서다.
 */

import type { SendMessageResult, ToolRuntime } from '../core/session'
import type { SlideDeck } from './slides'
import { researchSlideDeck } from './preResearch'
import { buildAudienceQuestionPrompt, buildSlideExplanationPrompt } from './prompts'

/** 본체에서 컨트롤러가 쓰는 표면 전부 — CompanionSession이 구조적으로 만족한다 */
export interface PresentationSessionPort {
  sendUserMessage(rawSource: unknown, rawText: unknown): Promise<SendMessageResult>
  interrupt(): void
}

export type PresentationStage =
  | { name: 'idle' }
  | { name: 'researching'; completedSlides: number; totalSlides: number }
  | { name: 'presenting'; slideNumber: number }
  | { name: 'answering'; slideNumber: number; question: string }
  | { name: 'finished' }

export interface PresentationView {
  stage: PresentationStage
  deck: SlideDeck | null
  /** 슬라이드 번호 → 사전 조사 요약. 발표 중엔 이 캐시만 쓴다(실시간 검색 없음) */
  researchBySlide: ReadonlyMap<number, string>
  /** 비정상 종료 사유 — 발표가 조용히 사라지지 않게 ui가 표시한다. 정상 흐름은 null */
  stopNotice: string | null
}

export type AskQuestionResult = 'accepted' | 'empty-question' | 'not-presenting' | 'already-answering'

export interface PresentationController {
  getView(): PresentationView
  subscribe(listener: (view: PresentationView) => void): () => void
  /** 사전 조사 → 슬라이드 1부터 자동 진행. 발표가 끝나거나 중단되면 resolve */
  startPresentation(deck: SlideDeck): Promise<void>
  /** 푸시투토크 질문 — 설명을 끊고 답한 뒤 발표로 복귀한다 */
  askQuestion(questionText: string): Promise<AskQuestionResult>
  stopPresentation(): void
}

export interface PresentationControllerOptions {
  session: PresentationSessionPort
  /** 사전 조사용 — null이면 조사 없이 발표만 진행 */
  toolRuntime: ToolRuntime | null
}

/** 발표 턴 사이로 채팅 턴이 끼어든 경우의 재시도 간격·한도 (합계 약 10초) */
const BUSY_RETRY_DELAY_MS = 500
const MAX_BUSY_RETRIES = 20

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/** 턴 실패 종류별 사용자 안내 — 상세 오류는 채팅 에러 말풍선(스트림)이 이미 보여준다 */
function buildTurnFailureNotice(failureStatus: SendMessageResult['status']): string {
  if (failureStatus === 'rejected-busy') {
    return '다른 대화가 계속 진행 중이라 발표를 중단했어요. 잠시 후 다시 시작해 주세요.'
  }
  return '답변 생성에 실패해 발표를 중단했어요. 채팅의 오류 메시지를 확인해 주세요.'
}

export function createPresentationController(
  options: PresentationControllerOptions,
): PresentationController {
  const { session, toolRuntime } = options

  let view: PresentationView = {
    stage: { name: 'idle' },
    deck: null,
    researchBySlide: new Map(),
    stopNotice: null,
  }
  const listeners = new Set<(view: PresentationView) => void>()
  /** 시작·종료마다 증가 — 이전 세대의 비동기 루프가 새 상태를 건드리지 못하게 한다 */
  let runGeneration = 0
  /** 컨트롤러가 띄운 진행 중 턴 — 질문 주입 전 정착 대기용 */
  let activeTurn: Promise<SendMessageResult> | null = null

  /** await 사이에 stage가 바뀔 수 있다 — TS의 클로저 내로잉을 피해 매번 새로 읽는다 */
  function getCurrentStage(): PresentationStage {
    return view.stage
  }

  function setView(partial: Partial<PresentationView>): void {
    view = { ...view, ...partial }
    for (const listener of listeners) {
      try {
        listener(view)
      } catch (error) {
        console.error('[presentation.controller]: 상태 구독자 오류 — 해당 구독자만 건너뜀:', error)
      }
    }
  }

  /** 컨트롤러발 턴을 추적하며 보낸다 — askQuestion이 정착을 기다릴 수 있게 */
  async function sendTrackedMessage(text: string): Promise<SendMessageResult> {
    const turnPromise = session.sendUserMessage('presentation', text)
    activeTurn = turnPromise
    try {
      return await turnPromise
    } finally {
      if (activeTurn === turnPromise) {
        activeTurn = null
      }
    }
  }

  async function settleActiveTurn(): Promise<void> {
    if (activeTurn !== null) {
      await activeTurn.catch(() => undefined)
    }
  }

  /** 채팅 턴과의 충돌(rejected-busy)은 짧게 기다렸다 재시도한다 */
  async function sendWithBusyRetry(text: string, generation: number): Promise<SendMessageResult> {
    for (let attempt = 0; attempt < MAX_BUSY_RETRIES; attempt += 1) {
      const result = await sendTrackedMessage(text)
      if (result.status !== 'rejected-busy' || generation !== runGeneration) {
        return result
      }
      await delay(BUSY_RETRY_DELAY_MS)
    }
    return { status: 'rejected-busy' }
  }

  /**
   * startSlideNumber부터 끝까지 순서대로 설명한다.
   * 각 턴이 완료되면 다음 슬라이드로(자동 진행), 마지막 뒤엔 finished.
   * 'interrupted'는 단계로 원인을 구분한다: answering이면 질문이 끊은 것
   * (복귀는 askQuestion 책임), 아니면 외부 중단으로 보고 발표를 끝낸다.
   */
  async function presentFromSlide(
    startSlideNumber: number,
    generation: number,
    isResumeAfterQuestion: boolean,
  ): Promise<void> {
    const deck = view.deck
    if (deck === null) {
      return
    }
    for (let slideNumber = startSlideNumber; slideNumber <= deck.slides.length; slideNumber += 1) {
      if (generation !== runGeneration || getCurrentStage().name === 'answering') {
        return
      }
      setView({ stage: { name: 'presenting', slideNumber } })
      const slide = deck.slides[slideNumber - 1]
      const researchSummary = view.researchBySlide.get(slideNumber) ?? null
      console.log(
        `[presentation]: 슬라이드 ${slideNumber}/${deck.slides.length} 설명 시작 (조사 캐시 ${researchSummary?.length ?? 0}자)`,
      )
      const prompt = buildSlideExplanationPrompt({
        slide,
        totalSlides: deck.slides.length,
        researchSummary,
        isResumeAfterQuestion: isResumeAfterQuestion && slideNumber === startSlideNumber,
      })
      const result = await sendWithBusyRetry(prompt, generation)
      if (generation !== runGeneration) {
        return
      }
      if (result.status === 'interrupted') {
        if (getCurrentStage().name !== 'answering') {
          console.log('[presentation]: 외부 중단으로 발표 종료')
          stopWithNotice('중단 요청으로 발표를 종료했어요.')
        }
        return
      }
      if (result.status !== 'completed') {
        console.error('[presentation.controller]: 슬라이드 설명 턴 실패 — 발표 중단:', result)
        stopWithNotice(buildTurnFailureNotice(result.status))
        return
      }
    }
    if (generation === runGeneration) {
      setView({ stage: { name: 'finished' } })
    }
  }

  async function startPresentation(deck: SlideDeck): Promise<void> {
    if (view.stage.name !== 'idle' && view.stage.name !== 'finished') {
      console.error('[presentation.controller]: 발표 흐름이 이미 진행 중 — 시작 무시')
      return
    }
    if (deck.slides.length === 0) {
      console.error('[presentation.controller]: 슬라이드가 없는 자료 — 시작 무시')
      return
    }
    runGeneration += 1
    const generation = runGeneration
    setView({
      deck,
      researchBySlide: new Map(),
      stopNotice: null,
      stage: { name: 'researching', completedSlides: 0, totalSlides: deck.slides.length },
    })

    // 사전 조사: 발표 시작 전에 끝낸다 — 발표 중 실시간 검색 없음 (③)
    const researchBySlide = await researchSlideDeck(deck, toolRuntime, {
      onProgress: (progress) => {
        if (generation === runGeneration) {
          setView({ stage: { name: 'researching', ...progress } })
        }
      },
      shouldContinue: () => generation === runGeneration,
    })
    if (generation !== runGeneration) {
      return
    }
    setView({ researchBySlide })
    await presentFromSlide(1, generation, false)
  }

  async function askQuestion(questionText: string): Promise<AskQuestionResult> {
    const question = questionText.trim()
    if (question.length === 0) {
      return 'empty-question'
    }
    if (view.stage.name === 'answering') {
      return 'already-answering'
    }
    if (view.stage.name !== 'presenting') {
      return 'not-presenting'
    }
    const generation = runGeneration
    const slideNumber = view.stage.slideNumber
    const deck = view.deck
    if (deck === null) {
      return 'not-presenting'
    }

    // 단계를 먼저 바꾸고 끊는다 — 설명 루프가 중단 원인을 질문으로 식별하게
    setView({ stage: { name: 'answering', slideNumber, question } })
    session.interrupt()
    await settleActiveTurn()
    if (generation !== runGeneration) {
      return 'accepted'
    }

    const slide = deck.slides[slideNumber - 1]
    const result = await sendWithBusyRetry(
      buildAudienceQuestionPrompt({
        question,
        slide,
        researchSummary: view.researchBySlide.get(slideNumber) ?? null,
      }),
      generation,
    )
    if (generation !== runGeneration) {
      return 'accepted'
    }
    if (result.status === 'completed' || result.status === 'interrupted') {
      // 복귀: 단계를 발표로 되돌린 뒤(루프의 answering 가드 해제) 현재 슬라이드를
      // "이어서"로 재개하고 이후 자동 진행 (답변이 끊겼어도 발표는 잇는다)
      setView({ stage: { name: 'presenting', slideNumber } })
      void presentFromSlide(slideNumber, generation, true)
      return 'accepted'
    }
    console.error('[presentation.controller]: 질문 응답 턴 실패 — 발표 중단:', result)
    stopWithNotice(buildTurnFailureNotice(result.status))
    return 'accepted'
  }

  /** 사용자가 직접 끝낸 정상 종료 — 사유 표시 없음 */
  function stopPresentation(): void {
    stopWithNotice(null)
  }

  /** 비정상 종료는 사유를 남긴다 — 발표가 이유 없이 사라진 것처럼 보이지 않게 */
  function stopWithNotice(stopNotice: string | null): void {
    if (view.stage.name === 'idle') {
      return
    }
    runGeneration += 1
    // 진행 중 설명·답변이 있으면 함께 끊는다 — 유휴면 무해한 no-op
    session.interrupt()
    setView({ stage: { name: 'idle' }, stopNotice })
  }

  function subscribe(listener: (view: PresentationView) => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  return {
    getView: () => view,
    subscribe,
    startPresentation,
    askQuestion,
    stopPresentation,
  }
}
