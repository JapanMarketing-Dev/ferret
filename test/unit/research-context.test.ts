/**
 * context.md（記録の生の値: 段階・人のゲート・点数・空いている欄・次にすること）と README.md（記録の形式）
 */
import { describe, expect, it } from 'vitest'
import {
  CONTEXT_DETAIL_LIMIT,
  CONTEXT_INDEX_LIMIT,
  README_FIELD_PATHS,
  candidateGaps,
  contextOrder,
  decisionHint,
  exitItems,
  firstOpenGate,
  nextAction,
  nextIdOrLimit,
  researchContextMarkdown,
  researchReadme,
  sceneText,
  type GapGroup
} from '@shared/research/context'
import type { Candidate } from '@shared/research/model'
import { NOW, blankCandidate, blankScene, conditions, emptyData, execution, fullCandidate, fullData, fullEvidence, fullExperiment, gates, metrics, roles, scene } from './research-fixtures'

const fields = (gaps: Record<GapGroup, Array<{ field: string }>>, g: GapGroup) => gaps[g].map((x) => x.field)

describe('candidateGaps（空いている欄）', () => {
  it('何も調べていない候補は、5原則と採点のすべてに空きがある', () => {
    const gaps = candidateGaps(blankCandidate('C001'), emptyData())
    for (const g of ['who', 'what', 'where', 'why', 'how', 'scores'] as const) expect(gaps[g].length).toBeGreaterThan(0)
    expect(fields(gaps, 'who')).toContain('who.segment.attribute')
    expect(fields(gaps, 'who')).toContain('who.companies')
    expect(fields(gaps, 'scores')).toEqual(['scores.demand', 'scores.spend', 'scores.reach', 'scores.profit', 'scores.competition', 'scores.delivery'])
  })

  it('who.conditions は人が埋める欄として印が付く', () => {
    const gaps = candidateGaps(blankCandidate('C001'), emptyData())
    const human = gaps.who.filter((x) => x.human).map((x) => x.field)
    expect(human).toEqual(['who.conditions.identifiable', 'who.conditions.sharedProblem', 'who.conditions.buyerKnown', 'who.conditions.canPay', 'who.conditions.repeatableContact'])
    expect(gaps.what.every((x) => !x.human)).toBe(true)
  })

  it('全欄を埋めた候補（根拠の証拠もある）は空きが無い', () => {
    const data = fullData()
    const gaps = candidateGaps(data.candidates[0]!, data)
    for (const g of ['who', 'what', 'where', 'why', 'how', 'scores'] as const) expect(gaps[g]).toEqual([])
  })

  it('targetCount だけでも企業リストの空きにはならない（0 社も「数えた」とみなす）', () => {
    const c = blankCandidate('C001')
    c.who.targetCount = 0
    expect(fields(candidateGaps(c, emptyData()), 'who')).not.toContain('who.companies')
  })

  it('企業の証拠 URL・購買担当・到達経路が1社でも空なら出す', () => {
    const c = fullCandidate('C001')
    c.who.companies[2] = { ...c.who.companies[2]!, evidenceUrl: ' ', buyerRole: '', reachPath: '' }
    const f = fields(candidateGaps(c, fullData()), 'who')
    expect(f).toEqual(expect.arrayContaining(['who.companies[].evidenceUrl', 'who.companies[].buyerRole', 'who.companies[].reachPath']))
  })

  it('支出の証拠・不満の証拠が無ければ What の空きに出す（他の候補の証拠は数えない）', () => {
    const data = fullData({ evidence: [fullEvidence('E001', { candidate: 'C002' })] })
    const f = fields(candidateGaps(data.candidates[0]!, data), 'what')
    expect(f.some((x) => x.startsWith('evidence(grade: contract'))).toBe(true)
    expect(f.some((x) => x.startsWith('evidence(grade: reviewComplaint'))).toBe(true)
  })

  it('AI の推測だけでは支出の証拠にならない', () => {
    const data = fullData({ evidence: [fullEvidence('E001', { grade: 'aiInference' })] })
    expect(fields(candidateGaps(data.candidates[0]!, data), 'what').some((x) => x.includes('contract'))).toBe(true)
  })

  it('点はあるが根拠が無い・知らない証拠を指す採点を出す', () => {
    const c = fullCandidate('C001')
    c.scores.demand = { score: 5, evidence: [], reason: '' }
    c.scores.reach = { score: 3, evidence: ['E999'], reason: '' }
    const f = fields(candidateGaps(c, fullData()), 'scores')
    expect(f).toEqual(['scores.demand.evidence', 'scores.reach.evidence(unknown id)'])
  })

  it('経路の状態と5軸の空きを経路ごとに出す', () => {
    const c = fullCandidate('C001')
    c.where.channels[0] = { ...c.where.channels[0]!, state: null, axes: { reachability: null, intent: 3, cost: null, repeatability: 4, scalability: 3 } }
    const f = fields(candidateGaps(c, fullData()), 'where')
    expect(f).toEqual(['where.channels[outreach].state', 'where.channels[outreach].axes.reachability|cost'])
  })

  it.each([
    [[], true],
    [[12], true],
    [[12, 12], true],
    [[0, -6], true],
    [[Number.NaN, 12], true],
    [[Number.POSITIVE_INFINITY, 12], true],
    [[6, 12], false]
  ])('継続月数の仮定 %j は2つ以上の正の値が要る → 空き %s', (scenarios, gap) => {
    const c = fullCandidate('C001')
    c.how.retentionScenarios = scenarios
    expect(fields(candidateGaps(c, fullData()), 'how').includes('how.retentionScenarios')).toBe(gap)
  })

  it('選ばれる理由の裏付けが知らない ID なら出す', () => {
    const c = fullCandidate('C001')
    c.why.reasonEvidence = ['E404']
    expect(fields(candidateGaps(c, fullData()), 'why')).toEqual(['why.reasonEvidence(unknown id)'])
  })

  it('乗り換えの値の 0 は埋まっている（null だけが空き）', () => {
    const c = fullCandidate('C001')
    c.why.switching = { expectedValue: 0, adoptionCost: 0, switchingRisk: 0, statusQuoValue: 0, coexists: false }
    expect(fields(candidateGaps(c, fullData()), 'why')).toEqual([])
  })
})

