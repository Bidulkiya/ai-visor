/**
 * 메인 프로세스 도구 작업 호스트 — 파일·프로세스·네트워크의 실제 수행만 담당.
 *
 * 위험도 게이트·승인·감사 로그는 렌더러 쪽(renderer/src/tools/)의 몫이고,
 * 여기는 검증된 입력을 받아 작업만 한다 (R4의 실행 계층).
 * 도구 실행 로직을 preload에 두지 않는다 (CLAUDE.md §5 preload 보안 표면).
 */

import { ipcMain, net, shell } from 'electron'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { IPC_CHANNELS, type ToolOperationName, type ToolOperationResult } from '../ipc/channels'
import { failure, requireStringField, validateExistingPath, type ToolOperation } from './opHelpers'
import { buildFileOperations } from './fileOps'
import { buildWebOperations } from './webOps'
import { buildSystemOperations } from './systemOps'
import { buildProcessOperations } from './processOps'
import { buildInteractionOperations } from './interactionOps'

/** 파일 읽기 상한 — LLM 컨텍스트 보호 */
const READ_FILE_MAX_CHARS = 20000
/** 휴지통 이동 작업 타임아웃 */
const TRASH_TIMEOUT_MS = 10000
/** DuckDuckGo Instant Answer API — 키 불필요(R7), 요약형 검색 */
const SEARCH_API_URL = 'https://api.duckduckgo.com/'
const SEARCH_MAX_RESULTS = 5

/** caution 등급이라도 임의 시스템 셸·스크립트 호스트 실행은 차단 (검토 반영) */
const FORBIDDEN_EXECUTABLE_NAMES: readonly string[] = [
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'wscript.exe',
  'cscript.exe',
  'mshta.exe',
  'regedit.exe',
  'rundll32.exe',
]


