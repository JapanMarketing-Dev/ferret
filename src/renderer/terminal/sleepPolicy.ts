import { panesToResume } from '@shared/terminalRestore'
import type { PaneInfo } from '@shared/memoryAlert'
import type { TuiAgent } from '@shared/types'

/**
 * Agent を休ませる決まり（メモリを空けるため。利用者がメモリの知らせの「止める」を押したときだけ。勝手には休ませない）。
 *
 * 休ませると、画面の文字を覚えてプロセスと xterm を閉じる。タブはそのまま残り、ペインの「続きから再開」を押すと
 * 前の画面の文字を書いて会話を続けて起動し直す（再起動後に戻したタブと同じ形）。
 * - 休ませられるのは、続きから起動し直せる Agent（Claude Code・Codex）で、同じ Agent・フォルダ・アカウントのペインが
 *   ほかに無いものだけ（--continue はそのフォルダの最後の会話を続けるので、2つあると取り違える）
 * - それ以外（素のシェル・ほかの Agent）は、知らせの「止める」でターミナルを閉じる（components/MemoryAlert.tsx）
 *
 * 前は裏のプロジェクトで30分入力を待った Agent を自動で休ませていたが、利用者の指示で止めた（2026-11-13
 * 「勝手にメモリ開けるので止まるのはやめてほしい。アラート出してほしい」）。設定 agents.sleepIdleAgents も廃止。
 */

export interface SleepCandidate {
  key: string
  launch: TuiAgent | null
  cwd: string | null
  accountId: string | null
  /** PTY が動いている */
  awake: boolean
  /** 戻せないペイン（アカウントのログイン・1回きりのコマンド） */
  restorable: boolean
}

/** 休ませて、あとで続きから起動し直せるペイン（並びは元のまま） */
export function resumableKeys(panes: readonly SleepCandidate[]): Set<string> {
  const id = (pane: SleepCandidate) => `${pane.launch}\u0000${pane.cwd ?? ''}\u0000${pane.accountId ?? ''}`
  const count = new Map<string, number>()
  for (const pane of panes) if (pane.launch) count.set(id(pane), (count.get(id(pane)) ?? 0) + 1)
  const result = new Set<string>()
  for (const pane of panes) {
    if (!pane.awake || !pane.restorable || !pane.launch) continue
    if (count.get(id(pane)) !== 1 || !panesToResume([pane]).has(pane.key)) continue
    result.add(pane.key)
  }
  return result
}

// ───────────────────────── ペインの一覧（TerminalPane → メモリの知らせ） ─────────────────────────

let directory: ReadonlyMap<string, PaneInfo> = new Map()

/** TerminalPane がペインの中身を置く（main のターミナルID → 中身）。メモリの知らせが「止める」の出し方を決めるのに読む */
export function publishPaneDirectory(entries: readonly PaneInfo[]): void {
  directory = new Map(entries.map((entry) => [entry.ptyId, entry]))
}

export function getPaneDirectory(): ReadonlyMap<string, PaneInfo> {
  return directory
}

/** メモリの知らせから、そのターミナル（main の id）の Agent を休ませるよう TerminalPane に頼むイベント */
export const SLEEP_TERMINAL_EVENT = 'ade:sleep-terminal'

export interface SleepTerminalDetail {
  id: string
  /** 休ませたら true（見つからない・休ませられないときは false） */
  done: (slept: boolean) => void
}

/** そのターミナルの Agent を休ませる。TerminalPane が居なければ false */
export function requestSleep(id: string): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false
    const done = (slept: boolean) => { if (!answered) { answered = true; resolve(slept) } }
    window.dispatchEvent(new CustomEvent<SleepTerminalDetail>(SLEEP_TERMINAL_EVENT, { detail: { id, done } }))
    // 受け手が居なければすぐ返事が無いまま。そのときは休ませられなかったことにする
    if (!answered) queueMicrotask(() => done(false))
  })
}
