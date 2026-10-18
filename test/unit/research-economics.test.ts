/**
 * CAC・LTV・回収期間・感度分析・課題の定量化・乗り換えの式（knowledge.md 第2・4・5原則）
 */
import { describe, expect, it } from 'vitest'
import type { HowResearch, ResearchExperiment } from '@shared/research/model'
import {
  cac,
  effectiveCac,
  experimentCac,
  ltv,
  ltvSensitivity,
  middleRow,
  paybackMonths,
  quantify,
  retentionMonths,
  switchingMargin
} from '@shared/research/economics'
import { fullCandidate, fullExperiment, metrics } from './research-fixtures'

const BAD = [NaN, Infinity, -Infinity, -1, null] as const
const how = (patch: Partial<HowResearch> = {}): HowResearch => ({ ...fullCandidate('C001').how, ...patch })

describe('cac', () => {
  it('ナレッジの例: 広告20万＋営業10万で10社 → 3万円', () => {
    expect(cac(300000, 10)).toBe(30000)
  })

  it('費用 0 なら 0', () => {
    expect(cac(0, 5)).toBe(0)
  })

  it('0社は null（無限大を数にしない）', () => {
    expect(cac(100000, 0)).toBeNull()
    expect(cac(0, 0)).toBeNull()
  })

  it.each(BAD)('費用が %s なら null', (v) => {
    expect(cac(v as number, 10)).toBeNull()
  })

  it.each(BAD)('顧客数が %s なら null', (v) => {
    expect(cac(1000, v as number)).toBeNull()
  })

  it('型違いは null', () => {
    expect(cac('1000' as unknown as number, 1)).toBeNull()
  })

  it('巨大値でも有限なら計算し、あふれれば null', () => {
    expect(cac(Number.MAX_VALUE, 1)).toBe(Number.MAX_VALUE)
    expect(cac(Number.MAX_VALUE, Number.MIN_VALUE)).toBeNull()
  })
})

describe('ltv', () => {
  it('ナレッジの例: 月3万 × 80% × 24か月 = 57.6万円', () => {
    expect(ltv(30000, 0.8, 24)).toBeCloseTo(576000)
  })

  it('月額 0・利益率 0 は 0', () => {
    expect(ltv(0, 0.8, 12)).toBe(0)
    expect(ltv(30000, 0, 12)).toBe(0)
  })

  it('利益率 1 は可、1 を超えると null', () => {
    expect(ltv(1000, 1, 2)).toBe(2000)
    expect(ltv(1000, 1.01, 2)).toBeNull()
  })

  it('継続月数 0 は null', () => {
    expect(ltv(1000, 0.5, 0)).toBeNull()
  })

  it.each(BAD)('どれかが %s なら null', (v) => {
    expect(ltv(v as number, 0.8, 12)).toBeNull()
    expect(ltv(30000, v as number, 12)).toBeNull()
    expect(ltv(30000, 0.8, v as number)).toBeNull()
  })

  it('掛け算があふれれば null', () => {
    expect(ltv(Number.MAX_VALUE, 1, 2)).toBeNull()
  })
})

describe('paybackMonths', () => {
  it('CAC 3万円 ÷（3万 × 0.8）= 1.25か月', () => {
    expect(paybackMonths(30000, 30000, 0.8)).toBeCloseTo(1.25)
  })

  it('CAC 0 は 0 か月', () => {
    expect(paybackMonths(0, 30000, 0.8)).toBe(0)
  })

  it('1か月の利益が 0 なら回収できない（null）', () => {
    expect(paybackMonths(30000, 0, 0.8)).toBeNull()
    expect(paybackMonths(30000, 30000, 0)).toBeNull()
  })

  it.each(BAD)('どれかが %s なら null', (v) => {
    expect(paybackMonths(v as number, 30000, 0.8)).toBeNull()
    expect(paybackMonths(30000, v as number, 0.8)).toBeNull()
    expect(paybackMonths(30000, 30000, v as number)).toBeNull()
  })
})

describe('retentionMonths', () => {
  it('不正値・重複を除いて昇順', () => {
    expect(retentionMonths([24, 6, 12, 6, 0, -3, NaN, Infinity, '12', null, 36, 24])).toEqual([6, 12, 24, 36])
  })

  it('配列でなければ空', () => {
    expect(retentionMonths(undefined)).toEqual([])
    expect(retentionMonths('6,12')).toEqual([])
  })

  it('小数の月も扱う', () => {
    expect(retentionMonths([1.5, 0.5])).toEqual([0.5, 1.5])
  })
})

