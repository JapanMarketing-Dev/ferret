/**
 * 発信の接続先（X の Client ID とトークン・ブログの接続先と秘密）の置き場。
 * OS の鍵の仕組み（safeStorage）で暗号化して userData/publish-connections.bin に置く（文字起こしのキー・共有リンクと同じ）。
 * 暗号化できない環境（dev 起動・E2E・Linux の basic_text）では起動中だけ覚える。
 *
 * - 画面へは info()（Client ID・つながっているか・@ユーザー名・ブログの名前と URL）だけを返す。トークン・パスワードは返さない
 * - ブログの秘密はその URL と一緒にしか登録できない（URL だけを変える口は無い）。画面が乗っ取られても、
 *   登録済みの秘密を別の接続先へ送らせられない（security-5 [6] と同じ考え）
 * - Client ID を変えたら、前の Client ID で得たトークンは捨てる
 */
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { UserFacingError } from '@shared/errors'
import {
  normalizeBlogUrl, PUBLISH_LIMITS, validCollection, validXClientId, xCallbackUrl,
  type BlogKind, type BlogTargetInfo, type BlogTargetInput, type PublishConnectionsInfo
} from '@shared/publish'
import { savePrivateFile } from '../atomicFile'
import type { KeyCipher } from '../pipeline/stt/keys'
import type { XTokens, XUser } from './xApi'
import { publishText } from './store'

export interface StoredX {
  clientId?: string
  tokens?: XTokens
  user?: XUser
}

export interface StoredBlog extends BlogTargetInfo {
  secret: string
}

interface Data {
  x: StoredX
  blogs: StoredBlog[]
}

const KINDS: readonly BlogKind[] = ['wordpress', 'emdash']
const ID_PATTERN = /^[0-9a-f]{16}$/

function sanitizeTokens(raw: unknown): XTokens | undefined {
  const t = (raw ?? {}) as Record<string, unknown>
  if (typeof t.accessToken !== 'string' || !t.accessToken || typeof t.expiresAt !== 'number' || !Number.isFinite(t.expiresAt)) return undefined
  return { accessToken: t.accessToken, expiresAt: t.expiresAt, ...(typeof t.refreshToken === 'string' && t.refreshToken ? { refreshToken: t.refreshToken } : {}) }
}

function sanitizeUser(raw: unknown): XUser | undefined {
  const u = (raw ?? {}) as Record<string, unknown>
  return typeof u.id === 'string' && u.id && typeof u.username === 'string' && /^[A-Za-z0-9_]{1,50}$/.test(u.username) ? { id: u.id, username: u.username } : undefined
}

/** 画面から来た接続先を確かめる。だめなら利用者向けの理由で断る */
export function readBlogInput(raw: unknown): BlogTargetInput {
  const r = (raw ?? {}) as Record<string, unknown>
  const kind = KINDS.find((k) => k === r.kind)
  if (!kind) throw new UserFacingError(publishText('publish.errors.blogKind'))
  const name = typeof r.name === 'string' ? r.name.replace(/\s+/g, ' ').trim() : ''
  if (!name || Array.from(name).length > PUBLISH_LIMITS.blogNameChars) throw new UserFacingError(publishText('publish.errors.blogName', { max: PUBLISH_LIMITS.blogNameChars }))
  const baseUrl = typeof r.baseUrl === 'string' ? normalizeBlogUrl(r.baseUrl) : null
  if (!baseUrl) throw new UserFacingError(publishText('publish.errors.blogUrl'))
  const secret = typeof r.secret === 'string' ? r.secret.trim() : ''
  if (!secret || secret.length > PUBLISH_LIMITS.blogSecretChars || !/^[\x20-\x7e]+$/.test(secret)) throw new UserFacingError(publishText('publish.errors.blogSecret'))
  if (kind === 'wordpress') {
    const username = typeof r.username === 'string' ? r.username.trim() : ''
    if (!username || username.length > 100 || /[:\r\n]/.test(username)) throw new UserFacingError(publishText('publish.errors.blogUsername'))
    return { kind, name, baseUrl, username, secret }
  }
  const collection = typeof r.collection === 'string' && r.collection.trim() ? r.collection.trim() : 'posts'
  if (!validCollection(collection)) throw new UserFacingError(publishText('publish.errors.blogCollection'))
  return { kind, name, baseUrl, secret, collection }
}

export function sanitizeConnections(raw: unknown): Data {
  const r = (raw ?? {}) as Record<string, unknown>
  const x = (r.x ?? {}) as Record<string, unknown>
  const stored: StoredX = {}
  if (typeof x.clientId === 'string' && validXClientId(x.clientId)) {
    stored.clientId = x.clientId
    const tokens = sanitizeTokens(x.tokens)
    const user = sanitizeUser(x.user)
    if (tokens) stored.tokens = tokens
    if (tokens && user) stored.user = user
  }
  const seen = new Set<string>()
  const blogs = (Array.isArray(r.blogs) ? r.blogs : []).flatMap((item: unknown): StoredBlog[] => {
    const b = (item ?? {}) as Record<string, unknown>
    if (typeof b.id !== 'string' || !ID_PATTERN.test(b.id) || seen.has(b.id)) return []
    try {
      const input = readBlogInput(b)
      seen.add(b.id)
      return [{ id: b.id, ...input }]
    } catch {
      // 形の合わないもの（手で書き換えた）は捨てる（想定内）
      return []
    }
  })
  return { x: stored, blogs: blogs.slice(0, PUBLISH_LIMITS.blogTargets) }
}

