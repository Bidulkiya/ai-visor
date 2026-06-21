/**
 * 메인 ↔ 렌더러 IPC 채널 정의 (ARCHITECTURE.md §1 electron/ipc/)
 *
 * 채널 이름과 페이로드 타입은 여기서만 정의하고 main/preload 양쪽이 공유한다.
 * 매직 스트링 금지 — 채널 이름을 코드에 직접 쓰지 않는다.
 */

export const IPC_CHANNELS = {
  /** 연결 핸드셰이크 — 기능이 아니라 메인↔렌더러 배선 점검용 */
  ping: 'system:ping',

  /** 메인 → 렌더러: 곧 종료된다, 기억을 영속하라 */
  appWillQuit: 'app:will-quit',
  /** 렌더러 → 메인: 영속 완료, 종료해도 된다 */
  appQuitReady: 'app:quit-ready',

  /**
   * 도구 실제 작업 — 파일·프로세스·네트워크는 메인 프로세스에서만 (R4 보조).
   * 게이트/감사는 렌더러(core가 호출), 여기는 순수 작업 수행만.
   */
  toolOperation: 'tools:operation',

  // SQLite 드라이버 — 네이티브(better-sqlite3)는 메인에서만 돌고 렌더러는 IPC로 요청
  databaseExec: 'database:exec',
  databaseRun: 'database:run',
  databaseGet: 'database:get',
  databaseAll: 'database:all',
  databaseClose: 'database:close',

  // Python 사이드카(+2) — 문서(PPTX·PDF·DOCX·TXT·MD) 파싱·슬라이드 렌더를 메인이 위임
  sidecarPickDocument: 'sidecar:pick-document',
  sidecarExtractDocument: 'sidecar:extract-document',

  /**
   * MCP(Model Context Protocol) — 노아가 외부 MCP 서버의 호스트(클라이언트)가 된다.
   * 트랜스포트(stdio 자식 프로세스)·네트워크는 메인에서만 (R4 보조, §5 자식 프로세스 관리).
   * 게이트·감사·redact는 렌더러 tools/가 담당 — 여기는 연결·도구목록·도구호출만.
   */
  mcpConnect: 'mcp:connect',
  mcpCallTool: 'mcp:call-tool',
} as const

export interface PingResult {
  isAlive: boolean
  electronVersion: string
}

/**
 * SQL 파라미터 와이어 타입 — renderer/src/memory/db.ts의 SqlParameter와
 * 거울 동기(mirror)다. electron과 renderer는 서로의 소스를 import하지 않으므로
 * 한쪽을 바꾸면 반드시 양쪽을 같이 바꾼다.
 */
export type SqlParameter = string | number | null
export type SqlParameters = ReadonlyArray<SqlParameter>

/**
 * 도구 작업 와이어 타입 — renderer/src/tools/builtins.ts와 거울 동기.
 * 작업 이름은 도구 이름과 1:1이다.
 */
export type ToolOperationName =
  // 기존 4종
  | 'search_web'
  | 'read_file'
  | 'open_app'
  | 'delete_file'
  // 파일·폴더 (+1 확장)
  | 'write_file'
  | 'move_file'
  | 'copy_file'
  | 'list_directory'
  | 'create_folder'
  | 'search_files'
  | 'get_file_info'
  | 'compress'
  | 'extract'
  // 웹
  | 'web_fetch'
  // 시스템 정보
  | 'system_status'
  | 'get_clipboard'
  | 'set_clipboard'
  | 'list_processes'
  // 상호작용
  | 'send_notification'
  | 'schedule_reminder'
  | 'open_url'
  | 'take_screenshot'
  // 프로세스
  | 'kill_process'

export interface ToolOperationResult {
  isSuccess: boolean
  output: string
  /** 가능한 작업만 — 예: 휴지통 이동된 원래 경로 (R4 롤백 정보) */
  rollbackInfo?: string
}

/** 사이드카가 다룰 수 있는 문서 타입 — renderer/src/presentation/document.ts와 거울 동기 */
export type SupportedDocumentType = 'pptx' | 'pdf' | 'docx' | 'txt' | 'md'

// ── MCP 와이어 타입 — renderer/src/ui/mcpSettings.ts·tools/mcp.ts와 거울 동기 ──

/**
 * MCP 서버 연결 설정 — 사용자가 설정 UI에서 지정(서버 경로/명령).
 * stdio 트랜스포트: command + args를 셸 없이 직접 실행한다(인젝션 차단).
 */
export interface McpServerConfig {
  /** 안정적 식별자 — 도구 네임스페이스(mcp__<id>__<tool>)에 쓰인다. [a-zA-Z0-9_-]만 */
  id: string
  /** 사람이 읽는 이름(상태 표시용) */
  label: string
  /** 실행 명령(예: 'npx', 'node', 'python') */
  command: string
  /** 명령 인자(예: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\docs']) */
  args: string[]
  /** 꺼두면 연결을 시도하지 않는다 */
  enabled: boolean
}

/**
 * MCP 서버가 노출하는 도구 하나 — tools/list 결과를 와이어로 옮긴 것.
 * annotations는 서버의 자기申告다 — 위험도를 '올리는' 보조 신호로만 쓰고,
 * 게이트를 '낮추는' 근거로는 쓰지 않는다(신뢰 경계 — renderer/src/tools/mcp.ts).
 */
export interface McpToolDescriptor {
  serverId: string
  /** MCP 서버 기준 원래 도구 이름(tools/call에 그대로 보낸다) */
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
  }
}

/** 서버별 연결 결과 — 실패해도 throw하지 않고 상태로 보고(graceful, 노아 기본 기능 보존) */
export type McpServerConnectionStatus =
  | { id: string; label: string; status: 'connected'; toolCount: number }
  | { id: string; label: string; status: 'error'; message: string }
  | { id: string; label: string; status: 'disabled' }

export interface McpConnectResult {
  servers: McpServerConnectionStatus[]
  /** 연결된 모든 서버의 도구를 합친 목록(렌더러가 레지스트리에 등록) */
  tools: McpToolDescriptor[]
}

/** MCP 도구 호출 결과 — 실패도 결과 객체로(LLM이 인지). 출력 상한·정제는 렌더러가 추가 적용 */
export interface McpCallResult {
  isSuccess: boolean
  output: string
}

/**
 * 사이드카 문서 와이어 타입 — renderer/src/presentation/sidecarDocument.ts와 거울 동기.
 * 구획(슬라이드/페이지/섹션) 한 개: 텍스트·노트 + (PPTX만) 이미지 data URL. 없으면 null.
 */
export interface SidecarSlide {
  title: string
  bodyText: string
  speakerNotes: string
  imageDataUrl: string | null
}

/**
 * 문서 추출 결과:
 * - ok: 구획 추출 성공(PPTX 렌더는 실패해도 ok — renderNotice로 안내)
 * - unavailable: 사이드카(Python) 자체가 없음/미준비 — 데모 폴백 대상
 * - failed: 사이드카는 있으나 이 파일 파싱 실패 또는 미지원 형식(HWP 등)
 */
export type SidecarExtractResult =
  | {
      status: 'ok'
      sourceName: string
      docType: SupportedDocumentType
      slides: SidecarSlide[]
      renderNotice: string | null
    }
  | { status: 'unavailable'; message: string }
  | { status: 'failed'; message: string }
