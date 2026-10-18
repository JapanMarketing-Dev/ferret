/**
 * ビジネスの段階（需要 → 初回取引 → 再現性 → 採算 → 運営。前を満たした所まで reached）
 */
import { describe, expect, it } from 'vitest'
import type { Channel, MetricRow, VentureConfig } from '../../src/shared/venture/model'
import { defaultVentureConfig } from '../../src/shared/venture/defaults'
import { marginRateOf, venturePhase } from '../../src/shared/venture/phase'

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
const cfg = (marginRate: number | null = 0.6): VentureConfig => {
  const c = defaultVentureConfig('テスト', '2026-10-01T00:00:00Z')
  c.economics.marginRate = marginRate
  return c
}
const OCT = { from: '2026-10-01', to: '2026-10-31' }

/** 需要・初回取引・再現性・採算を満たす行 */
const full = (): MetricRow[] => [
  row('2026-09-10', 'google-ads', { leads: 5, contracts: 1, revenue: 50000, spend: 10000 }),
  row('2026-10-10', 'google-ads', { leads: 8, contracts: 2, revenue: 100000, spend: 20000 })
]

describe('段階の進み方', () => {
  it('データが無ければ reached null、current は需要', () => {
    const p = venturePhase([], OCT, cfg(), null)
    expect(p.reached).toBe(null)
    expect(p.current).toBe('demand')
    expect(p.checks.demand.ok).toBe(null)
    expect(p.checks.demand.reason).toBe('noData')
  })
  it('リードが 0 の行しか無ければ証拠なし（false にはしない）', () => {
    const p = venturePhase([row('2026-10-01', 'x', { leads: 0, impressions: 100 })], OCT, cfg(), null)
    expect(p.checks.demand.ok).toBe(null)
    expect(p.checks.demand.reason).toBe('noEvidence')
  })
  it('リードが1件で需要を満たし、current は初回取引', () => {
    const p = venturePhase([row('2026-10-01', 'x', { leads: 1 })], OCT, cfg(), null)
    expect(p.reached).toBe('demand')
    expect(p.current).toBe('firstDeal')
    expect(p.checks.demand.params).toEqual({ leads: 1, contracts: 0 })
    expect(p.checks.firstDeal.reason).toBe('noDeal')
  })
  it('契約だけでも需要を満たす', () => {
    const p = venturePhase([row('2026-10-01', 'x', { contracts: 1 })], OCT, cfg(), null)
    expect(p.checks.demand.ok).toBe(true)
  })
  it('契約があっても売上が 0 なら初回取引は未確認', () => {
    const p = venturePhase([row('2026-10-01', 'x', { contracts: 1, revenue: 0 })], OCT, cfg(), null)
    expect(p.reached).toBe('demand')
    expect(p.checks.firstDeal.ok).toBe(null)
  })
  it('契約1件と売上で初回取引。経路 × 月が1つなら再現性は oneSlot で止まる', () => {
    const p = venturePhase([row('2026-10-01', 'x', { contracts: 1, revenue: 1000 })], OCT, cfg(), null)
    expect(p.reached).toBe('firstDeal')
    expect(p.current).toBe('repeatability')
    expect(p.checks.repeatability.reason).toBe('oneSlot')
    expect(p.checks.repeatability.params).toEqual({ slots: 1, min: 2 })
  })
  it('同じ経路の同じ月に契約が2件でも再現性は満たさない', () => {
    const rows = [row('2026-10-01', 'x', { contracts: 1, revenue: 1000 }), row('2026-10-20', 'x', { contracts: 1, revenue: 1000 })]
    expect(venturePhase(rows, OCT, cfg(), null).checks.repeatability.ok).toBe(null)
  })
  it('別の経路・同じ月なら再現性を満たす', () => {
    const rows = [row('2026-10-01', 'x', { contracts: 1, revenue: 1000 }), row('2026-10-20', 'blog', { contracts: 1 })]
    expect(venturePhase(rows, OCT, cfg(), null).checks.repeatability.ok).toBe(true)
  })
  it('同じ経路・別の月なら再現性を満たす（月をまたぐ。期間の外の月も数える）', () => {
    const rows = [row('2026-09-30', 'x', { contracts: 1, revenue: 1000 }), row('2026-10-01', 'x', { contracts: 1 })]
    expect(venturePhase(rows, OCT, cfg(), null).checks.repeatability.ok).toBe(true)
  })
  it('支払い行の初回からも契約を数える', () => {
    const rows = [
      row('2026-09-03', 'stripe', { revenue: 3000 }, { customer: 'a', paymentId: 'p1' }),
      row('2026-10-03', 'stripe', { revenue: 3000 }, { customer: 'b', paymentId: 'p2' })
    ]
    const p = venturePhase(rows, OCT, cfg(), null)
    expect(p.checks.firstDeal.params).toEqual({ contracts: 2, revenue: 6000 })
    expect(p.checks.repeatability.ok).toBe(true)
  })
  it('全部満たし運営も pass なら reached・current とも operations', () => {
    const p = venturePhase(full(), OCT, cfg(), 'pass')
    expect(p.reached).toBe('operations')
    expect(p.current).toBe('operations')
  })
  it('採算まで満たし運営がまだなら current は運営（reason human）', () => {
    const p = venturePhase(full(), OCT, cfg(), null)
    expect(p.reached).toBe('unitEconomics')
    expect(p.current).toBe('operations')
    expect(p.checks.operations.reason).toBe('human')
  })
  it('運営が fail なら false', () => {
    expect(venturePhase(full(), OCT, cfg(), 'fail').checks.operations.ok).toBe(false)
  })
  it('前の段階で止まれば、後ろが true でも reached はそこまで', () => {
    const rows = [row('2026-10-01', 'x', { leads: 1, revenue: 100000, spend: 1 })]
    const p = venturePhase(rows, OCT, cfg(), 'pass')
    expect(p.checks.unitEconomics.ok).toBe(true)
    expect(p.checks.operations.ok).toBe(true)
    expect(p.reached).toBe('demand')
    expect(p.current).toBe('firstDeal')
  })
})

