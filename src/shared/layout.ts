/**
 * 画面の配置（どのパネルをどこに置き、出すか出さないか）。設定に保存し、App が CSS グリッドへ変換する。
 *
 * 考え方は VS Code にならう。
 *   - 置き場所は固定: プロジェクト一覧は左、ファイルツリーは右、中央（ブラウザ・指摘・ファイルのタブ群）の横か下にターミナル
 *     （パネルをドラッグして別の端へ運ぶ機能は削除。ユーザーの指示: 不要。古い設定に残った置き場所は既定へ戻す）
 *   - 左右のパネルはタイトルバーのボタンで開閉し、隠しても状態は残す（幅を 0 にするだけで、外さない）
 *   - ターミナルは右か下（フッター・設定で切り替え）。中央との境界はドラッグで動かせる（splitRatio）
 * 隠すときに外さないのは、ターミナルのPTY（起動中のAgent）とサイドバーの状態を失わないため。
 */

export type PanelId = 'projects' | 'terminal' | 'files'
export type Dock = 'left' | 'right' | 'top' | 'bottom'
export type FooterDock = 'top' | 'bottom'

export const PANEL_IDS: readonly PanelId[] = ['projects', 'terminal', 'files']
/**
 * タイトルバーのボタンで開閉するパネル（左 → 右の並び。VS Code の右上のトグルと同じ）。
 * ターミナルは常に表示する（ユーザーの指示：閉じる・隠す手段を持たない。ブラウザに集中する間だけ隠す = browserFocusLayout）
 */
export const CLOSABLE_PANELS = ['projects', 'files'] as const
export type ClosablePanel = (typeof CLOSABLE_PANELS)[number]
/** 常に表示するパネル */
export const ALWAYS_VISIBLE_PANELS: readonly PanelId[] = ['terminal']
/** 左右のパネルの置き場所（固定） */
export const FIXED_DOCKS: Record<ClosablePanel, Dock> = { projects: 'left', files: 'right' }
/** ターミナルを置ける場所（フッターのボタン・設定で切り替える） */
export const TERMINAL_DOCKS: readonly Dock[] = ['right', 'bottom']

/** フッターの項目。並びはフッターでの左からの順 */
export const FOOTER_ITEMS = [
  'usage',
  'apiUsage',
  'recording',
  'mic',
  'transcription',
  'resources',
  'publish',
  'github',
  'page',
  'layout',
  'version',
  'theme',
  'settings'
] as const
export type FooterItemId = (typeof FOOTER_ITEMS)[number]

interface PanelPlacement {
  dock: Dock
  visible: boolean
}

export interface LayoutPrefs {
  panels: Record<PanelId, PanelPlacement>
  footer: {
    dock: FooterDock
    visible: boolean
    items: Record<FooterItemId, boolean>
  }
}

export const DEFAULT_LAYOUT: LayoutPrefs = {
  panels: {
    projects: { dock: 'left', visible: true },
    terminal: { dock: 'right', visible: true },
    files: { dock: 'right', visible: true }
  },
  footer: {
    dock: 'bottom',
    visible: true,
    items: Object.fromEntries(FOOTER_ITEMS.map((id) => [id, true])) as Record<FooterItemId, boolean>
  }
}

const isTerminalDock = (v: unknown): v is Dock => TERMINAL_DOCKS.includes(v as Dock)

/**
 * 保存された値を型どおりに直す。壊れた値は既定へ戻す。
 * 以前の設定（terminalDock だけ）があれば、ターミナルの置き場所として引き継ぐ。
 * 左右のパネルの置き場所は固定（ドラッグで動かしていた古い設定も既定へ戻す）。ターミナルは右か下だけ（左・上は右へ）。
 */
