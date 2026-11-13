/**
 * 文字起こしの API キーの保管。
 *
 * キーは settings.json に入れず、OS の鍵の仕組み（Electron の safeStorage）で暗号化した
 * 別のファイル（userData/stt-keys.bin）へ保存する。
 * - macOS: Keychain の「<アプリ名> Safe Storage」の鍵で暗号化する
 * - Windows: DPAPI（ログインユーザーに結びつく）で暗号化する
 * - Linux: libsecret / KWallet の鍵で暗号化する。鍵束が無く basic_text（固定の鍵）に
 *   落ちる環境は「暗号化できない」とみなし、保存せず起動中だけ持つ
 *
 * 暗号化できない環境では、これまでと同じく起動中だけ保持する。
 * 開発用の .env の OPENAI_API_KEY は、dev 起動（src/main/runtime.ts の IS_PACKAGED が false）のときだけ、
 * 保存したキーが無いときの OpenAI のキーとして使う。**配布版は環境変数のキーを一切読まない**
 * （開発者のキーで利用者の文字起こしを払わない。キーが無ければ端末内の whisper を案内するだけ）。
 * **キーの値はログ・エラーメッセージ・IPC の戻り値に出さないこと。**
 *
 * Electron に依存させない（単体テストで暗号化の可否を差し替えるため）。safeStorage は呼び出し側で渡す。
 */
