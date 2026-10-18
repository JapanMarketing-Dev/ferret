/**
 * TikTok の純粋な部品（Login Kit for Desktop ＋ Content Posting API。2026-10 時点の公式ドキュメントで確認）。
 * - 認可: https://www.tiktok.com/v2/auth/authorize/ ＋ PKCE。デスクトップ版はチャレンジを verifier の SHA-256 の **16 進**で渡す（base64url ではない）。
 *   リダイレクトは開発者ポータルに登録した http://127.0.0.1:47823/tiktok/callback（localhost の分も登録済み）
 * - トークン: クライアントシークレットが要るので、交換の Worker（workers/video-oauth）を通す。アクセストークン 24 時間、リフレッシュトークン 365 日（更新で変わることがある）
 * - 受信トレイ送り（video.upload）: POST /v2/post/publish/inbox/video/init/ → upload_url へ分割して PUT。
 *   Direct Post（video.publish、審査済みのアプリ）: POST /v2/post/publish/video/init/ ＋ post_info
 * - 分割: 1つ 5 MB 以上 64 MB 以下、個数は floor(大きさ / 1つの大きさ)、余りは最後に足す（最後は 128 MB まで）、5 MB 未満は1回、最大 1000 個
 */
import { createHash, randomBytes } from 'node:crypto'
import type { PublishSpec } from '../../shared/publish'

export const TIKTOK_AUTH = 'https://www.tiktok.com/v2/auth/authorize/'
export const TIKTOK_API = 'https://open.tiktokapis.com'
export const TIKTOK_REDIRECT_HOST = '127.0.0.1'
export const TIKTOK_REDIRECT_PORT = 47823
export const TIKTOK_CALLBACK_PATH = '/tiktok/callback'
/** 開発者ポータルにこのとおり登録してある（localhost の分も） */
export const TIKTOK_REDIRECT_URI = `http://${TIKTOK_REDIRECT_HOST}:${TIKTOK_REDIRECT_PORT}${TIKTOK_CALLBACK_PATH}`

/** 交換の Worker の口: <base>/token, <base>/refresh, <base>/revoke */
export function exchangeUrl(base: string, kind: 'token' | 'refresh' | 'revoke'): string {
  return `${base.replace(/\/+$/, '')}/${kind}`
}

export function tiktokScopes(directPost: boolean): string[] {
  return ['user.info.basic', 'video.upload', ...(directPost ? ['video.publish'] : [])]
}

/** [A-Za-z0-9-._~] の 43〜128 文字 */
export function tiktokVerifier(bytes = 48): string {
  return randomBytes(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 128)
}

/** TikTok のデスクトップ版の PKCE: SHA-256 の16進 */
export function tiktokChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('hex')
}

export function tiktokAuthUrl(o: { clientKey: string; redirectUri: string; challenge: string; state: string; scopes: string[] }): string {
  const q = new URLSearchParams({
    client_key: o.clientKey,
    scope: o.scopes.join(','),
    redirect_uri: o.redirectUri,
    state: o.state,
    response_type: 'code',
    code_challenge: o.challenge,
    code_challenge_method: 'S256'
  })
  return `${TIKTOK_AUTH}?${q.toString()}`
}

/** 交換の Worker へ送る本文。client_key で Worker がサンドボックス／本番のシークレットを選んで足す（アプリはシークレットを送らない） */
export function tiktokTokenBody(clientKey: string, o: { code: string; verifier: string; redirectUri: string } | { refreshToken: string }): URLSearchParams {
  if ('refreshToken' in o) return new URLSearchParams({ client_key: clientKey, refresh_token: o.refreshToken })
  return new URLSearchParams({ client_key: clientKey, code: o.code, code_verifier: o.verifier, redirect_uri: o.redirectUri })
}

export interface TikTokTokens {
  accessToken: string
  /** ミリ秒 */
  expiresAt: number
  refreshToken: string
  refreshExpiresAt: number
  openId: string
  scope: string[]
}

/** トークンの口の答えに入る失敗の印（invalid_grant など）。接続し直しが要るものを見分ける */
export class TikTokTokenError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
  }
}

/** トークンの口の答え → トークン。失敗は TikTok の文で例外 */
export function parseTikTokToken(j: unknown, nowMs: number): TikTokTokens {
  const o = (j ?? {}) as Record<string, unknown>
  if (typeof o.access_token !== 'string' || !o.access_token || typeof o.refresh_token !== 'string' || !o.refresh_token) {
    const e = typeof o.error === 'string' ? o.error : (o.error as { code?: string } | undefined)?.code
    const d = typeof o.error_description === 'string' ? o.error_description : (o.error as { message?: string } | undefined)?.message
    throw new TikTokTokenError(`TikTok token: ${e ?? 'no access token'}${d ? ` ${d.slice(0, 200)}` : ''}`, e ?? 'no_token')
  }
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d)
  return {
    accessToken: o.access_token,
    expiresAt: nowMs + num(o.expires_in, 86_400) * 1000,
    refreshToken: o.refresh_token,
    refreshExpiresAt: nowMs + num(o.refresh_expires_in, 365 * 86_400) * 1000,
    openId: typeof o.open_id === 'string' ? o.open_id : '',
    scope: typeof o.scope === 'string' ? o.scope.split(',').map((s) => s.trim()).filter(Boolean) : []
  }
}

