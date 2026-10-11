/**
 * スマホから操作（Mobile remote）の画面に依存しない部分。main の HTTP サーバー（src/main/mobileRemote.ts）と
 * 設定の画面が使い、単体テストの対象にする。
 *
 * 仕組み: 設定で入れると、Ferret が同じ Wi‑Fi・Tailscale から届く HTTP の口を開く。
 * スマホは `http://<この PC の IP>:<ポート>/#t=<合言葉>` を開き、ページの JS が合言葉を
 * `Authorization: Bearer` で送って、開いているターミナルの一覧・画面の文字を読み、文字やキーを送る。
 * 合言葉は URL の # の後ろ（フラグメント）に置くので、サーバーのログ・Referer には出ない。
 *
 * 守り:
 * - 合言葉は 256 ビットの乱数（base64url で 43 文字）。比べるときは長さ以外で時間が変わらない比べ方にする
 * - Host が IP・localhost・*.ts.net 以外なら断る（DNS rebinding で、利用者のブラウザから他のサイトが叩けないように）
 * - 合言葉の誤りが続く相手（IP）はしばらく断る
 * - 本文の大きさ・送る文字の長さに上限
 * - 送れるキーは決めたものだけ（任意の制御文字の列は受けない）
 */

export const MOBILE_REMOTE_DEFAULT_PORT = 47615
export const MOBILE_REMOTE_MIN_PORT = 1024
export const MOBILE_REMOTE_MAX_PORT = 65535

/** 合言葉のバイト数（256 ビット） */
export const MOBILE_REMOTE_TOKEN_BYTES = 32
/** POST の本文の上限 */
export const MOBILE_REMOTE_MAX_BODY_BYTES = 16 * 1024
/** 1回に送る文字の上限 */
export const MOBILE_REMOTE_MAX_TEXT = 8000
/** 画面の文字として返す上限（末尾を残す） */
export const MOBILE_REMOTE_MAX_SCREEN = 10_000

/** settings.json の mobileRemote */
export interface MobileRemotePrefs {
  /** 口を開くか。未設定は閉じる */
  enabled?: boolean
  /** 待ち受けるポート。未設定は MOBILE_REMOTE_DEFAULT_PORT */
  port?: number
}

/** 開けなかった理由（画面の文言は renderer が選ぶ） */
export type MobileRemoteError = 'portInUse' | 'permission' | 'failed'

/** 設定の画面に出す状態（main → renderer） */
export interface MobileRemoteState {
  enabled: boolean
  port: number
  /** 実際に待ち受けているか */
  running: boolean
  /** スマホで開く URL（合言葉付き）。LAN の IP を先に、Tailscale の IP を後に */
  urls: string[]
  /** 最初の URL の QR（SVG の path と、余白込みの1辺の大きさ）。URL が無ければ null */
  qr: { path: string; size: number } | null
  error: MobileRemoteError | null
}

/** 範囲内のポートか */
export function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MOBILE_REMOTE_MIN_PORT && value <= MOBILE_REMOTE_MAX_PORT
}

/** 読み込んだ値を型どおりに直す。既定（閉じる・既定のポート）だけなら undefined（書かない） */
export function sanitizeMobileRemotePrefs(raw: unknown): MobileRemotePrefs | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const out: MobileRemotePrefs = {}
  if (r.enabled === true) out.enabled = true
  if (isValidPort(r.port) && r.port !== MOBILE_REMOTE_DEFAULT_PORT) out.port = r.port
  return Object.keys(out).length ? out : undefined
}

/** 使うポート */
export function remotePort(prefs: MobileRemotePrefs | undefined): number {
  return isValidPort(prefs?.port) ? prefs.port : MOBILE_REMOTE_DEFAULT_PORT
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

/** 合言葉の形（base64url の 43 文字）か。壊れた保存は作り直す */
export function isWellFormedToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value)
}

