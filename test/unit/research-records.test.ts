import { describe, expect, it } from 'vitest'
import {
  MAX_COMPANIES,
  MAX_LIST,
  MAX_RETENTION_MONTHS,
  MAX_TEXT,
  coerceResearch,
  coerceResearchRecord,
  emptyCandidate,
  emptyEvidence,
  emptyExperiment,
  emptyResearch,
  emptyResearchRecord,
  hasResearchErrors,
  isIsoDate,
  isWebUrl,
  validateResearchRecord
} from '@shared/research/records'
import {
  DEFAULT_CUTOFFS,
  DEFAULT_FUNNEL_TARGETS,
  DEFAULT_WEIGHTS,
  GATE_IDS,
  METRIC_KEYS,
  SCORE_KEYS,
  type Candidate,
  type ResearchData,
  type ResearchEvidence,
  type ResearchExperiment
} from '@shared/research/model'
import { researchMainEn } from '@shared/research/messages/main.en'
import { researchMainJa } from '@shared/research/messages/main.ja'
import type { ResearchIssue } from '@shared/research/ipc'

const NOW = '2026-10-18T03:00:00.000Z'

function data(over: Partial<ResearchData> = {}): ResearchData {
  return { root: '/r', research: emptyResearch('r', NOW), candidates: [], evidence: [], experiments: [], problems: [], ...over }
}

function goodEvidence(id = 'E001', over: Partial<ResearchEvidence> = {}): ResearchEvidence {
  return { ...emptyEvidence(id, NOW), grade: 'contract', kind: 'spend', url: 'https://example.com/a', quote: '月額3万円で契約', fact: '契約がある', inference: '支払意思がある', ...over }
}

const codes = (issues: ResearchIssue[]) => issues.map((i) => `${i.level}:${i.field}:${i.code}`)
const errorCodes = (issues: ResearchIssue[]) => issues.filter((i) => i.level === 'error').map((i) => i.code)

describe('空の形', () => {
  it('research.yaml の初期値は定数の写し（共有しない）', () => {
    const r = emptyResearch('名前', NOW)
    expect(r).toMatchObject({ name: '名前', scope: '', minTargetCount: 100, createdAt: NOW })
    expect(r.weights).toEqual(DEFAULT_WEIGHTS)
    expect(r.cutoffs).toEqual(DEFAULT_CUTOFFS)
    expect(r.funnelTargets).toEqual(DEFAULT_FUNNEL_TARGETS)
    r.weights.demand = 0
    expect(DEFAULT_WEIGHTS.demand).toBe(25)
  })

  it('候補は全部の欄があり、数は null・ゲートは pending・段階は discovered', () => {
    const c = emptyCandidate('C001', NOW)
    expect(c.stage).toBe('discovered')
    expect(c.who.targetCount).toBeNull()
    expect(Object.keys(c.gates)).toEqual([...GATE_IDS])
    expect(Object.values(c.gates).every((g) => g.status === 'pending' && g.at === '')).toBe(true)
    expect(Object.keys(c.scores)).toEqual([...SCORE_KEYS])
    expect(Object.values(c.scores).every((s) => s.score === null && s.evidence.length === 0)).toBe(true)
    expect(c.what.quantification).toEqual({ hoursPerMonth: null, hourlyCost: null, reductionRate: null, cashSpendMonthly: null, opportunityMonthly: null })
    expect(c.promotedTo).toBeNull()
    // 2つの空の候補は同じオブジェクトを共有しない
    const d = emptyCandidate('C002', NOW)
    d.gates.G1.status = 'pass'
    expect(c.gates.G1.status).toBe('pending')
  })

  it('証拠は一番弱い区分・今日の確認日。実験は計画中・数は全部 null', () => {
    expect(emptyEvidence('E001', NOW)).toMatchObject({ grade: 'aiInference', checkedAt: '2026-10-18', url: '' })
    const x = emptyExperiment('X001')
    expect(x.status).toBe('planned')
    expect(Object.keys(x.metrics)).toEqual([...METRIC_KEYS])
    expect(Object.values(x.metrics).every((v) => v === null)).toBe(true)
    expect(emptyResearchRecord('experiment', 'X002', NOW).id).toBe('X002')
    expect(emptyResearchRecord('candidate', 'C009', NOW).id).toBe('C009')
  })
})

