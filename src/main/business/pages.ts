/**
 * 実験ページ（Cloudflare Worker: workers/experiment-pages）の管理 API を呼ぶ側。
 *
 * - 接続先（endpoint）は userData/business-pages.json に、トークンは OS の鍵の仕組み（Electron の safeStorage）で
 *   暗号化して userData/business-pages-token.bin に置く（文字起こしのキー stt-keys.bin と同じ考え方。pipeline/stt/keys.ts）。
 *   settings.json には入れない（画面・設定ファイル・IPC の戻り値にトークンを出さない）。暗号化できない環境（dev 起動など）は起動中だけ持つ
 * - 接続先は https で、インターネットに公開された名前だけ。IP の直書き・localhost・*.local・*.internal・
 *   名前を引くと社内・手元のアドレス（プライベート・ループバック・リンクローカル・CGNAT・メタデータ・IPv6 ULA）になるものは断る。
 *   保存のときに確かめ、送るときは引いたアドレスを確かめてそのアドレスへつなぐ（pinnedFetch.ts。DNS の差し替え対策）。dev 起動（配布版でない）のときだけ http(s)://127.0.0.1・localhost を使える
 * - トークンは保存したときの接続先の origin と組にして暗号化する。接続先を変えてトークンを入れなければトークンは消す。
 *   違う origin へはトークンを送らない
 * - 応答は時間と大きさに上限を付けて読む（boundedResponse.ts）。リダイレクトは追わない（netFetch.ts の既定）
 * - 契約（ルートと形）は workers/experiment-pages/src/contract.ts。main からは import せず、同じ形をここで確かめる
 */
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { lookup as dnsLookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { UserFacingError } from '@shared/errors'
import type { PageContent, PageStats } from '@shared/business/ipc'
import { readBoundedJson, SMALL_JSON_MAX_BYTES } from '../boundedResponse'
import { savePrivateFile } from '../atomicFile'
import type { KeyCipher } from '../pipeline/stt/keys'
import { createPinnedFetch } from './pinnedFetch'

/** contract.ts の SLUG_PATTERN・LIMITS・MAX_BULLETS と同じ値 */
export const SLUG_PATTERN = /^[a-z0-9-]{3,48}$/
export const PAGE_LIMITS = {
  title: 120,
  headline: 120,
  subhead: 300,
  bullet: 200,
  priceText: 120,
  ctaLabel: 40,
  formIntro: 500,
  consentText: 1000,
  footerNote: 500
} as const
export const MAX_BULLETS = 8
export const MAX_STATS_RANGE_DAYS = 366
const TIMEOUT_MS = 15_000
const MAX_TOKEN_LENGTH = 500

export const PAGE_MESSAGES = {
  badEndpoint: '接続先は https:// で始まる URL を入れてください。',
  badEndpointDev: '接続先は https:// で始まる URL を入れてください（開発中は http://127.0.0.1 と http://localhost も使えます）。',
  badToken: 'トークンに使えない文字が含まれています。',
  privateEndpoint: '接続先には、インターネットに公開された名前（例: pages.example.com）を入れてください。社内・手元のアドレスは使えません。',
  lookupFailed: '接続先の名前を引けませんでした。URL とネットの接続を確かめてください。',
  noEndpoint: '実験ページの接続先が設定されていません。',
  noToken: '実験ページのトークンが設定されていません。',
  unauthorized: '実験ページのトークンが違います。',
  notFound: '実験ページがサーバーにありません。',
  invalid: '実験ページのサーバーが内容を受け付けませんでした。',
  offline: '実験ページのサーバーにつながりません。',
  badResponse: '実験ページのサーバーの応答を読めませんでした。',
  server: (status: number) => `実験ページのサーバーがエラーを返しました（HTTP ${status}）。`
} as const

/** dev 起動だけで使える手元の名前 */
const DEV_LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** 公開されていない名前（IP の直書き・localhost・*.local・*.internal・点の無い名前） */
export function isNonPublicHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  if (!h) return true
  if (isIP(h.replace(/^\[|\]$/g, '')) !== 0) return true
  if (/^[0-9.]+$/.test(h) || /^0x/i.test(h)) return true // 省略形・16進の IPv4（URL が直すが念のため）
  if (!h.includes('.')) return true
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa') || h.endsWith('.arpa')
}

const BLOCKED = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) BLOCKED.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64], ['2001::', 32], ['2002::', 16]
] as const) BLOCKED.addSubnet(net, prefix, 'ipv6')