describe('ltvSensitivity', () => {
  it('継続月数ごとの LTV・倍率・回収期間（既定の目安 3 倍）', () => {
    const rows = ltvSensitivity(how({ retentionScenarios: [36, 6, 12, 24, 12] }), 60000)
    expect(rows.map((r) => r.months)).toEqual([6, 12, 24, 36])
    expect(rows.map((r) => r.ltv)).toEqual([144000, 288000, 576000, 864000])
    expect(rows.map((r) => r.ratio)).toEqual([2.4, 4.8, 9.6, 14.4])
    expect(rows.map((r) => r.viable)).toEqual([false, true, true, true])
    expect(rows.every((r) => r.paybackMonths === 2.5)).toBe(true)
  })

  it('ちょうど 3 倍は成立', () => {
    expect(ltvSensitivity(how({ retentionScenarios: [12] }), 96000)[0].viable).toBe(true)
  })

  it('目安を変えられる。不正な目安は 3 に戻す', () => {
    expect(ltvSensitivity(how({ retentionScenarios: [12] }), 96000, 5)[0].viable).toBe(false)
    for (const bad of [0, -1, NaN, Infinity]) expect(ltvSensitivity(how({ retentionScenarios: [12] }), 96000, bad)[0].viable).toBe(true)
  })

  it('CAC 未確認なら倍率・成立は null（LTV は出す）', () => {
    const [row] = ltvSensitivity(how({ retentionScenarios: [12] }), null)
    expect(row).toEqual({ months: 12, ltv: 288000, ratio: null, paybackMonths: null, viable: null })
  })

  it('CAC 0 は LTV > 0 なら成立（倍率は出さない）', () => {
    const [row] = ltvSensitivity(how({ retentionScenarios: [12] }), 0)
    expect(row.ratio).toBeNull()
    expect(row.viable).toBe(true)
    expect(ltvSensitivity(how({ retentionScenarios: [12], monthlyPrice: 0 }), 0)[0].viable).toBe(false)
  })

  it('負・NaN の CAC は未確認と同じ', () => {
    expect(ltvSensitivity(how({ retentionScenarios: [12] }), -1)[0].viable).toBeNull()
    expect(ltvSensitivity(how({ retentionScenarios: [12] }), NaN)[0].viable).toBeNull()
  })

  it('価格が未確認なら LTV も null', () => {
    const [row] = ltvSensitivity(how({ retentionScenarios: [12], monthlyPrice: null }), 1000)
    expect(row.ltv).toBeNull()
    expect(row.viable).toBeNull()
  })

  it('仮定が無ければ空。壊れた How でも落ちない', () => {
    expect(ltvSensitivity(how({ retentionScenarios: [] }), 1000)).toEqual([])
    expect(ltvSensitivity(null as unknown as HowResearch, 1000)).toEqual([])
    expect(ltvSensitivity(how({ retentionScenarios: null as unknown as number[] }), 1000)).toEqual([])
  })
})

describe('middleRow', () => {
  const rows = (n: number) => ltvSensitivity(how({ retentionScenarios: Array.from({ length: n }, (_, i) => (i + 1) * 6) }), 1000)
  it('奇数個は真ん中、偶数個は低い方', () => {
    expect(middleRow(rows(3))?.months).toBe(12)
    expect(middleRow(rows(4))?.months).toBe(12)
    expect(middleRow(rows(1))?.months).toBe(6)
    expect(middleRow(rows(2))?.months).toBe(6)
  })
  it('空なら null', () => {
    expect(middleRow([])).toBeNull()
  })
})

describe('experimentCac', () => {
  const x = (id: string, patch: Partial<ResearchExperiment>) => fullExperiment(id, patch)

  it('running と done の費用と契約を合計する', () => {
    const r = experimentCac([
      x('X001', { status: 'done', metrics: metrics({ spend: 100000, contracts: 2 }) }),
      x('X002', { status: 'running', metrics: metrics({ spend: 50000, contracts: 1 }) })
    ])
    expect(r).toEqual({ spend: 150000, customers: 3, cac: 50000 })
  })

  it('planned・stopped は数えない', () => {
    const r = experimentCac([
      x('X001', { status: 'planned', metrics: metrics({ spend: 100000, contracts: 2 }) }),
      x('X002', { status: 'stopped', metrics: metrics({ spend: 50000, contracts: 1 }) })
    ])
    expect(r).toEqual({ spend: null, customers: null, cac: null })
  })

  it('片方だけ測れた実験は混ぜない', () => {
    const r = experimentCac([
      x('X001', { metrics: metrics({ spend: 100000, contracts: null }) }),
      x('X002', { metrics: metrics({ spend: null, contracts: 5 }) }),
      x('X003', { metrics: metrics({ spend: 30000, contracts: 1 }) })
    ])
    expect(r).toEqual({ spend: 30000, customers: 1, cac: 30000 })
  })

  it('契約 0 なら CAC は null（費用・顧客数は返す）', () => {
    expect(experimentCac([x('X001', { metrics: metrics({ spend: 30000, contracts: 0 }) })])).toEqual({ spend: 30000, customers: 0, cac: null })
  })

  it('負・NaN の数は測れていないものとして扱う', () => {
    expect(experimentCac([x('X001', { metrics: metrics({ spend: -1, contracts: 1 }) }), x('X002', { metrics: metrics({ spend: 10, contracts: NaN }) })]).cac).toBeNull()
  })

  it('空・壊れた入力', () => {
    expect(experimentCac([]).cac).toBeNull()
    expect(experimentCac(null as unknown as ResearchExperiment[]).cac).toBeNull()
    expect(experimentCac([null, { status: 'done' }] as unknown as ResearchExperiment[]).cac).toBeNull()
  })
})

