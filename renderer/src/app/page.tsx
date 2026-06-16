'use client'

import { useState } from 'react'
import { Settings } from 'lucide-react'
import { ApprovalDialog } from '../ui/ApprovalDialog'
import { ChatPanel } from '../ui/ChatPanel'
import { DocumentPanel } from '../ui/DocumentPanel'
import { FaceCanvas } from '../ui/FaceCanvas'
import { SettingsPanel } from '../ui/SettingsPanel'
import { useCompanionSession } from '../ui/useCompanionSession'
import { useDocument } from '../ui/useDocument'
import { useToolApproval } from '../ui/useToolApproval'
import { useVoice } from '../ui/useVoice'
import { resolveInputRoute } from '../ui/inputRouting'
import { createDemoSlideDeck } from '../presentation/demoDeck'

export default function HomePage() {
  const approval = useToolApproval()
  const session = useCompanionSession(approval.requestApproval)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  // 발표·문서이해 컨트롤러는 본체를 호출만 한다 (R3) — ui는 세션·도구 런타임을 건네 배선만
  const workspace = useDocument(session.session, session.toolRuntime)

  // 아래 메인 입력(텍스트·음성)을 현재 모드로 라우팅한다(resolveInputRoute가 결정, 순수).
  // 문서 열림→documentAsk, 발표 중→presentationAsk, 그 외→sendMessage(일반). busy면 안내 문구를
  // 돌려줘 입력을 보존하게 한다(null=수락). documentAsk·presentationAsk·sendMessage 로직은 불변.
  const routeInput = (text: string, source: 'chat' | 'voice'): string | null => {
    const route = resolveInputRoute(
      workspace.documentView.stage.name,
      workspace.presentationView.stage.name,
    )
    switch (route.kind) {
      case 'busy':
        return route.notice
      case 'document':
        // 문서/발표 질문은 본체에 증강 프롬프트로 주입돼 말풍선이 안 남는다 — 통합 채팅이
        // 대화로 읽히게 사용자 질문을 먼저 표시한다(일반 채팅은 sendMessage가 자체 표시).
        session.appendUserMessage(text)
        void workspace.documentAsk(text)
        return null
      case 'presentation':
        session.appendUserMessage(text)
        void workspace.presentationAsk(text)
        return null
      case 'general':
        void session.sendMessage(text, source)
        return null
    }
  }

  // STT 확정 텍스트도 같은 라우팅을 탄다 — 음성으로도 문서/청중 질문을 한다(텍스트와 일관, R1)
  const voice = useVoice(session.outputStream, (text) => {
    routeInput(text, 'voice')
  })

  if (session.connectionState === 'no-bridge') {
    return (
      <main className="app-layout">
        <p className="app-notice">
          Electron 앱으로 실행해 주세요 — 브라우저 단독으로는 기억 저장소에 연결할 수 없습니다.
        </p>
      </main>
    )
  }

  // 입력창 placeholder를 현재 모드에 맞춘다(라우팅과 같은 resolveInputRoute로 결정 — 단일 출처).
  // busy(읽는 중·답하는 중)면 그 안내를 그대로 보여, "이 입력이 지금 무엇으로 가는지"가 읽힌다.
  // placeholder가 모드 전환마다 바뀌므로 ChatPanel이 이를 신호로 묵은 sendNotice도 정리한다.
  const currentRoute = resolveInputRoute(
    workspace.documentView.stage.name,
    workspace.presentationView.stage.name,
  )
  const chatPlaceholder =
    currentRoute.kind === 'busy'
      ? currentRoute.notice
      : currentRoute.kind === 'document'
        ? '이 문서에 대해 물어보세요'
        : currentRoute.kind === 'presentation'
          ? '청중 질문을 입력하세요'
          : '메시지를 입력하세요'

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
          <Settings size={16} strokeWidth={1.9} aria-hidden="true" />
          설정
        </button>
      </aside>

      <div className="app-chat-column">
        {session.connectionState === 'connected' && !session.hasApiKey && (
          <p id="api-key-banner" className="api-key-banner">
            Anthropic API 키가 설정되지 않았어요. 대화하려면 ⚙ 설정에서 키를 입력해 주세요.
          </p>
        )}
        <DocumentPanel
          presentationView={workspace.presentationView}
          documentView={workspace.documentView}
          isDisabled={session.connectionState !== 'connected' || !workspace.isAvailable}
          isLoading={workspace.isLoading}
          loadNotice={workspace.loadNotice}
          onOpenUnderstand={() => void workspace.openForUnderstanding()}
          onOpenPresent={() => void workspace.openForPresentation(createDemoSlideDeck())}
          onStartDemo={() => workspace.startDemo(createDemoSlideDeck())}
          onPresentationStop={workspace.presentationStop}
          onDocumentClose={workspace.documentClose}
        />
        <ChatPanel
          messages={session.messages}
          isThinking={session.isThinking}
          isDisabled={session.connectionState !== 'connected'}
          // 한 입력창으로 통합 — 모드에 따라 문서 질문/청중 질문/일반 채팅으로 라우팅한다
          placeholder={chatPlaceholder}
          onSend={(text) => routeInput(text, 'chat')}
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
