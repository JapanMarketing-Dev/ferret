import { lstat, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Project } from '@shared/types'
import { AGENT_SKILL_AGENTS, agentConfigDir } from '@shared/agentSkill'
import {
  FEEDBACK_LIST_FILE,
  FEEDBACK_SKILL_NAME,
  extractPlanFeedback,
  extractRecordingFeedback,
  isFeedbackList,
  isFeedbackSkill,
  renderFeedbackList,
  renderFeedbackSkill,
  reviewFolderTime,
  type FeedbackEntry
} from '@shared/feedbackSkill'
import { PROJECTS_LIST_FILE, PROJECTS_SKILL_NAME, referenceProjects } from '@shared/projectsSkill'
import { VALUE_USECASE_DIR } from '@shared/valueUseCase'
import { VISUAL_REVIEW_DIR } from '@shared/visualReview'
import { writePrivateFileAtomic } from './atomicFile'

/**
 * skill「ferret-feedback」（@shared/feedbackSkill）を入れ、横の feedback.md に登録したプロジェクトの人の指摘を集める
 * （起動時と、プロジェクトの一覧が変わったとき。ferret-projects と同じ流れ）。
 * - プロジェクトのフォルダは読むだけ。.ferret の下の決まった場所だけを、数と大きさを決めて読む（普通のファイルだけ）
 * - 印の無い同名の skill・リンクは触らない
 */

/** 1つのフォルダで読むファイルの上限 */
const MAX_FILES_PER_DIR = 300
/** 1つのファイルの大きさの上限 */
const MAX_FILE_BYTES = 1024 * 1024

async function readSmallFile(path: string): Promise<string | null> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    if ((await lstat(dir)).isSymbolicLink()) return []
    return (await readdir(dir)).slice(0, MAX_FILES_PER_DIR)
  } catch {
    return []
  }
}

/** 1つのプロジェクトの指摘を集める */
export async function projectFeedback(project: Pick<Project, 'name' | 'folderPath'>): Promise<FeedbackEntry[]> {
  const entries: FeedbackEntry[] = []
  for (const [dir, source] of [[VISUAL_REVIEW_DIR, 'visual-review'], [VALUE_USECASE_DIR, 'value-usecases']] as const) {
    const base = join(project.folderPath, ...dir.split('/'))
    for (const name of await listDir(base)) {
      if (!name.endsWith('.json')) continue
      const file = join(base, name)
      const text = await readSmallFile(file)
      if (text !== null) entries.push(...extractPlanFeedback(text, project.name, source, file))
    }
  }
  const reviews = join(project.folderPath, '.ferret', 'reviews')
  for (const name of await listDir(reviews)) {
    const file = join(reviews, name, 'feedback.md')
    const text = await readSmallFile(file)
    if (text !== null) entries.push(...extractRecordingFeedback(text, project.name, file, reviewFolderTime(name)))
  }
  return entries
}

/** feedback.md の中身（登録したプロジェクト全部から） */
export async function buildFeedbackList(projects: readonly Project[]): Promise<string> {
  const { local } = referenceProjects(projects)
  const all = await Promise.all(local.map((p) => projectFeedback(p)))
  return renderFeedbackList(all.flat())
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch { return false }
}

async function isLink(path: string): Promise<boolean> {
  try { return (await lstat(path)).isSymbolicLink() } catch { return false }
}

/** skill と feedback.md を入れて、今の版・今の指摘に合わせる。書いたファイルの数を返す */
export async function syncFeedbackSkill(version: string, projects: readonly Project[], home: string = homedir(), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { writeSkill } = await import('./agentSkill')
  let list: string | null = null
  let written = 0
  for (const agent of AGENT_SKILL_AGENTS) {
    const configDir = agentConfigDir(agent, env, home, join)
    if (!(await exists(configDir))) continue
    const dir = join(configDir, 'skills', FEEDBACK_SKILL_NAME)
    const skillPath = join(dir, 'SKILL.md')
    const listPath = join(dir, FEEDBACK_LIST_FILE)
    if (await isLink(dir) || await isLink(skillPath) || await isLink(listPath)) continue
    const current = await readFile(skillPath, 'utf8').catch(() => null)
    if (current !== null && !isFeedbackSkill(current)) continue
    const currentList = await readFile(listPath, 'utf8').catch(() => null)
    if (currentList !== null && !isFeedbackList(currentList)) continue
    const text = renderFeedbackSkill(version, listPath, join(configDir, 'skills', PROJECTS_SKILL_NAME, PROJECTS_LIST_FILE))
    if (current !== text) {
      await writeSkill(skillPath, text)
      written++
    }
    list ??= await buildFeedbackList(projects)
    if (currentList !== list) {
      await mkdir(dir, { recursive: true })
      await writePrivateFileAtomic(listPath, list)
      written++
    }
  }
  return written
}
