import type { TuiAgent } from '@shared/types'

/**
 * 「この Agent のタブを開いて」の依頼（指摘の画面の「Agentへ送信」で、どこにも Agent が居なかったとき）。
 * 開く側は TerminalPane。terminalCommand.ts と同じく window のイベントで渡す。
 */
const LAUNCH_EVENT = 'ade:launch-agent'

export function requestAgentLaunch(agent: TuiAgent): void {
  window.dispatchEvent(new CustomEvent(LAUNCH_EVENT, { detail: { agent } }))
}

/** タブを開く側（TerminalPane）が購読する。戻り値で購読をやめる */
export function onAgentLaunchRequest(listener: (agent: TuiAgent) => void): () => void {
  const wrapped = (event: Event) => {
    const detail = (event as CustomEvent<{ agent?: TuiAgent }>).detail
    if (detail?.agent) listener(detail.agent)
  }
  window.addEventListener(LAUNCH_EVENT, wrapped)
  return () => window.removeEventListener(LAUNCH_EVENT, wrapped)
}
