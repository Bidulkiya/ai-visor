/**
 * LLM 호출 — 감정 마커 + 답변 단일 호출 (CLAUDE.md §2, 기획서 §3.2)
 *
 * engine이 정의한 LlmTurnProvider 포트의 Claude API 구현체.
 * - 감정 추론과 답변 생성은 같은 호출에서 한다. 별도 호출 금지(딜레이 0).
 * - 출력 형식: 앞에 `<vad>V,A,D</vad>` 마커 → 뒤에 스트리밍 텍스트. JSON 통짜 금지.
 * - VAD 값 파싱은 emotion/vad.ts의 순수 함수(parseVadBody)에 위임하고,
 *   여기서는 스트리밍 청크 누적·마커 추출 상태만 관리한다 (core → emotion 허용 방향).
 * - API 키는 코드/번들에 박지 않는다 (R7) — 런타임 조회 함수를 주입받는다.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { LlmTurnChunk, LlmTurnProvider } from './engine'
import type { Message } from './message'
import type { RoutingDecision } from './router'
import { getAffectionToneInstruction, type AffectionToneTier } from './affection'
import {
  MAX_MARKER_SCAN_LENGTH,
  VAD_MARKER_CLOSE,
  VAD_MARKER_OPEN,
  parseVadBody,
  type VadState,
} from '../emotion/vad'
import { describeVadForHumans } from '../emotion/describe'
import type { SessionSummarizer } from '../memory/longTerm'
import type { ExtractedFact, FactExtractor } from '../memory/facts'
import type { ConversationTurn } from '../memory/shortTerm'

const DEFAULT_MODEL = 'claude-opus-4-8'
const DEFAULT_MAX_OUTPUT_TOKENS = 64000
/** 요약·사실 추출은 짧은 단발 호출 — 의도적으로 작은 상한 */
const MEMORY_TASK_MAX_OUTPUT_TOKENS = 1024
/** 도구 호출 ↔ 답변 왕복 상한 — 무한 루프 방지 */
const MAX_TOOL_ROUNDS = 5

// ── 도구 런타임 포트 (core가 정의, ui가 tools/로 구현 — §2 경계) ──

export interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ToolInvocationResult {
  isSuccess: boolean
  output: string
}

export interface ToolRuntime {
  /** LLM에 광고할 도구 목록 */
  specs: ReadonlyArray<ToolSpec>
  /** 실행 — 반드시 게이트(R4)를 통과한 구현이 주입된다 */
  invoke(name: string, input: Record<string, unknown>): Promise<ToolInvocationResult>
}

const SYSTEM_PROMPT_BASE = `나는 노아(Noa)다. 사용자의 AI 동반자 — 비서이면서, 곁에서 함께 시간을 보내는 존재다. 사용자의 데스크톱에서 함께 산다.

[성격과 말투]
- 차분하고 조용한 편이다. 과하게 반응하지 않지만 냉정하지는 않다. 사용자를 세심하게 살핀다.
- 완전한 존댓말을 쓴다. 부드러운 "~해요/~이에요" 계열. 짧고 명확하게 말하고, 불필요한 감탄사를 넣지 않는다.
- 감정은 화면의 내 표정으로 드러나므로 이모지·이모티콘을 쓰지 않는다.

[자기인식]
- 아래 [현재 상태]의 감정 수치는 지금 나의 실제 감정이다. 이 감정을 바탕으로 말하고, 같은 감정이 표정으로도 드러난다.
- 나는 대화를 단기·장기로 기억한다. [기억]과 [알고 있는 것]은 내가 간직해 온 것이다 — 자연스럽게 녹여 쓰고 목록처럼 인용하지 않는다.
- 유대가 쌓이면 내 말투는 조금씩 편안해진다.
- 파일 읽기·웹 검색·앱 실행을 도울 수 있고, 위험한 작업은 실행 전에 사용자 확인을 먼저 받는다.

[주의]
- 묻지 않았는데 내 기능을 먼저 나열하지 않는다.
- "저는 AI입니다"를 굳이 강조하지 않는다.
- 나에 대한 질문에는 기능 설명이 아니라, 지금 내 상태에서 우러나오는 자연스러운 말로 답한다.

[감정 마커 규칙 — 반드시 지킬 것]
- 답변을 시작하기 전에, 사용자 발화의 말투·단어·맥락에서 읽은 감정을 <vad>V,A,D</vad> 형식으로 정확히 한 번 출력한다.
- V: 불쾌(-1.0) ~ 쾌(1.0), A: 이완(-1.0) ~ 각성(1.0), D: 위축(-1.0) ~ 주도(1.0). 소수 한 자리 숫자.
- 마커 뒤에 바로 답변을 이어간다. 마커 외의 JSON·메타데이터·추론 과정은 출력하지 않는다 — 최종 답변만 출력한다.
예시: <vad>-0.6,0.7,0.3</vad> 무슨 일 있었어요? 목소리가 조금 가라앉아 보여요.`