/** IPv6 に埋め込んだ IPv4（::ffff:a.b.c.d・::a.b.c.d・64:ff9b::/96）を取り出す */
function embeddedIpv4(address: string): string | null {
  const a = address.toLowerCase()
  const dotted = /^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(a)
  if (dotted) return dotted[1]!
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a)
  if (hex) {
    const hi = Number.parseInt(hex[1]!, 16)
    const lo = Number.parseInt(hex[2]!, 16)
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  }
  return null
}

/** 社内・手元・特別な用途のアドレスか（プライベート・ループバック・リンクローカル・CGNAT・メタデータ 169.254.169.254・IPv6 ULA など） */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return BLOCKED.check(address, 'ipv4')
  if (family === 6) {
    const v4 = embeddedIpv4(address)
    if (v4) return BLOCKED.check(v4, 'ipv4')
    return BLOCKED.check(address, 'ipv6')
  }
  return true // アドレスでないものは信じない
}

export type LookupAll = (hostname: string) => Promise<Array<{ address: string; family: number }>>

export const defaultLookup: LookupAll = (hostname) => dnsLookup(hostname, { all: true, verbatim: true })

function isDevLocal(url: URL, packaged: boolean): boolean {
  return !packaged && DEV_LOCAL_HOSTS.has(url.hostname)
}

/**
 * 接続先を確かめて、末尾の / を落とした形にする（名前を引くのは assertPublicEndpoint）。空文字は「未設定」として '' を返す。
 * packaged（配布版）は https の公開の名前だけ。dev 起動は http(s)://127.0.0.1・localhost・[::1] も使える
 */
export function normalizeEndpoint(raw: unknown, packaged: boolean): string {
  if (typeof raw !== 'string') throw new UserFacingError(PAGE_MESSAGES.badEndpoint)
  const text = raw.trim()
  if (!text) return ''
  const bad = () => new UserFacingError(packaged ? PAGE_MESSAGES.badEndpoint : PAGE_MESSAGES.badEndpointDev)
  if (text.length > 500) throw bad()
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw bad()
  }
  if (url.username || url.password || url.search || url.hash) throw bad()
  const local = isDevLocal(url, packaged)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw bad()
  if (!local && isNonPublicHostname(url.hostname)) throw new UserFacingError(PAGE_MESSAGES.privateEndpoint)
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/** 名前を引いて、どのアドレスも社内・手元でないことを確かめる（保存のときと、送るたび） */
export async function assertPublicEndpoint(endpoint: string, packaged: boolean, lookup: LookupAll): Promise<void> {
  const url = new URL(endpoint)
  if (isDevLocal(url, packaged)) return
  if (isNonPublicHostname(url.hostname)) throw new UserFacingError(PAGE_MESSAGES.privateEndpoint)
  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(url.hostname)
  } catch (err) {
    throw new UserFacingError(PAGE_MESSAGES.lookupFailed, { cause: err })
  }
  if (!addresses.length) throw new UserFacingError(PAGE_MESSAGES.lookupFailed)
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new UserFacingError(PAGE_MESSAGES.privateEndpoint)
}

export function originOf(endpoint: string): string {
  try {
    return endpoint ? new URL(endpoint).origin : ''
  } catch {
    return ''
  }
}

export function validateToken(raw: unknown): string {
  if (typeof raw !== 'string') throw new UserFacingError(PAGE_MESSAGES.badToken)
  const token = raw.trim()
  if (token && !new RegExp(`^[\\x21-\\x7e]{1,${MAX_TOKEN_LENGTH}}$`).test(token)) throw new UserFacingError(PAGE_MESSAGES.badToken)
  return token
}

