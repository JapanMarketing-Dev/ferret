/**
 * 内蔵ブラウザの配線そのものを確かめる（security-2 [4] [11]）。
 * electron を差し替え、browser.ts が「読み込みの前に権限の決まりを入れる」「OS の URL ハンドラへ渡さない」ことを見る。
 * ページの中でマイク・カメラを求める調べはしない（ハンドラを直接呼ぶ）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (...args: unknown[]) => unknown

const state = vi.hoisted(() => ({
  order: [] as string[],
  requestHandler: null as null | ((wc: unknown, permission: string, cb: (g: boolean) => void, details: Record<string, unknown>) => void),
  checkHandler: null as null | ((wc: unknown, permission: string, origin: string, details: Record<string, unknown>) => boolean),
  openExternal: [] as string[],
  dialogs: [] as string[],
  dialogResponse: 1,
  windowOpen: null as null | ((d: { url: string; disposition?: string }) => { action: string; overrideBrowserWindowOptions?: { webPreferences?: Record<string, unknown> } }),
  events: new Map<string, (...args: unknown[]) => void>(),
  loaded: [] as string[],
  currentUrl: 'https://evil.example/page',
  partitions: [] as string[],
  /** 作ったビュー（タブ）。並び順 */
  views: [] as Array<{ webContents: { events: Map<string, (...args: unknown[]) => void>; windowOpen: null | ((d: { url: string; disposition?: string }) => { action: string }); loaded: string[]; closed: boolean } ; visible: boolean; webPreferences: Record<string, unknown> }>
}))

vi.mock('electron', () => {
  const fakeSession = {
    setPermissionRequestHandler: (h: typeof state.requestHandler) => { state.order.push('request-handler'); state.requestHandler = h },
    setPermissionCheckHandler: (h: typeof state.checkHandler) => { state.order.push('check-handler'); state.checkHandler = h },
    getUserAgent: () => 'UA',
    setUserAgent: () => undefined,
    // UA の切り替え（browserUserAgent.ts の BrowserIdentity）が付けるヘッダーの書き換え
    webRequest: { onBeforeSendHeaders: () => undefined, onHeadersReceived: () => undefined }
  }
  class WebContentsView {
    visible = true
    webPreferences: Record<string, unknown>
    webContents = {
      session: fakeSession,
      events: new Map<string, (...args: unknown[]) => void>(),
      windowOpen: null as typeof state.windowOpen,
      loaded: [] as string[],
      closed: false,
      url: '',
      isDestroyed: () => this.webContents.closed,
      setWindowOpenHandler: (h: typeof state.windowOpen) => { state.windowOpen = h; this.webContents.windowOpen = h },
      on: (name: string, fn: (...args: unknown[]) => void) => { state.events.set(name, fn); this.webContents.events.set(name, fn) },
      loadURL: async (url: string) => { state.loaded.push(url); this.webContents.loaded.push(url); this.webContents.url = url },
      getURL: () => this.webContents.url || state.currentUrl,
      getTitle: () => '',
      isLoading: () => false,
      isFocused: () => false,
      isCurrentlyAudible: () => false,
      focus: () => undefined,
      close: () => { this.webContents.closed = true },
      navigationHistory: { canGoBack: () => false, canGoForward: () => false, getAllEntries: () => [], getActiveIndex: () => -1, restore: async () => undefined }
    }
    constructor(options: { webPreferences: { session: unknown } & Record<string, unknown> }) {
      state.order.push(options.webPreferences.session === fakeSession ? 'view-with-policy-session' : 'view-with-other-session')
      this.webPreferences = options.webPreferences
      state.views.push(this)
    }
    setBackgroundColor(): void {}
    setBounds(): void {}
    setVisible(visible: boolean): void { this.visible = visible }
    getBounds() { return { x: 0, y: 0, width: 0, height: 0 } }
  }
  return {
    WebContentsView,
    session: { fromPartition: (name: string) => { state.partitions.push(name); return fakeSession } },
    shell: { openExternal: async (url: string) => { state.openExternal.push(url) } },
    dialog: { showMessageBox: async (...args: unknown[]) => { state.dialogs.push(String((args.at(-1) as { detail?: string }).detail)); return { response: state.dialogResponse } } }
  }
})

