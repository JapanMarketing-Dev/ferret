/**
 * ビジネスのフォルダの JSON の読み取り（純粋）。venture.json・guardrails.json・approvals/requests.json・log/external.json・streams/*。
 *
 * どれも `{ value, issues }` を返す。value は model.ts の型どおりの値だけ:
 * - テキストが null（ファイルが無い）→ 既定の値、issues なし
 * - 壊れた JSON・形の違う全体 → 既定の値（config は null、ほかは空）と issue
 * - 形の違う要素 → 捨てて issue、id の重複 → 後を捨てて issue、enum の違う値 → 要素の必須の欄なら要素ごと、任意の欄なら欄だけ捨てる
 * - 文字列は長さの上限で切る（切ったことは issue にしない）。前後の空白は id だけ外す
 *
 * issue は短い英語の印（画面は件数と中身をそのまま出す）: "badJson"、"badShape"、"requests[2]: kind"、"requests[3]: duplicate id A001"。
 */
import { APPROVAL_KINDS, CHANNELS, CHECK_CATEGORIES, DEFAULT_LTV_MONTHS, FUNNEL_STAGES, MEMBER_ROLES } from './model'
import type {
  AdCampaign, ApprovalRequest, BudgetCap, CanonicalFile, CheckItem, CheckResult, ContentItem, ExternalAction, FunnelStage, GuardrailsFile,
  ImageRequest, SatisfactionResponse, StreamRecords, SupportTicket, VentureConfig, VentureMember
} from './model'

export interface Parsed<T> {
  value: T
  issues: string[]
}

/** 文字列の上限 */
export const RECORD_TEXT_LIMITS = { id: 40, name: 200, text: 2000, detail: 20000, url: 2000, path: 1000, date: 40 } as const
/** 1ファイルの要素の上限（超えた分は捨てて issue） */
export const RECORD_MAX_ITEMS = 10_000

// ---------------------------------------------------------------- 欄の読み取り

type Obj = Record<string, unknown>

type Field =
  | { t: 'str'; max: number; req?: boolean; def?: string; id?: boolean }
  | { t: 'enum'; values: readonly string[]; req?: boolean }
  | { t: 'num'; min?: number; max?: number; req?: boolean }
  | { t: 'strs'; max: number }

type Schema = Readonly<Record<string, Field>>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function cut(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s
}

/**
 * schema どおりに1要素を読む。必須の欄が無い・違えば null。任意の欄の違う値は捨てる（issue）。
 * str の req は空でない文字列、def は無いときの既定（空でもよい）。
 */
function readFields(v: unknown, schema: Schema, at: string, issues: string[]): Obj | null {
  if (!isObj(v)) {
    issues.push(`${at}: badShape`)
    return null
  }
  const out: Obj = {}
  for (const [key, f] of Object.entries(schema)) {
    const x = v[key]
    const missing = x === undefined || x === null
    if (f.t === 'str') {
      if (typeof x === 'string' && x.trim() !== '') {
        out[key] = cut(f.id ? x.trim() : x, f.max)
        continue
      }
      if (f.req) {
        issues.push(`${at}: ${key}`)
        return null
      }
      if (!missing && !(typeof x === 'string')) issues.push(`${at}: ${key}`)
      if (f.def !== undefined) out[key] = f.def
      continue
    }
    if (f.t === 'enum') {
      if (typeof x === 'string' && f.values.includes(x)) {
        out[key] = x
        continue
      }
      if (f.req) {
        issues.push(`${at}: ${key}`)
        return null
      }
      if (!missing) issues.push(`${at}: ${key}`)
      continue
    }
    if (f.t === 'num') {
      if (typeof x === 'number' && Number.isFinite(x) && (f.min === undefined || x >= f.min) && (f.max === undefined || x <= f.max)) {
        out[key] = x
        continue
      }
      if (f.req) {
        issues.push(`${at}: ${key}`)
        return null
      }
      if (!missing) issues.push(`${at}: ${key}`)
      continue
    }
    // strs
    if (missing) continue
    if (!Array.isArray(x)) {
      issues.push(`${at}: ${key}`)
      continue
    }
    const list = x.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => cut(s.trim(), f.max))
    if (list.length !== x.length) issues.push(`${at}: ${key}`)
    out[key] = [...new Set(list)]
  }
  return out
}

