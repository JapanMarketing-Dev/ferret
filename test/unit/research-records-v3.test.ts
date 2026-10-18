import { describe, expect, it } from 'vitest'
import { coerceExecution, coerceResearchRecord, emptyCandidate, emptyEvidence, emptyResearch, validateResearchRecord } from '@shared/research/records'
import type { Candidate, ResearchData, ResearchEvidence } from '@shared/research/model'
import type { ResearchIssue } from '@shared/research/ipc'
import { researchMainEn } from '@shared/research/messages/main.en'
import { researchMainJa } from '@shared/research/messages/main.ja'

const NOW = '2026-10-18T03:00:00.000Z'

function data(over: Partial<ResearchData> = {}): ResearchData {
  return { root: '/r', research: emptyResearch('r', NOW), candidates: [], evidence: [], experiments: [], problems: [], ...over }
}
function goodEvidence(id = 'E001', over: Partial<ResearchEvidence> = {}): ResearchEvidence {
  return { ...emptyEvidence(id, NOW), grade: 'contract', kind: 'spend', url: 'https://example.com/a', quote: '月額3万円で契約', fact: '契約がある', inference: '支払意思がある', ...over }
}
const codes = (issues: ResearchIssue[]) => issues.map((i) => `${i.level}:${i.field}:${i.code}`)
const errorCodes = (issues: ResearchIssue[]) => issues.filter((i) => i.level === 'error').map((i) => i.code)
const scened = (over: (c: Candidate) => void = () => undefined): Candidate => {
  const c = emptyCandidate('C001', NOW)
  c.title = 't'
  c.scene = { company: 'a', who: 'b', event: 'c', outcome: 'd', currentHandling: 'e' }
  over(c)
  return c
}

describe('空の形', () => {
  it('場面は空、成立条件は5つ unverified、役割4つ、有料化率は 0.5%/2%/5%、実行条件4点、次の行動は null', () => {
    const c = emptyCandidate('C001', NOW)
    expect(c.scene).toEqual({ company: '', who: '', event: '', outcome: '', currentHandling: '' })
    expect(Object.keys(c.conditions)).toEqual(['problemStrong', 'targetAndScene', 'reasonToSwitch', 'reachable', 'revenue'])
    expect(Object.values(c.conditions).every((r) => r.status === 'unverified' && r.support.length === 0 && r.counter.length === 0)).toBe(true)
    expect(Object.keys(c.roles)).toEqual(['user', 'champion', 'budgetOwner', 'gatekeeper'])
    expect(c.monetization).toMatchObject({ side: 'unknown', orderScene: 'unknown', months: null, marginPerDeal: null, costPerFreeUser: null, conversionScenarios: [0.005, 0.02, 0.05] })
    expect(c.execution).toEqual({ firstDeal: { plan: '', confirmed: false }, supply: { plan: '', confirmed: false }, firstExperiment: { plan: '', confirmed: false }, profitOps: { plan: '', confirmed: false } })
    expect(c.decision).toBeNull()
    // 共有しない
    emptyCandidate('C002', NOW).monetization.conversionScenarios.push(1)
    expect(emptyCandidate('C003', NOW).monetization.conversionScenarios).toEqual([0.005, 0.02, 0.05])
    const e = emptyEvidence('E001', NOW)
    expect(e).toMatchObject({ state: 'collected', behaviorLevel: 'unknown', eventDate: '', publishedAt: '', dupGroup: '', counter: '', unknowns: '', subject: '', publisher: '' })
    expect(Object.values(e.reading).every((v) => v === null)).toBe(true)
  })
})

