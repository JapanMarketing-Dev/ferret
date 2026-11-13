import { lstat, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AGENT_SKILL_AGENTS, agentConfigDir } from '@shared/agentSkill'
import { VISUAL_REVIEW_SKILL_NAME, isVisualReviewSkill, renderVisualReviewSkill } from '@shared/visualReviewSkill'

/**
 * skill「ferret-visual-review」を、使っている Agent（設定のフォルダがあるもの）に入れて今の版に合わせる（ferret-browser と同じ決まり）。
 * 同じ名前で Ferret のものでない skill（印の無いもの）・リンクは触らない。書いたファイルの数を返す
 */
export async function syncVisualReviewSkill(version: string, home: string = homedir(), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { writeSkill } = await import('./agentSkill')
  const text = renderVisualReviewSkill(version)
  let written = 0
  for (const agent of AGENT_SKILL_AGENTS) {
    const configDir = agentConfigDir(agent, env, home, join)
    const configured = await lstat(configDir).then(() => true, () => false)
    if (!configured) continue
    const dir = join(configDir, 'skills', VISUAL_REVIEW_SKILL_NAME)
    const path = join(dir, 'SKILL.md')
    if (await lstat(dir).then((st) => st.isSymbolicLink(), () => false)) continue
    if (await lstat(path).then((st) => st.isSymbolicLink(), () => false)) continue
    const current = await readFile(path, 'utf8').catch(() => null)
    if (current !== null && !isVisualReviewSkill(current)) continue
    if (current === text) continue
    await writeSkill(path, text)
    written++
  }
  return written
}
