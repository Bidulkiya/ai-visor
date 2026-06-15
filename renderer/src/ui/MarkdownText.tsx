/**
 * 채팅 표시 전용 마크다운 렌더러 — **굵게**·목록·코드 등을 화면에 실제 서식으로 보인다.
 *
 * ★ 표시(자막)만 담당한다. TTS는 별도 경로(voice/tts.ts)에서 스트림 원본을 받으므로
 *   "자막 ≠ 읽는 텍스트" 분리는 그대로 유지된다 — 이 컴포넌트는 그 분리에 개입하지 않는다.
 * ★ dangerouslySetInnerHTML을 쓰지 않는다 — 모든 출력은 React 엘리먼트라 HTML 주입이 불가능하다.
 *
 * 지원 범위는 노아가 실제로 내는 마크다운에 맞춘다: 코드블록·제목·목록(불릿/순서)·인용·
 * 굵게·기울임·취소선·인라인코드·링크. 스트리밍 중 미완성 마크다운은 닫힐 때까지 원문 그대로 보인다.
 */

'use client'

import { Fragment, type ReactNode } from 'react'

// ── 인라인(문장 안) 토큰 ──
type InlineNode =
  | { kind: 'text'; value: string }
  | { kind: 'bold'; children: InlineNode[] }
  | { kind: 'italic'; children: InlineNode[] }
  | { kind: 'strike'; children: InlineNode[] }
  | { kind: 'code'; value: string }
  | { kind: 'link'; text: string; href: string }

// ── 블록(줄/문단) ──
type BlockNode =
  | { kind: 'paragraph'; lines: InlineNode[][] }
  | { kind: 'heading'; level: number; content: InlineNode[] }
  | { kind: 'list'; ordered: boolean; items: InlineNode[][] }
  | { kind: 'quote'; lines: InlineNode[][] }
  | { kind: 'codeblock'; text: string }

interface InlineRule {
  pattern: RegExp
  build(match: RegExpExecArray): InlineNode
}

// 우선순위 순서대로 검사한다(코드 스팬이 가장 강함 — 그 안은 서식 적용 안 함).
// 같은 위치에서 겹치면 앞 규칙이 이긴다(굵게가 기울임보다 먼저).
const INLINE_RULES: readonly InlineRule[] = [
  { pattern: /`([^`]+)`/, build: (m) => ({ kind: 'code', value: m[1] }) },
  { pattern: /\*\*([\s\S]+?)\*\*/, build: (m) => ({ kind: 'bold', children: parseInline(m[1]) }) },
  { pattern: /(?<![\w])__([\s\S]+?)__(?![\w])/, build: (m) => ({ kind: 'bold', children: parseInline(m[1]) }) },
  { pattern: /~~([\s\S]+?)~~/, build: (m) => ({ kind: 'strike', children: parseInline(m[1]) }) },
  { pattern: /\[([^\]]+)\]\(([^)\s]+)\)/, build: (m) => ({ kind: 'link', text: m[1], href: m[2] }) },
  { pattern: /(?<![*\w])\*([^*\n]+?)\*(?![*\w])/, build: (m) => ({ kind: 'italic', children: parseInline(m[1]) }) },
  { pattern: /(?<![\w])_([^_\n]+?)_(?![\w])/, build: (m) => ({ kind: 'italic', children: parseInline(m[1]) }) },
]

interface InlineMatch {
  index: number
  length: number
  node: InlineNode
}

/** text에서 가장 앞선 인라인 마커 하나를 찾는다. 없으면 null */
function findEarliestInline(text: string): InlineMatch | null {
  let earliest: InlineMatch | null = null
  for (const rule of INLINE_RULES) {
    const match = rule.pattern.exec(text)
    if (match === null) {
      continue
    }
    if (earliest === null || match.index < earliest.index) {
      earliest = { index: match.index, length: match[0].length, node: rule.build(match) }
    }
  }
  return earliest
}

/** 한 줄 텍스트를 인라인 토큰 배열로 — 순수 함수(테스트 대상) */
export function parseInline(text: string): InlineNode[] {
  if (text.length === 0) {
    return []
  }
  const earliest = findEarliestInline(text)
  if (earliest === null) {
    return [{ kind: 'text', value: text }]
  }
  const nodes: InlineNode[] = []
  if (earliest.index > 0) {
    nodes.push({ kind: 'text', value: text.slice(0, earliest.index) })
  }
  nodes.push(earliest.node)
  nodes.push(...parseInline(text.slice(earliest.index + earliest.length)))
  return nodes
}

const FENCE_PATTERN = /^(```|~~~)/
const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/
const UNORDERED_PATTERN = /^[-*+]\s+(.*)$/
const ORDERED_PATTERN = /^\d+[.)]\s+(.*)$/
const QUOTE_PATTERN = /^>\s?(.*)$/

