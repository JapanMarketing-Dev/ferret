/**
 * スマホから操作（Mobile remote）。同じ Wi‑Fi・Tailscale のスマホのブラウザから、開いているターミナルの画面を見て、
 * Agent に指示やキーを送る HTTP の口（node:http。依存は増やさない）。既定は閉じていて、設定で入れたときだけ開く。
 *
 * - 合言葉（256 ビット）は設定フォルダの mobile-remote-token に所有者だけが読める形で置く（再起動してもブックマークが使える）。
 *   「リンクを作り直す」で取り替えると、古いスマホは次の要求から 401 になる。合言葉はログ・エラー・Sentry に出さない
 * - 守りの決まり（Host・合言葉・回数の制限・本文の上限・キーの許可リスト）は @shared/mobileRemote の純粋な関数
 * - ここは electron を読まない（単体・結合テストで偽のターミナルを渡して確かめる）。つなぐのは src/main/index.ts
 *
 * 平文の HTTP なので、同じ Wi‑Fi の他人が通信を盗み見られる場所（公衆 Wi‑Fi など）では使わない前提（設定の画面で伝える）。
 * Tailscale 越しなら WireGuard で暗号化される。
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import { dirname } from 'node:path'
import { encodeQr, qrSvgPath } from '@shared/qrCode'
import {
  FailureLimiter,
  MOBILE_REMOTE_MAX_BODY_BYTES,
  MOBILE_REMOTE_TOKEN_BYTES,
  REMOTE_KEYS,
  bearerToken,
  cleanScreenText,
  isAllowedHost,
  isSameOrigin,
  isWellFormedToken,
  normalizeAgentState,
  parseKeyBody,
  parseSendBody,
  projectNameFor,
  reachableIPv4s,
  remotePort,
  remoteUrls,
  routeRequest,
  tokenFromBytes,
  tokensEqual,
  type MobileRemoteError,
  type MobileRemotePrefs,
  type MobileRemoteState,
  type NetInterfaceInfo,
  type RemoteTerminalSummary
} from '@shared/mobileRemote'
import type { TuiAgent } from '@shared/types'
import { writePrivateFileAtomicSync } from './atomicFile'
import { REMOTE_PAGE_CSS, REMOTE_PAGE_ICON, REMOTE_PAGE_JS, remotePageHtml, type RemotePageLocale } from './mobileRemotePage'

/** TerminalManager のうち、スマホから使う所だけ（結合テストで偽物に差し替える） */
export interface RemoteTerminalSource {
  list(): ReadonlyArray<{ id: string; cwd: string; title: string; agent: TuiAgent | null }>
  screenText(id: string): string
  agentStates(ids: readonly string[]): Promise<ReadonlyArray<{ kind: string; state: string; agent: TuiAgent | null }>>
  sendReview(id: string, text: string): Promise<{ ok: boolean; message: string; submitted?: boolean }>
  write(id: string, data: string): void
}

/** human.md の「人が確認すること」の1件（読むだけ。@shared/humanChecklist の ChecklistItem の一部） */
export interface RemoteChecklistItem {
  key: string
  label: string
  url: string
  note: string
  answer?: string
}

export interface RemoteServerDeps {
  terminals: () => RemoteTerminalSource | null
  /** 今の合言葉（要求のたびに読む。取り替えたら次の要求から効く） */
  token: () => string
  projects: () => ReadonlyArray<{ name: string; folderPath: string }>
  agentLabel: (agent: TuiAgent) => string
  locale: () => RemotePageLocale
  /** オーケストラの human.md。無ければ空 */
  checklist?: () => Promise<readonly RemoteChecklistItem[]>
  /** 予期しない失敗（Sentry へ。URL・合言葉・本文は渡さない） */
  onError?: (err: unknown, op: string) => void
  /** 合言葉の誤りの制限（テストで縮める） */
  limiter?: { maxFailures: number; windowMs: number }
}

/** 既定の制限: 5 分のうちに 10 回まちがえたら、その 5 分が過ぎるまで断る */
export const REMOTE_AUTH_LIMIT = { maxFailures: 10, windowMs: 5 * 60_000 }

/** 一覧に出すターミナルの上限 */
const MAX_TERMINALS = 200
/** human.md の項目の上限 */
const MAX_CHECKLIST = 200

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

