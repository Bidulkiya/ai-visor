/**
 * 민감 경로 차단 — 파일을 다루는 메인 프로세스 코드의 공통 방어선.
 *
 * 도구(toolHost)와 사이드카(manager)가 같은 블록리스트를 쓰도록 한 곳에 모은다
 * (두 곳에 복제하면 한쪽만 갱신돼 보안 구멍이 생긴다).
 */

import { app } from 'electron'

/**
 * 자격증명·시스템 비밀이 모인 위치 — 경로(소문자)에 이 조각이 들어가면 차단.
 * 도구·사이드카가 임의 시스템 파일을 읽거나/지우는 것을 막는다.
 */
export const SENSITIVE_PATH_FRAGMENTS: readonly string[] = [
  '\\.ssh',
  '\\.aws',
  '\\.gnupg',
  '\\windows\\system32\\config',
  '\\system volume information',
  'ntuser.dat',
  'id_rsa',
  'id_ed25519',
  '\\appdata\\roaming\\microsoft\\credentials',
  '\\appdata\\local\\microsoft\\credentials',
  '\\appdata\\local\\google\\chrome\\user data',
]

/** 민감 위치에 닿는 경로인가 — 자기 데이터(앱 userData)는 예외로 허용 */
export function isSensitivePath(absolutePath: string): boolean {
  const lower = absolutePath.toLowerCase()
  const appDataPath = app.getPath('userData').toLowerCase()
  if (lower.startsWith(appDataPath)) {
    return false
  }
  return SENSITIVE_PATH_FRAGMENTS.some((fragment) => lower.includes(fragment))
}
