/**
 * .research/context.md（Agent が最初に読む、いまの状況）と .research/README.md（記録の形式）の文。
 * context.md は記録の生の値だけで書く（段階・人のゲート・点数・空いている欄・次にすること）。
 * 機械の判定（scoring.ts・gates.ts）はここでは使わない。判定は画面と人が見る。
 */
import {
  BEHAVIOR_LEVELS,
  CANDIDATE_STAGES,
  CHANNEL_AXES,
  COMPLAINT_GRADES,
  CONDITION_KEYS,
  CONDITION_STATUSES,
  DEMAND_FACTORS,
  DIFFERENTIATORS,
  EVIDENCE_GRADES,
  EVIDENCE_STATES,
  EXECUTION_KEYS,
  EXIT_KEYS,
  GATE_IDS,
  MONETIZATION_SIDES,
  NEXT_DECISIONS,
  ORDER_SCENES,
  READING_KEYS,
  READING_LEVELS,
  PRINCIPLE_KEYS,
  RESEARCH_CONCLUSION_FILE,
  RESEARCH_CONTEXT_FILE,
  RESEARCH_FILE,
  RESEARCH_KNOWLEDGE_FILE,
  RESEARCH_README_FILE,
  ROLE_KEYS,
  SCENE_KEYS,
  SCORE_KEYS,
  SEGMENT_AXES,
  SPEND_GRADES,
  WHO_CONDITIONS,
  WHY_RESEARCH_ITEMS,
  nextResearchId,
  type Candidate,
  type CandidateStage,
  type ConditionKey,
  type ExecutionKey,
  type ExitKey,
  type GateId,
  type NextDecision,
  type PurchaseScene,
  type RoleKey,
  type PrincipleKey,
  type ResearchData,
  type ResearchRecordKind,
  type ScoreKey
} from './model'
import type { ResearchPromptId } from './ipc'

export type ResearchLocale = 'ja' | 'en'

/** 日英の文を選ぶ */
export function pick(locale: ResearchLocale, ja: string, en: string): string {
  return locale === 'en' ? en : ja
}

// ================================================================ 表記（Agent に渡す文の中だけで使う。画面の表記は i18n）

export const GATE_LABELS: Record<GateId, { ja: string; en: string }> = {
  G1: { ja: '顧客が存在するか（対象企業を特定できる）', en: 'Do customers exist (can we identify target companies)?' },
  G2: { ja: '強い課題があるか（支出・求人・不満などの証拠）', en: 'Is there a strong problem (spending, hiring, complaints)?' },
  G3: { ja: '接触できるか（営業先や検索経路が明確）', en: 'Can we reach them (clear sales targets or search paths)?' },
  G4: { ja: '購入するか（有料契約・予約・具体的な購入意思）', en: 'Will they buy (paid contract, reservation, concrete intent)?' },
  G5: { ja: '利益が残るか（CAC・LTV・回収期間）', en: 'Is it profitable (CAC, LTV, payback)?' },
  G6: { ja: '自動化できるか（代表の稼働を増やさず提供）', en: 'Can it be automated (delivered without more founder time)?' },
  G7: { ja: '拡大できるか（同じ獲得方法を繰り返せる）', en: 'Can it scale (repeat the same acquisition method)?' }
}

export const STAGE_LABELS: Record<CandidateStage, { ja: string; en: string }> = {
  discovered: { ja: '発見', en: 'Discovered' },
  evidenced: { ja: '証拠あり（支出と課題）', en: 'Evidenced (spending and problem)' },
  qualified: { ja: '経路と提供が明確', en: 'Qualified (channel and delivery clear)' },
  testing: { ja: '市場実験中', en: 'Testing' },
  selected: { ja: '選定（購入意思あり）', en: 'Selected (purchase intent confirmed)' },
  dropped: { ja: '除外', en: 'Dropped' }
}

export const PRINCIPLE_LABELS: Record<PrincipleKey, { ja: string; en: string }> = {
  who: { ja: 'Who 誰に売るか', en: 'Who: whom to sell to' },
  what: { ja: 'What 何を解決するか', en: 'What: what problem to solve' },
  where: { ja: 'Where どこで顧客を獲得するか', en: 'Where: where to acquire customers' },
  why: { ja: 'Why なぜ自社が選ばれるか', en: 'Why: why they choose us' },
  how: { ja: 'How どうやって利益を再現するか', en: 'How: how to make profit repeatable' }
}

export const SCORE_LABELS: Record<ScoreKey, { ja: string; en: string }> = {
  demand: { ja: '需要の強さ', en: 'Demand strength' },
  spend: { ja: '既存支出', en: 'Existing spending' },
  reach: { ja: '顧客到達性', en: 'Reachability' },
  profit: { ja: '利益可能性', en: 'Profit potential' },
  competition: { ja: '競争の余地', en: 'Room in competition' },
  delivery: { ja: '提供のしやすさ', en: 'Ease of delivery' }
}

export const CONDITION_LABELS: Record<ConditionKey, { ja: string; en: string }> = {
  problemStrong: { ja: '課題が十分に強い', en: 'The problem is strong enough' },
  targetAndScene: { ja: '対象と購入場面が明確', en: 'The target and purchase scene are clear' },
  reasonToSwitch: { ja: '変更する理由がある', en: 'There is a reason to change' },
  reachable: { ja: '顧客へ到達できる', en: 'Customers can be reached' },
  revenue: { ja: '収益が成立する', en: 'Revenue works' }
}

export const ROLE_LABELS: Record<RoleKey, { ja: string; en: string }> = {
  user: { ja: '実際に使う人', en: 'Person who uses it' },
  champion: { ja: '導入を進める人', en: 'Person who drives adoption' },
  budgetOwner: { ja: '予算・発注を決める人', en: 'Person who decides budget and orders' },
  gatekeeper: { ja: '導入条件を確認する人', en: 'Person who checks adoption conditions' }
}

/** 実行条件の4点の名前（既定の問いはビジネス側の EXECUTION_QUESTIONS） */
export const EXECUTION_LABELS: Record<ExecutionKey, { ja: string; en: string }> = {
  firstDeal: {
    ja: '最初の有料取引',
    en: 'The first paid deal'
  },
  supply: {
    ja: '提供する能力と供給',
    en: 'Capability and supply to deliver'
  },
  firstExperiment: {
    ja: '最初の実験',
    en: 'The first experiment'
  },
  profitOps: {
    ja: '利益と運用',
    en: 'Profit and operations'
  }
}

export const EXIT_LABELS: Record<ExitKey, { ja: string; en: string }> = {
  targetCustomer: { ja: '対象顧客', en: 'Target customer' },
  situation: { ja: '困っている状況', en: 'Situation in which they struggle' },
  currentHandling: { ja: '現在の対処', en: 'Current handling' },
  contactPoint: { ja: '接点', en: 'Contact point' },
  deliverable: { ja: '見せる成果物', en: 'Deliverable to show' },
  revenueLink: { ja: '収益へのつながり', en: 'Link to revenue' }
}

export const DECISION_LABELS: Record<NextDecision, { ja: string; en: string }> = {
  continue: { ja: '調査を続ける', en: 'Continue research' },
  experiment: { ja: '小さく実験する', en: 'Run a small experiment' },
  holdOrDrop: { ja: '保留・除外する', en: 'Hold or drop' },
  invest: { ja: '投資を増やす候補にする', en: 'Candidate for more investment' }
}

const label = (l: { ja: string; en: string }, locale: ResearchLocale) => pick(locale, l.ja, l.en)

/** 購買が起きる場面の一文（「どんな企業の、誰が、何が起きたときに、どんな成果を必要とし、今はどう対処しているか」）。全部空なら null */
export function sceneText(scene: PurchaseScene, locale: ResearchLocale): string | null {
  if (SCENE_KEYS.every((k) => !scene[k].trim())) return null
  const v = (k: keyof PurchaseScene) => scene[k].trim().replace(/[。.]+$/, '') || 'U'
  const ev = v('event')
  // 「〜したとき」「〜したときに」と書かれていても「ときときに」にしない
  const when = /ときに$/.test(ev) ? ev : /とき$/.test(ev) ? `${ev}に` : `${ev}ときに`
  return pick(
    locale,
    `${v('company')}の${v('who')}が、${when}、${v('outcome')}を必要としている。今は${v('currentHandling')}`,
    `At ${v('company')}, ${v('who')}, when ${ev}, needs ${v('outcome')}. Today: ${v('currentHandling')}`
  )
}

/**
 * 調査の終了条件6項目（記録の生の値。埋まっているか）:
 * targetCustomer=scene.company と who.segment のどれか / situation=scene.event / currentHandling=scene.currentHandling /
 * contactPoint=where.channels か、roles に確認できた決裁権限 / deliverable=deliverable / revenueLink=monetization.freeToPaidPath か how.monthlyPrice
 */
export function exitItems(c: Candidate): Record<ExitKey, boolean> {
  const has = (s: string) => s.trim() !== ''
  return {
    targetCustomer: has(c.scene.company) && SEGMENT_AXES.some((a) => has(c.who.segment[a])),
    situation: has(c.scene.event),
    currentHandling: has(c.scene.currentHandling),
    contactPoint: c.where.channels.length > 0 || ROLE_KEYS.some((r) => has(c.roles[r].confirmedAuthority)),
    deliverable: has(c.deliverable),
    revenueLink: has(c.monetization.freeToPaidPath) || c.how.monthlyPrice !== null
  }
}

