/**
 * YouTube（Ferret に組み込んだ Google の OAuth クライアント。config.ts）: ボタン1つで、既定のブラウザ ＋ PKCE（S256）＋ ループバックで接続し、
 * publish.json の中身を再開可能アップロード（videos.insert、8 MiB ごと、429 / 5xx は指数バックオフで再開）で上げ、thumbnails.set でサムネイルを付ける。
 *
 * - リフレッシュトークンは store.ts（暗号化）だけに置く。アクセストークンは起動中だけ覚える
 * - Google のテストユーザーのあいだはリフレッシュトークンが7日で切れる。切れた（invalid_grant）ら手元のトークンを捨て、接続し直しを頼む
 * - サムネイルの失敗はお知らせにする（動画は上げ直さない）
 * - トークンの値はログ・エラー・IPC の戻り値に出さない。Google の答えの文は短くして見せる
 *
 * Electron に依存させない（fetch・ブラウザを開く口・ファイルの読み方を渡す。単体テストで差し替える）。
 */
import { open as fsOpen, readFile, stat } from 'node:fs/promises'
import { UserFacingError } from '@shared/errors'
import { t } from '@shared/i18n'
import { UPLOAD_CHUNK, YT_THUMBNAIL_MAX_BYTES, nextOffsetFromRange, youtubeVideoResource, type VideoPublishAccount } from '../../shared/publish'
import type { YouTubeClient } from './config'
import { waitForLoopback, type LoopbackWaiter } from './loopback'
import { GOOGLE_REVOKE, GOOGLE_TOKEN, authUrl, challengeS256, channelTitle, newState, newVerifier, refreshRequestBody, tokenRequestBody } from './oauth'
import type { VideoPublishStore } from './store'
import type { UploadContext, UploadOutcome } from './handoff'

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

export const YOUTUBE_API = 'https://www.googleapis.com'
/** 同意画面で待つ時間 */
export const AUTH_WAIT_MS = 5 * 60_000
/** 一時的な失敗（429・5xx・通信の失敗）を続けて何回まで待って再開するか */
export const MAX_RETRIES = 5

const ERROR_DETAIL_CHARS = 200

export interface YouTubeDeps {
  fetch: Fetcher
  openExternal: (url: string) => Promise<void> | void
  store: VideoPublishStore
  client: () => YouTubeClient | null
  waitForLoopback?: typeof waitForLoopback
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/** 接続が切れた・取り消された（もう一度「接続」してもらう。手元のトークンは捨てた） */
export class YouTubeAuthError extends UserFacingError {
  constructor() {
    super(t('video.publish.errors.ytReconnect'))
  }
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const retryable = (status: number) => status === 429 || status >= 500

/** n 回目（1 から）の再試行の前に待つ時間（1, 2, 4, … 秒、32 秒まで） */
export function backoffMs(attempt: number): number {
  return Math.min(32_000, 1000 * 2 ** Math.max(0, attempt - 1))
}

async function apiError(r: Response): Promise<Error> {
  const j = (await r.json().catch(() => null)) as { error?: { message?: string; errors?: { reason?: string }[] } } | null
  const reason = j?.error?.errors?.[0]?.reason
  const message = (j?.error?.message ?? r.statusText ?? '').slice(0, ERROR_DETAIL_CHARS)
  return new Error(`YouTube ${r.status}${reason ? ` ${reason}` : ''}${message ? `: ${message}` : ''}`)
}

export interface ResumableOptions {
  fetch: Fetcher
  session: string
  size: number
  /** offset から len バイト */
  read: (offset: number, len: number) => Promise<Uint8Array>
  token: () => Promise<string>
  /** 401 のとき、次の token() で取り直させる */
  invalidateToken?: () => void
  sleep: (ms: number) => Promise<void>
  onProgress: (fraction: number) => void
  chunk?: number
  maxRetries?: number
}

/**
 * 再開可能アップロードの本体。308 は続き（Range の次から）、2xx は終わり（動画の id）。
 * 429・5xx・通信の失敗は指数バックオフで待ち、`bytes *\/size` でどこまで届いたかを聞いてから続ける。続けて maxRetries 回を超えたら止める。
 */
export async function resumableUpload(o: ResumableOptions): Promise<string> {
  const chunk = o.chunk ?? UPLOAD_CHUNK
  const max = o.maxRetries ?? MAX_RETRIES
  let offset = 0
  let attempt = 0
  const send = async (init: RequestInit): Promise<Response> => {
    try {
      return await o.fetch(o.session, init)
    } catch (e) {
      return new Response(null, { status: 599, statusText: e instanceof Error ? e.message.slice(0, ERROR_DETAIL_CHARS) : 'network error' })
    }
  }
  const finished = async (r: Response): Promise<string> => {
    const j = (await r.json().catch(() => null)) as { id?: unknown } | null
    if (typeof j?.id !== 'string' || !j.id) throw new Error('YouTube: upload finished without a video id')
    return j.id
  }
  for (;;) {
    if (offset >= o.size) {
      // 全部届いたと言われたのに終わりの答えが無い: 状態を聞いて id を受け取る
      const q = await send({ method: 'PUT', headers: { Authorization: `Bearer ${await o.token()}`, 'Content-Range': `bytes */${o.size}` } })
      if (q.ok) return finished(q)
      throw await apiError(q)
    }
    const len = Math.min(chunk, o.size - offset)
    const body = await o.read(offset, len)
    o.onProgress(o.size ? offset / o.size : 0)
    const r = await send({
      method: 'PUT',
      headers: { Authorization: `Bearer ${await o.token()}`, 'Content-Length': String(len), 'Content-Range': `bytes ${offset}-${offset + len - 1}/${o.size}` },
      body: body as unknown as RequestInit["body"]
    })
    if (r.status === 308) {
      offset = nextOffsetFromRange(r.headers.get('range'))
      attempt = 0
      continue
    }
    if (r.ok) return finished(r)
    const unauthorized = r.status === 401
    if ((!retryable(r.status) && !unauthorized) || ++attempt > max) throw await apiError(r)
    if (unauthorized) o.invalidateToken?.()
    await o.sleep(backoffMs(attempt))
    // どこまで届いたかを聞く
    const q = await send({ method: 'PUT', headers: { Authorization: `Bearer ${await o.token()}`, 'Content-Range': `bytes */${o.size}` } })
    if (q.status === 308) {
      const next = nextOffsetFromRange(q.headers.get('range'))
      // 先へ進んでいれば数え直す（進んでいないのに数え直すと、失敗が続いても止まらない）
      if (next > offset) attempt = 0
      offset = next
    } else if (q.ok) return finished(q)
    // ほかの答えなら、同じ位置からもう一度送る（次の失敗で attempt が進む）
  }
}

export class YouTubeService {
  private access: { clientId: string; token: string; expiresAt: number } | null = null
  private pending: LoopbackWaiter | null = null
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number

