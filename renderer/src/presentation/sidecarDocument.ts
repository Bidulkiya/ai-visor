/**
 * 문서 로더 — presentation 레이어와 사이드카(메인 프로세스)의 접점.
 *
 * tools/builtins·memory/ipcDriver와 같은 패턴: preload가 노출한 브리지
 * (window.aiVisor.presentation)로만 메인과 통신한다. 본체(core)는 이 경로를 모른다(R3).
 * 외부(IPC) 데이터는 신뢰하지 않으므로 normalizeDocument로 검증·가림(redact)해 들인다.
 */

import { normalizeDocument, type LoadedDocument } from './document'

/** preload(electron/preload.ts)의 presentation 브리지와 거울 동기 */
interface SidecarSlideWire {
  title: string
  bodyText: string
  speakerNotes: string
  imageDataUrl: string | null
}

/** electron/ipc/channels.ts의 SidecarExtractResult와 거울 동기 */
type SidecarExtractResult =
  | {
      status: 'ok'
      sourceName: string
      docType: string
      slides: SidecarSlideWire[]
      renderNotice: string | null
    }
  | { status: 'unavailable'; message: string }
  | { status: 'failed'; message: string }

interface PresentationBridge {
  pickDocumentFile(): Promise<string | null>
  extractDocument(documentPath: string): Promise<SidecarExtractResult>
}

export type LoadDocumentResult =
  | { status: 'loaded'; document: LoadedDocument; renderNotice: string | null }
  /** 사용자가 파일 선택을 취소 */
  | { status: 'cancelled' }
  /** 사이드카(Python) 자체가 없음/미준비 — 데모 폴백 대상 */
  | { status: 'unavailable'; message: string }
  /** 파싱 실패·미지원 형식·내용 0 */
  | { status: 'failed'; message: string }

/** preload 브리지에서 presentation 부분을 찾는다. Electron 밖(브라우저 단독)이면 null */
export function getPresentationBridge(): PresentationBridge | null {
  const bridgeHost = globalThis as { aiVisor?: { presentation?: PresentationBridge } }
  return bridgeHost.aiVisor?.presentation ?? null
}

/**
 * 파일 선택 → 사이드카 추출 → 정규화까지 한 번에. 어떤 단계 실패도 결과 union으로
 * 돌려준다(throw 없음) — 호출자(ui)는 unavailable이면 데모 덱으로 폴백한다.
 */
export async function pickAndLoadDocument(): Promise<LoadDocumentResult> {
  const bridge = getPresentationBridge()
  if (bridge === null) {
    return { status: 'unavailable', message: 'Electron 앱에서만 문서를 열 수 있습니다.' }
  }

  let documentPath: string | null
  try {
    documentPath = await bridge.pickDocumentFile()
  } catch (error) {
    console.error('[presentation.pickAndLoadDocument]: 파일 선택 실패:', error)
    return { status: 'failed', message: '파일 선택 창을 열지 못했습니다.' }
  }
  if (documentPath === null) {
    return { status: 'cancelled' }
  }

  let result: SidecarExtractResult
  try {
    result = await bridge.extractDocument(documentPath)
  } catch (error) {
    console.error('[presentation.pickAndLoadDocument]: 추출 호출 실패:', error)
    return { status: 'failed', message: '문서 추출 요청에 실패했습니다.' }
  }

  if (result.status === 'unavailable') {
    return { status: 'unavailable', message: result.message }
  }
  if (result.status === 'failed') {
    return { status: 'failed', message: result.message }
  }

  const document = normalizeDocument(result.slides, result.sourceName, result.docType)
  if (document === null) {
    return { status: 'failed', message: '읽을 수 있는 내용을 찾지 못했습니다.' }
  }
  return { status: 'loaded', document, renderNotice: result.renderNotice }
}
