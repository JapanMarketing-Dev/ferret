import { lstat, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AGENT_SKILL_AGENTS, agentConfigDir } from '@shared/agentSkill'
import { BROWSER_SKILL_NAME, isBrowserSkill, renderBrowserSkill } from '@shared/browserSkill'

/**
 * skill「ferret-browser」を、使っている Agent（設定のフォルダがあるもの）に入れて今の版に合わせる。
 * 同じ名前で Ferret のものでない skill（印の無いもの）・リンクは触らない（agentMail の skill と同じ）
 */
export async function syncBrowserSkill(version: string, home: string = homedir(), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { writeSkill } = await import('./agentSkill')
  const text = renderBrowserSkill(version)
  for (const agent of AGENT_SKILL_AGENTS) {
    const configDir = agentConfigDir(agent, env, home, join)
    const path = join(configDir, 'skills', BROWSER_SKILL_NAME, 'SKILL.md')
    const current = await readFile(path, 'utf8').catch(() => null)
    if (current !== null && !isBrowserSkill(current)) continue
    if (current === text) continue
    const configured = await lstat(configDir).then(() => true, () => false)
    if (!configured) continue
    if (current !== null && (await lstat(path)).isSymbolicLink()) continue
    await writeSkill(path, text)
  }
}
