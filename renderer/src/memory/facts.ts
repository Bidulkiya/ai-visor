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
import { redactSecrets } from '../shared/redact'

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

/**
 * 공백 정리 + 시크릿 가림 + 빈 값/과길이 거부. 유효하지 않으면 null.
 * 추출기가 실수로 키·토큰을 사실로 뽑아도 평문으로 영속·주입되지 않게 가린다
 * (도구 이력과 같은 redact 정책 — 경로 등 일반 값은 그대로 통과). 가림 후 길이를 잰다.
 */
function normalizeFact(fact: ExtractedFact): ExtractedFact | null {
  const key = redactSecrets(fact.key.trim())
  const value = redactSecrets(fact.value.trim())
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

/**
 * 세션 내 핵심 사실 — 휘발성 세션 캐시 (shortTerm과 같은 결).
 *
 * 대화 도중 증분 추출된 사실을 메모리에 누적해, 최근 N턴 윈도우 밖으로 밀려난
 * 정보("고양이 이름 루키" 등)도 세션 내내 시스템 프롬프트에 유지하게 한다.
 * DB에 쓰지 않는다 — 영속(다음 세션 이어받기)은 종료 시 전체 추출이 담당한다.
 * 같은 key는 최신 값으로 합쳐(중복 누적 방지) redact·검증은 factStore와 같은 정책(normalizeFact).
 */
export interface SessionFactStore {
  merge(facts: readonly ExtractedFact[]): void
  getAll(): ExtractedFact[]
}

/**
 * 세션 사실에서 지난 세션 사실과 완전히 같은(key+value) 항목을 뺀다 — 중복 노출 최소화 (R3 역할 분리).
 * 값이 이번 세션에 갱신된 항목(같은 key·다른 value)은 남겨 최신 값이 "이번 대화" 섹션에 드러나게 한다.
 */
export function excludeFactsAlreadyKnown(
  sessionFacts: readonly ExtractedFact[],
  priorFacts: readonly ExtractedFact[],
): ExtractedFact[] {
  return sessionFacts.filter(
    (sessionFact) =>
      !priorFacts.some(
        (priorFact) => priorFact.key === sessionFact.key && priorFact.value === sessionFact.value,
      ),
  )
}

/**
 * 세션 사실 상한 — 토큰 폭증·key 변이 누적 방지선. 초과 시 가장 오래전 언급된 것부터 버린다.
 * 한 세션의 지속적 사실(이름·선호·진행 맥락)은 보통 이 수보다 적다 — 안전 상한. 체감 튜닝 대상.
 */
export const MAX_SESSION_FACTS = 40

export function createSessionFactStore(): SessionFactStore {
  // 삽입 순서 = 언급 최신순(갱신 시 재삽입으로 끝으로 이동). 상한 초과 시 맨 앞(오래됨)을 축출.
  const valueByKey = new Map<string, string>()
  return {
    merge(facts: readonly ExtractedFact[]): void {
      for (const fact of facts) {
        const normalized = normalizeFact(fact)
        if (normalized !== null) {
          // 같은 key는 최신 값으로 갱신하되 재삽입해 "최근 언급" 위치로 올린다(축출 우선순위용)
          valueByKey.delete(normalized.key)
          valueByKey.set(normalized.key, normalized.value)
        }
      }
      // 상한 초과분은 가장 오래전 언급된 key부터 버린다 — LLM key 변이로 무한 증식하지 않게
      while (valueByKey.size > MAX_SESSION_FACTS) {
        const oldestKey = valueByKey.keys().next().value
        if (oldestKey === undefined) {
          break
        }
        valueByKey.delete(oldestKey)
      }
    },
    getAll(): ExtractedFact[] {
      return [...valueByKey.entries()]
        .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
        .map(([key, value]) => ({ key, value }))
    },
  }
}
