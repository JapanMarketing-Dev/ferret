/**
 * 動画の投稿（YouTube・TikTok）の純粋な部品。旧 Solocut の apps/desktop/src/shared/publish.ts を移したもの（仕様は Movie_ADE の docs/14）。
 *
 * - publish.json（AI が書き、人が確認する投稿の中身）の読み込み・制限の検査。例外を投げず、問題は「直すところ（error）」と「お知らせ（warning）」で返す
 * - CLI（`ferret-video publish upload`）⇄ アプリの受け渡しファイル（<動画>/.ferret-video/publish-request.json・publish-result.json・publish-log.json）の形
 * - 投稿画面の「OK・投稿する」の状態
 *
 * renderer と main の両方が使う（Electron にも Node の API にも依存しない）。
 */
import { t, type TranslationKey } from '@shared/i18n'
import { VIDEO_STATE_DIR } from '@video/names'

export const YT_TITLE_MAX = 100 // 文字（コードポイント）
export const YT_DESCRIPTION_MAX_BYTES = 5000
export const YT_TAGS_MAX = 500 // YouTube の数え方（区切りと、空白を含むタグの引用符も数える）
export const TIKTOK_CAPTION_MAX = 2200 // UTF-16 の単位
/** YouTube の thumbnails.set の上限 */
export const YT_THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024

export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length
}

/** YouTube の数え方の文字数（コードポイント） */
export function charCount(s: string): number {
  return [...s].length
}

export function tagsLength(tags: string[]): number {
  return tags.reduce((n, tag, i) => n + charCount(tag) + (/\s/.test(tag) ? 2 : 0) + (i > 0 ? 1 : 0), 0)
}

/** 自由な文（"a, b、#c"）からタグ。前後の空白と # を外し、大文字小文字を区別せず重複を除く */
export function parseTags(text: string): string[] {
  return cleanTags(text.split(/[,、\n]/))
}

function cleanTags(raw: unknown[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of raw) {
    if (typeof r !== 'string') continue
    const tag = r.trim().replace(/^#+/, '').trim()
    if (tag && !seen.has(tag.toLowerCase())) {
      seen.add(tag.toLowerCase())
      out.push(tag)
    }
  }
  return out
}

// ---------- publish.json ----------

export type PublishTargetId = 'youtube' | 'tiktok'
export const PUBLISH_TARGETS: readonly PublishTargetId[] = ['youtube', 'tiktok']
export const TARGET_LABEL: Record<PublishTargetId, string> = { youtube: 'YouTube', tiktok: 'TikTok' }
export const YT_PRIVACY = ['private', 'unlisted', 'public'] as const
export const TIKTOK_PRIVACY = ['SELF_ONLY', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'PUBLIC_TO_EVERYONE'] as const
export type YtPrivacy = (typeof YT_PRIVACY)[number]
export type TikTokPrivacy = (typeof TIKTOK_PRIVACY)[number]

/** `ferret-video render --final` の書き出し先 */
export const DEFAULT_VIDEO = 'renders/youtube/final.mp4'
export const PUBLISH_FILE = 'publish.json'

export interface PublishSpec {
  /** 動画のフォルダからの相対パス（/ 区切り） */
  video: string
  thumbnail?: string
  title: string
  description: string
  tags: string[]
  youtube: {
    enabled: boolean
    categoryId: string
    privacy: YtPrivacy
    /** publish.json に（正しい）youtube.privacy が無く、設定の既定を使った */
    privacyDefaulted: boolean
    /** ISO（正規化したもの） */
    publishAt?: string
    madeForKids: boolean
    containsSyntheticMedia: boolean
    chapters: boolean
    language: string
  }
  tiktok: {
    enabled: boolean
    caption: string
    privacy: TikTokPrivacy
    /** publish.json に（正しい）tiktok.privacy が無く、設定の既定を使った */
    privacyDefaulted: boolean
    allowComment: boolean
    allowDuet: boolean
    allowStitch: boolean
    isAigc: boolean
  }
}

export interface PublishIssue {
  /** error: その投稿先のアップロードを止める。warning: 表示だけ（既定値を使った など） */
  level: 'error' | 'warning'
  /** publish.json の中の場所（"$" はファイル全体） */
  field: string
  code: string
  /** 補足（上限・おかしな値） */
  detail?: string
}

/** 設定の publish.youtube.privacy / publish.tiktok.privacy。publish.json に書かれていないときに使う */
export interface PublishDefaults {
  youtubePrivacy: YtPrivacy
  tiktokPrivacy: TikTokPrivacy
}
export const BUILTIN_DEFAULTS: PublishDefaults = { youtubePrivacy: 'private', tiktokPrivacy: 'SELF_ONLY' }

/** 設定（~/.ferret/video/settings.json）から既定の公開範囲。おかしな値は安全な方（非公開・自分のみ）にする */
export function publishDefaultsFrom(settings: unknown): PublishDefaults {
  const pub = isObj(settings) && isObj(settings.publish) ? settings.publish : {}
  const yt = isObj(pub.youtube) ? pub.youtube.privacy : undefined
  const tt = isObj(pub.tiktok) ? pub.tiktok.privacy : undefined
  return {
    youtubePrivacy: typeof yt === 'string' && (YT_PRIVACY as readonly string[]).includes(yt) ? (yt as YtPrivacy) : BUILTIN_DEFAULTS.youtubePrivacy,
    tiktokPrivacy: typeof tt === 'string' && (TIKTOK_PRIVACY as readonly string[]).includes(tt) ? (tt as TikTokPrivacy) : BUILTIN_DEFAULTS.tiktokPrivacy
  }
}

export interface ParsedPublish {
  spec: PublishSpec | null
  issues: PublishIssue[]
}

type Dict = Record<string, unknown>
const isObj = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 動画のフォルダの中にとどまる相対パス。外へ出る・空・絶対パスは null */
export function safeRelPath(p: string): string | null {
  const s = p.trim().replace(/\\/g, '/')
  if (!s || s.startsWith('/') || /^[a-zA-Z]:/.test(s) || s.includes('\0')) return null
  const parts: string[] = []
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(seg)
  }
  return parts.length ? parts.join('/') : null
}

