/**
 * インストール型アプリの OAuth（RFC 8252）の純粋な部品: PKCE（S256・base64url）、Google の認可 URL、トークンの要求の本文。
 * TikTok の分は tiktokApi.ts（TikTok のデスクトップ版はチャレンジが16進）。
 */
import { createHash, randomBytes } from 'node:crypto'

export const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
export const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke'
/** アップロード ＋ thumbnails.set。force-ssl は channels.list mine=true（接続したチャンネルの名前）にも使う */
export const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.force-ssl']

export function base64url(b: Buffer): string {
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 43〜128 文字の非予約文字 */
export function newVerifier(bytes = 48): string {
  return base64url(randomBytes(bytes))
}

export function challengeS256(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest())
}

export function newState(): string {
  return randomBytes(16).toString('hex')
}

export function authUrl(o: { clientId: string; redirectUri: string; challenge: string; state: string; scopes?: string[] }): string {
  const q = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: 'code',
    scope: (o.scopes ?? YOUTUBE_SCOPES).join(' '),
    code_challenge: o.challenge,
    code_challenge_method: 'S256',
    state: o.state,
    access_type: 'offline',
    prompt: 'consent'
  })
  return `${GOOGLE_AUTH}?${q.toString()}`
}

export function tokenRequestBody(o: { clientId: string; clientSecret?: string; code: string; verifier: string; redirectUri: string }): URLSearchParams {
  const b = new URLSearchParams({
    client_id: o.clientId,
    code: o.code,
    code_verifier: o.verifier,
    grant_type: 'authorization_code',
    redirect_uri: o.redirectUri
  })
  if (o.clientSecret) b.set('client_secret', o.clientSecret)
  return b
}

export function refreshRequestBody(o: { clientId: string; clientSecret?: string; refreshToken: string }): URLSearchParams {
  const b = new URLSearchParams({ client_id: o.clientId, refresh_token: o.refreshToken, grant_type: 'refresh_token' })
  if (o.clientSecret) b.set('client_secret', o.clientSecret)
  return b
}

/** `channels.list?part=snippet&mine=true` の答え → チャンネル名 */
export function channelTitle(j: unknown): string | null {
  const items = (j as { items?: { snippet?: { title?: unknown } }[] } | null)?.items
  const title = Array.isArray(items) ? items[0]?.snippet?.title : undefined
  return typeof title === 'string' && title ? title : null
}