/** すべての応答に付けるヘッダー。CORS のヘッダーは付けない（ほかのサイトの JS からは読めない） */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CSP,
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
  }
}

/** 本文を上限つきで読む。超えたら 413、JSON でなければ 400 */
function readJsonBody(req: IncomingMessage, max: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > max) {
      reject(new HttpError(413, 'tooLarge'))
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      if (size > max) {
        done = true
        reject(new HttpError(413, 'tooLarge'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new HttpError(400, 'invalidJson'))
      }
    })
    req.on('error', () => {
      if (done) return
      done = true
      reject(new HttpError(400, 'aborted'))
    })
  })
}

export class MobileRemoteServer {
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()
  private readonly limiter: FailureLimiter

  constructor(private readonly deps: RemoteServerDeps, now: () => number = Date.now) {
    this.limiter = new FailureLimiter({ ...(deps.limiter ?? REMOTE_AUTH_LIMIT), maxEntries: 1000 }, now)
  }

  /** 待ち受けているポート。閉じていれば null */
  get port(): number | null {
    const address = this.server?.address()
    return address && typeof address === 'object' ? (address as AddressInfo).port : null
  }

  /** 待ち受けを始める。開けなければ errno の code（EADDRINUSE など）付きの Error で reject */
  async start(port: number, host = '0.0.0.0'): Promise<void> {
    if (this.server) await this.stop()
    const server = createServer((req, res) => void this.handle(req, res))
    // 遅い相手・途中で止まる相手にいつまでも付き合わない
    server.headersTimeout = 10_000
    server.requestTimeout = 15_000
    server.keepAliveTimeout = 5_000
    server.maxHeadersCount = 50
    server.maxConnections = 64
    server.on('connection', (socket: Socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })
    // 壊れた要求（ヘッダーの誤りなど）は 400 で閉じる。内容はログに出さない
    server.on('clientError', (_err, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      else socket.destroy()
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => { server.off('listening', onListening); reject(err) }
      const onListening = () => { server.off('error', onError); resolve() }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen({ port, host, exclusive: true })
    })
    server.on('error', (err) => this.deps.onError?.(err, 'server error'))
    this.server = server
  }

