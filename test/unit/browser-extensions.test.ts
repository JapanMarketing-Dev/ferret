/**
 * 内蔵ブラウザのブラウザ拡張機能（src/shared/browserExtensions.ts・src/main/browserExtensions.ts）。
 * electron を差し替え、「内蔵ブラウザの session にだけ・file: に触らせずに読み込む」「ポップアップに preload を入れない」
 * 「取り込みで _metadata・シンボリックリンクを写さず、上限で止める」を確かめる
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({
  views: [] as Array<{ webPreferences: Record<string, unknown>; loaded: string[]; events: Map<string, (...args: unknown[]) => void>; bounds: unknown; visible: boolean }>,
  added: 0,
  removed: 0
}))

vi.mock('electron', () => {
  class WebContentsView {
    entry: (typeof state.views)[number]
    webContents: Record<string, unknown>
    constructor(options: { webPreferences: Record<string, unknown> }) {
      const entry = { webPreferences: options.webPreferences, loaded: [] as string[], events: new Map<string, (...args: unknown[]) => void>(), bounds: null as unknown, visible: true }
      this.entry = entry
      state.views.push(entry)
      let destroyed = false
      this.webContents = {
        isDestroyed: () => destroyed,
        setWindowOpenHandler: (h: (d: { url: string }) => unknown) => entry.events.set('window-open', h as (...args: unknown[]) => void),
        on: (name: string, fn: (...args: unknown[]) => void) => entry.events.set(name, fn),
        loadURL: async (url: string) => { entry.loaded.push(url) },
        focus: () => undefined,
        close: () => { destroyed = true }
      }
    }
    setBackgroundColor(): void {}
    setVisible(v: boolean): void { this.entry.visible = v }
    setBounds(b: unknown): void { this.entry.bounds = b }
  }
  return { WebContentsView, Menu: { buildFromTemplate: () => ({ popup: () => undefined }) } }
})

const shared = await import('@shared/browserExtensions')
const main = await import('../../src/main/browserExtensions')

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ade-browser-ext-'))
  state.views.length = 0
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function makeExtension(dir: string, manifest: Record<string, unknown>, extra: Record<string, string> = {}): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
  for (const [name, text] of Object.entries(extra)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  return dir
}

describe('設定の browserExtensions', () => {
  it('絶対パスだけ・重複なし・無効だけ enabled: false を書く。空なら書かない', () => {
    expect(shared.sanitizeBrowserExtensions(undefined)).toBeUndefined()
    expect(shared.sanitizeBrowserExtensions([])).toBeUndefined()
    expect(shared.sanitizeBrowserExtensions([
      { path: '/ext/a' }, { path: '/ext/a', enabled: false }, { path: 'relative/b' }, { path: 'C:\\ext\\c', enabled: false }, { path: '/ext/d', enabled: true }, 'x', null, { path: '/e\0vil' }
    ])).toEqual([{ path: '/ext/a' }, { path: 'C:\\ext\\c', enabled: false }, { path: '/ext/d' }])
  })

  it('読み込み直しの合図（reload）は 0 以上の整数だけ残す', () => {
    expect(shared.sanitizeBrowserExtensions([
      { path: '/ext/a', reload: 1760000000 }, { path: '/ext/b', reload: -1 }, { path: '/ext/c', reload: 1.5 }, { path: '/ext/d', reload: '9' }, { path: '/ext/e', enabled: false, reload: 0 }
    ])).toEqual([{ path: '/ext/a', reload: 1760000000 }, { path: '/ext/b' }, { path: '/ext/c' }, { path: '/ext/d' }, { path: '/ext/e', enabled: false, reload: 0 }])
  })

  it('上限より多くは持たない', () => {
    const many = Array.from({ length: shared.MAX_BROWSER_EXTENSIONS + 5 }, (_, i) => ({ path: `/ext/${i}` }))
    expect(shared.sanitizeBrowserExtensions(many)).toHaveLength(shared.MAX_BROWSER_EXTENSIONS)
  })
})

describe('manifest.json の読み方', () => {
  it('MV3 の action・MV2 の browser_action / page_action からポップアップを取る', () => {
    expect(shared.parseExtensionManifest({ manifest_version: 3, name: 'A', version: '1.0', action: { default_popup: 'popup.html' } })?.popup).toBe('popup.html')
    expect(shared.parseExtensionManifest({ manifest_version: 2, name: 'B', version: '1', browser_action: { default_popup: './ui/p.html' } })?.popup).toBe('ui/p.html')
    expect(shared.parseExtensionManifest({ manifest_version: 2, name: 'C', version: '1', page_action: { default_popup: 'p.html' } })?.popup).toBe('p.html')
    expect(shared.parseExtensionManifest({ manifest_version: 3, name: 'D', version: '1', options_ui: { page: 'opt.html' } })?.options).toBe('opt.html')
  })

  it('拡張の外を指すポップアップ（/・..・スキーム・\\）は使わない', () => {
    for (const bad of ['/etc/passwd', '../x.html', 'a/../../x.html', 'https://evil.example/p.html', 'javascript:alert(1)', 'a\\b.html', 'file:///x']) {
      expect(shared.extensionRelativePath(bad), bad).toBeNull()
    }
    expect(shared.extensionRelativePath('popup.html?x=1#y')).toBe('popup.html')
  })

  it('拡張でないもの（版が無い・テーマ・アプリ）を見分ける', () => {
    expect(shared.parseExtensionManifest({ name: 'x' })).toBeNull()
    expect(shared.parseExtensionManifest({ manifest_version: 1, name: 'x' })).toBeNull()
    expect(shared.parseExtensionManifest([])).toBeNull()
    expect(shared.parseExtensionManifest({ manifest_version: 3, name: 'T', theme: {} })?.kind).toBe('theme')
    expect(shared.parseExtensionManifest({ manifest_version: 2, name: 'App', app: {} })?.kind).toBe('app')
  })

  it('名前の __MSG_xx__ を既定の言語の文に直す（キーの大文字小文字は問わない）', () => {
    expect(shared.resolveManifestMessage('__MSG_appName__', { APPNAME: { message: 'Color Picker' } })).toBe('Color Picker')
    expect(shared.resolveManifestMessage('__MSG_missing__', {})).toBe('__MSG_missing__')
    expect(shared.resolveManifestMessage('Plain', { Plain: { message: 'x' } })).toBe('Plain')
  })

  it('いちばん新しい版のフォルダを選ぶ', () => {
    expect(shared.latestVersionDir(['1.9.3_0', '1.10.0_0', 'Temp', '1.2_1'])).toBe('1.10.0_0')
    expect(shared.latestVersionDir(['junk'])).toBeNull()
    expect(shared.compareVersions('2.0', '2.0.0')).toBe(0)
  })

  it('Chrome の拡張の ID は a〜p の32文字だけ', () => {
    expect(shared.isChromeExtensionId('a'.repeat(32))).toBe(true)
    expect(shared.isChromeExtensionId('z'.repeat(32))).toBe(false)
    expect(shared.isChromeExtensionId('../' + 'a'.repeat(29))).toBe(false)
  })

  it('OS ごとの Chromium 系のユーザーデータの場所', () => {
    expect(shared.chromiumUserDataDirs('darwin', '/Users/me', {})[0]).toEqual({ browser: 'Google Chrome', dir: '/Users/me/Library/Application Support/Google/Chrome' })
    expect(shared.chromiumUserDataDirs('win32', 'C:\\Users\\me', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' })[0]!.dir).toBe('C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data')
    expect(shared.chromiumUserDataDirs('linux', '/home/me', {})[0]!.dir).toBe('/home/me/.config/google-chrome')
    expect(shared.isChromiumProfileDir('Default')).toBe(true)
    expect(shared.isChromiumProfileDir('Profile 3')).toBe(true)
    expect(shared.isChromiumProfileDir('System Profile')).toBe(false)
  })
})

describe('ポップアップの位置（録画に重ねる位置と見た目を一致させる）', () => {
  it('大きさは Chrome と同じ範囲に収める', () => {
    expect(shared.clampPopupSize({ width: 2000, height: 5 })).toEqual({ width: 800, height: 25 })
    expect(shared.clampPopupSize({ width: Number.NaN, height: 300 })).toEqual({ width: 25, height: 300 })
  })

  it('ビューの右上に置き、ビューの中に収める', () => {
    expect(shared.placePopup({ x: 100, y: 50, width: 1000, height: 700 }, { width: 300, height: 400 })).toEqual({ x: 792, y: 50, width: 300, height: 400 })
    expect(shared.placePopup({ x: 0, y: 0, width: 200, height: 100 }, { width: 300, height: 400 })).toEqual({ x: 8, y: 0, width: 184, height: 92 })
    expect(shared.placePopup({ x: 0, y: 0, width: 0, height: 0 }, { width: 300, height: 400 })).toBeNull()
  })

  it('ビューの中の割合に直す', () => {
    expect(shared.relativeRect({ x: 150, y: 50, width: 100, height: 200 }, { x: 50, y: 50, width: 400, height: 400 })).toEqual({ x: 0.25, y: 0, width: 0.25, height: 0.5 })
    expect(shared.relativeRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 0, height: 10 })).toBeNull()
  })

  it('ポップアップのリンクは http・https だけを内蔵ブラウザで開く。中の遷移はその拡張のページだけ', () => {
    expect(shared.isPopupLinkAllowed('https://example.com/a')).toBe(true)
    expect(shared.isPopupLinkAllowed('file:///etc/passwd')).toBe(false)
    expect(shared.isPopupLinkAllowed('https://u:p@example.com')).toBe(false)
    expect(shared.isPopupLinkAllowed('javascript:alert(1)')).toBe(false)
    const id = 'a'.repeat(32)
    expect(shared.isOwnExtensionUrl(`chrome-extension://${id}/other.html`, id)).toBe(true)
    expect(shared.isOwnExtensionUrl(`chrome-extension://${'b'.repeat(32)}/x.html`, id)).toBe(false)
    expect(shared.isOwnExtensionUrl('https://example.com', id)).toBe(false)
  })
})

describe('Chrome からの取り込み', () => {
  it('プロフィールの拡張を探し、いちばん新しい版・テーマ以外・__MSG_ の名前を直して返す', async () => {
    const chrome = join(root, 'Chrome')
    const id = 'a'.repeat(32)
    makeExtension(join(chrome, 'Default', 'Extensions', id, '1.0.0_0'), { manifest_version: 3, name: 'Old', version: '1.0.0' })
    makeExtension(join(chrome, 'Default', 'Extensions', id, '1.2.0_0'), { manifest_version: 3, name: '__MSG_name__', version: '1.2.0', default_locale: 'en' },
      { '_locales/en/messages.json': JSON.stringify({ name: { message: 'Picker' } }) })
    makeExtension(join(chrome, 'Profile 1', 'Extensions', 'b'.repeat(32), '3_0'), { manifest_version: 3, name: 'Dark theme', version: '3', theme: {} })
    mkdirSync(join(chrome, 'System Profile', 'Extensions', 'c'.repeat(32), '1_0'), { recursive: true })
    const found = await main.scanInstalledExtensions([{ browser: 'Google Chrome', dir: chrome }, { browser: 'None', dir: join(root, 'missing') }], new Set([id]))
    expect(found.map(({ name, version, profile, imported }) => ({ name, version, profile, imported }))).toEqual([{ name: 'Picker', version: '1.2.0', profile: 'Default', imported: true }])
  })

  it('写すとき _metadata とシンボリックリンクは写さない', async () => {
    const src = makeExtension(join(root, 'src'), { manifest_version: 3, name: 'X', version: '1' },
      { 'popup.html': '<p>hi</p>', '_metadata/verified_contents.json': '{}', 'js/a.js': '1' })
    writeFileSync(join(root, 'secret.txt'), 'secret')
    symlinkSync(join(root, 'secret.txt'), join(src, 'link.txt'))
    const dest = join(root, 'dest')
    await main.copyExtensionDir(src, dest)
    expect(readdirSync(dest).sort()).toEqual(['js', 'manifest.json', 'popup.html'])
    expect(readFileSync(join(dest, 'js', 'a.js'), 'utf8')).toBe('1')
  })

  it('件数・総量の上限を超えたら止め、写しかけを消す', async () => {
    const src = makeExtension(join(root, 'src'), { manifest_version: 3, name: 'X', version: '1' }, { 'a.txt': 'x'.repeat(100) })
    const dest = join(root, 'dest')
    await expect(main.copyExtensionDir(src, dest, { files: 1, bytes: 1_000_000 })).rejects.toThrow(/too many/)
    expect(existsSync(dest)).toBe(false)
    await expect(main.copyExtensionDir(src, dest, { files: 10, bytes: 50 })).rejects.toThrow(/too large/)
    expect(existsSync(dest)).toBe(false)
  })
})

describe('読み込み（内蔵ブラウザの session だけ）', () => {
  function fakeSession() {
    const calls: Array<{ op: string; path?: string; id?: string; options?: unknown }> = []
    let n = 0
    return {
      calls,
      extensions: {
        loadExtension: async (path: string, options: unknown) => { calls.push({ op: 'load', path, options }); n += 1; return { id: String.fromCharCode(96 + n).repeat(32), name: 'x', version: '1', path, url: '', manifest: {} } },
        removeExtension: (id: string) => { calls.push({ op: 'remove', id }) }
      }
    }
  }
  const host = (bounds: { x: number; y: number; width: number; height: number } | null = { x: 0, y: 40, width: 1000, height: 700 }) => {
    const window = { isDestroyed: () => false, contentView: { addChildView: () => { state.added += 1 }, removeChildView: () => { state.removed += 1 } } }
    return { window: () => window as never, viewBounds: () => bounds, navigate: vi.fn() }
  }

  it('有効なものだけを file: に触れない形で読み込み、外したものは取り除く', async () => {
    const a = makeExtension(join(root, 'a'), { manifest_version: 3, name: 'A', version: '1', action: { default_popup: 'popup.html' } })
    const b = makeExtension(join(root, 'b'), { manifest_version: 3, name: 'B', version: '2' })
    const notExt = join(root, 'empty')
    mkdirSync(notExt)
    const ses = fakeSession()
    const ext = new main.BrowserExtensions({ session: () => ses as never, host: host(), importDir: () => join(root, 'imports') })
    await ext.sync([{ path: a }, { path: b, enabled: false }, { path: notExt }])
    expect(ses.calls).toEqual([{ op: 'load', path: a, options: { allowFileAccess: false } }])
    const list = ext.list()
    expect(list.map((e) => ({ name: e.name, enabled: e.enabled, hasPopup: e.hasPopup, loaded: !!e.id, error: !!e.error }))).toEqual([
      { name: 'A', enabled: true, hasPopup: true, loaded: true, error: false },
      { name: 'B', enabled: false, hasPopup: false, loaded: false, error: false },
      { name: 'empty', enabled: true, hasPopup: false, loaded: false, error: true }
    ])
    expect(ext.hasPopupExtensions()).toBe(true)
    await ext.sync([{ path: b }])
    expect(ses.calls.slice(1)).toEqual([{ op: 'remove', id: 'a'.repeat(32) }, { op: 'load', path: b, options: { allowFileAccess: false } }])
    expect(ext.hasPopupExtensions()).toBe(false)
  })

  it('reload の値が変わったものだけを外して読み込み直し、manifest も読み直して、ページの読み込み直しを知らせる', async () => {
    const a = makeExtension(join(root, 'ra'), { manifest_version: 3, name: 'A', version: '1' })
    const b = makeExtension(join(root, 'rb'), { manifest_version: 3, name: 'B', version: '1' })
    const ses = fakeSession()
    const ext = new main.BrowserExtensions({ session: () => ses as never, host: host(), importDir: () => join(root, 'imports') })
    const reloaded = vi.fn()
    ext.onReloaded = reloaded
    await ext.sync([{ path: a }, { path: b }])
    await ext.sync([{ path: a }, { path: b }])
    expect(ses.calls.map((c) => c.op)).toEqual(['load', 'load'])
    expect(reloaded).not.toHaveBeenCalled()
    makeExtension(a, { manifest_version: 3, name: 'A', version: '2' })
    await ext.sync([{ path: a, reload: 1760000000 }, { path: b }])
    expect(ses.calls.slice(2)).toEqual([{ op: 'remove', id: 'a'.repeat(32) }, { op: 'load', path: a, options: { allowFileAccess: false } }])
    expect(ext.list().find((e) => e.path === a)?.version).toBe('2')
    expect(reloaded).toHaveBeenCalledTimes(1)
    // 同じ値のままなら読み込み直さない
    await ext.sync([{ path: a, reload: 1760000000 }, { path: b }])
    expect(ses.calls).toHaveLength(4)
    expect(reloaded).toHaveBeenCalledTimes(1)
  })

  it('ポップアップは preload なし・sandbox・内蔵ブラウザの session のビューで、ビューの右上に開く', async () => {
    const a = makeExtension(join(root, 'a'), { manifest_version: 3, name: 'A', version: '1', action: { default_popup: 'popup.html' } })
    const ses = fakeSession()
    const h = host()
    const ext = new main.BrowserExtensions({ session: () => ses as never, host: h, importDir: () => join(root, 'imports') })
    const changes: unknown[] = []
    ext.onPopupChange = (p) => changes.push(p)
    await ext.sync([{ path: a }])
    expect(ext.openPopup(a)).toBe(true)
    const view = state.views[0]!
    expect(view.webPreferences).toMatchObject({ session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true })
    expect(view.webPreferences.preload).toBeUndefined()
    await new Promise((r) => setTimeout(r, 0))
    expect(view.loaded).toEqual([`chrome-extension://${'a'.repeat(32)}/popup.html`])
    view.events.get('did-finish-load')!()
    view.events.get('preferred-size-changed')!({}, { width: 320, height: 240 })
    expect(view.bounds).toEqual({ x: 1000 - 320 - 8, y: 40, width: 320, height: 240 })
    expect(ext.popupTarget()?.bounds).toEqual({ x: 672, y: 40, width: 320, height: 240 })
    // ポップアップの中から外へ出る遷移は止め、http(s) は内蔵ブラウザで開く
    const prevent = vi.fn()
    view.events.get('will-navigate')!({ url: 'https://example.com/docs', preventDefault: prevent })
    expect(prevent).toHaveBeenCalled()
    expect(h.navigate).toHaveBeenCalledWith('https://example.com/docs')
    const prevent2 = vi.fn()
    view.events.get('will-navigate')!({ url: 'file:///etc/passwd', preventDefault: prevent2 })
    expect(prevent2).toHaveBeenCalled()
    expect(h.navigate).toHaveBeenCalledTimes(1)
    // 閉じたら録画へ知らせる
    ext.closePopup()
    expect(changes.at(-1)).toBeNull()
    expect(ext.popupTarget()).toBeNull()
  })

  it('録画中・文字で指摘の間に開いたものだけ、書き込みの注入スクリプトを入れる（sandbox などはそのまま）。書き込みの最中は Esc で閉じない', async () => {
    const a = makeExtension(join(root, 'a'), { manifest_version: 3, name: 'A', version: '1', action: { default_popup: 'popup.html' } })
    const ses = fakeSession()
    let annotating = true
    const inputs: unknown[] = []
    const h = { ...host(), reviewPreload: () => '/app/out/preload/review.js', annotating: () => annotating, popupInput: (wc: unknown) => inputs.push(wc) }
    const ext = new main.BrowserExtensions({ session: () => ses as never, host: h, importDir: () => join(root, 'imports') })
    await ext.sync([{ path: a }])
    expect(ext.openPopup(a)).toBe(true)
    const view = state.views[0]!
    expect(view.webPreferences).toMatchObject({ session: ses, preload: '/app/out/preload/review.js', sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true })
    view.events.get('did-finish-load')!()
    view.events.get('preferred-size-changed')!({}, { width: 320, height: 240 })
    // 本物の入力（OS から届いたもの）だけを許可の元として渡す
    view.events.get('input-event')!({}, { type: 'mouseMove' })
    expect(inputs).toHaveLength(0)
    view.events.get('input-event')!({}, { type: 'mouseDown' })
    expect(inputs).toHaveLength(1)
    const esc = { preventDefault: vi.fn() }
    view.events.get('before-input-event')!(esc, { type: 'keyDown', key: 'Escape' })
    expect(esc.preventDefault).not.toHaveBeenCalled()
    expect(ext.popupTarget()).not.toBeNull()
    annotating = false
    view.events.get('before-input-event')!(esc, { type: 'keyDown', key: 'Escape' })
    expect(ext.popupTarget()).toBeNull()
  })

  it('注入スクリプトを入れないと決めたら preload なし', async () => {
    const a = makeExtension(join(root, 'a'), { manifest_version: 3, name: 'A', version: '1', action: { default_popup: 'popup.html' } })
    const ext = new main.BrowserExtensions({ session: () => fakeSession() as never, host: { ...host(), reviewPreload: () => null }, importDir: () => join(root, 'imports') })
    await ext.sync([{ path: a }])
    expect(ext.openPopup(a)).toBe(true)
    expect(state.views[0]!.webPreferences.preload).toBeUndefined()
  })

  it('ビューが隠れていればポップアップを開かない・開いていれば閉じる', async () => {
    const a = makeExtension(join(root, 'a'), { manifest_version: 3, name: 'A', version: '1', action: { default_popup: 'popup.html' } })
    let bounds: { x: number; y: number; width: number; height: number } | null = { x: 0, y: 0, width: 800, height: 600 }
    const h = { ...host(), viewBounds: () => bounds }
    const ext = new main.BrowserExtensions({ session: () => fakeSession() as never, host: h, importDir: () => join(root, 'imports') })
    await ext.sync([{ path: a }])
    expect(ext.openPopup(a)).toBe(true)
    bounds = null
    ext.relayout()
    expect(ext.popupTarget()).toBeNull()
    expect(ext.openPopup(a)).toBe(false)
  })

  it('取り込んだ写しだけを消す（利用者のフォルダは消さない）', async () => {
    const imports = join(root, 'imports')
    const id = 'c'.repeat(32)
    makeExtension(join(imports, id), { manifest_version: 3, name: 'C', version: '1' })
    const own = makeExtension(join(root, 'mine'), { manifest_version: 3, name: 'Mine', version: '1' })
    const ext = new main.BrowserExtensions({ session: () => fakeSession() as never, host: host(), importDir: () => imports })
    await ext.deleteImportedCopy(own)
    await ext.deleteImportedCopy(join(imports, '..', 'mine'))
    expect(existsSync(own)).toBe(true)
    await ext.deleteImportedCopy(join(imports, id))
    expect(existsSync(join(imports, id))).toBe(false)
  })
})

describe('配線の不変条件', () => {
  const src = (p: string) => readFileSync(join(__dirname, '../../src', p), 'utf8')

  it('拡張を読み込むのは browserExtensions.ts だけで、渡す session は内蔵ブラウザのもの', () => {
    const files = ['main/index.ts', 'main/browser.ts', 'main/recording/recorderWindow.ts', 'main/recording/controller.ts', 'main/preview/index.ts']
    for (const f of files) expect(src(f), f).not.toMatch(/loadExtension\(/)
    // 渡すのは内蔵ブラウザの session（いまのログインの組）と、用意した内蔵ブラウザの session すべて（browser.ts の browserSessions）
    expect(src('main/index.ts')).toMatch(/new BrowserExtensions\(\{[^}]*session: \(\) => browser\?\.activeSession\(\) \?\? browserSession\(\),\s*sessions: \(\) => browserSessions\(\)/)
  })

  it('拡張機能の IPC は宣言済みのチャネルとして、アプリの窓の本体のフレームからだけ受ける（dispatcher を通る）', () => {
    const ipc = src('shared/ipc.ts')
    for (const ch of ['browserExtensions:list', 'browserExtensions:addFolder', 'browserExtensions:import', 'browserExtensions:menu']) expect(ipc).toContain(`'${ch}'`)
    // 取り込みは main が見つけた候補の key だけを受け、画面からパスを受け取らない
    expect(src('main/index.ts')).toMatch(/installedExtensions\.get\(String\(key\)\)/)
  })
})

describe('静止画にポップアップを重ねる（overlayStillSource）', () => {
  /** 1画素 4 バイトの偽の画像。scale は DIP に対する画素の倍率 */
  function image(width: number, height: number, fill: number, scale = 1) {
    const data = Buffer.alloc(width * height * 4 * scale * scale, fill)
    const self = {
      isEmpty: () => false,
      getSize: () => ({ width, height }),
      toBitmap: () => data,
      resize: ({ width: w, height: h }: { width: number; height: number }) => image(w, h, fill)
    }
    return self
  }

  it('ポップアップの位置（割合）に重ね、元の DIP の大きさのままにする', async () => {
    const { overlayStillSource } = await import('../../src/main/recording/stills')
    const base = image(10, 10, 0, 2)
    const popup = image(4, 4, 255)
    const made: Array<{ data: Buffer; size: { width: number; height: number; scaleFactor: number } }> = []
    const source = overlayStillSource({ capture: async () => base as never, gone: false },
      () => ({ contents: { isDestroyed: () => false, capturePage: async () => popup } as never, rect: { x: 0.5, y: 0, width: 0.5, height: 0.5 } }),
      (data, size) => { made.push({ data, size }); return image(size.width / size.scaleFactor, size.height / size.scaleFactor, 1) as never })
    await source.capture()
    expect(made).toHaveLength(1)
    const { data, size } = made[0]!
    expect(size).toEqual({ width: 20, height: 20, scaleFactor: 2 })
    // 右上の 10×10 画素がポップアップ、左上は元のまま
    expect(data[(0 * 20 + 15) * 4]).toBe(255)
    expect(data[(0 * 20 + 5) * 4]).toBe(0)
    expect(data[(15 * 20 + 15) * 4]).toBe(0)
  })

  it('ポップアップが無ければ元の画像をそのまま返す', async () => {
    const { overlayStillSource } = await import('../../src/main/recording/stills')
    const base = image(10, 10, 0)
    const fromBitmap = vi.fn()
    const source = overlayStillSource({ capture: async () => base as never, gone: false }, () => null, fromBitmap)
    expect(await source.capture()).toBe(base)
    expect(fromBitmap).not.toHaveBeenCalled()
  })
})

