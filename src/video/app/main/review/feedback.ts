/**
 * 確認の指摘を動画のフォルダの feedback/ に書く（Electron に依存しない。単体テストで一時フォルダに書いて確かめる）。
 *
 * - 録っている途中の声と画像は feedback/.inbox/<id>/ に置く（CLI の `feedback list` は feedback.md のあるフォルダだけを見るので出ない）
 * - 保存は feedback/.tmp-<id>-<pid>/ に全部を書いてから feedback/<id>/ へ名前を変える（途中で失敗しても半端なものを残さない）
 * - 形式は旧 Solocut の `feedback import` と同じ: items.json・feedback.md・NN.png・session.json・voice.wav
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  feedbackMarkdown, imageName, isFeedbackId, MAX_ITEMS, sanitizeItems,
  type Fps, type ReviewItem, type ReviewSession, type SavedFeedback
} from '../../shared/review'
import { wavSamples } from '../../shared/wav'

/** 声の上限（16kHz モノラルで約 60 分） */
export const MAX_VOICE_BYTES = 120 * 1024 * 1024
/** 画像1枚の上限 */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => bytes[i] === b)
}

function checkId(id: unknown): string {
  if (!isFeedbackId(id)) throw new Error(`invalid feedback id: ${String(id)}`)
  return id
}

export function inboxDir(videoDir: string, id: string): string {
  return join(videoDir, 'feedback', '.inbox', checkId(id))
}

function writeAtomic(path: string, data: string | Uint8Array): void {
  writeFileSync(`${path}.tmp`, data)
  renameSync(`${path}.tmp`, path)
}

/** feedback/ と feedback/.inbox/ がリンクでないこと（リンクの先＝動画のフォルダの外に書かない） */
function ensureRealDir(path: string): void {
  if (existsSync(path)) {
    if (!lstatSync(path).isDirectory()) throw new Error(`not a folder: ${path}`)
    return
  }
  mkdirSync(path, { recursive: true })
}

function ensureInbox(videoDir: string, id: string): string {
  ensureRealDir(join(videoDir, 'feedback'))
  ensureRealDir(join(videoDir, 'feedback', '.inbox'))
  const dir = inboxDir(videoDir, id)
  ensureRealDir(dir)
  return dir
}

/** 確認の声（16kHz モノラルの WAV）を置く。WAV でない・大きすぎるものは断る */
export function writeVoice(videoDir: string, id: string, bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_VOICE_BYTES) throw new Error('voice is too large')
  if (!wavSamples(bytes)) throw new Error('voice is not a 16-bit mono WAV')
  const path = join(ensureInbox(videoDir, id), 'voice.wav')
  writeAtomic(path, bytes)
  return path
}

/** 指摘 index の画像（ペン入りの PNG）を置く */
export function writeSnapshot(videoDir: string, id: string, index: number, bytes: Uint8Array): void {
  if (!Number.isInteger(index) || index < 1 || index > MAX_ITEMS) throw new Error(`invalid item index: ${index}`)
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_IMAGE_BYTES || !isPng(bytes)) throw new Error('snapshot is not a PNG')
  writeAtomic(join(ensureInbox(videoDir, id), imageName(index)), bytes)
}

export function discardInbox(videoDir: string, id: string): void {
  rmSync(inboxDir(videoDir, id), { recursive: true, force: true })
}

export interface SaveFeedbackInput {
  id: string
  session: ReviewSession
  items: unknown
  fps: Fps
  lang: 'ja' | 'en'
  now?: Date
}

export interface SaveFeedbackResult {
  id: string
  /** 動画のフォルダからの相対 */
  dir: string
  path: string
  count: number
  items: ReviewItem[]
}

function cleanSession(s: ReviewSession, hasVoice: boolean): ReviewSession {
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
  return {
    schema: 1,
    createdAt: typeof s?.createdAt === 'string' ? s.createdAt : new Date().toISOString(),
    ...(hasVoice ? { audio: 'voice.wav' } : {}),
    audioStartMs: typeof s?.audioStartMs === 'number' && Number.isFinite(s.audioStartMs) ? Math.max(0, s.audioStartMs) : 0,
    playback: arr<ReviewSession['playback'][number]>(s?.playback).slice(0, 10000),
    strokes: arr<ReviewSession['strokes'][number]>(s?.strokes).slice(0, 2000),
    notes: arr<ReviewSession['notes'][number]>(s?.notes).slice(0, 2000)
  }
}