  /** 閉じる。つながったままの接続（keep-alive）も切るので、すぐにポートが空く */
  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    server.closeAllConnections?.()
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    await closed
  }

  private send(res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}, head = false): void {
    if (res.headersSent) return
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': String(Buffer.byteLength(body)), ...extra })
    res.end(head ? undefined : body)
  }

  private json(res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
    this.send(res, status, JSON.stringify(value), 'application/json; charset=utf-8', extra)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.route(req, res)
    } catch (err) {
      if (err instanceof HttpError) {
        // 本文が大きすぎるときは読み残しがあるので、応答のあと接続を閉じる
        const close: Record<string, string> = err.status === 413 ? { Connection: 'close' } : {}
        this.json(res, err.status, { error: err.code }, close)
        if (err.status === 413) req.resume()
        return
      }
      this.deps.onError?.(err, 'handle request')
      this.json(res, 500, { error: 'internal' })
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS rebinding の対策。IP・localhost・*.ts.net 以外の Host は、どの道でも断る
    if (!isAllowedHost(req.headers.host)) return this.json(res, 403, { error: 'host' })
    const route = routeRequest(req.method, req.url)
    if ('error' in route) return this.json(res, route.error, { error: route.error === 404 ? 'notFound' : 'method' }, route.error === 405 ? { Allow: 'GET, POST' } : {})
    const head = req.method === 'HEAD'
    if (route.kind === 'page') return this.send(res, 200, remotePageHtml(this.deps.locale()), 'text/html; charset=utf-8', {}, head)
    if (route.kind === 'asset') {
      if (route.name === 'app.js') return this.send(res, 200, REMOTE_PAGE_JS, 'text/javascript; charset=utf-8', {}, head)
      if (route.name === 'app.css') return this.send(res, 200, REMOTE_PAGE_CSS, 'text/css; charset=utf-8', {}, head)
      return this.send(res, 200, REMOTE_PAGE_ICON, 'image/svg+xml', {}, head)
    }

    // ここから API。合言葉の誤りが続いた相手は、正しい合言葉でもしばらく断る（総当たりを続けさせない）
    const ip = req.socket.remoteAddress ?? 'unknown'
    const wait = this.limiter.blockedFor(ip)
    if (wait > 0) return this.json(res, 429, { error: 'tooManyAttempts' }, { 'Retry-After': String(Math.ceil(wait / 1000)) })
    const given = bearerToken(req.headers.authorization)
    if (!given || !tokensEqual(given, this.deps.token())) {
      this.limiter.fail(ip)
      return this.json(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' })
    }
    this.limiter.succeed(ip)
    if (req.method === 'POST') {
      if (!isSameOrigin(req.headers.origin, req.headers.host)) return this.json(res, 403, { error: 'origin' })
      const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
      if (type !== 'application/json') return this.json(res, 415, { error: 'contentType' })
    }

    const terminals = this.deps.terminals()
    if (route.kind === 'checklist') {
      const items = (await this.deps.checklist?.().catch((err: unknown) => { this.deps.onError?.(err, 'read checklist'); return [] })) ?? []
      return this.json(res, 200, { items: items.slice(0, MAX_CHECKLIST).map(({ key, label, url, note, answer }) => ({ key, label, url, note, ...(answer ? { answer } : {}) })) })
    }
    if (!terminals) return this.json(res, 503, { error: 'notReady' })
    if (route.kind === 'terminals') return this.json(res, 200, { terminals: await this.summaries(terminals) })

    const info = terminals.list().find((t) => t.id === route.id)
    if (!info) {
      // 本文は読み捨てる（keep-alive の接続に残さない）
      req.resume()
      return this.json(res, 404, { error: 'noTerminal' })
    }
    if (route.kind === 'screen') {
      const [summary] = await this.summarize(terminals, [info])
      return this.json(res, 200, { ...summary, text: cleanScreenText(terminals.screenText(info.id)) })
    }
    const body = await readJsonBody(req, MOBILE_REMOTE_MAX_BODY_BYTES)
    if (route.kind === 'send') {
      const parsed = parseSendBody(body)
      if ('error' in parsed) return this.json(res, 400, { error: parsed.error })
      // 「Agentへ送信」と同じ送り方（確認待ちなら断る・作業中なら積む・Enter で確定。TerminalManager.sendReview）
      const result = await terminals.sendReview(info.id, parsed.text)
      return this.json(res, result.ok ? 200 : 409, { ok: result.ok, message: result.message, ...(result.submitted !== undefined ? { submitted: result.submitted } : {}) })
    }
    const parsed = parseKeyBody(body)
    if ('error' in parsed) return this.json(res, 400, { error: parsed.error })
    terminals.write(info.id, REMOTE_KEYS[parsed.key])
    return this.json(res, 200, { ok: true })
  }

  private async summaries(terminals: RemoteTerminalSource): Promise<RemoteTerminalSummary[]> {
    return this.summarize(terminals, terminals.list().slice(0, MAX_TERMINALS))
  }

  private async summarize(terminals: RemoteTerminalSource, list: ReadonlyArray<{ id: string; cwd: string; title: string; agent: TuiAgent | null }>): Promise<RemoteTerminalSummary[]> {
    const states = await terminals.agentStates(list.map((t) => t.id)).catch((err: unknown) => { this.deps.onError?.(err, 'agent states'); return [] })
    const projects = this.deps.projects()
    return list.map((t, i) => {
      const s = states[i]
      const agent = s?.agent ?? null
      return { id: t.id, title: t.title, project: projectNameFor(t.cwd, projects), agent: agent ? this.deps.agentLabel(agent) : '', state: normalizeAgentState(s?.state ?? 'unknown') }
    })
  }
}

/** 開けなかった理由を画面の分類へ */
export function listenErrorKind(err: unknown): MobileRemoteError {
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'EADDRINUSE') return 'portInUse'
  if (code === 'EACCES' || code === 'EPERM') return 'permission'
  return 'failed'
}

export interface MobileRemoteServiceOptions {
  /** 合言葉を置くファイル（所有者だけが読める） */
  tokenFile: string
  deps: Omit<RemoteServerDeps, 'token'>
  interfaces?: () => Record<string, readonly NetInterfaceInfo[] | undefined>
  random?: (n: number) => Uint8Array
  /** 待ち受けの開始・停止・失敗のたびに呼ぶ（設定の画面へ知らせる） */
  onChange?: (state: MobileRemoteState) => void
  /** 待ち受ける所（テストは 127.0.0.1） */
  host?: string
}

