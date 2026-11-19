/**
 * Ferret アカウントの控え（userData/feedback-cloud/）。
 * - account.bin: トークンとメールアドレス。OS の鍵の仕組み（safeStorage）で暗号化する。暗号化できない環境・dev 起動では保存せず、その起動の間だけ持つ
 *   （共有リンクのトークンと同じ。pipeline/stt/keys.ts の chooseKeyCipher）
 * - device.json: この PC の id（ランダムな 32 桁の16進）。秘密ではないので平文。暗号化できない環境でも PC ごとに同じ id を使い、
 *   Worker の側で台が増え続けないようにする。ログアウトしても消さない
 * - cache.json: 最後に読んだ指摘（ほかの PC とチームの分）と、最後に送った中身の要約。ネットにつながらないときも feedback.md に載せるため。
 *   ログアウトで消す
 *
 * renderer へはトークンを渡さない。
 */
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ID_PATTERN, TOKEN_PATTERN, normalizeEmail, type CloudFeedback } from '@shared/feedbackCloud'
import { savePrivateFile } from '../atomicFile'
import type { KeyCipher } from '../pipeline/stt/keys'

export interface CloudAccount {
  token: string
  email: string
}

export interface CloudCache {
  feedback: CloudFeedback
  /** 最後に読めた日時（ISO 8601） */
  syncedAt: string
  /** 最後に送った中身の SHA-256（同じなら送り直さない） */
  uploadHash?: string
}

export class CloudStore {
  private account: CloudAccount | null | undefined
  private deviceId: string | null = null
  private cache: CloudCache | null | undefined

  constructor(private readonly dir: string, private readonly cipher: KeyCipher) {}

  private get accountFile(): string { return join(this.dir, 'account.bin') }
  private get deviceFile(): string { return join(this.dir, 'device.json') }
  private get cacheFile(): string { return join(this.dir, 'cache.json') }

  /** ログインの控え。無ければ null。ファイルが無ければ鍵の仕組みに触れない */
  async load(): Promise<CloudAccount | null> {
    if (this.account !== undefined) return this.account
    let account: CloudAccount | null = null
    if (existsSync(this.accountFile) && this.cipher.available()) {
      try {
        const raw = JSON.parse(this.cipher.decrypt(await readFile(this.accountFile))) as Record<string, unknown>
        const email = normalizeEmail(raw.email)
        if (typeof raw.token === 'string' && TOKEN_PATTERN.test(raw.token) && email) account = { token: raw.token, email }
      } catch {
        // 復号できない（鍵が変わった・壊れた）。ログインしていないとして扱う（想定内）
        account = null
      }
    }
    this.account = account
    return account
  }

  /** 読み込み済みのときだけ、ログインしているか（読み込み前は null。鍵の仕組みに触れない） */
  loadedLoggedIn(): boolean | null {
    return this.account === undefined ? null : this.account !== null
  }

  async save(account: CloudAccount): Promise<void> {
    this.account = account
    if (!this.cipher.available()) return
    await savePrivateFile(this.accountFile, this.cipher.encrypt(JSON.stringify({ version: 1, ...account })))
  }

  /** ログアウト: トークンと控えの指摘を消す。この PC の id は残す */
  async clear(): Promise<void> {
    this.account = null
    this.cache = null
    await Promise.all([rm(this.accountFile, { force: true }), rm(this.cacheFile, { force: true })])
  }

  /** この PC の id。無ければ作って残す */
  async device(): Promise<string> {
    if (this.deviceId) return this.deviceId
    try {
      const raw = JSON.parse(await readFile(this.deviceFile, 'utf8')) as { id?: unknown }
      if (typeof raw.id === 'string' && ID_PATTERN.test(raw.id)) this.deviceId = raw.id
    } catch {
      // 無い・読めない。作り直す
    }
    if (!this.deviceId) {
      this.deviceId = randomBytes(16).toString('hex')
      await savePrivateFile(this.deviceFile, JSON.stringify({ id: this.deviceId }))
    }
    return this.deviceId
  }

  async readCache(): Promise<CloudCache | null> {
    if (this.cache !== undefined) return this.cache
    let cache: CloudCache | null = null
    try {
      const raw = JSON.parse(await readFile(this.cacheFile, 'utf8')) as Partial<CloudCache>
      const f = raw.feedback
      if (f && typeof f === 'object' && Array.isArray(f.mine) && Array.isArray(f.teams) && f.me && typeof raw.syncedAt === 'string') {
        cache = { feedback: f, syncedAt: raw.syncedAt, ...(typeof raw.uploadHash === 'string' ? { uploadHash: raw.uploadHash } : {}) }
      }
    } catch {
      cache = null
    }
    this.cache = cache
    return cache
  }

  async writeCache(cache: CloudCache): Promise<void> {
    this.cache = cache
    await savePrivateFile(this.cacheFile, JSON.stringify(cache))
  }

  persisted(): boolean {
    return this.cipher.likelyAvailable?.() ?? this.cipher.available()
  }
}
