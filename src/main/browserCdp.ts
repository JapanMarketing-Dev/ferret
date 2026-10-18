import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'

/**
 * 内蔵ブラウザを外の自動操作（browser-use など CDP を話すもの）から動かすための、CDP の中継（127.0.0.1 だけ）。
 *
 * Electron の remote-debugging-port は使わない。あれはアプリの画面（設定・送信の許可を持つ renderer）まで外に出してしまう。
 * ここでは「内蔵ブラウザのタブ」だけを Chrome のページの target に見せ、タブごとに webContents.debugger をつなぐ:
 *
 *   GET  /<合言葉>/json/version            → webSocketDebuggerUrl（下の WebSocket）
 *   GET  /<合言葉>/json/list               → 開いているタブ
 *   WS   /<合言葉>/devtools/browser/ferret → ブラウザの CDP（Target.* は中継が答え、sessionId 付きはそのタブの debugger へ）
 *
 * 合言葉は Ferret のターミナルの環境変数（BU_CDP_URL）でだけ渡す。Host が 127.0.0.1/localhost でない（DNS rebinding）・
 * Origin がある（Web ページからの接続）ものは断る。ブラウザ全体に効く命令（Browser.*・SystemInfo.* など）はタブへ通さない。
 */

/** webContents.debugger のうち使うもの（テストで差し替える） */
export interface DebuggerLike {
  attach(protocolVersion?: string): void
  detach(): void
  isAttached(): boolean
  sendCommand(method: string, params?: object): Promise<unknown>
  // Electron の Debugger と EventEmitter の両方を受けられるよう、受け口の型はゆるくする（中身は message・detach だけ）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: 'message' | 'detach', listener: (...args: any[]) => void): unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeListener(event: 'message' | 'detach', listener: (...args: any[]) => void): unknown
}

export interface ContentsLike {
  readonly debugger: DebuggerLike
  getURL(): string
  getTitle(): string
  isDestroyed(): boolean
  once(event: 'destroyed', listener: () => void): unknown
}

export interface CdpTab {
  id: string
  contents: ContentsLike
}

/** CDP の Cookie の形（Storage.getCookies・Network.Cookie） */
export interface CdpCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  size: number
  httpOnly: boolean
  secure: boolean
  session: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

export interface BrowserCdpDeps {
  /** 内蔵ブラウザの今のタブ（閉じたものは入れない） */
  tabs(): CdpTab[]
  /** タブが増えた・減った・URL や題名が変わった（Target.setDiscoverTargets・setAutoAttach の知らせに使う）。外す関数を返す */
  onTabsChanged?(listener: () => void): () => void
  /** 内蔵ブラウザのセッションの Cookie（Storage.getCookies / setCookies / clearCookies） */
  cookies?: {
    get(): Promise<CdpCookie[]>
    set(cookies: CdpCookie[]): Promise<void>
    clear(): Promise<void>
  }
  /** 新しいタブを開いて前に出す（'' は空のタブ）。タブの id を返す */
  createTab(url: string): Promise<string>
  closeTab(id: string): void
  activateTab(id: string): void
  /** 外の自動操作がタブにつないだ（利用者に知らせる・隠れていても描画できるようにする） */
  onAttach?(tabId: string): void
  /** つないでいた全員が外れた（隠しておく大きさを戻す） */
  onRelease?(tabId: string): void
  /** browser-use の Agent（API で動かす）の LLM の中継（browserLlmRelay.ts）。無ければ /llm は 404 */
  llm?: { handle(path: string, req: IncomingMessage, res: ServerResponse): Promise<void> }
  /** Page.captureScreenshot の代わり（画面に出ていないタブも撮る）。base64 を返す */
  capture?(tabId: string, params: { format?: 'png' | 'jpeg'; quality?: number; clip?: { x: number; y: number; width: number; height: number } }): Promise<string>
}

/** タブへ通さない命令（ブラウザ全体・端末に効くもの。Target.* は中継が答える） */
const BLOCKED_PREFIXES = ['Browser.', 'Target.', 'SystemInfo.', 'Tethering.', 'Tracing.', 'Memory.', 'HeapProfiler.']

