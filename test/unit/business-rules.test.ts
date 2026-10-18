/**
 * 保存時の検査（構想 3章「守るルール」）。error は保存させない、warning は残して知らせる
 */
import { describe, expect, it } from 'vitest'
import { emptyBusiness, emptyNumbers, emptyRecord } from '@shared/business/records'
import type { BusinessData, Evidence, Experiment, Hypothesis, Interview, Stage } from '@shared/business/model'
import { hasErrors, validateBusiness, validateRecord, type Issue } from '@shared/business/rules'

const NOW = '2026-10-17T09:00:00.000Z'

function data(over: Partial<BusinessData> = {}): BusinessData {
  return { root: '/tmp/b', business: emptyBusiness('テスト', NOW), hypotheses: [], evidence: [], alternatives: [], interviews: [], experiments: [], decisions: [], approvals: [], searches: [], problems: [], ...over }
}
const hyp = (id = 'H01', over: Partial<Hypothesis> = {}): Hypothesis => ({ ...emptyRecord('hypothesis', id, NOW), ...over })
const ev = (id: string, over: Partial<Evidence> = {}): Evidence => ({
  ...emptyRecord('evidence', id, NOW), hypotheses: ['H01'], readStatus: '読了', url: `https://example.com/${id}`, facts: '事実', dupGroup: id, sourceKind: '本人の経験', ...over
})
const exp = (over: Partial<Experiment> = {}): Experiment => ({ ...emptyRecord('experiment', 'X01', NOW), hypothesis: 'H01', ...over })
const intv = (over: Partial<Interview> = {}): Interview => ({ ...emptyRecord('interview', 'I01', NOW), hypothesis: 'H01', ...over })
const msgs = (issues: Issue[]) => issues.map((i) => i.message)
const pick = (issues: Issue[], field: string) => issues.filter((i) => i.field === field)

describe('点数の根拠', () => {
  it('U の項目は根拠が無くても何も言わない', () => {
    expect(validateRecord('hypothesis', hyp(), data())).toEqual([])
  })

  it('点数に根拠の証拠 ID が無ければ警告（0 点でも）', () => {
    const h = hyp()
    h.demand.D1.score = 0
    h.acquisition.A2.score = 2
    h.provision.P3.value = 'いいえ'
    const issues = validateRecord('hypothesis', h, data({ hypotheses: [h] }))
    expect(issues).toEqual([
      { severity: 'warning', ref: 'H01', field: 'D1', message: 'D1 急ぐ理由 に根拠の証拠 ID がありません' },
      { severity: 'warning', ref: 'H01', field: 'A2', message: 'A2 接点 に根拠の証拠 ID がありません' },
      { severity: 'warning', ref: 'H01', field: 'P3', message: 'P3 採算が合う に根拠の証拠 ID がありません' }
    ])
    expect(hasErrors(issues)).toBe(false)
  })

  it('根拠の ID が証拠台帳に無ければ警告', () => {
    const h = hyp()
    h.demand.D2 = { score: 2, evidence: ['E01', 'E99'], reason: '' }
    const issues = validateRecord('hypothesis', h, data({ hypotheses: [h], evidence: [ev('E01')] }))
    expect(msgs(issues)).toEqual(['D2 の根拠 E99 が証拠台帳にありません'])
  })

  it('根拠が「発見のみ」の証拠なら警告（読んだことにしない）', () => {
    const h = hyp()
    h.demand.D3 = { score: 1, evidence: ['E02'], reason: '' }
    const issues = validateRecord('hypothesis', h, data({ hypotheses: [h], evidence: [ev('E02', { readStatus: '発見のみ' })] }))
    expect(msgs(issues)).toEqual(['D3 の根拠 E02 は原典を読めていません（発見のみ）'])
  })

  it('読了の証拠を根拠にした点数は問題なし', () => {
    const h = hyp()
    h.demand.D1 = { score: 2, evidence: ['E01'], reason: '' }
    h.provision.P1 = { value: 'はい', evidence: ['E01'], reason: '' }
    expect(validateRecord('hypothesis', h, data({ hypotheses: [h], evidence: [ev('E01')] }))).toEqual([])
  })
})

