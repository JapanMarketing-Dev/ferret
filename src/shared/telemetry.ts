/**
 * クラッシュレポート（Sentry）の送る条件と、送る前に個人の情報を落とす処理。
 *
 * main（初期化と beforeSend）と単体テストから使う。renderer のイベントと minidump も
 * main の beforeSend を通ってから送られるので、ここで落とせば全部の経路に効く。
 * Sentry の型には依存させず、イベントはただのオブジェクトとして扱う。
 *
 * 送るのは「アプリが落ちた・例外が出た」という事実と、その場所（スタック）と、
 * OS・CPU・Electron の版だけ。画面の中身（URL・ターミナル・文字起こし・指摘）は送らない。
 */
import type { MinidumpCrash } from './minidump'
import { STALE_CHUNK_MESSAGE, isUserFacingError } from './errors'
import { readBrandEnv } from './brandEnv'

/**
 * 送り先。公開してよい値（OSS のアプリに埋め込む前提）。
 * フォークした人は FERRET_SENTRY_DSN（以前の MOVIE_ADE_SENTRY_DSN も可）で自分の Sentry に向けられ、空にすれば送らない。
 */
export const DEFAULT_SENTRY_DSN =
  'https://716da12f9b6378ca3e3fd1cf8206846a@o4511317909569536.ingest.us.sentry.io/4512189930602496'

/**
 * release の名前。配布版は `ferret@<version>`（`sentry` CLI でソースマップを上げるときも同じ名前）。
 * dev 起動は `ferret@<version>+<git の短いハッシュ>`（取れなければ `+dev`）。どのコミットで出たかを分ける。
 * 0.1.x までは MOVIE-ADE の名前で `movie-ade@<version>` だった（Sentry に残っているリリースはその名前）。
 */
/** Sentry のリリース名の前置き（scripts/sentry-sourcemaps.mjs・sentry-release.mjs と同じ） */
export const RELEASE_PREFIX = 'ferret'

export function sentryRelease(version: string, dev?: { gitHash?: string | null }): string {
  if (!dev) return `${RELEASE_PREFIX}@${version}`
  const hash = dev.gitHash && /^[0-9a-f]{4,40}$/i.test(dev.gitHash.trim()) ? dev.gitHash.trim() : 'dev'
  return `${RELEASE_PREFIX}@${version}+${hash}`
}

/**
 * Sentry 系の環境変数。新しい名前（FERRET_SENTRY_*）を先に、無ければ以前の名前（MOVIE_ADE_SENTRY_*）を読む（src/shared/brandEnv.ts）。
 * 空文字も「設定あり」として扱う（DSN を空にすると送らない、の意味を保つ）
 */
export function sentryEnv(env: Record<string, string | undefined>, name: 'DSN' | 'FORCE' | 'TEST'): string | undefined {
  return readBrandEnv(env, `SENTRY_${name}`)
}

/** 環境変数があればそれを使う（空文字＝送らない）。無ければ既定の DSN */
export function resolveSentryDsn(env: Record<string, string | undefined>): string | null {
  const raw = sentryEnv(env, 'DSN')
  if (raw === undefined) return DEFAULT_SENTRY_DSN
  const v = raw.trim()
  return v ? v : null
}

/** 設定の値。未設定は ON（既定 ON、設定でいつでも OFF） */
export function crashReportsEnabled(settings: { crashReports?: boolean }): boolean {
  return settings.crashReports !== false
}

interface CrashReportConditions {
  /** E2E（ADE_E2E=1） */
  e2e: boolean
  /**
   * 送信の確認用（FERRET_SENTRY_FORCE=1。以前の MOVIE_ADE_SENTRY_FORCE も可）。E2E の起動（ウインドウを出さず、OS の許可のダイアログも出さない）でも送る。
   * 単体テストと設定 OFF には勝たない
   */
  forced?: boolean
  /** 単体テスト（VITEST） */
  unitTest: boolean
  /** 設定の「クラッシュレポートを送る」 */
  enabled: boolean
  dsn: string | null
}

/**
 * 配布版と dev 起動の両方で送る（dev のエラーも集めて直すため）。
 * E2E・単体テスト・設定 OFF・DSN が空なら送らない。
 */
export function shouldSendCrashReports(c: CrashReportConditions): boolean {
  return Boolean(c.dsn) && c.enabled && (!c.e2e || c.forced === true) && !c.unitTest
}

interface TelemetryProfile {
  environment: 'production' | 'development'
  /** JS の例外を送る割合（ネイティブのクラッシュは常に全部） */
  sampleRate: number
  /** 1回の起動で送る数の上限（エラー・クラッシュ） */
  maxEventsPerRun: number
  /** 1回の起動で送る warning（握りつぶしていた失敗・性能の異常）の上限。クラッシュの枠を食わないよう別に数える */
  maxWarningsPerRun: number
}

/**
 * 環境ごとの送り方。配布版は利用者が多いので間引き、dev は開発者の手元だけなので全部送る。
 * どちらも同じエラーは1回の起動で1度だけ（createEventLimiter）。
 */
export function telemetryProfile(packaged: boolean): TelemetryProfile {
  return packaged
    ? { environment: 'production', sampleRate: JS_ERROR_SAMPLE_RATE, maxEventsPerRun: MAX_EVENTS_PER_RUN, maxWarningsPerRun: 5 }
    : { environment: 'development', sampleRate: 1, maxEventsPerRun: MAX_DEV_EVENTS_PER_RUN, maxWarningsPerRun: 30 }
}

/** 送る前に伏せる材料。プロジェクトのフォルダは設定から渡す */
export interface ScrubContext {
  homeDir?: string
  projectPaths?: readonly string[]
}