describe('coerceResearch', () => {
  it('空・null・配列・文字でも落ちず、既定へ寄せる', () => {
    for (const raw of [undefined, null, [], 'x', 42, {}]) {
      const { value } = coerceResearch(raw, 'フォルダ名', NOW)
      expect(value.name).toBe('フォルダ名')
      expect(value.weights).toEqual(DEFAULT_WEIGHTS)
    }
    expect(coerceResearch([], 'x', NOW).fixes[0]?.code).toBe('fixNotObject')
  })

  it('重み: 0〜100 の数だけ。範囲の外・数でないものは初期値のまま知らせる', () => {
    const { value, fixes } = coerceResearch({ weights: { demand: 50, spend: '30', reach: -1, profit: 101, competition: 'abc', delivery: Number.NaN } }, 'x', NOW)
    expect(value.weights).toEqual({ ...DEFAULT_WEIGHTS, demand: 50, spend: 30 })
    expect(fixes.map((f) => `${f.field}:${f.code}`)).toEqual(['weights.reach:fixOutOfRange', 'weights.profit:fixOutOfRange', 'weights.competition:fixBadNumber', 'weights.delivery:fixBadNumber'])
  })

  it('足切り: null は足切りなし、1〜5 の整数だけ。0・6・小数は外す', () => {
    const { value, fixes } = coerceResearch({ cutoffs: { demand: null, reach: 3, spend: 0, profit: 6, competition: 2.5 } }, 'x', NOW)
    expect(value.cutoffs).toMatchObject({ demand: null, reach: 3, spend: null, profit: null, competition: null, delivery: null })
    expect(fixes.filter((f) => f.code === 'fixBadScore')).toHaveLength(3)
  })

  it('ファンネルの目安と G1 の目安は整数・下限あり', () => {
    const { value, fixes } = coerceResearch({ funnelTargets: { discovered: 500, evidenced: -3, qualified: 1.5, testing: Infinity }, minTargetCount: 0 }, 'x', NOW)
    expect(value.funnelTargets).toEqual({ ...DEFAULT_FUNNEL_TARGETS, discovered: 500 })
    expect(value.minTargetCount).toBe(100)
    expect(fixes.map((f) => f.field)).toEqual(['funnelTargets.evidenced', 'funnelTargets.qualified', 'funnelTargets.testing', 'minTargetCount'])
    expect(coerceResearch({ minTargetCount: 30 }, 'x', NOW).value.minTargetCount).toBe(30)
  })

  it('名前が空白だけならフォルダ名。長すぎる文は切る', () => {
    expect(coerceResearch({ name: '   ' }, 'fallback', NOW).value.name).toBe('fallback')
    const r = coerceResearch({ scope: 'あ'.repeat(MAX_TEXT + 5) }, 'x', NOW)
    expect(r.value.scope).toHaveLength(MAX_TEXT)
    expect(r.fixes[0]).toMatchObject({ field: 'scope', code: 'fixTooLong', params: { max: MAX_TEXT } })
  })
})

