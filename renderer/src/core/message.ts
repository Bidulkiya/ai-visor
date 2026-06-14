/**
 * 본체 입력 통일 규약 (CLAUDE.md R1)
 *
 * 모든 입력(채팅·음성·발표·시스템)은 본체에 들어가기 전 normalizeToMessage를
 * 거쳐 Message로 정규화된다. 본체는 source를 보고 동작을 분기하지 않는다 —
 * 어떤 source든 동일하게 처리한다.
 */

export const MESSAGE_SOURCES = ['chat', 'voice', 'presentation', 'system'] as const

export type MessageSource = (typeof MESSAGE_SOURCES)[number]

export interface Message {
  source: MessageSource
  text: string
  timestamp: number
}

/**
 * invalid-source: 허용된 4종이 아닌 source (IPC 등 외부 경계에서 온 값 방어)
 * invalid-text:   문자열이 아닌 text (null, undefined, 객체 등)
 * empty-text:     공백뿐인 text (빈 채팅 전송, STT 무음 결과 등)
 */
export type MessageRejectionReason = 'invalid-source' | 'invalid-text' | 'empty-text'

export type MessageNormalizationResult =
  | { isValid: true; message: Message }
  | { isValid: false; reason: MessageRejectionReason }

export function isMessageSource(value: unknown): value is MessageSource {
  return typeof value === 'string' && (MESSAGE_SOURCES as readonly string[]).includes(value)
}

/**
 * 외부 입력을 Message로 정규화한다. 본체 진입의 유일한 관문 (R1).
 *
 * 입력 경계(UI 폼, STT 결과, IPC)는 신뢰하지 않으므로 unknown으로 받아
 * 런타임 검증한다. 거부는 예외가 아니라 결과 값으로 반환한다 —
 * 호출자가 처리를 빠뜨릴 수 없게 하기 위함이다.
 */
export function normalizeToMessage(
  rawSource: unknown,
  rawText: unknown,
  timestamp: number = Date.now(),
): MessageNormalizationResult {
  if (!isMessageSource(rawSource)) {
    return { isValid: false, reason: 'invalid-source' }
  }
  if (typeof rawText !== 'string') {
    return { isValid: false, reason: 'invalid-text' }
  }

  const trimmedText = rawText.trim()
  if (trimmedText.length === 0) {
    return { isValid: false, reason: 'empty-text' }
  }

  return {
    isValid: true,
    message: { source: rawSource, text: trimmedText, timestamp },
  }
}
