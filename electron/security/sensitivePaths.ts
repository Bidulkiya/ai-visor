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

/** 경로를 소문자 세그먼트 배열로 — 구분자(\, /)로 나누고 빈 조각 제거 */
function toSegments(lowerPath: string): string[] {
  return lowerPath.split(/[\\/]+/).filter((segment) => segment.length > 0)
}

/** needle 세그먼트들이 haystack 세그먼트에 연속으로 등장하는가 */
function containsSegmentRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0) {
    return false
  }
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((segment, offset) => haystack[start + offset] === segment)) {
      return true
    }
  }
  return false
}

/**
 * 민감 위치에 닿는 경로인가 — 자기 데이터(앱 userData)는 예외로 허용.
 * substring이 아니라 **세그먼트 단위**로 비교한다 → '.ssh'는 '.ssh' 폴더만 막고
 * '.ssh-utils' 같은 정상 폴더는 막지 않는다(오탐 방지). 'id_rsa' 같은 파일명도
 * 정확히 그 이름의 세그먼트일 때만 막는다.
 */
export function isSensitivePath(absolutePath: string): boolean {
  const lower = absolutePath.toLowerCase()
  const appDataPath = app.getPath('userData').toLowerCase()
  if (lower.startsWith(appDataPath)) {
    return false
  }
  const segments = toSegments(lower)
  return SENSITIVE_PATH_FRAGMENTS.some((fragment) => containsSegmentRun(segments, toSegments(fragment)))
}