/** 保存したトークン（store.ts）を確かめる。形が違えば null */
export function sanitizeTikTokTokens(raw: unknown): TikTokTokens | null {
  const o = (raw ?? {}) as Partial<Record<keyof TikTokTokens, unknown>>
  if (typeof o.accessToken !== 'string' || !o.accessToken || typeof o.refreshToken !== 'string' || !o.refreshToken || typeof o.expiresAt !== 'number' || !Number.isFinite(o.expiresAt)) return null
  return {
    accessToken: o.accessToken,
    refreshToken: o.refreshToken,
    expiresAt: o.expiresAt,
    refreshExpiresAt: typeof o.refreshExpiresAt === 'number' && Number.isFinite(o.refreshExpiresAt) ? o.refreshExpiresAt : o.expiresAt,
    openId: typeof o.openId === 'string' ? o.openId : '',
    scope: Array.isArray(o.scope) ? o.scope.filter((s): s is string => typeof s === 'string') : []
  }
}

const MB = 1024 * 1024
export const TT_MIN_CHUNK = 5 * MB
export const TT_MAX_CHUNK = 64 * MB
export const TT_MAX_LAST_CHUNK = 128 * MB
export const TT_MAX_CHUNKS = 1000

export interface ChunkPlan {
  chunkSize: number
  count: number
  /** 1つずつの [始め, 終わり（含む）]。最後が余りを持つ */
  ranges: [number, number][]
}

export function tiktokChunkPlan(size: number, preferred = 10 * MB): ChunkPlan {
  if (!Number.isFinite(size) || size <= 0) throw new Error('empty video')
  if (size < TT_MIN_CHUNK) return { chunkSize: size, count: 1, ranges: [[0, size - 1]] }
  let chunk = Math.max(TT_MIN_CHUNK, Math.min(TT_MAX_CHUNK, Math.floor(preferred)))
  if (size <= TT_MAX_CHUNK) chunk = Math.min(chunk, size)
  let count = Math.floor(size / chunk)
  // 1000 個に収まるよう、1つを大きくする
  while (count > TT_MAX_CHUNKS && chunk < TT_MAX_CHUNK) {
    chunk = Math.min(TT_MAX_CHUNK, chunk * 2)
    count = Math.floor(size / chunk)
  }
  if (count > TT_MAX_CHUNKS) throw new Error('video too large for TikTok (over 1000 chunks)')
  const ranges: [number, number][] = []
  for (let i = 0; i < count; i++) ranges.push([i * chunk, i === count - 1 ? size - 1 : (i + 1) * chunk - 1])
  const last = ranges[ranges.length - 1]!
  if (last[1] - last[0] + 1 > TT_MAX_LAST_CHUNK) throw new Error('last chunk too large')
  return { chunkSize: chunk, count, ranges }
}

export function contentTypeFor(path: string): string {
  return /\.mov$/i.test(path) ? 'video/quicktime' : /\.webm$/i.test(path) ? 'video/webm' : 'video/mp4'
}

/** 受信トレイ送り（TikTok アプリの下書き。本人がアプリで仕上げて投稿する） */
export function inboxInitBody(plan: ChunkPlan, size: number): Record<string, unknown> {
  return { source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: plan.chunkSize, total_chunk_count: plan.count } }
}

/** Direct Post の公開範囲。アカウントが選べない値なら SELF_ONLY に下げる（選択肢に無ければ先頭） */
export function directPrivacy(wanted: string, options: readonly string[]): string {
  if (options.includes(wanted)) return wanted
  return options.includes('SELF_ONLY') || !options.length ? 'SELF_ONLY' : options[0]!
}

/** Direct Post の本文 */
export function directInitBody(spec: PublishSpec, plan: ChunkPlan, size: number, privacyOptions: string[]): Record<string, unknown> {
  return {
    post_info: {
      title: spec.tiktok.caption,
      privacy_level: directPrivacy(spec.tiktok.privacy, privacyOptions),
      disable_comment: !spec.tiktok.allowComment,
      disable_duet: !spec.tiktok.allowDuet,
      disable_stitch: !spec.tiktok.allowStitch,
      is_aigc: spec.tiktok.isAigc,
      brand_content_toggle: false,
      brand_organic_toggle: false
    },
    source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: plan.chunkSize, total_chunk_count: plan.count }
  }
}

/** `{ data, error: { code, message } }` → data。失敗は TikTok の文で例外 */
export function tiktokData<T = Record<string, unknown>>(j: unknown, what: string): T {
  const o = (j ?? {}) as { data?: T; error?: { code?: string; message?: string } }
  const code = o.error?.code
  if (code && code !== 'ok') throw new Error(`TikTok ${what}: ${code}${o.error?.message ? ` ${o.error.message.slice(0, 200)}` : ''}`)
  if (!o.data) throw new Error(`TikTok ${what}: no data`)
  return o.data
}

export type TikTokStatus = { done: boolean; ok: boolean; status: string; postId?: string; reason?: string }

/** status/fetch → 待ち続けるか。受信トレイ送りは SEND_TO_USER_INBOX、Direct Post は PUBLISH_COMPLETE で終わり */
export function interpretStatus(data: Record<string, unknown>, mode: 'inbox' | 'direct'): TikTokStatus {
  const status = typeof data.status === 'string' ? data.status : ''
  const ids = Array.isArray(data.publicaly_available_post_id) ? data.publicaly_available_post_id : []
  const postId = ids.length ? String(ids[0]) : undefined
  if (status === 'FAILED') return { done: true, ok: false, status, reason: typeof data.fail_reason === 'string' ? data.fail_reason : 'failed' }
  if (status === 'PUBLISH_COMPLETE') return { done: true, ok: true, status, ...(postId ? { postId } : {}) }
  if (status === 'SEND_TO_USER_INBOX' && mode === 'inbox') return { done: true, ok: true, status }
  return { done: false, ok: true, status }
}

export function tiktokVideoUrl(username: string | undefined, postId: string | undefined): string | undefined {
  if (!username || !postId || !/^[\w.]+$/.test(username) || !/^\d+$/.test(postId)) return undefined
  return `https://www.tiktok.com/@${username}/video/${postId}`
}
