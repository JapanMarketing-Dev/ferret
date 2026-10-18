/**
 * 5原則の完了条件の機械的な確認（docs/business-research/knowledge.md の各原則の「判定方法」「完了条件」）。
 * 記録から確かめられる範囲だけを見る。最後に決めるのは人（ゲート）で、ここは目安と理由を出す。
 *
 * Check.ok の意味:
 * - true:  満たしている
 * - false: 満たさないことが記録から分かった（数が足りないと確定した・人が「いいえ」と判断した・式が負・実測が 0 など）
 * - null:  まだ分からない（未入力・未調査・未計測）。空欄は「未調査」であって「否定」ではない
 * researchDone / experimentDone はすべての Check が true のとき true。
 * Check.id は i18n のキー research.check.<principle>.<id> に当たる。
 */
import { summarizeEvidence, isUsableAsProof } from './evidence'
import { effectiveCac, experimentCac, ltvSensitivity, middleRow, quantify, switchingMargin } from './economics'
import { improvementVerdict, mergeMetrics } from './funnel'
import {
  CHANNEL_AXES,
  DEMAND_FACTORS,
  DIFFERENTIATORS,
  SEGMENT_AXES,
  WHO_CONDITIONS,
  WHY_RESEARCH_ITEMS,
  type Candidate,
  type PrincipleKey,
  type ResearchData,
  type ResearchExperiment
} from './model'

export interface Check {
  /** i18n: research.check.<principle>.<id> */
  id: string
  /** どの原則の確認か（i18n キーを組み立てるため。ゲートの理由として他の原則と混ざって並ぶ） */
  principle: PrincipleKey
  ok: boolean | null
  params?: Record<string, string | number>
}

export interface PrincipleStatus {
  research: Check[]
  experiment: Check[]
  researchDone: boolean
  experimentDone: boolean
}

/** 担当者・到達経路が分かっている企業の割合の目安（ナレッジ「購入担当者を特定できる」「同じ方法で繰り返し接触できる」を 8 割で見る） */
export const COVERAGE_RATIO = 0.8
/** 需要の5要素のうち、点が付いているべき数 */
export const MIN_DEMAND_FACTORS = 4
/** Why の調べる10項目のうち、埋まっているべき数 */
export const MIN_WHY_FINDINGS = 6
/** 感度分析に要る継続月数の仮定の数 */
export const MIN_RETENTION_SCENARIOS = 2
/** LTV/CAC の目安（economics.ts の ltvSensitivity の既定と同じ） */
export const MIN_LTV_RATIO = 3
/** G1 の目安の既定（research.yaml の minTargetCount が不正なとき） */
export const DEFAULT_MIN_TARGET_COUNT = 100

function filled(v: unknown): boolean {
  return typeof v === 'string' && v.trim() !== ''
}

function norm(v: unknown): string {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').toLowerCase() : ''
}

function positive(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

function isZero(v: unknown): boolean {
  return v === 0
}

function arr<T>(v: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(v) ? v : []
}

function check(principle: PrincipleKey, id: string, ok: boolean | null, params?: Record<string, string | number>): Check {
  return params ? { id, principle, ok, params } : { id, principle, ok }
}

/** 割合（%・整数）を params に入れる形で */
function percent(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 100) : 0
}

/** 候補の実験（ID の重複は最初の1件） */
export function candidateExperiments(candidate: Candidate, data: ResearchData): ResearchExperiment[] {
  const seen = new Set<string>()
  return arr(data?.experiments).filter((x) => {
    if (!x || x.candidate !== candidate.id || seen.has(x.id)) return false
    seen.add(x.id)
    return true
  })
}

function minTargetCount(data: ResearchData): number {
  const v = data?.research?.minTargetCount
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_MIN_TARGET_COUNT
}

// ---------------------------------------------------------------- 実験の結果の読み方

/** 実施中・終わった実験（数がある） */
function started(list: readonly ResearchExperiment[]): ResearchExperiment[] {
  return list.filter((x) => x.status !== 'planned')
}

/** 終わった実験（done・stopped）。否定（false）はここからだけ出す（実施中の 0 は「まだ」） */
function finished(list: readonly ResearchExperiment[]): ResearchExperiment[] {
  return list.filter((x) => x.status === 'done' || x.status === 'stopped')
}

// ---------------------------------------------------------------- Who

