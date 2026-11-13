import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  LIMITS,
  VISUAL_REVIEW_DIR,
  applyResponse,
  imageMime,
  isValidPlanId,
  normalizePlanImage,
  parseVisualPlan,
  planIdFromFile,
  sortPlans,
  type PlanListing,
  type PlanResponse,
  type VisualPlan
} from '@shared/visualReview'
import { assertContained, readFileNoFollow, writeFileNoFollow } from './sessions/containment'

/**
 * ビジュアルレビューの計画（@shared/visualReview）を、開いているプロジェクトの `.ferret/visual-review/` から読む・返事を書き足す。
 * - 読むのはそのフォルダの直下の <id>.json だけ。リンク・大きすぎるものは読まない（Agent が書くフォルダなので）
 * - 画像は `.ferret/` の下の画像だけを、リンクをたどらずに読み、data URL で画面へ渡す
 * - 返事は生の JSON に書き足し、リンクを置き換えない書き方（writeFileNoFollow）で戻す
 */

type Parse<T> = (raw: unknown, id: string) => { ok: true; value: T } | { ok: false; reason: string }

/**
 * Agent が書く文書のフォルダ（`dirRel` の直下の <id>.json）を読む。ビジュアルレビューの計画と価値ユースケース（./valueUseCase）で共用。
 * 読めないものは理由を付けて別に返す。リンク・大きすぎるもの・普通のファイルでないものは読まない
 */
export async function listReviewDocs<T>(root: string, dirRel: string, parse: Parse<T>, opts: { maxBytes: number; maxFiles: number }): Promise<{ entries: Array<{ plan: T; mtime: number }>; invalid: Array<{ file: string; reason: string }> }> {
  const dir = join(root, ...dirRel.split('/'))
  try {
    assertContained(root, dir)
  } catch {
    return { entries: [], invalid: [] }
  }
  let names: string[]
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name)
  } catch {
    return { entries: [], invalid: [] } // まだ無い（想定内）
  }
  const invalid: Array<{ file: string; reason: string }> = []
  const entries: Array<{ plan: T; mtime: number }> = []
  const files = names.filter((name) => name.endsWith('.json')).slice(0, opts.maxFiles)
  await Promise.all(files.map(async (name) => {
    const id = planIdFromFile(name)
    if (!id) { invalid.push({ file: name, reason: 'invalid file name (use [A-Za-z0-9._-], up to 80 characters)' }); return }
    const file = join(dir, name)
    try {
      const [text, info] = await Promise.all([readFileNoFollow(file, 'utf8', { maxBytes: opts.maxBytes }), stat(file)])
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch {
        invalid.push({ file: name, reason: 'not valid JSON' })
        return
      }
      const parsed = parse(raw, id)
      if (parsed.ok) entries.push({ plan: parsed.value, mtime: info.mtimeMs })
      else invalid.push({ file: name, reason: parsed.reason })
    } catch {
      invalid.push({ file: name, reason: 'cannot read (too large, a link, or not a regular file)' })
    }
  }))
  invalid.sort((a, b) => a.file.localeCompare(b.file))
  return { entries, invalid }
}

/** 文書1つ（生の JSON と読んだもの）。読めなければ null */
export async function readReviewDoc<T>(root: string, dirRel: string, id: string, parse: Parse<T>, maxBytes: number): Promise<{ raw: Record<string, unknown>; value: T } | null> {
  if (!isValidPlanId(id)) return null
  const file = join(root, ...dirRel.split('/'), `${id}.json`)
  try {
    assertContained(root, file)
    const raw = JSON.parse(await readFileNoFollow(file, 'utf8', { maxBytes })) as unknown
    const parsed = parse(raw, id)
    if (!parsed.ok || typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
    return { raw: raw as Record<string, unknown>, value: parsed.value }
  } catch {
    return null
  }
}

/** 文書に書き戻す（リンクを置き換えない書き方） */
export async function writeReviewDoc(root: string, dirRel: string, id: string, next: Record<string, unknown>): Promise<void> {
  const file = join(root, ...dirRel.split('/'), `${id}.json`)
  assertContained(root, file)
  await writeFileNoFollow(file, `${JSON.stringify(next, null, 2)}\n`)
}

const parsePlan: Parse<VisualPlan> = (raw, id) => {
  const parsed = parseVisualPlan(raw, id)
  return parsed.ok ? { ok: true, value: parsed.plan } : parsed
}

/** 計画を新しい順に。読めないものは理由を付けて別に返す */
export async function listVisualPlans(root: string): Promise<PlanListing> {
  const { entries, invalid } = await listReviewDocs(root, VISUAL_REVIEW_DIR, parsePlan, { maxBytes: LIMITS.planBytes, maxFiles: LIMITS.plans * 2 })
  return { plans: sortPlans(entries), invalid }
}

/** 計画の画像を data URL にする。`.ferret/` の外・画像でない・リンク・大きすぎるものは null */
export async function readPlanImage(root: string, rel: string): Promise<string | null> {
  const normalized = normalizePlanImage(rel)
  if (!normalized || normalized !== rel) return null
  const file = join(root, ...normalized.split('/'))
  try {
    assertContained(root, file)
    const bytes = await readFileNoFollow(file, null, { maxBytes: LIMITS.imageBytes })
    return `data:${imageMime(normalized)};base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}

/** 返事を書き足す前の計画（生の JSON と読んだもの）。読めなければ null */
export async function readVisualPlan(root: string, id: string): Promise<{ raw: Record<string, unknown>; plan: VisualPlan } | null> {
  const doc = await readReviewDoc(root, VISUAL_REVIEW_DIR, id, parsePlan, LIMITS.planBytes)
  return doc ? { raw: doc.raw, plan: doc.value } : null
}

/**
 * 計画に返事（承認・フィードバック）を書き足す。返事できない状態（待っていない）・読めなければ null。
 * 書いたあとの計画を返す
 */
export async function writeVisualPlanResponse(root: string, id: string, response: Omit<PlanResponse, 'revision'>): Promise<VisualPlan | null> {
  const current = await readVisualPlan(root, id)
  if (!current) return null
  const next = applyResponse(current.raw, current.plan, response)
  if (!next) return null
  await writeReviewDoc(root, VISUAL_REVIEW_DIR, id, next)
  const parsed = parseVisualPlan(next, id)
  return parsed.ok ? parsed.plan : null
}
