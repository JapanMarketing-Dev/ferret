/**
 * サイドバーのプロジェクト一覧の並び順と絞り込み（☆ のみ）。純粋な関数だけを置く。
 *
 * - 並び順: 手動（ドラッグの順 = settings の projects の並び）・動いている順・最近使った順・名前順・追加した順
 * - ☆ を付けたプロジェクトは、どの並び順でも上にまとめる（その中の順は並び順に従う）
 * - オーケストラの並び順はプロジェクトの並び順と別に選ぶ（手動・最近使った順・名前順）。プロジェクトの並び順は各オーケストラの中の子に効く
 * - 並び順と「☆ のみ」はこの端末だけの好みなので、renderer が localStorage に置く
 */
import type { Project } from './types'
import { isGlobalOrchestra, isLooseFolder, isOrchestra, orchestraIdOf } from './orchestras'

export type ProjectSort = 'manual' | 'active' | 'recent' | 'name' | 'added'
export const PROJECT_SORTS: readonly ProjectSort[] = ['manual', 'active', 'recent', 'name', 'added']

/** オーケストラの並び順（手動 = ドラッグの順・最近使った順・名前順） */
export type OrchestraSort = 'manual' | 'recent' | 'name'
export const ORCHESTRA_SORTS: readonly OrchestraSort[] = ['manual', 'recent', 'name']

export interface ProjectListView {
  /** プロジェクト（オーケストラの中の子と、オーケストラに属さないもの）の並び順 */
  sort: ProjectSort
  /** オーケストラ同士の並び順。既定は手動 */
  orchestraSort: OrchestraSort
  /** ☆ を付けたプロジェクトだけを出す */
  starredOnly: boolean
}

export const DEFAULT_PROJECT_VIEW: ProjectListView = { sort: 'manual', orchestraSort: 'manual', starredOnly: false }

/** 保存した値を読む。知らない値・壊れた形は既定に戻す */
export function sanitizeProjectView(raw: unknown): ProjectListView {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PROJECT_VIEW }
  const r = raw as Record<string, unknown>
  return {
    sort: PROJECT_SORTS.includes(r.sort as ProjectSort) ? (r.sort as ProjectSort) : 'manual',
    // 以前の保存（orchestraSort の無いもの）は手動。オーケストラはずっと手動の順で並んでいた
    orchestraSort: ORCHESTRA_SORTS.includes(r.orchestraSort as OrchestraSort) ? (r.orchestraSort as OrchestraSort) : 'manual',
    starredOnly: r.starredOnly === true
  }
}

/** Agent の印（renderer/terminal/agentActivity.ts の ProjectActivity と同じ値） */
type Activity = 'blocked' | 'working' | 'done'
/** 動いている順: 確認待ち → 作業中 → 終わった（まだ見ていない）→ それ以外 */
const ACTIVITY_RANK: Record<Activity, number> = { blocked: 0, working: 1, done: 2 }

export interface ProjectSortContext {
  /** プロジェクトごとの Agent の印 */
  activity?: Readonly<Record<string, Activity>>
  /** Agent が最後に動いた時刻（ms）。この端末で見ていたもの */
  agentActiveAt?: Readonly<Record<string, number>>
  locale?: string
}

const time = (iso: string | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : 0
}

/** 最後に使った時刻（開いた・Agent が動いた、の新しいほう）。分からなければ 0 */
export function lastUsedAt(project: Project, ctx: ProjectSortContext = {}): number {
  return Math.max(time(project.lastOpenedAt), ctx.agentActiveAt?.[project.id] ?? 0)
}

/**
 * 表示する並び。☆ を上にまとめ、その中と外をそれぞれ並び順で並べる。
 * 同じ値どうしは手動の順（配列の順）のまま。追加した時刻の無い古いプロジェクトは、時刻のあるものより前（手動の順）
 */
export function sortProjects(projects: readonly Project[], sort: ProjectSort, ctx: ProjectSortContext = {}): Project[] {
  const collator = new Intl.Collator(ctx.locale, { numeric: true, sensitivity: 'base' })
  const compare = (a: Project, b: Project): number => {
    switch (sort) {
      case 'active': {
        const rank = (p: Project) => ACTIVITY_RANK[ctx.activity?.[p.id] as Activity] ?? 3
        return rank(a) - rank(b) || lastUsedAt(b, ctx) - lastUsedAt(a, ctx)
      }
      case 'recent': return lastUsedAt(b, ctx) - lastUsedAt(a, ctx)
      case 'name': return collator.compare(a.name, b.name)
      case 'added': return time(a.addedAt) - time(b.addedAt)
      default: return 0
    }
  }
  return projects
    .map((project, index) => ({ project, index }))
    .sort((a, b) => Number(!!b.project.starred) - Number(!!a.project.starred) || compare(a.project, b.project) || a.index - b.index)
    .map((x) => x.project)
}

