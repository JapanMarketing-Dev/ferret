/**
 * 5原則の完了条件の機械的な確認（knowledge.md 各原則の「判定方法」「完了条件」）
 */
import { describe, expect, it } from 'vitest'
import { PRINCIPLE_KEYS, type Candidate, type PrincipleKey, type ResearchData } from '@shared/research/model'
import { candidateExperiments, principleStatus, reasonBackingCount, type Check } from '@shared/research/principles'
import { blankCandidate, company, emptyData, fullCandidate, fullData, fullEvidence, fullExperiment, metrics } from './research-fixtures'

function find(st: ReturnType<typeof principleStatus>, p: PrincipleKey, id: string): Check {
  const c = [...st[p].research, ...st[p].experiment].find((x) => x.id === id)
  if (!c) throw new Error(`no check ${p}.${id}`)
  return c
}

function statusOf(c: Candidate, d: ResearchData = fullData()) {
  return principleStatus(c, { ...d, candidates: [c] })
}

const C = (patch: Partial<Candidate> = {}) => fullCandidate('C001', patch)
const full = fullCandidate('C001')

describe('principleStatus の形', () => {
  it('5原則すべてに research・experiment があり、Check の id と principle がそろう', () => {
    const st = statusOf(full)
    expect(Object.keys(st)).toEqual([...PRINCIPLE_KEYS])
    for (const p of PRINCIPLE_KEYS) {
      for (const c of [...st[p].research, ...st[p].experiment]) {
        expect(c.principle).toBe(p)
        expect(c.id).toMatch(/^[a-zA-Z]+$/)
        expect([true, false, null]).toContain(c.ok)
      }
    }
  })

  it('id の一覧（i18n キー research.check.<principle>.<id> の正本）', () => {
    const st = statusOf(full)
    const ids = Object.fromEntries(PRINCIPLE_KEYS.map((p) => [p, { research: st[p].research.map((c) => c.id), experiment: st[p].experiment.map((c) => c.id) }]))
    expect(ids).toEqual({
      who: { research: ['segmentDefined', 'listBuilt', 'factsSeparated', 'buyerKnown', 'repeatableContact', 'conditions'], experiment: ['contactable'] },
      what: { research: ['jtbd', 'factors', 'problemType', 'quantified', 'spendAndComplaint', 'improvement'], experiment: ['problemConfirmed'] },
      where: { research: ['channelEvaluated', 'triggerOrIntentKeyword', 'summary'], experiment: ['lowCostAcquisition'] },
      why: { research: ['switchingPositive', 'differentiator', 'findings', 'reasonBacked'], experiment: ['chosen'] },
      how: { research: ['pricing', 'scenarios', 'cacBasis', 'viableMiddle'], experiment: ['measuredAndProven'] }
    })
  })

  it('全欄を埋めた候補はリサーチの完了条件をすべて満たす（実験はまだ）', () => {
    const st = statusOf(full)
    for (const p of PRINCIPLE_KEYS) {
      expect(st[p].research.filter((c) => c.ok !== true).map((c) => c.id)).toEqual([])
      expect(st[p].researchDone).toBe(true)
      expect(st[p].experimentDone).toBe(false)
      expect(st[p].experiment.every((c) => c.ok === null)).toBe(true)
    }
  })

  it('何も調べていない候補は false を出さない（未調査は null）', () => {
    const st = statusOf(blankCandidate('C001'), emptyData())
    for (const p of PRINCIPLE_KEYS) {
      for (const c of [...st[p].research, ...st[p].experiment]) expect(c.ok).toBeNull()
      expect(st[p].researchDone).toBe(false)
    }
  })

  it('壊れた候補でも落ちない', () => {
    const broken = { id: 'C001' } as unknown as Candidate
    const st = principleStatus(broken, emptyData())
    expect(st.who.researchDone).toBe(false)
    const half = { ...full, who: { ...full.who, companies: [null, 3] as never, segment: null as never } }
    expect(() => statusOf(half)).not.toThrow()
  })
})

