/**
 * 도구 런타임 조립 (ui 계층) — registry + builtins + audit + gate를 묶어
 * core가 쓰는 ToolRuntime 포트로 노출한다.
 *
 * core는 tools/를 import하지 않는다(§2). 조립은 여기(ui)서 하고,
 * 결과 포트만 connectCompanionSession에 넘긴다.
 * 감사 로그는 SQLite의 audit_log에 IPC 브리지로 직접 기록한다(append-only라
 * memory 쓰기 큐와 충돌하지 않음).
 */

'use client'

import type { ToolRuntime } from '../core/session'
import { createAuditLog } from '../tools/audit'
import { createToolGate, type ApprovalRequester } from '../tools/gate'
import { createToolRegistry } from '../tools/registry'
import { getToolOperationBridge, registerBuiltinTools } from '../tools/builtins'
import { getDatabaseBridge } from '../memory/ipcDriver'

export interface ToolAssemblyResult {
  runtime: ToolRuntime
}

/**
 * 도구 런타임을 조립한다. Electron 브리지가 없으면(브라우저 단독) null —
 * 도구 없이 대화만 가능하다.
 */
export function assembleToolRuntime(requestApproval: ApprovalRequester): ToolRuntime | null {
  const toolBridge = getToolOperationBridge()
  const databaseBridge = getDatabaseBridge()
  if (toolBridge === null || databaseBridge === null) {
    return null
  }

  const registry = createToolRegistry()
  registerBuiltinTools(registry, toolBridge)

  // 감사 로그는 audit_log에 직접 INSERT (append-only) — DatabaseBridge.run을 그대로 쓴다
  const auditLog = createAuditLog({
    write: (sql, parameters) => databaseBridge.run(sql, parameters),
  })
  const gate = createToolGate({ registry, auditLog, requestApproval })

  return {
    specs: registry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    invoke: async (name, input, signal) => {
      const outcome = await gate.invoke(name, input, signal)
      if (outcome.status === 'executed') {
        return { isSuccess: outcome.result.isSuccess, output: outcome.result.output }
      }
      // 거부·미등록도 LLM이 알 수 있게 결과 텍스트로 돌려준다(에러 플래그 포함)
      return { isSuccess: false, output: outcome.reason }
    },
  }
}
