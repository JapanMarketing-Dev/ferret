/**
 * 主要な数（CAC・ARPA・LTV・回収期間・経路別の獲得）
 */
import { describe, expect, it } from 'vitest'
import type { Channel, MetricRow, VentureConfig } from '../../src/shared/venture/model'
import { defaultVentureConfig } from '../../src/shared/venture/defaults'
import { DAYS_PER_MONTH, channelAcquisition, periodMonths, ventureKpis } from '../../src/shared/venture/economics'

let line = 0
const row = (date: string, channel: Channel, values: MetricRow['values'], extra: Partial<MetricRow> = {}): MetricRow => ({
  date,
  source: 'canonical',
  channel,
  values,
  file: 'agent/a.json',
  line: ++line,
  ...extra
})
const pay = (date: string, customer: string, revenue: number, channel: Channel = 'stripe'): MetricRow =>
  row(date, channel, { revenue }, { source: 'stripe', customer, paymentId: `ch_${++line}` })
const cfg = (patch: Partial<VentureConfig['economics']> = {}): VentureConfig => {
  const c = defaultVentureConfig('テスト', '2026-10-01T00:00:00Z')
  c.economics = { ...c.economics, marginRate: 0.5, ...patch }
  return c
}
/** 30.4375 日（ちょうど1か月）にする期間は無いので、月数で割り戻して確かめる */
const P30 = { from: '2026-10-01', to: '2026-10-30' }
const M30 = 30 / DAYS_PER_MONTH

describe('期間の月数', () => {
  it('日数 / 30.4375', () => {
    expect(periodMonths(P30)).toBeCloseTo(M30, 10)
    expect(periodMonths({ from: '2026-01-01', to: '2026-12-31' })).toBeCloseTo(365 / DAYS_PER_MONTH, 10)
  })
  it('期間が無い・逆なら null', () => {
    expect(periodMonths(null)).toBe(null)
    expect(periodMonths({ from: '2026-10-31', to: '2026-10-01' })).toBe(null)
  })
})

describe('CAC', () => {
  it('費用の合計 / 新しい顧客（成約しなかった経路の費用も入れる）', () => {
    const rows = [row('2026-10-01', 'google-ads', { spend: 30000, contracts: 2 }), row('2026-10-02', 'meta-ads', { spend: 10000 })]
    const k = ventureKpis(rows, P30, cfg())
    expect(k.spend).toBe(40000)
    expect(k.newCustomers).toBe(2)
    expect(k.cac).toBe(20000)
  })
  it('新しい顧客が 0 なら null', () => {
    const k = ventureKpis([row('2026-10-01', 'x', { spend: 100, contracts: 0 })], P30, cfg())
    expect(k.newCustomers).toBe(0)
    expect(k.cac).toBe(null)
  })
  it('費用のデータが無ければ null（spend も null）', () => {
    const k = ventureKpis([row('2026-10-01', 'x', { contracts: 3 })], P30, cfg())
    expect(k.spend).toBe(null)
    expect(k.cac).toBe(null)
  })
  it('費用 0 なら CAC 0', () => {
    expect(ventureKpis([row('2026-10-01', 'x', { contracts: 1, spend: 0 })], P30, cfg()).cac).toBe(0)
  })
  it('データが無ければ全部 null・空', () => {
    const k = ventureKpis([], P30, cfg())
    expect(k).toMatchObject({ currency: 'JPY', spend: null, revenue: null, newCustomers: null, cac: null, arpa: null, arpaSource: null, paybackMonths: null, channels: [] })
    expect(k.ltv.every((l) => l.value === null && l.ltvToCac === null)).toBe(true)
  })
  it('通貨違いの費用は入れない', () => {
    const rows = [row('2026-10-01', 'x', { spend: 100, contracts: 1 }), row('2026-10-01', 'x', { spend: 999 }, { currency: 'USD' })]
    expect(ventureKpis(rows, P30, cfg()).cac).toBe(100)
  })
})

describe('ARPA', () => {
  it('上書きがあればそれ（override）', () => {
    const k = ventureKpis([pay('2026-10-01', 'a', 5000)], P30, cfg({ monthlyRevenuePerCustomer: 3000 }))
    expect(k.arpa).toBe(3000)
    expect(k.arpaSource).toBe('override')
  })
  it('上書き 0 も上書き。NaN・負数は無視してデータから', () => {
    expect(ventureKpis([], P30, cfg({ monthlyRevenuePerCustomer: 0 })).arpa).toBe(0)
    expect(ventureKpis([pay('2026-10-01', 'a', 5000)], P30, cfg({ monthlyRevenuePerCustomer: Number.NaN })).arpaSource).toBe('data')
    expect(ventureKpis([pay('2026-10-01', 'a', 5000)], P30, cfg({ monthlyRevenuePerCustomer: -1 })).arpaSource).toBe('data')
  })
  it('データから: 売上 / 月数 / 払った顧客の数', () => {
    const rows = [pay('2026-10-01', 'a', 6000), pay('2026-10-05', 'b', 3000), pay('2026-10-20', 'a', 3000)]
    const k = ventureKpis(rows, P30, cfg())
    expect(k.arpaSource).toBe('data')
    expect(k.arpa).toBeCloseTo(12000 / M30 / 2, 6)
  })
  it('顧客が分からなければ 売上 / 月数 / 契約', () => {
    const k = ventureKpis([row('2026-10-01', 'x', { revenue: 9000, contracts: 3 })], P30, cfg())
    expect(k.arpa).toBeCloseTo(9000 / M30 / 3, 6)
  })
  it('顧客も契約も無ければ null', () => {
    const k = ventureKpis([row('2026-10-01', 'x', { revenue: 9000 })], P30, cfg())
    expect(k.arpa).toBe(null)
    expect(k.arpaSource).toBe(null)
  })
  it('売上のデータが無ければ null', () => {
    expect(ventureKpis([row('2026-10-01', 'x', { contracts: 3 })], P30, cfg()).arpa).toBe(null)
  })
  it('period が null ならデータの最小〜最大日で月数を数える', () => {
    const rows = [pay('2026-10-01', 'a', 1000), pay('2026-10-30', 'a', 1000)]
    expect(ventureKpis(rows, null, cfg()).arpa).toBeCloseTo(2000 / M30, 6)
  })
})