  constructor(private readonly deps: YouTubeDeps) {
    this.sleep = deps.sleep ?? sleepMs
    this.now = deps.now ?? Date.now
  }

  private requireClient(): YouTubeClient {
    const c = this.deps.client()
    if (!c) throw new UserFacingError(t('video.publish.errors.ytNotConfigured'))
    return c
  }

  async status(): Promise<VideoPublishAccount> {
    const c = this.deps.client()
    const stored = c ? await this.deps.store.youtube(c.clientId) : null
    return { configured: Boolean(c), connected: Boolean(stored), ...(stored?.name ? { name: stored.name } : {}) }
  }

  private async tokenCall(body: URLSearchParams): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
    let r: Response
    try {
      r = await this.deps.fetch(GOOGLE_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() })
    } catch {
      throw new UserFacingError(t('video.publish.errors.network', { target: 'YouTube' }))
    }
    const j = (await r.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown; error?: unknown; error_description?: unknown }
    if (j.error === 'invalid_grant' || j.error === 'invalid_client' || j.error === 'unauthorized_client') throw new YouTubeAuthError()
    if (!r.ok || typeof j.access_token !== 'string' || !j.access_token) {
      const detail = [typeof j.error === 'string' ? j.error : String(r.status), typeof j.error_description === 'string' ? j.error_description.slice(0, ERROR_DETAIL_CHARS) : ''].filter(Boolean).join(' ')
      throw new Error(`YouTube token: ${detail}`)
    }
    const expires = typeof j.expires_in === 'number' && j.expires_in > 0 ? j.expires_in : 3600
    return { access_token: j.access_token, expires_in: expires, ...(typeof j.refresh_token === 'string' && j.refresh_token ? { refresh_token: j.refresh_token } : {}) }
  }

  /** 既定のブラウザで同意画面を開き、ループバックへの戻りを待ち、チャンネル名を読む */
  async connect(): Promise<void> {
    const c = this.requireClient()
    this.pending?.cancel()
    const verifier = newVerifier()
    const state = newState()
    const waiter = (this.deps.waitForLoopback ?? waitForLoopback)({ port: 0, path: '/', state, timeoutMs: AUTH_WAIT_MS, label: 'YouTube' })
    this.pending = waiter
    try {
      const redirectUri = await waiter.ready
      await this.deps.openExternal(authUrl({ clientId: c.clientId, redirectUri, challenge: challengeS256(verifier), state }))
      const code = await waiter.code
      const tok = await this.tokenCall(tokenRequestBody({ ...c, code, verifier, redirectUri }))
      if (!tok.refresh_token) throw new UserFacingError(t('video.publish.errors.ytNoRefresh'))
      this.access = { clientId: c.clientId, token: tok.access_token, expiresAt: this.now() + tok.expires_in * 1000 }
      await this.deps.store.setYouTube({ clientId: c.clientId, refreshToken: tok.refresh_token })
      const name = await this.fetchChannelName().catch(() => null)
      if (name) await this.deps.store.setYouTube({ clientId: c.clientId, refreshToken: tok.refresh_token, name })
    } finally {
      if (this.pending === waiter) this.pending = null
      waiter.cancel()
    }
  }

