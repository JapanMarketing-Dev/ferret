import { isOrchestra } from '@shared/orchestras'
import type { Project } from '@shared/types'
import type { BusinessListItem, BusinessSnapshot } from '@shared/business/ipc'

/**
 * ビジネス・ビジネスリサーチの外枠（中央のタブ・サイドバー・「証拠に追加」の知らせ）の判断。画面に依存しない純粋な関数（単体テストの対象）。
 */

export type VentureTab = 'business'

/**
 * 開いているプロジェクトで先頭に出すタブ。ビジネス（business.yaml がある＝一覧に入っている）なら business。
 * リサーチのフォルダ（research: true）は上のモード切替の「ビジネスリサーチ」で開くのでタブは出さない。オーケストラ・SSH・未選択も null
 */
export function ventureTabFor(projects: readonly Project[], activeId: string | null | undefined, businesses: readonly Pick<BusinessListItem, 'projectId'>[]): VentureTab | null {
  const project = projects.find((p) => p.id === activeId)
  if (!project || isOrchestra(project) || project.source === 'ssh' || project.research) return null
  return businesses.some((b) => b.projectId === project.id) ? 'business' : null
}

/** モードの「ビジネスリサーチ」に入ったとき開くリサーチのフォルダ（最後に開いたもの。日時が無ければ並びの先頭）。無ければ null */
export function latestResearchProject(projects: readonly Project[]): Project | null {
  const list = researchProjects(projects)
  let best: Project | null = null
  let bestAt = Number.NEGATIVE_INFINITY
  for (const p of list) {
    const at = p.lastOpenedAt ? Date.parse(p.lastOpenedAt) : Number.NaN
    if (Number.isFinite(at) && at > bestAt) { best = p; bestAt = at }
  }
  return best ?? list[0] ?? null
}

/** モードの「ビジネスリサーチ」の上に並べるリサーチのフォルダ（並びは与えた順。オーケストラ・SSH は入れない） */
export function researchProjects(projects: readonly Project[]): Project[] {
  return projects.filter((p) => p.research === true && !isOrchestra(p) && p.source !== 'ssh')
}

/**
 * 「証拠に追加」の結果の知らせ。選んだ文があれば読了の下書き、無ければ「発見のみ」で追加したことをそのまま伝える
 * （読んでいないのに読了と見せない）
 */
export function evidenceToast(result: { snapshot: BusinessSnapshot; id: string }): { tone: 'success' | 'warning'; message: string } {
  const added = result.snapshot.data.evidence.find((e) => e.id === result.id)
  if (added?.readStatus === '読了') return { tone: 'success', message: `${result.id} を証拠に追加しました` }
  return { tone: 'warning', message: `${result.id} を「発見のみ」で追加しました` }
}
