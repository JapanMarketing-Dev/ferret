/**
 * TikTok（Ferret に組み込んだクライアント。Login Kit for Desktop ＋ Content Posting API。口の形は tiktokApi.ts）。
 * 既定は受信トレイ送り（video.upload）: 動画は本人の TikTok アプリの受信トレイに下書きとして届き、本人がアプリで仕上げて投稿する。
 * TikTok の審査が通ったら（config の directPost）そのまま投稿する（video.publish）。
 * クライアントが入っていない版では、画面が「TikTok を開いてアップロード」（手で上げる）を出す。
 *
 * トークンの交換は交換の Worker（シークレットはそこだけ）を通す。トークンは store.ts（暗号化）だけに置く。
 * Electron に依存させない（fetch・ブラウザを開く口を渡す。単体テストで差し替える）。
 */
import { open as fsOpen, stat } from 'node:fs/promises'
import { UserFacingError } from '@shared/errors'
import { t } from '@shared/i18n'
import type { VideoPublishAccount } from '../../shared/publish'
import type { TikTokClient } from './config'
import { waitForLoopback, type LoopbackWaiter } from './loopback'
import { newState } from './oauth'
import type { VideoPublishStore } from './store'
import type { UploadContext, UploadOutcome } from './handoff'
import {
  TIKTOK_API,
  TIKTOK_CALLBACK_PATH,
  TIKTOK_REDIRECT_PORT,
  TikTokTokenError,
  contentTypeFor,
  directInitBody,
  directPrivacy,
  exchangeUrl,
  inboxInitBody,
  interpretStatus,
  parseTikTokToken,
  tiktokAuthUrl,
  tiktokChallenge,
  tiktokChunkPlan,
  tiktokData,
  tiktokScopes,
  tiktokTokenBody,
  tiktokVerifier,
  tiktokVideoUrl,
  type TikTokTokens
} from './tiktokApi'
import { AUTH_WAIT_MS, type Fetcher } from './youtube'

/** 処理の終わりを待つ（5 秒ごとに 36 回 ≒ 3 分） */
export const STATUS_POLL_MS = 5000
export const STATUS_POLLS = 36
/** 接続し直しが要る答え */
const AUTH_CODES = new Set(['invalid_grant', 'invalid_client', 'access_token_invalid', 'refresh_token_invalid', 'scope_not_authorized'])

export interface TikTokDeps {
  fetch: Fetcher
  openExternal: (url: string) => Promise<void> | void
  store: VideoPublishStore
  client: () => TikTokClient | null
  waitForLoopback?: typeof waitForLoopback
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export class TikTokAuthError extends UserFacingError {
  constructor() {
    super(t('video.publish.errors.ttReconnect'))
  }
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class TikTokService {
  private pending: LoopbackWaiter | null = null
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number

  constructor(private readonly deps: TikTokDeps) {
    this.sleep = deps.sleep ?? sleepMs
    this.now = deps.now ?? Date.now
  }

  private requireClient(): TikTokClient {
    const c = this.deps.client()
    if (!c) throw new UserFacingError(t('video.publish.errors.ttNotConfigured'))
    return c
  }

  async status(): Promise<VideoPublishAccount> {
    const c = this.deps.client()
    const stored = c ? await this.deps.store.tiktok(c.clientKey) : null
    return {
      configured: Boolean(c),
      connected: Boolean(stored),
      ...(stored?.name ? { name: stored.name } : {}),
      ...(c ? { directPost: c.directPost } : {})
    }
  }

  /** 交換の Worker を通す（アプリはシークレットを持たない） */
  private async tokenCall(c: TikTokClient, kind: 'token' | 'refresh', body: URLSearchParams): Promise<TikTokTokens> {
    let r: Response
    try {
      r = await this.deps.fetch(exchangeUrl(c.tokenUrl, kind), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
        body: body.toString()
      })
    } catch {
      throw new UserFacingError(t('video.publish.errors.tokenServer'))
    }
    const j = await r.json().catch(() => ({ error: `http_${r.status}` }))
    try {
      return parseTikTokToken(j, this.now())
    } catch (err) {
      if (err instanceof TikTokTokenError && AUTH_CODES.has(err.code)) throw new TikTokAuthError()
      throw err
    }
  }

  /** 使えるトークン（切れかけならリフレッシュして保存する）。リフレッシュトークンも切れていれば捨てて接続し直しを頼む */
  async tokens(): Promise<TikTokTokens> {
    const c = this.requireClient()
    const stored = await this.deps.store.tiktok(c.clientKey)
    if (!stored) throw new UserFacingError(t('video.publish.errors.ttNotConnected'))
    const tk = stored.tokens
    if (tk.expiresAt - 60_000 > this.now()) return tk
    if (tk.refreshExpiresAt <= this.now()) {
      await this.deps.store.setTikTok(null)
      throw new TikTokAuthError()
    }
    try {
      const fresh = await this.tokenCall(c, 'refresh', tiktokTokenBody(c.clientKey, { refreshToken: tk.refreshToken }))
      await this.deps.store.updateTikTokTokens(c.clientKey, tk.refreshToken, fresh)
      return fresh
    } catch (err) {
      if (err instanceof TikTokAuthError) await this.deps.store.setTikTok(null)
      throw err
    }
  }

  private async api<T = Record<string, unknown>>(path: string, body: unknown, what: string, method: 'POST' | 'GET' = 'POST'): Promise<T> {
    const tk = await this.tokens()
    const r = await this.deps.fetch(`${TIKTOK_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${tk.accessToken}`, ...(method === 'POST' ? { 'Content-Type': 'application/json; charset=UTF-8' } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {})
    })
    const j = await r.json().catch(() => ({ error: { code: `http_${r.status}`, message: r.statusText } }))
    const code = (j as { error?: { code?: string } }).error?.code
    if (r.status === 401 || (code && AUTH_CODES.has(code))) {
      await this.deps.store.setTikTok(null)
      throw new TikTokAuthError()
    }
    return tiktokData<T>(j, what)
  }