/** 例外のメッセージなど、1つの文字列の上限。長い文には画面の中身が入りやすい */
const MAX_STRING_LENGTH = 300

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
/** http(s)/ws(s) の URL。内蔵ブラウザで開いたページ・API の接続先。app:// と file:// はスタックに要るので残す */
const WEB_URL = /\b(?:https?|wss?):\/\/[^\s"'<>()]+/gi
/** ホームの下の利用者名（/Users/<name>、/home/<name>、C:\Users\<name>）。区切りは / と \ の両方 */
const HOME_UNIX = /(^|[\s"'(=:]|file:\/\/)\/(?:Users|home)\/[^/\\\s"']+/g
const HOME_WIN = /\b[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\\/\s"']+/gi
/**
 * 素の IP アドレス（SECURITY.md で送らないと約束している）。URL の中のものは WEB_URL が先に丸ごと消す。
 * IPv6 は省略形（::）・8区切りの全形・末尾が IPv4 の形・%ゾーン付き。時刻（12:34:56）や C++ の Foo::bar には当てない
 */
const IPV4_CORE = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}`
const IPV4 = new RegExp(String.raw`(?<![\w.])${IPV4_CORE}(?!\w|\.\d)`, 'g')
const H6 = '[0-9a-f]{1,4}'
const IPV6_TAIL = String.raw`(?:${IPV4_CORE}|${H6})`
const IPV6 = new RegExp(
  String.raw`(?<![\w:.])(?:` +
    // 全形（8区切り）。末尾 32bit が IPv4 の形も
    String.raw`(?:${H6}:){7}${H6}|(?:${H6}:){6}${IPV4_CORE}|` +
    // 省略形。:: の前後どちらかに少なくとも1区切り
    String.raw`(?:${H6}(?::${H6}){0,6})?::(?:(?:${H6}:){0,6}${IPV6_TAIL})?` +
  // 後ろの :<ポート>（全形のあとの :443 など）は IP に含めず、IP だけを落とす
  String.raw`)(?:%[\w.-]+)?(?!\w|\.\d|:(?!\d{1,5}(?![\w:])))`,
  'gi'
)
const IP_PLACEHOLDER = '<ip>'

/** よく使われる API キーの形（redact.ts の looksSecret と同じ前置き）、Bearer、JWT、長い16進 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{10,}/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{10,}/g,
  /\bxox[bpsar]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{12,}/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b[0-9a-f]{32,}\b/gi
]

/** 文字列1つから個人の情報を落とす */
export function scrubString(input: string, ctx: ScrubContext = {}, max = MAX_STRING_LENGTH): string {
  let s = input
  // プロジェクトのフォルダはホームより先に（ホームの下にあることが多い）
  for (const p of ctx.projectPaths ?? []) {
    if (p && p.length > 1) s = s.replace(new RegExp(escapeRegExp(p), 'g'), '<project>')
  }
  if (ctx.homeDir && ctx.homeDir.length > 1) s = s.replace(new RegExp(escapeRegExp(ctx.homeDir), 'g'), '~')
  s = s.replace(HOME_UNIX, (_m, lead: string) => `${lead}~`)
  s = s.replace(HOME_WIN, '~')
  s = s.replace(WEB_URL, '<url>')
  s = s.replace(EMAIL, '<email>')
  s = s.replace(IPV6, (m) => (m === '::' ? m : IP_PLACEHOLDER)).replace(IPV4, IP_PLACEHOLDER)
  for (const re of SECRET_PATTERNS) s = s.replace(re, '<secret>')
  if (s.length > max) s = `${s.slice(0, max)}…`
  return s
}

/** スタックのファイル名は長さで切らない（ソースマップの照合に要る） */
/** Sentry が付ける ID（32桁の16進）。秘密の形に見えても触らない */
const ID_KEYS = new Set(['event_id', 'trace_id', 'span_id', 'parent_span_id', 'sid', 'replay_id', 'profile_id'])

const UNTRUNCATED_KEYS = new Set(['filename', 'abs_path', 'module', 'debug_id', 'code_file', 'debug_file'])
/** 長くてよい文字列（React のコンポーネントの階層）。伏せる処理は同じ */
const LONG_TEXT_KEYS: Record<string, number> = { componentStack: 2000 }

function scrubDeep(value: unknown, ctx: ScrubContext, key = '', depth = 0): unknown {
  if (depth > 12) return undefined
  if (typeof value === 'string') {
    if (ID_KEYS.has(key)) return value
    return UNTRUNCATED_KEYS.has(key) ? scrubPath(value, ctx) : scrubString(value, ctx, LONG_TEXT_KEYS[key])
  }
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, ctx, key, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v, ctx, k, depth + 1)
    return out
  }
  return value
}

/** スタックのファイル名。伏せるのはホームとプロジェクトのパスだけで、長さでは切らない */
function scrubPath(value: string, ctx: ScrubContext): string {
  let s = value
  for (const p of ctx.projectPaths ?? []) if (p && p.length > 1) s = s.split(p).join('<project>')
  if (ctx.homeDir && ctx.homeDir.length > 1) s = s.split(ctx.homeDir).join('~')
  return s.replace(HOME_UNIX, (_m, lead: string) => `${lead}~`).replace(HOME_WIN, '~')
}

/**
 * 残してよい breadcrumb の種類。アプリやウィンドウの出来事（electron）、子プロセスの終了、
 * 起動の失敗（startup。console.error の `[startup]` だけを拾う）。
 * ほかの console・fetch・クリック・画面遷移は、ターミナルの出力やページの URL・要素の文言を含みうるので落とす。
 */
const BREADCRUMB_CATEGORIES = new Set(['electron', 'child-process', 'startup', 'flow'])
/** flow（主要な流れの区切り。src/shared/report.ts）の data に残してよい値：数と、短い識別子（agent 名・種類）だけ */
const FLOW_VALUE = /^[A-Za-z0-9_.:-]{1,40}$/
const MAX_BREADCRUMBS = 30

type Breadcrumb = { category?: string; message?: string; data?: { [key: string]: unknown } }

export function scrubBreadcrumb<T extends Breadcrumb>(crumb: T, ctx: ScrubContext = {}): T | null {
  if (!crumb.category || !BREADCRUMB_CATEGORIES.has(crumb.category)) return null
  // data には URL やウィンドウのタイトルが入るので、子プロセスの終了の情報と、flow の短い識別子以外は持たない
  const data = crumb.category === 'child-process' && crumb.data
    ? pick(crumb.data, ['type', 'reason', 'exitCode', 'name'])
    : crumb.category === 'flow' && crumb.data
      ? flowData(crumb.data)
      : undefined
  const out: Breadcrumb = { ...crumb, data }
  if (!data) delete out.data
  if (typeof out.message === 'string') out.message = scrubString(out.message, ctx)
  return scrubDeep(out, ctx) as T
}

function flowData(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (!FLOW_VALUE.test(k)) continue
    if ((typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && FLOW_VALUE.test(v))) out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

function electronContext(v: Record<string, unknown>): Record<string, unknown> {
  const details = v.details && typeof v.details === 'object' ? pick(v.details as Record<string, unknown>, ['reason', 'exitCode', 'type', 'name']) : undefined
  return details ? { details } : {}
}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) if (k in obj) out[k] = obj[k]
  return out
}

/** 残してよい contexts（OS・端末・アプリ・実行環境の版）。それ以外は落とす */
// crash は minimizeNativeCrash が形を確かめて作る落ちた場所（モジュール名+位置・symbols の ID・スレッド名）。
// ここで落としていたため、FERRET-1Q は 0.4.21 から 0.6.2 まで場所が届かなかった
const ALLOWED_CONTEXTS = new Set(['os', 'device', 'app', 'runtime', 'electron', 'chrome', 'node', 'gpu', 'culture', 'trace', 'react', 'block', 'startup', 'crash'])

type EventLike = {
  user?: unknown
  breadcrumbs?: Breadcrumb[]
  contexts?: object
  exception?: unknown
  message?: unknown
}

/**
 * Sentry へ送る前のイベントから個人の情報を落とす。
 * user・request・extra・server_name は丸ごと持たない。残る文字列は全部 scrubString を通す。
 */
export function scrubEvent<T extends EventLike>(event: T, ctx: ScrubContext = {}): T {
  const copy = { ...event } as EventLike & Record<string, unknown>
  // 利用者は、端末ごとに作ったランダムな ID（インストール ID）だけを残す（「影響を受けた人数」を数えるため）。
  // 名前・メール・IP は持たない
  const userId = (copy.user as { id?: unknown } | undefined)?.id
  // 空の geo も必ず置く。Sentry は IP を送らなくても（infer_ip: never・ip_address: null でも）接続元の IP から
  // 市区町村を推定して user.geo に入れるが、geo が既にあれば推定しない（2026-10-04 に verification へ送って確かめた）
  copy.user = isInstallId(userId) ? { id: userId, geo: {} } : { geo: {} }
  delete copy.request
  delete copy.extra
  delete copy.server_name
  if (copy.contexts) {
    const contexts: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(copy.contexts)) {
      if (!ALLOWED_CONTEXTS.has(k) || !v || typeof v !== 'object') continue
      // 端末名・機種の ID・起動した時刻など、端末の識別につながる項目は落とす
      const { name: _n, model_id: _m, boot_time: _b, ...rest } = v as Record<string, unknown>
      // electron には crashpad の注釈・クラッシュした画面の URL が入るので、終了の情報だけを残す
      contexts[k] = k === 'device' ? rest : k === 'electron' ? electronContext(v as Record<string, unknown>) : v
    }
    copy.contexts = contexts
  }
  if (copy.breadcrumbs) {
    copy.breadcrumbs = copy.breadcrumbs
      .map((b) => scrubBreadcrumb(b, ctx))
      .filter((b): b is Breadcrumb => b !== null)
      .slice(-MAX_BREADCRUMBS)
  }
  return scrubDeep(copy, ctx) as T
}

/**
 * 同じエラーを何度も送らないための鍵。例外の種類・メッセージ・一番上のフレームで決める。
 * 1回の起動で同じ鍵は1度だけ送る（無料の上限の中に収める）。
 */
function eventFingerprint(event: EventLike): string {
  const values = (event.exception as { values?: Array<Record<string, unknown>> } | undefined)?.values ?? []
  const last = values[values.length - 1]
  if (!last) return `msg:${String(event.message ?? '')}`
  const frames = ((last.stacktrace as { frames?: Array<Record<string, unknown>> } | undefined)?.frames ?? [])
  const top = frames[frames.length - 1]
  return [last.type, last.value, top?.filename, top?.function, top?.lineno].map((v) => String(v ?? '')).join('|')
}

/** 1回の起動で送る数の上限。暴走しているときに無料の枠を使い切らない */
export const MAX_EVENTS_PER_RUN = 10
/** dev 起動の上限。開発者の手元だけなので多めに集める（重複の抑止は同じ） */
const MAX_DEV_EVENTS_PER_RUN = 50

/** 起動ごとの送信の抑え（重複と上限）。テストのため状態を外に持てる形にする */
export function createEventLimiter(max = MAX_EVENTS_PER_RUN): (event: EventLike) => boolean {
  const seen = new Set<string>()
  let sent = 0
  return (event) => {
    if (sent >= max) return false
    const key = eventFingerprint(event)
    if (seen.has(key)) return false
    seen.add(key)
    sent += 1
    return true
  }
}

/**
 * JS の例外は半分だけ送る（同じ不具合は多くの人で起きるので、半分でも気づける）。
 * ネイティブのクラッシュ（minidump）は数が少なく重いので、全部送る。
 */
const JS_ERROR_SAMPLE_RATE = 0.5

export function sampleEvent(isNativeCrash: boolean, random: () => number = Math.random, rate = JS_ERROR_SAMPLE_RATE): boolean {
  return isNativeCrash || random() < rate
}

/** ErrorBoundary で捕まえた描画のエラーに付けるタグと文脈。componentStack はコンポーネントの階層 */
export function renderErrorCapture(boundary: string, componentStack?: string | null): {
  tags: Record<string, string>
  contexts: { react: { componentStack: string } }
} {
  return {
    tags: { kind: 'render-error', 'error.boundary': boundary },
    contexts: { react: { componentStack: (componentStack ?? '').trim() } }
  }
}

/**
 * did-fail-load を送るか。アプリ自身の画面（main の renderer・録画ウインドウ・プレビュー）の読み込み失敗だけを送る。
 * 内蔵ブラウザで開いた利用者のページ（別のセッション）は、相手のサーバーが止まっているなど利用者側の失敗が
 * 普通に起きるので送らない。-3（ERR_ABORTED）は次の読み込みで前の読み込みが止まっただけなので送らない。
 */

export function shouldReportLoadFailure(f: { ownPage: boolean; errorCode: number; isMainFrame: boolean }): boolean {
  if (!f.isMainFrame || f.errorCode === -3) return false
  return f.ownPage
}

/**
 * Ferret 自身の実行ファイルの名前か（配布版の ferret・ferret.exe、開発版の Ferret-Dev.exe・ferret-dev（electron-builder.dev.cjs）、
 * dev 起動の electron。小文字で比べる）
 */
export function isOwnExecutable(name: string): boolean {
  return /^(ferret(-dev)?|electron)(\.exe)?$/.test(name.toLowerCase())
}

/** render-process-gone / child-process-gone を送るか。正常終了と、利用者が止めた（killed）ものは送らない */
export function shouldReportProcessGone(reason: string): boolean {
  return reason !== 'clean-exit' && reason !== 'killed'
}

/**
 * minimizeNativeCrash を通したネイティブのクラッシュを送るか。main（browser）以外のプロセスが外から止められた（killed）・
 * 正常に終わった（clean-exit）ものは、shouldReportProcessGone と同じく送らない。
 * macOS の Utility が SIGTERM（exitCode 15）で止められたときも crashpad が報告を作り、SDK が「Native crash (Utility, killed)」として送っていた（Sentry FERRET-1V）。
 * main は前の起動の理由が分からない（unknown）ことが多いので、理由では捨てない。
 * 子のプロセスが dyld で読み込みの途中に外から止められた報告（例外なし crash.code 0x0・落ちた場所が dyld）も同じく送らない。
 * 次の起動で見つかった報告はプロセスと理由が分からない（unknown）ため、killed で捨てられずに「Native crash (unknown): dyld」になっていた（Sentry FERRET-1W。1V と同じ形）
 *
 * Ferret の外のプログラムの報告も送らない。macOS では crashpad の例外の受け口（mach の exception port）が子に引き継がれるため、
 * ターミナルから起動したプログラム（Playwright の headless_shell など）が落ちても Ferret の報告になり、
 * 「Native crash (unknown): headless_shell」として届いてクラッシュしなかった割合も下げていた（Sentry FERRET-1X・FERRET-Q）。
 * 実行ファイルの名前（crash.exe）が分かって、Ferret（配布版の ferret・ferret.exe、dev の electron）でなければ捨てる。
 * Ferret の helper（「Ferret Helper (Renderer)」など）は名前に空白が入り crash.exe が付かないので、これまでどおり送る
 */
export function shouldSendNativeCrash(event: { tags?: object }): boolean {
  const tags = (event.tags ?? {}) as Record<string, unknown>
  if (tags['event.process'] === 'browser') return true
  if (typeof tags['crash.exe'] === 'string' && !isOwnExecutable(tags['crash.exe'])) return false
  if (tags['crash.code'] === '0x0' && tags['crash.module'] === 'dyld') return false
  return typeof tags['exit.reason'] !== 'string' || shouldReportProcessGone(tags['exit.reason'])
}

/** 確認用（FERRET_SENTRY_TEST。以前の MOVIE_ADE_SENTRY_TEST も可）。`1`/`all` は全部、`main,renderer` のように選べる */
const SENTRY_TEST_KINDS = ['main', 'renderer', 'boundary', 'ipc', 'handled'] as const
/**
 * アプリを落とす・止める確認（ネイティブのクラッシュ、main の未処理の例外、長い停止）。
 * `1` / `all` には含めず、名前を書いたときだけ起こす（うっかり落とさない）
 */
export const SENTRY_DESTRUCTIVE_TEST_KINDS = ['crash-main', 'crash-renderer', 'uncaught', 'hang', 'preload'] as const
export type SentryTestKind = (typeof SENTRY_TEST_KINDS)[number] | (typeof SENTRY_DESTRUCTIVE_TEST_KINDS)[number]

export function parseSentryTestKinds(raw: string | undefined): SentryTestKind[] {
  const v = (raw ?? '').trim().toLowerCase()
  if (!v || v === '0') return []
  if (v === '1' || v === 'all') return [...SENTRY_TEST_KINDS]
  const words = v.split(/[\s,]+/)
  return [...SENTRY_TEST_KINDS, ...SENTRY_DESTRUCTIVE_TEST_KINDS].filter((k) => words.includes(k))
}

/**
 * IPC のハンドラを包み、投げた例外を `kind: ipc` と チャネル名のタグ付きで送る。
 * 利用者に見せるための想定内のエラー（UserFacingError）は送らない。
 * 例外はどちらもそのまま投げ直す（renderer 側の扱いは変えない）。送る処理（report）は main が渡す。
 */
export function wrapIpcHandler<A extends unknown[], R>(
  channel: string,
  handler: (...args: A) => R | Promise<R>,
  report: (err: unknown, tags: Record<string, string>) => void
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    try {
      return await handler(...args)
    } catch (err) {
      if (!isUserFacingError(err)) report(err, { kind: 'ipc', 'ipc.channel': channel })
      throw err
    }
  }
}

/** 性能の異常の閾値。起動して操作できるまで（目標 2s）と、main のイベントループの停止 */
export const SLOW_STARTUP_MS = 5000
export const EVENT_LOOP_BLOCK_MS = 1000
/**
 * 開発版の閾値。dev の Mac は E2E・ビルド・HMR で重いことが多く、1秒程度の停止は日常的に起きるので、3秒を超えたものだけ送る。
 * 配布版は EVENT_LOOP_BLOCK_MS のまま
 */
export const DEV_EVENT_LOOP_BLOCK_MS = 3000

export function eventLoopBlockThreshold(packaged: boolean): number {
  return packaged ? EVENT_LOOP_BLOCK_MS : DEV_EVENT_LOOP_BLOCK_MS
}

/** スリープから戻ってこの間は、タイマーの遅れを止まりとして数えない */
export const RESUME_GRACE_MS = 5000

/**
 * 閉じる操作（before-quit）からこの間は、終了の途中とみなす（will-quit の前の片付けの止まりを送らない。FERRET-M の 0.4.15）。
 * 終了の確認で取り消されることがあるので、ずっとではなく時間で区切る
 */
export const QUIT_GRACE_MS = 30_000

/**
 * タイマーの遅れを main の止まりとして送るか。
 * 送らないのは、利用者が待っていない・アプリの処理ではない遅れ（FERRET-M の 0.4.1・0.4.4 の macOS の事例）:
 *   quitting … 終了の途中（更新の入れ替え quitAndInstall でウィンドウを閉じた後に 5.2s）。画面は無く、誰も待っていない
 *   appActive … 遅れの前後ともアプリが前面か。裏にいる間は macOS の App Nap・タイマーのまとめでタイマーが数秒遅れる
 *     （前面に戻した瞬間に溜まった遅れで発火するので、前の回も前面だったかで見る。裏に回って数分後に 2.0s・4.0s）
 *   msSinceResume … スリープから戻ってからの時間（null は戻っていない）。戻った直後のタイマーの遅れは止まりではない
 *   msSinceQuitRequest … 閉じる操作（before-quit）からの時間（null は閉じていない）。QUIT_GRACE_MS のあいだは終了の途中
 */
export function shouldReportEventLoopBlock(s: {
  lagMs: number
  thresholdMs: number
  quitting: boolean
  appActive: boolean
  msSinceResume: number | null
  msSinceQuitRequest?: number | null
}): boolean {
  if (s.lagMs <= s.thresholdMs) return false
  if (s.quitting || !s.appActive) return false
  if (s.msSinceQuitRequest != null && s.msSinceQuitRequest < QUIT_GRACE_MS + s.lagMs) return false
  if (s.msSinceResume !== null && s.msSinceResume < RESUME_GRACE_MS + s.lagMs) return false
  return true
}
/** 同じ種類の性能の異常を続けて送らない間隔 */
export const ANOMALY_COOLDOWN_MS = 10 * 60 * 1000

/** 性能の異常を、種類ごとに一定時間に1度だけ通す。now はテストで差し替える */
export function createAnomalyGate(cooldownMs = ANOMALY_COOLDOWN_MS, now: () => number = Date.now): (key: string) => boolean {
  const last = new Map<string, number>()
  return (key) => {
    const t = now()
    const prev = last.get(key)
    if (prev !== undefined && t - prev < cooldownMs) return false
    last.set(key, t)
    return true
  }
}

/** 停止の長さを粗い区分にする（タグの値が増えすぎないように） */
export function durationBucket(ms: number): string {
  if (ms < 2000) return '1-2s'
  if (ms < 5000) return '2-5s'
  if (ms < 10000) return '5-10s'
  return '10s+'
}

/**
 * インストール ID：端末（userData）ごとに1度だけ作るランダムな UUID。利用者の情報は何も含まない。
 * 「影響を受けた人数」と、リリースごとのクラッシュしなかった人の割合を数えるためだけに使う
 */
const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isInstallId(value: unknown): value is string {
  return typeof value === 'string' && INSTALL_ID.test(value)
}

/** 保存してあった ID が使えればそれを、無い・壊れていれば新しく作る（作ったかどうかも返す） */
export function resolveInstallId(saved: string | null | undefined, create: () => string): { id: string; created: boolean } {
  const v = saved?.trim()
  if (isInstallId(v)) return { id: v, created: false }
  return { id: create(), created: true }
}

/**
 * クラッシュのイベントか。ネイティブのクラッシュ（minidump）、fatal、捕まえていない例外。
 * これにだけ main の直前のログを添付する
 */
export function isCrashEvent(event: { level?: unknown; exception?: unknown }, isNativeCrash: boolean): boolean {
  if (isNativeCrash || event.level === 'fatal') return true
  const values = (event.exception as { values?: Array<{ mechanism?: { handled?: unknown } }> } | undefined)?.values ?? []
  return values.some((v) => v.mechanism?.handled === false)
}

/**
 * 起動中にアプリのファイルが入れ替わって分割ファイルが無くなった失敗（FERRET-X）を分ける。
 * dev（作業ツリーの out/ の build し直し）は不具合ではないので送らない（null）。
 * 配布版は入れ替えの経路（更新の途中など）を知るために送るが、kind: stale-build を付けて1件にまとめる
 */
export function classifyStaleBuild<E extends { exception?: unknown; tags?: Record<string, unknown>; fingerprint?: string[] }>(event: E, packaged: boolean): E | null {
  const values = (event.exception as { values?: Array<{ value?: unknown }> } | undefined)?.values ?? []
  if (!values.some((v) => STALE_CHUNK_MESSAGE.test(String(v.value ?? '')))) return event
  if (!packaged) return null
  return { ...event, tags: { ...event.tags, kind: 'stale-build' }, fingerprint: ['stale-build'] }
}

/** 添付する main のログの行数と、1行の長さの上限 */
const LOG_RING_LINES = 50
export const LOG_LINE_MAX = 160

/**
 * main のログの直近の行（クラッシュに添付する）。
 * `[startup]` `[recording]` のようにアプリが付けた見出しで始まる行だけを残す（ターミナルの出力・文字起こし・
 * 指摘の本文が混ざらないように）。1行は短く切り、パス・URL・メール・キーは送る前の除去と同じ規則で伏せる
 */
export function createLogRing(max = LOG_RING_LINES, ctx: () => ScrubContext = () => ({})) {
  const lines: string[] = []
  return {
    push(level: string, args: unknown[]): void {
      const first = args[0]
      if (typeof first !== 'string' || !/^\[[\w:.-]{1,24}\]/.test(first)) return
      const text = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.name}: ${a.message}` : '')).filter(Boolean).join(' ')
      lines.push(`${new Date().toISOString()} ${level} ${scrubString(text, ctx(), LOG_LINE_MAX)}`)
      if (lines.length > max) lines.shift()
    },
    snapshot(): string {
      return lines.join('\n')
    }
  }
}