function whoResearch(c: Candidate, data: ResearchData): Check[] {
  const who = c.who
  const segFilled = SEGMENT_AXES.filter((a) => filled(who?.segment?.[a])).length
  const companies = arr(who?.companies).filter((x) => x && typeof x === 'object')
  const named = new Set(companies.map((x) => norm(x.company)).filter((n) => n !== ''))
  const targetCount = typeof who?.targetCount === 'number' && Number.isFinite(who.targetCount) && who.targetCount >= 0 ? who.targetCount : null
  const count = Math.max(named.size, targetCount ?? 0)
  const min = minTargetCount(data)
  const listOk = count >= min ? true : targetCount !== null ? false : null

  let factsOk: boolean | null = null
  if (companies.length > 0) {
    const mixed = companies.some((x) => filled(x.situation) && filled(x.inferredProblem) && norm(x.situation) === norm(x.inferredProblem))
    const all = companies.every((x) => filled(x.situation) && filled(x.inferredProblem))
    factsOk = mixed ? false : all ? true : null
  }

  const ratioCheck = (id: string, field: 'buyerRole' | 'reachPath'): Check => {
    if (companies.length === 0) return check('who', id, null)
    const n = companies.filter((x) => filled(x[field])).length
    return check('who', id, n / companies.length >= COVERAGE_RATIO ? true : null, { filled: n, total: companies.length, percent: percent(n, companies.length) })
  }

  const conds = WHO_CONDITIONS.map((k) => who?.conditions?.[k])
  const condOk = conds.some((v) => v === false) ? false : conds.every((v) => v === true) ? true : null

  return [
    check('who', 'segmentDefined', segFilled === SEGMENT_AXES.length ? true : null, { filled: segFilled, total: SEGMENT_AXES.length }),
    check('who', 'listBuilt', listOk, { count, min }),
    check('who', 'factsSeparated', factsOk),
    ratioCheck('buyerKnown', 'buyerRole'),
    ratioCheck('repeatableContact', 'reachPath'),
    check('who', 'conditions', condOk, { yes: conds.filter((v) => v === true).length, total: WHO_CONDITIONS.length })
  ]
}

/** 実験: 実際に接触できるか（担当者に届き、商談になった。G3） */
function whoExperiment(exps: readonly ResearchExperiment[]): Check[] {
  const m = mergeMetrics(started(exps))
  const f = mergeMetrics(finished(exps))
  let ok: boolean | null = null
  if (positive(m.reachedBuyer) && positive(m.meetings)) ok = true
  else if (isZero(f.reachedBuyer) || isZero(f.meetings)) ok = false
  return [check('who', 'contactable', ok)]
}

// ---------------------------------------------------------------- What

function whatResearch(c: Candidate, data: ResearchData): Check[] {
  const what = c.what
  const jtbd = [what?.jtbd?.surface, what?.jtbd?.job, what?.jtbd?.purpose].filter(filled).length
  const factors = DEMAND_FACTORS.filter((k) => {
    const v = what?.factors?.[k]
    return v === 1 || v === 2 || v === 3 || v === 4 || v === 5
  }).length
  const q = quantify(what?.quantification)
  const ev = summarizeEvidence(arr(data?.evidence).filter((e) => e && e.candidate === c.id))
  const problemType = what?.problemType
  return [
    check('what', 'jtbd', jtbd === 3 ? true : null, { filled: jtbd, total: 3 }),
    check('what', 'factors', factors >= MIN_DEMAND_FACTORS ? true : null, { filled: factors, min: MIN_DEMAND_FACTORS, total: DEMAND_FACTORS.length }),
    check('what', 'problemType', problemType === 'recurring' || problemType === 'highStakes' || problemType === 'both' ? true : null),
    check('what', 'quantified', q.monthlyTimeCost !== null || q.cashSpend !== null ? true : null),
    check('what', 'spendAndComplaint', ev.spendAndComplaint ? true : null, { spend: ev.spend, complaint: ev.complaint }),
    check('what', 'improvement', filled(what?.improvement) ? true : null)
  ]
}

/** 実験: 本当に解決を求めているか（課題一致か購入意思。G4） */
function whatExperiment(exps: readonly ResearchExperiment[]): Check[] {
  const m = mergeMetrics(started(exps))
  const f = mergeMetrics(finished(exps))
  let ok: boolean | null = null
  if (positive(m.problemMatch) || positive(m.purchaseIntent)) ok = true
  else if (isZero(f.problemMatch) || isZero(f.purchaseIntent)) ok = false
  return [check('what', 'problemConfirmed', ok)]
}

// ---------------------------------------------------------------- Where

function whereResearch(c: Candidate): Check[] {
  const where = c.where
  const evaluated = arr(where?.channels).filter((p) => p && p.state !== null && p.state !== undefined && CHANNEL_AXES.every((a) => typeof p.axes?.[a] === 'number')).length
  const triggers = arr(where?.triggers).filter((t) => t && filled(t.company) && filled(t.url)).length
  const keywords = arr(where?.keywords).filter((k) => k && filled(k.keyword) && k.intent === 'purchase').length
  return [
    check('where', 'channelEvaluated', evaluated > 0 ? true : null, { evaluated }),
    check('where', 'triggerOrIntentKeyword', triggers + keywords > 0 ? true : null, { triggers, keywords }),
    check('where', 'summary', filled(where?.summary) ? true : null)
  ]
}

// ---------------------------------------------------------------- How（Where の実験が使う中央の LTV もここ）

function sensitivity(c: Candidate, exps: readonly ResearchExperiment[]) {
  const cacNow = effectiveCac(c.how, exps)
  const rows = ltvSensitivity(c.how, cacNow.value, MIN_LTV_RATIO)
  return { cacNow, rows, middle: middleRow(rows) }
}

