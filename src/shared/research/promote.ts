/**
 * 「プロジェクトにする」で作るビジネスの最初の記録（純粋な関数。書き込みは main の research:promote）。
 * business-ADE の S1〜S5（対象の1文・証拠・束ね・代替・判定）に当たる部分を候補の調査で埋めた状態で始め、S6（提供案）から続ける。
 * 仮説 H01 は stage 'ネット上の有望仮説'、verdict '進める'（G1〜G3 を人が pass にしたものだけがここへ来る。確かめるのは main の canPromote）。
 *
 * リサーチの点数（1〜5）→ ビジネスの点（0 弱いと確認／1 一部確認／2 具体的に確認／U 未確認）:
 *   1・2 → 0、3 → 1、4・5 → 2、null → U。裏付けに使える証拠（aiInference でなく、url が http(s)、原文か事実がある）が
 *   1件も無ければ、点があっても U（根拠のない点数を持ち込まない）
 *
 * | ビジネス | 元にするリサーチの欄 | 根拠の証拠 |
 * |---|---|---|
 * | D1 急ぐ理由 | what.factors.urgency | 候補の What の証拠 |
 * | D2 放置の損失 | what.factors.loss | 候補の What の証拠 |
 * | D3 解決行動 | scores.spend（既存支出） | scores.spend.evidence |
 * | D4 既存手段の不足 | scores.competition（競争の余地） | scores.competition.evidence |
 * | D5 支払主体と経路 | who.conditions の buyerKnown・canPay（人の判断。両方 true → 2、片方 true → 1、どちらか false → 0） | 候補の Who の証拠 |
 * | A1 対象者の識別 | who.conditions.identifiable（true かつ企業数が minTargetCount 以上 → 2、true → 1、false → 0） | 候補の Who の証拠 |
 * | A2 接点 | scores.reach（顧客到達性） | scores.reach.evidence |
 * | A3 購入タイミング | where.triggers（URL のあるきっかけ 3件以上 → 2、1件以上 → 1） | 候補の Where の証拠 |
 * | A4 獲得の実績 | 常に U（実験の数は X に移し、S9 で確かめる） | — |
 * | P1 結果を出せる | scores.delivery（4・5 → はい、1・2 → いいえ、3 → U） | scores.delivery.evidence |
 * | P2 導入できる | why.switching.coexists（true → はい、ほかは U） | 候補の Why の証拠 |
 * | P3 採算が合う | 常に U（How の数を理由に書く。S9 の実測で決める） | — |
 * | P4 責任を担える | 常に U（how.automation を理由に書く） | — |
 *
 * 証拠の grade → sourceKind（根拠の性質）。readStatus は裏付けに使える証拠だけ「読了」、ほかは「発見のみ」:
 *
 * | grade | sourceKind |
 * |---|---|
 * | contract・budgetedTender | 発注 |
 * | paidUsage・competitorCase | 販売者の説明 |
 * | reviewComplaint・snsComplaint | 本人の経験 |
 * | aiInference | 分析者の推測 |
 * | searchDemand・companyFact | U（当事者の発言ではない） |
 *
 * 評価の工程で reading.match か reading.timing が ng になった証拠は、裏付けに使わない（発見のみ）。
 * 証拠の ID はそのまま使う（E001 はビジネスの ID の形 E\d{2,4} に合う）。
 * dupGroup: 評価済み（state: evaluated）なら dupGroup（空なら自分の ID＝独立した1件）、未評価は U（独立性を確かめていない）。
 * 11項目: subject（＋roles の役職）→ party、publisher → partyBasis、publishedAt → publishedAt、counter → counter、
 *   event → details.scene、behavior → details.action、amount → details.spend（支出の話のとき）、unknowns → details.nextQuestion。
 * 持ち込む証拠: candidate がこの候補のもの＋scores・why.reasonEvidence・conditions の support/counter・roles が指すもの。
 *
 * 購買が起きる場面（scene）→ target の1文と H01 の target・trigger（event）・outcome・whyUnsolved（currentHandling）。
 * 成立条件（conditions）→ 反証のある条件を H01 の biggestCounter の先頭に、reasonToSwitch の支持を whyUnsolved に、
 *   supported でない条件の未確認と次の確認を next に。roles → D5・A1 の理由（推定した役職と確認できた決裁権限を分けて）。
 * monetization と execution → RESEARCH.md。execution は PromotionPlan.execution として business.yaml へ
 *   （plan が空なら実行条件の既定の問い、confirmed は候補のまま）。
 *
 * existingServices → ALT01…（method=名前、cost=料金の原文、offering=高評価レビューの要点、gap=低評価・解約の要点）。
 * what.quantification に時間か現金の支出があれば「現状のやり方」の代替を1件足す。
 *
 * 実験 → X（ID はそのまま）。status: planned → 計画のみ（数は plan）、running → 実施中・done → 完了・stopped → 中止（数は actual）。
 * | リサーチの metrics | ビジネスの数 |
 * |---|---|
 * | contacted | contacts |
 * | responded | replies |
 * | meetings | qualified |
 * | proposals | priced |
 * | contracts | paid |
 * | retained | repurchased |
 * | purchaseIntent | interest |
 * | revenue | revenue |
 * | spend | adCost（獲得費の合計。内訳は S9 で分ける） |
 * | targets・reachedBuyer・problemMatch・expanded | 移さない（reasons に書く） |
 * passCondition・stopCondition（文）は reasons に書き、数の条件（pass・stop）は S6 で人が入れる。
 * 期間が逆（開始 > 終了）のときは終了を空にする（ビジネスの検査で error になるため）。
 */