describe('古い形の記録', () => {
  it('新しい欄が無くても直しの知らせなしで読め、新しい欄は既定になる', () => {
    const oldCandidate = { title: '古い候補', stage: 'evidenced', who: { targetCount: 120 }, scores: { demand: { score: 4, evidence: ['E001'] } }, gates: { G1: 'pass' } }
    const c = coerceResearchRecord('candidate', oldCandidate, 'C001', NOW)
    expect(c.fixes).toEqual([])
    expect(c.value).toMatchObject({ title: '古い候補', stage: 'evidenced', decision: null, deliverable: '' })
    expect(c.value.scene).toEqual(emptyCandidate('C001', NOW).scene)
    expect(c.value.conditions).toEqual(emptyCandidate('C001', NOW).conditions)
    expect(c.value.monetization.conversionScenarios).toEqual([0.005, 0.02, 0.05])
    const oldEvidence = { candidate: 'C001', principle: 'what', kind: 'spend', grade: 'contract', url: 'https://a.example', quote: 'q', checkedAt: '2026-10-01', source: 's', fact: 'f', inference: 'i' }
    const e = coerceResearchRecord('evidence', oldEvidence, 'E001', NOW)
    expect(e.fixes).toEqual([])
    expect(e.value).toMatchObject({ ...oldEvidence, state: 'collected', behaviorLevel: 'unknown', subject: '', eventDate: '' })
    // 古い形でも検査は通る（場面が無いことは warning だけ）
    expect(errorCodes(validateResearchRecord('candidate', c.value, data({ evidence: [goodEvidence('E001')] }), NOW))).toEqual([])
    expect(validateResearchRecord('evidence', e.value, data({ candidates: [c.value] }), NOW)).toEqual([])
  })

  it('古い今動く理由（salesHiring など）も新しい種類（contractRenewal など）も読む', () => {
    const { value, fixes } = coerceResearchRecord('candidate', { where: { triggers: [{ kind: 'salesHiring' }, { kind: 'contractRenewal' }, { kind: 'staffShortage' }] } }, 'C001', NOW)
    expect(value.where.triggers.map((t) => t.kind)).toEqual(['salesHiring', 'contractRenewal', 'staffShortage'])
    expect(fixes).toEqual([])
  })
})

