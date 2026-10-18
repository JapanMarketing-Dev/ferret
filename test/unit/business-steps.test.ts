/**
 * ステップの出口条件（記録から機械的に確かめる目安）と、ステップパネルの要約
 */
import { describe, expect, it } from 'vitest'
import { emptyBusiness, emptyNumbers, emptyRecord } from '@shared/business/records'
import { STEP_IDS, type BusinessData, type Evidence, type Experiment, type Hypothesis, type StepId } from '@shared/business/model'
import { currentHypothesis, exitChecks, nextStep, summarize } from '@shared/business/steps'

const NOW = '2026-10-17T09:00:00.000Z'

function data(over: Partial<BusinessData> = {}): BusinessData {
  return { root: '/tmp/b', business: emptyBusiness('テスト', NOW), hypotheses: [], evidence: [], alternatives: [], interviews: [], experiments: [], decisions: [], approvals: [], searches: [], problems: [], ...over }
}
const hyp = (id = 'H01', over: Partial<Hypothesis> = {}): Hypothesis => ({ ...emptyRecord('hypothesis', id, NOW), ...over })
const ev = (id: string, over: Partial<Evidence> = {}): Evidence => ({
  ...emptyRecord('evidence', id, NOW), hypotheses: ['H01'], readStatus: '読了', url: `https://example.com/${id}`, dupGroup: id, sourceKind: '本人の経験', ...over
})
const exp = (over: Partial<Experiment> = {}): Experiment => ({ ...emptyRecord('experiment', 'X01', NOW), hypothesis: 'H01', ...over })
const done = (step: StepId, d: BusinessData) => exitChecks(step, d).map((c) => c.done)

describe('今の仮説', () => {
  it('currentHypothesis があればそれ', () => {
    const d = data({ hypotheses: [hyp('H01'), hyp('H02')] })
    d.business.currentHypothesis = 'H02'
    expect(currentHypothesis(d)!.id).toBe('H02')
  })
  it('無い・見つからなければ最初の仮説、仮説が無ければ null', () => {
    const d = data({ hypotheses: [hyp('H01'), hyp('H02')] })
    expect(currentHypothesis(d)!.id).toBe('H01')
    d.business.currentHypothesis = 'H09'
    expect(currentHypothesis(d)!.id).toBe('H01')
    expect(currentHypothesis(data())).toBeNull()
  })
})

describe('出口条件（空のビジネスではどれも未達）', () => {
  it.each(STEP_IDS)('%s: 空なら全部 false、ラベルがある', (step) => {
    const d = data()
    d.business.name = ''
    const checks = exitChecks(step, d)
    expect(checks.length).toBeGreaterThan(0)
    for (const c of checks) {
      expect(c.done).toBe(false)
      expect(c.label.length).toBeGreaterThan(0)
    }
  })
})

