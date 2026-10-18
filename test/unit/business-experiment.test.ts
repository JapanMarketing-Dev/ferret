/**
 * 実験の計算（手法.md 11章）。CAC・提供後に残る額・回収月数・経路の割合・事前条件での判定
 */
import { describe, expect, it } from 'vitest'
import { emptyNumbers, emptyRecord } from '@shared/business/records'
import type { Condition, Experiment, ExperimentNumbers } from '@shared/business/model'
import {
  acquisitionCost,
  actualBeforeStart,
  cac,
  conditionLabel,
  funnel,
  funnelProblems,
  judge,
  marginAfterDelivery,
  moneyLabel,
  overLimits,
  paybackMonths
} from '@shared/business/experiment'

const NOW = '2026-10-17T09:00:00.000Z'
const nums = (over: Partial<ExperimentNumbers> = {}): ExperimentNumbers => ({ ...emptyNumbers(), ...over })
function exp(over: Partial<Experiment> = {}): Experiment {
  return { ...emptyRecord('experiment', 'X01', NOW), hypothesis: 'H01', ...over }
}
const cond = (metric: Condition['metric'], op: Condition['op'], value: number): Condition => ({ metric, op, value })

describe('獲得費', () => {
  it('どれも未入力なら未計測（0 円にしない）', () => {
    expect(acquisitionCost(nums())).toEqual({ kind: '未計測', reason: '獲得費が未入力' })
  })

  it('広告費・外注費・営業時間×時間単価を足す', () => {
    expect(acquisitionCost(nums({ adCost: 10000, outsourceCost: 5000, salesHours: 2, hourlyCost: 3000 }))).toEqual({ kind: 'value', yen: 21000 })
  })

  it('一部だけ入力でも、入力分を足す', () => {
    expect(acquisitionCost(nums({ adCost: 0 }))).toEqual({ kind: 'value', yen: 0 })
    expect(acquisitionCost(nums({ outsourceCost: 800 }))).toEqual({ kind: 'value', yen: 800 })
  })

  it('営業時間があるのに時間単価が無ければ未計測（他の費用があっても）', () => {
    expect(acquisitionCost(nums({ adCost: 10000, salesHours: 3 }))).toEqual({ kind: '未計測', reason: '営業時間の原価（1時間あたり）が未入力' })
  })

  it('営業時間 0 なら時間単価が無くてもよい', () => {
    expect(acquisitionCost(nums({ adCost: 100, salesHours: 0 }))).toEqual({ kind: 'value', yen: 100 })
  })

  it('時間単価だけあって営業時間が無いなら営業の原価は数えない', () => {
    expect(acquisitionCost(nums({ hourlyCost: 5000 }))).toEqual({ kind: '未計測', reason: '獲得費が未入力' })
  })
})

describe('CAC', () => {
  it('有料顧客数が未入力なら未計測', () => {
    expect(cac(nums({ adCost: 1000 }))).toEqual({ kind: '未計測', reason: '有料顧客数が未入力' })
  })

  it('有料顧客 0 社なら未成立（0 円にしない）', () => {
    const r = cac(nums({ adCost: 0, paid: 0 }))
    expect(r.kind).toBe('未成立')
    expect(moneyLabel(r)).toBe('未成立')
    expect(moneyLabel(r)).not.toContain('0 円')
  })

  it('有料顧客 0 社で費用も未入力でも未成立が先', () => {
    expect(cac(nums({ paid: 0 })).kind).toBe('未成立')
  })

  it('獲得費が未計測なら CAC も未計測', () => {
    expect(cac(nums({ paid: 2 })).kind).toBe('未計測')
    expect(cac(nums({ paid: 2, salesHours: 1 }))).toEqual({ kind: '未計測', reason: '営業時間の原価（1時間あたり）が未入力' })
  })

  it('獲得費 ÷ 有料顧客数を円に丸める', () => {
    expect(cac(nums({ adCost: 10000, paid: 3 }))).toEqual({ kind: 'value', yen: 3333 })
    expect(cac(nums({ adCost: 10000, paid: 6 }))).toEqual({ kind: 'value', yen: 1667 })
    expect(cac(nums({ adCost: 5, paid: 2 }))).toEqual({ kind: 'value', yen: 3 })
  })

  it('獲得費 0 円で顧客がいれば CAC は 0 円（実測の 0 は 0）', () => {
    expect(cac(nums({ adCost: 0, paid: 1 }))).toEqual({ kind: 'value', yen: 0 })
  })
})

