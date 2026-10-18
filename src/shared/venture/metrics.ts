/**
 * 取り込んだ行の集計（docs/venture.md 4章）。純粋な処理で、renderer からも使える。
 *
 * 数の扱い:
 * - 有限で 0 以上の数だけ数える（NaN・Infinity・負数・数でない値は「その行にその数は無い」とみなす）。
 * - 金額（spend・revenue）は、通貨がビジネスの通貨か未指定の行だけ（大文字・小文字は問わない）。
 * - 1行も無い数は undefined のまま（0 と分ける）。
 *
 * 契約（contracts）と継続（retained）:
 * - 支払い行（customer と paymentId がある行）は、書かれた contracts・retained を使わず、支払いから出す（二重にしない）。
 *   - contracts … その顧客の全期間で一番早い支払いの行を 1、ほかの支払い行を 0 として足す（= 期間内に初めて払った顧客の数）。
 *     同じ日に複数あれば先に並んだ行を初回とする。
 *   - retained … 期間内に払った「顧客 × 月」ごとに、その顧客が前の月にも払っていれば 1、いなければ 0（月ごとの合計を足した数）。
 *     支払いのデータが始まった最初の月は前の月が分からないので数えない（データなしのまま）。
 * - 支払い行でない行（canonical など）に書かれた contracts・retained は、そのまま足す。
 */
import { CHANNELS, METRIC_KEYS, MONEY_METRICS, type Channel, type MetricKey, type MetricRow, type Period } from './model'
import { inPeriod, isIsoDate, monthKey, prevMonthKey } from './period'

/** 数の種類ごとの合計（データが1行も無い数は入れない） */
export type Totals = Partial<Record<MetricKey, number>>

/** 有限で 0 以上の数（ほかは null） */
export function cleanNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

/** 金額を数えてよい行か（通貨が未指定か、ビジネスの通貨と同じ） */
export function sameCurrency(row: Pick<MetricRow, 'currency'>, currency: string): boolean {
  const c = row.currency
  if (c === undefined || c === null || c === '') return true
  return typeof c === 'string' && typeof currency === 'string' && c.trim().toUpperCase() === currency.trim().toUpperCase()
}

/** 支払い行（customer と paymentId がある行） */
export function isPaymentRow(row: MetricRow): boolean {
  return typeof row.customer === 'string' && row.customer !== '' && typeof row.paymentId === 'string' && row.paymentId !== ''
}

/** 正しい行だけ（日付が暦にあり、values が物） */
export function validRows(rows: readonly MetricRow[]): MetricRow[] {
  if (!Array.isArray(rows)) return []
  return rows.filter((r) => r !== null && typeof r === 'object' && isIsoDate(r.date) && r.values !== null && typeof r.values === 'object')
}

/** 行の1つの数（数えない値・通貨違いの金額・支払い行の contracts / retained は null） */
export function rowValue(row: MetricRow, key: MetricKey, currency: string): number | null {
  if (isPaymentRow(row) && (key === 'contracts' || key === 'retained')) return null
  if (MONEY_METRICS.has(key) && !sameCurrency(row, currency)) return null
  return cleanNumber(row.values[key])
}

/** 経路（CHANNELS に無い値は other） */
export function channelOf(row: MetricRow): Channel {
  return (CHANNELS as readonly string[]).includes(row.channel) ? row.channel : 'other'
}

function add(t: Totals, key: MetricKey, v: number): void {
  t[key] = (t[key] ?? 0) + v
}

interface PaymentIndex {
  /** 顧客ごとの初回の支払い行 */
  first: Map<string, MetricRow>
  /** 払った「顧客|月」 */
  paid: Set<string>
  /** 支払いのデータの最初の月 */
  firstMonth: string | null
}

function paymentIndex(rows: readonly MetricRow[]): PaymentIndex {
  const first = new Map<string, MetricRow>()
  const paid = new Set<string>()
  let firstMonth: string | null = null
  for (const r of rows) {
    if (!isPaymentRow(r)) continue
    const c = r.customer as string
    const prev = first.get(c)
    if (!prev || r.date < prev.date) first.set(c, r)
    const m = monthKey(r.date)
    paid.add(`${c}|${m}`)
    if (firstMonth === null || m < firstMonth) firstMonth = m
  }
  return { first, paid, firstMonth }
}

