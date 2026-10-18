/**
 * 記録の空の形（テンプレートどおり U で埋める）と、読み込んだ値を型へ寄せる処理。
 * ファイルは人も Agent も手で書くので、型が違う・欠けている値があっても落とさず、既定へ寄せて「直したこと」を返す。
 */
import {
  ACQUISITION_KEYS,
  APPROVAL_KINDS,
  APPROVAL_STATUSES,
  CHANGE_AXES,
  CONDITION_METRICS,
  DEMAND_KEYS,
  EXECUTION_KEYS,
  EXPERIMENT_STATUSES,
  PROVISION_KEYS,
  READ_STATUSES,
  SOURCE_KINDS,
  STAGES,
  UNKNOWN,
  VERDICTS,
  isStepId,
  type Alternative,
  type Approval,
  type BusinessFile,
  type Condition,
  type Decision,
  type Evidence,
  type ExecutionItem,
  type ExecutionKey,
  type Experiment,
  type ExperimentNumbers,
  type Hypothesis,
  type Interview,
  type LoopRecord,
  type ProvisionEntry,
  type RecordKind,
  type RecordTypes,
  type Score,
  type ScoreEntry,
  type ScoreKey,
  type SearchLog,
  type YesNo
} from './model'

/** 1つの値の長さの上限（巨大なファイルで画面を止めない） */
export const MAX_TEXT = 20_000
export const MAX_LIST = 200

export function emptyScore(): ScoreEntry {
  return { score: UNKNOWN, evidence: [], reason: '' }
}
export function emptyProvision(): ProvisionEntry {
  return { value: UNKNOWN, evidence: [], reason: '' }
}

export function emptyNumbers(): ExperimentNumbers {
  return {
    contacts: null, replies: null, qualified: null, priced: null, paid: null, payments: null, accepted: null, repurchased: null,
    interest: null, quoteRequests: null, revenue: null, adCost: null, outsourceCost: null, salesHours: null, hourlyCost: null,
    deliveryCost: null, setupCost: null, monthlyPrice: null, monthlyVariableCost: null
  }
}

export function emptyBusiness(name: string, now: string): BusinessFile {
  return { name, target: '', step: 'S1', loop: 1, currentHypothesis: null, limits: { hours: null, yen: null }, loops: [], createdAt: now }
}

/**
 * 実行条件の4点の既定の問い（ナレッジ「これで事業を完全に進められるか」の「決める内容」）。
 * 未入力のまま引き継いでも、何を決めればよいかが分かるようにする
 */
export const EXECUTION_QUESTIONS: Record<ExecutionKey, { ja: string; en: string }> = {
  firstDeal: {
    ja: '誰が何をどの条件で発注し、自社は何の対価をいつ受け取るか（確認できた状態: 判断できる提案・価格・提供範囲・契約条件がある）',
    en: 'Who orders what on which terms, and what payment do we receive and when (confirmed when there is a proposal, price, scope and contract terms the buyer can decide on)'
  },
  supply: {
    ja: '必要な品質・時期・費用で、誰が何を提供するか。自社はどの契約形態で関与し何を引き受けるか（確認できた状態: 実際の条件で提供できることを確認した）',
    en: 'Who delivers what at the required quality, timing and cost, and under which contract we take part and what we take on (confirmed when delivery under real terms is checked)'
  },
  firstExperiment: {
    ja: '対象、見せるもの、担当、使える費用と時間、観測する行動（確認できた状態: 結果に応じて継続・修正・停止を判断できる）',
    en: 'Target, what to show, owner, budget and time, behavior to observe (confirmed when the result lets us continue, change or stop)'
  },
  profitOps: {
    ja: '獲得から提供・請求・入金・問い合わせまで誰が担い、いくらかかるか（確認できた状態: 代表の作業も費用に含め、利益と入金までの資金負担を把握した）',
    en: 'Who handles acquisition, delivery, billing, payment and support, and what it costs (confirmed when the owner\'s own work is costed and profit and cash needs until payment are known)'
  }
}

