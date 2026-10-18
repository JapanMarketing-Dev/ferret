/**
 * 元（SourceKind）ごとの読み取り（純粋）。CSV の表 → MetricRow と問題。
 *
 * 行ごとの決まり（全部の元で同じ）:
 * - 空行・# で始まる行・合計の行（Total / 合計 / 総計 …）・見出しの繰り返し・値が1つだけで日付でない行（注記）は skipped に数える。
 *   日付が空で数だけある行も合計の行とみなす。数がすべて空の行も skipped。
 * - 日付が読めない → badDate、数が読めない → badNumber、負の数 → negative。どれも行ごと捨てる（行番号つき）。
 *   followers（フォロワー・登録者の増減）だけは負の数を受ける（純減は正しいデータ）。
 * - 行の通貨がビジネスの通貨と違う → currencyMismatch。その行の金額（spend・revenue）だけ外し、ほかの数は残す。
 */
import { CHANNELS, METRIC_KEYS, MONEY_METRICS, SOURCE_KINDS } from '../model'
import type { Channel, ImportIssue, ImportIssueCode, MetricKey, MetricRow, SourceKind } from '../model'
import { isBlankRow } from './csv'
import type { CsvRow, CsvTable } from './csv'
import { findHeader, isTotalLabel, normalizeHeader } from './columns'
import type { ColumnAliases, HeaderMatch, HeaderSpec } from './columns'
import { parseDate } from './dates'
import { parseNumber, roundAmount } from './numbers'

/** 負の数を受ける数の種類（増減を書く数。YouTube の登録者・X のフォロワーの純減） */
export const SIGNED_METRICS: ReadonlySet<MetricKey> = new Set(['followers'])

/** 問題の detail に入れる元の値の長さ */
export const DETAIL_VALUE_MAX = 80
/** 行に持つ文字列（キャンペーン名・顧客の手がかり・支払い id）の長さ */
export const TEXT_MAX = 200

export interface ImportContext {
  /** 行と問題の file（data/ からの相対パス） */
  file: string
  source: SourceKind
  /** ビジネスの通貨（大文字） */
  currency: string
  rows: MetricRow[]
  issues: ImportIssue[]
  skipped: number
}

export function clip(s: string, max = DETAIL_VALUE_MAX): string {
  return s.length > max ? s.slice(0, max) : s
}

export function addIssue(ctx: ImportContext, line: number | null, code: ImportIssueCode, detail?: string): void {
  ctx.issues.push(detail === undefined ? { file: ctx.file, line, code } : { file: ctx.file, line, code, detail: clip(detail) })
}

export function isSourceKind(v: unknown): v is SourceKind {
  return typeof v === 'string' && (SOURCE_KINDS as readonly string[]).includes(v)
}

export function isChannel(v: unknown): v is Channel {
  return typeof v === 'string' && (CHANNELS as readonly string[]).includes(v)
}

// ---------------------------------------------------------------- 顧客の仮名

/**
 * メールアドレスを顧客の仮名にする（'c_' + 16 桁の16進）。小文字にして前後の空白を外してから、FNV-1a（32 bit）を2つの起点で2回。
 * 同じメールは同じ仮名になるので、重複や継続を数えられる。仮名化であって安全な暗号ではない（総当たりで元に戻せる）。
 * 画面と集計にメールをそのまま持たないためのもの。
 */
