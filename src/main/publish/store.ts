/**
 * 「発信」の下書きの置き場（プロジェクトごと）。userData/publish/<プロジェクトの id の sha256 の先頭32文字>.json に、
 * 下書き・付けたメディア・バックグラウンドの生成の状態を置く（所有者だけが読める・一時ファイルから置き換え。atomicFile.ts）。
 *
 * - メディアの実パスは main だけが持つ。画面へは名前・大きさ・見本だけを返す（snapshot）
 * - 読むときに形を確かめ、壊れたファイルは空として、形の合わない下書き・メディアは捨てる（feedbackShare/store.ts と同じ）
 * - 同じプロジェクトの変更は1つずつ（読み込み → 変更 → 保存が割り込まない）
 */
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { t, type MessageParams, type TranslationKey } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'
import {
  mediaKindOf, PUBLISH_LIMITS, xMediaProblem,
  type PostDraftInfo, type PostDraftPatch, type PostDraftSource, type PostDraftStatus, type PostMediaInfo, type PostMediaKind, type PublishSnapshot
} from '@shared/publish'
import { savePrivateFile } from '../atomicFile'

export interface StoredMedia {
  id: string
  kind: PostMediaKind
  name: string
  bytes: number
  /** 実パス（絶対パス）。画面へは返さない */
  path: string
}

export interface StoredDraft extends Omit<PostDraftInfo, 'media'> {
  media: StoredMedia[]
}

export interface StoredBackground {
  /** バックグラウンドで作るか（既定は作る） */
  enabled: boolean
  lastRunAt?: string
  lastError?: string
  /** 前回の生成に使った git の HEAD（次はこれより後のコミットだけを材料にする） */
  lastHead?: string
}

/** null はその項目を消す */
export interface StoredBackgroundPatch {
  enabled?: boolean
  lastRunAt?: string | null
  lastError?: string | null
  lastHead?: string | null
}

/** 足す下書き。メディアは X の決まり（xMediaProblem）に収まる分だけ付ける */
export interface NewDraft {
  source: PostDraftSource
  title: string
  text: string
  basis?: string
  media?: ReadonlyArray<{ path: string; bytes: number }>
}

/** 下書きのメディアの見本を作る（作れなければ undefined） */
export type ThumbnailMaker = (path: string, kind: PostMediaKind) => Promise<string | undefined>

interface ProjectData {
  drafts: StoredDraft[]
  background: StoredBackground
}

const ID_PATTERN = /^[0-9a-f]{8,64}$/
const BASIS_CHARS = 500
const ERROR_CHARS = 500
const STATUSES: readonly PostDraftStatus[] = ['new', 'posted', 'dismissed']
const SOURCES: readonly PostDraftSource[] = ['ai-background', 'ai-text', 'manual']
/** 変えてよい状態（同じ状態への変更はいつでも可）。投稿済みは「使わない」にだけ動かせる（同じ本文を X は二度受け付けない） */
const TRANSITIONS: Record<PostDraftStatus, readonly PostDraftStatus[]> = {
  new: ['posted', 'dismissed'],
  dismissed: ['new'],
  posted: ['dismissed']
}

/** 発信の文（キーは publish.*。i18n に足したら t() をそのまま使ってよい） */
export function publishText(key: `publish.${string}`, params?: MessageParams): string {
  return t(key as TranslationKey, params)
}

export function newId(): string {
  return randomBytes(8).toString('hex')
}