/** 実行条件の4点の初期値。plan が空なら既定の問いを入れる */
export function defaultExecution(locale: 'ja' | 'en' = 'ja', from?: Partial<Record<ExecutionKey, Partial<ExecutionItem>>>): Record<ExecutionKey, ExecutionItem> {
  return Object.fromEntries(EXECUTION_KEYS.map((k) => {
    const plan = typeof from?.[k]?.plan === 'string' && from[k]!.plan!.trim() ? from[k]!.plan! : EXECUTION_QUESTIONS[k][locale]
    return [k, { plan, confirmed: from?.[k]?.confirmed === true }]
  })) as Record<ExecutionKey, ExecutionItem>
}

export function emptyRecord<K extends RecordKind>(kind: K, id: string, now: string): RecordTypes[K] {
  const today = now.slice(0, 10)
  const records: { [P in RecordKind]: () => RecordTypes[P] } = {
    hypothesis: () => ({
      id, name: '', stage: '探索メモ', target: '', trigger: '', outcome: '', problem: '', offer: '', whyUnsolved: '', biggestCounter: '', next: '', checker: '', checkedAt: today,
      demand: Object.fromEntries(DEMAND_KEYS.map((k) => [k, emptyScore()])) as Hypothesis['demand'],
      acquisition: Object.fromEntries(ACQUISITION_KEYS.map((k) => [k, emptyScore()])) as Hypothesis['acquisition'],
      provision: Object.fromEntries(PROVISION_KEYS.map((k) => [k, emptyProvision()])) as Hypothesis['provision'],
      verdict: null, stageHistory: []
    }),
    evidence: () => ({
      id, hypotheses: [], party: '', partyBasis: '', dupGroup: UNKNOWN, sourceKind: UNKNOWN, medium: '', url: '', publishedAt: '', checkedAt: today,
      readStatus: '発見のみ', facts: '', quote: '', interpretation: '', supports: [], counter: '',
      details: { scene: '', loss: '', deadline: '', action: '', spend: '', conditions: '', gap: '', workaround: '', payer: '', nextQuestion: '' }
    }),
    alternative: () => ({ id, hypothesis: '', method: '', offering: '', cost: '', gap: '', nextCheck: '', url: '', checkedAt: today }),
    interview: () => ({ id, hypothesis: '', role: '', date: today, consent: false, summary: '', transcript: '', evidence: [] }),
    experiment: () => ({
      id, hypothesis: '', status: '計画のみ', question: '', targetCondition: '', channel: '', offer: '', price: '', pass: [], stop: [],
      period: { start: '', end: '' }, limits: { yen: null, hours: null }, plan: emptyNumbers(), actual: emptyNumbers(),
      proof: '', quality: '', reasons: '', conclusion: '', page: null
    }),
    decision: () => ({
      id, hypothesis: '', verdict: '追加調査', stage: '探索メモ', who: '', loss: '', spent: '', gap: '', offer: '', payer: '', channel: '',
      evidence: [], counter: '', unknowns: '', next: '', passStop: '', learnings: [], worked: '不明', at: now
    }),
    approval: () => ({
      id, kind: '外部へ送る', title: '', detail: '', refs: [], options: [], status: '待ち', answer: '', requestedBy: '', requestedAt: now, decidedAt: ''
    })
  }
  return records[kind]()
}

// ---- 値を型へ寄せる ----

/** 寄せたときに直したこと（画面の「読み込みの注意」に出す） */
export interface Fix {
  field: string
  message: string
}

class Coercer {
  constructor(
    private readonly prefix = '',
    /** 子の直しも親と同じ一覧へ集める */
    readonly fixes: Fix[] = []
  ) {}

  child(field: string): Coercer {
    return new Coercer(this.path(field), this.fixes)
  }

  private path(field: string): string {
    if (!field) return this.prefix
    return this.prefix ? `${this.prefix}.${field}` : field
  }

  note(field: string, message: string): void {
    this.fixes.push({ field: this.path(field), message })
  }

