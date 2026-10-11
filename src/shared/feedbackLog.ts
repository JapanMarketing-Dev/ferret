import type { Project } from './types'
import type { ProgressMap } from './findingProgress'
import { isOrchestra, orchestraIdOf, orchestraMembers } from './orchestras'

/**
 * オーケストラのフィードバックの知見（<オーケストラ>/feedback/）。人が Agent に送ったフィードバックを残し、
 * Agent がそこからプレイブック（feedback/playbook.md）をまとめて、次のプロダクトでは同じフィードバックを人に繰り返させない。
 *
 * 中心はレビューの指摘ごとの「1組」：
 *   1. 人が枠・ペンを描いた画像（レビューの静止画を feedback/images/ に写す）と、枠の位置（bbox・形）
 *   2. 指摘の文（見出し・要望・発話や書き込み）
 *   3. Agent がどう直したか（progress.json の状態・ひとこと・AFTER の画像）
 *   4. それに人がどう反応したか（OK / NG / コメントと時刻。OK の後の NG ＝やり直しも）
 * 指摘はレビューの id と指摘の id で引き、送った → 直した → 人が反応した、の段階ごとに更新する。
 * ほかに、文で送ったもの・依頼の雛形・human.md の答えも1件ずつ残す。
 *
 * 置き方：feedback/log.jsonl に出来事を1行ずつ足すだけ（書き直さないので、途中で落ちても前の行は壊れない）。
 * 人と Agent が読む feedback/log.md は、log.jsonl を指摘ごとにまとめ直して毎回書き直す（renderFeedbackLog）。
 * 出来事の列にしたのは、段階が後から何度も来る（NG → 直し直し → OK → 再び NG）のを、上書きせず順に残すため。
 * Electron に依存しない純粋な処理だけを置く（書き込み・画像の写しは src/main/feedbackLog.ts）
 */

export const FEEDBACK_DIR = 'feedback'
export const FEEDBACK_EVENTS_FILE = 'log.jsonl'
export const FEEDBACK_LOG_FILE = 'log.md'
export const PLAYBOOK_FILE = 'playbook.md'
export const FEEDBACK_IMAGES_DIR = 'images'
/** オーケストラのフォルダからの相対パス（画面で開く・指示文に使う） */
export const FEEDBACK_LOG_PATH = `${FEEDBACK_DIR}/${FEEDBACK_LOG_FILE}`
export const PLAYBOOK_PATH = `${FEEDBACK_DIR}/${PLAYBOOK_FILE}`

/** 1件の文の上限（UTF-8 のバイト数）。超えた分は切って印を付ける */
export const MAX_FEEDBACK_ENTRY_BYTES = 8 * 1024
export const TRUNCATED_MARKER = '…[truncated by Ferret]'
/** 1つの指摘から写す画像の数と、1枚の大きさの上限（超えるものは写さず、無いものとして記録する） */
export const MAX_FINDING_IMAGES = 4
export const MAX_FEEDBACK_IMAGE_BYTES = 3 * 1024 * 1024
/** 1つの指摘に残す枠の数 */
const MAX_FRAMES = 20
/** 1つの指摘の経過（直した・反応した）の数。古いものから捨てる */
const MAX_TIMELINE = 100

/** どの経路で送ったか。review: レビューの指摘、text: 文で送ったもの、request: 依頼の雛形、answers: human.md の答え */
export type FeedbackChannel = 'review' | 'text' | 'request' | 'answers'
export const FEEDBACK_CHANNELS: readonly FeedbackChannel[] = ['review', 'text', 'request', 'answers']

/** 人が描いた枠1つ。bbox は [x, y, w, h]（録画の画面の座標）、view はそのときの画面の大きさ */
export interface FeedbackFrame {
  bbox: [number, number, number, number]
  shape: 'rect' | 'pen'
  view?: { w: number; h: number }
}

