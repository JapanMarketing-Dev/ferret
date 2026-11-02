import { panesToResume } from '@shared/terminalRestore'
import type { TuiAgent } from '@shared/types'

/**
 * 使っていないターミナルを休ませる決まり（メモリを空けるため）。
 *
 * Claude Code・Codex は1つで数百 MB を使い、xterm も 1 ペインごとにスクロールバックを持つ。
 * 前は開いたプロジェクトのターミナルをアプリを閉じるまで全部動かしていたので、プロジェクトを渡り歩くほど増えた。
 * - 裏のプロジェクトで、入力を待ったまま SLEEP_AFTER_MS 経った Agent は、画面の文字を覚えてプロセスと xterm を閉じる。
 *   そのプロジェクトを開いたら、前の画面の文字を書いて会話を続けて起動し直す（再起動後に戻したタブと同じ形）
 * - 休ませるのは、続きから起動し直せる Agent（Claude Code・Codex）で、同じ Agent・フォルダ・アカウントのペインが
 *   ほかに無いものだけ（--continue はそのフォルダの最後の会話を続けるので、2つあると取り違える）
 * - 素のシェルは休ませない（開発サーバーなど、裏で動かしているものを止めてしまう）
 */

/** 裏に回ってから休ませるまで */
export const SLEEP_AFTER_MS = 30 * 60_000
/** 休ませるペインを探す間隔 */
export const SLEEP_CHECK_MS = 60_000

export interface SleepCandidate {
  key: string
  projectId: string | null
  launch: TuiAgent | null
  cwd: string | null
  accountId: string | null
  /** 画面の印（renderer の追跡した状態）。'idle' のときだけ休ませる（'done' はまだ見ていない印なので残す） */
  state: string
  /** PTY が動いている */
  awake: boolean
  /** 戻せないペイン（アカウントのログイン・1回きりのコマンド） */
  restorable: boolean
}

/**
 * ペインが裏に回った時刻を更新する。表示中のプロジェクトのペインと、もう無いペインは消し、新しく裏に回ったペインは now を入れる
 */
export function trackHidden(hiddenSince: Map<string, number>, panes: readonly Pick<SleepCandidate, 'key' | 'projectId'>[], activeProject: string | null, now: number): void {
  const active = activeProject ?? ''
  const present = new Set<string>()
  for (const pane of panes) {
    present.add(pane.key)
    if ((pane.projectId ?? '') === active) hiddenSince.delete(pane.key)
    else if (!hiddenSince.has(pane.key)) hiddenSince.set(pane.key, now)
  }
  for (const key of [...hiddenSince.keys()]) if (!present.has(key)) hiddenSince.delete(key)
}

/** 休ませてよいペイン（並びは元のまま）。このあと main に今の状態を聞き直し、まだ入力待ちのものだけ休ませる */
export function panesToSleep(
  panes: readonly SleepCandidate[],
  activeProject: string | null,
  hiddenSince: ReadonlyMap<string, number>,
  now: number,
  afterMs = SLEEP_AFTER_MS
): string[] {
  const active = activeProject ?? ''
  const id = (pane: SleepCandidate) => `${pane.launch}\u0000${pane.cwd ?? ''}\u0000${pane.accountId ?? ''}`
  const count = new Map<string, number>()
  for (const pane of panes) if (pane.launch) count.set(id(pane), (count.get(id(pane)) ?? 0) + 1)
  return panes
    .filter((pane) => {
      if (!pane.awake || !pane.restorable || pane.state !== 'idle') return false
      if ((pane.projectId ?? '') === active) return false
      const since = hiddenSince.get(pane.key)
      if (since === undefined || now - since < afterMs) return false
      return count.get(id(pane)) === 1 && panesToResume([pane]).has(pane.key)
    })
    .map((pane) => pane.key)
}