/** 中央のタブ（どの画面を見ていたか）をタグの値にする。ファイルのタブはパスを持つので 'file' にまとめる */
export function uiTabTag(tab: string): string {
  return /^(browser|findings|settings|reviews|gallery)$/.test(tab) ? tab : tab.startsWith('file') ? 'file' : 'other'
}

/**
 * 送る environment。確認用の起動（FERRET_SENTRY_FORCE・ADE_E2E）と、版に -verify が付いたビルドは verification
 * （production のアラートとクラッシュしなかった割合を汚さない）。それ以外は配布版が production、dev が development
 */
export function resolveEnvironment(c: { packaged: boolean; version: string; forced: boolean; e2e: boolean }): 'production' | 'development' | 'verification' {
  if (c.forced || c.e2e || /-verify\b/i.test(c.version)) return 'verification'
  return c.packaged ? 'production' : 'development'
}

export type PerfAnomaly = 'slow-startup' | 'slow-pre-js' | 'event-loop-block'
const PERF_TITLE: Record<PerfAnomaly, string> = {
  'slow-startup': 'Slow startup',
  // JS より前（プロセスの生成からアプリの JS が動くまで）で遅れた起動。初回起動の Gatekeeper の検査など（src/shared/startupBreakdown.ts）
  'slow-pre-js': 'Slow launch before JS',
  'event-loop-block': 'Main event loop blocked'
}

