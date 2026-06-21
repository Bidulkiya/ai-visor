/**
 * MCP 서버 설정 저장소 (요구 ④) — 사용자가 설정 UI에서 지정한 서버 목록을
 * localStorage(로컬 프로필)에 보관한다. API 키 저장(apiKeySettings.ts)과 같은 방식이다.
 *
 * 여기엔 명령(command)·인자(args)만 둔다 — 시크릿(키)을 args에 넣지 말라고 UI가 안내한다.
 * core·tools는 이 저장 방식을 모른다 — ui가 읽어 connectMcpServers에 넘긴다(주입).
 */

import type { McpServerConfig } from '../tools/mcp'

const MCP_SERVERS_STORAGE_KEY = 'aiVisor.mcpServers'
const SERVER_ID_MAX_LENGTH = 64
/** 서버 id 허용 형식 — electron/mcp/manager.ts의 SERVER_ID_PATTERN과 거울 동기 */
const SERVER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

export interface McpServerDraft {
  label: string
  command: string
  /** 공백으로 구분된 인자 문자열(따옴표로 공백 포함 인자 가능) */
  argsText: string
}

function isStorageAvailable(): boolean {
  return typeof localStorage !== 'undefined'
}

/** 저장된 설정을 읽어 검증·정규화한다. 깨졌거나 없으면 빈 배열(첫 실행 안전) */
export function loadMcpServerConfigs(): McpServerConfig[] {
  if (!isStorageAvailable()) {
    return []
  }
  const raw = localStorage.getItem(MCP_SERVERS_STORAGE_KEY)
  if (raw === null) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }
    // 손편집·마이그레이션으로 들어온 잘못된/중복 id를 거른다 — UI key 충돌·상태 오매칭 방지
    const seenIds = new Set<string>()
    const configs: McpServerConfig[] = []
    for (const item of parsed) {
      const config = normalizeConfig(item)
      if (config !== null && !seenIds.has(config.id)) {
        seenIds.add(config.id)
        configs.push(config)
      }
    }
    return configs
  } catch (error) {
    console.error('[ui.mcpSettings]: MCP 설정 파싱 실패 — 빈 목록으로 진행:', error)
    return []
  }
}

function normalizeConfig(raw: unknown): McpServerConfig | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const candidate = raw as Record<string, unknown>
  // id는 도구 네임스페이스에 쓰이므로 형식을 강제한다(빈 문자열·64자 초과·공백/유니코드 거부)
  if (
    typeof candidate.id !== 'string' ||
    !SERVER_ID_PATTERN.test(candidate.id) ||
    typeof candidate.command !== 'string'
  ) {
    return null
  }
  return {
    id: candidate.id,
    label: typeof candidate.label === 'string' && candidate.label.length > 0 ? candidate.label : candidate.id,
    command: candidate.command,
    args: Array.isArray(candidate.args) ? candidate.args.filter((arg): arg is string => typeof arg === 'string') : [],
    enabled: candidate.enabled !== false,
  }
}

export function saveMcpServerConfigs(configs: readonly McpServerConfig[]): void {
  if (!isStorageAvailable()) {
    return
  }
  localStorage.setItem(MCP_SERVERS_STORAGE_KEY, JSON.stringify(configs))
}

/**
 * 인자 문자열을 토큰으로 — 공백 구분, 큰따옴표로 공백 포함 인자 지원
 * (예: 파일시스템 서버 경로 "C:\\My Docs"). 순수 함수.
 */
export function parseArgsString(argsText: string): string[] {
  const tokens: string[] = []
  const matches = argsText.match(/"[^"]*"|\S+/g)
  if (matches === null) {
    return tokens
  }
  for (const match of matches) {
    tokens.push(match.startsWith('"') && match.endsWith('"') ? match.slice(1, -1) : match)
  }
  return tokens
}

/** 라벨에서 안정적 id를 만든다 — 허용 문자만, 소문자, 기존과 겹치면 접미사. 순수 함수 */
export function generateServerId(label: string, existingIds: readonly string[]): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, SERVER_ID_MAX_LENGTH)
  const seed = base.length > 0 ? base : 'server'
  if (!existingIds.includes(seed)) {
    return seed
  }
  let suffix = 2
  while (existingIds.includes(`${seed}-${suffix}`)) {
    suffix += 1
  }
  return `${seed}-${suffix}`
}

export type AddServerResult =
  | { ok: true; configs: McpServerConfig[] }
  | { ok: false; reason: string }

/** 드래프트를 검증해 새 서버를 추가하고, 갱신된 목록을 저장·반환한다 */
export function addMcpServerConfig(draft: McpServerDraft): AddServerResult {
  const label = draft.label.trim()
  const command = draft.command.trim()
  if (label.length === 0) {
    return { ok: false, reason: '이름을 입력해 주세요.' }
  }
  if (command.length === 0) {
    return { ok: false, reason: '실행 명령을 입력해 주세요. (예: npx)' }
  }
  const existing = loadMcpServerConfigs()
  const newConfig: McpServerConfig = {
    id: generateServerId(label, existing.map((config) => config.id)),
    label,
    command,
    args: parseArgsString(draft.argsText),
    enabled: true,
  }
  const configs = [...existing, newConfig]
  saveMcpServerConfigs(configs)
  return { ok: true, configs }
}

/** id로 서버를 제거하고 갱신된 목록을 저장·반환한다 */
export function removeMcpServerConfig(id: string): McpServerConfig[] {
  const configs = loadMcpServerConfigs().filter((config) => config.id !== id)
  saveMcpServerConfigs(configs)
  return configs
}

/** 서버 활성/비활성 토글 후 갱신된 목록을 저장·반환한다 */
export function setMcpServerEnabled(id: string, enabled: boolean): McpServerConfig[] {
  const configs = loadMcpServerConfigs().map((config) =>
    config.id === id ? { ...config, enabled } : config,
  )
  saveMcpServerConfigs(configs)
  return configs
}
