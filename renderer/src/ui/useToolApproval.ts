/**
 * 위험 도구 승인 다이얼로그 상태 (R4 — dangerous는 ui 승인 후 실행).
 *
 * gate가 requestApproval을 호출하면 pending 상태로 모달을 띄우고,
 * 사용자가 승인/거부를 누를 때까지 Promise를 보류한다.
 */

'use client'

import { useCallback, useRef, useState } from 'react'
import type { ApprovalRequest, ApprovalRequester } from '../tools/gate'

export interface PendingApproval {
  request: ApprovalRequest
}

export interface ToolApprovalView {
  pending: PendingApproval | null
  requestApproval: ApprovalRequester
  approve(): void
  deny(): void
}

export function useToolApproval(): ToolApprovalView {
  const [pending, setPending] = useState<PendingApproval | null>(null)
  const resolveRef = useRef<((isApproved: boolean) => void) | null>(null)

  const requestApproval = useCallback<ApprovalRequester>((request) => {
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve
      setPending({ request })
    })
  }, [])

  const settle = useCallback((isApproved: boolean): void => {
    resolveRef.current?.(isApproved)
    resolveRef.current = null
    setPending(null)
  }, [])

  const approve = useCallback(() => settle(true), [settle])
  const deny = useCallback(() => settle(false), [settle])

  return { pending, requestApproval, approve, deny }
}
