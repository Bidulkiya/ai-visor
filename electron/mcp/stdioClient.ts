/**
 * 하나의 MCP 서버에 stdio로 연결하는 클라이언트 (메인 프로세스).
 *
 * MCP 표준 핸드셰이크를 직접 수행한다(외부 SDK 없음 — §5 패키징/다운로드 함정 회피):
 *   initialize → notifications/initialized → tools/list → tools/call
 *
 * 안전(요구 ③ — 외부는 신뢰 경계):
 *  - 자식 프로세스는 셸 없이 직접 실행(shell:false) — 명령 인젝션 차단.
 *  - 모든 요청에 타임아웃 — 멈춘 서버가 노아를 막지 않는다.
 *  - stdout 버퍼 상한 — 개행 없이 쏟아내는 악성 응답의 메모리 고갈(OOM) 차단.
 *  - 크래시·비정상 종료 시 대기 요청을 일괄 거부하고 닫힘으로 표시(throw로 메인 죽지 않음).
 *  - 종료 시 자식(및 그 트리)을 명시적으로 kill — 좀비/고아 프로세스 방지(§5).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  buildNotification,
  buildRequest,
  encodeMessage,
  isSuccess,
  parseResponseLine,
  type JsonRpcResponse,
} from './jsonRpc'
import type { McpServerConfig, McpToolDescriptor } from '../ipc/channels'

/** 핸드셰이크·도구목록·도구호출 한 건의 응답 한도 */
const REQUEST_TIMEOUT_MS = 20000
/** stdout 누적 상한 — 개행 없는 폭주 출력으로 인한 메모리 고갈 방지 */
const MAX_STDOUT_BUFFER_BYTES = 8 * 1024 * 1024
/** 한 서버에서 받아들일 도구 수 상한 — 비정상적으로 많은 도구로 인한 비대화 방지 */
const MAX_TOOLS_PER_SERVER = 200
/** 도구 설명 상한 — 비대한 외부 메타데이터가 매 턴 토큰을 삼키지 않게(출력 상한과 같은 철학) */
const MAX_TOOL_DESCRIPTION_CHARS = 4000
/** inputSchema 직렬화 크기 상한 — 거대/비정상 스키마는 폴백으로 보정(외부 신뢰 경계) */
const MAX_INPUT_SCHEMA_BYTES = 16 * 1024
/** 우리가 보내는 프로토콜 버전 — 서버가 다른 버전을 답해도 진행한다(관대) */
const PROTOCOL_VERSION = '2025-06-18'
const CLIENT_INFO = { name: 'ai-visor', version: '0.1.0' }