  cancelConnect(): void {
    this.pending?.cancel()
    this.pending = null
  }

  private async fetchChannelName(): Promise<string | null> {
    const r = await this.deps.fetch(`${YOUTUBE_API}/youtube/v3/channels?part=snippet&mine=true`, { headers: { Authorization: `Bearer ${await this.token()}` } })
    if (!r.ok) return null
    return channelTitle(await r.json().catch(() => null))
  }

  /** 接続を解除する（Google 側でも取り消す。取り消しの失敗は気にしない） */
  async disconnect(): Promise<void> {
    const c = this.deps.client()
    const stored = c ? await this.deps.store.youtube(c.clientId) : null
    if (stored) await this.deps.fetch(`${GOOGLE_REVOKE}?token=${encodeURIComponent(stored.refreshToken)}`, { method: 'POST' }).catch(() => undefined)
    await this.deps.store.setYouTube(null)
    this.access = null
  }

  /** 使えるアクセストークン（切れかけならリフレッシュする）。リフレッシュトークンが失効していれば捨てて接続し直しを頼む */
  async token(): Promise<string> {
    const c = this.requireClient()
    if (this.access && this.access.clientId === c.clientId && this.access.expiresAt - 60_000 > this.now()) return this.access.token
    const stored = await this.deps.store.youtube(c.clientId)
    if (!stored) throw new UserFacingError(t('video.publish.errors.ytNotConnected'))
    try {
      const tok = await this.tokenCall(refreshRequestBody({ ...c, refreshToken: stored.refreshToken }))
      this.access = { clientId: c.clientId, token: tok.access_token, expiresAt: this.now() + tok.expires_in * 1000 }
      return tok.access_token
    } catch (err) {
      if (err instanceof YouTubeAuthError) {
        await this.deps.store.setYouTube(null)
        this.access = null
      }
      throw err
    }
  }

  /** 受け渡しのアップロード: publish.json → 再開可能アップロード → サムネイル */
  async upload(c: UploadContext): Promise<UploadOutcome> {
    const size = (await stat(c.videoPath)).size
    const warnings: string[] = []
    c.onProgress('auth')
    // 1) 再開可能アップロードを始める
    const init = await this.deps.fetch(`${YOUTUBE_API}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(size),
        'X-Upload-Content-Type': 'video/*'
      },
      body: JSON.stringify(youtubeVideoResource(c.spec))
    })
    if (!init.ok) throw await apiError(init)
    const session = init.headers.get('location')
    if (!session || !/^https:\/\//.test(session)) throw new Error('YouTube: no upload session URL')

    // 2) 分けて送る。一時的な失敗は待ってから続きを送る
    const fh = await fsOpen(c.videoPath, 'r')
    let videoId: string
    try {
      videoId = await resumableUpload({
        fetch: this.deps.fetch,
        session,
        size,
        read: async (offset, len) => {
          const buf = Buffer.alloc(len)
          await fh.read(buf, 0, len, offset)
          return buf
        },
        token: () => this.token(),
        invalidateToken: () => { this.access = null },
        sleep: this.sleep,
        onProgress: (f) => c.onProgress('upload', f)
      })
    } finally {
      await fh.close()
    }
    c.onProgress('upload', 1)

    // 3) サムネイル: 失敗はお知らせにして、動画はそのまま（上げ直さない）
    if (c.thumbnailPath) {
      c.onProgress('thumbnail')
      try {
        const img = await readFile(c.thumbnailPath)
        if (img.length > YT_THUMBNAIL_MAX_BYTES) warnings.push(t('video.publish.warn.thumbTooLarge'))
        else {
          const type = /\.png$/i.test(c.thumbnailPath) ? 'image/png' : 'image/jpeg'
          const r = await this.deps.fetch(`${YOUTUBE_API}/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': type },
            body: img as unknown as RequestInit["body"]
          })
          if (!r.ok) warnings.push(t('video.publish.warn.thumbFailed', { detail: (await apiError(r)).message }))
        }
      } catch (e) {
        warnings.push(t('video.publish.warn.thumbFailed', { detail: e instanceof Error ? e.message.slice(0, ERROR_DETAIL_CHARS) : String(e) }))
      }
    }
    c.onProgress('done', 1)
    return { url: `https://youtu.be/${videoId}`, status: c.spec.youtube.publishAt ? 'scheduled' : 'published', warnings }
  }
}