/**
 * 次の行動の目安（記録の生の値から。決めるのは人で、candidate.decision に書く）:
 * - 成立条件のどれかに反証の証拠があるか、status が refuted → holdOrDrop（現実的な変更で解消できるかを人が見る）
 * - contracts > 0 の実験が2件以上 → invest
 * - 調査の終了条件6項目が埋まった → experiment（残る問いは「使うか・払うか」）
 * - それ以外 → continue
 */
export function decisionHint(c: Candidate, data: Pick<ResearchData, 'experiments'>): { suggestion: NextDecision; conditions: ConditionKey[] } {
  const countered = CONDITION_KEYS.filter((k) => c.conditions[k].counter.length > 0 || c.conditions[k].status === 'refuted')
  if (countered.length) return { suggestion: 'holdOrDrop', conditions: countered }
  const deals = data.experiments.filter((x) => x.candidate === c.id && (x.metrics.contracts ?? 0) > 0).length
  if (deals >= 2) return { suggestion: 'invest', conditions: [] }
  const exit = exitItems(c)
  if (EXIT_KEYS.every((k) => exit[k])) return { suggestion: 'experiment', conditions: [] }
  return { suggestion: 'continue', conditions: [] }
}

// ================================================================ 空いている欄（5原則の不足）

/** 空いている欄1つ。field は YAML の欄の名前（Agent がそのまま探せる）。human は人だけが埋める欄 */
export interface Gap {
  field: string
  human: boolean
}

/** scene は購買が起きる場面、conditions は成立条件の表と証拠の評価（収集とは別の工程） */
export type GapGroup = 'scene' | PrincipleKey | 'conditions' | 'scores'
export const GAP_GROUPS: readonly GapGroup[] = ['scene', ...PRINCIPLE_KEYS, 'conditions', 'scores']

const blank = (s: string) => s.trim() === ''

/** 候補に結び付いた証拠（candidate 欄が一致するもの） */
export function candidateEvidence(c: Candidate, data: Pick<ResearchData, 'evidence'>) {
  return data.evidence.filter((e) => e.candidate === c.id)
}

/**
 * 候補の空いている欄を5原則と採点ごとに並べる（記録の生の値だけ。点数の良し悪しは見ない）。
 * 根拠の無い点数（score はあるが evidence が空）も空いている欄として出す
 */
export function candidateGaps(c: Candidate, data: Pick<ResearchData, 'evidence'>): Record<GapGroup, Gap[]> {
  const out: Record<GapGroup, Gap[]> = { scene: [], who: [], what: [], where: [], why: [], how: [], conditions: [], scores: [] }
  const add = (group: GapGroup, field: string, human = false) => out[group].push({ field, human })
  const evidence = candidateEvidence(c, data)
  const evidenceIds = new Set(data.evidence.map((e) => e.id))

  for (const k of SCENE_KEYS) if (blank(c.scene[k])) add('scene', `scene.${k}`)

  for (const axis of SEGMENT_AXES) if (blank(c.who.segment[axis])) add('who', `who.segment.${axis}`)
  for (const r of ROLE_KEYS) if (blank(c.roles[r].title)) add('who', `roles.${r}.title`)
  if (c.who.companies.length === 0 && c.who.targetCount === null) add('who', 'who.companies')
  if (c.who.companies.some((x) => blank(x.evidenceUrl))) add('who', 'who.companies[].evidenceUrl')
  if (c.who.companies.some((x) => blank(x.buyerRole))) add('who', 'who.companies[].buyerRole')
  if (c.who.companies.some((x) => blank(x.reachPath))) add('who', 'who.companies[].reachPath')
  if (blank(c.who.targetListSource)) add('who', 'who.targetListSource')
  for (const k of WHO_CONDITIONS) if (c.who.conditions[k] === null) add('who', `who.conditions.${k}`, true)

  for (const k of ['surface', 'job', 'purpose'] as const) if (blank(c.what.jtbd[k])) add('what', `what.jtbd.${k}`)
  for (const f of DEMAND_FACTORS) if (c.what.factors[f] === null) add('what', `what.factors.${f}`)
  if (c.what.problemType === 'unknown') add('what', 'what.problemType')
  if (c.what.demandLevel === 'unknown') add('what', 'what.demandLevel')
  const q = c.what.quantification
  for (const k of ['hoursPerMonth', 'hourlyCost', 'reductionRate', 'cashSpendMonthly'] as const) if (q[k] === null) add('what', `what.quantification.${k}`)
  if (blank(c.what.improvement)) add('what', 'what.improvement')
  if (!evidence.some((e) => SPEND_GRADES.includes(e.grade))) add('what', 'evidence(grade: contract|paidUsage|budgetedTender|competitorCase)')
  if (!evidence.some((e) => COMPLAINT_GRADES.includes(e.grade))) add('what', 'evidence(grade: reviewComplaint|snsComplaint)')

  if (c.where.channels.length === 0) add('where', 'where.channels')
  for (const ch of c.where.channels) {
    if (ch.state === null) add('where', `where.channels[${ch.channel}].state`)
    const missing = CHANNEL_AXES.filter((a) => ch.axes[a] === null)
    if (missing.length) add('where', `where.channels[${ch.channel}].axes.${missing.join('|')}`)
  }
  if (c.where.triggers.length === 0) add('where', 'where.triggers')
  if (blank(c.deliverable)) add('where', 'deliverable')
  if (c.where.keywords.length === 0) add('where', 'where.keywords')
  for (const k of ['mentalAvailability', 'physicalAvailability', 'summary'] as const) if (blank(c.where[k])) add('where', `where.${k}`)

  const s = c.why.switching
  for (const k of ['expectedValue', 'adoptionCost', 'switchingRisk', 'statusQuoValue', 'coexists'] as const) if (s[k] === null) add('why', `why.switching.${k}`)
  if (c.why.differentiators.length === 0) add('why', 'why.differentiators')
  for (const item of WHY_RESEARCH_ITEMS) if (blank(c.why.findings[item])) add('why', `why.findings.${item}`)
  if (blank(c.why.reason)) add('why', 'why.reason')
  if (c.why.reasonEvidence.length === 0) add('why', 'why.reasonEvidence')
  else if (c.why.reasonEvidence.some((id) => !evidenceIds.has(id))) add('why', 'why.reasonEvidence(unknown id)')

  const h = c.how
  if (h.monthlyPrice === null) add('how', 'how.monthlyPrice')
  if (h.marginRate === null) add('how', 'how.marginRate')
  if (new Set(h.retentionScenarios.filter((m) => Number.isFinite(m) && m > 0)).size < 2) add('how', 'how.retentionScenarios')
  if (h.estimatedCac === null) add('how', 'how.estimatedCac')
  if (blank(h.cacBasis)) add('how', 'how.cacBasis')
  if (blank(h.automation)) add('how', 'how.automation')
  const m = c.monetization
  if (m.side === 'unknown') add('how', 'monetization.side')
  if (m.orderScene === 'unknown') add('how', 'monetization.orderScene')
  if (blank(m.freeToPaidPath)) add('how', 'monetization.freeToPaidPath')
  for (const k of ['months', 'marginPerDeal', 'costPerFreeUser'] as const) if (m[k] === null) add('how', `monetization.${k}`)
  if (new Set(m.conversionScenarios.filter((r) => Number.isFinite(r) && r > 0 && r <= 1)).size < 2) add('how', 'monetization.conversionScenarios')

  const collected = evidence.filter((e) => e.state !== 'evaluated').map((e) => e.id)
  if (collected.length) add('conditions', `evidence(state: collected): ${collected.slice(0, 20).join(', ')}${collected.length > 20 ? ' …' : ''}`)
  for (const k of CONDITION_KEYS) {
    const row = c.conditions[k]
    if (row.support.length === 0 && row.counter.length === 0) add('conditions', `conditions.${k}.support|counter`)
    else if ([...row.support, ...row.counter].some((id) => !evidenceIds.has(id))) add('conditions', `conditions.${k}(unknown id)`)
    if (blank(row.next) && row.status !== 'supported') add('conditions', `conditions.${k}.next`)
  }

  for (const k of SCORE_KEYS) {
    const entry = c.scores[k]
    if (entry.score === null) add('scores', `scores.${k}`)
    else if (entry.evidence.length === 0) add('scores', `scores.${k}.evidence`)
    else if (entry.evidence.some((id) => !evidenceIds.has(id))) add('scores', `scores.${k}.evidence(unknown id)`)
  }
  return out
}

// ================================================================ 次にすること

/** 人がまだ pass にしていない最初のゲート（記録の生の値。前から順に） */
export function firstOpenGate(c: Candidate): GateId | null {
  return GATE_IDS.find((g) => c.gates[g].status !== 'pass') ?? null
}