const KNOWN_TOP = new Set(['video', 'thumbnail', 'title', 'description', 'tags', 'youtube', 'tiktok', '$schema', 'notes'])
const KNOWN_YT = new Set(['enabled', 'categoryId', 'privacy', 'publishAt', 'madeForKids', 'containsSyntheticMedia', 'chapters', 'language'])
const KNOWN_TT = new Set(['enabled', 'caption', 'privacy', 'allowComment', 'allowDuet', 'allowStitch', 'isAigc'])

/**
 * publish.json を読む（文字列か、読み込み済みの値）。例外を投げない。使えない値は安全な既定（非公開・子ども向けではない・TikTok はオフ）に
 * してお知らせを出し、投稿先が断る値は「直すところ」にする。
 */
export function parsePublishJson(input: unknown, now = new Date(), defaults: PublishDefaults = BUILTIN_DEFAULTS): ParsedPublish {
  const issues: PublishIssue[] = []
  const err = (field: string, code: string, detail?: string) => issues.push({ level: 'error', field, code, ...(detail !== undefined ? { detail } : {}) })
  const warn = (field: string, code: string, detail?: string) => issues.push({ level: 'warning', field, code, ...(detail !== undefined ? { detail } : {}) })

  let raw: unknown = input
  if (typeof input === 'string') {
    const text = input.replace(/^﻿/, '')
    if (!text.trim()) return { spec: null, issues: [{ level: 'error', field: '$', code: 'empty' }] }
    try {
      raw = JSON.parse(text)
    } catch (e) {
      return { spec: null, issues: [{ level: 'error', field: '$', code: 'invalid-json', detail: e instanceof Error ? e.message : String(e) }] }
    }
  }
  if (!isObj(raw)) return { spec: null, issues: [{ level: 'error', field: '$', code: 'not-object' }] }
  for (const k of Object.keys(raw)) if (!KNOWN_TOP.has(k)) warn(k, 'unknown-field')

  const str = (v: unknown, field: string, fallback: string): string => {
    if (v === undefined || v === null) return fallback
    if (typeof v === 'string') return v
    if (typeof v === 'number' || typeof v === 'boolean') {
      warn(field, 'coerced')
      return String(v)
    }
    warn(field, 'wrong-type')
    return fallback
  }
  const bool = (v: unknown, field: string, fallback: boolean): boolean => {
    if (v === undefined || v === null) return fallback
    if (typeof v === 'boolean') return v
    if (v === 'true' || v === 'false') {
      warn(field, 'coerced')
      return v === 'true'
    }
    warn(field, 'wrong-type')
    return fallback
  }

  // ファイル
  let video = DEFAULT_VIDEO
  if (raw.video === undefined) warn('video', 'default', DEFAULT_VIDEO)
  else if (typeof raw.video !== 'string' || !safeRelPath(raw.video)) err('video', 'bad-path', String(raw.video))
  else video = safeRelPath(raw.video)!
  if (!/\.(mp4|mov|webm|m4v)$/i.test(video)) warn('video', 'not-video', video)

  let thumbnail: string | undefined
  if (raw.thumbnail !== undefined && raw.thumbnail !== null && raw.thumbnail !== '') {
    const rel = typeof raw.thumbnail === 'string' ? safeRelPath(raw.thumbnail) : null
    if (!rel) warn('thumbnail', 'bad-path', String(raw.thumbnail))
    else if (!/\.(png|jpe?g)$/i.test(rel)) warn('thumbnail', 'not-image', rel)
    else thumbnail = rel
  }

  // 共通の文
  const title = str(raw.title, 'title', '').trim()
  const description = str(raw.description, 'description', '').replace(/\r\n/g, '\n')
  let tags: string[] = []
  if (Array.isArray(raw.tags)) {
    if (raw.tags.some((x) => typeof x !== 'string')) warn('tags', 'wrong-type')
    tags = cleanTags(raw.tags)
  } else if (typeof raw.tags === 'string') {
    warn('tags', 'coerced')
    tags = parseTags(raw.tags)
  } else if (raw.tags !== undefined && raw.tags !== null) warn('tags', 'wrong-type')

  // YouTube
  const yt = raw.youtube === undefined || raw.youtube === null ? {} : isObj(raw.youtube) ? raw.youtube : (warn('youtube', 'wrong-type'), {})
  for (const k of Object.keys(yt)) if (!KNOWN_YT.has(k)) warn(`youtube.${k}`, 'unknown-field')
  const ytEnabled = bool(yt.enabled, 'youtube.enabled', true)
  let categoryId = str(yt.categoryId, 'youtube.categoryId', '28').trim()
  if (!/^\d{1,3}$/.test(categoryId)) {
    warn('youtube.categoryId', 'invalid', categoryId)
    categoryId = '28'
  }
  let privacy: YtPrivacy = defaults.youtubePrivacy
  let privacyDefaulted = true
  if (yt.privacy === undefined || yt.privacy === null) {
    if (ytEnabled) warn('youtube.privacy', 'default', privacy)
  } else if (typeof yt.privacy === 'string' && (YT_PRIVACY as readonly string[]).includes(yt.privacy.toLowerCase())) {
    privacy = yt.privacy.toLowerCase() as YtPrivacy
    privacyDefaulted = false
  } else warn('youtube.privacy', 'invalid', String(yt.privacy))
  let publishAt: string | undefined
  if (yt.publishAt !== undefined && yt.publishAt !== null && yt.publishAt !== '') {
    const at = typeof yt.publishAt === 'string' ? Date.parse(yt.publishAt) : NaN
    if (Number.isNaN(at)) err('youtube.publishAt', 'invalid', String(yt.publishAt))
    else if (at <= now.getTime()) err('youtube.publishAt', 'past', new Date(at).toISOString())
    else {
      publishAt = new Date(at).toISOString()
      if (privacy !== 'private') warn('youtube.privacy', 'scheduled-private', privacy)
      privacy = 'private' // YouTube が予約できるのは非公開の動画だけ
    }
  }
  const language = str(yt.language, 'youtube.language', 'ja').trim() || 'ja'

  if (ytEnabled) {
    if (!title) err('title', 'required')
    if (charCount(title) > YT_TITLE_MAX) err('title', 'too-long', `${charCount(title)}/${YT_TITLE_MAX}`)
    if (/[<>]/.test(title)) err('title', 'angle-brackets')
    if (utf8Bytes(description) > YT_DESCRIPTION_MAX_BYTES) err('description', 'too-long', `${utf8Bytes(description)}/${YT_DESCRIPTION_MAX_BYTES}`)
    if (/[<>]/.test(description)) err('description', 'angle-brackets')
    if (tagsLength(tags) > YT_TAGS_MAX) err('tags', 'too-long', `${tagsLength(tags)}/${YT_TAGS_MAX}`)
    if (tags.some((x) => /[<>]/.test(x))) err('tags', 'angle-brackets')
  }

  // TikTok
  const tt = raw.tiktok === undefined || raw.tiktok === null ? {} : isObj(raw.tiktok) ? raw.tiktok : (warn('tiktok', 'wrong-type'), {})
  for (const k of Object.keys(tt)) if (!KNOWN_TT.has(k)) warn(`tiktok.${k}`, 'unknown-field')
  const ttEnabled = bool(tt.enabled, 'tiktok.enabled', false)
  let caption = str(tt.caption, 'tiktok.caption', '')
  if (!caption.trim() && ttEnabled) {
    caption = [title, tags.map((x) => `#${x.replace(/\s+/g, '')}`).join(' ')].filter(Boolean).join('\n')
    warn('tiktok.caption', 'default')
  }
  let ttPrivacy: TikTokPrivacy = defaults.tiktokPrivacy
  let ttDefaulted = true
  if (tt.privacy !== undefined && tt.privacy !== null) {
    if (typeof tt.privacy === 'string' && (TIKTOK_PRIVACY as readonly string[]).includes(tt.privacy.toUpperCase())) {
      ttPrivacy = tt.privacy.toUpperCase() as TikTokPrivacy
      ttDefaulted = false
    } else warn('tiktok.privacy', 'invalid', String(tt.privacy))
  }
  if (ttEnabled && caption.length > TIKTOK_CAPTION_MAX) err('tiktok.caption', 'too-long', `${caption.length}/${TIKTOK_CAPTION_MAX}`)
  if (!ytEnabled && !ttEnabled) warn('$', 'no-target')

  const spec: PublishSpec = {
    video,
    ...(thumbnail ? { thumbnail } : {}),
    title,
    description,
    tags,
    youtube: {
      enabled: ytEnabled,
      categoryId,
      privacy,
      privacyDefaulted,
      ...(publishAt ? { publishAt } : {}),
      madeForKids: bool(yt.madeForKids, 'youtube.madeForKids', false),
      containsSyntheticMedia: bool(yt.containsSyntheticMedia, 'youtube.containsSyntheticMedia', false),
      chapters: bool(yt.chapters, 'youtube.chapters', true),
      language
    },
    tiktok: {
      enabled: ttEnabled,
      caption,
      privacy: ttPrivacy,
      privacyDefaulted: ttDefaulted,
      allowComment: bool(tt.allowComment, 'tiktok.allowComment', false),
      allowDuet: bool(tt.allowDuet, 'tiktok.allowDuet', false),
      allowStitch: bool(tt.allowStitch, 'tiktok.allowStitch', false),
      isAigc: bool(tt.isAigc, 'tiktok.isAigc', false)
    }
  }
  return { spec, issues }
}