import { defaultExecution, emptyRecord } from '../business/records'
import {
  nextId,
  type Alternative,
  type Evidence,
  type Experiment,
  type ExperimentNumbers,
  type Hypothesis,
  type ProvisionEntry,
  type Score as BizScore,
  type ScoreEntry as BizScoreEntry,
  type ScoreKey as BizScoreKey,
  type SourceKind,
  type Unknown
} from '../business/model'
import {
  CONDITION_KEYS,
  EXECUTION_KEYS,
  GATE_IDS,
  PRINCIPLE_KEYS,
  ROLE_KEYS,
  SCORE_KEYS,
  type Candidate,
  type ExecutionItem,
  type ExecutionKey,
  type Channel,
  type EvidenceGrade,
  type ExperimentMetrics,
  type PrincipleKey,
  type ResearchData,
  type ResearchEvidence,
  type ResearchExperiment,
  type ResearchExperimentStatus,
  type Score
} from './model'
import { CONDITION_LABELS, DECISION_LABELS, EXECUTION_LABELS, GATE_LABELS, PRINCIPLE_LABELS, ROLE_LABELS, SCORE_LABELS, pick, sceneText, type ResearchLocale } from './context'

export interface PromotionPlan {
  /** ビジネスの名前（business.yaml の name） */
  name: string
  /** 対象の1文（business.yaml の target） */
  target: string
  hypothesis: Hypothesis
  evidence: Evidence[]
  alternatives: Alternative[]
  experiments: Experiment[]
  /** business.yaml の execution（実行条件の4点。plan が空なら既定の問い。confirmed は候補のまま） */
  execution: Record<ExecutionKey, ExecutionItem>
  /** フォルダ直下の RESEARCH.md（由来・購買が起きる場面・成立条件・5原則のまとめ・ゲート・収益のつながり・実行条件・リンク） */
  researchMd: string
}

export const PROMOTED_HYPOTHESIS_ID = 'H01'

const U: Unknown = 'U'

const GRADE_SOURCE: Record<EvidenceGrade, SourceKind | Unknown> = {
  contract: '発注',
  budgetedTender: '発注',
  paidUsage: '販売者の説明',
  competitorCase: '販売者の説明',
  reviewComplaint: '本人の経験',
  snsComplaint: '本人の経験',
  aiInference: '分析者の推測',
  searchDemand: U,
  companyFact: U
}

const STATUS_MAP: Record<ResearchExperimentStatus, Experiment['status']> = {
  planned: '計画のみ',
  running: '実施中',
  done: '完了',
  stopped: '中止'
}

const CHANNEL_LABELS: Record<Channel, { ja: string; en: string }> = {
  seo: { ja: '検索（SEO）', en: 'Search (SEO)' },
  searchAds: { ja: '検索広告', en: 'Search ads' },
  comparison: { ja: '比較ページ・レビュー', en: 'Comparison pages, reviews' },
  outreach: { ja: '直接営業', en: 'Direct outreach' },
  referral: { ja: '紹介・コミュニティ', en: 'Referral, community' },
  freeTool: { ja: '無料ツール・連携', en: 'Free tool, integration' },
  notification: { ja: '通知・メール', en: 'Notifications, email' },
  snsVideo: { ja: 'SNS・動画', en: 'Social, video' }
}

/**
 * 裏付けに使える証拠か（evidence.ts の isUsableAsProof と同じ基準。並行して作るため、ここに同じ判定を持つ）。
 * 評価の工程で match（対象との一致）か timing（時点）が ng になったものは使わない
 */
function usable(e: ResearchEvidence): boolean {
  if (e.reading.match === 'ng' || e.reading.timing === 'ng') return false
  return e.grade !== 'aiInference' && /^https?:\/\/\S+$/i.test(e.url.trim()) && (e.quote.trim() !== '' || e.fact.trim() !== '')
}

/** リサーチの 1〜5 → ビジネスの 0/1/2 */
export function toBusinessScore(s: Score | null): BizScore {
  if (s === null) return U
  if (s <= 2) return 0
  if (s === 3) return 1
  return 2
}

const yen = (n: number | null, locale: ResearchLocale) => (n === null ? 'U' : `${n.toLocaleString(locale === 'en' ? 'en-US' : 'ja-JP')}${pick(locale, ' 円', ' JPY')}`)
const join = (parts: Array<string | null | undefined | false>, sep: string) => parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.trim()).join(sep)

/** 対象の1文（誰が・どの場面で・何を完了したいか）。購買が起きる場面があればそれを使う */
function targetSentence(c: Candidate, locale: ResearchLocale): string {
  const sentence = sceneText(c.scene, locale)
  if (sentence) return sentence
  const who = c.customer.trim() || c.who.segment.attribute.trim()
  const scene = c.who.segment.situation.trim()
  const job = c.what.jtbd.job.trim() || c.problem.trim()
  if (locale === 'en') return join([who || 'U', scene && `when ${scene}`, job && `needs to: ${job}`], ', ')
  if (!scene && !job) return who || 'U'
  return `${who || 'U'}が${scene ? `、${scene}のときに` : ''}${job ? `、${job}` : ''}`
}