/**
 * 性能の異常のイベントの形。題名は「Slow startup (7.4s)」のように種類と長さだけ、まとめ方（fingerprint）は種類ごとに固定。
 * スタックは付けない（送る処理の中のフレームが題名や culprit にならないように）
 */
export function perfAnomalyEvent(perf: PerfAnomaly, ms: number): {
  message: string
  level: 'warning'
  fingerprint: string[]
  tags: Record<string, string>
} {
  return {
    message: `${PERF_TITLE[perf]} (${(ms / 1000).toFixed(1)}s)`,
    level: 'warning',
    fingerprint: ['anomaly', perf],
    tags: { kind: 'perf', perf, duration: durationBucket(ms) }
  }
}

/** 起動の失敗のパンくず：console の文そのものは入れず、操作名と数（ms）だけにする */
export function startupBreadcrumb(level: 'error' | 'warning', args: unknown[]): { category: 'startup'; level: 'error' | 'warning'; message: string; data?: { ms: number } } {
  const text = typeof args[0] === 'string' ? args[0] : ''
  const ms = /(\d+)\s*ms/.exec(text)?.[1]
  return { category: 'startup', level, message: level === 'error' ? 'startup failed' : 'startup slow', ...(ms ? { data: { ms: Number(ms) } } : {}) }
}