  async connect(): Promise<void> {
    const c = this.requireClient()
    this.pending?.cancel()
    const verifier = tiktokVerifier()
    const state = newState()
    const waiter = (this.deps.waitForLoopback ?? waitForLoopback)({ port: TIKTOK_REDIRECT_PORT, path: TIKTOK_CALLBACK_PATH, state, timeoutMs: AUTH_WAIT_MS, label: 'TikTok' })
    this.pending = waiter
    try {
      const redirectUri = await waiter.ready
      await this.deps.openExternal(tiktokAuthUrl({ clientKey: c.clientKey, redirectUri, challenge: tiktokChallenge(verifier), state, scopes: tiktokScopes(c.directPost) }))
      const code = await waiter.code
      const tokens = await this.tokenCall(c, 'token', tiktokTokenBody(c.clientKey, { code, verifier, redirectUri }))
      await this.deps.store.setTikTok({ clientKey: c.clientKey, tokens })
      const user = await this.api<{ user?: { display_name?: unknown } }>('/v2/user/info/?fields=open_id,display_name', null, 'user info', 'GET').catch(() => null)
      const name = typeof user?.user?.display_name === 'string' ? user.user.display_name : undefined
      if (name) await this.deps.store.setTikTok({ clientKey: c.clientKey, tokens, name })
    } finally {
      if (this.pending === waiter) this.pending = null
      waiter.cancel()
    }
  }

  cancelConnect(): void {
    this.pending?.cancel()
    this.pending = null
  }

  async disconnect(): Promise<void> {
    const c = this.deps.client()
    const stored = c ? await this.deps.store.tiktok(c.clientKey) : null
    if (c && stored) {
      const b = new URLSearchParams({ client_key: c.clientKey, token: stored.tokens.accessToken })
      await this.deps.fetch(exchangeUrl(c.tokenUrl, 'revoke'), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b.toString() }).catch(() => undefined)
    }
    await this.deps.store.setTikTok(null)
  }

  /** 受け渡しのアップロード: 既定は受信トレイ送り、審査済みでスコープがあればそのまま投稿 */
  async upload(c: UploadContext): Promise<UploadOutcome> {
    const cl = this.requireClient()
    const tk = await this.tokens()
    const direct = cl.directPost && tk.scope.includes('video.publish')
    const size = (await stat(c.videoPath)).size
    const plan = tiktokChunkPlan(size)
    const warnings: string[] = []
    c.onProgress('auth')
    let username: string | undefined
    let init: { publish_id?: unknown; upload_url?: unknown }
    if (direct) {
      const info = await this.api<{ privacy_level_options?: unknown; creator_username?: unknown }>('/v2/post/publish/creator_info/query/', {}, 'creator info')
      username = typeof info.creator_username === 'string' ? info.creator_username : undefined
      const options = Array.isArray(info.privacy_level_options) ? info.privacy_level_options.filter((x): x is string => typeof x === 'string') : []
      const used = directPrivacy(c.spec.tiktok.privacy, options)
      if (used !== c.spec.tiktok.privacy) warnings.push(t('video.publish.warn.ttPrivacyLowered', { wanted: c.spec.tiktok.privacy, used }))
      init = await this.api('/v2/post/publish/video/init/', directInitBody(c.spec, plan, size, options), 'post init')
    } else {
      init = await this.api('/v2/post/publish/inbox/video/init/', inboxInitBody(plan, size), 'upload init')
    }
    if (typeof init.upload_url !== 'string' || !/^https:\/\//.test(init.upload_url) || typeof init.publish_id !== 'string' || !init.publish_id) throw new Error('TikTok: no upload URL')
    const uploadUrl = init.upload_url
    const fh = await fsOpen(c.videoPath, 'r')
    try {
      for (const [start, end] of plan.ranges) {
        c.onProgress('upload', start / size)
        const len = end - start + 1
        const buf = Buffer.alloc(len)
        await fh.read(buf, 0, len, start)
        const r = await this.deps.fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': contentTypeFor(c.videoPath), 'Content-Length': String(len), 'Content-Range': `bytes ${start}-${end}/${size}` },
          body: buf as unknown as RequestInit["body"]
        })
        if (!r.ok && r.status !== 206) throw new Error(`TikTok upload ${r.status}: ${r.statusText.slice(0, 200)}`)
      }
    } finally {
      await fh.close()
    }
    c.onProgress('processing', 1)
    // 受け取られる（受信トレイ）か投稿される（Direct Post）のを待つ。約3分で切り上げる
    for (let i = 0; i < STATUS_POLLS; i++) {
      await this.sleep(STATUS_POLL_MS)
      const s = interpretStatus(await this.api('/v2/post/publish/status/fetch/', { publish_id: init.publish_id }, 'status'), direct ? 'direct' : 'inbox')
      if (!s.done) continue
      if (!s.ok) throw new Error(`TikTok: ${s.reason ?? s.status}`)
      if (!direct) return { status: 'inbox', warnings: [...warnings, t('video.publish.warn.ttInbox')] }
      const url = tiktokVideoUrl(username, s.postId)
      return { ...(url ? { url } : {}), status: 'published', warnings }
    }
    return { status: direct ? 'published' : 'inbox', warnings: [...warnings, t('video.publish.warn.ttProcessing')] }
  }
}
