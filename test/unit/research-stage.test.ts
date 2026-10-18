/**
 * 事業を進める段階（需要 → 初回取引 → 再現性 → 採算 → 運営）と実行条件4点（knowledge.md 第2部 10章）
 */
import { describe, expect, it } from 'vitest'
import { BUSINESS_STAGES, type Candidate, type ResearchData } from '@shared/research/model'
import { businessStage, executionStatus } from '@shared/research/stage'
import { blankCandidate, conditions, emptyData, execution, fullCandidate, fullData, fullEvidence, fullExperiment, gates, metrics } from './research-fixtures'

const full = fullCandidate('C001')
const st = (c: Candidate, d: ResearchData) => businessStage(c, { ...d, candidates: [c] })
const ok = (c: Candidate, d: ResearchData) => Object.fromEntries(BUSINESS_STAGES.map((s) => [s, st(c, d).checks[s].ok]))

describe('businessStage', () => {
  it('何も無ければどの段階にも届かない', () => {
    const r = st(blankCandidate('C001'), emptyData())
    expect(r.reached).toBeNull()
    expect(Object.values(r.checks).every((c) => c.ok === null)).toBe(true)
  })

  it('Check の id と原則（i18n キー research.check.<principle>.<id>）', () => {
    const r = st(full, fullData())
    expect(BUSINESS_STAGES.map((s) => `${r.checks[s].principle}.${r.checks[s].id}`)).toEqual([
      'what.stageDemand',
      'how.stageFirstDeal',
      'how.stageRepeatability',
      'how.stageUnitEconomics',
      'how.stageOperations'
    ])
  })

  it('需要: 利用・契約・支払いの行動の証拠があれば届く（実験の前でも）', () => {
    const r = st(full, fullData())
    expect(r.checks.demand).toMatchObject({ ok: true, params: { behaviors: 1 } })
    expect(r.reached).toBe('demand')
  })

  it('需要: 感想・募集だけでは届かない。課題の条件を人が supported にすれば届く、refuted なら false', () => {
    const d = fullData({ evidence: [fullEvidence('E001', { behaviorLevel: 'opinion' }), fullEvidence('E002', { behaviorLevel: 'recruiting' })] })
    const unverified = fullCandidate('C001', { conditions: conditions() })
    expect(st(unverified, d).checks.demand.ok).toBeNull()
    expect(st(fullCandidate('C001', { conditions: conditions({}, { problemStrong: { status: 'supported' } }) }), d).checks.demand.ok).toBe(true)
    expect(st(fullCandidate('C001', { conditions: conditions({}, { problemStrong: { status: 'refuted' } }) }), d).checks.demand.ok).toBe(false)
  })

  it('需要: ほかの候補・裏付けに使えない行動の証拠は数えない', () => {
    const unverified = fullCandidate('C001', { conditions: conditions() })
    expect(st(unverified, fullData({ evidence: [fullEvidence('E001', { candidate: 'C002' })] })).checks.demand.ok).toBeNull()
    expect(st(unverified, fullData({ evidence: [fullEvidence('E001', { url: '' })] })).checks.demand.ok).toBeNull()
    expect(st(unverified, fullData({ evidence: [fullEvidence('E001', { behaviorLevel: 'weird' as never })] })).checks.demand.ok).toBeNull()
  })

  it('初回取引: 契約1件以上かつ売上 > 0', () => {
    const run = (m: Parameters<typeof metrics>[0], status: 'done' | 'running' | 'planned' | 'stopped' = 'done') =>
      st(full, fullData({ experiments: [fullExperiment('X001', { status, metrics: metrics(m) })] })).checks.firstDeal.ok
    expect(run({ contracts: 1, revenue: 30000 })).toBe(true)
    expect(run({ contracts: 1, revenue: 30000 }, 'running')).toBe(true)
    expect(run({ contracts: 1, revenue: 0 })).toBeNull()
    expect(run({ contracts: 0, revenue: 0 })).toBe(false)
    expect(run({ contracts: 0 }, 'running')).toBeNull()
    expect(run({ contracts: 1, revenue: 30000 }, 'planned')).toBeNull()
    expect(run({ contracts: NaN, revenue: 30000 })).toBeNull()
  })

  it('再現性: 契約の出た実験が2件以上', () => {
    expect(st(full, fullData({ experiments: [fullExperiment('X001')] })).checks.repeatability).toMatchObject({ ok: null, params: { experiments: 1, min: 2 } })
    expect(st(full, fullData({ experiments: [fullExperiment('X001'), fullExperiment('X002')] })).checks.repeatability.ok).toBe(true)
    expect(st(full, fullData({ experiments: [fullExperiment('X001'), fullExperiment('X001')] })).checks.repeatability.ok).toBeNull()
    expect(st(full, fullData({ experiments: [fullExperiment('X001'), fullExperiment('X002', { candidate: 'C002' })] })).checks.repeatability.ok).toBeNull()
  })

  it('採算: Σ売上 × 限界利益率 − Σ費用（成約しなかった実験の費用も入れる）', () => {
    // 60,000 × 0.8 − 40,000 = 8,000
    expect(st(full, fullData({ experiments: [fullExperiment('X001')] })).checks.unitEconomics).toMatchObject({ ok: true, params: { profit: 8000, spend: 40000, revenue: 60000 } })
    // 契約の出なかった実験の費用 10,000 を足すと 48,000 − 50,000 = −2,000
    const lost = fullExperiment('X002', { metrics: metrics({ contracts: 0, spend: 10000, revenue: 0 }) })
    expect(st(full, fullData({ experiments: [fullExperiment('X001'), lost] })).checks.unitEconomics).toMatchObject({ ok: false, params: { profit: -2000 } })
  })

  it('採算: ちょうど 0 は届かない', () => {
    const x = fullExperiment('X001', { metrics: metrics({ contracts: 1, spend: 48000, revenue: 60000 }) })
    expect(st(full, fullData({ experiments: [x] })).checks.unitEconomics.ok).toBe(false)
  })

  it('採算: 費用の抜けた実験・売上が全部未計測・利益率が未確認なら null', () => {
    const noSpend = fullExperiment('X002', { metrics: metrics({ contracts: 0 }) })
    expect(st(full, fullData({ experiments: [fullExperiment('X001'), noSpend] })).checks.unitEconomics.ok).toBeNull()
    const noRevenue = fullExperiment('X001', { metrics: metrics({ spend: 1000, contracts: 1 }) })
    expect(st(full, fullData({ experiments: [noRevenue] })).checks.unitEconomics.ok).toBeNull()
    for (const marginRate of [null, -0.1, 1.5, NaN]) {
      expect(st(fullCandidate('C001', { how: { ...full.how, marginRate } }), fullData({ experiments: [fullExperiment('X001')] })).checks.unitEconomics.ok).toBeNull()
    }
    expect(st(full, fullData()).checks.unitEconomics.ok).toBeNull()
  })

  it('採算: planned の実験は費用にも数えない', () => {
    const planned = fullExperiment('X002', { status: 'planned', metrics: metrics() })
    expect(st(full, fullData({ experiments: [fullExperiment('X001'), planned] })).checks.unitEconomics.ok).toBe(true)
  })

  it('運営: G6 を人が pass にした。fail なら false', () => {
    expect(st(fullCandidate('C001', { gates: gates({ G6: 'pass' }) }), fullData()).checks.operations.ok).toBe(true)
    expect(st(fullCandidate('C001', { gates: gates({ G6: 'fail' }) }), fullData()).checks.operations.ok).toBe(false)
    expect(st(full, fullData()).checks.operations.ok).toBeNull()
  })

  it('reached は先頭から続けて満たした所まで（後ろだけ満たしても飛ばさない）', () => {
    const two = fullData({ experiments: [fullExperiment('X001'), fullExperiment('X002')] })
    expect(st(fullCandidate('C001', { gates: gates({ G6: 'pass' }) }), two).reached).toBe('operations')
    expect(st(full, two).reached).toBe('unitEconomics')
    expect(st(full, fullData({ experiments: [fullExperiment('X001')] })).reached).toBe('firstDeal')
    // 需要が未確認なら、取引が出ていても null
    const noDemand = fullCandidate('C001', { conditions: conditions() })
    const r = st(noDemand, { ...two, evidence: [] })
    expect(ok(noDemand, { ...two, evidence: [] })).toMatchObject({ demand: null, firstDeal: true, repeatability: true })
    expect(r.reached).toBeNull()
  })

  it('壊れた候補でも落ちない', () => {
    expect(() => businessStage({ id: 'C001' } as never, emptyData())).not.toThrow()
    expect(businessStage({ id: 'C001' } as never, emptyData({ evidence: null as never, experiments: null as never })).reached).toBeNull()
  })
})

