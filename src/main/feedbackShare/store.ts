/**
 * 作った共有リンクの控え（プロジェクトごと）。持ち主のトークンは OS の鍵の仕組み（safeStorage）で暗号化して
 * userData/feedback-share/shares.bin に置く。暗号化できない環境・dev 起動・E2E では保存せず、その起動の間だけ持つ
 * （文字起こしのキー・取り込んだパスワードと同じ。pipeline/stt/keys.ts の chooseKeyCipher）。
 *
 * 設定を開き直せるよう、メモの平文とパスワードも同じく暗号化して持つ（Worker へはパスワードを送らず、メモはパスワードがあれば暗号文だけ）。
 *
 * renderer へはトークン・パスワードを渡さない（ShareSummary だけ。パスワードは main がクリップボードへ写す）。
 */
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { savePrivateFile } from '../atomicFile'
import { OWNER_TOKEN_PATTERN, SHARE_ID_PATTERN, SHARE_LIMITS, sanitizeShareUrls, type ShareSummaryInfo, type ShareUrl } from '@shared/feedbackShare'
import type { KeyCipher } from '../pipeline/stt/keys'

export interface StoredShare {
  id: string
  projectId: string
  title: string
  url: string
  createdAt: string
  expiresAt: string
  ownerToken: string
  urls: ShareUrl[]
  /** メモの平文（設定を開き直すため。Worker にはパスワードがあれば暗号文だけ） */
  memo: string
  /** パスワード（コピーするため）。無ければパスワードなし */
  password?: string
}

/** 画面へ返す形（トークンを除く） */
export type ShareSummary = ShareSummaryInfo

/** 1つのプロジェクトで覚えておく共有の数 */
export const MAX_SHARES_PER_PROJECT = 50

export function sanitizeStoredShares(raw: unknown): StoredShare[] {
  const list: unknown = (raw as { shares?: unknown } | null)?.shares
  if (!Array.isArray(list)) return []
  return list.flatMap((item: unknown) => {
    const s = (item ?? {}) as Record<string, unknown>
    const str = (v: unknown) => (typeof v === 'string' ? v : null)
    const id = str(s.id), projectId = str(s.projectId), title = str(s.title), url = str(s.url), createdAt = str(s.createdAt), expiresAt = str(s.expiresAt), ownerToken = str(s.ownerToken)
    // ページの無いもの（静止画の版の共有）は今の Worker では開けないので忘れる
    const urls = sanitizeShareUrls(s.urls)
    if (!id || !SHARE_ID_PATTERN.test(id) || !projectId || title === null || !url || !createdAt || !expiresAt || !ownerToken || !OWNER_TOKEN_PATTERN.test(ownerToken) || !urls) return []
    const memo = typeof s.memo === 'string' ? s.memo.slice(0, SHARE_LIMITS.memoChars * 2) : ''
    const password = typeof s.password === 'string' && s.password ? s.password.slice(0, SHARE_LIMITS.passwordMaxChars * 4) : undefined
    return [{ id, projectId, title, url, createdAt, expiresAt, ownerToken, urls, memo, ...(password ? { password } : {}) }]
  })
}

export class ShareStore {
  private shares: StoredShare[] | null = null

  constructor(private readonly path: string, private readonly cipher: KeyCipher, private readonly now: () => number = Date.now) {}

  private async load(): Promise<StoredShare[]> {
    if (this.shares) return this.shares
    let shares: StoredShare[] = []
    if (existsSync(this.path) && this.cipher.available()) {
      try {
        shares = sanitizeStoredShares(JSON.parse(this.cipher.decrypt(await readFile(this.path))))
      } catch {
        // 復号できない（鍵が変わった・壊れた）。空として扱う（想定内）
        shares = []
      }
    }
    // 期限の過ぎたものは忘れる（Worker の側でも消えている）
    this.shares = shares.filter((s) => Date.parse(s.expiresAt) > this.now())
    return this.shares
  }

  private async save(): Promise<void> {
    const shares = this.shares ?? []
    if (!this.cipher.available()) return
    if (shares.length === 0) {
      await rm(this.path, { force: true })
      return
    }
    await savePrivateFile(this.path, this.cipher.encrypt(JSON.stringify({ version: 2, shares })))
  }

  /** そのプロジェクトの共有（新しい順） */
  async list(projectId: string): Promise<ShareSummary[]> {
    return (await this.load())
      .filter((s) => s.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(summarize)
  }

  /** そのプロジェクトの共有のトークン。別のプロジェクトのものは返さない */
  async get(projectId: string, shareId: string): Promise<StoredShare | null> {
    return (await this.load()).find((s) => s.id === shareId && s.projectId === projectId) ?? null
  }

  async add(share: StoredShare): Promise<void> {
    const shares = await this.load()
    const mine = shares.filter((s) => s.projectId === share.projectId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    // 古いものから忘れる（Worker の側は期限で消える）
    const drop = new Set(mine.slice(0, Math.max(0, mine.length + 1 - MAX_SHARES_PER_PROJECT)).map((s) => s.id))
    this.shares = [...shares.filter((s) => !drop.has(s.id)), share]
    await this.save()
  }

  /** 設定を変えたあとの値に置き換える（同じプロジェクトのものだけ） */
  async replace(share: StoredShare): Promise<void> {
    const shares = await this.load()
    if (!shares.some((s) => s.id === share.id && s.projectId === share.projectId)) return
    this.shares = shares.map((s) => (s.id === share.id ? share : s))
    await this.save()
  }

  async remove(shareId: string): Promise<void> {
    this.shares = (await this.load()).filter((s) => s.id !== shareId)
    await this.save()
  }

  persisted(): boolean {
    return this.cipher.likelyAvailable?.() ?? this.cipher.available()
  }
}

/** 画面へ返す形（トークン・パスワード・メモの本文を除く） */
export function summarize(s: StoredShare): ShareSummary {
  return {
    id: s.id, title: s.title, url: s.url, createdAt: s.createdAt, expiresAt: s.expiresAt, urls: s.urls,
    protected: !!s.password, hasMemo: !!s.memo.trim(), hasPassword: !!s.password
  }
}
