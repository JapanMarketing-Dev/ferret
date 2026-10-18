/**
 * 完成動画の確認（喋って囲むとタイムコード付きの指摘になる）の純粋な処理。main・renderer・単体テストで共用。
 *
 * 流れ: プレビューを再生・停止しながらマイクで話し、動画の上にペンで囲む（renderer がセッションの時計で記録）
 * → main が Ferret の文字起こしで話を文にする → 話の切れ目で指摘に分け、ペン・メモを近い指摘へ寄せる（buildReviewItems）
 * → 人が確かめて直す → `feedback/<id>/` に items.json・feedback.md・NN.png（ペン入りの画像）を書く。
 * 形式は旧 Solocut の `feedback import` と同じ（`ferret-video feedback list/show` がそのまま読める）。
 */
import { VIDEO_CLI } from '@video/names'

export interface Fps {
  num: number
  den: number
}

/** ペンの線。点は動画の絵に対して 0..1（左上が原点）。四角の枠は閉じた線にする（CLI は線しか知らない） */
export interface ReviewStroke {
  id?: string
  startMs: number
  endMs: number
  frame: number
  color?: string
  width?: number
  points: [number, number][]
}

export interface ReviewPlayback {
  atMs: number
  state: 'playing' | 'paused'
  frame: number
}

export interface ReviewNote {
  atMs: number
  text: string
  frame?: number
}

/** 確認1回の記録（セッションの時計＝ms。CLI の FeedbackSession と同じ形） */
export interface ReviewSession {
  schema: 1
  createdAt?: string
  audio?: string
  /** マイクの最初のサンプルがセッションの時計のどこか（ms） */
  audioStartMs?: number
  playback: ReviewPlayback[]
  strokes: ReviewStroke[]
  notes: ReviewNote[]
}

/** 文字起こしの区間（音声の先頭からの ms） */
export interface TranscriptPiece {
  t0: number
  t1: number
  text: string
}

export interface Remark {
  startMs: number
  endMs: number
  text: string
}

/** 指摘1つ（items.json の1件。CLI の FeedbackItem と同じ形） */
export interface ReviewItem {
  index: number
  atMs: number
  frame: number
  speech: string
  strokes: ReviewStroke[]
  notes: string[]
  targets: { kind: string; id: string; label: string }[]
  title?: string
  request?: string
}

export const DEFAULT_FPS: Fps = { num: 30, den: 1 }

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** timeline.json の canvas.fps（壊れていれば 30） */
export function fpsOf(timeline: unknown): Fps {
  const c = (timeline as { canvas?: { fps?: { num?: unknown; den?: unknown } } } | null)?.canvas?.fps
  const num = c?.num
  const den = c?.den
  return finite(num) && finite(den) && num > 0 && den > 0 ? { num, den } : DEFAULT_FPS
}

/** 動画の再生位置（秒）→ フレーム（プレビューはフレーム 0 から始まる） */
export function frameAtTime(videoTime: number, fps: Fps): number {
  if (!Number.isFinite(videoTime) || videoTime < 0) return 0
  return Math.round((videoTime * fps.num) / (fps.den || 1) + 1e-9)
}

/** フレーム → 秒 */
export function frameToSeconds(frame: number, fps: Fps): number {
  return (frame * fps.den) / fps.num
}

const pad = (n: number) => String(n).padStart(2, '0')

/** "HH:MM:SS:FF"（ノンドロップ、29.97 は 30 として数える。CLI の frameToTimecode と同じ） */
export function timecode(frame: number, fps: Fps): string {
  const f = Number.isFinite(frame) && frame > 0 ? Math.floor(frame) : 0
  const r = Math.max(1, Math.round(fps.num / (fps.den || 1)))
  const totalSec = Math.floor(f / r)
  return `${pad(Math.floor(totalSec / 3600))}:${pad(Math.floor(totalSec / 60) % 60)}:${pad(totalSec % 60)}:${pad(f % r)}`
}

/** セッションの時刻 ms に映っていたフレーム（再生中は進んだ分を足す） */
export function frameAtSession(playback: readonly ReviewPlayback[], ms: number, fps: Fps): number {
  const ev = [...playback].sort((a, b) => a.atMs - b.atMs)
  if (!ev.length) return 0
  let cur = ev[0]!
  for (const e of ev) if (e.atMs <= ms) cur = e
  if (ms < cur.atMs || cur.state === 'paused') return Math.max(0, cur.frame)
  return Math.max(0, cur.frame + Math.floor(((ms - cur.atMs) / 1000) * (fps.num / fps.den)))
}