describe('段階が証拠より先へ進んでいないか', () => {
  const at = (stage: Stage, over: Partial<BusinessData> = {}) => {
    const h = hyp('H01', { stage })
    return pick(validateRecord('hypothesis', h, data({ hypotheses: [h], ...over })), 'stage')
  }

  it('探索メモ・ネット上の有望仮説では何も言わない', () => {
    expect(at('探索メモ')).toEqual([])
    expect(at('ネット上の有望仮説')).toEqual([])
  })

  it('当事者確認済みなのに同意つきの聞き取りが無ければ警告', () => {
    expect(msgs(at('当事者確認済み'))).toEqual(['当事者確認済みより先ですが、同意つきの聞き取りの記録がありません'])
    expect(at('当事者確認済み', { interviews: [intv({ consent: false })] })).toHaveLength(1)
    expect(at('当事者確認済み', { interviews: [intv({ consent: true, hypothesis: 'H02' })] })).toHaveLength(1)
    expect(at('当事者確認済み', { interviews: [intv({ consent: true })] })).toEqual([])
  })

  it('有料検証済みなのに入金を記録した実験が無ければ警告（入金 0 は無いのと同じ）', () => {
    const interviews = [intv({ consent: true })]
    expect(msgs(at('有料検証済み', { interviews }))).toEqual(['有料検証済みより先ですが、入金を記録した実験がありません'])
    expect(at('有料検証済み', { interviews, experiments: [exp({ status: '完了', actual: { ...emptyNumbers(), payments: 0 } })] })).toHaveLength(1)
    expect(at('有料検証済み', { interviews, experiments: [exp({ status: '完了', plan: { ...emptyNumbers(), payments: 5 } })] })).toHaveLength(1)
    expect(at('有料検証済み', { interviews, experiments: [exp({ status: '完了', actual: { ...emptyNumbers(), payments: 1 } })] })).toEqual([])
  })

  it('継続提供の見込みありなのに再購入の記録が無ければ警告。足りないものを全部出す', () => {
    expect(msgs(at('継続提供の見込みあり'))).toHaveLength(3)
    const ok = at('継続提供の見込みあり', {
      interviews: [intv({ consent: true })],
      experiments: [exp({ status: '完了', actual: { ...emptyNumbers(), payments: 1, repurchased: 1, paid: 1 } })]
    })
    expect(ok).toEqual([])
  })
})

describe('実験', () => {
  it('計画のみの実験に実測値があれば error（計画値と実測値を混ぜない）', () => {
    const x = exp({ actual: { ...emptyNumbers(), contacts: 10, paid: 0 } })
    const issues = validateRecord('experiment', x, data({ hypotheses: [hyp()] }))
    const errors = issues.filter((i) => i.severity === 'error')
    expect(errors.map((i) => i.field)).toEqual(['actual.contacts', 'actual.paid'])
    expect(hasErrors(issues)).toBe(true)
  })

  it('計画のみで計画値だけなら error なし', () => {
    const issues = validateRecord('experiment', exp({ plan: { ...emptyNumbers(), contacts: 100 } }), data({ hypotheses: [hyp()] }))
    expect(hasErrors(issues)).toBe(false)
  })

  it('終了日が開始日より前なら error。同じ日・片方だけは問題なし', () => {
    const v = (start: string, end: string) => pick(validateRecord('experiment', exp({ period: { start, end } }), data({ hypotheses: [hyp()] })), 'period')
    expect(v('2026-10-10', '2026-10-01')).toEqual([{ severity: 'error', ref: 'X01', field: 'period', message: '終了日が開始日より前です' }])
    expect(v('2026-10-01', '2026-10-01')).toEqual([])
    expect(v('2026-10-01', '')).toEqual([])
    expect(v('', '2026-10-01')).toEqual([])
  })

  it('実施中なのに合格条件・中止条件が無ければ警告。計画のみなら言わない', () => {
    const running = validateRecord('experiment', exp({ status: '実施中' }), data({ hypotheses: [hyp()] }))
    expect(running.map((i) => i.field)).toEqual(['pass', 'stop'])
    expect(validateRecord('experiment', exp(), data({ hypotheses: [hyp()] }))).toEqual([])
  })

  it('実測・計画の経路の矛盾はそれぞれ「実測:」「計画:」として警告', () => {
    const x = exp({ status: '実施中', pass: [{ metric: 'paid', op: '>=', value: 1 }], stop: [{ metric: 'contacts', op: '<=', value: 0 }], actual: { ...emptyNumbers(), contacts: 1, replies: 2 }, plan: { ...emptyNumbers(), priced: 1, paid: 3 } })
    expect(msgs(validateRecord('experiment', x, data({ hypotheses: [hyp()] })))).toEqual(['実測: 返信（2）が接触（1）より多い', '計画: 有料顧客（3）が価格提示（1）より多い'])
  })

  it('上限を超えたら警告', () => {
    const x = exp({ status: '実施中', pass: [{ metric: 'paid', op: '>=', value: 1 }], stop: [{ metric: 'paid', op: '<=', value: 0 }], limits: { yen: 100, hours: 1 }, actual: { ...emptyNumbers(), adCost: 200, salesHours: 2, hourlyCost: 0 } })
    expect(pick(validateRecord('experiment', x, data({ hypotheses: [hyp()] })), 'limits')).toHaveLength(2)
  })

  it('仮説が無ければ警告', () => {
    expect(msgs(validateRecord('experiment', exp({ hypothesis: 'H09' }), data()))).toEqual(['仮説 H09 がありません'])
  })
})