/**
 * 「クラッシュレポートを送る」を起動中に切り替えたときの扱い。allow() は送る直前に毎回呼び、そのときの設定で決める
 * （OFF にした瞬間から、エラー・warning・セッション・添付・renderer のイベントまで全部止まる）。
 * ON / OFF が変わったら onDisable / onEnable を1度だけ呼ぶ（セッションを閉じる・始め直す）
 */
export function createSendGate(isEnabled: () => boolean, hooks: { onDisable?: () => void; onEnable?: () => void } = {}) {
  let last = isEnabled()
  const sync = (): boolean => {
    const now = isEnabled()
    if (now !== last) {
      last = now
      if (now) hooks.onEnable?.()
      else hooks.onDisable?.()
    }
    return now
  }
  return { allow: sync, sync }
}

/**
 * 送ってよい添付。main の直近のログ（見出し付きの行だけ・行ごとに伏せ字済み。createLogRing）だけ。
 * minidump（ネイティブのクラッシュのメモリの写し）は、キー・パス・画面の文などが入りうるのに伏せ字を通せないので送らない（security-2 [13]）
 */
export const ALLOWED_ATTACHMENTS: ReadonlySet<string> = new Set(['main-log.txt'])

type AttachmentLike = { filename?: unknown; attachmentType?: unknown }

