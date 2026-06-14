/**
 * 슬라이드 데이터 구조 (+2, 기획서 §4)
 *
 * PPTX에서 추출한 슬라이드별 텍스트·노트를 담는 타입.
 * 실제 PPTX 파싱은 Python 사이드카(다음 단계)가 담당한다 — 여기는
 * 사이드카가 IPC로 넘겨줄 데이터를 받아 검증·정규화하는 경계만 정의한다.
 * 외부(IPC) 데이터는 신뢰하지 않으므로 unknown으로 받아 런타임 검증한다
 * (core/message.ts의 normalizeToMessage와 같은 원칙).
 */

export interface Slide {
  /** 1-기반 슬라이드 번호 */
  number: number
  title: string
  bodyText: string
  /** 발표자 노트 — 없으면 빈 문자열 */
  speakerNotes: string
}

export interface SlideDeck {
  /** 출처 표시용 (파일명 등) */
  sourceName: string
  slides: readonly Slide[]
}

/** 사이드카가 넘겨줄 원시 슬라이드 한 장의 기대 형태 (와이어 계약) */
interface RawSlideShape {
  title?: unknown
  bodyText?: unknown
  speakerNotes?: unknown
}

function asTrimmedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 제목·본문이 모두 빈 슬라이드는 발표할 내용이 없다 — 정규화에서 거른다 */
function normalizeSlide(raw: RawSlideShape, slideNumber: number): Slide | null {
  const title = asTrimmedText(raw.title)
  const bodyText = asTrimmedText(raw.bodyText)
  if (title.length === 0 && bodyText.length === 0) {
    return null
  }
  return {
    number: slideNumber,
    title,
    bodyText,
    speakerNotes: asTrimmedText(raw.speakerNotes),
  }
}

/**
 * 외부에서 온 슬라이드 데이터를 SlideDeck으로 정규화한다.
 * 형태가 아니거나 발표 가능한 슬라이드가 0장이면 null —
 * 호출자(컨트롤러·ui)는 null을 "열 수 없는 자료"로 처리한다.
 * 빈 슬라이드를 거른 뒤 번호를 1부터 다시 매긴다(번호 연속성 보장).
 */
export function normalizeSlideDeck(rawSlides: unknown, sourceName: string): SlideDeck | null {
  if (!Array.isArray(rawSlides)) {
    return null
  }
  const slides: Slide[] = []
  for (const rawSlide of rawSlides) {
    if (typeof rawSlide !== 'object' || rawSlide === null) {
      continue
    }
    const normalized = normalizeSlide(rawSlide as RawSlideShape, slides.length + 1)
    if (normalized !== null) {
      slides.push(normalized)
    }
  }
  if (slides.length === 0) {
    return null
  }
  return { sourceName: sourceName.trim() || '이름 없는 자료', slides }
}