/** どの問題がどの投稿先を止めるか。パス・ファイルの問題はすべてを止める */
export function issueBlocks(issue: PublishIssue, target: PublishTargetId): boolean {
  if (issue.level !== 'error') return false
  if (issue.field === '$' || issue.field === 'video') return true
  if (issue.field.startsWith('tiktok.')) return target === 'tiktok'
  return target === 'youtube' // title / description / tags / youtube.*
}

/** publish.json でオンの投稿先。頼まれた投稿先があればそのうち publish.json がオフにしていないものだけ */
export function targetsToUpload(spec: PublishSpec, requested: readonly PublishTargetId[] = []): PublishTargetId[] {
  const on = PUBLISH_TARGETS.filter((x) => spec[x].enabled)
  return requested.length ? on.filter((x) => requested.includes(x)) : on
}

/** サムネイルを差し替えた publish.json（書き戻す値。知らない項目は残す） */
export function withThumbnail(original: unknown, rel: string | null): Dict {
  const base: Dict = isObj(original) ? { ...original } : {}
  if (rel) base.thumbnail = rel
  else delete base.thumbnail
  return base
}

/** 1つの投稿先の公開範囲を書いた publish.json（知らない項目は残す）。値が正しくなければ null */
export function withPrivacy(original: unknown, target: PublishTargetId, value: string): Dict | null {
  const ok = target === 'youtube' ? (YT_PRIVACY as readonly string[]).includes(value) : (TIKTOK_PRIVACY as readonly string[]).includes(value)
  if (!ok) return null
  const base: Dict = isObj(original) ? { ...original } : {}
  base[target] = { ...(isObj(base[target]) ? (base[target] as Dict) : {}), privacy: value }
  return base
}

