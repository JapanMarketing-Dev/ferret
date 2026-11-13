import { applyOrder } from '@shared/layout'

/**
 * 中央のタブ列を「いつもある画面（ダッシュボード・ブラウザ・指摘・ビジュアルレビュー）」と「開いたもの（設定・ファイル）」に分ける（純粋な関数。単体テストの対象）。
 *
 * いつもある画面は列の左に固定の切り替え（セグメント）として置き、開いたファイルとは別の軸にする。
 * ファイルのタブが横幅をすべて使えるように、ドラッグの並び（order）はファイル・設定にだけ効かせる。
 * 以前の並び（ブラウザ・指摘を含む）を渡されても、それらは並びから外して固定の側へ置く。
 */

/** いつもある画面のタブ（並びは固定） */
export const VIEW_TABS = ['dashboard', 'browser', 'findings', 'visual-review'] as const
export type ViewTab = (typeof VIEW_TABS)[number]

export function isViewTab(tab: string): tab is ViewTab {
  return (VIEW_TABS as readonly string[]).includes(tab)
}

export function centerTabGroups({ dashboard, settingsOpen, files, order }: {
  /** 全体（すべてのプロダクト）を開いている間だけダッシュボードを出す */
  dashboard: boolean
  settingsOpen: boolean
  /** 開いているファイルのタブ（file:…）。開いた順 */
  files: readonly string[]
  /** ドラッグで並べ替えた順（無いものは後ろに付く。ブラウザ・指摘が入っていても無視する） */
  order: readonly string[]
}): { views: ViewTab[]; docs: string[] } {
  const views: ViewTab[] = dashboard ? ['dashboard', 'browser', 'findings', 'visual-review'] : ['browser', 'findings', 'visual-review']
  const docs = applyOrder<string>([...(settingsOpen ? ['settings'] : []), ...files], order.filter((tab) => !isViewTab(tab)))
  return { views, docs }
}
