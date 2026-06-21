/**
 * 위험도 승인 게이트 (CLAUDE.md R4) — 도구 실행을 가로채는 유일한 경로.
 *
 * safe      → 자동 실행
 * caution   → 자동 실행 + 감사 로그
 * dangerous → ui 승인 요청 통과 후에만 실행 (+ 감사 로그)
 *
 * 게이트는 코드로 강제된다 — engine은 이 함수만 주입받으므로 LLM이 위험도를
 * 우회하거나 직접 도구를 부를 구조적 경로가 없다 (R5: risk는 감정과 무관한 상수).
 * 모든 호출은 결과와 무관하게 감사 로그에 남는다.
 */

import type { AuditLog } from './audit'
import type { ToolDefinition, ToolExecutionResult, ToolRegistry } from './registry'

/**
 * dangerous 도구 실행 전 ui에 승인을 묻는다. 거부=false. 미주입 시 게이트는 기본 거부.
 * signal이 주어지면 끼어들기(abort) 시 대기 중인 승인이 자동 거부돼야 한다.
 */
export type ApprovalRequester = (request: ApprovalRequest, signal?: AbortSignal) => Promise<boolean>

export interface ApprovalRequest {
  toolName: string
  description: string
  input: Record<string, unknown>
}

export type GateOutcome =
  | { status: 'executed'; result: ToolExecutionResult }
  | { status: 'denied'; reason: string }
  | { status: 'unknown-tool'; reason: string }

export interface ToolGate {
  /** 도구 실행의 유일한 진입점. signal로 끼어들기 시 대기 중 승인까지 취소한다 */
  invoke(toolName: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<GateOutcome>
}

const DENY_MESSAGE_NO_APPROVER =
  '위험 작업 승인 통로가 없어 거부했습니다. (승인 UI 미연결)'
const DENY_MESSAGE_USER =
  '사용자가 승인하지 않아 실행하지 않았습니다.'
const DENY_MESSAGE_INTERRUPTED =
  '끼어들기로 중단되어 실행하지 않았습니다.'

/** 함수로 감싸 await 전후의 좁힘을 끊는다 — signal.aborted는 도중에 바뀔 수 있다 */
function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

export interface ToolGateOptions {
  registry: ToolRegistry
  auditLog: AuditLog
  /** dangerous 도구 승인자 — 없으면 dangerous는 전부 거부된다 (안전 기본값) */
  requestApproval?: ApprovalRequester
}

async function executeAndAudit(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  auditLog: AuditLog,
): Promise<GateOutcome> {
  // execute가 던져도 (a) 감사에 남기고(R4 — 모든 도구 호출 기록) (b) 턴을 깨지 않고
  // 실패 결과로 돌려준다(graceful — LLM이 상황을 설명·계속하게). 빌트인·MCP는 내부에서
  // 잡지만, 예기치 못한 throw에 대한 게이트 차원의 안전망이다(미등록·거부와 같은 실패 취급).
  let result: ToolExecutionResult
  try {
    result = await tool.execute(input)
  } catch (error) {
    const message = error instanceof Error ? error.message : '도구 실행 중 오류가 발생했습니다'
    console.error(`[tools.gate]: 도구 '${tool.name}' 실행 예외:`, error)
    result = { isSuccess: false, output: `도구 실행 중 오류: ${message}` }
  }
  const isAudited = await auditLog.record({
    toolName: tool.name,
    risk: tool.risk,
    input,
    isSuccess: result.isSuccess,
    outputSummary: result.output,
    rollbackInfo: result.rollbackInfo,
  })
  if (!isAudited && tool.risk === 'dangerous') {
    // 위험 작업이 감사에 남지 않은 것은 심각하다 — 강하게 경고한다 (기획서 §6: 모든 호출 기록)
    console.error(`[tools.gate]: 위험 도구 '${tool.name}' 실행이 감사 로그에 기록되지 못했습니다.`)
  }
  return { status: 'executed', result }
}

async function recordDenial(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  auditLog: AuditLog,
  reason: string,
): Promise<void> {
  await auditLog.record({
    toolName: tool.name,
    risk: tool.risk,
    input,
    isSuccess: false,
    outputSummary: `거부됨: ${reason}`,
  })
}

export function createToolGate(options: ToolGateOptions): ToolGate {
  const { registry, auditLog } = options

  async function invoke(
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<GateOutcome> {
    const tool = registry.get(toolName)
    if (tool === null) {
      return { status: 'unknown-tool', reason: `등록되지 않은 도구: ${toolName}` }
    }

    // safe: 자동 실행 (+ 감사). caution도 같은 경로 — 차이는 위험도 태그뿐, 둘 다 기록됨.
    if (tool.risk === 'safe' || tool.risk === 'caution') {
      return executeAndAudit(tool, input, auditLog)
    }

    // dangerous: 승인 게이트 필수. 승인자가 없으면 기본 거부 (R4 — 코드로 강제)
    if (options.requestApproval === undefined) {
      await recordDenial(tool, input, auditLog, DENY_MESSAGE_NO_APPROVER)
      return { status: 'denied', reason: DENY_MESSAGE_NO_APPROVER }
    }
    // 이미 끼어들기로 중단됐으면 승인을 묻지 않고 거부 — 멈춘 체인이 위험 작업을 띄우지 않게
    if (isAborted(signal)) {
      await recordDenial(tool, input, auditLog, DENY_MESSAGE_INTERRUPTED)
      return { status: 'denied', reason: DENY_MESSAGE_INTERRUPTED }
    }
    // 승인 대기 중 끼어들면 자동 거부된다 (signal 전달 — useToolApproval이 처리)
    const isApproved = await options.requestApproval(
      { toolName: tool.name, description: tool.description, input },
      signal,
    )
    if (!isApproved) {
      const reason = isAborted(signal) ? DENY_MESSAGE_INTERRUPTED : DENY_MESSAGE_USER
      await recordDenial(tool, input, auditLog, reason)
      return { status: 'denied', reason }
    }
    // 승인은 통과했지만 그 직후~실행 직전에 끼어들기로 턴이 중단됐으면 실행하지 않는다.
    // 게이트는 승인 '전'에 이미 abort를 확인하므로, 이 재확인이 승인 후의 좁은 틈만 메운다.
    // (정상 승인이고 중단이 없으면 isAborted=false라 그대로 실행 — 과차단 아님)
    if (isAborted(signal)) {
      await recordDenial(tool, input, auditLog, DENY_MESSAGE_INTERRUPTED)
      return { status: 'denied', reason: DENY_MESSAGE_INTERRUPTED }
    }
    return executeAndAudit(tool, input, auditLog)
  }

  return { invoke }
}
