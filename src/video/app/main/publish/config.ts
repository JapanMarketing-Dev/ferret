/**
 * Ferret に組み込む YouTube・TikTok の OAuth のクライアント。利用者は「接続」を押すだけで、クライアントを自分で作らない。
 * 値はビルドのときに埋め込んだもの（src/video/build/oauthEnv.ts → `__FERRET_VIDEO_OAUTH__`）。
 * 開発版（配布版でない）だけ、実行時の環境変数（FERRET_VIDEO_* / 旧 SOLOCUT_*）でも差し替えられる。配布版は環境変数を読まない。
 */
import { oauthValuesFromEnv, type EnvSource, type VideoOAuthValues } from '../../../build/oauthEnv'

declare const __FERRET_VIDEO_OAUTH__: VideoOAuthValues | undefined

export interface YouTubeClient {
  clientId: string
  clientSecret?: string
}

export interface TikTokClient {
  clientKey: string
  /** トークンの交換の Worker（シークレットはそこにだけある）: <tokenUrl>/token | refresh | revoke */
  tokenUrl: string
  /** TikTok の審査が通った: 受信トレイ送りではなく、そのまま投稿する（video.publish） */
  directPost: boolean
}

/** 交換の Worker の既定（旧 Solocut から動いているもの。workers/video-oauth） */
export const DEFAULT_TIKTOK_TOKEN_URL = 'https://ferretade.dev/oauth/tiktok'

export function builtOAuthValues(): VideoOAuthValues {
  try {
    return typeof __FERRET_VIDEO_OAUTH__ === 'undefined' || !__FERRET_VIDEO_OAUTH__ ? {} : { ...__FERRET_VIDEO_OAUTH__ }
  } catch {
    return {}
  }
}

/** 使う値。開発版は実行時の環境変数が先、なければ埋め込んだ値（値ごとに） */
export function oauthValues(built: VideoOAuthValues, runtimeEnv: EnvSource | null): VideoOAuthValues {
  const env = runtimeEnv ? oauthValuesFromEnv(runtimeEnv) : {}
  // YouTube の ID とシークレットは同じところから（混ぜない）
  const yt = env.youtubeClientId
    ? { youtubeClientId: env.youtubeClientId, ...(env.youtubeClientSecret ? { youtubeClientSecret: env.youtubeClientSecret } : {}) }
    : { ...(built.youtubeClientId ? { youtubeClientId: built.youtubeClientId } : {}), ...(built.youtubeClientId && built.youtubeClientSecret ? { youtubeClientSecret: built.youtubeClientSecret } : {}) }
  const tiktokClientKey = env.tiktokClientKey ?? built.tiktokClientKey
  const tiktokTokenUrl = env.tiktokTokenUrl ?? built.tiktokTokenUrl
  const tiktokDirectPost = env.tiktokDirectPost ?? built.tiktokDirectPost
  return {
    ...yt,
    ...(tiktokClientKey ? { tiktokClientKey } : {}),
    ...(tiktokTokenUrl ? { tiktokTokenUrl } : {}),
    ...(tiktokDirectPost ? { tiktokDirectPost } : {})
  }
}

const val = (v: string | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

export function youtubeClientFrom(v: VideoOAuthValues): YouTubeClient | null {
  const id = val(v.youtubeClientId)
  if (!id) return null
  const secret = val(v.youtubeClientSecret)
  return { clientId: id, ...(secret ? { clientSecret: secret } : {}) }
}

/** 交換先は https だけ（開発中の `wrangler dev` の http://127.0.0.1 / localhost は可）。それ以外は使わない（null） */
export function tiktokClientFrom(v: VideoOAuthValues, defaultTokenUrl = DEFAULT_TIKTOK_TOKEN_URL): TikTokClient | null {
  const key = val(v.tiktokClientKey)
  if (!key) return null
  const tokenUrl = val(v.tiktokTokenUrl) ?? defaultTokenUrl
  if (!/^https:\/\/[^/\s]+\//.test(tokenUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(tokenUrl)) return null
  return { clientKey: key, tokenUrl, directPost: /^(1|true|yes)$/i.test(val(v.tiktokDirectPost) ?? '') }
}

export interface OAuthClients {
  youtube: YouTubeClient | null
  tiktok: TikTokClient | null
}

/** 今使うクライアント。isPackaged なら実行時の環境変数は読まない */
export function oauthClients(isPackaged: boolean, env: EnvSource = process.env): OAuthClients {
  const v = oauthValues(builtOAuthValues(), isPackaged ? null : env)
  return { youtube: youtubeClientFrom(v), tiktok: tiktokClientFrom(v) }
}