export function pseudonymizeCustomer(email: string): string {
  const bytes = new TextEncoder().encode(email.trim().toLowerCase())
  const fnv = (basis: number): string => {
    let h = basis >>> 0
    for (const b of bytes) {
      h ^= b
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h.toString(16).padStart(8, '0')
  }
  return `c_${fnv(0x811c9dc5)}${fnv(0x050c5d1f)}`
}

// ---------------------------------------------------------------- 経路の対応

/**
 * GA4 の「セッションのデフォルト チャネル グループ」→ 経路。正規化（小文字・空白なし）した名前で引く。
 * Organic Search → organic-search / Paid Search → google-ads / Direct → direct / Referral → referral / Email → email /
 * Organic Video → youtube（動画の自然流入はほぼ YouTube）/ ほか（Organic Social・Paid Social・Display・Unassigned・
 * Cross-network・Affiliates・Organic Shopping・Paid Video・SMS・Audio・Mobile Push Notifications など）→ other。
 * Paid Social は Meta とは限らない（X・TikTok の広告もある）ので meta-ads にしない。日本語の表示名も同じ対応。
 */
export const GA4_CHANNEL_GROUPS: Readonly<Record<string, Channel>> = {
  organicsearch: 'organic-search',
  オーガニック検索: 'organic-search',
  自然検索: 'organic-search',
  paidsearch: 'google-ads',
  有料検索: 'google-ads',
  direct: 'direct',
  ダイレクト: 'direct',
  ノーリファラー: 'direct',
  referral: 'referral',
  参照: 'referral',
  参照元サイト: 'referral',
  email: 'email',
  メール: 'email',
  organicvideo: 'youtube',
  オーガニック動画: 'youtube'
}

export function ga4Channel(group: string): Channel {
  return GA4_CHANNEL_GROUPS[normalizeHeader(group)] ?? 'other'
}

/** サポートの「経路」の自由な書き方 → 経路。分からなければ support */
const FREE_CHANNELS: Readonly<Record<string, Channel>> = {
  email: 'email', 'e-mail': 'email', mail: 'email', メール: 'email', eメール: 'email',
  x: 'x', twitter: 'x', ツイッター: 'x',
  youtube: 'youtube', ユーチューブ: 'youtube',
  tiktok: 'tiktok', ティックトック: 'tiktok',
  blog: 'blog', ブログ: 'blog', note: 'blog',
  referral: 'referral', 紹介: 'referral',
  google: 'google-ads', googleads: 'google-ads', google広告: 'google-ads',
  meta: 'meta-ads', facebook: 'meta-ads', instagram: 'meta-ads', meta広告: 'meta-ads',
  seo: 'organic-search', 検索: 'organic-search', 自然検索: 'organic-search',
  direct: 'direct', 直接: 'direct'
}

export function freeChannel(text: string): Channel {
  const s = normalizeHeader(text)
  if (s === '') return 'support'
  if (isChannel(s)) return s
  return FREE_CHANNELS[s] ?? 'support'
}

/** サポートの「種類」のうち問い合わせ・リードとして数えるもの（正規化した完全一致） */
const LEAD_TYPES = new Set(
  ['問い合わせ', 'お問い合わせ', '問合せ', 'お問合せ', '問合わせ', 'inquiry', 'inquiries', 'enquiry', 'lead', 'leads', 'リード',
    '見積もり', '見積り', '見積', '見積もり依頼', '見積依頼', 'quote', '資料請求', '商談', '商談依頼', 'demo', 'デモ', 'デモ依頼', 'sales', '営業'].map(normalizeHeader)
)

export function isLeadType(type: string): boolean {
  return LEAD_TYPES.has(normalizeHeader(type))
}

// ---------------------------------------------------------------- 元ごとの列

interface SourceSpec {
  channel: Channel
  header: HeaderSpec
  /** 数の列の鍵 → 数の種類 */
  metrics: Readonly<Record<string, MetricKey>>
}

const DATE = ['day', 'date', '日', '日付']

const CANONICAL_COLUMNS: ColumnAliases = {
  date: ['date', '日付'],
  channel: ['channel', '経路'],
  campaign: ['campaign', 'キャンペーン'],
  currency: ['currency', '通貨'],
  customer: ['customer', '顧客'],
  paymentId: ['paymentid', 'payment_id', 'payment id'],
  ...Object.fromEntries(METRIC_KEYS.map((k) => [k, [k]]))
}

/** 元ごとの列名（日英）と数の対応。support・stripe は行の読み方が違うので数の対応は空 */
export const SOURCE_SPECS: Readonly<Record<SourceKind, SourceSpec>> = {
  'google-ads': {
    channel: 'google-ads',
    header: {
      columns: {
        date: DATE,
        campaign: ['campaign', 'キャンペーン'],
        currency: ['currency code', 'currency', '通貨コード', '通貨'],
        impressions: ['impr.', 'impressions', 'impr', '表示回数'],
        clicks: ['clicks', 'クリック数'],
        spend: ['cost', '費用'],
        conversions: ['conversions', 'コンバージョン']
      },
      date: 'date',
      needAny: ['impressions', 'clicks', 'spend', 'conversions']
    },
    metrics: { impressions: 'impressions', clicks: 'clicks', spend: 'spend', conversions: 'conversions' }
  },
  'meta-ads': {
    channel: 'meta-ads',
    header: {
      columns: {
        date: ['day', 'reporting starts', '日', 'レポート開始日', 'date', '日付'],
        campaign: ['campaign name', 'キャンペーン名'],
        currency: ['currency', '通貨'],
        impressions: ['impressions', 'インプレッション'],
        clicks: ['link clicks', 'リンクのクリック'],
        spend: ['amount spent', '消化金額'],
        leads: ['leads', 'リード']
      },
      date: 'date',
      needAny: ['impressions', 'clicks', 'spend', 'leads']
    },
    metrics: { impressions: 'impressions', clicks: 'clicks', spend: 'spend', leads: 'leads' }
  },
  ga4: {
    channel: 'other',
    header: {
      columns: {
        date: ['date', '日付'],
        channelGroup: ['session default channel group', 'セッションのデフォルト チャネル グループ', 'default channel group', 'デフォルト チャネル グループ'],
        sessions: ['sessions', 'セッション', 'セッション数'],
        conversions: ['key events', 'キーイベント', 'conversions', 'コンバージョン']
      },
      date: 'date',
      needAny: ['sessions', 'conversions']
    },
    metrics: { sessions: 'sessions', conversions: 'conversions' }
  },
  'search-console': {
    channel: 'organic-search',
    header: {
      columns: { date: ['date', '日付'], clicks: ['clicks', 'クリック数'], impressions: ['impressions', '表示回数'] },
      date: 'date',
      needAny: ['clicks', 'impressions']
    },
    metrics: { clicks: 'clicks', impressions: 'impressions' }
  },
  x: {
    channel: 'x',
    header: {
      columns: {
        date: ['date', '日付'],
        impressions: ['impressions', 'インプレッション', 'インプレッション数'],
        clicks: ['url clicks', 'link clicks', 'リンクのクリック数', 'urlのクリック数', 'リンクのクリック'],
        followers: ['new follows', 'new followers', '新しいフォロー', '新しいフォロワー', 'フォロー']
      },
      date: 'date',
      needAny: ['impressions', 'clicks', 'followers']
    },
    metrics: { impressions: 'impressions', clicks: 'clicks', followers: 'followers' }
  },
  youtube: {
    channel: 'youtube',
    header: {
      columns: {
        date: ['date', '日付'],
        views: ['views', '視聴回数'],
        impressions: ['impressions', 'インプレッション数', 'インプレッション'],
        followers: ['subscribers', 'チャンネル登録者', 'チャンネル登録者数', '登録者']
      },
      date: 'date',
      needAny: ['views', 'impressions', 'followers']
    },
    metrics: { views: 'clicks', impressions: 'impressions', followers: 'followers' }
  },
  tiktok: {
    channel: 'tiktok',
    header: {
      columns: {
        date: ['date', '日付'],
        videoViews: ['video views', '動画視聴数', '動画の視聴数'],
        profileViews: ['profile views', 'プロフィール表示回数', 'プロフィールの表示回数'],
        followers: ['new followers', '新しいフォロワー', '新規フォロワー']
      },
      date: 'date',
      needAny: ['videoViews', 'profileViews', 'followers']
    },
    metrics: { videoViews: 'impressions', profileViews: 'clicks', followers: 'followers' }
  },
  support: {
    channel: 'support',
    header: {
      // 顧客のメール・名前の列は対応に入れない（読まない）
      columns: { date: ['受付日', 'date', 'created', 'created at', '受信日', '日付'], channel: ['経路', 'channel'], type: ['種類', 'type', 'kind'] },
      date: 'date',
      needAny: []
    },
    metrics: {}
  },
  stripe: {
    channel: 'stripe',
    header: {
      columns: {
        date: ['created date (utc)', 'created (utc)', 'created', 'created date', '作成日 (utc)', '作成日'],
        id: ['id', 'charge id', 'payment id'],
        amount: ['amount', '金額'],
        refunded: ['amount refunded', '返金額', '返金済み金額'],
        currency: ['currency', '通貨'],
        status: ['status', 'ステータス'],
        customerId: ['customer id', '顧客 id'],
        customerEmail: ['customer email', '顧客のメールアドレス', '顧客メール']
      },
      date: 'date',
      needAny: [],
      required: ['amount']
    },
    metrics: {}
  },
  canonical: {
    channel: 'other',
    header: { columns: CANONICAL_COLUMNS, date: 'date', needAny: METRIC_KEYS, required: ['channel'] },
    metrics: Object.fromEntries(METRIC_KEYS.map((k) => [k, k]))
  }
}

// ---------------------------------------------------------------- CSV の読み取り

type Cell = (key: string) => string

/** 行を組む（null は問題を出して捨てた、'skip' は数えずに飛ばす） */
type BuildRow = (row: CsvRow, cell: Cell, date: string) => MetricRow | 'skip' | null

/** CSV の表を元に合わせて読み、ctx に足す */
export function readCsvSource(table: CsvTable, ctx: ImportContext): void {
  const spec = SOURCE_SPECS[ctx.source]
  const header = findHeader(table.rows, spec.header)
  if (!header.ok) {
    addIssue(ctx, header.line, header.code, header.detail)
    return
  }
  ctx.skipped += header.index
  const build = builderFor(spec, header, ctx)
  const dateCol = header.columns[spec.header.date]
  const dateAliases = new Set(spec.header.columns[spec.header.date].map(normalizeHeader))
  for (let i = header.index + 1; i < table.rows.length; i++) {
    const row = table.rows[i]
    const cell: Cell = (key) => {
      const idx = header.columns[key]
      return idx === undefined ? '' : (row.cells[idx] ?? '').trim()
    }
    if (isBlankRow(row) || (row.cells[0] ?? '').trim().startsWith('#') || row.cells.some(isTotalLabel)) {
      ctx.skipped++
      continue
    }
    const rawDate = (row.cells[dateCol] ?? '').trim()
    if (dateAliases.has(normalizeHeader(rawDate))) {
      // 見出しの繰り返し（GA4 の2つ目の表など）
      ctx.skipped++
      continue
    }
    const date = parseDate(rawDate)
    if (date === null) {
      const filled = row.cells.filter((c) => c.trim() !== '')
      if (filled.length === 1 || (rawDate === '' && onlyNumbers(row, dateCol))) ctx.skipped++
      else addIssue(ctx, row.line, 'badDate', rawDate === '' ? '(empty)' : rawDate)
      continue
    }
    const built = build(row, cell, date)
    if (built === 'skip') ctx.skipped++
    else if (built) ctx.rows.push(built)
  }
}

function onlyNumbers(row: CsvRow, dateCol: number): boolean {
  return row.cells.every((c, i) => {
    if (i === dateCol || c.trim() === '') return true
    const n = parseNumber(c)
    return n.ok
  })
}

function builderFor(spec: SourceSpec, header: Extract<HeaderMatch, { ok: true }>, ctx: ImportContext): BuildRow {
  if (ctx.source === 'support') return supportRow(ctx)
  if (ctx.source === 'stripe') return stripeRow(header, ctx)
  return (row, cell, date) => {
    const values = readMetrics(row, cell, spec.metrics, header, ctx)
    if (values === null) return null
    if (Object.keys(values).length === 0) return 'skip'
    let channel = spec.channel
    if (ctx.source === 'ga4') channel = header.columns.channelGroup === undefined ? 'other' : ga4Channel(cell('channelGroup'))
    if (ctx.source === 'canonical') channel = checkedChannel(cell('channel'), row.line, ctx)
    const out: MetricRow = { date, source: ctx.source, channel, values, file: ctx.file, line: row.line }
    const campaign = cell('campaign')
    if (campaign) out.campaign = clip(campaign, TEXT_MAX)
    if (ctx.source === 'canonical') {
      const customer = cell('customer')
      if (customer) out.customer = customer.includes('@') ? pseudonymizeCustomer(customer) : clip(customer, TEXT_MAX)
      const paymentId = cell('paymentId')
      if (paymentId) out.paymentId = clip(paymentId, TEXT_MAX)
    }
    applyCurrency(out, cell('currency') || moneyHeaderCurrency(header), ctx)
    return out
  }
}

/** 数の列を読む。読めない・負の数なら問題を出して null */
function readMetrics(
  row: CsvRow,
  cell: Cell,
  metrics: Readonly<Record<string, MetricKey>>,
  header: Extract<HeaderMatch, { ok: true }>,
  ctx: ImportContext
): Partial<Record<MetricKey, number>> | null {
  const values: Partial<Record<MetricKey, number>> = {}
  for (const [key, metric] of Object.entries(metrics)) {
    if (header.columns[key] === undefined) continue
    const raw = cell(key)
    const n = parseNumber(raw)
    if (!n.ok || n.percent) {
      addIssue(ctx, row.line, 'badNumber', `${clip(header.names[key] ?? key, 40)}: ${clip(raw)}`)
      return null
    }
    if (n.value === null) continue
    if (n.value < 0 && !SIGNED_METRICS.has(metric)) {
      addIssue(ctx, row.line, 'negative', `${clip(header.names[key] ?? key, 40)}: ${clip(raw)}`)
      return null
    }
    values[metric] = (values[metric] ?? 0) + n.value
  }
  return values
}

/** 金額の列の見出しの括弧の通貨（Meta の "Amount spent (JPY)"） */
function moneyHeaderCurrency(header: Extract<HeaderMatch, { ok: true }>): string {
  return header.currencies.spend ?? header.currencies.revenue ?? header.currencies.amount ?? ''
}

/** 行の通貨を付け、ビジネスの通貨と違えば金額を外して currencyMismatch */
function applyCurrency(row: MetricRow, rawCurrency: string, ctx: ImportContext): void {
  const cur = rawCurrency.normalize('NFKC').trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(cur)) return
  row.currency = cur
  if (cur === ctx.currency) return
  const money = (Object.keys(row.values) as MetricKey[]).filter((k) => MONEY_METRICS.has(k))
  if (money.length === 0) return
  for (const k of money) delete row.values[k]
  addIssue(ctx, row.line, 'currencyMismatch', `${cur} ≠ ${ctx.currency}`)
}