describe('ツールバーの拡張のボタンとログインの組（0.6.9）', () => {
  function multiSession(loaded = new Set<string>()) {
    const calls: Array<{ op: string; path?: string; id?: string }> = []
    return {
      calls,
      extensions: {
        loadExtension: async (path: string) => { calls.push({ op: 'load', path }); const id = /[\\/]a$/.test(path) ? 'a'.repeat(32) : 'b'.repeat(32); loaded.add(id); return { id } },
        removeExtension: (id: string) => { calls.push({ op: 'remove', id }); loaded.delete(id) },
        getExtension: (id: string) => (loaded.has(id) ? { id } : null)
      }
    }
  }
  const host = { window: () => null as never, viewBounds: () => ({ x: 0, y: 40, width: 1000, height: 700 }), navigate: vi.fn() }

  it('アイコンは action.default_icon → icons の順で 32px に近いもの（足りなければ一番大きいもの）。外へ出るパスは使わない', () => {
    expect(shared.pickExtensionIcon({ 16: 'i16.png', 48: 'i48.png', 128: 'i128.png' })).toBe('i48.png')
    expect(shared.pickExtensionIcon({ 16: 'i16.png', 19: 'i19.png' })).toBe('i19.png')
    expect(shared.pickExtensionIcon('icon.png')).toBe('icon.png')
    expect(shared.pickExtensionIcon({ 32: '../x.png' })).toBeNull()
    expect(shared.pickExtensionIcon(null)).toBeNull()
    expect(shared.parseExtensionManifest({ manifest_version: 3, name: 'T', action: { default_icon: { 32: 'a32.png' } }, icons: { 128: 'big.png' } })!.icon).toBe('a32.png')
    expect(shared.parseExtensionManifest({ manifest_version: 2, name: 'T', icons: { 128: 'big.png' } })!.icon).toBe('big.png')
  })

  it('アイコンは data: URL で一覧に載る。大きすぎる・画像でない・リンクは載せない', async () => {
    const a = makeExtension(join(root, 'a'), { manifest_version: 3, name: 'Translate', version: '1', action: { default_popup: 'popup.html', default_icon: 'icon.png' } }, { 'icon.png': 'PNGDATA' })
    expect(await main.readExtensionIcon(a, 'icon.png')).toBe(`data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`)
    expect(await main.readExtensionIcon(a, 'manifest.json')).toBeNull()
    writeFileSync(join(a, 'big.png'), Buffer.alloc(300 * 1024))
    expect(await main.readExtensionIcon(a, 'big.png')).toBeNull()
    symlinkSync(join(a, 'icon.png'), join(a, 'link.png'))
    expect(await main.readExtensionIcon(a, 'link.png')).toBeNull()
    const ses = multiSession()
    const ext = new main.BrowserExtensions({ session: () => ses as never, host, importDir: () => join(root, 'imports') })
    await ext.sync([{ path: a }])
    expect(ext.list()[0]).toMatchObject({ name: 'Translate', hasPopup: true, icon: expect.stringMatching(/^data:image\/png;base64,/) })
  })

  it('拡張はログインの組ごとの session すべてに読み込み、外すときもすべてから外す', async () => {
    const a = makeExtension(join(root, 'a'), { manifest_version: 3, name: 'A', version: '1' })
    const shared1 = multiSession()
    const client = multiSession()
    const sessions = [shared1]
    const ext = new main.BrowserExtensions({ session: () => client as never, sessions: () => sessions as never, host, importDir: () => join(root, 'imports') })
    await ext.sync([{ path: a }])
    expect(shared1.calls).toEqual([{ op: 'load', path: a }])
    // 別の組の session ができたら、もう一度 sync すればそこにも読み込む（index.ts の onBrowserSessionReady）
    sessions.push(client)
    await ext.sync([{ path: a }])
    expect(client.calls).toEqual([{ op: 'load', path: a }])
    expect(shared1.calls).toHaveLength(1)
    await ext.sync([])
    expect(shared1.calls.at(-1)).toEqual({ op: 'remove', id: 'a'.repeat(32) })
    expect(client.calls.at(-1)).toEqual({ op: 'remove', id: 'a'.repeat(32) })
  })

  it('配線：ボタンは browserExtensions:open で開き、ポップアップは開いているタブと同じ組の session', () => {
    const src = (p: string) => readFileSync(join(__dirname, '../../src', p), 'utf8')
    expect(src('shared/ipc.ts')).toContain("'browserExtensions:open'")
    expect(src('main/index.ts')).toMatch(/'browserExtensions:open': \(path\) => \{/)
    expect(src('renderer/components/BrowserToolbar.tsx')).toContain('<BrowserExtensionActions />')
    const browser = src('main/browser.ts')
    // タブはそれぞれ作ったときのプロジェクトのログインの組で開く（隠しているプロジェクトのタブも同じ）
    expect(browser).toContain('overrideBrowserWindowOptions: popupWindowOptions(tab.partition)')
    expect(browser).toContain('session: browserSession(() => this.window, tab.partition)')
    const index = src('main/index.ts')
    expect(index).toMatch(/browser\.switchGroup\(project\.id, browserPartition\(saved\.browserProfile\), sessionTabs\(saved\)\)/)
    expect(index).toMatch(/onBrowserSessionReady\(\(ses\) => \{\n\s*registerPreviewProtocol\(\[ses\]/)
  })
})