/** 送った指摘（1組の 1 と 2） */
export interface FindingSentEvent {
  v: 1
  type: 'finding'
  at: string
  /** <projectId>:<reviewId>/<findingId> */
  key: string
  projectId: string
  product: string
  reviewId: string
  findingId: string
  /** feedback.md の見出しの番号 */
  index: number
  title: string
  request: string
  /** 発話・書き込み（話した人と文） */
  quotes: Array<{ speaker: string; text: string }>
  url?: string
  /** feedback/ からの相対パス（images/…png）。写せなかったものは入れない */
  images: string[]
  /** 写せなかった画像の数（大きすぎる・消えた） */
  missingImages?: number
  frames: FeedbackFrame[]
  /** レビューのフォルダ（元の録画・feedback.md をたどる） */
  reviewDir?: string
}

/** Agent が直した（1組の 3）。progress.json の human_review / done を見たとき */
export interface FindingFixEvent {
  v: 1
  type: 'fix'
  at: string
  key: string
  status: 'human_review' | 'done'
  note?: string
  /** 直したあとの画像（feedback/ からの相対パス）。無ければ無い */
  after?: string
}

/** 人の反応（1組の 4）。progress.json の history（OK / NG / Comment）から */
export interface FindingReactionEvent {
  v: 1
  type: 'reaction'
  /** 人が判断した時刻（history の at） */
  at: string
  key: string
  verdict: 'ok' | 'ng' | 'comment'
  text?: string
}

/** 文・依頼・答え（レビューの指摘でないもの。レビューの差し替えの本文もここ） */
export interface FeedbackMessageEvent {
  v: 1
  type: 'message'
  at: string
  product: string
  channel: FeedbackChannel
  text: string
  reviewId?: string
}

export type FeedbackEvent = FindingSentEvent | FindingFixEvent | FindingReactionEvent | FeedbackMessageEvent

// ───────────── 文の整え ─────────────

/**
 * UTF-8 で maxBytes に収める。切ったら末尾に印を付ける（印も含めて収める）。サロゲートペアの途中では切らない。
 * maxBytes が印より小さいなら印だけ（それでも切ったことは分かる）
 */
export function truncateUtf8(text: string, maxBytes: number = MAX_FEEDBACK_ENTRY_BYTES): { text: string; truncated: boolean } {
  const encoder = new TextEncoder()
  if (encoder.encode(text).length <= maxBytes) return { text, truncated: false }
  const suffix = `\n${TRUNCATED_MARKER}`
  const budget = maxBytes - encoder.encode(suffix).length
  if (budget <= 0) return { text: TRUNCATED_MARKER, truncated: true }
  let bytes = 0
  let end = 0
  for (const ch of text) {
    // コードポイントごとに数える（for…of はサロゲートペアを1文字として回る）
    const size = encoder.encode(ch).length
    if (bytes + size > budget) break
    bytes += size
    end += ch.length
  }
  return { text: `${text.slice(0, end).replace(/\s+$/, '')}${suffix}`, truncated: true }
}