/** videos.insert の本文（part=snippet,status）。予約は privacyStatus private ＋ publishAt */
export function youtubeVideoResource(s: PublishSpec): Record<string, unknown> {
  const status: Record<string, unknown> = {
    privacyStatus: s.youtube.publishAt ? 'private' : s.youtube.privacy,
    selfDeclaredMadeForKids: s.youtube.madeForKids,
    containsSyntheticMedia: s.youtube.containsSyntheticMedia
  }
  if (s.youtube.publishAt) status.publishAt = s.youtube.publishAt
  return {
    snippet: {
      title: s.title,
      description: s.description,
      tags: s.tags,
      categoryId: s.youtube.categoryId,
      defaultLanguage: s.youtube.language,
      defaultAudioLanguage: s.youtube.language
    },
    status
  }
}

export interface Chapter {
  /** 秒 */
  at: number
  label: string
  title: string
}

/** 説明文のチャプター（行頭の 00:00 / 1:02:03 とその後ろの文）。YouTube と同じく行頭の時刻だけを見る */
export function chaptersFromDescription(description: string): Chapter[] {
  const out: Chapter[] = []
  for (const line of description.split('\n')) {
    const m = /^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s+[-–—:|]?\s*(.+?)\s*$/.exec(line)
    if (!m) continue
    const h = Number(m[1] ?? 0)
    const min = Number(m[2])
    const sec = Number(m[3])
    if (sec > 59 || (m[1] !== undefined && min > 59)) continue
    out.push({ at: h * 3600 + min * 60 + sec, label: `${m[1] !== undefined ? `${m[1]}:` : ''}${m[2]}:${m[3]}`, title: m[4]! })
  }
  return out
}