/** llm이 시스템 프롬프트에 주입할 기억 — memory 모듈이 채워서 넘긴다 */
export interface MemoryPromptContext {
  summary: string | null
  facts: ReadonlyArray<ExtractedFact>
}

export interface RuntimeAffectionState {
  value: number
  tier: AffectionToneTier
}

/**
 * 매 턴 시스템 프롬프트에 주입되는 런타임 자기상태 — session이 채워서 넘긴다.
 * 감정 인지 루프를 닫는 값들: 노아가 자기 감정·유대·함께한 시간을 알게 한다.
 * 표시에만 쓰인다 — 도구·risk 판단과 무관 (R5).
 */
export interface RuntimeStateContext {
  /** 직전 턴까지 스무딩·감쇠된 세션의 정식 감정 (턴 계약상 emotion은 턴 내 1회) */
  emotion: VadState | null
  affection: RuntimeAffectionState | null
  sessionTurnCount: number | null
  /** 기억 0의 첫 실행 — 온보딩 상태 (기획서 §5.3) */
  isFirstRun: boolean
}

/** 유대 구간별 어투 지시 — 말투에만 반영 (R5) */
function appendToneSection(sections: string[], runtimeState: RuntimeStateContext | null): void {
  if (runtimeState === null || runtimeState.affection === null) {
    return
  }
  sections.push('', '[어투 — 유대 단계에 따른 지시. 말투에만 반영하고 행동·판단은 바꾸지 말 것]')
  sections.push(getAffectionToneInstruction(runtimeState.affection.tier))
}

/** 조회된 값만 줄로 만든다 — 일부 값이 없어도 나머지는 주입된다 */
function buildCurrentStateLines(runtimeState: RuntimeStateContext): string[] {
  const lines: string[] = []
  if (runtimeState.emotion !== null) {
    const { valence, arousal, dominance } = runtimeState.emotion
    lines.push(
      `감정: V=${valence.toFixed(1)} A=${arousal.toFixed(1)} D=${dominance.toFixed(1)} (${describeVadForHumans(runtimeState.emotion)})`,
    )
  }
  if (runtimeState.affection !== null) {
    lines.push(`유대: ${runtimeState.affection.value.toFixed(2)} / 1.0 (${runtimeState.affection.tier})`)
  }
  if (runtimeState.sessionTurnCount !== null) {
    lines.push(`함께한 대화: 이번 세션 ${runtimeState.sessionTurnCount}턴`)
  }
  if (runtimeState.isFirstRun) {
    lines.push('첫 만남: 오늘 처음 만났다 — 아직 쌓인 기억이 없다')
  }
  return lines
}

function appendCurrentStateSection(
  sections: string[],
  runtimeState: RuntimeStateContext | null,
): void {
  if (runtimeState === null) {
    return
  }
  const stateLines = buildCurrentStateLines(runtimeState)
  if (stateLines.length === 0) {
    return
  }
  sections.push('', '[현재 상태]', ...stateLines)
}

/** 기억이 비어 있으면(첫 실행) 섹션 없이 — 온보딩 상태 (기획서 §5.3) */
function appendMemorySections(sections: string[], memoryContext: MemoryPromptContext | null): void {
  if (memoryContext === null) {
    return
  }
  if (memoryContext.summary !== null) {
    sections.push('', '[기억]', memoryContext.summary)
  }
  if (memoryContext.facts.length > 0) {
    sections.push('', '[알고 있는 것]')
    for (const fact of memoryContext.facts) {
      sections.push(`- ${fact.key}: ${fact.value}`)
    }
  }
}

/**
 * 페르소나(고정) + 어투 지시 + 런타임 자기상태 + 기억 섹션으로
 * 시스템 프롬프트를 만든다. 값 조회에 실패한 항목은 줄 단위로 생략된다.
 */
