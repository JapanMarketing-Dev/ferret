/**
 * ほかのブラウザから取り込んだパスワードの保管と、内蔵ブラウザのログインの欄への入力。
 *
 * - 取り込みの元は、利用者がブラウザの公式の機能で書き出した CSV だけ（src/shared/browserImport.ts の parsePasswordCsv）
 * - 同期：同じブラウザ（CSV の見出しの形で見分ける）から取り込み直すと、前にそのブラウザから取り込んだものをその CSV の中身に置き換える
 *   （ブラウザで消したものは消え、変えたものは新しくなる。別のブラウザから取り込んだものは残す）
 * - 保存は OS の鍵の仕組み（safeStorage）で暗号化した userData/browser-import/passwords.bin。
 *   暗号化できない環境・dev 起動・E2E では保存せず、その起動の間だけ持つ（文字起こしのキーと同じ。pipeline/stt/keys.ts の chooseKeyCipher）
 * - 復号は最初に要るとき（ページの照合・件数の表示）に1回だけ。以後はメモリに持つ
 * - renderer へはオリジンとユーザー名だけを返す。パスワードは、選んだ1件を main が内蔵ブラウザのページへ直接入れる
 *
 * **パスワード・ユーザー名をログ・エラーメッセージ・Sentry に出さないこと。**
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { savePrivateFile } from '../atomicFile'
import type { WebContents } from 'electron'
import { loginMatch, loginOrigin, type ImportedLogin, type PasswordCsvSource, type SavedLoginAccount } from '@shared/browserImport'
import type { KeyCipher } from '../pipeline/stt/keys'

interface StoredLogin extends ImportedLogin {
  id: string
  /** 取り込んだ元のブラウザ（同期で置き換える範囲）。0.6.5 より前に取り込んだものには無い */
  source?: PasswordCsvSource
}

const SOURCES: readonly PasswordCsvSource[] = ['chromium', 'safari', 'firefox', 'other']

/** 保存するファイルの形（暗号化する前の JSON） */
interface StoredFile {
  version: 1
  logins: StoredLogin[]
}

/** 復号した中身を確かめて読む。壊れた行は捨てる */
export function sanitizeStoredLogins(raw: unknown): StoredLogin[] {
  const list: unknown = (raw as Partial<StoredFile> | null)?.logins
  if (!Array.isArray(list)) return []
  return list.flatMap((item: unknown) => {
    const { id, origin, username, password, source } = (item ?? {}) as Record<string, unknown>
    if (typeof id !== 'string' || typeof origin !== 'string' || typeof username !== 'string' || typeof password !== 'string') return []
    if (!password || loginOrigin(origin) !== origin) return []
    return [{ id, origin, username, password, ...(SOURCES.includes(source as PasswordCsvSource) ? { source: source as PasswordCsvSource } : {}) }]
  })
}

/**
 * 取り込んだ分を足す。同じオリジン＋ユーザー名は新しいパスワードで置き換える（id はそのまま）。
 * source を渡すと同期：前にその元から取り込んだもののうち、今回の CSV に無いものを消す（removed）
 */
export function mergeLogins(existing: readonly StoredLogin[], incoming: readonly ImportedLogin[], newId: () => string = randomUUID, source?: PasswordCsvSource): { logins: StoredLogin[]; added: number; updated: number; removed: number } {
  const keyOf = (login: ImportedLogin) => `${login.origin}\n${login.username}`
  const incomingKeys = new Set(incoming.map(keyOf))
  const kept = source ? existing.filter((login) => login.source !== source || incomingKeys.has(keyOf(login))) : existing
  const removed = existing.length - kept.length
  const byKey = new Map(kept.map((login) => [keyOf(login), login]))
  let added = 0
  let updated = 0
  for (const login of incoming) {
    const key = keyOf(login)
    const prev = byKey.get(key)
    if (prev) {
      if (prev.password !== login.password) updated++
      byKey.set(key, { ...prev, password: login.password, ...(source ? { source } : {}) })
    } else {
      added++
      byKey.set(key, { id: newId(), ...login, ...(source ? { source } : {}) })
    }
  }
  return { logins: [...byKey.values()], added, updated, removed }
}

export class SavedLoginStore {
  private logins: StoredLogin[] | null = null
  /** ファイルを読めなかった（復号できない・壊れている）。上書きで消さないよう、取り込みの前に知らせる */
  private unreadable = false

  constructor(private readonly path: string, private readonly cipher: KeyCipher) {}

  /** 暗号化して保存できる環境か（触れずに分かる範囲） */
  persisted(): boolean {
    return this.cipher.likelyAvailable?.() ?? this.cipher.available()
  }

  /** 最初に要るときに1回だけ読む（復号は OS の鍵に触れる） */
  private async load(): Promise<StoredLogin[]> {
    if (this.logins) return this.logins
    let logins: StoredLogin[] = []
    if (existsSync(this.path) && this.cipher.available()) {
      try {
        logins = sanitizeStoredLogins(JSON.parse(this.cipher.decrypt(await readFile(this.path))))
      } catch {
        // 復号できない（鍵が変わった・壊れた）。中身は出さずに空として扱う（想定内）
        this.unreadable = true
      }
    }
    this.logins = logins
    return logins
  }

  private async save(logins: StoredLogin[]): Promise<void> {
    this.logins = logins
    if (!this.cipher.available()) return
    if (logins.length === 0) {
      await rm(this.path, { force: true })
      return
    }
    const data: StoredFile = { version: 1, logins }
    const encrypted = this.cipher.encrypt(JSON.stringify(data))
    // 一時ファイルに書いてから置き換える（途中で落ちても元か新しいほうが残る）
    await savePrivateFile(this.path, encrypted)
    this.unreadable = false
  }