/** 題が空のときは本文の最初の行から作る */
export function titleFromText(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return Array.from(line).slice(0, PUBLISH_LIMITS.titleChars).join('')
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

function validDate(v: unknown): string | null {
  return typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null
}

function sanitizeMedia(raw: unknown): StoredMedia[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  return raw.flatMap((item: unknown) => {
    const m = (item ?? {}) as Record<string, unknown>
    const id = typeof m.id === 'string' && ID_PATTERN.test(m.id) ? m.id : null
    const path = typeof m.path === 'string' && isAbsolute(m.path) ? m.path : null
    const kind = path ? mediaKindOf(path) : null
    const bytes = typeof m.bytes === 'number' && Number.isFinite(m.bytes) && m.bytes >= 0 ? Math.floor(m.bytes) : null
    if (!id || !path || !kind || m.kind !== kind || bytes === null || seen.has(id)) return []
    seen.add(id)
    const name = typeof m.name === 'string' && m.name ? clip(m.name, 255) : basename(path)
    return [{ id, kind, name, bytes, path }]
  })
}

/** 保存したファイルの中身を確かめる。合わないものは捨て、新しい順に並べる */
export function sanitizeProjectData(raw: unknown, projectId: string): ProjectData {
  const r = (raw ?? {}) as Record<string, unknown>
  const empty: ProjectData = { drafts: [], background: { enabled: true } }
  if (typeof raw !== 'object' || raw === null || r.projectId !== projectId) return empty
  const seen = new Set<string>()
  const drafts = (Array.isArray(r.drafts) ? r.drafts : []).flatMap((item: unknown): StoredDraft[] => {
    const d = (item ?? {}) as Record<string, unknown>
    const id = typeof d.id === 'string' && ID_PATTERN.test(d.id) ? d.id : null
    const createdAt = validDate(d.createdAt)
    const updatedAt = validDate(d.updatedAt) ?? createdAt
    const source = SOURCES.find((s) => s === d.source)
    const status = STATUSES.find((s) => s === d.status)
    if (!id || seen.has(id) || !createdAt || !updatedAt || !source || !status || typeof d.text !== 'string' || typeof d.title !== 'string') return []
    seen.add(id)
    const text = clip(d.text, PUBLISH_LIMITS.textChars)
    const title = Array.from(d.title.replace(/\s+/g, ' ').trim()).slice(0, PUBLISH_LIMITS.titleChars).join('') || titleFromText(text)
    const basis = typeof d.basis === 'string' && d.basis ? clip(d.basis, BASIS_CHARS) : undefined
    const postedAt = status === 'posted' ? validDate(d.postedAt) ?? updatedAt : status === 'dismissed' ? validDate(d.postedAt) ?? undefined : undefined
    // 組み合わせが X の決まりから外れたもの（手で書き換えた・決まりが変わった）は、収まる分だけ残す
    const media = fitMedia([], sanitizeMedia(d.media))
    return [{ id, createdAt, updatedAt, source, status, title, text, media, ...(basis ? { basis } : {}), ...(postedAt ? { postedAt } : {}) }]
  })
  // 新しい順（同じ時刻は保存の順のまま）
  drafts.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  const b = (r.background ?? {}) as Record<string, unknown>
  const background: StoredBackground = { enabled: b.enabled !== false }
  const lastRunAt = validDate(b.lastRunAt)
  if (lastRunAt) background.lastRunAt = lastRunAt
  if (typeof b.lastError === 'string' && b.lastError) background.lastError = clip(b.lastError, ERROR_CHARS)
  if (typeof b.lastHead === 'string' && /^[0-9a-f]{7,64}$/.test(b.lastHead)) background.lastHead = b.lastHead
  return { drafts: drafts.slice(0, PUBLISH_LIMITS.draftsPerProject), background }
}

/** 今のメディアに、X の決まりに収まる分だけ足す（収まらないものは捨てる） */
function fitMedia(current: StoredMedia[], additions: StoredMedia[]): StoredMedia[] {
  const out = [...current]
  for (const m of additions) {
    if (out.some((o) => o.path === m.path)) continue
    if (xMediaProblem([...out, m]) === null) out.push(m)
  }
  return out
}

function toInfo(d: StoredDraft, thumbnails?: ReadonlyMap<string, string | undefined>): PostDraftInfo {
  const media: PostMediaInfo[] = d.media.map((m) => {
    const thumbnail = thumbnails?.get(m.id)
    return { id: m.id, kind: m.kind, name: m.name, bytes: m.bytes, ...(thumbnail ? { thumbnail } : {}) }
  })
  return { ...d, media }
}

const MEDIA_PROBLEM_KEYS = { tooMany: 'publish.errors.mediaTooMany', mixed: 'publish.errors.mediaMixed', tooLarge: 'publish.errors.mediaTooLarge' } as const

export class PublishStore {
  private readonly cache = new Map<string, ProjectData>()
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(private readonly userDataDir: string, private readonly now: () => number = Date.now) {}

  /** そのプロジェクトのファイルの場所 */
  pathOf(projectId: string): string {
    return join(this.userDataDir, 'publish', `${createHash('sha256').update(projectId).digest('hex').slice(0, 32)}.json`)
  }

  private async load(projectId: string): Promise<ProjectData> {
    const cached = this.cache.get(projectId)
    if (cached) return cached
    let data: ProjectData
    try {
      data = sanitizeProjectData(JSON.parse(await readFile(this.pathOf(projectId), 'utf8')), projectId)
    } catch {
      // 無い・壊れている。空として扱う（想定内）
      data = { drafts: [], background: { enabled: true } }
    }
    this.cache.set(projectId, data)
    return data
  }

  private async save(projectId: string, data: ProjectData): Promise<void> {
    this.cache.set(projectId, data)
    await savePrivateFile(this.pathOf(projectId), JSON.stringify({ version: 1, projectId, drafts: data.drafts, background: data.background }))
  }

  /** 同じプロジェクトの読み込み → 変更 → 保存を1つずつ走らせる */
  private exclusive<T>(projectId: string, fn: (data: ProjectData) => Promise<T> | T): Promise<T> {
    const prev = this.queues.get(projectId) ?? Promise.resolve()
    // 前の処理の失敗はその呼び出し側へ返し済み（順番待ちに使うだけ。想定内）
    const next = prev.catch(() => undefined).then(async () => fn(await this.load(projectId)))
    const tail = next.catch(() => undefined)
    this.queues.set(projectId, tail)
    void tail.then(() => { if (this.queues.get(projectId) === tail) this.queues.delete(projectId) })
    return next
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  /** 画面へ返す形（新しい順）。running は呼び出し側（PublishBackground）が知っている */
  async snapshot(projectId: string, thumbnail?: ThumbnailMaker, running = false): Promise<PublishSnapshot> {
    const data = await this.exclusive(projectId, (d) => d)
    const thumbs = new Map<string, string | undefined>()
    if (thumbnail) {
      await Promise.all(data.drafts.flatMap((d) => d.media).map(async (m) => {
        // 見本が作れない（ファイルが消えた・読めない形式）ときは見本なし（想定内）
        thumbs.set(m.id, await thumbnail(m.path, m.kind).catch(() => undefined))
      }))
    }
    const { enabled, lastRunAt, lastError } = data.background
    return {
      drafts: data.drafts.map((d) => toInfo(d, thumbs)),
      background: { enabled, running, ...(lastRunAt ? { lastRunAt } : {}), ...(lastError ? { lastError } : {}) }
    }
  }

  /** 1件（見本なし）。無ければ null */
  async get(projectId: string, id: string): Promise<PostDraftInfo | null> {
    const data = await this.exclusive(projectId, (d) => d)
    const draft = data.drafts.find((d) => d.id === id)
    return draft ? toInfo(draft) : null
  }

  /** 未使用（new）の下書きの数 */
  async pendingCount(projectId: string): Promise<number> {
    return (await this.exclusive(projectId, (d) => d)).drafts.filter((d) => d.status === 'new').length
  }

  /** 最近の下書きの題（AI に同じものを作らせないため） */
  async recentTitles(projectId: string, limit = 30): Promise<string[]> {
    return (await this.exclusive(projectId, (d) => d)).drafts.slice(0, limit).map((d) => d.title)
  }

  /**
   * 下書きを足す（先頭＝いちばん新しい側に、渡した順で）。上限を超えたら、使い終わった（投稿済み・使わない）ものの古い順、
   * 次に未使用の古い順に忘れる。足したもの（見本なし）を返す
   */
  async add(projectId: string, drafts: readonly NewDraft[]): Promise<PostDraftInfo[]> {
    return this.exclusive(projectId, async (data) => {
      const at = this.iso()
      const added: StoredDraft[] = drafts.flatMap((n) => {
        const text = clip(n.text.trim(), PUBLISH_LIMITS.textChars)
        // AI の下書きは空なら捨てる。手書きは白紙から書き始められるよう空でも作る
        if (!text && n.source !== 'manual') return []
        const title = Array.from(n.title.replace(/\s+/g, ' ').trim()).slice(0, PUBLISH_LIMITS.titleChars).join('') || titleFromText(text)
        const media = fitMedia([], (n.media ?? []).flatMap((f) => {
          const kind = isAbsolute(f.path) ? mediaKindOf(f.path) : null
          return kind ? [{ id: newId(), kind, name: basename(f.path), bytes: Math.max(0, Math.floor(f.bytes)), path: f.path }] : []
        }))
        const basis = n.basis?.trim() ? clip(n.basis.trim(), BASIS_CHARS) : undefined
        return [{ id: newId(), createdAt: at, updatedAt: at, source: n.source, status: 'new' as const, title, text, media, ...(basis ? { basis } : {}) }]
      }).slice(0, PUBLISH_LIMITS.draftsPerProject)
      if (!added.length) return []
      let all = [...added, ...data.drafts]
      const over = all.length - PUBLISH_LIMITS.draftsPerProject
      if (over > 0) {
        // 古い順に、使い終わったもの → 未使用のもの（今回足したものは消さない）
        const older = data.drafts.slice().reverse()
        const drop = new Set([...older.filter((d) => d.status !== 'new'), ...older.filter((d) => d.status === 'new')].slice(0, over).map((d) => d.id))
        all = all.filter((d) => !drop.has(d.id))
      }
      await this.save(projectId, { ...data, drafts: all })
      return added.map((d) => toInfo(d))
    })
  }

  /** 画面からの変更。題・本文の長さ、状態の移り方、メディアの並びを確かめる */
  async update(projectId: string, id: string, patch: PostDraftPatch): Promise<PostDraftInfo> {
    return this.exclusive(projectId, async (data) => {
      const draft = data.drafts.find((d) => d.id === id)
      if (!draft) throw new UserFacingError(publishText('publish.errors.draftNotFound'))
      const next: StoredDraft = { ...draft }
      if (patch.text !== undefined) {
        if (typeof patch.text !== 'string') throw new Error('invalid draft text')
        if (patch.text.length > PUBLISH_LIMITS.textChars) throw new UserFacingError(publishText('publish.errors.textTooLong', { max: PUBLISH_LIMITS.textChars }))
        next.text = patch.text
      }
      if (patch.title !== undefined) {
        if (typeof patch.title !== 'string') throw new Error('invalid draft title')
        const title = patch.title.replace(/\s+/g, ' ').trim()
        if (Array.from(title).length > PUBLISH_LIMITS.titleChars) throw new UserFacingError(publishText('publish.errors.titleTooLong', { max: PUBLISH_LIMITS.titleChars }))
        next.title = title || titleFromText(next.text)
      }
      if (patch.status !== undefined && patch.status !== draft.status) {
        if (!STATUSES.includes(patch.status)) throw new Error('invalid draft status')
        if (!TRANSITIONS[draft.status].includes(patch.status)) throw new Error(`invalid draft status change: ${draft.status} -> ${patch.status}`)
        next.status = patch.status
        // 投稿済みから「使わない」にしても、投稿した時刻は残す
        if (patch.status === 'posted') next.postedAt = this.iso()
        else if (patch.status === 'new') delete next.postedAt
      }
      if (patch.mediaOrder !== undefined) {
        if (!Array.isArray(patch.mediaOrder)) throw new Error('invalid media order')
        const byId = new Map(draft.media.map((m) => [m.id, m]))
        const seen = new Set<string>()
        next.media = patch.mediaOrder.flatMap((mid) => {
          const m = typeof mid === 'string' && !seen.has(mid) ? byId.get(mid) : undefined
          if (!m) return []
          seen.add(mid)
          return [m]
        })
      }
      next.updatedAt = this.iso()
      await this.save(projectId, { ...data, drafts: data.drafts.map((d) => (d.id === id ? next : d)) })
      return toInfo(next)
    })
  }

  /** メディアを付ける（後ろに足す）。知らない形式・X の決まり（4枚まで・動画は1本で画像と混ぜない・大きさ）に外れたら断る */
  async addMedia(projectId: string, id: string, files: ReadonlyArray<{ path: string; bytes: number }>): Promise<PostDraftInfo> {
    return this.exclusive(projectId, async (data) => {
      const draft = data.drafts.find((d) => d.id === id)
      if (!draft) throw new UserFacingError(publishText('publish.errors.draftNotFound'))
      const additions: StoredMedia[] = []
      for (const f of files) {
        if (!isAbsolute(f.path)) throw new Error('media path must be absolute')
        const name = basename(f.path)
        const kind = mediaKindOf(f.path)
        if (!kind) throw new UserFacingError(publishText('publish.errors.mediaUnsupported', { name }))
        // 同じファイルを2回付けない
        if (draft.media.some((m) => m.path === f.path) || additions.some((m) => m.path === f.path)) continue
        additions.push({ id: newId(), kind, name, bytes: Math.max(0, Math.floor(f.bytes)), path: f.path })
      }
      const media = [...draft.media, ...additions]
      const problem = xMediaProblem(media)
      if (problem) throw new UserFacingError(publishText(MEDIA_PROBLEM_KEYS[problem], { images: PUBLISH_LIMITS.xImages }))
      const next: StoredDraft = { ...draft, media, updatedAt: this.iso() }
      await this.save(projectId, { ...data, drafts: data.drafts.map((d) => (d.id === id ? next : d)) })
      return toInfo(next)
    })
  }

  /** 投稿に使うメディアの実パス（並び順）。下書きが無ければ断る */
  async mediaPaths(projectId: string, id: string): Promise<string[]> {
    const data = await this.exclusive(projectId, (d) => d)
    const draft = data.drafts.find((d) => d.id === id)
    if (!draft) throw new UserFacingError(publishText('publish.errors.draftNotFound'))
    return draft.media.map((m) => m.path)
  }

  /** 下書きを消す。無ければ何もしない */
  async remove(projectId: string, id: string): Promise<void> {
    await this.exclusive(projectId, async (data) => {
      if (!data.drafts.some((d) => d.id === id)) return
      await this.save(projectId, { ...data, drafts: data.drafts.filter((d) => d.id !== id) })
    })
  }

  async background(projectId: string): Promise<StoredBackground> {
    return { ...(await this.exclusive(projectId, (d) => d)).background }
  }

  async setBackground(projectId: string, patch: StoredBackgroundPatch): Promise<StoredBackground> {
    return this.exclusive(projectId, async (data) => {
      const next: StoredBackground = { ...data.background }
      if (patch.enabled !== undefined) next.enabled = patch.enabled === true
      for (const key of ['lastRunAt', 'lastError', 'lastHead'] as const) {
        const value = patch[key]
        if (value === undefined) continue
        if (value === null || value === '') delete next[key]
        else next[key] = key === 'lastError' ? clip(value, ERROR_CHARS) : value
      }
      await this.save(projectId, { ...data, background: next })
      return { ...next }
    })
  }
}
