/**
 * 설정 패널 — API 키 입력/삭제 (CLAUDE.md R7: 키는 런타임 입력).
 * 저장된 키는 마스킹해서만 보여주고 전체를 다시 노출하지 않는다.
 */

'use client'

import { useState, type FormEvent } from 'react'
import { clearApiKey, getStoredApiKey, maskApiKey, saveApiKey } from './apiKeySettings'

interface SettingsPanelProps {
  isOpen: boolean
  onClose(): void
  /** 키 저장/삭제 후 호출 — 상위가 hasApiKey 상태를 갱신한다 */
  onApiKeyChanged(): void
}

export function SettingsPanel({ isOpen, onClose, onApiKeyChanged }: SettingsPanelProps) {
  const [draftKey, setDraftKey] = useState('')
  const [noticeText, setNoticeText] = useState('')

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

  return (
    <div id="settings-panel" className="settings-panel">
      <div className="settings-header">
        <h2 className="settings-title">설정</h2>
        <button id="settings-close" className="chat-button chat-button-secondary" type="button" onClick={onClose}>
          닫기
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
    </div>
  )
}