describe('coerceResearchRecord: 候補', () => {
  it('壊れた形（null・配列・文字）でも全部の欄がそろう', () => {
    for (const raw of [null, undefined, [], 'text', 3]) {
      const { value } = coerceResearchRecord('candidate', raw, 'C001', NOW)
      expect(value.id).toBe('C001')
      expect(value.who.companies).toEqual([])
      expect(Object.keys(value.gates)).toEqual([...GATE_IDS])
    }
  })

  it('id はファイル名から（前置きの id は使わない）', () => {
    expect(coerceResearchRecord('candidate', { id: 'C999', title: 'x' }, 'C001', NOW).value.id).toBe('C001')
  })

  it('点は 1〜5 の整数だけ。0・6・小数・文字は未採点にして知らせる。点だけの書き方も読む', () => {
    const { value, fixes } = coerceResearchRecord('candidate', {
      scores: { demand: 4, spend: { score: '5', evidence: ['E001', 'E001', 'bad', '../E002'], reason: 'r' }, reach: 0, profit: 6, competition: 2.5, delivery: 'high' }
    }, 'C001', NOW)
    expect(value.scores.demand).toEqual({ score: 4, evidence: [], reason: '' })
    expect(value.scores.spend).toEqual({ score: 5, evidence: ['E001'], reason: 'r' })
    expect([value.scores.reach.score, value.scores.profit.score, value.scores.competition.score, value.scores.delivery.score]).toEqual([null, null, null, null])
    expect(fixes.filter((f) => f.code === 'fixBadScore')).toHaveLength(4)
    expect(fixes.filter((f) => f.code === 'fixBadItem').map((f) => f.params?.value)).toEqual(['bad', '../E002'])
  })

  it('数: 文字の数・円・カンマは読む。NaN・Infinity・巨大値・文字は null。負は残す（検査で止める）', () => {
    const { value, fixes } = coerceResearchRecord('candidate', {
      who: { targetCount: '1,200' },
      what: { quantification: { hoursPerMonth: 'Infinity', hourlyCost: '4000円', reductionRate: 1.5, cashSpendMonthly: 1e13, opportunityMonthly: -5 } },
      how: { monthlyPrice: 'abc', marginRate: '0.8', estimatedCac: null }
    }, 'C001', NOW)
    expect(value.who.targetCount).toBe(1200)
    expect(value.what.quantification).toEqual({ hoursPerMonth: null, hourlyCost: 4000, reductionRate: 1.5, cashSpendMonthly: null, opportunityMonthly: -5 })
    expect(value.how).toMatchObject({ monthlyPrice: null, marginRate: 0.8, estimatedCac: null })
    expect(fixes.filter((f) => f.code === 'fixBadNumber').map((f) => f.field)).toEqual(['what.quantification.hoursPerMonth', 'what.quantification.cashSpendMonthly', 'how.monthlyPrice'])
  })

  it('継続月数: 書いていなければ既定の 6/12/24/36、書いていれば数だけ残す', () => {
    expect(coerceResearchRecord('candidate', {}, 'C001', NOW).value.how.retentionScenarios).toEqual([6, 12, 24, 36])
    expect(coerceResearchRecord('candidate', { how: { retentionScenarios: [12, 'x', 24, null] } }, 'C001', NOW).value.how.retentionScenarios).toEqual([12, 24])
    expect(coerceResearchRecord('candidate', { how: { retentionScenarios: 'abc' } }, 'C001', NOW).value.how.retentionScenarios).toEqual([])
  })

  it('選ぶ値: 知らない値は既定、null にできるものは null', () => {
    const { value, fixes } = coerceResearchRecord('candidate', {
      stage: 'winner', what: { problemType: 'often', demandLevel: 'urgent' },
      where: { channels: [{ channel: 'tv' }, { channel: 'seo', state: 'flying', axes: { reachability: 5, intent: 9 } }], triggers: [{ kind: 'party', url: 'https://x.example' }], keywords: [{ keyword: 'k', intent: 'buy', ads: 'yes', enterable: 'maybe' }] },
      why: { differentiators: ['price', { kind: 'magic' }, { kind: 'data', note: 'n' }] }
    }, 'C001', NOW)
    expect(value.stage).toBe('discovered')
    expect(value.what.problemType).toBe('unknown')
    expect(value.what.demandLevel).toBe('urgent')
    expect(value.where.channels).toEqual([{ channel: 'seo', state: null, axes: { reachability: 5, intent: null, cost: null, repeatability: null, scalability: null }, note: '' }])
    expect(value.where.triggers[0]).toMatchObject({ kind: 'other', url: 'https://x.example' })
    expect(value.where.keywords[0]).toMatchObject({ intent: 'unknown', ads: true, enterable: null })
    expect(value.why.differentiators).toEqual([{ kind: 'price', note: '' }, { kind: 'data', note: 'n' }])
    expect(fixes.length).toBeGreaterThanOrEqual(7)
  })

  it('ゲート: 状態だけの書き方も読む。pending は日時を持たない。知らない状態は pending', () => {
    const { value } = coerceResearchRecord('candidate', { gates: { G1: 'pass', G2: { status: 'fail', note: 'n', at: '2026-10-01T00:00:00Z' }, G3: { status: 'pending', at: 'x' }, G4: 'maybe' } }, 'C001', NOW)
    expect(value.gates.G1).toEqual({ status: 'pass', note: '', at: '' })
    expect(value.gates.G2).toEqual({ status: 'fail', note: 'n', at: '2026-10-01T00:00:00Z' })
    expect(value.gates.G3.at).toBe('')
    expect(value.gates.G4.status).toBe('pending')
  })

  it('一覧の上限: 企業は 1000 件、ほかは 200 件まで', () => {
    const many = Array.from({ length: MAX_COMPANIES + 10 }, (_, i) => ({ company: `c${i}` }))
    const { value, fixes } = coerceResearchRecord('candidate', { who: { companies: many }, existingServices: Array.from({ length: MAX_LIST + 1 }, () => ({ name: 'x' })) }, 'C001', NOW)
    expect(value.who.companies).toHaveLength(MAX_COMPANIES)
    expect(value.existingServices).toHaveLength(MAX_LIST)
    expect(fixes.filter((f) => f.code === 'fixTooMany')).toHaveLength(2)
  })

  it('promotedTo: folder の無いものは外す。YAML が日付にした値は日付の文字に戻す', () => {
    expect(coerceResearchRecord('candidate', { promotedTo: { projectId: 'p' } }, 'C001', NOW).value.promotedTo).toBeNull()
    expect(coerceResearchRecord('candidate', { promotedTo: { folder: '/b', projectId: 'p', at: 'x' } }, 'C001', NOW).value.promotedTo).toEqual({ folder: '/b', projectId: 'p', at: 'x' })
    const e = coerceResearchRecord('evidence', { checkedAt: new Date('2026-10-01T00:00:00Z') }, 'E001', NOW).value
    expect(e.checkedAt).toBe('2026-10-01')
  })

  it('Who の5条件は true / false / null（はい・いいえも読む）', () => {
    const { value } = coerceResearchRecord('candidate', { who: { conditions: { identifiable: true, sharedProblem: 'はい', buyerKnown: 'no', canPay: 'perhaps' } } }, 'C001', NOW)
    expect(value.who.conditions).toEqual({ identifiable: true, sharedProblem: true, buyerKnown: false, canPay: null, repeatableContact: null })
  })
})