describe('型の違う新しい欄', () => {
  it('既定に寄せて知らせる', () => {
    const { value, fixes } = coerceResearchRecord('candidate', {
      scene: 'まとめて一文', conditions: { problemStrong: { support: ['E001', 'bad'], counter: 'E002, E003', status: 'proven' }, revenue: 'x' },
      roles: { user: '経理担当', budgetOwner: { title: '部長', confirmedAuthority: '', evidence: ['E9'] } },
      monetization: { side: 'everyone', orderScene: 'afterOrder', months: '12', marginPerDeal: '300,000', costPerFreeUser: 'abc', conversionScenarios: [0.02, 'x', '5%'] },
      execution: { supply: '誰が提供するか', firstDeal: { plan: 'p', confirmed: 'yes' }, profitOps: { confirmed: 'maybe' } },
      decision: 'buy', deliverable: 42
    }, 'C001', NOW)
    expect(value.scene).toEqual(emptyCandidate('C001', NOW).scene)
    expect(value.conditions.problemStrong).toMatchObject({ support: ['E001'], counter: ['E002', 'E003'], status: 'unverified' })
    expect(value.conditions.revenue).toEqual(emptyCandidate('C001', NOW).conditions.revenue)
    expect(value.roles.user).toEqual({ title: '経理担当', confirmedAuthority: '', evidence: [] })
    expect(value.roles.budgetOwner.evidence).toEqual([])
    // '5%' は数として 5 と読み、検査（0〜1）で止める
    expect(value.monetization).toMatchObject({ side: 'unknown', orderScene: 'afterOrder', months: 12, marginPerDeal: 300000, costPerFreeUser: null, conversionScenarios: [0.02, 5] })
    expect(value.execution.supply).toEqual({ plan: '誰が提供するか', confirmed: false })
    expect(value.execution.firstDeal).toEqual({ plan: 'p', confirmed: true })
    expect(value.execution.profitOps.confirmed).toBe(false)
    expect(value.decision).toBeNull()
    expect(value.deliverable).toBe('42')
    const fields = fixes.map((f) => `${f.field}:${f.code}`)
    for (const f of [
      'scene:fixNotObject', 'conditions.problemStrong.support:fixBadItem', 'conditions.problemStrong.status:fixBadChoice', 'conditions.revenue:fixNotObject',
      'roles.budgetOwner.evidence:fixBadItem', 'monetization.side:fixBadChoice', 'monetization.costPerFreeUser:fixBadNumber',
      'monetization.conversionScenarios[1]:fixBadNumber', 'execution.profitOps.confirmed:fixBadBool', 'decision:fixBadChoiceNull'
    ]) expect(fields).toContain(f)
  })

  it('有料化率: 書いていなければ既定、一覧でなければ空', () => {
    expect(coerceResearchRecord('candidate', { monetization: {} }, 'C001', NOW).value.monetization.conversionScenarios).toEqual([0.005, 0.02, 0.05])
    expect(coerceResearchRecord('candidate', { monetization: { conversionScenarios: 'x' } }, 'C001', NOW).value.monetization.conversionScenarios).toEqual([])
  })

  it('次の行動は4つのどれか', () => {
    for (const d of ['continue', 'experiment', 'holdOrDrop', 'invest'] as const) expect(coerceResearchRecord('candidate', { decision: d }, 'C001', NOW).value.decision).toBe(d)
  })

  it('証拠: 知らない値は既定、読む5観点は ok/weak/ng/null だけ、転載のまとまりは 200 文字まで', () => {
    const { value, fixes } = coerceResearchRecord('evidence', {
      behaviorLevel: 'love', state: 'done', reading: { match: 'ok', timing: 'ng', specificity: 'bad', independence: null, selectionBias: 'weak' },
      dupGroup: `  ${'g'.repeat(300)} `, eventDate: new Date('2014-05-01T00:00:00Z'), publisher: '販売者'
    }, 'E001', NOW)
    expect(value.behaviorLevel).toBe('unknown')
    expect(value.state).toBe('collected')
    expect(value.reading).toEqual({ match: 'ok', specificity: null, timing: 'ng', independence: null, selectionBias: 'weak' })
    expect(value.dupGroup).toHaveLength(200)
    expect(value.eventDate).toBe('2014-05-01')
    expect(value.publisher).toBe('販売者')
    expect(fixes.map((f) => f.field)).toEqual(['behaviorLevel', 'state', 'reading.specificity'])
    expect(coerceResearchRecord('evidence', { state: 'evaluated', behaviorLevel: 'payment' }, 'E001', NOW).value).toMatchObject({ state: 'evaluated', behaviorLevel: 'payment' })
  })

  it('coerceExecution: 決める内容だけの書き方も読む。知らない項目は無視', () => {
    const { value, fixes } = coerceExecution({ supply: '供給', firstDeal: { plan: 3, confirmed: true }, other: 'x' })
    expect(value.supply).toEqual({ plan: '供給', confirmed: false })
    expect(value.firstDeal).toEqual({ plan: '3', confirmed: true })
    expect(value.profitOps).toEqual({ plan: '', confirmed: false })
    expect(fixes).toEqual([])
    expect(coerceExecution([]).fixes[0]?.code).toBe('fixNotObject')
    expect(coerceExecution(undefined).value.firstExperiment).toEqual({ plan: '', confirmed: false })
  })
})

