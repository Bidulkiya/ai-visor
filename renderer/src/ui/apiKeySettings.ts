/**
 * API 키 설정 저장소 (CLAUDE.md R7)
 *
 * 키는 코드/번들 어디에도 없다 — 사용자가 설정 화면에서 입력한 값을
 * localStorage(로컬 프로필 폴더)에 보관하고 런타임에 조회한다.
 * core는 이 저장 방식을 모른다(getApiKey 함수만 주입받음).
 */

const API_KEY_STORAGE_KEY = 'aiVisor.anthropicApiKey'
/** 마스킹 표시용 — 앞·뒤 몇 글자만 남긴다 */
const MASK_PREFIX_LENGTH = 10
const MASK_SUFFIX_LENGTH = 4

function isStorageAvailable(): boolean {
  return typeof localStorage !== 'undefined'
}

export function getStoredApiKey(): string | null {
  if (!isStorageAvailable()) {
    return null
  }
  const storedKey = localStorage.getItem(API_KEY_STORAGE_KEY)
  if (storedKey === null || storedKey.trim().length === 0) {
    return null
  }
  return storedKey
}

/** 공백을 정리해 저장한다. 빈 값이면 저장하지 않고 false */
export function saveApiKey(rawKey: string): boolean {
  if (!isStorageAvailable()) {
    return false
  }
  const trimmedKey = rawKey.trim()
  if (trimmedKey.length === 0) {
    return false
  }
  localStorage.setItem(API_KEY_STORAGE_KEY, trimmedKey)
  return true
}

export function clearApiKey(): void {
  if (isStorageAvailable()) {
    localStorage.removeItem(API_KEY_STORAGE_KEY)
  }
}

/** 화면 표시용 마스킹 — 키 전체를 다시 노출하지 않는다 */
export function maskApiKey(key: string): string {
  if (key.length <= MASK_PREFIX_LENGTH + MASK_SUFFIX_LENGTH) {
    return `${key.slice(0, 4)}…`
  }
  return `${key.slice(0, MASK_PREFIX_LENGTH)}…${key.slice(-MASK_SUFFIX_LENGTH)}`
}
