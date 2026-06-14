/**
 * PPTX → SlideDeck 로더 — presentation 레이어와 사이드카(메인 프로세스)의 접점.
 *
 * memory/ipcDriver, tools/builtins와 같은 패턴: preload가 노출한 브리지
 * (window.aiVisor.presentation)를 통해서만 메인 프로세스와 통신한다.
 * 본체(core)는 이 경로를 모른다 — 발표는 본체 바깥의 확장이다 (R3).
 *
 * 외부(IPC) 데이터는 신뢰하지 않으므로 normalizeSlideDeck으로 검증해 들인다.
 */

import { normalizeSlideDeck, type SlideDeck } from './slides'

/** preload(electron/preload.ts)의 presentation 브리지와 거울 동기 */
interface SidecarSlideWire {
  title: string
  bodyText: string
  speakerNotes: string
  imageDataUrl: string | null
}

/** electron/ipc/channels.ts의 SidecarExtractResult와 거울 동기 */
type SidecarExtractResult =
  | { status: 'ok'; sourceName: string; slides: SidecarSlideWire[]; renderNotice: string | null }
  | { status: 'unavailable'; message: string }
  | { status: 'failed'; message: string }

interface PresentationBridge {
  pickPptxFile(): Promise<string | null>
  extractDeck(pptxPath: string): Promise<SidecarExtractResult>
}

export type LoadDeckResult =
  | { status: 'loaded'; deck: SlideDeck; renderNotice: string | null }
  /** 사용자가 파일 선택을 취소 */
  | { status: 'cancelled' }
  /** 사이드카(Python) 자체가 없음/미준비 — 데모 폴백 대상 */
  | { status: 'unavailable'; message: string }
  /** 파싱 실패 또는 발표 가능한 슬라이드 0장 */
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
export async function pickAndLoadDeck(): Promise<LoadDeckResult> {
  const bridge = getPresentationBridge()
  if (bridge === null) {
    return { status: 'unavailable', message: 'Electron 앱에서만 PPTX를 열 수 있습니다.' }
  }

  let pptxPath: string | null
  try {
    pptxPath = await bridge.pickPptxFile()
  } catch (error) {
    console.error('[presentation.pickAndLoadDeck]: 파일 선택 실패:', error)
    return { status: 'failed', message: '파일 선택 창을 열지 못했습니다.' }
  }
  if (pptxPath === null) {
    return { status: 'cancelled' }
  }

  let result: SidecarExtractResult
  try {
    result = await bridge.extractDeck(pptxPath)
  } catch (error) {
    console.error('[presentation.pickAndLoadDeck]: 추출 호출 실패:', error)
    return { status: 'failed', message: 'PPTX 추출 요청에 실패했습니다.' }
  }

  if (result.status === 'unavailable') {
    return { status: 'unavailable', message: result.message }
  }
  if (result.status === 'failed') {
    return { status: 'failed', message: result.message }
  }

  const deck = normalizeSlideDeck(result.slides, result.sourceName)
  if (deck === null) {
    return { status: 'failed', message: '발표할 수 있는 슬라이드를 찾지 못했습니다.' }
  }
  return { status: 'loaded', deck, renderNotice: result.renderNotice }
}
