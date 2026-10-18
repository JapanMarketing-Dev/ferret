/**
 * ビジネスリサーチの記録の空の形と、読み込んだ値を型へ寄せる処理（coerce）と、保存の前の検査（validate）。
 * ファイルは人も Agent も手で書くので、型が違う・欠けている値があっても落とさず、既定へ寄せて「直したこと」（fixes）を返す。
 * - 数の未確認は null（0 にしない）。数として読めない値は null にして知らせる。負・範囲の外の数は寄せずに残し、検査（validate）で止める
 * - 直したこと・検査の結果は i18n のキー（research.issue.<code>）と差し込む値で返す（文は main・画面が引く）
 * - 日時は引数で受け取る（ここで Date.now を呼ばない）
 */
import {
  BEHAVIOR_LEVELS,
  CANDIDATE_STAGES,
  CHANNELS,
  CONDITION_KEYS,
  CONDITION_STATUSES,
  CHANNEL_AXES,
  COMPARISON_METHODS,
  CUSTOMER_STATES,
  DEFAULT_CUTOFFS,
  DEFAULT_FUNNEL_TARGETS,
  DEFAULT_WEIGHTS,
  DEMAND_FACTORS,
  DEMAND_LEVELS,
  DIFFERENTIATORS,
  EVIDENCE_GRADES,
  EVIDENCE_KINDS,
  EVIDENCE_STATES,
  EXECUTION_KEYS,
  EXPERIMENT_METHODS,
  EXPERIMENT_STATUSES,
  FUNNEL_STAGES,
  GATE_IDS,
  GATE_STATUSES,
  GRADE_RELIABILITY,
  METRIC_KEYS,
  MONETIZATION_SIDES,
  NEXT_DECISIONS,
  ORDER_SCENES,
  PRINCIPLE_KEYS,
  PROBLEM_TYPES,
  READING_KEYS,
  READING_LEVELS,
  ROLE_KEYS,
  SCENE_KEYS,
  SCORE_KEYS,
  SEGMENT_AXES,
  TRIGGER_KINDS,
  WHO_CONDITIONS,
  WHY_RESEARCH_ITEMS,
  isResearchId,
  type Candidate,
  type ChannelPlan,
  type ConditionRow,
  type ExecutionItem,
  type ExistingService,
  type ExperimentMetrics,
  type GateDecision,
  type GateId,
  type Maybe,
  type Monetization,
  type PurchaseScene,
  type ResearchData,
  type ResearchEvidence,
  type ResearchExperiment,
  type ResearchFile,
  type ResearchRecordKind,
  type ResearchRecordTypes,
  type RoleEntry,
  type Score,
  type ScoreEntry,
  type SearchKeyword,
  type TargetCompany,
  type TriggerEvent
} from './model'
import type { ResearchIssue } from './ipc'

/** 1つの文の長さの上限（巨大なファイルで画面を止めない） */
export const MAX_TEXT = 20_000
/** 一覧の件数の上限（企業の一覧だけ別） */
export const MAX_LIST = 200
export const MAX_COMPANIES = 1000
/** 数の上限（これより大きい値は数として読まない） */
export const MAX_NUMBER = 1e12
/** 継続月数の仮定の上限（50 年） */
export const MAX_RETENTION_MONTHS = 600

// ================================================================ 空の形

export function emptyResearch(name: string, now: string): ResearchFile {
  return {
    name,
    scope: '',
    weights: { ...DEFAULT_WEIGHTS },
    cutoffs: { ...DEFAULT_CUTOFFS },
    funnelTargets: { ...DEFAULT_FUNNEL_TARGETS },
    minTargetCount: 100,
    createdAt: now
  }
}

export function emptyScoreEntry(): ScoreEntry {
  return { score: null, evidence: [], reason: '' }
}

export function emptyGate(): GateDecision {
  return { status: 'pending', note: '', at: '' }
}

export function emptyMetrics(): ExperimentMetrics {
  return Object.fromEntries(METRIC_KEYS.map((k) => [k, null])) as ExperimentMetrics
}

/** 試算する有料化率の初期値（ナレッジの例: 0.5%・2%・5%） */
export const DEFAULT_CONVERSION_SCENARIOS: readonly number[] = [0.005, 0.02, 0.05]

export function emptyScene(): PurchaseScene {
  return { company: '', who: '', event: '', outcome: '', currentHandling: '' }
}

export function emptyConditionRow(): ConditionRow {
  return { support: [], counter: [], supportNote: '', counterNote: '', unknown: '', next: '', status: 'unverified' }
}

export function emptyRole(): RoleEntry {
  return { title: '', confirmedAuthority: '', evidence: [] }
}

export function emptyMonetization(): Monetization {
  return { side: 'unknown', orderScene: 'unknown', freeToPaidPath: '', months: null, marginPerDeal: null, costPerFreeUser: null, conversionScenarios: [...DEFAULT_CONVERSION_SCENARIOS] }
}

export function emptyExecutionItem(): ExecutionItem {
  return { plan: '', confirmed: false }
}

const fill = <K extends string, V>(keys: readonly K[], make: () => V): Record<K, V> => Object.fromEntries(keys.map((k) => [k, make()])) as Record<K, V>

