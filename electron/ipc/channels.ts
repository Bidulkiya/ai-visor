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

  // Python 사이드카(+2 발표) — PPTX 파싱·슬라이드 렌더는 메인이 사이드카로 위임
  sidecarPickPptx: 'sidecar:pick-pptx',
  sidecarExtractDeck: 'sidecar:extract-deck',
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
export type ToolOperationName = 'search_web' | 'read_file' | 'open_app' | 'delete_file'

export interface ToolOperationResult {
  isSuccess: boolean
  output: string
  /** 가능한 작업만 — 예: 휴지통 이동된 원래 경로 (R4 롤백 정보) */
  rollbackInfo?: string
}

/**
 * 사이드카 발표 와이어 타입 — renderer/src/presentation/sidecarDeck.ts와 거울 동기.
 * 슬라이드 한 장: 텍스트·노트 + (가능하면) 슬라이드 이미지 data URL. 이미지 없으면 null.
 */
export interface SidecarSlide {
  title: string
  bodyText: string
  speakerNotes: string
  imageDataUrl: string | null
}

/**
 * PPTX 추출 결과:
 * - ok: 슬라이드 추출 성공(렌더는 실패해도 ok — renderNotice로 안내)
 * - unavailable: 사이드카(Python) 자체가 없음/미준비 — 데모 폴백 대상
 * - failed: 사이드카는 있으나 이 파일 파싱에 실패
 */
export type SidecarExtractResult =
  | { status: 'ok'; sourceName: string; slides: SidecarSlide[]; renderNotice: string | null }
  | { status: 'unavailable'; message: string }
  | { status: 'failed'; message: string }