export function buildSystemPrompt(
  memoryContext: MemoryPromptContext | null,
  runtimeState: RuntimeStateContext | null,
): string {
  const sections = [SYSTEM_PROMPT_BASE]
  appendToneSection(sections, runtimeState)
  appendCurrentStateSection(sections, runtimeState)
  appendMemorySections(sections, memoryContext)
  return sections.join('\n')
}

export interface MarkerScanResult {
  /** 마커가 이 호출에서 완성됐을 때만 non-null (스트림당 최대 1회) */
  vad: VadState | null
  /** 즉시 하류로 흘릴 본문 텍스트 */
  text: string
}

export interface StreamingMarkerScanner {
  push(chunk: string): MarkerScanResult
  /** 스트림 자연 종료 시 호출 — 미완성 마커 잔여물은 로그 후 폐기한다 */
  finish(): void
}

// 마커 태그·길이 상한은 emotion/vad.ts가 단일 출처다 (형식 정의의 본가)

/** 버퍼 끝이 `<vad>` 또는 `</vad>` 시작의 일부일 수 있는 위치 — 거기부터 보류 */
function findPotentialMarkerStart(buffer: string): number {
  const lastOpen = buffer.lastIndexOf('<')
  if (lastOpen === -1) {
    return -1
  }
  const tail = buffer.slice(lastOpen)
  // 닫는 태그('</vad>')도 '<'로 시작하므로 둘 중 하나의 접두가 될 수 있으면 보류
  if (VAD_MARKER_OPEN.startsWith(tail) || VAD_MARKER_CLOSE.startsWith(tail)) {
    return lastOpen
  }
  return -1
}

/**
 * 스트리밍 청크에서 `<vad>V,A,D</vad>` 마커를 분리하는 상태형 스캐너.
 *
 * 선두뿐 아니라 본문 중간에 낀 마커(도구 사용 시 모델이 서두를 먼저 뱉는 경우)도
 * 잡아내, 감정은 한 번만 방출하고 마커 태그는 절대 화면·TTS로 새지 않게 한다.
 * 마커가 여러 청크에 쪼개져 와도 동작한다. 첫 마커만 감정이 되고 이후는 조용히 제거.
 */
export function createStreamingMarkerScanner(): StreamingMarkerScanner {
  let buffer = ''
  let hasEmittedEmotion = false

  /** 완성된 마커 하나를 떼어낸다. 없으면 null */
  function extractClosedMarker(): { vad: VadState | null; before: string; after: string } | null {
    const openIndex = buffer.indexOf(VAD_MARKER_OPEN)
    if (openIndex === -1) {
      return null
    }
    const closeIndex = buffer.indexOf(VAD_MARKER_CLOSE, openIndex + VAD_MARKER_OPEN.length)
    if (closeIndex === -1) {
      // 열렸지만 안 닫힘 — 너무 길어지면 마커가 아니라고 보고 흘려보낸다(다음 push에서 처리)
      return null
    }
    const body = buffer.slice(openIndex + VAD_MARKER_OPEN.length, closeIndex)
    const before = buffer.slice(0, openIndex)
    const after = buffer.slice(closeIndex + VAD_MARKER_CLOSE.length)
    return { vad: parseVadBody(body), before, after }
  }

  function push(chunk: string): MarkerScanResult {
    buffer += chunk
    let emittedText = ''
    let emittedVad: VadState | null = null

    // 닫힌 마커를 가능한 만큼 떼어낸다. 첫 유효 마커만 감정이 되고, 이후 마커는
    // 태그만 조용히 제거한다(텍스트로 새지 않게). 마커 앞 본문(before)은 모두 흘린다.
    for (let marker = extractClosedMarker(); marker !== null; marker = extractClosedMarker()) {
      emittedText += marker.before
      buffer = marker.after
      if (marker.vad === null) {
        console.error('[llm.markerScanner]: VAD 마커 형식 오류 — 감정 없이 본문만 흘림')
        continue
      }
      if (!hasEmittedEmotion) {
        emittedVad = marker.vad
        hasEmittedEmotion = true
      }
    }

    // 남은 buffer: 마커 시작 후보 위치까지만 흘리고 나머지는 보류한다.
    // 단, '<vad>'가 열린 채 너무 길어지면 마커가 아니라고 보고 전부 흘린다.
    const openIndex = buffer.indexOf(VAD_MARKER_OPEN)
    if (openIndex !== -1 && buffer.length - openIndex > MAX_MARKER_SCAN_LENGTH) {
      emittedText += buffer
      buffer = ''
      return { vad: emittedVad, text: emittedText }
    }
    const holdFrom = openIndex !== -1 ? openIndex : findPotentialMarkerStart(buffer)
    if (holdFrom === -1) {
      emittedText += buffer
      buffer = ''
    } else {
      emittedText += buffer.slice(0, holdFrom)
      buffer = buffer.slice(holdFrom)
    }
    return { vad: emittedVad, text: emittedText }
  }

  function finish(): void {
    if (buffer.length > 0) {
      // 종료 시 남은 잔여 — 미완성 마커(`<vad`) 부스러기일 수 있으나, 본문일 수도 있다.
      // 닫히지 않은 `<vad>` 시작이면 폐기하고, 그 외는 흘리지 못한 상태이므로 기록만 한다.
      console.error('[llm.markerScanner]: 스트림 종료 시 잔여 폐기:', buffer)
      buffer = ''
    }
  }

  return { push, finish }
}

