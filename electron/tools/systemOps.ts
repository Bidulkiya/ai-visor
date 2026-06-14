/**
 * 시스템 정보 도구 (메인 프로세스 실행 계층, R4).
 *
 * system_status: 배터리·CPU·메모리·디스크. os 모듈 + PowerShell(WMI) 조합.
 * get_clipboard/set_clipboard: Electron clipboard. 덮어쓰기 경고·롤백 정보 포함.
 */

import { clipboard } from 'electron'
import os from 'node:os'
import type { ToolOperationResult } from '../ipc/channels'
import { failure, requireStringField, runPowerShell, success, type ToolOperation } from './opHelpers'

type SystemOperationName = 'system_status' | 'get_clipboard' | 'set_clipboard'

const SYSTEM_INFO_TIMEOUT_MS = 8000
/** 클립보드 표시·기록 상한 */
const CLIPBOARD_MAX_CHARS = 4000

interface WmiDisk {
  drive: string
  sizeGB: number
  freeGB: number
}

interface WmiSystemInfo {
  cpuLoad: number | null
  batteryPercent: number | null
  batteryCharging: boolean | null
  disks: WmiDisk[]
}

const SYSTEM_INFO_SCRIPT = `
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$bat = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
  [pscustomobject]@{ drive = $_.DeviceID; sizeGB = [math]::Round($_.Size/1GB,1); freeGB = [math]::Round($_.FreeSpace/1GB,1) }
})
[pscustomobject]@{
  cpuLoad = $cpu
  batteryPercent = $(if ($bat) { [int]$bat.EstimatedChargeRemaining } else { $null })
  batteryCharging = $(if ($bat) { $bat.BatteryStatus -eq 2 } else { $null })
  disks = $disks
} | ConvertTo-Json -Compress -Depth 4
`

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`
}

async function loadWmiSystemInfo(): Promise<WmiSystemInfo | null> {
  const result = await runPowerShell(SYSTEM_INFO_SCRIPT, {}, SYSTEM_INFO_TIMEOUT_MS)
  if (!result.ok || result.stdout.length === 0) {
    return null
  }
  try {
    return JSON.parse(result.stdout) as WmiSystemInfo
  } catch (error) {
    // 파싱 실패해도 os 기반 요약은 돌려주되, 원인 추적을 위해 기록은 남긴다
    console.error('[systemOps.system_status]: WMI 출력 파싱 실패:', error)
    return null
  }
}

async function systemStatusOperation(): Promise<ToolOperationResult> {
  const totalMemory = os.totalmem()
  const freeMemory = os.freemem()
  const cpus = os.cpus()
  const lines = [
    `CPU: ${cpus[0]?.model.trim() ?? '알 수 없음'} (${cpus.length}코어)`,
    `메모리: ${formatBytes(totalMemory - freeMemory)} / ${formatBytes(totalMemory)} 사용`,
    `가동 시간: ${Math.round(os.uptime() / 60)}분`,
    `플랫폼: ${os.platform()} ${os.release()}`,
  ]

  // WMI 정보는 best-effort — 실패해도 os 기반 요약은 돌려준다(도구가 깨지지 않게)
  const wmi = await loadWmiSystemInfo()
  if (wmi !== null) {
    if (wmi.cpuLoad !== null) {
      lines.splice(1, 0, `CPU 사용률: ${Math.round(wmi.cpuLoad)}%`)
    }
    if (wmi.batteryPercent !== null) {
      const charging = wmi.batteryCharging === true ? ' (충전 중)' : ''
      lines.push(`배터리: ${wmi.batteryPercent}%${charging}`)
    } else {
      lines.push('배터리: 없음(데스크톱) 또는 정보 없음')
    }
    for (const disk of wmi.disks) {
      lines.push(`디스크 ${disk.drive} ${disk.freeGB}GB 여유 / ${disk.sizeGB}GB`)
    }
  } else {
    lines.push('(배터리·디스크 상세는 가져오지 못했습니다)')
  }
  return success(lines.join('\n'))
}

async function getClipboardOperation(): Promise<ToolOperationResult> {
  const text = clipboard.readText()
  if (text.length === 0) {
    return success('(클립보드가 비어 있거나 텍스트가 아닙니다)')
  }
  if (text.length > CLIPBOARD_MAX_CHARS) {
    return success(`${text.slice(0, CLIPBOARD_MAX_CHARS)}\n…(${text.length}자 중 앞 ${CLIPBOARD_MAX_CHARS}자)`)
  }
  return success(text)
}

async function setClipboardOperation(input: Record<string, unknown>): Promise<ToolOperationResult> {
  const text = requireStringField(input, 'text')
  if (text === null) {
    return failure('클립보드에 넣을 텍스트(text)가 비어 있습니다.')
  }
  // 덮어쓰기 경고 + 이전 내용을 롤백 정보로 보존(자동 복원은 안 하지만 사람이 되돌릴 수 있게)
  const previous = clipboard.readText()
  clipboard.writeText(text)
  const previousSummary =
    previous.length === 0
      ? '이전 클립보드는 비어 있었음'
      : `이전 클립보드(${previous.length}자): ${previous.slice(0, CLIPBOARD_MAX_CHARS)}`
  return success(`클립보드를 덮어썼습니다 (${text.length}자). 이전 내용은 사라졌습니다.`, previousSummary)
}

export function buildSystemOperations(): Record<SystemOperationName, ToolOperation> {
  return {
    system_status: systemStatusOperation,
    get_clipboard: getClipboardOperation,
    set_clipboard: setClipboardOperation,
  }
}
