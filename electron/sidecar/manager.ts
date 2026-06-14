/**
 * Python 사이드카 생명주기 + PPTX 추출 위임 (기획서 원칙 5, CLAUDE.md §5 알려진 함정)
 *
 * 원칙 5의 세 함정을 코드로 차단한다:
 *  1. detached spawn + unref → 앱이 죽어도 부모 콘솔/세션에 묶이지 않는다.
 *     앱 정상 종료 시에는 stop()으로 명시적으로 죽인다(고아 프로세스 방지).
 *  2. stdout/stderr를 전용 로그 파일로 리다이렉트 → 파이프 버퍼 가득참 행(hang) 방지.
 *  3. /health 폴링으로 소켓 바인딩을 확인한 뒤에만 요청 → 기동 경쟁 조건 방지.
 *
 * Python이 없거나 python-pptx 미설치면 크래시하지 않고 '사용 불가'로 보고한다
 * → 렌더러는 데모 덱으로 폴백한다(발표 자체는 막지 않는다).
 */

import { app } from 'electron'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { openSync, closeSync, existsSync, lstatSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { SidecarExtractResult, SidecarSlide } from '../ipc/channels'
import { isSensitivePath } from '../security/sensitivePaths'

const HOST = '127.0.0.1'
/** 기동 후 /health 가 응답할 때까지의 한도 — Python 인터프리터 콜드스타트 여유 */
const READY_TIMEOUT_MS = 15000
const READY_POLL_INTERVAL_MS = 250
/** 추출 요청 한도 — LibreOffice 렌더가 섞일 수 있어 넉넉히 */
const EXTRACT_TIMEOUT_MS = 120000
/** Python 탐지 프로브 한도 — Store 스텁이 멈춰도 빠르게 포기 */
const PROBE_TIMEOUT_MS = 5000
/** 프로즌 사이드카 실행 파일 이름(PyInstaller 산출물) */
const FROZEN_EXECUTABLE_NAME = 'ai-visor-sidecar.exe'

export interface SidecarStatus {
  isRunning: boolean
  /** 프로세스 기동 ≠ 준비됨. 소켓 바인딩 확인까지 끝나야 true */
  isReady: boolean
}

export interface SidecarManager {
  /** detached spawn + 로그 파일 리다이렉트. 이미 떠 있으면 무시 */
  start(): Promise<void>
  /** 프로세스 종료 + 로그 핸들 정리. 앱 종료 훅에서 반드시 호출 */
  stop(): Promise<void>
  // waitUntilReady·status는 사이드카 생명주기 계약의 일부다(골격에서 정의).
  // 지금 extractDeck은 내부에서 준비 상태를 다루지만, 스트리밍 사이드카(+1 STT)는
  // "준비됨"을 폴링해야 하므로 이 표면을 계약으로 유지한다.
  /** 소켓/포트 바인딩 폴링. 시간 내 준비 안 되면 false */
  waitUntilReady(timeoutMs: number): Promise<boolean>
  status(): SidecarStatus
  /** 게으른 시작 + 준비 대기 후 PPTX 추출. 어떤 실패도 결과 객체로 보고(throw 없음) */
  extractDeck(pptxPath: string): Promise<SidecarExtractResult>
}

type SidecarLaunch =
  | { kind: 'frozen'; command: string; baseArgs: readonly string[] }
  | { kind: 'python'; command: string; baseArgs: readonly string[] }
  | { kind: 'unavailable'; message: string }

/**
 * 후보 명령으로 실제 python.exe 절대경로(sys.executable)를 알아낸다.
 * - Store 스텁(출력 없음/비정상 종료)은 통과하지 못한다.
 * - `py -3` 같은 런처를 절대경로로 풀어 spawn을 직접화한다 → Node 자식이 곧
 *   python.exe 자체가 되어 kill이 정확히 적중한다(런처+서버 2프로세스 고아 방지).
 */
function resolvePythonExecutable(candidate: readonly string[]): string | null {
  try {
    const [command, ...prefixArgs] = candidate
    const output = execFileSync(command, [...prefixArgs, '-c', 'import sys; sys.stdout.write(sys.executable)'], {
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const executablePath = output.toString().trim()
    return executablePath.length > 0 && existsSync(executablePath) ? executablePath : null
  } catch {
    return null
  }
}

/** 해당 파이썬에 python-pptx 가 설치돼 있는가 */
function probePptxModule(pythonExecutable: string): boolean {
  try {
    execFileSync(pythonExecutable, ['-c', 'import pptx'], {
      timeout: PROBE_TIMEOUT_MS,
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

/** 사이드카 실행 방법을 정한다: 프로즌 exe > 워킹 파이썬 > 사용 불가 */
function resolveSidecarLaunch(): SidecarLaunch {
  // 1) 패키징된 앱: PyInstaller 프로즌 실행 파일 (Python 미설치 환경 대비)
  const frozenPath = path.join(process.resourcesPath, 'sidecar', FROZEN_EXECUTABLE_NAME)
  if (existsSync(frozenPath)) {
    return { kind: 'frozen', command: frozenPath, baseArgs: [] }
  }

  // 2) 개발 모드: 워킹 파이썬 + server.py
  const serverScript = path.join(app.getAppPath(), 'sidecar', 'server.py')
  if (!existsSync(serverScript)) {
    return { kind: 'unavailable', message: '사이드카 스크립트를 찾지 못했습니다.' }
  }
  const override = process.env.AIVISOR_PYTHON
  const candidates: ReadonlyArray<readonly string[]> = [
    ...(override !== undefined && override.length > 0 ? [[override]] : []),
    ['python'],
    ['python3'],
    ['py', '-3'],
  ]
  for (const candidate of candidates) {
    const pythonExecutable = resolvePythonExecutable(candidate)
    if (pythonExecutable === null) {
      continue
    }
    if (!probePptxModule(pythonExecutable)) {
      return {
        kind: 'unavailable',
        message:
          'Python은 있으나 python-pptx가 설치돼 있지 않습니다. `pip install -r sidecar/requirements.txt` 후 다시 시도해 주세요.',
      }
    }
    // 런처가 아니라 풀린 python.exe를 직접 실행 — 종료 시 kill이 정확히 적중한다
    return { kind: 'python', command: pythonExecutable, baseArgs: [serverScript] }
  }
  return {
    kind: 'unavailable',
    message: 'Python이 설치돼 있지 않아 PPTX를 열 수 없습니다. 데모 슬라이드로 진행하거나 Python을 설치해 주세요.',
  }
}

/** OS가 비어 있다고 보장하는 포트를 받아온다(바인드 후 즉시 닫아 번호만 취득) */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, HOST, () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close()
        reject(new Error('자유 포트를 얻지 못했습니다.'))
        return
      }
      const { port } = address
      probe.close(() => resolve(port))
    })
  })
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export function createSidecarManager(): SidecarManager {
  let child: ChildProcess | null = null
  let logFileDescriptor: number | null = null
  let port = 0
  let token = ''
  let isReady = false
  /** 동시 start 호출이 두 프로세스를 띄우지 않게 진행 중 시작을 공유한다 */
  let startInFlight: Promise<void> | null = null
  /** 시작 불가 사유 — extractDeck이 사용자에게 그대로 전달 */
  let unavailableMessage: string | null = null

  function authHeaders(): Record<string, string> {
    return { 'X-Sidecar-Token': token }
  }

  async function pollHealth(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (child === null) {
        return false
      }
      try {
        const response = await fetchWithTimeout(
          `http://${HOST}:${port}/health`,
          { headers: authHeaders() },
          READY_POLL_INTERVAL_MS * 3,
        )
        if (response.ok) {
          return true
        }
      } catch {
        // 아직 바인딩 전 — 다음 폴링까지 대기
      }
      await delay(READY_POLL_INTERVAL_MS)
    }
    return false
  }

  async function startInternal(): Promise<void> {
    const launch = resolveSidecarLaunch()
    if (launch.kind === 'unavailable') {
      unavailableMessage = launch.message
      return
    }
    unavailableMessage = null
    port = await findFreePort()
    token = randomBytes(24).toString('hex')

    // 출력은 전용 로그 파일로 — 파이프 버퍼 가득참 행 방지(원칙 5-2)
    const logPath = path.join(app.getPath('userData'), 'sidecar.log')
    logFileDescriptor = openSync(logPath, 'a')

    const args = [...launch.baseArgs, '--port', String(port), '--token', token]
    // detached + unref — 부모 세션 분리(원칙 5-1). 정상 종료 시 stop()이 명시적으로 죽인다.
    let spawned: ChildProcess
    try {
      spawned = spawn(launch.command, args, {
        detached: true,
        stdio: ['ignore', logFileDescriptor, logFileDescriptor],
        windowsHide: true,
      })
    } catch (error) {
      // spawn 자체 실패(실행 파일 문제 등) — 열어둔 로그 fd를 누수 없이 닫는다
      console.error('[sidecar.start]: 사이드카 spawn 실패:', error)
      closeSync(logFileDescriptor)
      logFileDescriptor = null
      unavailableMessage = '사이드카 프로세스를 시작하지 못했습니다.'
      return
    }
    child = spawned
    spawned.once('exit', () => {
      if (child === spawned) {
        child = null
        isReady = false
      }
    })
    spawned.unref()

    isReady = await pollHealth(READY_TIMEOUT_MS)
    if (!isReady) {
      unavailableMessage = '사이드카가 시간 내에 준비되지 않았습니다.'
      await stop()
    }
  }

  async function start(): Promise<void> {
    if (child !== null && isReady) {
      return
    }
    if (startInFlight !== null) {
      return startInFlight
    }
    startInFlight = startInternal().finally(() => {
      startInFlight = null
    })
    return startInFlight
  }

  async function stop(): Promise<void> {
    const runningChild = child
    child = null
    isReady = false
    if (runningChild !== null) {
      // 고아 프로세스 방지 — 명시적 종료. detached여도 핸들을 들고 있어 kill 가능.
      try {
        runningChild.kill()
      } catch (error) {
        console.error('[sidecar.stop]: 프로세스 종료 실패:', error)
      }
    }
    if (logFileDescriptor !== null) {
      try {
        closeSync(logFileDescriptor)
      } catch (error) {
        console.error('[sidecar.stop]: 로그 핸들 정리 실패:', error)
      }
      logFileDescriptor = null
    }
  }

  async function waitUntilReady(timeoutMs: number): Promise<boolean> {
    if (isReady) {
      return true
    }
    return pollHealth(timeoutMs)
  }

  async function extractDeck(pptxPath: string): Promise<SidecarExtractResult> {
    await start()
    if (child === null || !isReady) {
      return { status: 'unavailable', message: unavailableMessage ?? '사이드카를 시작하지 못했습니다.' }
    }
    try {
      const response = await fetchWithTimeout(
        `http://${HOST}:${port}/extract`,
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ pptxPath, render: true }),
        },
        EXTRACT_TIMEOUT_MS,
      )
      const payload = (await response.json()) as {
        error?: string
        sourceName?: string
        slides?: SidecarSlide[]
        renderStatus?: string
        renderMessage?: string | null
      }
      if (!response.ok || payload.error !== undefined) {
        return { status: 'failed', message: payload.error ?? `사이드카 오류 (HTTP ${response.status})` }
      }
      return {
        status: 'ok',
        sourceName: payload.sourceName ?? 'PPTX 발표',
        slides: payload.slides ?? [],
        // 렌더 실패(이미지 없음)는 발표를 막지 않으므로 ok에 안내 문구로만 전달
        renderNotice:
          payload.renderStatus !== undefined && payload.renderStatus !== 'ok' && payload.renderStatus !== 'skipped'
            ? payload.renderMessage ?? null
            : null,
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.error('[sidecar.extractDeck]: 추출 요청 실패:', detail)
      return { status: 'failed', message: `사이드카 추출에 실패했습니다: ${detail}` }
    }
  }

  return {
    start,
    stop,
    waitUntilReady,
    status: (): SidecarStatus => ({ isRunning: child !== null, isReady }),
    extractDeck,
  }
}

/** PPTX 경로 검증 — 절대경로 + 존재 + 심볼릭 링크 차단 + 확장자 .pptx (read-only 파싱) */
export function validatePptxPath(
  filePath: string,
): { ok: true; resolved: string } | { ok: false; reason: string } {
  if (!path.isAbsolute(filePath)) {
    return { ok: false, reason: '절대 경로만 허용됩니다.' }
  }
  const resolved = path.normalize(filePath)
  if (!existsSync(resolved)) {
    return { ok: false, reason: `파일이 없습니다: ${resolved}` }
  }
  if (lstatSync(resolved).isSymbolicLink()) {
    return { ok: false, reason: '심볼릭 링크는 허용되지 않습니다.' }
  }
  if (path.extname(resolved).toLowerCase() !== '.pptx') {
    return { ok: false, reason: '.pptx 파일만 열 수 있습니다.' }
  }
  // 도구(toolHost)와 같은 방어선 — 자격증명·시스템 경로의 파일은 열지 않는다(심층 방어)
  if (isSensitivePath(resolved)) {
    return { ok: false, reason: '보호된 시스템·자격증명 경로의 파일은 열 수 없습니다.' }
  }
  return { ok: true, resolved }
}