export function sanitizeLayout(raw: unknown, legacyTerminalDock?: unknown): LayoutPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { panels?: Record<string, unknown>; footer?: Record<string, unknown> }
  const panels = {} as Record<PanelId, PanelPlacement>
  for (const id of PANEL_IDS) {
    const p = (r.panels?.[id] && typeof r.panels[id] === 'object' ? r.panels[id] : {}) as Partial<PanelPlacement>
    const dock = id === 'terminal'
      ? isTerminalDock(p.dock) ? p.dock : !r.panels && isTerminalDock(legacyTerminalDock) ? legacyTerminalDock : DEFAULT_LAYOUT.panels.terminal.dock
      : FIXED_DOCKS[id]
    // ターミナルは常に表示する（ユーザーの指示：閉じる手段を持たない）。古い設定で閉じたままにしない
    panels[id] = { dock, visible: ALWAYS_VISIBLE_PANELS.includes(id) || p.visible !== false }
  }
  const f = (r.footer ?? {}) as { dock?: unknown; visible?: unknown; items?: Record<string, unknown> }
  const items = {} as Record<FooterItemId, boolean>
  for (const id of FOOTER_ITEMS) items[id] = f.items?.[id] !== false
  return {
    panels,
    // フッターは常に下（動かす機能は削除。ユーザーの指示: 不要）。古い設定の dock: 'top' も下に戻す
    footer: { dock: 'bottom', visible: f.visible !== false, items }
  }
}

/** 1つのパネルの置き場所・表示を変えた配置を返す。左右のパネルの置き場所・ターミナルの左・上は受け付けない */
export function withPanel(layout: LayoutPrefs, id: PanelId, patch: Partial<PanelPlacement>): LayoutPrefs {
  const next = { ...layout.panels[id], ...patch }
  if (ALWAYS_VISIBLE_PANELS.includes(id)) next.visible = true
  if (id !== 'terminal') next.dock = FIXED_DOCKS[id]
  else if (!isTerminalDock(next.dock)) next.dock = layout.panels.terminal.dock
  return { ...layout, panels: { ...layout.panels, [id]: next } }
}

interface GridTemplate {
  columns: string
  rows: string
  areas: string
}

/** 横に置いたときの幅・縦に置いたときの高さ。CSS の変数で持つ */
/**
 * 狭い窓での最小の大きさ（px）。足りないときは、左右のパネルが先に縮み、中央の列は CENTER_MIN_WIDTH を守る。
 * 窓の最小幅（main の minWidth: 900）で、左右のパネルを両方開き、ターミナルを左右に置いても収まる値にする
 * （SIDE_MIN_WIDTH×2 ＋ 境界 ＋ TERMINAL_MIN_WIDTH ＋ CENTER_MIN_WIDTH ≦ 900）。
 * 値を変えるときは test/unit/layout.test.ts と e2e/layout.spec.ts（900×650 で中央 360px・ターミナル 240px 以上）も一緒に直す。
 */
export const CENTER_MIN_WIDTH = 360
export const TERMINAL_MIN_WIDTH = 240
const TERMINAL_MIN_HEIGHT = 160
export const SIDE_MIN_WIDTH = 140
const SPLITTER_SIZE = 6
/** 窓の最小幅（src/main/index.ts の BrowserWindow の minWidth と同じ値） */
export const WINDOW_MIN_WIDTH = 900

/**
 * 配置ごとの最小の横幅（px）。左右に開いたパネルの最小 ＋ 本体の最小（中央の列 ＋ ターミナルを左右に置くなら境界とターミナル）。
 * 窓がこれより狭くならなければ、中央の列は CENTER_MIN_WIDTH を下回らない（単体テストで確かめる）。
 */
export function layoutMinWidth(layout: LayoutPrefs): number {
  const sides = CLOSABLE_PANELS.filter((id) => layout.panels[id].visible).length
  return sides * SIDE_MIN_WIDTH + mainMinWidth(layout.panels.terminal.dock, layout.panels.terminal.visible)
}

/** 本体（中央の列とターミナル）の最小の横幅（px）。ターミナルを隠している（ブラウザに集中）なら中央の列だけ */
export function mainMinWidth(terminalDock: Dock, terminalVisible = true): number {
  return terminalVisible && (terminalDock === 'left' || terminalDock === 'right')
    ? CENTER_MIN_WIDTH + SPLITTER_SIZE + TERMINAL_MIN_WIDTH
    : CENTER_MIN_WIDTH
}

const SIDE_WIDTH: Record<ClosablePanel, string> = {
  projects: 'var(--sidebar-width)',
  files: 'var(--size-sidebar)'
}