describe('coerceResearchRecord: 証拠・実験', () => {
  it('証拠: 候補の ID の形が違えば空。知らない区分は aiInference', () => {
    const { value, fixes } = coerceResearchRecord('evidence', { candidate: '../C001', grade: 'rumor', principle: 'when', url: '  https://a.example  ' }, 'E001', NOW)
    expect(value).toMatchObject({ candidate: '', grade: 'aiInference', principle: 'what', url: 'https://a.example' })
    expect(fixes.map((f) => f.field)).toEqual(['candidate', 'principle', 'grade'])
  })

  it('実験: 数は null を保つ。知らない経路は null', () => {
    const { value } = coerceResearchRecord('experiment', { candidate: 'C001', channel: 'radio', metrics: { targets: 100, contacted: 'x', spend: '200,000' }, interviews: '3' }, 'X001', NOW)
    expect(value.channel).toBeNull()
    expect(value.metrics.targets).toBe(100)
    expect(value.metrics.contacted).toBeNull()
    expect(value.metrics.spend).toBe(200000)
    expect(value.metrics.responded).toBeNull()
    expect(value.interviews).toBe(3)
  })
})

describe('小さな検査', () => {
  it('isIsoDate: 実在する日だけ', () => {
    expect(isIsoDate('2026-02-28')).toBe(true)
    expect(isIsoDate('2024-02-29')).toBe(true)
    for (const bad of ['2026-02-30', '2026-13-01', '2026-1-1', '26-01-01', '', '2026-01-01T00:00:00Z', '2026/01/01']) expect(isIsoDate(bad)).toBe(false)
  })

  it('isWebUrl: http・https とホスト名があるものだけ', () => {
    expect(isWebUrl('https://example.com/a?b=c')).toBe(true)
    expect(isWebUrl('http://localhost:3000')).toBe(true)
    for (const bad of ['', 'example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://x', 'https://a b.com', `https://x.com/${'a'.repeat(2100)}`]) expect(isWebUrl(bad)).toBe(false)
  })
})

