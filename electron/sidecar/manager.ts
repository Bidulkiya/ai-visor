/**
 * Python 사이드카 생명주기 관리 (기획서 원칙 5, CLAUDE.md §5 알려진 함정)
 *
 * Core 단계에서는 인터페이스(생명주기 + 준비 확인)만 둔다.
 * 실제 기능(STT, PPTX)은 +1/+2에서 채우되, 아래 함정 차단은 구현 시 필수다:
 *
 * TODO(+1 구현 시 반드시 지킬 것):
 *  1. spawn 시 자식 프로세스를 부모 세션에서 분리(detached) → 앱 종료 후 좀비 방지
 *  2. stdout/stderr를 전용 로그 파일로 리다이렉트 → 파이프 버퍼 가득참으로 인한 행(hang) 방지
 *  3. 소켓/포트 바인딩 확인(waitUntilReady) 후에만 호출 허용 → 기동 경쟁 조건 방지
 */

export interface SidecarStatus {
  isRunning: boolean
  /** 프로세스 기동 ≠ 준비됨. 소켓 바인딩 확인까지 끝나야 true */
  isReady: boolean
}

export interface SidecarManager {
  /** TODO(+1): detached spawn + 로그 파일 리다이렉트 */
  start(): Promise<void>

  /** TODO(+1): 프로세스 종료 + 로그 핸들 정리. 앱 종료 훅에서 반드시 호출 */
  stop(): Promise<void>

  /** TODO(+1): 소켓/포트 바인딩 폴링. 시간 내 준비 안 되면 false */
  waitUntilReady(timeoutMs: number): Promise<boolean>

  status(): SidecarStatus
}