export function isAllowedAttachment(attachment: AttachmentLike): boolean {
  return typeof attachment.filename === 'string' && ALLOWED_ATTACHMENTS.has(attachment.filename) &&
    (attachment.attachmentType === undefined || attachment.attachmentType === 'event.attachment')
}

/**
 * 送ってよい envelope の項目。beforeSend（伏せ字）を通ったイベント、セッション（数だけ）、送れなかった数、許した添付だけ。
 * renderer から直接届く span・profile・feedback・replay などは beforeSend を通らないので送らない
 */
const ALLOWED_ENVELOPE_ITEMS = new Set(['event', 'session', 'sessions', 'client_report', 'attachment'])

/** envelope から送ってよくない項目を落とす。何も残らない・形が違うときは null（送らない） */
export function filterEnvelope<E>(envelope: E): E | null {
  if (!Array.isArray(envelope) || envelope.length !== 2 || !Array.isArray(envelope[1])) return null
  const items = (envelope[1] as unknown[]).filter((item) => {
    const header = (Array.isArray(item) ? item[0] : undefined) as { type?: unknown; filename?: unknown; attachment_type?: unknown } | undefined
    if (!header || typeof header.type !== 'string' || !ALLOWED_ENVELOPE_ITEMS.has(header.type)) return false
    return header.type !== 'attachment' || isAllowedAttachment({ filename: header.filename, attachmentType: header.attachment_type })
  })
  return items.length > 0 ? ([envelope[0], items] as E) : null
}

/**
 * 送る直前の transport を包み、filterEnvelope を通す。オフラインの置き場から後で送るもの（前の版がためたものも含む）も、
 * ここを通ってから送られる
 */
export function filterTransport<T extends { send: (envelope: never) => PromiseLike<unknown> }>(base: T): T {
  return {
    ...base,
    send: (envelope: never) => {
      const filtered = filterEnvelope(envelope)
      return filtered ? base.send(filtered) : Promise.resolve({})
    }
  }
}

/**
 * Sentry の transport を包む。allow() が false のあいだは何も送らない（セッション・renderer のイベントも含む）。
 * 送るときも filterEnvelope を通し、伏せ字を通らない項目（minidump・span など）を最後にもう一度落とす
 */
export function gateTransport<T extends { send: (envelope: never) => PromiseLike<unknown>; flush: (timeout?: number) => PromiseLike<boolean> }>(base: T, allow: () => boolean): T {
  return {
    ...base,
    send: (envelope: never) => {
      const filtered = allow() ? filterEnvelope(envelope) : null
      return filtered ? base.send(filtered) : Promise.resolve({})
    },
    flush: (timeout?: number) => base.flush(timeout)
  }
}

type NativeCrashLike = {
  platform?: unknown
  tags?: Record<string, unknown>
  contexts?: Record<string, unknown>
  [key: string]: unknown
}

/** Electron が V8 のメモリ不足で落ちたときに付ける crashpad の注釈があるか */
function isV8OomCrash(event: NativeCrashLike): boolean {
  const electron = event.contexts?.electron as Record<string, unknown> | undefined
  if (electron && Object.keys(electron).some((k) => k.includes('v8-oom'))) return true
  const values = (event.exception as { values?: Array<{ type?: unknown }> } | undefined)?.values
  return Array.isArray(values) && values.some((v) => v?.type === 'OutOfMemoryError')
}

/** ネイティブのクラッシュ（minidump から作られたイベント）か */
export function isNativeCrashEvent(event: { platform?: unknown; tags?: object }, hasMinidump: boolean): boolean {
  return hasMinidump || event.platform === 'native' || (event.tags as Record<string, unknown> | undefined)?.['event.environment'] === 'native'
}

