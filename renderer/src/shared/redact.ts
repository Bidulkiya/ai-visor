/**
 * 시크릿 가림 — 텍스트에서 명백한 키·토큰 패턴을 마스킹하는 순수 유틸 (R7 방어).
 *
 * 의존이 없는 leaf다. 도구 감사(tools/audit)와 기억 사실(memory/facts)이 같은
 * 패턴으로 가리도록 단일 출처로 둔다(복제 시 한쪽만 갱신돼 누출이 생긴다).
 * 경로·일반 텍스트는 건드리지 않는다 — 시크릿 패턴만 가리므로 정확도를 해치지 않는다.
 */

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /sk-ant-[A-Za-z0-9_-]+/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /(api[_-]?key|token|password|secret)\s*[=:]\s*\S+/gi,
  // 아래는 형식이 명확해 오탐이 거의 없는 시크릿들 — 문서 등 외부 내용에서도 가린다.
  // 개인키 PEM 블록(여러 줄)은 통째로 가린다.
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, // GitHub 토큰
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS 액세스 키 ID
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API 키
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack 토큰
]
const REDACTED_PLACEHOLDER = '[가림]'

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, REDACTED_PLACEHOLDER),
    text,
  )
}