const { EmbeddedBrowser, browserSession, PARTITION } = await import('../../src/main/browser')

const flush = () => new Promise((r) => setTimeout(r, 0))
const request = (permission: string, details: Record<string, unknown>) => new Promise<boolean>((resolve) => state.requestHandler!({}, permission, resolve, details))

function attach(): InstanceType<typeof EmbeddedBrowser> {
  const window = { contentView: { addChildView: () => {}, removeChildView: () => {}, children: [] }, isDestroyed: () => false } as unknown as Parameters<InstanceType<typeof EmbeddedBrowser>['attach']>[0]
  const browser = new EmbeddedBrowser()
  browser.attach(window, 'https://evil.example/page', 'desktop')
  return browser
}

/** そのタブ（ビュー）に、利用者の本物の入力（クリック）が届いた */
function gesture(view: (typeof state.views)[number]): void {
  view.webContents.events.get('input-event')!({}, { type: 'mouseDown' })
}

beforeEach(() => {
  state.openExternal.length = 0
  state.dialogs.length = 0
  state.dialogResponse = 1
  state.loaded.length = 0
})

describe('security-2 [4] 内蔵ブラウザの権限', () => {
  it('ビューを作る（読み込む）前に、request と check の両方のハンドラを入れる', () => {
    attach()
    const view = state.order.indexOf('view-with-policy-session')
    expect(view).toBeGreaterThan(-1)
    expect(state.order.indexOf('request-handler')).toBeLessThan(view)
    expect(state.order.indexOf('check-handler')).toBeLessThan(view)
  })

  it('レビューするページのマイク・カメラ・画面共有・位置・通知・クリップボードの読み取り・USB などは断る（session を使い回しても同じ）', async () => {
    browserSession()
    browserSession()
    const page = { requestingUrl: 'https://evil.example/page', isMainFrame: true, securityOrigin: 'https://evil.example' }
    expect(await request('media', { ...page, mediaTypes: ['audio'] })).toBe(false)
    expect(await request('media', { ...page, mediaTypes: ['video'] })).toBe(false)
    for (const p of ['display-capture', 'geolocation', 'notifications', 'clipboard-read', 'midiSysex', 'usb', 'hid', 'serial', 'local-network-access', 'pointerLock', 'something-new']) {
      expect(await request(p, page), p).toBe(false)
      expect(state.checkHandler!({}, p, 'https://evil.example', page), p).toBe(false)
    }
    expect(state.checkHandler!({}, 'media', 'https://evil.example', { ...page, mediaType: 'audio' })).toBe(false)
  })
})

