import { activeProjects } from './projectArchive'
import type { Project } from './types'

/**
 * オーケストラのプロダクトの一覧（設定の「オーケストラ」のプロダクトごとのルールの欄）。
 * 確認の巡回は 2026-11-13 にダッシュボードの集計といっしょに無くした（本人指示）。画面に依存しない純粋な処理だけを置く
 */

/** オーケストラのプロダクト（全体・以前のオーケストレーター・オーケストラの対象外・アーカイブ・work・SSH は除く）。並びはサイドバーの順 */
export function roundProducts(projects: readonly Project[]): Project[] {
  return activeProjects(projects).filter((p) => !p.editorWorkspace && !p.orchestrator && !p.orchestraExcluded && !p.work && p.source !== 'ssh')
}