describe('提供後に残る額', () => {
  it('売上 − 提供変動費', () => {
    expect(marginAfterDelivery(nums({ revenue: 100000, deliveryCost: 30000 }))).toEqual({ kind: 'value', yen: 70000 })
  })
  it('マイナスもそのまま出す', () => {
    expect(marginAfterDelivery(nums({ revenue: 1000, deliveryCost: 3000 }))).toEqual({ kind: 'value', yen: -2000 })
  })
  it('どちらかが未入力なら未計測', () => {
    expect(marginAfterDelivery(nums({ deliveryCost: 1 })).kind).toBe('未計測')
    expect(marginAfterDelivery(nums({ revenue: 1 })).kind).toBe('未計測')
  })
})

describe('回収月数', () => {
  const base = { adCost: 30000, paid: 1 }
  it('CAC ÷ 月次の提供後利益を小数1桁に丸める', () => {
    expect(paybackMonths(nums({ ...base, monthlyPrice: 10000, monthlyVariableCost: 1000 }))).toEqual({ kind: 'months', months: 3.3 })
    expect(paybackMonths(nums({ ...base, monthlyPrice: 10000, monthlyVariableCost: 0 }))).toEqual({ kind: 'months', months: 3 })
  })
  it('月次の提供後利益が 0 なら回収不能', () => {
    expect(paybackMonths(nums({ ...base, monthlyPrice: 5000, monthlyVariableCost: 5000 })).kind).toBe('回収不能')
  })
  it('月次の提供後利益がマイナスなら回収不能', () => {
    expect(paybackMonths(nums({ ...base, monthlyPrice: 5000, monthlyVariableCost: 6000 })).kind).toBe('回収不能')
  })
  it('CAC が未成立・未計測ならそのまま返す', () => {
    expect(paybackMonths(nums({ adCost: 1, paid: 0, monthlyPrice: 1, monthlyVariableCost: 0 })).kind).toBe('未成立')
    expect(paybackMonths(nums({ monthlyPrice: 1, monthlyVariableCost: 0 })).kind).toBe('未計測')
  })
  it('月額か月次の変動費が未入力なら未計測', () => {
    expect(paybackMonths(nums({ ...base, monthlyPrice: 1000 })).kind).toBe('未計測')
    expect(paybackMonths(nums({ ...base, monthlyVariableCost: 1000 })).kind).toBe('未計測')
  })
  it('表示', () => {
    expect(moneyLabel({ kind: 'months', months: 3.3 })).toBe('約 3.3 か月')
    expect(moneyLabel({ kind: 'value', yen: 1234567 })).toBe('1,234,567 円')
    expect(moneyLabel({ kind: '回収不能', reason: '' })).toBe('回収不能')
    expect(moneyLabel({ kind: '未計測', reason: '' })).toBe('未計測')
  })
})

describe('経路の段ごとの割合', () => {
  it('最初の段は割合なし。前の段で割って小数1桁の％', () => {
    const f = funnel(nums({ contacts: 300, replies: 10, qualified: 3 }))
    expect(f[0]).toEqual({ key: 'contacts', label: '接触', value: 300, rate: null })
    expect(f[1]!.rate).toBe(3.3)
    expect(f[2]!.rate).toBe(30)
    expect(f).toHaveLength(8)
  })
  it('前の段が 0・未計測なら割合を出さない（0 で割らない）', () => {
    const f = funnel(nums({ contacts: 0, replies: 0, priced: 2 }))
    expect(f[1]!.rate).toBeNull()
    expect(f[3]!.rate).toBeNull() // qualified が未計測
    expect(f[2]!.rate).toBeNull() // qualified 自体が未計測
  })
  it('この段が 0 なら割合は 0', () => {
    expect(funnel(nums({ contacts: 10, replies: 0 }))[1]!.rate).toBe(0)
  })
  it('全部未計測なら値も割合も null', () => {
    for (const s of funnel(nums())) {
      expect(s.value).toBeNull()
      expect(s.rate).toBeNull()
    }
  })
})