/** 32 バイトの乱数から合言葉を作る（乱数は呼び出し側が crypto で作る） */
export function tokenFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== MOBILE_REMOTE_TOKEN_BYTES) throw new RangeError('token needs 32 random bytes')
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * 時間が中身で変わらない比べ方。長さが違えば false（長さは秘密ではない。合言葉はいつも 43 文字）。
 * 文字ごとの差を全部たしてから判断し、途中で抜けない
 */
export function tokensEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const len = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

/** Authorization ヘッダーの Bearer の値。無い・形が違えば null */
export function bearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null
  const m = /^Bearer[ \t]+([^\s]+)[ \t]*$/i.exec(header)
  return m ? m[1]! : null
}

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/** 10 進の4つ組の IPv4 か（先頭の 0 や 8・16 進の書き方は受けない） */
export function isIPv4(value: string): boolean {
  return IPV4_RE.test(value)
}

/** Host ヘッダーから名前を取り出す（ポートを外し、小文字に）。形が壊れていれば null */
export function hostName(host: string | undefined): string | null {
  if (typeof host !== 'string' || host.length === 0 || host.length > 255) return null
  const h = host.trim().toLowerCase()
  if (h.startsWith('[')) {
    // [IPv6]:port
    const m = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/.exec(h)
    return m ? `[${m[1]}]` : null
  }
  const m = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(h)
  return m ? m[1]! : null
}

/**
 * 受け付ける Host か。IP の直書き・localhost・Tailscale の MagicDNS（*.ts.net）だけ。
 * 攻撃者のドメインをこの PC の IP へ向け直す DNS rebinding では Host が攻撃者のドメインになるので、ここで断れる
 */
export function isAllowedHost(host: string | undefined): boolean {
  const name = hostName(host)
  if (!name) return false
  if (name.startsWith('[')) return true
  if (isIPv4(name)) return true
  if (name === 'localhost') return true
  // 末尾の点（FQDN）も同じ名前として扱う
  const bare = name.endsWith('.') ? name.slice(0, -1) : name
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(bare)
}

/**
 * Origin があれば、Host と同じ相手か（同じページの fetch だけを受ける）。Origin の無い要求（同じ所からの GET など）は通す。
 * 合言葉はヘッダーで送るので CSRF にはもともと強いが、念のため重ねる
 */
export function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true
  if (typeof host !== 'string') return false
  try {
    const url = new URL(origin)
    return url.protocol === 'http:' && url.host === host.trim().toLowerCase()
  } catch {
    return false
  }
}

/** os.networkInterfaces() の1件の形（必要な所だけ） */
export interface NetInterfaceInfo {
  address: string
  family: string | number
  internal: boolean
}

/** Tailscale（CGNAT の 100.64.0.0/10）の IP か */
export function isTailscaleIPv4(address: string): boolean {
  if (!isIPv4(address)) return false
  const [a, b] = address.split('.').map(Number) as [number, number]
  return a === 100 && b >= 64 && b <= 127
}

/** LAN の IP（10/8・172.16/12・192.168/16）か */
export function isPrivateLanIPv4(address: string): boolean {
  if (!isIPv4(address)) return false
  const [a, b] = address.split('.').map(Number) as [number, number]
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/**
 * スマホから届く IPv4 の一覧。内部（127.x）・リンクローカル（169.254.x）を除き、重複を除く。
 * 並びは LAN → Tailscale → そのほか（QR は最初の URL なので、同じ Wi‑Fi の IP を先に）
 */
export function reachableIPv4s(interfaces: Record<string, readonly NetInterfaceInfo[] | undefined>): string[] {
  const seen = new Set<string>()
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      const v4 = info.family === 'IPv4' || info.family === 4
      if (!v4 || info.internal || !isIPv4(info.address)) continue
      if (info.address.startsWith('127.') || info.address.startsWith('169.254.')) continue
      seen.add(info.address)
    }
  }
  const rank = (ip: string) => (isPrivateLanIPv4(ip) ? 0 : isTailscaleIPv4(ip) ? 1 : 2)
  return [...seen].sort((a, b) => rank(a) - rank(b))
}

