/**
 * ビジネスリサーチのテスト用の記録（外部につながない固定の値）。
 * - fullCandidate: 全欄を埋めた候補（リサーチの完了条件・調査の終了条件はすべて満たし、成立条件は supported で反証なし。根拠は E001・E002 を指す）
 * - blankCandidate: 何も調べていない候補
 * - fullEvidence / fullExperiment: 全欄を埋めた証拠・実験
 * - emptyData / fullData: リサーチ1件の全体
 * patch は浅い上書き（入れ子は呼ぶ側で丸ごと渡す）
 */
import {
  CONDITION_KEYS,
  DEFAULT_CUTOFFS,
  DEFAULT_FUNNEL_TARGETS,
  DEFAULT_WEIGHTS,
  EXECUTION_KEYS,
  GATE_IDS,
  METRIC_KEYS,
  READING_KEYS,
  ROLE_KEYS,
  SCORE_KEYS,
  type Candidate,
  type ConditionKey,
  type ConditionRow,
  type ExecutionItem,
  type ExecutionKey,
  type ExperimentMetrics,
  type GateDecision,
  type GateId,
  type GateStatus,
  type Monetization,
  type PurchaseScene,
  type ReadingKey,
  type ReadingLevel,
  type ResearchData,
  type ResearchEvidence,
  type ResearchExperiment,
  type RoleEntry,
  type RoleKey,
  type Score,
  type ScoreEntry,
  type ScoreKey,
  type TargetCompany
} from '@shared/research/model'

export const NOW = '2026-10-18T09:00:00.000Z'

export function metrics(patch: Partial<ExperimentMetrics> = {}): ExperimentMetrics {
  return { ...(Object.fromEntries(METRIC_KEYS.map((k) => [k, null])) as ExperimentMetrics), ...patch }
}

export function gates(statuses: Partial<Record<GateId, GateStatus>> = {}): Record<GateId, GateDecision> {
  return Object.fromEntries(
    GATE_IDS.map((g) => {
      const status = statuses[g] ?? 'pending'
      return [g, { status, note: '', at: status === 'pending' ? '' : NOW }]
    })
  ) as Record<GateId, GateDecision>
}

/** 全項目に同じ点と根拠を付けた採点（points で項目ごとに上書き） */
export function scores(points: Partial<Record<ScoreKey, Score | null>> = {}, evidence: string[] = ['E001'], base: Score | null = 4): Record<ScoreKey, ScoreEntry> {
  return Object.fromEntries(
    SCORE_KEYS.map((k) => [k, { score: k in points ? (points[k] as Score | null) : base, evidence: [...evidence], reason: `${k} の理由` }])
  ) as Record<ScoreKey, ScoreEntry>
}

export function company(name: string, patch: Partial<TargetCompany> = {}): TargetCompany {
  return {
    company: name,
    industry: 'IT',
    employees: 50,
    situation: '法人営業を3名募集中',
    inferredProblem: '営業リスト作成に時間がかかっている',
    evidenceUrl: `https://jobs.example.com/${encodeURIComponent(name)}`,
    buyerRole: '営業部長',
    reachPath: '公式問い合わせ窓口',
    ...patch
  }
}

export function scene(patch: Partial<PurchaseScene> = {}): PurchaseScene {
  return {
    company: '従業員20〜100人の IT 企業',
    who: '新規法人営業の責任者',
    event: '営業担当を増員したとき',
    outcome: '今週アプローチすべき企業と理由',
    currentHandling: '担当者が求人サイトと企業サイトを見て Excel に転記している',
    ...patch
  }
}

export function blankScene(): PurchaseScene {
  return { company: '', who: '', event: '', outcome: '', currentHandling: '' }
}

export function conditionRow(patch: Partial<ConditionRow> = {}): ConditionRow {
  return { support: [], counter: [], supportNote: '', counterNote: '', unknown: '', next: '', status: 'unverified', ...patch }
}

