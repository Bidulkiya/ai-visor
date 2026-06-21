/**
 * 최소 JSON-RPC 2.0 프레이밍 — MCP stdio 트랜스포트용 (순수, 단독 테스트 가능).
 *
 * MCP stdio는 줄바꿈으로 구분된 JSON-RPC 메시지를 쓴다(한 메시지=한 줄, 내부 줄바꿈 없음).
 * 외부 SDK 없이 이 한 파일로 프레이밍을 처리한다 — 의존성·다운로드 표면을 0으로 유지
 * (CLAUDE.md §5 패키징 함정 + 대용량 CDN 스톨 회피). 트랜스포트 I/O는 stdioClient가 맡고,
 * 여기서는 직렬화·역직렬화·메시지 분류만 한다.
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0'
  id: number
  result: Record<string, unknown>
}

export interface JsonRpcError {
  jsonrpc: '2.0'
  id: number
  error: { code: number; message: string; data?: unknown }
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError

/** 한 줄(개행 없는 JSON) — stdin에 그대로 흘릴 수 있게 개행을 붙여 돌려준다 */
export function encodeMessage(message: JsonRpcRequest | JsonRpcNotification): string {
  return `${JSON.stringify(message)}\n`
}

export function buildRequest(
  id: number,
  method: string,
  params?: Record<string, unknown>,
): JsonRpcRequest {
  return params === undefined
    ? { jsonrpc: '2.0', id, method }
    : { jsonrpc: '2.0', id, method, params }
}

export function buildNotification(
  method: string,
  params?: Record<string, unknown>,
): JsonRpcNotification {
  return params === undefined
    ? { jsonrpc: '2.0', method }
    : { jsonrpc: '2.0', method, params }
}

/**
 * 한 줄을 응답으로 파싱한다. 우리가 보낸 요청에 대한 응답(숫자 id + result|error)만
 * 인식하고, 그 외(서버 알림·로그·잘못된 줄)는 null로 무시한다 — 악성/잡음 입력에 견고.
 */
export function parseResponseLine(line: string): JsonRpcResponse | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const candidate = parsed as Record<string, unknown>
  if (typeof candidate.id !== 'number') {
    return null
  }
  if ('error' in candidate && isRpcErrorShape(candidate.error)) {
    return { jsonrpc: '2.0', id: candidate.id, error: candidate.error }
  }
  if ('result' in candidate && typeof candidate.result === 'object' && candidate.result !== null) {
    return { jsonrpc: '2.0', id: candidate.id, result: candidate.result as Record<string, unknown> }
  }
  return null
}

function isRpcErrorShape(value: unknown): value is { code: number; message: string; data?: unknown } {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return typeof candidate.code === 'number' && typeof candidate.message === 'string'
}

export function isSuccess(response: JsonRpcResponse): response is JsonRpcSuccess {
  return 'result' in response
}