import { existsSync, readFileSync } from 'node:fs'
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SttKeySource } from '@shared/types'
import { AI_VENDORS, type AiVendor } from '@shared/aiProviders'
import { t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'
import { errorKind, reportHandled } from '@shared/report'

/** キーを保存する単位。提供元（vendor）ごとに1つで、文字起こしと整理で共有する */
type SttKeyProvider = AiVendor

/** safeStorage の必要な部分だけ */
export interface KeyCipher {
  /** 安全に暗号化できるか（Linux の basic_text は false にすること）。macOS では Keychain に触れることがある */
  available(): boolean
  /**
   * OS の鍵の仕組みに触れずに分かる範囲の「たぶん使える」。起動時の表示（保存方式）に使う。
   * 省略時は available() を使う
   */
  likelyAvailable?(): boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}

const PROVIDERS: readonly SttKeyProvider[] = AI_VENDORS

/**
 * キーの形式を確かめる。OpenAI は sk- で始まるキーだけ、互換サーバーは空白を含まない
 * 表示可能な ASCII（Groq の gsk_…、自前サーバーの任意のトークン）。問題なければ null。
 */
export function validateSttKey(provider: SttKeyProvider, key: string): string | null {
  if (provider === 'openai') {
    return /^sk-[A-Za-z0-9_-]{15,500}$/.test(key) ? null : t('stt.key.badOpenai')
  }
  return /^[\x21-\x7e]{1,500}$/.test(key) ? null : t('stt.key.badFormat')
}

export class SttKeyStore {
  private readonly keys: Partial<Record<SttKeyProvider, string>> = {}
  /** 暗号化して保存できているキー */
  private readonly persisted = new Set<SttKeyProvider>()
  /** キーが変わったら呼ぶ（security-7 [4]。キーを覚えて使う側が、古いキーと出した合言葉を捨てる） */
  private readonly listeners = new Set<(provider: SttKeyProvider) => void>()
  private loaded = false
  /** 保存した提供元の名前（暗号化しない別のファイル）。起動時はこれだけを読み、復号しない */
  private index: Set<SttKeyProvider> | null = null

  constructor(
    private readonly file: string,
    private readonly cipher: KeyCipher,
    /** キーとして読んでよい環境変数。既定は空（読まない）。dev 起動だけ devKeyEnv で渡す */
    private readonly env: NodeJS.ProcessEnv = {},
  ) {}

  /** 保存方式。画面に「保存しません」を出すかどうかに使う。OS の鍵の仕組みには触れない */
  storage(): 'encrypted' | 'session' {
    return (this.cipher.likelyAvailable ?? this.cipher.available)() ? 'encrypted' : 'session'
  }

  /** 保存した提供元の名前の一覧のファイル。値は入れない */
  private get indexFile(): string {
    return `${this.file}.index.json`
  }

  private savedVendors(): Set<SttKeyProvider> {
    if (!this.index) {
      try {
        const raw = JSON.parse(readFileSync(this.indexFile, 'utf8')) as { vendors?: unknown }
        this.index = new Set(Array.isArray(raw.vendors) ? raw.vendors.filter((v): v is SttKeyProvider => PROVIDERS.includes(v as SttKeyProvider)) : [])
      } catch {
        // まだキーを保存していない（索引が無い）のは想定内
        this.index = new Set()
      }
    }
    return this.index
  }

  /**
   * キーがあるか（送れる状態の判定用）。**復号しない**ので、起動時・画面の表示から呼んでよい。
   * まだ読んでいなければ、保存した提供元の名前の一覧で判断する。
   */
  has(provider: SttKeyProvider): boolean {
    return !!this.get(provider) || (!this.loaded && this.savedVendors().has(provider))
  }

  /**
   * 送信に使うキー。保存してあれば、ここで初めて復号する（macOS の Keychain に触れる）。
   * 実際に送る直前・接続の確認のときだけ呼ぶ。保存していない提供元では OS の鍵の仕組みに触れない。
   */
  async read(provider: SttKeyProvider): Promise<string | undefined> {
    if (!this.keys[provider] && !this.loaded && this.savedVendors().has(provider)) await this.load()
    return this.get(provider)
  }

  /**
   * 保存済みのキーを読む。初めて使う時点で1度だけ呼ぶ（macOS では Keychain に触れるため、起動時には読まない）。
   * 読めない（別の端末からコピーした・鍵が消えた）ファイルは無視する。
   */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    if (!this.cipher.available()) return
    try { await this.decryptFile() } finally { this.syncIndexAfterLoad() }
  }

  private async decryptFile(): Promise<void> {
    let data: Buffer
    // 保存したキーが無い（想定内）
    try { data = await readFile(this.file) } catch { return }
    try {
      const parsed = JSON.parse(this.cipher.decrypt(data)) as Record<string, unknown>
      for (const p of PROVIDERS) {
        const v = parsed[p]
        // 起動中に入れたキーを、後から読んだ古い値で上書きしない
        if (typeof v === 'string' && v && this.keys[p] === undefined) {
          this.keys[p] = v
          this.persisted.add(p)
        }
      }
    } catch (err) {
      console.warn('[stt] 保存済みのAPIキーを復号できませんでした。もう一度入力してください。')
      // キーそのものは送らない（種類だけ）
      reportHandled(errorKind(err), { area: 'stt', op: 'decrypt saved keys' })
    }
  }

  /** 読み終えたら、一覧は実際に読めたキーに合わせる（復号できなかったものを「保存済み」と出さない） */
  private syncIndexAfterLoad(): void {
    this.index = new Set(this.persisted)
  }

  /** 送信に使うキー。OpenAI は保存したキーが無ければ .env の OPENAI_API_KEY */
  get(provider: SttKeyProvider): string | undefined {
    return this.keys[provider] ?? (provider === 'openai' ? this.env.OPENAI_API_KEY || undefined : undefined)
  }

  source(provider: SttKeyProvider): SttKeySource {
    if (this.keys[provider]) return this.persisted.has(provider) ? 'saved' : 'session'
    if (!this.loaded && this.savedVendors().has(provider)) return 'saved'
    return provider === 'openai' && this.env.OPENAI_API_KEY ? 'env' : null
  }

  /** キーが変わったときに呼ぶ関数を足す。戻り値で外す */
  onChange(listener: (provider: SttKeyProvider) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * キーを設定する。空文字は解除。暗号化できれば保存し、できなければ起動中だけ持つ。
   * 形式が違えば日本語のエラーを投げる（キーの値はメッセージに含めない）。
   */
  async set(provider: SttKeyProvider, key: string): Promise<{ persisted: boolean }> {
    await this.load()
    const trimmed = key.trim()
    if (trimmed) {
      const invalid = validateSttKey(provider, trimmed)
      // 形の誤りは利用者が直すもの（不具合として報告しない）。文面にキーの値は入れない
      if (invalid) throw new UserFacingError(invalid)
      this.keys[provider] = trimmed
    } else {
      delete this.keys[provider]
    }
    this.persisted.delete(provider)
    // 書き込みを待つ前に、同期で知らせる（変更の IPC が戻る前に、古いキーを使う合言葉と依頼を止める）
    for (const listener of this.listeners) {
      try {
        listener(provider)
      } catch (err) {
        reportHandled(errorKind(err), { area: 'stt', op: 'key change listener' })
      }
    }
    if (!this.cipher.available()) return { persisted: false }
    try {
      await this.write()
    } catch (err) {
      console.warn('[stt] APIキーを保存できませんでした。この起動中だけ使います。')
      reportHandled(errorKind(err), { area: 'stt', op: 'save api key' })
      return { persisted: false }
    }
    if (trimmed) this.persisted.add(provider)
    return { persisted: !!trimmed }
  }

  /** 保存済みの分も含めて暗号化して書き直す。キーが1つも無ければファイルを消す */
  private async write(): Promise<void> {
    const entries = PROVIDERS.flatMap((p) => (this.keys[p] ? [[p, this.keys[p]] as const] : []))
    if (entries.length === 0) {
      await rm(this.file, { force: true })
      await rm(this.indexFile, { force: true })
      this.index = new Set()
      return
    }
    await mkdir(dirname(this.file), { recursive: true })
    // 中身は暗号化済みだが、念のため本人だけが読める権限にする（Windows では無視される）
    await writeFile(this.file, this.cipher.encrypt(JSON.stringify(Object.fromEntries(entries))), { mode: 0o600 })
    for (const [p] of entries) this.persisted.add(p)
    // 起動時に復号せずに「保存済み」と分かるよう、提供元の名前だけを別に書く
    await writeFile(this.indexFile, `${JSON.stringify({ vendors: entries.map(([p]) => p) })}\n`, { mode: 0o600 })
    this.index = new Set(entries.map(([p]) => p))
  }
}

/** キーとして読んでよい環境変数。配布版（isPackaged）は空にして、利用者・開発者どちらの環境変数も使わない */
export function devKeyEnv(isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return isPackaged ? {} : env
}

/**
 * 開発用の .env を読む。dev 起動のときだけ。配布物には .env を含めない（electron-builder の files で除外）。
 * 読んだら true。
 */
export function loadDevDotEnv(isPackaged: boolean, path = '.env', load: (path: string) => void = process.loadEnvFile): boolean {
  if (isPackaged || !existsSync(path)) return false
  load(path)
  return true
}

/**
 * Electron の safeStorage を KeyCipher にする。
 * Linux で鍵束が無いと basic_text（ソースに書かれた固定の鍵）になり、実質平文なので使わない。
 */
export function safeStorageCipher(safeStorage: {
  isEncryptionAvailable(): boolean
  encryptString(text: string): Buffer
  decryptString(data: Buffer): string
  getSelectedStorageBackend?(): string
}, platform: NodeJS.Platform = process.platform): KeyCipher {
  return {
    // macOS / Windows は OS の鍵の仕組みが常にある。触れずに「使える」とみなす（触れると Keychain の確認が出ることがある）
    likelyAvailable: () => platform !== 'linux' || (safeStorage.isEncryptionAvailable() && !['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend?.() ?? 'unknown')),
    available: () => {
      if (!safeStorage.isEncryptionAvailable()) return false
      if (platform !== 'linux') return true
      const backend = safeStorage.getSelectedStorageBackend?.() ?? 'unknown'
      return backend !== 'basic_text' && backend !== 'unknown'
    },
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
  }
}

/** 暗号化しない（保存しない）。dev 起動で使う */
export const NO_CIPHER: KeyCipher = { available: () => false, likelyAvailable: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' }

/**
 * 使う暗号化を選ぶ。**配布版だけ** safeStorage を使う。
 * dev 起動では使わない（Electron.app の名前・署名が変わると Keychain の許可が合わず、起動のたびに確認が出るため）。
 * キーはその起動中だけ持つ。
 * safeStorage はここでは呼ばない（渡すだけ）。
 */
export function chooseKeyCipher(opt: { isPackaged: boolean; safeStorage: Parameters<typeof safeStorageCipher>[0]; platform?: NodeJS.Platform }): KeyCipher {
  return opt.isPackaged ? safeStorageCipher(opt.safeStorage, opt.platform) : NO_CIPHER
}
