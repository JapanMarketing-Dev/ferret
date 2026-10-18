/**
 * YouTube・TikTok の接続（トークンと表示名）の置き場。Ferret の発信の接続先（src/main/publish/connections.ts）と同じ作法で、
 * OS の鍵の仕組み（safeStorage）で暗号化して userData/video-publish-connections.bin に置く（X・ブログとは別のファイル）。
 * 暗号化できない環境（dev 起動・E2E・Linux の basic_text）では起動中だけ覚える。
 *
 * - 画面へは info()（つながっているか・チャンネル名）だけを返す。トークンは返さない
 * - トークンは得たときのクライアント（YouTube の Client ID・TikTok の client_key）と一緒に置く。
 *   クライアントが変わったら（サンドボックス → 本番など）前のトークンは使わない
 * - トークンの値はログ・エラー・IPC の戻り値に出さない
 */
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { savePrivateFile } from '../../../../main/atomicFile'
import type { KeyCipher } from '../../../../main/pipeline/stt/keys'
import { sanitizeTikTokTokens, type TikTokTokens } from './tiktokApi'

export interface StoredYouTube {
  clientId: string
  refreshToken: string
  name?: string
}

export interface StoredTikTok {
  clientKey: string
  tokens: TikTokTokens
  name?: string
}

export interface StoredConnections {
  youtube?: StoredYouTube
  tiktok?: StoredTikTok
}

const NAME_CHARS = 200

const cleanName = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, NAME_CHARS) : undefined)

export function sanitizeStored(raw: unknown): StoredConnections {
  const r = (raw ?? {}) as Record<string, unknown>
  const out: StoredConnections = {}
  const yt = (r.youtube ?? {}) as Record<string, unknown>
  if (typeof yt.clientId === 'string' && yt.clientId && typeof yt.refreshToken === 'string' && yt.refreshToken) {
    const name = cleanName(yt.name)
    out.youtube = { clientId: yt.clientId, refreshToken: yt.refreshToken, ...(name ? { name } : {}) }
  }
  const tt = (r.tiktok ?? {}) as Record<string, unknown>
  const tokens = sanitizeTikTokTokens(tt.tokens)
  if (typeof tt.clientKey === 'string' && tt.clientKey && tokens) {
    const name = cleanName(tt.name)
    out.tiktok = { clientKey: tt.clientKey, tokens, ...(name ? { name } : {}) }
  }
  return out
}

export class VideoPublishStore {
  private data: StoredConnections | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly path: string, private readonly cipher: KeyCipher) {}

  private async load(): Promise<StoredConnections> {
    if (this.data) return this.data
    let data: StoredConnections = {}
    if (existsSync(this.path) && this.cipher.available()) {
      try {
        data = sanitizeStored(JSON.parse(this.cipher.decrypt(await readFile(this.path))))
      } catch {
        // 復号できない（鍵が変わった・壊れた）。空として扱う（想定内）
      }
    }
    this.data = data
    return data
  }

  private async save(data: StoredConnections): Promise<void> {
    this.data = data
    if (!this.cipher.available()) return
    if (!data.youtube && !data.tiktok) {
      await rm(this.path, { force: true })
      return
    }
    await savePrivateFile(this.path, this.cipher.encrypt(JSON.stringify({ version: 1, ...data })))
  }

  /** 読み込み → 変更 → 保存を1つずつ */
  private exclusive<T>(fn: (data: StoredConnections) => Promise<T> | T): Promise<T> {
    const next = this.queue.catch(() => undefined).then(async () => fn(await this.load()))
    this.queue = next.catch(() => undefined)
    return next
  }

  persisted(): boolean {
    return this.cipher.likelyAvailable?.() ?? this.cipher.available()
  }

  /** 今のクライアントで得た YouTube の接続。クライアントが違えば null */
  async youtube(clientId: string | null): Promise<StoredYouTube | null> {
    return this.exclusive((d) => (d.youtube && clientId && d.youtube.clientId === clientId ? { ...d.youtube } : null))
  }

  async tiktok(clientKey: string | null): Promise<StoredTikTok | null> {
    return this.exclusive((d) => (d.tiktok && clientKey && d.tiktok.clientKey === clientKey ? { ...d.tiktok, tokens: { ...d.tiktok.tokens } } : null))
  }

  async setYouTube(v: StoredYouTube | null): Promise<void> {
    await this.exclusive(async (d) => {
      const next = { ...d }
      if (v) next.youtube = sanitizeStored({ youtube: v }).youtube!
      else delete next.youtube
      await this.save(next)
    })
  }

  async setTikTok(v: StoredTikTok | null): Promise<void> {
    await this.exclusive(async (d) => {
      const next = { ...d }
      const clean = v ? sanitizeStored({ tiktok: v }).tiktok : undefined
      if (clean) next.tiktok = clean
      else delete next.tiktok
      await this.save(next)
    })
  }

  /** 新しいトークン（リフレッシュの結果）だけを入れ替える。その間に解除・別の接続があれば入れない */
  async updateTikTokTokens(clientKey: string, previousRefresh: string, tokens: TikTokTokens): Promise<boolean> {
    return this.exclusive(async (d) => {
      if (!d.tiktok || d.tiktok.clientKey !== clientKey || d.tiktok.tokens.refreshToken !== previousRefresh) return false
      await this.save({ ...d, tiktok: { ...d.tiktok, tokens } })
      return true
    })
  }
}