interface PendingRequest {
  resolve(response: JsonRpcResponse): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export interface McpClient {
  /** initialize 핸드셰이크까지 마친다. 실패 시 throw(매니저가 잡아 상태로 보고) */
  connect(): Promise<void>
  /** 서버의 도구 목록 */
  listTools(): Promise<McpToolDescriptor[]>
  /** 도구 실행 — 실패도 결과 객체로(throw 안 함) */
  callTool(toolName: string, input: Record<string, unknown>): Promise<{ isSuccess: boolean; output: string }>
  /** 자식 프로세스 종료 + 대기 요청 정리. 멱등 */
  close(): void
  isConnected(): boolean
}

export function createStdioMcpClient(config: McpServerConfig): McpClient {
  let child: ChildProcessWithoutNullStreams | null = null
  let nextId = 1
  let stdoutBuffer = ''
  let isClosed = false
  const pending = new Map<number, PendingRequest>()

  function rejectAllPending(reason: string): void {
    for (const [, request] of pending) {
      clearTimeout(request.timer)
      request.reject(new Error(reason))
    }
    pending.clear()
  }

  /**
   * 프로세스가 사라졌다(또는 stdin이 깨졌다) — 상태를 정리하고 대기 요청을 거부한다.
   * 'exit'(이미 종료)와 달리 'error'·stdin 오류는 손자(npx 등)가 살아있을 수 있어, pid가
   * 있으면 트리를 거둔다(좀비 방지 §5). 이미 처리됐거나 다른 인스턴스면 무시(idempotent).
   */
  function handleProcessGone(reason: string, source: ChildProcessWithoutNullStreams): void {
    if (child !== source) {
      return
    }
    child = null
    isClosed = true
    rejectAllPending(reason)
    if (source.pid !== undefined) {
      killProcessTree(source)
    }
  }

  function handleResponseLine(line: string): void {
    const response = parseResponseLine(line)
    if (response === null) {
      // 서버 알림·로그·깨진 줄 — 무시(견고성). 우리 요청에 대한 응답만 처리한다.
      return
    }
    const request = pending.get(response.id)
    if (request === undefined) {
      return
    }
    pending.delete(response.id)
    clearTimeout(request.timer)
    request.resolve(response)
  }

  function onStdoutChunk(chunk: Buffer): void {
    stdoutBuffer += chunk.toString('utf-8')
    if (stdoutBuffer.length > MAX_STDOUT_BUFFER_BYTES) {
      // 개행 없이 쏟아지는 응답 — 메모리 보호를 위해 연결을 끊는다(악성/오작동 서버)
      console.error(`[mcp.stdio:${config.id}]: stdout 버퍼 상한 초과 — 연결 종료`)
      close()
      return
    }
    let newlineIndex = stdoutBuffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex)
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
      handleResponseLine(line)
      newlineIndex = stdoutBuffer.indexOf('\n')
    }
  }

  function sendRequest(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      if (child === null || isClosed) {
        reject(new Error('MCP 서버에 연결돼 있지 않습니다.'))
        return
      }
      const id = nextId
      nextId += 1
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`MCP 요청 시간 초과: ${method}`))
      }, REQUEST_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer })
      try {
        child.stdin.write(encodeMessage(buildRequest(id, method, params)))
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error('stdin 쓰기 실패'))
      }
    })
  }

  function sendNotification(method: string, params?: Record<string, unknown>): void {
    if (child === null || isClosed) {
      return
    }
    try {
      child.stdin.write(encodeMessage(buildNotification(method, params)))
    } catch (error) {
      console.error(`[mcp.stdio:${config.id}]: 알림 전송 실패(${method}):`, error)
    }
  }

  async function connect(): Promise<void> {
    let spawned: ChildProcessWithoutNullStreams
    try {
      // 셸 없이 직접 실행 — 명령 인젝션 차단. stdio는 파이프(JSON-RPC 통신), 종료 시 명시 kill.
      spawned = spawn(config.command, config.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      })
    } catch (error) {
      throw new Error(`MCP 서버 실행 실패: ${error instanceof Error ? error.message : String(error)}`)
    }
    child = spawned
    spawned.stdout.on('data', onStdoutChunk)
    // stderr는 서버 로그 — 통신과 무관하므로 흘려보낸다(버퍼 누적 방지). 디버깅용으로만 기록.
    spawned.stderr.on('data', () => {})
    // stdin 파이프 오류(죽은 파이프 EPIPE 등)는 *비동기* 'error' 이벤트로 온다. 리스너가
    // 없으면 Node가 uncaughtException으로 다시 던져 메인 프로세스 전체가 죽는다 — 반드시 처리(요구 ③c).
    spawned.stdin.on('error', (error) => {
      console.error(`[mcp.stdio:${config.id}]: stdin 오류:`, error)
      handleProcessGone('MCP 서버 stdin 오류', spawned)
    })
    spawned.on('error', (error) => {
      console.error(`[mcp.stdio:${config.id}]: 프로세스 오류:`, error)
      handleProcessGone('MCP 서버 프로세스 오류', spawned)
    })
    spawned.on('exit', () => {
      // 이미 종료됨 — pid 재사용 위험이 있어 트리 kill은 하지 않고 상태만 정리한다
      if (child !== spawned) {
        return
      }
      rejectAllPending('MCP 서버 프로세스가 종료되었습니다.')
      isClosed = true
      child = null
    })

    const response = await sendRequest('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    })
    if (!isSuccess(response)) {
      throw new Error(`initialize 실패: ${response.error.message}`)
    }
    // 핸드셰이크 완료 통지 — 이걸 보내야 서버가 tools/list 등을 받는다(MCP 계약)
    sendNotification('notifications/initialized')
  }

  async function listTools(): Promise<McpToolDescriptor[]> {
    const response = await sendRequest('tools/list')
    if (!isSuccess(response)) {
      throw new Error(`tools/list 실패: ${response.error.message}`)
    }
    const rawTools = Array.isArray(response.result.tools) ? response.result.tools : []
    const descriptors: McpToolDescriptor[] = []
    for (const raw of rawTools.slice(0, MAX_TOOLS_PER_SERVER)) {
      const descriptor = normalizeToolDescriptor(config.id, raw)
      if (descriptor !== null) {
        descriptors.push(descriptor)
      }
    }
    return descriptors
  }

  async function callTool(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ isSuccess: boolean; output: string }> {
    let response: JsonRpcResponse
    try {
      response = await sendRequest('tools/call', { name: toolName, arguments: input })
    } catch (error) {
      return { isSuccess: false, output: error instanceof Error ? error.message : 'MCP 도구 호출 실패' }
    }
    if (!isSuccess(response)) {
      return { isSuccess: false, output: `MCP 오류: ${response.error.message}` }
    }
    return {
      isSuccess: response.result.isError !== true,
      output: extractTextContent(response.result.content),
    }
  }

  function close(): void {
    if (isClosed && child === null) {
      return
    }
    isClosed = true
    const runningChild = child
    child = null
    rejectAllPending('MCP 연결이 종료되었습니다.')
    if (runningChild !== null && runningChild.pid !== undefined) {
      killProcessTree(runningChild)
    }
  }

  return {
    connect,
    listTools,
    callTool,
    close,
    isConnected: () => child !== null && !isClosed,
  }
}

