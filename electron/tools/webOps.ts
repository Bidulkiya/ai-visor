/**
 * 웹 도구 (메인 프로세스 실행 계층, R4).
 *
 * web_fetch: URL 본문을 가져와 텍스트로 돌려준다. http/https 스킴만 허용한다
 * (file:, data:, javascript: 등 로컬·위험 스킴 차단). 응답 크기를 제한한다.
 */

import { net } from 'electron'
import type { ToolOperationResult } from '../ipc/channels'
import { failure, requireStringField, success, type ToolOperation } from './opHelpers'

type WebOperationName = 'web_fetch'

/** 본문 상한 — LLM 컨텍스트·메모리 보호 */
const FETCH_MAX_CHARS = 20000
/** 요청 타임아웃 */
const FETCH_TIMEOUT_MS = 15000
const ALLOWED_SCHEMES: readonly string[] = ['http:', 'https:']

/**
 * SSRF 방어 — 사설·루프백·링크로컬 호스트(내부망·클라우드 메타데이터)를 막는다.
 * URL의 호스트 리터럴(IP·localhost)을 검사한다. 초기 URL과 리다이렉트 후 최종 URL
 * 양쪽에 적용해, 내부 주소로 새는 응답이 LLM에 노출되지 않게 한다.
 */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '') // IPv6 대괄호 제거
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::1') {
    return true
  }
  // IPv6 사설·링크로컬
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) {
    return true
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4 === null) {
    return false // 일반 도메인 — 통과(리터럴 사설 IP만 차단)
  }
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
  if (a === 127 || a === 10 || a === 0) {
    return true // 루프백·사설(10/8)·0.0.0.0/8
  }
  if (a === 192 && b === 168) {
    return true // 사설 192.168/16
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true // 사설 172.16/12
  }
  if (a === 169 && b === 254) {
    return true // 링크로컬·클라우드 메타데이터 169.254/16
  }
  return false
}

/** HTML이면 태그를 걷어내 대략적인 본문 텍스트만 남긴다(간이 변환) */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

async function webFetchOperation(input: Record<string, unknown>): Promise<ToolOperationResult> {
  const rawUrl = requireStringField(input, 'url')
  if (rawUrl === null) {
    return failure('URL이 비어 있습니다.')
  }
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return failure('올바른 URL이 아닙니다.')
  }
  if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
    return failure('http/https URL만 가져올 수 있습니다.')
  }
  if (isBlockedHost(parsed.hostname)) {
    return failure('내부망·로컬 주소는 가져올 수 없습니다.')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await net.fetch(parsed.toString(), { signal: controller.signal })
    // 리다이렉트로 내부 주소에 도달했으면 본문을 돌려주지 않는다(SSRF 데이터 노출 차단)
    try {
      if (isBlockedHost(new URL(response.url).hostname)) {
        return failure('리다이렉트가 내부망·로컬 주소로 향해 차단했습니다.')
      }
    } catch {
      // response.url 파싱 실패는 무시하고 진행
    }
    if (!response.ok) {
      return failure(`요청 실패 (HTTP ${response.status})`)
    }
    const contentType = response.headers.get('content-type') ?? ''
    const body = await response.text()
    const text = contentType.includes('text/html') ? stripHtml(body) : body.trim()
    if (text.length > FETCH_MAX_CHARS) {
      return success(`${text.slice(0, FETCH_MAX_CHARS)}\n…(${text.length}자 중 앞 ${FETCH_MAX_CHARS}자만 표시)`)
    }
    return success(text.length > 0 ? text : '(빈 응답)')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return failure(`가져오기 실패: ${detail}`)
  } finally {
    clearTimeout(timer)
  }
}

export function buildWebOperations(): Record<WebOperationName, ToolOperation> {
  return {
    web_fetch: webFetchOperation,
  }
}
