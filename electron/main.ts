/**
 * Electron 메인 프로세스 진입점 — 창 생성 + 렌더러 로딩만 담당한다.
 * 본체 로직은 전부 renderer/src/에 있다 (ARCHITECTURE.md §1).
 */

import { app, BrowserWindow, ipcMain, net, protocol } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { IPC_CHANNELS, type PingResult } from './ipc/channels'
import { registerSqliteDriverHost } from './db/sqliteDriverHost'
import { registerToolHost } from './tools/toolHost'
import { registerSidecarHost } from './sidecar/sidecarHost'
import { registerMcpHost } from './mcp/mcpHost'
import type { McpManager } from './mcp/manager'

const RENDERER_DEV_URL = 'http://localhost:3000'
const RENDERER_SCHEME = 'app'
const RENDERER_ORIGIN = `${RENDERER_SCHEME}://renderer/`
const RENDERER_OUT_DIRECTORY = path.join(__dirname, '..', '..', 'renderer', 'out')

const WINDOW_DEFAULT_WIDTH = 1080
const WINDOW_DEFAULT_HEIGHT = 720
/** 종료 전 렌더러 영속(persistSessionEnd) 대기 한도 — 행 방지 안전장치 */
const QUIT_FLUSH_TIMEOUT_MS = 3000

// Next.js 정적 export 결과는 file://로 직접 열면 절대경로 자산(/_next/...)이 깨진다.
// 전용 스킴으로 서빙해 프로덕션에서도 자산 경로가 살아 있게 한다.
protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
])

function resolveRendererFilePath(urlPathname: string): string {
  const decodedPathname = decodeURIComponent(urlPathname)
  const relativePath = decodedPathname === '/' ? 'index.html' : decodedPathname.replace(/^\//, '')
  // Next 정적 export 규칙: 확장자 없는 경로는 같은 이름의 .html 파일
  const hasExtension = path.extname(relativePath) !== ''
  const fileName = hasExtension ? relativePath : `${relativePath}.html`

  const resolvedPath = path.normalize(path.join(RENDERER_OUT_DIRECTORY, fileName))
  const isInsideOutDirectory = resolvedPath.startsWith(RENDERER_OUT_DIRECTORY + path.sep)
  if (!isInsideOutDirectory) {
    return path.join(RENDERER_OUT_DIRECTORY, '404.html')
  }
  return resolvedPath
}

function registerRendererProtocol(): void {
  protocol.handle(RENDERER_SCHEME, (request) => {
    const { pathname } = new URL(request.url)
    return net.fetch(pathToFileURL(resolveRendererFilePath(pathname)).toString())
  })
}

/** MCP 매니저 — 종료 시 자식 프로세스를 정리하기 위해 핸들을 들고 있는다(좀비 방지 §5) */
let mcpManager: McpManager | null = null

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.ping, (): PingResult => {
    return { isAlive: true, electronVersion: process.versions.electron }
  })
  registerSqliteDriverHost()
  registerToolHost()
  registerSidecarHost()
  mcpManager = registerMcpHost()
}

/**
 * 창 닫기를 가로채 렌더러에 기억 영속 기회를 준다 (기획서 §5.1 — 종료 시 단기→장기).
 * 렌더러가 준비 신호를 보내거나 타임아웃이 지나면 실제로 닫는다.
 * 정리할 것이 없으면 preload가 즉시 응답하므로 체감 지연은 없다.
 */
function attachQuitFlushHook(window: BrowserWindow): void {
  let isFlushCompleted = false
  let isFlushInProgress = false

  window.on('close', (event) => {
    if (isFlushCompleted) {
      return
    }
    event.preventDefault()
    if (isFlushInProgress) {
      return
    }
    isFlushInProgress = true

    const finishClose = (): void => {
      if (isFlushCompleted) {
        return
      }
      isFlushCompleted = true
      ipcMain.removeAllListeners(IPC_CHANNELS.appQuitReady)
      window.close()
    }

    const timeoutHandle = setTimeout(finishClose, QUIT_FLUSH_TIMEOUT_MS)
    ipcMain.once(IPC_CHANNELS.appQuitReady, () => {
      clearTimeout(timeoutHandle)
      finishClose()
    })
    window.webContents.send(IPC_CHANNELS.appWillQuit)
  })
}

function createMainWindow(): void {
  const mainWindow = new BrowserWindow({
    width: WINDOW_DEFAULT_WIDTH,
    height: WINDOW_DEFAULT_HEIGHT,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 샌드박스 preload는 로컬 모듈(ipc/channels) require가 불가하다.
      // contextBridge로 노출 범위를 제한하는 대신 sandbox만 푼다.
      sandbox: false,
    },
  })

  attachQuitFlushHook(mainWindow)

  const isDevelopment = !app.isPackaged
  const rendererUrl = isDevelopment ? RENDERER_DEV_URL : RENDERER_ORIGIN
  mainWindow.loadURL(rendererUrl).catch((error: unknown) => {
    console.error('[createMainWindow]: 렌더러 로딩 실패 —', rendererUrl, error)
  })
}

app
  .whenReady()
  .then(() => {
    registerRendererProtocol()
    registerIpcHandlers()
    createMainWindow()
  })
  .catch((error: unknown) => {
    console.error('[app.whenReady]: 초기화 실패', error)
  })

// 종료 직전 MCP 자식 프로세스를 정리한다 — 비동기 영속(렌더러)과 별개의 동기 정리(좀비 방지 §5)
app.on('before-quit', () => {
  mcpManager?.disconnectAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow()
  }
})
