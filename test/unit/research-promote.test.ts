/**
 * 「プロジェクトにする」で作るビジネスの最初の記録。ビジネスの検査（rules.ts）で error にならず、読み直しても型が崩れないこと
 */
import { describe, expect, it } from 'vitest'
import { EXECUTION_QUESTIONS, coerceRecord, emptyBusiness } from '@shared/business/records'
import { EXECUTION_KEYS } from '@shared/research/model'
import { hasErrors, validateBusiness } from '@shared/business/rules'
import type { BusinessData, RecordKind, RecordTypes } from '@shared/business/model'
import { PROMOTED_HYPOTHESIS_ID, buildPromotion, toBusinessScore, type PromotionPlan } from '@shared/research/promote'
import type { ResearchData } from '@shared/research/model'
import { NOW, blankCandidate, emptyData, fullCandidate, fullData, fullEvidence, fullExperiment, gates, metrics, scores } from './research-fixtures'

function business(plan: PromotionPlan): BusinessData {
  return {
    root: '/tmp/biz',
    business: { ...emptyBusiness(plan.name, NOW), target: plan.target, step: 'S6', currentHypothesis: plan.hypothesis.id },
    hypotheses: [plan.hypothesis],
    evidence: plan.evidence,
    alternatives: plan.alternatives,
    interviews: [],
    experiments: plan.experiments,
    decisions: [],
    approvals: [],
    searches: [],
    problems: []
  }
}

/** ファイルに書いて読み直したときと同じ寄せ方で、直しが出ないこと（欄の型を守っている） */
function expectNoFixes<K extends RecordKind>(kind: K, record: RecordTypes[K]) {
  const raw = JSON.parse(JSON.stringify(record)) as unknown
  const { value, fixes } = coerceRecord(kind, raw, record.id, NOW)
  expect(fixes).toEqual([])
  expect(value).toEqual(record)
}

function passed(data: ResearchData): ResearchData {
  data.candidates[0]!.gates = gates({ G1: 'pass', G2: 'pass', G3: 'pass' })
  return data
}

describe('toBusinessScore', () => {
  it.each([
    [null, 'U'],
    [1, 0],
    [2, 0],
    [3, 1],
    [4, 2],
    [5, 2]
  ] as const)('%s → %s', (s, b) => {
    expect(toBusinessScore(s)).toBe(b)
  })
})

describe('buildPromotion: ビジネスの検査を通る', () => {
  const cases: Array<[string, () => ResearchData]> = [
    ['全欄を埋めた候補', () => passed(fullData({ experiments: [fullExperiment('X001')] }))],
    ['何も調べていない候補', () => passed(emptyData({ candidates: [blankCandidate('C001')] }))],
    ['計画中の実験（数あり）', () => passed(fullData({ experiments: [fullExperiment('X001', { status: 'planned' })] }))],
    ['期間が逆の実験', () => passed(fullData({ experiments: [fullExperiment('X001', { period: { start: '2026-10-10', end: '2026-10-01' } })] }))],
    ['壊れた期間・負でない巨大な数', () => passed(fullData({ experiments: [fullExperiment('X001', { period: { start: '10/1', end: '' }, metrics: metrics({ contacted: 1e9, contracts: 1e9 }) })] }))],
    ['AI の推測だけの証拠', () => passed(fullData({ evidence: [fullEvidence('E001', { grade: 'aiInference', url: '' })] }))]
  ]
  for (const [name, make] of cases) {
    it(`${name}: error が無く、H01 の点に警告が無い`, () => {
      for (const locale of ['ja', 'en'] as const) {
        const plan = buildPromotion(make(), 'C001', NOW, locale)
        const issues = validateBusiness(business(plan))
        expect(hasErrors(issues)).toBe(false)
        expect(issues.filter((i) => i.ref === PROMOTED_HYPOTHESIS_ID)).toEqual([])
        expect(issues.filter((i) => i.field === 'hypothesis' || i.field === 'hypotheses')).toEqual([])
      }
    })

    it(`${name}: 読み直しても型が崩れない`, () => {
      const plan = buildPromotion(make(), 'C001', NOW, 'ja')
      expectNoFixes('hypothesis', plan.hypothesis)
      for (const e of plan.evidence) expectNoFixes('evidence', e)
      for (const a of plan.alternatives) expectNoFixes('alternative', a)
      for (const x of plan.experiments) expectNoFixes('experiment', x)
    })
  }

  it('知らない候補は投げる', () => {
    expect(() => buildPromotion(fullData(), 'C404', NOW, 'ja')).toThrow(/C404/)
  })
})

