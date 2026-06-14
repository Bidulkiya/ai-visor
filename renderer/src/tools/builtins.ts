/**
 * Layer 1 내장 도구 정의 (기획서 §6).
 *
 * 실제 작업(파일·프로세스·네트워크)은 메인 프로세스 toolHost가 하고,
 * 여기서는 도구 메타(이름·위험도·스키마)와 IPC 위임만 정의한다.
 * risk 태그는 감정과 무관한 코드 상수다 (R5).
 */

import type { ToolDefinition, ToolExecutionResult, ToolRegistry } from './registry'

/** preload(electron/preload.ts)의 tools.runOperation과 거울 동기 */
export interface ToolOperationBridge {
  runOperation(name: string, input: Record<string, unknown>): Promise<ToolExecutionResult>
}

function pathSchema(description: string): Record<string, unknown> {
  return {
    type: 'object',
    properties: { path: { type: 'string', description } },
    required: ['path'],
  }
}

/** 메인 프로세스 작업을 그대로 위임하는 execute를 만든다 */
function delegateToHost(
  bridge: ToolOperationBridge,
  operationName: string,
): (input: Record<string, unknown>) => Promise<ToolExecutionResult> {
  return (input) => bridge.runOperation(operationName, input)
}

export function buildBuiltinTools(bridge: ToolOperationBridge): ToolDefinition[] {
  return [
    {
      name: 'search_web',
      description: '웹에서 정보를 검색해 요약 결과를 돌려준다. 최신 정보·사실 확인에 쓴다.',
      risk: 'safe',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: '검색어' } },
        required: ['query'],
      },
      execute: delegateToHost(bridge, 'search_web'),
    },
    {
      name: 'read_file',
      description: '지정한 절대 경로의 텍스트 파일 내용을 읽는다.',
      risk: 'safe',
      inputSchema: pathSchema('읽을 파일의 절대 경로'),
      execute: delegateToHost(bridge, 'read_file'),
    },
    {
      name: 'open_app',
      description: '지정한 절대 경로의 앱·문서·폴더를 연다(프로세스 실행).',
      risk: 'caution',
      inputSchema: pathSchema('실행하거나 열 대상의 절대 경로'),
      execute: delegateToHost(bridge, 'open_app'),
    },
    {
      name: 'delete_file',
      description: '지정한 파일을 삭제한다(휴지통으로 이동 — 복원 가능).',
      risk: 'dangerous',
      inputSchema: pathSchema('삭제할 파일의 절대 경로'),
      execute: delegateToHost(bridge, 'delete_file'),
    },
  ]
}

export function registerBuiltinTools(registry: ToolRegistry, bridge: ToolOperationBridge): void {
  for (const tool of buildBuiltinTools(bridge)) {
    registry.register(tool)
  }
}

/** preload 브리지에서 tools 부분을 찾는다. Electron 밖이면 null */
export function getToolOperationBridge(): ToolOperationBridge | null {
  const bridgeHost = globalThis as { aiVisor?: { tools?: ToolOperationBridge } }
  return bridgeHost.aiVisor?.tools ?? null
}
