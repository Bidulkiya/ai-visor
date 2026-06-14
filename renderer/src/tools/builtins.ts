/**
 * Layer 1 내장 도구 정의 (기획서 §6).
 *
 * 실제 작업(파일·프로세스·네트워크)은 메인 프로세스 toolHost가 하고,
 * 여기서는 도구 메타(이름·위험도·스키마)와 IPC 위임만 정의한다.
 * risk 태그는 감정과 무관한 코드 상수다 (R5).
 *
 * 도구 이름 = IPC 작업 이름(electron/ipc/channels.ts의 ToolOperationName과 1:1).
 */

import type { ToolDefinition, ToolExecutionResult, ToolRegistry, RiskLevel } from './registry'

/** preload(electron/preload.ts)의 tools.runOperation과 거울 동기 */
export interface ToolOperationBridge {
  runOperation(name: string, input: Record<string, unknown>): Promise<ToolExecutionResult>
}

type JsonSchema = Record<string, unknown>

const EMPTY_INPUT_SCHEMA: JsonSchema = { type: 'object', properties: {}, additionalProperties: false }

function stringField(description: string): JsonSchema {
  return { type: 'string', description }
}

function objectSchema(properties: Record<string, JsonSchema>, required: string[]): JsonSchema {
  return { type: 'object', properties, required }
}

/** 메인 프로세스 작업을 그대로 위임하는 execute를 만든다 */
function delegateToHost(
  bridge: ToolOperationBridge,
  operationName: string,
): (input: Record<string, unknown>) => Promise<ToolExecutionResult> {
  return (input) => bridge.runOperation(operationName, input)
}

interface ToolSpec {
  name: string
  description: string
  risk: RiskLevel
  inputSchema: JsonSchema
}

function defineTools(bridge: ToolOperationBridge, specs: readonly ToolSpec[]): ToolDefinition[] {
  return specs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    risk: spec.risk,
    inputSchema: spec.inputSchema,
    execute: delegateToHost(bridge, spec.name),
  }))
}

// ── 기존 4종 (Core +1 초기) ──
const CORE_TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'search_web',
    description: '웹에서 정보를 검색해 요약 결과를 돌려준다. 최신 정보·사실 확인에 쓴다.',
    risk: 'safe',
    inputSchema: objectSchema({ query: stringField('검색어') }, ['query']),
  },
  {
    name: 'read_file',
    description: '지정한 절대 경로의 텍스트 파일 내용을 읽는다.',
    risk: 'safe',
    inputSchema: objectSchema({ path: stringField('읽을 파일의 절대 경로') }, ['path']),
  },
  {
    name: 'open_app',
    description: '지정한 절대 경로의 앱·문서·폴더를 연다(프로세스 실행).',
    risk: 'caution',
    inputSchema: objectSchema({ path: stringField('실행하거나 열 대상의 절대 경로') }, ['path']),
  },
  {
    name: 'delete_file',
    description: '지정한 파일을 삭제한다(휴지통으로 이동 — 복원 가능).',
    risk: 'dangerous',
    inputSchema: objectSchema({ path: stringField('삭제할 파일의 절대 경로') }, ['path']),
  },
]

// ── 파일·폴더 ──
const FILE_TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'write_file',
    description: '지정한 절대 경로에 텍스트를 쓴다(있으면 덮어씀). 상위 폴더는 미리 있어야 한다.',
    risk: 'caution',
    inputSchema: objectSchema(
      { path: stringField('쓸 파일의 절대 경로'), content: stringField('파일에 쓸 텍스트') },
      ['path', 'content'],
    ),
  },
  {
    name: 'move_file',
    description: '파일을 다른 경로로 이동(이름 변경)한다. 대상이 이미 있으면 거부한다.',
    risk: 'caution',
    inputSchema: objectSchema(
      { source: stringField('원본 절대 경로'), destination: stringField('이동할 절대 경로') },
      ['source', 'destination'],
    ),
  },
  {
    name: 'copy_file',
    description: '파일을 다른 경로로 복사한다. 대상이 이미 있으면 거부한다.',
    risk: 'caution',
    inputSchema: objectSchema(
      { source: stringField('원본 파일 절대 경로'), destination: stringField('복사할 절대 경로') },
      ['source', 'destination'],
    ),
  },
  {
    name: 'list_directory',
    description: '지정한 폴더의 파일·하위 폴더 목록을 돌려준다.',
    risk: 'safe',
    inputSchema: objectSchema({ path: stringField('목록을 볼 폴더의 절대 경로') }, ['path']),
  },
  {
    name: 'create_folder',
    description: '새 폴더를 만든다. 상위 폴더는 미리 있어야 한다.',
    risk: 'safe',
    inputSchema: objectSchema({ path: stringField('만들 폴더의 절대 경로') }, ['path']),
  },
  {
    name: 'search_files',
    description: '폴더 아래에서 파일명(과 선택적으로 내용)으로 파일을 찾는다.',
    risk: 'safe',
    inputSchema: objectSchema(
      {
        root: stringField('검색을 시작할 폴더의 절대 경로'),
        query: stringField('찾을 문자열(파일명·내용)'),
        searchContent: { type: 'boolean', description: '파일 내용까지 검색할지(기본 false)' },
      },
      ['root', 'query'],
    ),
  },
  {
    name: 'get_file_info',
    description: '파일·폴더의 크기·수정일·종류 같은 정보를 돌려준다.',
    risk: 'safe',
    inputSchema: objectSchema({ path: stringField('정보를 볼 대상의 절대 경로') }, ['path']),
  },
  {
    name: 'compress',
    description: '파일이나 폴더를 zip으로 압축한다.',
    risk: 'caution',
    inputSchema: objectSchema(
      { source: stringField('압축할 파일·폴더의 절대 경로'), destination: stringField('만들 .zip의 절대 경로') },
      ['source', 'destination'],
    ),
  },
  {
    name: 'extract',
    description: 'zip 압축 파일을 지정한 폴더에 푼다.',
    risk: 'caution',
    inputSchema: objectSchema(
      { source: stringField('풀 .zip의 절대 경로'), destination: stringField('압축을 풀 폴더의 절대 경로') },
      ['source', 'destination'],
    ),
  },
]

