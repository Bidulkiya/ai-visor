/**
 * 장기기억 — 영속 + 요약 + 스냅샷 (기획서 §5.1~5.3)
 *
 * - 앱 시작: 최신 요약을 읽어 맥락 파악. 요약보다 새 스냅샷이 있으면
 *   비정상 종료로 보고 복구 대상으로 함께 넘긴다.
 * - 세션 중: N턴마다 단기기억을 통째로 스냅샷 — 크래시·강제종료 시 증발 방지.
 * - 앱 종료: 단기 → 요약(손실 압축) → 장기 저장. 요약 실패 시 스냅샷으로 대체
 *   저장해 어떤 경로로도 기억이 통째로 사라지지 않게 한다.
 * - 요약은 LLM의 일이지만 memory는 core를 import할 수 없으므로(경계 §2)
 *   요약기는 함수로 주입받는다. 감정 영속도 여기서 담당한다(§4 상태 저장 위치).
 */

import { EMOTION_STATE_ROW_ID, type MemoryDatabase } from './db'
import type { ConversationTurn, ShortTermMemory } from './shortTerm'
import type { ExtractAndStoreResult, FactExtractor, FactStore } from './facts'

/** 이 턴 수마다 단기기억을 스냅샷한다. 체감 튜닝 대상. */
export const SNAPSHOT_INTERVAL_TURNS = 10
/** 스냅샷은 최신 몇 개만 유지한다 (무한 증식 방지) */
export const MAX_SNAPSHOTS_KEPT = 3

/** emotion 모듈의 VadState와 구조적으로 호환 — 직접 import하지 않는 이유는 경계(§2) */
export interface PersistedEmotionState {
  valence: number
  arousal: number
  dominance: number
}

/** 첫 실행 기본 감정 — db 시드와 동일한 중립 (기획서 §5.3) */
export const FIRST_RUN_EMOTION_STATE: PersistedEmotionState = {
  valence: 0,
  arousal: 0,
  dominance: 0,
}

export type SessionSummarizer = (turns: readonly ConversationTurn[]) => Promise<string>

export interface StartupContext {
  latestSummary: string | null
  /** 최신 요약 이후에 남은 스냅샷(JSON 직렬화된 턴 배열) — 비정상 종료 복구용 */
  recoveredSnapshot: string | null
  /** 요약도 스냅샷도 없음 — 온보딩 첫인사 대상 (기획서 §5.3) */
  isFirstRun: boolean
}

export type PersistSummaryResult =
  | { status: 'saved-summary' }
  /** 요약 실패 — 원본 스냅샷으로 대체 저장됨 (기억 증발 방지) */
  | { status: 'saved-snapshot-fallback'; errorMessage: string }
  /** 요약도 대체 스냅샷도 실패 — 이번 세션 기억은 저장되지 못함 */
  | { status: 'persist-failed'; errorMessage: string }
  | { status: 'skipped-empty' }

export type SnapshotResult =
  | { status: 'saved' }
  /** N턴 주기에 아직 도달하지 않음 */
  | { status: 'not-due' }
  | { status: 'failed'; errorMessage: string }

/** 앱 종료 시 한 번에 영속할 것들 — 요약·사실·감정 (ARCHITECTURE §3·§4) */
export interface SessionEndArguments {
  shortTerm: ShortTermMemory
  factStore: FactStore
  extractFacts: FactExtractor
  /** 종료 시점의 현재 감정 — 다음 실행에서 이어받는다 */
  emotionState: PersistedEmotionState
  now?: number
}

export interface SessionEndResult {
  summary: PersistSummaryResult
  facts: ExtractAndStoreResult
  isEmotionSaved: boolean
}

export interface LongTermMemory {
  loadStartupContext(): Promise<StartupContext>
  /** 턴 종료마다 호출 — N턴 주기에 도달했을 때만 스냅샷 저장 */
  recordTurnAndMaybeSnapshot(shortTerm: ShortTermMemory, now?: number): Promise<SnapshotResult>
  /** 앱 종료 시 호출 — 단기 → 요약 → 장기 */
  persistSessionSummary(shortTerm: ShortTermMemory, now?: number): Promise<PersistSummaryResult>
  /**
   * 앱 종료의 단일 진입점 — 요약·사실·감정을 정해진 순서로 전부 시도한다.
   * 한 단계의 실패가 다음 단계를 막지 않으며, 절대 throw하지 않는다.
   * 통합 코드는 이 함수 하나만 호출하면 된다 (누락 방지).
   */
  persistSessionEnd(sessionEnd: SessionEndArguments): Promise<SessionEndResult>
  loadEmotionState(): Promise<PersistedEmotionState>
  saveEmotionState(state: PersistedEmotionState, now?: number): Promise<void>
}

interface MemoryRow {
  content: string
  created_at: number
}

interface EmotionStateRow {
  valence: number
  arousal: number
  dominance: number
}

