import type { Project } from './types'

/**
 * 複数のオーケストラ。オーケストラは editorWorkspace の付いたプロジェクト（Ferret が持つフォルダで、中に所属するプロジェクトがリンクで入る）。
 * プロジェクトは orchestraId でどれか1つのオーケストラに属する（サイドバーではその下にサブフォルダのように並ぶ）。
 * orchestraId が無い・消えたオーケストラを指すプロジェクトは、先頭のオーケストラに属するとみなす（0.6.15 までの「すべてのプロダクト」1つの頃の設定）。
 * 並びは settings.projects の配列の順。画面に依存しない純粋な処理だけを置く
 */

export function isOrchestra(p: Pick<Project, 'editorWorkspace'>): boolean {
  return p.editorWorkspace === true
}

export function orchestraList(projects: readonly Project[]): Project[] {
  return projects.filter(isOrchestra)
}

/**
 * Ferret が既定で用意する「グローバル」のオーケストラ（src/main/globalOrchestra.ts）。登録したプロジェクトの全部が対象で、
 * どのプロジェクトもここには「属さない」（所属は今までどおりグループのオーケストラ）。サイドバーではオーケストラの先頭に、子を持たない行として並ぶ
 */
export function isGlobalOrchestra(p: Pick<Project, 'editorWorkspace' | 'global'>): boolean {
  return p.editorWorkspace === true && p.global === true
}

/** プロジェクトが属せるオーケストラ（グローバルを除いたもの）。並びは settings.projects の順 */
export function groupOrchestras(projects: readonly Project[]): Project[] {
  return projects.filter((p) => isOrchestra(p) && !isGlobalOrchestra(p))
}

/**
 * オーケストラに入れず、サイドバーの最後に普通のフォルダとして並べるもの。
 * 以前の版のビジネスリサーチのフォルダと、Ferret が既定で用意する作業用のフォルダ「work」（src/main/workProject.ts）
 */
export function isLooseFolder(p: Pick<Project, 'research' | 'work'>): boolean {
  return p.research === true || p.work === true
}

/** そのプロジェクトが属するオーケストラの id。オーケストラ自身・オーケストラが1つも無いときは null。グローバルには属さない（指していても先頭のグループへ） */
export function orchestraIdOf(projects: readonly Project[], project: Pick<Project, 'orchestraId' | 'editorWorkspace'>): string | null {
  if (isOrchestra(project)) return null
  const list = groupOrchestras(projects)
  if (project.orchestraId && list.some((o) => o.id === project.orchestraId)) return project.orchestraId
  return list[0]?.id ?? null
}

/**
 * オーケストラの subagent・巡回・全体への依頼の対象。SSH・旧オーケストレーター・対象から外したもの（orchestraExcluded）・
 * アーカイブしたもの（外したものも含めて、ダッシュボードにも出さない）・work は入れない。
 * includeExcluded なら外したものも入れる（ダッシュボードの表）。
 * グローバルのオーケストラは、どのグループに属するかを問わず全部（アーカイブしたグループの中のものは除く。グループごと隠したため）
 */
export function orchestraMembers(projects: readonly Project[], orchestraId: string, options: { includeExcluded?: boolean } = {}): Project[] {
  const global = projects.some((p) => p.id === orchestraId && isGlobalOrchestra(p))
  const archivedGroups = new Set(groupOrchestras(projects).filter((o) => o.archived).map((o) => o.id))
  return projects.filter((p) => {
    if (isOrchestra(p) || isLooseFolder(p) || p.archived || p.orchestrator || p.source === 'ssh' || (!options.includeExcluded && p.orchestraExcluded)) return false
    const group = orchestraIdOf(projects, p)
    return global ? !(group && archivedGroups.has(group)) : group === orchestraId
  })
}

