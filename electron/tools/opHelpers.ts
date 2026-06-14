/**
 * 도구 작업 공통 헬퍼 — 입력 검증·경로 가드·PowerShell 실행.
 *
 * 파일을 다루는 모든 도구가 같은 가드를 쓰도록 한 곳에 모은다(복제 시 한쪽만
 * 갱신돼 보안 구멍이 생긴다). 경로 가드는 CLAUDE.md §5·검토 반영:
 * 절대경로 + 심볼릭 링크 차단 + 민감 위치 차단(sensitivePaths).
 */

import { spawn } from 'node:child_process'
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { isSensitivePath } from '../security/sensitivePaths'
import type { ToolOperationResult } from '../ipc/channels'

/** 도구 작업 한 건의 실행 시그니처 — 카테고리 모듈이 같은 모양으로 내보낸다 */
export type ToolOperation = (input: Record<string, unknown>) => Promise<ToolOperationResult>

export type PathValidation = { ok: true; resolved: string } | { ok: false; reason: string }

export function failure(output: string): ToolOperationResult {
  return { isSuccess: false, output }
}

export function success(output: string, rollbackInfo?: string): ToolOperationResult {
  return rollbackInfo === undefined
    ? { isSuccess: true, output }
    : { isSuccess: true, output, rollbackInfo }
}

export function requireStringField(input: Record<string, unknown>, fieldName: string): string | null {
  const value = input[fieldName]
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null
  }
  return value.trim()
}

export function readNumberField(input: Record<string, unknown>, fieldName: string): number | null {
  const value = input[fieldName]
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function readBooleanField(input: Record<string, unknown>, fieldName: string): boolean {
  const value = input[fieldName]
  if (typeof value === 'boolean') {
    return value
  }
  // LLM이 문자열로 보낼 수 있어 관대하게 받는다('TRUE'·'1' 등)
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase()
    return lower === 'true' || lower === '1' || lower === 'yes'
  }
  return false
}

/**
 * 절대경로 + 존재 + 심볼릭 링크 차단 + 민감 위치 차단 (읽기/이동/삭제할 기존 대상).
 * 대상뿐 아니라 상위 폴더가 심링크·정션이어도 보호경로로 새지 않게 realpath로
 * 실제 경로를 기준으로 민감 검사한다.
 */
export function validateExistingPath(filePath: string): PathValidation {
  if (!path.isAbsolute(filePath)) {
    return { ok: false, reason: '절대 경로만 허용됩니다.' }
  }
  const normalized = path.normalize(filePath)
  if (!existsSync(normalized)) {
    return { ok: false, reason: `경로가 없습니다: ${normalized}` }
  }
  if (lstatSync(normalized).isSymbolicLink()) {
    return { ok: false, reason: '심볼릭 링크는 허용되지 않습니다.' }
  }
  let resolved: string
  try {
    // 상위 심링크·정션까지 풀어 실제 경로를 얻는다(대상은 위에서 심링크가 아님이 보장됨)
    resolved = realpathSync(normalized)
  } catch {
    return { ok: false, reason: '경로를 확인할 수 없습니다.' }
  }
  if (isSensitivePath(resolved)) {
    return { ok: false, reason: '보호된 시스템·자격증명 경로에는 접근할 수 없습니다.' }
  }
  return { ok: true, resolved }
}

/** 기존 대상이면서 디렉터리여야 하는 경우(목록·검색·압축해제 대상) */
export function validateDirectoryPath(dirPath: string): PathValidation {
  const base = validateExistingPath(dirPath)
  if (!base.ok) {
    return base
  }
  if (!statSync(base.resolved).isDirectory()) {
    return { ok: false, reason: '폴더가 아닙니다.' }
  }
  return base
}

/**
 * 새로 만들/덮어쓸 대상 경로 가드: 절대경로 + 상위 폴더 존재 + 민감 위치 차단 +
 * (이미 있으면) 심볼릭 링크 덮어쓰기 차단. 대상 파일 자체는 없어도 된다.
 *
 * 상위 폴더가 심볼릭 링크·정션이면 실제 위치로 우회될 수 있으므로, 상위를
 * realpath로 풀어 **실제 경로**를 기준으로 민감 검사한다(심링크 부모를 통한 탈출 차단).
 */
export function validateWriteTargetPath(filePath: string): PathValidation {
  if (!path.isAbsolute(filePath)) {
    return { ok: false, reason: '절대 경로만 허용됩니다.' }
  }
  const normalized = path.normalize(filePath)
  const parentDirectory = path.dirname(normalized)
  if (!existsSync(parentDirectory)) {
    return { ok: false, reason: `상위 폴더가 없습니다: ${parentDirectory}` }
  }
  // 상위 폴더의 실제 경로로 대상을 재구성 — 심링크·정션 부모를 통한 보호경로 이탈 차단
  let realParent: string
  try {
    realParent = realpathSync(parentDirectory)
  } catch {
    return { ok: false, reason: '상위 폴더 경로를 확인할 수 없습니다.' }
  }
  const resolved = path.join(realParent, path.basename(normalized))
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    return { ok: false, reason: '심볼릭 링크 대상은 덮어쓸 수 없습니다.' }
  }
  if (isSensitivePath(resolved)) {
    return { ok: false, reason: '보호된 시스템·자격증명 경로에는 쓸 수 없습니다.' }
  }
  return { ok: true, resolved }
}

export interface PowerShellResult {
  ok: boolean
  stdout: string
  stderr: string
}

/** PowerShell 출력 누적 상한 — 폭주 출력으로 인한 메모리 고갈(OOM) 방지 */
const POWERSHELL_MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/**
 * PowerShell 스크립트를 실행한다. 경로·사용자 값은 절대 스크립트에 문자열로 섞지
 * 않고 환경변수(env)로 전달한다 — 명령 인젝션 차단(toolHost의 휴지통 패턴과 동일).
 * 스크립트 안에서는 $env:NAME 으로 읽는다. shell:false + -NonInteractive.
 */
export function runPowerShell(
  script: string,
  environment: Record<string, string>,
  timeoutMs: number,
): Promise<PowerShellResult> {
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env: { ...process.env, ...environment }, windowsHide: true, shell: false },
    )
    let stdout = ''
    let stderr = ''
    let isOverflowed = false
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, stdout, stderr: '시간 초과' })
    }, timeoutMs)
    // 출력이 상한을 넘으면 즉시 종료한다 — 폭주 출력이 시간 초과 전에 메모리를 삼키지 않게
    const guardOverflow = (): void => {
      if (!isOverflowed && stdout.length + stderr.length > POWERSHELL_MAX_OUTPUT_BYTES) {
        isOverflowed = true
        clearTimeout(timer)
        child.kill()
        resolve({ ok: false, stdout: stdout.slice(0, POWERSHELL_MAX_OUTPUT_BYTES), stderr: '출력이 너무 큽니다(상한 초과)' })
      }
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (isOverflowed) {
        return
      }
      stdout += chunk.toString()
      guardOverflow()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (isOverflowed) {
        return
      }
      stderr += chunk.toString()
      guardOverflow()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, stdout, stderr: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() })
    })
  })
}