/** 5条件すべて同じ行（rows で条件ごとに上書き） */
export function conditions(base: Partial<ConditionRow> = {}, rows: Partial<Record<ConditionKey, Partial<ConditionRow>>> = {}): Record<ConditionKey, ConditionRow> {
  return Object.fromEntries(CONDITION_KEYS.map((k) => [k, conditionRow({ ...base, ...(rows[k] ?? {}) })])) as Record<ConditionKey, ConditionRow>
}

export function roles(filled = true): Record<RoleKey, RoleEntry> {
  return Object.fromEntries(
    ROLE_KEYS.map((k) => [k, filled ? { title: `${k} の役職`, confirmedAuthority: k === 'budgetOwner' ? '月10万円まで決裁' : '', evidence: ['E001'] } : { title: '', confirmedAuthority: '', evidence: [] }])
  ) as Record<RoleKey, RoleEntry>
}

/** ナレッジの例: 12か月・有料取引1社の限界利益30万円・無料利用企業1社6,000円、有料化率 0.5%・2%・5% */
export function monetization(patch: Partial<Monetization> = {}): Monetization {
  return {
    side: 'buyer',
    orderScene: 'afterOrder',
    freeToPaidPath: '無料で案件を探す → 体制が足りない → 発注担当につながる → 条件の相談 → 有料取引',
    months: 12,
    marginPerDeal: 300000,
    costPerFreeUser: 6000,
    conversionScenarios: [0.005, 0.02, 0.05],
    ...patch
  }
}

export function blankMonetization(): Monetization {
  return { side: 'unknown', orderScene: 'unknown', freeToPaidPath: '', months: null, marginPerDeal: null, costPerFreeUser: null, conversionScenarios: [] }
}

export function execution(confirmed: boolean | Partial<Record<ExecutionKey, boolean>> = true): Record<ExecutionKey, ExecutionItem> {
  return Object.fromEntries(
    EXECUTION_KEYS.map((k) => [k, { plan: `${k} の決める内容`, confirmed: typeof confirmed === 'boolean' ? confirmed : confirmed[k] === true }])
  ) as Record<ExecutionKey, ExecutionItem>
}

/** 読む5観点（level で全部そろえ、patch で観点ごとに上書き） */
export function reading(level: ReadingLevel | null = 'ok', patch: Partial<Record<ReadingKey, ReadingLevel | null>> = {}): Record<ReadingKey, ReadingLevel | null> {
  return { ...(Object.fromEntries(READING_KEYS.map((k) => [k, level])) as Record<ReadingKey, ReadingLevel | null>), ...patch }
}

export function blankCandidate(id: string, patch: Partial<Candidate> = {}): Candidate {
  return {
    id,
    title: '',
    market: '',
    problem: '',
    customer: '',
    existingServices: [],
    aiFit: '',
    scene: blankScene(),
    conditions: conditions(),
    roles: roles(false),
    deliverable: '',
    monetization: blankMonetization(),
    execution: Object.fromEntries(EXECUTION_KEYS.map((k) => [k, { plan: '', confirmed: false }])) as Record<ExecutionKey, ExecutionItem>,
    decision: null,
    who: {
      segment: { attribute: '', situation: '', behavior: '', problem: '', purchase: '' },
      companies: [],
      targetCount: null,
      targetListSource: '',
      conditions: { identifiable: null, sharedProblem: null, buyerKnown: null, canPay: null, repeatableContact: null }
    },
    what: {
      jtbd: { surface: '', job: '', purpose: '' },
      factors: { severity: null, frequency: null, loss: null, urgency: null, existingSpend: null },
      problemType: 'unknown',
      demandLevel: 'unknown',
      quantification: { hoursPerMonth: null, hourlyCost: null, reductionRate: null, cashSpendMonthly: null, opportunityMonthly: null },
      improvement: ''
    },
    where: { channels: [], triggers: [], keywords: [], mentalAvailability: '', physicalAvailability: '', summary: '' },
    why: {
      switching: { expectedValue: null, adoptionCost: null, switchingRisk: null, statusQuoValue: null, coexists: null },
      differentiators: [],
      findings: { positiveReviews: '', negativeReviews: '', churnPosts: '', comparisonArticles: '', pricing: '', caseStudies: '' },
      reason: '',
      reasonEvidence: []
    },
    how: { monthlyPrice: null, marginRate: null, retentionScenarios: [], estimatedCac: null, cacBasis: '', automation: '' },
    stage: 'discovered',
    scores: scores({}, [], null),
    gates: gates(),
    dropReason: '',
    promotedTo: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch
  }
}