describe('仮説 H01', () => {
  it('段階は「ネット上の有望仮説」、判定は「進める」、S6 から続ける', () => {
    const plan = buildPromotion(passed(fullData()), 'C001', NOW, 'ja')
    const h = plan.hypothesis
    expect(h.id).toBe('H01')
    expect(h.stage).toBe('ネット上の有望仮説')
    expect(h.verdict).toBe('進める')
    expect(h.stageHistory).toEqual([{ from: '探索メモ', to: 'ネット上の有望仮説', at: NOW, note: expect.stringContaining('C001') }])
    expect(h.next).toMatch(/^S6/)
    expect(h.checkedAt).toBe('2026-10-18')
    expect(plan.name).toBe('営業リストの自動作成')
    expect(h.name).toBe(plan.name)
    // 購買が起きる場面の一文が対象の1文になる
    expect(plan.target).toBe('従業員20〜100人の IT 企業の新規法人営業の責任者が、営業担当を増員したときに、今週アプローチすべき企業と理由を必要としている。今は担当者が求人サイトと企業サイトを見て Excel に転記している')
    expect(h.target).toBe(plan.target)
    expect(h.trigger.split('\n')[0]).toBe('営業担当を増員したとき')
    expect(h.outcome).toBe('今週アプローチすべき企業と理由')
    expect(h.whyUnsolved).toContain('今の対処: 担当者が求人サイト')
    expect(h.offer).toBe('公開情報の収集と構造化を AI で代替できる')
    expect(h.whyUnsolved).toContain('情報が古い')
    expect(h.whyUnsolved).toContain('求人が出た直後')
  })

  it('乗り換えの式の差を最大の反証に書く（どれか未確認なら U）', () => {
    const plan = buildPromotion(passed(fullData()), 'C001', NOW, 'ja')
    expect(plan.hypothesis.biggestCounter).toContain('640,000 円')
    const data = passed(fullData())
    data.candidates[0]!.why.switching.switchingRisk = null
    expect(buildPromotion(data, 'C001', NOW, 'ja').hypothesis.biggestCounter).toContain('= U')
  })

  it('点の写し方（全欄の候補）', () => {
    const h = buildPromotion(passed(fullData()), 'C001', NOW, 'ja').hypothesis
    // what.factors.urgency 3 → 1、loss 4 → 2（What の証拠 E001・E002）
    expect(h.demand.D1).toMatchObject({ score: 1, evidence: ['E001', 'E002'] })
    expect(h.demand.D2.score).toBe(2)
    // scores.spend 4 → 2（根拠 E001）
    expect(h.demand.D3).toMatchObject({ score: 2, evidence: ['E001'] })
    expect(h.demand.D4).toMatchObject({ score: 2, evidence: ['E001'] })
    expect(h.acquisition.A2).toMatchObject({ score: 2, evidence: ['E001'] })
    // Who・Where の証拠が無いので、人の判断があっても U
    expect(h.demand.D5.score).toBe('U')
    expect(h.acquisition.A1.score).toBe('U')
    expect(h.acquisition.A3.score).toBe('U')
    expect(h.acquisition.A4.score).toBe('U')
    expect(h.provision.P1).toMatchObject({ value: 'はい', evidence: ['E001'] })
    expect(h.provision.P2.value).toBe('U')
    expect(h.provision.P3.value).toBe('U')
    expect(h.provision.P3.reason).toContain('30,000 円')
    expect(h.provision.P4.reason).toBe('収集と配信は自動。問い合わせだけ人が受ける')
  })

  it('Who・Where の証拠があれば人の判断ときっかけから D5・A1・A3', () => {
    const data = passed(
      fullData({
        evidence: [
          fullEvidence('E001'),
          fullEvidence('E002', { principle: 'who', grade: 'companyFact', kind: 'hiring' }),
          fullEvidence('E003', { principle: 'where', grade: 'companyFact', kind: 'hiring' }),
          fullEvidence('E004', { principle: 'why', grade: 'reviewComplaint', kind: 'complaint' })
        ]
      })
    )
    const c = data.candidates[0]!
    c.why.switching.coexists = true
    let h = buildPromotion(data, 'C001', NOW, 'ja').hypothesis
    expect(h.demand.D5).toMatchObject({ score: 2, evidence: ['E002'] })
    expect(h.acquisition.A1).toMatchObject({ score: 2, evidence: ['E002'] })
    expect(h.acquisition.A3).toMatchObject({ score: 1, evidence: ['E003'] })
    expect(h.provision.P2).toMatchObject({ value: 'はい', evidence: ['E004'] })

    c.who.conditions.canPay = null
    c.who.targetCount = 10
    c.where.triggers = Array.from({ length: 3 }, (_, i) => ({ kind: 'salesHiring' as const, company: `X${i}`, url: `https://jobs.example.com/${i}`, observedAt: '2026-10-01', note: '' }))
    h = buildPromotion(data, 'C001', NOW, 'ja').hypothesis
    expect(h.demand.D5.score).toBe(1)
    expect(h.acquisition.A1.score).toBe(1)
    expect(h.acquisition.A3.score).toBe(2)

    c.who.conditions.buyerKnown = false
    c.who.conditions.identifiable = false
    expect(buildPromotion(data, 'C001', NOW, 'ja').hypothesis.demand.D5.score).toBe(0)
    expect(buildPromotion(data, 'C001', NOW, 'ja').hypothesis.acquisition.A1.score).toBe(0)
  })

  it('URL の無いきっかけは数えない', () => {
    const data = passed(fullData({ evidence: [fullEvidence('E001'), fullEvidence('E003', { principle: 'where', grade: 'companyFact' })] }))
    data.candidates[0]!.where.triggers = [{ kind: 'other', company: 'A', url: 'ftp://x', observedAt: '', note: '' }]
    expect(buildPromotion(data, 'C001', NOW, 'ja').hypothesis.acquisition.A3.score).toBe('U')
  })

  it('根拠のない点数は持ち込まない（証拠が無い・知らない ID・AI の推測・URL が http でない・原文も事実も空）', () => {
    const variants: Array<Partial<Parameters<typeof fullEvidence>[1]>> = [
      { grade: 'aiInference' },
      { url: 'mailto:a@example.com' },
      { url: ' ' },
      { quote: '', fact: '  ' }
    ]
    for (const v of variants) {
      const data = passed(fullData({ evidence: [fullEvidence('E001', v)] }))
      const h = buildPromotion(data, 'C001', NOW, 'ja').hypothesis
      expect(h.demand.D3.score).toBe('U')
      expect(h.demand.D3.evidence).toEqual([])
      expect(h.demand.D3.reason).toContain('U')
      expect(h.provision.P1.value).toBe('U')
    }
    const data = passed(fullData())
    data.candidates[0]!.scores = scores({}, ['E999'])
    const h = buildPromotion(data, 'C001', NOW, 'en').hypothesis
    expect(h.demand.D3.score).toBe('U')
    expect(h.demand.D3.reason).toContain('no usable evidence')
  })

  it('点が 3 の提供のしやすさは U（はい／いいえに丸めない）、1・2 は いいえ', () => {
    const data = passed(fullData())
    data.candidates[0]!.scores.delivery.score = 3
    expect(buildPromotion(data, 'C001', NOW, 'ja').hypothesis.provision.P1.value).toBe('U')
    data.candidates[0]!.scores.delivery.score = 2
    expect(buildPromotion(data, 'C001', NOW, 'ja').hypothesis.provision.P1.value).toBe('いいえ')
  })

  it('何も調べていない候補はすべて U、名前は ID', () => {
    const plan = buildPromotion(passed(emptyData({ candidates: [blankCandidate('C001')] })), 'C001', NOW, 'ja')
    const h = plan.hypothesis
    expect(plan.name).toBe('C001')
    expect(plan.target).toBe('U')
    expect(Object.values(h.demand).every((e) => e.score === 'U')).toBe(true)
    expect(Object.values(h.acquisition).every((e) => e.score === 'U')).toBe(true)
    expect(Object.values(h.provision).every((e) => e.value === 'U')).toBe(true)
    expect(plan.evidence).toEqual([])
    expect(plan.alternatives).toEqual([])
    expect(plan.experiments).toEqual([])
  })

  it('英語の対象の1文（場面から）', () => {
    const plan = buildPromotion(passed(fullData()), 'C001', NOW, 'en')
    expect(plan.target).toBe('At 従業員20〜100人の IT 企業, 新規法人営業の責任者, when 営業担当を増員したとき, needs 今週アプローチすべき企業と理由. Today: 担当者が求人サイトと企業サイトを見て Excel に転記している')
    expect(plan.hypothesis.checker).toBe('Ferret research')
  })

  it('場面が空なら顧客・状況・仕事から1文を作る（ja・en）', () => {
    const data = passed(fullData())
    data.candidates[0]!.scene = { company: '', who: '', event: '', outcome: '', currentHandling: '' }
    expect(buildPromotion(data, 'C001', NOW, 'ja').target).toBe('従業員20〜100人の IT 企業の営業責任者が、法人営業を強化中のときに、今週アプローチする企業を見つけたい')
    expect(buildPromotion(data, 'C001', NOW, 'en').target).toBe('従業員20〜100人の IT 企業の営業責任者, when 法人営業を強化中, needs to: 今週アプローチする企業を見つけたい')
    expect(buildPromotion(data, 'C001', NOW, 'ja').hypothesis.outcome).toBe('限られた営業人員で商談数を増やしたい')
  })

  it('成立条件の反証を最大の反証の先頭に、未確認と次の確認を next に', () => {
    const data = passed(fullData({ evidence: [fullEvidence('E001'), fullEvidence('E002'), fullEvidence('E009', { candidate: 'C002' })] }))
    const c = data.candidates[0]!
    c.conditions.revenue = { support: [], counter: ['E009'], supportNote: '', counterNote: '無料利用者と買い手がずれる', unknown: '転換率', next: '収益商品を提示する', status: 'refuted' }
    c.conditions.reachable = { ...c.conditions.reachable, status: 'mixed', unknown: '反応率', next: '対象を絞って接触' }
    const plan = buildPromotion(data, 'C001', NOW, 'ja')
    const h = plan.hypothesis
    expect(h.biggestCounter.split('\n')[0]).toBe('反証（収益が成立する・refuted）: 無料利用者と買い手がずれる（E009）')
    expect(h.biggestCounter).toContain('乗り換え:')
    expect(h.next).toMatch(/^S6/)
    expect(h.next).toContain('顧客へ到達できる: 未確認 反応率／次の確認 対象を絞って接触')
    expect(h.next).toContain('収益が成立する: 未確認 転換率')
    // supported の条件は next に出さない
    expect(h.next).not.toContain('課題が十分に強い')
    // 反証の証拠は他の候補のものでも持ち込む
    expect(plan.evidence.map((e) => e.id)).toContain('E009')
  })

  it('反証が無ければ最大の反証は乗り換えの式だけ', () => {
    const h = buildPromotion(passed(fullData()), 'C001', NOW, 'ja').hypothesis
    expect(h.biggestCounter.startsWith('乗り換え:')).toBe(true)
  })

  it('役割を D5・A1 の理由に（推定した役職と確認できた決裁権限を分けて）', () => {
    const h = buildPromotion(passed(fullData()), 'C001', NOW, 'ja').hypothesis
    expect(h.demand.D5.reason).toContain('予算・発注を決める人: budgetOwner の役職（推定）／確認できた決裁権限: 月10万円まで決裁')
    expect(h.acquisition.A1.reason).toContain('実際に使う人: user の役職（推定）／確認できた決裁権限: 未確認')
    const en = buildPromotion(passed(fullData()), 'C001', NOW, 'en').hypothesis
    expect(en.demand.D5.reason).toContain('confirmed authority: 月10万円まで決裁')
  })

  it('評価で match か timing が ng の証拠は裏付けにしない（発見のみ・点は U）', () => {
    for (const r of [{ match: 'ng' as const }, { timing: 'ng' as const }]) {
      const data = passed(fullData({ evidence: [fullEvidence('E001', { reading: { match: 'ok', specificity: 'ok', timing: 'ok', independence: 'ok', selectionBias: 'ok', ...r } })] }))
      const plan = buildPromotion(data, 'C001', NOW, 'ja')
      expect(plan.evidence[0]!.readStatus).toBe('発見のみ')
      expect(plan.hypothesis.demand.D3.score).toBe('U')
      expect(hasErrors(validateBusiness(business(plan)))).toBe(false)
    }
    // ほかの観点の ng・weak では外さない
    const data = passed(fullData({ evidence: [fullEvidence('E001', { reading: { match: 'ok', specificity: 'ng', timing: 'weak', independence: 'ng', selectionBias: 'ng' } })] }))
    expect(buildPromotion(data, 'C001', NOW, 'ja').evidence[0]!.readStatus).toBe('読了')
  })
})

