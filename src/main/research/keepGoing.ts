import { STOP_HOOK_MAX_BLOCKS, continueMessage } from '@shared/research/stopHook'

/**
 * 「参入先を決め切る」を送ったターミナルの Agent を、conclusion.md が決め切った条件を満たすまで止めない（Agent の種類を問わない）。
 *
 * Claude Code の Stop フック（.research/stop-check.mjs）は Claude Code にしか効かないので、ADE の側で同じことをする:
 * 送ったあと Agent が手を止めたら conclusion.md を判定し、足りなければ足りないものを書いた続きの依頼を同じターミナルへ送る。
 *
 * 「手を止めた」の見分け方（main には状態の変化の知らせが無いので、数秒ごとに見る）:
 * - 送ってから作業した（working を見た、または画面が変わった）あとで、
 *   idle が settlePolls 回続いた（Claude Code・Codex は確か）か、状態が分からない Agent（generic）は画面が quietMs 変わらない
 * - 送っても noStartMs 何も起きなければ、それも止まったとみなす（貼っただけで送信されなかったときなど）
 * blocked（権限の確認など）の間は人の番なので待つ。ターミナルが閉じた・上限に達した・決め切ったら終える。
 * Claude Code で Stop フックが入っているフォルダはフックに任せる（二重に続けさせない）。
 * 記録は持たない（Ferret を閉じたら終わる）。同じターミナルへ送り直したら、前の見張りを止めて数え直す
 */

export interface KeepGoingJob {
  terminalId: string
  root: string
  locale: 'ja' | 'en'
}

export interface KeepGoingDeps {
  exists(id: string): boolean
  agentState(id: string): Promise<{ kind: string; state: string; agent: string | null }>
  screenText(id: string): string
  send(id: string, text: string): Promise<{ ok: boolean; message: string }>
  /** conclusion.md に足りないもの（空なら決め切った） */
  check(root: string, locale: 'ja' | 'en'): Promise<string[]>
  /** そのフォルダに Claude Code の Stop フックが入っているか */
  hasClaudeHook(root: string): Promise<boolean>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** 見張りが終わったとき（理由つき。通知・ログ用） */
  onEnd?: (job: KeepGoingJob, reason: KeepGoingEnd) => void
}

export type KeepGoingEnd = 'settled' | 'limit' | 'closed' | 'replaced' | 'stopped' | 'hook'

export const KEEP_GOING_DEFAULTS = {
  pollMs: 3000,
  settlePolls: 2,
  quietMs: 30_000,
  noStartMs: 120_000,
  max: STOP_HOOK_MAX_BLOCKS
}

export class KeepGoing {
  private readonly jobs = new Map<string, { cancelled: boolean }>()
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly deps: KeepGoingDeps, private readonly options: typeof KEEP_GOING_DEFAULTS = KEEP_GOING_DEFAULTS) {
    this.now = deps.now ?? (() => Date.now())
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /** 見張りを始める（同じターミナルの前の見張りは止める）。終わるまで待てる Promise を返す（テスト用） */
  start(job: KeepGoingJob): Promise<KeepGoingEnd> {
    this.stop(job.terminalId, 'replaced')
    const handle = { cancelled: false }
    this.jobs.set(job.terminalId, handle)
    return this.run(job, handle).then((reason) => {
      if (this.jobs.get(job.terminalId) === handle) this.jobs.delete(job.terminalId)
      if (reason !== 'replaced' && reason !== 'stopped') this.deps.onEnd?.(job, reason)
      return reason
    })
  }

  stop(terminalId: string, _reason: 'replaced' | 'stopped' = 'stopped'): void {
    const handle = this.jobs.get(terminalId)
    if (handle) handle.cancelled = true
    this.jobs.delete(terminalId)
  }

  watching(terminalId: string): boolean {
    return this.jobs.has(terminalId)
  }

  private async run(job: KeepGoingJob, handle: { cancelled: boolean }): Promise<KeepGoingEnd> {
    const { pollMs, settlePolls, quietMs, noStartMs, max } = this.options
    const id = job.terminalId
    let count = 0
    let sentAt = this.now()
    let worked = false
    let idlePolls = 0
    let lastScreen = this.deps.screenText(id)
    let lastChange = sentAt
    let hookChecked = false
    for (;;) {
      await this.sleep(pollMs)
      if (handle.cancelled) return 'replaced'
      if (!this.deps.exists(id)) return 'closed'
      const st = await this.deps.agentState(id).catch(() => ({ kind: 'unknown', state: 'unknown', agent: null }))
      if (!hookChecked && st.agent !== null) {
        hookChecked = true
        if (st.agent === 'claude' && (await this.deps.hasClaudeHook(job.root).catch(() => false))) return 'hook'
      }
      const screen = this.deps.screenText(id)
      const now = this.now()
      if (screen !== lastScreen) {
        lastScreen = screen
        lastChange = now
        worked = true
      }
      if (st.state === 'working') {
        worked = true
        idlePolls = 0
        continue
      }
      if (st.state === 'blocked') {
        idlePolls = 0
        continue
      }
      if (st.state === 'idle') idlePolls++
      else idlePolls = 0
      const stopped = worked
        ? idlePolls >= settlePolls || (st.state !== 'idle' && now - lastChange >= quietMs)
        : now - sentAt >= noStartMs
      if (!stopped) continue
      const missing = await this.deps.check(job.root, job.locale).catch(() => null)
      if (handle.cancelled) return 'replaced'
      if (missing === null) continue
      if (missing.length === 0) return 'settled'
      if (count >= max) return 'limit'
      const result = await this.deps.send(id, continueMessage(missing, count + 1, max, job.locale)).catch(() => ({ ok: false, message: '' }))
      if (!result.ok) continue
      count++
      sentAt = this.now()
      lastChange = sentAt
      worked = false
      idlePolls = 0
    }
  }
}