export function emptyCandidate(id: string, now: string): Candidate {
  return {
    id,
    title: '',
    market: '',
    problem: '',
    customer: '',
    existingServices: [],
    aiFit: '',
    scene: emptyScene(),
    conditions: fill(CONDITION_KEYS, emptyConditionRow),
    roles: fill(ROLE_KEYS, emptyRole),
    deliverable: '',
    monetization: emptyMonetization(),
    execution: fill(EXECUTION_KEYS, emptyExecutionItem),
    decision: null,
    who: {
      segment: fill(SEGMENT_AXES, () => ''),
      companies: [],
      targetCount: null,
      targetListSource: '',
      conditions: fill(WHO_CONDITIONS, () => null)
    },
    what: {
      jtbd: { surface: '', job: '', purpose: '' },
      factors: fill(DEMAND_FACTORS, () => null),
      problemType: 'unknown',
      demandLevel: 'unknown',
      quantification: { hoursPerMonth: null, hourlyCost: null, reductionRate: null, cashSpendMonthly: null, opportunityMonthly: null },
      improvement: ''
    },
    where: { channels: [], triggers: [], keywords: [], mentalAvailability: '', physicalAvailability: '', summary: '' },
    why: {
      switching: { expectedValue: null, adoptionCost: null, switchingRisk: null, statusQuoValue: null, coexists: null },
      differentiators: [],
      findings: fill(WHY_RESEARCH_ITEMS, () => ''),
      reason: '',
      reasonEvidence: []
    },
    how: { monthlyPrice: null, marginRate: null, retentionScenarios: [6, 12, 24, 36], estimatedCac: null, cacBasis: '', automation: '' },
    stage: 'discovered',
    scores: fill(SCORE_KEYS, emptyScoreEntry),
    gates: fill(GATE_IDS, emptyGate),
    dropReason: '',
    promotedTo: null,
    createdAt: now,
    updatedAt: now
  }
}

export function emptyEvidence(id: string, now: string): ResearchEvidence {
  return {
    id,
    candidate: '',
    principle: 'what',
    kind: 'other',
    // 種類が分からないうちは一番弱い区分（AI の推測）にしておく。強い区分は人か Agent が根拠を見て付ける
    grade: 'aiInference',
    subject: '',
    problem: '',
    event: '',
    behavior: '',
    behaviorLevel: 'unknown',
    amount: '',
    url: '',
    eventDate: '',
    publishedAt: '',
    publisher: '',
    quote: '',
    checkedAt: now.slice(0, 10),
    source: '',
    fact: '',
    inference: '',
    counter: '',
    unknowns: '',
    dupGroup: '',
    // 収集の工程で書いたもの。読む5観点で評価したら evaluated（別の工程・別の依頼）
    state: 'collected',
    reading: fill(READING_KEYS, () => null)
  }
}

export function emptyExperiment(id: string): ResearchExperiment {
  return {
    id,
    candidate: '',
    principle: 'who',
    method: 'other',
    channel: null,
    hypothesis: '',
    passCondition: '',
    stopCondition: '',
    status: 'planned',
    period: { start: '', end: '' },
    metrics: emptyMetrics(),
    comparison: 'none',
    interviews: null,
    learning: ''
  }
}

export function emptyResearchRecord<K extends ResearchRecordKind>(kind: K, id: string, now: string): ResearchRecordTypes[K] {
  const makers: { [P in ResearchRecordKind]: () => ResearchRecordTypes[P] } = {
    candidate: () => emptyCandidate(id, now),
    evidence: () => emptyEvidence(id, now),
    experiment: () => emptyExperiment(id)
  }
  return makers[kind]() as ResearchRecordTypes[K]
}

// ================================================================ 値を型へ寄せる

/** 寄せたときに直したこと。code は i18n のキー research.issue.<code> */
export interface ResearchFix {
  field: string
  code: string
  params?: Record<string, string | number>
}

export interface Coerced<T> {
  value: T
  fixes: ResearchFix[]
}

const shown = (v: unknown) => String(v).slice(0, 40)

class Coercer {
  constructor(
    private readonly prefix = '',
    readonly fixes: ResearchFix[] = []
  ) {}

  child(field: string): Coercer {
    return new Coercer(this.path(field), this.fixes)
  }

  private path(field: string): string {
    if (!field) return this.prefix
    return this.prefix ? `${this.prefix}.${field}` : field
  }

  note(field: string, code: string, params?: Record<string, string | number>): void {
    this.fixes.push({ field: this.path(field), code, ...(params ? { params } : {}) })
  }

  text(raw: unknown, field: string, fallback = ''): string {
    if (raw === undefined || raw === null) return fallback
    if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
    if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? fallback : raw.toISOString().slice(0, 10)
    if (typeof raw !== 'string') {
      this.note(field, 'fixNotText')
      return fallback
    }
    if (raw.length > MAX_TEXT) {
      this.note(field, 'fixTooLong', { max: MAX_TEXT })
      return raw.slice(0, MAX_TEXT)
    }
    return raw
  }

  oneOf<T extends string>(raw: unknown, field: string, allowed: readonly T[], fallback: T): T {
    if (raw === undefined || raw === null || raw === '') return fallback
    const s = typeof raw === 'string' ? raw.trim() : String(raw)
    if ((allowed as readonly string[]).includes(s)) return s as T
    this.note(field, 'fixBadChoice', { value: shown(s), fallback })
    return fallback
  }

  /** 選べる値か null */
  oneOfOrNull<T extends string>(raw: unknown, field: string, allowed: readonly T[]): T | null {
    if (raw === undefined || raw === null || raw === '') return null
    const s = typeof raw === 'string' ? raw.trim() : String(raw)
    if ((allowed as readonly string[]).includes(s)) return s as T
    this.note(field, 'fixBadChoiceNull', { value: shown(s) })
    return null
  }