/**
 * 次にすること（記録の生の値から）。
 * prompt: 次に Agent に頼む依頼。human: 調べる欄は埋まっていて、人がゲートを判定する番か
 * - G1〜G3 は対応する原則（who・what・where）の空いている欄があれば Agent、無ければ人の判定
 * - G3 まで pass で、選ばれる理由（why）か採点が空なら why・ranking
 * - G4 以降は市場実験。終わった実験に学びが無ければ learning
 */
export interface NextAction {
  gate: GateId | null
  prompt: ResearchPromptId | null
  human: boolean
}

export function nextAction(c: Candidate, data: Pick<ResearchData, 'evidence' | 'experiments'>): NextAction {
  if (c.stage === 'dropped') return { gate: null, prompt: null, human: false }
  const gate = firstOpenGate(c)
  const gaps = candidateGaps(c, data)
  const agentGaps = (g: GapGroup) => gaps[g].some((x) => !x.human)
  const unevaluated = candidateEvidence(c, data).some((e) => e.state !== 'evaluated')
  const desk: Partial<Record<GateId, 'who' | 'what' | 'where'>> = { G1: 'who', G2: 'what', G3: 'where' }
  const principle = gate ? desk[gate] : undefined
  if (gate && principle) {
    if (agentGaps(principle) || agentGaps('scene')) return { gate, prompt: principle, human: false }
    // 集めた証拠は、人がゲートを判定する前に別の工程で評価する
    if (unevaluated) return { gate, prompt: 'evaluate', human: false }
    return { gate, prompt: null, human: true }
  }
  const experiments = data.experiments.filter((x) => x.candidate === c.id)
  if (experiments.some((x) => (x.status === 'done' || x.status === 'stopped') && blank(x.learning))) return { gate, prompt: 'learning', human: false }
  if (agentGaps('why') || agentGaps('scene')) return { gate, prompt: 'why', human: false }
  if (agentGaps('conditions')) return { gate, prompt: 'evaluate', human: false }
  if (agentGaps('scores') || agentGaps('how')) return { gate, prompt: 'ranking', human: false }
  if (gate === null) return { gate, prompt: null, human: false }
  if (!experiments.some((x) => x.status === 'planned' || x.status === 'running')) return { gate, prompt: 'experiment', human: false }
  return { gate, prompt: null, human: true }
}

// ================================================================ context.md

/** context.md に詳しく書く候補の数（それ以上は1行の一覧） */
export const CONTEXT_DETAIL_LIMIT = 20
/** 1行の一覧に書く候補の数（それ以上は数だけ） */
export const CONTEXT_INDEX_LIMIT = 300

const STAGE_PRIORITY: Record<CandidateStage, number> = { testing: 0, selected: 1, qualified: 2, evidenced: 3, discovered: 4, dropped: 5 }