describe('effectiveCac', () => {
  it('実測を優先する', () => {
    expect(effectiveCac(how({ estimatedCac: 99999 }), [fullExperiment('X001')])).toEqual({ value: 20000, source: 'measured' })
  })

  it('実測が無ければ見積り', () => {
    expect(effectiveCac(how({ estimatedCac: 30000 }), [])).toEqual({ value: 30000, source: 'estimated' })
    expect(effectiveCac(how({ estimatedCac: 0 }), [])).toEqual({ value: 0, source: 'estimated' })
  })

  it('どちらも無ければ none', () => {
    expect(effectiveCac(how({ estimatedCac: null }), [])).toEqual({ value: null, source: 'none' })
    expect(effectiveCac(how({ estimatedCac: -5 }), [])).toEqual({ value: null, source: 'none' })
    expect(effectiveCac(null as unknown as HowResearch, [])).toEqual({ value: null, source: 'none' })
  })
})

describe('quantify', () => {
  const q = { hoursPerMonth: 40, hourlyCost: 4000, reductionRate: 0.8, cashSpendMonthly: 30000, opportunityMonthly: 100000 }

  it('ナレッジの例: 月40時間 × 4,000円 = 16万円、80%削減で12.8万円', () => {
    expect(quantify(q)).toEqual({ monthlyTimeCost: 160000, theoreticalSaving: 128000, cashSpend: 30000, opportunity: 100000 })
  })

  it('時間の換算と現金支出を混ぜない', () => {
    const r = quantify({ ...q, hoursPerMonth: null })
    expect(r.monthlyTimeCost).toBeNull()
    expect(r.theoreticalSaving).toBeNull()
    expect(r.cashSpend).toBe(30000)
  })

  it('削減率が範囲外・未確認なら削減額だけ null', () => {
    expect(quantify({ ...q, reductionRate: 1.2 }).theoreticalSaving).toBeNull()
    expect(quantify({ ...q, reductionRate: null }).theoreticalSaving).toBeNull()
    expect(quantify({ ...q, reductionRate: 0 }).theoreticalSaving).toBe(0)
    expect(quantify({ ...q, reductionRate: 1.2 }).monthlyTimeCost).toBe(160000)
  })

  it.each(BAD)('%s は null', (v) => {
    const r = quantify({ hoursPerMonth: v, hourlyCost: 4000, reductionRate: 0.5, cashSpendMonthly: v, opportunityMonthly: v } as never)
    expect(r).toEqual({ monthlyTimeCost: null, theoreticalSaving: null, cashSpend: null, opportunity: null })
  })

  it('壊れた入力でも落ちない', () => {
    expect(quantify(null as never)).toEqual({ monthlyTimeCost: null, theoreticalSaving: null, cashSpend: null, opportunity: null })
  })
})

describe('switchingMargin', () => {
  const base = { expectedValue: 840000, adoptionCost: 1000000, switchingRisk: 0, statusQuoValue: 0, coexists: false }

  it('ナレッジの例: 年84万円安くなっても移行に100万円なら乗り換えない', () => {
    expect(switchingMargin(base)).toEqual({ margin: -160000, switches: false })
  })

  it('期待価値が上回れば乗り換える', () => {
    expect(switchingMargin({ ...base, adoptionCost: 100000 })).toEqual({ margin: 740000, switches: true })
  })

  it('ちょうど 0 は乗り換えない（> 0 で true）', () => {
    expect(switchingMargin({ ...base, adoptionCost: 840000 })).toEqual({ margin: 0, switches: false })
  })

  it.each(BAD)('どれかが %s なら null', (v) => {
    for (const k of ['expectedValue', 'adoptionCost', 'switchingRisk', 'statusQuoValue'] as const) {
      expect(switchingMargin({ ...base, [k]: v })).toEqual({ margin: null, switches: null })
    }
  })

  it('併用できてもここでは式だけを見る', () => {
    expect(switchingMargin({ ...base, coexists: true }).switches).toBe(false)
  })

  it('壊れた入力', () => {
    expect(switchingMargin(null as never)).toEqual({ margin: null, switches: null })
  })
})