  /** 数（未確認は null）。数として読めないものは null にして知らせる。負・範囲の外は残す（検査で止める） */
  num(raw: unknown, field: string): Maybe<number> {
    if (raw === undefined || raw === null || raw === '') return null
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim().replace(/[,，円%]/g, '')) : Number.NaN
    if (!Number.isFinite(n) || Math.abs(n) > MAX_NUMBER) {
      this.note(field, 'fixBadNumber', { value: shown(raw) })
      return null
    }
    return n
  }

  /** 1〜5 の整数の点（未採点は null） */
  score(raw: unknown, field: string): Maybe<Score> {
    if (raw === undefined || raw === null || raw === '') return null
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : Number.NaN
    if (Number.isInteger(n) && n >= 1 && n <= 5) return n as Score
    this.note(field, 'fixBadScore', { value: shown(raw) })
    return null
  }

  boolOrNull(raw: unknown, field: string): Maybe<boolean> {
    if (raw === undefined || raw === null || raw === '') return null
    if (typeof raw === 'boolean') return raw
    if (raw === 'true' || raw === 'yes' || raw === 'はい') return true
    if (raw === 'false' || raw === 'no' || raw === 'いいえ') return false
    this.note(field, 'fixBadBool', { value: shown(raw) })
    return null
  }

  object(raw: unknown, field: string): Record<string, unknown> {
    if (raw === undefined || raw === null) return {}
    if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
    this.note(field, 'fixNotObject')
    return {}
  }

  array(raw: unknown, field: string, max = MAX_LIST): unknown[] {
    if (raw === undefined || raw === null || raw === '') return []
    if (!Array.isArray(raw)) {
      this.note(field, 'fixNotList')
      return []
    }
    if (raw.length > max) this.note(field, 'fixTooMany', { max })
    return raw.slice(0, max)
  }

  /** 文字の一覧（「,」「、」・空白で区切った1つの文字も読む）。valid に合わないものは外し、重複は1つにする */
  ids(raw: unknown, field: string, valid: (v: string) => boolean): string[] {
    if (raw === undefined || raw === null || raw === '') return []
    const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,、\s]+/) : null
    if (!items) {
      this.note(field, 'fixNotList')
      return []
    }
    const out: string[] = []
    for (const item of items.slice(0, MAX_LIST)) {
      const s = typeof item === 'string' || typeof item === 'number' ? String(item).trim() : ''
      if (!s) continue
      if (!valid(s)) {
        this.note(field, 'fixBadItem', { value: shown(s) })
        continue
      }
      if (!out.includes(s)) out.push(s)
    }
    if (items.length > MAX_LIST) this.note(field, 'fixTooMany', { max: MAX_LIST })
    return out
  }
}

const isEvidenceId = (s: string) => isResearchId('evidence', s)
const isCandidateId = (s: string) => isResearchId('candidate', s)

/** 候補・実験が指す ID（形が違えば空にして知らせる） */
function ref(c: Coercer, raw: unknown, field: string, valid: (s: string) => boolean): string {
  const s = c.text(raw, field).trim()
  if (!s) return ''
  if (valid(s)) return s
  c.note(field, 'fixBadItem', { value: shown(s) })
  return ''
}

export function coerceResearch(raw: unknown, fallbackName: string, now: string): Coerced<ResearchFile> {
  const c = new Coercer()
  const o = c.object(raw, '')
  const base = emptyResearch(fallbackName, now)
  const w = c.object(o.weights, 'weights')
  const wc = c.child('weights')
  const weights = { ...base.weights }
  for (const k of SCORE_KEYS) {
    if (w[k] === undefined || w[k] === null) continue
    const n = wc.num(w[k], k)
    if (n === null) continue
    if (n < 0 || n > 100) wc.note(k, 'fixOutOfRange', { min: 0, max: 100 })
    else weights[k] = n
  }
  const cu = c.object(o.cutoffs, 'cutoffs')
  const cc = c.child('cutoffs')
  const cutoffs = { ...base.cutoffs }
  for (const k of SCORE_KEYS) {
    if (!(k in cu)) continue
    if (cu[k] === null || cu[k] === '') {
      cutoffs[k] = null
      continue
    }
    cutoffs[k] = cc.score(cu[k], k)
  }
  const ft = c.object(o.funnelTargets, 'funnelTargets')
  const fc = c.child('funnelTargets')
  const funnelTargets = { ...base.funnelTargets }
  for (const k of FUNNEL_STAGES) {
    const n = fc.num(ft[k], k)
    if (n === null) continue
    if (!Number.isInteger(n) || n < 0) fc.note(k, 'fixOutOfRange', { min: 0, max: MAX_NUMBER })
    else funnelTargets[k] = n
  }
  let minTargetCount = base.minTargetCount
  const m = c.num(o.minTargetCount, 'minTargetCount')
  if (m !== null) {
    if (!Number.isInteger(m) || m < 1) c.note('minTargetCount', 'fixOutOfRange', { min: 1, max: MAX_NUMBER })
    else minTargetCount = m
  }
  return {
    value: {
      name: c.text(o.name, 'name').trim() || base.name,
      scope: c.text(o.scope, 'scope'),
      weights,
      cutoffs,
      funnelTargets,
      minTargetCount,
      createdAt: c.text(o.createdAt, 'createdAt', now) || now
    },
    fixes: c.fixes
  }
}

function scoreEntry(c: Coercer, raw: unknown, field: string): ScoreEntry {
  // 点だけ（reach: 3）でも、まとまり（reach: { score: 3, evidence: [E001], reason: … }）でも読む
  const o = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : { score: raw }
  const sc = c.child(field)
  return { score: sc.score(o.score, 'score'), evidence: sc.ids(o.evidence, 'evidence', isEvidenceId), reason: sc.text(o.reason, 'reason') }
}

function gate(c: Coercer, raw: unknown, field: string): GateDecision {
  const o = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : { status: raw }
  const gc = c.child(field)
  const status = gc.oneOf(o.status, 'status', GATE_STATUSES, 'pending')
  return { status, note: gc.text(o.note, 'note'), at: status === 'pending' ? '' : gc.text(o.at, 'at') }
}

