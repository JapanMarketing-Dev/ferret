/**
 * 経済性の計算（docs/business-research/knowledge.md 第5原則 How・第2原則の「課題の定量化」・第4原則の「乗り換えの式」）。
 * - 数の未確認は null のまま返す（0 で埋めない）。負・NaN・Infinity は「不正」として null。
 * - CAC = 獲得に要した費用 ÷ 新規有料顧客数。LTV ≈ 月額売上 × 限界利益率 × 継続月数。
 * - 継続月数は新規事業では分からないので、複数の仮定で感度分析する（ltvSensitivity）。
 */
import type { HowResearch, Quantification, ResearchExperiment, SwitchingCase } from './model'

/** 配列でなければ空（壊れた記録への備え。readonly 配列の型を保つ） */
function arr<T>(v: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(v) ? v : []
}

/** 0 以上の有限の数ならその数、それ以外は null */
function nonNeg(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

/** 0〜1 の有限の数ならその数、それ以外は null */
function unitRate(v: unknown): number | null {
  const n = nonNeg(v)
  return n !== null && n <= 1 ? n : null
}

/** 割り算の結果が有限でなければ null（巨大値どうしの掛け算のあふれを防ぐ） */
function finite(v: number): number | null {
  return Number.isFinite(v) ? v : null
}

/**
 * CAC（円/社）= 費用 ÷ 新規有料顧客数。
 * 顧客が0社・費用か顧客数が負・NaN・Infinity・未確認なら null（0社の CAC は「無限大」で、比べられる数にならない）
 */
export function cac(spend: number | null, newCustomers: number | null): number | null {
  const s = nonNeg(spend)
  const c = nonNeg(newCustomers)
  if (s === null || c === null || c === 0) return null
  return finite(s / c)
}

/**
 * LTV（円/社）≈ 月額売上 × 限界利益率 × 継続月数。
 * 月額は 0 以上、利益率は 0〜1、継続月数は 0 より大きいこと。外れれば null
 */
export function ltv(monthlyPrice: number | null, marginRate: number | null, months: number | null): number | null {
  const p = nonNeg(monthlyPrice)
  const m = unitRate(marginRate)
  const n = nonNeg(months)
  if (p === null || m === null || n === null || n === 0) return null
  return finite(p * m * n)
}

/**
 * 回収期間（月）= CAC ÷（月額売上 × 限界利益率）。G5「利益が残るか」の材料。
 * 1か月の利益が 0（無料・利益率0）なら回収できないので null
 */
export function paybackMonths(cacValue: number | null, monthlyPrice: number | null, marginRate: number | null): number | null {
  const c = nonNeg(cacValue)
  const p = nonNeg(monthlyPrice)
  const m = unitRate(marginRate)
  if (c === null || p === null || m === null) return null
  const monthly = p * m
  if (monthly === 0 || !Number.isFinite(monthly)) return null
  return finite(c / monthly)
}

export interface SensitivityRow {
  /** 継続月数の仮定 */
  months: number
  ltv: number | null
  /** LTV ÷ CAC（CAC が 0 か未確認なら null） */
  ratio: number | null
  paybackMonths: number | null
  /** LTV/CAC が minRatio 以上か（CAC 0 なら LTV > 0 で成立。どちらか未確認なら null） */
  viable: boolean | null
}

/** 継続月数の仮定を整える（0 より大きい有限の数だけ・重複を除いて昇順） */
export function retentionMonths(scenarios: unknown): number[] {
  if (!Array.isArray(scenarios)) return []
  const set = new Set<number>()
  for (const v of scenarios) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) set.add(v)
  }
  return [...set].sort((a, b) => a - b)
}

/**
 * LTV の感度分析（継続月数の仮定ごとの LTV・LTV/CAC・回収期間）。
 * minRatio の既定 3 は「LTV が CAC の3倍以上あれば獲得を増やしても利益が残る」という一般的な目安。
 * 不正な minRatio（0 以下・NaN など）は 3 に戻す
 */
export function ltvSensitivity(how: HowResearch, cacValue: number | null, minRatio = 3): SensitivityRow[] {
  const min = typeof minRatio === 'number' && Number.isFinite(minRatio) && minRatio > 0 ? minRatio : 3
  const c = nonNeg(cacValue)
  const payback = paybackMonths(c, how?.monthlyPrice ?? null, how?.marginRate ?? null)
  return retentionMonths(how?.retentionScenarios).map((months) => {
    const value = ltv(how.monthlyPrice, how.marginRate, months)
    const ratio = value !== null && c !== null && c > 0 ? finite(value / c) : null
    let viable: boolean | null = null
    if (value !== null && c !== null) viable = c === 0 ? value > 0 : ratio !== null && ratio >= min
    return { months, ltv: value, ratio, paybackMonths: payback, viable }
  })
}

