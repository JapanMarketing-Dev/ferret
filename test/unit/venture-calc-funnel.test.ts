/**
 * ファネル（段階の数・率・目安・止まっている段階・代わりの数・経路別）
 */
import { describe, expect, it } from 'vitest'
import type { Channel, FunnelStep, MetricRow } from '../../src/shared/venture/model'
import { FUNNEL_DEFAULT_TARGETS, funnelBottleneck, funnelSteps, funnelTargets, ventureFunnel } from '../../src/shared/venture/funnel'

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
const OCT = { from: '2026-10-01', to: '2026-10-31' }
const byStage = (steps: FunnelStep[]): Record<string, FunnelStep> => Object.fromEntries(steps.map((s) => [s.stage, s]))

describe('目安', () => {
  it('既定の目安', () => {
    expect(FUNNEL_DEFAULT_TARGETS).toEqual({ clicks: 0.02, leads: 0.03, meetings: 0.3, contracts: 0.25, retained: 0.7, referrals: 0.1 })
  })
  it('正しい値だけ上書きする（NaN・負数・文字は既定のまま）', () => {
    const t = funnelTargets({ clicks: 0.05, leads: Number.NaN, meetings: -1, contracts: '0.5' as unknown as number, retained: 0 })
    expect(t.clicks).toBe(0.05)
    expect(t.leads).toBe(0.03)
    expect(t.meetings).toBe(0.3)
    expect(t.contracts).toBe(0.25)
    expect(t.retained).toBe(0)
  })
  it('null・未指定なら既定', () => {
    expect(funnelTargets(null)).toEqual(FUNNEL_DEFAULT_TARGETS)
    expect(funnelTargets()).toEqual(FUNNEL_DEFAULT_TARGETS)
  })
})

describe('段階', () => {
  it('データが無ければ先頭は first、ほかは noData、bottleneck なし', () => {
    const f = ventureFunnel([], OCT)
    expect(f.steps.map((s) => s.status)).toEqual(['first', 'noData', 'noData', 'noData', 'noData', 'noData', 'noData'])
    expect(f.steps.every((s) => s.count === null && s.rate === null)).toBe(true)
    expect(f.bottleneck).toBe(null)
    expect(f.byChannel).toEqual([])
  })
  it('FUNNEL_STAGES の順で、率は前の段階から', () => {
    const f = ventureFunnel([row('2026-10-01', 'x', { impressions: 1000, clicks: 50, leads: 5, meetings: 2, contracts: 1 })], OCT)
    expect(f.steps.map((s) => s.stage)).toEqual(['impressions', 'clicks', 'leads', 'meetings', 'contracts', 'retained', 'referrals'])
    const s = byStage(f.steps)
    expect(s.impressions.rate).toBe(null)
    expect(s.impressions.target).toBe(null)
    expect(s.clicks.rate).toBe(0.05)
    expect(s.leads.rate).toBe(0.1)
    expect(s.meetings.rate).toBe(0.4)
    expect(s.contracts.rate).toBe(0.5)
    expect(s.retained.status).toBe('noData')
    expect(f.bottleneck).toBe(null)
  })
  it('前に数があるのに 0 は stuck、bottleneck は最初の stuck', () => {
    const f = ventureFunnel([row('2026-10-01', 'x', { impressions: 1000, clicks: 50, leads: 0, meetings: 0 })], OCT)
    const s = byStage(f.steps)
    expect(s.leads.status).toBe('stuck')
    expect(s.leads.rate).toBe(0)
    expect(s.meetings.status).toBe('stuck')
    expect(s.meetings.rate).toBe(null)
    expect(f.bottleneck).toBe('leads')
  })
  it('先頭から 0 なら stuck にしない（流れが無い）', () => {
    const f = ventureFunnel([row('2026-10-01', 'x', { impressions: 0, clicks: 0 })], OCT)
    expect(byStage(f.steps).clicks.status).toBe('ok')
    expect(f.bottleneck).toBe(null)
  })
  it('間にデータなしがあっても、もっと前に数があれば stuck', () => {
    const f = ventureFunnel([row('2026-10-01', 'x', { impressions: 1000, leads: 0 })], OCT)
    const s = byStage(f.steps)
    expect(s.clicks.status).toBe('noData')
    expect(s.leads.status).toBe('stuck')
    expect(s.leads.rate).toBe(null)
  })
  it('目安未満は low、bottleneck は 率 / 目安 が一番低い low', () => {
    // clicks 0.01/0.02 = 0.5、meetings 0.1/0.3 = 0.33…
    const f = ventureFunnel([row('2026-10-01', 'x', { impressions: 10000, clicks: 100, leads: 10, meetings: 1, contracts: 1 })], OCT)
    const s = byStage(f.steps)
    expect(s.clicks.status).toBe('low')
    expect(s.meetings.status).toBe('low')
    expect(s.leads.status).toBe('ok')
    expect(f.bottleneck).toBe('meetings')
  })
  it('目安ちょうどは ok', () => {
    const f = ventureFunnel([row('2026-10-01', 'x', { impressions: 100, clicks: 2 })], OCT)
    expect(byStage(f.steps).clicks.status).toBe('ok')
  })
  it('stuck があれば low より優先', () => {
    const f = ventureFunnel([row('2026-10-01', 'x', { impressions: 10000, clicks: 1, leads: 1, meetings: 0 })], OCT)
    expect(byStage(f.steps).clicks.status).toBe('low')
    expect(f.bottleneck).toBe('meetings')
  })
  it('比が同じ low なら前の段階', () => {
    const steps = funnelSteps({ impressions: 1000, clicks: 10, leads: 0.15 }, { clicks: 0.02, leads: 0.03 })
    expect(funnelBottleneck(steps)).toBe('clicks')
  })
  it('目安 0 の段階は low にならない', () => {
    const f = ventureFunnel([row('2026-10-01', 'x', { impressions: 100, clicks: 1 })], OCT, { clicks: 0 })
    expect(byStage(f.steps).clicks.status).toBe('ok')
  })
  it('前の段階が 0 なら率は null（0 で割らない）', () => {
    const steps = funnelSteps({ impressions: 0, clicks: 5 }, {})
    expect(steps[1].rate).toBe(null)
    expect(steps[1].status).toBe('ok')
  })
  it('前より多い数は率が 1 を超えてよい', () => {
    const steps = funnelSteps({ impressions: 10, clicks: 20 }, FUNNEL_DEFAULT_TARGETS)
    expect(steps[1].rate).toBe(2)
  })
  it('先頭がデータなしでも status は first', () => {
    const f = ventureFunnel([row('2026-10-01', 'x', { clicks: 10, leads: 0 })], OCT)
    expect(f.steps[0].status).toBe('first')
    expect(f.steps[0].count).toBe(null)
    expect(byStage(f.steps).leads.status).toBe('stuck')
  })
  it('期間の外の行は入れない', () => {
    const f = ventureFunnel([row('2026-09-30', 'x', { impressions: 10 })], OCT)
    expect(f.steps[0].count).toBe(null)
  })
  it('NaN・負数の数はデータなし', () => {
    const f = ventureFunnel([row('2026-10-01', 'x', { impressions: Number.NaN, clicks: -3 })], OCT)
    expect(f.steps[0].count).toBe(null)
    expect(f.steps[1].status).toBe('noData')
  })
})

