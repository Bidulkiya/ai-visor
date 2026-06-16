/**
 * 메인 채팅 입력의 라우팅 결정 — 순수 함수 (입력창 통합)
 *
 * 아래 입력창 하나로 문서 질문·청중 질문·일반 채팅을 모두 한다. "지금 어디로 보낼지"를
 * 현재 모드(문서/발표 단계)로 정한다. 부수효과(실제 호출)는 호출자(page.tsx)가 맡고,
 * 여기서는 결정만 한다 — 그래야 라우팅 진리표를 부수효과 없이 검증할 수 있다.
 *
 * 우선순위: 문서가 열려 있으면 문서, 아니면 발표(진행 중), 그 외 일반. busy는 진행 중이라
 * 새 질문을 받을 수 없는 상태(요약/답변 생성 중) — 입력을 보존하도록 안내 문구를 돌려준다.
 */

// presentation/documentUnderstanding.ts의 DocumentStage·controller.ts의 PresentationStage
// 이름과 거울 동기다. import 대신 로컬로 둬 의존 없는 리프(검증 용이)로 유지하고, 드리프트는
// 호출처(page.tsx)가 실제 union을 이 파라미터로 넘길 때 타입 검사로 잡힌다.
type DocumentStageName = 'idle' | 'reading' | 'ready' | 'answering'
type PresentationStageName = 'idle' | 'researching' | 'presenting' | 'answering' | 'finished'

export type InputRoute =
  | { kind: 'document' }
  | { kind: 'presentation' }
  | { kind: 'general' }
  | { kind: 'busy'; notice: string }

export function resolveInputRoute(
  documentStage: DocumentStageName,
  presentationStage: PresentationStageName,
): InputRoute {
  // 문서 모드(열림)가 최우선 — 일반 채팅으로 새지 않게 documentStage를 먼저 본다.
  if (documentStage !== 'idle') {
    if (documentStage === 'ready') {
      return { kind: 'document' }
    }
    return {
      kind: 'busy',
      notice:
        documentStage === 'reading'
          ? '문서를 읽고 있어요. 잠시 후 물어봐 주세요.'
          : '답하는 중이에요. 끝나면 다시 물어봐 주세요.',
    }
  }
  // 발표가 진행 중(연속 단계)일 때만 청중 질문으로 — 'finished'/'idle'은 일반 채팅으로 돌아간다.
  if (
    presentationStage === 'researching' ||
    presentationStage === 'presenting' ||
    presentationStage === 'answering'
  ) {
    if (presentationStage === 'presenting') {
      return { kind: 'presentation' }
    }
    return {
      kind: 'busy',
      notice:
        presentationStage === 'researching'
          ? '발표 준비 중이에요. 잠시 후 물어봐 주세요.'
          : '앞 질문에 답하는 중이에요. 끝나면 다시 물어봐 주세요.',
    }
  }
  return { kind: 'general' }
}
