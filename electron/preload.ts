/**
 * 렌더러에 노출되는 최소 브리지.
 *
 * contextIsolation은 유지하며 ipcRenderer를 직접 노출하지 않는다 —
 * contextBridge로 명시된 함수만 내보낸다.
 */

import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC_CHANNELS,
  type PingResult,
  type SqlParameters,
  type ToolOperationResult,
} from './ipc/channels'

let appWillQuitListener: (() => void) | null = null

// 메인이 종료 전 영속을 요청한다. 아직 아무도 등록하지 않았다면(ui 미조립 등)
// 정리할 것이 없으므로 즉시 종료를 허용한다 — 창 닫기가 타임아웃만큼 늦어지지 않게.
ipcRenderer.on(IPC_CHANNELS.appWillQuit, () => {
  if (appWillQuitListener === null) {
    ipcRenderer.send(IPC_CHANNELS.appQuitReady)
    return
  }
  appWillQuitListener()
})

const bridge = {
  /** 메인 프로세스 왕복 핸드셰이크 */
  ping(): Promise<PingResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.ping)
  },

  /** SQLite 드라이버 — 실 구현은 메인 프로세스 (renderer/src/memory/ipcDriver.ts가 소비) */
  database: {
    exec(sql: string): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.databaseExec, sql)
    },
    run(sql: string, parameters?: SqlParameters): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.databaseRun, sql, parameters ?? [])
    },
    get(sql: string, parameters?: SqlParameters): Promise<unknown> {
      return ipcRenderer.invoke(IPC_CHANNELS.databaseGet, sql, parameters ?? [])
    },
    all(sql: string, parameters?: SqlParameters): Promise<unknown[]> {
      return ipcRenderer.invoke(IPC_CHANNELS.databaseAll, sql, parameters ?? [])
    },
    close(): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.databaseClose)
    },
  },

  /** 도구 실제 작업(메인 프로세스) — 게이트·감사는 렌더러 tools/가 담당 */
  tools: {
    runOperation(name: string, input: Record<string, unknown>): Promise<ToolOperationResult> {
      return ipcRenderer.invoke(IPC_CHANNELS.toolOperation, name, input)
    },
  },

  /** 종료 직전 영속 훅 — 세션 조립 코드(core/session.ts)가 등록한다 */
  onAppWillQuit(listener: () => void): void {
    appWillQuitListener = listener
  },
  /** 영속 완료 통지 — 메인이 이걸 받으면(또는 타임아웃) 실제로 종료한다 */
  notifyQuitReady(): void {
    ipcRenderer.send(IPC_CHANNELS.appQuitReady)
  },
}

export type AiVisorBridge = typeof bridge

contextBridge.exposeInMainWorld('aiVisor', bridge)
