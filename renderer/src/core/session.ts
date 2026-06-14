/**
 * 대화 세션 조립 — ui가 호출하는 Core의 단일 진입점 (컴포지션 루트)
 *
 * message → engine → llm → stream과 memory를 배선한다.
 * - core는 expression을 모른다 (R3와 같은 방향의 경계) — 표정은 ui가
 *   outputStream에 직접 구독시킨다 (ARCHITECTURE §2).
 * - 세션의 정식 감정 상태(VAD)는 여기서 보유한다: 시작 시 영속값 로드,
 *   emotion 이벤트마다 스무딩 갱신, 종료 시 영속 (ARCHITECTURE §4).
 * - 종료는 persistSessionEnd 단일 진입점으로 — 요약·사실·감정 누락 방지.
 */

import { createConversationEngine, type LlmTurnProvider, type TurnResult } from './engine'
import { createOutputStream, type OutputStream, type Unsubscribe } from './stream'
import { normalizeToMessage } from './message'
import { routeModel } from './router'
import {
  attachAffectionToOutputStream,
  createAffectionTracker,
  type AffectionTracker,
} from './affection'
import {
  createClaudeTurnProvider,
  createFactExtractor,
  createSessionSummarizer,
  type ClaudeProviderConfig,
  type MemoryPromptContext,
  type RuntimeStateContext,
  type ToolRuntime,
} from './llm'

export type { ToolRuntime, ToolSpec, ToolInvocationResult } from './llm'
import { smoothVad } from '../emotion/smoothing'
import { decayVadTowardNeutral } from '../emotion/decay'
import { NEUTRAL_VAD, type VadState } from '../emotion/vad'
import {
  AFFECTION_INITIAL_VALUE,
  openMemoryDatabase,
  type MemoryDatabase,
  type SqliteDriver,
} from '../memory/db'
import { createShortTermMemory } from '../memory/shortTerm'
import {
  createLongTermMemory,
  type LongTermMemory,
  type SessionEndResult,
  type SessionSummarizer,
  type StartupContext,
} from '../memory/longTerm'
import { createFactStore, type FactExtractor, type FactStore } from '../memory/facts'
import { createToolHistoryReader, type ToolHistoryReader } from '../memory/toolHistory'
import { createIpcSqliteDriver, type DatabaseBridge } from '../memory/ipcDriver'

export type SendMessageResult =
  | TurnResult
  /** 입력 정규화 거부 (R1) — reason은 message.ts의 거부 사유 */
  | { status: 'invalid-input'; reason: string }
  | { status: 'not-started' }

export interface CompanionSession {
  /** 자막·표정(ui가 구독시킴)·TTS가 구독할 단일 출력 스트림 (R2) */
  outputStream: OutputStream
  /** DB 열기 + 시작 컨텍스트(요약·복구·첫 실행) 로드 + 영속 감정 이어받기 */
  start(): Promise<StartupContext>
  /** 모든 입력의 관문 — 정규화(R1) 후 엔진 실행 */
  sendUserMessage(rawSource: unknown, rawText: unknown): Promise<SendMessageResult>
  /** 푸시투토크 끼어들기 */
  interrupt(): void
  isTurnActive(): boolean
  getCurrentEmotion(): VadState
  /** 현재 유대도(0~1) — 어투에만 쓰이는 값이다 (R5). 시작 전엔 기본값 */
  getCurrentAffection(): number
  /** 앱 종료: 요약→사실→감정 영속 후 DB 닫기. 멱등(두 번째부터 null) */
  shutdown(): Promise<SessionEndResult | null>
}

export interface CompanionSessionOptions {
  driver: SqliteDriver
  llm: ClaudeProviderConfig
  /** Layer 1 도구 런타임 (ui가 tools/로 조립해 주입) — 없으면 도구 없이 대화만 */
  toolRuntime?: ToolRuntime
  /** 테스트·발표 데모에서 LLM 의존을 교체할 때만 사용 */
  overrides?: {
    llmProvider?: LlmTurnProvider
    summarize?: SessionSummarizer
    extractFacts?: FactExtractor
  }
}

/** 유휴 감쇠 틱 주기 — 이 간격마다 실제 경과 시간만큼 중립으로 끌어당긴다 */
const DECAY_TICK_INTERVAL_MS = 5000