function company(c: Coercer, raw: unknown): TargetCompany {
  const o = c.object(raw, '')
  const t = (f: string) => c.text(o[f], f)
  return {
    company: t('company'), industry: t('industry'), employees: c.num(o.employees, 'employees'), situation: t('situation'),
    inferredProblem: t('inferredProblem'), evidenceUrl: t('evidenceUrl').trim(), buyerRole: t('buyerRole'), reachPath: t('reachPath')
  }
}

function channelPlan(c: Coercer, raw: unknown): ChannelPlan | null {
  const o = c.object(raw, '')
  const channel = c.oneOfOrNull(o.channel, 'channel', CHANNELS)
  if (!channel) return null
  const axes = c.object(o.axes, 'axes')
  const ac = c.child('axes')
  return {
    channel,
    state: c.oneOfOrNull(o.state, 'state', CUSTOMER_STATES),
    axes: Object.fromEntries(CHANNEL_AXES.map((k) => [k, ac.score(axes[k], k)])) as ChannelPlan['axes'],
    note: c.text(o.note, 'note')
  }
}

function trigger(c: Coercer, raw: unknown): TriggerEvent {
  const o = c.object(raw, '')
  return {
    kind: c.oneOf(o.kind, 'kind', TRIGGER_KINDS, 'other'), company: c.text(o.company, 'company'), url: c.text(o.url, 'url').trim(),
    observedAt: c.text(o.observedAt, 'observedAt').trim(), note: c.text(o.note, 'note')
  }
}

function keyword(c: Coercer, raw: unknown): SearchKeyword {
  const o = c.object(raw, '')
  return {
    keyword: c.text(o.keyword, 'keyword'), volume: c.num(o.volume, 'volume'),
    intent: c.oneOf(o.intent, 'intent', ['info', 'purchase', 'unknown'] as const, 'unknown'), competitors: c.text(o.competitors, 'competitors'),
    ads: c.boolOrNull(o.ads, 'ads'), enterable: c.boolOrNull(o.enterable, 'enterable')
  }
}

function list<T>(c: Coercer, raw: unknown, field: string, item: (c: Coercer, raw: unknown) => T | null, max = MAX_LIST): T[] {
  const out: T[] = []
  c.array(raw, field, max).forEach((r, i) => {
    const v = item(c.child(`${field}[${i}]`), r)
    if (v !== null) out.push(v)
  })
  return out
}

function scene(c: Coercer, raw: unknown): PurchaseScene {
  const o = c.object(raw, 'scene')
  const sc = c.child('scene')
  return Object.fromEntries(SCENE_KEYS.map((k) => [k, sc.text(o[k], k)])) as unknown as PurchaseScene
}

function conditionRows(c: Coercer, raw: unknown): Candidate['conditions'] {
  const o = c.object(raw, 'conditions')
  return Object.fromEntries(CONDITION_KEYS.map((k) => {
    const rc = c.child(`conditions.${k}`)
    const r = rc.object(o[k], '')
    const row: ConditionRow = {
      support: rc.ids(r.support, 'support', isEvidenceId), counter: rc.ids(r.counter, 'counter', isEvidenceId),
      supportNote: rc.text(r.supportNote, 'supportNote'), counterNote: rc.text(r.counterNote, 'counterNote'),
      unknown: rc.text(r.unknown, 'unknown'), next: rc.text(r.next, 'next'),
      status: rc.oneOf(r.status, 'status', CONDITION_STATUSES, 'unverified')
    }
    return [k, row]
  })) as Candidate['conditions']
}

function roles(c: Coercer, raw: unknown): Candidate['roles'] {
  const o = c.object(raw, 'roles')
  return Object.fromEntries(ROLE_KEYS.map((k) => {
    const rc = c.child(`roles.${k}`)
    // 役職だけ（user: 経理担当）の書き方も読む
    const r = typeof o[k] === 'string' ? { title: o[k] } : rc.object(o[k], '')
    const role: RoleEntry = { title: rc.text(r.title, 'title'), confirmedAuthority: rc.text(r.confirmedAuthority, 'confirmedAuthority'), evidence: rc.ids(r.evidence, 'evidence', isEvidenceId) }
    return [k, role]
  })) as Candidate['roles']
}

function monetization(c: Coercer, raw: unknown): Monetization {
  const o = c.object(raw, 'monetization')
  const mc = c.child('monetization')
  const base = emptyMonetization()
  return {
    side: mc.oneOf(o.side, 'side', MONETIZATION_SIDES, 'unknown'),
    orderScene: mc.oneOf(o.orderScene, 'orderScene', ORDER_SCENES, 'unknown'),
    freeToPaidPath: mc.text(o.freeToPaidPath, 'freeToPaidPath'),
    months: mc.num(o.months, 'months'),
    marginPerDeal: mc.num(o.marginPerDeal, 'marginPerDeal'),
    costPerFreeUser: mc.num(o.costPerFreeUser, 'costPerFreeUser'),
    conversionScenarios: o.conversionScenarios === undefined
      ? base.conversionScenarios
      : mc.array(o.conversionScenarios, 'conversionScenarios', 20).map((v, i) => mc.num(v, `conversionScenarios[${i}]`)).filter((v): v is number => v !== null)
  }
}

/** 実行条件の4点（ビジネスの business.yaml の execution も同じ形。決める内容だけの書き方も読む） */
export function coerceExecution(raw: unknown, field = 'execution'): Coerced<Record<(typeof EXECUTION_KEYS)[number], ExecutionItem>> {
  const c = new Coercer()
  return { value: execution(c, raw, field), fixes: c.fixes }
}

