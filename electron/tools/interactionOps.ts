/**
 * 상호작용 도구 (메인 프로세스 실행 계층, R4).
 *
 * send_notification(safe): OS 알림.
 * schedule_reminder(caution): 지연 후 알림(세션 동안만 — 앱 종료 시 사라짐).
 * open_url(caution): http/https 스킴만 + 네이티브 확인 후 외부 브라우저로 연다
 *   (LLM이 만든 URL을 그대로 열지 않는다).
 * take_screenshot(caution): 화면을 캡처해 **로컬 파일로만** 저장한다(외부 전송 0).
 */

import { app, desktopCapturer, dialog, Notification, screen, shell } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ToolOperationResult } from '../ipc/channels'
import { failure, readNumberField, requireStringField, success, type ToolOperation } from './opHelpers'

type InteractionOperationName = 'send_notification' | 'schedule_reminder' | 'open_url' | 'take_screenshot'

/** 예약 알림 지연 한도 — 1초 ~ 24시간 */
const REMINDER_MIN_SECONDS = 1
const REMINDER_MAX_SECONDS = 24 * 60 * 60
const ALLOWED_URL_SCHEMES: readonly string[] = ['http:', 'https:']

async function sendNotificationOperation(input: Record<string, unknown>): Promise<ToolOperationResult> {
  if (!Notification.isSupported()) {
    return failure('이 환경은 알림을 지원하지 않습니다.')
  }
  const title = requireStringField(input, 'title')
  if (title === null) {
    return failure('알림 제목(title)이 비어 있습니다.')
  }
  const body = typeof input.body === 'string' ? input.body : ''
  new Notification({ title, body }).show()
  return success(`알림을 띄웠습니다: ${title}`)
}

async function scheduleReminderOperation(input: Record<string, unknown>): Promise<ToolOperationResult> {
  const message = requireStringField(input, 'message')
  const delaySeconds = readNumberField(input, 'delaySeconds')
  if (message === null) {
    return failure('알림 내용(message)이 비어 있습니다.')
  }
  if (delaySeconds === null || delaySeconds < REMINDER_MIN_SECONDS || delaySeconds > REMINDER_MAX_SECONDS) {
    return failure(`지연(delaySeconds)은 ${REMINDER_MIN_SECONDS}~${REMINDER_MAX_SECONDS}초 사이여야 합니다.`)
  }
  if (!Notification.isSupported()) {
    return failure('이 환경은 알림을 지원하지 않습니다.')
  }
  // 세션 동안만 유효 — 타이머는 앱 프로세스에 묶인다(앱이 닫히면 사라짐)
  const timer = setTimeout(() => {
    new Notification({ title: '예약 알림', body: message }).show()
  }, delaySeconds * 1000)
  timer.unref?.()
  return success(`${delaySeconds}초 뒤 알림을 예약했습니다(앱이 켜져 있는 동안만 유효): "${message}"`)
}

async function openUrlOperation(input: Record<string, unknown>): Promise<ToolOperationResult> {
  const rawUrl = requireStringField(input, 'url')
  if (rawUrl === null) {
    return failure('URL이 비어 있습니다.')
  }
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return failure('올바른 URL이 아닙니다.')
  }
  // 스킴 검증 — http/https만. file:/javascript:/data: 등 위험 스킴 차단
  if (!ALLOWED_URL_SCHEMES.includes(parsed.protocol)) {
    return failure('http/https URL만 열 수 있습니다.')
  }
  // LLM이 만든 URL을 그대로 열지 않는다 — 사용자에게 전체 URL을 보이고 확인받는다
  const choice = await dialog.showMessageBox({
    type: 'question',
    buttons: ['열기', '취소'],
    defaultId: 1,
    cancelId: 1,
    message: '외부 브라우저로 이 주소를 열까요?',
    detail: parsed.toString(),
  })
  if (choice.response !== 0) {
    return failure('사용자가 URL 열기를 취소했습니다.')
  }
  await shell.openExternal(parsed.toString())
  return success(`외부 브라우저로 열었습니다: ${parsed.toString()}`)
}

async function takeScreenshotOperation(): Promise<ToolOperationResult> {
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width, height } = primaryDisplay.size
  const scaleFactor = primaryDisplay.scaleFactor
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(width * scaleFactor), height: Math.round(height * scaleFactor) },
  })
  if (sources.length === 0) {
    return failure('캡처할 화면을 찾지 못했습니다.')
  }
  const pngBuffer = sources[0].thumbnail.toPNG()
  if (pngBuffer.length === 0) {
    return failure('화면 캡처에 실패했습니다.')
  }
  // 로컬 저장만 — 외부로 전송하는 경로는 없다(R6 정신)
  const screenshotDirectory = path.join(app.getPath('userData'), 'screenshots')
  await mkdir(screenshotDirectory, { recursive: true })
  const fileName = `screenshot-${Date.now()}.png`
  const filePath = path.join(screenshotDirectory, fileName)
  await writeFile(filePath, pngBuffer)
  return success(`화면을 저장했습니다(로컬 전용): ${filePath}`)
}

export function buildInteractionOperations(): Record<InteractionOperationName, ToolOperation> {
  return {
    send_notification: sendNotificationOperation,
    schedule_reminder: scheduleReminderOperation,
    open_url: openUrlOperation,
    take_screenshot: takeScreenshotOperation,
  }
}