/** YouTube がチャプターとして扱う条件（最初が 0:00・3つ以上・時刻が増えていく・それぞれ10秒以上） */
export function chaptersValid(chapters: readonly Chapter[]): boolean {
  if (chapters.length < 3 || chapters[0]!.at !== 0) return false
  for (let i = 1; i < chapters.length; i++) if (chapters[i]!.at - chapters[i - 1]!.at < 10) return false
  return true
}

const ISSUE_CODES = [
  'empty', 'invalid-json', 'not-object', 'unknown-field', 'coerced', 'wrong-type', 'default', 'bad-path', 'not-video', 'not-image',
  'required', 'too-long', 'angle-brackets', 'invalid', 'past', 'scheduled-private', 'no-target', 'missing', 'chapters'
] as const

/** 問題の1行（今の言語）。知らないコードはそのまま出す */
export function issueText(i: PublishIssue): string {
  const m = (ISSUE_CODES as readonly string[]).includes(i.code) ? t(`video.publish.issue.${i.code}` as TranslationKey) : i.code
  return `${i.field === '$' ? PUBLISH_FILE : i.field}: ${m}${i.detail ? ` (${i.detail})` : ''}`
}

// ---------- アップロードの受け渡し（CLI ⇄ アプリ） ----------

export const REQUEST_FILE = `${VIDEO_STATE_DIR}/publish-request.json`
export const RESULT_FILE = `${VIDEO_STATE_DIR}/publish-result.json`
export const PUBLISH_LOG_FILE = `${VIDEO_STATE_DIR}/publish-log.json`
/** この時間までにアプリが受け取らなかった頼みは無視する（CLI はとうにあきらめている） */
export const REQUEST_TTL_MS = 10 * 60_000
/** CLI がアプリの受け取りを待つ時間（これを過ぎると app-not-running で頼みを取り下げる） */
export const PICKUP_MS = 30_000

export interface PublishRequest {
  id: string
  /** 空なら publish.json でオンの投稿先すべて */
  targets: PublishTargetId[]
  at: string
  /** その投稿先に同じ動画を上げ済みでも、もう一度上げる */
  force?: boolean
}

export interface PublishTargetResult {
  target: PublishTargetId
  ok: boolean
  url?: string
  error?: string
  /** youtube: published | scheduled、tiktok: inbox（TikTok アプリの下書き） | published */
  status?: 'published' | 'scheduled' | 'inbox' | 'skipped'
  /** 上げ直していない（publish-log.json に同じ動画がある） */
  alreadyPublished?: boolean
  warnings?: string[]
}

export interface PublishResult {
  id: string
  /** running: アプリが受け取った（進み具合が続く）。done: 結果が決まった */
  state: 'running' | 'done'
  at: string
  progress?: { target: PublishTargetId; phase: string; fraction?: number }
  results: PublishTargetResult[]
  /** 何も上げなかった理由（publish.json が無い・投稿先がオフ など） */
  error?: string
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/

export function isRequestId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v)
}

