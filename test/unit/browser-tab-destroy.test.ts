/**
 * プロジェクトの切り替え（replaceTabs）とタブを閉じるときの、古いビューの片付けの順序（0.4.19 の Windows のクラッシュの再発防止）。
 * 古いタブは先に隠してウインドウから外し、webContents の close は次のティックに回す。閉じかけのタブは、
 * 前に出す・配置（bounds）・エミュレーションのどれからも触らない。
 * あわせて、読み込みの中断（ERR_ABORTED）は想定内として Sentry へ送らない（FERRET-1R）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isAbortedNavigation } from '../../src/shared/browserNav'

const state = vi.hoisted(() => ({
  log: [] as string[],
  views: [] as Array<{ id: number; webContents: { closed: boolean; events: Map<string, (...args: unknown[]) => void>; restoreError: unknown } }>,
  reported: [] as string[]
}))

vi.mock('electron', () => {
  const fakeSession = {
    setPermissionRequestHandler: () => undefined,
    setPermissionCheckHandler: () => undefined,
    getUserAgent: () => 'UA',
    setUserAgent: () => undefined,
    webRequest: { onBeforeSendHeaders: () => undefined, onHeadersReceived: () => undefined }
  }
  let seq = 0
  class WebContentsView {
    id = ++seq
    webContents = {
      session: fakeSession,
      closed: false,
      restoreError: null as unknown,
      url: '',
      events: new Map<string, (...args: unknown[]) => void>(),
      isDestroyed: () => this.webContents.closed,
      setWindowOpenHandler: () => undefined,
      on: (name: string, fn: (...args: unknown[]) => void) => { this.webContents.events.set(name, fn) },
      loadURL: async (url: string) => { this.webContents.url = url },
      getURL: () => this.webContents.url,
      getTitle: () => '',
      getUserAgent: () => 'UA',
      setUserAgent: () => undefined,
      isLoading: () => false,
      isFocused: () => false,
      focus: () => undefined,
      enableDeviceEmulation: () => { state.log.push(`emulate ${this.id}`) },
      disableDeviceEmulation: () => undefined,
      close: () => {
        if (this.webContents.closed) throw new Error('closed twice')
        state.log.push(`close ${this.id}`)
        this.webContents.closed = true
      },
      navigationHistory: {
        canGoBack: () => false,
        canGoForward: () => false,
        getAllEntries: () => [{ url: 'https://example.com/a', title: '' }],
        getActiveIndex: () => 0,
        restore: async () => { if (this.webContents.restoreError) throw this.webContents.restoreError }
      }
    }
    constructor() { state.views.push(this) }
    setBackgroundColor(): void {}
    setBounds(b: { width: number }): void { if (this.webContents.closed) throw new Error('bounds on closed view'); state.log.push(`bounds ${this.id} ${b.width}`) }
    setVisible(v: boolean): void { if (this.webContents.closed) throw new Error('visible on closed view'); state.log.push(`visible ${this.id} ${v}`) }
    getBounds() { return { x: 0, y: 0, width: 0, height: 0 } }
  }
  return {
    WebContentsView,
    session: { fromPartition: () => fakeSession },
    shell: { openExternal: async () => undefined },
    dialog: { showMessageBox: async () => ({ response: 1 }) }
  }
})

vi.mock('../../src/shared/report', async (orig) => ({
  ...(await orig<typeof import('../../src/shared/report')>()),
  reportHandled: (_err: unknown, tags: { op?: string }) => { state.reported.push(tags.op ?? '') }
}))

const { EmbeddedBrowser } = await import('../../src/main/browser')

function attach(): InstanceType<typeof EmbeddedBrowser> {
  const window = {
    contentView: { addChildView: (v: { id: number }) => { state.log.push(`add ${v.id}`) }, removeChildView: (v: { id: number }) => { state.log.push(`remove ${v.id}`) }, children: [] },
    isDestroyed: () => false
  } as unknown as Parameters<InstanceType<typeof EmbeddedBrowser>['attach']>[0]
  const browser = new EmbeddedBrowser()
  browser.attach(window, { urls: ['https://example.com/shop', 'https://example.com/shop2'], active: 0 }, 'desktop')
  browser.setBounds({ x: 0, y: 0, width: 800, height: 600 })
  return browser
}

const nextTick = () => new Promise((r) => setImmediate(r))
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  state.log.length = 0
  state.views.length = 0
  state.reported.length = 0
})

describe('プロジェクトを切り替えたときの古いタブの片付け', () => {
  it('古いタブは隠してウインドウから外し、close は次のティック。そのあとの配置は古いビューを触らない', async () => {
    const browser = attach()
    const [a, b] = state.views
    state.log.length = 0
    browser.replaceTabs(null, { urls: ['https://example.com/blog'], active: 0 })
    // 同じ流れの中では close しない
    expect(state.log.filter((l) => l.startsWith('close'))).toEqual([])
    for (const old of [a!, b!]) {
      const i = state.log.indexOf(`visible ${old.id} false`)
      const removed = state.log.indexOf(`remove ${old.id}`)
      expect(i).toBeGreaterThanOrEqual(0)
      expect(removed).toBeGreaterThan(i)
    }
    await nextTick()
    expect(state.log.filter((l) => l.startsWith('close'))).toEqual([`close ${a!.id}`, `close ${b!.id}`])
    // ファイルを開いて中央のタブがブラウザから外れる（bounds が空）・戻る、を繰り返しても、閉じたビューには触らない（触ると偽物が投げる）
    state.log.length = 0
    browser.setBounds(null)
    browser.setBounds({ x: 0, y: 0, width: 640, height: 480 })
    expect(state.log.some((l) => l.includes(` ${a!.id} `) || l.endsWith(` ${a!.id}`))).toBe(false)
  })

  it('閉じかけのタブに dom-ready が届いても、エミュレーションを掛けない', async () => {
    const browser = attach()
    browser.setViewport('mobile')
    const [a] = state.views
    browser.replaceTabs(null, { urls: ['https://example.com/blog'], active: 0 })
    state.log.length = 0
    a!.webContents.events.get('dom-ready')?.()
    expect(state.log.filter((l) => l === `emulate ${a!.id}`)).toEqual([])
    await nextTick()
  })

  it('タブを閉じても、すぐには close しない。同じタブを2回閉じても close は1回', async () => {
    const browser = attach()
    const [a] = state.views
    const tabs = (browser as unknown as { tabs: Array<{ id: string }> }).tabs
    browser.closeTab(tabs[0]!.id)
    browser.closeTab(tabs[0]?.id ?? '')
    expect(state.log.filter((l) => l.startsWith('close'))).toEqual([])
    await nextTick()
    expect(state.log.filter((l) => l === `close ${a!.id}`)).toHaveLength(1)
  })
})

describe('まとめて閉じる（右クリックのメニュー）', () => {
  const ids = (browser: InstanceType<typeof EmbeddedBrowser>) => browser.tabIds()
  const active = (browser: InstanceType<typeof EmbeddedBrowser>) => (browser as unknown as { activeId: string }).activeId

  it('ほかを閉じると、残すタブが前に出て、ほかは閉じる', async () => {
    const browser = attach()
    const [first, second] = ids(browser)
    browser.closeTabs([first!], second!)
    expect(ids(browser)).toEqual([second])
    expect(active(browser)).toBe(second)
    await nextTick()
  })

  it('右側を閉じても、前に出ているタブが残るならそのまま', async () => {
    const browser = attach()
    const [first, second] = ids(browser)
    expect(active(browser)).toBe(first)
    browser.closeTabs([second!], first!)
    expect(ids(browser)).toEqual([first])
    expect(active(browser)).toBe(first)
    await nextTick()
  })

  it('すべて閉じると空のタブが1枚残る', async () => {
    const browser = attach()
    const before = ids(browser)
    browser.closeTabs(before, null)
    const after = ids(browser)
    expect(after).toHaveLength(1)
    expect(before).not.toContain(after[0])
    expect(active(browser)).toBe(after[0])
    await nextTick()
  })

  it('知らない id・空の一覧では何も変わらない', async () => {
    const browser = attach()
    const before = ids(browser)
    browser.closeTabs(['nope'], before[0]!)
    browser.closeTabs([], null)
    expect(ids(browser)).toEqual(before)
    await nextTick()
  })
})

describe('ほかのビューの片付けも同じ順序（FERRET-1Q）', () => {
  it('dispose は隠して外し、close は次のティック', async () => {
    const browser = attach()
    const [a, b] = state.views
    state.log.length = 0
    browser.dispose()
    expect(state.log.filter((l) => l.startsWith('close'))).toEqual([])
    for (const old of [a!, b!]) expect(state.log.indexOf(`remove ${old.id}`)).toBeGreaterThan(state.log.indexOf(`visible ${old.id} false`))
    await nextTick()
    expect(state.log.filter((l) => l.startsWith('close'))).toEqual([`close ${a!.id}`, `close ${b!.id}`])
  })

  it('retireView は同じ流れで close しない。先に閉じられていても触らない', async () => {
    const { retireView } = await import('../../src/main/viewTeardown')
    const { WebContentsView } = await import('electron')
    const window = { contentView: { removeChildView: (v: { id: number }) => { state.log.push(`remove ${v.id}`) } }, isDestroyed: () => false }
    const v = new WebContentsView() as unknown as (typeof state.views)[number]
    const w = new WebContentsView() as unknown as (typeof state.views)[number]
    state.log.length = 0
    retireView(window as never, v as never, 'test')
    retireView(window as never, w as never, 'test')
    expect(state.log).toEqual([`visible ${v.id} false`, `bounds ${v.id} 0`, `remove ${v.id}`, `visible ${w.id} false`, `bounds ${w.id} 0`, `remove ${w.id}`])
    w.webContents.closed = true
    await nextTick()
    expect(state.log.filter((l) => l.startsWith('close'))).toEqual([`close ${v.id}`])
    expect(state.reported).toEqual([])
  })

  it('映し込み・拡張のポップアップの片付けも retireView を通る（同じティックの close を書かない）', async () => {
    const { readFileSync } = await import('node:fs')
    for (const file of ['src/main/browser.ts', 'src/main/browserExtensions.ts']) {
      const src = readFileSync(file, 'utf8')
      expect(src).not.toMatch(/removeChildView\([^)]*\)\s*\n\s*if \(![^\n]*isDestroyed\(\)\) [^\n]*webContents\.close\(\)/)
    }
    expect(readFileSync('src/main/browser.ts', 'utf8')).toMatch(/retireView\(this\.window, view, 'destroy capture mirror'\)/)
    expect(readFileSync('src/main/browserExtensions.ts', 'utf8')).toMatch(/retireView\(this\.host\.window\(\), this\.view, 'close extension popup'\)/)
  })
  it('拡張のポップアップは、中身が壊れたあとの配置で位置を入れずに閉じる（destroyed から次のティックの close までの間。0.6.2 の FERRET-1Q）', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/main/browserExtensions.ts', 'utf8')
    const layout = /  layout\(\): void \{([\s\S]*?)\n  \}/.exec(src)?.[1] ?? ''
    const guard = layout.indexOf('if (this.view.webContents.isDestroyed()) return this.close()')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(layout.indexOf('this.view.setBounds('))
  })
})

describe('読み込みの中断（ERR_ABORTED）は送らない（FERRET-1R）', () => {
  it('ERR_ABORTED (-3) の形を見分ける', () => {
    expect(isAbortedNavigation(Object.assign(new Error("ERR_ABORTED (-3) loading 'https://example.com/'"), { errno: -3, code: 'ERR_ABORTED' }))).toBe(true)
    expect(isAbortedNavigation({ errno: -3 })).toBe(true)
    expect(isAbortedNavigation({ code: 'ERR_ABORTED' })).toBe(true)
    expect(isAbortedNavigation(new Error("ERR_ABORTED (-3) loading 'https://example.com/'"))).toBe(true)
    expect(isAbortedNavigation(Object.assign(new Error("ERR_NAME_NOT_RESOLVED (-105) loading 'https://x.invalid/'"), { errno: -105 }))).toBe(false)
    expect(isAbortedNavigation(null)).toBe(false)
    expect(isAbortedNavigation('ERR_ABORTED')).toBe(false)
  })

  it('履歴を戻す途中で中断されても送らない。ほかの失敗は送る', async () => {
    const browser = attach()
    const snapshot = browser.snapshotTabs()
    // 次に作られるタブの restore を中断させる
    const aborted = Object.assign(new Error("ERR_ABORTED (-3) loading 'https://example.com/a'"), { errno: -3, code: 'ERR_ABORTED' })
    const originalPush = state.views.push.bind(state.views)
    state.views.push = (v) => { v.webContents.restoreError = aborted; return originalPush(v) }
    browser.replaceTabs(snapshot, { urls: [], active: 0 })
    await flush()
    expect(state.reported).not.toContain('restore tab history')
    state.views.push = (v) => { v.webContents.restoreError = new Error('boom'); return originalPush(v) }
    browser.replaceTabs(snapshot, { urls: [], active: 0 })
    await flush()
    expect(state.reported).toContain('restore tab history')
    state.views.push = originalPush
    await nextTick()
  })
})
