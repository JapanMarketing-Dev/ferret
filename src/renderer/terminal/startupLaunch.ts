import type { TuiAgent } from '@shared/types'

/**
 * 初めて開いたプロジェクトで、ターミナルのタブを何で開くか（TerminalPane の最初のタブ）。
 * - プロジェクト: 設定の startupAgents の順に Agent（無効にしたものを除く）。空なら素のシェル1つ
 * - プロジェクトを開いていない（ホームなど）: 素のシェル1つ（Agent は起動しない）
 * - オーケストラ: 何も開かない（2026-11-13 本人指示。まとめて眺めるだけの用途もあり、開くたびに Agent の起動と確認が出るのは面倒。
 *   Agent・ターミナルは、＋や依頼を送るなど利用者が求めたときだけ始める）
 * null は素のシェル
 */
export function startupLaunches(input: {
  projectId: string | null
  orchestra: boolean
  startupAgents: readonly TuiAgent[]
  disabled: ReadonlySet<string>
}): Array<TuiAgent | null> {
  if (input.orchestra) return []
  const enabled = input.startupAgents.filter((agent) => !input.disabled.has(agent))
  return input.projectId && enabled.length > 0 ? [...enabled] : [null]
}