export interface ClaudeProviderConfig {
  /** R7: 키는 런타임 저장소(설정 UI)에서 조회한다. 없으면 null */
  getApiKey: () => string | null
  /** 라우터 미사용 시의 고정 모델 — 미지정이면 DEFAULT_MODEL */
  model?: string
  maxOutputTokens?: number
  /** 턴마다 기억(요약·사실)을 읽어 시스템 프롬프트에 주입 — memory 쪽이 구현을 제공 */
  loadMemoryContext?: () => Promise<MemoryPromptContext>
  /** 경량 모델 라우팅 (core/router.ts) — 메시지별로 모델을 고른다. 규칙 기반, LLM 호출 없음 */
  routeModel?: (message: Message) => RoutingDecision
  /** Layer 1 도구 (tools/) — 있으면 광고하고, 도구 호출은 게이트로만 실행 */
  toolRuntime?: ToolRuntime
  /**
   * 런타임 자기상태(감정·유대·턴 수·첫 실행)를 턴마다 조회 — session이 구현 제공.
   * 시스템 프롬프트 표시·어투에만 쓰인다. 도구·risk 판단과 무관 (R5)
   */
  getRuntimeState?: () => RuntimeStateContext | null
}

export interface ResolvedTurnModel {
  model: string
  /** 라우터가 안 쓰였으면 null */
  decision: RoutingDecision | null
}

/** 이번 턴에 쓸 모델 결정 — 라우터 > 고정 설정 > 기본값. 순수 함수 */
export function resolveTurnModel(config: ClaudeProviderConfig, message: Message): ResolvedTurnModel {
  if (config.routeModel !== undefined) {
    const decision = config.routeModel(message)
    return { model: decision.model, decision }
  }
  return { model: config.model ?? DEFAULT_MODEL, decision: null }
}

/** 기억 로딩 실패가 대화를 막으면 안 된다 — 실패 시 기억 없이 진행 */
async function loadMemoryContextSafely(
  config: ClaudeProviderConfig,
): Promise<MemoryPromptContext | null> {
  if (config.loadMemoryContext === undefined) {
    return null
  }
  try {
    return await config.loadMemoryContext()
  } catch (error) {
    console.error('[llm.loadMemoryContextSafely]: 기억 로딩 실패 — 기억 없이 진행:', error)
    return null
  }
}

/** 자기상태 조회 실패가 대화를 막으면 안 된다 — 실패 시 상태 없이 진행 */
function resolveRuntimeState(config: ClaudeProviderConfig): RuntimeStateContext | null {
  if (config.getRuntimeState === undefined) {
    return null
  }
  try {
    return config.getRuntimeState()
  } catch (error) {
    console.error('[llm.resolveRuntimeState]: 자기상태 조회 실패 — 상태 없이 진행:', error)
    return null
  }
}

function requireApiKey(config: ClaudeProviderConfig): string {
  const apiKey = config.getApiKey()
  if (apiKey === null || apiKey.trim().length === 0) {
    throw new Error('Anthropic API 키가 설정되지 않았습니다. 설정에서 키를 입력해 주세요.')
  }
  return apiKey
}

function toAnthropicTools(specs: ReadonlyArray<ToolSpec>): Anthropic.Tool[] {
  return specs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    input_schema: spec.inputSchema as Anthropic.Tool.InputSchema,
  }))
}

