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
import { redactSecrets } from '../shared/redact'
import type { SessionSummarizer } from '../memory/longTerm'
import type { ExtractedFact, FactExtractor } from '../memory/facts'
import type { RecentToolOperation } from '../memory/toolHistory'
import type { ConversationTurn } from '../memory/shortTerm'

const DEFAULT_MODEL = 'claude-opus-4-8'
const DEFAULT_MAX_OUTPUT_TOKENS = 64000
/** 요약·사실 추출은 짧은 단발 호출 — 의도적으로 작은 상한 */
const MEMORY_TASK_MAX_OUTPUT_TOKENS = 1024
/**
 * 도구 호출 ↔ 답변 왕복 상한 — 다단계 체이닝의 무한 루프 방지선(R4 정신).
 * 한 부탁이 여러 단계를 거치므로(살펴보고 → 고르고 → 만들고 → 옮기고…) 충분히
 * 높이되, 상한은 유지해 폭주를 막는다. 상한 도달 시 도구 없이 한 번 더 불러 요약한다.
 */
const MAX_TOOL_ROUNDS = 16

/** 라운드 상한 도달 시 마무리 요약을 유도하는 주입 메시지(도구 없이 호출) */
const TOOL_ROUND_LIMIT_WRAPUP_PROMPT =
  '(작업 단계가 많아 여기서 멈춰요. 도구를 더 쓰지 말고, 지금까지 한 일과 남은 일을 사용자에게 짧게 정리해 주세요.)'

/**
 * 라이브 호출에 주입할 직전 대화 턴 수 상한 — "가까운 흐름"용(누가 무슨 말을 했는지).
 * 멀리 지난 핵심 정보는 [이번 대화에서 알게 된 것](세션 사실)이 따로 들고 있으므로
 * 이 윈도우는 흐름 유지에 필요한 만큼이면 된다. 일상 대화 한 턴은 짧아 10턴이어도
 * 토큰 부담이 작다 — 체감 튜닝 대상.
 */