export const BROWSER_TARGET_ID = 'ferret-browser'

interface Session {
  id: string
  tabId: string
  contents: ContentsLike
  client: Client
}

interface Attachment {
  tabId: string
  sessions: Set<Session>
  onMessage: (event: unknown, method: string, params: unknown, sessionId?: string) => void
  onDetach: (event: unknown, reason: string) => void
}

interface Client {
  send(message: object): void
  sessions: Set<Session>
  /** Target.setDiscoverTargets で、タブの出入りを知らせる */
  discover: boolean
  /** Target.setAutoAttach で、新しいタブにも自分でつなぐ（flatten） */
  autoAttach: boolean
  /** 知らせ済みのタブ（id → 最後に知らせた url と題名） */
  known: Map<string, string>
}

interface CdpMessage {
  id?: unknown
  method?: unknown
  params?: unknown
  sessionId?: unknown
}

const cdpError = (code: number, message: string) => ({ code, message })

/** CDP の取り次ぎ（HTTP・WebSocket と切り離した中身。単体テストはここを直接たたく） */
export class CdpRouter {
  private readonly attachments = new Map<ContentsLike, Attachment>()
  private readonly sessions = new Map<string, Session>()

  private readonly clients = new Set<Client>()
  private unsubscribe: (() => void) | null = null

  constructor(private readonly deps: BrowserCdpDeps) {}

  /** 接続を1つ作る。閉じたら close() を呼ぶ */
  connect(send: (message: object) => void): { handle: (raw: string) => Promise<void>; close: () => void } {
    const client: Client = { send, sessions: new Set(), discover: false, autoAttach: false, known: new Map() }
    this.clients.add(client)
    if (!this.unsubscribe && this.deps.onTabsChanged) this.unsubscribe = this.deps.onTabsChanged(() => this.tabsChanged())
    return {
      handle: (raw) => this.handle(client, raw),
      close: () => {
        this.clients.delete(client)
        for (const session of [...client.sessions]) this.release(session, false)
        if (this.clients.size === 0 && this.unsubscribe) {
          this.unsubscribe()
          this.unsubscribe = null
        }
      }
    }
  }

  /** タブの出入りを、知らせを望んだ接続へ。新しいタブは自動でつなぐ接続にはつなぐ */
  private tabsChanged(): void {
    for (const client of this.clients) this.syncClient(client)
  }

  private syncClient(client: Client): void {
    if (!client.discover && !client.autoAttach) return
    const tabs = this.deps.tabs().filter((tab) => !tab.contents.isDestroyed())
    const ids = new Set(tabs.map((tab) => tab.id))
    for (const tab of tabs) {
      const info = this.targetInfo(tab)
      const key = `${info.url}\n${info.title}`
      const before = client.known.get(tab.id)
      if (before === undefined) {
        client.known.set(tab.id, key)
        if (client.discover) client.send({ method: 'Target.targetCreated', params: { targetInfo: info } })
        if (client.autoAttach && ![...client.sessions].some((s) => s.tabId === tab.id)) {
          try {
            const session = this.attach(client, tab)
            client.send({ method: 'Target.attachedToTarget', params: { sessionId: session.id, targetInfo: this.targetInfo(tab), waitingForDebugger: false } })
          } catch {
            /* 開発者ツールが使っているタブ（つながずに一覧にだけ出す） */
          }
        }
      } else if (before !== key) {
        client.known.set(tab.id, key)
        if (client.discover) client.send({ method: 'Target.targetInfoChanged', params: { targetInfo: info } })
      }
    }
    for (const id of [...client.known.keys()]) {
      if (ids.has(id)) continue
      client.known.delete(id)
      if (client.discover) client.send({ method: 'Target.targetDestroyed', params: { targetId: id } })
    }
  }

  private targetInfo(tab: CdpTab) {
    const attached = [...this.sessions.values()].some((s) => s.tabId === tab.id)
    return { targetId: tab.id, type: 'page', title: tab.contents.getTitle(), url: tab.contents.getURL() || 'about:blank', attached, canAccessOpener: false, browserContextId: 'ferret' }
  }

