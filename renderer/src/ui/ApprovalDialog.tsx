/**
 * 위험 도구 승인 모달 (R4) — dangerous 도구 실행 직전 사용자에게 묻는다.
 */

'use client'

import { AlertTriangle } from 'lucide-react'
import type { PendingApproval } from './useToolApproval'

interface ApprovalDialogProps {
  pending: PendingApproval | null
  onApprove(): void
  onDeny(): void
}

export function ApprovalDialog({ pending, onApprove, onDeny }: ApprovalDialogProps) {
  if (pending === null) {
    return null
  }

  const { request } = pending
  return (
    <div id="approval-dialog" className="settings-panel">
      <div className="settings-header">
        <h2 className="settings-title settings-title-danger">
          <AlertTriangle size={18} strokeWidth={1.9} aria-hidden="true" />
          위험 작업 승인
        </h2>
      </div>
      <p className="settings-status">
        <strong>{request.toolName}</strong> — {request.description}
      </p>
      <pre className="approval-input">{JSON.stringify(request.input, null, 2)}</pre>
      <div className="settings-actions">
        <button id="approval-deny" className="chat-button chat-button-secondary" type="button" onClick={onDeny}>
          거부
        </button>
        <button id="approval-approve" className="chat-button chat-button-danger" type="button" onClick={onApprove}>
          승인하고 실행
        </button>
      </div>
      <p className="settings-hint">실행하지 않으면 안전합니다. 확실할 때만 승인하세요.</p>
    </div>
  )
}
