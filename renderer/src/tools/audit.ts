/**
 * 감사 로그 (CLAUDE.md R4) — 모든 도구 호출을 SQLite에 기록한다.
 *
 * 기록 대상: 도구명·위험도·인자·결과·승인 여부·롤백 정보·타임스탬프.
 * 저장은 memory의 단일 쓰기 경로를 그대로 탄다 — 의존 방향(§2)을 지키기 위해
 * memory를 import하지 않고 구조적으로 호환되는 쓰기 함수만 받는다(거울 동기).
 */

import type { RiskLevel } from './registry'

/** memory/db.ts의 MemoryDatabase.write와 구조 호환 — import 없이 주입 */
export interface AuditWriter {
  write(sql: string, parameters?: ReadonlyArray<string | number | null>): Promise<void>
}

export interface AuditEntry {
  toolName: string
  risk: RiskLevel
  input: Record<string, unknown>
  isSuccess: boolean
  /** 승인 거부·실행 결과 등 사람이 읽을 요약 */
  outputSummary: string
  rollbackInfo?: string
}

export interface AuditLog {
  /**
   * 기록 실패가 도구 흐름을 깨지 않도록 절대 throw하지 않는다.
   * 기록 성공 여부를 반환하니 호출자(게이트)가 위험 작업의 미기록을 인지할 수 있다.
   */
  record(entry: AuditEntry, now?: number): Promise<boolean>
}

/** 컬럼 폭주 방지 — 인자·결과는 요약으로만 저장 */
const SUMMARY_MAX_CHARS = 500

/** 입력·출력에서 명백한 시크릿 패턴을 가린다 (R7 방어 — 프롬프트 인젝션 등 대비) */
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /sk-ant-[A-Za-z0-9_-]+/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /(api[_-]?key|token|password|secret)\s*[=:]\s*\S+/gi,
]
const REDACTED_PLACEHOLDER = '[가림]'

const INSERT_AUDIT_SQL = `INSERT INTO audit_log
  (tool_name, risk, input_summary, is_success, rollback_info, output_summary, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`

function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, REDACTED_PLACEHOLDER),
    text,
  )
}

function truncateSummary(text: string): string {
  const redacted = redactSecrets(text)
  if (redacted.length <= SUMMARY_MAX_CHARS) {
    return redacted
  }
  return `${redacted.slice(0, SUMMARY_MAX_CHARS)}…(잘림)`
}

function summarizeInput(input: Record<string, unknown>): string {
  try {
    return truncateSummary(JSON.stringify(input))
  } catch {
    return '(직렬화 불가 입력)'
  }
}

export function createAuditLog(writer: AuditWriter): AuditLog {
  return {
    async record(entry: AuditEntry, now: number = Date.now()): Promise<boolean> {
      try {
        await writer.write(INSERT_AUDIT_SQL, [
          entry.toolName,
          entry.risk,
          summarizeInput(entry.input),
          entry.isSuccess ? 1 : 0,
          // 롤백 정보도 시크릿 가림·길이 제한을 거친다 — 이전 클립보드 등 민감 값이
          // 평문으로 감사 로그에 남지 않게 (입력·출력과 동일한 보호)
          entry.rollbackInfo !== undefined ? truncateSummary(entry.rollbackInfo) : null,
          truncateSummary(entry.outputSummary),
          now,
        ])
        return true
      } catch (error) {
        // 감사 기록 실패가 대화·도구 흐름을 중단시키면 안 된다 — 기록하고 계속
        console.error('[tools.audit]: 감사 로그 기록 실패:', error)
        return false
      }
    },
  }
}
