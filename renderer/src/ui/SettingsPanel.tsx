/**
 * 설정 패널 — API 키 입력/삭제 (CLAUDE.md R7: 키는 런타임 입력) + MCP 서버 연결(요구 ④).
 * 저장된 키는 마스킹해서만 보여주고 전체를 다시 노출하지 않는다.
 * MCP 서버는 추가/제거/켜고끄기 + 연결 상태 표시 — 연결 안 돼도 노아 기본 기능은 정상.
 */

'use client'

import { useState, type FormEvent } from 'react'
import { X, Plug, Trash2 } from 'lucide-react'
import { clearApiKey, getStoredApiKey, maskApiKey, saveApiKey } from './apiKeySettings'
import {
  addMcpServerConfig,
  loadMcpServerConfigs,
  removeMcpServerConfig,
  setMcpServerEnabled,
  type McpServerDraft,
} from './mcpSettings'
import type { McpServerConfig, McpServerConnectionStatus } from '../tools/mcp'

interface SettingsPanelProps {
  isOpen: boolean
  onClose(): void
  /** 키 저장/삭제 후 호출 — 상위가 hasApiKey 상태를 갱신한다 */
  onApiKeyChanged(): void
  /** MCP 서버 연결 상태(설정 변경 시 갱신됨) */
  mcpStatuses: readonly McpServerConnectionStatus[]
  /** 설정 변경 후 MCP 서버 재연결 — 상위(useCompanionSession)가 수행 */
  onReconnectMcp(): Promise<void>
}

const EMPTY_DRAFT: McpServerDraft = { label: '', command: '', argsText: '' }