  text(raw: unknown, field: string, fallback = ''): string {
    if (raw === undefined || raw === null) return fallback
    if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
    // YAML は日付らしい値を Date にする。日付だけを書き戻す
    if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? fallback : raw.toISOString().slice(0, raw.getUTCHours() || raw.getUTCMinutes() ? 19 : 10)
    if (typeof raw !== 'string') {
      this.note(field, '文字ではないので空にしました')
      return fallback
    }
    if (raw.length > MAX_TEXT) {
      this.note(field, `長すぎるので ${MAX_TEXT} 文字で切りました`)
      return raw.slice(0, MAX_TEXT)
    }
    return raw
  }

  list(raw: unknown, field: string, valid?: (v: string) => boolean): string[] {
    if (raw === undefined || raw === null || raw === '') return []
    const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,、\s]+/) : null
    if (!items) {
      this.note(field, '一覧ではないので空にしました')
      return []
    }
    const out: string[] = []
    for (const item of items.slice(0, MAX_LIST)) {
      const s = typeof item === 'string' || typeof item === 'number' ? String(item).trim() : ''
      if (!s) continue
      if (valid && !valid(s)) {
        this.note(field, `「${s.slice(0, 40)}」は使えない値なので外しました`)
        continue
      }
      if (!out.includes(s)) out.push(s)
    }
    if (items.length > MAX_LIST) this.note(field, `${MAX_LIST} 件を超えた分を外しました`)
    return out
  }

  oneOf<T extends string>(raw: unknown, field: string, allowed: readonly T[], fallback: T): T {
    if (raw === undefined || raw === null || raw === '') return fallback
    const s = typeof raw === 'string' ? raw.trim() : String(raw)
    if ((allowed as readonly string[]).includes(s)) return s as T
    this.note(field, `「${s.slice(0, 40)}」は選べない値なので「${fallback}」にしました`)
    return fallback
  }

  /** 0 以上の数。未計測は null。負・数でないものは null にして知らせる（0 にしない） */
  count(raw: unknown, field: string): number | null {
    if (raw === undefined || raw === null || raw === '' || raw === UNKNOWN) return null
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.replace(/[,，円]/g, '')) : Number.NaN
    if (!Number.isFinite(n) || n < 0 || n > 1e12) {
      this.note(field, '0 以上の数ではないので未計測にしました')
      return null
    }
    return n
  }

  bool(raw: unknown, field: string, fallback = false): boolean {
    if (raw === undefined || raw === null) return fallback
    if (typeof raw === 'boolean') return raw
    if (raw === 'はい' || raw === 'true' || raw === 'yes') return true
    if (raw === 'いいえ' || raw === 'false' || raw === 'no') return false
    this.note(field, 'はい／いいえではないので既定にしました')
    return fallback
  }

  object(raw: unknown, field: string): Record<string, unknown> {
    if (raw === undefined || raw === null) return {}
    if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
    this.note(field, '項目のまとまりではないので空にしました')
    return {}
  }
}

const SCORE_KEY_SET = new Set<string>([...DEMAND_KEYS, ...ACQUISITION_KEYS])
const isEvidenceRef = (s: string) => /^E\d{2,4}$/.test(s)
const isAnyRef = (s: string) => /^(H|E|ALT|I|X|C|R)\d{2,4}$/.test(s)

function score(c: Coercer, raw: unknown, field: string): ScoreEntry {
  // 値だけ（D1: 2）でも、まとまり（D1: { score: 2, evidence: [E01] }）でも読む
  const o = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : { score: raw }
  const sc = c.child(field)
  const v = o.score
  let s: Score = UNKNOWN
  if (v === 0 || v === 1 || v === 2) s = v
  else if (v === '0' || v === '1' || v === '2') s = Number(v) as 0 | 1 | 2
  else if (v !== undefined && v !== null && v !== '' && v !== UNKNOWN && v !== 'u') sc.note('score', `「${String(v).slice(0, 20)}」は 0/1/2/U ではないので U にしました`)
  return { score: s, evidence: sc.list(o.evidence, 'evidence', isEvidenceRef), reason: sc.text(o.reason, 'reason') }
}

function provision(c: Coercer, raw: unknown, field: string): ProvisionEntry {
  const o = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : { value: raw }
  const pc = c.child(field)
  const value = pc.oneOf<YesNo>(o.value === true ? 'はい' : o.value === false ? 'いいえ' : o.value, 'value', ['はい', 'いいえ', UNKNOWN], UNKNOWN)
  return { value, evidence: pc.list(o.evidence, 'evidence', isEvidenceRef), reason: pc.text(o.reason, 'reason') }
}