describe('検査', () => {
  it('購買が起きる場面が空・書きかけなら warning（保存はできる）', () => {
    expect(codes(validateResearchRecord('candidate', scened((c) => { c.scene = emptyCandidate('C001', NOW).scene }), data(), NOW))).toEqual(['warning:scene:sceneMissing'])
    const partial = validateResearchRecord('candidate', scened((c) => { c.scene.event = ' '; c.scene.currentHandling = '' }), data(), NOW)
    expect(partial).toEqual([{ level: 'warning', field: 'scene', code: 'sceneMissing', params: { fields: 'event, currentHandling' } }])
    expect(validateResearchRecord('candidate', scened(), data(), NOW)).toEqual([])
  })

  it('成立条件・役割: 知らない証拠は error、同じ証拠を支持と反証の両方に置くと warning', () => {
    const d = data({ evidence: [goodEvidence('E001'), goodEvidence('E002')] })
    const issues = validateResearchRecord('candidate', scened((c) => {
      c.conditions.problemStrong = { ...c.conditions.problemStrong, support: ['E001', 'E002'], counter: ['E002', 'E404'] }
      c.conditions.revenue = { ...c.conditions.revenue, support: ['E777'] }
      c.roles.budgetOwner = { title: '部長', confirmedAuthority: '', evidence: ['E001', 'E888'] }
    }), d, NOW)
    expect(codes(issues)).toEqual([
      'error:conditions.problemStrong.counter:unknownEvidence',
      'warning:conditions.problemStrong:evidenceBothSides',
      'error:conditions.revenue.support:unknownEvidence',
      'error:roles.budgetOwner.evidence:unknownEvidence'
    ])
    expect(issues[1]!.params).toEqual({ id: 'E002' })
    expect(validateResearchRecord('candidate', scened((c) => { c.conditions.reachable.support = ['E001']; c.conditions.reachable.counter = ['E002'] }), d, NOW)).toEqual([])
  })

  it('収益のつながり: 期間・限界利益・費用の負は error、有料化率は 0〜1（境界は通る）、重複は warning', () => {
    const issues = validateResearchRecord('candidate', scened((c) => {
      c.monetization = { ...c.monetization, months: -1, marginPerDeal: -300000, costPerFreeUser: -1, conversionScenarios: [0, 1, 1.01, -0.01, 0.02, 0.02] }
    }), data(), NOW)
    expect(codes(issues)).toEqual([
      'error:monetization.months:negative',
      'error:monetization.marginPerDeal:negative',
      'error:monetization.costPerFreeUser:negative',
      'error:monetization.conversionScenarios[2]:rateOutOfRange',
      'error:monetization.conversionScenarios[3]:rateOutOfRange',
      'warning:monetization.conversionScenarios[5]:scenarioDuplicate'
    ])
    expect(validateResearchRecord('candidate', scened((c) => { c.monetization.months = 0; c.monetization.costPerFreeUser = 0; c.monetization.conversionScenarios = [] }), data(), NOW)).toEqual([])
  })

  it('証拠の日付: 形と未来は error、掲載日が出来事より前は warning。評価済みで5観点が空は warning', () => {
    const ev = (over: Partial<ResearchEvidence>) => validateResearchRecord('evidence', goodEvidence('E001', over), data(), NOW)
    expect(codes(ev({ eventDate: '2014/05/01' }))).toEqual(['error:eventDate:dateInvalid'])
    expect(codes(ev({ eventDate: '2014-02-30' }))).toEqual(['error:eventDate:dateInvalid'])
    expect(codes(ev({ publishedAt: '2026-10-19' }))).toEqual(['error:publishedAt:dateFuture'])
    expect(codes(ev({ eventDate: '2023-04-01', publishedAt: '2014-01-01' }))).toEqual(['warning:publishedAt:publishedBeforeEvent'])
    // 2014 年公開・2023 年更新の過去事例: 出来事が前、掲載・更新が後
    expect(ev({ eventDate: '2014-01-01', publishedAt: '2023-04-01' })).toEqual([])
    expect(ev({ eventDate: '2026-10-18', publishedAt: '2026-10-18' })).toEqual([])
    expect(codes(ev({ state: 'evaluated' }))).toEqual(['warning:reading:readingMissing'])
    expect(ev({ state: 'evaluated', reading: { match: 'ok', specificity: null, timing: null, independence: null, selectionBias: null } })).toEqual([])
  })

  it('新しい検査の code にも日英の文がある', () => {
    for (const code of ['sceneMissing', 'evidenceBothSides', 'scenarioDuplicate', 'publishedBeforeEvent', 'readingMissing']) {
      expect(researchMainEn).toHaveProperty([`research.issue.${code}`])
      expect(researchMainJa).toHaveProperty([`research.issue.${code}`])
    }
  })
})