export function createCompanionSession(options: CompanionSessionOptions): CompanionSession {
  const outputStream = createOutputStream()
  const shortTerm = createShortTermMemory()

  let database: MemoryDatabase | null = null
  let longTerm: LongTermMemory | null = null
  let factStore: FactStore | null = null
  let toolHistory: ToolHistoryReader | null = null
  let currentEmotion: VadState = NEUTRAL_VAD
  let isShutdownCompleted = false
  /** 진행 중인 턴 — shutdown이 영속 전에 정착을 기다리기 위해 추적한다 */
  let activeTurnPromise: Promise<TurnResult> | null = null
  /** affection(+1) — 턴마다 갱신·영속되고 어투 지시로만 쓰인다 (R5) */
  let affectionTracker: AffectionTracker | null = null
  let detachAffection: Unsubscribe | null = null
  /** 기억 0의 첫 실행 여부 — start()에서 확정, 자기상태 주입에 쓰인다 */
  let isFirstRunSession = false

  // 세션의 정식 감정 상태 — engine이 발행한 원시 VAD를 스무딩해 보유 (CLAUDE.md §2)
  outputStream.subscribe((event) => {
    if (event.type === 'emotion') {
      currentEmotion = smoothVad(currentEmotion, event.vad)
    }
  })

  /** 도구 맥락에 줄 최근 작업 건수 — 너무 많으면 프롬프트가 비대해진다 */
  const RECENT_TOOL_OPERATIONS_LIMIT = 6

  async function loadMemoryContext(): Promise<MemoryPromptContext> {
    if (longTerm === null || factStore === null) {
      return { summary: null, facts: [], recentToolOperations: [] }
    }
    // 도구 이력은 보조 맥락 — 없거나 실패해도(reader null·빈 로그) 기억은 정상 로드된다
    const recentOperationsPromise =
      toolHistory !== null
        ? toolHistory.getRecentOperations(RECENT_TOOL_OPERATIONS_LIMIT)
        : Promise.resolve([])
    const [startupContext, facts, recentToolOperations] = await Promise.all([
      longTerm.loadStartupContext(),
      factStore.getAllFacts(),
      recentOperationsPromise,
    ])
    return { summary: startupContext.latestSummary, facts, recentToolOperations }
  }

  /**
   * 자기상태 스냅샷 (감정 인지 루프 닫기): 직전 턴까지의 정식 감정(스무딩·감쇠 반영),
   * 유대 수치·구간, 이번 세션 턴 수, 첫 실행 여부. 시스템 프롬프트 표시에만 쓰인다 (R5).
   */
  function getRuntimeState(): RuntimeStateContext {
    return {
      emotion: currentEmotion,
      affection:
        affectionTracker !== null
          ? { value: affectionTracker.getAffection(), tier: affectionTracker.getToneTier() }
          : null,
      sessionTurnCount: shortTerm.getTurnCount(),
      isFirstRun: isFirstRunSession,
    }
  }

  // 경량 모델 라우팅은 기본 활성 — 호출자가 routeModel을 넘기면 그쪽을 쓴다
  const llmProvider =
    options.overrides?.llmProvider ??
    createClaudeTurnProvider({
      routeModel,
      ...options.llm,
      loadMemoryContext,
      toolRuntime: options.toolRuntime,
      getRuntimeState,
    })
  const summarize = options.overrides?.summarize ?? createSessionSummarizer(options.llm)
  const extractFacts = options.overrides?.extractFacts ?? createFactExtractor(options.llm)

  let engine: ReturnType<typeof createConversationEngine> | null = null
  let decayTimerId: ReturnType<typeof setInterval> | null = null
  let lastDecayAt = 0

  /**
   * 유휴 감쇠 (CLAUDE.md §2): 대화 없는 동안 정식 감정을 중립으로 끌어당긴다.
   * 턴 진행 중에는 감쇠를 멈추고 기준점만 갱신해, 대화에 쓴 시간이
   * 유휴 시간으로 계산되지 않게 한다 — 턴이 끝나면 자동으로 재개되는 셈이다.
   */
  function startIdleDecay(): void {
    if (decayTimerId !== null) {
      return
    }
    lastDecayAt = Date.now()
    decayTimerId = setInterval(() => {
      const now = Date.now()
      if (engine !== null && engine.isTurnActive()) {
        lastDecayAt = now
        return
      }
      currentEmotion = decayVadTowardNeutral(currentEmotion, now - lastDecayAt)
      lastDecayAt = now
    }, DECAY_TICK_INTERVAL_MS)
  }

  function stopIdleDecay(): void {
    if (decayTimerId !== null) {
      clearInterval(decayTimerId)
      decayTimerId = null
    }
  }

  async function start(): Promise<StartupContext> {
    if (database === null) {
      database = await openMemoryDatabase(options.driver)
      longTerm = createLongTermMemory(database, summarize)
      factStore = createFactStore(database)
      toolHistory = createToolHistoryReader(database)
      engine = createConversationEngine(llmProvider, outputStream, { shortTerm, longTerm })
      currentEmotion = await longTerm.loadEmotionState()
      // 유대도: 영속값 이어받기 + 턴 단위 갱신 구독 (어투에만 반영 — R5)
      affectionTracker = createAffectionTracker(database)
      await affectionTracker.load()
      detachAffection = attachAffectionToOutputStream(affectionTracker, outputStream)
      startIdleDecay()
    }
    if (longTerm === null) {
      throw new Error('세션 초기화에 실패했습니다')
    }
    const startupContext = await longTerm.loadStartupContext()
    isFirstRunSession = startupContext.isFirstRun
    return startupContext
  }

  async function sendUserMessage(rawSource: unknown, rawText: unknown): Promise<SendMessageResult> {
    if (engine === null) {
      return { status: 'not-started' }
    }
    const normalized = normalizeToMessage(rawSource, rawText)
    if (!normalized.isValid) {
      return { status: 'invalid-input', reason: normalized.reason }
    }
    const turnPromise = engine.runTurn(normalized.message)
    activeTurnPromise = turnPromise
    try {
      return await turnPromise
    } finally {
      if (activeTurnPromise === turnPromise) {
        activeTurnPromise = null
      }
    }
  }

  async function shutdown(): Promise<SessionEndResult | null> {
    if (isShutdownCompleted || database === null || longTerm === null || factStore === null) {
      return null
    }
    isShutdownCompleted = true
    stopIdleDecay()
    // 진행 중인 턴이 있으면 끊고, 기록까지 정착한 뒤 영속을 시작한다 —
    // 스트리밍 중 LLM 호출과 요약 호출이 경쟁하거나 부분 답변이 누락되는 것을 방지
    if (engine !== null && engine.isTurnActive()) {
      engine.interrupt()
    }
    if (activeTurnPromise !== null) {
      await activeTurnPromise.catch(() => undefined)
    }
    // 턴이 정착한 뒤 유대도 구독 해지 — 닫힌 DB로의 늦은 쓰기 방지
    detachAffection?.()
    detachAffection = null
    // 유대도 최종 플러시 — 마지막 턴의 쓰기가 일시 실패했어도 현재 값을 남긴다 (throw 안 함)
    if (affectionTracker !== null) {
      await affectionTracker.persist()
    }
    const result = await longTerm.persistSessionEnd({
      shortTerm,
      factStore,
      extractFacts,
      emotionState: currentEmotion,
    })
    try {
      await database.close()
    } catch (error) {
      console.error('[session.shutdown]: DB 닫기 실패 (영속은 완료됨):', error)
    }
    return result
  }

  return {
    outputStream,
    start,
    sendUserMessage,
    interrupt: () => engine?.interrupt(),
    isTurnActive: () => engine?.isTurnActive() ?? false,
    getCurrentEmotion: () => currentEmotion,
    getCurrentAffection: () => affectionTracker?.getAffection() ?? AFFECTION_INITIAL_VALUE,
    shutdown,
  }
}

