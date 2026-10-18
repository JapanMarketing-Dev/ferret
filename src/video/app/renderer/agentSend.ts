import { defaultLaunchAgent } from '@shared/sendTarget'
import { agentLabel } from '@shared/agentCatalog'
import { t } from '@shared/i18n'
import { launchAgentAndWait } from '@/lib/sendReview'

/**
 * 動画づくりの依頼文（「動画を完成させて」「投稿して」「直して」）を、今のプロジェクトの Agent へ送る。
 * 宛先は Ferret の「Agent へ送信」の自動と同じ（選んでいるターミナル → 同じプロジェクトの Agent）。
 * どこにも Agent が居なければ、既定の Agent（設定の startupAgents の先頭）のタブを開き、入力を受け付けるまで待ってから送る。
 */
export async function sendVideoPrompt(text: string, onStarting?: (agentName: string) => void): Promise<{ ok: boolean; message: string }> {
  let result = await window.ade.invoke('agent:sendText', text)
  if (!result.noAgent) return result
  const settings = await window.ade.invoke('app:settings')
  const agent = defaultLaunchAgent(settings.agents?.startupAgents ?? [], settings.agents?.disabledAgents ?? [])
  const name = agentLabel(agent)
  onStarting?.(name)
  const started = await launchAgentAndWait(agent)
  if (!started) return { ok: false, message: t('review.agentStartFailed', { agent: name }) }
  result = await window.ade.invoke('agent:sendText', text)
  return result.noAgent ? { ok: false, message: t('review.agentStartFailed', { agent: name }) } : result
}