describe('証拠', () => {
  it('ID はそのまま。grade → sourceKind、裏付けに使えるものだけ読了、supports に使った点', () => {
    const plan = buildPromotion(passed(fullData()), 'C001', NOW, 'ja')
    expect(plan.evidence.map((e) => e.id)).toEqual(['E001', 'E002'])
    const [e1, e2] = plan.evidence
    expect(e1).toMatchObject({
      sourceKind: '発注',
      readStatus: '読了',
      hypotheses: ['H01'],
      dupGroup: 'E001',
      medium: '発注サイト',
      checkedAt: '2026-10-10',
      publishedAt: '2026-09-05',
      party: '従業員50人の IT 企業 / user の役職',
      partyBasis: '発注者本人',
      counter: '1社だけの発注で、継続は未確認',
      facts: '営業リスト作成に月3万円が払われている',
      quote: '営業リスト作成を月額3万円で発注'
    })
    expect(e1!.details).toMatchObject({ spend: '月額3万円', scene: '営業担当を3名増員', action: '営業リスト作成を外注した', nextQuestion: '自社の提案に予算を移すか' })
    expect(e1!.interpretation).toContain('出来事の日: 2026-09-01')
    expect(e1!.supports).toEqual(expect.arrayContaining(['D1', 'D2', 'D3', 'D4', 'A2']))
    expect(e1!.interpretation).toContain('同じ規模の企業も払う可能性がある')
    expect(e1!.interpretation).toContain('contract')
    expect(e2).toMatchObject({ sourceKind: '本人の経験', readStatus: '読了', party: '従業員50人の IT 企業' })
    expect(e2!.details.gap).toBe('営業リスト作成に月3万円が払われている')
  })

  it('dupGroup: 評価済みは値（空なら自分の ID）、未評価は U。金額が空なら事実を支出に', () => {
    const data = passed(
      fullData({
        evidence: [fullEvidence('E001', { dupGroup: 'press-1' }), fullEvidence('E002', { dupGroup: 'press-1', state: 'collected', amount: '' }), fullEvidence('E003', { dupGroup: '  ' })]
      })
    )
    const plan = buildPromotion(data, 'C001', NOW, 'ja')
    expect(plan.evidence.map((e) => e.dupGroup)).toEqual(['press-1', 'U', 'E003'])
    expect(plan.evidence[1]!.details.spend).toBe('営業リスト作成に月3万円が払われている')
  })

  it.each([
    ['contract', '発注'],
    ['budgetedTender', '発注'],
    ['paidUsage', '販売者の説明'],
    ['competitorCase', '販売者の説明'],
    ['reviewComplaint', '本人の経験'],
    ['snsComplaint', '本人の経験'],
    ['aiInference', '分析者の推測'],
    ['searchDemand', 'U'],
    ['companyFact', 'U']
  ] as const)('%s → %s', (grade, kind) => {
    const plan = buildPromotion(passed(fullData({ evidence: [fullEvidence('E001', { grade })] })), 'C001', NOW, 'ja')
    expect(plan.evidence[0]!.sourceKind).toBe(kind)
    expect(plan.evidence[0]!.readStatus).toBe(grade === 'aiInference' ? '発見のみ' : '読了')
  })

  it('点・選ばれる理由が指す他の候補の証拠も持ち込み、関係ない証拠は持ち込まない。確認日が空なら今日', () => {
    const data = passed(
      fullData({
        evidence: [fullEvidence('E001', { candidate: 'C002', checkedAt: '' }), fullEvidence('E005', { candidate: 'C002' }), fullEvidence('E007', { candidate: '' })]
      })
    )
    data.candidates[0]!.why.reasonEvidence = ['E007', 'E404']
    const plan = buildPromotion(data, 'C001', NOW, 'ja')
    expect(plan.evidence.map((e) => e.id)).toEqual(['E001', 'E007'])
    expect(plan.evidence[0]!.checkedAt).toBe('2026-10-18')
  })

  it('同じ ID が2つあっても1件にする', () => {
    const data = passed(fullData({ evidence: [fullEvidence('E001'), fullEvidence('E001', { fact: '後の方' })] }))
    const plan = buildPromotion(data, 'C001', NOW, 'ja')
    expect(plan.evidence.map((e) => e.id)).toEqual(['E001'])
    expect(plan.evidence[0]!.facts).not.toBe('後の方')
  })
})