/** 도구 정의 한 건을 와이어 타입으로 정규화 — 형식이 어긋나면 null(건너뜀) */
function normalizeToolDescriptor(serverId: string, raw: unknown): McpToolDescriptor | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const candidate = raw as Record<string, unknown>
  if (typeof candidate.name !== 'string' || candidate.name.length === 0) {
    return null
  }
  const rawDescription =
    typeof candidate.description === 'string' ? candidate.description : candidate.name
  const descriptor: McpToolDescriptor = {
    serverId,
    name: candidate.name,
    // 설명·스키마는 외부(신뢰 못 함) 메타데이터 — 길이·크기를 신뢰 경계에서 제한한다
    description: rawDescription.slice(0, MAX_TOOL_DESCRIPTION_CHARS),
    inputSchema: normalizeInputSchema(candidate.inputSchema),
  }
  const annotations = normalizeAnnotations(candidate.annotations)
  if (annotations !== undefined) {
    descriptor.annotations = annotations
  }
  return descriptor
}

/**
 * inputSchema를 JSON Schema 객체로 보정 — 외부 서버의 비정상 응답에 견고(요구 ③c).
 * 배열(typeof []==='object'이라 단순 검사를 통과함)·null·원시값·순환·거대 스키마는
 * 최소 폴백으로 대체한다. 비정상 스키마 하나가 그 턴의 전체 도구 요청을 깨지 않게.
 */
function normalizeInputSchema(raw: unknown): Record<string, unknown> {
  const fallback = { type: 'object', properties: {} }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fallback
  }
  let serialized: string
  try {
    serialized = JSON.stringify(raw)
  } catch {
    return fallback // 순환 참조 등
  }
  if (serialized.length > MAX_INPUT_SCHEMA_BYTES) {
    return fallback
  }
  return raw as Record<string, unknown>
}

function normalizeAnnotations(
  raw: unknown,
): { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined
  }
  const candidate = raw as Record<string, unknown>
  const result: { readOnlyHint?: boolean; destructiveHint?: boolean } = {}
  if (typeof candidate.readOnlyHint === 'boolean') {
    result.readOnlyHint = candidate.readOnlyHint
  }
  if (typeof candidate.destructiveHint === 'boolean') {
    result.destructiveHint = candidate.destructiveHint
  }
  return result.readOnlyHint === undefined && result.destructiveHint === undefined ? undefined : result
}

/** tools/call 결과의 content 배열에서 텍스트만 모은다. 비텍스트(이미지·리소스)는 표식만 */
function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return ''
  }
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) {
      continue
    }
    const candidate = block as Record<string, unknown>
    if (candidate.type === 'text' && typeof candidate.text === 'string') {
      parts.push(candidate.text)
    } else if (typeof candidate.type === 'string') {
      parts.push(`[${candidate.type} 콘텐츠 — 텍스트 아님]`)
    }
  }
  return parts.join('\n')
}

/**
 * 자식 프로세스 트리를 종료한다 — 좀비/고아 방지(§5).
 * Windows에서는 npx/launcher가 손자 프로세스를 띄울 수 있어 taskkill /T로 트리째 죽인다.
 */
function killProcessTree(child: ChildProcessWithoutNullStreams): void {
  try {
    if (process.platform === 'win32' && child.pid !== undefined) {
      // taskkill은 별도 프로세스다. spawn 실패(ENOENT 등)는 동기 throw가 아니라 비동기
      // 'error'로 오므로, 리스너가 없으면 메인이 죽는다 — 반드시 처리하고 결과도 로깅한다.
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        shell: false,
      })
      killer.on('error', (error) => console.error('[mcp.stdio]: taskkill 실행 실패:', error))
      killer.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          console.error(`[mcp.stdio]: taskkill 비정상 종료 (code=${code})`)
        }
      })
    } else {
      child.kill()
    }
  } catch (error) {
    console.error('[mcp.stdio]: 프로세스 트리 종료 실패:', error)
  }
}