describe('LTV と回収期間', () => {
  it('LTV = ARPA × 率 × 月数（ltvMonths ごと）、LTV / CAC', () => {
    const rows = [row('2026-10-01', 'x', { spend: 10000, contracts: 2 })]
    const k = ventureKpis(rows, P30, cfg({ monthlyRevenuePerCustomer: 4000, ltvMonths: [6, 12] }))
    expect(k.cac).toBe(5000)
    expect(k.ltv).toEqual([
      { months: 6, value: 12000, ltvToCac: 2.4 },
      { months: 12, value: 24000, ltvToCac: 4.8 }
    ])
    expect(k.paybackMonths).toBe(2.5)
  })
  it('既定の継続月数は 6・12・24・36', () => {
    expect(ventureKpis([], P30, cfg()).ltv.map((l) => l.months)).toEqual([6, 12, 24, 36])
  })
  it('率が null なら LTV・回収期間は null', () => {
    const rows = [row('2026-10-01', 'x', { spend: 100, contracts: 1 })]
    const k = ventureKpis(rows, P30, cfg({ marginRate: null, monthlyRevenuePerCustomer: 1000 }))
    expect(k.marginRate).toBe(null)
    expect(k.ltv.every((l) => l.value === null)).toBe(true)
    expect(k.paybackMonths).toBe(null)
  })
  it('率 0 なら LTV 0、回収期間は null（0 で割らない）', () => {
    const rows = [row('2026-10-01', 'x', { spend: 100, contracts: 1 })]
    const k = ventureKpis(rows, P30, cfg({ marginRate: 0, monthlyRevenuePerCustomer: 1000 }))
    expect(k.ltv[0].value).toBe(0)
    expect(k.paybackMonths).toBe(null)
  })
  it('CAC が null・0 なら ltvToCac は null', () => {
    const k = ventureKpis([row('2026-10-01', 'x', { spend: 0, contracts: 1 })], P30, cfg({ monthlyRevenuePerCustomer: 1000 }))
    expect(k.cac).toBe(0)
    expect(k.ltv[0].ltvToCac).toBe(null)
    expect(k.paybackMonths).toBe(0)
  })
  it('壊れた継続月数（0・負数・NaN・文字）は除く', () => {
    const k = ventureKpis([], P30, cfg({ ltvMonths: [0, -6, Number.NaN, '12' as unknown as number, 24] }))
    expect(k.ltv.map((l) => l.months)).toEqual([24])
  })
  it('ltvMonths が無ければ空', () => {
    const c = cfg()
    ;(c.economics as { ltvMonths: unknown }).ltvMonths = undefined
    expect(ventureKpis([], P30, c).ltv).toEqual([])
  })
})

describe('経路別の獲得', () => {
  it('費用の多い順、契約 0 の経路の CAC は null', () => {
    const rows = [
      row('2026-10-01', 'x', { spend: 1000, leads: 3, contracts: 1, revenue: 5000 }),
      row('2026-10-01', 'google-ads', { spend: 9000, leads: 10, contracts: 3 }),
      row('2026-10-01', 'meta-ads', { spend: 4000, leads: 2 })
    ]
    const ch = ventureKpis(rows, P30, cfg()).channels
    expect(ch.map((c) => c.channel)).toEqual(['google-ads', 'meta-ads', 'x'])
    expect(ch[0]).toEqual({ channel: 'google-ads', spend: 9000, leads: 10, contracts: 3, revenue: 0, cac: 3000 })
    expect(ch[1].cac).toBe(null)
    expect(ch[2].revenue).toBe(5000)
  })
  it('leads が無ければ conversions を使う', () => {
    const ch = channelAcquisition([row('2026-10-01', 'google-ads', { spend: 10, conversions: 4 })], P30, 'JPY')
    expect(ch[0].leads).toBe(4)
  })
  it('費用が同じなら契約の多い順', () => {
    const rows = [row('2026-10-01', 'x', { spend: 0, contracts: 1 }), row('2026-10-01', 'blog', { contracts: 2 })]
    expect(channelAcquisition(rows, P30, 'JPY').map((c) => c.channel)).toEqual(['blog', 'x'])
  })
  it('config の通貨を使う（USD のビジネスなら USD の行だけ）', () => {
    const c = cfg()
    c.currency = 'USD'
    const rows = [row('2026-10-01', 'x', { spend: 10, contracts: 1 }, { currency: 'USD' }), row('2026-10-01', 'x', { spend: 1000 }, { currency: 'JPY' })]
    const k = ventureKpis(rows, P30, c)
    expect(k.currency).toBe('USD')
    expect(k.spend).toBe(10)
  })
})