describe('代替', () => {
  it('既存サービス → ALT01…、時間か現金の支出があれば現状のやり方も', () => {
    const plan = buildPromotion(passed(fullData()), 'C001', NOW, 'ja')
    expect(plan.alternatives.map((a) => a.id)).toEqual(['ALT01', 'ALT02'])
    expect(plan.alternatives[0]).toMatchObject({ hypothesis: 'H01', method: '既存リストサービス', cost: '月額 3万円〜', url: 'https://competitor.example.com/pricing', offering: 'E002: 使いやすさが評価', checkedAt: '2026-10-18' })
    expect(plan.alternatives[0]!.gap).toContain('情報が古い')
    expect(plan.alternatives[0]!.gap).toContain('更新が遅いので解約')
    expect(plan.alternatives[1]!.cost).toContain('160,000 円')
    expect(plan.alternatives[1]!.cost).toContain('30,000 円')
  })

  it('名前も URL も無いサービスは飛ばし、名前が無ければ URL。99件まで', () => {
    const data = passed(fullData())
    const c = data.candidates[0]!
    c.what.quantification = { hoursPerMonth: null, hourlyCost: null, reductionRate: null, cashSpendMonthly: null, opportunityMonthly: null }
    c.existingServices = [{ name: ' ', url: '', price: '' }, { name: '', url: 'https://x.example.com', price: '' }, ...Array.from({ length: 150 }, (_, i) => ({ name: `S${i}`, url: '', price: '' }))]
    const plan = buildPromotion(data, 'C001', NOW, 'ja')
    expect(plan.alternatives[0]!.method).toBe('https://x.example.com')
    expect(plan.alternatives).toHaveLength(99)
    expect(plan.alternatives.at(-1)!.id).toBe('ALT99')
  })
})