/** JSON のテキスト → 全体のオブジェクト。null のテキストは undefined（ファイルが無い） */
function parseRoot(text: string | null, issues: string[]): Obj | null | undefined {
  if (text === null) return undefined
  let data: unknown
  try {
    data = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    issues.push('badJson')
    return null
  }
  if (!isObj(data)) {
    issues.push('badShape')
    return null
  }
  return data
}

/** { "<key>": [...] } の配列を schema で読み、id の重複は後を捨てる */
function readList<T>(text: string | null, key: string, schema: Schema, idKey: string | null, issues: string[], check?: (o: Obj, at: string) => Obj | null): T[] {
  const root = parseRoot(text, issues)
  return root ? readArray<T>(root[key], key, schema, idKey, issues, check) : []
}

function readArray<T>(list: unknown, key: string, schema: Schema, idKey: string | null, issues: string[], check?: (o: Obj, at: string) => Obj | null): T[] {
  if (list === undefined || list === null) return []
  if (!Array.isArray(list)) {
    issues.push(`${key}: badShape`)
    return []
  }
  const out: T[] = []
  const seen = new Set<string>()
  list.forEach((item: unknown, i: number) => {
    const at = `${key}[${i}]`
    if (i >= RECORD_MAX_ITEMS) {
      if (i === RECORD_MAX_ITEMS) issues.push(`${key}: tooMany`)
      return
    }
    let o = readFields(item, schema, at, issues)
    if (o && check) o = check(o, at)
    if (!o) return
    if (idKey) {
      const id = String(o[idKey])
      if (seen.has(id)) {
        issues.push(`${at}: duplicate id ${cut(id, RECORD_TEXT_LIMITS.id)}`)
        return
      }
      seen.add(id)
    }
    out.push(o as T)
  })
  return out
}

const L = RECORD_TEXT_LIMITS

// ---------------------------------------------------------------- venture.json

const MEMBER: Schema = { role: { t: 'enum', values: MEMBER_ROLES, req: true }, folder: { t: 'str', max: L.path, req: true }, projectId: { t: 'str', max: L.id * 4 } }

