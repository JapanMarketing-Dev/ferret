import type { AgentOption, BuiltinAgent, TuiAgent } from './types'

/**
 * 「Agentへ送信」の宛先（main・renderer・単体テストで共用する純粋な処理）。
 *
 * - auto: 選んでいるターミナル → 同じプロジェクトで動いている Agent → どこにも居なければ既定の Agent を起動
 * - agent: その Agent。動いているタブがあればそこ、無ければタブを開いて起動してから送る
 * - terminal: 特定のタブ（同じ Agent を2つ動かしているときに選ぶ）
 */
export type SendTarget =
  | { kind: 'auto' }
  | { kind: 'agent'; agent: TuiAgent }
  | { kind: 'terminal'; terminalId: string; agent: TuiAgent | null }

export const AUTO_TARGET: SendTarget = { kind: 'auto' }

/**
 * 送信の依頼。review:send の2つ目の引数。
 * 古い形（選んでいるターミナルの id だけ）も受ける（parseSendRequest）。
 */
export interface SendRequest {
  target: SendTarget
  /** いまフォーカスしているターミナル（auto のときの最初の候補） */
  focusedTerminalId?: string | null
  /**
   * 送る本文を差し替える（Agent からの確認に返答して1件だけ送り直す、など）。
   * 省略すると feedback.md を読む既定の指示文
   */
  text?: string
}

/** 差し替える本文の上限（PTY へ1回で貼れる量に収める。sanitize.ts の上限より十分小さく） */
export const MAX_SEND_TEXT = 20_000

const AGENT_ID = /^(?:[a-z0-9][a-z0-9-]{0,47}|custom:[a-z0-9][a-z0-9-]{0,47})$/

function agentId(value: unknown): TuiAgent | null {
  return typeof value === 'string' && AGENT_ID.test(value) ? (value as TuiAgent) : null
}

/** 保存した値・IPC で受けた値を型どおりに直す。壊れていれば null */
export function parseSendTarget(raw: unknown): SendTarget | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.kind === 'auto') return AUTO_TARGET
  if (r.kind === 'agent') {
    const agent = agentId(r.agent)
    return agent ? { kind: 'agent', agent } : null
  }
  if (r.kind === 'terminal' && typeof r.terminalId === 'string' && r.terminalId.length > 0 && r.terminalId.length < 200) {
    return { kind: 'terminal', terminalId: r.terminalId, agent: agentId(r.agent) }
  }
  return null
}