describe('実験', () => {
  it('数の対応（終わった実験は実測へ）と、移さない数・条件の文を reasons に', () => {
    const plan = buildPromotion(passed(fullData({ experiments: [fullExperiment('X001')] })), 'C001', NOW, 'ja')
    const x = plan.experiments[0]!
    expect(x).toMatchObject({ id: 'X001', hypothesis: 'H01', status: '完了', question: '営業部長は月3万円で申し込むか', channel: '直接営業', price: '月額 30,000 円', pass: [], stop: [], conclusion: '求人直後の企業は返信が早い' })
    expect(x.actual).toMatchObject({ contacts: 80, replies: 10, qualified: 8, priced: 5, paid: 2, repurchased: 2, interest: 3, revenue: 60000, adCost: 40000, payments: null })
    expect(Object.values(x.plan).every((v) => v === null)).toBe(true)
    expect(x.reasons).toContain('合格条件（リサーチ）: 100社で契約2社以上')
    expect(x.reasons).toContain('中止条件（リサーチ）: 50社で商談0なら中止')
    expect(x.reasons).toContain('targets 100, reachedBuyer 40, problemMatch 6, expanded 0')
  })

  it.each([
    ['planned', '計画のみ'],
    ['running', '実施中'],
    ['done', '完了'],
    ['stopped', '中止']
  ] as const)('%s → %s（計画のみの数は plan へ）', (status, mapped) => {
    const plan = buildPromotion(passed(fullData({ experiments: [fullExperiment('X001', { status })] })), 'C001', NOW, 'ja')
    const x = plan.experiments[0]!
    expect(x.status).toBe(mapped)
    const target = status === 'planned' ? x.plan : x.actual
    const other = status === 'planned' ? x.actual : x.plan
    expect(target.contacts).toBe(80)
    expect(Object.values(other).every((v) => v === null)).toBe(true)
  })

  it('期間が逆なら終了を空にして理由を書く。同じ日は残す', () => {
    let x = buildPromotion(passed(fullData({ experiments: [fullExperiment('X001', { period: { start: '2026-10-10', end: '2026-10-01' } })] })), 'C001', NOW, 'ja').experiments[0]!
    expect(x.period).toEqual({ start: '2026-10-10', end: '' })
    expect(x.reasons).toContain('2026-10-01')
    x = buildPromotion(passed(fullData({ experiments: [fullExperiment('X001', { period: { start: '2026-10-10', end: '2026-10-10' } })] })), 'C001', NOW, 'ja').experiments[0]!
    expect(x.period).toEqual({ start: '2026-10-10', end: '2026-10-10' })
  })

  it('他の候補の実験は持ち込まない。経路が無ければ空、価格が無ければ空', () => {
    const data = passed(fullData({ experiments: [fullExperiment('X001', { channel: null }), fullExperiment('X002', { candidate: 'C002' })] }))
    data.candidates[0]!.how.monthlyPrice = null
    const plan = buildPromotion(data, 'C001', NOW, 'en')
    expect(plan.experiments.map((x) => x.id)).toEqual(['X001'])
    expect(plan.experiments[0]!.channel).toBe('')
    expect(plan.experiments[0]!.price).toBe('')
    expect(plan.hypothesis.next).toContain('X001')
  })
})

