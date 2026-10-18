/**
 * 実験のファネル・ボトルネック・経路ごとの学び・改善の効果の判定（knowledge.md 第1・5原則）
 */
import { describe, expect, it } from 'vitest'
import { B2B_FUNNEL, METRIC_KEYS, WHO_FUNNEL, type MetricKey, type ResearchExperiment } from '@shared/research/model'
import {
  bottleneckHint,
  channelLearning,
  DEFAULT_BENCHMARKS,
  findBottleneck,
  funnelSteps,
  improvementVerdict,
  mergeMetrics,
  overallRate,
  stepRate
} from '@shared/research/funnel'
import { fullExperiment, metrics } from './research-fixtures'

describe('stepRate', () => {
  it('後 ÷ 前', () => {
    expect(stepRate(1000, 50)).toBe(0.05)
    expect(stepRate(5, 5)).toBe(1)
    expect(stepRate(5, 0)).toBe(0)
  })

  it('前が 0・数の逆転・未計測・不正は null', () => {
    expect(stepRate(0, 0)).toBeNull()
    expect(stepRate(10, 11)).toBeNull()
    expect(stepRate(null, 1)).toBeNull()
    expect(stepRate(10, null)).toBeNull()
    for (const bad of [NaN, Infinity, -1]) {
      expect(stepRate(bad, 1)).toBeNull()
      expect(stepRate(10, bad)).toBeNull()
    }
  })
})

describe('funnelSteps・overallRate', () => {
  const m = metrics({ targets: 1000, contacted: 600, responded: 50, meetings: 20, proposals: 10, contracts: 5, retained: 4, expanded: 1 })

  it('B2B 直接営業の8段階は7つの段差', () => {
    const steps = funnelSteps(m, B2B_FUNNEL)
    expect(steps).toHaveLength(7)
    expect(steps[0]).toEqual({ from: 'targets', to: 'contacted', fromCount: 1000, toCount: 600, rate: 0.6 })
    expect(steps[2].rate).toBe(0.4)
  })

  it('ナレッジの例: 1,000社 → 契約5 で 0.5%', () => {
    expect(overallRate(m, ['targets', 'contracts'])).toBe(0.005)
  })

  it('数の逆転・負は率 null', () => {
    const steps = funnelSteps(metrics({ targets: 10, contacted: 20, responded: -1 }), ['targets', 'contacted', 'responded'])
    expect(steps.map((s) => s.rate)).toEqual([null, null])
    expect(steps[1].toCount).toBeNull()
  })

  it('未計測の段階を挟むと前後の率は null', () => {
    expect(funnelSteps(metrics({ targets: 100, meetings: 5 }), WHO_FUNNEL).every((s) => s.rate === null)).toBe(true)
  })

  it('キーの重複・知らないキーは除く', () => {
    const steps = funnelSteps(m, ['targets', 'targets', 'bogus' as MetricKey, 'contacted'])
    expect(steps).toHaveLength(1)
    expect(steps[0].rate).toBe(0.6)
  })

  it('段階が2つ未満なら空・null', () => {
    expect(funnelSteps(m, [])).toEqual([])
    expect(funnelSteps(m, ['targets'])).toEqual([])
    expect(overallRate(m, ['targets'])).toBeNull()
    expect(overallRate(m, [])).toBeNull()
  })

  it('壊れた入力でも落ちない', () => {
    expect(funnelSteps(null as never, B2B_FUNNEL).every((s) => s.rate === null)).toBe(true)
    expect(funnelSteps(m, null as never)).toEqual([])
  })
})