function checkedChannel(raw: string, line: number, ctx: ImportContext): Channel {
  const s = raw.trim()
  if (isChannel(s)) return s
  addIssue(ctx, line, 'badChannel', s === '' ? '(empty)' : s)
  return 'other'
}

function supportRow(ctx: ImportContext): BuildRow {
  return (row, cell, date) => {
    const values: Partial<Record<MetricKey, number>> = isLeadType(cell('type')) ? { leads: 1 } : { tickets: 1 }
    return { date, source: ctx.source, channel: freeChannel(cell('channel')), values, file: ctx.file, line: row.line }
  }
}

/** Stripe の Status: 数えるもの / 返金を引いて数えるもの（ほか: Failed・Canceled・Pending・Uncaptured・Disputed などは数えない） */
const STRIPE_PAID = new Set(['paid', 'succeeded', 'success', '支払い済み', '成功'].map(normalizeHeader))
const STRIPE_REFUNDED = new Set(['refunded', 'partiallyrefunded', 'partialrefund', '返金済み', '一部返金', '一部返金済み'].map(normalizeHeader))

/**
 * 支払い1件 → 1行。revenue = Amount − Amount Refunded（負にしない）。
 * Status が無い・空・Paid / succeeded は数える。Refunded / Partially refunded は返金を引いた残りが 0 より大きいときだけ数える
 * （全額の返金は skipped）。それ以外の Status（失敗・取り消し・保留・未確定・異議申し立て中）は売上に入れず skipped。
 */
