/**
 * 無料から有料へのつながりの採算（knowledge.md 第2部 原則⑤）
 */
import { describe, expect, it } from 'vitest'
import type { Monetization } from '@shared/research/model'
import { breakEvenRate, conversionRates, expectedMargin, monetizationTable } from '@shared/research/monetization'
import { blankMonetization, monetization } from './research-fixtures'

const BAD = [NaN, Infinity, -Infinity, -1, null] as const

describe('expectedMargin', () => {
  it('ナレッジの例: 0.5% → 1,500円（−4,500円）/ 2% → 6,000円（0円）/ 5% → 15,000円（＋9,000円）', () => {
    const m = monetization()
    expect(expectedMargin(m, 0.005)).toEqual({ expected: 1500, net: -4500 })
    expect(expectedMargin(m, 0.02)).toEqual({ expected: 6000, net: 0 })
    expect(expectedMargin(m, 0.05)).toEqual({ expected: 15000, net: 9000 })
  })

  it('率 0 と 1 は範囲内', () => {
    expect(expectedMargin(monetization(), 0)).toEqual({ expected: 0, net: -6000 })
    expect(expectedMargin(monetization(), 1)).toEqual({ expected: 300000, net: 294000 })
  })

  it.each([...BAD, 1.01, '0.02'])('率が %s なら null', (rate) => {
    expect(expectedMargin(monetization(), rate as number)).toEqual({ expected: null, net: null })
  })

  it.each(BAD)('限界利益が %s なら両方 null', (v) => {
    expect(expectedMargin(monetization({ marginPerDeal: v as number }), 0.02)).toEqual({ expected: null, net: null })
  })

  it.each(BAD)('対応費が %s なら差し引きだけ null', (v) => {
    expect(expectedMargin(monetization({ costPerFreeUser: v as number }), 0.02)).toEqual({ expected: 6000, net: null })
  })

  it('対応費 0 なら期待値がそのまま差し引き', () => {
    expect(expectedMargin(monetization({ costPerFreeUser: 0 }), 0.02)).toEqual({ expected: 6000, net: 6000 })
  })

  it('巨大値でも丸めであふれさせない', () => {
    expect(expectedMargin(monetization({ marginPerDeal: Number.MAX_VALUE, costPerFreeUser: 0 }), 1)).toEqual({ expected: Number.MAX_VALUE, net: Number.MAX_VALUE })
  })

  it('壊れた入力', () => {
    expect(expectedMargin(null as never, 0.02)).toEqual({ expected: null, net: null })
    expect(expectedMargin(blankMonetization(), 0.02)).toEqual({ expected: null, net: null })
  })
})

describe('conversionRates・monetizationTable', () => {
  it('重複・範囲外を除いて昇順', () => {
    expect(conversionRates([0.05, 0.005, 0.02, 0.02, -0.1, 1.5, NaN, Infinity, '0.1', null, 0, 1])).toEqual([0, 0.005, 0.02, 0.05, 1])
    expect(conversionRates(undefined)).toEqual([])
    expect(conversionRates('0.02')).toEqual([])
  })

  it('ナレッジの例の表（損益分岐は 0 以上）', () => {
    expect(monetizationTable(monetization({ conversionScenarios: [0.05, 0.005, 0.02, 0.005] }))).toEqual([
      { rate: 0.005, expected: 1500, net: -4500, breakEven: false },
      { rate: 0.02, expected: 6000, net: 0, breakEven: true },
      { rate: 0.05, expected: 15000, net: 9000, breakEven: true }
    ])
  })

  it('対応費が未確認なら breakEven は false', () => {
    expect(monetizationTable(monetization({ costPerFreeUser: null }))[2]).toEqual({ rate: 0.05, expected: 15000, net: null, breakEven: false })
  })

  it('仮定が無い・壊れた入力は空', () => {
    expect(monetizationTable(monetization({ conversionScenarios: [] }))).toEqual([])
    expect(monetizationTable(null as never)).toEqual([])
    expect(monetizationTable({ ...monetization(), conversionScenarios: null } as unknown as Monetization)).toEqual([])
  })
})

describe('breakEvenRate', () => {
  it('ナレッジの例: 6,000 ÷ 300,000 = 2%', () => {
    expect(breakEvenRate(monetization())).toEqual({ rate: 0.02, reachable: true })
  })

  it('対応費 0 なら 0%', () => {
    expect(breakEvenRate(monetization({ costPerFreeUser: 0 }))).toEqual({ rate: 0, reachable: true })
  })

  it('ちょうど 100% は届く、超えると到達不能（値はそのまま返す）', () => {
    expect(breakEvenRate(monetization({ costPerFreeUser: 300000 }))).toEqual({ rate: 1, reachable: true })
    expect(breakEvenRate(monetization({ costPerFreeUser: 600000 }))).toEqual({ rate: 2, reachable: false })
  })

  it('限界利益が 0・負・未確認なら null', () => {
    for (const v of [0, ...BAD]) expect(breakEvenRate(monetization({ marginPerDeal: v as number }))).toEqual({ rate: null, reachable: null })
  })

  it('対応費が負・未確認なら null', () => {
    for (const v of BAD) expect(breakEvenRate(monetization({ costPerFreeUser: v as number }))).toEqual({ rate: null, reachable: null })
  })

  it('割り算があふれれば null', () => {
    expect(breakEvenRate(monetization({ marginPerDeal: Number.MIN_VALUE, costPerFreeUser: Number.MAX_VALUE }))).toEqual({ rate: null, reachable: null })
  })

  it('壊れた入力', () => {
    expect(breakEvenRate(null as never)).toEqual({ rate: null, reachable: null })
  })
})