/** 指摘を feedback/<id>/ に書く。同じ id がもうあれば断る。画像は inbox にある分だけ（無い指摘は「画像: なし」） */
export function saveFeedback(videoDir: string, input: SaveFeedbackInput): SaveFeedbackResult {
  const id = checkId(input.id)
  const items = sanitizeItems(input.items)
  if (!items.length) throw new Error('no feedback items')
  ensureRealDir(join(videoDir, 'feedback'))
  const final = join(videoDir, 'feedback', id)
  if (existsSync(join(final, 'items.json')) || existsSync(join(final, 'feedback.md'))) throw new Error(`feedback/${id} already exists`)
  const inbox = inboxDir(videoDir, id)
  const work = join(videoDir, 'feedback', `.tmp-${id}-${process.pid}`)
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  try {
    const images = new Set<number>()
    for (const it of items) {
      const src = join(inbox, imageName(it.index))
      if (existsSync(src) && lstatSync(src).isFile()) {
        renameSync(src, join(work, imageName(it.index)))
        images.add(it.index)
      }
    }
    const voice = join(inbox, 'voice.wav')
    const hasVoice = existsSync(voice) && lstatSync(voice).isFile()
    if (hasVoice) renameSync(voice, join(work, 'voice.wav'))
    const createdAt = (input.now ?? new Date()).toISOString()
    writeAtomic(join(work, 'session.json'), JSON.stringify(cleanSession(input.session, hasVoice), null, 2) + '\n')
    writeAtomic(join(work, 'items.json'), JSON.stringify({ id, createdAt, organizedBy: null, variant: 'main', items }, null, 2) + '\n')
    writeAtomic(join(work, 'feedback.md'), feedbackMarkdown(id, items, input.fps, input.lang, images))
    // feedback.md の無い残り（前に失敗したもの）は置き換える
    rmSync(final, { recursive: true, force: true })
    renameSync(work, final)
  } catch (err) {
    rmSync(work, { recursive: true, force: true })
    throw err
  }
  rmSync(inbox, { recursive: true, force: true })
  return { id, dir: `feedback/${id}`, path: `feedback/${id}/feedback.md`, count: items.length, items }
}

/** 保存した指摘（feedback/<id>/feedback.md）。timeline.json の review.feedback の状態を重ねる。新しい順 */
export function listSavedFeedback(videoDir: string, timeline?: unknown): SavedFeedback[] {
  const root = join(videoDir, 'feedback')
  let names: string[]
  try {
    names = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && isFeedbackId(e.name)).map((e) => e.name)
  } catch {
    return []
  }
  const review = (timeline as { review?: { feedback?: unknown } } | undefined)?.review
  const states = Array.isArray(review?.feedback) ? (review.feedback as { id?: unknown; status?: unknown; items?: unknown }[]) : []
  const out: SavedFeedback[] = []
  for (const id of names) {
    if (!existsSync(join(root, id, 'feedback.md'))) continue
    let count = 0
    let createdAt: string | undefined
    try {
      const j = JSON.parse(readFileSync(join(root, id, 'items.json'), 'utf8')) as { items?: unknown; createdAt?: unknown }
      count = Array.isArray(j.items) ? j.items.length : 0
      if (typeof j.createdAt === 'string') createdAt = j.createdAt
    } catch {
      /* items.json が無い・壊れている（feedback.md だけ）ものも出す */
    }
    const st = states.find((s) => s.id === id)
    const item: SavedFeedback = { id, count, status: st?.status === 'done' ? 'done' : 'open', path: `feedback/${id}/feedback.md` }
    if (createdAt) item.createdAt = createdAt
    out.push(item)
  }
  return out.sort((a, b) => b.id.localeCompare(a.id))
}

/**
 * timeline.json の review に指摘を足す op（`ferret-video edit --ops`）。`feedback done` が見つけられるように。
 * 同じ id の古い記録は置き換える
 */
export function reviewRegisterOps(timeline: unknown, id: string, count: number, lang: 'ja' | 'en'): unknown[] {
  const review = (timeline as { review?: { feedback?: unknown; openItems?: unknown } } | undefined)?.review ?? {}
  const feedback = (Array.isArray(review.feedback) ? review.feedback : []).filter((f) => (f as { id?: unknown })?.id !== id)
  const openItems = (Array.isArray(review.openItems) ? review.openItems : []).filter((o) => (o as { ref?: unknown })?.ref !== id)
  const summary = lang === 'ja' ? `フィードバック ${count} 件（feedback/${id}/feedback.md）` : `${count} feedback item(s) (feedback/${id}/feedback.md)`
  return [{ op: 'setReview', patch: { feedback: [...feedback, { id, status: 'open', items: count }], openItems: [...openItems, { ref: id, kind: 'feedback', summary }] } }]
}
