import type { Project } from './types'
import { groupOrchestras, isGlobalOrchestra, isOrchestra, orchestraIdOf } from './orchestras'

/**
 * プロジェクトとオーケストラのアーカイブ（一時的に使わない・待ちのもの）。消すのとは違い、フォルダ・確認先・作業の状態・並び・所属は
 * そのまま残し、サイドバー・オーケストラ・巡回・ferret-projects の skill から隠すだけ。「元に戻す」で前と同じ場所に戻る。
 * オーケストラをアーカイブすると、そこに属するプロジェクトもいっしょに隠れる（それぞれの印は変えないので、戻せば元どおり）。
 * 画面に依存しない純粋な処理だけを置く
 */

/** 自分か、属するオーケストラがアーカイブされている（画面・裏の処理から隠すもの） */
export function isArchived(projects: readonly Project[], project: Project): boolean {
  if (project.archived) return true
  if (isOrchestra(project)) return false
  const orchestraId = orchestraIdOf(projects, project)
  return !!orchestraId && !!projects.find((p) => p.id === orchestraId)?.archived
}

/** 隠さないもの（サイドバー・タイトルバーの一覧・オーケストラ・巡回の対象）。並びは元のまま */
export function activeProjects(projects: readonly Project[]): Project[] {
  return projects.filter((p) => !isArchived(projects, p))
}

/** アーカイブの一覧に並べるもの（自分に印のあるもの。オーケストラといっしょに隠れた子は、オーケストラを戻せば戻るので並べない） */
export function archivedProjects(projects: readonly Project[]): Project[] {
  return projects.filter((p) => p.archived)
}

/**
 * アーカイブできるか。最後の（アーカイブしていない）グループのオーケストラはアーカイブできない（プロジェクトの属する先が無くなるため）。
 * グローバルのオーケストラはいつでも隠せる（子を持たない）。知らない id・もうアーカイブしてあるものは false
 */
export function canArchive(projects: readonly Project[], id: string): boolean {
  const target = projects.find((p) => p.id === id)
  if (!target || target.archived) return false
  if (!isOrchestra(target) || isGlobalOrchestra(target)) return true
  return groupOrchestras(projects).some((o) => o.id !== id && !o.archived)
}

/** 印を付ける・外す。ほかの項目と並び・所属は変えない。知らない id なら元のまま */
export function setArchived(projects: readonly Project[], id: string, archived: boolean): Project[] {
  return projects.map((p) => {
    if (p.id !== id) return p
    if (archived) return { ...p, archived: true as const }
    const { archived: _drop, ...rest } = p
    return rest
  })
}

/**
 * 開いていたものを隠したときに次に開くもの。隠していない先頭のグループのオーケストラ → グローバル → 隠していない先頭のプロジェクト → 無し
 */
export function archiveFallback(projects: readonly Project[]): Project | null {
  const active = activeProjects(projects)
  return active.find((p) => isOrchestra(p) && !isGlobalOrchestra(p)) ?? active.find(isOrchestra) ?? active[0] ?? null
}