/** 実験: 低コストで顧客を獲得できるか（実測 CAC ≤ 中央の仮定の LTV ÷ 3。G5） */
function whereExperiment(c: Candidate, exps: readonly ResearchExperiment[]): Check[] {
  const measured = experimentCac(exps).cac
  const middle = middleRow(ltvSensitivity(c.how, null))
  if (measured === null || middle === null || middle.ltv === null) return [check('where', 'lowCostAcquisition', null)]
  const limit = middle.ltv / MIN_LTV_RATIO
  return [check('where', 'lowCostAcquisition', measured <= limit, { cac: Math.round(measured), limit: Math.round(limit), months: middle.months })]
}

// ---------------------------------------------------------------- Why

/** 「選ばれる理由」の裏付けになる証拠の数（reasonEvidence のうちデータ内にあり裏付けに使えるもの） */
export function reasonBackingCount(c: Candidate, data: ResearchData): number {
  const ids = new Set(arr(c.why?.reasonEvidence).filter((id) => typeof id === 'string'))
  const list = arr(data?.evidence)
  let n = 0
  for (const id of ids) {
    const e = list.find((x) => x && x.id === id)
    if (e && isUsableAsProof(e)) n++
  }
  return n
}

function whyResearch(c: Candidate, data: ResearchData): Check[] {
  const why = c.why
  const sw = switchingMargin(why?.switching)
  let switchOk: boolean | null = null
  if (why?.switching?.coexists === true || sw.switches === true) switchOk = true
  else if (sw.switches === false) switchOk = false
  const diff = arr(why?.differentiators).filter((d) => d && (DIFFERENTIATORS as readonly string[]).includes(d.kind)).length
  const findings = WHY_RESEARCH_ITEMS.filter((k) => filled(why?.findings?.[k])).length
  const backed = reasonBackingCount(c, data)
  return [
    check('why', 'switchingPositive', switchOk, sw.margin !== null ? { margin: Math.round(sw.margin) } : undefined),
    check('why', 'differentiator', diff > 0 ? true : null, { count: diff }),
    check('why', 'findings', findings >= MIN_WHY_FINDINGS ? true : null, { filled: findings, min: MIN_WHY_FINDINGS, total: WHY_RESEARCH_ITEMS.length }),
    check('why', 'reasonBacked', filled(why?.reason) && backed > 0 ? true : null, { backed })
  ]
}

/** 実験: 自社を選ぶか（購入意思か契約。G4） */
function whyExperiment(exps: readonly ResearchExperiment[]): Check[] {
  const m = mergeMetrics(started(exps))
  const f = mergeMetrics(finished(exps))
  let ok: boolean | null = null
  if (positive(m.purchaseIntent) || positive(m.contracts)) ok = true
  else if (isZero(f.purchaseIntent) || isZero(f.contracts)) ok = false
  return [check('why', 'chosen', ok)]
}

function howResearch(c: Candidate, exps: readonly ResearchExperiment[]): Check[] {
  const how = c.how
  const priceOk = positive(how?.monthlyPrice) && positive(how?.marginRate) && (how.marginRate as number) <= 1
  const { cacNow, rows, middle } = sensitivity(c, exps)
  const params: Record<string, string | number> = { source: cacNow.source }
  if (middle) {
    params.months = middle.months
    if (middle.ratio !== null) params.ratio = Math.round(middle.ratio * 10) / 10
  }
  return [
    check('how', 'pricing', priceOk ? true : null),
    check('how', 'scenarios', rows.length >= MIN_RETENTION_SCENARIOS ? true : null, { count: rows.length, min: MIN_RETENTION_SCENARIOS }),
    check('how', 'cacBasis', filled(how?.cacBasis) ? true : null),
    check('how', 'viableMiddle', middle ? middle.viable : null, params)
  ]
}

/** 実験: 利益と継続率が成立するか（実測 CAC・継続した顧客・比較で効果を言える実験。G5・G7） */
function howExperiment(exps: readonly ResearchExperiment[]): Check[] {
  const measured = experimentCac(exps).cac
  const retained = mergeMetrics(started(exps)).retained
  const proven = exps.filter((x) => improvementVerdict(x) === 'proven').length
  const ok = measured !== null && positive(retained) && proven > 0 ? true : null
  return [check('how', 'measuredAndProven', ok, { proven })]
}

function status(research: Check[], experiment: Check[]): PrincipleStatus {
  return {
    research,
    experiment,
    researchDone: research.every((c) => c.ok === true),
    experimentDone: experiment.every((c) => c.ok === true)
  }
}

/** 候補の5原則それぞれの完了条件（リサーチで確かめること・実験で確かめること） */
export function principleStatus(candidate: Candidate, data: ResearchData): Record<PrincipleKey, PrincipleStatus> {
  const exps = candidateExperiments(candidate, data)
  return {
    who: status(whoResearch(candidate, data), whoExperiment(exps)),
    what: status(whatResearch(candidate, data), whatExperiment(exps)),
    where: status(whereResearch(candidate), whereExperiment(candidate, exps)),
    why: status(whyResearch(candidate, data), whyExperiment(exps)),
    how: status(howResearch(candidate, exps), howExperiment(exps))
  }
}