function parseJsonish(input: unknown): unknown {
  if (typeof input !== 'string') return input
  try {
    return JSON.parse(input.replace(/^﻿/, ''))
  } catch {
    return null
  }
}

export function parsePublishRequest(input: unknown): PublishRequest | null {
  const o = parseJsonish(input)
  if (!isObj(o) || !isRequestId(o.id)) return null
  const targets = Array.isArray(o.targets) ? [...new Set(o.targets.filter((x): x is PublishTargetId => (PUBLISH_TARGETS as readonly unknown[]).includes(x)))] : []
  if (Array.isArray(o.targets) && o.targets.length > 0 && targets.length === 0) return null // 知らない投稿先だけ
  const at = typeof o.at === 'string' && !Number.isNaN(Date.parse(o.at)) ? o.at : ''
  if (!at) return null
  return { id: o.id, targets, at, ...(o.force === true ? { force: true } : {}) }
}

export function parsePublishResult(input: unknown): PublishResult | null {
  const o = parseJsonish(input)
  if (!isObj(o) || !isRequestId(o.id)) return null
  const results: PublishTargetResult[] = []
  for (const r of Array.isArray(o.results) ? o.results : []) {
    if (!isObj(r) || !(PUBLISH_TARGETS as readonly unknown[]).includes(r.target) || typeof r.ok !== 'boolean') continue
    const x: PublishTargetResult = { target: r.target as PublishTargetId, ok: r.ok }
    if (typeof r.url === 'string') x.url = r.url
    if (typeof r.error === 'string') x.error = r.error
    if (r.status === 'published' || r.status === 'scheduled' || r.status === 'inbox' || r.status === 'skipped') x.status = r.status
    if (r.alreadyPublished === true) x.alreadyPublished = true
    if (Array.isArray(r.warnings)) x.warnings = r.warnings.filter((w): w is string => typeof w === 'string')
    results.push(x)
  }
  const state = o.state === 'running' ? 'running' : 'done' // state の無い結果（最小の形）は確定とみなす
  const out: PublishResult = { id: o.id, state, at: typeof o.at === 'string' ? o.at : '', results }
  if (typeof o.error === 'string' && o.error) out.error = o.error
  if (isObj(o.progress) && (PUBLISH_TARGETS as readonly unknown[]).includes(o.progress.target)) {
    const p = o.progress
    out.progress = { target: p.target as PublishTargetId, phase: typeof p.phase === 'string' ? p.phase : '', ...(typeof p.fraction === 'number' && Number.isFinite(p.fraction) ? { fraction: Math.max(0, Math.min(1, p.fraction)) } : {}) }
  }
  return out
}

export function requestIsStale(req: PublishRequest, nowMs: number): boolean {
  const at = Date.parse(req.at)
  return Number.isNaN(at) || nowMs - at > REQUEST_TTL_MS
}

/** 全体の成否。全部の投稿先が ok（空の結果は失敗: 何も投稿していない） */
export function resultOk(r: PublishResult): boolean {
  return r.state === 'done' && r.results.length > 0 && r.results.every((x) => x.ok)
}

// ---------- 投稿の記録（二重投稿の防止） ----------

export interface PublishLogEntry {
  target: PublishTargetId
  /** 動画のフォルダからの相対パス */
  video: string
  size: number
  url?: string
  status: PublishTargetResult['status']
  requestId: string
  at: string
}

export function parsePublishLog(input: unknown): PublishLogEntry[] {
  const o = parseJsonish(input)
  const arr = isObj(o) && Array.isArray(o.entries) ? o.entries : []
  return arr.filter(
    (e): e is PublishLogEntry =>
      isObj(e) && (PUBLISH_TARGETS as readonly unknown[]).includes(e.target) && typeof e.video === 'string' && typeof e.size === 'number' && typeof e.requestId === 'string'
  )
}

/** 同じファイル（パスと大きさ）をその投稿先へ上げた前の記録。無ければ null */
export function alreadyPublished(log: readonly PublishLogEntry[], target: PublishTargetId, video: string, size: number): PublishLogEntry | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]!
    if (e.target === target && e.video === video && e.size === size) return e
  }
  return null
}

// ---------- 再開可能アップロード ----------

