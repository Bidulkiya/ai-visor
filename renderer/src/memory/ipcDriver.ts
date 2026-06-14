/**
 * IPC 기반 SqliteDriver — 렌더러 쪽 구현 (db.ts의 드라이버 계약 충족)
 *
 * 실제 SQLite(better-sqlite3, 동기 네이티브)는 Electron 메인 프로세스에 있고,
 * 렌더러는 preload가 노출한 비동기 브리지(window.aiVisor.database)로 요청한다.
 * invoke가 비동기 경계를 만들므로 드라이버 계약(전부 Promise)과 자연히 맞는다.
 */

import type { SqliteDriver, SqlParameters } from './db'

/** preload(electron/preload.ts)가 노출하는 database 브리지 모양 — 거울 동기 */
export interface DatabaseBridge {
  exec(sql: string): Promise<void>
  run(sql: string, parameters?: SqlParameters): Promise<void>
  get(sql: string, parameters?: SqlParameters): Promise<unknown>
  all(sql: string, parameters?: SqlParameters): Promise<unknown[]>
  close(): Promise<void>
}

export function createIpcSqliteDriver(bridge: DatabaseBridge): SqliteDriver {
  return {
    exec: (sql) => bridge.exec(sql),
    run: (sql, parameters) => bridge.run(sql, parameters),
    get: async <Row>(sql: string, parameters?: SqlParameters) =>
      (await bridge.get(sql, parameters)) as Row | null,
    all: async <Row>(sql: string, parameters?: SqlParameters) =>
      (await bridge.all(sql, parameters)) as Row[],
    close: () => bridge.close(),
  }
}

/** preload 브리지에서 database 부분을 찾는다. 브라우저 단독 실행 등에선 null */
export function getDatabaseBridge(): DatabaseBridge | null {
  const bridgeHost = globalThis as { aiVisor?: { database?: DatabaseBridge } }
  return bridgeHost.aiVisor?.database ?? null
}
