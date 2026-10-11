import { lstat, mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import {
  FEEDBACK_DIR,
  FEEDBACK_EVENTS_FILE,
  FEEDBACK_IMAGES_DIR,
  FEEDBACK_LOG_FILE,
  FEEDBACK_LOG_PATH,
  MAX_FEEDBACK_IMAGE_BYTES,
  MAX_FINDING_IMAGES,
  PLAYBOOK_FILE,
  PLAYBOOK_PATH,
  afterImageName,
  findingImageName,
  findingSentEvent,
  foldFeedback,
  messageEvent,
  parseFeedbackEvents,
  penFrames,
  playbookTemplate,
  progressChanges,
  renderFeedbackLog,
  type FeedbackChannel,
  type FeedbackEvent,
  type FeedbackState,
  type SentFindingInput
} from '@shared/feedbackLog'
import type { ProgressMap } from '@shared/findingProgress'
import { SubagentLinkError, writeAtomic } from './orchestrator'

/**
 * オーケストラのフィードバックの知見を、オーケストラのフォルダの feedback/ に書く（@shared/feedbackLog）。
 * - log.jsonl：出来事を1行ずつ足すだけ（O_APPEND の1回の書き込み）。log.md：そこから毎回まとめ直して置き換える
 * - images/：指摘の画像（人の枠が描かれた静止画）と AFTER の画像の写し。大きすぎるもの・リンクは写さない
 * - playbook.md：無いときだけ雛形を作る（あるものは決して上書きしない）
 * 同じフォルダへの書き込みは1本の列に並べる（送信と判断が同時に来ても、行が混ざらない・log.md が古い中身で上書きされない）。
 * 呼び出し側は送信を待たせない・失敗させないよう、結果を待たずに投げっぱなしにし、失敗は記録だけする（src/main/index.ts）。
 * Electron に依存しない
 */

/** これより大きい log.jsonl は、末尾のこの大きさだけを読んで log.md を作る（古いものは log.jsonl には残る） */
const MAX_EVENTS_READ_BYTES = 16 * 1024 * 1024

const queues = new Map<string, Promise<unknown>>()

function enqueue<T>(folder: string, run: () => Promise<T>): Promise<T> {
  const key = resolve(folder)
  const next = (queues.get(key) ?? Promise.resolve()).then(run, run)
  const tail = next.catch(() => undefined) // 失敗は呼び出し側へ返す。列には順番待ちのためだけに残す（想定内）
  queues.set(key, tail)
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key) })
  return next
}

async function isLink(path: string): Promise<boolean> {
  try { return (await lstat(path)).isSymbolicLink() } catch { return false }
}

/** feedback/（と images/）を用意する。どれかがリンクなら書かない（別の場所を書き換えさせない） */
async function feedbackDir(folder: string, withImages = false): Promise<string> {
  const dir = join(folder, FEEDBACK_DIR)
  if (await isLink(folder) || await isLink(dir)) throw new SubagentLinkError(dir)
  await mkdir(dir, { recursive: true, mode: 0o755 })
  if (withImages) {
    const images = join(dir, FEEDBACK_IMAGES_DIR)
    if (await isLink(images)) throw new SubagentLinkError(images)
    await mkdir(images, { recursive: true, mode: 0o755 })
  }
  return dir
}

async function readEventsIn(dir: string): Promise<FeedbackEvent[]> {
  const path = join(dir, FEEDBACK_EVENTS_FILE)
  let st
  try { st = await lstat(path) } catch { return [] } // まだ無い（想定内）
  if (st.isSymbolicLink() || !st.isFile()) throw new SubagentLinkError(path)
  if (st.size <= MAX_EVENTS_READ_BYTES) return parseFeedbackEvents(await readFile(path, 'utf8'))
  // 大きすぎるときは末尾だけ（最初の行は途中から始まるので捨てる）
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(MAX_EVENTS_READ_BYTES)
    await handle.read(buffer, 0, MAX_EVENTS_READ_BYTES, st.size - MAX_EVENTS_READ_BYTES)
    const text = buffer.toString('utf8')
    return parseFeedbackEvents(text.slice(text.indexOf('\n') + 1))
  } finally {
    await handle.close()
  }
}

