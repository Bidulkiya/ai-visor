/**
 * 파일·폴더 도구 (메인 프로세스 실행 계층, R4).
 *
 * 모든 경로는 opHelpers의 가드를 거친다: 절대경로 + 심볼릭 링크 차단 +
 * 민감 위치(sensitivePaths) 차단. 게이트·승인·감사는 렌더러가 담당한다.
 */

import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { ToolOperationResult } from '../ipc/channels'
import {
  failure,
  readBooleanField,
  requireStringField,
  runPowerShell,
  success,
  validateDirectoryPath,
  validateExistingPath,
  validateWriteTargetPath,
  type ToolOperation,
} from './opHelpers'

type FileOperationName =
  | 'write_file'
  | 'move_file'
  | 'copy_file'
  | 'list_directory'
  | 'create_folder'
  | 'search_files'
  | 'get_file_info'
  | 'compress'
  | 'extract'

/** 디렉터리 목록 최대 항목 */
const LIST_MAX_ENTRIES = 500
/** 파일 검색: 훑을 최대 파일 수·결과 수·내용검색 파일 크기 상한 */
const SEARCH_MAX_FILES_SCANNED = 5000
const SEARCH_MAX_RESULTS = 100
const SEARCH_CONTENT_MAX_BYTES = 1_000_000
/** 검색 재귀 깊이 상한 — 무한·과도 탐색 방지 */
const SEARCH_MAX_DEPTH = 8
/** 압축·해제 PowerShell 타임아웃 */
const ARCHIVE_TIMEOUT_MS = 120000

async function writeFileOperation(input: Record<string, unknown>): Promise<ToolOperationResult> {
  const filePath = requireStringField(input, 'path')
  if (filePath === null) {
    return failure('파일 경로(path)가 비어 있습니다.')
  }
  const content = typeof input.content === 'string' ? input.content : ''
  const validation = validateWriteTargetPath(filePath)
  if (!validation.ok) {
    return failure(validation.reason)
  }
  const isOverwrite = existsSync(validation.resolved)
  await writeFile(validation.resolved, content, 'utf-8')
  return success(
    `${isOverwrite ? '덮어씀' : '새로 씀'}: ${validation.resolved} (${content.length}자)`,
    isOverwrite ? `주의: 기존 내용을 덮어썼습니다 — 자동 복원 불가: ${validation.resolved}` : undefined,
  )
}

async function moveFileOperation(input: Record<string, unknown>): Promise<ToolOperationResult> {
  const source = requireStringField(input, 'source')
  const destination = requireStringField(input, 'destination')
  if (source === null || destination === null) {
    return failure('원본(source)과 대상(destination) 경로가 필요합니다.')
  }
  const sourceValidation = validateExistingPath(source)
  if (!sourceValidation.ok) {
    return failure(sourceValidation.reason)
  }
  const destinationValidation = validateWriteTargetPath(destination)
  if (!destinationValidation.ok) {
    return failure(destinationValidation.reason)
  }
  if (existsSync(destinationValidation.resolved)) {
    return failure('대상 경로에 이미 파일이 있습니다(덮어쓰기 방지).')
  }
  try {
    await rename(sourceValidation.resolved, destinationValidation.resolved)
  } catch (error) {
    // 드라이브가 다르면 rename은 EXDEV로 실패 — 복사 후 원본 삭제로 폴백
    if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
      await copyFile(sourceValidation.resolved, destinationValidation.resolved)
      await unlink(sourceValidation.resolved)
    } else {
      throw error
    }
  }
  return success(
    `이동함: ${sourceValidation.resolved} → ${destinationValidation.resolved}`,
    `되돌리기: ${destinationValidation.resolved} → ${sourceValidation.resolved}`,
  )
}

async function copyFileOperation(input: Record<string, unknown>): Promise<ToolOperationResult> {
  const source = requireStringField(input, 'source')
  const destination = requireStringField(input, 'destination')
  if (source === null || destination === null) {
    return failure('원본(source)과 대상(destination) 경로가 필요합니다.')
  }
  const sourceValidation = validateExistingPath(source)
  if (!sourceValidation.ok) {
    return failure(sourceValidation.reason)
  }
  if ((await stat(sourceValidation.resolved)).isDirectory()) {
    return failure('폴더 복사는 지원하지 않습니다(파일만).')
  }
  const destinationValidation = validateWriteTargetPath(destination)
  if (!destinationValidation.ok) {
    return failure(destinationValidation.reason)
  }
  if (existsSync(destinationValidation.resolved)) {
    return failure('대상 경로에 이미 파일이 있습니다(덮어쓰기 방지).')
  }
  await copyFile(sourceValidation.resolved, destinationValidation.resolved)
  return success(
    `복사함: ${sourceValidation.resolved} → ${destinationValidation.resolved}`,
    `되돌리기: ${destinationValidation.resolved} 삭제`,
  )
}

