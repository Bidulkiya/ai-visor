/**
 * 로컬 SQLite(WAL) 연결 + 스키마 + 단일 쓰기 경로 (CLAUDE.md R6, 기획서 §5)
 *
 * - 대화·기억·감정 상태는 로컬에만 둔다. 클라우드 전송 금지 (R6).
 * - 네이티브 바인딩(better-sqlite3)은 Electron 메인 프로세스에서만 돌 수 있으므로
 *   이 모듈은 SqliteDriver 인터페이스에만 의존한다. 프로덕션 드라이버는 메인
 *   프로세스가 구현하고 preload IPC로 주입한다. IPC 경유를 전제로 전부 비동기다.
 *   TODO(통합 단계): electron/ 쪽 드라이버 + IPC 채널 구현.
 * - 모든 쓰기는 단일 쓰기 경로(큐)로 직렬화한다 — 세션 중 쓰기(스냅샷)와
 *   종료 시 쓰기(요약·사실)의 동시 충돌 방지 (기획서 §5.2).
 */

export const DATABASE_FILE_NAME = 'companion.db'

/** WAL + WAL 권장 동기화 수준 — 연결 직후 반드시 순서대로 적용한다 */
export const CONNECTION_PRAGMAS: readonly string[] = [
  'PRAGMA journal_mode = WAL;',
  'PRAGMA synchronous = NORMAL;',
]

export type SqlParameter = string | number | null
export type SqlParameters = ReadonlyArray<SqlParameter>

export interface SqlStatement {
  sql: string
  parameters?: SqlParameters
}

/** 네이티브 SQLite에 대한 최소 추상화 — 구현체가 IPC를 건너므로 전부 Promise */
export interface SqliteDriver {
  exec(sql: string): Promise<void>
  run(sql: string, parameters?: SqlParameters): Promise<void>
  get<Row>(sql: string, parameters?: SqlParameters): Promise<Row | null>
  all<Row>(sql: string, parameters?: SqlParameters): Promise<Row[]>
  close(): Promise<void>
}

/**
 * 5테이블 스키마 — 확장 대비 테이블 분리 (기획서 §5.4).
 * 컬럼 추가가 아니라 키-값 보조 구조(relationship)로 확장을 흡수한다.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (            -- 기억: 요약(손실 압축) + 스냅샷(크래시 대비 원본)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('summary', 'snapshot')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS index_memories_kind_created_at ON memories(kind, created_at);

CREATE TABLE IF NOT EXISTS emotion_state (       -- 감정 상태: 단일 행, 종료 시 VAD 영속
  id INTEGER PRIMARY KEY CHECK (id = 1),
  valence REAL NOT NULL DEFAULT 0,
  arousal REAL NOT NULL DEFAULT 0,
  dominance REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS relationship (        -- 관계 지표: affection(+1) 등 확장 자리 (키-값)
  key TEXT PRIMARY KEY,
  value REAL NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS facts (               -- 사실: 요약과 별개의 구조화 키-값 (이름·선호·약속)
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (           -- 감사 로그: 도구 호출 기록 + 롤백 정보 (R4)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name TEXT NOT NULL,
  risk TEXT NOT NULL,
  input_summary TEXT NOT NULL,
  is_success INTEGER NOT NULL,
  rollback_info TEXT,
  output_summary TEXT,
  created_at INTEGER NOT NULL
);
`

/** 구버전 DB에 output_summary 컬럼이 없으면 추가한다 (멱등 마이그레이션) */
async function ensureAuditOutputColumn(driver: SqliteDriver): Promise<void> {
  const columns = await driver.all<{ name: string }>('PRAGMA table_info(audit_log)')
  const hasOutputColumn = columns.some((column) => column.name === 'output_summary')
  if (!hasOutputColumn) {
    await driver.exec('ALTER TABLE audit_log ADD COLUMN output_summary TEXT')
  }
}

/** 관계 지표에서 affection(+1)이 쓸 키 — 자리만 확보, 값 변경 로직은 +1에서 */
export const RELATIONSHIP_KEY_AFFECTION = 'affection'
/** 첫 실행 시 affection 기본값 (기획서 §5.3) */
export const AFFECTION_INITIAL_VALUE = 0
/** emotion_state는 단일 행 — 스키마의 CHECK (id = 1)과 동일한 상수 */
export const EMOTION_STATE_ROW_ID = 1
/** 첫 실행 시 감정 각 축의 중립값 (기획서 §5.3) */
const NEUTRAL_EMOTION_AXIS_VALUE = 0