/** venture.json。無い・壊れていれば null。欄の違う値は既定に戻して issue（通貨は JPY、継続月数は DEFAULT_LTV_MONTHS） */
export function parseVentureConfig(text: string | null): Parsed<VentureConfig | null> {
  const issues: string[] = []
  const root = parseRoot(text, issues)
  if (!root) return { value: null, issues }
  if (root.version !== undefined && root.version !== 1) {
    issues.push('version')
    return { value: null, issues }
  }
  const name = typeof root.name === 'string' ? cut(root.name.trim(), L.name) : ''
  if (name === '') issues.push('name')
  const createdAt = typeof root.createdAt === 'string' ? cut(root.createdAt, L.date) : ''
  if (root.createdAt !== undefined && typeof root.createdAt !== 'string') issues.push('createdAt')
  let currency = 'JPY'
  if (typeof root.currency === 'string' && /^[A-Za-z]{3}$/.test(root.currency.trim())) currency = root.currency.trim().toUpperCase()
  else if (root.currency !== undefined) issues.push('currency')

  const members: VentureMember[] = []
  if (Array.isArray(root.members)) {
    const seen = new Set<string>()
    root.members.forEach((m: unknown, i: number) => {
      const o = readFields(m, MEMBER, `members[${i}]`, issues)
      if (!o) return
      const key = `${o.role}\u0000${o.folder}`
      if (seen.has(key)) {
        issues.push(`members[${i}]: duplicate`)
        return
      }
      seen.add(key)
      members.push(o as unknown as VentureMember)
    })
  } else if (root.members !== undefined) issues.push('members')

  const eco = isObj(root.economics) ? root.economics : {}
  if (root.economics !== undefined && !isObj(root.economics)) issues.push('economics')
  let marginRate: number | null = null
  if (typeof eco.marginRate === 'number' && Number.isFinite(eco.marginRate) && eco.marginRate >= 0 && eco.marginRate <= 1) marginRate = eco.marginRate
  else if (eco.marginRate !== undefined && eco.marginRate !== null) issues.push('economics.marginRate')
  let ltvMonths: number[] = [...DEFAULT_LTV_MONTHS]
  if (Array.isArray(eco.ltvMonths)) {
    const ok = eco.ltvMonths.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 600)
    if (ok.length !== eco.ltvMonths.length) issues.push('economics.ltvMonths')
    if (ok.length > 0) ltvMonths = [...new Set(ok)]
  } else if (eco.ltvMonths !== undefined) issues.push('economics.ltvMonths')
  let monthlyRevenuePerCustomer: number | null = null
  const arpa = eco.monthlyRevenuePerCustomer
  if (typeof arpa === 'number' && Number.isFinite(arpa) && arpa >= 0) monthlyRevenuePerCustomer = arpa
  else if (arpa !== undefined && arpa !== null) issues.push('economics.monthlyRevenuePerCustomer')

  const value: VentureConfig = { version: 1, name, createdAt, currency, members, economics: { marginRate, ltvMonths, monthlyRevenuePerCustomer } }
  if (isObj(root.funnelTargets)) {
    const targets: Partial<Record<FunnelStage, number>> = {}
    for (const [k, v] of Object.entries(root.funnelTargets)) {
      if ((FUNNEL_STAGES as readonly string[]).includes(k) && typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) targets[k as FunnelStage] = v
      else issues.push(`funnelTargets.${cut(k, L.id)}`)
    }
    if (Object.keys(targets).length > 0) value.funnelTargets = targets
  } else if (root.funnelTargets !== undefined) issues.push('funnelTargets')
  return { value, issues }
}

// ---------------------------------------------------------------- guardrails.json

const CHECK_ITEM: Schema = {
  id: { t: 'str', max: L.id, req: true, id: true },
  category: { t: 'enum', values: CHECK_CATEGORIES, req: true },
  text: { t: 'str', max: L.text, req: true }
}

/** guardrails.json。予算は経路（CHANNELS か '*'）ごとに1つ（重複は後を捨てる）、daily・monthly は 0 以上の数か null */
export function parseGuardrails(text: string | null): Parsed<GuardrailsFile> {
  const issues: string[] = []
  const empty: GuardrailsFile = { version: 1, budgets: [], checks: [] }
  const root = parseRoot(text, issues)
  if (!root) return { value: empty, issues }
  if (root.version !== undefined && root.version !== 1) {
    issues.push('version')
    return { value: empty, issues }
  }
  const budgets: BudgetCap[] = []
  if (Array.isArray(root.budgets)) {
    const seen = new Set<string>()
    root.budgets.forEach((b: unknown, i: number) => {
      const at = `budgets[${i}]`
      if (!isObj(b) || typeof b.channel !== 'string' || !(b.channel === '*' || (CHANNELS as readonly string[]).includes(b.channel))) {
        issues.push(`${at}: ${isObj(b) ? 'channel' : 'badShape'}`)
        return
      }
      const cap = (v: unknown, key: string): number | null => {
        if (v === undefined || v === null) return null
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
        issues.push(`${at}: ${key}`)
        return null
      }
      if (seen.has(b.channel)) {
        issues.push(`${at}: duplicate channel ${b.channel}`)
        return
      }
      seen.add(b.channel)
      budgets.push({ channel: b.channel as BudgetCap['channel'], daily: cap(b.daily, 'daily'), monthly: cap(b.monthly, 'monthly') })
    })
  } else if (root.budgets !== undefined) issues.push('budgets: badShape')
  const checks = readArray<CheckItem>(root.checks, 'checks', CHECK_ITEM, 'id', issues)
  return { value: { version: 1, budgets, checks }, issues }
}

// ---------------------------------------------------------------- approvals/requests.json・log/external.json