describe('ログインのポップアップ', () => {
  it('大きさを指定した window.open は、同じ永続セッション・sandbox の子ウインドウで開く（opener を保つ）', () => {
    attach()
    const result = state.windowOpen!({ url: 'https://accounts.example/login', disposition: 'new-window' })
    expect(result.action).toBe('allow')
    expect(result.overrideBrowserWindowOptions?.webPreferences).toMatchObject({ partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true })
  })

  it('子ウインドウでは、外の http・ファイル・独自スキームへの遷移と転送を止め、さらに開くものは中で開くか断る', () => {
    attach()
    const child = new FakePopup()
    state.events.get('did-create-window')!(child)
    const nav = (name: string, url: string) => {
      let stopped = false
      child.wcEvents.get(name)!({ url, preventDefault: () => { stopped = true } })
      return stopped
    }
    for (const name of ['will-navigate', 'will-redirect']) {
      expect(nav(name, 'https://accounts.example/consent')).toBe(false)
      expect(nav(name, 'http://127.0.0.1:4100/callback')).toBe(false)
      expect(nav(name, 'file:///etc/passwd')).toBe(true)
      expect(nav(name, 'zoommtg://zoom.us/join')).toBe(true)
      expect(nav(name, 'http://evil.example/')).toBe(true)
    }
    expect(child.openHandler!({ url: 'https://accounts.example/next' }).action).toBe('deny')
    expect(child.loaded).toEqual(['https://accounts.example/next'])
    expect(child.openHandler!({ url: 'file:///etc/passwd' }).action).toBe('deny')
    expect(child.loaded).toEqual(['https://accounts.example/next'])
  })

  it('普通の別タブ（target=_blank）は子ウインドウにせず、利用者が押した直後なら、手元の開発中のページは内蔵ブラウザの新しいタブで開く', () => {
    attach()
    const opener = state.views.at(-1)!
    gesture(opener)
    state.loaded.length = 0
    expect(opener.webContents.windowOpen!({ url: 'http://localhost:3000/tab', disposition: 'foreground-tab' }).action).toBe('deny')
    const tab = state.views.at(-1)!
    expect(tab).not.toBe(opener)
    expect(tab.webContents.loaded).toEqual(['http://localhost:3000/tab'])
    expect(tab.visible).toBe(true)
    expect(opener.visible).toBe(false)
    expect(state.openExternal).toEqual([])
  })

  it('外のサイトへの別タブのリンクは、押した直後なら外部ブラウザで開く（内蔵ブラウザのタブを増やさない）。操作が無ければ外へは出さない', async () => {
    attach()
    const opener = state.views.at(-1)!
    const before = state.views.length
    opener.webContents.windowOpen!({ url: 'https://github.com/x/y', disposition: 'foreground-tab' })
    await flush()
    expect(state.openExternal).toEqual([])
    gesture(opener)
    expect(opener.webContents.windowOpen!({ url: 'https://github.com/x/y', disposition: 'foreground-tab' }).action).toBe('deny')
    opener.webContents.windowOpen!({ url: 'https://github.com/x/z', disposition: 'foreground-tab' })
    await flush()
    expect(state.openExternal).toEqual(['https://github.com/x/y'])
    expect(state.views.length).toBe(before)
  })

  it('ページのスクリプトだけ（利用者の操作が無い）の window.open は、タブを増やさず同じタブで開く。1回の操作で開けるのは1枚', () => {
    attach()
    const opener = state.views.at(-1)!
    const before = state.views.length
    opener.webContents.windowOpen!({ url: 'https://example.com/spam', disposition: 'foreground-tab' })
    expect(state.views.length).toBe(before)
    expect(opener.webContents.loaded).toContain('https://example.com/spam')
    gesture(opener)
    opener.webContents.windowOpen!({ url: 'http://localhost:3000/one', disposition: 'foreground-tab' })
    opener.webContents.windowOpen!({ url: 'http://localhost:3000/two', disposition: 'foreground-tab' })
    expect(state.views.length).toBe(before + 1)
    expect(opener.webContents.loaded).toContain('http://localhost:3000/two')
  })
})

class FakePopup {
  wcEvents = new Map<string, (...args: unknown[]) => void>()
  openHandler: null | ((d: { url: string }) => { action: string }) = null
  loaded: string[] = []
  webContents = {
    setWindowOpenHandler: (h: (d: { url: string }) => { action: string }) => { this.openHandler = h },
    on: (name: string, fn: (...args: unknown[]) => void) => { this.wcEvents.set(name, fn) },
    loadURL: async (url: string) => { this.loaded.push(url) }
  }
  once(): void {}
  setMenuBarVisibility(): void {}
  isDestroyed(): boolean { return false }
  close(): void {}
}

describe('内蔵ブラウザのログインの保持', () => {
  it('セッションは永続の partition（persist:）なので、Figma や Google ドキュメントへのログインは再起動後も残る', () => {
    attach()
    expect(PARTITION).toMatch(/^persist:/)
    expect(state.partitions.length).toBeGreaterThan(0)
    expect(new Set(state.partitions)).toEqual(new Set([PARTITION]))
  })
})