/** 코드펜스 블록을 모은다(닫는 펜스 없이 스트리밍 중이면 거기까지). [블록, 다음줄] 반환 */
function collectCodeBlock(lines: string[], start: number): [BlockNode, number] {
  const body: string[] = []
  let index = start + 1
  while (index < lines.length && !FENCE_PATTERN.test(lines[index].trim())) {
    body.push(lines[index])
    index += 1
  }
  // 닫는 펜스가 있으면 그 줄도 건너뛴다
  const next = index < lines.length ? index + 1 : index
  return [{ kind: 'codeblock', text: body.join('\n') }, next]
}

/** 같은 종류의 목록 줄을 연속으로 모은다. [블록, 다음줄] 반환 */
function collectList(lines: string[], start: number, ordered: boolean): [BlockNode, number] {
  const pattern = ordered ? ORDERED_PATTERN : UNORDERED_PATTERN
  const items: InlineNode[][] = []
  let index = start
  for (let match = pattern.exec(lines[index].trim()); match !== null; ) {
    items.push(parseInline(match[1]))
    index += 1
    match = index < lines.length ? pattern.exec(lines[index].trim()) : null
  }
  return [{ kind: 'list', ordered, items }, index]
}

/** 연속한 인용 줄을 모은다. [블록, 다음줄] 반환 */
function collectQuote(lines: string[], start: number): [BlockNode, number] {
  const quoteLines: InlineNode[][] = []
  let index = start
  for (let match = QUOTE_PATTERN.exec(lines[index].trim()); match !== null; ) {
    quoteLines.push(parseInline(match[1]))
    index += 1
    match = index < lines.length ? QUOTE_PATTERN.exec(lines[index].trim()) : null
  }
  return [{ kind: 'quote', lines: quoteLines }, index]
}

/** 빈 줄/특수 줄 전까지 문단을 모은다. [블록, 다음줄] 반환 */
function collectParagraph(lines: string[], start: number): [BlockNode, number] {
  const paragraphLines: InlineNode[][] = []
  let index = start
  while (index < lines.length && !isStructuralStart(lines[index])) {
    paragraphLines.push(parseInline(lines[index]))
    index += 1
  }
  return [{ kind: 'paragraph', lines: paragraphLines }, index]
}

/** 문단을 끊는 줄(빈 줄·코드펜스·제목·목록·인용)인가 */
function isStructuralStart(line: string): boolean {
  const trimmed = line.trim()
  return (
    trimmed.length === 0 ||
    FENCE_PATTERN.test(trimmed) ||
    HEADING_PATTERN.test(trimmed) ||
    UNORDERED_PATTERN.test(trimmed) ||
    ORDERED_PATTERN.test(trimmed) ||
    QUOTE_PATTERN.test(trimmed)
  )
}

/** 원문을 블록 배열로 — 순수 함수(테스트 대상) */
export function parseBlocks(source: string): BlockNode[] {
  const lines = source.split('\n')
  const blocks: BlockNode[] = []
  let index = 0
  while (index < lines.length) {
    const trimmed = lines[index].trim()
    if (trimmed.length === 0) {
      index += 1
    } else if (FENCE_PATTERN.test(trimmed)) {
      const [block, next] = collectCodeBlock(lines, index)
      blocks.push(block)
      index = next
    } else if (HEADING_PATTERN.test(trimmed)) {
      const match = HEADING_PATTERN.exec(trimmed)
      blocks.push({ kind: 'heading', level: (match?.[1] ?? '#').length, content: parseInline(match?.[2] ?? '') })
      index += 1
    } else if (UNORDERED_PATTERN.test(trimmed) || ORDERED_PATTERN.test(trimmed)) {
      const [block, next] = collectList(lines, index, ORDERED_PATTERN.test(trimmed))
      blocks.push(block)
      index = next
    } else if (QUOTE_PATTERN.test(trimmed)) {
      const [block, next] = collectQuote(lines, index)
      blocks.push(block)
      index = next
    } else {
      const [block, next] = collectParagraph(lines, index)
      blocks.push(block)
      index = next
    }
  }
  return blocks
}