describe('Who', () => {
  it('セグメントの5軸がすべて埋まって segmentDefined', () => {
    const c = C({ who: { ...full.who, segment: { ...full.who.segment, purchase: '  ' } } })
    expect(find(statusOf(c), 'who', 'segmentDefined')).toEqual({ id: 'segmentDefined', principle: 'who', ok: null, params: { filled: 4, total: 5 } })
  })

  it('listBuilt: 企業リストか総数が minTargetCount 以上', () => {
    expect(find(statusOf(full), 'who', 'listBuilt')).toMatchObject({ ok: true, params: { count: 120, min: 100 } })
    expect(find(statusOf(C({ who: { ...full.who, targetCount: 100 } })), 'who', 'listBuilt').ok).toBe(true)
    expect(find(statusOf(C({ who: { ...full.who, targetCount: 99 } })), 'who', 'listBuilt')).toMatchObject({ ok: false, params: { count: 99 } })
    expect(find(statusOf(C({ who: { ...full.who, targetCount: 0 } })), 'who', 'listBuilt').ok).toBe(false)
  })

  it('listBuilt: 総数が未確認なら、リストが足りないうちは null', () => {
    expect(find(statusOf(C({ who: { ...full.who, targetCount: null } })), 'who', 'listBuilt')).toMatchObject({ ok: null, params: { count: 5 } })
    const many = Array.from({ length: 100 }, (_, i) => company(`社${i}`))
    expect(find(statusOf(C({ who: { ...full.who, targetCount: null, companies: many } })), 'who', 'listBuilt').ok).toBe(true)
  })

  it('listBuilt: 同じ社名は1社。負・NaN の総数は未確認', () => {
    const dup = Array.from({ length: 100 }, () => company('同じ社'))
    expect(find(statusOf(C({ who: { ...full.who, targetCount: null, companies: dup } })), 'who', 'listBuilt').params?.count).toBe(1)
    expect(find(statusOf(C({ who: { ...full.who, targetCount: -5 } })), 'who', 'listBuilt').ok).toBeNull()
    expect(find(statusOf(C({ who: { ...full.who, targetCount: NaN } })), 'who', 'listBuilt').ok).toBeNull()
  })

  it('listBuilt: research.yaml の目安を使い、不正なら 100', () => {
    const d = fullData()
    expect(find(statusOf(full, { ...d, research: { ...d.research, minTargetCount: 200 } }), 'who', 'listBuilt').ok).toBe(false)
    expect(find(statusOf(full, { ...d, research: { ...d.research, minTargetCount: 0 } }), 'who', 'listBuilt').params?.min).toBe(100)
    expect(find(statusOf(full, { ...d, research: { ...d.research, minTargetCount: NaN } }), 'who', 'listBuilt').params?.min).toBe(100)
  })

  it('factsSeparated: 事実と推測が同じ文なら false、片方が空なら null', () => {
    const same = C({ who: { ...full.who, companies: [company('A社', { situation: '営業を募集', inferredProblem: ' 営業を募集 ' })] } })
    expect(find(statusOf(same), 'who', 'factsSeparated').ok).toBe(false)
    const empty = C({ who: { ...full.who, companies: [company('A社', { inferredProblem: '' })] } })
    expect(find(statusOf(empty), 'who', 'factsSeparated').ok).toBeNull()
    expect(find(statusOf(C({ who: { ...full.who, companies: [] } })), 'who', 'factsSeparated').ok).toBeNull()
  })

  it('buyerKnown・repeatableContact: 8割で true', () => {
    const list = (n: number) => Array.from({ length: 10 }, (_, i) => company(`社${i}`, i < n ? {} : { buyerRole: '', reachPath: '' }))
    expect(find(statusOf(C({ who: { ...full.who, companies: list(8) } })), 'who', 'buyerKnown')).toMatchObject({ ok: true, params: { filled: 8, total: 10, percent: 80 } })
    expect(find(statusOf(C({ who: { ...full.who, companies: list(7) } })), 'who', 'buyerKnown').ok).toBeNull()
    expect(find(statusOf(C({ who: { ...full.who, companies: list(7) } })), 'who', 'repeatableContact').ok).toBeNull()
    expect(find(statusOf(C({ who: { ...full.who, companies: [] } })), 'who', 'buyerKnown').ok).toBeNull()
  })

  it('conditions: 人の5条件。1つでも「いいえ」なら false、未判断があれば null', () => {
    const cond = (patch: object) => C({ who: { ...full.who, conditions: { ...full.who.conditions, ...patch } } })
    expect(find(statusOf(full), 'who', 'conditions')).toMatchObject({ ok: true, params: { yes: 5, total: 5 } })
    expect(find(statusOf(cond({ canPay: null })), 'who', 'conditions').ok).toBeNull()
    expect(find(statusOf(cond({ canPay: false, buyerKnown: null })), 'who', 'conditions').ok).toBe(false)
  })

  it('contactable: 担当者に届き商談になれば true、終わった実験で 0 なら false、実施中の 0 は null', () => {
    const run = (patch: Parameters<typeof fullExperiment>[1]) => find(statusOf(full, fullData({ experiments: [fullExperiment('X001', patch)] })), 'who', 'contactable').ok
    expect(run({})).toBe(true)
    expect(run({ metrics: metrics({ reachedBuyer: 10, meetings: 0 }) })).toBe(false)
    expect(run({ status: 'stopped', metrics: metrics({ reachedBuyer: 0 }) })).toBe(false)
    expect(run({ status: 'running', metrics: metrics({ reachedBuyer: 10, meetings: 0 }) })).toBeNull()
    expect(run({ status: 'planned' })).toBeNull()
    expect(run({ metrics: metrics() })).toBeNull()
  })

  it('ほかの候補の実験は数えない', () => {
    expect(find(statusOf(full, fullData({ experiments: [fullExperiment('X001', { candidate: 'C002' })] })), 'who', 'contactable').ok).toBeNull()
  })
})