async function searchWeb(input: Record<string, unknown>): Promise<ToolOperationResult> {
  const query = requireStringField(input, 'query')
  if (query === null) {
    return failure('검색어(query)가 비어 있습니다.')
  }
  const url = `${SEARCH_API_URL}?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
  const response = await net.fetch(url)
  if (!response.ok) {
    return failure(`검색 요청 실패 (HTTP ${response.status})`)
  }
  const body = (await response.json()) as {
    AbstractText?: string
    AbstractURL?: string
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>
  }

  const lines: string[] = []
  if (body.AbstractText !== undefined && body.AbstractText.length > 0) {
    lines.push(`${body.AbstractText} (${body.AbstractURL ?? ''})`)
  }
  for (const topic of body.RelatedTopics ?? []) {
    if (lines.length >= SEARCH_MAX_RESULTS) {
      break
    }
    if (topic.Text !== undefined && topic.Text.length > 0) {
      lines.push(`- ${topic.Text}${topic.FirstURL !== undefined ? ` (${topic.FirstURL})` : ''}`)
    }
  }
  if (lines.length === 0) {
    return { isSuccess: true, output: `'${query}'에 대한 요약형 검색 결과가 없습니다.` }
  }
  return { isSuccess: true, output: lines.join('\n') }
}

async function readFileOperation(input: Record<string, unknown>): Promise<ToolOperationResult> {
  const filePath = requireStringField(input, 'path')
  if (filePath === null) {
    return failure('파일 경로(path)가 비어 있습니다.')
  }
  const validation = validateExistingPath(filePath)
  if (!validation.ok) {
    return failure(validation.reason)
  }
  const content = await readFile(validation.resolved, 'utf-8')
  if (content.length > READ_FILE_MAX_CHARS) {
    return {
      isSuccess: true,
      output: `${content.slice(0, READ_FILE_MAX_CHARS)}\n…(${content.length}자 중 앞 ${READ_FILE_MAX_CHARS}자만 표시)`,
    }
  }
  return { isSuccess: true, output: content }
}

async function openApp(input: Record<string, unknown>): Promise<ToolOperationResult> {
  const appPath = requireStringField(input, 'path')
  if (appPath === null) {
    return failure('실행할 경로(path)가 비어 있습니다.')
  }
  const validation = validateExistingPath(appPath)
  if (!validation.ok) {
    return failure(validation.reason)
  }
  const resolved = validation.resolved
  if (FORBIDDEN_EXECUTABLE_NAMES.includes(path.basename(resolved).toLowerCase())) {
    return failure('시스템 셸·스크립트 호스트는 실행할 수 없습니다.')
  }
  if (resolved.toLowerCase().endsWith('.exe')) {
    // shell:false — 셸 인젝션 차단. detached+unref — 앱 종료와 분리 (CLAUDE.md §5)
    const child = spawn(resolved, [], { detached: true, stdio: 'ignore', shell: false })
    child.unref()
    return { isSuccess: true, output: `실행함: ${resolved}` }
  }
  // 문서·폴더 등은 OS 기본 연결로 연다
  const openError = await shell.openPath(resolved)
  if (openError.length > 0) {
    return failure(`열기 실패: ${openError}`)
  }
  return { isSuccess: true, output: `열었음: ${resolved}` }
}

/**
 * Windows 휴지통 이동 — Electron의 shell.trashItem이 일부 환경에서
 * "Failed to perform delete operation"으로 실패하므로, 검증된 .NET
 * (Microsoft.VisualBasic.FileIO)을 PowerShell로 호출한다.
 * 경로는 명령에 섞지 않고 환경변수로 전달해 인젝션을 차단한다.
 */
function moveToRecycleBinWindows(filePath: string): Promise<void> {
  const script =
    '$ErrorActionPreference="Stop"; Add-Type -AssemblyName Microsoft.VisualBasic; ' +
    '[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(' +
    '$env:AIVISOR_TRASH_PATH, ' +
    '[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, ' +
    '[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)'

  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...process.env, AIVISOR_TRASH_PATH: filePath }, windowsHide: true, shell: false },
    )
    let stderr = ''
    const timeoutHandle = setTimeout(() => {
      child.kill()
      reject(new Error('휴지통 이동 시간 초과'))
    }, TRASH_TIMEOUT_MS)
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timeoutHandle)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timeoutHandle)
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(stderr.trim().length > 0 ? stderr.trim() : `powershell 종료 코드 ${code}`))
      }
    })
  })
}

async function moveToRecycleBin(filePath: string): Promise<void> {
  if (process.platform === 'win32') {
    await moveToRecycleBinWindows(filePath)
    return
  }
  await shell.trashItem(filePath)
}

async function deleteFile(input: Record<string, unknown>): Promise<ToolOperationResult> {
  const filePath = requireStringField(input, 'path')
  if (filePath === null) {
    return failure('삭제할 경로(path)가 비어 있습니다.')
  }
  const validation = validateExistingPath(filePath)
  if (!validation.ok) {
    return failure(validation.reason)
  }
  // 영구 삭제가 아니라 휴지통 이동 — 롤백 가능 (R4).
  const normalizedPath = validation.resolved
  try {
    await moveToRecycleBin(normalizedPath)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error('[toolHost.delete_file]: 휴지통 이동 실패:', detail)
    return failure(`휴지통으로 이동하지 못했습니다: ${detail}`)
  }
  return {
    isSuccess: true,
    output: `휴지통으로 이동함: ${normalizedPath}`,
    rollbackInfo: `휴지통에서 복원 가능 — 원래 경로: ${normalizedPath}`,
  }
}

// 기존 4종 + 카테고리 모듈(파일·웹·시스템·프로세스·상호작용)을 한 맵으로 합친다.
// 각 모듈은 자기 카테고리의 작업만 알고, 게이트·감사는 렌더러가 담당한다(R4).
const OPERATIONS: Record<ToolOperationName, ToolOperation> = {
  search_web: searchWeb,
  read_file: readFileOperation,
  open_app: openApp,
  delete_file: deleteFile,
  ...buildFileOperations(),
  ...buildWebOperations(),
  ...buildSystemOperations(),
  ...buildProcessOperations(),
  ...buildInteractionOperations(),
}

export function registerToolHost(): void {
  ipcMain.handle(
    IPC_CHANNELS.toolOperation,
    async (_event, name: string, input: Record<string, unknown>): Promise<ToolOperationResult> => {
      const operation = OPERATIONS[name as ToolOperationName]
      if (operation === undefined) {
        return failure(`알 수 없는 도구 작업: ${name}`)
      }
      try {
        return await operation(input ?? {})
      } catch (error) {
        console.error(`[toolHost.${name}]:`, error)
        const message = error instanceof Error ? error.message : '작업 수행에 실패했습니다'
        return failure(message)
      }
    },
  )
}