  private findTab(id: unknown): CdpTab | undefined {
    return typeof id === 'string' ? this.deps.tabs().find((tab) => tab.id === id && !tab.contents.isDestroyed()) : undefined
  }

  private async handle(client: Client, raw: string): Promise<void> {
    let msg: CdpMessage
    try {
      msg = JSON.parse(raw) as CdpMessage
    } catch {
      return
    }
    if (typeof msg.id !== 'number' || typeof msg.method !== 'string') return
    const id = msg.id
    const method = msg.method
    const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>
    const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : undefined
    const reply = (body: { result?: unknown; error?: unknown }) => client.send({ id, ...body, ...(sessionId ? { sessionId } : {}) })
    try {
      if (sessionId && !method.startsWith('Target.')) {
        const session = this.sessions.get(sessionId)
        if (!session || session.client !== client) return reply({ error: cdpError(-32001, `Session with given id not found.`) })
        if (BLOCKED_PREFIXES.some((p) => method.startsWith(p))) return reply({ error: cdpError(-32601, `'${method}' is not available in Ferret's built-in browser`) })
        if (session.contents.isDestroyed()) return reply({ error: cdpError(-32000, 'Target closed') })
        // 画面に出ていないタブは CDP のスクリーンショットが返らないので、Electron の撮影で答える
        if (method === 'Page.captureScreenshot' && this.deps.capture) {
          const format = params.format === 'jpeg' ? 'jpeg' : 'png'
          const clip = params.clip as { x: number; y: number; width: number; height: number } | undefined
          const data = await this.deps.capture(session.tabId, { format, ...(typeof params.quality === 'number' ? { quality: params.quality } : {}), ...(clip ? { clip } : {}) })
          return reply({ result: { data } })
        }
        const result = await session.contents.debugger.sendCommand(method, params)
        return reply({ result: result ?? {} })
      }
      return reply({ result: await this.browserCommand(client, method, params) })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      reply({ error: cdpError(-32000, message) })
    }
  }

