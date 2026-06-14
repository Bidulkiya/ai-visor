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
]
const REDACTED_PLACEHOLDER = '[가림]'

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, REDACTED_PLACEHOLDER),
    text,
  )
}
