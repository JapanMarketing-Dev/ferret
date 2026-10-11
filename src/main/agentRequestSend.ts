import { composeAgentRequest, resolveAgentRequests, type AgentRequest, type AgentRequestPrefs, type RequestLanguage } from '@shared/agentRequests'
import type { Project } from '@shared/types'

/**
 * 依頼文（全体のダッシュボードの「Agent への依頼」）を、開いているプロジェクトの Agent へ送る。宛先は「Agent へ送信」の auto と同じ。
 * 全体（すべてのプロダクト）からなら、プロダクトごとの subagent で同時に進め、プロダクトの中でも並行するよう添える（@shared/agentRequests）。
 * Electron に依存しない（送り先の探し方と送り方は deps で受け取る。src/main/index.ts の agentRequests:send が使う）
 */
export interface AgentRequestSendDeps {
  resolveTarget: (folder: string | null) => Promise<string | null>
  send: (terminalId: string, text: string) => Promise<{ ok: boolean; message: string }>
  noAgentMessage: string
  /** 送れたあとに、送った依頼を渡す（オーケストラのフィードバックの記録）。ここで投げても送信の結果は変えない */
  onSent?: (picked: AgentRequest[]) => void
}

export async function sendAgentRequestsTo(
  deps: AgentRequestSendDeps,
  input: { ids: unknown; prefs: AgentRequestPrefs | undefined; lang: RequestLanguage; project: Pick<Project, 'orchestrator' | 'editorWorkspace'> | undefined; folder: string | null }
): Promise<{ ok: boolean; message: string; noAgent?: boolean } | 'empty'> {
  const wanted = Array.isArray(input.ids) ? input.ids.filter((id): id is string => typeof id === 'string') : []
  const picked = resolveAgentRequests(input.prefs, input.lang).filter((r) => wanted.includes(r.id) && r.text.trim())
  if (!picked.length) return 'empty'
  const project = input.project
  const lang = input.lang
  const text = composeAgentRequest(picked, lang, !!(project?.orchestrator || project?.editorWorkspace))
  const target = await deps.resolveTarget(input.folder)
  if (!target) return { ok: false, message: deps.noAgentMessage, noAgent: true }
  const { ok, message } = await deps.send(target, text)
  if (ok && deps.onSent) {
    try { deps.onSent(picked) } catch { /* 記録の失敗で送信を失敗にしない（想定内） */ }
  }
  return { ok, message }
}