describe('実行条件（business.yaml の execution）', () => {
  it('候補の plan と confirmed をそのまま', () => {
    const data = passed(fullData())
    data.candidates[0]!.execution.supply.confirmed = false
    const plan = buildPromotion(data, 'C001', NOW, 'ja')
    expect(plan.execution).toEqual({
      firstDeal: { plan: 'firstDeal の決める内容', confirmed: true },
      supply: { plan: 'supply の決める内容', confirmed: false },
      firstExperiment: { plan: 'firstExperiment の決める内容', confirmed: true },
      profitOps: { plan: 'profitOps の決める内容', confirmed: true }
    })
  })

  it('plan が空（空白だけも）なら既定の問い（日英）、confirmed は false のまま', () => {
    const data = passed(emptyData({ candidates: [blankCandidate('C001')] }))
    data.candidates[0]!.execution.firstDeal.plan = '   '
    const ja = buildPromotion(data, 'C001', NOW, 'ja').execution
    // 既定の問いはビジネス側（business.yaml の execution）と同じ文
    for (const k of EXECUTION_KEYS) expect(ja[k]).toEqual({ plan: EXECUTION_QUESTIONS[k].ja, confirmed: false })
    expect(ja.supply.plan).toContain('誰が何を提供するか')
    const en = buildPromotion(data, 'C001', NOW, 'en').execution
    for (const k of EXECUTION_KEYS) expect(en[k]).toEqual({ plan: EXECUTION_QUESTIONS[k].en, confirmed: false })
  })
})

