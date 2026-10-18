/**
 * 事業を進める段階（docs/venture.md 4章。research/stage.ts と同じ5段階・同じ考え方）。
 * 需要 → 初回取引 → 再現性 → 採算 → 運営。前の段階を満たした所までを reached、current は reached の次（全部満たしたら operations）。
 *
 * 需要・初回取引・再現性は「一度示せた証拠」なので全期間のデータで見る（期間を短くしても後戻りしない）。
 * 採算は今の姿を見るので、集計の期間で見る。
 *
 * StageCheck.reason（i18n の venture.phase.reason.<reason>）の一覧:
 * - noData … 判定に使う行が1行も無い（需要: リード・契約のデータなし / 採算: 期間に行が無い）
 * - noEvidence … データはあるが、リード・契約が 0
 * - noDeal … 契約か売上がまだ無い（初回取引）
 * - oneSlot … 契約の出た「経路 × 月」が1つだけ（再現性）
 * - noMargin … 限界利益率が未入力か 0〜1 の外
 * - noRevenue … 期間の売上のデータが無い
 * - noSpend … 期間の費用（spend）のデータが1行も無い
 * - human … 人の判断がまだ（運営）
 */
import { VENTURE_STAGES, type MetricRow, type OperationsDecision, type Period, type PhaseResult, type StageCheck, type VentureConfig, type VentureStage } from './model'
import { aggregateBy, channelOf, hasRowsInPeriod, totals } from './metrics'
import { monthKey } from './period'

/** 0〜1 の限界利益率（ほかは null） */
export function marginRateOf(config: VentureConfig): number | null {
  const v = config?.economics?.marginRate
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null
}

function currencyOf(config: VentureConfig): string {
  return typeof config?.currency === 'string' && config.currency !== '' ? config.currency : 'JPY'
}

/** 需要: 問い合わせ・リード・契約が全期間で1件以上（行動の証拠）。0 件は「まだ分からない」（null）で、false にはしない */
function demandCheck(rows: readonly MetricRow[], currency: string): StageCheck {
  const t = totals(rows, null, currency)
  const leads = t.leads ?? 0
  const contracts = t.contracts ?? 0
  const params = { leads, contracts }
  if (leads + contracts >= 1) return { stage: 'demand', ok: true, params }
  const reason = t.leads === undefined && t.contracts === undefined ? 'noData' : 'noEvidence'
  return { stage: 'demand', ok: null, params, reason }
}

/** 初回取引: 全期間で契約1件以上かつ売上 > 0 */
function firstDealCheck(rows: readonly MetricRow[], currency: string): StageCheck {
  const t = totals(rows, null, currency)
  const contracts = t.contracts ?? 0
  const revenue = t.revenue ?? 0
  const params = { contracts, revenue: Math.round(revenue) }
  if (contracts >= 1 && revenue > 0) return { stage: 'firstDeal', ok: true, params }
  return { stage: 'firstDeal', ok: null, params, reason: 'noDeal' }
}

/** 再現性: 契約の出た「経路 × 月」が全期間で2つ以上（別の経路・別の時期でも成立） */
function repeatabilityCheck(rows: readonly MetricRow[], currency: string): StageCheck {
  const m = aggregateBy(rows, null, currency, (r) => `${channelOf(r)}|${monthKey(r.date)}`)
  let slots = 0
  for (const t of m.values()) if ((t.contracts ?? 0) > 0) slots++
  const params = { slots, min: 2 }
  if (slots >= 2) return { stage: 'repeatability', ok: true, params }
  return { stage: 'repeatability', ok: null, params, reason: slots === 0 ? 'noDeal' : 'oneSlot' }
}

/**
 * 採算: 利益 = 期間の売上 × 限界利益率 − 期間の獲得の費用（成約しなかった経路の費用も入れる）。
 * 利益 > 0 → true、≤ 0 → false。率が無い・期間に行が無い・売上のデータが無い・費用のデータが1行も無いなら null（黙って 0 にしない）。
 * 売上 0・費用 0 はデータがあるので計算する（利益 0 → false）
 */
function unitEconomicsCheck(rows: readonly MetricRow[], period: Period | null, config: VentureConfig, currency: string): StageCheck {
  const rate = marginRateOf(config)
  if (rate === null) return { stage: 'unitEconomics', ok: null, reason: 'noMargin' }
  if (!hasRowsInPeriod(rows, period)) return { stage: 'unitEconomics', ok: null, reason: 'noData' }
  const t = totals(rows, period, currency)
  if (t.revenue === undefined) return { stage: 'unitEconomics', ok: null, reason: 'noRevenue' }
  if (t.spend === undefined) return { stage: 'unitEconomics', ok: null, reason: 'noSpend' }
  const profit = t.revenue * rate - t.spend
  return {
    stage: 'unitEconomics',
    ok: profit > 0,
    params: { profit: Math.round(profit), revenue: Math.round(t.revenue), spend: Math.round(t.spend), marginRate: rate }
  }
}

/** 運営: 人の判断（台帳）。pass → true、fail → false、まだ → null */
function operationsCheck(decision: OperationsDecision): StageCheck {
  if (decision === 'pass') return { stage: 'operations', ok: true }
  if (decision === 'fail') return { stage: 'operations', ok: false }
  return { stage: 'operations', ok: null, reason: 'human' }
}

/**
 * ビジネスの段階。checks は5段階それぞれの確認、reached は先頭から続けて true だった最後の段階（需要も未確認なら null）、
 * current は reached の次（全部満たしたら operations）
 */
export function venturePhase(rows: readonly MetricRow[], period: Period | null, config: VentureConfig, operations: OperationsDecision): PhaseResult {
  const currency = currencyOf(config)
  const checks: Record<VentureStage, StageCheck> = {
    demand: demandCheck(rows, currency),
    firstDeal: firstDealCheck(rows, currency),
    repeatability: repeatabilityCheck(rows, currency),
    unitEconomics: unitEconomicsCheck(rows, period, config, currency),
    operations: operationsCheck(operations)
  }
  let reached: VentureStage | null = null
  for (const s of VENTURE_STAGES) {
    if (checks[s].ok !== true) break
    reached = s
  }
  const i = reached === null ? 0 : Math.min(VENTURE_STAGES.indexOf(reached) + 1, VENTURE_STAGES.length - 1)
  return { reached, current: VENTURE_STAGES[i], checks }
}