function execution(c: Coercer, raw: unknown, field: string): Record<(typeof EXECUTION_KEYS)[number], ExecutionItem> {
  const o = c.object(raw, field)
  return Object.fromEntries(EXECUTION_KEYS.map((k) => {
    const ec = c.child(`${field}.${k}`)
    const r = typeof o[k] === 'string' ? { plan: o[k] } : ec.object(o[k], '')
    const item: ExecutionItem = { plan: ec.text(r.plan, 'plan'), confirmed: ec.boolOrNull(r.confirmed, 'confirmed') === true }
    return [k, item]
  })) as Record<(typeof EXECUTION_KEYS)[number], ExecutionItem>
}

function coerceCandidate(c: Coercer, o: Record<string, unknown>, id: string, now: string): Candidate {
  const base = emptyCandidate(id, now)
  const t = (f: string) => c.text(o[f], f)

  const who = c.object(o.who, 'who')
  const whc = c.child('who')
  const seg = whc.object(who.segment, 'segment')
  const segc = whc.child('segment')
  const cond = whc.object(who.conditions, 'conditions')
  const condc = whc.child('conditions')

  const what = c.object(o.what, 'what')
  const wac = c.child('what')
  const jtbd = wac.object(what.jtbd, 'jtbd')
  const jc = wac.child('jtbd')
  const factors = wac.object(what.factors, 'factors')
  const fc = wac.child('factors')
  const q = wac.object(what.quantification, 'quantification')
  const qc = wac.child('quantification')

  const where = c.object(o.where, 'where')
  const wec = c.child('where')

  const why = c.object(o.why, 'why')
  const wyc = c.child('why')
  const sw = wyc.object(why.switching, 'switching')
  const swc = wyc.child('switching')
  const findings = wyc.object(why.findings, 'findings')
  const fic = wyc.child('findings')

  const how = c.object(o.how, 'how')
  const hc = c.child('how')
  const retention = how.retentionScenarios === undefined
    ? base.how.retentionScenarios
    : hc.array(how.retentionScenarios, 'retentionScenarios', 50).map((v, i) => hc.num(v, `retentionScenarios[${i}]`)).filter((v): v is number => v !== null)

  const scores = c.object(o.scores, 'scores')
  const gates = c.object(o.gates, 'gates')

  const promoted = o.promotedTo === null || o.promotedTo === undefined ? null : c.object(o.promotedTo, 'promotedTo')
  const pc = c.child('promotedTo')
  const promotedTo = promoted && typeof promoted.folder === 'string' && promoted.folder
    ? { folder: pc.text(promoted.folder, 'folder'), projectId: pc.text(promoted.projectId, 'projectId'), at: pc.text(promoted.at, 'at') }
    : null
  if (promoted && !promotedTo) c.note('promotedTo', 'fixNotObject')

  return {
    ...base,
    title: t('title'), market: t('market'), problem: t('problem'), customer: t('customer'),
    existingServices: list(c, o.existingServices, 'existingServices', (ic, r): ExistingService => {
      const s = ic.object(r, '')
      return { name: ic.text(s.name, 'name'), url: ic.text(s.url, 'url').trim(), price: ic.text(s.price, 'price') }
    }),
    aiFit: t('aiFit'),
    scene: scene(c, o.scene),
    conditions: conditionRows(c, o.conditions),
    roles: roles(c, o.roles),
    deliverable: t('deliverable'),
    monetization: monetization(c, o.monetization),
    execution: execution(c, o.execution, 'execution'),
    decision: c.oneOfOrNull(o.decision, 'decision', NEXT_DECISIONS),
    who: {
      segment: Object.fromEntries(SEGMENT_AXES.map((k) => [k, segc.text(seg[k], k)])) as Candidate['who']['segment'],
      companies: list(whc, who.companies, 'companies', company, MAX_COMPANIES),
      targetCount: whc.num(who.targetCount, 'targetCount'),
      targetListSource: whc.text(who.targetListSource, 'targetListSource'),
      conditions: Object.fromEntries(WHO_CONDITIONS.map((k) => [k, condc.boolOrNull(cond[k], k)])) as Candidate['who']['conditions']
    },
    what: {
      jtbd: { surface: jc.text(jtbd.surface, 'surface'), job: jc.text(jtbd.job, 'job'), purpose: jc.text(jtbd.purpose, 'purpose') },
      factors: Object.fromEntries(DEMAND_FACTORS.map((k) => [k, fc.score(factors[k], k)])) as Candidate['what']['factors'],
      problemType: wac.oneOf(what.problemType, 'problemType', PROBLEM_TYPES, 'unknown'),
      demandLevel: wac.oneOf(what.demandLevel, 'demandLevel', DEMAND_LEVELS, 'unknown'),
      quantification: {
        hoursPerMonth: qc.num(q.hoursPerMonth, 'hoursPerMonth'), hourlyCost: qc.num(q.hourlyCost, 'hourlyCost'),
        reductionRate: qc.num(q.reductionRate, 'reductionRate'), cashSpendMonthly: qc.num(q.cashSpendMonthly, 'cashSpendMonthly'),
        opportunityMonthly: qc.num(q.opportunityMonthly, 'opportunityMonthly')
      },
      improvement: wac.text(what.improvement, 'improvement')
    },
    where: {
      channels: list(wec, where.channels, 'channels', channelPlan, CHANNELS.length * 4),
      triggers: list(wec, where.triggers, 'triggers', trigger),
      keywords: list(wec, where.keywords, 'keywords', keyword),
      mentalAvailability: wec.text(where.mentalAvailability, 'mentalAvailability'),
      physicalAvailability: wec.text(where.physicalAvailability, 'physicalAvailability'),
      summary: wec.text(where.summary, 'summary')
    },
    why: {
      switching: {
        expectedValue: swc.num(sw.expectedValue, 'expectedValue'), adoptionCost: swc.num(sw.adoptionCost, 'adoptionCost'),
        switchingRisk: swc.num(sw.switchingRisk, 'switchingRisk'), statusQuoValue: swc.num(sw.statusQuoValue, 'statusQuoValue'),
        coexists: swc.boolOrNull(sw.coexists, 'coexists')
      },
      differentiators: list(wyc, why.differentiators, 'differentiators', (ic, r) => {
        const d = r !== null && typeof r === 'object' && !Array.isArray(r) ? r as Record<string, unknown> : { kind: r }
        const kind = ic.oneOfOrNull(d.kind, 'kind', DIFFERENTIATORS)
        return kind ? { kind, note: ic.text(d.note, 'note') } : null
      }, DIFFERENTIATORS.length * 2),
      findings: Object.fromEntries(WHY_RESEARCH_ITEMS.map((k) => [k, fic.text(findings[k], k)])) as Candidate['why']['findings'],
      reason: wyc.text(why.reason, 'reason'),
      reasonEvidence: wyc.ids(why.reasonEvidence, 'reasonEvidence', isEvidenceId)
    },
    how: {
      monthlyPrice: hc.num(how.monthlyPrice, 'monthlyPrice'), marginRate: hc.num(how.marginRate, 'marginRate'),
      retentionScenarios: retention, estimatedCac: hc.num(how.estimatedCac, 'estimatedCac'),
      cacBasis: hc.text(how.cacBasis, 'cacBasis'), automation: hc.text(how.automation, 'automation')
    },
    stage: c.oneOf(o.stage, 'stage', CANDIDATE_STAGES, 'discovered'),
    scores: Object.fromEntries(SCORE_KEYS.map((k) => [k, scoreEntry(c, scores[k], `scores.${k}`)])) as Candidate['scores'],
    gates: Object.fromEntries(GATE_IDS.map((k) => [k, gate(c, gates[k], `gates.${k}`)])) as Record<GateId, GateDecision>,
    dropReason: t('dropReason'),
    promotedTo,
    createdAt: c.text(o.createdAt, 'createdAt', now) || now,
    updatedAt: c.text(o.updatedAt, 'updatedAt', now) || now
  }
}