/** 開いているプロジェクトのオーケストラ。オーケストラならそれ、プロダクトならその所属、無ければ先頭のオーケストラ */
export function currentOrchestra(projects: readonly Project[], currentProjectId: string | null | undefined): Project | null {
  const current = projects.find((p) => p.id === currentProjectId)
  if (current && isOrchestra(current)) return current
  const id = current ? orchestraIdOf(projects, current) : null
  // 先頭のオーケストラへ落とすときは、アーカイブしていないグループを選ぶ（グローバルは最後の手段）
  return projects.find((p) => p.id === id) ?? groupOrchestras(projects).find((o) => !o.archived) ?? groupOrchestras(projects)[0] ?? orchestraList(projects)[0] ?? null
}

export interface OrchestraGroup {
  orchestra: Project
  /** 所属するプロジェクト（与えた並びの順。SSH・外したものも入る） */
  children: Project[]
}

/**
 * サイドバーの木。オーケストラは全体の並び（all）の順、子は shown の順（並び替え・絞り込みを済ませたもの）。
 * shown に子が1つも無く、オーケストラ自身も shown に無いグループは出さない（絞り込みで消えたもの）
 */
export function orchestraTree(all: readonly Project[], shown: readonly Project[], orchestraOrder?: readonly Project[]): OrchestraGroup[] {
  const shownIds = new Set(shown.map((p) => p.id))
  // オーケストラの並びはプロジェクトの並びと別に決められる（@shared/projectOrder の sortOrchestras）。無ければ全体の並び（手動）の順
  return (orchestraOrder ?? orchestraList(all)).filter(isOrchestra).flatMap((orchestra) => {
    const children = shown.filter((p) => !isOrchestra(p) && orchestraIdOf(all, p) === orchestra.id)
    return children.length || shownIds.has(orchestra.id) ? [{ orchestra, children }] : []
  })
}

/**
 * プロジェクトを別のオーケストラへ移す・並べ替える。before の前（null ならそのオーケストラの最後）に置く。
 * オーケストラを動かすときは orchestraId を無視し、before（オーケストラ）の前に置く。知らない id なら元のまま
 */
export function moveInTree(projects: readonly Project[], id: string, toOrchestraId: string | null, beforeId: string | null): Project[] {
  const moving = projects.find((p) => p.id === id)
  if (!moving) return [...projects]
  const rest = projects.filter((p) => p.id !== id)
  if (isOrchestra(moving)) {
    const at = beforeId ? rest.findIndex((p) => p.id === beforeId && isOrchestra(p)) : -1
    return at >= 0 ? [...rest.slice(0, at), moving, ...rest.slice(at)] : [...rest, moving]
  }
  // グローバルには入れられない（全部が対象なので、属させる意味が無い）
  if (!toOrchestraId || !projects.some((p) => p.id === toOrchestraId && isOrchestra(p) && !isGlobalOrchestra(p))) return [...projects]
  const moved: Project = { ...moving, orchestraId: toOrchestraId }
  const before = beforeId ? rest.findIndex((p) => p.id === beforeId && !isOrchestra(p) && orchestraIdOf(projects, p) === toOrchestraId) : -1
  if (before >= 0) return [...rest.slice(0, before), moved, ...rest.slice(before)]
  // そのオーケストラの最後の子の後ろ（子が無ければ全体の最後）
  let last = -1
  rest.forEach((p, i) => { if (!isOrchestra(p) && orchestraIdOf(projects, p) === toOrchestraId) last = i })
  return last >= 0 ? [...rest.slice(0, last + 1), moved, ...rest.slice(last + 1)] : [...rest, moved]
}

/**
 * オーケストラを消すとき、その子を残りの先頭のグループへ移す。最後のグループは消せない（null。グローバルは子を持てないので数えない）。
 * グローバルは子が無いのでそのまま消せる（次の起動で Ferret が足し直す）
 */
export function removeOrchestra(projects: readonly Project[], orchestraId: string): Project[] | null {
  const target = projects.find((p) => p.id === orchestraId && isOrchestra(p))
  if (!target) return null
  if (isGlobalOrchestra(target)) return projects.filter((p) => p.id !== orchestraId)
  const others = groupOrchestras(projects).filter((o) => o.id !== orchestraId)
  if (!others.length) return null
  const to = others[0]!.id
  return projects
    .filter((p) => p.id !== orchestraId)
    .map((p) => (!isOrchestra(p) && orchestraIdOf(projects, p) === orchestraId ? { ...p, orchestraId: to } : p))
}