const CRASH_VALUE = /^[A-Za-z0-9_.-]{1,40}$/
const crashValue = (v: unknown): string | undefined => (typeof v === 'string' && CRASH_VALUE.test(v) ? v : undefined)
/** ネイティブのクラッシュに残すタグ（どのプロセスが・なぜ・どの版と環境で） */
const NATIVE_CRASH_TAGS = ['os.platform', 'arch', 'electron', 'build', 'app.mode']
/** 落ちる前の main の様子（watchMainHealth が scope に付けた区分。memoryBucket・uptimeBucket の形だけ） */
const NATIVE_CRASH_BUCKET_TAGS = ['mem.rss', 'mem.heap', 'uptime']
/** ネイティブのクラッシュに残す flow のパンくずの数（直近から） */
export const NATIVE_CRASH_FLOW_LIMIT = 30
const FLOW_MESSAGE = /^[a-z][a-z0-9 :_-]{0,39}$/
const STACK_ENTRY = /^[a-z0-9_.+-]{1,40}\+0x[0-9a-f]{1,12}$/
const HEX_ID = /^[0-9A-F]{8,48}$/
const THREAD_NAME = /^[A-Za-z0-9 _.:#/-]{1,40}$/

/** 前の起動のパンくずから、Ferret の flow だけを形を確かめて残す */
function nativeCrashFlow(breadcrumbs: unknown): Array<Record<string, unknown>> {
  const list = Array.isArray(breadcrumbs) ? breadcrumbs : (breadcrumbs as { values?: unknown } | undefined)?.values
  if (!Array.isArray(list)) return []
  const out: Array<Record<string, unknown>> = []
  for (const b of list as Array<Record<string, unknown>>) {
    if (b?.category !== 'flow' || typeof b.message !== 'string' || !FLOW_MESSAGE.test(b.message)) continue
    const data = b.data && typeof b.data === 'object' ? flowData(b.data as Record<string, unknown>) : undefined
    out.push({ category: 'flow', message: b.message, ...(typeof b.timestamp === 'number' ? { timestamp: b.timestamp } : {}), ...(data && Object.keys(data).length ? { data } : {}) })
  }
  return out.slice(-NATIVE_CRASH_FLOW_LIMIT)
}

/** minidump から読んだ落ちた場所の手がかり（形を確かめたものだけ） */
function nativeCrashContext(dump: MinidumpCrash | null | undefined): Record<string, unknown> | null {
  if (!dump) return null
  const out: Record<string, unknown> = {}
  if (dump.module && crashValue(dump.module) && dump.offset && /^0x[0-9a-f]{1,12}$/.test(dump.offset)) out.location = `${dump.module}+${dump.offset}`
  if (dump.debugId && HEX_ID.test(dump.debugId)) out.debug_id = dump.debugId
  if (dump.codeId && HEX_ID.test(dump.codeId)) out.code_id = dump.codeId
  if (dump.thread && THREAD_NAME.test(dump.thread)) out.thread = dump.thread
  const stack = (dump.stack ?? []).filter((e) => STACK_ENTRY.test(e))
  if (stack.length) out.stack = stack
  return Object.keys(out).length ? out : null
}
const BUCKET_VALUES = new Set(['<256MB', '256-512MB', '512MB-1GB', '1-2GB', '2GB+', '<1m', '1-10m', '10-60m', '1-4h', '4-24h', '1d+'])

/**
 * ネイティブのクラッシュは「起きたこと」だけを送る：プロセスの種類・終了の理由・版（security-2 [13]）。
 * crashpad の注釈・クラッシュした画面の URL・スタックのメモリの中身は持たない。
 * 原因を追えるように、次の2つだけは残す（2026-10-07、FERRET-1Q で手がかりが無かったため）:
 *   - contexts.crash: minidump から読んだ、落ちた場所と、落ちたスレッドのスタックの中のモジュールの位置（`name+0xoffset`）・
 *     symbols を引く ID・スレッド名（@shared/minidump。アドレスそのもの・メモリの中身・パスは含まない）
 *   - 前の起動のパンくずのうち、Ferret 自身の flow（@shared/report の flow。固定の文と列挙した値）だけを直近 NATIVE_CRASH_FLOW_LIMIT 件。
 *     Electron が付けるパンくず（URL・ウインドウの題名を含みうる）は捨てる
 */
export function minimizeNativeCrash<E extends { tags?: object; contexts?: object }>(input: E, dump?: MinidumpCrash | null): E {
  const event = input as unknown as NativeCrashLike
  const proc = crashValue(event.tags?.['event.process']) ?? 'unknown'
  const electron = event.contexts?.electron as { details?: Record<string, unknown> } | undefined
  const reason = crashValue(event.tags?.['exit.reason']) ?? crashValue(electron?.details?.reason)
  const exitCode = electron?.details?.exitCode
  const tags: Record<string, string> = { 'event.environment': 'native', 'event.process': proc }
  if (reason) tags['exit.reason'] = reason
  for (const k of NATIVE_CRASH_TAGS) {
    const v = crashValue(event.tags?.[k])
    if (v) tags[k] = v
  }
  for (const k of NATIVE_CRASH_BUCKET_TAGS) {
    const v = event.tags?.[k]
    if (typeof v === 'string' && BUCKET_VALUES.has(v)) tags[k] = v
  }
  // なぜ落ちたか：minidump の例外の種類と落ちた場所のモジュール名、V8 のメモリ不足の印（注釈の有無だけ。中身は送らない）
  const oom = isV8OomCrash(event) || dump?.kind === 'oom'
  const code = crashValue(dump?.code)
  const module = crashValue(dump?.module)
  const kind = oom ? 'oom' : crashValue(dump?.kind)
  if (code) tags['crash.code'] = code
  if (kind) tags['crash.kind'] = kind
  if (module) tags['crash.module'] = module
  const exe = crashValue(dump?.executable)
  if (exe) tags['crash.exe'] = exe
  const app = event.contexts?.app as Record<string, unknown> | undefined
  const os = event.contexts?.os as Record<string, unknown> | undefined
  const contexts: Record<string, unknown> = {
    electron: { details: { reason: reason ?? 'unknown', ...(typeof exitCode === 'number' ? { exitCode } : {}) } }
  }
  if (app) contexts.app = { app_version: app.app_version, app_arch: app.app_arch }
  if (os) contexts.os = { name: os.name, version: os.version }
  const crash = nativeCrashContext(dump)
  if (crash) contexts.crash = crash
  const flow = nativeCrashFlow(event.breadcrumbs)
  const out: NativeCrashLike = {
    event_id: event.event_id,
    timestamp: event.timestamp,
    level: 'fatal',
    platform: 'native',
    release: event.release,
    environment: event.environment,
    user: event.user,
    sdk: event.sdk,
    message: `Native crash (${proc}${reason ? `, ${reason}` : ''})${kind || module ? `: ${[kind, module].filter(Boolean).join(' in ')}` : ''}`,
    fingerprint: ['native-crash', proc, reason ?? 'unknown', ...(kind ? [kind] : []), ...(module ? [module] : [])],
    tags,
    contexts,
    ...(flow.length ? { breadcrumbs: flow } : {})
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
  return out as unknown as E
}

/**
 * 処理中の IPC（main の停止の手がかり）。begin で始め、返した関数で終える。snapshot は長い順の上位3つ
 */
export function createInflightTracker(now: () => number = Date.now) {
  const running = new Map<number, { name: string; at: number }>()
  let seq = 0
  return {
    begin(name: string): () => number {
      const id = ++seq
      const at = now()
      running.set(id, { name, at })
      return () => {
        running.delete(id)
        return now() - at
      }
    },
    snapshot(limit = 3): Array<{ name: string; ms: number }> {
      const t = now()
      return [...running.values()].map((r) => ({ name: r.name, ms: t - r.at })).sort((a, b) => b.ms - a.ms).slice(0, limit)
    }
  }
}

/**
 * 止まったときの main の様子（JS のスタックに出ない原因の手がかり）。
 *   heapUsedMb / rssMb … 大きいと GC（ゴミ集め）で止まりやすい
 *   axEnabled / axChangedMsAgo … 補助技術（画面の読み上げ・他のアプリの操作）が有効になると、Chromium が画面の木を作り直して main が止まることがある
 */
interface BlockEnvironment {
  heapUsedMb: number
  rssMb: number
  axEnabled: boolean
  axChangedMsAgo: number | null
  /**
   * OS が掛けている CPU の速度の上限（%。powerMonitor の speed-limit-change。100 は制限なし、null はまだ来ていない）。
   * 省電力・熱で絞られている間は、アプリの処理でなくてもタイマーが遅れる（FERRET-M の 0.6.30 の Windows で続けて来ていた）
   */
  cpuSpeedLimit?: number | null
}

/** CPU の速度の上限のおおまかな区分（タグにする） */
export function cpuLimitBucket(limit: number | null | undefined): string {
  if (limit == null || !Number.isFinite(limit)) return 'unknown'
  if (limit >= 100) return 'none'
  if (limit >= 75) return '75-99%'
  if (limit >= 50) return '50-74%'
  return '<50%'
}

/** メモリの量のおおまかな区分（タグにする） */
export function memoryBucket(mb: number): string {
  if (mb < 256) return '<256MB'
  if (mb < 512) return '256-512MB'
  if (mb < 1024) return '512MB-1GB'
  if (mb < 2048) return '1-2GB'
  return '2GB+'
}

/** 起動からの時間のおおまかな区分（タグにする） */
export function uptimeBucket(seconds: number): string {
  if (seconds < 60) return '<1m'
  if (seconds < 600) return '1-10m'
  if (seconds < 3600) return '10-60m'
  if (seconds < 4 * 3600) return '1-4h'
  if (seconds < 24 * 3600) return '4-24h'
  return '1d+'
}

/** GC の種類の名前（node:perf_hooks の entry.detail.kind。NODE_PERFORMANCE_GC_*） */
export function gcKindName(kind: unknown): string {
  switch (kind) {
    case 1: return 'minor'
    case 4: return 'major'
    case 8: return 'incremental'
    case 16: return 'weakcb'
    default: return 'other'
  }
}

/** 止まったときのイベントに付ける手がかり（タグと contexts.block）。中身は処理の名前と時間、メモリの量だけ */
export function eventLoopBlockContext(
  inflight: Array<{ name: string; ms: number }>,
  slow: Array<{ op: string; ms: number }>,
  env?: BlockEnvironment
): { tags: Record<string, string>; context: Record<string, string> } {
  const fmt = (list: Array<{ label: string; ms: number }>) => list.map((x) => `${x.label} ${Math.round(x.ms)}ms`).join(', ') || 'none'
  const tags: Record<string, string> = { 'block.ipc': inflight[0]?.name ?? 'none', 'block.slowop': slow[0]?.op ?? 'none' }
  const context: Record<string, string> = {
    inflight_ipc: fmt(inflight.map((x) => ({ label: x.name, ms: x.ms }))),
    recent_slow_ops: fmt(slow.map((x) => ({ label: x.op, ms: x.ms })))
  }
  if (env) {
    tags['block.heap'] = memoryBucket(env.heapUsedMb)
    tags['block.ax'] = env.axEnabled ? 'on' : 'off'
    context.heap_used = `${Math.round(env.heapUsedMb)}MB`
    context.rss = `${Math.round(env.rssMb)}MB`
    context.ax_changed = env.axChangedMsAgo === null ? 'never' : `${Math.round(env.axChangedMsAgo)}ms ago`
    if (env.cpuSpeedLimit !== undefined) {
      tags['block.cpulimit'] = cpuLimitBucket(env.cpuSpeedLimit)
      context.cpu_speed_limit = env.cpuSpeedLimit === null ? 'unknown' : `${Math.round(env.cpuSpeedLimit)}%`
    }
  }
  return { tags, context }
}

/** 意味の無い Electron の出来事（補助技術の切り替えの通知など）。同じものが続けて来るので捨てる */
const NOISY_BREADCRUMBS = new Set(['app.accessibility-support-changed'])

/** パンくずを間引く。騒がしい出来事は捨て、直前と同じもの（種類と文が同じ）が続くときは1つにする */
export function createBreadcrumbFilter() {
  let last = ''
  return (crumb: { category?: string; message?: string }): boolean => {
    if (crumb.category === 'electron' && crumb.message && NOISY_BREADCRUMBS.has(crumb.message)) return false
    const key = `${crumb.category ?? ''}\u0000${crumb.message ?? ''}`
    if (key === last) return false
    last = key
    return true
  }
}