describe('What', () => {
  it('jtbd: 3層', () => {
    const c = C({ what: { ...full.what, jtbd: { ...full.what.jtbd, purpose: '' } } })
    expect(find(statusOf(c), 'what', 'jtbd')).toMatchObject({ ok: null, params: { filled: 2, total: 3 } })
  })

  it('factors: 5要素のうち4つ以上（1〜5 の点だけ数える）', () => {
    const f = (patch: object) => C({ what: { ...full.what, factors: { ...full.what.factors, ...patch } } })
    expect(find(statusOf(f({ urgency: null })), 'what', 'factors').ok).toBe(true)
    expect(find(statusOf(f({ urgency: null, loss: null })), 'what', 'factors')).toMatchObject({ ok: null, params: { filled: 3, min: 4 } })
    expect(find(statusOf(f({ urgency: 0, loss: 7 })), 'what', 'factors').ok).toBeNull()
  })

  it('problemType: unknown・壊れた値は null', () => {
    expect(find(statusOf(C({ what: { ...full.what, problemType: 'highStakes' } })), 'what', 'problemType').ok).toBe(true)
    expect(find(statusOf(C({ what: { ...full.what, problemType: 'unknown' } })), 'what', 'problemType').ok).toBeNull()
    expect(find(statusOf(C({ what: { ...full.what, problemType: 'weird' as never } })), 'what', 'problemType').ok).toBeNull()
  })

  it('quantified: 時間の換算か現金支出のどちらかがあれば', () => {
    const q = (patch: object) => C({ what: { ...full.what, quantification: { ...full.what.quantification, ...patch } } })
    expect(find(statusOf(q({ hoursPerMonth: null })), 'what', 'quantified').ok).toBe(true)
    expect(find(statusOf(q({ cashSpendMonthly: null })), 'what', 'quantified').ok).toBe(true)
    expect(find(statusOf(q({ hoursPerMonth: null, cashSpendMonthly: null })), 'what', 'quantified').ok).toBeNull()
    expect(find(statusOf(q({ hoursPerMonth: -1, cashSpendMonthly: NaN })), 'what', 'quantified').ok).toBeNull()
  })

  it('spendAndComplaint: その候補の裏付けに使える証拠で支出と不満の両方', () => {
    expect(find(statusOf(full), 'what', 'spendAndComplaint')).toMatchObject({ ok: true, params: { spend: 1, complaint: 1 } })
    const onlySpend = fullData({ evidence: [fullEvidence('E001')] })
    expect(find(statusOf(full, onlySpend), 'what', 'spendAndComplaint').ok).toBeNull()
    const other = fullData({ evidence: [fullEvidence('E001'), fullEvidence('E002', { grade: 'reviewComplaint', candidate: 'C009' })] })
    expect(find(statusOf(full, other), 'what', 'spendAndComplaint').ok).toBeNull()
  })

  it('improvement', () => {
    expect(find(statusOf(C({ what: { ...full.what, improvement: '' } })), 'what', 'improvement').ok).toBeNull()
  })

  it('problemConfirmed: 課題一致か購入意思', () => {
    const run = (patch: Parameters<typeof fullExperiment>[1]) => find(statusOf(full, fullData({ experiments: [fullExperiment('X001', patch)] })), 'what', 'problemConfirmed').ok
    expect(run({})).toBe(true)
    expect(run({ metrics: metrics({ problemMatch: 0, purchaseIntent: 2 }) })).toBe(true)
    expect(run({ metrics: metrics({ problemMatch: 0, purchaseIntent: 0 }) })).toBe(false)
    expect(run({ metrics: metrics({ problemMatch: 0 }) })).toBe(false)
    expect(run({ status: 'running', metrics: metrics({ problemMatch: 0 }) })).toBeNull()
  })
})