describe('security-2 [11] 内蔵ブラウザから OS の URL ハンドラへ渡さない', () => {
  const HOSTILE = ['zoommtg://zoom.us/join?confno=1', 'file:///etc/passwd', 'smb://attacker.example/share', 'data:text/html,<script>1</script>',
    'x-apple.systempreferences:com.apple.preference.security', 'ms-settings:privacy', 'javascript:alert(1)', 'vscode://file/etc/hosts']

  it('window.open の独自・file・SMB・data・OS 設定のスキームは openExternal を呼ばず、確認も出さない', async () => {
    attach()
    for (const url of HOSTILE) expect(state.windowOpen!({ url }).action).toBe('deny')
    await flush()
    expect(state.openExternal).toEqual([])
    expect(state.dialogs).toEqual([])
    // http(s) は同じビューで開く（外へは出さない）
    state.windowOpen!({ url: 'https://example.com/next' })
    expect(state.loaded).toContain('https://example.com/next')
  })

  it('ページの遷移と転送（リダイレクト）でも、行けない先は止める', async () => {
    attach()
    for (const name of ['will-navigate', 'will-redirect']) {
      for (const url of HOSTILE) {
        const event = { url, preventDefault: vi.fn() }
        state.events.get(name)!(event)
        expect(event.preventDefault, `${name} ${url}`).toHaveBeenCalled()
      }
      const ok = { url: 'https://example.com/', preventDefault: vi.fn() }
      state.events.get(name)!(ok)
      expect(ok.preventDefault).not.toHaveBeenCalled()
    }
    await flush()
    expect(state.openExternal).toEqual([])
  })

  it('リンク・転送からの外部アプリの起動（openExternal の権限）は断り、独自スキームは確認も出さない', async () => {
    browserSession()
    expect(await request('openExternal', { requestingUrl: 'https://evil.example/page', externalURL: 'zoommtg://zoom.us/join' })).toBe(false)
    expect(await request('openExternal', { requestingUrl: 'https://evil.example/page', externalURL: 'smb://attacker.example/share' })).toBe(false)
    await flush()
    expect(state.openExternal).toEqual([])
    expect(state.dialogs).toEqual([])
  })

  it('mailto は、行き先とページを見せた確認で「開く」を選んだときだけ渡す', async () => {
    attach()
    state.windowOpen!({ url: 'mailto:a@example.com' })
    await flush()
    expect(state.dialogs).toHaveLength(1)
    expect(state.dialogs[0]).toContain('mailto:a@example.com')
    expect(state.dialogs[0]).toContain('https://evil.example')
    expect(state.openExternal).toEqual([])
    state.dialogResponse = 0
    state.windowOpen!({ url: 'mailto:a@example.com' })
    await flush()
    expect(state.openExternal).toEqual(['mailto:a@example.com'])
  })
})