// ── 웹 ──
const WEB_TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'web_fetch',
    description: 'http/https URL의 본문을 가져와 텍스트로 돌려준다(HTML은 태그를 제거).',
    risk: 'safe',
    inputSchema: objectSchema({ url: stringField('가져올 http/https URL') }, ['url']),
  },
]

// ── 시스템 정보 ──
const SYSTEM_TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'system_status',
    description: '배터리·CPU·메모리·디스크 등 시스템 상태를 요약해 돌려준다.',
    risk: 'safe',
    inputSchema: EMPTY_INPUT_SCHEMA,
  },
  {
    name: 'get_clipboard',
    description: '현재 클립보드의 텍스트를 읽는다.',
    risk: 'safe',
    inputSchema: EMPTY_INPUT_SCHEMA,
  },
  {
    name: 'set_clipboard',
    description: '클립보드에 텍스트를 넣는다(기존 내용은 덮어써진다).',
    risk: 'caution',
    inputSchema: objectSchema({ text: stringField('클립보드에 넣을 텍스트') }, ['text']),
  },
  {
    name: 'list_processes',
    description: '실행 중인 프로세스 목록(메모리 상위)을 돌려준다.',
    risk: 'safe',
    inputSchema: EMPTY_INPUT_SCHEMA,
  },
]

// ── 상호작용 ──
const INTERACTION_TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'send_notification',
    description: 'OS 알림을 띄운다.',
    risk: 'safe',
    inputSchema: objectSchema(
      { title: stringField('알림 제목'), body: stringField('알림 본문(선택)') },
      ['title'],
    ),
  },
  {
    name: 'schedule_reminder',
    description: '지정한 초 뒤에 알림을 예약한다(앱이 켜져 있는 동안만 유효).',
    risk: 'caution',
    inputSchema: objectSchema(
      { message: stringField('알릴 내용'), delaySeconds: { type: 'number', description: '몇 초 뒤에 알릴지' } },
      ['message', 'delaySeconds'],
    ),
  },
  {
    name: 'open_url',
    description: 'http/https URL을 외부 브라우저로 연다(사용자 확인을 거친다).',
    risk: 'caution',
    inputSchema: objectSchema({ url: stringField('열 http/https URL') }, ['url']),
  },
  {
    name: 'take_screenshot',
    description: '화면을 캡처해 로컬 파일로 저장한다(외부로 보내지 않는다). 저장 경로를 돌려준다.',
    risk: 'caution',
    inputSchema: EMPTY_INPUT_SCHEMA,
  },
]

// ── 프로세스 ──
const PROCESS_TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'kill_process',
    description: '지정한 PID의 프로세스를 강제 종료한다. OS 핵심 프로세스는 종료할 수 없다.',
    risk: 'dangerous',
    inputSchema: objectSchema({ pid: { type: 'number', description: '종료할 프로세스의 PID' } }, ['pid']),
  },
]

const ALL_TOOL_SPECS: readonly ToolSpec[] = [
  ...CORE_TOOL_SPECS,
  ...FILE_TOOL_SPECS,
  ...WEB_TOOL_SPECS,
  ...SYSTEM_TOOL_SPECS,
  ...INTERACTION_TOOL_SPECS,
  ...PROCESS_TOOL_SPECS,
]

export function buildBuiltinTools(bridge: ToolOperationBridge): ToolDefinition[] {
  return defineTools(bridge, ALL_TOOL_SPECS)
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