describe('Where', () => {
  it('channelEvaluated: 状態と5軸がそろった経路が1つ以上', () => {
    const ch = full.where.channels[0]
    expect(find(statusOf(full), 'where', 'channelEvaluated').params).toEqual({ evaluated: 2 })
    const partial = C({ where: { ...full.where, channels: [{ ...ch, axes: { ...ch.axes, cost: null } }, { ...ch, state: null }] } })
    expect(find(statusOf(partial), 'where', 'channelEvaluated').ok).toBeNull()
  })

  it('triggerOrIntentKeyword: きっかけか購入意図のキーワード', () => {
    const w = (patch: object) => C({ where: { ...full.where, ...patch } })
    expect(find(statusOf(w({ triggers: [] })), 'where', 'triggerOrIntentKeyword').ok).toBe(true)
    expect(find(statusOf(w({ keywords: [] })), 'where', 'triggerOrIntentKeyword').ok).toBe(true)
    expect(find(statusOf(w({ triggers: [], keywords: [{ ...full.where.keywords[0], intent: 'info' }] })), 'where', 'triggerOrIntentKeyword').ok).toBeNull()
    expect(find(statusOf(w({ triggers: [{ ...full.where.triggers[0], url: '' }], keywords: [] })), 'where', 'triggerOrIntentKeyword').ok).toBeNull()
  })

  it('summary', () => {
    expect(find(statusOf(C({ where: { ...full.where, summary: ' ' } })), 'where', 'summary').ok).toBeNull()
  })

  it('lowCostAcquisition: 実測 CAC ≤ 中央の LTV ÷ 3', () => {
    // 中央 = 12か月: 3万 × 0.8 × 12 = 28.8万 → 上限 9.6万
    const run = (spend: number, contracts: number) =>
      find(statusOf(full, fullData({ experiments: [fullExperiment('X001', { metrics: metrics({ spend, contracts }) })] })), 'where', 'lowCostAcquisition')
    expect(run(96000, 1)).toMatchObject({ ok: true, params: { cac: 96000, limit: 96000, months: 12 } })
    expect(run(96001, 1).ok).toBe(false)
    expect(run(100000, 0).ok).toBeNull()
  })

  it('lowCostAcquisition: 見積りの CAC は使わない（実測だけ）', () => {
    expect(find(statusOf(full), 'where', 'lowCostAcquisition').ok).toBeNull()
  })
})