/** review:send の2つ目の引数を読む。文字列・null は古い形（フォーカス中のターミナル） */
export function parseSendRequest(raw: unknown): SendRequest {
  if (raw === null || raw === undefined || typeof raw === 'string') return { target: AUTO_TARGET, focusedTerminalId: raw || null }
  const r = (typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const text = typeof r.text === 'string' && r.text.trim() ? r.text.slice(0, MAX_SEND_TEXT) : undefined
  return {
    target: parseSendTarget(r.target) ?? AUTO_TARGET,
    focusedTerminalId: typeof r.focusedTerminalId === 'string' ? r.focusedTerminalId : null,
    ...(text ? { text } : {})
  }
}

export function sendTargetKey(target: SendTarget): string {
  if (target.kind === 'agent') return `agent:${target.agent}`
  if (target.kind === 'terminal') return `terminal:${target.terminalId}`
  return 'auto'
}

/** 動いているターミナル（renderer が terminal:list と terminal:agentState から作る） */
export interface RunningAgentTerminal {
  id: string
  /** 中で動いていると分かった Agent。分からなければ null */
  agent: TuiAgent | null
  /** タブの番号（1始まり。表示用） */
  index: number
}

export interface SendTargetOption {
  key: string
  target: SendTarget
  agent: TuiAgent | null
  /** 動いているタブか（無ければ選んだときに起動する） */
  running: boolean
  /** 同じ Agent のタブが複数あるときの番号 */
  tab?: number
}

/**
 * 宛先の一覧。動いている Agent のタブ → 有効でインストール済みの Agent（動いていないもの）の順。
 * 同じ Agent のタブが1つなら Agent の行にまとめる（選ぶとそのタブへ送る）。2つ以上あるときだけタブごとに出す
 */
/** ターミナルを開いたフォルダ（cwd）が、プロジェクトのフォルダかその中か。宛先はそのプロジェクトのターミナルだけにする */
export function isInsideDir(cwd: string, dir: string): boolean {
  const base = dir.replace(/[\\/]+$/, '')
  return cwd === base || cwd.startsWith(`${base}/`) || cwd.startsWith(`${base}\\`)
}

/**
 * 宛先の候補にするターミナル。開いているプロジェクトのものだけ（ほかのプロジェクトのタブは出さない）。
 * タブの番号はこのプロジェクトの中での順。プロジェクトが無ければ全部
 */
export function projectTerminals<T extends { cwd: string }>(list: readonly T[], projectDir: string | null): Array<T & { index: number }> {
  return list.filter((info) => !projectDir || isInsideDir(info.cwd, projectDir)).map((info, i) => ({ ...info, index: i + 1 }))
}

export function buildSendTargetOptions(agentOptions: readonly AgentOption[], running: readonly RunningAgentTerminal[]): SendTargetOption[] {
  const out: SendTargetOption[] = []
  const live = running.filter((r): r is RunningAgentTerminal & { agent: TuiAgent } => r.agent !== null)
  const byAgent = new Map<TuiAgent, typeof live>()
  for (const r of live) byAgent.set(r.agent, [...(byAgent.get(r.agent) ?? []), r])
  for (const [agent, tabs] of byAgent) {
    if (tabs.length === 1) out.push({ key: `agent:${agent}`, target: { kind: 'agent', agent }, agent, running: true })
    else for (const tab of tabs) out.push({ key: `terminal:${tab.id}`, target: { kind: 'terminal', terminalId: tab.id, agent }, agent, running: true, tab: tab.index })
  }
  for (const option of agentOptions) {
    if (!option.enabled || !option.installed || byAgent.has(option.id)) continue
    out.push({ key: `agent:${option.id}`, target: { kind: 'agent', agent: option.id }, agent: option.id, running: false })
  }
  return out
}

/**
 * 覚えていた宛先を、いま選べるものに直す。
 * - タブを覚えていて、そのタブが無くなっていれば、そのタブの Agent（起動して送る）
 * - Agent を覚えていて、無効にした・アンインストールしたなら auto
 */
export function resolveRememberedTarget(saved: SendTarget | null, agentOptions: readonly AgentOption[], running: readonly RunningAgentTerminal[]): SendTarget {
  if (!saved || saved.kind === 'auto') return AUTO_TARGET
  const usable = (agent: TuiAgent) => running.some((r) => r.agent === agent) || agentOptions.some((o) => o.id === agent && o.enabled && o.installed)
  if (saved.kind === 'terminal') {
    if (running.some((r) => r.id === saved.terminalId && r.agent !== null)) return saved
    return saved.agent && usable(saved.agent) ? { kind: 'agent', agent: saved.agent } : AUTO_TARGET
  }
  return usable(saved.agent) ? saved : AUTO_TARGET
}

/**
 * 貼り付けたあと Enter で送信されることを確かめた Agent（ブラケットペーストで貼り、Enter は別に送る）。
 * ここに無い Agent（カスタムを含む）は、貼り付けるだけで Enter を押さない。
 * 入力欄の作りが分からないまま Enter を送ると、貼った本文が途中で送られたり、別の操作になったりするため
 */
const SUBMITS_PASTE: ReadonlySet<BuiltinAgent> = new Set<BuiltinAgent>(['claude', 'codex', 'gemini', 'cursor', 'copilot', 'opencode', 'antigravity', 'hermes', 'openclaw'])

export function agentSubmitsPaste(agent: TuiAgent | null): boolean {
  return agent !== null && SUBMITS_PASTE.has(agent as BuiltinAgent)
}

/** 宛先が決まらないとき（auto）に起動する Agent。有効な startupAgents の先頭、無ければ Claude Code */
export function defaultLaunchAgent(startupAgents: readonly TuiAgent[], disabled: readonly TuiAgent[]): TuiAgent {
  return startupAgents.find((agent) => !disabled.includes(agent)) ?? 'claude'
}
