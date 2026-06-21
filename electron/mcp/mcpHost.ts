/**
 * MCP IPC 호스트 (메인 프로세스) — 렌더러 ↔ MCP 매니저 배선.
 *
 * 렌더러(tools/mcp.ts)가 설정을 넘겨 연결을 요청하고, 받은 도구 목록을
 * 자기 레지스트리에 등록한다. 도구 호출도 이 채널을 거친다 — 단, 게이트·감사·
 * 인젝션 경계는 렌더러가 적용한 뒤에야 이 호출에 도달한다(R4 불변).
 *
 * 어떤 핸들러도 throw하지 않는다 — 실패는 결과 객체로 보고해 렌더러/노아가
 * 크래시 없이 graceful하게 대응한다(요구 ③·④).
 */

import { ipcMain } from 'electron'
import { IPC_CHANNELS, type McpCallResult, type McpConnectResult, type McpServerConfig } from '../ipc/channels'
import { createMcpManager, type McpManager } from './manager'

const EMPTY_CONNECT_RESULT: McpConnectResult = { servers: [], tools: [] }

/** 매니저를 만들고 IPC 핸들러를 등록한다. 반환된 매니저로 메인이 종료 시 정리한다 */
export function registerMcpHost(): McpManager {
  const manager = createMcpManager()

  ipcMain.handle(
    IPC_CHANNELS.mcpConnect,
    async (_event, configs: unknown): Promise<McpConnectResult> => {
      if (!Array.isArray(configs)) {
        return EMPTY_CONNECT_RESULT
      }
      try {
        return await manager.connect(configs as McpServerConfig[])
      } catch (error) {
        // 매니저는 자체적으로 graceful하지만, 예기치 못한 예외도 크래시로 잇지 않는다
        console.error('[mcp.host]: 연결 처리 실패:', error)
        return EMPTY_CONNECT_RESULT
      }
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.mcpCallTool,
    async (
      _event,
      serverId: unknown,
      toolName: unknown,
      input: unknown,
    ): Promise<McpCallResult> => {
      if (typeof serverId !== 'string' || typeof toolName !== 'string') {
        return { isSuccess: false, output: 'MCP 도구 호출 인자가 올바르지 않습니다.' }
      }
      const safeInput =
        typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
      return manager.callTool(serverId, toolName, safeInput)
    },
  )

  // 종료 시 자식 정리는 main이 manager.disconnectAll()을 직접 호출한다(IPC 불필요).
  return manager
}
