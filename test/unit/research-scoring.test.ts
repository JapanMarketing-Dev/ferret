/**
 * 加重スコア・事業魅力度・足切り・ランキング・点の信頼度・Learning の較正（knowledge.md「6つの機能」の 5・6）
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_CUTOFFS, DEFAULT_WEIGHTS, SCORE_KEYS, type ResearchData, type ScoreEntry } from '@shared/research/model'
import {
  attractiveness,
  backedScore,
  backingEvidence,
  calibration,
  calibrationNote,
  cutoffHits,
  normalizeCutoffs,
  normalizeWeights,
  rankCandidates,
  scoreReliability,
  weightedScore,
  type CalibrationRow
} from '@shared/research/scoring'
import { conditions, emptyData, fullCandidate, fullData, fullEvidence, fullExperiment, metrics, scores } from './research-fixtures'

const data = fullData()

describe('normalizeWeights', () => {
  it('正しい重みはそのまま', () => {
    expect(normalizeWeights(DEFAULT_WEIGHTS)).toEqual(DEFAULT_WEIGHTS)
  })

  it('0〜100 に丸め、範囲外は端に寄せる', () => {
    const w = normalizeWeights({ demand: 33.6, spend: -5, reach: 250, profit: Infinity, competition: -Infinity, delivery: 0 })
    expect(w).toEqual({ demand: 34, spend: 0, reach: 100, profit: 100, competition: 0, delivery: 0 })
  })

  it('数でない・欠けた項目は初期値', () => {
    const w = normalizeWeights({ demand: '50', spend: null, reach: NaN, profit: 10 })
    expect(w).toEqual({ ...DEFAULT_WEIGHTS, profit: 10 })
  })

  it('合計 0 なら初期値に戻す', () => {
    expect(normalizeWeights(Object.fromEntries(SCORE_KEYS.map((k) => [k, 0])))).toEqual(DEFAULT_WEIGHTS)
    expect(normalizeWeights(Object.fromEntries(SCORE_KEYS.map((k) => [k, -1])))).toEqual(DEFAULT_WEIGHTS)
  })

  it.each([[null], [undefined], [42], ['x'], [[1, 2, 3]]])('%s は初期値', (w) => {
    expect(normalizeWeights(w)).toEqual(DEFAULT_WEIGHTS)
  })

  it('初期値の写しを返す（書き換えても DEFAULT_WEIGHTS は変わらない）', () => {
    const w = normalizeWeights(null)
    w.demand = 0
    expect(DEFAULT_WEIGHTS.demand).toBe(25)
  })
})

describe('normalizeCutoffs', () => {
  it('null は足切りなし、数は 1〜5 に寄せる、壊れた値は初期値', () => {
    expect(normalizeCutoffs({ demand: null, spend: 0, reach: 9, profit: 'x', competition: 3 })).toEqual({
      demand: null,
      spend: 1,
      reach: 5,
      profit: DEFAULT_CUTOFFS.profit,
      competition: 3,
      delivery: DEFAULT_CUTOFFS.delivery
    })
    expect(normalizeCutoffs(undefined)).toEqual(DEFAULT_CUTOFFS)
  })
})

describe('根拠の証拠', () => {
  const entry = (evidence: string[], score: ScoreEntry['score'] = 4): ScoreEntry => ({ score, evidence, reason: '' })

  it('データ内にあり裏付けに使える証拠だけ', () => {
    const d = emptyData({ evidence: [fullEvidence('E001'), fullEvidence('E002', { grade: 'aiInference' }), fullEvidence('E003', { url: '' })] })
    expect(backingEvidence(entry(['E001', 'E002', 'E003', 'E999', 'E001']), d).map((e) => e.id)).toEqual(['E001'])
  })

  it('根拠が無い点は数えない', () => {
    expect(backedScore(entry(['E001']), data)).toBe(4)
    expect(backedScore(entry([]), data)).toBeNull()
    expect(backedScore(entry(['E999']), data)).toBeNull()
  })

  it('点が 1〜5 でなければ null', () => {
    for (const bad of [0, 6, 2.5, NaN, null, '3']) expect(backedScore(entry(['E001'], bad as never), data)).toBeNull()
  })

  it('壊れた入力', () => {
    expect(backedScore(null, data)).toBeNull()
    expect(backingEvidence({ score: 3, evidence: 'E001' as never, reason: '' }, data)).toEqual([])
    expect(backingEvidence(entry(['E001']), { evidence: null as never })).toEqual([])
  })

  it('scoreReliability は根拠のうち最も強いもの', () => {
    expect(scoreReliability(entry(['E002', 'E001']), data)).toBe('high')
    expect(scoreReliability(entry(['E002']), data)).toBe('medium')
    expect(scoreReliability(entry([]), data)).toBeNull()
    expect(scoreReliability(entry(['E001'], null), data)).toBe('high')
  })
})

describe('weightedScore', () => {
  it('全項目 4 点なら 80 点', () => {
    expect(weightedScore(scores(), DEFAULT_WEIGHTS, data)).toEqual({ value: 80, scored: 6, unbacked: [] })
  })

  it('全項目 5 点で 100、1 点で 20', () => {
    expect(weightedScore(scores({}, ['E001'], 5), DEFAULT_WEIGHTS, data).value).toBe(100)
    expect(weightedScore(scores({}, ['E001'], 1), DEFAULT_WEIGHTS, data).value).toBe(20)
  })

  it('点の付いた項目だけで重みを割り直す', () => {
    const s = scores({ demand: 5, spend: null, reach: null, profit: null, competition: null, delivery: 1 })
    // (5×25 + 1×10) ÷ 35 × 20
    expect(weightedScore(s, DEFAULT_WEIGHTS, data)).toEqual({ value: Math.round(((135 / 35) * 20) * 10) / 10, scored: 2, unbacked: [] })
  })

  it('根拠の無い点は数えず unbacked に出す', () => {
    const s = scores()
    s.demand = { score: 1, evidence: [], reason: '' }
    s.reach = { score: 5, evidence: ['E999'], reason: '' }
    const r = weightedScore(s, DEFAULT_WEIGHTS, data)
    expect(r.unbacked).toEqual(['demand', 'reach'])
    expect(r.scored).toBe(4)
    expect(r.value).toBe(80)
  })

  it('AI の推測だけを根拠にした点は数えない', () => {
    const d = emptyData({ evidence: [fullEvidence('E001', { grade: 'aiInference' })] })
    expect(weightedScore(scores(), DEFAULT_WEIGHTS, d)).toEqual({ value: null, scored: 0, unbacked: [...SCORE_KEYS] })
  })

  it('未採点なら null（unbacked も空）', () => {
    expect(weightedScore(scores({}, ['E001'], null), DEFAULT_WEIGHTS, data)).toEqual({ value: null, scored: 0, unbacked: [] })
  })

  it('数えた項目の重みが 0 なら null', () => {
    const s = scores({ spend: null, reach: null, profit: null, competition: null, delivery: null })
    expect(weightedScore(s, { ...DEFAULT_WEIGHTS, demand: 0 }, data)).toEqual({ value: null, scored: 1, unbacked: [] })
  })

  it('壊れた重みは整えてから使う', () => {
    expect(weightedScore(scores(), null as never, data).value).toBe(80)
  })

  it('壊れた採点でも落ちない', () => {
    expect(weightedScore(null as never, DEFAULT_WEIGHTS, data)).toEqual({ value: null, scored: 0, unbacked: [] })
    expect(weightedScore({ demand: null } as never, DEFAULT_WEIGHTS, data).value).toBeNull()
  })
})

describe('attractiveness', () => {
  it('需要 × 到達 × 利益 ÷ ((6 − 競争) × (6 − 提供))', () => {
    const s = scores({ demand: 5, reach: 4, profit: 3, competition: 4, delivery: 2 })
    expect(attractiveness(s, data)).toEqual({ value: Math.round((60 / 8) * 100) / 100, unbacked: [] })
  })

  it('最高 125・最低 0.04', () => {
    expect(attractiveness(scores({}, ['E001'], 5), data).value).toBe(125)
    expect(attractiveness(scores({}, ['E001'], 1), data).value).toBe(0.04)
  })

  it('5項目のどれかが未採点・根拠なしなら null（支出は使わない）', () => {
    expect(attractiveness(scores({ spend: null }), data).value).not.toBeNull()
    expect(attractiveness(scores({ delivery: null }), data).value).toBeNull()
    const s = scores()
    s.profit = { score: 5, evidence: [], reason: '' }
    expect(attractiveness(s, data)).toEqual({ value: null, unbacked: ['profit'] })
  })

  it('壊れた入力', () => {
    expect(attractiveness(null as never, data)).toEqual({ value: null, unbacked: [] })
  })
})

describe('cutoffHits', () => {
  it('足切りより下の項目（ちょうどは掛からない）', () => {
    expect(cutoffHits(scores({ demand: 1, reach: 2 }), DEFAULT_CUTOFFS)).toEqual(['demand'])
  })

  it('根拠の無い低い点でも掛かる（安全側）', () => {
    const s = scores()
    s.reach = { score: 1, evidence: [], reason: '' }
    expect(cutoffHits(s, DEFAULT_CUTOFFS)).toEqual(['reach'])
  })

  it('未採点・足切りなしは見ない', () => {
    expect(cutoffHits(scores({ demand: null }), DEFAULT_CUTOFFS)).toEqual([])
    expect(cutoffHits(scores({ spend: 1 }), DEFAULT_CUTOFFS)).toEqual([])
  })

  it('足切りを変えられる（壊れた足切りは初期値）', () => {
    expect(cutoffHits(scores({ spend: 2 }), { ...DEFAULT_CUTOFFS, spend: 3 })).toEqual(['spend'])
    expect(cutoffHits(scores({ demand: 1 }), null as never)).toEqual(['demand'])
  })
})

describe('rankCandidates', () => {
  const d = (cands: ReturnType<typeof fullCandidate>[], patch: Partial<ResearchData> = {}) => fullData({ candidates: cands, ...patch })

  it('値の降順・保留は後ろ・null は最後・同点は ID 順・dropped は除く', () => {
    const rows = rankCandidates(
      d([
        fullCandidate('C001', { scores: scores({}, ['E001'], 3) }),
        fullCandidate('C002', { scores: scores({}, ['E001'], 5) }),
        fullCandidate('C003', { scores: scores({ reach: 1 }, ['E001'], 5) }),
        fullCandidate('C004', { scores: scores({}, [], 5) }),
        fullCandidate('C005', { scores: scores({}, ['E001'], 3) }),
        fullCandidate('C006', { stage: 'dropped' })
      ])
    )
    expect(rows.map((r) => r.id)).toEqual(['C002', 'C001', 'C005', 'C004', 'C003'])
    expect(rows.find((r) => r.id === 'C003')).toMatchObject({ held: true, cutoffs: ['reach'] })
    expect(rows.find((r) => r.id === 'C004')).toMatchObject({ value: null, unbacked: [...SCORE_KEYS] })
  })

  it('候補ごとの証拠のまとめを付ける', () => {
    const rows = rankCandidates(
      d([fullCandidate('C001'), fullCandidate('C002')], {
        evidence: [...fullData().evidence, fullEvidence('E003', { candidate: 'C002', grade: 'snsComplaint' })]
      })
    )
    expect(rows.find((r) => r.id === 'C001')?.evidence.level).toBe('strong')
    expect(rows.find((r) => r.id === 'C002')?.evidence.level).toBe('weak')
  })

  it('research.yaml の重みを使う', () => {
    const c1 = fullCandidate('C001', { scores: scores({ profit: 5, delivery: 1 }, ['E001'], 3) })
    const c2 = fullCandidate('C002', { scores: scores({ profit: 1, delivery: 5 }, ['E001'], 3) })
    const base = emptyData().research
    expect(rankCandidates(d([c1, c2], { research: { ...base, weights: { ...DEFAULT_WEIGHTS, profit: 100, delivery: 0 } } }))[0].id).toBe('C001')
    expect(rankCandidates(d([c1, c2], { research: { ...base, weights: { ...DEFAULT_WEIGHTS, profit: 0, delivery: 100 } } }))[0].id).toBe('C002')
  })

  it('空・壊れた入力', () => {
    expect(rankCandidates(emptyData())).toEqual([])
    expect(rankCandidates(emptyData({ candidates: null as never }))).toEqual([])
    expect(rankCandidates(emptyData({ candidates: [fullCandidate('C001')], research: null as never }))).toHaveLength(1)
  })

  it('候補が多くても並ぶ', () => {
    const cands = Array.from({ length: 1000 }, (_, i) => fullCandidate(`C${String(i + 1).padStart(4, '0')}`, { scores: scores({}, ['E001'], ((i % 5) + 1) as 1) }))
    const rows = rankCandidates(d(cands))
    expect(rows).toHaveLength(1000)
    for (let i = 1; i < rows.length; i++) expect((rows[i - 1].value as number) >= (rows[i].value as number)).toBe(true)
  })
})

describe('rankCandidates と成立条件（第2部: 評価の主軸は成立条件の表）', () => {
  it('重要な条件に反証があれば点が高くても保留（後ろ）にし、印を出す', () => {
    const rows = rankCandidates(
      fullData({
        candidates: [
          fullCandidate('C001', { scores: scores({}, ['E001'], 5), conditions: conditions({ status: 'supported' }, { revenue: { counter: ['E002'] } }) }),
          fullCandidate('C002', { scores: scores({}, ['E001'], 2) })
        ]
      })
    )
    expect(rows.map((r) => r.id)).toEqual(['C002', 'C001'])
    expect(rows[1]).toMatchObject({ held: true, cutoffs: [], alarms: ['revenue'], decision: 'holdOrDrop', value: 100 })
    expect(rows[0]).toMatchObject({ held: false, alarms: [], decision: 'experiment' })
  })

  it('人の refuted も印になる', () => {
    const [row] = rankCandidates(fullData({ candidates: [fullCandidate('C001', { conditions: conditions({}, { reachable: { status: 'refuted' } }) })] }))
    expect(row).toMatchObject({ held: true, alarms: ['reachable'] })
  })

  it('次の行動の目安を付ける', () => {
    const rows = rankCandidates(fullData({ candidates: [fullCandidate('C001')], experiments: [fullExperiment('X001'), fullExperiment('X002')] }))
    expect(rows[0].decision).toBe('invest')
  })
})

describe('calibration', () => {
  it('実験のある候補だけ。実測の成約率・CAC と事前の点・証拠の強さ', () => {
    const rows = calibration(fullData({ candidates: [fullCandidate('C001'), fullCandidate('C002')], experiments: [fullExperiment('X001')] }))
    expect(rows).toEqual([{ candidateId: 'C001', score: 80, evidenceLevel: 'strong', measuredCloseRate: 0.25, measuredCac: 20000 }])
  })

  it('planned だけの候補は率・CAC が null', () => {
    const [row] = calibration(fullData({ experiments: [fullExperiment('X001', { status: 'planned' })] }))
    expect(row.measuredCloseRate).toBeNull()
    expect(row.measuredCac).toBeNull()
  })

  it('dropped の候補も学びとして残す', () => {
    expect(calibration(fullData({ candidates: [fullCandidate('C001', { stage: 'dropped' })], experiments: [fullExperiment('X001')] }))).toHaveLength(1)
  })

  it('空・壊れた入力', () => {
    expect(calibration(emptyData())).toEqual([])
    expect(calibration(emptyData({ candidates: [fullCandidate('C001')], experiments: null as never }))).toEqual([])
  })
})

describe('calibrationNote', () => {
  const row = (score: number | null, rate: number | null, i = 0): CalibrationRow => ({ candidateId: `C${i}`, score, evidenceLevel: 'weak', measuredCloseRate: rate, measuredCac: null })

  it('3件未満は相関を出さない', () => {
    expect(calibrationNote([])).toEqual({ n: 0, correlation: null })
    expect(calibrationNote([row(50, 0.1), row(80, 0.3)])).toEqual({ n: 2, correlation: null })
  })

  it('完全な正の相関・負の相関', () => {
    expect(calibrationNote([row(40, 0.1), row(60, 0.2), row(80, 0.3)])).toEqual({ n: 3, correlation: 1 })
    expect(calibrationNote([row(40, 0.3), row(60, 0.2), row(80, 0.1)])).toEqual({ n: 3, correlation: -1 })
  })

  it('null・NaN の行は数えない', () => {
    expect(calibrationNote([row(40, 0.1), row(null, 0.2), row(60, null), row(NaN, 0.1), row(80, 0.3), row(70, 0.2)]).n).toBe(3)
  })

  it('ばらつきが 0 なら null', () => {
    expect(calibrationNote([row(50, 0.1), row(50, 0.2), row(50, 0.3)])).toEqual({ n: 3, correlation: null })
    expect(calibrationNote([row(40, 0.2), row(50, 0.2), row(60, 0.2)])).toEqual({ n: 3, correlation: null })
  })

  it('-1〜1 に収まる', () => {
    const rows = Array.from({ length: 200 }, (_, i) => row((i * 37) % 100, ((i * 13) % 50) / 100, i))
    const c = calibrationNote(rows).correlation as number
    expect(c).toBeGreaterThanOrEqual(-1)
    expect(c).toBeLessThanOrEqual(1)
  })

  it('壊れた入力', () => {
    expect(calibrationNote(null as never)).toEqual({ n: 0, correlation: null })
  })
})
