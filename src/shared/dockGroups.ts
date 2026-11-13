/**
 * 全体のフィードバックの帯のタブ（2段）。上の段はプロダクト、下の段はそのプロダクトの確認先（prd・local などの登録した URL）。
 * 画面に依存しない純粋な処理だけを置く（使うのは OrchestraDock）。確認先の URL が無いプロダクトは出さない
 */

export interface DockItem {
  /** 下の段のタブの名前（prd・local など） */
  label: string
  url: string
}

export interface DockGroup {
  id: string
  label: string
  items: DockItem[]
}

export interface DockProject {
  id: string
  name: string
  urls: ReadonlyArray<{ label: string; url?: string }>
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null
  } catch {
    return null
  }
}

export function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/$/, '') === b.replace(/\/$/, '')
}

/** 上の段は登録の順。下の段はそのプロダクトの確認先の順 */
export function groupDockTargets(projects: readonly DockProject[]): DockGroup[] {
  return projects
    .map((p) => ({ id: `p:${p.id}`, label: p.name, items: p.urls.flatMap((u) => (u.url ? [{ label: u.label || u.url, url: u.url }] : [])) }))
    .filter((g) => g.items.length > 0)
}

/** 開いているページがどのタブか（同じ URL を先に、無ければ同じオリジン） */
export function currentDockGroup(groups: readonly DockGroup[], url: string): string | null {
  const exact = groups.find((g) => g.items.some((i) => sameUrl(i.url, url)))
  if (exact) return exact.id
  const origin = originOf(url)
  return (origin && groups.find((g) => g.items.some((i) => originOf(i.url) === origin))?.id) ?? null
}