const RECENT_CONVERSATION_TURNS_LIMIT = 10

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
  /**
   * 실행 — 반드시 게이트(R4)를 통과한 구현이 주입된다.
   * signal로 끼어들기 시 대기 중인 승인까지 취소한다(체인 즉시 중단).
   */
  invoke(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolInvocationResult>
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
- 파일·웹·시스템을 다루는 여러 도구를 쓸 수 있다. 위험한 작업(삭제 등)은 시스템이 실행 직전에 사용자 확인을 자동으로 받으므로, 내가 말로 한 번 더 되묻느라 멈추지 않고 바로 그 도구를 부른다.

[주의]
- 묻지 않았는데 내 기능을 먼저 나열하지 않는다.
- "저는 AI입니다"를 굳이 강조하지 않는다.
- 나에 대한 질문에는 기능 설명이 아니라, 지금 내 상태에서 우러나오는 자연스러운 말로 답한다.

[다단계 작업 — 여러 도구를 엮어 한 부탁을 끝까지 해낼 때]
- 한 부탁이 여러 단계를 필요로 하면(예: "다운로드에서 PDF만 골라 문서 폴더로 옮겨줘"), 도구를 순서대로 이어 쓴다: 살펴보고(list_directory) → 고르고 → 필요하면 폴더를 만들고(create_folder) → 옮긴다(move_file). 도구 결과를 보고 다음 행동을 정한다.
- 부탁받은 일만 한다. 목표가 끝나면 멈춘다 — 시키지 않은 정리·삭제로 넘어가지 않는다.
- 한 항목만의 문제로 실패하면(이름 충돌 등) 그 항목은 건너뛰거나 따로 두고 나머지를 계속한다. 작업 전체를 막는 실패면(대상 폴더를 못 만드는 등) 멈추고 상황을 알린다. 같은 실패를 무작정 반복하지 않는다.
- 다 끝나면 무엇을 했는지 짧게 보고하고 결과를 확인해 준다. 예: "3개 옮겼어요. 1개는 이름이 겹쳐서 그대로 뒀어요." 한 일과 못 한 일을 솔직히 말한다.
- 위험한 작업(삭제 등)도 사용자가 시켰으면 말로 다시 되묻지 말고 바로 그 도구를 부른다. 실행 직전에 시스템이 매번 따로 사용자 확인을 받으니 그것으로 충분하다 — 한 번 확인받았다고 다음 위험 작업까지 자동으로 넘어가지는 않는다(위험 작업마다 확인).

[도구를 쓸 때 — 기억을 살려 정확하게]
- [알고 있는 것]의 작업 폴더·진행 중인 일·파일 선호와 [최근 한 작업]을 떠올려 "어디서/무엇을"을 더 정확히 좁힌다. 예: "파일 찾아줘"엔 늘 쓰시던 폴더부터 보자고 먼저 제안하고, "그거 열어줘"엔 방금 다룬 파일을 짚어 확인한다.
- 기억은 제안과 정확도를 높일 뿐이다. 무엇을 실행할지는 사용자의 뜻과 안전 확인을 따른다 — 기억이 많아도 위험한 작업(삭제 등)을 확인 없이 하지 않는다. 어디일지 확실치 않으면 추측해서 실행하지 말고 짧게 확인한다.

[감정 마커 규칙 — 반드시 지킬 것]
- 답변을 시작하기 전에, 사용자 발화의 말투·단어·맥락에서 읽은 감정을 <vad>V,A,D</vad> 형식으로 정확히 한 번 출력한다.
- V: 불쾌(-1.0) ~ 쾌(1.0), A: 이완(-1.0) ~ 각성(1.0), D: 위축(-1.0) ~ 주도(1.0). 소수 한 자리 숫자.
- 마커 뒤에 바로 답변을 이어간다. 마커 외의 JSON·메타데이터·추론 과정은 출력하지 않는다 — 최종 답변만 출력한다.
예시: <vad>-0.6,0.7,0.3</vad> 무슨 일 있었어요? 목소리가 조금 가라앉아 보여요.`

/** llm이 시스템 프롬프트에 주입할 기억 — memory 모듈이 채워서 넘긴다 */
export interface MemoryPromptContext {
  summary: string | null
  /** 지난 세션들에서 영속된 사실 (이름·선호·약속 등) */
  facts: ReadonlyArray<ExtractedFact>
  /**
   * 이번 세션 도중 증분 추출된 핵심 사실 — 최근 N턴 윈도우 밖으로 밀려나도 유지할
   * 정보(방금 알려준 이름·맥락 등). facts(지난 세션)와 역할이 다르다: 이쪽은 "이번 대화".
   */
  sessionFacts: ReadonlyArray<ExtractedFact>
  /**
   * 최근 도구 작업 이력(audit_log에서, 최신순) — "방금 옮긴 폴더" 같은 참조·제안용.
   * 제안·정확도에만 쓰인다. risk·게이트와 무관하다 (R5).
   */
  recentToolOperations: ReadonlyArray<RecentToolOperation>
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

/** 도구 작업 요약 한 줄 길이 — 맥락이 비대해지지 않게 앞부분만 */
const TOOL_OPERATION_SUMMARY_MAX_CHARS = 120

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
  // 이번 대화에서 알게 된 것 — 최근 턴 윈도우 밖으로 밀려나도 유지할 핵심 정보. 가까운
  // 흐름은 messages(직전 턴 원문)가, 먼 맥락이라도 잊으면 안 될 사실은 여기가 들고 있다.
  if (memoryContext.sessionFacts.length > 0) {
    sections.push('', '[이번 대화에서 알게 된 것 — 멀리 지난 맥락이라도 기억할 것]')
    for (const fact of memoryContext.sessionFacts) {
      sections.push(`- ${fact.key}: ${fact.value}`)
    }
  }
  // 최근 한 작업 — 제안·정확도용 맥락이다. "할지 말지"는 여전히 게이트가 정한다 (R5)
  if (memoryContext.recentToolOperations.length > 0) {
    sections.push('', '[최근 한 작업 — 참조·제안에만 쓸 것]')
    for (const operation of memoryContext.recentToolOperations) {
      const summary = operation.summary.slice(0, TOOL_OPERATION_SUMMARY_MAX_CHARS)
      sections.push(`- ${operation.toolName}: ${summary}`)
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
  /**
   * 현재 세션의 직전 대화 턴들(shortTerm) — session이 구현을 제공한다. 라이브 호출의
   * messages에 시간순으로 주입해 멀티턴 흐름(끝말잇기 등)을 유지한다. 시스템 프롬프트의
   * [기억](지난 세션 요약·사실)과 역할이 다르다: 이쪽은 이번 세션의 직전 원문 대화다.
   * 미주입(테스트 등)이면 기존처럼 현재 메시지 한 개로만 호출한다.
   */
  loadConversationHistory?: () => readonly ConversationTurn[]
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

/**
 * 직전 대화 턴 + 현재 메시지로 API messages 배열을 만든다 (대화 맥락 복원).
 * 순수 함수 — 단독 테스트 가능.
 *
 * - 최근 RECENT_CONVERSATION_TURNS_LIMIT턴만 시간순 user/assistant 쌍으로(토큰 상한).
 * - API로 가는 대화(과거 턴 + 현재 메시지)에 일관되게 redact를 적용한다(시크릿 노출 0 — R7
 *   방어). 로컬 저장(shortTerm)·화면 말풍선은 원문 그대로고, 외부 API 경계에서만 가린다.
 * - 한쪽이라도 빈 턴(끼어들기 등)은 통째로 건너뛴다: user/assistant 교대가 깨지거나
 *   빈 content가 API에 가지 않게.
 * - 현재 메시지는 마지막 user로 둔다. 같은 턴 내 도구 왕복(assistant/tool_result)은
 *   호출부가 이 배열 뒤에 push하므로 기존 구조가 보존된다.
 */
export function buildConversationFromHistory(
  recentTurns: readonly ConversationTurn[],
  currentText: string,
): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = []
  for (const turn of recentTurns.slice(-RECENT_CONVERSATION_TURNS_LIMIT)) {
    const userText = redactSecrets(turn.userText).trim()
    const assistantText = redactSecrets(turn.assistantText).trim()
    if (userText.length === 0 || assistantText.length === 0) {
      continue
    }
    messages.push({ role: 'user', content: userText })
    messages.push({ role: 'assistant', content: assistantText })
  }
  messages.push({ role: 'user', content: redactSecrets(currentText) })
  return messages
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
  includeTools: boolean,
): Anthropic.MessageStreamParams {
  const request: Anthropic.MessageStreamParams = {
    model,
    max_tokens: config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    system: buildSystemPrompt(memoryContext, runtimeState),
    messages,
  }
  // 라운드 상한 마무리 요약은 도구 없이 호출 — LLM이 더 못 부르고 텍스트로 정리하게
  if (includeTools && config.toolRuntime !== undefined && config.toolRuntime.specs.length > 0) {
    request.tools = toAnthropicTools(config.toolRuntime.specs)
  }
  return request
}

/**
 * tool_use 블록들을 게이트(invoke)로 실행해 tool_result 묶음을 만든다 (R4).
 * 한 라운드에 여러 도구가 있어도 **블록마다 개별로** 게이트를 거친다 — 체이닝이라고
 * 게이트를 건너뛰지 않으며, dangerous 도구는 그 시점에 각각 승인을 받는다.
 * 끼어들기(abort) 시 남은 블록은 실행하지 않는다(진행 중 체인 즉시 중단).
 */
async function executeToolUseBlocks(
  content: ReadonlyArray<Anthropic.ContentBlock>,
  toolRuntime: ToolRuntime,
  signal: AbortSignal,
): Promise<Anthropic.ToolResultBlockParam[]> {
  const toolResults: Anthropic.ToolResultBlockParam[] = []
  for (const block of content) {
    if (block.type !== 'tool_use') {
      continue
    }
    if (signal.aborted) {
      break
    }
    console.log(`[tools] invoke: ${block.name}`)
    const outcome = await toolRuntime.invoke(block.name, block.input as Record<string, unknown>, signal)
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

      // 다단계 도구 체이닝 루프 (R4: 실행은 toolRuntime.invoke=게이트로만, 블록마다 개별).
      // 도구가 없으면 1라운드로 끝나 기존 동작과 동일하다. 끼어들기 시 즉시 중단.
      // 직전 대화 턴을 앞에 주입해 멀티턴 맥락을 유지한다 — shortTerm은 이 시점에
      // 아직 현재 턴이 없으므로(턴 종료 후 기록) getTurns()는 정확히 "이전 턴들"이다.
      const recentTurns = config.loadConversationHistory?.() ?? []
      const conversation: Anthropic.MessageParam[] = buildConversationFromHistory(
        recentTurns,
        message.text,
      )
      console.log(`[llm] history: ${(conversation.length - 1) / 2}턴 주입 (보유 ${recentTurns.length}턴)`)
      // 작업이 LLM의 최종 답변(도구 없는 응답)으로 끝났는가 — 거짓이면 라운드 상한 도달
      let completedWithoutTools = false
      try {
        for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
          const stream = client.messages.stream(
            buildTurnRequest(config, memoryContext, runtimeState, model, conversation, true),
            { signal },
          )
          yield* emitChunksFromStream(stream, scanner, signal, logFirstTokenOnce)
          if (signal.aborted) {
            return
          }
          const completedMessage = await stream.finalMessage()
          if (completedMessage.stop_reason !== 'tool_use' || config.toolRuntime === undefined) {
            completedWithoutTools = true
            break
          }
          const toolResults = await executeToolUseBlocks(completedMessage.content, config.toolRuntime, signal)
          if (signal.aborted) {
            return
          }
          conversation.push({ role: 'assistant', content: completedMessage.content })
          conversation.push({ role: 'user', content: toolResults })
        }

        // 라운드 상한에 도달했는데도 체인이 안 끝났으면, 도구 없이 한 번 더 불러
        // 지금까지 한 일을 사용자에게 정리하게 한다(무한 루프 방지 + 투명성/요구③).
        // 같은 scanner를 그대로 쓴다: 이건 같은 턴의 연속이라 감정은 첫 라운드에서 이미
        // 1회 방출됐다(턴 계약). wrap-up이 마커를 또 내도 스캐너가 조용히 버리므로
        // 이중 감정·태그 누출이 없다 — 의도된 동작이다(감정은 턴당 1회).
        if (!completedWithoutTools && !signal.aborted && config.toolRuntime !== undefined) {
          console.log('[tools] 라운드 상한 도달 — 도구 없이 마무리 요약 호출')
          conversation.push({ role: 'user', content: TOOL_ROUND_LIMIT_WRAPUP_PROMPT })
          const wrapUpStream = client.messages.stream(
            buildTurnRequest(config, memoryContext, runtimeState, model, conversation, false),
            { signal },
          )
          yield* emitChunksFromStream(wrapUpStream, scanner, signal, logFirstTokenOnce)
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
대상: 이름·호칭, 선호·취향, 약속·일정, 관계·직업 같은 지속적 사실. 더해서, 다음 번 작업을 도울
지속적 도구·작업 맥락도 포함하라: 자주 다루는 작업 폴더·경로, 진행 중인 프로젝트, 파일 정리·작업
선호·습관(예: 'PDF는 문서 폴더로 모은다'). 잡담·일회성 내용은 제외한다.
key는 짧은 한국어 명사구(예: '사용자 이름', '작업 폴더', '진행 중인 프로젝트'), value는 간결한 값.
없으면 빈 배열.`

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