  async count(): Promise<number> {
    return (await this.load()).length
  }

  /** 前の保存を読めなかったか（取り込むと置き換わる） */
  async wasUnreadable(): Promise<boolean> {
    await this.load()
    return this.unreadable
  }

  async importLogins(incoming: readonly ImportedLogin[], source?: PasswordCsvSource): Promise<{ added: number; updated: number; removed: number }> {
    const merged = mergeLogins(await this.load(), incoming, randomUUID, source)
    await this.save(merged.logins)
    return { added: merged.added, updated: merged.updated, removed: merged.removed }
  }

  async clear(): Promise<void> {
    this.logins = []
    this.unreadable = false
    await rm(this.path, { force: true })
  }

  /** そのページで使える資格情報（ユーザー名と id だけ）。同じオリジンのものが先、同じサイトの別のサブドメインのものは後ろにホスト名を付けて。ユーザー名の順 */
  async accountsFor(pageUrl: string): Promise<SavedLoginAccount[]> {
    if (!loginOrigin(pageUrl)) return []
    const matched = (await this.load()).flatMap((login) => {
      const match = loginMatch(login.origin, pageUrl)
      return match ? [{ id: login.id, username: login.username, ...(match === 'site' ? { site: new URL(login.origin).hostname } : {}) }] : []
    })
    return matched.sort((a, b) => Number(!!a.site) - Number(!!b.site) || a.username.localeCompare(b.username))
  }

  /** 選んだ1件。ページに使えるもの（同じオリジンか同じサイト）だけ（違えば null） */
  async loginFor(id: string, pageUrl: string): Promise<ImportedLogin | null> {
    const login = (await this.load()).find((l) => l.id === id)
    return login && loginMatch(login.origin, pageUrl) ? login : null
  }
}

/** 内蔵ブラウザのページの JS とは別の世界で動かす（ページのスクリプトが入力の処理を書き換えられないように） */
const FILL_WORLD_ID = 1207

/** ページにパスワードの欄があるか（見えていて、入力できるもの） */
export const HAS_PASSWORD_FIELD_SCRIPT = `(() => Array.from(document.querySelectorAll('input[type="password"]')).some((el) => !el.disabled && !el.readOnly && el.getClientRects().length > 0))()`

/**
 * ログインの欄へ入れるスクリプト。値は JSON で埋め込む（文字列の外に出ない）。
 * - 実行した時点のトップフレームのオリジンが expectedOrigin でなければ何もしない（main の確認のあとにページが移った場合）
 * - React などが入力を拾えるよう、要素の value ではなく HTMLInputElement の元の setter で入れ、input・change を発火する
 * - パスワードの欄が無い（ユーザー名だけの段のログイン）なら、ユーザー名の欄にだけ入れる
 * 戻り値は入れた欄の数
 */
export function buildFillScript(login: { username: string; password: string }, expectedOrigin: string): string {
  return `(() => {
  if (location.origin !== ${JSON.stringify(expectedOrigin)}) return 0
  const username = ${JSON.stringify(login.username)}
  const password = ${JSON.stringify(login.password)}
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  const visible = (el) => !el.disabled && !el.readOnly && el.getClientRects().length > 0
  const put = (el, value) => {
    el.focus()
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const textLike = 'input:not([type]), input[type="text"], input[type="email"], input[type="tel"]'
  const pass = Array.from(document.querySelectorAll('input[type="password"]')).find(visible) || null
  const scope = (pass && pass.form) || document
  const candidates = Array.from(scope.querySelectorAll(textLike)).filter(visible)
  let user = candidates.find((el) => (el.autocomplete || '').split(/\\s+/).includes('username')) || null
  if (!user && pass) user = candidates.filter((el) => el.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING).pop() || null
  if (!user && !pass) user = candidates.find((el) => el.type === 'email') || candidates[0] || null
  let filled = 0
  if (user && username) { put(user, username); filled++ }
  if (pass) { put(pass, password); filled++ }
  return filled
})()`
}

/** トップフレームの今の URL（main が持つもの。renderer からは受け取らない） */
export function topFrameUrl(contents: WebContents): string {
  try {
    return contents.mainFrame.url || contents.getURL()
  } catch {
    // 破棄の途中（想定内）
    return ''
  }
}

/** ページにパスワードの欄があるか。調べられなければ false */
export async function pageHasPasswordField(contents: WebContents): Promise<boolean> {
  try {
    return (await contents.executeJavaScriptInIsolatedWorld(FILL_WORLD_ID, [{ code: HAS_PASSWORD_FIELD_SCRIPT }])) === true
  } catch {
    // 読み込みの途中・破棄の途中（想定内）
    return false
  }
}

/**
 * 選んだ1件をトップフレームへ入れる。その時点のトップフレームのオリジンが保存したオリジンに合うことを main で確かめてから。
 * 入れた欄の数を返す（合わなければ 0）
 */
export async function fillLogin(contents: WebContents, store: SavedLoginStore, id: string): Promise<number> {
  const pageUrl = topFrameUrl(contents)
  const login = await store.loginFor(id, pageUrl)
  const origin = loginOrigin(pageUrl)
  if (!login || !origin) return 0
  const filled = await contents.executeJavaScriptInIsolatedWorld(FILL_WORLD_ID, [{ code: buildFillScript(login, origin) }])
  return typeof filled === 'number' ? filled : 0
}