function blogInfo(b: StoredBlog): BlogTargetInfo {
  return { id: b.id, kind: b.kind, name: b.name, baseUrl: b.baseUrl, ...(b.username ? { username: b.username } : {}), ...(b.collection ? { collection: b.collection } : {}) }
}

export class PublishConnections {
  private data: Data | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly path: string, private readonly cipher: KeyCipher) {}

  private async load(): Promise<Data> {
    if (this.data) return this.data
    let data: Data = { x: {}, blogs: [] }
    if (existsSync(this.path) && this.cipher.available()) {
      try {
        data = sanitizeConnections(JSON.parse(this.cipher.decrypt(await readFile(this.path))))
      } catch {
        // 復号できない（鍵が変わった・壊れた）。空として扱う（想定内）
      }
    }
    this.data = data
    return data
  }

  private async save(data: Data): Promise<void> {
    this.data = data
    if (!this.cipher.available()) return
    if (!data.x.clientId && !data.blogs.length) {
      await rm(this.path, { force: true })
      return
    }
    await savePrivateFile(this.path, this.cipher.encrypt(JSON.stringify({ version: 1, ...data })))
  }

  /** 読み込み → 変更 → 保存を1つずつ */
  private exclusive<T>(fn: (data: Data) => Promise<T> | T): Promise<T> {
    const next = this.queue.catch(() => undefined).then(async () => fn(await this.load()))
    this.queue = next.catch(() => undefined)
    return next
  }

  persisted(): boolean {
    return this.cipher.likelyAvailable?.() ?? this.cipher.available()
  }

  async info(): Promise<PublishConnectionsInfo> {
    return this.exclusive((d) => ({
      x: {
        clientId: d.x.clientId ?? null,
        connected: Boolean(d.x.tokens),
        ...(d.x.user ? { username: d.x.user.username } : {}),
        callbackUrl: xCallbackUrl()
      },
      blogs: d.blogs.map(blogInfo),
      persisted: this.persisted()
    }))
  }

  async x(): Promise<StoredX> {
    return this.exclusive((d) => ({ ...d.x }))
  }

  /** Client ID を変える（null で消す）。変わったらトークンを捨てる */
  async setXClientId(clientId: string | null): Promise<void> {
    if (clientId !== null && !validXClientId(clientId)) throw new UserFacingError(publishText('publish.errors.xClientId'))
    await this.exclusive(async (d) => {
      if (d.x.clientId === (clientId ?? undefined)) return
      await this.save({ ...d, x: clientId ? { clientId } : {} })
    })
  }

  /** 認証で得たトークンを置く。その間に Client ID が変わっていたら捨てる */
  async setXTokens(clientId: string, tokens: XTokens, user?: XUser): Promise<boolean> {
    return this.exclusive(async (d) => {
      if (d.x.clientId !== clientId) return false
      const who = user ?? d.x.user
      await this.save({ ...d, x: { clientId, tokens, ...(who ? { user: who } : {}) } })
      return true
    })
  }

  async clearXTokens(): Promise<void> {
    await this.exclusive(async (d) => {
      if (!d.x.tokens) return
      await this.save({ ...d, x: d.x.clientId ? { clientId: d.x.clientId } : {} })
    })
  }

  async addBlog(raw: unknown): Promise<BlogTargetInfo> {
    const input = readBlogInput(raw)
    return this.exclusive(async (d) => {
      if (d.blogs.length >= PUBLISH_LIMITS.blogTargets) throw new UserFacingError(publishText('publish.errors.blogTooMany', { max: PUBLISH_LIMITS.blogTargets }))
      const blog: StoredBlog = { id: randomBytes(8).toString('hex'), ...input }
      await this.save({ ...d, blogs: [...d.blogs, blog] })
      return blogInfo(blog)
    })
  }

  async removeBlog(id: string): Promise<void> {
    await this.exclusive(async (d) => {
      if (!d.blogs.some((b) => b.id === id)) return
      await this.save({ ...d, blogs: d.blogs.filter((b) => b.id !== id) })
    })
  }

  /** 投稿に使う接続先（秘密を含む）。無ければ断る */
  async blog(id: string): Promise<StoredBlog> {
    const blog = await this.exclusive((d) => d.blogs.find((b) => b.id === id))
    if (!blog) throw new UserFacingError(publishText('publish.errors.blogNotFound'))
    return { ...blog }
  }
}
