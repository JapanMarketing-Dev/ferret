import { describe, expect, it } from 'vitest'
import type { BrowserState } from '../../src/shared/types'
import { INITIAL_BROWSER_STATE, browserAppKey, createBrowserSelector, getBrowserState, setBrowserState, subscribeBrowserState } from '../../src/renderer/lib/browserStore'

const state = (patch: Partial<BrowserState>): BrowserState => ({ ...INITIAL_BROWSER_STATE, ...patch })

describe('内蔵ブラウザの状態の置き場（src/renderer/lib/browserStore.ts）', () => {
  it('変わったときだけ知らせる。同じオブジェクトなら知らせない', () => {
    let calls = 0
    const off = subscribeBrowserState(() => { calls += 1 })
    const a = state({ url: 'https://a.example/' })
    setBrowserState(a)
    setBrowserState(a)
    expect(calls).toBe(1)
    expect(getBrowserState()).toBe(a)
    off()
    setBrowserState(state({ url: 'https://b.example/' }))
    expect(calls).toBe(1)
  })

  it('App 用の読み方は、読み込み中の印・タブの一覧だけが変わっても同じオブジェクトを返す（App を描き直さない）', () => {
    const select = createBrowserSelector(browserAppKey)
    const first = state({ url: 'https://a.example/', title: 'A', loading: true })
    setBrowserState(first)
    expect(select()).toBe(first)
    setBrowserState({ ...first, loading: false, tabs: [{ id: 't1', url: 'https://a.example/', title: 'A' } as never] })
    expect(select()).toBe(first)
    const titled = { ...first, title: 'A2' }
    setBrowserState(titled)
    expect(select()).toBe(titled)
    const back = { ...titled, canGoBack: true }
    setBrowserState(back)
    expect(select()).toBe(back)
  })

  it('App が使う値（URL・タイトル・表示幅・開けなかった理由・前のタブ・戻る進む）は全部 key に入る', () => {
    const base = state({})
    const keys = new Set([
      base, { ...base, url: 'x' }, { ...base, title: 'x' }, { ...base, viewport: 'mobile' as const }, { ...base, loadError: 'x' },
      { ...base, activeTabId: 'x' }, { ...base, canGoBack: true }, { ...base, canGoForward: true }
    ].map(browserAppKey))
    expect(keys.size).toBe(8)
    expect(browserAppKey({ ...base, loading: true })).toBe(browserAppKey(base))
  })
})
