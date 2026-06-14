/**
 * 사이드카 IPC 호스트 — 발표 파일 선택 + PPTX 추출 위임 (메인 프로세스).
 *
 * sqliteDriverHost·toolHost와 같은 패턴: 매니저 인스턴스를 소유하고 IPC 핸들러만
 * 등록한다. 앱 종료 시 사이드카를 반드시 정리한다(고아 프로세스 방지, 원칙 5).
 */

import { app, dialog, ipcMain } from 'electron'
import { IPC_CHANNELS, type SidecarExtractResult } from '../ipc/channels'
import { createSidecarManager, validatePptxPath } from './manager'

export function registerSidecarHost(): void {
  const manager = createSidecarManager()

  // 네이티브 파일 선택 — 사용자가 고른 .pptx 경로만 신뢰 경계를 넘는다
  ipcMain.handle(IPC_CHANNELS.sidecarPickPptx, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: '발표할 PPTX 파일 선택',
      properties: ['openFile'],
      filters: [{ name: 'PowerPoint 발표', extensions: ['pptx'] }],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  ipcMain.handle(
    IPC_CHANNELS.sidecarExtractDeck,
    async (_event, pptxPath: unknown): Promise<SidecarExtractResult> => {
      if (typeof pptxPath !== 'string') {
        return { status: 'failed', message: '잘못된 파일 경로입니다.' }
      }
      const validation = validatePptxPath(pptxPath)
      if (!validation.ok) {
        return { status: 'failed', message: validation.reason }
      }
      return manager.extractDeck(validation.resolved)
    },
  )

  // 앱 종료 시 사이드카 정리 — 고아 프로세스로 남지 않게(원칙 5)
  app.on('will-quit', () => {
    void manager.stop()
  })
}