interface Mapped {
  entry: BizScoreEntry
  /** 根拠に使った証拠（supports を付ける） */
  evidence: string[]
}

export function buildPromotion(data: ResearchData, candidateId: string, now: string, locale: ResearchLocale): PromotionPlan {
  const c = data.candidates.find((x) => x.id === candidateId)
  if (!c) throw new Error(`candidate ${candidateId} not found`)
  const p = (ja: string, en: string) => pick(locale, ja, en)
  const today = now.slice(0, 10)
  const H = PROMOTED_HYPOTHESIS_ID

  // ---- 持ち込む証拠
  const byId = new Map<string, ResearchEvidence>()
  for (const e of data.evidence) if (!byId.has(e.id)) byId.set(e.id, e)
  const wanted = new Set<string>(data.evidence.filter((e) => e.candidate === c.id).map((e) => e.id))
  for (const k of SCORE_KEYS) for (const id of c.scores[k].evidence) if (byId.has(id)) wanted.add(id)
  for (const id of c.why.reasonEvidence) if (byId.has(id)) wanted.add(id)
  for (const k of CONDITION_KEYS) for (const id of [...c.conditions[k].support, ...c.conditions[k].counter]) if (byId.has(id)) wanted.add(id)
  for (const r of ROLE_KEYS) for (const id of c.roles[r].evidence) if (byId.has(id)) wanted.add(id)
  const sources = [...wanted].sort().map((id) => byId.get(id)!)
  const usableIds = new Set(sources.filter(usable).map((e) => e.id))
  const principleEvidence = (principle: PrincipleKey) => sources.filter((e) => e.principle === principle && usableIds.has(e.id)).map((e) => e.id).slice(0, 10)

  // ---- 点
  const fromScore = (key: (typeof SCORE_KEYS)[number]): Mapped => {
    const s = c.scores[key]
    const backing = s.evidence.filter((id) => usableIds.has(id))
    const head = `${p('リサーチ', 'research')} scores.${key}（${pick(locale, SCORE_LABELS[key].ja, SCORE_LABELS[key].en)}）= ${s.score ?? 'null'}/5`
    if (s.score === null) return { entry: { score: U, evidence: [], reason: `${head}. ${s.reason}`.trim() }, evidence: [] }
    if (backing.length === 0) return { entry: { score: U, evidence: [], reason: `${head}${p('。裏付けに使える証拠が無いので U', '; no usable evidence, so U')}. ${s.reason}`.trim() }, evidence: [] }
    return { entry: { score: toBusinessScore(s.score), evidence: backing, reason: `${head}. ${s.reason}`.trim() }, evidence: backing }
  }
  const fromFactor = (factor: 'urgency' | 'loss'): Mapped => {
    const v = c.what.factors[factor]
    const backing = principleEvidence('what')
    const head = `${p('リサーチ', 'research')} what.factors.${factor} = ${v ?? 'null'}/5`
    if (v === null || backing.length === 0) return { entry: { score: U, evidence: [], reason: v === null ? head : `${head}${p('。裏付けに使える What の証拠が無いので U', '; no usable What evidence, so U')}` }, evidence: [] }
    return { entry: { score: toBusinessScore(v), evidence: backing, reason: head }, evidence: backing }
  }
  const fromJudgement = (value: BizScore, principle: PrincipleKey, reason: string): Mapped => {
    const backing = principleEvidence(principle)
    if (value === U || backing.length === 0) return { entry: { score: U, evidence: [], reason: value === U ? reason : `${reason}${p('。裏付けに使える証拠が無いので U', '; no usable evidence, so U')}` }, evidence: [] }
    return { entry: { score: value, evidence: backing, reason }, evidence: backing }
  }

  const cond = c.who.conditions
  const d5: BizScore = cond.buyerKnown === false || cond.canPay === false ? 0 : cond.buyerKnown && cond.canPay ? 2 : cond.buyerKnown || cond.canPay ? 1 : U
  const companies = Math.max(c.who.companies.length, c.who.targetCount ?? 0)
  const a1: BizScore = cond.identifiable === false ? 0 : cond.identifiable ? (companies >= data.research.minTargetCount ? 2 : 1) : U
  const triggers = c.where.triggers.filter((t) => /^https?:\/\//i.test(t.url.trim())).length
  const a3: BizScore = triggers >= 3 ? 2 : triggers >= 1 ? 1 : U

  /** 役割の一文（推定した役職と、確認できた決裁権限を分けて書く） */
  const roleText = (r: (typeof ROLE_KEYS)[number]) => {
    const role = c.roles[r]
    if (!role.title.trim() && !role.confirmedAuthority.trim()) return ''
    return p(
      `${ROLE_LABELS[r].ja}: ${role.title.trim() || 'U'}（推定）／確認できた決裁権限: ${role.confirmedAuthority.trim() || '未確認'}`,
      `${ROLE_LABELS[r].en}: ${role.title.trim() || 'U'} (estimated) / confirmed authority: ${role.confirmedAuthority.trim() || 'unconfirmed'}`
    )
  }
  const roleOf = new Map<string, string>()
  for (const r of ROLE_KEYS) for (const id of c.roles[r].evidence) if (!roleOf.has(id) && c.roles[r].title.trim()) roleOf.set(id, c.roles[r].title.trim())

  const mapped: Record<BizScoreKey, Mapped> = {
    D1: fromFactor('urgency'),
    D2: fromFactor('loss'),
    D3: fromScore('spend'),
    D4: fromScore('competition'),
    D5: fromJudgement(d5, 'who', join([`${p('人の判断', 'judged by people')} who.conditions.buyerKnown = ${cond.buyerKnown ?? 'null'}, canPay = ${cond.canPay ?? 'null'}`, roleText('budgetOwner')], p('。', '. '))),
    A1: fromJudgement(a1, 'who', join([`who.conditions.identifiable = ${cond.identifiable ?? 'null'}, ${p('企業', 'companies')} ${companies} / ${data.research.minTargetCount}`, roleText('user'), roleText('champion')], p('。', '. '))),
    A2: fromScore('reach'),
    A3: fromJudgement(a3, 'where', `where.triggers ${p('（URL あり）', '(with URL)')} ${triggers}`),
    A4: { entry: { score: U, evidence: [], reason: p('獲得の実績は実験（X）で確かめる（S9）', 'Acquisition results are checked in experiments (X) at S9') }, evidence: [] }
  }

  const delivery = c.scores.delivery
  const deliveryBacking = delivery.evidence.filter((id) => usableIds.has(id))
  const p1: ProvisionEntry =
    delivery.score !== null && delivery.score !== 3 && deliveryBacking.length > 0
      ? { value: delivery.score >= 4 ? 'はい' : 'いいえ', evidence: deliveryBacking, reason: `${p('リサーチ', 'research')} scores.delivery = ${delivery.score}/5. ${delivery.reason}`.trim() }
      : { value: U, evidence: [], reason: `${p('リサーチ', 'research')} scores.delivery = ${delivery.score ?? 'null'}/5. ${c.aiFit}`.trim() }
  const whyBacking = principleEvidence('why')
  const p2: ProvisionEntry =
    c.why.switching.coexists === true && whyBacking.length > 0
      ? { value: 'はい', evidence: whyBacking, reason: p('既存サービスと併用でき、導入作業がほぼ要らない（why.switching.coexists）', 'Coexists with current services with almost no setup (why.switching.coexists)') }
      : { value: U, evidence: [], reason: `why.switching.coexists = ${c.why.switching.coexists ?? 'null'}` }
  const how = c.how
  const p3: ProvisionEntry = {
    value: U,
    evidence: [],
    reason: p(
      `見積り: 月額 ${yen(how.monthlyPrice, locale)}、限界利益率 ${how.marginRate ?? 'U'}、継続 [${how.retentionScenarios.join(', ')}] か月、CAC 見積り ${yen(how.estimatedCac, locale)}（${how.cacBasis || '含め方は未定'}）。S9 の実測で決める`,
      `Estimate: ${yen(how.monthlyPrice, locale)}/month, margin ${how.marginRate ?? 'U'}, retention [${how.retentionScenarios.join(', ')}] months, estimated CAC ${yen(how.estimatedCac, locale)} (${how.cacBasis || 'basis not set'}). Decide with S9 measurements`
    )
  }
  const p4: ProvisionEntry = { value: U, evidence: [], reason: how.automation.trim() || p('提供の体制は未確認', 'Delivery setup not verified') }

  const supports = new Map<string, BizScoreKey[]>()
  for (const [key, m] of Object.entries(mapped) as Array<[BizScoreKey, Mapped]>) {
    for (const id of m.evidence) supports.set(id, [...(supports.get(id) ?? []), key])
  }

  // ---- 証拠
  const evidence: Evidence[] = sources.map((e) => {
    const base = emptyRecord('evidence', e.id, now)
    const spend = e.kind === 'spend' || e.kind === 'purchase'
    const complaint = e.kind === 'complaint'
    return {
      ...base,
      hypotheses: [H],
      party: join([e.subject, roleOf.get(e.id)], ' / ') || (e.principle === 'who' ? c.customer : ''),
      partyBasis: e.publisher,
      // 評価済みで dupGroup が空なら独立した1件（自分の ID）。未評価は独立性を確かめていないので U
      dupGroup: e.state === 'evaluated' ? e.dupGroup.trim() || e.id : U,
      sourceKind: GRADE_SOURCE[e.grade],
      medium: e.source,
      url: e.url,
      publishedAt: e.publishedAt,
      checkedAt: e.checkedAt || today,
      readStatus: usableIds.has(e.id) ? '読了' : '発見のみ',
      facts: e.fact,
      quote: e.quote,
      interpretation: join(
        [
          e.inference,
          `${p('リサーチの証拠の種類', 'research grade')}: ${e.grade}（${e.principle}・${e.kind}・${e.behaviorLevel}・${e.state}）`,
          e.eventDate && `${p('出来事の日', 'event date')}: ${e.eventDate}`
        ],
        '\n'
      ),
      supports: supports.get(e.id) ?? [],
      counter: e.counter,
      details: {
        ...base.details,
        scene: e.event,
        action: e.behavior,
        spend: spend ? e.amount || e.fact : '',
        gap: complaint ? e.fact : '',
        nextQuestion: e.unknowns
      }
    }
  })

  // ---- 代替
  const alternatives: Alternative[] = []
  const addAlternative = (fields: Omit<Alternative, 'id' | 'hypothesis'>) => {
    if (alternatives.length >= 99) return
    alternatives.push({ id: nextId('alternative', alternatives.map((a) => a.id)), hypothesis: H, ...fields })
  }
  const checkedAt = c.updatedAt.slice(0, 10) || today
  const offering = c.why.findings.positiveReviews.trim()
  const gap = join([c.why.findings.negativeReviews, c.why.findings.churnPosts], '\n')
  const nextCheck = p('S7 の聞き取りで、この手段に残る不足と乗り換えの条件を確かめる', 'At S7, confirm in interviews what this option leaves unsolved and what would make them switch')
  for (const s of c.existingServices) {
    if (!s.name.trim() && !s.url.trim()) continue
    addAlternative({ method: s.name.trim() || s.url.trim(), offering, cost: s.price, gap, nextCheck, url: s.url, checkedAt })
  }
  const q = c.what.quantification
  if (q.hoursPerMonth !== null || q.cashSpendMonthly !== null) {
    const timeCost = q.hoursPerMonth !== null && q.hourlyCost !== null ? q.hoursPerMonth * q.hourlyCost : null
    addAlternative({
      method: p('現状のやり方（社内の手作業・既存の支出）', 'Current way (in-house manual work, existing spend)'),
      offering: c.what.jtbd.surface,
      cost: p(
        `時間: 月 ${q.hoursPerMonth ?? 'U'} 時間（時間の換算 ${yen(timeCost, locale)}/月）／現金: ${yen(q.cashSpendMonthly, locale)}/月`,
        `Time: ${q.hoursPerMonth ?? 'U'} h/month (≈ ${yen(timeCost, locale)}/month in time) / cash: ${yen(q.cashSpendMonthly, locale)}/month`
      ),
      gap: c.problem,
      nextCheck,
      url: '',
      checkedAt
    })
  }

  // ---- 実験
  const experiments: Experiment[] = data.experiments.filter((x) => x.candidate === c.id).map((x) => promoteExperiment(x, c, now, locale))

  // ---- 仮説 H01
  const sw = c.why.switching
  const margin = sw.expectedValue !== null && sw.adoptionCost !== null && sw.switchingRisk !== null && sw.statusQuoValue !== null ? sw.expectedValue - sw.adoptionCost - sw.switchingRisk - sw.statusQuoValue : null
  const name = c.title.trim() || c.market.trim() || c.id
  const target = targetSentence(c, locale)
  const condLabel = (k: (typeof CONDITION_KEYS)[number]) => pick(locale, CONDITION_LABELS[k].ja, CONDITION_LABELS[k].en)
  // 反証のある条件（重要な条件への反証を、ほかの高得点で埋もれさせない）
  const counterText = CONDITION_KEYS.filter((k) => c.conditions[k].counter.length > 0 || c.conditions[k].status === 'refuted')
    .map((k) => `${p('反証', 'Counter')}（${condLabel(k)}・${c.conditions[k].status}）: ${c.conditions[k].counterNote || '-'}（${c.conditions[k].counter.join(', ') || '-'}）`)
    .join('\n')
  // 支持が固まっていない条件の、未確認と次の確認
  const nextChecks = CONDITION_KEYS.filter((k) => c.conditions[k].status !== 'supported' && (c.conditions[k].next.trim() || c.conditions[k].unknown.trim()))
    .map((k) => `${condLabel(k)}: ${join([c.conditions[k].unknown && `${p('未確認', 'unverified')} ${c.conditions[k].unknown}`, c.conditions[k].next && `${p('次の確認', 'next')} ${c.conditions[k].next}`], '／')}`)
    .join('\n')
  const hypothesis: Hypothesis = {
    ...emptyRecord('hypothesis', H, now),
    name,
    stage: 'ネット上の有望仮説',
    target,
    trigger: join([c.scene.event, c.who.segment.situation, ...c.where.triggers.slice(0, 5).map((t) => join([t.kind, t.company, t.observedAt], ' '))], '\n'),
    outcome: c.scene.outcome.trim() || c.what.jtbd.purpose.trim() || c.what.improvement,
    problem: join(
      [
        c.problem,
        c.what.jtbd.job && `JTBD: ${join([c.what.jtbd.surface, c.what.jtbd.job, c.what.jtbd.purpose], ' → ')}`,
        p(`課題の種類: ${c.what.problemType}／需要の段階: ${c.what.demandLevel}`, `Problem type: ${c.what.problemType} / demand level: ${c.what.demandLevel}`)
      ],
      '\n'
    ),
    offer: c.aiFit,
    whyUnsolved: join([
      c.scene.currentHandling && `${p('今の対処', 'Current handling')}: ${c.scene.currentHandling}`,
      c.conditions.reasonToSwitch.supportNote && `${p('変更する理由（支持）', 'Reason to change (support)')}: ${c.conditions.reasonToSwitch.supportNote}（${c.conditions.reasonToSwitch.support.join(', ')}）`,
      gap,
      c.why.reason && `${p('選ばれる理由', 'Reason to choose us')}: ${c.why.reason}（${c.why.reasonEvidence.join(', ')}）`], '\n'),
    biggestCounter: join([counterText, p(
      `乗り換え: 期待価値 ${yen(sw.expectedValue, locale)} − 導入負担 ${yen(sw.adoptionCost, locale)} − 乗り換えリスク ${yen(sw.switchingRisk, locale)} − 現状維持 ${yen(sw.statusQuoValue, locale)} = ${yen(margin, locale)}／併用できるか: ${sw.coexists ?? 'U'}。乗り換えコストが上回れば売れない`,
      `Switching: expected value ${yen(sw.expectedValue, locale)} − adoption ${yen(sw.adoptionCost, locale)} − risk ${yen(sw.switchingRisk, locale)} − status quo ${yen(sw.statusQuoValue, locale)} = ${yen(margin, locale)} / coexists: ${sw.coexists ?? 'U'}. It will not sell if switching costs outweigh this`
    )], '\n'),
    next: join([p(
      `S6: 提供の1文・範囲・価格を決め、実験の合格条件と中止条件を数で入れる${experiments.length ? `（リサーチの実験 ${experiments.map((x) => x.id).join(', ')} を引き継いだ）` : ''}`,
      `S6: write the one-sentence offer, scope and price, and set numeric pass/stop conditions${experiments.length ? ` (carried over research experiments ${experiments.map((x) => x.id).join(', ')})` : ''}`
    ), nextChecks], '\n'),
    checker: p('Ferret リサーチ', 'Ferret research'),
    checkedAt: today,
    demand: { D1: mapped.D1.entry, D2: mapped.D2.entry, D3: mapped.D3.entry, D4: mapped.D4.entry, D5: mapped.D5.entry },
    acquisition: { A1: mapped.A1.entry, A2: mapped.A2.entry, A3: mapped.A3.entry, A4: mapped.A4.entry },
    provision: { P1: p1, P2: p2, P3: p3, P4: p4 },
    verdict: '進める',
    stageHistory: [{ from: '探索メモ', to: 'ネット上の有望仮説', at: now, note: p(`リサーチ「${data.research.name}」の候補 ${c.id} から（G1〜G3 は人が pass）`, `From candidate ${c.id} of research "${data.research.name}" (G1–G3 passed by people)`) }]
  }

  // plan が空なら既定の問い（ビジネス側の defaultExecution と同じ文。business.yaml の execution と一致させる）
  const execution = defaultExecution(locale, c.execution)

  return { name, target, hypothesis, evidence, alternatives, experiments, execution, researchMd: researchMarkdown(data, c, now, locale, { hypothesis, evidence, alternatives, experiments, execution }) }
}

function mapMetrics(m: ExperimentMetrics, spendInto: ExperimentNumbers): ExperimentNumbers {
  return {
    ...spendInto,
    contacts: m.contacted,
    replies: m.responded,
    qualified: m.meetings,
    priced: m.proposals,
    paid: m.contracts,
    repurchased: m.retained,
    interest: m.purchaseIntent,
    revenue: m.revenue,
    adCost: m.spend
  }
}

function isoDay(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!m) return null
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const d = new Date(t)
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? t : null
}

