/**
 * 共有リンクの Worker（workers/feedback-share）と話す。Electron に依存させない（単体テストで偽の fetch を渡すため）。
 * 持ち主のトークンは Authorization ヘッダーでだけ送り、URL・ログ・エラーメッセージに出さない。
 */
import { SMALL_JSON_MAX_BYTES, readJsonBody } from '../boundedResponse'
import {
  ITEM_ID_PATTERN,
  OWNER_TOKEN_PATTERN,
  SHARE_BASE,
  SHARE_ERROR_STATUS,
  SHARE_ID_PATTERN,
  SHARE_LIMITS,
  sanitizeEventsFile,
  type ShareErrorCode,
  type ShareEventsFile,
  type ShareMemo,
  type ShareRecording,
  type ShareRecordingStatus,
  type ShareSnapshot,
  type ShareUrl
} from '@shared/feedbackShare'
import type { ShareAuthVerifier } from '@shared/shareCrypto'

export type ShareFetch = (url: string, init: RequestInit) => Promise<Response>

/** Worker が返した失敗。code だけを持つ（本文・トークンは持たない） */
export class ShareApiError extends Error {
  constructor(readonly code: ShareErrorCode | 'network' | 'bad_response', readonly status = 0) {
    super(`feedback share: ${code}`)
  }
}

export interface ShareClientOptions {
  fetch: ShareFetch
  base?: string
  userAgent?: string
  timeoutMs?: number
}

export interface CreatedShare {
  id: string
  ownerToken: string
  url: string
  expiresAt: string
}

/** 作る・変えるときに送る値。memo の null は「メモなし」、auth の null は「パスワードを外す」。省いたものは変えない */
export interface SharePatch {
  title?: string
  urls?: ShareUrl[]
  memo?: ShareMemo | null
  auth?: ShareAuthVerifier | null
}

const ERROR_CODES = new Set(Object.keys(SHARE_ERROR_STATUS))

export class ShareClient {
  private readonly base: string

  constructor(private readonly opt: ShareClientOptions) {
    this.base = opt.base ?? SHARE_BASE
  }

  private headers(init: RequestInit, token?: string): Headers {
    const headers = new Headers(init.headers)
    if (token) {
      if (!OWNER_TOKEN_PATTERN.test(token)) throw new ShareApiError('unauthorized')
      headers.set('authorization', `Bearer ${token}`)
    }
    if (this.opt.userAgent) headers.set('user-agent', this.opt.userAgent)
    return headers
  }

  private async raw(path: string, init: RequestInit, token?: string, timeoutMs = this.opt.timeoutMs ?? 30_000): Promise<Response> {
    try {
      return await this.opt.fetch(`${this.base}${path}`, { ...init, headers: this.headers(init, token), signal: AbortSignal.timeout(timeoutMs) })
    } catch (err) {
      if (err instanceof ShareApiError) throw err
      throw new ShareApiError('network')
    }
  }

  private async call(path: string, init: RequestInit, token?: string): Promise<Record<string, unknown>> {
    const res = await this.raw(path, init, token)
    // 本文の途中で切れた・時間切れは回線の都合（readJsonBody。FERRET-2K と同じ）
    const read = await readJsonBody(res, SMALL_JSON_MAX_BYTES)
    if (read.failed) throw new ShareApiError(read.failed === 'network' ? 'network' : 'bad_response', res.status)
    if (!read.json || typeof read.json !== 'object' || Array.isArray(read.json)) throw new ShareApiError('bad_response', res.status)
    const body = read.json as Record<string, unknown>
    if (!res.ok || body.ok !== true) {
      const code = typeof body.code === 'string' && ERROR_CODES.has(body.code) ? body.code as ShareErrorCode : 'bad_response'
      throw new ShareApiError(code, res.status)
    }
    return body
  }