/**
 * オーケストラ同士の並び。手動は全体の並び（settings の projects の順）のまま。
 * 最近使った順は、オーケストラ自身とそこに属するプロジェクトのうち一番新しく使った時刻で比べる（中のプロジェクトを使えば、そのオーケストラも上がる）。
 * 時刻の無いものは後ろで、同じ値どうしは手動の順。名前順は ☆ を上にまとめない（☆ の扱いはプロジェクトの並びだけ）
 */
export function sortOrchestras(all: readonly Project[], sort: OrchestraSort, ctx: ProjectSortContext = {}): Project[] {
  // グローバルのオーケストラは、どの並びでも先頭に固定する（全体に効くものなので、いつも同じ場所にあるほうが探しやすい）
  const globals = all.filter((p) => isOrchestra(p) && isGlobalOrchestra(p))
  return [...globals, ...sortGroupOrchestras(all, sort, ctx)]
}

function sortGroupOrchestras(all: readonly Project[], sort: OrchestraSort, ctx: ProjectSortContext): Project[] {
  const orchestras = all.filter((p) => isOrchestra(p) && !isGlobalOrchestra(p))
  if (sort === 'manual') return orchestras
  const used = new Map(orchestras.map((o) => [o.id, lastUsedAt(o, ctx)]))
  if (sort === 'recent') {
    for (const p of all) {
      // work・リサーチのフォルダ（どのオーケストラにも入れないもの）とアーカイブしたものは数えない
      if (isOrchestra(p) || isLooseFolder(p) || p.archived) continue
      const id = orchestraIdOf(all, p)
      if (id && used.has(id)) used.set(id, Math.max(used.get(id)!, lastUsedAt(p, ctx)))
    }
  }
  const collator = new Intl.Collator(ctx.locale, { numeric: true, sensitivity: 'base' })
  return orchestras
    .map((orchestra, index) => ({ orchestra, index }))
    .sort((a, b) => (sort === 'recent' ? used.get(b.orchestra.id)! - used.get(a.orchestra.id)! : collator.compare(a.orchestra.name, b.orchestra.name)) || a.index - b.index)
    .map((x) => x.orchestra)
}

/** 絞り込んだあとの一覧（☆ のみ） */
export function filterProjects(sorted: readonly Project[], view: Pick<ProjectListView, 'starredOnly'> & Partial<ProjectListView>): Project[] {
  return view.starredOnly ? sorted.filter((p) => p.starred) : [...sorted]
}

/** 入れたプロジェクト → そのオーケストレーター（先に並んでいるオーケストレーターが持つもの） */
export function memberParents(projects: readonly Project[]): Map<string, string> {
  const parents = new Map<string, string>()
  for (const p of projects) {
    if (!p.orchestrator) continue
    for (const id of p.members ?? []) if (id !== p.id && !parents.has(id)) parents.set(id, p.id)
  }
  return parents
}

/**
 * オーケストレーターに入れたプロジェクトを、そのオーケストレーターのすぐ下に並べ直す（並びの中の順は保つ）。
 * オーケストレーターが絞り込みで出ていなければ、入れたプロジェクトは自分の位置に出る
 */
export function nestMembers(shown: readonly Project[], all: readonly Project[]): Project[] {
  const parents = memberParents(all)
  const shownIds = new Set(shown.map((p) => p.id))
  const out: Project[] = []
  for (const p of shown) {
    const parent = parents.get(p.id)
    if (parent && shownIds.has(parent)) continue
    out.push(p)
    if (p.orchestrator) out.push(...shown.filter((c) => parents.get(c.id) === p.id))
  }
  return out
}

/** 「すべてのプロダクト」（エディタ全体）を一番上に置く（ほかの並びは保つ） */
export function editorFirst(projects: readonly Project[]): Project[] {
  return [...projects.filter((p) => p.editorWorkspace), ...projects.filter((p) => !p.editorWorkspace)]
}
