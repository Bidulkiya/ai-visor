/**
 * 단기기억 — 세션 캐시 (휘발성, 기획서 §5.1)
 *
 * 앱을 켠 순간부터 끌 때까지의 대화 맥락을 메모리에만 둔다.
 * 영속화(주기 스냅샷·종료 시 요약)는 longTerm 몫이고,
 * 이 모듈은 어떤 저장소도 모른다.
 */

export interface ConversationTurn {
  userText: string
  /** 끼어들기로 잘린 턴은 빈 문자열일 수 있다 */
  assistantText: string
  timestamp: number
}

export interface ShortTermMemory {
  appendTurn(turn: ConversationTurn): void
  /** 방어적 복사본 — 반환 배열을 수정해도 내부 상태는 안전하다 */
  getTurns(): readonly ConversationTurn[]
  getTurnCount(): number
  /** 장기 이관 완료 후 등 세션 캐시 비우기 */
  clear(): void
}

export function createShortTermMemory(): ShortTermMemory {
  let turns: ConversationTurn[] = []

  return {
    appendTurn(turn: ConversationTurn): void {
      turns.push(turn)
    },
    getTurns(): readonly ConversationTurn[] {
      return [...turns]
    },
    getTurnCount(): number {
      return turns.length
    },
    clear(): void {
      turns = []
    },
  }
}