function promoteExperiment(x: ResearchExperiment, c: Candidate, now: string, locale: ResearchLocale): Experiment {
  const p = (ja: string, en: string) => pick(locale, ja, en)
  const base = emptyRecord('experiment', x.id, now)
  const status = STATUS_MAP[x.status]
  const numbers = mapMetrics(x.metrics, base.plan)
  const start = isoDay(x.period.start)
  const end = isoDay(x.period.end)
  const reversed = start !== null && end !== null && start > end
  const notMoved = (['targets', 'reachedBuyer', 'problemMatch', 'expanded'] as const).filter((k) => x.metrics[k] !== null).map((k) => `${k} ${x.metrics[k]}`)
  return {
    ...base,
    hypothesis: PROMOTED_HYPOTHESIS_ID,
    status,
    question: x.hypothesis,
    targetCondition: join([c.who.segment.attribute, c.who.segment.situation], p('、', ', ')),
    channel: x.channel ? pick(locale, CHANNEL_LABELS[x.channel].ja, CHANNEL_LABELS[x.channel].en) : '',
    offer: c.aiFit,
    price: c.how.monthlyPrice !== null ? p(`月額 ${yen(c.how.monthlyPrice, locale)}`, `${yen(c.how.monthlyPrice, locale)}/month`) : '',
    pass: [],
    stop: [],
    period: { start: x.period.start, end: reversed ? '' : x.period.end },
    plan: status === '計画のみ' ? numbers : base.plan,
    actual: status === '計画のみ' ? base.actual : numbers,
    reasons: join(
      [
        x.passCondition && `${p('合格条件（リサーチ）', 'Pass condition (research)')}: ${x.passCondition}`,
        x.stopCondition && `${p('中止条件（リサーチ）', 'Stop condition (research)')}: ${x.stopCondition}`,
        `${p('方法', 'Method')}: ${x.method}／${p('比較', 'comparison')}: ${x.comparison}／${p('聞き取り', 'interviews')}: ${x.interviews ?? 'U'}`,
        notMoved.length > 0 && `${p('移さなかった数', 'Counts not carried over')}: ${notMoved.join(', ')}`,
        x.metrics.spend !== null && p('adCost はリサーチの spend（獲得費の合計）。内訳は S9 で分ける', 'adCost is the research spend (total acquisition cost); split it at S9'),
        reversed && p(`期間の終了（${x.period.end}）が開始より前なので空にした`, `The end date (${x.period.end}) was before the start, so it was cleared`)
      ],
      '\n'
    ),
    conclusion: x.learning
  }
}

