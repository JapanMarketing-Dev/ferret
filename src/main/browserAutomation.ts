import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BROWSER_AGENT_PY, BROWSER_AGENT_SCRIPT, BROWSER_BIN_NAME, browserBinCmd, browserBinPosix } from './browserAgentScript'
import type { Cookie, Session, WebContents } from 'electron'
import { BROWSER_BIN_ENV, BROWSER_CDP_ENV, BU_CDP_ENV } from '@shared/browserAutomationEnv'
import { reportHandled } from '@shared/report'
import { BrowserCdpServer, type CdpCookie } from './browserCdp'
import { LlmRelay } from './browserLlmRelay'

/**
 * 内蔵ブラウザを browser-use で動かす口（browserCdp.ts の中継）を、Ferret のターミナルへ渡す。
 *
 * - 中継は最初のターミナルを開くときに 127.0.0.1 で起動する。番号と合言葉は userData に覚え、起動し直しても同じ URL にする
 *   （browser-use の常駐のプロセスが前の URL のまま残っても、つなぎ直せるように）。番号が使えなければ別の番号にする
 * - ターミナルには BU_CDP_URL（browser-use が読む）と FERRET_BROWSER_CDP_URL を入れる。Ferret の中で browser-use を
 *   実行すると、利用者の Chrome ではなく内蔵ブラウザが動く
 */


export interface BrowserAutomationDeps {
  configFile: string
  /** ferret-browser と Python の置き場（userData/browser-use） */
  toolDir: string
  tabs(): Array<{ id: string; contents: WebContents }>
  createTab(url: string): Promise<string>
  closeTab(id: string): void
  activateTab(id: string): void
  /** 自動操作がつないでいる間、画面に出ていなくても描画できる大きさで隠しておく */
  hold(id: string, held: boolean): void
  capture(id: string, params: { format?: 'png' | 'jpeg'; quality?: number; clip?: { x: number; y: number; width: number; height: number } }): Promise<string>
  onTabsChanged(listener: () => void): () => void
  session(): Session
  notice(message: string): void
  attachedMessage(): string
  /** 画面へ「エージェントが内蔵ブラウザを動かし始めた」を知らせる（エディタなら中央を内蔵ブラウザにする） */
  reveal(): void
  /** API で動かすときの LLM のキー（Ferret に保存したもの・設定の環境変数）。ターミナルには渡さない */
  llmKey(providerId: string): Promise<string | undefined>
}

interface Saved {
  port: number
  token: string
}

const SAME_SITE: Record<string, CdpCookie['sameSite']> = { strict: 'Strict', lax: 'Lax', no_restriction: 'None' }
const TO_ELECTRON: Record<string, Cookie['sameSite']> = { Strict: 'strict', Lax: 'lax', None: 'no_restriction' }

export function toCdpCookie(c: Cookie): CdpCookie {
  const sameSite = c.sameSite ? SAME_SITE[c.sameSite] : undefined
  return {
    name: c.name,
    value: c.value,
    domain: c.domain ?? '',
    path: c.path ?? '/',
    expires: c.expirationDate ?? -1,
    size: c.name.length + c.value.length,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    session: !!c.session,
    ...(sameSite ? { sameSite } : {})
  }
}

export class BrowserAutomation {
  private server: BrowserCdpServer | null = null
  private starting: Promise<string | null> | null = null
  private lastNoticeAt = 0

  constructor(private readonly deps: BrowserAutomationDeps) {}

  /** ターミナルへ渡す環境変数。中継を起動できなければ空（browser-use は利用者の Chrome につなぐ、いつもの動き） */
  async env(): Promise<Record<string, string>> {
    const url = await this.start()
    if (!url) return {}
    const bin = await this.prepareBin().catch((err: unknown) => {
      reportHandled(err, { area: 'browser', op: 'automation bin' })
      return null
    })
    return { [BU_CDP_ENV]: url, [BROWSER_CDP_ENV]: url, ...(bin ? { [BROWSER_BIN_ENV]: bin } : {}) }
  }

  private binReady: Promise<string> | null = null

