import { useSyncExternalStore } from 'react'
import type { BrowserState } from '@shared/types'

/**
 * 内蔵ブラウザの状態（browser:stateChanged）の置き場。
 *
 * 読み込み中の印・タイトル・タブの一覧は、ページを開くたびに何度も変わる。App の state に置くと、そのたびに
 * 画面全体（ターミナル・ファイルツリー・サイドバーを含む）を描き直していた。ここに置き、使う部品だけが読む。
 * App は自分が使う値（browserAppKey）が変わったときだけ描き直す。
 */

export const INITIAL_BROWSER_STATE: BrowserState = {
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: false,
  viewport: 'desktop'
}

let current: BrowserState = INITIAL_BROWSER_STATE
const listeners = new Set<() => void>()

export function getBrowserState(): BrowserState {
  return current
}

export function setBrowserState(next: BrowserState): void {
  if (next === current) return
  current = next
  for (const listener of [...listeners]) listener()
}

export function subscribeBrowserState(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** いまの状態をそのまま読む（タブの一覧・戻る・読み込み中の印を出す部品） */
export function useBrowserState(): BrowserState {
  return useSyncExternalStore(subscribeBrowserState, getBrowserState)
}

/**
 * key が変わったときだけ新しい状態を返す（ほかの値の変化では同じオブジェクトのまま＝描き直さない）。
 * key に入れていない値（loading・tabs など）は古いことがあるので、key に入れた値だけを使う
 */
export function createBrowserSelector(key: (state: BrowserState) => string): () => BrowserState {
  let cache: { key: string; state: BrowserState } | null = null
  return () => {
    const state = current
    if (cache?.state === state) return state
    const k = key(state)
    if (cache && cache.key === k) return cache.state
    cache = { key: k, state }
    return state
  }
}

/**
 * App と、App から state を受ける部品（StatusBar・FeedbackToolbar の戻る・進む）が使う値。
 * 読み込み中の印（loading）とタブの一覧（tabs）は入れない（それを出す部品は useBrowserState で読む）
 */
export function browserAppKey(state: BrowserState): string {
  return JSON.stringify([state.url, state.title, state.viewport, state.loadError ?? null, state.activeTabId ?? null, state.canGoBack, state.canGoForward])
}

/** App 用：browserAppKey の値が変わったときだけ描き直す */
const appSelector = createBrowserSelector(browserAppKey)
export function useAppBrowserState(): BrowserState {
  return useSyncExternalStore(subscribeBrowserState, appSelector)
}