/** 実験ページの中身を確かめる（contract.ts の validatePageContent と同じ上限）。問題があれば日本語の UserFacingError */
export function validatePageContent(raw: unknown): PageContent {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null
  if (!o) throw new UserFacingError('ページの中身が正しくありません。')
  const labels: Record<Exclude<keyof PageContent, 'bullets'>, string> = {
    headline: '見出し', subhead: '小見出し', priceText: '価格', ctaLabel: 'ボタンの文言', formIntro: 'フォームの説明', consentText: '同意の文', footerNote: 'ページ下の注記'
  }
  const out: Partial<PageContent> = {}
  for (const key of Object.keys(labels) as Array<keyof typeof labels>) {
    const v = o[key]
    if (typeof v !== 'string') throw new UserFacingError(`${labels[key]}が正しくありません。`)
    if (v.length > PAGE_LIMITS[key]) throw new UserFacingError(`${labels[key]}は ${PAGE_LIMITS[key]} 文字までです。`)
    out[key] = v
  }
  if (!out.headline!.trim()) throw new UserFacingError('見出しを入れてください。')
  if (!out.ctaLabel!.trim()) throw new UserFacingError('ボタンの文言を入れてください。')
  if (!Array.isArray(o.bullets) || o.bullets.length > MAX_BULLETS) throw new UserFacingError(`箇条書きは ${MAX_BULLETS} 個までです。`)
  const bullets: string[] = []
  for (const b of o.bullets) {
    if (typeof b !== 'string' || b.length > PAGE_LIMITS.bullet) throw new UserFacingError(`箇条書きは1つ ${PAGE_LIMITS.bullet} 文字までです。`)
    bullets.push(b)
  }
  return { ...(out as Omit<PageContent, 'bullets'>), bullets }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface PagesApi {
  put(slug: string, body: { experimentId: string; title: string; content: PageContent; status: 'draft' | 'published' }): Promise<void>
  unpublish(slug: string): Promise<void>
  stats(slug: string, from: string, to: string): Promise<PageStats>
}

function nonNegativeInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null
}

/** 統計の応答を確かめる（数は 0 以上の整数） */
export function parseStats(raw: unknown, slug: string): PageStats {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null
  if (!o || o.slug !== slug || typeof o.experimentId !== 'string' || typeof o.from !== 'string' || typeof o.to !== 'string') throw new UserFacingError(PAGE_MESSAGES.badResponse)
  const views = nonNegativeInt(o.views)
  const uniqueVisitors = nonNegativeInt(o.uniqueVisitors)
  const ctaClicks = nonNegativeInt(o.ctaClicks)
  const interests = nonNegativeInt(o.interests)
  if (views === null || uniqueVisitors === null || ctaClicks === null || interests === null) throw new UserFacingError(PAGE_MESSAGES.badResponse)
  return { slug, experimentId: o.experimentId, from: o.from, to: o.to, views, uniqueVisitors, ctaClicks, interests }
}

export interface PagesApiOptions {
  /** トークンを保存したときの接続先の origin。違う origin へはトークンを送らない */
  tokenOrigin?: string
}

