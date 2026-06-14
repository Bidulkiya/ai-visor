/**
 * 최근 도구 작업 이력 읽기 (+1 — 기억을 도구 작업에 연결).
 *
 * 도구 호출은 이미 audit_log(R4 감사)에 영속된다. 여기서는 그 기록을 읽어
 * "방금 옮긴 폴더", "어제 그 파일" 같은 참조가 다음 턴에 가능하도록 도구 맥락으로
 * 제공한다. 새로 저장하지 않고 기존 감사 기록을 재사용한다(중복 저장 없음).
 *
 * R5: 이 맥락은 LLM의 제안·정확도만 높인다. risk 태그·게이트와 무관하다 —
 * 이 모듈은 tools/gate·registry를 import하지 않으며 risk를 다루지 않는다.
 * R6: audit_log는 로컬 SQLite다. 외부로 나가지 않는다.
 * 시크릿 가림: output_summary는 기록 시 이미 redactSecrets를 거쳤다(tools/audit.ts).
 */

import type { MemoryDatabase } from './db'

export interface RecentToolOperation {
  toolName: string
  /** 무엇을 했는지 요약 — audit_log에 이미 시크릿 가림·길이 제한된 값 */
  summary: string
}

interface ToolHistoryRow {
  tool_name: string
  output_summary: string | null
}

export interface ToolHistoryReader {
  /** 최근 성공한 도구 작업 N건(최신순). 실패·거부가 아니라 "실제로 한 일"만 맥락에 준다 */
  getRecentOperations(limit: number): Promise<RecentToolOperation[]>
}

// 성공한 작업만 — 거부·실패는 "한 일"이 아니므로 참조 맥락에서 제외한다
const RECENT_OPERATIONS_SQL = `SELECT tool_name, output_summary FROM audit_log
  WHERE is_success = 1 ORDER BY id DESC LIMIT ?`

export function createToolHistoryReader(database: MemoryDatabase): ToolHistoryReader {
  return {
    async getRecentOperations(limit: number): Promise<RecentToolOperation[]> {
      try {
        const rows = await database.all<ToolHistoryRow>(RECENT_OPERATIONS_SQL, [limit])
        return rows.map((row) => ({
          toolName: row.tool_name,
          summary: (row.output_summary ?? '').trim(),
        }))
      } catch (error) {
        // 도구 이력 읽기 실패가 대화를 막지 않는다 — 맥락 없이 진행 (엣지: 첫 실행, 빈 로그)
        console.error('[memory.toolHistory]: 최근 도구 이력 읽기 실패:', error)
        return []
      }
    },
  }
}