describe('firstOpenGate・nextAction（次にすること）', () => {
  const withGates = (c: Candidate, passed: number) => ({ ...c, gates: gates(Object.fromEntries(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'].slice(0, passed).map((g) => [g, 'pass']))) })

  it('前から順に、pass でない最初のゲート（fail も開いたまま）', () => {
    expect(firstOpenGate(blankCandidate('C001'))).toBe('G1')
    expect(firstOpenGate(withGates(blankCandidate('C001'), 2))).toBe('G3')
    expect(firstOpenGate({ ...blankCandidate('C001'), gates: gates({ G1: 'fail', G2: 'pass' }) })).toBe('G1')
    expect(firstOpenGate(withGates(blankCandidate('C001'), 7))).toBeNull()
  })

  it('除外した候補は何もしない', () => {
    expect(nextAction(blankCandidate('C001', { stage: 'dropped' }), emptyData())).toEqual({ gate: null, prompt: null, human: false })
  })

  it('G1 の材料が足りなければ who を頼む', () => {
    expect(nextAction(blankCandidate('C001'), emptyData())).toEqual({ gate: 'G1', prompt: 'who', human: false })
  })

  it('人だけの欄しか空いていなければ、人がゲートを判定する番', () => {
    const data = fullData()
    const c = data.candidates[0]!
    c.who.conditions.canPay = null
    expect(nextAction(c, data)).toEqual({ gate: 'G1', prompt: null, human: true })
  })

  it('G1 が pass で What が空なら what、G2 まで pass なら where', () => {
    expect(nextAction(withGates(blankCandidate('C001'), 1), emptyData()).prompt).toBe('what')
    expect(nextAction(withGates(blankCandidate('C001'), 2), emptyData()).prompt).toBe('where')
  })

  it('G3 まで pass: why → ranking → experiment の順', () => {
    const data = fullData()
    const c = withGates(data.candidates[0]!, 3)
    expect(nextAction({ ...c, why: { ...c.why, reason: '' } }, data)).toEqual({ gate: 'G4', prompt: 'why', human: false })
    expect(nextAction({ ...c, scores: { ...c.scores, profit: { score: null, evidence: [], reason: '' } } }, data).prompt).toBe('ranking')
    expect(nextAction({ ...c, how: { ...c.how, cacBasis: '' } }, data).prompt).toBe('ranking')
    expect(nextAction(c, data)).toEqual({ gate: 'G4', prompt: 'experiment', human: false })
  })

  it('計画中・実施中の実験があれば人が進める番、学びの無い終わった実験があれば learning', () => {
    const base = fullData()
    const c = withGates(base.candidates[0]!, 3)
    expect(nextAction(c, { ...base, experiments: [fullExperiment('X001', { status: 'planned' })] })).toEqual({ gate: 'G4', prompt: null, human: true })
    expect(nextAction(c, { ...base, experiments: [fullExperiment('X001', { status: 'stopped', learning: '  ' })] }).prompt).toBe('learning')
    expect(nextAction(c, { ...base, experiments: [fullExperiment('X001', { candidate: 'C009', learning: '' })] }).prompt).toBe('experiment')
  })

  it('G1〜G7 がすべて pass なら頼むことは無い', () => {
    const data = fullData()
    expect(nextAction(withGates(data.candidates[0]!, 7), { ...data, experiments: [fullExperiment('X001')] })).toEqual({ gate: null, prompt: null, human: false })
  })
})

describe('nextIdOrLimit', () => {
  it('次の空き番号。上限なら作らせない文', () => {
    expect(nextIdOrLimit('evidence', [], 'ja')).toBe('E001')
    expect(nextIdOrLimit('evidence', ['E001', 'E041', 'X999'], 'ja')).toBe('E042')
    expect(nextIdOrLimit('evidence', ['E9999'], 'ja')).toContain('上限')
    expect(nextIdOrLimit('experiment', ['X9999'], 'en')).toContain('limit')
  })
})

describe('contextOrder', () => {
  it('実験中 → 選定 → 経路明確 → 証拠あり → 発見 → 除外、同じ段階は更新が新しい順、同じなら ID 順', () => {
    const list = [
      blankCandidate('C001', { stage: 'discovered', updatedAt: '2026-10-01T00:00:00Z' }),
      blankCandidate('C002', { stage: 'dropped' }),
      blankCandidate('C003', { stage: 'testing' }),
      blankCandidate('C004', { stage: 'discovered', updatedAt: '2026-10-05T00:00:00Z' }),
      blankCandidate('C006', { stage: 'evidenced' }),
      blankCandidate('C005', { stage: 'evidenced' }),
      blankCandidate('C007', { stage: 'selected' })
    ]
    expect(contextOrder(list).map((c) => c.id)).toEqual(['C003', 'C007', 'C005', 'C006', 'C004', 'C001', 'C002'])
    expect(list[0]!.id).toBe('C001')
  })
})

describe('researchContextMarkdown', () => {
  it('候補ごとに段階・人のゲート・点数と根拠・次にすること・ファイル', () => {
    const data = fullData({ experiments: [fullExperiment('X001')] })
    data.candidates[0]!.gates = gates({ G1: 'pass', G2: 'fail' })
    const md = researchContextMarkdown(data, NOW, 'ja')
    expect(md).toContain('# いまの状況（テストのリサーチ）')
    expect(md).toContain(`更新: ${NOW}`)
    expect(md).toContain('### C001 営業リストの自動作成')
    expect(md).toContain('qualified（経路と提供が明確）')
    expect(md).toContain('G1 pass / G2 fail / G3 pending')
    expect(md).toContain('demand 4（E001）')
    expect(md).toContain('contract 1, reviewComplaint 1')
    expect(md).toContain('X001 done')
    expect(md).toContain('候補 C002, 証拠 E003, 実験 X002')
    expect(md).toContain('candidates/C001.md')
    expect(md).toContain('principles/knowledge.md')
    expect(md).toContain('.research/README.md')
    expect(md).toContain('求人直後の企業は返信が早い')
  })

  it('空いている欄を原則ごとに書き、人の欄に印を付ける', () => {
    const md = researchContextMarkdown(emptyData({ candidates: [blankCandidate('C001')] }), NOW, 'ja')
    expect(md).toContain('空いている欄')
    expect(md).toContain('who.segment.attribute')
    expect(md).toContain('who.conditions.canPay（人）')
    expect(md).toContain('1 顧客・企業の発見（Who）（G1 の材料）')
  })

  it('根拠の無い点数は「根拠なし」と書く', () => {
    const data = fullData()
    data.candidates[0]!.scores.reach = { score: 5, evidence: [], reason: '' }
    expect(researchContextMarkdown(data, NOW, 'ja')).toContain('reach 5（根拠なし）')
  })

  it('候補が無ければ discover から始めると書く', () => {
    const md = researchContextMarkdown(emptyData(), NOW, 'ja')
    expect(md).toContain('まだ候補が無い')
    expect(md).toContain('候補 C001, 証拠 E001, 実験 X001')
  })

  it('英語は英語の見出し', () => {
    const md = researchContextMarkdown(fullData(), NOW, 'en')
    expect(md).toContain('# Current state')
    expect(md).toContain('Gates decided by people')
    expect(md).toContain('Where files are')
    expect(md).not.toContain('いまの状況')
    expect(md).not.toContain('人のゲート')
  })

  it(`詳しく書くのは ${CONTEXT_DETAIL_LIMIT} 件まで。残りと除外は1行（除外の理由つき）`, () => {
    const candidates = Array.from({ length: CONTEXT_DETAIL_LIMIT + 5 }, (_, i) => blankCandidate(`C${String(i + 1).padStart(3, '0')}`, { title: `候補${i + 1}` }))
    candidates.push(blankCandidate('C900', { stage: 'dropped', dropReason: '到達できない\n詳しくは本文' }))
    const md = researchContextMarkdown(emptyData({ candidates }), NOW, 'ja')
    expect(md.match(/^### C/gm)?.length).toBe(CONTEXT_DETAIL_LIMIT)
    expect(md).toContain('ほかの候補（1行）')
    expect(md).toContain('- C900 dropped -（除外の理由: 到達できない）')
    expect(md).not.toContain('詳しくは本文')
  })

  it(`1行の一覧も ${CONTEXT_INDEX_LIMIT} 件まで。あとは数だけ`, () => {
    const n = CONTEXT_DETAIL_LIMIT + CONTEXT_INDEX_LIMIT + 7
    const candidates = Array.from({ length: n }, (_, i) => blankCandidate(`C${String(i + 1).padStart(4, '0')}`))
    const md = researchContextMarkdown(emptyData({ candidates }), NOW, 'ja')
    expect(md).toContain('ほか 7 件')
    expect(researchContextMarkdown(emptyData({ candidates }), NOW, 'en')).toContain('and 7 more')
  })

  it('読めなかったファイルを書く（30件まで）', () => {
    const problems = Array.from({ length: 40 }, (_, i) => ({ path: `candidates/C${i}.md`, message: 'YAML を読めません' }))
    const md = researchContextMarkdown(emptyData({ problems }), NOW, 'ja')
    expect(md).toContain('読めなかったファイル')
    expect(md).toContain('candidates/C29.md')
    expect(md).not.toContain('candidates/C30.md')
  })

  it('候補に結び付かない証拠の数と、プロジェクトにした先', () => {
    const data = fullData({ evidence: [fullEvidence('E001', { candidate: '' })] })
    data.candidates[0]!.promotedTo = { folder: '/tmp/biz', projectId: 'p1', at: NOW }
    const md = researchContextMarkdown(data, NOW, 'ja')
    expect(md).toContain('候補に結び付いていない 1')
    expect(md).toContain('/tmp/biz')
  })

  it('空の名前・対象範囲でも落ちない', () => {
    const data = emptyData()
    data.research.name = ''
    data.research.scope = ''
    expect(researchContextMarkdown(data, NOW, 'ja')).toContain('対象範囲: U')
  })
})

/** 記録の欄の名前（入れ子の最後の名前）をすべて集める */
function leafKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) leafKeys(v, out)
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k)
      leafKeys(v, out)
    }
  }
  return out
}

describe('researchReadme', () => {
  it.each(['ja', 'en'] as const)('%s: model の欄の名前がすべて載っている', (locale) => {
    const text = researchReadme(locale)
    const data = fullData()
    const keys = new Set([
      ...leafKeys(data.research),
      ...leafKeys({ ...fullCandidate('C001'), promotedTo: { folder: '', projectId: '', at: '' } }),
      ...leafKeys(fullEvidence('E001')),
      ...leafKeys(fullExperiment('X001'))
    ])
    // 下の欄はまとめて書いている（promotedTo の中身・期間・gates の中身）
    for (const k of ['folder', 'projectId', 'at', 'note', 'start', 'end', 'status', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'A社', 'B社']) keys.delete(k)
    const missing = [...keys].filter((k) => !text.includes(k))
    expect(missing).toEqual([])
  })

  it('README の欄の一覧は記録の種類ごとに重複が無い', () => {
    for (const paths of Object.values(README_FIELD_PATHS)) expect(new Set(paths).size).toBe(paths.length)
  })

  it('証拠の強さの9種・人だけの欄・しないことを書く', () => {
    const ja = researchReadme('ja')
    for (const g of ['contract', 'paidUsage', 'budgetedTender', 'competitorCase', 'reviewComplaint', 'searchDemand', 'snsComplaint', 'aiInference', 'companyFact']) expect(ja).toContain(`| ${g} |`)
    expect(ja).toContain('人だけ')
    expect(ja).toContain('広告出稿')
    expect(ja).toContain('ゲートの pass を書くこと')
    const en = researchReadme('en')
    expect(en).toContain('person only')
    expect(en).toContain('Writing a gate pass')
    expect(en).not.toMatch(/[ぁ-ん]/)
  })
})

describe('v3: 場面・成立条件・終了条件・次の行動の目安・実行条件', () => {
  it('sceneText: 5欄から一文。全部空なら null、一部空は U、「とき」を重ねない、末尾の句点を外す', () => {
    expect(sceneText(blankScene(), 'ja')).toBeNull()
    expect(sceneText({ ...blankScene(), company: ' ', who: '\n' }, 'en')).toBeNull()
    expect(sceneText(scene(), 'ja')).toBe('従業員20〜100人の IT 企業の新規法人営業の責任者が、営業担当を増員したときに、今週アプローチすべき企業と理由を必要としている。今は担当者が求人サイトと企業サイトを見て Excel に転記している')
    expect(sceneText(scene({ event: '契約更新が近い' }), 'ja')).toContain('契約更新が近いときに、')
    expect(sceneText(scene({ event: '受注したときに' }), 'ja')).toContain('受注したときに、')
    expect(sceneText(scene({ currentHandling: '手作業。' }), 'ja')!.endsWith('今は手作業')).toBe(true)
    expect(sceneText({ ...blankScene(), company: 'A社' }, 'ja')).toBe('A社のUが、Uときに、Uを必要としている。今はU')
    expect(sceneText(scene(), 'en')).toBe('At 従業員20〜100人の IT 企業, 新規法人営業の責任者, when 営業担当を増員したとき, needs 今週アプローチすべき企業と理由. Today: 担当者が求人サイトと企業サイトを見て Excel に転記している')
  })

  it('空いている欄: 場面・役割・見せる成果物・収益のつながり・未評価の証拠・成立条件', () => {
    const gaps = candidateGaps(blankCandidate('C001'), emptyData({ evidence: [fullEvidence('E001', { state: 'collected' })] }))
    expect(fields(gaps, 'scene')).toEqual(['scene.company', 'scene.who', 'scene.event', 'scene.outcome', 'scene.currentHandling'])
    expect(fields(gaps, 'who')).toContain('roles.budgetOwner.title')
    expect(fields(gaps, 'where')).toContain('deliverable')
    expect(fields(gaps, 'how')).toEqual(expect.arrayContaining(['monetization.side', 'monetization.orderScene', 'monetization.freeToPaidPath', 'monetization.months', 'monetization.marginPerDeal', 'monetization.costPerFreeUser', 'monetization.conversionScenarios']))
    expect(fields(gaps, 'conditions')[0]).toBe('evidence(state: collected): E001')
    expect(fields(gaps, 'conditions')).toContain('conditions.revenue.support|counter')
    expect(fields(gaps, 'conditions')).toContain('conditions.revenue.next')
  })

  it('有料化率の仮定は 0〜1 の異なる値が2つ以上要る', () => {
    for (const [rates, gap] of [
      [[0.02, 0.02], true],
      [[0, 1.5], true],
      [[Number.NaN, 0.02], true],
      [[0.005, 1], false]
    ] as const) {
      const c = fullCandidate('C001')
      c.monetization.conversionScenarios = [...rates]
      expect(fields(candidateGaps(c, fullData()), 'how').includes('monetization.conversionScenarios')).toBe(gap)
    }
  })

  it('成立条件: 知らない証拠 ID、supported なら次の確認が空でもよい', () => {
    const c = fullCandidate('C001')
    c.conditions.reachable = { ...c.conditions.reachable, support: ['E404'] }
    c.conditions.revenue = { ...c.conditions.revenue, next: '', status: 'supported' }
    c.conditions.problemStrong = { ...c.conditions.problemStrong, next: '', status: 'mixed' }
    const f = fields(candidateGaps(c, fullData()), 'conditions')
    expect(f).toEqual(['conditions.problemStrong.next', 'conditions.reachable(unknown id)'])
  })

  it('20件を超える未評価の証拠は切る', () => {
    const evidence = Array.from({ length: 25 }, (_, i) => fullEvidence(`E${String(i + 1).padStart(3, '0')}`, { state: 'collected' }))
    const f = fields(candidateGaps(fullCandidate('C001'), emptyData({ evidence })), 'conditions')[0]!
    expect(f.endsWith('E020 …')).toBe(true)
  })

  it('nextAction: 机上のゲートで欄が埋まっていても、未評価の証拠があれば evaluate。場面が空なら原則の依頼', () => {
    const data = fullData({ evidence: [fullEvidence('E001'), fullEvidence('E002', { state: 'collected' })] })
    expect(nextAction(data.candidates[0]!, data)).toEqual({ gate: 'G1', prompt: 'evaluate', human: false })
    const noScene = { ...data.candidates[0]!, scene: blankScene() }
    expect(nextAction(noScene, data).prompt).toBe('who')
    const evaluated = fullData()
    expect(nextAction(evaluated.candidates[0]!, evaluated)).toEqual({ gate: 'G1', prompt: null, human: true })
  })

  it('nextAction: G3 まで pass で成立条件が空なら evaluate（ranking より先）', () => {
    const data = fullData()
    const c = { ...data.candidates[0]!, gates: gates({ G1: 'pass', G2: 'pass', G3: 'pass' }), conditions: conditions() }
    expect(nextAction(c, data).prompt).toBe('evaluate')
  })

  it('exitItems: 6項目それぞれ', () => {
    expect(Object.values(exitItems(blankCandidate('C001'))).every((v) => !v)).toBe(true)
    expect(Object.values(exitItems(fullCandidate('C001'))).every((v) => v)).toBe(true)
    const c = fullCandidate('C001')
    c.where.channels = []
    expect(exitItems(c).contactPoint).toBe(true) // 予算の権限が確認できている
    c.roles = roles(false)
    expect(exitItems(c).contactPoint).toBe(false)
    c.monetization.freeToPaidPath = ''
    expect(exitItems(c).revenueLink).toBe(true) // 月額がある
    c.how.monthlyPrice = null
    expect(exitItems(c).revenueLink).toBe(false)
    const d = fullCandidate('C001')
    d.who.segment = { attribute: '', situation: '', behavior: '', problem: '', purchase: '' }
    expect(exitItems(d).targetCustomer).toBe(false)
  })

  it('decisionHint: 反証 → holdOrDrop、契約の実験2件 → invest、終了条件がそろう → experiment、ほか continue', () => {
    const data = fullData()
    const c = data.candidates[0]!
    expect(decisionHint(c, data)).toEqual({ suggestion: 'experiment', conditions: [] })
    expect(decisionHint(blankCandidate('C001'), data)).toEqual({ suggestion: 'continue', conditions: [] })
    expect(decisionHint(c, { experiments: [fullExperiment('X001'), fullExperiment('X002')] }).suggestion).toBe('invest')
    expect(decisionHint(c, { experiments: [fullExperiment('X001'), fullExperiment('X002', { candidate: 'C009' })] }).suggestion).toBe('experiment')
    expect(decisionHint(c, { experiments: [fullExperiment('X001'), fullExperiment('X002', { metrics: metrics({ contracts: 0 }) })] }).suggestion).toBe('experiment')
    const refuted = { ...c, conditions: conditions({}, { revenue: { status: 'refuted' }, reachable: { counter: ['E002'] } }) }
    expect(decisionHint(refuted, { experiments: [fullExperiment('X001'), fullExperiment('X002')] })).toEqual({ suggestion: 'holdOrDrop', conditions: ['reachable', 'revenue'] })
  })

  it('context.md: 場面・次の行動の目安と人の決定・終了条件の残り・実行条件（供給）・成立条件の表（反証に印）', () => {
    const data = fullData()
    const c = data.candidates[0]!
    c.conditions.revenue = { ...c.conditions.revenue, counter: ['E002'], counterNote: '無料利用者と\n買い手 | がずれる', status: 'refuted' }
    c.decision = 'continue'
    c.execution = execution({ firstDeal: true })
    c.deliverable = ''
    const md = researchContextMarkdown(data, NOW, 'ja')
    expect(md).toContain('- 購買が起きる場面: 従業員20〜100人の IT 企業の新規法人営業の責任者が')
    expect(md).toContain('- 次の行動の目安: holdOrDrop（保留・除外する。反証のある条件: revenue）／人の決定: continue')
    expect(md).toContain('- 調査の終了条件: 5/6（残り: 見せる成果物）')
    expect(md).toContain('- 実行条件: 1/4 確認済み。供給（supply）が未確認')
    expect(md).toContain('| 成立条件 | 判定 | 支持 | 反証・別の説明 | 未確認 | 次の確認 |')
    expect(md).toContain('| revenue 収益が成立する ⚠ | refuted | E001, E002 発注と不満の両方 | E002 無料利用者と 買い手 \\| がずれる | 現在の優先順位 | 直近の業務を確認 |')
    expect(md).toContain('| problemStrong 課題が十分に強い | supported |')
  })

  it('context.md: 場面が空・終了条件がそろった・供給が確認済み（英語）', () => {
    const md = researchContextMarkdown(emptyData({ candidates: [blankCandidate('C001')] }), NOW, 'ja')
    expect(md).toContain('- 購買が起きる場面: 未記入（どの依頼でも最初に書く）')
    expect(md).toContain('人の決定: 未決定')
    expect(md).toContain('| problemStrong 課題が十分に強い | unverified | — | — | — | — |')
    const en = researchContextMarkdown(fullData(), NOW, 'en')
    expect(en).toContain('Exit conditions of research: 6/6 (the remaining question is "will they use it and pay" → experiment)')
    expect(en).toContain('Execution conditions: 4/4 confirmed\n')
    expect(en).toContain('Next-action hint: experiment (Run a small experiment)')
  })

  it('README: 成立条件の主軸・次の行動4つ・収集と評価の工程を書く', () => {
    const ja = researchReadme('ja')
    for (const s of ['評価の主軸（成立条件の表）', 'problemStrong 課題が十分に強い', 'holdOrDrop', '収集と評価は別の工程', 'reading.<match|specificity|timing|independence|selectionBias>', 'execution.<key>.confirmed', '人だけ']) expect(ja).toContain(s)
    expect(researchReadme('en')).toContain('Main axis of evaluation (conditions table)')
  })
})