/**
 * 感度分析の「中央の仮定」の行（偶数個なら低い方。楽観に寄せない）。行が無ければ null。
 * principles.ts の how.viableMiddle と where.lowCostAcquisition が使う
 */
export function middleRow(rows: readonly SensitivityRow[]): SensitivityRow | null {
  if (rows.length === 0) return null
  return rows[Math.floor((rows.length - 1) / 2)]
}

/**
 * 実験の実測 CAC。running・done の実験のうち、費用（spend）と契約数（contracts）の両方が測れているものだけを合計する
 * （片方だけの実験を混ぜると費用だけ・顧客だけが膨らむため）。測れた実験が無ければ spend・customers も null
 */
export function experimentCac(experiments: readonly ResearchExperiment[]): { spend: number | null; customers: number | null; cac: number | null } {
  let spend: number | null = null
  let customers: number | null = null
  for (const x of arr(experiments)) {
    if (!x || (x.status !== 'running' && x.status !== 'done')) continue
    const s = nonNeg(x.metrics?.spend)
    const c = nonNeg(x.metrics?.contracts)
    if (s === null || c === null) continue
    spend = (spend ?? 0) + s
    customers = (customers ?? 0) + c
  }
  return { spend, customers, cac: cac(spend, customers) }
}

/** 使う CAC: 実験の実測（measured）を優先し、無ければ How の見積り（estimated）、どちらも無ければ none */
export function effectiveCac(how: HowResearch, experiments: readonly ResearchExperiment[]): { value: number | null; source: 'measured' | 'estimated' | 'none' } {
  const measured = experimentCac(experiments).cac
  if (measured !== null) return { value: measured, source: 'measured' }
  const estimated = nonNeg(how?.estimatedCac)
  if (estimated !== null) return { value: estimated, source: 'estimated' }
  return { value: null, source: 'none' }
}

/**
 * 課題の定量化（月・円）。ナレッジの例: 月40時間 × 4,000円 = 月16万円、80%削減なら理論上12.8万円。
 * - monthlyTimeCost: 時間 × 単価（時間の金銭換算）
 * - theoreticalSaving: monthlyTimeCost × 削減率（理論上の削減額。現金支出が減るとは限らない）
 * - cashSpend: いま実際に払っている現金（外注・既存サービス）
 * - opportunity: 売上機会の損失（推計）
 * 時間の換算と現金支出は足さない（別々に返す）
 */
export function quantify(q: Quantification): { monthlyTimeCost: number | null; theoreticalSaving: number | null; cashSpend: number | null; opportunity: number | null } {
  const hours = nonNeg(q?.hoursPerMonth)
  const rate = nonNeg(q?.hourlyCost)
  const reduction = unitRate(q?.reductionRate)
  const monthlyTimeCost = hours !== null && rate !== null ? finite(hours * rate) : null
  const theoreticalSaving = monthlyTimeCost !== null && reduction !== null ? finite(monthlyTimeCost * reduction) : null
  return {
    monthlyTimeCost,
    theoreticalSaving,
    cashSpend: nonNeg(q?.cashSpendMonthly),
    opportunity: nonNeg(q?.opportunityMonthly)
  }
}

/**
 * 乗り換えの概念式（年額の円）: 期待価値 − 導入負担 − 乗り換えリスク − 現状維持の価値。
 * margin > 0 なら乗り換える（switches = true）。どれかが未確認・負・NaN なら null。
 * 併用（coexists）はここでは見ない（principles.ts の why.switchingPositive が別に扱う）
 */
export function switchingMargin(s: SwitchingCase): { margin: number | null; switches: boolean | null } {
  const ev = nonNeg(s?.expectedValue)
  const ac = nonNeg(s?.adoptionCost)
  const sr = nonNeg(s?.switchingRisk)
  const sq = nonNeg(s?.statusQuoValue)
  if (ev === null || ac === null || sr === null || sq === null) return { margin: null, switches: null }
  const margin = finite(ev - ac - sr - sq)
  return { margin, switches: margin === null ? null : margin > 0 }
}
