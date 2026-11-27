import { SMALL_JSON_MAX_BYTES, readJsonBody } from './boundedResponse'
import {
  APP_VERSION_PATTERN,
  ARCHES,
  FEEDBACK_RELAY_URL,
  MAX_BODY_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_REQUEST_BYTES,
  MAX_TITLE_CHARS,
  OS_RELEASE_PATTERN,
  PLATFORMS,
  RELAY_TIMEOUT_MS,
  RETRYABLE_CODES,
  isErrorCode,
  type ErrorCode
} from '@shared/feedbackRelay'

/**
 * 匿名フィードバックの中継へ送る（Ferret はサーバーを持たない。中継は Cloudflare Worker で、ボットのトークンで Issue を作る）。
 *
 * Orca由来: ~/bench/orca/src/main/ipc/feedback-request.ts の postFeedback（時間の上限・AbortController・multipart の組み立て）（MIT, Copyright 2026 Lovecast Inc.）
 * 送るのは main の net.fetch から（renderer の fetch だと Origin が付き、中継が 403 で断る）。
 * Electron に依存させない（fetch は呼び出し側が渡す）。単体テストでは偽の fetch を使い、本物の中継へは送らない。
 */

export interface RelayImage {
  /** image/png か image/jpeg（中身の先頭のバイトで確かめる） */
  type: 'image/png' | 'image/jpeg'
  data: Uint8Array
}

export interface RelaySubmission {
  kind: 'bug' | 'enhancement'
  title: string
  body: string
  appVersion: string
  /** 環境情報を外したら送らない */
  platform?: string
  arch?: string
  osRelease?: string
  /** 送らない選択もできる */
  installId?: string
  images: RelayImage[]
}

/** 中継の code に、アプリの側で分かる失敗を足したもの */
type RelayFailure = ErrorCode | 'network' | 'timeout' | 'bad_response' | 'disabled'

export type RelayResult =
  | { ok: true; issue: number; url: string }
  | { ok: false; code: RelayFailure; retryable: boolean; retryAfterSec?: number }

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length

/** 中身の先頭のバイトで PNG / JPEG を確かめる（拡張子や宣言だけを信じない） */
export function sniffImageType(data: Uint8Array): 'image/png' | 'image/jpeg' | null {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  return null
}

/** 送る前に、中継と同じ上限で確かめる（送っても断られると分かっているものは送らない） */
export function checkSubmission(s: RelaySubmission): ErrorCode | null {
  const title = s.title.trim()
  if (!title || /[\r\n]/.test(title) || [...title].length > MAX_TITLE_CHARS) return 'invalid_title'
  if (!s.body.trim() || utf8Bytes(s.body) > MAX_BODY_BYTES) return 'invalid_body'
  if (!APP_VERSION_PATTERN.test(s.appVersion)) return 'invalid_meta'
  if (s.platform !== undefined && !(PLATFORMS as readonly string[]).includes(s.platform)) return 'invalid_meta'
  if (s.arch !== undefined && !(ARCHES as readonly string[]).includes(s.arch)) return 'invalid_meta'
  if (s.osRelease !== undefined && !OS_RELEASE_PATTERN.test(s.osRelease)) return 'invalid_meta'
  if (s.installId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s.installId)) return 'invalid_meta'
  if (s.images.length > MAX_IMAGES) return 'too_many_images'
  for (const image of s.images) {
    if (image.data.length > MAX_IMAGE_BYTES) return 'image_too_large'
    if (sniffImageType(image.data) !== image.type) return 'bad_image'
  }
  const total = utf8Bytes(s.title) + utf8Bytes(s.body) + s.images.reduce((n, i) => n + i.data.length, 0)
  // multipart の区切りの分を見込んで、少し手前で止める
  if (total + 4096 > MAX_REQUEST_BYTES) return 'too_large'
  return null
}

export function buildRelayForm(s: RelaySubmission): FormData {
  const form = new FormData()
  form.set('kind', s.kind)
  form.set('title', s.title.trim())
  form.set('body', s.body)
  form.set('appVersion', s.appVersion)
  if (s.platform !== undefined) form.set('platform', s.platform)
  if (s.arch !== undefined) form.set('arch', s.arch)
  if (s.osRelease !== undefined) form.set('osRelease', s.osRelease)
  if (s.installId !== undefined) form.set('installId', s.installId)
  s.images.forEach((image, i) => {
    const ext = image.type === 'image/png' ? 'png' : 'jpg'
    form.append('image', new Blob([new Uint8Array(image.data)], { type: image.type }), `screenshot-${i + 1}.${ext}`)
  })
  return form
}

const failure = (code: RelayFailure, retryAfterSec?: number): RelayResult => ({
  ok: false,
  code,
  retryable: code === 'network' || code === 'timeout' || (isErrorCode(code) && RETRYABLE_CODES.includes(code)),
  ...(retryAfterSec !== undefined ? { retryAfterSec } : {})
})

export async function sendToRelay(
  s: RelaySubmission,
  deps: { fetch: (url: string, init: RequestInit) => Promise<Response>; userAgent: string; url?: string; timeoutMs?: number }
): Promise<RelayResult> {
  const invalid = checkSubmission(s)
  if (invalid) return failure(invalid)
  const controller = new AbortController()
  // 黙ったままの中継で、送信の画面が止まり続けないように
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? RELAY_TIMEOUT_MS)
  try {
    const response = await deps.fetch(deps.url ?? FEEDBACK_RELAY_URL, {
      method: 'POST',
      body: buildRelayForm(s),
      headers: { 'User-Agent': deps.userAgent },
      signal: controller.signal
    })
    // JSON でない（中継の前のプロキシのエラーページなど）・読めないときは null
    const read = await readJsonBody(response, SMALL_JSON_MAX_BYTES)
    const json: unknown = read.failed ? null : read.json
    if (controller.signal.aborted) return failure('timeout')
    const r = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
    if (response.status === 201 && r.ok === true && typeof r.url === 'string' && /^https:\/\/github\.com\//.test(r.url)) {
      return { ok: true, issue: typeof r.issue === 'number' ? r.issue : 0, url: r.url }
    }
    if (isErrorCode(r.code)) {
      const retryAfter = Number(response.headers.get('Retry-After'))
      return failure(r.code, r.code === 'rate_limited' && Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined)
    }
    return failure(response.status >= 500 ? 'internal' : 'bad_response')
  } catch {
    return failure(controller.signal.aborted ? 'timeout' : 'network')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 中継が使えない（落ちている・つながらない）とみなして、ブラウザの issues/new へ切り替える失敗か。
 * upstream_pending（GitHub が作ったか分からない）は切り替えない。Issue ができていれば2件目になる（security-4 [12]）
 */
export function shouldFallBackToBrowser(code: RelayFailure): boolean {
  return code === 'network' || code === 'timeout' || code === 'bad_response' || code === 'disabled' ||
    code === 'internal' || code === 'upstream_failed' || code === 'not_found' || code === 'method_not_allowed' ||
    code === 'origin_not_allowed' || code === 'unsupported_media_type' || code === 'invalid_request' || code === 'unknown_field'
}