/** preload가 노출하는 종료 훅 모양 (electron/preload.ts와 거울 동기) */
export interface AppLifecycleBridge {
  onAppWillQuit(listener: () => void): void
  notifyQuitReady(): void
}

/** preload 브리지 전체 중 세션 조립에 필요한 부분 (electron/preload.ts와 거울 동기) */
interface PreloadBridge extends AppLifecycleBridge {
  database: DatabaseBridge
}

function getPreloadBridge(): PreloadBridge | null {
  const bridgeHost = globalThis as { aiVisor?: PreloadBridge }
  return bridgeHost.aiVisor ?? null
}

export interface ConnectSessionOptions {
  /**
   * R7: 키는 코드/번들 어디에도 없다 — 사용자가 설정 UI에서 입력한 값을
   * 런타임에 조회하는 함수를 ui가 주입한다. core는 저장 방식을 모른다.
   */
  getApiKey: () => string | null
  /** Layer 1 도구 런타임 — ui가 tools/(게이트·감사 포함)로 조립해 주입 */
  toolRuntime?: ToolRuntime
}

export type ConnectSessionResult =
  | { status: 'connected'; session: CompanionSession; startup: StartupContext }
  /** Electron 밖(순수 브라우저)에서 열림 — preload 브리지 없음 */
  | { status: 'no-bridge' }

/**
 * ui가 호출하는 조립 진입점: preload 브리지 → IPC 드라이버 → 세션 생성 →
 * 종료 영속 훅 등록 → 시작(요약 로드)까지 한 번에.
 */
export async function connectCompanionSession(
  connectOptions: ConnectSessionOptions,
): Promise<ConnectSessionResult> {
  const bridge = getPreloadBridge()
  if (bridge === null) {
    return { status: 'no-bridge' }
  }

  const session = createCompanionSession({
    driver: createIpcSqliteDriver(bridge.database),
    llm: { getApiKey: connectOptions.getApiKey },
    toolRuntime: connectOptions.toolRuntime,
  })
  attachQuitPersistence(session, bridge)
  const startup = await session.start()
  return { status: 'connected', session, startup }
}

/**
 * 창 닫기 → 기억 영속 → 종료 허용 배선.
 * 영속이 실패해도 종료는 막지 않는다 (메인의 타임아웃과 이중 안전장치).
 */
export function attachQuitPersistence(session: CompanionSession, bridge: AppLifecycleBridge): void {
  bridge.onAppWillQuit(() => {
    void session
      .shutdown()
      .catch((error: unknown) => {
        console.error('[session.attachQuitPersistence]: 종료 영속 실패:', error)
      })
      .finally(() => {
        bridge.notifyQuitReady()
      })
  })
}