  private async browserCommand(client: Client, method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'Browser.getVersion':
        return { protocolVersion: '1.3', product: 'Ferret/BuiltInBrowser', revision: '', userAgent: '', jsVersion: '' }
      case 'Target.getTargets':
        return { targetInfos: this.deps.tabs().filter((tab) => !tab.contents.isDestroyed()).map((tab) => this.targetInfo(tab)) }
      case 'Target.getTargetInfo': {
        if (params.targetId === undefined) return { targetInfo: { targetId: BROWSER_TARGET_ID, type: 'browser', title: '', url: '', attached: true, canAccessOpener: false } }
        const tab = this.findTab(params.targetId)
        if (!tab) throw new Error('No target with given id found')
        return { targetInfo: this.targetInfo(tab) }
      }
      case 'Target.createTarget': {
        const url = typeof params.url === 'string' && params.url !== 'about:blank' ? params.url : ''
        return { targetId: await this.deps.createTab(url) }
      }
      case 'Target.closeTarget': {
        const tab = this.findTab(params.targetId)
        if (!tab) throw new Error('No target with given id found')
        this.deps.closeTab(tab.id)
        return { success: true }
      }
      case 'Target.activateTarget': {
        const tab = this.findTab(params.targetId)
        if (!tab) throw new Error('No target with given id found')
        this.deps.activateTab(tab.id)
        return {}
      }
      case 'Target.attachToTarget': {
        const tab = this.findTab(params.targetId)
        if (!tab) throw new Error('No target with given id found')
        const session = this.attach(client, tab)
        client.send({ method: 'Target.attachedToTarget', params: { sessionId: session.id, targetInfo: this.targetInfo(tab), waitingForDebugger: false } })
        return { sessionId: session.id }
      }
      case 'Target.detachFromTarget': {
        const session = typeof params.sessionId === 'string' ? this.sessions.get(params.sessionId) : undefined
        if (!session || session.client !== client) throw new Error('No session with given id')
        this.release(session, true)
        return {}
      }
      case 'Target.setDiscoverTargets':
        client.discover = params.discover === true
        if (!client.discover && !client.autoAttach) client.known.clear()
        queueMicrotask(() => this.syncClient(client))
        return {}
      case 'Target.setAutoAttach':
        client.autoAttach = params.autoAttach === true
        if (!client.discover && !client.autoAttach) client.known.clear()
        // すでに知らせ済みのタブも、自動でつなぐ接続にはつなぐ
        if (client.autoAttach) client.known.clear()
        queueMicrotask(() => this.syncClient(client))
        return {}
      case 'Target.setRemoteLocations':
      case 'Browser.setDownloadBehavior':
      case 'Browser.grantPermissions':
      case 'Browser.resetPermissions':
        return {}
      case 'Storage.getCookies':
        return { cookies: (await this.deps.cookies?.get()) ?? [] }
      case 'Storage.setCookies':
        await this.deps.cookies?.set(Array.isArray(params.cookies) ? params.cookies as CdpCookie[] : [])
        return {}
      case 'Storage.clearCookies':
        await this.deps.cookies?.clear()
        return {}
      default: {
        const err = new Error(`'${method}' wasn't found`) as Error & { code?: number }
        throw err
      }
    }
  }

  private attach(client: Client, tab: CdpTab): Session {
    const contents = tab.contents
    let attachment = this.attachments.get(contents)
    if (!attachment) {
      if (!contents.debugger.isAttached()) {
        try {
          contents.debugger.attach('1.3')
        } catch {
          throw new Error('This tab is already being debugged (close DevTools for it and retry)')
        }
      }
      const created: Attachment = {
        tabId: tab.id,
        sessions: new Set(),
        // タブの debugger の出来事を、そのタブにつないだ全員へ（子の session の出来事は渡さない）
        onMessage: (_event, method, params, childSession) => {
          if (childSession) return
          for (const s of created.sessions) s.client.send({ method, params, sessionId: s.id })
        },
        onDetach: () => this.dropContents(contents, false)
      }
      contents.debugger.on('message', created.onMessage)
      contents.debugger.on('detach', created.onDetach)
      contents.once('destroyed', () => this.dropContents(contents, true))
      attachment = created
      this.attachments.set(contents, attachment)
      this.deps.onAttach?.(tab.id)
    }
    const session: Session = { id: randomBytes(16).toString('hex').toUpperCase(), tabId: tab.id, contents, client }
    attachment.sessions.add(session)
    client.sessions.add(session)
    this.sessions.set(session.id, session)
    return session
  }

  /** つないだ session を外す。誰も使わなくなったら debugger も外す */
  private release(session: Session, notify: boolean): void {
    this.sessions.delete(session.id)
    session.client.sessions.delete(session)
    if (notify) session.client.send({ method: 'Target.detachedFromTarget', params: { sessionId: session.id, targetId: session.tabId } })
    const attachment = this.attachments.get(session.contents)
    if (!attachment) return
    attachment.sessions.delete(session)
    if (attachment.sessions.size === 0) this.unhook(session.contents, attachment, true)
  }

  /** タブが閉じた・debugger が外れた（開発者ツールを開いた等）。つないでいた全員に知らせる */
  private dropContents(contents: ContentsLike, destroyed: boolean): void {
    const attachment = this.attachments.get(contents)
    if (!attachment) return
    for (const session of [...attachment.sessions]) {
      this.sessions.delete(session.id)
      session.client.sessions.delete(session)
      session.client.send({ method: 'Target.detachedFromTarget', params: { sessionId: session.id, targetId: session.tabId } })
      if (destroyed) session.client.send({ method: 'Target.targetDestroyed', params: { targetId: session.tabId } })
    }
    attachment.sessions.clear()
    this.unhook(contents, attachment, !destroyed)
  }

  private unhook(contents: ContentsLike, attachment: Attachment, detach: boolean): void {
    this.attachments.delete(contents)
    this.deps.onRelease?.(attachment.tabId)
    contents.debugger.removeListener('message', attachment.onMessage)
    contents.debugger.removeListener('detach', attachment.onDetach)
    if (detach && !contents.isDestroyed()) {
      try {
        if (contents.debugger.isAttached()) contents.debugger.detach()
      } catch {
        /* もう外れている（想定内） */
      }
    }
  }

  /** つないでいるタブの数（テスト・状態の表示用） */
  attachedCount(): number {
    return this.attachments.size
  }
}