  async create(input: SharePatch & { urls: ShareUrl[]; installId?: string }): Promise<CreatedShare> {
    const body = await this.call('/v1/shares', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
    const { id, ownerToken, url, expiresAt } = body as Record<string, string>
    if (!SHARE_ID_PATTERN.test(id ?? '') || !OWNER_TOKEN_PATTERN.test(ownerToken ?? '') || typeof url !== 'string' || !url.startsWith(`${this.base}/s/`) || typeof expiresAt !== 'string') {
      throw new ShareApiError('bad_response')
    }
    return { id, ownerToken, url, expiresAt }
  }

  async update(shareId: string, token: string, patch: SharePatch): Promise<void> {
    assertShareId(shareId)
    await this.call(`/v1/shares/${shareId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }, token)
  }

  async snapshot(shareId: string, token: string): Promise<ShareSnapshot> {
    assertShareId(shareId)
    const body = await this.call(`/v1/shares/${shareId}`, { method: 'GET' }, token)
    const share = body.share as ShareSnapshot | undefined
    if (!share || !Array.isArray(share.urls) || !Array.isArray(share.recordings)) throw new ShareApiError('bad_response')
    return share
  }

  async setStatus(shareId: string, token: string, recordingId: string, status: ShareRecordingStatus): Promise<void> {
    assertShareId(shareId)
    assertItemId(recordingId)
    await this.call(`/v1/shares/${shareId}/recordings/${recordingId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) }, token)
  }

  async remove(shareId: string, token: string): Promise<void> {
    assertShareId(shareId)
    await this.call(`/v1/shares/${shareId}`, { method: 'DELETE' }, token)
  }

  /** 録画のファイルを取る（持ち主のトークンで。断ったものも取れる）。上限を超えたら too_large */
  private async file(shareId: string, token: string, recordingId: string, file: 'media' | 'events.json' | 'thumb.jpg', timeoutMs?: number): Promise<Response> {
    assertShareId(shareId)
    assertItemId(recordingId)
    const res = await this.raw(`/v1/shares/${shareId}/recordings/${recordingId}/${file}`, { method: 'GET' }, token, timeoutMs)
    if (!res.ok) {
      const read = await readJsonBody(res, SMALL_JSON_MAX_BYTES)
      const body = (read.failed ? null : read.json) as { code?: unknown } | null
      throw new ShareApiError(typeof body?.code === 'string' && ERROR_CODES.has(body.code) ? body.code as ShareErrorCode : 'bad_response', res.status)
    }
    return res
  }

  /** サムネイル（JPEG）。無い・上限を超える・画像でなければ null */
  async thumbnail(shareId: string, token: string, recording: Pick<ShareRecording, 'id' | 'hasThumbnail'>): Promise<Uint8Array | null> {
    if (!recording.hasThumbnail) return null
    try {
      const res = await this.file(shareId, token, recording.id, 'thumb.jpg')
      if (res.headers.get('content-type') !== 'image/jpeg') return null
      const bytes = await readLimited(res, SHARE_LIMITS.thumbnailBytes)
      return bytes && bytes.byteLength > 0 ? bytes : null
    } catch {
      return null
    }
  }

  /** 書き込み・文字で指摘・ページの操作の記録。無ければ null（形の合わないものも null） */
  async events(shareId: string, token: string, recording: Pick<ShareRecording, 'id' | 'durationMs'>): Promise<ShareEventsFile | null> {
    let res: Response
    try {
      res = await this.file(shareId, token, recording.id, 'events.json')
    } catch (err) {
      if (err instanceof ShareApiError && err.code === 'not_found') return null
      throw err
    }
    const bytes = await readLimited(res, SHARE_LIMITS.eventsBytes)
    if (!bytes) throw new ShareApiError('too_large')
    try {
      return sanitizeEventsFile(JSON.parse(new TextDecoder().decode(bytes)), recording.durationMs)
    } catch {
      return null
    }
  }

  /** 録画（声・映像）を少しずつ write に渡す。届いた大きさが録画の大きさ・上限を超えたら too_large */
  async media(shareId: string, token: string, recording: Pick<ShareRecording, 'id' | 'bytes'>, write: (chunk: Uint8Array) => Promise<void>): Promise<void> {
    const res = await this.file(shareId, token, recording.id, 'media', 10 * 60_000)
    const limit = Math.min(recording.bytes, SHARE_LIMITS.recordingBytes)
    const reader = res.body?.getReader()
    if (!reader) throw new ShareApiError('bad_response')
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => undefined)
        throw new ShareApiError('too_large')
      }
      await write(value)
    }
    if (total === 0) throw new ShareApiError('bad_response')
  }
}

/** 本文を上限まで読む。超えたら null */
async function readLimited(res: Response, max: number): Promise<Uint8Array | null> {
  const reader = res.body?.getReader()
  if (!reader) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.byteLength }
  return out
}

function assertShareId(id: string): void {
  if (!SHARE_ID_PATTERN.test(id)) throw new ShareApiError('not_found')
}

function assertItemId(id: string): void {
  if (!ITEM_ID_PATTERN.test(id)) throw new ShareApiError('invalid_request')
}
