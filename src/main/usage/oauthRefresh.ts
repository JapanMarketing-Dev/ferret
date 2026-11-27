import { execFile } from 'node:child_process'
import { SMALL_JSON_MAX_BYTES, readJsonBody } from '../boundedResponse'
import { chmod, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Claude の OAuth のアクセストークンを、保存してあるリフレッシュトークンで取り直す（使用量を出すためだけ）。
 *
 * Orca由来: ~/bench/orca/src/main/claude-accounts/oauth-refresh.ts,
 *           ~/bench/orca/src/main/rate-limits/claude-managed-account-usage.ts（MIT, Copyright 2026 Lovecast Inc.）
 *
 * 追加したアカウントは、そのアカウントで Claude Code を起動しない限りトークンが更新されず、
 * 使用量が 401（「ログインの更新待ち」）になっていた。Claude Code と同じ公開のクライアント ID とトークンの窓口で取り直し、
 * リフレッシュトークンは使い捨て（取り直すと新しいものに替わる）なので、取り直した値を元の置き場所へすぐ書き戻す
 * （書き戻さないと、Claude Code が古いリフレッシュトークンを使ってログアウトしてしまう）。
 * トークンはメモリの中だけで扱い、ログ・例外・画面へは出さない。
 */

const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
/** 期限の5分前から取り直す（Claude Code と同じ） */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000
const REFRESH_TIMEOUT_MS = 10_000
const KEYCHAIN_WRITE_TIMEOUT_MS = 5000

type OauthBlob = { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown; scopes?: unknown; [key: string]: unknown }
type Credentials = { claudeAiOauth?: OauthBlob; [key: string]: unknown }
type TokenResponse = { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown; scope?: unknown }

function oauthOf(json: string): OauthBlob | null {
  try {
    const oauth = (JSON.parse(json) as Credentials)?.claudeAiOauth
    return oauth && typeof oauth === 'object' && !Array.isArray(oauth) ? oauth : null
  } catch {
    // 資格情報の形でない（取り直せない。トークンを含むので送らない）
    return null
  }
}

export function readRefreshToken(json: string): string | null {
  const token = oauthOf(json)?.refreshToken
  return typeof token === 'string' && token.trim() ? token.trim() : null
}

/** 期限切れか、期限の5分前を過ぎた。期限が書かれていなければ取り直す */
export function isTokenExpiring(json: string, now: number = Date.now()): boolean {
  const oauth = oauthOf(json)
  if (!oauth) return false
  return typeof oauth.expiresAt !== 'number' || !Number.isFinite(oauth.expiresAt) || now + EXPIRY_BUFFER_MS >= oauth.expiresAt
}

/** 窓口の応答を資格情報に重ねる。ほかの項目はそのまま残し、新しいリフレッシュトークンが来たときだけ替える */
export function applyRefreshedToken(json: string, response: TokenResponse, now: number = Date.now()): string | null {
  let parsed: Credentials
  try {
    parsed = JSON.parse(json) as Credentials
  } catch {
    // 形が壊れていれば書き戻さない
    return null
  }
  if (typeof response.access_token !== 'string' || !response.access_token.trim()) return null
  const oauth: OauthBlob = { ...parsed.claudeAiOauth, accessToken: response.access_token }
  if (typeof response.expires_in === 'number' && Number.isFinite(response.expires_in)) oauth.expiresAt = now + response.expires_in * 1000
  if (typeof response.refresh_token === 'string' && response.refresh_token.trim()) oauth.refreshToken = response.refresh_token
  if (typeof response.scope === 'string' && response.scope.trim()) oauth.scopes = response.scope.split(' ')
  return JSON.stringify({ ...parsed, claudeAiOauth: oauth })
}

export type TokenRequest = (url: string, init: RequestInit) => Promise<Response>

/** 取り直した資格情報の JSON。失敗（ネットワーク・リフレッシュトークンが使えない）は null で、今の値のまま続ける */
export async function refreshClaudeCredentials(request: TokenRequest, json: string, now: number = Date.now()): Promise<string | null> {
  const refreshToken = readRefreshToken(json)
  if (!refreshToken) return null
  try {
    const response = await request(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: OAUTH_CLIENT_ID }).toString(),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS)
    })
    if (!response.ok) return null
    const read = await readJsonBody(response, SMALL_JSON_MAX_BYTES)
    if (read.failed) return null
    return applyRefreshedToken(json, read.json as TokenResponse, now)
  } catch {
    // 通信の失敗は「ログインの更新待ち」のまま（次の読み込みでまた試す）
    return null
  }
}

/** 資格情報の置き場所（読んだ所へそのまま書き戻す） */
export type CredentialLocation = { kind: 'file'; path: string } | { kind: 'keychain'; service: string; account: string }

/**
 * `security -i` の1行。値は16進（-X）にして、引数（ps で見える）には載せず標準入力で渡す（Claude Code と同じ書き方）。
 * service・account は Ferret が決めた値だけ（記号を含まないことを確かめてから入れる）
 */
export function keychainWriteCommand(service: string, account: string, json: string): string | null {
  if (!/^[\w .@-]+$/.test(service) || !/^[\w.@-]+$/.test(account)) return null
  return `add-generic-password -U -a "${account}" -s "${service}" -X "${Buffer.from(json, 'utf8').toString('hex')}"\n`
}

function writeKeychain(service: string, account: string, json: string): Promise<boolean> {
  const command = keychainWriteCommand(service, account, json)
  if (!command) return Promise.resolve(false)
  return new Promise((resolve) => {
    const child = execFile('security', ['-i'], { timeout: KEYCHAIN_WRITE_TIMEOUT_MS, killSignal: 'SIGKILL' }, (error) => resolve(!error))
    child.stdin?.end(command)
  })
}

/** 元の置き場所へ書き戻す。ファイルは一時ファイルから置き換える（途中で切れて壊さない）。所有者だけが読める */
export async function writeClaudeCredentials(location: CredentialLocation, json: string): Promise<boolean> {
  if (location.kind === 'keychain') return writeKeychain(location.service, location.account, json)
  const temp = join(dirname(location.path), `.credentials.json.${process.pid}.${Date.now()}.tmp`)
  try {
    await writeFile(temp, json, { encoding: 'utf8', mode: 0o600 })
    await chmod(temp, 0o600).catch(() => undefined)
    await rename(temp, location.path)
    return true
  } catch {
    // 書けなければ、取り直したトークンはこの読み込みだけで使う
    return false
  }
}