describe('validateResearchRecord: 証拠', () => {
  it('よい証拠は問題なし', () => {
    expect(validateResearchRecord('evidence', goodEvidence(), data(), NOW)).toEqual([])
  })

  it('url の形・原文も事実も空・事実と推論が同じ・確認日の形と未来', () => {
    expect(errorCodes(validateResearchRecord('evidence', goodEvidence('E001', { url: 'notaurl' }), data(), NOW))).toEqual(['urlInvalid'])
    expect(errorCodes(validateResearchRecord('evidence', goodEvidence('E001', { quote: ' ', fact: '' }), data(), NOW))).toEqual(['quoteOrFactRequired'])
    expect(errorCodes(validateResearchRecord('evidence', goodEvidence('E001', { fact: '同じ', inference: ' 同じ ' }), data(), NOW))).toEqual(['factSameAsInference'])
    expect(errorCodes(validateResearchRecord('evidence', goodEvidence('E001', { checkedAt: '2026/10/01' }), data(), NOW))).toEqual(['dateInvalid'])
    expect(errorCodes(validateResearchRecord('evidence', goodEvidence('E001', { checkedAt: '' }), data(), NOW))).toEqual(['dateRequired'])
    expect(errorCodes(validateResearchRecord('evidence', goodEvidence('E001', { checkedAt: '2026-10-19' }), data(), NOW))).toEqual(['dateFuture'])
    // 今日は未来ではない。now を渡さなければ未来は見ない
    expect(validateResearchRecord('evidence', goodEvidence('E001', { checkedAt: '2026-10-18' }), data(), NOW)).toEqual([])
    expect(validateResearchRecord('evidence', goodEvidence('E001', { checkedAt: '2099-01-01' }), data())).toEqual([])
  })

  it('強い区分なのに url が無ければ error、中程度以下は warning、AI の推測は見ない', () => {
    expect(codes(validateResearchRecord('evidence', goodEvidence('E001', { url: '' }), data(), NOW))).toEqual(['error:url:urlRequiredForGrade'])
    expect(codes(validateResearchRecord('evidence', goodEvidence('E001', { url: '', grade: 'competitorCase' }), data(), NOW))).toEqual(['error:url:urlRequiredForGrade'])
    expect(codes(validateResearchRecord('evidence', goodEvidence('E001', { url: '', grade: 'snsComplaint' }), data(), NOW))).toEqual(['warning:url:urlRecommended'])
    expect(validateResearchRecord('evidence', goodEvidence('E001', { url: '', grade: 'aiInference' }), data(), NOW)).toEqual([])
  })

  it('知らない候補・ID の形', () => {
    expect(errorCodes(validateResearchRecord('evidence', goodEvidence('E001', { candidate: 'C001' }), data(), NOW))).toEqual(['unknownCandidate'])
    expect(validateResearchRecord('evidence', goodEvidence('E001', { candidate: 'C001' }), data({ candidates: [emptyCandidate('C001', NOW)] }), NOW)).toEqual([])
    expect(errorCodes(validateResearchRecord('evidence', goodEvidence('E1'), data(), NOW))).toEqual(['idInvalid'])
    expect(errorCodes(validateResearchRecord('evidence', goodEvidence('X001'), data(), NOW))).toEqual(['idInvalid'])
  })
})

