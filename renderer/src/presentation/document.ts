/**
 * 범용 문서 추상화 (+2 확장) — PPTX 전용이던 발표를 PDF·DOCX·TXT·MD까지 일반화한다.
 *
 * 설계: 발표 파이프라인(controller·preResearch·prompts)은 이미 SlideDeck 위에서
 * 완성돼 있다. 그래서 새로 SlideDeck을 대체하지 않고, 상위에 LoadedDocument를 두되
 * 구획(section)은 기존 Slide 타입을 그대로 재사용한다. 발표는 documentToSlideDeck로
 * 변환해 기존 경로를 타고, 이해(질문답변) 모드는 LoadedDocument를 직접 읽는다.
 *
 * 안전: 외부(사이드카/IPC) 데이터는 신뢰하지 않으므로 normalizeSlideDeck으로 검증해
 * 들이고, 본문·제목·노트의 시크릿은 여기서 redactSecrets로 가린다(화면·프롬프트 양쪽
 * 노출 0, R7 방어). core는 이 모듈을 모른다(R3).
 */

import { redactSecrets } from '../shared/redact'
import { normalizeSlideDeck, type Slide, type SlideDeck } from './slides'

/** 사이드카가 다룰 수 있는 문서 타입 — electron/ipc/channels.ts의 SupportedDocumentType와 거울 동기 */
export type DocumentType = 'pptx' | 'pdf' | 'docx' | 'txt' | 'md'

const DOCUMENT_TYPES: ReadonlySet<DocumentType> = new Set(['pptx', 'pdf', 'docx', 'txt', 'md'])

/** 사람이 읽는 타입 라벨 — UI 표시·안내용 */
export const DOCUMENT_TYPE_LABEL: Readonly<Record<DocumentType, string>> = {
  pptx: 'PowerPoint',
  pdf: 'PDF',
  docx: 'Word',
  txt: '텍스트',
  md: '마크다운',
}

export interface LoadedDocument {
  sourceName: string
  docType: DocumentType
  /** 구획(슬라이드/페이지/섹션) — 발표 시 슬라이드, 이해 시 본문 단위 */
  sections: readonly Slide[]
}

/** 외부에서 온 docType 문자열을 검증한다. 모르는 값은 'txt'로 안전하게 떨어뜨린다 */
function asDocumentType(value: unknown): DocumentType {
  return typeof value === 'string' && DOCUMENT_TYPES.has(value as DocumentType)
    ? (value as DocumentType)
    : 'txt'
}

/** 구획 한 개의 텍스트 필드에서 시크릿을 가린다 — 화면·프롬프트 어디로도 새지 않게 */
function redactSlide(slide: Slide): Slide {
  return {
    ...slide,
    title: redactSecrets(slide.title),
    bodyText: redactSecrets(slide.bodyText),
    speakerNotes: redactSecrets(slide.speakerNotes),
  }
}

/**
 * 사이드카가 넘긴 원시 구획 배열을 LoadedDocument로 정규화한다.
 * 검증·빈 구획 제거·번호 재매김은 normalizeSlideDeck에 위임하고(단일 출처),
 * 여기서는 docType을 붙이고 시크릿을 가린다. 정규화할 구획이 0개면 null.
 */
export function normalizeDocument(
  rawSections: unknown,
  sourceName: string,
  docType: unknown,
): LoadedDocument | null {
  const deck = normalizeSlideDeck(rawSections, sourceName)
  if (deck === null) {
    return null
  }
  return {
    sourceName: deck.sourceName,
    docType: asDocumentType(docType),
    sections: deck.slides.map(redactSlide),
  }
}

/** 발표 파이프라인(SlideDeck)으로 변환 — 구획이 곧 슬라이드다(기존 경로 그대로 재사용) */
export function documentToSlideDeck(document: LoadedDocument): SlideDeck {
  return { sourceName: document.sourceName, slides: document.sections }
}