describe('Why', () => {
  it('switchingPositive: 式が正か併用できれば true、式が負なら false', () => {
    const sw = (patch: object) => C({ why: { ...full.why, switching: { ...full.why.switching, ...patch } } })
    expect(find(statusOf(full), 'why', 'switchingPositive')).toMatchObject({ ok: true, params: { margin: 640000 } })
    expect(find(statusOf(sw({ adoptionCost: 1000000 })), 'why', 'switchingPositive').ok).toBe(false)
    expect(find(statusOf(sw({ adoptionCost: 1000000, coexists: true })), 'why', 'switchingPositive').ok).toBe(true)
    expect(find(statusOf(sw({ adoptionCost: null })), 'why', 'switchingPositive')).toEqual({ id: 'switchingPositive', principle: 'why', ok: null })
    expect(find(statusOf(sw({ adoptionCost: null, coexists: true })), 'why', 'switchingPositive').ok).toBe(true)
  })

  it('differentiator: 7種のどれか（知らない種類は数えない）', () => {
    expect(find(statusOf(C({ why: { ...full.why, differentiators: [] } })), 'why', 'differentiator').ok).toBeNull()
    expect(find(statusOf(C({ why: { ...full.why, differentiators: [{ kind: 'magic' as never, note: '' }] } })), 'why', 'differentiator').ok).toBeNull()
  })

  it('findings: 10項目のうち6つ以上（サイトのコンセプトと証明・競合の求人・広告ライブラリ・投稿サイトの声を含む）', () => {
    const fd = { ...full.why.findings, churnPosts: '', pricing: '', competitorHiring: '', socialVoice: '' }
    expect(find(statusOf(C({ why: { ...full.why, findings: fd } })), 'why', 'findings')).toMatchObject({ ok: true, params: { filled: 6, total: 10 } })
    expect(find(statusOf(C({ why: { ...full.why, findings: { ...fd, caseStudies: '' } } })), 'why', 'findings').ok).toBeNull()
  })

  it('reasonBacked: 理由の1文と、裏付けに使える証拠1件以上', () => {
    expect(find(statusOf(full), 'why', 'reasonBacked')).toMatchObject({ ok: true, params: { backed: 1 } })
    expect(find(statusOf(C({ why: { ...full.why, reason: '' } })), 'why', 'reasonBacked').ok).toBeNull()
    expect(find(statusOf(C({ why: { ...full.why, reasonEvidence: ['E999'] } })), 'why', 'reasonBacked').ok).toBeNull()
    const ai = fullData({ evidence: [fullEvidence('E001', { grade: 'aiInference' })] })
    expect(find(statusOf(full, ai), 'why', 'reasonBacked').ok).toBeNull()
  })

  it('reasonBackingCount: 重複は1件', () => {
    expect(reasonBackingCount(C({ why: { ...full.why, reasonEvidence: ['E001', 'E001', 'E002'] } }), fullData())).toBe(2)
    expect(reasonBackingCount(C({ why: { ...full.why, reasonEvidence: null as never } }), fullData())).toBe(0)
  })

  it('chosen: 購入意思か契約', () => {
    const run = (patch: Parameters<typeof fullExperiment>[1]) => find(statusOf(full, fullData({ experiments: [fullExperiment('X001', patch)] })), 'why', 'chosen').ok
    expect(run({})).toBe(true)
    expect(run({ metrics: metrics({ purchaseIntent: 0, contracts: 1 }) })).toBe(true)
    expect(run({ metrics: metrics({ purchaseIntent: 0, contracts: 0 }) })).toBe(false)
    expect(run({ metrics: metrics({ purchaseIntent: null, contracts: null }) })).toBeNull()
  })
})