describe('聞き取り', () => {
  it('同意の無い聞き取りに原文があれば error', () => {
    const issues = validateRecord('interview', intv({ consent: false, transcript: '原文' }), data({ hypotheses: [hyp()] }))
    expect(issues).toEqual([{ severity: 'error', ref: 'I01', field: 'transcript', message: '同意が無い聞き取りの原文は保存できません' }])
  })

  it('同意が無くても原文が空白だけなら error にしない', () => {
    expect(validateRecord('interview', intv({ consent: false, transcript: '  \n' }), data({ hypotheses: [hyp()] }))).toEqual([])
  })

  it('同意があれば原文を保存できる', () => {
    expect(validateRecord('interview', intv({ consent: true, transcript: '原文' }), data({ hypotheses: [hyp()] }))).toEqual([])
  })

  it.each([
    ['要約', { summary: '連絡先は taro.yamada+test@example.co.jp です' }],
    ['原文', { consent: true, transcript: 'mail: a@b.jp' }]
  ])('%s にメールアドレスがあれば警告', (_n, over) => {
    const issues = validateRecord('interview', intv(over), data({ hypotheses: [hyp()] }))
    expect(issues.map((i) => i.field)).toEqual(['summary'])
    expect(issues[0]!.severity).toBe('warning')
  })

  it('@ があってもメールの形でなければ警告しない', () => {
    expect(validateRecord('interview', intv({ summary: '@user にリプ。価格は 1 万円 @ 月' }), data({ hypotheses: [hyp()] }))).toEqual([])
  })
})

describe('証拠', () => {
  it('読了なのに URL が無い・事実も原文も空なら警告', () => {
    const issues = validateRecord('evidence', ev('E01', { url: '', facts: '', quote: '' }), data({ hypotheses: [hyp()] }))
    expect(issues.map((i) => i.field)).toEqual(['url', 'facts'])
  })

  it('URL が http(s) でなければ警告（javascript: など）', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'example.com', 'ftp://x']) {
      const issues = validateRecord('evidence', ev('E01', { url }), data({ hypotheses: [hyp()] }))
      expect(msgs(issues)).toEqual(['原典の URL が http(s) ではありません'])
    }
    expect(validateRecord('evidence', ev('E01', { url: 'HTTPS://EXAMPLE.COM' }), data({ hypotheses: [hyp()] }))).toEqual([])
  })

  it('発見のみなら URL・事実が空でも警告しない', () => {
    expect(validateRecord('evidence', ev('E01', { readStatus: '発見のみ', url: '', facts: '' }), data({ hypotheses: [hyp()] }))).toEqual([])
  })

  it('結びつけた仮説が無ければ警告', () => {
    expect(msgs(validateRecord('evidence', ev('E01', { hypotheses: ['H01', 'H05'] }), data({ hypotheses: [hyp()] })))).toEqual(['仮説 H05 がありません'])
  })
})

