/**
 * 통합 도구 레지스트리 + 위험도 태그 (CLAUDE.md R4)
 *
 * 모든 능력(파일/앱/검색/화면조작)은 이 레지스트리 하나에 등록된다.
 * - risk는 감정과 무관한 코드 상수다 (R5) — affection이 아무리 높아도 바뀌지 않는다.
 * - dangerous 도구의 승인 게이트는 gate.ts가 실행 직전 코드로 가로챈다.
 *   LLM 판단에 의존하지 않는다.
 *
 * 실행은 반드시 gate.ts를 거친다 — 레지스트리를 직접 실행하는 코드를 만들지 말 것.
 */

/**
 * safe      → 자동 실행
 * caution   → 실행 + 로그
 * dangerous → 실행 직전 승인 게이트 필수 (delete, run_command, computer_use 등)
 */
export type RiskLevel = 'safe' | 'caution' | 'dangerous'

export interface ToolExecutionResult {
  isSuccess: boolean
  output: string
  /** 가능한 작업은 롤백 정보를 함께 기록한다 (R4) */
  rollbackInfo?: string
}

export interface ToolDefinition {
  name: string
  description: string
  risk: RiskLevel
  /** LLM tool use에 넘길 JSON Schema */
  inputSchema: Record<string, unknown>
  execute(input: Record<string, unknown>): Promise<ToolExecutionResult>
}

export interface ToolRegistry {
  register(tool: ToolDefinition): void
  get(name: string): ToolDefinition | null
  list(): readonly ToolDefinition[]
}

export function createToolRegistry(): ToolRegistry {
  const toolsByName = new Map<string, ToolDefinition>()

  return {
    register(tool: ToolDefinition): void {
      if (toolsByName.has(tool.name)) {
        // 중복 등록은 버그다 — 어느 구현이 이기는지 모호해지므로 즉시 드러낸다
        throw new Error(`이미 등록된 도구입니다: ${tool.name}`)
      }
      toolsByName.set(tool.name, tool)
    },
    get(name: string): ToolDefinition | null {
      return toolsByName.get(name) ?? null
    },
    list(): readonly ToolDefinition[] {
      return [...toolsByName.values()]
    },
  }
}