const APPROVAL: Schema = {
  id: { t: 'str', max: L.id, req: true, id: true },
  kind: { t: 'enum', values: APPROVAL_KINDS, req: true },
  title: { t: 'str', max: L.name, req: true },
  detail: { t: 'str', max: L.detail, def: '' },
  refs: { t: 'strs', max: L.id },
  createdAt: { t: 'str', max: L.date, def: '' },
  by: { t: 'enum', values: ['agent', 'human'] }
}

/** approvals/requests.json（{ "requests": [...] }）。ファイルの status・decidedAt・answer は読まない・返さない（正本は台帳） */
export function parseApprovals(text: string | null): Parsed<ApprovalRequest[]> {
  const issues: string[] = []
  const value = readList<ApprovalRequest>(text, 'requests', APPROVAL, 'id', issues, (o) => ({ ...o, refs: o.refs ?? [] }))
  return { value, issues }
}

const EXTERNAL: Schema = {
  at: { t: 'str', max: L.date, req: true },
  kind: { t: 'enum', values: APPROVAL_KINDS, req: true },
  approvalId: { t: 'str', max: L.id, id: true },
  summary: { t: 'str', max: L.text, req: true },
  result: { t: 'str', max: L.text },
  url: { t: 'str', max: L.url },
  via: { t: 'enum', values: ['agent', 'human', 'ferret'] }
}

/** log/external.json（{ "actions": [...] }）。id は無いので重複は除かない */
export function parseExternalLog(text: string | null): Parsed<ExternalAction[]> {
  const issues: string[] = []
  return { value: readList<ExternalAction>(text, 'actions', EXTERNAL, null, issues), issues }
}

// ---------------------------------------------------------------- streams/*

export type StreamFileKind = keyof StreamRecords

/**
 * 業務ごとの記録のファイルの形（どれも { "<鍵>": [...] }）:
 * ads `{ "campaigns": [...] }`（streams/ads/campaigns.json）・content `{ "items": [...] }`（streams/content/calendar.json）・
 * images `{ "items": [...] }`（streams/images/requests.json）・support `{ "tickets": [...] }`（streams/support/tickets.json）・
 * satisfaction `{ "responses": [...] }`（streams/satisfaction/responses.json）・checks `{ "results": [...] }`（streams/checks/results.json）
 */
export const STREAM_FILE_KEYS = {
  ads: 'campaigns',
  content: 'items',
  images: 'items',
  support: 'tickets',
  satisfaction: 'responses',
  checks: 'results'
} as const satisfies Record<StreamFileKind, string>

const ID: Field = { t: 'str', max: L.id, req: true, id: true }
const APPROVAL_ID: Field = { t: 'str', max: L.id, id: true }