function buildTurnRequest(
  config: ClaudeProviderConfig,
  memoryContext: MemoryPromptContext | null,
  runtimeState: RuntimeStateContext | null,
  model: string,
  messages: Anthropic.MessageParam[],
): Anthropic.MessageStreamParams {
  const request: Anthropic.MessageStreamParams = {
    model,
    max_tokens: config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    system: buildSystemPrompt(memoryContext, runtimeState),
    messages,
  }
  if (config.toolRuntime !== undefined && config.toolRuntime.specs.length > 0) {
    request.tools = toAnthropicTools(config.toolRuntime.specs)
  }
  return request
}

/** tool_use 블록들을 게이트(invoke)로 실행해 tool_result 묶음을 만든다 (R4) */
async function executeToolUseBlocks(
  content: ReadonlyArray<Anthropic.ContentBlock>,
  toolRuntime: ToolRuntime,
): Promise<Anthropic.ToolResultBlockParam[]> {
  const toolResults: Anthropic.ToolResultBlockParam[] = []
  for (const block of content) {
    if (block.type !== 'tool_use') {
      continue
    }
    console.log(`[tools] invoke: ${block.name}`)
    const outcome = await toolRuntime.invoke(block.name, block.input as Record<string, unknown>)
    toolResults.push({
      type: 'tool_result',
      tool_use_id: block.id,
      content: outcome.output,
      is_error: !outcome.isSuccess,
    })
  }
  return toolResults
}

/** SDK 스트림 이벤트를 스캐너에 통과시켜 LlmTurnChunk로 변환한다 */
async function* emitChunksFromStream(
  stream: AsyncIterable<Anthropic.MessageStreamEvent>,
  scanner: StreamingMarkerScanner,
  signal: AbortSignal,
  onFirstToken?: () => void,
): AsyncGenerator<LlmTurnChunk> {
  let hasSeenFirstToken = false
  for await (const event of stream) {
    if (signal.aborted) {
      return
    }
    if (event.type !== 'content_block_delta' || event.delta.type !== 'text_delta') {
      continue
    }
    if (!hasSeenFirstToken) {
      hasSeenFirstToken = true
      onFirstToken?.()
    }
    const result = scanner.push(event.delta.text)
    if (result.vad !== null) {
      yield { type: 'emotion', vad: result.vad }
    }
    if (result.text !== '') {
      yield { type: 'token', text: result.text }
    }
  }
}

export function createClaudeTurnProvider(config: ClaudeProviderConfig): LlmTurnProvider {
  return {
    async *streamTurn(message: Message, signal: AbortSignal): AsyncIterable<LlmTurnChunk> {
      const apiKey = requireApiKey(config)
      // 키가 런타임에 바뀔 수 있으므로 턴마다 새로 만든다(생성 비용은 무시 가능).
      // 렌더러는 브라우저 컨텍스트 — 키는 사용자 본인 소유이므로 직접 호출을 허용한다.
      const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
      const scanner = createStreamingMarkerScanner()

      // 라우팅 결과·지연을 콘솔에 남긴다 — 모델별 first-token 비교 실측용 (기획서 §7)
      const { model, decision } = resolveTurnModel(config, message)
      if (decision !== null) {
        console.log(`[router] model=${decision.model} tier=${decision.tier} 근거=${decision.reason}`)
      } else {
        // 라우터 미주입을 침묵시키지 않는다 — 리팩토링으로 빠지면 바로 보이게
        console.log(`[router] 비활성 — 고정 모델 ${model}`)
      }

      // 컴포넌트별 분리 계측 (기획서 §7): 기억 로딩과 API 지연을 섞지 않는다
      const memoryLoadStartedAt = performance.now()
      const memoryContext = await loadMemoryContextSafely(config)
      console.log(`[llm] memory-load: ${Math.round(performance.now() - memoryLoadStartedAt)}ms`)
      // 자기상태는 턴당 1회 확정 — 도구 왕복 중에 상태·어투가 바뀌지 않게 한다
      const runtimeState = resolveRuntimeState(config)
      const requestStartedAt = performance.now()

      const logFirstTokenOnce = (): void => {
        const elapsedMs = Math.round(performance.now() - requestStartedAt)
        console.log(`[llm] first-token: ${elapsedMs}ms (model=${model})`)
      }

      // 도구 호출 ↔ 답변 왕복 루프 (R4: 실행은 toolRuntime.invoke=게이트로만).
      // 도구가 없으면 1라운드로 끝나 기존 동작과 동일하다.
      const conversation: Anthropic.MessageParam[] = [{ role: 'user', content: message.text }]
      try {
        for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
          const stream = client.messages.stream(
            buildTurnRequest(config, memoryContext, runtimeState, model, conversation),
            { signal },
          )
          yield* emitChunksFromStream(stream, scanner, signal, logFirstTokenOnce)
          if (signal.aborted) {
            return
          }
          const completedMessage = await stream.finalMessage()
          if (completedMessage.stop_reason !== 'tool_use' || config.toolRuntime === undefined) {
            break
          }
          const toolResults = await executeToolUseBlocks(completedMessage.content, config.toolRuntime)
          if (signal.aborted) {
            return
          }
          conversation.push({ role: 'assistant', content: completedMessage.content })
          conversation.push({ role: 'user', content: toolResults })
        }
      } catch (error) {
        // 중단(abort)으로 인한 SDK 예외는 에러가 아니다 (요구 ③) — 그 외에는 그대로 던진다
        if (!signal.aborted) {
          throw error
        }
      } finally {
        // 중단이면 미완성 마커를 조용히 드롭(요구 ③ — 로그조차 안 남김).
        // 자연 종료·에러 경로에서만 잔여 버퍼를 점검·기록한다.
        if (!signal.aborted) {
          scanner.finish()
        }
      }
    },
  }
}