async function listDirectoryOperation(input: Record<string, unknown>): Promise<ToolOperationResult> {
  const dirPath = requireStringField(input, 'path')
  if (dirPath === null) {
    return failure('폴더 경로(path)가 비어 있습니다.')
  }
  const validation = validateDirectoryPath(dirPath)
  if (!validation.ok) {
    return failure(validation.reason)
  }
  const entries = await readdir(validation.resolved, { withFileTypes: true })
  const lines = entries.slice(0, LIST_MAX_ENTRIES).map((entry) => {
    const kind = entry.isDirectory() ? '[폴더]' : entry.isSymbolicLink() ? '[링크]' : '[파일]'
    return `${kind} ${entry.name}`
  })
  const suffix = entries.length > LIST_MAX_ENTRIES ? `\n…(${entries.length}개 중 앞 ${LIST_MAX_ENTRIES}개)` : ''
  return success(lines.length > 0 ? lines.join('\n') + suffix : '(빈 폴더)')
}

async function createFolderOperation(input: Record<string, unknown>): Promise<ToolOperationResult> {
  const dirPath = requireStringField(input, 'path')
  if (dirPath === null) {
    return failure('폴더 경로(path)가 비어 있습니다.')
  }
  const validation = validateWriteTargetPath(dirPath)
  if (!validation.ok) {
    return failure(validation.reason)
  }
  if (existsSync(validation.resolved)) {
    return failure('이미 존재하는 경로입니다.')
  }
  // 상위 폴더는 가드에서 존재 확인됨 — 비재귀로 만들어 의도치 않은 상위 생성 방지
  await mkdir(validation.resolved)
  return success(`폴더 만듦: ${validation.resolved}`, `되돌리기: ${validation.resolved} 삭제`)
}

interface SearchMatch {
  filePath: string
  matchedName: boolean
  matchedContent: boolean
}

async function walkAndSearch(
  rootDirectory: string,
  query: string,
  searchContent: boolean,
  matches: SearchMatch[],
  scanned: { count: number },
  depth: number,
): Promise<void> {
  if (depth > SEARCH_MAX_DEPTH || matches.length >= SEARCH_MAX_RESULTS || scanned.count >= SEARCH_MAX_FILES_SCANNED) {
    return
  }
  const entries = await readdir(rootDirectory, { withFileTypes: true })
  for (const entry of entries) {
    if (matches.length >= SEARCH_MAX_RESULTS || scanned.count >= SEARCH_MAX_FILES_SCANNED) {
      return
    }
    if (entry.isSymbolicLink()) {
      continue // 심볼릭 링크는 따라가지 않는다(루프·보호경로 이탈 방지)
    }
    const entryPath = path.join(rootDirectory, entry.name)
    const guard = validateExistingPath(entryPath)
    if (!guard.ok) {
      continue // 민감 경로 등은 건너뛴다
    }
    if (entry.isDirectory()) {
      await walkAndSearch(entryPath, query, searchContent, matches, scanned, depth + 1)
      continue
    }
    scanned.count += 1
    const matchedName = entry.name.toLowerCase().includes(query)
    let matchedContent = false
    if (searchContent) {
      try {
        const fileStat = await stat(entryPath)
        if (fileStat.size <= SEARCH_CONTENT_MAX_BYTES) {
          const text = await readFile(entryPath, 'utf-8')
          matchedContent = text.toLowerCase().includes(query)
        }
      } catch {
        // 바이너리·권한 오류 등은 내용 검색 생략
      }
    }
    if (matchedName || matchedContent) {
      matches.push({ filePath: entryPath, matchedName, matchedContent })
    }
  }
}

async function searchFilesOperation(input: Record<string, unknown>): Promise<ToolOperationResult> {
  const root = requireStringField(input, 'root')
  const rawQuery = requireStringField(input, 'query')
  if (root === null || rawQuery === null) {
    return failure('검색 폴더(root)와 검색어(query)가 필요합니다.')
  }
  const validation = validateDirectoryPath(root)
  if (!validation.ok) {
    return failure(validation.reason)
  }
  const query = rawQuery.toLowerCase()
  const searchContent = readBooleanField(input, 'searchContent')
  const matches: SearchMatch[] = []
  const scanned = { count: 0 }
  await walkAndSearch(validation.resolved, query, searchContent, matches, scanned, 0)
  if (matches.length === 0) {
    return success(`'${rawQuery}'에 맞는 파일이 없습니다. (훑은 파일 ${scanned.count}개)`)
  }
  const lines = matches.map((match) => {
    const how = [match.matchedName ? '이름' : '', match.matchedContent ? '내용' : ''].filter((value) => value).join('+')
    return `${match.filePath} (${how} 일치)`
  })
  const suffix = matches.length >= SEARCH_MAX_RESULTS ? `\n…(상한 ${SEARCH_MAX_RESULTS}개 도달)` : ''
  return success(lines.join('\n') + suffix)
}