/** 再開可能アップロードの 308 の Range（"bytes=0-12345"）から次に送るバイト。受け取りが無ければ 0 */
export function nextOffsetFromRange(range: string | null | undefined): number {
  const m = /bytes=0-(\d+)/.exec(range ?? '')
  return m ? Number(m[1]) + 1 : 0
}

/** 再開可能アップロードの1回の大きさ（256 KiB の倍数） */
export const UPLOAD_CHUNK = 8 * 1024 * 1024

export const TIKTOK_UPLOAD_PAGE = 'https://www.tiktok.com/tiktokstudio/upload'

// ---------- 画面・接続（IPC の形） ----------

export interface VideoPublishState {
  /** publish.json がある */
  exists: boolean
  spec: PublishSpec | null
  issues: PublishIssue[]
  /** 動画・サムネイルがあるとき、今開いているチャンネルからの相対パス（ade-media://project/ で見せる） */
  videoMedia?: string
  thumbnailMedia?: string
  /** 動画の大きさ（バイト）。中身が変わったら画面の再生を読み直すのに使う */
  videoSize?: number
  request: PublishRequest | null
  result: PublishResult | null
  log: PublishLogEntry[]
  /** この動画（パスと大きさ）が上がっている投稿先 */
  published: Partial<Record<PublishTargetId, PublishLogEntry>>
}

export interface VideoPublishAccount {
  /** クライアント ID / キーが組み込まれている（開発中は環境変数） */
  configured: boolean
  connected: boolean
  /** チャンネル名・表示名 */
  name?: string
  /** tiktok: そのまま投稿する（そうでなければ TikTok アプリの受信トレイに下書きとして届く） */
  directPost?: boolean
}

export interface VideoPublishAccounts {
  youtube: VideoPublishAccount
  tiktok: VideoPublishAccount
  /** 接続を暗号化して保存できる（false なら起動中だけ覚える） */
  persisted: boolean
}

export interface VideoThumbFile {
  /** 動画のフォルダからの相対パス（thumbnails/…） */
  rel: string
  /** 今開いているチャンネルからの相対パス */
  media: string
  mtimeMs: number
}

// ---------- 「OK・投稿する」 ----------

export type OkState =
  | { kind: 'ready'; targets: PublishTargetId[] }
  | { kind: 'no-file' }
  | { kind: 'no-video' }
  | { kind: 'no-target' }
  | { kind: 'connect'; target: PublishTargetId }
  | { kind: 'sent' }
  | { kind: 'running' }
  | { kind: 'published' }

/** OK を押したあと、エージェントがアップロードを始めるのを待つ時間（その間は押せない） */
export const SENT_HOLD_MS = 3 * 60_000
/** running のまま残った結果を「アップロード中」とみなす時間 */
export const RUNNING_HOLD_MS = 30 * 60_000

/**
 * 今の「OK・投稿する」。publish.json の問題では止めない（投稿プロンプトでエージェントが先に直す）。
 * 同じファイルを上げ済みの投稿先には投稿しない。
 */
export function okState(view: VideoPublishState | null, accounts: Omit<VideoPublishAccounts, 'persisted'> | null, sentAt: number | null, nowMs: number): OkState {
  if (!view || !view.exists || !view.spec) return { kind: 'no-file' }
  if (view.result && view.result.state === 'running' && (!view.request || view.request.id === view.result.id) && nowMs - (Date.parse(view.result.at) || 0) < RUNNING_HOLD_MS) return { kind: 'running' }
  if (sentAt !== null && nowMs - sentAt < SENT_HOLD_MS) return { kind: 'sent' }
  if (!view.videoMedia) return { kind: 'no-video' }
  const on = PUBLISH_TARGETS.filter((x) => view.spec![x].enabled)
  if (!on.length) return { kind: 'no-target' }
  const todo = on.filter((x) => !view.published[x])
  if (!todo.length) return { kind: 'published' }
  if (todo.includes('youtube') && accounts && !accounts.youtube.connected) return { kind: 'connect', target: 'youtube' }
  if (todo.includes('tiktok') && accounts && accounts.tiktok.configured && !accounts.tiktok.connected) return { kind: 'connect', target: 'tiktok' }
  return { kind: 'ready', targets: todo }
}

/** 「AI に直してもらう」の一言（空なら見直しを頼む）。長すぎる一言は切る */
export function fixInstruction(input: string): string {
  return input.trim().replace(/\s+/g, ' ').slice(0, 500)
}