describe('内蔵ブラウザのタブ', () => {
  it('新しいタブも、同じ永続の session・注入スクリプトだけ・sandbox・遷移の決まり・window.open の扱いで作る', async () => {
    const browser = attach()
    const first = state.views.at(-1)!
    await browser.newTab('https://example.com/mail')
    const tab = state.views.at(-1)!
    expect(tab).not.toBe(first)
    expect(state.order.at(-1)).toBe('view-with-policy-session')
    expect(tab.webPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true })
    expect(String(tab.webPreferences.preload)).toMatch(/preload[\\/]review\.js$/)
    for (const name of ['input-event', 'before-input-event', 'will-navigate', 'will-redirect', 'did-create-window']) expect(tab.webContents.events.has(name), name).toBe(true)
    // 新しいタブからも、独自スキーム・ファイルへは行かせない
    const event = { url: 'file:///etc/passwd', preventDefault: vi.fn() }
    tab.webContents.events.get('will-navigate')!(event)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(tab.webContents.windowOpen!({ url: 'zoommtg://zoom.us/join' }).action).toBe('deny')
    expect(new Set(state.partitions)).toEqual(new Set([PARTITION]))
  })

  it('URL 欄から開くタブも、javascript: data: 独自スキームは作る前に断る', async () => {
    const browser = attach()
    const before = state.views.length
    for (const url of ['javascript:alert(1)', 'data:text/html,<p>x</p>', 'zoommtg://zoom.us/join']) await expect(browser.newTab(url), url).rejects.toThrow()
    expect(state.views.length).toBe(before)
  })

  it('タブは上限（MAX_BROWSER_TABS）まで。最後の1枚を閉じると空のタブに置き換わる。閉じたタブの中身は閉じる', async () => {
    const { MAX_BROWSER_TABS } = await import('../../src/shared/browserTabs')
    const base = state.views.length
    const browser = attach()
    for (let i = 1; i < MAX_BROWSER_TABS; i++) await browser.newTab()
    expect(browser.state().tabs).toHaveLength(MAX_BROWSER_TABS)
    await expect(browser.newTab()).rejects.toThrow(String(MAX_BROWSER_TABS))
    for (const tab of browser.state().tabs!.slice(1)) browser.closeTab(tab.id)
    // 閉じたタブの webContents の close は次のティック（外す処理と重ねない。browser-tab-destroy.test.ts）
    await new Promise((r) => setImmediate(r))
    const only = browser.state().tabs!
    expect(only).toHaveLength(1)
    const last = state.views.slice(base).find((view) => !view.webContents.closed)!
    browser.closeTab(only[0]!.id)
    expect(last.webContents.closed).toBe(false)
    await new Promise((r) => setImmediate(r))
    expect(last.webContents.closed).toBe(true)
    expect(browser.state().tabs).toHaveLength(1)
    expect(browser.state().tabs![0]!.id).not.toBe(only[0]!.id)
  })

  it('録画が使っているタブは、閉じても録画が終わるまで中身を残す', async () => {
    const browser = attach()
    await browser.newTab('https://example.com/b')
    const tab = state.views.at(-1)!
    browser.keepClosedTab = () => true
    browser.closeTab(browser.state().activeTabId!)
    expect(tab.webContents.closed).toBe(false)
    expect(tab.visible).toBe(true)
    browser.releaseClosedTabs()
    expect(tab.webContents.closed).toBe(true)
  })

  it('ページに焦点があるときの ⌘T・⌘W・⌘1・Ctrl+Tab は、メニューへ渡さずタブの操作にする', async () => {
    const browser = attach()
    const first = state.views.at(-1)!
    const press = (view: (typeof state.views)[number], input: Record<string, unknown>) => {
      const event = { preventDefault: vi.fn() }
      view.webContents.events.get('before-input-event')!(event, { type: 'keyDown', control: false, meta: false, alt: false, shift: false, ...input })
      return event.preventDefault
    }
    const mod = process.platform === 'darwin' ? { meta: true } : { control: true }
    let focused = 0
    browser.onFocusUrl = () => { focused++ }
    expect(press(first, { key: 't', ...mod })).toHaveBeenCalled()
    await flush()
    expect(browser.state().tabs).toHaveLength(2)
    expect(focused).toBe(1)
    const second = state.views.at(-1)!
    expect(press(second, { key: '1', ...mod })).toHaveBeenCalled()
    expect(browser.state().activeTabId).toBe(browser.state().tabs![0]!.id)
    expect(press(first, { key: 'Tab', control: true })).toHaveBeenCalled()
    expect(browser.state().activeTabId).toBe(browser.state().tabs![1]!.id)
    expect(press(second, { key: 'w', ...mod })).toHaveBeenCalled()
    expect(browser.state().tabs).toHaveLength(1)
    // ふつうの文字・書き込みのキーはページへ
    expect(press(first, { key: 'p' })).not.toHaveBeenCalled()
  })
})