/** 詳しく書く順（実験中 → 選定 → … → 発見、同じ段階は更新が新しい順、最後に ID） */
export function contextOrder(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => STAGE_PRIORITY[a.stage] - STAGE_PRIORITY[b.stage] || (b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** 次の ID（上限なら上限と書き、新しく作らせない） */
export function nextIdOrLimit(kind: ResearchRecordKind, ids: readonly string[], locale: ResearchLocale): string {
  try {
    return nextResearchId(kind, ids)
  } catch {
    return pick(locale, '（ID が上限。新しく作らない）', '(ID limit reached; do not create more)')
  }
}

const num = (v: number | null) => (v === null ? 'null' : String(v))

function promptLabel(id: ResearchPromptId, locale: ResearchLocale): string {
  const labels: Record<ResearchPromptId, [string, string]> = {
    decide: ['参入先を決め切る（結論まで止まらない）', 'Decide where to enter (do not stop until concluded)'],
    discover: ['候補を出す（既存支出から）', 'Discover candidates (from existing spending)'],
    who: ['1 顧客・企業の発見（Who）', '1 Find customers and companies (Who)'],
    what: ['2 需要・支出・不満の証拠（What）', '2 Evidence of demand, spending, complaints (What)'],
    where: ['3 集客経路ときっかけ（Where）', '3 Channels and triggers (Where)'],
    why: ['4 競合・差別化（Why）', '4 Competitors and differentiation (Why)'],
    evaluate: ['証拠の評価と成立条件の表', 'Evaluate evidence and the conditions table'],
    ranking: ['5 採点と経済性（Ranking・How）', '5 Scoring and economics (Ranking, How)'],
    experiment: ['6 市場実験の設計', '6 Design a market experiment'],
    learning: ['6 実験からの学び', '6 Learning from experiments']
  }
  const [ja, en] = labels[id]
  return pick(locale, ja, en)
}

/**
 * 参入先を「決め切った」とみなす条件（6つ）。「参入先を決め切る」の依頼と .research/README.md の両方に入れる
 * （AGENTS.md だけを読んだ Agent も README から辿れる）
 */
export function conclusionDoneConditions(locale: ResearchLocale, nextExperimentId: string): string {
  return pick(
    locale,
    `1. 参入先が1つ（候補の ID）。「A か B」にしない。場面（どんな企業の・誰が・何が起きたとき・どんな成果を必要とし・今はどう対処しているか）、売るもの、価格の仮説、最初の集客経路が書いてある。
2. 選ばなかった候補（除外済みを除く）すべてに、選ばなかった理由が1行ずつある。参入先を含む上位3件は比較表で、勝負を分けた点と証拠の ID がある。
3. 参入先の成立条件がすべて、根拠の証拠の ID（aiInference でない）で支持されているか、反証が無いうえで「未確認」と明記され確かめ方が書いてある。反証が残る（refuted の）条件がある候補は選ばない。
4. 残る不確かさが「実際に使うか・払うか」のように市場実験でしか確かめられないものだけになっている（ネットで調べられることが残っていない）。
5. 最初の市場実験を experiments/ に status: planned で設計してある（次の ID は ${nextExperimentId}。方法・対象・数・合格条件・中止条件を数字で）。不合格のときに次に参入する候補（第2候補）も書いてある。
6. 人が決めること（ゲートの判定・実験の実施）を短いチェックリストで書いてある。`,
    `1. Exactly one entry (a candidate ID), never "A or B", with its scene (at what kind of company, who, when what happens, what outcome they need, how they handle it now), what you sell, a price hypothesis and the first acquisition channel.
2. Every candidate not chosen (except dropped ones) has a one-line reason. The top 3 including the entry are compared in a table with what decided it and evidence IDs.
3. Every condition of the entry is supported by evidence IDs (not aiInference), or has no counter-evidence and is marked "unverified" with how to check it. Never choose a candidate with a refuted condition.
4. The only uncertainties left are ones only a market experiment can answer, such as "will they actually use it and pay" (nothing left that desk research can check).
5. The first market experiment is designed in experiments/ with status: planned (next ID ${nextExperimentId}; method, target, numbers, pass and stop conditions in numbers), and the candidate to enter next if it fails (the runner-up) is named.
6. What people must decide (gate judgements, running the experiment) is written as a short checklist.`
  )
}

export function researchPromptLabel(id: ResearchPromptId, locale: ResearchLocale): string {
  return promptLabel(id, locale)
}

function nextActionText(c: Candidate, a: NextAction, locale: ResearchLocale): string {
  if (c.stage === 'dropped') return pick(locale, '除外済み（何もしない）', 'Dropped (nothing to do)')
  if (a.prompt) return `${promptLabel(a.prompt, locale)}${a.gate ? pick(locale, `（${a.gate} の材料）`, ` (material for ${a.gate})`) : ''}`
  if (a.human && a.gate) return pick(locale, `${a.gate} を人が判定する番（Agent はゲートを書かない）`, `A person decides ${a.gate} (agents never write gates)`)
  if (!a.gate) return pick(locale, 'G1〜G7 がすべて pass。人が「プロジェクトにする」を判断する', 'G1–G7 all passed. A person decides whether to turn it into a project')
  return pick(locale, '実験の実施と記録は人が行う（結果が出たら learning）', 'People run and record the experiment (then learning)')
}

const cell = (s: string) => s.replace(/\r?\n/g, ' ').replace(/[\\|]/g, (c) => `\\${c}`).trim() || '—'
const join2 = (a: string, b: string) => [a.trim(), b.trim()].filter(Boolean).join(' ')

/** 購買が起きる場面・次の行動の目安・調査の終了条件・実行条件・成立条件の表 */
function evaluationLines(c: Candidate, data: ResearchData, locale: ResearchLocale): string[] {
  const p = (ja: string, en: string) => pick(locale, ja, en)
  const scene = sceneText(c.scene, locale)
  const hint = decisionHint(c, data)
  const exit = exitItems(c)
  const missingExit = EXIT_KEYS.filter((k) => !exit[k])
  const confirmed = EXECUTION_KEYS.filter((k) => c.execution[k].confirmed).length
  const countered = hint.conditions.length ? p(`。反証のある条件: ${hint.conditions.join(', ')}`, `; conditions with counter-evidence: ${hint.conditions.join(', ')}`) : ''
  return [
    `- ${p('購買が起きる場面', 'Purchase scene')}: ${scene ?? p('未記入（どの依頼でも最初に書く）', 'not written (write it first in every request)')}`,
    `- ${p('次の行動の目安', 'Next-action hint')}: ${hint.suggestion}${p('（', ' (')}${label(DECISION_LABELS[hint.suggestion], locale)}${countered}${p('）／', ') / ')}${p('人の決定', 'decided by people')}: ${c.decision ?? p('未決定', 'not decided')}`,
    `- ${p('調査の終了条件', 'Exit conditions of research')}: ${EXIT_KEYS.length - missingExit.length}/${EXIT_KEYS.length}${
      missingExit.length
        ? p(`（残り: ${missingExit.map((k) => label(EXIT_LABELS[k], locale)).join('・')}）`, ` (remaining: ${missingExit.map((k) => label(EXIT_LABELS[k], locale)).join(', ')})`)
        : p('（残る問いは「使うか・払うか」→ 実験へ）', ' (the remaining question is "will they use it and pay" → experiment)')
    }`,
    `- ${p('実行条件', 'Execution conditions')}: ${confirmed}/${EXECUTION_KEYS.length} ${p('確認済み', 'confirmed')}${
      c.execution.supply.confirmed ? '' : p('。供給（supply）が未確認（抜けやすい。買い手の発注条件で対応できる供給側がいるか）', ". Supply is unconfirmed (easy to miss: is there a supply side that can meet the buyer's order terms?)")
    }`,
    '',
    p('| 成立条件 | 判定 | 支持 | 反証・別の説明 | 未確認 | 次の確認 |', '| Condition | Status | Support | Counter / other explanation | Unverified | Next check |'),
    '|---|---|---|---|---|---|',
    ...CONDITION_KEYS.map((k) => {
      const r = c.conditions[k]
      const alarm = r.counter.length > 0 || r.status === 'refuted' ? ' ⚠' : ''
      return `| ${k} ${label(CONDITION_LABELS[k], locale)}${alarm} | ${r.status} | ${cell(join2(r.support.join(', '), r.supportNote))} | ${cell(join2(r.counter.join(', '), r.counterNote))} | ${cell(r.unknown)} | ${cell(r.next)} |`
    }),
    ''
  ]
}

function candidateSection(c: Candidate, data: ResearchData, locale: ResearchLocale): string[] {
  const gaps = candidateGaps(c, data)
  const action = nextAction(c, data)
  const evidence = candidateEvidence(c, data)
  const byGrade = EVIDENCE_GRADES.map((g) => [g, evidence.filter((e) => e.grade === g).length] as const).filter(([, n]) => n > 0)
  const experiments = data.experiments.filter((x) => x.candidate === c.id)
  const gates = GATE_IDS.map((g) => `${g} ${c.gates[g].status}`).join(' / ')
  const scores = SCORE_KEYS.map((k) => {
    const e = c.scores[k]
    return `${k} ${e.score === null ? 'null' : e.score}${e.score !== null ? `（${e.evidence.length ? e.evidence.join(', ') : pick(locale, '根拠なし', 'no evidence')}）` : ''}`
  }).join(' / ')
  const lines = [
    `### ${c.id} ${c.title || pick(locale, '（題名なし）', '(untitled)')}`,
    '',
    `- ${pick(locale, '段階', 'Stage')}: ${c.stage}（${label(STAGE_LABELS[c.stage], locale)}）`,
    `- ${pick(locale, '市場 / 顧客 / 課題', 'Market / customer / problem')}: ${c.market || 'U'} / ${c.customer || 'U'} / ${c.problem || 'U'}`,
    `- ${pick(locale, '人のゲート', 'Gates decided by people')}: ${gates}`,
    `- ${pick(locale, '点数（1〜5・根拠の証拠）', 'Scores (1–5, evidence)')}: ${scores}`,
    `- ${pick(locale, '証拠', 'Evidence')}: ${evidence.length}${byGrade.length ? `（${byGrade.map(([g, n]) => `${g} ${n}`).join(', ')}）` : ''}`,
    `- ${pick(locale, '実験', 'Experiments')}: ${experiments.length ? experiments.map((x) => `${x.id} ${x.status}`).join(', ') : pick(locale, 'なし', 'none')}`,
    `- ${pick(locale, '次にすること', 'Next')}: ${nextActionText(c, action, locale)}`
  ]
  if (c.promotedTo) lines.push(`- ${pick(locale, 'プロジェクトにした先', 'Promoted to')}: ${c.promotedTo.folder}（${c.promotedTo.at}）`)
  lines.push(...evaluationLines(c, data, locale))
  if (c.stage !== 'dropped') {
    const groups = GAP_GROUPS.filter((g) => gaps[g].length > 0)
    if (groups.length) {
      lines.push(`- ${pick(locale, '空いている欄', 'Empty fields')}:`)
      for (const g of groups) {
        const head =
          g === 'scores'
            ? pick(locale, '採点', 'Scores')
            : g === 'scene'
              ? pick(locale, '購買が起きる場面', 'Purchase scene')
              : g === 'conditions'
                ? pick(locale, '証拠の評価・成立条件', 'Evidence evaluation, conditions')
                : label(PRINCIPLE_LABELS[g], locale)
        const fields = gaps[g].map((x) => (x.human ? `${x.field}${pick(locale, '（人）', ' (person)')}` : x.field))
        lines.push(`  - ${head}: ${fields.join(', ')}`)
      }
    }
  }
  lines.push(`- ${pick(locale, 'ファイル', 'Files')}: candidates/${c.id}.md${evidence.length ? `, evidence/（${evidence.slice(0, 10).map((e) => e.id).join(', ')}${evidence.length > 10 ? ' …' : ''}）` : ''}${experiments.length ? `, experiments/（${experiments.map((x) => x.id).join(', ')}）` : ''}`)
  lines.push('')
  return lines
}

export function researchContextMarkdown(data: ResearchData, now: string, locale: ResearchLocale): string {
  const r = data.research
  const ordered = contextOrder(data.candidates)
  const detailed = ordered.filter((c) => c.stage !== 'dropped').slice(0, CONTEXT_DETAIL_LIMIT)
  const detailedIds = new Set(detailed.map((c) => c.id))
  const rest = ordered.filter((c) => !detailedIds.has(c.id))
  const counts = CANDIDATE_STAGES.map((s) => `${s} ${data.candidates.filter((c) => c.stage === s).length}`).join(' / ')
  const unlinked = data.evidence.filter((e) => !e.candidate.trim()).length
  const learnings = data.experiments.filter((x) => x.learning.trim()).slice(-10)
  const lines = [
    `# ${pick(locale, 'いまの状況', 'Current state')}（${r.name}）`,
    '',
    pick(locale, `更新: ${now}（Ferret が送るたびに書き直す。手で直さない）`, `Updated: ${now} (Ferret rewrites this on every send; do not edit by hand)`),
    '',
    pick(
      locale,
      `ゴール: 参入する市場を1つに決め切る（人が求めているのは検証の過程ではなく「結局どこに参入するか」）。結論は ${RESEARCH_CONCLUSION_FILE} に書き、どの作業もその更新で終える。`,
      `Goal: settle on exactly one market to enter (people want "where do we enter", not the verification process). Write the decision in ${RESEARCH_CONCLUSION_FILE} and end every task by updating it.`
    ),
    '',
    `- ${pick(locale, '対象範囲', 'Scope')}: ${r.scope || 'U'}`,
    `- ${pick(locale, '候補の段階ごとの数', 'Candidates by stage')}: ${counts}`,
    `- ${pick(locale, 'ファンネルの目安', 'Funnel targets')}: ${Object.entries(r.funnelTargets).map(([k, v]) => `${k} ${v}`).join(' → ')}`,
    `- ${pick(locale, 'G1 の目安（特定できた対象企業の数）', 'G1 target (identified companies)')}: ${r.minTargetCount}`,
    `- ${pick(locale, '記録の数', 'Records')}: ${pick(locale, '候補', 'candidates')} ${data.candidates.length}, ${pick(locale, '証拠', 'evidence')} ${data.evidence.length}${unlinked ? pick(locale, `（候補に結び付いていない ${unlinked}）`, ` (${unlinked} not linked to a candidate)`) : ''}, ${pick(locale, '実験', 'experiments')} ${data.experiments.length}`,
    `- ${pick(locale, '次の ID', 'Next IDs')}: ${pick(locale, '候補', 'candidate')} ${nextIdOrLimit('candidate', data.candidates.map((c) => c.id), locale)}, ${pick(locale, '証拠', 'evidence')} ${nextIdOrLimit('evidence', data.evidence.map((e) => e.id), locale)}, ${pick(locale, '実験', 'experiment')} ${nextIdOrLimit('experiment', data.experiments.map((x) => x.id), locale)}`,
    `- ${pick(locale, '重み / 足切り', 'Weights / cutoffs')}: ${SCORE_KEYS.map((k) => `${k} ${r.weights[k]}/${num(r.cutoffs[k])}`).join(', ')}`,
    '',
    pick(
      locale,
      '検証の順: G1 顧客が存在するか → G2 強い課題があるか → G3 接触できるか → G4 購入するか → G5 利益が残るか → G6 自動化できるか → G7 拡大できるか。ゲートを決めるのは人。高い点数でも G4（購入の検証）は省略できない。',
      'Order of verification: G1 customers exist → G2 strong problem → G3 reachable → G4 they buy → G5 profitable → G6 automatable → G7 scalable. People decide gates. A high score never skips G4 (purchase verification).'
    ),
    '',
    `## ${pick(locale, '候補', 'Candidates')}`,
    ''
  ]
  if (data.candidates.length === 0) lines.push(pick(locale, 'まだ候補が無い（「候補を出す」の依頼から始める）。', 'No candidates yet (start with the "discover" request).'), '')
  for (const c of detailed) lines.push(...candidateSection(c, data, locale))
  if (rest.length) {
    lines.push(`## ${pick(locale, 'ほかの候補（1行）', 'Other candidates (one line each)')}`, '')
    for (const c of rest.slice(0, CONTEXT_INDEX_LIMIT)) lines.push(`- ${c.id} ${c.stage} ${c.title || '-'}${c.stage === 'dropped' && c.dropReason.trim() ? `（${pick(locale, '除外の理由', 'drop reason')}: ${c.dropReason.trim().split('\n')[0]}）` : ''}`)
    if (rest.length > CONTEXT_INDEX_LIMIT) lines.push(pick(locale, `- ……ほか ${rest.length - CONTEXT_INDEX_LIMIT} 件（candidates/ を見る）`, `- … and ${rest.length - CONTEXT_INDEX_LIMIT} more (see candidates/)`))
    lines.push('')
  }
  if (learnings.length) {
    lines.push(`## ${pick(locale, '実験の学び（新しい順の最大10件）', 'Learnings from experiments (latest 10)')}`, '')
    for (const x of learnings) lines.push(`- ${x.id}（${x.candidate || '-'}・${x.method}${x.channel ? `・${x.channel}` : ''}）: ${x.learning.trim().split('\n')[0]}`)
    lines.push('')
  }
  if (data.problems.length) {
    lines.push(`## ${pick(locale, '読めなかったファイル（直す）', 'Files that could not be read (fix them)')}`, '')
    for (const p of data.problems.slice(0, 30)) lines.push(`- ${p.path}: ${p.message}`)
    lines.push('')
  }
  lines.push(
    `## ${pick(locale, 'ファイルの場所', 'Where files are')}`,
    '',
    `- ${RESEARCH_FILE} … ${pick(locale, '名前・対象範囲・重み・足切り（人が変える）', 'name, scope, weights, cutoffs (people change it)')}`,
    `- candidates/C???.md … ${pick(locale, '候補と5原則の調査', 'candidates and the five-principle research')}`,
    `- evidence/E???.md … ${pick(locale, '証拠', 'evidence')}`,
    `- experiments/X???.md … ${pick(locale, '市場実験', 'market experiments')}`,
    `- ${RESEARCH_KNOWLEDGE_FILE} … ${pick(locale, '集客の5原則（調べ方・判定方法・完了条件の基準）', 'the five principles of customer acquisition (how to research, how to judge, done criteria)')}`,
    `- ${RESEARCH_README_FILE} … ${pick(locale, '記録の形式と、書いてよい欄', 'record format and which fields you may write')}`,
    `- ${RESEARCH_CONTEXT_FILE} … ${pick(locale, 'このファイル', 'this file')}`,
    ''
  )
  return lines.join('\n')
}

// ================================================================ README.md（記録の形式）

type Writer = 'agent' | 'human' | 'ferret'
type FieldRow = readonly [path: string, ja: string, en: string, writer: Writer]

const values = (list: readonly string[]) => list.join(' | ')

const RESEARCH_FILE_FIELDS: readonly FieldRow[] = [
  ['name', 'リサーチの名前', 'Name of the research', 'human'],
  ['scope', '対象範囲（例: 日本の B2B。既存ソフトウェア・データサービス・デジタル BPO への支出）', 'Scope (e.g. Japanese B2B spending on software, data services, digital BPO)', 'human'],
  ['weights.<demand|spend|reach|profit|competition|delivery>', '採点の重み（合計 100 が目安）', 'Score weights (about 100 in total)', 'human'],
  ['cutoffs.<score key>', '足切り（この点より下なら保留。null は足切りなし）', 'Cutoff (below this score the candidate is held; null = none)', 'human'],
  ['funnelTargets.<discovered|evidenced|qualified|testing|selected>', 'ファンネルの目安の数', 'Funnel target counts', 'human'],
  ['minTargetCount', 'G1 の目安（特定できた対象企業の数）', 'G1 target (number of identified target companies)', 'human'],
  ['createdAt', '作った日時（ISO8601）', 'Created at (ISO 8601)', 'ferret']
]

const CANDIDATE_FIELDS: readonly FieldRow[] = [
  ['id', 'C001 の形。ファイル名と同じ', 'C001 style; same as the file name', 'agent'],
  ['title', '題名（市場 × 課題を短く）', 'Title (market × problem, short)', 'agent'],
  ['market', '市場（業界・業務）', 'Market (industry, operation)', 'agent'],
  ['problem', '課題（今すぐ解決したい問題）', 'Problem (what they want solved now)', 'agent'],
  ['customer', '顧客（誰が払うか。業種・規模・部署）', 'Customer (who pays: industry, size, department)', 'agent'],
  ['existingServices[].name / url / price', '既存サービス・既存の支出先。price は原文のまま（例: 月額 3万円〜）', 'Existing services or spending. price verbatim (e.g. from ¥30,000/month)', 'agent'],
  ['aiFit', 'AI で代替・提供できる見込み', 'How AI could replace or deliver it', 'agent'],
  [`scene.<${SCENE_KEYS.join('|')}>`, '購買が起きる場面（必須。どんな企業の・誰が・何が起きたときに・どんな成果を必要とし・今はどう対処しているか）。どの依頼でも最初に書く・直す', 'Purchase scene (required: at what company, who, when what happens, needs what outcome, how they handle it now). Write or fix it first in every request', 'agent'],
  [`conditions.<${CONDITION_KEYS.join('|')}>.support / counter`, '成立条件ごとの支持・反証の証拠 ID（評価の工程で書く。評価の主軸）', 'Supporting / counter evidence IDs per condition (written in the evaluation step; the main axis of evaluation)', 'agent'],
  ['conditions.<key>.supportNote / counterNote / unknown / next', '支持の要約・反証や別の説明の要約・未確認のこと・次の確認', 'Summary of support, summary of counter-evidence or other explanations, what is unverified, next check', 'agent'],
  ['conditions.<key>.status', `${values(CONDITION_STATUSES)}（Agent は提案として書いてよい。人が直す。unverified は需要がないことを意味しない）`, `${values(CONDITION_STATUSES)} (agents may propose; people correct it. unverified does not mean no demand)`, 'agent'],
  [`roles.<${ROLE_KEYS.join('|')}>.title / confirmedAuthority / evidence`, '担当者の役割（使う人・導入を進める人・予算と発注を決める人・導入条件を確認する人）。推定した役職（title）と確認できた決裁権限（confirmedAuthority）は別々に。未確認なら空', 'Roles (user, champion, budget owner, gatekeeper). Keep the estimated title apart from the confirmed decision authority; leave empty if unconfirmed', 'agent'],
  ['deliverable', '最初に見せる成果物（相手の業務に当てはめた実物サンプル）', 'The first deliverable to show (a real sample fitted to their work)', 'agent'],
  [`monetization.side / orderScene`, `集める相手（${values(MONETIZATION_SIDES)}）・発注の場面（${values(ORDER_SCENES)}）`, `Who you gather (${values(MONETIZATION_SIDES)}), ordering scene (${values(ORDER_SCENES)})`, 'agent'],
  ['monetization.freeToPaidPath', '無料利用 → 業務上の必要 → 発注できる担当者 → 条件の相談 → 有料取引、のつながり（文）', 'Free use → business need → person who can order → discussing terms → paid deal (text)', 'agent'],
  ['monetization.months / marginPerDeal / costPerFreeUser / conversionScenarios', '評価期間（月）・有料取引1社の限界利益（円）・無料利用企業1社の獲得・提供・成約前の対応費（円）・試算する有料化率（0〜1。例: [0.005, 0.02, 0.05]）', 'Evaluation period (months), contribution margin per paying company (JPY), cost per free-using company (JPY), paid-conversion rates to test (0–1, e.g. [0.005, 0.02, 0.05])', 'agent'],
  [`execution.<${EXECUTION_KEYS.join('|')}>.plan`, '実行条件の4点で決める内容（最初の有料取引・提供する能力と供給・最初の実験・利益と運用）。特に supply が抜けやすい', 'What to decide for the four execution conditions (first paid deal, capability and supply, first experiment, profit and operations). supply is easy to miss', 'agent'],
  ['execution.<key>.confirmed', '確認できたと言える状態になったか（true / false）', 'Whether it reached the "confirmed" state (true / false)', 'human'],
  ['decision', `人が決めた次の行動（${values(NEXT_DECISIONS)}。null は未決定）`, `Next action decided by people (${values(NEXT_DECISIONS)}; null = not decided)`, 'human'],
  [`who.segment.<${SEGMENT_AXES.join('|')}>`, '顧客を分ける5軸（属性・状況・行動・課題・購買条件）', 'Five segmentation axes (attribute, situation, behavior, problem, purchase conditions)', 'agent'],
  ['who.companies[].company / industry / employees', '企業・業種・従業員数（未確認は null）', 'Company, industry, employees (null if unknown)', 'agent'],
  ['who.companies[].situation', '状況（観測した事実。例: 法人営業を3名募集中）', 'Situation (observed fact, e.g. hiring 3 B2B sales reps)', 'agent'],
  ['who.companies[].inferredProblem', '推定課題（推測。事実と分ける）', 'Inferred problem (inference; keep apart from facts)', 'agent'],
  ['who.companies[].evidenceUrl', '課題の証拠の URL（求人など）', 'URL of the evidence (job post, etc.)', 'agent'],
  ['who.companies[].buyerRole / reachPath', '購買担当候補（例: 営業部長）・到達経路（例: 公式問い合わせ窓口）', 'Likely buyer (e.g. head of sales), reach path (e.g. official contact form)', 'agent'],
  ['who.targetCount', '特定できた対象企業の総数（companies に全部書かないとき。未確認は null）', 'Total identified target companies (when not all are listed; null if unknown)', 'agent'],
  ['who.targetListSource', '名簿の出典（URL・検索条件など）', 'Source of the list (URL, search conditions)', 'agent'],
  [`who.conditions.<${WHO_CONDITIONS.join('|')}>`, 'Who の判定5条件の人の判断（true / false / null）', "People's judgement of the five Who conditions (true / false / null)", 'human'],
  ['what.jtbd.surface / job / purpose', 'JTBD の3層（表面のニーズ・実際の仕事・深い目的）', 'JTBD in three layers (surface need, actual job, deeper purpose)', 'agent'],
  [`what.factors.<${DEMAND_FACTORS.join('|')}>`, '需要の5要素（1〜5。根拠が無ければ null）', 'Five demand factors (1–5; null without evidence)', 'agent'],
  ['what.problemType', 'recurring | highStakes | both | unknown', 'recurring | highStakes | both | unknown', 'agent'],
  ['what.demandLevel', 'urgent | explicit | latent | unaware | unknown', 'urgent | explicit | latent | unaware | unknown', 'agent'],
  ['what.quantification.hoursPerMonth / hourlyCost / reductionRate', '時間 × 単価 × 削減率（削減率は 0〜1）。時間の金銭換算で、現金支出とは別', 'Hours × hourly cost × reduction rate (0–1). Monetised time, not cash', 'agent'],
  ['what.quantification.cashSpendMonthly', 'いま実際に払っている現金（月・円）', 'Cash actually spent now (per month, JPY)', 'agent'],
  ['what.quantification.opportunityMonthly', '売上機会の損失（月・円・推計）', 'Lost revenue opportunity (per month, JPY, estimate)', 'agent'],
  ['what.improvement', '解決すると何が改善するか', 'What improves when solved', 'agent'],
  ['where.channels[].channel', 'seo | searchAds | comparison | outreach | referral | freeTool | notification | snsVideo', 'seo | searchAds | comparison | outreach | referral | freeTool | notification | snsVideo', 'agent'],
  ['where.channels[].state', 'searching | comparing | notLooking | peerInfo | inWorkflow | periodicCheck（null は未確認）', 'searching | comparing | notLooking | peerInfo | inWorkflow | periodicCheck (null if unknown)', 'agent'],
  [`where.channels[].axes.<${CHANNEL_AXES.join('|')}>`, '経路の5軸（1〜5。cost は獲得コストの低さで、高いほど良い）', 'Five channel axes (1–5; cost = how cheap acquisition is, higher is better)', 'agent'],
  ['where.channels[].note', '経路のメモ', 'Channel notes', 'agent'],
  ['where.triggers[].kind / company / url / observedAt / note', 'きっかけの出来事（salesHiring | newDivision | newSite | outsourcing | systemRenewal | other）。observedAt は YYYY-MM-DD', 'Trigger events (salesHiring | newDivision | newSite | outsourcing | systemRenewal | other). observedAt is YYYY-MM-DD', 'agent'],
  ['where.keywords[].keyword / volume / intent / competitors / ads / enterable', '検索キーワード・月の検索数（null は未確認）・意図（info | purchase | unknown）・上位の競合・広告の有無・参入できそうか', 'Keyword, monthly volume (null if unknown), intent (info | purchase | unknown), top competitors, ads shown, enterable', 'agent'],
  ['where.mentalAvailability / physicalAvailability', '購入場面で思い出されるか・見つけて買いやすいか', 'Recalled at the buying moment / easy to find and buy', 'agent'],
  ['where.summary', '顧客がどこにいて、どのタイミングで、どの経路から接触するか（1文）', 'Where customers are, when, and through which channel to reach them (one sentence)', 'agent'],
  ['why.switching.expectedValue / adoptionCost / switchingRisk / statusQuoValue', '乗り換えの式（年額・円）: 期待価値 − 導入負担 − 乗り換えリスク ＞ 現状維持の価値', 'Switching formula (JPY per year): expected value − adoption cost − switching risk > value of status quo', 'agent'],
  ['why.switching.coexists', '既存サービスと併用でき導入作業がほぼ要らないか（true / false / null）', 'Can coexist with the current service with almost no setup (true / false / null)', 'agent'],
  ['why.differentiators[].kind / note', `差別化（${values(DIFFERENTIATORS)}）`, `Differentiation (${values(DIFFERENTIATORS)})`, 'agent'],
  [`why.findings.<${WHY_RESEARCH_ITEMS.join('|')}>`, '購入を決める条件の6項目の調べた内容（証拠の ID を本文に書く）', 'What you found for the six purchase-decision items (cite evidence IDs)', 'agent'],
  ['why.reason', '自社を選ぶ理由（1文）', 'Why they would choose us (one sentence)', 'agent'],
  ['why.reasonEvidence', 'その理由の裏付けの証拠 ID（顧客の実際の評価や行動）', 'Evidence IDs backing the reason (actual customer reviews or behavior)', 'agent'],
  ['how.monthlyPrice / marginRate', '月額の売上（円/社）・限界利益率（0〜1）', 'Monthly revenue (JPY per company), contribution margin (0–1)', 'agent'],
  ['how.retentionScenarios', '継続月数の仮定（感度分析。例: [6, 12, 24, 36]）', 'Assumed retention months (sensitivity, e.g. [6, 12, 24, 36])', 'agent'],
  ['how.estimatedCac / cacBasis', '獲得費用の見積り（円/社）と、CAC に含める費用の決め方', 'Estimated CAC (JPY per company) and what costs it includes', 'agent'],
  ['how.automation', '代表の稼働を増やさず提供できるか（G6 の材料）', 'Can it be delivered without more founder time (material for G6)', 'agent'],
  [`scores.<${SCORE_KEYS.join('|')}>.score / evidence / reason`, '採点（1〜5）・根拠の証拠 ID・理由。根拠が無ければ score: null', 'Score (1–5), evidence IDs, reason. score: null without evidence', 'agent'],
  [`stage`, `${values(CANDIDATE_STAGES)}（人が変える）`, `${values(CANDIDATE_STAGES)} (people change it)`, 'human'],
  [`gates.<${GATE_IDS.join('|')}>.status / note / at`, 'ゲートの人の判定（pass | fail | pending）・メモ・確定日時', "People's gate decisions (pass | fail | pending), note, decided at", 'human'],
  ['dropReason', '除外・保留の理由', 'Reason for dropping or holding', 'human'],
  ['promotedTo', 'プロジェクトにした先（Ferret が書く）', 'Where it was turned into a project (Ferret writes it)', 'ferret'],
  ['createdAt / updatedAt', '作った・更新した日時（ISO8601）', 'Created / updated at (ISO 8601)', 'agent']
]

const EVIDENCE_FIELDS: readonly FieldRow[] = [
  ['id', 'E001 の形。ファイル名と同じ', 'E001 style; same as the file name', 'agent'],
  ['candidate', '結び付く候補（C001…）。どれにも結び付かない発見は空', 'Linked candidate (C001…); empty if none', 'agent'],
  ['principle', `どの原則の材料か（${values(PRINCIPLE_KEYS)}）`, `Which principle it supports (${values(PRINCIPLE_KEYS)})`, 'agent'],
  ['kind', 'search | spend | complaint | hiring | competitor | reach | purchase | other（何の話か）', 'search | spend | complaint | hiring | competitor | reach | purchase | other (what it is about)', 'agent'],
  ['grade', `証拠の強さ（${values(EVIDENCE_GRADES)}）。下の表`, `Strength of evidence (${values(EVIDENCE_GRADES)}). See the table below`, 'agent'],
  ['url', '原典の URL（http/https）', 'Source URL (http/https)', 'agent'],
  ['quote', '原文のまま抜いた文（訳さない・要約しない）', 'Verbatim quote (do not translate or summarise)', 'agent'],
  ['checkedAt', '確認した日（"YYYY-MM-DD"。引用符で囲む）', 'Date you checked it ("YYYY-MM-DD", quoted)', 'agent'],
  ['source', '媒体（例: 発注サイト、レビューサイト、求人サイト、X）', 'Medium (e.g. procurement site, review site, job board, X)', 'agent'],
  ['fact', '観測した事実（原文から言えること）', 'Observed fact (what the source itself says)', 'agent'],
  ['inference', 'そこから導いた推論（fact と同じ文にしない）', 'Inference drawn from it (never the same text as fact)', 'agent'],
  ['subject / problem / event', '企業・対象者・課題・発生した出来事', 'Company or subject, problem, event that occurred', 'agent'],
  ['behavior / behaviorLevel', `観測された行動と、その具体性（${values(BEHAVIOR_LEVELS)}。感想より募集・利用・契約・支払いが強い）`, `Observed behaviour and how concrete it is (${values(BEHAVIOR_LEVELS)}; recruiting, usage, contract and payment are stronger than opinion)`, 'agent'],
  ['amount', '金額・時間・頻度（原文の数のまま）', 'Amount, time, frequency (numbers as in the source)', 'agent'],
  ['eventDate / publishedAt', '出来事の日付と掲載日（"YYYY-MM-DD"。別々に。分からなければ空）', 'Date of the event and publication date ("YYYY-MM-DD", separately; empty if unknown)', 'agent'],
  ['publisher', '情報の発信者（販売者・顧客本人・報道・公的機関など）', 'Publisher of the information (seller, the customer, press, public body, …)', 'agent'],
  ['counter / unknowns', '仮説に合わない事実・別の説明／未確認事項', 'Facts that do not fit the hypothesis or other explanations / unverified points', 'agent'],
  ['dupGroup', '同じ発表・転載のまとまり（同じ値は1件として数える。空なら独立）', 'Group of the same announcement or reposts (same value counts once; empty = independent)', 'agent'],
  ['state', `${values(EVIDENCE_STATES)}（収集の工程は collected、評価の工程で evaluated にする）`, `${values(EVIDENCE_STATES)} (collection writes collected; the evaluation step sets evaluated)`, 'agent'],
  [`reading.<${READING_KEYS.join('|')}>`, `読む5観点（対象との一致・行動の具体性・時点の適切さ・独立性・選ばれ方の偏り）。${values(READING_LEVELS)}。評価の工程で付け、収集の工程では null のまま`, `Five reading viewpoints (match, specificity, timing, independence, selection bias): ${values(READING_LEVELS)}. Set in the evaluation step; null during collection`, 'agent']
]

const EXPERIMENT_FIELDS: readonly FieldRow[] = [
  ['id', 'X001 の形。ファイル名と同じ', 'X001 style; same as the file name', 'agent'],
  ['candidate', '候補の ID', 'Candidate ID', 'agent'],
  ['principle', 'どの原則を確かめる実験か', 'Which principle the experiment tests', 'agent'],
  ['method', 'lpAds | outreach | freeTool | preorder | limitedSale | other', 'lpAds | outreach | freeTool | preorder | limitedSale | other', 'agent'],
  ['channel', '経路（where.channels と同じ値。null も可）', 'Channel (same values as where.channels; may be null)', 'agent'],
  ['hypothesis', '確かめる問い（例: 経理担当は月3万円で申し込むか）', 'Question to test (e.g. will accounting leads sign up at ¥30,000/month?)', 'agent'],
  ['passCondition', '合格の条件（事前に決める。文で。数を入れる）', 'Pass condition (decided beforehand, in words, with numbers)', 'agent'],
  ['stopCondition', '中止の条件（事前に決める。文で。数を入れる）', 'Stop condition (decided beforehand, in words, with numbers)', 'agent'],
  ['status', 'planned | running | done | stopped（Agent は planned だけ書く。進めるのは人）', 'planned | running | done | stopped (agents write planned only; people move it)', 'human'],
  ['period.start / period.end', '期間（"YYYY-MM-DD"）', 'Period ("YYYY-MM-DD")', 'agent'],
  ['metrics.<targets|contacted|reachedBuyer|responded|meetings|problemMatch|proposals|purchaseIntent|contracts|retained|expanded|spend|revenue>', '実測の数（未計測は null。0 と書かない）。人が記録する', 'Measured counts (null if not measured; never 0 for unknown). People record them', 'human'],
  ['comparison', 'abTest | staged | beforeAfter | none（効果の確かめ方）', 'abTest | staged | beforeAfter | none (how the effect is verified)', 'agent'],
  ['interviews', '組み合わせた聞き取りの数（null は未実施）', 'Number of interviews combined (null if none)', 'human'],
  ['learning', '学び（次の評価に反映する）', 'Learning (fed back into the next evaluation)', 'agent']
]

const GRADE_TABLE: ReadonlyArray<readonly [string, string, string, string]> = [
  ['contract', '実際の契約・発注（お金が使われている）', 'Actual contracts or orders (money is spent)', 'high'],
  ['paidUsage', '既存製品の有料利用（市場に支払意思がある）', 'Paid use of existing products (willingness to pay)', 'high'],
  ['budgetedTender', '予算付きの募集・入札（購入する具体的な意思）', 'Budgeted calls or tenders (concrete intent to buy)', 'high'],
  ['competitorCase', '競合の導入事例（課題解決への支出実績）', "Competitors' case studies (spending on the problem)", 'fairlyHigh'],
  ['reviewComplaint', '製品レビューの不満（改善余地）', 'Complaints in product reviews (room to improve)', 'medium'],
  ['searchDemand', '検索需要（情報探索の存在）', 'Search demand (people look for information)', 'medium'],
  ['snsComplaint', 'SNS での不満（課題の存在可能性）', 'Complaints on social media (the problem may exist)', 'lowMedium'],
  ['aiInference', 'AI による課題推測（調査すべき仮説）', 'AI inference about the problem (a hypothesis to research)', 'low'],
  ['companyFact', '企業の状況の事実（公式サイト・求人・プレスリリース。課題の証拠としては数えない）', 'Facts about a company (website, job posts, press releases; not counted as evidence of the problem)', 'medium']
]

const WRITER_LABEL: Record<Writer, { ja: string; en: string }> = {
  agent: { ja: 'Agent・人', en: 'agent, person' },
  human: { ja: '人だけ', en: 'person only' },
  ferret: { ja: 'Ferret', en: 'Ferret' }
}

function fieldTable(rows: readonly FieldRow[], locale: ResearchLocale): string[] {
  return [
    pick(locale, '| 欄 | 意味 | 書く人 |', '| Field | Meaning | Written by |'),
    '|---|---|---|',
    ...rows.map(([path, ja, en, w]) => `| \`${path}\` | ${pick(locale, ja, en)} | ${label(WRITER_LABEL[w], locale)} |`)
  ]
}

/** README.md の欄の一覧（テストで model の欄が全部載っているかを確かめる） */
export const README_FIELD_PATHS: Record<'research' | ResearchRecordKind, readonly string[]> = {
  research: RESEARCH_FILE_FIELDS.map(([p]) => p),
  candidate: CANDIDATE_FIELDS.map(([p]) => p),
  evidence: EVIDENCE_FIELDS.map(([p]) => p),
  experiment: EXPERIMENT_FIELDS.map(([p]) => p)
}

export function researchReadme(locale: ResearchLocale): string {
  const p = (ja: string, en: string) => pick(locale, ja, en)
  return [
    p('# 記録の形式（Ferret ビジネスリサーチ）', '# Record format (Ferret business research)'),
    '',
    p(
      'このフォルダはビジネスリサーチ1件の記録です。人と Agent が同じファイルを読み書きします。調べ方と判定の基準は principles/knowledge.md（集客の5原則）。いまの状況は .research/context.md。',
      'This folder holds one business research. People and agents read and write the same files. How to research and judge is in principles/knowledge.md (the five principles of customer acquisition). The current state is in .research/context.md.'
    ),
    '',
    p(
      '考え方: 事業は「何を作れるか」ではなく「どうすれば顧客を継続的に獲得できるか」から逆算する。リサーチは成功の保証ではなく、失敗確率の高い仮説を安く除外するためのもの。',
      'Mindset: work backwards from "how can we keep acquiring customers", not "what can we build". Research does not guarantee success; it cheaply rules out hypotheses that are likely to fail.'
    ),
    '',
    p('## 置き場所', '## Where things are'),
    '',
    p('| 記録 | ファイル | ID |', '| Record | File | ID |'),
    '|---|---|---|',
    p('| リサーチ | research.yaml | — |', '| Research | research.yaml | — |'),
    p('| 候補 | candidates/C001.md | C001… |', '| Candidate | candidates/C001.md | C001… |'),
    p('| 証拠 | evidence/E001.md | E001… |', '| Evidence | evidence/E001.md | E001… |'),
    p('| 市場実験 | experiments/X001.md | X001… |', '| Market experiment | experiments/X001.md | X001… |'),
    p('| 集客の5原則 | principles/knowledge.md（Ferret が写す） | — |', '| Five principles | principles/knowledge.md (copied by Ferret) | — |'),
    p('| いまの状況 | .research/context.md（Ferret が書く） | — |', '| Current state | .research/context.md (written by Ferret) | — |'),
    p('| 送った依頼 | .research/sent/（Ferret が書く） | — |', '| Sent requests | .research/sent/ (written by Ferret) | — |'),
    '',
    p(
      '記録は先頭の `---` で囲んだ YAML が正本で、その下の本文は自由なメモ（調べた経緯・提案・未確認のこと）です。ID は数字3桁の連番（C001、E012、X003）で、使い回しません。値（段階・種類など）は下の英語の識別子で書きます。数の未確認は null（0 と書かない）。日付は "2026-10-18" のように引用符で囲みます。',
      'The YAML between the leading `---` lines is the source of truth; the body below is free notes (how you researched, proposals, open questions). IDs are 3-digit sequences (C001, E012, X003) and are never reused. Enumerated values (stages, kinds, …) use the English identifiers below. Unknown numbers are null (never 0). Quote dates like "2026-10-18".'
    ),
    '',
    '## research.yaml',
    '',
    ...fieldTable(RESEARCH_FILE_FIELDS, locale),
    '',
    p('## 候補（candidates/C001.md）', '## Candidate (candidates/C001.md)'),
    '',
    ...fieldTable(CANDIDATE_FIELDS, locale),
    '',
    p('## 証拠（evidence/E001.md）', '## Evidence (evidence/E001.md)'),
    '',
    p('1つの観測で1件。観測した事実（fact）と推論（inference）を分けます。収集と評価は別の工程です: 収集では11項目（subject・problem・event・behavior・amount・url・eventDate と publishedAt・publisher・inference・counter・unknowns）を書き、grade は仮、state: collected、reading は null のまま。評価（evaluate の依頼）で読む5観点を付け、grade を見直し、転載に同じ dupGroup を付けて state: evaluated にします。AI が見つけた情報をそのまま自説の根拠にしません。', 'One observation per record. Keep the observed fact apart from the inference. Collection and evaluation are separate steps: collection writes the 11 fields (subject, problem, event, behavior, amount, url, eventDate and publishedAt, publisher, inference, counter, unknowns), a provisional grade, state: collected and reading left null. Evaluation (the evaluate request) sets the five reading viewpoints, reviews the grade, gives reposts the same dupGroup and sets state: evaluated. Never use information an AI found directly as grounds for its own theory.'),
    '',
    ...fieldTable(EVIDENCE_FIELDS, locale),
    '',
    p('### grade（証拠の強さ。上ほど強い）', '### grade (strength of evidence; stronger first)'),
    '',
    p('| grade | 何を示すか | 信頼性 |', '| grade | What it shows | Reliability |'),
    '|---|---|---|',
    ...GRADE_TABLE.map(([g, ja, en, r]) => `| ${g} | ${pick(locale, ja, en)} | ${r} |`),
    '',
    p(
      '- 観測したものの種類で付ける。迷ったら弱い方。\n- AI（自分）の推測・まとめは aiInference。推測を他の種類にしない。\n- 既存支出（contract・paidUsage・budgetedTender・competitorCase）と不満（reviewComplaint・snsComplaint）が同時に確認できる市場を重視する。ただし乗り換えコストが高ければ参入は難しい。\n- 裏付けに使えるのは、aiInference でなく、url が http(s) で、quote か fact があるもの。',
      '- Grade by what you actually observed. When unsure, pick the weaker one.\n- Your own (AI) guesses or summaries are aiInference. Never disguise an inference as another grade.\n- Prefer markets where existing spending (contract, paidUsage, budgetedTender, competitorCase) and complaints (reviewComplaint, snsComplaint) are both confirmed. High switching costs still make entry hard.\n- Only evidence that is not aiInference, has an http(s) url, and has a quote or fact counts as backing.'
    ),
    '',
    p('## 市場実験（experiments/X001.md）', '## Market experiment (experiments/X001.md)'),
    '',
    p(
      '合格条件と中止条件は実施の前に決めます。Agent は設計（status: planned）だけを書き、実施・送信・広告出稿・実測の記録は人がします。AI が改善案を出しただけでは効果があったとは言えません（A/B テスト・段階的展開などの比較が要る。少数のうちは聞き取りと組み合わせる）。',
      'Pass and stop conditions are decided before running. Agents write the design only (status: planned); people run it, send, place ads, and record measurements. An AI suggestion is not proof of effect (compare with A/B tests or staged rollouts; with small numbers, combine with interviews).'
    ),
    '',
    ...fieldTable(EXPERIMENT_FIELDS, locale),
    '',
    p(
      'ファンネル: Who の100社実験は targets → reachedBuyer → meetings → problemMatch → purchaseIntent、B2B 直接営業は targets → contacted → responded → meetings → proposals → contracts → retained → expanded。',
      'Funnels: the 100-company Who test is targets → reachedBuyer → meetings → problemMatch → purchaseIntent; B2B direct sales is targets → contacted → responded → meetings → proposals → contracts → retained → expanded.'
    ),
    '',
    p('## 評価の主軸（成立条件の表）', '## Main axis of evaluation (conditions table)'),
    '',
    p(
      '最初は合計点より、成立に必要な5つの条件ごとに「支持・反証・未確認・次の確認」を記録する（candidates の conditions）。6項目の加重スコア（scores）は比べるための補助。重要な条件への反証は、ほかの高得点で埋もれさせない。「魅力的に見えること」と「証拠が揃っていること」を別々に評価する。',
      'At first, record "support, counter-evidence, unverified, next check" for each of the five conditions for success (conditions in candidates) rather than a total score. The six-item weighted score (scores) is an aid for comparison. Never let counter-evidence against an important condition be buried by high scores elsewhere. Evaluate "looking attractive" and "having the evidence" separately.'
    ),
    '',
    ...CONDITION_KEYS.map((k) => `- ${k} ${label(CONDITION_LABELS[k], locale)}`),
    '',
    p(
      '次の行動は4つ: continue（次の判断を左右する事実が公開情報で確認できそう）／ experiment（対象・課題・提案は具体化したが反応や支払いが未確認）／ holdOrDrop（必須条件への反証があり現実的な変更でも解消できない）／ invest（実顧客で獲得・利用・取引・利益の再現を確認）。調査の終了条件は「対象顧客・困っている状況・現在の対処・接点・見せる成果物・収益へのつながり」が具体化し、残る問いが「使うか・払うか」になったとき。',
      'Four next actions: continue (facts that drive the next decision look confirmable from public information) / experiment (target, problem and proposal are concrete but reactions and payment are unverified) / holdOrDrop (counter-evidence against an essential condition that realistic changes cannot resolve) / invest (acquisition, usage, deals and profit confirmed to repeat with real customers). Research is done when target customer, situation, current handling, contact point, deliverable and link to revenue are concrete and the remaining question is "will they use it and pay".'
    ),
    '',
    p('## ゲート（検証の順。人が決める）', '## Gates (order of verification; people decide)'),
    '',
    ...GATE_IDS.map((g) => `- ${g} ${label(GATE_LABELS[g], locale)}`),
    '',
    p(
      'G1〜G3 はネットリサーチでかなり判断でき、G4 以降は市場実験で確かめる。前のゲートが pass でないものは pass にできない。高い点数でも G4（購入の検証）は省略できない。',
      'G1–G3 can mostly be judged by desk research; G4 onwards needs market experiments. A gate cannot pass before the previous one has. A high score never skips G4 (purchase verification).'
    ),
    '',
    p('## 参入先を決め切った条件（conclusion.md）', '## When the entry decision is settled (conclusion.md)'),
    '',
    p(
      'このリサーチの成果物は conclusion.md（参入する市場を1つに決めた結論）。次の6つをすべて満たしたら決め切ったとみなす。満たすまで調べ続け、どの作業も conclusion.md の更新で終える。',
      'The output of this research is conclusion.md (the decision on the one market to enter). It is settled when all six of the following hold. Keep researching until they do, and end every task by updating conclusion.md.'
    ),
    '',
    conclusionDoneConditions(locale, p('context.md の「次の ID」', '"Next IDs" in context.md')),
    '',
    p('## 書いてよいファイル', '## What you may write'),
    '',
    p(
      '- Agent が書いてよい: conclusion.md（参入先の結論。リサーチの最終の成果物で、決め切るまで書き直す）、candidates/（上の表で「Agent・人」の欄）、evidence/、experiments/（status: planned の設計だけ。metrics は書かない）。本文に提案・未確認のことを書く。\n- 人だけが変える: research.yaml、候補の stage・gates・dropReason・who.conditions・decision・execution の confirmed、実験の status・metrics・interviews。\n- Ferret が書く: .research/、principles/、promotedTo。',
      '- Agents may write: conclusion.md (the entry decision, the final output of the research; keep rewriting it until settled), candidates/ (fields marked "agent, person"), evidence/, experiments/ (designs with status: planned only; never metrics). Put proposals and open questions in the body.\n- People only: research.yaml; candidate stage, gates, dropReason, who.conditions, decision, execution confirmed; experiment status, metrics, interviews.\n- Ferret writes: .research/, principles/, promotedTo.'
    ),
    '',
    p('## しないこと', '## Never do'),
    '',
    p(
      '問い合わせ・営業メール・フォームの送信、応募、広告出稿、課金・購入、ログインが要るサイトの操作、アカウントの作成。ゲートの pass を書くこと（決めるのは人）。根拠の無い点数を書くこと。',
      'Sending inquiries, sales emails or forms; applying; placing ads; paying or purchasing; actions on sites that need a login; creating accounts. Writing a gate pass (people decide). Writing a score without evidence.'
    ),
    ''
  ].join('\n')
}
