import { delay } from '@shared/delay'
import { agentLabel } from '@shared/agentCatalog'
import { t } from '@shared/i18n'
import { AUTO_TARGET, buildSendTargetOptions, parseSendTarget, projectTerminals, resolveRememberedTarget, type RunningAgentTerminal, type SendTarget, type SendTargetOption } from '@shared/sendTarget'
import type { AgentOption, TuiAgent } from '@shared/types'
import { requestAgentLaunch } from './agentLaunchRequest'

/**
 * 「Agentへ送信」の renderer 側（指摘の画面の送信ボタンと、確認への返答つきの送り直しが使う）。
 * 宛先に Agent が居なければ、その Agent（auto なら既定の Agent）のタブを開き、入力を受け付けるまで待ってから送り直す。
 */

/** 起動した Agent が入力を受け付けるまで待つ上限 */
const AGENT_START_TIMEOUT_MS = 45_000
/** 待機中の見え方を知らない Agent は、Agent と分かってからこの時間たてば送ってみる（送信側が出力の落ち着きを待つ） */
const GENERIC_SETTLE_MS = 3000

/** その Agent のタブを開き、入力を受け付ける（待機中・確認待ち）まで待つ。ターミナルの id を返す */
export async function launchAgentAndWait(agent: TuiAgent): Promise<string | null> {
  const before = new Set((await window.ade.invoke('terminal:list')).map((x) => x.id))
  requestAgentLaunch(agent)
  const deadline = Date.now() + AGENT_START_TIMEOUT_MS
  let seenAt: number | null = null
  while (Date.now() < deadline) {
    await delay(500)
    const created = (await window.ade.invoke('terminal:list')).find((x) => !before.has(x.id) && x.agent === agent)
    if (!created) continue
    const state = await window.ade.invoke('terminal:agentState', created.id)
    if (state.kind === 'unknown') continue
    // 待機中なら送れる。確認待ち（blocked）なら送信側が理由を出すので、そこで待つのをやめる
    if (state.state === 'idle' || state.state === 'blocked') return created.id
    seenAt ??= Date.now()
    if (state.kind === 'generic' && state.state !== 'working' && Date.now() - seenAt >= GENERIC_SETTLE_MS) return created.id
  }
  return null
}

interface SendReviewOptions {
  reviewId: string
  target: SendTarget
  /** いまフォーカスしているターミナル（auto の最初の候補） */
  focusedTerminalId: string | null
  /** 差し替える本文（返答つきの送り直しなど）。省略で feedback.md を読む既定の指示文 */
  text?: string
  /** auto で何も居なかったときに起動する Agent */
  defaultAgent: TuiAgent
  /** 起動を始めたとき（トースト用） */
  onStarting?: (agent: TuiAgent) => void
}

export async function sendReviewToAgent(options: SendReviewOptions): Promise<{ ok: boolean; message: string; terminalId?: string; submitted?: boolean }> {
  const request = { target: options.target, focusedTerminalId: options.focusedTerminalId, ...(options.text ? { text: options.text } : {}) }
  let result = await window.ade.invoke('review:send', options.reviewId, request)
  // 宛先に Agent が居なければ、その Agent（auto なら既定の Agent）を起動してから、そのタブへ送り直す
  if (result.noAgent) {
    const agent = result.launchAgent ?? options.defaultAgent
    const name = agentLabel(agent)
    options.onStarting?.(agent)
    const started = await launchAgentAndWait(agent)
    result = started
      ? await window.ade.invoke('review:send', options.reviewId, { ...request, target: { kind: 'terminal', terminalId: started, agent } })
      : { ok: false, message: t('review.agentStartFailed', { agent: name }) }
    if (result.noAgent) result = { ok: false, message: t('review.agentStartFailed', { agent: name }) }
  }
  // 送った先のタブを見せる（選んでいたのと別のターミナルへ送ったとき）
  if (result.ok && result.terminalId && result.terminalId !== options.focusedTerminalId) {
    window.dispatchEvent(new CustomEvent('ade:focus-terminal', { detail: { id: result.terminalId } }))
  }
  return result
}

/** 宛先の一覧を今の状態から作る（有効でインストール済みの Agent ＋ 動いている Agent のタブ） */
export async function loadSendTargets(): Promise<{ options: SendTargetOption[]; agents: AgentOption[]; running: RunningAgentTerminal[] }> {
  const [agents, list, workspace] = await Promise.all([window.ade.invoke('agents:list'), window.ade.invoke('terminal:list'), window.ade.invoke('workspace:current')])
  // ほかのプロジェクトで開いたままのターミナルは出さない（main の自動の宛先と同じ決まり。agent/sendTarget.ts）
  const running = await Promise.all(projectTerminals(list, workspace.folderPath).map(async (info) => {
    const state = await window.ade.invoke('terminal:agentState', info.id).catch(() => null) // 閉じたばかりのタブ（想定内）
    return { id: info.id, agent: state && state.kind !== 'unknown' ? state.agent ?? info.agent : null, index: info.index }
  }))
  return { options: buildSendTargetOptions(agents, running), agents, running }
}

/** 宛先の表示名 */
export function sendTargetLabel(option: Pick<SendTargetOption, 'agent' | 'tab'> | null): string {
  if (!option?.agent) return t('review.sendToAgent')
  const name = agentLabel(option.agent)
  return option.tab ? t('review.sendTargetTab', { agent: name, n: option.tab }) : name
}

// ───────── 最後に選んだ宛先（プロジェクトごと。この端末の中だけの覚え書き） ─────────

const storageKey = (projectKey: string) => `ferret.sendTarget.${projectKey}`

export function rememberedSendTarget(projectKey: string): SendTarget {
  try {
    const raw = window.localStorage.getItem(storageKey(projectKey))
    return (raw && parseSendTarget(JSON.parse(raw))) || AUTO_TARGET
  } catch {
    return AUTO_TARGET // 読めない（壊れた値・保存できない環境）ときは自動（想定内）
  }
}

export function rememberSendTarget(projectKey: string, target: SendTarget): void {
  try {
    window.localStorage.setItem(storageKey(projectKey), JSON.stringify(target))
  } catch {
    // 保存できなくても送信はできる（次はまた自動から。想定内）
  }
}

export { resolveRememberedTarget }