describe('validateResearchRecord: 候補', () => {
  const titled = (over: (c: Candidate) => void = () => undefined): Candidate => {
    const c = emptyCandidate('C001', NOW)
    c.title = '経理の証憑回収'
    c.scene = { company: '従業員20〜100人の会社', who: '経理担当', event: '月末の締め', outcome: '証憑を期限内に集め終える', currentHandling: 'メールで催促' }
    over(c)
    return c
  }

  it('空の候補は題名だけが要る', () => {
    expect(errorCodes(validateResearchRecord('candidate', emptyCandidate('C001', NOW), data(), NOW))).toEqual(['titleRequired'])
    expect(validateResearchRecord('candidate', titled(), data(), NOW)).toEqual([])
  })

  it('負・整数でない・率の外', () => {
    const issues = validateResearchRecord('candidate', titled((c) => {
      c.who.targetCount = -1
      c.who.companies = [{ ...emptyCompany(), employees: 2.5 }]
      c.what.quantification.reductionRate = 1.01
      c.what.quantification.hoursPerMonth = -0.1
      c.how.marginRate = -0.2
      c.how.monthlyPrice = -1
      c.where.keywords = [{ keyword: 'k', volume: -10, intent: 'info', competitors: '', ads: null, enterable: null }]
      c.why.switching.adoptionCost = -100
    }), data(), NOW)
    expect(codes(issues)).toEqual([
      'error:who.targetCount:negative',
      'error:who.companies[0].employees:notInteger',
      'error:what.quantification.hoursPerMonth:negative',
      'error:what.quantification.reductionRate:rateOutOfRange',
      'error:where.keywords[0].volume:negative',
      'error:why.switching.adoptionCost:negative',
      'error:how.monthlyPrice:negative',
      'error:how.marginRate:rateOutOfRange'
    ])
  })

  it('率の境界: 0 と 1 は通る', () => {
    expect(validateResearchRecord('candidate', titled((c) => { c.how.marginRate = 0; c.what.quantification.reductionRate = 1 }), data(), NOW)).toEqual([])
  })

  it('継続月数: 0・負・小数・上限超え・重複は error、1 と上限は通る', () => {
    const issues = validateResearchRecord('candidate', titled((c) => { c.how.retentionScenarios = [0, -6, 1.5, MAX_RETENTION_MONTHS + 1, 12, 12, 1, MAX_RETENTION_MONTHS] }), data(), NOW)
    expect(codes(issues)).toEqual([
      'error:how.retentionScenarios[0]:retentionInvalid',
      'error:how.retentionScenarios[1]:retentionInvalid',
      'error:how.retentionScenarios[2]:retentionInvalid',
      'error:how.retentionScenarios[3]:retentionInvalid',
      'error:how.retentionScenarios[5]:retentionDuplicate'
    ])
  })

  it('点に根拠が無ければ warning、知らない証拠 ID は error', () => {
    const d = data({ evidence: [goodEvidence('E001')] })
    const issues = validateResearchRecord('candidate', titled((c) => {
      c.scores.demand = { score: 4, evidence: [], reason: '' }
      c.scores.reach = { score: 3, evidence: ['E001'], reason: '' }
      c.scores.spend = { score: 5, evidence: ['E404'], reason: '' }
      c.why.reasonEvidence = ['E001', 'E777']
    }), d, NOW)
    expect(codes(issues)).toEqual([
      'error:why.reasonEvidence:unknownEvidence',
      'warning:scores.demand.evidence:scoreUnbacked',
      'error:scores.spend.evidence:unknownEvidence'
    ])
    expect(hasResearchErrors(issues)).toBe(true)
    expect(hasResearchErrors(issues.filter((i) => i.level === 'warning'))).toBe(false)
  })

  it('url・日付の形、除外の理由、事実と推測が同じ企業', () => {
    const issues = validateResearchRecord('candidate', titled((c) => {
      c.existingServices = [{ name: 'x', url: 'x.com', price: '' }]
      c.who.companies = [{ ...emptyCompany(), evidenceUrl: 'mailto:a@b', situation: '営業を募集', inferredProblem: '営業を募集' }]
      c.where.triggers = [{ kind: 'salesHiring', company: 'A', url: 'https://a.example', observedAt: '2026-12-01', note: '' }]
      c.stage = 'dropped'
      c.dropReason = ' '
    }), data(), NOW)
    expect(codes(issues)).toEqual([
      'error:existingServices[0].url:urlInvalid',
      'error:who.companies[0].evidenceUrl:urlInvalid',
      'warning:who.companies[0].inferredProblem:factSameAsInference',
      'error:where.triggers[0].observedAt:dateFuture',
      'error:dropReason:dropReasonRequired'
    ])
  })
})

describe('validateResearchRecord: 実験', () => {
  const x = (over: Partial<ResearchExperiment> = {}): ResearchExperiment => ({ ...emptyExperiment('X001'), candidate: 'C001', passCondition: '10社中2社が申し込む', stopCondition: '20万円使って0件', ...over })
  const d = data({ candidates: [emptyCandidate('C001', NOW)] })

  it('よい実験は問題なし', () => {
    expect(validateResearchRecord('experiment', x(), d, NOW)).toEqual([])
  })

  it('候補が要る・知らない候補', () => {
    expect(errorCodes(validateResearchRecord('experiment', x({ candidate: '' }), d, NOW))).toEqual(['candidateRequired'])
    expect(errorCodes(validateResearchRecord('experiment', x({ candidate: 'C002' }), d, NOW))).toEqual(['unknownCandidate'])
  })

  it('合格・中止の条件: 計画中なら warning、実施中・完了なら error', () => {
    expect(codes(validateResearchRecord('experiment', x({ passCondition: '', stopCondition: '' }), d, NOW))).toEqual(['warning:passCondition:conditionMissing', 'warning:stopCondition:conditionMissing'])
    expect(codes(validateResearchRecord('experiment', x({ status: 'running', stopCondition: '' }), d, NOW))).toEqual(['error:stopCondition:conditionRequired'])
  })

  it('期間の逆転・形、数の負と小数、計画中の実測', () => {
    const m = { ...emptyExperiment('X001').metrics, targets: 100, contacted: -1, responded: 2.5, spend: 1234.5 }
    expect(codes(validateResearchRecord('experiment', x({ period: { start: '2026-10-10', end: '2026-10-01' }, metrics: m, interviews: -2 }), d, NOW))).toEqual([
      'error:period:periodReversed',
      'error:metrics.contacted:negative',
      'error:metrics.responded:notInteger',
      'warning:metrics:metricsBeforeStart',
      'error:interviews:negative'
    ])
    expect(errorCodes(validateResearchRecord('experiment', x({ period: { start: 'tomorrow', end: '' } }), d, NOW))).toEqual(['dateInvalid'])
    // 対象の数だけなら計画中でもよい
    expect(validateResearchRecord('experiment', x({ metrics: { ...emptyExperiment('X001').metrics, targets: 100 } }), d, NOW)).toEqual([])
  })
})