  /** ferret-browser（API で browser-use の Agent を動かす入口）を書く。起動ごとに1回 */
  private prepareBin(): Promise<string> {
    this.binReady ??= (async () => {
      const bin = join(this.deps.toolDir, 'bin')
      await mkdir(bin, { recursive: true })
      const script = join(this.deps.toolDir, BROWSER_AGENT_PY)
      await writeFile(script, BROWSER_AGENT_SCRIPT, { mode: 0o644 })
      if (process.platform === 'win32') {
        await writeFile(join(bin, `${BROWSER_BIN_NAME}.cmd`), browserBinCmd(script))
      } else {
        const entry = join(bin, BROWSER_BIN_NAME)
        await writeFile(entry, browserBinPosix(script), { mode: 0o755 })
        await chmod(entry, 0o755)
      }
      return bin
    })().catch((err: unknown) => {
      this.binReady = null
      throw err
    })
    return this.binReady
  }

  start(): Promise<string | null> {
    if (this.server) return Promise.resolve(this.server.url())
    this.starting ??= this.boot().catch((err: unknown) => {
      reportHandled(err, { area: 'browser', op: 'automation start' })
      this.starting = null
      return null
    })
    return this.starting
  }

  private async boot(): Promise<string> {
    const saved = await this.load()
    const server = new BrowserCdpServer({
      tabs: () => this.deps.tabs(),
      createTab: (url) => this.deps.createTab(url),
      closeTab: (id) => this.deps.closeTab(id),
      activateTab: (id) => this.deps.activateTab(id),
      onTabsChanged: (listener) => this.deps.onTabsChanged(listener),
      cookies: {
        get: async () => (await this.deps.session().cookies.get({})).map(toCdpCookie),
        set: async (cookies) => {
          for (const c of cookies) {
            const sameSite = c.sameSite ? TO_ELECTRON[c.sameSite] : undefined
            const host = c.domain.replace(/^\./, '')
            await this.deps.session().cookies.set({
              url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path || '/',
              secure: !!c.secure,
              httpOnly: !!c.httpOnly,
              ...(c.expires && c.expires > 0 ? { expirationDate: c.expires } : {}),
              ...(sameSite ? { sameSite } : {})
            })
          }
        },
        clear: async () => {
          await this.deps.session().clearStorageData({ storages: ['cookies'] })
        }
      },
      onRelease: (id) => this.deps.hold(id, false),
      llm: new LlmRelay({ key: (id) => this.deps.llmKey(id) }),
      capture: (id, params) => this.deps.capture(id, params),
      // 同じ操作で何度も出さない（タブを開くたびにつなぎ直す道具がある）
      onAttach: (id) => {
        this.deps.hold(id, true)
        this.deps.reveal()
        const now = Date.now()
        if (now - this.lastNoticeAt < 60_000) return
        this.lastNoticeAt = now
        this.deps.notice(this.deps.attachedMessage())
      }
    }, saved?.token ?? randomBytes(24).toString('hex'))
    const url = await server.start(saved?.port ?? 0)
    this.server = server
    if (saved?.port !== server.listeningPort() || saved?.token !== server.token) await this.save({ port: server.listeningPort(), token: server.token })
    return url
  }

  private async load(): Promise<Saved | null> {
    try {
      const raw = JSON.parse(await readFile(this.deps.configFile, 'utf8')) as Partial<Saved>
      if (typeof raw.port === 'number' && Number.isInteger(raw.port) && raw.port > 1024 && raw.port < 65536 && typeof raw.token === 'string' && /^[0-9a-f]{48}$/.test(raw.token)) {
        return { port: raw.port, token: raw.token }
      }
    } catch {
      /* 初回・壊れたファイル（想定内。作り直す） */
    }
    return null
  }

  private async save(value: Saved): Promise<void> {
    await writeFile(this.deps.configFile, JSON.stringify(value), { mode: 0o600 }).catch((err: unknown) => reportHandled(err, { area: 'browser', op: 'automation save' }))
  }

  async stop(): Promise<void> {
    await this.server?.stop()
    this.server = null
    this.starting = null
  }
}