const STREAM_SCHEMAS: Record<StreamFileKind, Schema> = {
  ads: {
    id: ID,
    channel: { t: 'enum', values: CHANNELS, req: true },
    name: { t: 'str', max: L.name, req: true },
    status: { t: 'enum', values: ['planned', 'draft', 'awaitingApproval', 'running', 'paused', 'ended'] satisfies AdCampaign['status'][], req: true },
    dailyBudget: { t: 'num', min: 0 },
    landingUrl: { t: 'str', max: L.url },
    approvalId: APPROVAL_ID,
    note: { t: 'str', max: L.text }
  },
  content: {
    id: ID,
    channel: { t: 'enum', values: ['x', 'blog', 'youtube', 'tiktok', 'note', 'instagram', 'other'] satisfies ContentItem['channel'][], req: true },
    title: { t: 'str', max: L.name, req: true },
    status: { t: 'enum', values: ['idea', 'draft', 'review', 'approved', 'posted'] satisfies ContentItem['status'][], req: true },
    due: { t: 'str', max: L.date },
    file: { t: 'str', max: L.path },
    url: { t: 'str', max: L.url },
    approvalId: APPROVAL_ID
  },
  images: {
    id: ID,
    purpose: { t: 'str', max: L.name, def: '' },
    prompt: { t: 'str', max: L.detail, def: '' },
    status: { t: 'enum', values: ['requested', 'generated', 'approved', 'rejected'] satisfies ImageRequest['status'][], req: true },
    output: { t: 'str', max: L.path },
    usage: { t: 'str', max: L.text }
  },
  support: {
    id: ID,
    receivedAt: { t: 'str', max: L.date, def: '' },
    channel: { t: 'str', max: L.id, def: '' },
    customer: { t: 'str', max: L.name, def: '' },
    subject: { t: 'str', max: L.name, def: '' },
    summary: { t: 'str', max: L.text, def: '' },
    kind: { t: 'enum', values: ['inquiry', 'support', 'complaint', 'other'] satisfies SupportTicket['kind'][], req: true },
    status: { t: 'enum', values: ['open', 'drafted', 'awaitingApproval', 'replied', 'closed'] satisfies SupportTicket['status'][], req: true },
    draft: { t: 'str', max: L.path },
    approvalId: APPROVAL_ID
  },
  satisfaction: {
    id: ID,
    date: { t: 'str', max: L.date, req: true },
    method: { t: 'enum', values: ['nps', 'csat', 'survey', 'interview'] satisfies SatisfactionResponse['method'][], req: true },
    score: { t: 'num' },
    comment: { t: 'str', max: L.text },
    segment: { t: 'str', max: L.name },
    tags: { t: 'strs', max: L.id * 2 }
  },
  checks: {
    id: ID,
    target: { t: 'str', max: L.url, req: true },
    checkId: { t: 'str', max: L.id, req: true, id: true },
    result: { t: 'enum', values: ['pass', 'fail', 'na'] satisfies CheckResult['result'][], req: true },
    note: { t: 'str', max: L.text },
    checkedAt: { t: 'str', max: L.date, def: '' }
  }
}

/** 点数の幅: nps は 0〜10 の整数、csat は 1〜5。違えば score だけ捨てる（survey・interview は数ならそのまま） */
function checkScore(o: Obj, at: string, issues: string[]): Obj {
  if (o.score === undefined) return o
  const s = o.score as number
  const ok = o.method === 'nps' ? Number.isInteger(s) && s >= 0 && s <= 10 : o.method === 'csat' ? s >= 1 && s <= 5 : true
  if (ok) return o
  issues.push(`${at}: score`)
  const rest = { ...o }
  delete rest.score
  return rest
}

/** 業務ごとの記録のファイル（形は STREAM_FILE_KEYS）。無い・壊れていれば空 */
export function parseStreamFile<K extends StreamFileKind>(kind: K, text: string | null): Parsed<StreamRecords[K]> {
  const issues: string[] = []
  const check = kind === 'satisfaction' ? (o: Obj, at: string) => checkScore(o, at, issues) : undefined
  const value = readList<StreamRecords[K][number]>(text, STREAM_FILE_KEYS[kind], STREAM_SCHEMAS[kind], 'id', issues, check)
  return { value: value as StreamRecords[K], issues }
}

// ---------------------------------------------------------------- 書き出し・id

/** JSON のテキスト（2スペース・末尾改行） */
export function toJsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** 次の id（prefix に続く数の最大の次。A001・A002 → A003。無ければ 1。width で0埋め、超えたら桁を増やす） */
export function nextRecordId(prefix: string, ids: readonly string[], width: number): string {
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`)
  let max = 0
  for (const id of ids) {
    const m = re.exec(id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `${prefix}${String(max + 1).padStart(Math.max(0, width), '0')}`
}

/** 規定の形（data/agent/*.json）の最小の例。依頼文と画面の見本に使う */
export const CANONICAL_EXAMPLE: CanonicalFile = {
  version: 1,
  source: 'canonical',
  fetchedAt: '2026-10-01T09:00:00+09:00',
  method: 'X のアナリティクスの画面から日別の数を書き写した',
  rows: [
    { date: '2026-09-30', channel: 'x', impressions: 1200, clicks: 30, followers: 4 },
    { date: '2026-09-30', channel: 'stripe', paymentId: 'ch_example', customer: 'cus_example', currency: 'JPY', revenue: 9800 }
  ]
}
