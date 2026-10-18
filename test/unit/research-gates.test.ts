/**
 * ゲート G1〜G7 の機械の目安・人が確定するときの順番・「プロジェクトにする」の条件・ファンネルの数
 */
import { describe, expect, it } from 'vitest'
import { CANDIDATE_STAGES, GATE_IDS, type Candidate, type GateId, type GateStatus } from '@shared/research/model'
import { autoGates, canDecideGate, canPromote, funnelCounts, funnelReached, nextGate, repeatedAcquisition } from '@shared/research/gates'
import { blankCandidate, emptyData, fullCandidate, fullData, fullEvidence, fullExperiment, gates, metrics, scene } from './research-fixtures'

const full = fullCandidate('C001')
const passed = (n: number): Partial<Record<GateId, GateStatus>> => Object.fromEntries(GATE_IDS.slice(0, n).map((g) => [g, 'pass']))

describe('autoGates', () => {
  it('全欄を埋めた候補（実験なし）: G1〜G3 は pass、G4・G5・G7 は unknown、G6 は常に unknown', () => {
    const g = autoGates(full, fullData())
    expect(Object.fromEntries(GATE_IDS.map((id) => [id, g[id].suggestion]))).toEqual({
      G1: 'pass',
      G2: 'pass',
      G3: 'pass',
      G4: 'unknown',
      G5: 'unknown',
      G6: 'unknown',
      G7: 'unknown'
    })
  })

  it('理由は PRINCIPLE_GATES に沿って集まる', () => {
    const g = autoGates(full, fullData())
    const ids = (id: GateId) => g[id].reasons.map((c) => `${c.principle}.${c.id}`)
    expect(ids('G1')).toEqual(['who.segmentDefined', 'who.listBuilt', 'who.factsSeparated', 'who.buyerKnown', 'who.repeatableContact', 'who.conditions'])
    expect(ids('G2')).toEqual(['what.jtbd', 'what.factors', 'what.problemType', 'what.quantified', 'what.spendAndComplaint', 'what.improvement'])
    expect(ids('G3')).toEqual(['where.channelEvaluated', 'where.triggerOrIntentKeyword', 'where.summary', 'who.contactable'])
    expect(ids('G4')).toEqual(['what.problemConfirmed', 'why.chosen'])
    expect(ids('G5')).toEqual(['where.lowCostAcquisition', 'how.pricing', 'how.scenarios', 'how.cacBasis', 'how.viableMiddle', 'how.measuredAndProven'])
    expect(ids('G6')).toEqual(['how.automationNoted'])
    expect(ids('G7')).toEqual(['how.measuredAndProven', 'how.repeatable'])
  })

  it('Why のリサーチはゲートでなく「プロジェクトにする」の条件（どのゲートの理由にも出ない）', () => {
    const g = autoGates(full, fullData())
    for (const id of GATE_IDS) expect(g[id].reasons.some((c) => c.principle === 'why' && c.id === 'reasonBacked')).toBe(false)
  })

  it('何も調べていない候補はすべて unknown（fail にしない）', () => {
    const g = autoGates(blankCandidate('C001'), emptyData())
    for (const id of GATE_IDS) expect(g[id].suggestion).toBe('unknown')
  })

  it('人が「いいえ」とした条件があれば G1 は fail', () => {
    const c = fullCandidate('C001', { who: { ...full.who, conditions: { ...full.who.conditions, canPay: false } } })
    expect(autoGates(c, fullData()).G1.suggestion).toBe('fail')
  })

  it('G3: 実験の確認は補助。終わった実験で接触できなければ fail', () => {
    const d = fullData({ experiments: [fullExperiment('X001', { metrics: metrics({ reachedBuyer: 0, meetings: 0 }) })] })
    expect(autoGates(full, d).G3.suggestion).toBe('fail')
  })

  it('G4: 実験で課題一致と購入意思が確認できれば pass、0 なら fail', () => {
    expect(autoGates(full, fullData({ experiments: [fullExperiment('X001')] })).G4.suggestion).toBe('pass')
    const zero = fullData({ experiments: [fullExperiment('X001', { metrics: metrics({ problemMatch: 0, purchaseIntent: 0, contracts: 0 }) })] })
    expect(autoGates(full, zero).G4.suggestion).toBe('fail')
  })

  it('G4: 高得点でもリサーチだけでは pass にならない', () => {
    const c = fullCandidate('C001', { scores: fullCandidate('C001').scores })
    expect(autoGates(c, fullData()).G4.suggestion).toBe('unknown')
  })

  it('G5: 実験で CAC・継続・比較がそろえば pass。実測 CAC が高すぎれば fail', () => {
    expect(autoGates(full, fullData({ experiments: [fullExperiment('X001')] })).G5.suggestion).toBe('pass')
    const costly = fullData({ experiments: [fullExperiment('X001', { metrics: { ...fullExperiment('X001').metrics, spend: 2000000 } })] })
    expect(autoGates(full, costly).G5.suggestion).toBe('fail')
  })

  it('G6: 記録がそろっても unknown（人だけが判断）。automation の有無を理由に出す', () => {
    const g = autoGates(full, fullData({ experiments: [fullExperiment('X001'), fullExperiment('X002')] }))
    expect(g.G6).toEqual({ suggestion: 'unknown', reasons: [{ id: 'automationNoted', principle: 'how', ok: true }] })
    expect(autoGates(fullCandidate('C001', { how: { ...full.how, automation: ' ' } }), fullData()).G6.reasons[0].ok).toBeNull()
  })

  it('G7: 同じ方法か経路で契約の出た実験が2件以上', () => {
    expect(autoGates(full, fullData({ experiments: [fullExperiment('X001')] })).G7.suggestion).toBe('unknown')
    const two = fullData({ experiments: [fullExperiment('X001'), fullExperiment('X002', { method: 'lpAds' })] })
    const g = autoGates(full, two)
    expect(g.G7.suggestion).toBe('pass')
    expect(g.G7.reasons.find((c) => c.id === 'repeatable')?.params).toEqual({ count: 2, min: 2 })
  })

  it('壊れた候補でも落ちない', () => {
    expect(() => autoGates({ id: 'C001' } as unknown as Candidate, emptyData())).not.toThrow()
  })
})