function numbers(c: Coercer, raw: unknown, field: string): ExperimentNumbers {
  const nc = c.child(field)
  const o = c.object(raw, field)
  const out = emptyNumbers()
  for (const key of Object.keys(out) as Array<keyof ExperimentNumbers>) out[key] = nc.count(o[key], key)
  return out
}

function conditions(c: Coercer, raw: unknown, field: string): Condition[] {
  if (raw === undefined || raw === null || raw === '') return []
  if (!Array.isArray(raw)) {
    c.note(field, '条件の一覧ではないので空にしました')
    return []
  }
  const out: Condition[] = []
  raw.slice(0, 20).forEach((item, i) => {
    const o = item !== null && typeof item === 'object' ? (item as Record<string, unknown>) : {}
    const metric = typeof o.metric === 'string' && (CONDITION_METRICS as readonly string[]).includes(o.metric) ? (o.metric as Condition['metric']) : null
    const op = o.op === '>=' || o.op === '<=' ? o.op : null
    const value = typeof o.value === 'number' && Number.isFinite(o.value) && o.value >= 0 ? o.value : null
    if (!metric || !op || value === null) {
      c.note(`${field}[${i}]`, '指標・比べ方・値のどれかが使えないので外しました')
      return
    }
    out.push({ metric, op, value })
  })
  return out
}

export interface Coerced<T> {
  value: T
  fixes: Fix[]
}

export function coerceBusiness(raw: unknown, fallbackName: string, now: string): Coerced<BusinessFile> {
  const c = new Coercer()
  const o = c.object(raw, 'business')
  const base = emptyBusiness(fallbackName, now)
  const limits = c.object(o.limits, 'limits')
  if (o.step !== undefined && !isStepId(o.step)) c.note('step', 'S1〜S10 ではないので S1 にしました')
  const step = isStepId(o.step) ? o.step : 'S1'
  const loop = c.count(o.loop, 'loop')
  const loops: LoopRecord[] = Array.isArray(o.loops)
    ? o.loops.slice(0, 500).map((item, i) => {
        const lc = c.child(`loops[${i}]`)
        const r = lc.object(item, '')
        return {
          loop: lc.count(r.loop, 'loop') ?? i + 1,
          changed: r.changed === null || r.changed === undefined ? null : lc.oneOf(r.changed, 'changed', CHANGE_AXES, '対象'),
          backTo: isStepId(r.backTo) ? r.backTo : null,
          note: lc.text(r.note, 'note'),
          at: lc.text(r.at, 'at')
        }
      })
    : []
  // 実行条件: 書いてあるときだけ持つ（無い古い business.yaml は欄ごと無いまま）
  let execution: Record<ExecutionKey, ExecutionItem> | undefined
  if (o.execution !== undefined && o.execution !== null) {
    const e = c.object(o.execution, 'execution')
    execution = Object.fromEntries(EXECUTION_KEYS.map((k) => {
      const ec = c.child(`execution.${k}`)
      const r = typeof e[k] === 'string' ? { plan: e[k] } : ec.object(e[k], '')
      return [k, { plan: ec.text(r.plan, 'plan'), confirmed: ec.bool(r.confirmed, 'confirmed', false) }]
    })) as Record<ExecutionKey, ExecutionItem>
  }
  return {
    value: {
      name: c.text(o.name, 'name', base.name).trim() || base.name,
      target: c.text(o.target, 'target'),
      step,
      loop: loop && loop >= 1 ? Math.floor(loop) : 1,
      currentHypothesis: typeof o.currentHypothesis === 'string' && /^H\d{2,4}$/.test(o.currentHypothesis) ? o.currentHypothesis : null,
      limits: { hours: c.count(limits.hours, 'limits.hours'), yen: c.count(limits.yen, 'limits.yen') },
      loops,
      createdAt: c.text(o.createdAt, 'createdAt', now),
      ...(execution ? { execution } : {})
    },
    fixes: c.fixes
  }
}