function readings(c: Coercer, raw: unknown): ResearchEvidence['reading'] {
  const o = c.object(raw, 'reading')
  const rc = c.child('reading')
  return Object.fromEntries(READING_KEYS.map((k) => [k, rc.oneOfOrNull(o[k], k, READING_LEVELS)])) as ResearchEvidence['reading']
}

function coerceEvidence(c: Coercer, o: Record<string, unknown>, id: string, now: string): ResearchEvidence {
  const base = emptyEvidence(id, now)
  const t = (f: string) => c.text(o[f], f)
  return {
    id,
    candidate: ref(c, o.candidate, 'candidate', isCandidateId),
    principle: c.oneOf(o.principle, 'principle', PRINCIPLE_KEYS, base.principle),
    kind: c.oneOf(o.kind, 'kind', EVIDENCE_KINDS, base.kind),
    grade: c.oneOf(o.grade, 'grade', EVIDENCE_GRADES, base.grade),
    subject: t('subject'),
    problem: t('problem'),
    event: t('event'),
    behavior: t('behavior'),
    behaviorLevel: c.oneOf(o.behaviorLevel, 'behaviorLevel', BEHAVIOR_LEVELS, base.behaviorLevel),
    amount: t('amount'),
    url: t('url').trim(),
    eventDate: c.text(o.eventDate, 'eventDate').trim(),
    publishedAt: c.text(o.publishedAt, 'publishedAt').trim(),
    publisher: t('publisher'),
    quote: t('quote'),
    checkedAt: c.text(o.checkedAt, 'checkedAt').trim(),
    source: t('source'),
    fact: t('fact'),
    inference: t('inference'),
    counter: t('counter'),
    unknowns: t('unknowns'),
    dupGroup: t('dupGroup').trim().slice(0, 200),
    // 古い形（state が無い）は収集のまま扱う（読む5観点の評価はまだ）
    state: c.oneOf(o.state, 'state', EVIDENCE_STATES, base.state),
    reading: readings(c, o.reading)
  }
}

function coerceExperiment(c: Coercer, o: Record<string, unknown>, id: string): ResearchExperiment {
  const base = emptyExperiment(id)
  const t = (f: string) => c.text(o[f], f)
  const period = c.object(o.period, 'period')
  const metrics = c.object(o.metrics, 'metrics')
  const mc = c.child('metrics')
  return {
    id,
    candidate: ref(c, o.candidate, 'candidate', isCandidateId),
    principle: c.oneOf(o.principle, 'principle', PRINCIPLE_KEYS, base.principle),
    method: c.oneOf(o.method, 'method', EXPERIMENT_METHODS, base.method),
    channel: c.oneOfOrNull(o.channel, 'channel', CHANNELS),
    hypothesis: t('hypothesis'),
    passCondition: t('passCondition'),
    stopCondition: t('stopCondition'),
    status: c.oneOf(o.status, 'status', EXPERIMENT_STATUSES, base.status),
    period: { start: c.text(period.start, 'period.start').trim(), end: c.text(period.end, 'period.end').trim() },
    metrics: Object.fromEntries(METRIC_KEYS.map((k) => [k, mc.num(metrics[k], k)])) as ExperimentMetrics,
    comparison: c.oneOf(o.comparison, 'comparison', COMPARISON_METHODS, base.comparison),
    interviews: c.num(o.interviews, 'interviews'),
    learning: t('learning')
  }
}

