import { lstat, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Project } from '@shared/types'
import { AGENT_SKILL_AGENTS, agentConfigDir } from '@shared/agentSkill'
import {
  FEEDBACK_LIST_FILE,
  FEEDBACK_SKILL_NAME,
  extractPlanApprovals,
  extractPlanFeedback,
  extractRecordingFeedback,
  isFeedbackList,
  isFeedbackSkill,
  renderFeedbackList,
  renderFeedbackSkill,
  reviewFolderTime,
  type ApprovalEntry,
  type FeedbackCloudExtra,
  type FeedbackEntry
} from '@shared/feedbackSkill'
import { PROJECTS_LIST_FILE, PROJECTS_SKILL_NAME, referenceProjects } from '@shared/projectsSkill'
import { VALUE_USECASE_DIR } from '@shared/valueUseCase'
import { VISUAL_REVIEW_DIR } from '@shared/visualReview'
import { writePrivateFileAtomic } from './atomicFile'
import { collectAgentPrompts } from './agentPrompts'
import { resolveImages } from './feedbackImages'

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

/** 1つのプロジェクトの指摘と、承認に添えた言葉を集める */
export async function projectSignals(project: Pick<Project, 'name' | 'folderPath'>): Promise<{ entries: FeedbackEntry[]; approvals: ApprovalEntry[] }> {
  const entries: FeedbackEntry[] = []
  const approvals: ApprovalEntry[] = []
  for (const [dir, source] of [[VISUAL_REVIEW_DIR, 'visual-review'], [VALUE_USECASE_DIR, 'value-usecases']] as const) {
    const base = join(project.folderPath, ...dir.split('/'))
    for (const name of await listDir(base)) {
      if (!name.endsWith('.json')) continue
      const file = join(base, name)
      const text = await readSmallFile(file)
      if (text === null) continue
      // 囲んだ画面・録画のレビューの画像は、このプロジェクトの .ferret/ の中のものだけ
      entries.push(...await resolveImages(extractPlanFeedback(text, project.name, source, file, project.folderPath), () => join(project.folderPath, '.ferret')))
      approvals.push(...extractPlanApprovals(text, project.name, source, file))
    }
  }
  const reviews = join(project.folderPath, '.ferret', 'reviews')
  for (const name of await listDir(reviews)) {
    const dir = join(reviews, name)
    const file = join(dir, 'feedback.md')
    const text = await readSmallFile(file)
    // 録画の指摘の画像は、そのレビューのフォルダの ./NN.png だけ
    if (text !== null) entries.push(...await resolveImages(extractRecordingFeedback(text, project.name, file, reviewFolderTime(name)), () => dir))
  }
  return { entries, approvals }
}

/** 1つのプロジェクトの指摘を集める */
export async function projectFeedback(project: Pick<Project, 'name' | 'folderPath'>): Promise<FeedbackEntry[]> {
  return (await projectSignals(project)).entries
}

/**
 * Ferret アカウントにログインしていれば、この PC の指摘を送り、ほかの PC とチームの指摘を返す（src/main/feedbackCloud/service.ts）。
 * ログインしていない・失敗して控えも無いときは null（feedback.md はこの PC の分だけになる）。投げない
 */
export type FeedbackCloudHook = (entries: readonly FeedbackEntry[]) => Promise<FeedbackCloudExtra | null>

/** Agent の履歴を読む場所（ホームと環境変数。CODEX_HOME・CLAUDE_CONFIG_DIR など）。渡さなければ Agent への指示は集めない */
export interface AgentHistoryPlace {
  home: string
  env: NodeJS.ProcessEnv
}

/** 登録したプロジェクト全部の指摘と承認の言葉。agents があれば、Agent に人が打った指示も足す */
export async function collectFeedback(projects: readonly Project[], agents?: AgentHistoryPlace): Promise<{ entries: FeedbackEntry[]; approvals: ApprovalEntry[] }> {
  const { local } = referenceProjects(projects)
  const [all, prompts] = await Promise.all([
    Promise.all(local.map((p) => projectSignals(p))),
    agents ? collectAgentPrompts(local, agents.home, agents.env).catch(() => []) : Promise.resolve([])
  ])
  return { entries: [...all.flatMap((a) => a.entries), ...prompts], approvals: all.flatMap((a) => a.approvals) }
}

/** feedback.md の中身（登録したプロジェクト全部から。cloud があればほかの PC とチームの指摘も） */
export async function buildFeedbackList(projects: readonly Project[], cloud?: FeedbackCloudHook, agents?: AgentHistoryPlace): Promise<string> {
  const { entries, approvals } = await collectFeedback(projects, agents)
  const extra = cloud ? await cloud(entries).catch(() => null) : null
  return renderFeedbackList(entries, undefined, approvals, extra ?? undefined)
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch { return false }
}

async function isLink(path: string): Promise<boolean> {
  try { return (await lstat(path)).isSymbolicLink() } catch { return false }
}

/** skill と feedback.md を入れて、今の版・今の指摘に合わせる。書いたファイルの数を返す */
export async function syncFeedbackSkill(version: string, projects: readonly Project[], home: string = homedir(), env: NodeJS.ProcessEnv = process.env, cloud?: FeedbackCloudHook): Promise<number> {
  const { writeSkill } = await import('./agentSkill')
  // ログインしていれば、skill を入れた Agent が無くても送る（ほかの PC・チームが読めるように）
  let list: string | null = cloud ? await buildFeedbackList(projects, cloud, { home, env }) : null
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
    list ??= await buildFeedbackList(projects, undefined, { home, env })
    if (currentList !== list) {
      await mkdir(dir, { recursive: true })
      await writePrivateFileAtomic(listPath, list)
      written++
    }
  }
  return written
}