/**
 * 期間の行を groupOf の鍵ごとに集計する（契約・継続の出し方はファイルの先頭のとおり。初回の判定は全期間で行う）。
 * period が null なら期間で絞らない。groupOf が null を返した行は数えない
 */
export function aggregateBy(
  rows: readonly MetricRow[],
  period: Period | null,
  currency: string,
  groupOf: (row: MetricRow) => string | null
): Map<string, Totals> {
  const valid = validRows(rows)
  const idx = paymentIndex(valid)
  const out = new Map<string, Totals>()
  const seenRetained = new Set<string>()
  for (const r of valid) {
    if (!inPeriod(r.date, period)) continue
    const g = groupOf(r)
    if (g === null) continue
    let t = out.get(g)
    if (!t) {
      t = {}
      out.set(g, t)
    }
    for (const key of METRIC_KEYS) {
      const v = rowValue(r, key, currency)
      if (v !== null) add(t, key, v)
    }
    if (isPaymentRow(r)) {
      const c = r.customer as string
      add(t, 'contracts', idx.first.get(c) === r ? 1 : 0)
      const m = monthKey(r.date)
      const seen = `${g}|${c}|${m}`
      if (idx.firstMonth !== null && m > idx.firstMonth && !seenRetained.has(seen)) {
        seenRetained.add(seen)
        add(t, 'retained', idx.paid.has(`${c}|${prevMonthKey(m)}`) ? 1 : 0)
      }
    }
  }
  return out
}

/** 期間の数ごとの合計（データが1行も無い数は undefined。0 とは分ける） */
export function totals(rows: readonly MetricRow[], period: Period | null, currency: string): Totals {
  return aggregateBy(rows, period, currency, () => '*').get('*') ?? {}
}

/** 経路ごとの合計（CHANNELS の順。期間に行の無い経路は出さない） */
export function totalsByChannel(rows: readonly MetricRow[], period: Period | null, currency: string): Array<{ channel: Channel; totals: Totals }> {
  const m = aggregateBy(rows, period, currency, channelOf)
  return CHANNELS.filter((c) => m.has(c)).map((channel) => ({ channel, totals: m.get(channel) as Totals }))
}

/** 日ごとの合計（日付の順。行の無い日は出さない） */
export function totalsByDay(rows: readonly MetricRow[], period: Period | null, currency: string): Array<{ date: string; totals: Totals }> {
  const m = aggregateBy(rows, period, currency, (r) => r.date)
  return [...m.keys()].sort().map((date) => ({ date, totals: m.get(date) as Totals }))
}

/** 月ごとの合計（YYYY-MM の順。行の無い月は出さない） */
export function totalsByMonth(rows: readonly MetricRow[], period: Period | null, currency: string): Array<{ month: string; totals: Totals }> {
  const m = aggregateBy(rows, period, currency, (r) => monthKey(r.date))
  return [...m.keys()].sort().map((month) => ({ month, totals: m.get(month) as Totals }))
}

/** 期間内に初めて払った顧客（初回の判定は全期間。顧客の文字列の順） */
export function newCustomers(rows: readonly MetricRow[], period: Period | null): string[] {
  const idx = paymentIndex(validRows(rows))
  const out: string[] = []
  for (const [c, r] of idx.first) if (inPeriod(r.date, period)) out.push(c)
  return out.sort()
}

/** 期間内に1回以上払った顧客（顧客の文字列の順） */
export function payingCustomers(rows: readonly MetricRow[], period: Period | null): string[] {
  const set = new Set<string>()
  for (const r of validRows(rows)) if (isPaymentRow(r) && inPeriod(r.date, period)) set.add(r.customer as string)
  return [...set].sort()
}

/** 期間に正しい行が1行でもあるか */
export function hasRowsInPeriod(rows: readonly MetricRow[], period: Period | null): boolean {
  return validRows(rows).some((r) => inPeriod(r.date, period))
}