/**
 * ワークスペース（プロジェクト一覧 | 本体 | ファイルツリー）のグリッド。
 * 隠したパネルも列は残して幅を 0 にする（中身を外さず、開閉を滑らかにする）。
 */
export function workspaceGrid(layout: LayoutPrefs): GridTemplate {
  // 左右のパネルは、足りなければ SIDE_MIN_WIDTH まで縮む（本体の最小幅を先に取り、残りを左右へ配る。CSS グリッドの minmax の動き）
  const sideColumn = (id: ClosablePanel) => (layout.panels[id].visible ? `minmax(${SIDE_MIN_WIDTH}px, ${SIDE_WIDTH[id]})` : '0px')
  const mainColumn = `minmax(${mainMinWidth(layout.panels.terminal.dock, layout.panels.terminal.visible)}px, 1fr)`
  return {
    columns: [sideColumn('projects'), mainColumn, sideColumn('files')].join(' '),
    rows: 'minmax(0, 1fr)',
    areas: '"projects main files"'
  }
}

/**
 * 本体（中央のタブ群とターミナル）のグリッド。中央の大きさは --split-left（splitRatio）で決める。
 * ターミナルが左・上なら並びを逆にする。
 * ターミナルは常に表示する（閉じる手段を持たない）。境界をドラッグしても実質隠れないよう、
 * 中央の大きさを「全体 − 境界 − ターミナルの最小（左右 240px・上下 160px）」で頭打ちにする。
 * 横に並べるときは、中央の列も CENTER_MIN_WIDTH（360px）を下回らない（ワークスペース側で本体にその分の幅を先に取る）。
 */
export function mainSplitGrid(dock: Dock, terminalVisible = true): GridTemplate & { orientation: 'vertical' | 'horizontal'; reverse: boolean } {
  const horizontal = dock === 'left' || dock === 'right'
  const reverse = dock === 'left' || dock === 'top'
  // ブラウザに集中している間は中央だけ（境界とターミナルは App が隠す。ターミナルは外さないので PTY は残る）
  if (!terminalVisible) return { columns: 'minmax(0, 1fr)', rows: 'minmax(0, 1fr)', areas: '"center"', orientation: horizontal ? 'vertical' : 'horizontal', reverse }
  const min = `${horizontal ? TERMINAL_MIN_WIDTH : TERMINAL_MIN_HEIGHT}px`
  // 上限：ターミナルの最小を残す。下限：横に並べるときは中央の列の最小（ドラッグで寄せても下回らない）
  const capped = `min(var(--split-left), calc(100% - var(--size-splitter) - ${min}))`
  const center = horizontal ? `max(${CENTER_MIN_WIDTH}px, ${capped})` : capped
  const split = 'var(--size-splitter)'
  const term = 'minmax(0, 1fr)'
  const tracks = reverse ? [term, split, center] : [center, split, term]
  const names = reverse ? ['term', 'split', 'center'] : ['center', 'split', 'term']
  return horizontal
    ? { columns: tracks.join(' '), rows: 'minmax(0, 1fr)', areas: `"${names.join(' ')}"`, orientation: 'vertical', reverse }
    : { columns: 'minmax(0, 1fr)', rows: tracks.join(' '), areas: names.map((n) => `"${n}"`).join(' '), orientation: 'horizontal', reverse }
}

/** 配置の変化を1語にまとめる（内蔵ブラウザの位置を測り直すきっかけ = layoutKey に入れる） */
export function layoutSignature(layout: LayoutPrefs): string {
  const p = PANEL_IDS.map((id) => `${id[0]}${layout.panels[id].dock[0]}${layout.panels[id].visible ? 1 : 0}`).join('')
  return `${p}f${layout.footer.dock[0]}${layout.footer.visible ? 1 : 0}`
}

/**
 * タブの並べ替え。from を to の前（before）か後ろへ動かした新しい並びを返す。
 * どちらかが並びに無ければそのまま返す。
 */
export function moveItem<T>(order: readonly T[], from: T, to: T, before: boolean): T[] {
  if (from === to || !order.includes(from) || !order.includes(to)) return [...order]
  const rest = order.filter((x) => x !== from)
  const at = rest.indexOf(to) + (before ? 0 : 1)
  return [...rest.slice(0, at), from, ...rest.slice(at)]
}