export function createLongTermMemory(
  database: MemoryDatabase,
  summarize: SessionSummarizer,
): LongTermMemory {
  async function loadLatestRow(kind: 'summary' | 'snapshot'): Promise<MemoryRow | null> {
    return database.get<MemoryRow>(
      'SELECT content, created_at FROM memories WHERE kind = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      [kind],
    )
  }

  async function loadStartupContext(): Promise<StartupContext> {
    const latestSummaryRow = await loadLatestRow('summary')
    const latestSnapshotRow = await loadLatestRow('snapshot')

    const isSnapshotNewerThanSummary =
      latestSnapshotRow !== null &&
      (latestSummaryRow === null || latestSnapshotRow.created_at > latestSummaryRow.created_at)

    const latestSummary = latestSummaryRow?.content ?? null
    const recoveredSnapshot = isSnapshotNewerThanSummary ? latestSnapshotRow.content : null
    return {
      latestSummary,
      recoveredSnapshot,
      isFirstRun: latestSummary === null && recoveredSnapshot === null,
    }
  }

  async function saveSnapshot(turns: readonly ConversationTurn[], now: number): Promise<void> {
    await database.writeBatch([
      {
        sql: "INSERT INTO memories (kind, content, created_at) VALUES ('snapshot', ?, ?)",
        parameters: [JSON.stringify(turns), now],
      },
      {
        sql: `DELETE FROM memories WHERE kind = 'snapshot' AND id NOT IN (
                SELECT id FROM memories WHERE kind = 'snapshot'
                ORDER BY created_at DESC, id DESC LIMIT ?)`,
        parameters: [MAX_SNAPSHOTS_KEPT],
      },
    ])
  }

  async function recordTurnAndMaybeSnapshot(
    shortTerm: ShortTermMemory,
    now: number = Date.now(),
  ): Promise<SnapshotResult> {
    const turnCount = shortTerm.getTurnCount()
    if (turnCount === 0 || turnCount % SNAPSHOT_INTERVAL_TURNS !== 0) {
      return { status: 'not-due' }
    }
    try {
      await saveSnapshot(shortTerm.getTurns(), now)
      return { status: 'saved' }
    } catch (error) {
      // 스냅샷 실패가 대화 턴을 깨면 안 된다 — 기록하고 다음 주기에 재시도된다
      const errorMessage = error instanceof Error ? error.message : '스냅샷 저장에 실패했습니다'
      console.error('[longTerm.recordTurnAndMaybeSnapshot]: 스냅샷 실패:', error)
      return { status: 'failed', errorMessage }
    }
  }

  async function persistSessionSummary(
    shortTerm: ShortTermMemory,
    now: number = Date.now(),
  ): Promise<PersistSummaryResult> {
    const turns = shortTerm.getTurns()
    if (turns.length === 0) {
      return { status: 'skipped-empty' }
    }
    try {
      const summary = (await summarize(turns)).trim()
      if (summary.length === 0) {
        throw new Error('요약 결과가 비어 있습니다')
      }
      await database.write(
        "INSERT INTO memories (kind, content, created_at) VALUES ('summary', ?, ?)",
        [summary, now],
      )
      return { status: 'saved-summary' }
    } catch (error) {
      // 요약(손실 압축) 실패 — 원본 스냅샷으로라도 보존해 기억 증발을 막는다
      const errorMessage = error instanceof Error ? error.message : '요약에 실패했습니다'
      console.error('[longTerm.persistSessionSummary]: 요약 실패 — 스냅샷 대체 저장:', error)
      try {
        await saveSnapshot(turns, now)
      } catch (snapshotError) {
        // 폴백마저 실패 — 호출자가 알 수 있게 상태로 반환한다 (throw 금지: 종료 경로)
        const snapshotErrorMessage =
          snapshotError instanceof Error ? snapshotError.message : '스냅샷 저장에 실패했습니다'
        console.error('[longTerm.persistSessionSummary]: 대체 스냅샷도 실패:', snapshotError)
        return { status: 'persist-failed', errorMessage: `${errorMessage} / ${snapshotErrorMessage}` }
      }
      return { status: 'saved-snapshot-fallback', errorMessage }
    }
  }

  async function persistSessionEnd(sessionEnd: SessionEndArguments): Promise<SessionEndResult> {
    const now = sessionEnd.now ?? Date.now()
    const turns = sessionEnd.shortTerm.getTurns()

    // 순서 고정: 요약 → 사실 → 감정. 각 단계는 실패해도 다음을 막지 않는다.
    const summary = await persistSessionSummary(sessionEnd.shortTerm, now)
    const facts = await sessionEnd.factStore.extractAndStoreFacts(turns, sessionEnd.extractFacts, now)

    let isEmotionSaved = true
    try {
      await saveEmotionState(sessionEnd.emotionState, now)
    } catch (error) {
      console.error('[longTerm.persistSessionEnd]: 감정 영속 실패:', error)
      isEmotionSaved = false
    }
    return { summary, facts, isEmotionSaved }
  }

  async function loadEmotionState(): Promise<PersistedEmotionState> {
    const row = await database.get<EmotionStateRow>(
      'SELECT valence, arousal, dominance FROM emotion_state WHERE id = ?',
      [EMOTION_STATE_ROW_ID],
    )
    if (row === null) {
      // 시드가 보장하므로 정상이라면 없을 수 없다 — 방어적으로 중립 반환
      console.error('[longTerm.loadEmotionState]: emotion_state 행 없음 — 중립으로 대체')
      return FIRST_RUN_EMOTION_STATE
    }
    return { valence: row.valence, arousal: row.arousal, dominance: row.dominance }
  }

  async function saveEmotionState(state: PersistedEmotionState, now: number = Date.now()): Promise<void> {
    await database.write(
      `INSERT INTO emotion_state (id, valence, arousal, dominance, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         valence = excluded.valence, arousal = excluded.arousal,
         dominance = excluded.dominance, updated_at = excluded.updated_at`,
      [EMOTION_STATE_ROW_ID, state.valence, state.arousal, state.dominance, now],
    )
  }

  return {
    loadStartupContext,
    recordTurnAndMaybeSnapshot,
    persistSessionSummary,
    persistSessionEnd,
    loadEmotionState,
    saveEmotionState,
  }
}
