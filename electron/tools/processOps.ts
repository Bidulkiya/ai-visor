/**
 * 프로세스 도구 (메인 프로세스 실행 계층, R4).
 *
 * list_processes(safe): 실행 중 프로세스 목록(메모리 상위).
 * kill_process(dangerous): PID로 종료. 승인 게이트는 렌더러가 강제하고, 여기서는
 *   **OS 핵심 프로세스·자기 자신**을 코드 상수로 차단한다 — 사용자가 실수로
 *   승인해도 죽일 수 없게(R5: 차단 리스트는 감정과 무관한 코드 상수).
 */

import type { ToolOperationResult } from '../ipc/channels'
import { failure, readNumberField, runPowerShell, success, type ToolOperation } from './opHelpers'

type ProcessOperationName = 'list_processes' | 'kill_process'

const PROCESS_TIMEOUT_MS = 8000
const LIST_PROCESS_MAX = 40

/**
 * 죽이면 시스템이 불안정해지는 핵심 프로세스(소문자, 확장자 제외).
 * 승인과 무관하게 항상 차단한다.
 */
const CRITICAL_PROCESS_NAMES: readonly string[] = [
  'system',
  'system idle process',
  'registry',
  'smss',
  'csrss',
  'wininit',
  'winlogon',
  'services',
  'lsass',
  'svchost',
  'dwm',
  'fontdrvhost',
  'memory compression',
]

const LIST_PROCESS_SCRIPT = `
Get-Process | Sort-Object -Property WorkingSet64 -Descending | Select-Object -First ${LIST_PROCESS_MAX} |
  ForEach-Object { "{0,8} {1,9:N0}KB  {2}" -f $_.Id, ([math]::Round($_.WorkingSet64/1KB)), $_.ProcessName }
`

async function listProcessesOperation(): Promise<ToolOperationResult> {
  const result = await runPowerShell(LIST_PROCESS_SCRIPT, {}, PROCESS_TIMEOUT_MS)
  if (!result.ok || result.stdout.length === 0) {
    return failure(`프로세스 목록을 가져오지 못했습니다: ${result.stderr || '출력 없음'}`)
  }
  return success(`PID      메모리      이름 (메모리 상위 ${LIST_PROCESS_MAX})\n${result.stdout}`)
}

/**
 * 이름 조회와 종료를 **한 번의 PowerShell 호출**에서 한다 — 두 번 호출 사이에 PID가
 * 재사용돼 엉뚱한(핵심) 프로세스를 죽이는 경쟁 조건을 없앤다. 프로세스 객체를 잡아
 * 그 객체로 Stop하므로 PID 재해석도 없다. 차단 리스트는 코드 상수를 env로 넘긴다(R5).
 */
const KILL_PROCESS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$p = Get-Process -Id $env:AIVISOR_PID -ErrorAction SilentlyContinue
if (-not $p) { Write-Output 'NOTFOUND'; return }
$name = $p.ProcessName.ToLower()
$blocked = ($env:AIVISOR_BLOCKLIST).Split(',')
if ($blocked -contains $name) { Write-Output "BLOCKED:$name"; return }
try { $p | Stop-Process -Force -ErrorAction Stop; Write-Output "KILLED:$name" }
catch { Write-Output "ERROR:$($_.Exception.Message)" }
`

async function killProcessOperation(input: Record<string, unknown>): Promise<ToolOperationResult> {
  const processId = readNumberField(input, 'pid')
  if (processId === null || !Number.isInteger(processId) || processId <= 0) {
    return failure('종료할 프로세스 PID(양의 정수)가 필요합니다.')
  }
  // 자기 자신(앱 메인 프로세스)은 절대 죽이지 않는다 — 앱이 자살하지 않게
  if (processId === process.pid) {
    return failure('이 앱 자신은 종료할 수 없습니다.')
  }
  const result = await runPowerShell(
    KILL_PROCESS_SCRIPT,
    { AIVISOR_PID: String(processId), AIVISOR_BLOCKLIST: CRITICAL_PROCESS_NAMES.join(',') },
    PROCESS_TIMEOUT_MS,
  )
  const output = result.stdout
  if (output === 'NOTFOUND') {
    return failure(`PID ${processId} 프로세스를 찾을 수 없습니다.`)
  }
  if (output.startsWith('BLOCKED:')) {
    // 승인 게이트를 통과했더라도 핵심 프로세스는 코드가 막는다(R5)
    return failure(`'${output.slice('BLOCKED:'.length)}'은(는) OS 핵심 프로세스라 종료할 수 없습니다.`)
  }
  if (output.startsWith('KILLED:')) {
    return success(`종료함: ${output.slice('KILLED:'.length)} (PID ${processId})`)
  }
  const detail = output.startsWith('ERROR:') ? output.slice('ERROR:'.length) : result.stderr || '알 수 없는 오류'
  return failure(`종료 실패: ${detail}`)
}

export function buildProcessOperations(): Record<ProcessOperationName, ToolOperation> {
  return {
    list_processes: listProcessesOperation,
    kill_process: killProcessOperation,
  }
}