export function fullCandidate(id: string, patch: Partial<Candidate> = {}): Candidate {
  return {
    id,
    title: '営業リストの自動作成',
    market: 'IT 企業の法人営業',
    problem: '営業先リストの作成に毎週5時間以上かかる',
    customer: '従業員20〜100人の IT 企業の営業責任者',
    existingServices: [{ name: '既存リストサービス', url: 'https://competitor.example.com/pricing', price: '月額 3万円〜' }],
    aiFit: '公開情報の収集と構造化を AI で代替できる',
    scene: scene(),
    conditions: conditions({ support: ['E001', 'E002'], supportNote: '発注と不満の両方', unknown: '現在の優先順位', next: '直近の業務を確認', status: 'supported' }),
    roles: roles(),
    deliverable: 'その企業の今週の営業先リスト10社と理由',
    monetization: monetization(),
    execution: execution(),
    decision: null,
    who: {
      segment: {
        attribute: '従業員20〜100人の IT 企業',
        situation: '法人営業を強化中',
        behavior: '営業職の求人を出している',
        problem: '営業リスト作成の時間不足',
        purchase: '営業部長が決裁。月5万円まで'
      },
      companies: [company('A社'), company('B社'), company('C社'), company('D社'), company('E社')],
      targetCount: 120,
      targetListSource: 'https://jobs.example.com/search?q=法人営業',
      conditions: { identifiable: true, sharedProblem: true, buyerKnown: true, canPay: true, repeatableContact: true }
    },
    what: {
      jtbd: { surface: '営業リストを作りたい', job: '今週アプローチする企業を見つけたい', purpose: '限られた営業人員で商談数を増やしたい' },
      factors: { severity: 4, frequency: 5, loss: 4, urgency: 3, existingSpend: 4 },
      problemType: 'recurring',
      demandLevel: 'explicit',
      quantification: { hoursPerMonth: 40, hourlyCost: 4000, reductionRate: 0.8, cashSpendMonthly: 30000, opportunityMonthly: 200000 },
      improvement: '商談数が増える'
    },
    where: {
      channels: [
        { channel: 'outreach', state: 'notLooking', axes: { reachability: 4, intent: 3, cost: 3, repeatability: 4, scalability: 3 }, note: '' },
        { channel: 'seo', state: 'searching', axes: { reachability: 3, intent: 4, cost: 4, repeatability: 4, scalability: 4 }, note: '' }
      ],
      triggers: [{ kind: 'salesHiring', company: 'A社', url: 'https://jobs.example.com/a', observedAt: '2026-10-01', note: '' }],
      keywords: [{ keyword: '営業リスト 作成ツール', volume: 1300, intent: 'purchase', competitors: '', ads: true, enterable: true }],
      mentalAvailability: '「営業リスト」で検索したときに出る',
      physicalAvailability: '無料登録ですぐ使える',
      summary: '営業を増員中の IT 企業へ、求人を出した直後に直接営業で接触する'
    },
    why: {
      switching: { expectedValue: 840000, adoptionCost: 50000, switchingRisk: 50000, statusQuoValue: 100000, coexists: false },
      differentiators: [{ kind: 'data', note: '求人の継続収集' }],
      findings: {
        positiveReviews: 'E002: 使いやすさが評価',
        negativeReviews: 'E002: 情報が古い',
        churnPosts: '更新が遅いので解約',
        comparisonArticles: '件数と鮮度で比較',
        pricing: '月3万円〜',
        caseStudies: '導入で商談2倍'
      },
      reason: '求人が出た直後の企業だけを毎週届けるので、営業の初動が早くなる',
      reasonEvidence: ['E001']
    },
    how: {
      monthlyPrice: 30000,
      marginRate: 0.8,
      retentionScenarios: [6, 12, 24, 36],
      estimatedCac: 30000,
      cacBasis: '広告費・営業の人件費・制作費を含める',
      automation: '収集と配信は自動。問い合わせだけ人が受ける'
    },
    stage: 'qualified',
    scores: scores(),
    gates: gates(),
    dropReason: '',
    promotedTo: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch
  }
}