describe('代わりの数', () => {
  it('clicks が無く sessions があれば sessions を使い、substitute に出す', () => {
    const f = ventureFunnel([row('2026-10-01', 'organic-search', { impressions: 1000, sessions: 40 })], OCT)
    const s = byStage(f.steps)
    expect(s.clicks.count).toBe(40)
    expect(s.clicks.substitute).toBe('sessions')
    expect(s.clicks.rate).toBe(0.04)
  })
  it('clicks があれば sessions は使わない（substitute なし）', () => {
    const f = ventureFunnel([row('2026-10-01', 'x', { impressions: 1000, clicks: 30, sessions: 40 })], OCT)
    const s = byStage(f.steps)
    expect(s.clicks.count).toBe(30)
    expect(s.clicks.substitute).toBeUndefined()
    expect('substitute' in s.clicks).toBe(false)
  })
  it('clicks 0 もデータなので sessions を使わない', () => {
    const f = ventureFunnel([row('2026-10-01', 'x', { impressions: 1000, clicks: 0, sessions: 40 })], OCT)
    expect(byStage(f.steps).clicks.count).toBe(0)
  })
  it('leads が無く conversions があれば conversions を使う', () => {
    const f = ventureFunnel([row('2026-10-01', 'google-ads', { impressions: 1000, clicks: 50, conversions: 3 })], OCT)
    const s = byStage(f.steps)
    expect(s.leads.count).toBe(3)
    expect(s.leads.substitute).toBe('conversions')
  })
  it('別の経路の leads があれば、全体では conversions を使わない', () => {
    const f = ventureFunnel([row('2026-10-01', 'google-ads', { conversions: 3 }), row('2026-10-01', 'x', { leads: 1 })], OCT)
    expect(byStage(f.steps).leads.count).toBe(1)
    const ads = f.byChannel.find((c) => c.channel === 'google-ads')
    expect(ads && byStage(ads.steps).leads.substitute).toBe('conversions')
  })
})

describe('経路別', () => {
  it('表示の多い順。ファネルの数が無い経路（費用だけ）は出さない', () => {
    const rows = [
      row('2026-10-01', 'x', { impressions: 100 }),
      row('2026-10-01', 'google-ads', { impressions: 500, clicks: 5 }),
      row('2026-10-01', 'meta-ads', { spend: 1000 }),
      row('2026-10-02', 'blog', { sessions: 10 })
    ]
    const f = ventureFunnel(rows, OCT)
    expect(f.byChannel.map((c) => c.channel)).toEqual(['google-ads', 'x', 'blog'])
    expect(f.byChannel[0].steps[1].count).toBe(5)
  })
  it('表示が同じなら契約の多い順、同じなら CHANNELS の順', () => {
    const rows = [row('2026-10-01', 'x', { leads: 1 }), row('2026-10-01', 'blog', { contracts: 1 }), row('2026-10-01', 'email', { leads: 2 })]
    expect(ventureFunnel(rows, OCT).byChannel.map((c) => c.channel)).toEqual(['blog', 'x', 'email'])
  })
})
