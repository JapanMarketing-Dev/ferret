/**
 * YouTube・TikTok の OAuth のクライアントの値を、ビルドのときに main へ埋め込む（electron.vite.config.ts の main の define。担当: 投稿）。
 * 値はリポジトリに入れない。旧 Solocut と同じ置き場（環境変数・~/.solocut-release/）から読む。値はログにも出さない。
 *
 * 値ごとに、先に見つかったものを使う:
 *   1. 環境変数 FERRET_VIDEO_*（新しい名前）
 *   2. 環境変数 SOLOCUT_*（旧 Solocut の名前）
 *   3. 環境変数 MAIN_VITE_SOLOCUT_*（旧 Solocut の electron-vite の名前）
 *   4. 手元のリリース用のファイル（YouTube: Google のクライアント JSON、TikTok: tiktok-<環境>.env の TIKTOK_CLIENT_KEY だけ）
 * YouTube のシークレットは ID と同じところからだけ取る（2つのクライアントを混ぜない）。
 * TikTok のシークレットは読まない（交換の Worker（workers/video-oauth）だけが持つ）。
 *
 * main では src/video/app/main/publish/config.ts が `__FERRET_VIDEO_OAUTH__` として読む。
 * このファイルは electron.vite.config.ts から読まれるので、相対の import と Node の標準だけを使う。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

/** main へ埋め込む値（どれも省略できる） */
export interface VideoOAuthValues {
  youtubeClientId?: string
  youtubeClientSecret?: string
  tiktokClientKey?: string
  tiktokTokenUrl?: string
  tiktokDirectPost?: string
}

export type EnvSource = Record<string, string | undefined>

/** 環境変数の名前の接頭辞（先が優先） */
export const OAUTH_ENV_PREFIXES = ['FERRET_VIDEO_', 'SOLOCUT_', 'MAIN_VITE_SOLOCUT_'] as const

const KEYS: Record<keyof VideoOAuthValues, string> = {
  youtubeClientId: 'YOUTUBE_CLIENT_ID',
  youtubeClientSecret: 'YOUTUBE_CLIENT_SECRET',
  tiktokClientKey: 'TIKTOK_CLIENT_KEY',
  tiktokTokenUrl: 'TIKTOK_TOKEN_URL',
  tiktokDirectPost: 'TIKTOK_DIRECT_POST'
}

/** 埋め込む定数の名前（main の config.ts が declare する） */
export const OAUTH_DEFINE = '__FERRET_VIDEO_OAUTH__'

const val = (v: string | undefined | null): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** 接頭辞の順に探した最初の値。どの接頭辞で見つかったかも返す */
function pick(env: EnvSource, name: string): { value: string; tier: number } | null {
  for (let i = 0; i < OAUTH_ENV_PREFIXES.length; i++) {
    const v = val(env[`${OAUTH_ENV_PREFIXES[i]}${name}`])
    if (v) return { value: v, tier: i }
  }
  return null
}

/** 環境変数の値（FERRET_VIDEO_* → SOLOCUT_* → MAIN_VITE_SOLOCUT_*）。どれも無い値は省く */
export function oauthValuesFromEnv(env: EnvSource): VideoOAuthValues {
  const out: VideoOAuthValues = {}
  const id = pick(env, KEYS.youtubeClientId)
  if (id) {
    out.youtubeClientId = id.value
    // シークレットは ID と同じ名前の組からだけ
    const secret = val(env[`${OAUTH_ENV_PREFIXES[id.tier]}${KEYS.youtubeClientSecret}`])
    if (secret) out.youtubeClientSecret = secret
  }
  for (const k of ['tiktokClientKey', 'tiktokTokenUrl', 'tiktokDirectPost'] as const) {
    const v = pick(env, KEYS[k])
    if (v) out[k] = v.value
  }
  return out
}