describe('repeatedAcquisition', () => {
  const x = (id: string, patch: Parameters<typeof fullExperiment>[1] = {}) => fullExperiment(id, patch)

  it('method か channel ごとの数の最大', () => {
    const d = fullData({
      experiments: [
        x('X001', { method: 'outreach', channel: 'outreach' }),
        x('X002', { method: 'lpAds', channel: 'outreach' }),
        x('X003', { method: 'lpAds', channel: 'seo' }),
        x('X004', { method: 'lpAds', channel: null })
      ]
    })
    expect(repeatedAcquisition(full, d)).toBe(3)
  })

  it('契約 0・planned・ほかの候補・ID の重複は数えない', () => {
    const d = fullData({
      experiments: [
        x('X001'),
        x('X001'),
        x('X002', { metrics: metrics({ contracts: 0 }) }),
        x('X003', { status: 'planned' }),
        x('X004', { candidate: 'C002' }),
        x('X005', { metrics: metrics({ contracts: NaN }) })
      ]
    })
    expect(repeatedAcquisition(full, d)).toBe(1)
  })

  it('中止した実験でも契約が出ていれば数える', () => {
    expect(repeatedAcquisition(full, fullData({ experiments: [x('X001', { status: 'stopped' }), x('X002', { status: 'running' })] }))).toBe(2)
  })

  it('空・壊れた入力', () => {
    expect(repeatedAcquisition(full, emptyData())).toBe(0)
    expect(repeatedAcquisition(full, emptyData({ experiments: null as never }))).toBe(0)
  })
})

describe('canDecideGate', () => {
  it('G1 はいつでも pass にできる', () => {
    expect(canDecideGate(full, 'G1', 'pass')).toEqual({ ok: true })
  })

  it('前のゲートが人の pass でなければ pass にできない', () => {
    expect(canDecideGate(full, 'G2', 'pass')).toEqual({ ok: false, reason: 'previousNotPassed' })
    const c = fullCandidate('C001', { gates: gates({ ...passed(3), G2: 'fail' }) })
    expect(canDecideGate(c, 'G4', 'pass')).toEqual({ ok: false, reason: 'previousNotPassed' })
  })

  it('前がすべて pass なら pass にできる', () => {
    for (let i = 0; i < GATE_IDS.length; i++) {
      expect(canDecideGate(fullCandidate('C001', { gates: gates(passed(i)) }), GATE_IDS[i], 'pass')).toEqual({ ok: true })
    }
  })

  it('fail・pending（取り消し）はいつでもできる', () => {
    expect(canDecideGate(full, 'G7', 'fail')).toEqual({ ok: true })
    expect(canDecideGate(full, 'G7', 'pending')).toEqual({ ok: true })
  })

  it('知らないゲート・壊れた記録', () => {
    expect(canDecideGate(full, 'G8' as GateId, 'pass').ok).toBe(false)
    expect(canDecideGate(full, 'G8' as GateId, 'fail').ok).toBe(false)
    const broken = fullCandidate('C001', { gates: { G1: { status: 'yes' } } as never })
    expect(canDecideGate(broken, 'G2', 'pass').ok).toBe(false)
    expect(canDecideGate({ id: 'C001' } as unknown as Candidate, 'G2', 'pass').ok).toBe(false)
  })
})

