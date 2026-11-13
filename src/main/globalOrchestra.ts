import { mkdirSync, statSync } from 'node:fs'
import { lstat, mkdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Project } from '@shared/types'
import { agentConfigDir } from '@shared/agentSkill'
import { isGlobalOrchestra } from '@shared/orchestras'
import { isProjectsList } from '@shared/projectsSkill'
import {
  CLAUDE_GLOBAL_RULES_FILE,
  GLOBAL_FOLDER_NAME,
  GLOBAL_PROJECTS_FILE,
  GLOBAL_RULES_FILE,
  globalRulesBody,
  globalRulesTemplate,
  isFerretGlobalRules,
  renderClaudeGlobalRules,
  renderCodexGlobalBlock,
  withCodexGlobalBlock
} from '@shared/globalOrchestra'
import { findProjectByFolder, newProject } from './projects'

/**
 * Ferret が既定で用意するオーケストラ「グローバル」。登録したプロジェクトの全部が対象で、「全部に〜を適用して」をここの Agent に頼む。
 *
 * - 置き場は work と同じ決まり（src/main/workProject.ts）: 配布版は ~/Ferret/global、開発版・E2E・--user-data-dir の起動は <設定フォルダ>/global
 * - 中身はほかのオーケストラと同じ（プロジェクトへのリンク・subagent・CLAUDE.md / AGENTS.md / README.md の Ferret の欄。src/main/orchestrator.ts）に、
 *   rules.md（全体のルール。人と Agent が書く）と projects.md（プロジェクトの一覧。ferret-projects の skill と同じものを書く）を足す
 * - rules.md の中身は、すべてのオーケストラの欄と subagent、Claude Code の <設定のフォルダ>/rules/ferret-global-rules.md、
 *   Codex の全体の AGENTS.md の印の欄へ写す（@shared/globalOrchestra）。利用者の文には触れない
 * - 隠すときはアーカイブにする。登録を外しても次の起動で戻る（work と同じ）
 */

export function globalFolderPath(where: { home: string; configDir: string; shared: boolean }): string {
  return where.shared ? join(where.home, 'Ferret', GLOBAL_FOLDER_NAME) : join(where.configDir, GLOBAL_FOLDER_NAME)
}

/**
 * 一覧にグローバルのオーケストラが無ければ足す（初めての起動と、以前の版からの更新で1回）。
 * - 印の付いたものがあればそのまま（アーカイブしてあっても、名前・置き場を変えてあっても）
 * - 同じフォルダを利用者が自分で登録していれば、それをグローバルのオーケストラにする（所属の印は外す）
 * - 無ければ一覧の先頭に足す（オーケストラの並びでも先頭に固定される。@shared/projectOrder）
 * 変えなければ同じ配列を返す
 */
export function withGlobalOrchestra(projects: Project[], folder: string, name: string, id?: string, now?: Date): Project[] {
  if (projects.some(isGlobalOrchestra)) return projects
  const existing = findProjectByFolder(projects, folder)
  const mark = (p: Project): Project => {
    const { orchestraId: _drop, orchestraExcluded: _excluded, work: _work, ...rest } = p
    return { ...rest, orchestrator: true, editorWorkspace: true, global: true }
  }
  if (existing) return projects.map((p) => (p.id === existing.id ? mark(p) : p))
  return [mark({ ...newProject(folder, id, now), name }), ...projects]
}

/** フォルダが無ければ作る。作った・あったなら true（例外は投げない） */
export function ensureGlobalFolder(folder: string): boolean {
  try {
    mkdirSync(folder, { recursive: true })
    return statSync(folder).isDirectory()
  } catch {
    return false
  }
}

async function isLink(path: string): Promise<boolean> {
  try { return (await lstat(path)).isSymbolicLink() } catch { return false }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch { return false }
}

async function readText(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8') } catch { return null } // 無い（想定内）
}

/** rules.md から写す中身（無い・リンク・雛形のままなら空文字） */
export async function readGlobalRules(folder: string): Promise<string> {
  const path = join(folder, GLOBAL_RULES_FILE)
  if (await isLink(path)) return ''
  return globalRulesBody(await readText(path))
}

/**
 * グローバルのフォルダの rules.md（無いときだけ雛形）と projects.md（今の登録の一覧）を書く。
 * projects.md は Ferret の印のあるもの・無いものだけを書き直す（利用者が同じ名前で置いたものは触らない）。リンクは書かない
 */
export async function syncGlobalFiles(folder: string, projects: readonly Project[], lang: 'ja' | 'en'): Promise<void> {
  const { writeAtomic } = await import('./orchestrator')
  const rulesPath = join(folder, GLOBAL_RULES_FILE)
  if (!(await exists(rulesPath))) await writeAtomic(folder, GLOBAL_RULES_FILE, globalRulesTemplate(lang))
  const listPath = join(folder, GLOBAL_PROJECTS_FILE)
  if (await isLink(listPath)) return
  const current = await readText(listPath)
  if (current !== null && !isProjectsList(current)) return
  const { buildProjectsList } = await import('./projectsSkill')
  const list = await buildProjectsList(projects)
  if (current !== list) await writeAtomic(folder, GLOBAL_PROJECTS_FILE, list)
}

export interface AgentRulesResult {
  /** 書いた・消したファイル */
  changed: string[]
  /** Ferret のものでない同名のファイル・リンクなので触らなかったもの */
  skipped: string[]
}

/**
 * 全体のルールを、使っている Agent（設定のフォルダがあるもの）の全体の指示へ写す。ルールが空なら Ferret が書いたものを外す。
 * - Claude Code: <設定のフォルダ>/rules/ferret-global-rules.md（Ferret だけが持つファイル。印の無い同名のもの・リンクは触らない）
 * - Codex: <設定のフォルダ>/AGENTS.md の印で囲んだ欄だけ（印の外の利用者の文はそのまま。リンクなら触らない）
 */
export async function syncAgentGlobalRules(body: string, rulesPath: string, home: string = homedir(), env: NodeJS.ProcessEnv = process.env): Promise<AgentRulesResult> {
  const { writeAtomic } = await import('./orchestrator')
  const result: AgentRulesResult = { changed: [], skipped: [] }
  const claudeDir = agentConfigDir('claude', env, home, join)
  if (await exists(claudeDir)) {
    const dir = join(claudeDir, 'rules')
    const path = join(dir, CLAUDE_GLOBAL_RULES_FILE)
    const want = renderClaudeGlobalRules(body, rulesPath)
    if (await isLink(dir) || await isLink(path)) result.skipped.push(path)
    else {
      const current = await readText(path)
      if (current !== null && !isFerretGlobalRules(current)) result.skipped.push(path)
      else if (want === null) {
        if (current !== null) { await rm(path, { force: true }); result.changed.push(path) }
      } else if (current !== want) {
        await mkdir(dir, { recursive: true })
        await writeAtomic(dir, CLAUDE_GLOBAL_RULES_FILE, want)
        result.changed.push(path)
      }
    }
  }
  const codexDir = agentConfigDir('codex', env, home, join)
  if (await exists(codexDir)) {
    const path = join(codexDir, 'AGENTS.md')
    if (await isLink(path)) result.skipped.push(path)
    else {
      const next = withCodexGlobalBlock(await readText(path), body.trim() ? renderCodexGlobalBlock(body, rulesPath) : null)
      if (next !== null) {
        await writeAtomic(codexDir, 'AGENTS.md', next)
        result.changed.push(path)
      }
    }
  }
  return result
}