export function coerceRecord<K extends RecordKind>(kind: K, raw: unknown, id: string, now: string): Coerced<RecordTypes[K]> {
  const c = new Coercer()
  const o = c.object(raw, kind)
  const t = (f: string) => c.text(o[f], f)
  const coercers: { [P in RecordKind]: () => RecordTypes[P] } = {
    hypothesis: () => {
      const base = emptyRecord('hypothesis', id, now)
      const demand = c.object(o.demand, 'demand')
      const acquisition = c.object(o.acquisition, 'acquisition')
      const prov = c.object(o.provision, 'provision')
      const history = Array.isArray(o.stageHistory) ? o.stageHistory : []
      return {
        ...base,
        name: t('name'), stage: c.oneOf(o.stage, 'stage', STAGES, '探索メモ'), target: t('target'), trigger: t('trigger'), outcome: t('outcome'),
        problem: t('problem'), offer: t('offer'), whyUnsolved: t('whyUnsolved'), biggestCounter: t('biggestCounter'), next: t('next'),
        checker: t('checker'), checkedAt: c.text(o.checkedAt, 'checkedAt', base.checkedAt),
        demand: Object.fromEntries(DEMAND_KEYS.map((k) => [k, score(c, demand[k], `demand.${k}`)])) as Hypothesis['demand'],
        acquisition: Object.fromEntries(ACQUISITION_KEYS.map((k) => [k, score(c, acquisition[k], `acquisition.${k}`)])) as Hypothesis['acquisition'],
        provision: Object.fromEntries(PROVISION_KEYS.map((k) => [k, provision(c, prov[k], `provision.${k}`)])) as Hypothesis['provision'],
        verdict: o.verdict === null || o.verdict === undefined || o.verdict === '' ? null : c.oneOf(o.verdict, 'verdict', VERDICTS, '追加調査'),
        stageHistory: history.slice(0, 100).map((item, i) => {
          const hc = c.child(`stageHistory[${i}]`)
          const r = hc.object(item, '')
          return { from: hc.oneOf(r.from, 'from', STAGES, '探索メモ'), to: hc.oneOf(r.to, 'to', STAGES, '探索メモ'), at: hc.text(r.at, 'at'), note: hc.text(r.note, 'note') }
        })
      }
    },
    evidence: () => {
      const base = emptyRecord('evidence', id, now)
      const d = c.object(o.details, 'details')
      const dc = c.child('details')
      return {
        ...base,
        hypotheses: c.list(o.hypotheses, 'hypotheses', (s) => /^H\d{2,4}$/.test(s)),
        party: t('party'), partyBasis: t('partyBasis'), dupGroup: c.text(o.dupGroup, 'dupGroup', UNKNOWN).trim() || UNKNOWN,
        sourceKind: c.oneOf(o.sourceKind, 'sourceKind', [...SOURCE_KINDS, UNKNOWN], UNKNOWN), medium: t('medium'), url: t('url').trim(),
        publishedAt: t('publishedAt'), checkedAt: c.text(o.checkedAt, 'checkedAt', base.checkedAt),
        readStatus: c.oneOf(o.readStatus, 'readStatus', READ_STATUSES, '発見のみ'),
        facts: t('facts'), quote: t('quote'), interpretation: t('interpretation'),
        supports: c.list(o.supports, 'supports', (s) => SCORE_KEY_SET.has(s)) as ScoreKey[], counter: t('counter'),
        details: Object.fromEntries(Object.keys(base.details).map((k) => [k, dc.text(d[k], k)])) as Evidence['details']
      }
    },
    alternative: () => ({
      ...emptyRecord('alternative', id, now),
      hypothesis: t('hypothesis'), method: t('method'), offering: t('offering'), cost: t('cost'), gap: t('gap'), nextCheck: t('nextCheck'),
      url: t('url').trim(), checkedAt: t('checkedAt')
    }) satisfies Alternative,
    interview: () => {
      const consent = c.bool(o.consent, 'consent')
      const transcript = t('transcript')
      if (!consent && transcript) c.note('transcript', '同意が無いので原文は読み込みませんでした')
      return {
        ...emptyRecord('interview', id, now),
        hypothesis: t('hypothesis'), role: t('role'), date: t('date'), consent, summary: t('summary'),
        transcript: consent ? transcript : '', evidence: c.list(o.evidence, 'evidence', isEvidenceRef)
      } satisfies Interview
    },
    experiment: () => {
      const base = emptyRecord('experiment', id, now)
      const period = c.object(o.period, 'period')
      const limits = c.object(o.limits, 'limits')
      const page = o.page === null || o.page === undefined ? null : c.object(o.page, 'page')
      const pageOk = !!page && typeof page.slug === 'string' && /^[a-z0-9-]{3,48}$/.test(page.slug)
      if (page && !pageOk) c.note('page', 'ページの名前（英小文字・数字・- の 3〜48 文字）が使えないので外しました')
      return {
        ...base,
        hypothesis: t('hypothesis'), status: c.oneOf(o.status, 'status', EXPERIMENT_STATUSES, '計画のみ'), question: t('question'),
        targetCondition: t('targetCondition'), channel: t('channel'), offer: t('offer'), price: t('price'),
        pass: conditions(c, o.pass, 'pass'), stop: conditions(c, o.stop, 'stop'),
        period: { start: c.text(period.start, 'period.start'), end: c.text(period.end, 'period.end') },
        limits: { yen: c.count(limits.yen, 'limits.yen'), hours: c.count(limits.hours, 'limits.hours') },
        plan: numbers(c, o.plan, 'plan'), actual: numbers(c, o.actual, 'actual'),
        proof: t('proof'), quality: t('quality'), reasons: t('reasons'), conclusion: t('conclusion'),
        page: page && pageOk
          ? { slug: page.slug as string, status: c.oneOf(page.status, 'page.status', ['なし', '下書き', '公開中', '停止'] as const, '下書き') }
          : null
      } satisfies Experiment
    },
    decision: () => ({
      ...emptyRecord('decision', id, now),
      hypothesis: t('hypothesis'), verdict: c.oneOf(o.verdict, 'verdict', VERDICTS, '追加調査'), stage: c.oneOf(o.stage, 'stage', STAGES, '探索メモ'),
      who: t('who'), loss: t('loss'), spent: t('spent'), gap: t('gap'), offer: t('offer'), payer: t('payer'), channel: t('channel'),
      evidence: c.list(o.evidence, 'evidence', isEvidenceRef), counter: t('counter'), unknowns: t('unknowns'), next: t('next'), passStop: t('passStop'),
      learnings: c.list(o.learnings, 'learnings').map((s) => s.slice(0, 500)),
      worked: c.oneOf(o.worked, 'worked', ['効いた', '効かなかった', '不明'] as const, '不明'), at: c.text(o.at, 'at', now)
    }) satisfies Decision,
    approval: () => ({
      ...emptyRecord('approval', id, now),
      kind: c.oneOf(o.kind, 'kind', APPROVAL_KINDS, '外部へ送る'), title: t('title'), detail: t('detail'),
      refs: c.list(o.refs, 'refs', isAnyRef), options: c.list(o.options, 'options').map((s) => s.slice(0, 300)).slice(0, 4),
      status: c.oneOf(o.status, 'status', APPROVAL_STATUSES, '待ち'), answer: t('answer'), requestedBy: t('requestedBy'),
      requestedAt: c.text(o.requestedAt, 'requestedAt', now), decidedAt: t('decidedAt')
    }) satisfies Approval
  }
  const value = coercers[kind]() as RecordTypes[K]
  return { value, fixes: c.fixes }
}

export function coerceSearch(raw: unknown): SearchLog | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const c = new Coercer()
  const o = raw as Record<string, unknown>
  const query = c.text(o.query, 'query').trim()
  if (!query) return null
  return {
    at: c.text(o.at, 'at'), query: query.slice(0, 500), medium: c.text(o.medium, 'medium'), period: c.text(o.period, 'period'),
    readable: c.bool(o.readable, 'readable', false), adopted: c.bool(o.adopted, 'adopted', false), note: c.text(o.note, 'note')
  }
}