describe('経路の数の矛盾', () => {
  it('返信が接触より多いと知らせる', () => {
    expect(funnelProblems(nums({ contacts: 5, replies: 6 }))).toEqual(['返信（6）が接触（5）より多い'])
  })
  it('同じ数・少ない数は問題なし', () => {
    expect(funnelProblems(nums({ contacts: 5, replies: 5, qualified: 1, priced: 1, paid: 1 }))).toEqual([])
  })
  it('有料顧客が価格提示より多いと知らせる', () => {
    expect(funnelProblems(nums({ priced: 1, paid: 2 }))).toEqual(['有料顧客（2）が価格提示（1）より多い'])
  })
  it('入金・成果受入は前の段と比べない（入金が有料顧客より多い・受入が入金より多いのはあり得る）', () => {
    expect(funnelProblems(nums({ paid: 1, payments: 3, accepted: 5 }))).toEqual([])
  })
  it('再購入は有料顧客と比べる', () => {
    expect(funnelProblems(nums({ paid: 2, repurchased: 3 }))).toEqual(['再購入（3）が有料顧客（2）より多い'])
    expect(funnelProblems(nums({ paid: 2, payments: 1, accepted: 1, repurchased: 2 }))).toEqual([])
  })
  it('未計測の段とは比べない', () => {
    expect(funnelProblems(nums({ contacts: null, replies: 100, repurchased: 9 }))).toEqual([])
  })
  it('複数の矛盾をすべて返す', () => {
    expect(funnelProblems(nums({ contacts: 1, replies: 2, qualified: 3 }))).toHaveLength(2)
  })
})

describe('事前の条件で判定する（judge）', () => {
  const running = (over: Partial<Experiment>) => exp({ status: '実施中', ...over })

  it('計画のみなら、条件を満たしていても判定できない', () => {
    const j = judge(exp({ status: '計画のみ', pass: [cond('paid', '>=', 0)], actual: nums({ paid: 5 }) }))
    expect(j).toMatchObject({ verdict: '判定できない', reason: '実施前（計画のみ）' })
  })

  it('合格条件が無ければ判定できない', () => {
    const j = judge(running({ stop: [cond('contacts', '>=', 1)], actual: nums({ contacts: 10 }) }))
    expect(j).toMatchObject({ verdict: '判定できない', reason: '合格条件が事前に決められていない' })
  })

  it('中止条件を満たせば、合格条件も満たしていても中止（中止が優先）', () => {
    const j = judge(running({ pass: [cond('paid', '>=', 1)], stop: [cond('cac', '>=', 50000)], actual: nums({ paid: 1, adCost: 60000 }) }))
    expect(j.verdict).toBe('中止')
    expect(j.pass[0]!.state).toBe('満たす')
    expect(j.stop[0]!.state).toBe('満たす')
  })

  it('合格条件をすべて満たせば合格', () => {
    const j = judge(running({ pass: [cond('paid', '>=', 2), cond('cac', '<=', 10000)], stop: [cond('contacts', '>=', 1000)], actual: nums({ contacts: 50, paid: 2, adCost: 10000 }) }))
    expect(j.verdict).toBe('合格')
    expect(j.pass.map((r) => r.state)).toEqual(['満たす', '満たす'])
    expect(j.stop[0]!.state).toBe('満たさない')
  })

  it('境界: >= と <= は等しい値で満たす', () => {
    expect(judge(running({ pass: [cond('paid', '>=', 3)], actual: nums({ paid: 3 }) })).verdict).toBe('合格')
    expect(judge(running({ pass: [cond('paid', '<=', 3)], actual: nums({ paid: 3 }) })).verdict).toBe('合格')
    expect(judge(running({ pass: [cond('paid', '>=', 3)], actual: nums({ paid: 2 }) })).verdict).toBe('判定できない')
  })

  it('合格条件の指標に未計測があれば判定できない', () => {
    const j = judge(running({ pass: [cond('paid', '>=', 1), cond('revenue', '>=', 1)], actual: nums({ paid: 1 }) }))
    expect(j).toMatchObject({ verdict: '判定できない', reason: '合格条件の指標に未計測がある' })
    expect(j.pass.map((r) => r.state)).toEqual(['満たす', '未計測'])
  })

  it('顧客 0 社の CAC 条件は未計測（0 円として合格にしない）', () => {
    const j = judge(running({ pass: [cond('cac', '<=', 10000)], actual: nums({ paid: 0, adCost: 0 }) }))
    expect(j.verdict).toBe('判定できない')
    expect(j.pass[0]!.state).toBe('未計測')
  })

  it('未計測の中止条件は中止にしないが、測れていないまま合格にもしない', () => {
    const j = judge(running({ pass: [cond('paid', '>=', 1)], stop: [cond('cac', '>=', 1)], actual: nums({ paid: 1 }) }))
    expect(j.stop[0]!.state).toBe('未計測')
    expect(j).toMatchObject({ verdict: '判定できない', reason: '中止条件の指標に未計測がある' })
  })

  it('中止条件の1つが満たすなら、他の中止条件が未計測でも中止', () => {
    const j = judge(running({ pass: [cond('paid', '>=', 1)], stop: [cond('cac', '>=', 1), cond('contacts', '<=', 0)], actual: nums({ paid: 1, contacts: 0 }) }))
    expect(j.verdict).toBe('中止')
  })

  it('中止条件がすべて測れて満たさなければ合格', () => {
    const j = judge(running({ pass: [cond('paid', '>=', 1)], stop: [cond('cac', '>=', 100000)], actual: nums({ paid: 1, adCost: 5000 }) }))
    expect(j.verdict).toBe('合格')
  })

  it('合格条件を満たしていないだけなら、続けるよう伝える', () => {
    const j = judge(running({ pass: [cond('paid', '>=', 5)], actual: nums({ paid: 1 }) }))
    expect(j).toMatchObject({ verdict: '判定できない', reason: '合格条件を満たしていない（実施中なら続ける）' })
  })

  it('計画値は判定に使わない（実測だけ）', () => {
    const j = judge(running({ pass: [cond('paid', '>=', 1)], plan: nums({ paid: 10 }), actual: nums() }))
    expect(j.pass[0]!.state).toBe('未計測')
  })

  it('完了・中止の状態でも判定する', () => {
    expect(judge(exp({ status: '完了', pass: [cond('interest', '>=', 1)], actual: nums({ interest: 1 }) })).verdict).toBe('合格')
    expect(judge(exp({ status: '中止', pass: [cond('quoteRequests', '>=', 1)], stop: [cond('contacts', '<=', 0)], actual: nums({ contacts: 0 }) })).verdict).toBe('中止')
  })

  it('条件の表示', () => {
    expect(conditionLabel(cond('paid', '>=', 3))).toBe('有料顧客 ≥ 3')
    expect(conditionLabel(cond('cac', '<=', 50000))).toBe('CAC ≤ 50,000')
    expect(conditionLabel(cond('interest', '>=', 1))).toBe('関心表明 ≥ 1')
    expect(conditionLabel(cond('quoteRequests', '>=', 1))).toBe('見積依頼 ≥ 1')
    expect(conditionLabel(cond('revenue', '>=', 1))).toBe('入金額 ≥ 1')
  })
})