const SENTENCE_END = /[。．！？!?.]$/

const joinParts = (parts: string[], lang: 'ja' | 'en') => (lang === 'ja' ? parts.join('') : parts.join(' ').replace(/\s+([,.!?])/g, '$1'))

/**
 * 文字起こしの区間を、話の切れ目で指摘に分ける。間が gapMs より空く、または文の終わりのあと 300ms より空くと次の指摘。
 * 空の区間は落とす。時刻はセッションの時計（audioStartMs を足す）
 */
export function splitRemarks(pieces: readonly TranscriptPiece[], audioStartMs: number, lang: 'ja' | 'en', gapMs = 800): Remark[] {
  const out: Remark[] = []
  let cur: { startMs: number; endMs: number; parts: string[] } | null = null
  for (const p of [...pieces].filter((x) => finite(x.t0) && finite(x.t1)).sort((a, b) => a.t0 - b.t0)) {
    const text = typeof p.text === 'string' ? p.text.trim() : ''
    if (!text) continue
    const s = audioStartMs + Math.max(0, p.t0)
    const e = audioStartMs + Math.max(p.t0, p.t1)
    const prev = cur?.parts.at(-1) ?? ''
    if (cur && (s - cur.endMs > gapMs || (SENTENCE_END.test(prev) && s - cur.endMs > 300))) {
      out.push({ startMs: cur.startMs, endMs: cur.endMs, text: joinParts(cur.parts, lang) })
      cur = null
    }
    if (!cur) cur = { startMs: s, endMs: e, parts: [] }
    cur.parts.push(text)
    cur.endMs = Math.max(cur.endMs, e)
  }
  if (cur) out.push({ startMs: cur.startMs, endMs: cur.endMs, text: joinParts(cur.parts, lang) })
  return out
}

/** ペン・メモを寄せる距離（ms）。これより離れていれば別の指摘にする */
export const ATTACH_MS = 4000

/**
 * 話＋ペン＋メモ → 指摘。ペン・メモは重なる、または 4 秒以内でいちばん近い話へ寄せ、無ければそれだけで1件。
 * フレームはペンがあればペンを描いたフレーム、無ければ話し始めのフレーム。totalFrames があれば最後のフレームまでに収める
 */
export function buildReviewItems(session: Pick<ReviewSession, 'playback' | 'strokes' | 'notes'>, remarks: readonly Remark[], fps: Fps, totalFrames?: number): ReviewItem[] {
  type Draft = { atMs: number; endMs: number; speech: string; strokes: ReviewStroke[]; notes: string[]; frame?: number }
  const items: Draft[] = remarks.map((r) => ({ atMs: r.startMs, endMs: r.endMs, speech: r.text, strokes: [], notes: [] }))
  const nearest = (a: number, b: number) => {
    let best = -1
    let bestD = Infinity
    items.forEach((it, i) => {
      const d = b < it.atMs ? it.atMs - b : a > it.endMs ? a - it.endMs : 0
      if (d < bestD) {
        bestD = d
        best = i
      }
    })
    return bestD <= ATTACH_MS ? best : -1
  }
  for (const st of [...session.strokes].sort((a, b) => a.startMs - b.startMs)) {
    if (!st.points?.length) continue
    const i = nearest(st.startMs, st.endMs)
    if (i >= 0) items[i]!.strokes.push(st)
    else items.push({ atMs: st.startMs, endMs: st.endMs, speech: '', strokes: [st], notes: [] })
  }
  for (const n of [...session.notes].sort((a, b) => a.atMs - b.atMs)) {
    const text = n.text.trim()
    if (!text) continue
    const i = nearest(n.atMs, n.atMs)
    if (i >= 0) items[i]!.notes.push(text)
    else items.push({ atMs: n.atMs, endMs: n.atMs, speech: '', strokes: [], notes: [text], ...(n.frame !== undefined ? { frame: n.frame } : {}) })
  }
  const last = totalFrames !== undefined && totalFrames > 0 ? Math.floor(totalFrames) - 1 : Infinity
  return items
    .sort((a, b) => a.atMs - b.atMs)
    .map((it, i) => {
      const raw = it.strokes[0]?.frame ?? it.frame ?? frameAtSession(session.playback, it.atMs, fps)
      const frame = Math.max(0, Math.min(last, Math.round(raw)))
      return { index: i + 1, atMs: Math.round(it.atMs), frame, speech: it.speech, strokes: it.strokes, notes: it.notes, targets: [] }
    })
}

