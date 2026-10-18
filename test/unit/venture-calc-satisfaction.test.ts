/**
 * 顧客満足のまとめ（NPS・CSAT・インタビュー・多いタグ）
 */
import { describe, expect, it } from 'vitest'
import type { SatisfactionResponse } from '../../src/shared/venture/model'
import { satisfactionSummary } from '../../src/shared/venture/satisfaction'

let n = 0
const res = (method: SatisfactionResponse['method'], score?: number, patch: Partial<SatisfactionResponse> = {}): SatisfactionResponse => ({
  id: `R${++n}`,
  date: '2026-10-05',
  method,
  ...(score === undefined ? {} : { score }),
  ...patch
})
const nps = (...scores: number[]) => satisfactionSummary(scores.map((s) => res('nps', s)))

describe('NPS', () => {
  it('回答が無ければ null、件数は 0', () => {
    expect(satisfactionSummary([])).toEqual({
      responses: 0,
      nps: null,
      npsResponses: 0,
      promoters: 0,
      passives: 0,
      detractors: 0,
      csat: null,
      interviews: 0,
      topTags: []
    })
  })
  it('推奨者(9-10)% − 批判者(0-6)%', () => {
    const s = nps(10, 9, 8, 7, 6, 0)
    expect(s.promoters).toBe(2)
    expect(s.passives).toBe(2)
    expect(s.detractors).toBe(2)
    expect(s.nps).toBe(0)
  })
  it('境界: 9 は推奨者、8・7 は中立、6 は批判者', () => {
    expect(nps(9).nps).toBe(100)
    expect(nps(8).nps).toBe(0)
    expect(nps(7).passives).toBe(1)
    expect(nps(6).nps).toBe(-100)
  })
  it('全員推奨者で 100、全員批判者で -100', () => {
    expect(nps(10, 10, 9).nps).toBe(100)
    expect(nps(0, 1, 2).nps).toBe(-100)
  })
  it('整数に四捨五入（2/3 → 67、1/3 → 33）', () => {
    expect(nps(10, 10, 8).nps).toBe(67)
    expect(nps(10, 8, 8).nps).toBe(33)
    expect(nps(0, 8, 8).nps).toBe(-33)
  })
  it('-0 にならない', () => {
    const s = nps(10, 0, 8, 8, 8, 8, 8, 8)
    expect(Object.is(s.nps, -0)).toBe(false)
    expect(s.nps).toBe(0)
  })
  it('範囲外・NaN・Infinity・文字・score なしは数えない（回答の件数には入る）', () => {
    const s = satisfactionSummary([
      res('nps', 11),
      res('nps', -1),
      res('nps', Number.NaN),
      res('nps', Number.POSITIVE_INFINITY),
      res('nps', '9' as unknown as number),
      res('nps'),
      res('nps', 10)
    ])
    expect(s.responses).toBe(7)
    expect(s.npsResponses).toBe(1)
    expect(s.nps).toBe(100)
  })
  it('csat の回答は NPS に入れない', () => {
    expect(satisfactionSummary([res('csat', 5)]).nps).toBe(null)
  })
})

describe('CSAT・インタビュー', () => {
  it('1〜5 の平均を小数1桁', () => {
    expect(satisfactionSummary([res('csat', 5), res('csat', 4), res('csat', 4)]).csat).toBe(4.3)
    expect(satisfactionSummary([res('csat', 1)]).csat).toBe(1)
    expect(satisfactionSummary([res('csat', 5), res('csat', 4)]).csat).toBe(4.5)
  })
  it('範囲外（0・6）は数えない。全部外なら null', () => {
    expect(satisfactionSummary([res('csat', 0), res('csat', 6)]).csat).toBe(null)
    expect(satisfactionSummary([res('csat', 0), res('csat', 3)]).csat).toBe(3)
  })
  it('インタビューの数。survey は数だけ', () => {
    const s = satisfactionSummary([res('interview'), res('interview'), res('survey', 3)])
    expect(s.interviews).toBe(2)
    expect(s.responses).toBe(3)
    expect(s.csat).toBe(null)
  })
})

describe('タグ', () => {
  it('多い順、同じなら文字の順で上位5件', () => {
    const tags = [['価格', 'UI'], ['価格'], ['速さ', 'UI'], ['価格', 'サポート'], ['a'], ['b'], ['c']]
    const s = satisfactionSummary(tags.map((t) => res('survey', undefined, { tags: t })))
    expect(s.topTags).toEqual([
      { tag: '価格', count: 3 },
      { tag: 'UI', count: 2 },
      { tag: 'a', count: 1 },
      { tag: 'b', count: 1 },
      { tag: 'c', count: 1 }
    ])
  })
  it('前後の空白を除き、空・文字でないタグは除く。1回答の重複は1回', () => {
    const s = satisfactionSummary([res('survey', undefined, { tags: [' 価格 ', '価格', '', '  ', 3 as unknown as string] })])
    expect(s.topTags).toEqual([{ tag: '価格', count: 1 }])
  })
  it('tags が配列でなくても壊れない', () => {
    expect(satisfactionSummary([res('survey', undefined, { tags: 'x' as unknown as string[] })]).topTags).toEqual([])
  })
})

describe('期間', () => {
  const list = [res('nps', 10, { date: '2026-09-30' }), res('nps', 0, { date: '2026-10-01' }), res('nps', 10, { date: '2026-10-31T23:00:00+09:00' }), res('nps', 10, { date: 'bad' })]
  it('期間の端を含む（日時は先頭の日付）', () => {
    const s = satisfactionSummary(list, { from: '2026-10-01', to: '2026-10-31' })
    expect(s.responses).toBe(2)
    expect(s.nps).toBe(0)
  })
  it('期間が無ければ全部（日付の読めない回答も）', () => {
    expect(satisfactionSummary(list).responses).toBe(4)
    expect(satisfactionSummary(list, null).responses).toBe(4)
  })
  it('壊れた回答・配列でない入力でも落ちない', () => {
    expect(satisfactionSummary([null as unknown as SatisfactionResponse, res('csat', 4)]).responses).toBe(1)
    expect(satisfactionSummary(undefined as unknown as SatisfactionResponse[]).responses).toBe(0)
  })
})