function researchMarkdown(
  data: ResearchData,
  c: Candidate,
  now: string,
  locale: ResearchLocale,
  plan: Pick<PromotionPlan, 'hypothesis' | 'evidence' | 'alternatives' | 'experiments' | 'execution'>
): string {
  const p = (ja: string, en: string) => pick(locale, ja, en)
  const root = data.root.replace(/[\\/]+$/, '')
  const cell = (s: string) => s.replace(/\r?\n/g, ' ').replace(/[\\|]/g, (c) => `\\${c}`).trim() || '—'
  const w = c.who
  const m = c.monetization
  // 期待限界利益 = 有料化率 × 有料取引1社の限界利益、差し引き = それ − 無料利用1社の費用（率は 0〜1 の重複を除いて昇順）
  const rates = [...new Set(m.conversionScenarios.filter((r) => Number.isFinite(r) && r > 0 && r <= 1))].sort((a, b) => a - b)
  const conversionRows = rates.map((r) => {
    const expected = m.marginPerDeal === null ? null : Math.round(r * m.marginPerDeal)
    return { label: `${Math.round(r * 10000) / 100}%`, expected, net: expected === null || m.costPerFreeUser === null ? null : expected - m.costPerFreeUser }
  })
  const principleLines: Record<PrincipleKey, string[]> = {
    who: [
      `${p('顧客', 'Customer')}: ${c.customer || 'U'}`,
      `${p('セグメント', 'Segment')}: ${join([w.segment.attribute, w.segment.situation, w.segment.behavior, w.segment.problem, w.segment.purchase], ' / ') || 'U'}`,
      `${p('対象企業', 'Target companies')}: ${w.companies.length}${w.targetCount !== null ? p(`（総数 ${w.targetCount}）`, ` (total ${w.targetCount})`) : ''}${w.targetListSource ? ` — ${w.targetListSource}` : ''}`,
      `${p('判定5条件（人）', 'Five conditions (people)')}: ${Object.entries(w.conditions).map(([k, v]) => `${k} ${v ?? 'null'}`).join(', ')}`
    ],
    what: [
      `${p('課題', 'Problem')}: ${c.problem || 'U'}`,
      `JTBD: ${join([c.what.jtbd.surface, c.what.jtbd.job, c.what.jtbd.purpose], ' → ') || 'U'}`,
      `${p('需要の5要素', 'Demand factors')}: ${Object.entries(c.what.factors).map(([k, v]) => `${k} ${v ?? 'null'}`).join(', ')}（${c.what.problemType}・${c.what.demandLevel}）`,
      `${p('改善', 'Improvement')}: ${c.what.improvement || 'U'}`
    ],
    where: [
      `${p('まとめ', 'Summary')}: ${c.where.summary || 'U'}`,
      `${p('経路', 'Channels')}: ${c.where.channels.map((ch) => ch.channel).join(', ') || 'U'}`,
      `${p('きっかけ', 'Triggers')}: ${c.where.triggers.length}／${p('キーワード', 'keywords')}: ${c.where.keywords.length}`
    ],
    why: [
      `${p('選ばれる理由', 'Reason to choose us')}: ${c.why.reason || 'U'}（${c.why.reasonEvidence.join(', ') || p('裏付けなし', 'no backing')}）`,
      `${p('差別化', 'Differentiators')}: ${c.why.differentiators.map((d) => d.kind).join(', ') || 'U'}`,
      `${p('併用できるか', 'Coexists')}: ${c.why.switching.coexists ?? 'U'}`
    ],
    how: [
      `${p('月額', 'Monthly price')}: ${yen(c.how.monthlyPrice, locale)}／${p('限界利益率', 'margin')}: ${c.how.marginRate ?? 'U'}／${p('継続月数の仮定', 'retention assumptions')}: [${c.how.retentionScenarios.join(', ')}]`,
      `${p('CAC 見積り', 'Estimated CAC')}: ${yen(c.how.estimatedCac, locale)}（${c.how.cacBasis || 'U'}）`,
      `${p('自動化', 'Automation')}: ${c.how.automation || 'U'}`
    ]
  }
  return [
    `# ${p('リサーチからの引き継ぎ', 'Handover from research')}: ${plan.hypothesis.name}`,
    '',
    p(
      `このビジネスは、リサーチ「${data.research.name}」の候補 ${c.id} から ${now} に作った。business-ADE の S1〜S5（対象・証拠・束ね・代替・判定）はリサーチの記録で埋めてあり、S6（提供案）から続ける。`,
      `This business was created on ${now} from candidate ${c.id} of the research "${data.research.name}". S1–S5 (target, evidence, clustering, alternatives, judgement) are filled from the research records; continue from S6 (offer).`
    ),
    '',
    `## ${p('リンク', 'Links')}`,
    '',
    `- ${p('リサーチのフォルダ', 'Research folder')}: ${root}`,
    `- ${p('候補', 'Candidate')}: ${root}/candidates/${c.id}.md`,
    `- ${p('集客の5原則', 'Five principles')}: ${root}/principles/knowledge.md`,
    `- ${p('仮説', 'Hypothesis')}: hypotheses/${plan.hypothesis.id}.md`,
    '',
    `## ${p('購買が起きる場面', 'Purchase scene')}`,
    '',
    sceneText(c.scene, locale) ?? p('（未記入）', '(not written)'),
    '',
    `## ${p('成立条件（評価の主軸）', 'Conditions for success (main axis of evaluation)')}`,
    '',
    p('| 成立条件 | 判定 | 支持 | 反証・別の説明 | 未確認 | 次の確認 |', '| Condition | Status | Support | Counter / other explanation | Unverified | Next check |'),
    '|---|---|---|---|---|---|',
    ...CONDITION_KEYS.map((k) => {
      const r = c.conditions[k]
      const alarm = r.counter.length > 0 || r.status === 'refuted' ? ' ⚠' : ''
      return `| ${pick(locale, CONDITION_LABELS[k].ja, CONDITION_LABELS[k].en)}${alarm} | ${r.status} | ${cell(join([r.support.join(', '), r.supportNote], ' '))} | ${cell(join([r.counter.join(', '), r.counterNote], ' '))} | ${cell(r.unknown)} | ${cell(r.next)} |`
    }),
    '',
    `${p('人が決めた次の行動', 'Next action decided by people')}: ${c.decision ? `${c.decision}（${pick(locale, DECISION_LABELS[c.decision].ja, DECISION_LABELS[c.decision].en)}）` : p('未決定', 'not decided')}`,
    '',
    `## ${p('5原則のまとめ', 'Five principles summary')}`,
    '',
    ...PRINCIPLE_KEYS.flatMap((k) => [`### ${pick(locale, PRINCIPLE_LABELS[k].ja, PRINCIPLE_LABELS[k].en)}`, '', ...principleLines[k].map((l) => `- ${l}`), '']),
    `## ${p('ゲート（人の判定）', 'Gates (decided by people)')}`,
    '',
    p('| ゲート | 判定 | メモ | 日時 |', '| Gate | Status | Note | At |'),
    '|---|---|---|---|',
    ...GATE_IDS.map((g) => `| ${g} ${pick(locale, GATE_LABELS[g].ja, GATE_LABELS[g].en)} | ${c.gates[g].status} | ${cell(c.gates[g].note)} | ${cell(c.gates[g].at)} |`),
    '',
    p('G4（購入するか）以降はこのビジネスの実験で確かめる。高い点数でも G4 は省略できない。', 'G4 (will they buy?) and later are verified by this business\'s experiments. A high score never skips G4.'),
    '',
    `## ${p('採点（リサーチ・1〜5）', 'Scores (research, 1–5)')}`,
    '',
    p('| 項目 | 点 | 根拠 | 理由 |', '| Item | Score | Evidence | Reason |'),
    '|---|---|---|---|',
    ...SCORE_KEYS.map((k) => `| ${pick(locale, SCORE_LABELS[k].ja, SCORE_LABELS[k].en)} | ${c.scores[k].score ?? 'null'} | ${c.scores[k].evidence.join(', ') || '—'} | ${cell(c.scores[k].reason)} |`),
    '',
    p(
      'ビジネスの D・A・P への写し方は 1・2 → 0、3 → 1、4・5 → 2。裏付けに使える証拠が無い点は U にした。',
      'Mapped to business D/A/P as 1–2 → 0, 3 → 1, 4–5 → 2. Scores without usable evidence became U.'
    ),
    '',
    `## ${p('無料から有料へのつながり', 'Link from free to paid')}`,
    '',
    `- ${p('集める相手', 'Who you gather')}: ${m.side}／${p('発注の場面', 'ordering scene')}: ${m.orderScene}`,
    `- ${p('つながり', 'Path')}: ${m.freeToPaidPath || 'U'}`,
    `- ${p('評価期間', 'Period')}: ${m.months ?? 'U'} ${p('か月', 'months')}／${p('有料取引1社の限界利益', 'margin per paying company')}: ${yen(m.marginPerDeal, locale)}／${p('無料利用1社の費用', 'cost per free user')}: ${yen(m.costPerFreeUser, locale)}`,
    ...conversionRows.map((r) => `- ${p('有料化率', 'conversion')} ${r.label}: ${p('期待限界利益', 'expected margin')} ${yen(r.expected, locale)}／${p('差し引き', 'net')} ${yen(r.net, locale)}`),
    '',
    `## ${p('実行条件（business.yaml の execution）', 'Execution conditions (execution in business.yaml)')}`,
    '',
    p('| 項目 | 決める内容 | 確認できた |', '| Item | What to decide | Confirmed |'),
    '|---|---|---|',
    ...EXECUTION_KEYS.map((k) => `| ${pick(locale, EXECUTION_LABELS[k].ja, EXECUTION_LABELS[k].en)}${k === 'supply' ? p('（抜けやすい）', ' (easy to miss)') : ''} | ${cell(plan.execution[k].plan)} | ${plan.execution[k].confirmed ? p('はい', 'yes') : p('まだ', 'not yet')} |`),
    '',
    `## ${p('引き継いだ記録', 'Records carried over')}`,
    '',
    `- ${p('仮説', 'Hypothesis')}: ${plan.hypothesis.id}（${plan.hypothesis.stage}・${plan.hypothesis.verdict}）`,
    `- ${p('証拠', 'Evidence')}: ${plan.evidence.map((e) => e.id).join(', ') || p('なし', 'none')}`,
    `- ${p('代替', 'Alternatives')}: ${plan.alternatives.map((a) => `${a.id} ${a.method}`).join(', ') || p('なし', 'none')}`,
    `- ${p('実験', 'Experiments')}: ${plan.experiments.map((x) => `${x.id}（${x.status}）`).join(', ') || p('なし', 'none')}`,
    ''
  ].join('\n')
}