/** 指摘の id（`fb_YYYYMMDD-HHMMSS`、その PC の時刻）。CLI と同じ */
export function newFeedbackId(now: Date = new Date()): string {
  return `fb_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/** 指摘の id として使えるか（フォルダ名になる。CLI の検査と同じ形に、.. を足して断る） */
export function isFeedbackId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= 100 && /^fb_[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id) && !id.includes('..')
}

const short = (s: string, n: number) => ([...s].length > n ? `${[...s].slice(0, n).join('')}…` : s)

export const MAX_ITEMS = 200
export const MAX_TEXT = 4000
const MAX_POINTS = 5000

const clamp01 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000

/** renderer から来た指摘を確かめて直す（番号を 1..n に振り直す。壊れた点・長すぎる文・多すぎる件数は落とす） */
export function sanitizeItems(raw: unknown): ReviewItem[] {
  if (!Array.isArray(raw)) return []
  const out: ReviewItem[] = []
  for (const x of raw.slice(0, MAX_ITEMS)) {
    if (typeof x !== 'object' || x === null) continue
    const o = x as Record<string, unknown>
    const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : '')
    const strokes: ReviewStroke[] = (Array.isArray(o.strokes) ? o.strokes : []).flatMap((s): ReviewStroke[] => {
      if (typeof s !== 'object' || s === null) return []
      const st = s as Record<string, unknown>
      const points = (Array.isArray(st.points) ? st.points : [])
        .filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1]))
        .slice(0, MAX_POINTS)
        .map(([px, py]) => [clamp01(px), clamp01(py)] as [number, number])
      if (!points.length) return []
      const stroke: ReviewStroke = { startMs: finite(st.startMs) ? st.startMs : 0, endMs: finite(st.endMs) ? st.endMs : 0, frame: finite(st.frame) ? Math.max(0, Math.round(st.frame)) : 0, points }
      if (typeof st.color === 'string' && /^#[0-9a-f]{6}$/i.test(st.color)) stroke.color = st.color
      if (finite(st.width) && st.width > 0 && st.width < 0.1) stroke.width = st.width
      if (typeof st.id === 'string') stroke.id = st.id.slice(0, 64)
      return [stroke]
    })
    const item: ReviewItem = {
      index: out.length + 1,
      atMs: finite(o.atMs) ? Math.max(0, Math.round(o.atMs)) : 0,
      frame: finite(o.frame) ? Math.max(0, Math.round(o.frame)) : 0,
      speech: text(o.speech),
      strokes,
      notes: (Array.isArray(o.notes) ? o.notes : []).filter((n): n is string => typeof n === 'string' && n.trim() !== '').slice(0, 20).map((n) => n.slice(0, MAX_TEXT)),
      targets: []
    }
    const title = text(o.title).trim()
    const request = text(o.request).trim()
    if (title) item.title = title.slice(0, 200)
    if (request) item.request = request
    // 話もペンもメモも要望も無いものは指摘にしない
    if (!item.speech.trim() && !item.strokes.length && !item.notes.length && !item.request) continue
    out.push(item)
  }
  return out
}

/** 画像のファイル名（01.png …） */
export const imageName = (index: number) => `${pad(index)}.png`

/** feedback.md（旧 Solocut の `feedback import` と同じ見出し・項目。CLI の `feedback show` がそのまま出す） */
export function feedbackMarkdown(id: string, items: readonly ReviewItem[], fps: Fps, lang: 'ja' | 'en', images: ReadonlySet<number> = new Set(items.map((it) => it.index))): string {
  const ja = lang === 'ja'
  const lines = [`# ${ja ? 'フィードバック' : 'Feedback'} ${id}`, '']
  lines.push(ja
    ? `指摘ごとに対応してください。時刻はタイムコード（時:分:秒:フレーム）です。対象の要素は \`${VIDEO_CLI} tl show <id>\` で確認し、直しは \`${VIDEO_CLI} edit\` で（decided.feedbackRef に ${id} を入れる）。終わったら \`${VIDEO_CLI} render --preview\` と \`${VIDEO_CLI} check\`、そして \`${VIDEO_CLI} feedback done ${id}\`。`
    : `Address each item. Times are timecodes (HH:MM:SS:FF). Inspect targets with \`${VIDEO_CLI} tl show <id>\`, fix with \`${VIDEO_CLI} edit\` (set decided.feedbackRef to ${id}). Then \`${VIDEO_CLI} render --preview\`, \`${VIDEO_CLI} check\` and \`${VIDEO_CLI} feedback done ${id}\`.`)
  lines.push('')
  for (const it of items) {
    const speech = it.speech.trim()
    const heading = it.title ?? (speech ? short(speech, 28) : it.notes[0] ? short(it.notes[0], 28) : ja ? '（ペンの囲みのみ）' : '(pen only)')
    lines.push(`## ${it.index}. [${timecode(it.frame, fps)}] ${heading.replace(/\s+/g, ' ')}`)
    lines.push(`- ${ja ? '要望' : 'Request'}: ${it.request?.replace(/\s+/g, ' ') ?? (ja ? '（未整理）発話と画像をもとに対応してください' : '(not organized) act on the speech and the image')}`)
    if (speech) lines.push(`- ${ja ? '発話（原文）' : 'Speech (verbatim)'}: 「${speech.replace(/\s+/g, ' ')}」`)
    for (const n of it.notes) lines.push(`- ${ja ? 'メモ' : 'Note'}: ${n.replace(/\s+/g, ' ')}`)
    if (images.has(it.index)) lines.push(`- ${ja ? '画像' : 'Image'}: ./${imageName(it.index)}${it.strokes.length ? (ja ? '（ペンの囲み入り）' : ' (with pen strokes)') : ''}`)
    else lines.push(`- ${ja ? '画像' : 'Image'}: ${ja ? '（なし）' : '(none)'}`)
    lines.push(`- ${ja ? '対象' : 'Targets'}: ${it.targets.length ? it.targets.map((x) => x.label).join('、') : ja ? '（特定できませんでした）' : '(none found)'}`)
    lines.push(`- ${ja ? 'フレーム' : 'Frame'}: ${it.frame}`)
    lines.push('')
  }
  return lines.join('\n')
}