/** 첫 실행(기억 0) 기본 상태: 중립 감정(0,0,0) + affection 0 (기획서 §5.3). 멱등. */
function buildFirstRunSeedStatements(now: number): SqlStatement[] {
  return [
    {
      sql: 'INSERT OR IGNORE INTO emotion_state (id, valence, arousal, dominance, updated_at) VALUES (?, ?, ?, ?, ?)',
      parameters: [
        EMOTION_STATE_ROW_ID,
        NEUTRAL_EMOTION_AXIS_VALUE,
        NEUTRAL_EMOTION_AXIS_VALUE,
        NEUTRAL_EMOTION_AXIS_VALUE,
        now,
      ],
    },
    {
      sql: 'INSERT OR IGNORE INTO relationship (key, value, updated_at) VALUES (?, ?, ?)',
      parameters: [RELATIONSHIP_KEY_AFFECTION, AFFECTION_INITIAL_VALUE, now],
    },
  ]
}

export interface MemoryDatabase {
  get<Row>(sql: string, parameters?: SqlParameters): Promise<Row | null>
  all<Row>(sql: string, parameters?: SqlParameters): Promise<Row[]>
  /** 단일 쓰기 — 쓰기 큐로 직렬화된다 */
  write(sql: string, parameters?: SqlParameters): Promise<void>
  /** 여러 쓰기를 하나의 트랜잭션으로 — 전부 성공하거나 전부 롤백 */
  writeBatch(statements: ReadonlyArray<SqlStatement>): Promise<void>
  close(): Promise<void>
}

type WriteOperation<Result> = () => Promise<Result>

/** 단일 쓰기 경로 — 모든 쓰기를 도착 순서대로 직렬 실행한다. 실패해도 큐는 멈추지 않는다 */
function createWriteQueue(): <Result>(operation: WriteOperation<Result>) => Promise<Result> {
  let tail: Promise<unknown> = Promise.resolve()
  return function enqueue<Result>(operation: WriteOperation<Result>): Promise<Result> {
    const next = tail.then(operation, operation)
    tail = next.catch(() => undefined)
    return next
  }
}

/**
 * 드라이버 위에 WAL·스키마·첫 실행 시드·쓰기 직렬화를 얹어 연다.
 * 같은 파일로 다시 열어도 안전하다(스키마·시드 모두 멱등).
 */
export async function openMemoryDatabase(
  driver: SqliteDriver,
  now: number = Date.now(),
): Promise<MemoryDatabase> {
  for (const pragma of CONNECTION_PRAGMAS) {
    await driver.exec(pragma)
  }
  await driver.exec(SCHEMA_SQL)
  await ensureAuditOutputColumn(driver)

  const enqueueWrite = createWriteQueue()

  async function runStatementsInTransaction(statements: ReadonlyArray<SqlStatement>): Promise<void> {
    await driver.run('BEGIN')
    try {
      for (const statement of statements) {
        await driver.run(statement.sql, statement.parameters)
      }
      await driver.run('COMMIT')
    } catch (error) {
      try {
        await driver.run('ROLLBACK')
      } catch (rollbackError) {
        // 롤백 실패는 기록만 한다 — 원래 실패 원인을 가리면 안 된다
        console.error('[db.runStatementsInTransaction]: ROLLBACK 실패', rollbackError)
      }
      throw error
    }
  }

  // 첫 실행 기본 상태도 단일 쓰기 경로로 — 이후 모든 쓰기와 직렬화된다
  await enqueueWrite(() => runStatementsInTransaction(buildFirstRunSeedStatements(now)))

  return {
    get: (sql, parameters) => driver.get(sql, parameters),
    all: (sql, parameters) => driver.all(sql, parameters),
    write: (sql, parameters) => enqueueWrite(() => driver.run(sql, parameters)),
    writeBatch: (statements) => enqueueWrite(() => runStatementsInTransaction(statements)),
    close: () => enqueueWrite(() => driver.close()),
  }
}