/** 記録に入れる文（改行をそろえ、前後の空白を落とし、上限で切る） */
export function cleanText(text: string, maxBytes = MAX_FEEDBACK_ENTRY_BYTES): string {
  return truncateUtf8(String(text ?? '').replace(/\r\n?/g, '\n').replace(/^\s+|\s+$/g, ''), maxBytes).text
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * 記録の時刻。その地域の時刻と時差（例 `2026-10-11 14:03 +09:00`）。
 * offsetMinutes は UTC からの進み（日本は +540）。テストのために渡せる。既定はその時刻の地域の時差
 */
export function formatFeedbackTime(at: Date | string, offsetMinutes?: number): string {
  const date = typeof at === 'string' ? new Date(at) : at
  if (Number.isNaN(date.getTime())) return 'unknown time'
  const offset = offsetMinutes ?? -date.getTimezoneOffset()
  const local = new Date(date.getTime() + offset * 60_000)
  const sign = offset < 0 ? '-' : '+'
  const abs = Math.abs(offset)
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())} ${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** 見出し・箇条書きに入れる1行（改行・制御文字を空白に、長すぎるものは切る） */
export function oneLine(text: string, max = 200): string {
  const line = String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** 本文を囲むフェンス。本文の中のいちばん長いバッククォートの並びより長くする（最低3つ） */
function fenceFor(text: string): string {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return '`'.repeat(Math.max(3, longest + 1))
}

function fenced(text: string): string[] {
  const body = text || '(empty)'
  const fence = fenceFor(body)
  return [`${fence}text`, body, fence]
}

/** ファイル名に使える形（英数字・_・- だけ。長すぎるものは切る） */
export function fileSafe(text: string, max = 40): string {
  return (String(text ?? '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max)) || 'x'
}

export function findingKey(projectId: string, reviewId: string, findingId: string): string {
  return `${projectId}:${reviewId}/${findingId}`
}

/** 写した指摘の画像の名前（feedback/ からの相対パス） */
export function findingImageName(projectId: string, reviewId: string, findingId: string, n: number): string {
  return `${FEEDBACK_IMAGES_DIR}/${fileSafe(projectId, 8)}-${fileSafe(reviewId)}-${fileSafe(findingId)}-${n}.png`
}

/** 写した AFTER の画像の名前。直し直すたびに n が増える（同じ after/i2.png が上書きされても前のものを残す） */
export function afterImageName(projectId: string, reviewId: string, findingId: string, n: number, ext = 'png'): string {
  const safeExt = /^(png|jpe?g|webp|gif)$/i.test(ext) ? ext.toLowerCase() : 'png'
  return `${FEEDBACK_IMAGES_DIR}/${fileSafe(projectId, 8)}-${fileSafe(reviewId)}-${fileSafe(findingId)}-after-${n}.${safeExt}`
}

// ───────────── 送った指摘を記録の形にする ─────────────

interface PenLike { type?: unknown; id?: unknown; bbox?: unknown; shape?: unknown; view?: unknown }

/** レビューの操作ログから、その指摘に紐づく枠・ペン（annotationIds）の位置と形を拾う。壊れた値は捨てる */
export function penFrames(events: readonly unknown[], annotationIds: readonly string[]): FeedbackFrame[] {
  const wanted = new Set(annotationIds)
  const out: FeedbackFrame[] = []
  for (const raw of events) {
    if (out.length >= MAX_FRAMES) break
    const e = raw as PenLike
    if (!e || typeof e !== 'object' || e.type !== 'pen' || typeof e.id !== 'string' || !wanted.has(e.id)) continue
    const box = Array.isArray(e.bbox) && e.bbox.length === 4 && e.bbox.every((n) => typeof n === 'number' && Number.isFinite(n)) ? e.bbox as [number, number, number, number] : null
    if (!box) continue
    const v = e.view as { w?: unknown; h?: unknown } | undefined
    const view = v && typeof v.w === 'number' && typeof v.h === 'number' && v.w > 0 && v.h > 0 ? { w: Math.round(v.w), h: Math.round(v.h) } : undefined
    out.push({ bbox: box.map((n) => Math.round(n)) as [number, number, number, number], shape: e.shape === 'rect' ? 'rect' : 'pen', ...(view ? { view } : {}) })
  }
  return out
}

export interface SentFindingInput {
  at: string
  projectId: string
  product: string
  reviewId: string
  reviewDir?: string
  item: {
    id: string
    index: number
    title: string
    request: string
    quotes: ReadonlyArray<{ speaker: string; text: string; name?: string }>
    context: { url?: string }
  }
  images: string[]
  missingImages: number
  frames: FeedbackFrame[]
}

/** 送った指摘1件の出来事（文は上限で切る） */
export function findingSentEvent(input: SentFindingInput): FindingSentEvent {
  const it = input.item
  const quotes = it.quotes.slice(0, 30).map((q) => ({ speaker: oneLine(q.name || q.speaker, 40) || 'self', text: cleanText(q.text, 2048) })).filter((q) => q.text)
  return {
    v: 1, type: 'finding', at: input.at,
    key: findingKey(input.projectId, input.reviewId, it.id),
    projectId: input.projectId, product: oneLine(input.product, 120), reviewId: input.reviewId, findingId: it.id, index: it.index,
    title: cleanText(it.title, 1024), request: cleanText(it.request), quotes,
    ...(it.context.url ? { url: oneLine(it.context.url, 1000) } : {}),
    images: input.images.slice(0, MAX_FINDING_IMAGES),
    ...(input.missingImages > 0 ? { missingImages: input.missingImages } : {}),
    frames: input.frames.slice(0, MAX_FRAMES),
    ...(input.reviewDir ? { reviewDir: input.reviewDir } : {})
  }
}

export function messageEvent(input: { at: string; product: string; channel: FeedbackChannel; text: string; reviewId?: string }): FeedbackMessageEvent | null {
  const text = cleanText(input.text)
  if (!text) return null
  return {
    v: 1, type: 'message', at: input.at, product: oneLine(input.product, 120),
    channel: FEEDBACK_CHANNELS.includes(input.channel) ? input.channel : 'text', text,
    ...(input.reviewId ? { reviewId: oneLine(input.reviewId, 80) } : {})
  }
}

// ───────────── log.jsonl を読む・まとめる ─────────────

const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const isStr = (v: unknown): v is string => typeof v === 'string'

/** 1行を出来事として読む。形の合わないもの・知らない種類は null（書きかけの行・手で書き換えた行） */
export function parseFeedbackEvent(raw: unknown): FeedbackEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const e = raw as Record<string, unknown>
  if (e.v !== 1 || !isIso(e.at)) return null
  if (e.type === 'finding') {
    if (!isStr(e.key) || !isStr(e.projectId) || !isStr(e.reviewId) || !isStr(e.findingId) || !isStr(e.title) || !isStr(e.request)) return null
    return {
      v: 1, type: 'finding', at: e.at, key: e.key, projectId: e.projectId, reviewId: e.reviewId, findingId: e.findingId, title: e.title, request: e.request,
      ...(isStr(e.url) ? { url: e.url } : {}),
      ...(isStr(e.reviewDir) ? { reviewDir: e.reviewDir } : {}),
      ...(typeof e.missingImages === 'number' && e.missingImages > 0 ? { missingImages: Math.floor(e.missingImages) } : {}),
      product: isStr(e.product) ? e.product : '',
      index: typeof e.index === 'number' && Number.isFinite(e.index) ? e.index : 0,
      quotes: Array.isArray(e.quotes) ? e.quotes.filter((q): q is { speaker: string; text: string } => !!q && typeof q === 'object' && isStr((q as { text?: unknown }).text)).map((q) => ({ speaker: isStr(q.speaker) ? q.speaker : 'self', text: q.text })) : [],
      images: Array.isArray(e.images) ? e.images.filter(isSafeImagePath) : [],
      frames: Array.isArray(e.frames) ? penFrames(e.frames.map((f) => ({ ...(f && typeof f === 'object' ? f : {}), type: 'pen', id: 'f' })), ['f']) : []
    }
  }
  if (e.type === 'fix') {
    if (!isStr(e.key) || (e.status !== 'human_review' && e.status !== 'done')) return null
    return { v: 1, type: 'fix', at: e.at, key: e.key, status: e.status, ...(isStr(e.note) ? { note: e.note } : {}), ...(isSafeImagePath(e.after) ? { after: e.after } : {}) }
  }
  if (e.type === 'reaction') {
    if (!isStr(e.key) || (e.verdict !== 'ok' && e.verdict !== 'ng' && e.verdict !== 'comment')) return null
    return { v: 1, type: 'reaction', at: e.at, key: e.key, verdict: e.verdict, ...(isStr(e.text) ? { text: e.text } : {}) }
  }
  if (e.type === 'message') {
    if (!isStr(e.text) || !FEEDBACK_CHANNELS.includes(e.channel as FeedbackChannel)) return null
    return { v: 1, type: 'message', at: e.at, product: isStr(e.product) ? e.product : '', channel: e.channel as FeedbackChannel, text: e.text, ...(isStr(e.reviewId) ? { reviewId: e.reviewId } : {}) }
  }
  return null
}

/** 画像の相対パスとして安全か（images/ の下のファイル名だけ。上へ出る・絶対パスは不可） */
function isSafeImagePath(v: unknown): v is string {
  return typeof v === 'string' && new RegExp(`^${FEEDBACK_IMAGES_DIR}/[A-Za-z0-9_-]+\\.(png|jpe?g|webp|gif)$`, 'i').test(v)
}

/** log.jsonl の中身を出来事の列にする。壊れた行は飛ばす */
export function parseFeedbackEvents(text: string): FeedbackEvent[] {
  const out: FeedbackEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = parseFeedbackEvent(JSON.parse(line))
      if (e) out.push(e)
    } catch { /* 書きかけ・手で壊した行は読み飛ばす */ }
  }
  return out
}

export type TimelineStep =
  | { kind: 'sent'; at: string }
  | { kind: 'fix'; at: string; status: 'human_review' | 'done'; note?: string; after?: string }
  | { kind: 'reaction'; at: string; verdict: 'ok' | 'ng' | 'comment'; text?: string }

export interface FindingRecord {
  kind: 'finding'
  key: string
  finding: FindingSentEvent
  /** 送った（2回目から）・直した・反応した、の順 */
  timeline: TimelineStep[]
}

export interface MessageRecord {
  kind: 'message'
  message: FeedbackMessageEvent
}

export interface FeedbackState {
  /** 最初に現れた順 */
  records: Array<FindingRecord | MessageRecord>
  findings: Map<string, FindingRecord>
}

/**
 * 出来事の列を、指摘ごとの1組と、ほかのフィードバックにまとめる。
 * まだ送っていない指摘への fix・reaction（記録の前に送ったレビューなど）は捨てる。同じ指摘を送り直したら、中身を新しくして経過に「送り直した」を足す
 */
export function foldFeedback(events: readonly FeedbackEvent[]): FeedbackState {
  const records: FeedbackState['records'] = []
  const findings = new Map<string, FindingRecord>()
  for (const e of events) {
    if (e.type === 'message') { records.push({ kind: 'message', message: e }); continue }
    if (e.type === 'finding') {
      const current = findings.get(e.key)
      if (current) {
        current.finding = e
        current.timeline = [...current.timeline, { kind: 'sent' as const, at: e.at }].slice(-MAX_TIMELINE)
      } else {
        const record: FindingRecord = { kind: 'finding', key: e.key, finding: e, timeline: [] }
        findings.set(e.key, record)
        records.push(record)
      }
      continue
    }
    const record = findings.get(e.key)
    if (!record) continue
    const step: TimelineStep = e.type === 'fix'
      ? { kind: 'fix', at: e.at, status: e.status, ...(e.note ? { note: e.note } : {}), ...(e.after ? { after: e.after } : {}) }
      : { kind: 'reaction', at: e.at, verdict: e.verdict, ...(e.text ? { text: e.text } : {}) }
    record.timeline = [...record.timeline, step].slice(-MAX_TIMELINE)
  }
  return { records, findings }
}

/** まだ記録していない「直した」。AFTER の画像は main が写して after に入れる（afterSource はレビューのフォルダからの相対パス） */
export interface PendingFix {
  type: 'pendingFix'
  key: string
  findingId: string
  status: 'human_review' | 'done'
  note?: string
  afterSource?: string
  /** その指摘で何回目の直しか（1 から。AFTER の画像の名前に使う） */
  n: number
}

type FixStep = Extract<TimelineStep, { kind: 'fix' }>

/** 最後に「送った」か人の NG があったあとの段階（そこから先が今の直しの回） */
function sinceReset(steps: readonly TimelineStep[]): TimelineStep[] {
  let at = -1
  steps.forEach((s, i) => { if (s.kind === 'sent' || (s.kind === 'reaction' && s.verdict === 'ng')) at = i })
  return steps.slice(at + 1)
}

/**
 * progress.json の今の値から、まだ記録していない段階を拾う（記録した指摘だけ）。並びは起きた順。
 * - 反応：history の判断のうち、最後に記録した反応より新しいもの（時刻で比べる。同じものは重ねない）
 * - 直した：状態が human_review で、今の回（最後の送信・NG のあと）に同じひとこと・AFTER の有無の直しをまだ記録していないもの。
 *   人の OK の付いた done は、今の回に直しを1つも記録していなければ（見ないうちに直して OK されたとき）1つ足す。
 *   NG のあと直し直したものは、同じ AFTER のパスでも新しい直しとして数える（画像は回ごとに別の名前で写す）
 * 新しい反応に NG があり、今が human_review なら、直したのは NG のあと（反応の後ろに置く）。それ以外は直してから人が反応した（前に置く）
 */
export function progressChanges(state: FeedbackState, projectId: string, reviewId: string, progress: ProgressMap): Array<PendingFix | FindingReactionEvent> {
  const out: Array<PendingFix | FindingReactionEvent> = []
  for (const [findingId, entry] of Object.entries(progress)) {
    const key = findingKey(projectId, reviewId, findingId)
    const record = state.findings.get(key)
    if (!record || !entry) continue
    const lastReaction = [...record.timeline].reverse().find((s) => s.kind === 'reaction')
    const fresh: FindingReactionEvent[] = (entry.history ?? [])
      .filter((h) => !lastReaction || Date.parse(h.at) > Date.parse(lastReaction.at))
      .map((h) => ({ v: 1, type: 'reaction', at: h.at, key, verdict: h.verdict, ...(h.text ? { text: cleanText(h.text, 2048) } : {}) }))
    const freshNg = fresh.some((r) => r.verdict === 'ng')
    const note = entry.note ? cleanText(entry.note, 2048) : undefined
    const fixesNow = (freshNg ? [] : sinceReset(record.timeline)).filter((s): s is FixStep => s.kind === 'fix')
    let fix: PendingFix | null = null
    const n = record.timeline.filter((s) => s.kind === 'fix').length + 1
    if (entry.status === 'human_review' && !fixesNow.some((s) => (s.note ?? '') === (note ?? '') && !!s.after === !!entry.after)) {
      fix = { type: 'pendingFix', key, findingId, status: 'human_review', ...(note ? { note } : {}), ...(entry.after ? { afterSource: entry.after } : {}), n }
    } else if (entry.status === 'done' && !fixesNow.length && !freshNg) {
      fix = { type: 'pendingFix', key, findingId, status: 'done', ...(note ? { note } : {}), ...(entry.after ? { afterSource: entry.after } : {}), n }
    }
    if (fix && freshNg) out.push(...fresh, fix)
    else out.push(...(fix ? [fix] : []), ...fresh)
  }
  return out
}

/** 指摘の今の結果（人の反応から） */
export function findingOutcome(record: FindingRecord): string {
  const verdicts = record.timeline.filter((s): s is Extract<TimelineStep, { kind: 'reaction' }> => s.kind === 'reaction' && s.verdict !== 'comment')
  const rejections = verdicts.filter((v) => v.verdict === 'ng').length
  const last = verdicts.at(-1)
  const reopened = verdicts.some((v, i) => v.verdict === 'ng' && verdicts.slice(0, i).some((p) => p.verdict === 'ok'))
  const lastStep = record.timeline.at(-1)
  if (last?.verdict === 'ok') return rejections ? `accepted after ${rejections} rejection${rejections > 1 ? 's' : ''}${reopened ? ' (reopened after an earlier OK)' : ''}` : 'accepted on the first fix'
  if (last?.verdict === 'ng') {
    const waiting = lastStep?.kind === 'fix' ? 'agent fixed again, waiting for the human' : 'waiting for the agent to fix again'
    return `rejected ${rejections} time${rejections > 1 ? 's' : ''}${reopened ? ' (reopened after OK)' : ''}; ${waiting}`
  }
  if (record.timeline.some((s) => s.kind === 'fix')) return 'agent fixed, waiting for the human'
  return 'sent, agent working'
}

// ───────────── log.md ─────────────

function frameLine(f: FeedbackFrame): string {
  const [x, y, w, h] = f.bbox
  return `${f.shape === 'rect' ? 'box' : 'pen'} at x=${x}, y=${y}, ${w}×${h}${f.view ? ` (screen ${f.view.w}×${f.view.h})` : ''}`
}

function renderFinding(record: FindingRecord, offsetMinutes?: number): string[] {
  const f = record.finding
  const time = (at: string) => formatFeedbackTime(at, offsetMinutes)
  const out = [
    `## ${time(f.at)} · ${oneLine(f.product, 80) || '(unknown)'} · finding #${f.index}: ${oneLine(f.title, 120) || '(untitled)'}`,
    '',
    `- key: \`${f.key}\``,
    `- outcome: **${findingOutcome(record)}**`,
    ...(f.url ? [`- page: ${f.url}`] : []),
    ...(f.reviewDir ? [`- review: \`${f.reviewDir}\``] : []),
    ''
  ]
  if (f.images.length) out.push(...f.images.map((src, i) => `![finding ${f.index} image ${i + 1} (the human's frames are drawn on it)](${src})`), '')
  if (f.missingImages) out.push(`- images not kept: ${f.missingImages} (too large or missing)`, '')
  if (!f.images.length && !f.missingImages) out.push('- no image', '')
  if (f.frames.length) out.push('Frames the human drew:', '', ...f.frames.map((fr) => `- ${frameLine(fr)}`), '')
  const said = [
    f.title ? `Title: ${f.title}` : '',
    f.request ? `Request: ${f.request}` : '',
    ...f.quotes.map((q) => `${q.speaker}: ${q.text}`)
  ].filter(Boolean).join('\n')
  out.push('What the human said:', '', ...fenced(said), '')
  out.push('Timeline:', '')
  out.push(`- ${time(f.at)} sent to the agent`)
  for (const step of record.timeline) {
    if (step.kind === 'sent') out.push(`- ${time(step.at)} sent again`)
    else if (step.kind === 'fix') {
      out.push(`- ${time(step.at)} agent fixed (${step.status})${step.note ? `: ${oneLine(step.note, 600)}` : ''}${step.after ? '' : ' — no after screenshot'}`)
      if (step.after) out.push(`  ![after fix](${step.after})`)
    } else {
      const label = step.verdict === 'ok' ? 'human OK' : step.verdict === 'ng' ? 'human NG (rejected the fix)' : 'human comment'
      out.push(`- ${time(step.at)} ${label}${step.text ? `: “${oneLine(step.text, 600)}”` : ''}`)
    }
  }
  if (!record.timeline.some((s) => s.kind === 'reaction')) out.push('- (no reaction from the human yet)')
  out.push('')
  return out
}

function renderMessage(m: FeedbackMessageEvent, offsetMinutes?: number): string[] {
  return [
    `## ${formatFeedbackTime(m.at, offsetMinutes)} · ${oneLine(m.product, 80) || '(unknown)'} · ${m.channel}`,
    '',
    ...(m.reviewId ? [`- review: ${m.reviewId}`, ''] : []),
    ...fenced(m.text),
    ''
  ]
}

/** log.md の中身（Ferret が毎回書き直す。新しいものを上に） */
export function renderFeedbackLog(state: FeedbackState, orchestraName: string, offsetMinutes?: number): string {
  const body = [...state.records].reverse().flatMap((r) => (r.kind === 'finding' ? renderFinding(r, offsetMinutes) : renderMessage(r.message, offsetMinutes)))
  return [
    `# Feedback log — ${oneLine(orchestraName) || 'orchestra'}`,
    '',
    '<!-- Written by Ferret from feedback/log.jsonl; this file is rewritten on every update, so do not edit it. Newest first. Each review finding is one set: the image with the human\'s frames, what the human said, what the agent did, and how the human reacted (OK / NG / comment). Distill recurring lessons into feedback/playbook.md. -->',
    '',
    ...(body.length ? body : ['(No feedback recorded yet.)', ''])
  ].join('\n')
}

/** playbook.md の雛形（無いときだけ作る。人と Agent が育てる。英語の指示に合わせる） */
export function playbookTemplate(orchestraName: string): string {
  return [
    `# Playbook — ${oneLine(orchestraName) || 'orchestra'}`,
    '',
    '<!-- Distilled from feedback/log.md by the agents (Ferret only creates this file and never overwrites it). Read it before starting work on any product, especially a new one, and apply it so the human does not have to repeat the same feedback. Keep it short and deduplicated; group lessons by theme. -->',
    '',
    '## Frame set by the human',
    '',
    '<!-- Goals, value, scope and what "good" means. Only the human changes this frame; agents work inside it. -->',
    '- ',
    '',
    '## Benchmarks',
    '',
    '<!-- Per product: the benchmark products to match, with URLs. -->',
    '- ',
    '',
    '## Lessons',
    '',
    '<!-- One block per theme:',
    '### <theme>',
    '- Pointed out: what the human pointed out (link the framed image from feedback/images/)',
    '- In their words: how they phrased it',
    '- Agent got wrong: what the agent did that the human rejected or corrected, and what the human wanted instead',
    '- Rule: what to do next time',
    '- From: which products / log entries',
    '-->',
    ''
  ].join('\n')
}

// ───────────── どのオーケストラに記録するか・経路ごとの文 ─────────────

/**
 * フィードバックを記録するオーケストラと、記録に書くプロダクトの名前。
 * プロジェクトがオーケストラならそれ自身（名前はオーケストラ）、オーケストラに属するプロダクト（対象から外したもの・SSH・旧オーケストレーターは除く）ならその所属。
 * それ以外（オーケストラが無い・属していない・知らない id）は null（記録しない）
 */
export function feedbackTarget(projects: readonly Project[], projectId: string | null | undefined): { orchestra: Project; product: string } | null {
  const project = projectId ? projects.find((p) => p.id === projectId) : undefined
  if (!project) return null
  if (isOrchestra(project)) return project.source === 'ssh' ? null : { orchestra: project, product: project.name }
  const orchestraId = orchestraIdOf(projects, project)
  const orchestra = orchestraId ? projects.find((p) => p.id === orchestraId) : undefined
  if (!orchestra || orchestra.source === 'ssh') return null
  if (!orchestraMembers(projects, orchestra.id).some((p) => p.id === project.id)) return null
  return { orchestra, product: project.name }
}

/** human.md の答えを記録に書く形（答えた項目だけ。番号・プロダクト・見てほしいこと → 答え） */
export function answersFeedbackText(items: ReadonlyArray<{ key: string; label: string; note: string; answer?: string }>): string {
  return items
    .filter((it) => it.answer?.trim())
    .map((it) => `- ${it.key}${it.label ? ` [${oneLine(it.label, 80)}]` : ''}${it.note ? ` ${oneLine(it.note, 300)}` : ''} → ${it.answer!.trim()}`)
    .join('\n')
}

/** 依頼の雛形を記録に書く形。組み込みのままのものは名前だけ（文面は Ferret の既定）、変えたもの・自作のものは文面も */
export function requestsFeedbackText(picked: ReadonlyArray<{ title: string; text: string; custom: boolean; edited: boolean }>): string {
  return picked
    .map((r) => (r.custom || r.edited ? `### ${oneLine(r.title) || '(untitled)'}\n${r.text.trim()}` : `### ${oneLine(r.title) || '(untitled)'} (built-in request)`))
    .join('\n\n')
}