function stripeRow(header: Extract<HeaderMatch, { ok: true }>, ctx: ImportContext): BuildRow {
  return (row, cell, date) => {
    const status = normalizeHeader(cell('status'))
    const refundedStatus = STRIPE_REFUNDED.has(status)
    if (status !== '' && !STRIPE_PAID.has(status) && !refundedStatus) return 'skip'
    const amount = parseNumber(cell('amount'))
    if (!amount.ok || amount.percent || amount.value === null) {
      addIssue(ctx, row.line, 'badNumber', `${clip(header.names.amount ?? 'Amount', 40)}: ${clip(cell('amount')) || '(empty)'}`)
      return null
    }
    const refunded = parseNumber(cell('refunded'))
    if (!refunded.ok || refunded.percent) {
      addIssue(ctx, row.line, 'badNumber', `${clip(header.names.refunded ?? 'Amount Refunded', 40)}: ${clip(cell('refunded'))}`)
      return null
    }
    if (amount.value < 0 || (refunded.value ?? 0) < 0) {
      addIssue(ctx, row.line, 'negative', `${clip(cell('amount'))} / ${clip(cell('refunded'))}`)
      return null
    }
    const net = Math.max(0, roundAmount(amount.value - (refunded.value ?? 0)))
    if (net === 0 && ((refunded.value ?? 0) > 0 || refundedStatus)) return 'skip'
    const out: MetricRow = { date, source: ctx.source, channel: 'stripe', values: { revenue: net }, file: ctx.file, line: row.line }
    const id = cell('id')
    if (id) out.paymentId = clip(id, TEXT_MAX)
    const customerId = cell('customerId')
    const email = cell('customerEmail')
    if (customerId) out.customer = clip(customerId, TEXT_MAX)
    else if (email) out.customer = pseudonymizeCustomer(email)
    applyCurrency(out, cell('currency') || moneyHeaderCurrency(header), ctx)
    return out
  }
}