describe('実施前の実測値と上限', () => {
  it('計画のみの実験に実測値があれば、その欄を返す（0 も実測値）', () => {
    expect(actualBeforeStart(exp({ actual: nums({ contacts: 0, revenue: 100 }) }))).toEqual(['contacts', 'revenue'])
  })
  it('計画のみで実測が空なら何も返さない。計画値はいくら入っていてもよい', () => {
    expect(actualBeforeStart(exp({ plan: nums({ contacts: 100 }) }))).toEqual([])
  })
  it('実施中・完了なら実測値があってよい', () => {
    expect(actualBeforeStart(exp({ status: '実施中', actual: nums({ contacts: 1 }) }))).toEqual([])
    expect(actualBeforeStart(exp({ status: '完了', actual: nums({ contacts: 1 }) }))).toEqual([])
  })

  it('費用の上限: 獲得費 + 提供変動費が上限を超えたら知らせる（等しいのは超えない）', () => {
    expect(overLimits(exp({ limits: { yen: 10000, hours: null }, actual: nums({ adCost: 6000, deliveryCost: 4000 }) }))).toEqual([])
    expect(overLimits(exp({ limits: { yen: 10000, hours: null }, actual: nums({ adCost: 6000, deliveryCost: 4001 }) }))).toEqual(['費用 10,001 円が上限 10,000 円を超えた'])
  })
  it('工数の上限', () => {
    expect(overLimits(exp({ limits: { yen: null, hours: 5 }, actual: nums({ salesHours: 5 }) }))).toEqual([])
    expect(overLimits(exp({ limits: { yen: null, hours: 5 }, actual: nums({ salesHours: 5.5 }) }))).toEqual(['工数 5.5 時間が上限 5 時間を超えた'])
  })
  it('上限が未設定なら何も言わない', () => {
    expect(overLimits(exp({ actual: nums({ adCost: 1e9, salesHours: 1e6 }) }))).toEqual([])
  })
  it('獲得費が未計測でも提供変動費だけで上限を見る', () => {
    expect(overLimits(exp({ limits: { yen: 100, hours: null }, actual: nums({ deliveryCost: 101 }) }))).toHaveLength(1)
  })
  it('上限 0 円で費用 0 円は超えない', () => {
    expect(overLimits(exp({ limits: { yen: 0, hours: 0 }, actual: nums({ adCost: 0, salesHours: 0 }) }))).toEqual([])
  })
})