describe('出口条件（満たした状態）', () => {
  it('S1: 名前と、10 文字以上の対象の1文', () => {
    const d = data()
    d.business.name = '   '
    expect(done('S1', d)).toEqual([false, false])
    d.business.name = '経理'
    d.business.target = '123456789'
    expect(done('S1', d)).toEqual([true, false])
    d.business.target = '月末に明細を統合したい経理'
    expect(done('S1', d)).toEqual([true, true])
  })

  it('S2: URL 付きの証拠・読了の証拠・検索履歴', () => {
    expect(done('S2', data({ evidence: [ev('E01', { url: 'example.com', readStatus: '発見のみ' })] }))).toEqual([false, false, false])
    expect(done('S2', data({ evidence: [ev('E01')], searches: [{ at: '', query: 'q', medium: '', period: '', readable: true, adopted: true, note: '' }] }))).toEqual([true, true, true])
  })

  it('S3: 仮説・課題の1文・結びついた証拠・数えられる当事者', () => {
    expect(done('S3', data({ hypotheses: [hyp()] }))).toEqual([true, false, false, false])
    expect(done('S3', data({ hypotheses: [hyp('H01', { problem: '課題' })], evidence: [ev('E01', { dupGroup: 'U' })] }))).toEqual([true, true, true, false])
    expect(done('S3', data({ hypotheses: [hyp('H01', { problem: '課題' })], evidence: [ev('E01')] }))).toEqual([true, true, true, true])
  })

  it('S3: 別の仮説の証拠は今の仮説の証拠に数えない', () => {
    expect(done('S3', data({ hypotheses: [hyp('H01', { problem: '課題' })], evidence: [ev('E01', { hypotheses: ['H02'] })] }))).toEqual([true, true, false, false])
  })

  it('S4: 代替比較・最大の反証・解消できない理由（または棄却）', () => {
    const alt = { ...emptyRecord('alternative', 'ALT01', NOW), hypothesis: 'H01' }
    expect(done('S4', data({ hypotheses: [hyp()], alternatives: [{ ...alt, hypothesis: 'H02' }] }))).toEqual([false, false, false])
    expect(done('S4', data({ hypotheses: [hyp('H01', { biggestCounter: '反証', whyUnsolved: '理由' })], alternatives: [alt] }))).toEqual([true, true, true])
    expect(done('S4', data({ hypotheses: [hyp('H01', { verdict: '棄却' })] }))[2]).toBe(true)
  })

  it('S5: どれか採点した・次に確かめること・判定', () => {
    const h = hyp('H01', { next: '聞き取り', verdict: '追加調査' })
    expect(done('S5', data({ hypotheses: [h] }))).toEqual([false, true, true])
    h.provision.P4.value = 'いいえ'
    expect(done('S5', data({ hypotheses: [h] }))).toEqual([true, true, true])
  })

  it('S6: 提供の1文・価格と合格・中止条件のある実験', () => {
    const cond = { metric: 'paid' as const, op: '>=' as const, value: 1 }
    expect(done('S6', data({ hypotheses: [hyp('H01', { offer: '提供' })], experiments: [exp({ price: '1万円', pass: [cond] })] }))).toEqual([true, false])
    expect(done('S6', data({ hypotheses: [hyp('H01', { offer: '提供' })], experiments: [exp({ price: '1万円', pass: [cond], stop: [cond] })] }))).toEqual([true, true])
    expect(done('S6', data({ hypotheses: [hyp('H01', { offer: '提供' })], experiments: [exp({ hypothesis: 'H02', price: '1万円', pass: [cond], stop: [cond] })] }))).toEqual([true, false])
  })

  it('S7: 同意つきの聞き取り・聞き取りから起こした証拠', () => {
    const i = { ...emptyRecord('interview', 'I01', NOW), hypothesis: 'H01' }
    expect(done('S7', data({ hypotheses: [hyp()], interviews: [i] }))).toEqual([false, false])
    expect(done('S7', data({ hypotheses: [hyp()], interviews: [{ ...i, consent: true, evidence: ['E01'] }] }))).toEqual([true, true])
  })

  it('S8: 実施中か完了の実験・接触数の実測', () => {
    expect(done('S8', data({ hypotheses: [hyp()], experiments: [exp({ plan: { ...emptyNumbers(), contacts: 100 } })] }))).toEqual([false, false])
    expect(done('S8', data({ hypotheses: [hyp()], experiments: [exp({ status: '実施中', actual: { ...emptyNumbers(), contacts: 0 } })] }))).toEqual([true, true])
    expect(done('S8', data({ hypotheses: [hyp()], experiments: [exp({ status: '完了' })] }))).toEqual([true, false])
  })

  it('S9: 合格か中止を判定できた', () => {
    const pass = [{ metric: 'paid' as const, op: '>=' as const, value: 1 }]
    expect(done('S9', data({ hypotheses: [hyp()], experiments: [exp({ status: '完了', pass, actual: { ...emptyNumbers(), paid: 0 } })] }))).toEqual([false])
    expect(done('S9', data({ hypotheses: [hyp()], experiments: [exp({ status: '完了', pass, actual: { ...emptyNumbers(), paid: 1 } })] }))).toEqual([true])
    expect(done('S9', data({ hypotheses: [hyp()], experiments: [exp({ status: '中止', pass, stop: [{ metric: 'contacts', op: '<=', value: 0 }], actual: { ...emptyNumbers(), contacts: 0 } })] }))).toEqual([true])
  })

  it('S10: 結論と、今の周で変えるもの', () => {
    const d = data({ hypotheses: [hyp()], decisions: [{ ...emptyRecord('decision', 'C01', NOW), hypothesis: 'H01' }] })
    d.business.loop = 2
    d.business.loops = [{ loop: 1, changed: '価格', backTo: 'S6', note: '', at: '' }, { loop: 2, changed: null, backTo: null, note: '', at: '' }]
    expect(done('S10', d)).toEqual([true, false])
    d.business.loops[1]!.changed = '経路'
    expect(done('S10', d)).toEqual([true, true])
  })

  it('仮説が無いときは全仮説の証拠・実験を見る', () => {
    expect(done('S8', data({ experiments: [exp({ hypothesis: 'H05', status: '実施中' })] }))[0]).toBe(true)
  })
})

describe('次のステップ', () => {
  it('S1 → S2 … S9 → S10、S10 の次は無い（null）', () => {
    for (let i = 0; i < STEP_IDS.length - 1; i++) expect(nextStep(STEP_IDS[i]!)).toBe(STEP_IDS[i + 1])
    expect(nextStep('S10')).toBeNull()
  })
  it('知らないステップは null', () => {
    expect(nextStep('S11' as StepId)).toBeNull()
  })
})

describe('要約', () => {
  it('空のビジネス', () => {
    const s = summarize(data())
    expect(s).toMatchObject({ step: 'S1', name: '対象決め', loop: 1, hypothesis: null, demand: '—', acquisition: '—', unknowns: 0, independentParties: 0, next: '' })
    expect(s.counts).toEqual({ hypotheses: 0, evidence: 0, readEvidence: 0, alternatives: 0, interviews: 0, experiments: 0, pendingApprovals: 0 })
    expect(s.checks).toEqual(exitChecks('S1', data()))
  })

  it('記録があるビジネス', () => {
    const h = hyp('H01', { name: '月末統合', next: '  聞き取り  ' })
    h.demand.D1.score = 2
    const d = data({
      hypotheses: [h],
      evidence: [ev('E01'), ev('E02', { readStatus: '発見のみ' }), ev('E03', { dupGroup: 'E01' })],
      approvals: [{ ...emptyRecord('approval', 'R01', NOW) }, { ...emptyRecord('approval', 'R02', NOW), status: '承認' }]
    })
    d.business.step = 'S5'
    d.business.loop = 3
    const s = summarize(d)
    expect(s.step).toBe('S5')
    expect(s.name).toBe('判定')
    expect(s.loop).toBe(3)
    expect(s.hypothesis).toEqual({ id: 'H01', name: '月末統合', stage: '探索メモ' })
    expect(s.counts.evidence).toBe(3)
    expect(s.counts.readEvidence).toBe(2)
    expect(s.counts.pendingApprovals).toBe(1)
    expect(s.demand).toBe('未完了（U 残り 4）')
    expect(s.acquisition).toBe('未完了（U 残り 4）')
    expect(s.unknowns).toBe(12)
    expect(s.independentParties).toBe(1)
    expect(s.next).toBe('聞き取り')
    expect(s.checks).toHaveLength(3)
  })
})