/** 記録1件を型へ寄せる。id はファイル名から（前置きの id は使わない） */
export function coerceResearchRecord<K extends ResearchRecordKind>(kind: K, raw: unknown, id: string, now: string): Coerced<ResearchRecordTypes[K]> {
  const c = new Coercer()
  const o = c.object(raw, '')
  const makers: { [P in ResearchRecordKind]: () => ResearchRecordTypes[P] } = {
    candidate: () => coerceCandidate(c, o, id, now),
    evidence: () => coerceEvidence(c, o, id, now),
    experiment: () => coerceExperiment(c, o, id)
  }
  return { value: makers[kind]() as ResearchRecordTypes[K], fixes: c.fixes }
}

// ================================================================ 保存の前の検査

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** YYYY-MM-DD の実在する日か */
export function isIsoDate(s: string): boolean {
  const m = DATE.exec(s)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
}

/** http(s) の URL か */
export function isWebUrl(s: string): boolean {
  if (!s || s.length > 2048 || /\s/.test(s)) return false
  try {
    const u = new URL(s)
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname
  } catch {
    return false
  }
}

export function hasResearchErrors(issues: readonly ResearchIssue[]): boolean {
  return issues.some((i) => i.level === 'error')
}

class Checker {
  readonly issues: ResearchIssue[] = []

  error(field: string, code: string, params?: Record<string, string | number>): void {
    this.issues.push({ level: 'error', field, code, ...(params ? { params } : {}) })
  }

  warn(field: string, code: string, params?: Record<string, string | number>): void {
    this.issues.push({ level: 'warning', field, code, ...(params ? { params } : {}) })
  }

  url(field: string, value: string): void {
    if (value && !isWebUrl(value)) this.error(field, 'urlInvalid')
  }

  /** 空なら見ない。形が違う・未来（today を渡したとき）は error */
  date(field: string, value: string, today: string | null): void {
    if (!value) return
    if (!isIsoDate(value)) this.error(field, 'dateInvalid')
    else if (today && value > today) this.error(field, 'dateFuture', { today })
  }

  nonNegative(field: string, value: Maybe<number>, integer = false): void {
    if (value === null) return
    if (value < 0) this.error(field, 'negative')
    else if (integer && !Number.isInteger(value)) this.error(field, 'notInteger')
  }

  rate(field: string, value: Maybe<number>): void {
    if (value !== null && (value < 0 || value > 1)) this.error(field, 'rateOutOfRange')
  }

  evidenceRefs(field: string, ids: readonly string[], known: ReadonlySet<string>): void {
    for (const id of ids) if (!known.has(id)) this.error(field, 'unknownEvidence', { id })
  }
}

function checkCandidate(ch: Checker, x: Candidate, data: ResearchData, today: string | null): void {
  const evidenceIds = new Set(data.evidence.map((e) => e.id))
  if (!x.title.trim()) ch.error('title', 'titleRequired')
  x.existingServices.forEach((s, i) => ch.url(`existingServices[${i}].url`, s.url))
  // Who
  ch.nonNegative('who.targetCount', x.who.targetCount, true)
  x.who.companies.forEach((co, i) => {
    ch.nonNegative(`who.companies[${i}].employees`, co.employees, true)
    ch.url(`who.companies[${i}].evidenceUrl`, co.evidenceUrl)
    // 観測した事実と推測した課題は分けて持つ（同じ文なら分けていない）
    if (co.situation.trim() && co.situation.trim() === co.inferredProblem.trim()) ch.warn(`who.companies[${i}].inferredProblem`, 'factSameAsInference')
  })
  // What
  const q = x.what.quantification
  ch.nonNegative('what.quantification.hoursPerMonth', q.hoursPerMonth)
  ch.nonNegative('what.quantification.hourlyCost', q.hourlyCost)
  ch.rate('what.quantification.reductionRate', q.reductionRate)
  ch.nonNegative('what.quantification.cashSpendMonthly', q.cashSpendMonthly)
  ch.nonNegative('what.quantification.opportunityMonthly', q.opportunityMonthly)
  // Where
  x.where.triggers.forEach((tr, i) => {
    ch.url(`where.triggers[${i}].url`, tr.url)
    ch.date(`where.triggers[${i}].observedAt`, tr.observedAt, today)
  })
  x.where.keywords.forEach((k, i) => ch.nonNegative(`where.keywords[${i}].volume`, k.volume, true))
  // Why
  const s = x.why.switching
  ch.nonNegative('why.switching.expectedValue', s.expectedValue)
  ch.nonNegative('why.switching.adoptionCost', s.adoptionCost)
  ch.nonNegative('why.switching.switchingRisk', s.switchingRisk)
  ch.nonNegative('why.switching.statusQuoValue', s.statusQuoValue)
  ch.evidenceRefs('why.reasonEvidence', x.why.reasonEvidence, evidenceIds)
  // How
  ch.nonNegative('how.monthlyPrice', x.how.monthlyPrice)
  ch.rate('how.marginRate', x.how.marginRate)
  ch.nonNegative('how.estimatedCac', x.how.estimatedCac)
  const seen = new Set<number>()
  x.how.retentionScenarios.forEach((m, i) => {
    if (!Number.isInteger(m) || m < 1 || m > MAX_RETENTION_MONTHS) ch.error(`how.retentionScenarios[${i}]`, 'retentionInvalid', { max: MAX_RETENTION_MONTHS })
    else if (seen.has(m)) ch.error(`how.retentionScenarios[${i}]`, 'retentionDuplicate', { months: m })
    seen.add(m)
  })
  // 採点: 点には根拠の証拠が要る（無ければ warning。比べる計算には数えない）
  for (const k of SCORE_KEYS) {
    const e = x.scores[k]
    ch.evidenceRefs(`scores.${k}.evidence`, e.evidence, evidenceIds)
    if (e.score !== null && e.evidence.length === 0) ch.warn(`scores.${k}.evidence`, 'scoreUnbacked')
  }
  if (x.stage === 'dropped' && !x.dropReason.trim()) ch.error('dropReason', 'dropReasonRequired')
  // 購買が起きる場面（調査の単位。必須だが、書きかけでも保存はできる）
  const missing = SCENE_KEYS.filter((k) => !x.scene[k].trim())
  if (missing.length > 0) ch.warn('scene', 'sceneMissing', { fields: missing.join(', ') })
  // 成立条件: 証拠は知っている ID だけ。同じ証拠を支持と反証の両方に置かない
  for (const k of CONDITION_KEYS) {
    const row = x.conditions[k]
    ch.evidenceRefs(`conditions.${k}.support`, row.support, evidenceIds)
    ch.evidenceRefs(`conditions.${k}.counter`, row.counter, evidenceIds)
    for (const id of row.support) if (row.counter.includes(id)) ch.warn(`conditions.${k}`, 'evidenceBothSides', { id })
  }
  for (const k of ROLE_KEYS) ch.evidenceRefs(`roles.${k}.evidence`, x.roles[k].evidence, evidenceIds)
  // 無料から有料へのつながり
  const m = x.monetization
  ch.nonNegative('monetization.months', m.months)
  ch.nonNegative('monetization.marginPerDeal', m.marginPerDeal)
  ch.nonNegative('monetization.costPerFreeUser', m.costPerFreeUser)
  const rates = new Set<number>()
  m.conversionScenarios.forEach((r, i) => {
    if (r < 0 || r > 1) ch.error(`monetization.conversionScenarios[${i}]`, 'rateOutOfRange')
    else if (rates.has(r)) ch.warn(`monetization.conversionScenarios[${i}]`, 'scenarioDuplicate', { rate: r })
    rates.add(r)
  })
}

