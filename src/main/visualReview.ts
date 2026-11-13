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

function planDir(root: string): string {
  return join(root, ...VISUAL_REVIEW_DIR.split('/'))
}

/** 計画を新しい順に。読めないものは理由を付けて別に返す */
export async function listVisualPlans(root: string): Promise<PlanListing> {
  const dir = planDir(root)
  try {
    assertContained(root, dir)
  } catch {
    return { plans: [], invalid: [] }
  }
  let names: string[]
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name)
  } catch {
    return { plans: [], invalid: [] } // まだ無い（想定内）
  }
  const invalid: PlanListing['invalid'] = []
  const entries: Array<{ plan: VisualPlan; mtime: number }> = []
  const files = names.filter((name) => name.endsWith('.json')).slice(0, LIMITS.plans * 2)
  await Promise.all(files.map(async (name) => {
    const id = planIdFromFile(name)
    if (!id) { invalid.push({ file: name, reason: 'invalid file name (use [A-Za-z0-9._-], up to 80 characters)' }); return }
    const file = join(dir, name)
    try {
      const [text, info] = await Promise.all([readFileNoFollow(file, 'utf8', { maxBytes: LIMITS.planBytes }), stat(file)])
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch {
        invalid.push({ file: name, reason: 'not valid JSON' })
        return
      }
      const parsed = parseVisualPlan(raw, id)
      if (parsed.ok) entries.push({ plan: parsed.plan, mtime: info.mtimeMs })
      else invalid.push({ file: name, reason: parsed.reason })
    } catch {
      invalid.push({ file: name, reason: 'cannot read (too large, a link, or not a regular file)' })
    }
  }))
  invalid.sort((a, b) => a.file.localeCompare(b.file))
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
  if (!isValidPlanId(id)) return null
  const file = join(planDir(root), `${id}.json`)
  try {
    assertContained(root, file)
    const raw = JSON.parse(await readFileNoFollow(file, 'utf8', { maxBytes: LIMITS.planBytes })) as unknown
    const parsed = parseVisualPlan(raw, id)
    if (!parsed.ok || typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
    return { raw: raw as Record<string, unknown>, plan: parsed.plan }
  } catch {
    return null
  }
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
  const file = join(planDir(root), `${id}.json`)
  assertContained(root, file)
  await writeFileNoFollow(file, `${JSON.stringify(next, null, 2)}\n`)
  const parsed = parseVisualPlan(next, id)
  return parsed.ok ? parsed.plan : null
}