/** 保存したあと Agent へ送る「この指摘を直して」 */
export function fixFeedbackPrompt(videoDir: string, id: string, lang: 'ja' | 'en'): string {
  const dir = videoDir.replace(/[\\/]+$/, '')
  const md = `${dir}/feedback/${id}/feedback.md`
  return lang === 'ja'
    ? `動画の確認で出た指摘を直してください。対象の動画のフォルダ: ${dir}\nこのフォルダへ移ってから（cd "${dir}"）、${md} を読み、指摘を1つずつ直してください（時刻はタイムコード、画像はペンで囲んだ場所）。終わったら ${VIDEO_CLI} render --preview と ${VIDEO_CLI} check を実行し、${VIDEO_CLI} feedback done ${id} で対応済みにしてください。`
    : `Fix the review feedback on this video. Video folder: ${dir}\nWork in that folder (cd "${dir}"), read ${md} and fix each item (times are timecodes, the images show what was circled). Then run ${VIDEO_CLI} render --preview and ${VIDEO_CLI} check, and mark it done with ${VIDEO_CLI} feedback done ${id}.`
}

// ---------- ペン（renderer） ----------

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** object-fit: contain の動画の絵が要素の中のどこにあるか */
export function contentRect(elW: number, elH: number, vidW: number, vidH: number): Rect {
  if (elW <= 0 || elH <= 0 || vidW <= 0 || vidH <= 0) return { x: 0, y: 0, w: Math.max(0, elW), h: Math.max(0, elH) }
  if (elW * vidH <= elH * vidW) {
    const h = (vidH * elW) / vidW
    return { x: 0, y: (elH - h) / 2, w: elW, h }
  }
  const w = (vidW * elH) / vidH
  return { x: (elW - w) / 2, y: 0, w, h: elH }
}

/** 要素の座標 → 動画の絵に対する 0..1（はみ出しは端に寄せる） */
export function normalizePoint(px: number, py: number, r: Rect): [number, number] {
  return [clamp01((px - r.x) / (r.w || 1)), clamp01((py - r.y) / (r.h || 1))]
}

/** 前に残した点から minDist（0..1）より近い点を落とす。最後の点は残す */
export function simplifyStroke(points: readonly [number, number][], minDist = 0.003): [number, number][] {
  if (points.length <= 2) return points.slice()
  const out: [number, number][] = [points[0]!]
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!
    const q = out[out.length - 1]!
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= minDist) out.push(p)
  }
  out.push(points[points.length - 1]!)
  return out
}

/** 四角の枠（0..1）を閉じた線にする */
export function boxPoints(b: Rect): [number, number][] {
  return [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h], [b.x, b.y]]
}

/** 保存した指摘の一覧の1件 */
export interface SavedFeedback {
  id: string
  count: number
  createdAt?: string
  status: 'open' | 'done'
  /** 動画のフォルダからの相対（feedback/<id>/feedback.md） */
  path: string
}
