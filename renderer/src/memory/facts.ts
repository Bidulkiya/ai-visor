/**
 * 사실 분리 추출·저장 (기획서 §5.2)
 *
 * 요약은 손실 압축이다 — 이름·선호·약속 같은 중요한 사실은 요약과 별개로
 * 구조화 키-값으로 따로 저장한다.
 * 추출은 LLM의 일이지만 memory는 core를 import할 수 없으므로(경계 §2)
 * 추출기는 함수로 주입받는다.
 */

import type { MemoryDatabase } from './db'
import type { ConversationTurn } from './shortTerm'

export const MAX_FACT_KEY_LENGTH = 64
export const MAX_FACT_VALUE_LENGTH = 500

export interface ExtractedFact {
  /** 예: '사용자 이름', '좋아하는 음식', '다음 주 약속' */
  key: string
  value: string
}

export type FactExtractor = (turns: readonly ConversationTurn[]) => Promise<ExtractedFact[]>

export type ExtractAndStoreResult =
  | { status: 'stored'; storedCount: number }
  | { status: 'extractor-failed'; errorMessage: string }
  | { status: 'store-failed'; errorMessage: string }

export interface FactStore {
  /** 같은 키는 최신 값으로 덮어쓴다 */
  upsertFact(key: string, value: string, now?: number): Promise<void>
  getFact(key: string): Promise<string | null>
  getAllFacts(): Promise<ExtractedFact[]>
  /** 대화에서 사실을 추출해 일괄 저장. 유효하지 않은 항목은 건너뛴다 */
  extractAndStoreFacts(
    turns: readonly ConversationTurn[],
    extract: FactExtractor,
    now?: number,
  ): Promise<ExtractAndStoreResult>
}

interface FactRow {
  key: string
  value: string
}

/** 공백 정리 + 빈 값/과길이 거부. 유효하지 않으면 null */
function normalizeFact(fact: ExtractedFact): ExtractedFact | null {
  const key = fact.key.trim()
  const value = fact.value.trim()
  if (key.length === 0 || value.length === 0) {
    return null
  }
  if (key.length > MAX_FACT_KEY_LENGTH || value.length > MAX_FACT_VALUE_LENGTH) {
    return null
  }
  return { key, value }
}

const UPSERT_FACT_SQL = `INSERT INTO facts (key, value, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`

export function createFactStore(database: MemoryDatabase): FactStore {
  async function upsertFact(key: string, value: string, now: number = Date.now()): Promise<void> {
    const normalized = normalizeFact({ key, value })
    if (normalized === null) {
      throw new Error('저장할 수 없는 사실입니다 (빈 값 또는 길이 초과)')
    }
    await database.write(UPSERT_FACT_SQL, [normalized.key, normalized.value, now])
  }

  async function getFact(key: string): Promise<string | null> {
    const row = await database.get<FactRow>('SELECT key, value FROM facts WHERE key = ?', [key.trim()])
    return row?.value ?? null
  }

  async function getAllFacts(): Promise<ExtractedFact[]> {
    const rows = await database.all<FactRow>('SELECT key, value FROM facts ORDER BY key')
    return rows.map((row) => ({ key: row.key, value: row.value }))
  }

  async function extractAndStoreFacts(
    turns: readonly ConversationTurn[],
    extract: FactExtractor,
    now: number = Date.now(),
  ): Promise<ExtractAndStoreResult> {
    if (turns.length === 0) {
      return { status: 'stored', storedCount: 0 }
    }

    let extractedFacts: ExtractedFact[]
    try {
      extractedFacts = await extract(turns)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '사실 추출에 실패했습니다'
      console.error('[facts.extractAndStoreFacts]: 추출 실패 — 이번 세션 사실은 저장 안 됨:', error)
      return { status: 'extractor-failed', errorMessage }
    }

    const validFacts = extractedFacts
      .map(normalizeFact)
      .filter((fact): fact is ExtractedFact => fact !== null)
    if (validFacts.length === 0) {
      return { status: 'stored', storedCount: 0 }
    }

    try {
      await database.writeBatch(
        validFacts.map((fact) => ({
          sql: UPSERT_FACT_SQL,
          parameters: [fact.key, fact.value, now],
        })),
      )
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '사실 저장에 실패했습니다'
      console.error('[facts.extractAndStoreFacts]: 저장 실패:', error)
      return { status: 'store-failed', errorMessage }
    }
    return { status: 'stored', storedCount: validFacts.length }
  }

  return { upsertFact, getFact, getAllFacts, extractAndStoreFacts }
}