const sameSecret = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

/** 127.0.0.1 で待ち受ける HTTP・WebSocket の口 */
export class BrowserCdpServer {
  private server: Server | null = null
  private wss: WebSocketServer | null = null
  private port = 0
  readonly router: CdpRouter

  constructor(private readonly deps: BrowserCdpDeps, readonly token: string = randomBytes(24).toString('hex')) {
    this.router = new CdpRouter(deps)
  }

  /** 待ち受けを始める（preferredPort が使えればそれ、だめなら空いている番号）。BU_CDP_URL に入れる URL を返す */
  async start(preferredPort = 0): Promise<string> {
    if (this.server) return this.url()
    const server = createServer((req, res) => this.onHttp(req, res))
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 })
    server.on('upgrade', (req, socket, head) => {
      if (!this.allowed(req) || this.pathOf(req) !== `/devtools/browser/ferret`) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws))
    })
    const listen = (port: number) => new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err)
      server.once('error', onError)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError)
        resolve()
      })
    })
    try {
      await listen(preferredPort)
    } catch (err) {
      if (preferredPort === 0) throw err
      await listen(0)
    }
    this.port = (server.address() as AddressInfo).port
    this.server = server
    this.wss = wss
    return this.url()
  }

  url(): string {
    return `http://127.0.0.1:${this.port}/${this.token}`
  }

  listeningPort(): number {
    return this.port
  }

  async stop(): Promise<void> {
    for (const ws of this.wss?.clients ?? []) ws.terminate()
    this.wss?.close()
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
    this.server = null
    this.wss = null
  }

  /** 合言葉・Host・Origin を確かめる */
  private allowed(req: IncomingMessage): boolean {
    if (req.headers.origin) return false
    const host = req.headers.host ?? ''
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return false
    const path = (req.url ?? '').split('?')[0] ?? ''
    const prefix = `/${this.token}`
    const head = path.slice(0, prefix.length)
    return head.length === prefix.length && sameSecret(head, prefix) && (path.length === prefix.length || path[prefix.length] === '/')
  }

  private pathOf(req: IncomingMessage): string {
    return ((req.url ?? '').split('?')[0] ?? '').slice(this.token.length + 1) || '/'
  }

  private onHttp(req: IncomingMessage, res: ServerResponse): void {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (!this.allowed(req)) return json(403, { error: 'forbidden' })
    const path = this.pathOf(req).replace(/\/+$/, '')
    if (path.startsWith('/llm/') || path === '/llm') {
      if (!this.deps.llm) return json(404, { error: 'not found' })
      void this.deps.llm.handle(path, req, res).catch(() => json(500, { error: 'relay failed' }))
      return
    }
    if (req.method !== 'GET') return json(405, { error: 'method not allowed' })
    const ws = `ws://127.0.0.1:${this.port}/${this.token}/devtools/browser/ferret`
    if (path === '/json/version') {
      return json(200, { Browser: 'Ferret/BuiltInBrowser', 'Protocol-Version': '1.3', 'User-Agent': '', 'V8-Version': '', 'WebKit-Version': '', webSocketDebuggerUrl: ws })
    }
    if (path === '/json' || path === '/json/list') {
      return json(200, this.deps.tabs().filter((tab) => !tab.contents.isDestroyed()).map((tab) => ({ id: tab.id, type: 'page', title: tab.contents.getTitle(), url: tab.contents.getURL() || 'about:blank' })))
    }
    json(404, { error: 'not found' })
  }

  private onSocket(ws: WebSocket): void {
    const conn = this.router.connect((message) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message))
    })
    ws.on('message', (data) => void conn.handle(data.toString()))
    ws.on('close', () => conn.close())
    ws.on('error', () => conn.close())
  }
}