export function SettingsPanel({
  isOpen,
  onClose,
  onApiKeyChanged,
  mcpStatuses,
  onReconnectMcp,
}: SettingsPanelProps) {
  const [draftKey, setDraftKey] = useState('')
  const [noticeText, setNoticeText] = useState('')
  const [mcpConfigs, setMcpConfigs] = useState<McpServerConfig[]>(() => loadMcpServerConfigs())
  const [mcpDraft, setMcpDraft] = useState<McpServerDraft>(EMPTY_DRAFT)
  const [mcpNotice, setMcpNotice] = useState('')
  const [isMcpBusy, setIsMcpBusy] = useState(false)

  if (!isOpen) {
    return null
  }

  const storedKey = getStoredApiKey()

  function handleSave(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!saveApiKey(draftKey)) {
      setNoticeText('키가 비어 있어요. 값을 입력해 주세요.')
      return
    }
    setDraftKey('')
    setNoticeText('저장했어요. 다음 대화부터 바로 적용됩니다.')
    onApiKeyChanged()
  }

  function handleClear(): void {
    clearApiKey()
    setNoticeText('키를 삭제했어요.')
    onApiKeyChanged()
  }

  async function reconnect(message: string): Promise<void> {
    setIsMcpBusy(true)
    setMcpNotice('연결 중…')
    try {
      await onReconnectMcp()
      setMcpNotice(message)
    } catch {
      setMcpNotice('연결을 갱신하지 못했어요.')
    } finally {
      setIsMcpBusy(false)
    }
  }

  async function handleAddServer(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const result = addMcpServerConfig(mcpDraft)
    if (!result.ok) {
      setMcpNotice(result.reason)
      return
    }
    setMcpConfigs(result.configs)
    setMcpDraft(EMPTY_DRAFT)
    await reconnect('서버를 추가하고 연결했어요.')
  }

  async function handleRemoveServer(id: string): Promise<void> {
    setMcpConfigs(removeMcpServerConfig(id))
    await reconnect('서버를 제거했어요.')
  }

  async function handleToggleServer(id: string, enabled: boolean): Promise<void> {
    setMcpConfigs(setMcpServerEnabled(id, enabled))
    await reconnect(enabled ? '서버를 켰어요.' : '서버를 껐어요.')
  }

  return (
    <div id="settings-panel" className="settings-panel">
      <div className="settings-header">
        <h2 className="settings-title">설정</h2>
        <button
          id="settings-close"
          className="chat-button chat-button-secondary chat-button-icon"
          type="button"
          title="닫기"
          aria-label="닫기"
          onClick={onClose}
        >
          <X size={18} strokeWidth={1.9} aria-hidden="true" />
        </button>
      </div>

      <p className="settings-status" id="settings-key-status">
        {storedKey === null
          ? 'Anthropic API 키가 설정되지 않았습니다.'
          : `현재 키: ${maskApiKey(storedKey)}`}
      </p>

      <form className="settings-form" onSubmit={handleSave}>
        <input
          id="settings-key-input"
          className="chat-input"
          type="password"
          value={draftKey}
          placeholder="sk-ant-로 시작하는 API 키"
          autoComplete="off"
          onChange={(event) => setDraftKey(event.target.value)}
        />
        <div className="settings-actions">
          <button id="settings-save" className="chat-button" type="submit">
            저장
          </button>
          <button
            id="settings-clear"
            className="chat-button chat-button-secondary"
            type="button"
            onClick={handleClear}
            disabled={storedKey === null}
          >
            삭제
          </button>
        </div>
      </form>

      {noticeText.length > 0 && <p className="settings-notice">{noticeText}</p>}
      <p className="settings-hint">
        키는 이 컴퓨터에만 저장되며, 코드나 설치 파일에 포함되지 않습니다 (R7).
      </p>

      <div className="settings-section-divider" />

      <h3 className="settings-subtitle">
        <Plug size={16} strokeWidth={1.9} aria-hidden="true" />
        MCP 서버 (외부 도구 연동)
      </h3>
      <p className="settings-hint">
        MCP 서버를 연결하면 그 도구를 노아가 일반 도구처럼 씁니다. 외부 도구는 보수적으로
        취급되어(실행+기록, 위험한 작업은 승인) 안전하게 동작합니다.
      </p>

      <ul className="mcp-server-list">
        {mcpConfigs.length === 0 && (
          <li className="mcp-server-empty">연결된 MCP 서버가 없습니다.</li>
        )}
        {mcpConfigs.map((config) => {
          const status = mcpStatuses.find((entry) => entry.id === config.id)
          return (
            <li key={config.id} className="mcp-server-item">
              <div className="mcp-server-main">
                <span className="mcp-server-label">{config.label}</span>
                <span className={`mcp-server-status mcp-status-${describeStatusKind(status)}`}>
                  {describeStatusText(status, config.enabled)}
                </span>
              </div>
              <code className="mcp-server-command">
                {config.command} {config.args.join(' ')}
              </code>
              <div className="mcp-server-actions">
                <button
                  className="chat-button chat-button-secondary chat-button-small"
                  type="button"
                  disabled={isMcpBusy}
                  onClick={() => void handleToggleServer(config.id, !config.enabled)}
                >
                  {config.enabled ? '끄기' : '켜기'}
                </button>
                <button
                  className="chat-button chat-button-secondary chat-button-small chat-button-icon"
                  type="button"
                  title="제거"
                  aria-label="제거"
                  disabled={isMcpBusy}
                  onClick={() => void handleRemoveServer(config.id)}
                >
                  <Trash2 size={15} strokeWidth={1.9} aria-hidden="true" />
                </button>
              </div>
            </li>
          )
        })}
      </ul>

      <form className="settings-form mcp-add-form" onSubmit={(event) => void handleAddServer(event)}>
        <input
          className="chat-input"
          type="text"
          value={mcpDraft.label}
          placeholder="이름 (예: 파일시스템)"
          onChange={(event) => setMcpDraft((previous) => ({ ...previous, label: event.target.value }))}
        />
        <input
          className="chat-input"
          type="text"
          value={mcpDraft.command}
          placeholder="실행 명령 (예: npx)"
          autoComplete="off"
          onChange={(event) => setMcpDraft((previous) => ({ ...previous, command: event.target.value }))}
        />
        <input
          className="chat-input"
          type="text"
          value={mcpDraft.argsText}
          placeholder={'인자 (예: -y @modelcontextprotocol/server-filesystem "C:\\docs")'}
          autoComplete="off"
          onChange={(event) => setMcpDraft((previous) => ({ ...previous, argsText: event.target.value }))}
        />
        <div className="settings-actions">
          <button className="chat-button" type="submit" disabled={isMcpBusy}>
            서버 추가
          </button>
          <button
            className="chat-button chat-button-secondary"
            type="button"
            disabled={isMcpBusy}
            onClick={() => void reconnect('연결을 새로고침했어요.')}
          >
            새로고침
          </button>
        </div>
      </form>

      {mcpNotice.length > 0 && <p className="settings-notice">{mcpNotice}</p>}
      <p className="settings-hint">
        명령·인자는 이 컴퓨터에만 저장됩니다. 인자에 비밀 키를 넣지 마세요. 서버는 셸 없이
        직접 실행됩니다.
      </p>
    </div>
  )
}

type StatusKind = 'connected' | 'error' | 'disabled' | 'pending'

function describeStatusKind(status: McpServerConnectionStatus | undefined): StatusKind {
  if (status === undefined) {
    return 'pending'
  }
  return status.status
}

function describeStatusText(
  status: McpServerConnectionStatus | undefined,
  enabled: boolean,
): string {
  if (status === undefined) {
    return enabled ? '대기 중' : '꺼짐'
  }
  if (status.status === 'connected') {
    return `연결됨 · 도구 ${status.toolCount}개`
  }
  if (status.status === 'error') {
    return `오류: ${status.message}`
  }
  return '꺼짐'
}