function checkEvidence(ch: Checker, x: ResearchEvidence, data: ResearchData, today: string | null): void {
  if (x.candidate && !data.candidates.some((c) => c.id === x.candidate)) ch.error('candidate', 'unknownCandidate', { id: x.candidate })
  ch.url('url', x.url)
  if (!x.url && x.grade !== 'aiInference') {
    // 強い区分（高い・比較的高い）は出典が無ければ証拠にならない。それ以外は知らせるだけ
    const r = GRADE_RELIABILITY[x.grade]
    if (r === 'high' || r === 'fairlyHigh') ch.error('url', 'urlRequiredForGrade', { grade: x.grade })
    else ch.warn('url', 'urlRecommended')
  }
  if (!x.quote.trim() && !x.fact.trim()) ch.error('fact', 'quoteOrFactRequired')
  if (x.fact.trim() && x.fact.trim() === x.inference.trim()) ch.error('inference', 'factSameAsInference')
  if (!x.checkedAt) ch.error('checkedAt', 'dateRequired')
  else ch.date('checkedAt', x.checkedAt, today)
  // 出来事の日と掲載日は別々（過去の事例を現在の証拠にしない）
  ch.date('eventDate', x.eventDate, today)
  ch.date('publishedAt', x.publishedAt, today)
  if (isIsoDate(x.eventDate) && isIsoDate(x.publishedAt) && x.publishedAt < x.eventDate) ch.warn('publishedAt', 'publishedBeforeEvent')
  // 評価の工程を終えたのに、読む5観点がひとつも付いていない
  if (x.state === 'evaluated' && READING_KEYS.every((k) => x.reading[k] === null)) ch.warn('reading', 'readingMissing')
}

function checkExperiment(ch: Checker, x: ResearchExperiment, data: ResearchData, today: string | null): void {
  if (!x.candidate) ch.error('candidate', 'candidateRequired')
  else if (!data.candidates.some((c) => c.id === x.candidate)) ch.error('candidate', 'unknownCandidate', { id: x.candidate })
  // 合格・中止の条件は始める前に決める
  for (const f of ['passCondition', 'stopCondition'] as const) {
    if (x[f].trim()) continue
    if (x.status === 'planned') ch.warn(f, 'conditionMissing')
    else ch.error(f, 'conditionRequired')
  }
  ch.date('period.start', x.period.start, null)
  ch.date('period.end', x.period.end, null)
  if (isIsoDate(x.period.start) && isIsoDate(x.period.end) && x.period.start > x.period.end) ch.error('period', 'periodReversed')
  if (x.status !== 'planned' && x.period.start && isIsoDate(x.period.start) && today && x.period.start > today) ch.warn('period.start', 'dateFuture', { today })
  for (const k of METRIC_KEYS) ch.nonNegative(`metrics.${k}`, x.metrics[k], k !== 'spend' && k !== 'revenue')
  if (x.status === 'planned' && METRIC_KEYS.some((k) => x.metrics[k] !== null && k !== 'targets')) ch.warn('metrics', 'metricsBeforeStart')
  ch.nonNegative('interviews', x.interviews, true)
}

/**
 * 保存の前の検査。error があれば保存しない、warning は保存して画面に出す。
 * data はほかの記録（知らない ID を見つけるため。保存する記録自身は除いて渡してよい）。
 * now（ISO8601）を渡すと「確認日が未来」も見る（地元の日付は呼び出し側が決める: YYYY-MM-DD でも可）
 */
export function validateResearchRecord<K extends ResearchRecordKind>(kind: K, record: ResearchRecordTypes[K], data: ResearchData, now?: string): ResearchIssue[] {
  const ch = new Checker()
  if (!isResearchId(kind, record.id)) ch.error('id', 'idInvalid', { id: String(record.id).slice(0, 20) })
  const today = now ? now.slice(0, 10) : null
  if (kind === 'candidate') checkCandidate(ch, record as Candidate, data, today)
  else if (kind === 'evidence') checkEvidence(ch, record as ResearchEvidence, data, today)
  else checkExperiment(ch, record as ResearchExperiment, data, today)
  return ch.issues
}