async function getFileInfoOperation(input: Record<string, unknown>): Promise<ToolOperationResult> {
  const filePath = requireStringField(input, 'path')
  if (filePath === null) {
    return failure('경로(path)가 비어 있습니다.')
  }
  const validation = validateExistingPath(filePath)
  if (!validation.ok) {
    return failure(validation.reason)
  }
  const info = await stat(validation.resolved)
  const kind = info.isDirectory() ? '폴더' : info.isFile() ? '파일' : '기타'
  const lines = [
    `경로: ${validation.resolved}`,
    `종류: ${kind}`,
    `크기: ${info.size.toLocaleString()} 바이트`,
    `수정: ${new Date(info.mtimeMs).toISOString()}`,
    `생성: ${new Date(info.birthtimeMs).toISOString()}`,
  ]
  return success(lines.join('\n'))
}

async function compressOperation(input: Record<string, unknown>): Promise<ToolOperationResult> {
  const source = requireStringField(input, 'source')
  const destination = requireStringField(input, 'destination')
  if (source === null || destination === null) {
    return failure('압축할 원본(source)과 대상 zip(destination)이 필요합니다.')
  }
  const sourceValidation = validateExistingPath(source)
  if (!sourceValidation.ok) {
    return failure(sourceValidation.reason)
  }
  if (path.extname(destination).toLowerCase() !== '.zip') {
    return failure('대상(destination)은 .zip 이어야 합니다.')
  }
  const destinationValidation = validateWriteTargetPath(destination)
  if (!destinationValidation.ok) {
    return failure(destinationValidation.reason)
  }
  // 경로는 env로만 전달(인젝션 차단). -Force로 기존 zip 덮어쓰기 허용.
  const result = await runPowerShell(
    'Compress-Archive -Path $env:AIVISOR_SRC -DestinationPath $env:AIVISOR_DEST -Force',
    { AIVISOR_SRC: sourceValidation.resolved, AIVISOR_DEST: destinationValidation.resolved },
    ARCHIVE_TIMEOUT_MS,
  )
  if (!result.ok) {
    return failure(`압축 실패: ${result.stderr || '알 수 없는 오류'}`)
  }
  return success(
    `압축함: ${sourceValidation.resolved} → ${destinationValidation.resolved}`,
    `되돌리기: ${destinationValidation.resolved} 삭제`,
  )
}

/**
 * zip-slip(경로 탈출) 차단 해제 — 각 항목의 최종 경로가 대상 폴더 밖이면 거부한다.
 * .NET ZipArchive를 직접 다뤄 항목별로 검증한다(Expand-Archive 버전 의존 회피).
 */
const EXTRACT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$dest = [System.IO.Path]::GetFullPath($env:AIVISOR_DEST)
# 경계 비교용 — 뒤에 구분자를 붙여 'C:\\dest-evil'이 'C:\\dest'로 시작하는 prefix 우회를 막는다
$destPrefix = $dest.TrimEnd('\\') + '\\'
[System.IO.Directory]::CreateDirectory($dest) | Out-Null
$zip = [System.IO.Compression.ZipFile]::OpenRead($env:AIVISOR_ZIP)
try {
  foreach ($entry in $zip.Entries) {
    $target = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($dest, $entry.FullName))
    if (-not $target.StartsWith($destPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "zip-slip 차단: $($entry.FullName)"
    }
    if ($entry.FullName.EndsWith('/')) {
      [System.IO.Directory]::CreateDirectory($target) | Out-Null
    } else {
      [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target)) | Out-Null
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
    }
  }
} finally {
  $zip.Dispose()
}
`

async function extractOperation(input: Record<string, unknown>): Promise<ToolOperationResult> {
  const source = requireStringField(input, 'source')
  const destination = requireStringField(input, 'destination')
  if (source === null || destination === null) {
    return failure('압축 파일(source)과 풀 폴더(destination)가 필요합니다.')
  }
  const sourceValidation = validateExistingPath(source)
  if (!sourceValidation.ok) {
    return failure(sourceValidation.reason)
  }
  if (path.extname(sourceValidation.resolved).toLowerCase() !== '.zip') {
    return failure('source는 .zip 파일이어야 합니다.')
  }
  // 풀 위치도 민감 경로 차단 — 새 폴더면 상위만 검증
  const destinationValidation = validateWriteTargetPath(destination)
  if (!destinationValidation.ok) {
    return failure(destinationValidation.reason)
  }
  const result = await runPowerShell(
    EXTRACT_SCRIPT,
    { AIVISOR_ZIP: sourceValidation.resolved, AIVISOR_DEST: destinationValidation.resolved },
    ARCHIVE_TIMEOUT_MS,
  )
  if (!result.ok) {
    return failure(`압축 해제 실패: ${result.stderr || '알 수 없는 오류'}`)
  }
  return success(`압축 해제함: ${sourceValidation.resolved} → ${destinationValidation.resolved}`)
}

export function buildFileOperations(): Record<FileOperationName, ToolOperation> {
  return {
    write_file: writeFileOperation,
    move_file: moveFileOperation,
    copy_file: copyFileOperation,
    list_directory: listDirectoryOperation,
    create_folder: createFolderOperation,
    search_files: searchFilesOperation,
    get_file_info: getFileInfoOperation,
    compress: compressOperation,
    extract: extractOperation,
  }
}
