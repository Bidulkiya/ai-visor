/**
 * 도구 런타임 조립 (ui 계층) — registry + builtins + audit + gate + MCP를 묶어
 * core가 쓰는 ToolRuntime 포트로 노출한다.
 *
 * core는 tools/를 import하지 않는다(§2). 조립은 여기(ui)서 하고,
 * 결과 포트만 connectCompanionSession에 넘긴다.
 * 감사 로그는 SQLite의 audit_log에 IPC 브리지로 직접 기록한다(append-only라
 * memory 쓰기 큐와 충돌하지 않음).
 *
 * MCP: 빌트인은 동기로 즉시 등록되고(노아는 곧장 23종 사용), MCP 서버는 비동기로
 * 나중에 연결해 같은 레지스트리에 동적으로 추가한다. 그래서 specs를 '라이브 게터'로
 * 노출한다 — 매 턴 현재 레지스트리를 읽어 나중에 붙은 MCP 도구가 자동으로 광고된다.
 * MCP 연결이 실패해도 빌트인·대화는 정상(graceful).
 */

'use client'

import type { ToolRuntime } from '../core/session'
import { createAuditLog } from '../tools/audit'
import { createToolGate, type ApprovalRequester } from '../tools/gate'
import { createToolRegistry } from '../tools/registry'
import { getToolOperationBridge, registerBuiltinTools } from '../tools/builtins'
import {
  createMcpRegistrar,
  getMcpBridge,
  type McpServerConfig,
  type McpServerConnectionStatus,
} from '../tools/mcp'
import { getDatabaseBridge } from '../memory/ipcDriver'

export interface ToolAssembly {
  runtime: ToolRuntime
  /** 설정으로 MCP 서버에 연결하고 도구를 레지스트리에 등록한다. 상태를 돌려줘 UI가 표시 */
  connectMcpServers(configs: readonly McpServerConfig[]): Promise<McpServerConnectionStatus[]>
}

/**
 * 도구 런타임을 조립한다. Electron 브리지가 없으면(브라우저 단독) null —
 * 도구 없이 대화만 가능하다.
 */
export function assembleToolRuntime(requestApproval: ApprovalRequester): ToolAssembly | null {
  const toolBridge = getToolOperationBridge()
  const databaseBridge = getDatabaseBridge()
  if (toolBridge === null || databaseBridge === null) {
    return null
  }

  const registry = createToolRegistry()
  registerBuiltinTools(registry, toolBridge)
  const mcpRegistrar = createMcpRegistrar(registry, getMcpBridge())

  // 감사 로그는 audit_log에 직접 INSERT (append-only) — DatabaseBridge.run을 그대로 쓴다
  const auditLog = createAuditLog({
    write: (sql, parameters) => databaseBridge.run(sql, parameters),
  })
  const gate = createToolGate({ registry, auditLog, requestApproval })

  const runtime: ToolRuntime = {
    // 라이브 게터 — 매 턴 현재 레지스트리를 읽어 나중에 등록된 MCP 도구까지 광고한다.
    get specs() {
      return registry.list().map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }))
    },
    invoke: async (name, input, signal) => {
      const outcome = await gate.invoke(name, input, signal)
      if (outcome.status === 'executed') {
        return { isSuccess: outcome.result.isSuccess, output: outcome.result.output }
      }
      // 거부·미등록도 LLM이 알 수 있게 결과 텍스트로 돌려준다(에러 플래그 포함)
      return { isSuccess: false, output: outcome.reason }
    },
  }

  return {
    runtime,
    connectMcpServers: (configs) => mcpRegistrar.connectAndRegister(configs),
  }
}