/** 管理 API の呼び出し（Bearer ADMIN_TOKEN）。fetch は差し替えられる（テストは偽物、本番は pinnedFetch.ts） */
export function createPagesApi(endpoint: string, token: string, fetchImpl: FetchLike, options: PagesApiOptions = {}): PagesApi {
  if (!endpoint) throw new UserFacingError(PAGE_MESSAGES.noEndpoint)
  if (!token) throw new UserFacingError(PAGE_MESSAGES.noToken)
  const origin = originOf(endpoint)
  if (!origin || (options.tokenOrigin !== undefined && options.tokenOrigin !== origin)) throw new UserFacingError(PAGE_MESSAGES.noToken)
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const url = `${endpoint}${path}`
    if (new URL(url).origin !== origin) throw new UserFacingError(PAGE_MESSAGES.badEndpoint)
    let res: Response
    try {
      res = await fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Accept: 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
    } catch (err) {
      const blocked = (e: unknown): boolean => !!e && typeof e === 'object' && ((e as { code?: unknown }).code === 'EBLOCKEDADDRESS' || blocked((e as { cause?: unknown }).cause))
      if (blocked(err)) throw new UserFacingError(PAGE_MESSAGES.privateEndpoint, { cause: err })
      throw new UserFacingError(PAGE_MESSAGES.offline, { cause: err })
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      if (res.status === 401 || res.status === 403) throw new UserFacingError(PAGE_MESSAGES.unauthorized)
      if (res.status === 404) throw new UserFacingError(PAGE_MESSAGES.notFound)
      if (res.status === 400 || res.status === 409 || res.status === 413 || res.status === 415) throw new UserFacingError(PAGE_MESSAGES.invalid)
      throw new UserFacingError(PAGE_MESSAGES.server(res.status))
    }
    try {
      return await readBoundedJson(res, SMALL_JSON_MAX_BYTES)
    } catch (err) {
      if (err instanceof UserFacingError) throw err
      throw new UserFacingError(PAGE_MESSAGES.badResponse, { cause: err })
    }
  }
  const slugPath = (slug: string) => {
    if (!SLUG_PATTERN.test(slug)) throw new UserFacingError('ページの名前は英小文字・数字・- の 3〜48 文字にしてください。')
    return `/api/pages/${slug}`
  }
  return {
    async put(slug, body) {
      await call('PUT', slugPath(slug), body)
    },
    async unpublish(slug) {
      await call('POST', `${slugPath(slug)}/unpublish`)
    },
    async stats(slug, from, to) {
      const raw = await call('GET', `${slugPath(slug)}/stats?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      return parseStats(raw, slug)
    }
  }
}

/** 接続先とトークンの保管。トークンは画面へ返さない（hasToken だけ）。トークンは保存したときの origin と組で持つ */
export class PageConfigStore {
  private endpointCache: string | null = null
  /** 暗号化できない環境で、起動中だけ持つトークン */
  private sessionToken: BoundToken | null = null

  constructor(
    private readonly files: { config: string; token: string },
    private readonly cipher: KeyCipher,
    private readonly packaged: boolean,
    private readonly lookup: LookupAll = defaultLookup,
    /** 送る道（既定は確かめたアドレスにだけつなぐ pinnedFetch。テストで差し替える） */
    private readonly transport: FetchLike = createPinnedFetch(lookup, (address, hostname) =>
      (!packaged && DEV_LOCAL_HOSTS.has(hostname)) || !isPrivateAddress(address))
  ) {}

  async endpoint(): Promise<string> {
    if (this.endpointCache !== null) return this.endpointCache
    let endpoint = ''
    try {
      const raw = JSON.parse(await readFile(this.files.config, 'utf8')) as { endpoint?: unknown }
      endpoint = normalizeEndpoint(raw.endpoint ?? '', this.packaged)
    } catch {
      // 無い・壊れている・今は使えない接続先（配布版の http・社内の名前）は未設定として扱う
      endpoint = ''
    }
    this.endpointCache = endpoint
    return endpoint
  }

  /** 保存したトークンと、その origin。無い・読めない・origin の無い古い形なら null */
  private async bound(): Promise<BoundToken | null> {
    if (this.sessionToken) return this.sessionToken
    if (!existsSync(this.files.token) || !this.cipher.available()) return null
    try {
      const o = JSON.parse(this.cipher.decrypt(await readFile(this.files.token))) as Partial<BoundToken>
      return typeof o.origin === 'string' && o.origin && typeof o.token === 'string' && o.token ? { origin: o.origin, token: o.token } : null
    } catch {
      return null
    }
  }

  /** いまの接続先で使えるトークン（origin が違えば ''） */
  async token(): Promise<string> {
    const b = await this.bound()
    const origin = originOf(await this.endpoint())
    return b && origin && b.origin === origin ? b.token : ''
  }

  async hasToken(): Promise<boolean> {
    return (await this.token()) !== ''
  }

  async config(): Promise<{ endpoint: string; hasToken: boolean }> {
    return { endpoint: await this.endpoint(), hasToken: await this.hasToken() }
  }

  private async clearToken(): Promise<void> {
    this.sessionToken = null
    await rm(this.files.token, { force: true })
  }

  /**
   * 接続先を保存し、トークンが空でなければ置き換える。
   * 接続先の origin が変わってトークンが空なら、前のトークンは消す（別の接続先へ送らない）
   */
  async set(input: { endpoint: unknown; token: unknown }): Promise<{ endpoint: string; hasToken: boolean }> {
    const endpoint = normalizeEndpoint(input.endpoint, this.packaged)
    const token = validateToken(input.token)
    if (endpoint) await assertPublicEndpoint(endpoint, this.packaged, this.lookup)
    const origin = originOf(endpoint)
    const previous = await this.bound()
    await savePrivateFile(this.files.config, `${JSON.stringify({ endpoint }, null, 2)}\n`)
    this.endpointCache = endpoint
    if (token && origin) {
      const bound: BoundToken = { origin, token }
      if (this.cipher.available()) {
        await savePrivateFile(this.files.token, this.cipher.encrypt(JSON.stringify(bound)))
        this.sessionToken = null
      } else {
        // 暗号化できない（dev 起動・鍵束の無い Linux）: 平文で書かず、起動中だけ持つ
        await rm(this.files.token, { force: true })
        this.sessionToken = bound
      }
    } else if (!origin || (previous && previous.origin !== origin) || (!previous && existsSync(this.files.token))) {
      await this.clearToken()
    }
    return this.config()
  }

  async api(): Promise<PagesApi> {
    const endpoint = await this.endpoint()
    const b = await this.bound()
    const origin = originOf(endpoint)
    const token = b && origin && b.origin === origin ? b.token : ''
    return createPagesApi(endpoint, token, this.transport, { tokenOrigin: b?.origin ?? '' })
  }
}

interface BoundToken {
  origin: string
  token: string
}