async function appendEvents(dir: string, events: readonly FeedbackEvent[]): Promise<void> {
  const path = join(dir, FEEDBACK_EVENTS_FILE)
  if (await isLink(path)) throw new SubagentLinkError(path)
  // 1回の追記で書く（O_APPEND。途中で落ちても前の行は壊れない）
  await writeFile(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n', { encoding: 'utf8', flag: 'a', mode: 0o644 })
}

/**
 * 今の記録を読み、build が返した出来事を足して、log.md を書き直す。build が何も返さなければ書かない。
 * 足した出来事を返す
 */
async function update(folder: string, orchestraName: string, build: (state: FeedbackState, dir: string) => Promise<FeedbackEvent[]>): Promise<FeedbackEvent[]> {
  return enqueue(folder, async () => {
    const dir = await feedbackDir(folder)
    const events = await readEventsIn(dir)
    const added = await build(foldFeedback(events), dir)
    if (!added.length) return []
    await appendEvents(dir, added)
    await writeAtomic(dir, FEEDBACK_LOG_FILE, renderFeedbackLog(foldFeedback([...events, ...added]), orchestraName))
    return added
  })
}

/**
 * 画像を feedback/ の下へ写す。元がリンク・普通のファイルでない・大きすぎる・無いときは写さず false。
 * 同じ名前がもうあれば（前に写した）そのまま true
 */
export async function copyImage(source: string, dir: string, relName: string, maxBytes = MAX_FEEDBACK_IMAGE_BYTES): Promise<boolean> {
  try {
    const st = await lstat(source)
    if (st.isSymbolicLink() || !st.isFile() || st.size > maxBytes || st.size === 0) return false
    const bytes = await readFile(source)
    if (bytes.length > maxBytes) return false
    const dest = join(dir, ...relName.split('/'))
    if (await isLink(dest)) return false
    await writeFile(dest, bytes, { flag: 'wx', mode: 0o644 })
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return true
    return false // 消えた・読めない画像は「無い」として記録する（想定内）
  }
}

export interface ReviewSentInput {
  projectId: string
  reviewId: string
  /** レビューのフォルダ（絶対パス。画像はこの中の ./01.png など） */
  reviewDir: string
  /** 送った指摘と、そのプロダクトの名前（全体で録ったものはプロダクトごとに分けた名前） */
  items: Array<{ product: string; item: SentFindingInput['item'] & { images: readonly string[]; annotationIds: readonly string[] } }>
  /** レビューの操作ログ（枠・ペンの位置を拾う） */
  events: readonly unknown[]
  at?: Date
}

/** 送った指摘を1件ずつ記録する（画像の写し・枠の位置・文） */
export function recordReviewSent(folder: string, orchestraName: string, input: ReviewSentInput): Promise<FeedbackEvent[]> {
  return update(folder, orchestraName, async (_state, dir) => {
    if (!input.items.length) return []
    await feedbackDir(folder, true)
    const at = (input.at ?? new Date()).toISOString()
    const out: FeedbackEvent[] = []
    for (const { product, item } of input.items) {
      const images: string[] = []
      let missing = 0
      for (const [i, name] of item.images.slice(0, MAX_FINDING_IMAGES).entries()) {
        // 画像はレビューのフォルダの ./01.png の形だけ（それ以外の場所は読まない）
        const rel = findingImageName(input.projectId, input.reviewId, item.id, i + 1)
        if (/^\.\/\d+\.png$/.test(name) && await copyImage(join(input.reviewDir, basename(name)), dir, rel)) images.push(rel)
        else missing += 1
      }
      out.push(findingSentEvent({ at, projectId: input.projectId, product, reviewId: input.reviewId, reviewDir: input.reviewDir, item, images, missingImages: missing, frames: penFrames(input.events, item.annotationIds) }))
    }
    return out
  })
}

/**
 * レビューの progress.json の今の値から、Agent が直したこと・人の反応のうち、まだ記録していないものを足す。
 * 記録していない指摘（記録を始める前に送ったものなど）は何もしない
 */
export function recordReviewProgress(folder: string, orchestraName: string, input: { projectId: string; reviewId: string; reviewDir: string; progress: ProgressMap; at?: Date }): Promise<FeedbackEvent[]> {
  return update(folder, orchestraName, async (state, dir) => {
    const steps = progressChanges(state, input.projectId, input.reviewId, input.progress)
    if (!steps.length) return []
    const at = (input.at ?? new Date()).toISOString()
    const out: FeedbackEvent[] = []
    for (const step of steps) {
      if (step.type !== 'pendingFix') { out.push(step); continue }
      let after: string | undefined
      if (step.afterSource) {
        await feedbackDir(folder, true)
        const rel = afterImageName(input.projectId, input.reviewId, step.findingId, step.n, extname(step.afterSource).slice(1) || 'png')
        // afterSource は sanitizeAfterPath を通った相対パス（.. や絶対パスは来ない）
        if (await copyImage(join(input.reviewDir, ...step.afterSource.split('/')), dir, rel)) after = rel
      }
      out.push({ v: 1, type: 'fix', at, key: step.key, status: step.status, ...(step.note ? { note: step.note } : {}), ...(after ? { after } : {}) })
    }
    return out
  })
}

/** 文・依頼・答え・レビューの差し替えの本文を1件記録する。空なら何もしない */
export function recordFeedbackMessage(folder: string, orchestraName: string, input: { product: string; channel: FeedbackChannel; text: string; reviewId?: string; at?: Date }): Promise<FeedbackEvent[]> {
  const event = messageEvent({ ...input, at: (input.at ?? new Date()).toISOString() })
  if (!event) return Promise.resolve([])
  return update(folder, orchestraName, async () => [event])
}

/** playbook.md が無ければ雛形を作る。あれば決して上書きしない。作ったら true */
export async function seedPlaybook(folder: string, orchestraName: string): Promise<boolean> {
  return enqueue(folder, async () => {
    const dir = await feedbackDir(folder)
    const path = join(dir, PLAYBOOK_FILE)
    if (await isLink(path)) throw new SubagentLinkError(path)
    try {
      await writeFile(path, playbookTemplate(orchestraName), { encoding: 'utf8', flag: 'wx', mode: 0o644 })
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return false
      throw err
    }
  })
}

/**
 * 画面から開く前に、そのファイルがあるようにする（記録はまだ何も無ければ空の log.md、プレイブックは雛形）。
 * オーケストラのフォルダからの相対パスを返す
 */
export async function ensureFeedbackFile(folder: string, orchestraName: string, which: 'log' | 'playbook'): Promise<string> {
  if (which === 'playbook') {
    await seedPlaybook(folder, orchestraName)
    return PLAYBOOK_PATH
  }
  await enqueue(folder, async () => {
    const dir = await feedbackDir(folder)
    const path = join(dir, FEEDBACK_LOG_FILE)
    if (await isLink(path)) throw new SubagentLinkError(path)
    try { await lstat(path); return } catch { /* 無ければ作る（想定内） */ }
    await writeAtomic(dir, FEEDBACK_LOG_FILE, renderFeedbackLog(foldFeedback(await readEventsIn(dir)), orchestraName))
  })
  return FEEDBACK_LOG_PATH
}