describe('DEFAULT_BENCHMARKS', () => {
  it('B2B と Who の隣り合う段階をすべて持ち、0〜1 の率', () => {
    for (const funnel of [B2B_FUNNEL, WHO_FUNNEL]) {
      for (let i = 1; i < funnel.length; i++) {
        const v = DEFAULT_BENCHMARKS[`${funnel[i - 1]}>${funnel[i]}`]
        expect(v).toBeGreaterThan(0)
        expect(v).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('bottleneckHint', () => {
  it.each([
    ['targets', 'contacted', 'reach'],
    ['targets', 'reachedBuyer', 'reach'],
    ['contacted', 'responded', 'message'],
    ['reachedBuyer', 'meetings', 'message'],
    ['responded', 'meetings', 'targeting'],
    ['meetings', 'problemMatch', 'targeting'],
    ['meetings', 'proposals', 'targeting'],
    ['problemMatch', 'purchaseIntent', 'offer'],
    ['proposals', 'contracts', 'offer'],
    ['contracts', 'retained', 'retention'],
    ['retained', 'expanded', 'expansion'],
    ['spend', 'revenue', 'message']
  ] as const)('%s → %s は %s', (from, to, hint) => {
    expect(bottleneckHint(from, to)).toBe(hint)
  })
})

describe('findBottleneck', () => {
  it('ナレッジの例: 商談は多いのに成約が低い → offer', () => {
    const m = metrics({ targets: 1000, contacted: 600, responded: 60, meetings: 30, proposals: 20, contracts: 1, retained: 1, expanded: 0 })
    const b = findBottleneck(m, B2B_FUNNEL)
    expect(b?.step.from).toBe('retained')
    // 拡大 0 が一番低い。拡大を除けば成約
    const b2 = findBottleneck(m, B2B_FUNNEL.slice(0, 6))
    expect(b2?.step.to).toBe('contracts')
    expect(b2?.hint).toBe('offer')
    expect(b2?.ratio).toBeCloseTo(0.05 / 0.25)
  })

  it('反応率が低い → message', () => {
    const m = metrics({ targets: 1000, contacted: 600, responded: 3, meetings: 2 })
    const b = findBottleneck(m, B2B_FUNNEL)
    expect(b?.step.to).toBe('responded')
    expect(b?.hint).toBe('message')
  })

  it('Who の100社実験: 担当者に届かない → reach', () => {
    const b = findBottleneck(metrics({ targets: 100, reachedBuyer: 5, meetings: 2, problemMatch: 1, purchaseIntent: 1 }), WHO_FUNNEL)
    expect(b?.hint).toBe('reach')
  })

  it('すべて目安以上でも最も余裕の少ない段階を返す（ratio ≥ 1）', () => {
    const b = findBottleneck(metrics({ targets: 100, contacted: 100, responded: 100 }), ['targets', 'contacted', 'responded'])
    expect(b?.step.to).toBe('contacted')
    expect(b?.ratio).toBeGreaterThanOrEqual(1)
  })

  it('同じ比なら前の段階', () => {
    const b = findBottleneck(metrics({ targets: 10, contacted: 5, responded: 5 }), ['targets', 'contacted', 'responded'], { 'targets>contacted': 1, 'contacted>responded': 2 })
    expect(b?.step.to).toBe('contacted')
  })

  it('目安が無い・不正な段階は比べない。比べられなければ null', () => {
    const m = metrics({ targets: 100, contacted: 10 })
    expect(findBottleneck(m, ['targets', 'contacted'], {})).toBeNull()
    expect(findBottleneck(m, ['targets', 'contacted'], { 'targets>contacted': 0 })).toBeNull()
    expect(findBottleneck(m, ['targets', 'contacted'], { 'targets>contacted': NaN })).toBeNull()
    expect(findBottleneck(metrics(), B2B_FUNNEL)).toBeNull()
  })
})

describe('mergeMetrics', () => {
  it('測れた数だけを足し、全部未計測なら null のまま', () => {
    const m = mergeMetrics([
      fullExperiment('X001', { metrics: metrics({ targets: 100, contracts: 1 }) }),
      fullExperiment('X002', { metrics: metrics({ targets: 50, contracts: null }) })
    ])
    expect(m.targets).toBe(150)
    expect(m.contracts).toBe(1)
    expect(m.meetings).toBeNull()
    expect(Object.keys(m)).toEqual([...METRIC_KEYS])
  })

  it('0 は 0 として残す', () => {
    expect(mergeMetrics([fullExperiment('X001', { metrics: metrics({ contracts: 0 }) })]).contracts).toBe(0)
  })

  it('負・NaN・Infinity・型違いは足さない', () => {
    const m = mergeMetrics([fullExperiment('X001', { metrics: metrics({ targets: -5, contacted: NaN, responded: Infinity, meetings: '3' as never }) })])
    expect([m.targets, m.contacted, m.responded, m.meetings]).toEqual([null, null, null, null])
  })

  it('空・壊れた入力', () => {
    expect(Object.values(mergeMetrics([])).every((v) => v === null)).toBe(true)
    expect(Object.values(mergeMetrics(null as never)).every((v) => v === null)).toBe(true)
    expect(Object.values(mergeMetrics([null, { metrics: null }] as never)).every((v) => v === null)).toBe(true)
  })
})

describe('channelLearning', () => {
  it('経路ごとに率と CAC を出す（CHANNELS の順）', () => {
    const rows = channelLearning([
      fullExperiment('X001', { channel: 'seo', metrics: metrics({ contacted: 200, responded: 20, meetings: 10, contracts: 2, spend: 100000 }) }),
      fullExperiment('X002', { channel: 'outreach' }),
      fullExperiment('X003', { channel: 'seo', metrics: metrics({ contacted: 100, responded: 10, meetings: 5, contracts: 1, spend: 50000 }) })
    ])
    expect(rows.map((r) => r.channel)).toEqual(['seo', 'outreach'])
    expect(rows[0]).toEqual({ channel: 'seo', experiments: 2, responseRate: 0.1, meetingRate: 0.5, closeRate: 0.2, cac: 50000 })
    expect(rows[1].experiments).toBe(1)
  })

  it('planned と経路の無い実験・知らない経路は除く', () => {
    const rows = channelLearning([
      fullExperiment('X001', { status: 'planned' }),
      fullExperiment('X002', { channel: null }),
      fullExperiment('X003', { channel: 'tv' as never })
    ])
    expect(rows).toEqual([])
  })

  it('中止した実験も学びとして数える（CAC は running・done だけ）', () => {
    const [row] = channelLearning([fullExperiment('X001', { status: 'stopped' })])
    expect(row.closeRate).toBe(0.25)
    expect(row.cac).toBeNull()
  })

  it('空', () => {
    expect(channelLearning([])).toEqual([])
  })
})

describe('improvementVerdict', () => {
  const x = (patch: Partial<ResearchExperiment>) => fullExperiment('X001', patch)

  it('比較が無ければ needsComparison（ほかが良くても）', () => {
    expect(improvementVerdict(x({ comparison: 'none' }))).toBe('needsComparison')
    expect(improvementVerdict(x({ comparison: undefined as never }))).toBe('needsComparison')
  })

  it('比較があり、試行数が十分で購入意思か契約があれば proven', () => {
    expect(improvementVerdict(x({}))).toBe('proven')
    expect(improvementVerdict(x({ comparison: 'staged', metrics: metrics({ contacted: 30, contracts: 1 }) }))).toBe('proven')
  })

  it('少数で聞き取りが無ければ needsInterviews、聞き取りがあれば判定する', () => {
    const m = metrics({ contacted: 29, purchaseIntent: 1 })
    expect(improvementVerdict(x({ metrics: m, interviews: null }))).toBe('needsInterviews')
    expect(improvementVerdict(x({ metrics: m, interviews: 0 }))).toBe('needsInterviews')
    expect(improvementVerdict(x({ metrics: m, interviews: 3 }))).toBe('proven')
  })

  it('接触数が無ければ対象数を試行数に使う', () => {
    expect(improvementVerdict(x({ metrics: metrics({ targets: 50, contracts: 1 }), interviews: null }))).toBe('proven')
    expect(improvementVerdict(x({ metrics: metrics({ targets: 5, contracts: 1 }), interviews: null }))).toBe('needsInterviews')
  })

  it('成果が無い・試行数が未計測・未実施は inconclusive', () => {
    expect(improvementVerdict(x({ metrics: metrics({ contacted: 100, purchaseIntent: 0, contracts: 0 }) }))).toBe('inconclusive')
    expect(improvementVerdict(x({ metrics: metrics({ contracts: 3 }) }))).toBe('inconclusive')
    expect(improvementVerdict(x({ status: 'planned' }))).toBe('inconclusive')
  })

  it('minSample を変えられる。不正なら 30', () => {
    const e = x({ metrics: metrics({ contacted: 10, contracts: 1 }), interviews: null })
    expect(improvementVerdict(e, 10)).toBe('proven')
    expect(improvementVerdict(e, 11)).toBe('needsInterviews')
    for (const bad of [0, -1, NaN, Infinity]) expect(improvementVerdict(e, bad)).toBe('needsInterviews')
  })

  it('壊れた入力', () => {
    expect(improvementVerdict(null as never)).toBe('inconclusive')
    expect(improvementVerdict(x({ metrics: null as never }))).toBe('inconclusive')
  })
})