/** Google のクライアント JSON（`{ installed: { client_id, client_secret } }` か `web`）→ 2つの値。読めなければ {} */
export function googleClientFromJson(text: string | null): { id?: string; secret?: string } {
  if (!text) return {}
  try {
    const j = JSON.parse(text.replace(/^﻿/, '')) as Record<string, { client_id?: unknown; client_secret?: unknown } | undefined> | null
    const c = j && typeof j === 'object' ? (j.installed ?? j.web) : undefined
    return {
      ...(typeof c?.client_id === 'string' && c.client_id.trim() ? { id: c.client_id.trim() } : {}),
      ...(typeof c?.client_secret === 'string' && c.client_secret.trim() ? { secret: c.client_secret.trim() } : {})
    }
  } catch {
    return {}
  }
}

export const TIKTOK_ENVS = ['sandbox', 'production'] as const

/** FERRET_VIDEO_TIKTOK_ENV（旧 SOLOCUT_TIKTOK_ENV。既定 sandbox）→ `tiktok-sandbox.env` / `tiktok-production.env`。ほかの値は止める */
export function tiktokEnvFileName(env: EnvSource): string {
  const raw = env.FERRET_VIDEO_TIKTOK_ENV ?? env.SOLOCUT_TIKTOK_ENV ?? ''
  const v = raw.trim().toLowerCase() || 'sandbox'
  if (!(TIKTOK_ENVS as readonly string[]).includes(v)) throw new Error(`FERRET_VIDEO_TIKTOK_ENV must be sandbox or production (got ${raw})`)
  return `tiktok-${v}.env`
}

/** dotenv の形のファイル（KEY=VALUE、引用符・export・# のコメント可）から1つの値だけ。ほかのキーは読まない */
export function dotenvValue(text: string | null, key: string): string | undefined {
  if (!text) return undefined
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw)
    if (!m || m[1] !== key) continue
    let v = m[2]!
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1)
    else v = v.replace(/\s+#.*$/, '')
    return v.trim() || undefined
  }
  return undefined
}

/** 環境変数とリリース用のファイルの中身から、埋め込む値を決める（純粋。ファイルは読まない） */
export function resolveOAuthValues(env: EnvSource, googleJson: string | null, tiktokEnvFile: string | null): VideoOAuthValues {
  const out = oauthValuesFromEnv(env)
  if (!out.youtubeClientId) {
    const g = googleClientFromJson(googleJson)
    if (g.id) {
      out.youtubeClientId = g.id
      if (g.secret) out.youtubeClientSecret = g.secret
    }
  }
  if (!out.tiktokClientKey) {
    const key = dotenvValue(tiktokEnvFile, 'TIKTOK_CLIENT_KEY')
    if (key) out.tiktokClientKey = key
  }
  return out
}

/** リリース用のファイルの場所（FERRET_VIDEO_* → SOLOCUT_* → ~/.solocut-release/） */
export function oauthFilePaths(env: EnvSource, home: string): { googleJson: string; tiktokEnv: string } {
  const dir = resolve(home, '.solocut-release')
  return {
    googleJson: val(env.FERRET_VIDEO_GOOGLE_OAUTH_JSON) ?? val(env.SOLOCUT_GOOGLE_OAUTH_JSON) ?? resolve(dir, 'google-oauth-client.json'),
    tiktokEnv: val(env.FERRET_VIDEO_TIKTOK_ENV_FILE) ?? val(env.SOLOCUT_TIKTOK_ENV_FILE) ?? resolve(dir, tiktokEnvFileName(env))
  }
}

function readIfExists(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  } catch {
    return null
  }
}

/** Vite の define（`__FERRET_VIDEO_OAUTH__` に見つかった値だけを入れたオブジェクト） */
export function videoOAuthDefines(env: EnvSource = process.env, home: string = homedir()): Record<string, string> {
  const paths = oauthFilePaths(env, home)
  // 環境変数で足りる値のファイルは読まない
  const fromEnv = oauthValuesFromEnv(env)
  const google = fromEnv.youtubeClientId ? null : readIfExists(paths.googleJson)
  const tiktok = fromEnv.tiktokClientKey ? null : readIfExists(paths.tiktokEnv)
  return { [OAUTH_DEFINE]: JSON.stringify(resolveOAuthValues(env, google, tiktok)) }
}