// ── 렌더 (데이터 트리 → React 엘리먼트) ──

// 키로 배열 인덱스를 쓴다 — 트리는 불변 source(message.text)에서 매 렌더 새로 만들어지고
// 노드는 상태가 없어(재정렬 없음) 인덱스 키로 충분하다(stateful 노드를 추가하면 재고할 것).
function renderInline(nodes: InlineNode[]): ReactNode {
  return nodes.map((node, key) => {
    switch (node.kind) {
      case 'text':
        return <Fragment key={key}>{node.value}</Fragment>
      case 'bold':
        return <strong key={key}>{renderInline(node.children)}</strong>
      case 'italic':
        return <em key={key}>{renderInline(node.children)}</em>
      case 'strike':
        return <del key={key}>{renderInline(node.children)}</del>
      case 'code':
        return (
          <code key={key} className="md-code">
            {node.value}
          </code>
        )
      case 'link':
        // 표시 전용 — 렌더러 창을 가로채지 않도록 이동 없는 스팬으로(URL은 title로 안내).
        return (
          <span key={key} className="md-link" title={node.href}>
            {node.text}
          </span>
        )
    }
  })
}

function renderLines(lines: InlineNode[][]): ReactNode {
  return lines.map((line, key) => (
    <Fragment key={key}>
      {key > 0 && <br />}
      {renderInline(line)}
    </Fragment>
  ))
}

/** 스트리밍 표시용 깜빡이는 캐럿 — 마지막 블록 인라인 끝에 붙어 줄바꿈 없이 흐른다 */
function renderCaret(): ReactNode {
  return <span className="chat-caret">▌</span>
}

/** trailing은 마지막 블록에만 전달돼 인라인 끝(캐럿)을 이어 붙인다 */
function renderBlock(block: BlockNode, key: number, trailing: ReactNode): ReactNode {
  switch (block.kind) {
    case 'paragraph':
      return (
        <p key={key} className="md-paragraph">
          {renderLines(block.lines)}
          {trailing}
        </p>
      )
    case 'heading':
      // 보조기술에 '제목'임을 알리되(role/aria-level), 앱의 실제 h1~h6 문서 아웃라인을
      // 오염시키지 않도록 <p>를 유지한다(채팅 본문의 제목이 문서 구조를 가로채면 안 됨).
      return (
        <p key={key} className="md-heading" data-level={block.level} role="heading" aria-level={block.level}>
          {renderInline(block.content)}
          {trailing}
        </p>
      )
    case 'list': {
      const items = block.items.map((item, itemKey) => (
        <li key={itemKey}>
          {renderInline(item)}
          {itemKey === block.items.length - 1 ? trailing : null}
        </li>
      ))
      return block.ordered ? (
        <ol key={key} className="md-list">
          {items}
        </ol>
      ) : (
        <ul key={key} className="md-list">
          {items}
        </ul>
      )
    }
    case 'quote':
      return (
        <blockquote key={key} className="md-quote">
          {renderLines(block.lines)}
          {trailing}
        </blockquote>
      )
    case 'codeblock':
      return (
        <pre key={key} className="md-codeblock">
          <code>
            {block.text}
            {trailing}
          </code>
        </pre>
      )
  }
}

interface MarkdownTextProps {
  source: string
  /** 스트리밍 중이면 마지막 글자 뒤에 깜빡이는 캐럿을 인라인으로 보인다(표시 전용) */
  streaming?: boolean
}

/** 채팅 말풍선 본문을 마크다운 서식으로 표시한다(표시 전용, TTS와 무관) */
export function MarkdownText({ source, streaming = false }: MarkdownTextProps) {
  const blocks = parseBlocks(source)
  const caret = streaming ? renderCaret() : null
  // 내용이 아직 없는데 스트리밍 중이면 캐럿만이라도 보여 빈 말풍선을 피한다
  if (blocks.length === 0) {
    return <>{caret}</>
  }
  const lastIndex = blocks.length - 1
  return <>{blocks.map((block, key) => renderBlock(block, key, key === lastIndex ? caret : null))}</>
}