/** 今あるタブを、覚えている並びの順に並べる。覚えていないもの（新しく開いたファイル）は後ろへ */
export function applyOrder<T extends string>(ids: readonly T[], order: readonly string[]): T[] {
  const rank = (id: T) => {
    const i = order.indexOf(id)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  return ids.map((id, i) => ({ id, i })).sort((a, b) => rank(a.id) - rank(b.id) || a.i - b.i).map((x) => x.id)
}

/** パネルの開閉（タイトルバーのボタン・⌘⇧E で共通）。open を渡すとその状態にする。ターミナルは閉じない（sanitizeLayout が表示に戻す） */
export function togglePanel(layout: LayoutPrefs, id: PanelId, open?: boolean): LayoutPrefs {
  return withPanel(layout, id, { visible: open ?? !layout.panels[id].visible })
}

/**
 * ブラウザに集中する（タイトルバーのボタン）間の見た目の配置。ブラウザ以外のパネル（プロジェクト一覧・ファイルツリー・ターミナル）を隠す。
 * 保存はしない（設定の配置はそのまま）。もう一度押すと元の配置で描き直すだけなので、元へ戻すための記録は要らない。
 * ターミナルは大きさを 0 にして隠すだけで外さない（PTY・Agent の画面は残る）。
 */
export function browserFocusLayout(layout: LayoutPrefs): LayoutPrefs {
  const hidden = (id: PanelId): PanelPlacement => ({ ...layout.panels[id], visible: false })
  return { ...layout, panels: { projects: hidden('projects'), terminal: hidden('terminal'), files: hidden('files') } }
}

/**
 * フッターの項目の優先順位（Orca の useStatusBarDensity / VS Code のステータスバーと同じ考え方）。
 * 0 は常に出す（録画時間・使用量・設定）。1 から順に大事で、数の大きいものほど先に右端の「…」へ移す。
 * 段でまとめて隠さず1つずつ移すので、空きがあるあいだはできるだけ多くフッターに並ぶ（pickFooterOverflow）。
 * 使用量の段階的な短縮（UsageMeter）は、ほかを全部「…」へ移したあとに効く。
 */
export const FOOTER_PRIORITY: Record<FooterItemId, number> = {
  recording: 0,
  usage: 0,
  settings: 0,
  mic: 1,
  // 従量課金の API（判定モデルなど）の使用量。Agent の使用量の次に見たいもの
  apiUsage: 2,
  transcription: 3,
  github: 4,
  version: 5,
  page: 6,
  resources: 7,
  theme: 8,
  layout: 9,
  // 発信（X への投稿の下書き）。押したときに開ければよいので、狭いときは最初に「…」へ移す
  publish: 10
}

/**
 * 幅が足りないときに「…」へ移す項目を選ぶ（純粋な関数。単体テストの対象）。
 * slots は出す設定になっている項目と「全部出したときの幅」、priority は FOOTER_PRIORITY の値。
 * 項目のあいだには gap ずつ隙間が入る。全部収まれば何も移さない。収まらなければ「…」ボタンの幅（moreWidth）を空けたうえで、
 * 優先順位の高いものから順に入るだけ並べ、入らないものを「…」へ移す（大きい項目が入らなくても、後ろの小さい項目は入れば出す）。
 * 優先順位 0 は収まらなくても出す。返す並びは slots の順。
 */
export function pickFooterOverflow<Id extends string>(slots: ReadonlyArray<{ id: Id; priority: number; width: number }>, available: number, gap: number, moreWidth: number): Id[] {
  const total = (list: ReadonlyArray<{ width: number }>) => list.reduce((sum, s) => sum + s.width, 0) + gap * Math.max(0, list.length - 1)
  if (total(slots) <= available) return []
  const always = slots.filter((s) => s.priority <= 0)
  // 「…」ボタンとその前の隙間
  let used = total(always) + moreWidth + (always.length > 0 ? gap : 0)
  const overflow = new Set<Id>()
  for (const s of [...slots].filter((s) => s.priority > 0).sort((a, b) => a.priority - b.priority)) {
    const need = s.width + gap
    if (used + need <= available) used += need
    else overflow.add(s.id)
  }
  return slots.filter((s) => overflow.has(s.id)).map((s) => s.id)
}
