/**
 * X API（v2）で投稿する。利用者が自分の X の開発者ポータルで作った Native App の Client ID で、
 * OAuth 2.0 の Authorization Code + PKCE（S256）で認証し、そのトークンで投稿する（料金は利用者の開発者アカウントに付く）。
 *
 * - 認証のコールバックは端末の中のループバック（xAuthServer.ts）で受ける。トークンの交換は client_id を本文に入れる（公開クライアント）
 * - 画像・動画は /2/media/upload の initialize → append → finalize（→ 処理を待つ）で上げ、1件目の投稿に付ける
 * - 長い本文はスレッド（2件目からは直前の投稿への返信）。途中で失敗したら、そこまでの結果と理由を返す
 * - トークンの値はログ・エラー・IPC の戻り値に出さない。X が返したエラーの文は短くして利用者に見せる
 *
 * Electron に依存させない（fetch とファイルの読み方を渡す。単体テストで差し替える）。
 */
import { createHash, randomBytes } from 'node:crypto'
import { open } from 'node:fs/promises'
import { UserFacingError } from '@shared/errors'
import { X_OAUTH, type PostMediaKind } from '@shared/publish'
import { publishText } from './store'

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

export interface XTokens {
  accessToken: string
  refreshToken?: string
  /** 切れる時刻（ミリ秒） */
  expiresAt: number
}

export interface XUser {
  id: string
  username: string
}

/** 1回に送るメディアの大きさ（X の上限は 8MB、推奨は 5MB 以下） */
export const X_CHUNK_BYTES = 4 * 1024 * 1024
/** 切れる少し前に更新する */
const REFRESH_MARGIN_MS = 2 * 60 * 1000
const ERROR_DETAIL_CHARS = 200
/** 動画の処理を待つ上限 */
const PROCESSING_WAIT_MS = 10 * 60 * 1000

/** 認証が切れた・取り消された（もう一度「Xで認証」してもらう。手元のトークンは捨てる） */
export class XAuthError extends UserFacingError {
  constructor() {
    super(publishText('publish.errors.xUnauthorized'))
  }
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** PKCE の verifier と challenge（S256） */
export function makePkce(random: (n: number) => Buffer = randomBytes): { verifier: string; challenge: string; state: string } {
  const verifier = base64url(random(48))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge, state: base64url(random(24)) }
}

export function authorizeUrl(input: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: X_OAUTH.scopes.join(' '),
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: 'S256'
  })
  return `${X_OAUTH.authorizeUrl}?${params.toString()}`
}

/** X のエラーの本文から、利用者に見せる短い理由 */
async function errorDetail(res: Response): Promise<string> {
  let text = ''
  try {
    text = await res.text()
  } catch {
    // 本文が読めない（想定内）
  }
  let detail = ''
  try {
    const json = JSON.parse(text) as Record<string, unknown>
    const errors = Array.isArray(json.errors) ? json.errors as Array<Record<string, unknown>> : []
    detail = [json.detail, json.error_description, json.title, json.error, errors[0]?.message, errors[0]?.detail]
      .find((v): v is string => typeof v === 'string' && v.length > 0) ?? ''
  } catch {
    detail = text
  }
  return detail.replace(/\s+/g, ' ').trim().slice(0, ERROR_DETAIL_CHARS)
}

/** HTTP の失敗を利用者向けの理由にする */
export async function xFailure(res: Response): Promise<UserFacingError> {
  const detail = await errorDetail(res)
  if (res.status === 401) return new XAuthError()
  if (res.status === 402 || (res.status === 403 && /credit|payment|billing|enroll/i.test(detail))) {
    return new UserFacingError(publishText('publish.errors.xPayment', { detail: detail || String(res.status) }))
  }
  if (res.status === 429) return new UserFacingError(publishText('publish.errors.xRateLimited'))
  return new UserFacingError(publishText('publish.errors.xFailed', { detail: detail || `HTTP ${res.status}` }))
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const json = await res.json() as unknown
    return json && typeof json === 'object' ? json as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function parseTokens(json: Record<string, unknown>, now: number): XTokens {
  const accessToken = typeof json.access_token === 'string' ? json.access_token : ''
  if (!accessToken) throw new UserFacingError(publishText('publish.errors.xFailed', { detail: 'no access_token' }))
  const expiresIn = typeof json.expires_in === 'number' && Number.isFinite(json.expires_in) && json.expires_in > 0 ? json.expires_in : 7200
  return {
    accessToken,
    ...(typeof json.refresh_token === 'string' && json.refresh_token ? { refreshToken: json.refresh_token } : {}),
    expiresAt: now + expiresIn * 1000
  }
}

async function tokenRequest(fetcher: Fetcher, body: Record<string, string>, now: number): Promise<XTokens> {
  const res = await fetcher(X_OAUTH.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString()
  })
  // 更新のトークンが使えない（取り消された・期限切れ）ときは 400 invalid_grant が返る
  if (!res.ok && body.grant_type === 'refresh_token' && (res.status === 400 || res.status === 401)) throw new XAuthError()
  if (!res.ok) throw await xFailure(res)
  return parseTokens(await readJson(res), now)
}