describe('How', () => {
  const h = (patch: object) => C({ how: { ...full.how, ...patch } })

  it('pricing: 月額 > 0、利益率 0〜1', () => {
    expect(find(statusOf(h({ monthlyPrice: 0 })), 'how', 'pricing').ok).toBeNull()
    expect(find(statusOf(h({ marginRate: 1.5 })), 'how', 'pricing').ok).toBeNull()
    expect(find(statusOf(h({ marginRate: 1 })), 'how', 'pricing').ok).toBe(true)
    expect(find(statusOf(h({ marginRate: null })), 'how', 'pricing').ok).toBeNull()
  })

  it('scenarios: 正しい仮定が2つ以上（重複・不正は除く）', () => {
    expect(find(statusOf(h({ retentionScenarios: [12, 12, -1, NaN] })), 'how', 'scenarios')).toMatchObject({ ok: null, params: { count: 1, min: 2 } })
    expect(find(statusOf(h({ retentionScenarios: [12, 24] })), 'how', 'scenarios').ok).toBe(true)
  })

  it('cacBasis', () => {
    expect(find(statusOf(h({ cacBasis: '' })), 'how', 'cacBasis').ok).toBeNull()
  })

  it('viableMiddle: 中央の仮定で LTV/CAC ≥ 3（見積りの CAC）', () => {
    expect(find(statusOf(full), 'how', 'viableMiddle')).toMatchObject({ ok: true, params: { source: 'estimated', months: 12, ratio: 9.6 } })
    expect(find(statusOf(h({ estimatedCac: 100000 })), 'how', 'viableMiddle').ok).toBe(false)
    expect(find(statusOf(h({ estimatedCac: null })), 'how', 'viableMiddle')).toMatchObject({ ok: null, params: { source: 'none' } })
    expect(find(statusOf(h({ retentionScenarios: [] })), 'how', 'viableMiddle').ok).toBeNull()
  })

  it('viableMiddle: 実測の CAC があればそちらを使う', () => {
    const d = fullData({ experiments: [fullExperiment('X001', { metrics: metrics({ spend: 1000000, contracts: 1 }) })] })
    expect(find(statusOf(full, d), 'how', 'viableMiddle')).toMatchObject({ ok: false, params: { source: 'measured' } })
  })

  it('measuredAndProven: 実測 CAC・継続した顧客・比較で効果を言える実験', () => {
    const run = (patch: Parameters<typeof fullExperiment>[1]) => find(statusOf(full, fullData({ experiments: [fullExperiment('X001', patch)] })), 'how', 'measuredAndProven')
    expect(run({})).toMatchObject({ ok: true, params: { proven: 1 } })
    expect(run({ comparison: 'none' }).ok).toBeNull()
    expect(run({ metrics: { ...fullExperiment('X001').metrics, retained: 0 } }).ok).toBeNull()
    expect(run({ metrics: { ...fullExperiment('X001').metrics, spend: null } }).ok).toBeNull()
  })
})

describe('candidateExperiments', () => {
  it('その候補の実験だけ。ID の重複は最初の1件', () => {
    const d = fullData({ experiments: [fullExperiment('X001'), fullExperiment('X001', { status: 'planned' }), fullExperiment('X002', { candidate: 'C002' })] })
    const list = candidateExperiments(full, d)
    expect(list.map((x) => x.id)).toEqual(['X001'])
    expect(list[0].status).toBe('done')
  })

  it('壊れた入力', () => {
    expect(candidateExperiments(full, emptyData({ experiments: null as never }))).toEqual([])
    expect(candidateExperiments(full, emptyData({ experiments: [null] as never }))).toEqual([])
  })
})