describe('canPromote', () => {
  it('G1〜G3 が人の pass で、選ばれる理由が裏付けられていれば進める', () => {
    expect(canPromote(fullCandidate('C001', { gates: gates(passed(3)) }), fullData())).toEqual({ ok: true, missing: [] })
  })

  it('機械の目安が pass でも、人が確定していなければ進めない', () => {
    expect(canPromote(full, fullData())).toEqual({ ok: false, missing: ['G1', 'G2', 'G3'] })
  })

  it('理由の裏付けが無ければ whyReason', () => {
    const c = fullCandidate('C001', { gates: gates(passed(3)), why: { ...full.why, reasonEvidence: [] } })
    expect(canPromote(c, fullData()).missing).toEqual(['whyReason'])
    const ai = fullData({ evidence: [fullEvidence('E001', { grade: 'aiInference' })] })
    expect(canPromote(fullCandidate('C001', { gates: gates(passed(3)) }), ai).missing).toEqual(['whyReason'])
  })

  it('プロジェクトにした・除外した候補は進めない（条件はこの順に並ぶ）', () => {
    const c = blankCandidate('C001', { stage: 'dropped', promotedTo: { folder: '/x', projectId: 'p', at: '2026-10-18' } })
    expect(canPromote(c, emptyData())).toEqual({ ok: false, missing: ['G1', 'G2', 'G3', 'whyReason', 'scene', 'exit', 'alreadyPromoted', 'dropped'] })
  })

  it('購買が起きる場面が埋まっていなければ scene', () => {
    const c = fullCandidate('C001', { gates: gates(passed(3)), scene: scene({ outcome: '' }) })
    expect(canPromote(c, fullData())).toEqual({ ok: false, missing: ['scene'] })
  })

  it('調査の終了条件が未達なら exit', () => {
    const c = fullCandidate('C001', { gates: gates(passed(3)), deliverable: '' })
    expect(canPromote(c, fullData())).toEqual({ ok: false, missing: ['exit'] })
  })

  it('場面の出来事が空なら scene と exit の両方', () => {
    const c = fullCandidate('C001', { gates: gates(passed(3)), scene: scene({ event: '' }) })
    expect(canPromote(c, fullData()).missing).toEqual(['scene', 'exit'])
  })

  it('G4 以降は条件に入らない', () => {
    const c = fullCandidate('C001', { gates: gates({ ...passed(3), G4: 'fail' }) })
    expect(canPromote(c, fullData()).ok).toBe(true)
  })
})

describe('nextGate', () => {
  it('人の pass でない最初のゲート', () => {
    expect(nextGate(full)).toBe('G1')
    expect(nextGate(fullCandidate('C001', { gates: gates(passed(2)) }))).toBe('G3')
    expect(nextGate(fullCandidate('C001', { gates: gates({ ...passed(4), G3: 'fail' }) }))).toBe('G3')
  })

  it('すべて pass なら null', () => {
    expect(nextGate(fullCandidate('C001', { gates: gates(passed(7)) }))).toBeNull()
  })

  it('壊れた記録は G1', () => {
    expect(nextGate({ id: 'C001' } as unknown as Candidate)).toBe('G1')
  })
})

describe('funnelCounts・funnelReached', () => {
  const list = (stages: string[]) => stages.map((s, i) => blankCandidate(`C${String(i + 1).padStart(3, '0')}`, { stage: s as Candidate['stage'] }))

  it('段階ごとの数（全段階が並び、0 も出す）', () => {
    const counts = funnelCounts(list(['discovered', 'discovered', 'evidenced', 'testing', 'dropped']))
    expect(Object.keys(counts)).toEqual([...CANDIDATE_STAGES])
    expect(counts).toEqual({ discovered: 2, evidenced: 1, qualified: 0, testing: 1, selected: 0, dropped: 1 })
  })

  it('知らない段階・壊れた候補は数えない', () => {
    const counts = funnelCounts([...list(['weird', 'toString']), null as never])
    expect(Object.values(counts).every((n) => n === 0)).toBe(true)
    expect(funnelCounts(null as never).discovered).toBe(0)
  })

  it('到達した数は後ろの段階を含む（dropped は数えない）', () => {
    expect(funnelReached(list(['discovered', 'discovered', 'evidenced', 'testing', 'selected', 'dropped']))).toEqual({
      discovered: 5,
      evidenced: 3,
      qualified: 2,
      testing: 2,
      selected: 1
    })
    expect(funnelReached([])).toEqual({ discovered: 0, evidenced: 0, qualified: 0, testing: 0, selected: 0 })
  })
})