export function exchangeCode(fetcher: Fetcher, input: { clientId: string; code: string; verifier: string; redirectUri: string }, now = Date.now()): Promise<XTokens> {
  return tokenRequest(fetcher, {
    grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri, code_verifier: input.verifier, client_id: input.clientId
  }, now)
}

export async function refreshTokens(fetcher: Fetcher, input: { clientId: string; refreshToken: string }, now = Date.now()): Promise<XTokens> {
  const tokens = await tokenRequest(fetcher, { grant_type: 'refresh_token', refresh_token: input.refreshToken, client_id: input.clientId }, now)
  // 新しい refresh_token が来なければ前のものを使い続ける
  return tokens.refreshToken ? tokens : { ...tokens, refreshToken: input.refreshToken }
}

/** トークンを取り消す（切断のとき。失敗しても手元のトークンは消す） */
export async function revokeToken(fetcher: Fetcher, input: { clientId: string; token: string }): Promise<void> {
  await fetcher(X_OAUTH.revokeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: input.token, client_id: input.clientId }).toString()
  }).catch(() => undefined)
}

/** 切れかけていれば更新したトークン。更新できなければ断る（もう一度認証してもらう） */
export async function freshTokens(fetcher: Fetcher, clientId: string, tokens: XTokens, now = Date.now()): Promise<{ tokens: XTokens; refreshed: boolean }> {
  if (tokens.expiresAt - REFRESH_MARGIN_MS > now) return { tokens, refreshed: false }
  if (!tokens.refreshToken) throw new XAuthError()
  return { tokens: await refreshTokens(fetcher, { clientId, refreshToken: tokens.refreshToken }, now), refreshed: true }
}