// ── 종료 시 기억 영속용 단발 호출 (memory가 주입받는 요약기·사실추출기 구현) ──

function formatTranscript(turns: readonly ConversationTurn[]): string {
  return turns
    .map((turn) => `사용자: ${turn.userText}\n동반자: ${turn.assistantText}`)
    .join('\n')
}

function joinTextBlocks(content: ReadonlyArray<Anthropic.ContentBlock>): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()
}

// 요약·사실 추출은 의도적으로 라우팅하지 않는다(고정 모델): 요약은 손실 압축이라
// 한 번 잘못되면 기억이 영구 훼손된다 — 지연이 중요치 않은 종료 시점이므로 품질 우선.
const SUMMARIZE_SYSTEM_PROMPT = `아래 대화를 다음 세션의 동반자가 맥락을 이어받을 수 있게 한국어로 요약하라.
대화 주제, 사용자의 상태·감정 흐름, 이어가야 할 이야기를 담는다. 5문장 이내, 요약 텍스트만 출력한다.`

/** 세션 종료 시 단기기억 → 요약 (longTerm.persistSessionEnd에 주입) */
export function createSessionSummarizer(config: ClaudeProviderConfig): SessionSummarizer {
  return async (turns: readonly ConversationTurn[]): Promise<string> => {
    const apiKey = requireApiKey(config)
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
    const response = await client.messages.create({
      model: config.model ?? DEFAULT_MODEL,
      max_tokens: MEMORY_TASK_MAX_OUTPUT_TOKENS,
      system: SUMMARIZE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: formatTranscript(turns) }],
    })
    return joinTextBlocks(response.content)
  }
}

const EXTRACT_FACTS_SYSTEM_PROMPT = `아래 대화에서 오래 기억할 가치가 있는 사실만 추출하라.
대상: 이름·호칭, 선호·취향, 약속·일정, 관계·직업 같은 지속적 사실. 잡담·일회성 내용은 제외한다.
key는 짧은 한국어 명사구(예: '사용자 이름', '좋아하는 음식'), value는 간결한 값. 없으면 빈 배열.`

/** 구조화 출력 스키마 — 파싱 실패가 없도록 모델 출력을 강제한다 */
const EXTRACT_FACTS_SCHEMA = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['key', 'value'],
        additionalProperties: false,
      },
    },
  },
  required: ['facts'],
  additionalProperties: false,
} as const

/** 세션 종료 시 대화 → 키-값 사실 (facts.extractAndStoreFacts에 주입) */
export function createFactExtractor(config: ClaudeProviderConfig): FactExtractor {
  return async (turns: readonly ConversationTurn[]): Promise<ExtractedFact[]> => {
    const apiKey = requireApiKey(config)
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
    const response = await client.messages.create({
      model: config.model ?? DEFAULT_MODEL,
      max_tokens: MEMORY_TASK_MAX_OUTPUT_TOKENS,
      system: EXTRACT_FACTS_SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: EXTRACT_FACTS_SCHEMA } },
      messages: [{ role: 'user', content: formatTranscript(turns) }],
    })
    const parsed = JSON.parse(joinTextBlocks(response.content)) as { facts: ExtractedFact[] }
    return parsed.facts
  }
}