/** スマホで開く URL（合言葉はフラグメントに） */
export function remoteUrl(address: string, port: number, token: string): string {
  return `http://${address}:${port}/#t=${token}`
}

export function remoteUrls(addresses: readonly string[], port: number, token: string): string[] {
  return addresses.map((ip) => remoteUrl(ip, port, token))
}

/**
 * 合言葉の誤りが続く相手を止める。window の間に maxFailures 回まちがえたら、window が過ぎるまで断る。
 * 覚えておく相手の数に上限を持つ（多数の IP から来ても膨らまない）
 */
export class FailureLimiter {
  private entries = new Map<string, { count: number; since: number }>()
  constructor(
    private readonly opts: { maxFailures: number; windowMs: number; maxEntries?: number },
    private readonly now: () => number = Date.now
  ) {}

  /** 止めている間なら、あと何ミリ秒か。止めていなければ 0 */
  blockedFor(key: string): number {
    const entry = this.entries.get(key)
    if (!entry) return 0
    const left = entry.since + this.opts.windowMs - this.now()
    if (left <= 0) {
      this.entries.delete(key)
      return 0
    }
    return entry.count >= this.opts.maxFailures ? left : 0
  }

  fail(key: string): void {
    const now = this.now()
    const entry = this.entries.get(key)
    if (!entry || now - entry.since >= this.opts.windowMs) {
      this.prune(now)
      this.entries.set(key, { count: 1, since: now })
      return
    }
    entry.count++
  }

  /** 正しい合言葉が届いたら数え直す */
  succeed(key: string): void {
    this.entries.delete(key)
  }

  size(): number {
    return this.entries.size
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) if (now - entry.since >= this.opts.windowMs) this.entries.delete(key)
    const max = this.opts.maxEntries ?? 1000
    // 上限を超えたら古いものから捨てる（Map は入れた順）
    while (this.entries.size >= max) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
}

/** スマホから送れるキー。名前 → 端末へ書く列 */
export const REMOTE_KEYS = {
  enter: '\r',
  esc: '\x1b',
  'ctrl-c': '\x03',
  up: '\x1b[A',
  down: '\x1b[B',
  tab: '\t',
  '1': '1',
  '2': '2',
  '3': '3',
  y: 'y',
  n: 'n'
} as const satisfies Record<string, string>

export type RemoteKey = keyof typeof REMOTE_KEYS

export function isRemoteKey(value: unknown): value is RemoteKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(REMOTE_KEYS, value)
}

/** ターミナルの id の形（main の TerminalManager は t1, t2 … の形。余裕を持たせて英数字と - _ だけ） */
const TERMINAL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export type RemoteRoute =
  | { kind: 'page' }
  | { kind: 'asset'; name: 'app.js' | 'app.css' | 'icon.svg' }
  | { kind: 'terminals' }
  | { kind: 'screen'; id: string }
  | { kind: 'send'; id: string }
  | { kind: 'key'; id: string }
  | { kind: 'checklist' }