describe('採算', () => {
  it('利益 = 売上 × 率 − 費用 > 0 で true、params に金額', () => {
    const c = venturePhase(full(), OCT, cfg(0.6), null).checks.unitEconomics
    expect(c.ok).toBe(true)
    expect(c.params).toEqual({ profit: 40000, revenue: 100000, spend: 20000, marginRate: 0.6 })
  })
  it('利益がちょうど 0 なら false', () => {
    const rows = [row('2026-10-01', 'x', { revenue: 1000, spend: 500 })]
    const c = venturePhase(rows, OCT, cfg(0.5), null).checks.unitEconomics
    expect(c.ok).toBe(false)
    expect(c.params?.profit).toBe(0)
  })
  it('利益が負なら false', () => {
    const rows = [row('2026-10-01', 'x', { revenue: 1000, spend: 900 })]
    expect(venturePhase(rows, OCT, cfg(0.5), null).checks.unitEconomics.ok).toBe(false)
  })
  it('成約しなかった経路の費用も入れる', () => {
    const rows = [row('2026-10-01', 'x', { revenue: 1000, spend: 100 }), row('2026-10-01', 'meta-ads', { spend: 450 })]
    expect(venturePhase(rows, OCT, cfg(0.5), null).checks.unitEconomics.ok).toBe(false)
  })
  it('率が null なら noMargin', () => {
    expect(venturePhase(full(), OCT, cfg(null), null).checks.unitEconomics).toEqual({ stage: 'unitEconomics', ok: null, reason: 'noMargin' })
  })
  it('率が範囲外・NaN なら noMargin', () => {
    expect(venturePhase(full(), OCT, cfg(1.5), null).checks.unitEconomics.reason).toBe('noMargin')
    expect(venturePhase(full(), OCT, cfg(-0.1), null).checks.unitEconomics.reason).toBe('noMargin')
    expect(venturePhase(full(), OCT, cfg(Number.NaN), null).checks.unitEconomics.reason).toBe('noMargin')
  })
  it('率 0 と 1 は使える', () => {
    expect(marginRateOf(cfg(0))).toBe(0)
    expect(marginRateOf(cfg(1))).toBe(1)
    expect(venturePhase(full(), OCT, cfg(0), null).checks.unitEconomics.ok).toBe(false)
  })
  it('期間に行が無ければ noData', () => {
    expect(venturePhase(full(), { from: '2027-01-01', to: '2027-01-31' }, cfg(), null).checks.unitEconomics.reason).toBe('noData')
  })
  it('期間の売上のデータが無ければ noRevenue（黙って 0 にしない）', () => {
    const rows = [row('2026-10-01', 'x', { spend: 100 })]
    expect(venturePhase(rows, OCT, cfg(), null).checks.unitEconomics.reason).toBe('noRevenue')
  })
  it('費用のデータが1行も無ければ noSpend', () => {
    const rows = [row('2026-10-01', 'x', { revenue: 100 })]
    expect(venturePhase(rows, OCT, cfg(), null).checks.unitEconomics.reason).toBe('noSpend')
  })
  it('費用 0 と書いてあれば計算する', () => {
    const rows = [row('2026-10-01', 'x', { revenue: 100, spend: 0 })]
    expect(venturePhase(rows, OCT, cfg(), null).checks.unitEconomics.ok).toBe(true)
  })
  it('通貨違いの売上は入れない（全部違えば noRevenue）', () => {
    const rows = [row('2026-10-01', 'x', { revenue: 100, spend: 10 }, { currency: 'USD' })]
    expect(venturePhase(rows, OCT, cfg(), null).checks.unitEconomics.reason).toBe('noRevenue')
  })
  it('採算は期間で見る（期間の外の売上は入れない）', () => {
    const rows = [row('2026-09-01', 'x', { revenue: 100000 }), row('2026-10-01', 'x', { revenue: 100, spend: 1000 })]
    expect(venturePhase(rows, OCT, cfg(), null).checks.unitEconomics.ok).toBe(false)
  })
  it('config が壊れていても落ちない', () => {
    const p = venturePhase(full(), OCT, {} as VentureConfig, null)
    expect(p.checks.unitEconomics.reason).toBe('noMargin')
    expect(p.reached).toBe('repeatability')
  })
})
