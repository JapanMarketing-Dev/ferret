/**
 * 主要な数（docs/venture.md 4章）。CAC・ARPA・LTV・回収期間・経路別の獲得。
 *
 * - CAC = 期間の費用の合計 / 期間の新しい顧客（契約）。成約しなかった経路の費用も入れる。費用のデータが無い・新しい顧客が 0 なら null
 * - ARPA（顧客1件あたりの月の売上）:
 *   - venture.json の economics.monthlyRevenuePerCustomer があればそれ（arpaSource 'override'）
 *   - 無ければデータから（'data'）: 期間の売上 / 期間の月数 / 期間に払った顧客の数。
 *     払った顧客が分からなければ（支払い行が無い）期間の売上 / 期間の月数 / 期間の契約。どちらも無ければ null。
 *     期間の月数 = 期間の日数 / 30.4375（1年の平均の月の日数）。period が null ならデータの最小〜最大日で数える
 * - LTV = ARPA × 限界利益率 × 継続月数（ltvMonths ごと）。どちらかが null なら null。ltvToCac = LTV / CAC
 * - 回収期間（月）= CAC / (ARPA × 限界利益率)。分母が 0 か null なら null
 */
import type { ChannelAcquisition, Kpis, MetricRow, Period, VentureConfig } from './model'
import { cleanNumber, payingCustomers, totals, totalsByChannel, type Totals } from './metrics'
import { marginRateOf } from './phase'
import { dataRange, periodDays } from './period'

/** 1か月の平均の日数 */
export const DAYS_PER_MONTH = 365.25 / 12

/** 期間の月数（日数 / 30.4375）。期間が無ければ null */
export function periodMonths(period: Period | null): number | null {
  if (!period) return null
  const days = periodDays(period)
  return days > 0 ? days / DAYS_PER_MONTH : null
}

/** リードの数（leads が無ければ conversions を代わりに使う。ファネルと同じ） */
function leadsOf(t: Totals): number {
  return t.leads ?? t.conversions ?? 0
}

/** 経路ごとの獲得（費用の多い順、同じなら契約の多い順、それも同じなら CHANNELS の順） */
export function channelAcquisition(rows: readonly MetricRow[], period: Period | null, currency: string): ChannelAcquisition[] {
  return totalsByChannel(rows, period, currency)
    .map((c, order) => {
      const spend = c.totals.spend ?? 0
      const contracts = c.totals.contracts ?? 0
      const acq: ChannelAcquisition = {
        channel: c.channel,
        spend,
        leads: leadsOf(c.totals),
        contracts,
        revenue: c.totals.revenue ?? 0,
        cac: contracts > 0 ? spend / contracts : null
      }
      return { acq, order }
    })
    .sort((a, b) => b.acq.spend - a.acq.spend || b.acq.contracts - a.acq.contracts || a.order - b.order)
    .map((x) => x.acq)
}

/** 期間の主要な数 */
export function ventureKpis(rows: readonly MetricRow[], period: Period | null, config: VentureConfig): Kpis {
  const currency = typeof config?.currency === 'string' && config.currency !== '' ? config.currency : 'JPY'
  const t = totals(rows, period, currency)
  const spend = t.spend ?? null
  const revenue = t.revenue ?? null
  const newCustomers = t.contracts ?? null
  const cac = spend !== null && newCustomers !== null && newCustomers > 0 ? spend / newCustomers : null

  let arpa: number | null = null
  let arpaSource: Kpis['arpaSource'] = null
  const override = cleanNumber(config?.economics?.monthlyRevenuePerCustomer)
  if (override !== null) {
    arpa = override
    arpaSource = 'override'
  } else {
    const months = periodMonths(period ?? dataRange(rows))
    const payers = payingCustomers(rows, period).length
    const customers = payers > 0 ? payers : (newCustomers ?? 0)
    if (revenue !== null && months !== null && customers > 0) {
      arpa = revenue / months / customers
      arpaSource = 'data'
    }
  }

  const marginRate = marginRateOf(config)
  const monthlyMargin = arpa !== null && marginRate !== null ? arpa * marginRate : null
  const ltvMonths = Array.isArray(config?.economics?.ltvMonths) ? config.economics.ltvMonths : []
  const ltv = ltvMonths
    .filter((m) => typeof m === 'number' && Number.isFinite(m) && m > 0)
    .map((months) => {
      const value = monthlyMargin !== null ? monthlyMargin * months : null
      return { months, value, ltvToCac: value !== null && cac !== null && cac > 0 ? value / cac : null }
    })
  const paybackMonths = cac !== null && monthlyMargin !== null && monthlyMargin > 0 ? cac / monthlyMargin : null

  return {
    currency,
    spend,
    revenue,
    newCustomers,
    cac,
    arpa,
    arpaSource,
    marginRate,
    ltv,
    paybackMonths,
    channels: channelAcquisition(rows, period, currency)
  }
}