/** 要求の行き先。知らない道・メソッドの違いは理由付きで返す */
export function routeRequest(method: string | undefined, rawUrl: string | undefined): RemoteRoute | { error: 404 | 405 } {
  const raw = rawUrl ?? '/'
  // 要求の行は / で始まるパスだけ（//host/… や絶対 URL の形は、別の相手を指すように読めるので受けない）
  if (!raw.startsWith('/') || raw.startsWith('//')) return { error: 404 }
  let pathname: string
  try {
    pathname = new URL(raw, 'http://x').pathname
  } catch {
    return { error: 404 }
  }
  const get = method === 'GET' || method === 'HEAD'
  const want = (route: RemoteRoute, needs: 'GET' | 'POST'): RemoteRoute | { error: 405 } =>
    (needs === 'GET' ? get : method === 'POST') ? route : { error: 405 }
  if (pathname === '/' || pathname === '/index.html') return want({ kind: 'page' }, 'GET')
  if (pathname === '/app.js' || pathname === '/app.css' || pathname === '/icon.svg') return want({ kind: 'asset', name: pathname.slice(1) as 'app.js' | 'app.css' | 'icon.svg' }, 'GET')
  if (pathname === '/api/terminals') return want({ kind: 'terminals' }, 'GET')
  if (pathname === '/api/checklist') return want({ kind: 'checklist' }, 'GET')
  const m = /^\/api\/terminals\/([^/]+)\/(screen|send|key)$/.exec(pathname)
  if (m) {
    let id: string
    try { id = decodeURIComponent(m[1]!) } catch { return { error: 404 } }
    if (!TERMINAL_ID_RE.test(id)) return { error: 404 }
    const action = m[2] as 'screen' | 'send' | 'key'
    return want({ kind: action, id }, action === 'screen' ? 'GET' : 'POST')
  }
  return { error: 404 }
}

/** 送る文字の本文 `{"text": "..."}` を確かめる。前後の空白は落とし、空・長すぎは断る */
export function parseSendBody(body: unknown): { text: string } | { error: 'invalid' | 'empty' | 'tooLong' } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid' }
  const text = (body as Record<string, unknown>).text
  if (typeof text !== 'string') return { error: 'invalid' }
  // 改行の揺れ（\r\n）は \n にそろえる。NUL などの制御文字は落とす（タブと改行は残す）
  const clean = text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim()
  if (!clean) return { error: 'empty' }
  if (clean.length > MOBILE_REMOTE_MAX_TEXT) return { error: 'tooLong' }
  return { text: clean }
}

/** キーの本文 `{"key": "enter"}` を確かめる */
export function parseKeyBody(body: unknown): { key: RemoteKey } | { error: 'invalid' } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid' }
  const key = (body as Record<string, unknown>).key
  return isRemoteKey(key) ? { key } : { error: 'invalid' }
}

/**
 * 画面の文字をスマホに出せる形に。残った端末の制御（ESC で始まる列・制御文字）を落とし、
 * 行末の空白と末尾の空行を削り、上限を超えたら末尾を残す
 */
export function cleanScreenText(text: string, max = MOBILE_REMOTE_MAX_SCREEN): string {
  const plain = text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?<=>]*[ -/]*[@-~]/g, '')
    .replace(/\x1b./g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  const lines = plain.split('\n').map((line) => line.replace(/[ \t]+$/, ''))
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  const joined = lines.join('\n')
  return joined.length > max ? joined.slice(joined.length - max) : joined
}

/** パスを / 区切り・末尾の / なしにそろえる（Windows の \ も） */
function normPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
}

/**
 * ターミナルの作業フォルダが入っているプロジェクトの名前（いちばん深いもの）。無ければフォルダ名
 */
export function projectNameFor(cwd: string, projects: ReadonlyArray<{ name: string; folderPath: string }>): string {
  const dir = normPath(cwd)
  let best: { name: string; depth: number } | null = null
  for (const p of projects) {
    const root = normPath(p.folderPath)
    if (dir === root || dir.startsWith(root === '/' ? '/' : `${root}/`)) {
      if (!best || root.length > best.depth) best = { name: p.name, depth: root.length }
    }
  }
  if (best) return best.name
  return dir.split('/').filter(Boolean).pop() ?? dir
}

/** 一覧の1件（API の返す形） */
export interface RemoteTerminalSummary {
  id: string
  title: string
  project: string
  /** Agent の表示名（Claude Code など）。シェルなら空 */
  agent: string
  /** 'working' | 'blocked' | 'idle' | 'unknown' */
  state: string
}

/** 状態を3つ（作業中・確認待ち・待機中）と不明にまとめる */
export function normalizeAgentState(state: string): 'working' | 'blocked' | 'idle' | 'unknown' {
  return state === 'working' || state === 'blocked' || state === 'idle' ? state : 'unknown'
}
