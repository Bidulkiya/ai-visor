/**
 * 사이드카 IPC 호스트 — 발표 파일 선택 + PPTX 추출 위임 (메인 프로세스).
 *
 * sqliteDriverHost·toolHost와 같은 패턴: 매니저 인스턴스를 소유하고 IPC 핸들러만
 * 등록한다. 앱 종료 시 사이드카를 반드시 정리한다(고아 프로세스 방지, 원칙 5).
 */

import { app, dialog, ipcMain } from 'electron'
import { IPC_CHANNELS, type SidecarExtractResult } from '../ipc/channels'
import { createSidecarManager, validateDocumentPath } from './manager'

export function registerSidecarHost(): void {
  const manager = createSidecarManager()

  // 네이티브 파일 선택 — 사용자가 고른 지원 문서 경로만 신뢰 경계를 넘는다(HWP는 목록에 없음)
  ipcMain.handle(IPC_CHANNELS.sidecarPickDocument, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: '열 문서 선택 (PDF·Word·PowerPoint·텍스트·마크다운)',
      properties: ['openFile'],
      filters: [
        { name: '문서', extensions: ['pdf', 'docx', 'pptx', 'txt', 'md', 'markdown'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Word', extensions: ['docx'] },
        { name: 'PowerPoint', extensions: ['pptx'] },
        { name: '텍스트·마크다운', extensions: ['txt', 'md', 'markdown'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  ipcMain.handle(
    IPC_CHANNELS.sidecarExtractDocument,
    async (_event, documentPath: unknown): Promise<SidecarExtractResult> => {
      if (typeof documentPath !== 'string') {
        return { status: 'failed', message: '잘못된 파일 경로입니다.' }
      }
      const validation = validateDocumentPath(documentPath)
      if (!validation.ok) {
        return { status: 'failed', message: validation.reason }
      }
      return manager.extractDocument(validation.resolved)
    },
  )

  // 앱 종료 시 사이드카 정리 — 고아 프로세스로 남지 않게(원칙 5)
  app.on('will-quit', () => {
    void manager.stop()
  })
}