describe('文言', () => {
  it('検査・直しの code はすべて research.issue.<code> の文が日英にある', () => {
    const found = new Set<string>()
    const c = emptyCandidate('C001', NOW)
    c.stage = 'dropped'
    c.how.retentionScenarios = [0, 12, 12]
    c.how.marginRate = 2
    c.who.targetCount = 1.5
    c.scores.demand = { score: 3, evidence: ['E404'], reason: '' }
    c.scores.reach = { score: 3, evidence: [], reason: '' }
    c.existingServices = [{ name: '', url: 'bad', price: '' }]
    c.where.triggers = [{ kind: 'other', company: '', url: '', observedAt: 'bad', note: '' }]
    const all = [
      ...validateResearchRecord('candidate', c, data(), NOW),
      ...validateResearchRecord('evidence', goodEvidence('E1', { candidate: 'C404', url: '', checkedAt: '2099-01-01', fact: 'a', inference: 'a' }), data(), NOW),
      ...validateResearchRecord('evidence', goodEvidence('E001', { grade: 'snsComplaint', url: '', quote: '', fact: '' }), data(), NOW),
      ...validateResearchRecord('experiment', { ...emptyExperiment('X001'), status: 'done', period: { start: '2026-10-05', end: '2026-10-01' } }, data(), NOW),
      ...validateResearchRecord('experiment', { ...emptyExperiment('X001'), candidate: 'C404', metrics: { ...emptyExperiment('X001').metrics, contacted: -1 } }, data(), NOW)
    ]
    for (const i of all) found.add(i.code)
    const fixes = [
      ...coerceResearchRecord('candidate', { title: 1, market: {}, scores: { demand: 9, spend: { evidence: 'bad' } }, stage: 'x', what: { demandLevel: 'x' }, how: { monthlyPrice: 'x', retentionScenarios: 'x' }, who: { conditions: { canPay: 'x' } }, existingServices: 'x', where: { channels: [{ channel: 'tv' }] }, promotedTo: { x: 1 }, aiFit: 'a'.repeat(MAX_TEXT + 1) }, 'C001', NOW).fixes,
      ...coerceResearch({ weights: { demand: 200 }, cutoffs: [], minTargetCount: 0 }, 'x', NOW).fixes,
      ...coerceResearchRecord('candidate', { who: { companies: Array.from({ length: MAX_COMPANIES + 1 }, () => ({})) } }, 'C001', NOW).fixes
    ]
    for (const f of fixes) found.add(f.code)
    expect(found.size).toBeGreaterThan(25)
    for (const code of found) {
      expect(researchMainEn, code).toHaveProperty([`research.issue.${code}`])
      expect(researchMainJa, code).toHaveProperty([`research.issue.${code}`])
    }
  })

  it('日英のキーがそろい、差し込む名前が同じ', () => {
    expect(Object.keys(researchMainJa).sort()).toEqual(Object.keys(researchMainEn).sort())
    const vars = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()
    for (const [k, en] of Object.entries(researchMainEn)) expect(vars(researchMainJa[k as keyof typeof researchMainEn]), k).toEqual(vars(en))
  })
})

function emptyCompany() {
  return { company: 'A', industry: '', employees: null, situation: '', inferredProblem: '', evidenceUrl: '', buyerRole: '', reachPath: '' }
}