export interface TreeRow {
  project: Project
  /** 0 はオーケストラ（とオーケストラが無いときのプロジェクト）、1 はその下のプロジェクト */
  depth: 0 | 1
  /** オーケストラの行で、子を畳んでいる */
  collapsed?: boolean
  /** オーケストラの行の子の数（畳んでいても数える） */
  childCount?: number
}

/**
 * サイドバーに並べる行。オーケストラ（orchestraOrder の順。無ければ全体の並び）→ その子（shown の順）を字下げして続ける。畳んだオーケストラの子は出さない。
 * オーケストラに属さないもの（オーケストラが1つも無いとき）は最後に depth 0 で並べる。
 * ビジネスリサーチのフォルダと work は、どのオーケストラにも入れず、いちばん最後に depth 0 で並べる（以前の版で登録したもの。普通のフォルダとして開く）
 */
export function treeRows(all: readonly Project[], shownAll: readonly Project[], collapsed: ReadonlySet<string>, orchestraOrder?: readonly Project[]): TreeRow[] {
  const shown = shownAll.filter((p) => !isLooseFolder(p))
  const groups = orchestraTree(all, shown, orchestraOrder)
  const placed = new Set(groups.flatMap((g) => [g.orchestra.id, ...g.children.map((c) => c.id)]))
  return [
    ...groups.flatMap((g): TreeRow[] => [
      { project: g.orchestra, depth: 0, collapsed: collapsed.has(g.orchestra.id), childCount: g.children.length },
      ...(collapsed.has(g.orchestra.id) ? [] : g.children.map((c): TreeRow => ({ project: c, depth: 1 })))
    ]),
    ...shown.filter((p) => !placed.has(p.id)).map((p): TreeRow => ({ project: p, depth: 0 })),
    ...shownAll.filter(isLooseFolder).map((p): TreeRow => ({ project: p, depth: 0 }))
  ]
}

/**
 * 行の上・下に落としたときの移動先（project:move の引数）。
 * - オーケストラを別のオーケストラの行に落とす: その前（上半分）か次のオーケストラの前（下半分。最後なら末尾）
 * - プロジェクトをオーケストラの行に落とす: そのオーケストラの最後へ
 * - プロジェクトを別のプロジェクトの行に落とす: その行のオーケストラの、その前（上半分）か次の前（下半分）
 * 動かないとき・オーケストラをプロジェクトの行に落としたときは null
 */
export function treeDrop(all: readonly Project[], rows: readonly TreeRow[], draggingId: string, targetId: string, position: 'before' | 'after'): { id: string; to: string | null; before: string | null } | null {
  const dragging = all.find((p) => p.id === draggingId)
  const target = all.find((p) => p.id === targetId)
  if (!dragging || !target || draggingId === targetId) return null
  // ビジネスリサーチのフォルダはオーケストラに入れない（動かさず、ほかのものの落とし先にもしない）。グローバルは先頭に固定（動かさず、落とし先にもしない）
  if (isLooseFolder(dragging) || isLooseFolder(target) || isGlobalOrchestra(dragging) || isGlobalOrchestra(target)) return null
  if (isOrchestra(dragging)) {
    if (!isOrchestra(target)) return null
    const list = groupOrchestras(all).filter((o) => o.id !== draggingId)
    const at = list.findIndex((o) => o.id === targetId)
    const before = position === 'before' ? targetId : list[at + 1]?.id ?? null
    return { id: draggingId, to: null, before }
  }
  if (isOrchestra(target)) return { id: draggingId, to: targetId, before: null }
  const to = orchestraIdOf(all, target)
  if (!to) return null
  if (position === 'before') return { id: draggingId, to, before: targetId }
  // 下半分：画面で次に並ぶ同じオーケストラの子の前（無ければ最後）
  const siblings = rows.filter((r) => r.depth === 1 && r.project.id !== draggingId && orchestraIdOf(all, r.project) === to).map((r) => r.project.id)
  const next = siblings[siblings.indexOf(targetId) + 1] ?? null
  return { id: draggingId, to, before: next }
}
