import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { claudeKeychainService } from '../accounts/identity'
import type { CredentialLocation } from './oauthRefresh'

/**
 * 使用量の取得に使うアクセストークンを読む。値はメモリの中だけで使い、返り値以外へは出さない
 * （ログ・画面・例外のメッセージに含めない）。
 *
 * Orca由来: ~/bench/orca/src/main/rate-limits/claude-oauth-credentials.ts,
 *           ~/bench/orca/src/main/rate-limits/codex-backend-auth.ts（MIT, Copyright 2026 Lovecast Inc.）
 */

type CredentialRead = { token: string; accountId?: string | null } | { token: null; reason: 'missing' | 'keychain-unavailable' }

function keychainUser(): string {
  try {
    const user = process.env.USER || process.env.USERNAME || userInfo().username
    return /^[a-zA-Z0-9._-]+$/.test(user) ? user : 'claude-code-user'
  } catch {
    // 利用者名が取れない環境は Claude Code と同じ既定値（想定内）
    return 'claude-code-user'
  }
}

/**
 * macOS の Keychain を `security` コマンド経由で読む（Orca の generic-password.ts と同じ方式）。
 * Electron から Keychain の API を直接呼ばない。Claude Code 自身も `security` で読み書きするため、
 * Claude Code が作った項目は、ふつう確認のダイアログなしで読める。
 *
 * それでも許可を求められる環境では、待たずに諦める：
 * - 入力は閉じ（stdin を使わない）、3秒で強制終了する（ダイアログの応答を待ち続けない）
 * - 一度読めなかった項目は、このセッションの間は自動では読みに行かない（手動の再読み込みでだけ試す）
 * - 中身を読む前に、項目が「あるか」だけを属性の読み取り（-w なし。許可は要らない）で確かめる
 */
const KEYCHAIN_COMMAND_TIMEOUT_MS = 3000

type SecurityExec = (args: string[]) => Promise<{ ok: true; stdout: string } | { ok: false; code: unknown }>

const execSecurity: SecurityExec = (args) =>
  new Promise((resolve) => {
    let settled = false
    const done = (result: Awaited<ReturnType<SecurityExec>>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const child = execFile('security', args, { timeout: KEYCHAIN_COMMAND_TIMEOUT_MS, killSignal: 'SIGKILL' }, (error, stdout) =>
      done(error ? { ok: false, code: (error as { code?: unknown }).code } : { ok: true, stdout: String(stdout) })
    )
    child.stdin?.end()
    // execFile の timeout が効かなかったときの保険（コールバックが来ないまま残さない）
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done({ ok: false, code: 'ETIMEDOUT' })
    }, KEYCHAIN_COMMAND_TIMEOUT_MS + 500)
  })

/** 項目が無い（44）。それ以外の失敗は「読めなかった」（拒否・タイムアウト・ロック中） */
const NOT_FOUND = 44

export function createKeychainReader(exec: SecurityExec = execSecurity) {
  /** 読めなかった項目。手動の再読み込み（retryBlocked）まで自動では読まない */
  const blocked = new Set<string>()
  return {
    async read(service: string, account: string, options: { retryBlocked?: boolean } = {}): Promise<string | null | 'unavailable'> {
      const key = `${service}\u0000${account}`
      if (blocked.has(key) && !options.retryBlocked) return 'unavailable'
      const exists = await exec(['find-generic-password', '-s', service, '-a', account])
      if (!exists.ok) return exists.code === NOT_FOUND ? null : 'unavailable'
      const result = await exec(['find-generic-password', '-s', service, '-a', account, '-w'])
      if (result.ok) {
        blocked.delete(key)
        return result.stdout.trim() || null
      }
      if (result.code === NOT_FOUND) return null
      blocked.add(key)
      return 'unavailable'
    }
  }
}

const keychain = createKeychainReader()

/** 資格情報の JSON から、アクセストークンと期限切れかどうかを取り出す（単体テストから使うため export） */
export function parseClaudeCredentials(raw: string, now: number = Date.now()): { token: string; expired: boolean } | null {
  try {
    const oauth = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } }).claudeAiOauth
    if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken) return null
    return { token: oauth.accessToken, expired: typeof oauth.expiresAt === 'number' && oauth.expiresAt < now }
  } catch {
    // 資格情報の形でない（未ログイン扱い。想定内。トークンを含むので送らない）
    return null
  }
}

/** 読んだ Claude の資格情報（取り直して書き戻すために、元の JSON と置き場所も持つ） */
export type ClaudeCredentialRead =
  | { token: string; expired: boolean; raw: string; location: CredentialLocation }
  | { token: null; reason: 'missing' | 'keychain-unavailable' }

/**
 * Claude の OAuth アクセストークン。
 * configDir を渡すと、その CLAUDE_CONFIG_DIR 用の Keychain の項目と .credentials.json を見る。
 * 省略するとシステムの既定アカウント（無印の項目と ~/.claude/.credentials.json）。
 *
 * macOS では、古い .credentials.json が残っていて、新しいトークンは Keychain にあることがある
 * （Claude Code は macOS では Keychain に書く）。ファイルのトークンが期限切れなら Keychain を見て、
 * Keychain にも無いときだけファイルの期限切れのトークンを使う。
 */
export async function readClaudeCredential(configDir?: string, options: { retryBlocked?: boolean } = {}): Promise<ClaudeCredentialRead> {
  // ファイル（Linux・Windows、または macOS でファイルに置いている場合）を先に見る。Keychain に触れずに済む
  const filePath = join(configDir ?? join(homedir(), '.claude'), '.credentials.json')
  let file: { token: string; expired: boolean; raw: string; location: CredentialLocation } | null = null
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = parseClaudeCredentials(raw)
    if (parsed) file = { ...parsed, raw, location: { kind: 'file', path: filePath } }
  } catch {
    // 無ければ Keychain を見る
  }
  if (file && !file.expired) return file
  if (process.platform !== 'darwin') return file ?? { token: null, reason: 'missing' }
  const service = claudeKeychainService(configDir)
  const account = keychainUser()
  const raw = await keychain.read(service, account, options)
  const parsed = raw && raw !== 'unavailable' ? parseClaudeCredentials(raw) : null
  if (parsed && raw && raw !== 'unavailable') return { ...parsed, raw, location: { kind: 'keychain', service, account } }
  if (file) return file
  if (raw === 'unavailable') return { token: null, reason: 'keychain-unavailable' }
  return { token: null, reason: 'missing' }
}

/** Codex の auth.json のアクセストークンと ChatGPT のアカウント id */
export async function readCodexAccessToken(codexHome: string): Promise<CredentialRead> {
  try {
    const auth = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8')) as { tokens?: { access_token?: unknown; account_id?: unknown } }
    const token = auth.tokens?.access_token
    if (typeof token === 'string' && token) {
      return { token, accountId: typeof auth.tokens?.account_id === 'string' ? auth.tokens.account_id : null }
    }
  } catch {
    // 読めなければ未ログイン
  }
  return { token: null, reason: 'missing' }
}