export async function fetchMe(fetcher: Fetcher, accessToken: string): Promise<XUser> {
  const res = await fetcher(`${X_OAUTH.apiBase}/users/me`, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw await xFailure(res)
  const data = (await readJson(res)).data as Record<string, unknown> | undefined
  const id = typeof data?.id === 'string' ? data.id : ''
  const username = typeof data?.username === 'string' ? data.username : ''
  if (!id || !/^[A-Za-z0-9_]{1,50}$/.test(username)) throw new UserFacingError(publishText('publish.errors.xFailed', { detail: 'users/me' }))
  return { id, username }
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4', webm: 'video/webm'
}

export function mimeOf(path: string): string {
  return MIME[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream'
}

export function mediaCategory(path: string, kind: PostMediaKind): 'tweet_image' | 'tweet_gif' | 'tweet_video' {
  if (kind === 'video') return 'tweet_video'
  return path.toLowerCase().endsWith('.gif') ? 'tweet_gif' : 'tweet_image'
}

/** ファイルの一部を読む */
export type ChunkReader = (path: string, offset: number, length: number) => Promise<Buffer>

export const readChunk: ChunkReader = async (path, offset, length) => {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, offset)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** multipart/form-data の本文（ファイルの部分は1つ） */
export function multipartBody(fields: Record<string, string>, file: { name: string; filename: string; type: string; data: Buffer }, boundary: string): Buffer {
  const parts: Buffer[] = []
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  const filename = file.filename.replace(/["\r\n\\]/g, '_')
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${filename}"\r\nContent-Type: ${file.type}\r\n\r\n`))
  parts.push(file.data)
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))
  return Buffer.concat(parts)
}

export interface XMediaInput {
  path: string
  kind: PostMediaKind
  bytes: number
  name: string
}

export interface XClientDeps {
  fetcher: Fetcher
  accessToken: string
  readChunk?: ChunkReader
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export class XClient {
  private readonly read: ChunkReader
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number

  constructor(private readonly deps: XClientDeps) {
    this.read = deps.readChunk ?? readChunk
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.now = deps.now ?? Date.now
  }

  private auth(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.deps.accessToken}`, ...extra }
  }

  private async call(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    const res = await this.deps.fetcher(url, init)
    if (!res.ok) throw await xFailure(res)
    return readJson(res)
  }

  /** メディアを上げて media の id を返す */
  async uploadMedia(media: XMediaInput): Promise<string> {
    const init = await this.call(`${X_OAUTH.apiBase}/media/upload/initialize`, {
      method: 'POST',
      headers: this.auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ media_type: mimeOf(media.path), total_bytes: media.bytes, media_category: mediaCategory(media.path, media.kind) })
    })
    const id = (init.data as Record<string, unknown> | undefined)?.id
    if (typeof id !== 'string' || !/^\d{1,30}$/.test(id)) throw new UserFacingError(publishText('publish.errors.xFailed', { detail: 'media initialize' }))

    const segments = Math.max(1, Math.ceil(media.bytes / X_CHUNK_BYTES))
    for (let index = 0; index < segments; index++) {
      const data = await this.read(media.path, index * X_CHUNK_BYTES, Math.min(X_CHUNK_BYTES, media.bytes - index * X_CHUNK_BYTES))
      const boundary = `----ferret${randomBytes(12).toString('hex')}`
      const body = multipartBody({ segment_index: String(index) }, { name: 'media', filename: media.name, type: 'application/octet-stream', data }, boundary)
      await this.call(`${X_OAUTH.apiBase}/media/upload/${id}/append`, {
        method: 'POST',
        headers: this.auth({ 'Content-Type': `multipart/form-data; boundary=${boundary}` }),
        body: new Uint8Array(body)
      })
    }

    const finalized = await this.call(`${X_OAUTH.apiBase}/media/upload/${id}/finalize`, { method: 'POST', headers: this.auth() })
    let processing = (finalized.data as Record<string, unknown> | undefined)?.processing_info as Record<string, unknown> | undefined
    const deadline = this.now() + PROCESSING_WAIT_MS
    while (processing && processing.state !== 'succeeded') {
      if (processing.state === 'failed') {
        const error = processing.error as Record<string, unknown> | undefined
        throw new UserFacingError(publishText('publish.errors.xMediaFailed', { name: media.name, detail: typeof error?.message === 'string' ? error.message.slice(0, ERROR_DETAIL_CHARS) : '' }))
      }
      if (this.now() > deadline) throw new UserFacingError(publishText('publish.errors.xMediaFailed', { name: media.name, detail: 'timeout' }))
      const wait = typeof processing.check_after_secs === 'number' ? Math.min(30, Math.max(1, processing.check_after_secs)) : 2
      await this.sleep(wait * 1000)
      const status = await this.call(`${X_OAUTH.apiBase}/media/upload?command=STATUS&media_id=${id}`, { headers: this.auth() })
      processing = (status.data as Record<string, unknown> | undefined)?.processing_info as Record<string, unknown> | undefined
    }
    return id
  }

  /** 1件投稿して id を返す */
  async createPost(text: string, options: { mediaIds?: string[]; replyTo?: string } = {}): Promise<string> {
    const json = await this.call(`${X_OAUTH.apiBase}/tweets`, {
      method: 'POST',
      headers: this.auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        text,
        ...(options.mediaIds?.length ? { media: { media_ids: options.mediaIds } } : {}),
        ...(options.replyTo ? { reply: { in_reply_to_tweet_id: options.replyTo } } : {})
      })
    })
    const id = (json.data as Record<string, unknown> | undefined)?.id
    if (typeof id !== 'string' || !/^\d{1,30}$/.test(id)) throw new UserFacingError(publishText('publish.errors.xFailed', { detail: 'tweets' }))
    return id
  }
}

export interface ThreadResult {
  ids: string[]
  /** 途中で失敗したときの理由（1件目が失敗したら例外にする） */
  error?: string
}

/** メディアを上げてからスレッドを投稿する。1件目（メディアのアップロードを含む）が失敗したら例外 */
export async function postThread(client: Pick<XClient, 'uploadMedia' | 'createPost'>, parts: readonly string[], media: readonly XMediaInput[]): Promise<ThreadResult> {
  if (!parts.length) throw new UserFacingError(publishText('publish.empty'))
  const mediaIds: string[] = []
  for (const m of media) mediaIds.push(await client.uploadMedia(m))
  const ids = [await client.createPost(parts[0], { mediaIds })]
  for (const part of parts.slice(1)) {
    try {
      ids.push(await client.createPost(part, { replyTo: ids[ids.length - 1] }))
    } catch (err) {
      return { ids, error: err instanceof UserFacingError ? err.message : publishText('publish.errors.xFailed', { detail: '' }) }
    }
  }
  return { ids }
}

export function postUrl(username: string, id: string): string {
  return `https://x.com/${encodeURIComponent(username)}/status/${id}`
}
