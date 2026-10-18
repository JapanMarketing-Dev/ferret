import { EventEmitter } from 'node:events'
import { request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { BrowserCdpServer, CdpRouter, type BrowserCdpDeps, type ContentsLike, type DebuggerLike } from '../../src/main/browserCdp'

/**
 * 内蔵ブラウザの CDP の中継（browser-use などが内蔵ブラウザを動かす口）。
 * タブだけを page の target に見せ、sessionId 付きの命令はそのタブの debugger へ、ブラウザ全体の命令は通さない
 */

class FakeDebugger extends EventEmitter implements DebuggerLike {
  attached = false
  commands: Array<{ method: string; params?: object }> = []
  failAttach = false
  attach(): void {
    if (this.failAttach || this.attached) throw new Error('already attached')
    this.attached = true
  }
  detach(): void {
    this.attached = false
  }
  isAttached(): boolean {
    return this.attached
  }
  async sendCommand(method: string, params?: object): Promise<unknown> {
    this.commands.push({ method, params })
    if (method === 'Runtime.evaluate') return { result: { type: 'number', value: 2 } }
    if (method === 'Page.fail') throw new Error('boom')
    return {}
  }
}

class FakeContents extends EventEmitter implements ContentsLike {
  readonly debugger = new FakeDebugger()
  destroyed = false
  constructor(public url: string, public title = '') {
    super()
  }
  getURL() { return this.url }
  getTitle() { return this.title }
  isDestroyed() { return this.destroyed }
  destroy() {
    this.destroyed = true
    this.emit('destroyed')
  }
}

function setup() {
  const tabs = [{ id: 'tab-1', contents: new FakeContents('https://example.com', 'Example') }]
  const listeners = new Set<() => void>()
  const changed = () => { for (const l of listeners) l() }
  const jar: Array<Record<string, unknown>> = [{ name: 'sid', value: 'x', domain: 'example.com', path: '/', expires: -1, size: 4, httpOnly: true, secure: true, session: true }]
  const created: string[] = []
  const closed: string[] = []
  const activated: string[] = []
  const attachedTabs: string[] = []
  const deps: BrowserCdpDeps = {
    tabs: () => tabs.filter((t) => !t.contents.destroyed),
    createTab: async (url) => {
      created.push(url)
      const id = `tab-${tabs.length + 1}`
      tabs.push({ id, contents: new FakeContents(url || '') })
      return id
    },
    closeTab: (id) => { closed.push(id) },
    activateTab: (id) => { activated.push(id) },
    onAttach: (id) => { attachedTabs.push(id) },
    onTabsChanged: (l) => { listeners.add(l); return () => listeners.delete(l) },
    cookies: {
      get: async () => jar as never,
      set: async (c) => { jar.push(...(c as never[])) },
      clear: async () => { jar.length = 0 }
    }
  }
  const router = new CdpRouter(deps)
  const out: Array<Record<string, unknown>> = []
  const conn = router.connect((m) => out.push(m as Record<string, unknown>))
  let nextId = 1
  const call = async (method: string, params: object = {}, sessionId?: string) => {
    const id = nextId++
    await conn.handle(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return out.find((m) => m.id === id) as { result?: Record<string, unknown>; error?: { message: string }; sessionId?: string }
  }
  return { tabs, created, closed, activated, attachedTabs, router, out, conn, call, changed, listeners, jar }
}

describe('CdpRouter', () => {
  it('タブだけを page の target として返し、ブラウザの版も答える', async () => {
    const h = setup()
    expect((await h.call('Browser.getVersion')).result?.product).toBe('Ferret/BuiltInBrowser')
    expect((await h.call('Target.getTargets')).result?.targetInfos).toEqual([
      { targetId: 'tab-1', type: 'page', title: 'Example', url: 'https://example.com', attached: false, canAccessOpener: false, browserContextId: 'ferret' }
    ])
    expect((await h.call('Target.getTargetInfo')).result?.targetInfo).toMatchObject({ type: 'browser' })
    expect((await h.call('Target.getTargetInfo', { targetId: 'nope' })).error?.message).toContain('No target')
  })

  it('attach（flatten）でタブの debugger につなぎ、sessionId 付きの命令をそのタブへ送り、出来事をその session で返す', async () => {
    const h = setup()
    const { sessionId } = (await h.call('Target.attachToTarget', { targetId: 'tab-1', flatten: true })).result as { sessionId: string }
    expect(sessionId).toMatch(/^[0-9A-F]{32}$/)
    expect(h.attachedTabs).toEqual(['tab-1'])
    expect(h.out.some((m) => m.method === 'Target.attachedToTarget')).toBe(true)
    const r = await h.call('Runtime.evaluate', { expression: '1+1' }, sessionId)
    expect(r).toMatchObject({ result: { result: { value: 2 } }, sessionId })
    const dbg = h.tabs[0]!.contents.debugger
    expect(dbg.commands).toEqual([{ method: 'Runtime.evaluate', params: { expression: '1+1' } }])
    dbg.emit('message', {}, 'Page.loadEventFired', { timestamp: 1 })
    dbg.emit('message', {}, 'Page.loadEventFired', { timestamp: 2 }, 'child-session')
    expect(h.out.filter((m) => m.method === 'Page.loadEventFired')).toEqual([{ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId }])
    expect((await h.call('Target.getTargets')).result?.targetInfos).toMatchObject([{ attached: true }])
  })

  it('ブラウザ全体に効く命令はタブへ通さない。知らない session・失敗はエラーで返す', async () => {
    const h = setup()
    const { sessionId } = (await h.call('Target.attachToTarget', { targetId: 'tab-1' })).result as { sessionId: string }
    for (const m of ['Browser.close', 'SystemInfo.getInfo', 'Tracing.start']) expect((await h.call(m, {}, sessionId)).error?.message).toContain('not available')
    expect(h.tabs[0]!.contents.debugger.commands).toEqual([])
    expect((await h.call('Runtime.evaluate', {}, 'BAD')).error?.message).toContain('Session')
    expect((await h.call('Page.fail', {}, sessionId)).error?.message).toBe('boom')
    expect((await h.call('Browser.close')).error?.message).toContain("wasn't found")
  })

  it('タブを開く・前に出す・閉じるは内蔵ブラウザの操作になる（about:blank は空のタブ）', async () => {
    const h = setup()
    expect((await h.call('Target.createTarget', { url: 'about:blank', background: true })).result).toEqual({ targetId: 'tab-2' })
    await h.call('Target.createTarget', { url: 'https://a.example' })
    expect(h.created).toEqual(['', 'https://a.example'])
    await h.call('Target.activateTarget', { targetId: 'tab-2' })
    await h.call('Target.closeTarget', { targetId: 'tab-2' })
    expect(h.activated).toEqual(['tab-2'])
    expect(h.closed).toEqual(['tab-2'])
  })

  it('最後の session を外すか接続が閉じたら debugger を外す。2つの接続が同じタブにつなげる', async () => {
    const h = setup()
    const other = h.router.connect(() => undefined)
    const a = (await h.call('Target.attachToTarget', { targetId: 'tab-1' })).result as { sessionId: string }
    await other.handle(JSON.stringify({ id: 1, method: 'Target.attachToTarget', params: { targetId: 'tab-1' } }))
    const dbg = h.tabs[0]!.contents.debugger
    expect(dbg.attached).toBe(true)
    await h.call('Target.detachFromTarget', { sessionId: a.sessionId })
    expect(dbg.attached).toBe(true)
    other.close()
    expect(dbg.attached).toBe(false)
    expect(h.router.attachedCount()).toBe(0)
  })

  it('タブが閉じた・開発者ツールが debugger を取った ら、つないでいた側に detached を知らせる', async () => {
    const h = setup()
    const { sessionId } = (await h.call('Target.attachToTarget', { targetId: 'tab-1' })).result as { sessionId: string }
    h.tabs[0]!.contents.destroy()
    expect(h.out.filter((m) => m.method === 'Target.detachedFromTarget' || m.method === 'Target.targetDestroyed').map((m) => m.method)).toEqual(['Target.detachedFromTarget', 'Target.targetDestroyed'])
    expect((await h.call('Runtime.evaluate', {}, sessionId)).error).toBeDefined()
    const h2 = setup()
    await h2.call('Target.attachToTarget', { targetId: 'tab-1' })
    h2.tabs[0]!.contents.debugger.emit('detach', {}, 'canceled_by_user')
    expect(h2.out.some((m) => m.method === 'Target.detachedFromTarget')).toBe(true)
  })

  it('setDiscoverTargets: 今あるタブ・増えたタブ・URL の変化・閉じたタブを知らせる', async () => {
    const h = setup()
    await h.call('Target.setDiscoverTargets', { discover: true })
    await Promise.resolve()
    expect(h.out.filter((m) => m.method === 'Target.targetCreated')).toHaveLength(1)
    await h.call('Target.createTarget', { url: 'https://b.example' })
    h.changed()
    h.tabs[0]!.contents.url = 'https://example.com/next'
    h.changed()
    h.tabs[1]!.contents.destroyed = true
    h.changed()
    expect(h.out.filter((m) => typeof m.method === 'string' && m.method.startsWith('Target.target')).map((m) => m.method)).toEqual(['Target.targetCreated', 'Target.targetCreated', 'Target.targetInfoChanged', 'Target.targetDestroyed'])
  })

  it('setAutoAttach（flatten）: 今あるタブにも、あとで開いたタブにも自分でつないで attachedToTarget を送る', async () => {
    const h = setup()
    await h.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    await Promise.resolve()
    await h.call('Target.createTarget', { url: 'https://b.example' })
    h.changed()
    const attached = h.out.filter((m) => m.method === 'Target.attachedToTarget').map((m) => (m.params as { targetInfo: { targetId: string } }).targetInfo.targetId)
    expect(attached).toEqual(['tab-1', 'tab-2'])
    expect(h.tabs.every((t) => t.contents.debugger.attached)).toBe(true)
  })

  it('最後の接続が閉じたら、タブの変化の知らせを外す', () => {
    const h = setup()
    expect(h.listeners.size).toBe(1)
    h.conn.close()
    expect(h.listeners.size).toBe(0)
  })

  it('Cookie（Storage.*）は内蔵ブラウザのセッションへ。ダウンロード・権限の命令は受け付けるだけ', async () => {
    const h = setup()
    expect((await h.call('Storage.getCookies')).result?.cookies).toHaveLength(1)
    await h.call('Storage.setCookies', { cookies: [{ name: 'a', value: 'b', domain: 'x.example', path: '/' }] })
    expect(h.jar).toHaveLength(2)
    await h.call('Storage.clearCookies')
    expect(h.jar).toHaveLength(0)
    for (const m of ['Browser.setDownloadBehavior', 'Browser.grantPermissions']) expect((await h.call(m, {})).result).toEqual({})
  })

  it('ほかがつないでいるタブ（開発者ツール）にはつなげない', async () => {
    const h = setup()
    h.tabs[0]!.contents.debugger.failAttach = true
    expect((await h.call('Target.attachToTarget', { targetId: 'tab-1' })).error?.message).toContain('already being debugged')
  })
})

describe('BrowserCdpServer（127.0.0.1 の口）', () => {
  let server: BrowserCdpServer | null = null
  afterEach(async () => { await server?.stop(); server = null })

  const get = (port: number, path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })

  it('合言葉付きの /json/version から WebSocket へつながり、CDP が通る（browser-use の BU_CDP_URL と同じ手順）', async () => {
    const h = setup()
    server = new BrowserCdpServer({ tabs: () => h.tabs, createTab: async () => 'x', closeTab: () => {}, activateTab: () => {} }, 'secret-token')
    const url = await server.start()
    const port = server.listeningPort()
    expect(url).toBe(`http://127.0.0.1:${port}/secret-token`)
    const version = await get(port, '/secret-token/json/version')
    expect(version.status).toBe(200)
    const ws = new WebSocket((JSON.parse(version.body) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    const reply = new Promise<Record<string, unknown>>((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()))))
    ws.send(JSON.stringify({ id: 7, method: 'Target.getTargets' }))
    expect(await reply).toMatchObject({ id: 7, result: { targetInfos: [{ targetId: 'tab-1' }] } })
    ws.close()
    expect(JSON.parse((await get(port, '/secret-token/json/list')).body)).toEqual([{ id: 'tab-1', type: 'page', title: 'Example', url: 'https://example.com' }])
  })

  it('合言葉が違う・無い、Web ページ（Origin あり）、別の Host（DNS rebinding）は断る', async () => {
    server = new BrowserCdpServer({ tabs: () => [], createTab: async () => 'x', closeTab: () => {}, activateTab: () => {} }, 'secret-token')
    await server.start()
    const port = server.listeningPort()
    expect((await get(port, '/wrong-token/json/version')).status).toBe(403)
    expect((await get(port, '/json/version')).status).toBe(403)
    expect((await get(port, '/secret-tokenX/json/version')).status).toBe(403)
    expect((await get(port, '/secret-token/json/version', { Origin: 'https://evil.example' })).status).toBe(403)
    expect((await get(port, '/secret-token/json/version', { Host: `evil.example:${port}` })).status).toBe(403)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/secret-token/devtools/browser/ferret`, { headers: { Origin: 'https://evil.example' } })
    await expect(new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })).rejects.toThrow()
  })

  it('前の番号が使えなければ空いている番号で待ち受ける', async () => {
    const first = new BrowserCdpServer({ tabs: () => [], createTab: async () => 'x', closeTab: () => {}, activateTab: () => {} })
    await first.start()
    server = new BrowserCdpServer({ tabs: () => [], createTab: async () => 'x', closeTab: () => {}, activateTab: () => {} })
    await server.start(first.listeningPort())
    expect(server.listeningPort()).not.toBe(first.listeningPort())
    await first.stop()
  })
})