/**
 * 設定（mobileRemote）に合わせてサーバーを開け閉めし、合言葉と画面に出す状態を持つ。
 * apply・resetToken・stop は順番に1つずつ行う（続けて切り替えても、開く・閉じるが入れ違わない）
 */
export class MobileRemoteService {
  private server: MobileRemoteServer | null = null
  private token: string | null = null
  private prefs: MobileRemotePrefs | undefined
  private error: MobileRemoteError | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private qrCache: { url: string; qr: MobileRemoteState['qr'] } | null = null

  constructor(private readonly opts: MobileRemoteServiceOptions) {}

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => undefined)
    return next
  }

  /** 保存してある合言葉。無い・壊れていれば作って保存する */
  private ensureToken(): string {
    if (this.token) return this.token
    try {
      const saved = readFileSync(this.opts.tokenFile, 'utf8').trim()
      if (isWellFormedToken(saved)) {
        this.token = saved
        return saved
      }
    } catch { /* 無い（初めて入れた）・読めないときは作り直す */ }
    return this.rotateToken()
  }

  private rotateToken(): string {
    const token = tokenFromBytes((this.opts.random ?? ((n) => new Uint8Array(randomBytes(n))))(MOBILE_REMOTE_TOKEN_BYTES))
    mkdirSync(dirname(this.opts.tokenFile), { recursive: true })
    writePrivateFileAtomicSync(this.opts.tokenFile, `${token}\n`)
    this.token = token
    return token
  }

  /** 画面に出す今の状態。IP はそのつど調べ直す（Wi‑Fi の切り替え・Tailscale の接続で変わる） */
  state(): MobileRemoteState {
    const enabled = this.prefs?.enabled === true
    const port = remotePort(this.prefs)
    const running = this.server?.port != null
    const addresses = running ? reachableIPv4s((this.opts.interfaces ?? networkInterfaces)()) : []
    const urls = running && this.token ? remoteUrls(addresses, port, this.token) : []
    return { enabled, port, running, urls, qr: this.qrFor(urls[0]), error: this.error }
  }

  private qrFor(url: string | undefined): MobileRemoteState['qr'] {
    if (!url) return null
    if (this.qrCache?.url === url) return this.qrCache.qr
    const code = encodeQr(url)
    const qr = { path: qrSvgPath(code, 4), size: code.size + 8 }
    this.qrCache = { url, qr }
    return qr
  }

  private emit(): MobileRemoteState {
    const state = this.state()
    this.opts.onChange?.(state)
    return state
  }

  /** 設定に合わせる（入れたら開く、ポートが変われば開き直す、切ったら閉じる） */
  apply(prefs: MobileRemotePrefs | undefined): Promise<MobileRemoteState> {
    return this.serial(async () => {
      this.prefs = prefs
      const port = remotePort(prefs)
      if (prefs?.enabled !== true) {
        await this.closeServer()
        this.error = null
        return this.emit()
      }
      if (this.server && this.server.port === port && !this.error) return this.emit()
      await this.closeServer()
      try {
        this.ensureToken()
      } catch (err) {
        // 合言葉を保存できない（設定フォルダに書けない）なら開かない
        this.opts.deps.onError?.(err, 'save token')
        this.error = 'failed'
        return this.emit()
      }
      const server = new MobileRemoteServer({ ...this.opts.deps, token: () => this.token ?? '' })
      try {
        await server.start(port, this.opts.host)
        this.server = server
        this.error = null
      } catch (err) {
        this.error = listenErrorKind(err)
        if (this.error === 'failed') this.opts.deps.onError?.(err, 'listen')
      }
      return this.emit()
    })
  }

  /** 合言葉を取り替える。今つながっているスマホは次の要求から 401 になる */
  resetToken(): Promise<MobileRemoteState> {
    return this.serial(async () => {
      this.rotateToken()
      this.qrCache = null
      return this.emit()
    })
  }

  /** 閉じる（アプリの終了）。設定は変えない */
  stop(): Promise<void> {
    return this.serial(() => this.closeServer())
  }

  private async closeServer(): Promise<void> {
    const server = this.server
    this.server = null
    await server?.stop()
  }
}
