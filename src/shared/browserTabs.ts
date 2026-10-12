/**
 * 内蔵ブラウザのタブ（複数のページを開いて切り替える）の決まり。
 * main（browser.ts のタブの一覧・ページのキー）と renderer（タブの帯・キー）の両方から使うので Electron に依存しない。
 *
 * - タブはどれも同じ永続の session（persist:ade-browser）。ログイン・Cookie は共有する
 * - 開けるのは MAX_BROWSER_TABS まで。最後の1枚は閉じずに、空のタブに置き換える
 * - キー: ⌘T / Ctrl+T 新しいタブ・⌘W / Ctrl+W 閉じる（内蔵ブラウザに焦点があるときだけ。ほかはターミナル）、
 *   ⌘1〜⌘9 / Ctrl+1〜9 その番号のタブ（9 は最後）、Ctrl+Tab / Ctrl+Shift+Tab 次・前のタブ
 */

/** 一度に開けるタブの数 */
export const MAX_BROWSER_TABS = 20

/** 画面へ出すタブ1枚 */
export interface BrowserTabInfo {
  id: string
  title: string
  url: string
  loading: boolean
}

/** 次のタブの id（tab-1, tab-2 …。閉じた番号は使い直さない） */
export function nextTabId(counter: number): string {
  return `tab-${counter}`
}

/** 新しいタブを開けるか */
export function canOpenTab(count: number): boolean {
  return count < MAX_BROWSER_TABS
}

/**
 * タブを閉じたあとに前に出すタブ。閉じたのが前のタブでなければ、いまのまま。
 * 前のタブを閉じたら右隣、右端なら左隣（Chrome と同じ）。最後の1枚なら null（呼び出し側が空のタブを開く）
 */
export function tabAfterClose(ids: readonly string[], closing: string, active: string): string | null {
  const rest = ids.filter((id) => id !== closing)
  if (rest.length === 0) return null
  if (closing !== active && rest.includes(active)) return active
  const at = ids.indexOf(closing)
  if (at < 0) return rest.includes(active) ? active : rest[0]!
  return rest[Math.min(at, rest.length - 1)]!
}

/** タブの右クリックのメニューの項目（中央のタブ列と同じ並び。保存済みはブラウザに無い） */
export type BrowserTabCloseAction = 'close' | 'closeOthers' | 'closeRight' | 'closeAll'
export const BROWSER_TAB_CLOSE_ACTIONS: readonly BrowserTabCloseAction[] = ['close', 'closeOthers', 'closeRight', 'closeAll']

export function isBrowserTabCloseAction(value: unknown): value is BrowserTabCloseAction {
  return typeof value === 'string' && (BROWSER_TAB_CLOSE_ACTIONS as readonly string[]).includes(value)
}

/** 右クリックしたタブ（target）に対して閉じるタブ。ids はタブの並び。知らないタブなら何も閉じない */
export function browserTabsToClose(action: BrowserTabCloseAction, target: string, ids: readonly string[]): string[] {
  const at = ids.indexOf(target)
  if (at < 0) return []
  switch (action) {
    case 'close': return [target]
    case 'closeOthers': return ids.filter((id) => id !== target)
    case 'closeRight': return ids.slice(at + 1)
    case 'closeAll': return [...ids]
  }
}

/** ⌘1〜⌘8 はその番号、⌘9 は最後のタブ（Chrome と同じ）。無ければ null */
export function tabAtNumber(ids: readonly string[], n: number): string | null {
  if (!Number.isInteger(n) || n < 1 || n > 9 || ids.length === 0) return null
  if (n === 9) return ids[ids.length - 1]!
  return ids[n - 1] ?? null
}

/** 次（+1）・前（-1）のタブ。端では反対の端へ回る */
export function cycleTab(ids: readonly string[], active: string, step: 1 | -1): string | null {
  if (ids.length === 0) return null
  const at = ids.indexOf(active)
  if (at < 0) return ids[0]!
  return ids[(at + step + ids.length) % ids.length]!
}

/** タブのキー操作 */
export type BrowserTabKeyAction =
  | { type: 'new' }
  | { type: 'close' }
  | { type: 'number'; n: number }
  | { type: 'cycle'; step: 1 | -1 }

/** before-input-event（main）・keydown（renderer）の入力の要るところ */
export interface TabKeyInput {
  key: string
  control: boolean
  meta: boolean
  alt: boolean
  shift: boolean
}

/**
 * タブのキーか。macOS は ⌘（Ctrl+Tab だけは Ctrl）、Windows / Linux は Ctrl。
 * 注入スクリプトの書き込みのキー（P / B / V / C / ⌘Z）、戻る・進む（⌘[ ⌘] / Alt+← →）、録画（⌘⇧R）とは重ならない
 */
export function browserTabKeyAction(input: TabKeyInput, platform: string): BrowserTabKeyAction | null {
  const key = input.key
  if (input.alt) return null
  // Ctrl+Tab / Ctrl+Shift+Tab は、どの OS でも Ctrl（macOS の Chrome と同じ）
  if (key === 'Tab') return input.control && !input.meta ? { type: 'cycle', step: input.shift ? -1 : 1 } : null
  const mod = platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
  if (!mod || input.shift) return null
  const lower = key.toLowerCase()
  if (lower === 't') return { type: 'new' }
  if (lower === 'w') return { type: 'close' }
  if (/^[1-9]$/.test(key)) return { type: 'number', n: Number(key) }
  return null
}

/** タブの帯に出す名前。題名が無ければホスト名、それも無ければ空（呼び出し側が「新しいタブ」と出す） */
export function tabLabel(tab: Pick<BrowserTabInfo, 'title' | 'url'>): string {
  const title = tab.title.trim()
  if (title && title !== tab.url && title !== 'about:blank') return title
  if (!tab.url || tab.url === 'about:blank') return ''
  try {
    const u = new URL(tab.url)
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.host + (u.pathname === '/' ? '' : u.pathname)
    return tab.url
  } catch {
    // 読めない URL はそのまま（想定内）
    return tab.url
  }
}