export function fullEvidence(id: string, patch: Partial<ResearchEvidence> = {}): ResearchEvidence {
  return {
    id,
    candidate: 'C001',
    principle: 'what',
    kind: 'spend',
    grade: 'contract',
    subject: '従業員50人の IT 企業',
    problem: '営業リスト作成に時間がかかる',
    event: '営業担当を3名増員',
    behavior: '営業リスト作成を外注した',
    behaviorLevel: 'contract',
    amount: '月額3万円',
    url: `https://orders.example.com/${id}`,
    eventDate: '2026-09-01',
    publishedAt: '2026-09-05',
    publisher: '発注者本人',
    quote: '営業リスト作成を月額3万円で発注',
    checkedAt: '2026-10-10',
    source: '発注サイト',
    fact: '営業リスト作成に月3万円が払われている',
    inference: '同じ規模の企業も払う可能性がある',
    counter: '1社だけの発注で、継続は未確認',
    unknowns: '自社の提案に予算を移すか',
    dupGroup: '',
    state: 'evaluated',
    reading: reading(),
    ...patch
  }
}

export function fullExperiment(id: string, patch: Partial<ResearchExperiment> = {}): ResearchExperiment {
  return {
    id,
    candidate: 'C001',
    principle: 'how',
    method: 'outreach',
    channel: 'outreach',
    hypothesis: '営業部長は月3万円で申し込むか',
    passCondition: '100社で契約2社以上',
    stopCondition: '50社で商談0なら中止',
    status: 'done',
    period: { start: '2026-09-01', end: '2026-09-30' },
    metrics: metrics({
      targets: 100,
      contacted: 80,
      reachedBuyer: 40,
      responded: 10,
      meetings: 8,
      problemMatch: 6,
      proposals: 5,
      purchaseIntent: 3,
      contracts: 2,
      retained: 2,
      expanded: 0,
      spend: 40000,
      revenue: 60000
    }),
    comparison: 'abTest',
    interviews: 5,
    learning: '求人直後の企業は返信が早い',
    ...patch
  }
}

export function emptyData(patch: Partial<ResearchData> = {}): ResearchData {
  return {
    root: '/tmp/research-test',
    research: {
      name: 'テストのリサーチ',
      scope: '日本の B2B',
      weights: { ...DEFAULT_WEIGHTS },
      cutoffs: { ...DEFAULT_CUTOFFS },
      funnelTargets: { ...DEFAULT_FUNNEL_TARGETS },
      minTargetCount: 100,
      createdAt: NOW
    },
    candidates: [],
    evidence: [],
    experiments: [],
    problems: [],
    ...patch
  }
}

/** fullCandidate C001 と、その根拠の証拠 E001（契約）・E002（レビューの不満。別の媒体） */
export function fullData(patch: Partial<ResearchData> = {}): ResearchData {
  return emptyData({
    candidates: [fullCandidate('C001')],
    evidence: [
      fullEvidence('E001'),
      fullEvidence('E002', { kind: 'complaint', grade: 'reviewComplaint', behaviorLevel: 'opinion', url: 'https://reviews.example.net/x', quote: '情報が古い', source: 'レビューサイト' })
    ],
    ...patch
  })
}
