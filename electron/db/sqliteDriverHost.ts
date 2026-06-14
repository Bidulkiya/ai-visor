/**
 * 메인 프로세스 SQLite 호스트 (CLAUDE.md R6 — 기억은 로컬에만)
 *
 * better-sqlite3(동기 네이티브 모듈)는 메인 프로세스에서만 동작한다.
 * 렌더러의 memory/db.ts는 비동기 SqliteDriver 계약으로 추상화되어 있고,
 * 여기의 ipcMain.handle이 동기 호출을 자동으로 Promise 경계로 감싸 그 계약을
 * 충족한다 — 동기(메인)/비동기(렌더러)가 invoke 지점에서 만나므로 충돌이 없다.
 * 쿼리는 전부 짧은 로컬 쿼리(WAL)라 메인 스레드 점유는 무시 가능하다.
 */

import Database from 'better-sqlite3'
import { app, ipcMain } from 'electron'
import path from 'node:path'
import { IPC_CHANNELS, type SqlParameters } from '../ipc/channels'

/** renderer/src/memory/db.ts의 DATABASE_FILE_NAME과 거울 동기 */
const DATABASE_FILE_NAME = 'companion.db'

export function resolveDatabaseFilePath(): string {
  return path.join(app.getPath('userData'), DATABASE_FILE_NAME)
}

export function registerSqliteDriverHost(): void {
  let database: Database.Database | null = null

  function ensureDatabase(): Database.Database {
    if (database === null) {
      database = new Database(resolveDatabaseFilePath())
    }
    return database
  }

  ipcMain.handle(IPC_CHANNELS.databaseExec, (_event, sql: string) => {
    ensureDatabase().exec(sql)
  })

  ipcMain.handle(IPC_CHANNELS.databaseRun, (_event, sql: string, parameters: SqlParameters = []) => {
    if (parameters.length === 0) {
      // BEGIN/COMMIT/ROLLBACK 같은 무파라미터 문장은 exec로 — prepare 제약 회피
      ensureDatabase().exec(sql)
      return
    }
    ensureDatabase()
      .prepare(sql)
      .run(...parameters)
  })

  ipcMain.handle(IPC_CHANNELS.databaseGet, (_event, sql: string, parameters: SqlParameters = []) => {
    // 행 없음은 undefined가 아니라 null로 — 드라이버 계약(get → Row | null)
    return (
      ensureDatabase()
        .prepare(sql)
        .get(...parameters) ?? null
    )
  })

  ipcMain.handle(IPC_CHANNELS.databaseAll, (_event, sql: string, parameters: SqlParameters = []) => {
    return ensureDatabase()
      .prepare(sql)
      .all(...parameters)
  })

  ipcMain.handle(IPC_CHANNELS.databaseClose, () => {
    if (database !== null) {
      database.close()
      database = null
    }
  })
}