// ---------------------------------------------------------------- 規定の形（JSON）

/**
 * CanonicalFile（JSON）を読む。line は rows の何件目か（1始まり）。
 * source が SOURCE_KINDS の値ならその元の行として扱い（重複の判定も同じ元どうし）、無い・違えば fallback（置いたフォルダの元）。
 * 数は数値（または数として読める文字列）。null は値なし。customer にメールが書いてあれば仮名にする。
 */
export function readCanonicalJson(text: string, ctx: ImportContext, maxRows: number): void {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    addIssue(ctx, null, 'badJson', e instanceof Error ? e.message : undefined)
    return
  }
  if (!isObject(data) || !Array.isArray(data.rows)) {
    addIssue(ctx, null, 'badShape', 'rows')
    return
  }
  if (data.version !== undefined && data.version !== 1) {
    addIssue(ctx, null, 'badShape', `version: ${clip(String(data.version))}`)
    return
  }
  if (data.rows.length > maxRows) {
    addIssue(ctx, null, 'tooManyRows', String(data.rows.length))
    return
  }
  const source: SourceKind = isSourceKind(data.source) ? data.source : ctx.source
  data.rows.forEach((item: unknown, i: number) => {
    const line = i + 1
    if (!isObject(item)) {
      addIssue(ctx, line, 'badShape', `rows[${i}]`)
      return
    }
    const date = typeof item.date === 'string' ? parseDate(item.date) : null
    if (date === null) {
      addIssue(ctx, line, 'badDate', item.date === undefined ? '(empty)' : clip(String(item.date)))
      return
    }
    const values: Partial<Record<MetricKey, number>> = {}
    for (const key of METRIC_KEYS) {
      const v = item[key]
      if (v === undefined || v === null) continue
      let n: number | null
      if (typeof v === 'number') n = Number.isFinite(v) ? v : null
      else if (typeof v === 'string') {
        const p = parseNumber(v)
        if (!p.ok || p.percent) {
          addIssue(ctx, line, 'badNumber', `${key}: ${clip(v)}`)
          return
        }
        n = p.value
      } else {
        addIssue(ctx, line, 'badNumber', `${key}: ${clip(JSON.stringify(v) ?? '')}`)
        return
      }
      if (n === null) continue
      if (n < 0 && !SIGNED_METRICS.has(key)) {
        addIssue(ctx, line, 'negative', `${key}: ${n}`)
        return
      }
      values[key] = n
    }
    if (Object.keys(values).length === 0) {
      ctx.skipped++
      return
    }
    const channel = checkedChannel(typeof item.channel === 'string' ? item.channel : '', line, ctx)
    const out: MetricRow = { date, source, channel, values, file: ctx.file, line }
    if (typeof item.campaign === 'string' && item.campaign.trim()) out.campaign = clip(item.campaign.trim(), TEXT_MAX)
    if (typeof item.customer === 'string' && item.customer.trim()) {
      const c = item.customer.trim()
      out.customer = c.includes('@') ? pseudonymizeCustomer(c) : clip(c, TEXT_MAX)
    }
    if (typeof item.paymentId === 'string' && item.paymentId.trim()) out.paymentId = clip(item.paymentId.trim(), TEXT_MAX)
    applyCurrency(out, typeof item.currency === 'string' ? item.currency : '', ctx)
    ctx.rows.push(out)
  })
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
