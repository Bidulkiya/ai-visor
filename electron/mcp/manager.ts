/**
 * MCP 다중 서버 매니저 (메인 프로세스) — 연결 수명주기 + 도구 호출 라우팅.
 *
 * - connect(configs): 기존 연결을 모두 끊고, 주어진 설정으로 새로 연결한다(전체 재조정).
 *   서버 하나가 실패해도 다른 서버·노아 기본 기능은 정상(요구 ④ graceful).
 * - callTool: serverId로 클라이언트를 찾아 위임. 없거나 끊겼으면 에러 결과(throw 안 함).
 * - disconnectAll: 앱 종료 시 자식 프로세스 정리(좀비 방지 §5).
 *
 * 게이트·감사·인젝션 경계·redact는 렌더러 tools/의 몫이다 — 여기는 순수 연결·호출만.
 */

import { createStdioMcpClient, type McpClient } from './stdioClient'
import type {
  McpCallResult,
  McpConnectResult,
  McpServerConfig,
  McpServerConnectionStatus,
  McpToolDescriptor,
} from '../ipc/channels'

/** 서버 id 허용 문자 — 도구 네임스페이스(mcp__<id>__<tool>)에 안전한 문자만 */
const SERVER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

export interface McpManager {
  connect(configs: readonly McpServerConfig[]): Promise<McpConnectResult>
  callTool(serverId: string, toolName: string, input: Record<string, unknown>): Promise<McpCallResult>
  disconnectAll(): void
}

export function createMcpManager(): McpManager {
  const clientsByServerId = new Map<string, McpClient>()
  // 연결을 직렬화한다 — 동시 connect가 disconnectAll과 connectOne의 set 사이에 끼어들어
  // 자식 프로세스를 추적 불가(고아)로 만들지 않게 한다(§5 좀비/고아 금지).
  let connectInFlight: Promise<McpConnectResult> = Promise.resolve({ servers: [], tools: [] })

  function disconnectAll(): void {
    for (const [, client] of clientsByServerId) {
      client.close()
    }
    clientsByServerId.clear()
  }

  async function connectOne(
    config: McpServerConfig,
    tools: McpToolDescriptor[],
  ): Promise<McpServerConnectionStatus> {
    if (!config.enabled) {
      return { id: config.id, label: config.label, status: 'disabled' }
    }
    const validationError = validateConfig(config)
    if (validationError !== null) {
      return { id: config.id, label: config.label, status: 'error', message: validationError }
    }
    const client = createStdioMcpClient(config)
    try {
      await client.connect()
      const serverTools = await client.listTools()
      clientsByServerId.set(config.id, client)
      for (const tool of serverTools) {
        tools.push(tool)
      }
      return { id: config.id, label: config.label, status: 'connected', toolCount: serverTools.length }
    } catch (error) {
      // 연결·도구목록 실패 — 자식 정리 후 에러 상태로 보고(크래시 금지, 다른 서버는 계속)
      client.close()
      const message = error instanceof Error ? error.message : 'MCP 서버 연결 실패'
      console.error(`[mcp.manager]: 서버 '${config.id}' 연결 실패:`, message)
      return { id: config.id, label: config.label, status: 'error', message }
    }
  }

  function connect(configs: readonly McpServerConfig[]): Promise<McpConnectResult> {
    // 직렬화: 이전 connect가 끝난 뒤 다음이 시작한다. 실패해도 큐가 멈추지 않게 catch로 잇는다.
    const next = connectInFlight.then(
      () => connectInternal(configs),
      () => connectInternal(configs),
    )
    connectInFlight = next.catch(() => ({ servers: [], tools: [] }))
    return next
  }

  async function connectInternal(configs: readonly McpServerConfig[]): Promise<McpConnectResult> {
    // 전체 재조정 — 재연결 시 묵은 자식이 남지 않게 먼저 모두 끊는다
    disconnectAll()
    const tools: McpToolDescriptor[] = []
    const servers: McpServerConnectionStatus[] = []
    const seenIds = new Set<string>()
    for (const config of configs) {
      // 중복 id는 네임스페이스 충돌을 일으키므로 두 번째부터 건너뛴다(첫 정의 우선)
      if (seenIds.has(config.id)) {
        servers.push({
          id: config.id,
          label: config.label,
          status: 'error',
          message: '서버 id가 중복됩니다.',
        })
        continue
      }
      seenIds.add(config.id)
      // 서버는 순차 연결한다 — 동시 spawn 폭주를 피하고, 한 서버의 실패가 다른 서버에
      // 영향을 주지 않게(각자 try/catch). 서버 수는 보통 적어 지연 부담이 작다.
      servers.push(await connectOne(config, tools))
    }
    return { servers, tools }
  }

  async function callTool(
    serverId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<McpCallResult> {
    const client = clientsByServerId.get(serverId)
    if (client === undefined || !client.isConnected()) {
      return { isSuccess: false, output: `MCP 서버에 연결돼 있지 않습니다: ${serverId}` }
    }
    try {
      return await client.callTool(toolName, input)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'MCP 도구 호출 실패'
      console.error(`[mcp.manager]: 도구 호출 실패 ${serverId}/${toolName}:`, message)
      return { isSuccess: false, output: message }
    }
  }

  return { connect, callTool, disconnectAll }
}

/** 설정 유효성 — id 형식·명령 존재. 문제가 있으면 사유(string), 없으면 null */
function validateConfig(config: McpServerConfig): string | null {
  if (!SERVER_ID_PATTERN.test(config.id)) {
    return 'id는 영문·숫자·_·- 1~64자만 허용됩니다.'
  }
  if (typeof config.command !== 'string' || config.command.trim().length === 0) {
    return '실행 명령(command)이 비어 있습니다.'
  }
  if (!Array.isArray(config.args)) {
    return '인자(args) 형식이 올바르지 않습니다.'
  }
  return null
}