describe('ID の形と全体の検査', () => {
  it.each([
    ['hypothesis', 'E01'],
    ['hypothesis', 'H1'],
    ['evidence', 'E00001'],
    ['alternative', 'A01'],
    ['approval', 'r01']
  ] as const)('%s の ID「%s」は error', (kind, id) => {
    const rec = { ...emptyRecord(kind, id, NOW) }
    const issues = validateRecord(kind, rec, data())
    expect(issues.some((i) => i.severity === 'error' && i.field === 'id')).toBe(true)
  })

  it('同じ ID が2つあれば error', () => {
    const issues = validateBusiness(data({ hypotheses: [hyp('H01'), hyp('H01'), hyp('H02')] }))
    expect(issues.filter((i) => i.field === 'id')).toEqual([{ severity: 'error', ref: 'H01', field: 'id', message: 'ID H01 が重複しています' }])
  })

  it('種類が違えば同じ番号でも重複ではない（I01 と I01 は重複、H01 と E01 は別）', () => {
    const issues = validateBusiness(data({ hypotheses: [hyp('H01')], evidence: [ev('E01')], interviews: [intv(), intv()] }))
    expect(issues.filter((i) => i.message.includes('重複')).map((i) => i.ref)).toEqual(['I01'])
  })

  it('今の仮説が無ければ警告', () => {
    const d = data({ hypotheses: [hyp('H01')] })
    d.business.currentHypothesis = 'H02'
    expect(validateBusiness(d)).toContainEqual({ severity: 'warning', ref: 'business', field: 'currentHypothesis', message: '今の仮説 H02 がありません' })
  })

  it('読めなかったファイルも警告として出す', () => {
    const issues = validateBusiness(data({ problems: [{ path: 'hypotheses/H03.md', message: 'YAML を読めません' }] }))
    expect(issues).toEqual([{ severity: 'warning', ref: 'hypotheses/H03.md', field: '', message: 'YAML を読めません' }])
  })

  it('空のビジネスは問題なし', () => {
    expect(validateBusiness(data())).toEqual([])
  })

  it('全体の検査は各記録の検査を含む（error を拾う）', () => {
    const issues = validateBusiness(data({ hypotheses: [hyp()], interviews: [intv({ transcript: '原文' })], experiments: [exp({ actual: { ...emptyNumbers(), paid: 1 } })] }))
    expect(hasErrors(issues)).toBe(true)
    expect(issues.filter((i) => i.severity === 'error').map((i) => `${i.ref}.${i.field}`)).toEqual(['I01.transcript', 'X01.actual.paid'])
  })

  it('代替・結論の仮説の参照も確かめる。承認は参照を確かめない', () => {
    const issues = validateBusiness(data({
      alternatives: [{ ...emptyRecord('alternative', 'ALT01', NOW), hypothesis: 'H07' }],
      decisions: [{ ...emptyRecord('decision', 'C01', NOW), hypothesis: 'H08' }],
      approvals: [{ ...emptyRecord('approval', 'R01', NOW), refs: ['H09'] }]
    }))
    expect(msgs(issues)).toEqual(['仮説 H07 がありません', '仮説 H08 がありません'])
  })

  it('hasErrors', () => {
    expect(hasErrors([])).toBe(false)
    expect(hasErrors([{ severity: 'warning', ref: '', field: '', message: '' }])).toBe(false)
    expect(hasErrors([{ severity: 'warning', ref: '', field: '', message: '' }, { severity: 'error', ref: '', field: '', message: '' }])).toBe(true)
  })
})

describe('実験の期間の日付', () => {
  it('ゼロ埋めの無い日付・実在しない日付は警告し、比べない', async () => {
    const { isoDay } = await import('../../src/shared/business/rules')
    expect(isoDay('2026-10-01')).not.toBeNull()
    expect(isoDay('2026-9-1')).toBeNull()
    expect(isoDay('2026-02-30')).toBeNull()
    expect(isoDay(' 2026-02-28 ')).not.toBeNull()
  })
})
