'use client'

import { useState } from 'react'
import { ApprovalDialog } from '../ui/ApprovalDialog'
import { ChatPanel } from '../ui/ChatPanel'
import { FaceCanvas } from '../ui/FaceCanvas'
import { PresentationPanel } from '../ui/PresentationPanel'
import { SettingsPanel } from '../ui/SettingsPanel'
import { useCompanionSession } from '../ui/useCompanionSession'
import { usePresentation } from '../ui/usePresentation'
import { useToolApproval } from '../ui/useToolApproval'
import { useVoice } from '../ui/useVoice'
import { createDemoSlideDeck } from '../presentation/demoDeck'

export default function HomePage() {
  const approval = useToolApproval()
  const session = useCompanionSession(approval.requestApproval)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  // STT 확정 텍스트는 source 'voice'로 주입 — 본체는 source를 구분하지 않는다 (R1)
  const voice = useVoice(session.outputStream, (text) => {
    void session.sendMessage(text, 'voice')
  })
  // 발표 컨트롤러는 본체를 호출만 한다 (R3) — ui는 세션·도구 런타임을 건네 배선만
  const presentation = usePresentation(session.session, session.toolRuntime)

  if (session.connectionState === 'no-bridge') {
    return (
      <main className="app-layout">
        <p className="app-notice">
          Electron 앱으로 실행해 주세요 — 브라우저 단독으로는 기억 저장소에 연결할 수 없습니다.
        </p>
      </main>
    )
  }

  return (
    <main className="app-layout">
      <aside className="app-face-column">
        {session.outputStream !== null && <FaceCanvas stream={session.outputStream} />}
        {session.isFirstRun && session.messages.length === 0 && (
          <p className="app-onboarding">처음 만나는 사이네요. 먼저 인사를 건네 보세요!</p>
        )}
        <button
          id="settings-open"
          className="chat-button chat-button-secondary settings-open-button"
          type="button"
          onClick={() => setIsSettingsOpen(true)}
        >
          ⚙ 설정
        </button>
      </aside>

      <div className="app-chat-column">
        {session.connectionState === 'connected' && !session.hasApiKey && (
          <p id="api-key-banner" className="api-key-banner">
            Anthropic API 키가 설정되지 않았어요. 대화하려면 ⚙ 설정에서 키를 입력해 주세요.
          </p>
        )}
        <PresentationPanel
          view={presentation.view}
          isDisabled={session.connectionState !== 'connected' || !presentation.isAvailable}
          isLoadingDeck={presentation.isLoadingDeck}
          loadNotice={presentation.loadNotice}
          onOpenPptx={() => void presentation.openPptx(createDemoSlideDeck())}
          onStart={() => presentation.start(createDemoSlideDeck())}
          onStop={presentation.stop}
          onAskQuestion={presentation.askQuestion}
        />
        <ChatPanel
          messages={session.messages}
          isThinking={session.isThinking}
          isDisabled={session.connectionState !== 'connected'}
          onSend={(text) => {
            void session.sendMessage(text)
          }}
          onInterrupt={session.interrupt}
          voice={{
            isCapturing: voice.isCapturing,
            isSpeakerEnabled: voice.isSpeakerEnabled,
            voiceNotice: voice.voiceNotice,
            onTalkStart: voice.startTalk,
            onTalkEnd: voice.stopTalk,
            onToggleSpeaker: voice.toggleSpeaker,
          }}
        />
      </div>

      <SettingsPanel
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onApiKeyChanged={session.refreshApiKeyStatus}
      />

      <ApprovalDialog pending={approval.pending} onApprove={approval.approve} onDeny={approval.deny} />
    </main>
  )
}