describe('RESEARCH.md', () => {
  it('場面・成立条件（反証に印）・人の決定・収益のつながり（有料化率ごとの期待限界利益）・実行条件', () => {
    const data = passed(fullData())
    const c = data.candidates[0]!
    c.conditions.revenue = { ...c.conditions.revenue, counter: ['E002'], counterNote: '無料利用者と買い手がずれる', status: 'refuted' }
    c.decision = 'experiment'
    c.execution.supply.confirmed = false
    const md = buildPromotion(data, 'C001', NOW, 'ja').researchMd
    expect(md).toContain('## 購買が起きる場面')
    expect(md).toContain('従業員20〜100人の IT 企業の新規法人営業の責任者が、営業担当を増員したときに')
    expect(md).toContain('| 収益が成立する ⚠ | refuted |')
    expect(md).toContain('| 課題が十分に強い | supported | E001, E002 発注と不満の両方 | — | 現在の優先順位 | 直近の業務を確認 |')
    expect(md).toContain('人が決めた次の行動: experiment（小さく実験する）')
    expect(md).toContain('有料化率 0.5%: 期待限界利益 1,500 円／差し引き -4,500 円')
    expect(md).toContain('有料化率 2%: 期待限界利益 6,000 円／差し引き 0 円')
    expect(md).toContain('有料化率 5%: 期待限界利益 15,000 円／差し引き 9,000 円')
    expect(md).toContain('| 提供する能力と供給（抜けやすい） | supply の決める内容 | まだ |')
    expect(md).toContain('| 最初の有料取引 | firstDeal の決める内容 | はい |')
  })

  it('収益の率は範囲外・重複を除いて昇順。金額が無ければ U', () => {
    const data = passed(fullData())
    data.candidates[0]!.monetization = { ...data.candidates[0]!.monetization, marginPerDeal: null, conversionScenarios: [0.05, 0, -1, 2, Number.NaN, 0.05, 0.01] }
    const md = buildPromotion(data, 'C001', NOW, 'en').researchMd
    expect(md).toContain('conversion 1%: expected margin U／net U')
    expect(md).toContain('conversion 5%: expected margin U')
    expect(md.match(/conversion /g)?.length).toBe(2)
    expect(md).toContain('Next action decided by people: not decided')
    expect(md).toContain('## Purchase scene')
  })

  it('由来・リンク・5原則・ゲート・採点・引き継いだ記録', () => {
    const data = passed(fullData({ root: '/Users/me/research/', experiments: [fullExperiment('X001')] }))
    data.candidates[0]!.gates.G1.note = '120社を確認 | 求人ベース\n2行目'
    const md = buildPromotion(data, 'C001', NOW, 'ja').researchMd
    expect(md).toContain('# リサーチからの引き継ぎ: 営業リストの自動作成')
    expect(md).toContain('リサーチ「テストのリサーチ」の候補 C001')
    expect(md).toContain('/Users/me/research/candidates/C001.md')
    expect(md).not.toContain('research//')
    for (const s of ['Who 誰に売るか', 'What 何を解決するか', 'Where どこで顧客を獲得するか', 'Why なぜ自社が選ばれるか', 'How どうやって利益を再現するか']) expect(md).toContain(s)
    expect(md).toContain('| G1 顧客が存在するか（対象企業を特定できる） | pass | 120社を確認 \\| 求人ベース 2行目 |')
    expect(md).toContain('| G4 購入するか（有料契約・予約・具体的な購入意思） | pending | — | — |')
    expect(md).toContain('| 需要の強さ | 4 | E001 |')
    expect(md).toContain('証拠: E001, E002')
    expect(md).toContain('代替: ALT01 既存リストサービス')
    expect(md).toContain('X001（完了）')
  })

  it('英語', () => {
    const md = buildPromotion(passed(fullData()), 'C001', NOW, 'en').researchMd
    expect(md).toContain('# Handover from research')
    expect(md).toContain('Gates (decided by people)')
    expect(md).toContain('A high score never skips G4')
    expect(md).toContain('Experiments: none')
  })
})