describe('executionStatus', () => {
  it('4点すべて確認できた', () => {
    expect(executionStatus(full)).toEqual({ confirmed: 4, missing: [], supplyMissing: false })
  })

  it('供給だけ抜けている', () => {
    const c = fullCandidate('C001', { execution: execution({ firstDeal: true, firstExperiment: true, profitOps: true }) })
    expect(executionStatus(c)).toEqual({ confirmed: 3, missing: ['supply'], supplyMissing: true })
  })

  it('何も確認していない（EXECUTION_KEYS の順）', () => {
    expect(executionStatus(blankCandidate('C001'))).toEqual({ confirmed: 0, missing: ['firstDeal', 'supply', 'firstExperiment', 'profitOps'], supplyMissing: true })
  })

  it('true 以外（"yes"・1）は確認とみなさない。壊れた記録でも落ちない', () => {
    const c = fullCandidate('C001', { execution: { firstDeal: { plan: '', confirmed: 'yes' }, supply: { plan: '', confirmed: 1 }, firstExperiment: null, profitOps: { plan: '', confirmed: true } } as never })
    expect(executionStatus(c)).toEqual({ confirmed: 1, missing: ['firstDeal', 'supply', 'firstExperiment'], supplyMissing: true })
    expect(executionStatus({ id: 'C001' } as never).confirmed).toBe(0)
  })
})
