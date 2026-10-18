/**
 * 需要点 D・獲得点 A・提供条件 P の集計と、独立した当事者の数え方（手法.md 5〜7章）
 */
import { describe, expect, it } from 'vitest'
import { emptyRecord } from '@shared/business/records'
import { UNKNOWN, type AcquisitionKey, type DemandKey, type Evidence, type Hypothesis, type ProvisionKey, type Score, type YesNo } from '@shared/business/model'
import {
  acquisitionTotal,
  countability,
  demandTotal,
  evidenceFor,
  independentParties,
  priorityCheck,
  provisionSummary,
  sourceTypes,
  totalLabel,
  unknownCount
} from '@shared/business/scoring'

const NOW = '2026-10-17T09:00:00.000Z'

function hyp(scores: Partial<Record<DemandKey | AcquisitionKey, Score>> = {}, prov: Partial<Record<ProvisionKey, YesNo>> = {}, id = 'H01'): Hypothesis {
  const h = emptyRecord('hypothesis', id, NOW)
  for (const [k, v] of Object.entries(scores)) {
    if (k.startsWith('D')) h.demand[k as DemandKey].score = v
    else h.acquisition[k as AcquisitionKey].score = v
  }
  for (const [k, v] of Object.entries(prov)) h.provision[k as ProvisionKey].value = v
  return h
}

function ev(id: string, over: Partial<Evidence> = {}): Evidence {
  return { ...emptyRecord('evidence', id, NOW), hypotheses: ['H01'], readStatus: '読了', url: `https://example.com/${id}`, sourceKind: '本人の経験', dupGroup: `g-${id}`, medium: '発注サイト', ...over }
}

const allD = (v: Score) => ({ D1: v, D2: v, D3: v, D4: v, D5: v })
const allA = (v: Score) => ({ A1: v, A2: v, A3: v, A4: v })

describe('需要点 D・獲得点 A の合計', () => {
  it('空の仮説はすべて U なので未完了。U は 5 個、分かっている点は 0', () => {
    expect(demandTotal(hyp())).toEqual({ complete: false, known: 0, unknown: 5, max: 10 })
    expect(acquisitionTotal(hyp())).toEqual({ complete: false, known: 0, unknown: 4, max: 8 })
  })

  it('U が1つでもあれば合計しない（U を 0 として埋めない）', () => {
    const t = demandTotal(hyp({ D1: 2, D2: 2, D3: 2, D4: 2, D5: UNKNOWN }))
    expect(t.complete).toBe(false)
    expect(t).toEqual({ complete: false, known: 8, unknown: 1, max: 10 })
    expect('total' in t).toBe(false)
  })

  it('全部 0 でも完了（0 と U は違う）', () => {
    expect(demandTotal(hyp(allD(0)))).toEqual({ complete: true, total: 0, max: 10 })
    expect(acquisitionTotal(hyp(allA(0)))).toEqual({ complete: true, total: 0, max: 8 })
  })

  it('全部 2 なら D は 10/10、A は 8/8', () => {
    expect(demandTotal(hyp(allD(2)))).toEqual({ complete: true, total: 10, max: 10 })
    expect(acquisitionTotal(hyp(allA(2)))).toEqual({ complete: true, total: 8, max: 8 })
  })

  it('D と A は足さない（D の合計に A は入らず、A の合計に D は入らない）', () => {
    const h = hyp({ ...allD(1), ...allA(2) })
    expect(demandTotal(h)).toEqual({ complete: true, total: 5, max: 10 })
    expect(acquisitionTotal(h)).toEqual({ complete: true, total: 8, max: 8 })
  })

  it('A が U でも D の完了には影響しない', () => {
    const h = hyp({ ...allD(2), A4: UNKNOWN })
    expect(demandTotal(h).complete).toBe(true)
    expect(acquisitionTotal(h)).toEqual({ complete: false, known: 0, unknown: 4, max: 8 })
  })

  it('表示は「n / 満点」か「未完了（U 残り n）」', () => {
    expect(totalLabel({ complete: true, total: 7, max: 10 })).toBe('7 / 10')
    expect(totalLabel({ complete: false, known: 3, unknown: 2, max: 8 })).toBe('未完了（U 残り 2）')
    expect(totalLabel(demandTotal(hyp({ D1: 2 })))).toBe('未完了（U 残り 4）')
  })
})

describe('提供条件 P と U の残り', () => {
  it('P は はい／いいえ／U のまま数える', () => {
    expect(provisionSummary(hyp())).toEqual({ yes: 0, no: 0, unknown: 4 })
    expect(provisionSummary(hyp({}, { P1: 'はい', P2: 'はい', P3: 'いいえ' }))).toEqual({ yes: 2, no: 1, unknown: 1 })
  })

  it('U の残りは D・A・P の合計（空なら 13）', () => {
    expect(unknownCount(hyp())).toBe(13)
    expect(unknownCount(hyp({ ...allD(0), ...allA(1) }, { P1: 'いいえ', P2: 'はい', P3: 'はい', P4: 'はい' }))).toBe(0)
    expect(unknownCount(hyp({ D1: 2, A1: 0 }, { P4: 'いいえ' }))).toBe(10)
  })
})

describe('独立した当事者として数えるか', () => {
  it('読了・URL あり・本人の経験・重複グループありなら数える', () => {
    expect(countability(ev('E01'))).toEqual({ counts: true })
  })

  it('発注・伝聞も数える', () => {
    expect(countability(ev('E01', { sourceKind: '発注' })).counts).toBe(true)
    expect(countability(ev('E01', { sourceKind: '伝聞' })).counts).toBe(true)
  })

  it.each([
    ['発見のみ', { readStatus: '発見のみ' as const }, '発見のみ'],
    ['URL が空', { url: '' }, 'URL'],
    ['URL が空白だけ', { url: '   ' }, 'URL'],
    ['販売者の説明', { sourceKind: '販売者の説明' as const }, '販売者'],
    ['分析者の推測', { sourceKind: '分析者の推測' as const }, '推測'],
    ['重複グループが U', { dupGroup: 'U' }, '重複グループ'],
    ['重複グループが小文字の u', { dupGroup: 'u' }, '重複グループ'],
    ['重複グループが空', { dupGroup: '' }, '重複グループ'],
    ['重複グループが空白だけ', { dupGroup: '  ' }, '重複グループ'],
    ['重複グループが前後空白つきの U', { dupGroup: ' U ' }, '重複グループ']
  ])('%s は数えず、理由を返す', (_name, over, reason) => {
    const r = countability(ev('E01', over))
    expect(r.counts).toBe(false)
    if (!r.counts) expect(r.reason).toContain(reason)
  })

  it('発見のみは他の条件より先に理由になる', () => {
    const r = countability(ev('E01', { readStatus: '発見のみ', url: '', sourceKind: '分析者の推測', dupGroup: 'U' }))
    expect(r).toEqual({ counts: false, reason: '原典を読めていない（発見のみ）' })
  })

  it('sourceKind が U でも、他を満たせば数える（未分類は除外理由にならない）', () => {
    expect(countability(ev('E01', { sourceKind: UNKNOWN })).counts).toBe(true)
  })
})

describe('独立当事者の数と原典の種類', () => {
  it('同じ重複グループは1つとして数える（前後の空白は同じとみなす）', () => {
    const list = [ev('E01', { dupGroup: 'A社' }), ev('E02', { dupGroup: 'A社' }), ev('E03', { dupGroup: ' A社 ' }), ev('E04', { dupGroup: 'B社' })]
    expect(independentParties('H01', list)).toBe(2)
  })

  it('数えない証拠（発見のみ・URL なし・販売者・推測・U）は足さない', () => {
    const list = [
      ev('E01'),
      ev('E02', { readStatus: '発見のみ' }),
      ev('E03', { url: '' }),
      ev('E04', { sourceKind: '販売者の説明' }),
      ev('E05', { sourceKind: '分析者の推測' }),
      ev('E06', { dupGroup: 'U' }),
      ev('E07', { dupGroup: '' })
    ]
    expect(independentParties('H01', list)).toBe(1)
  })

  it('別の仮説に結びついた証拠は数えない', () => {
    const list = [ev('E01'), ev('E02', { hypotheses: ['H02'] }), ev('E03', { hypotheses: [] }), ev('E04', { hypotheses: ['H01', 'H02'] })]
    expect(independentParties('H01', list)).toBe(2)
    expect(independentParties('H02', list)).toBe(2)
    expect(independentParties('H03', list)).toBe(0)
    expect(evidenceFor('H01', list).map((e) => e.id)).toEqual(['E01', 'E04'])
  })

  it('証拠が無ければ 0', () => {
    expect(independentParties('H01', [])).toBe(0)
    expect(sourceTypes('H01', [])).toBe(0)
  })

  it('原典の種類は数えられる証拠の媒体の種類（空の媒体・数えない証拠の媒体は入れない）', () => {
    const list = [
      ev('E01', { medium: '発注サイト' }),
      ev('E02', { medium: ' 発注サイト ' }),
      ev('E03', { medium: 'レビューサイト' }),
      ev('E04', { medium: '' }),
      ev('E05', { medium: 'X', readStatus: '発見のみ' }),
      ev('E06', { medium: 'note', hypotheses: ['H02'] })
    ]
    expect(sourceTypes('H01', list)).toBe(2)
  })
})

describe('追加調査を優先する目安（priorityCheck）の境界', () => {
  const strongD = { D1: 2, D2: 2, D3: 2, D4: 2, D5: 0 } as const // 合計 8
  const three = [ev('E01', { medium: '発注サイト' }), ev('E02', { medium: 'レビューサイト' }), ev('E03', { medium: '発注サイト' })]

  it('D 合計 8・D2〜D4 が 2・当事者 3・種類 2 なら満たす', () => {
    expect(priorityCheck(hyp(strongD), three)).toEqual({ meets: true, missing: [] })
  })

  it('D 合計 7 では満たさない（8 が境界）', () => {
    const r = priorityCheck(hyp({ D1: 1, D2: 2, D3: 2, D4: 2, D5: 0 }), three)
    expect(r.meets).toBe(false)
    expect(r.missing).toEqual(['D の合計が 7（8 以上が目安）'])
  })

  it('D に U があれば合計の代わりに U の数を出す（U を 0 にして 8 未満と言わない）', () => {
    const r = priorityCheck(hyp({ D1: UNKNOWN, D2: 2, D3: 2, D4: 2, D5: 2 }), three)
    expect(r.missing).toEqual(['D に U が 1 個残っている'])
  })

  it.each(['D2', 'D3', 'D4'] as const)('%s が 1 だと合計 8 以上でも満たさない', (k) => {
    const r = priorityCheck(hyp({ ...allD(2), [k]: 1 }), three)
    expect(r.meets).toBe(false)
    expect(r.missing).toEqual([`${k} が 2 でない`])
  })

  it('D2 が U のときは U と 2 でないの両方を出す', () => {
    const r = priorityCheck(hyp({ ...allD(2), D2: UNKNOWN }), three)
    expect(r.missing).toEqual(['D に U が 1 個残っている', 'D2 が 2 でない'])
  })

  it('独立当事者 2 では満たさない（3 が境界）', () => {
    const r = priorityCheck(hyp(strongD), three.slice(0, 2))
    expect(r.missing).toEqual(['独立当事者が 2（3 以上が目安）'])
  })

  it('同じ重複グループの 3 件は当事者 1 として扱う', () => {
    const dup = three.map((e) => ({ ...e, dupGroup: '同じ会社' }))
    expect(priorityCheck(hyp(strongD), dup).missing).toEqual(['独立当事者が 1（3 以上が目安）'])
  })

  it('原典の種類 1 では満たさない（2 が境界）', () => {
    const one = three.map((e) => ({ ...e, medium: 'X' }))
    expect(priorityCheck(hyp(strongD), one).missing).toEqual(['原典の種類が 1（2 以上が目安）'])
  })

  it('空の仮説・証拠なしでは全部の不足を出す', () => {
    const r = priorityCheck(hyp(), [])
    expect(r.meets).toBe(false)
    expect(r.missing).toEqual(['D に U が 5 個残っている', 'D2 が 2 でない', 'D3 が 2 でない', 'D4 が 2 でない', '独立当事者が 0（3 以上が目安）', '原典の種類が 0（2 以上が目安）'])
  })

  it('A（獲得点）は目安に関係しない', () => {
    expect(priorityCheck(hyp({ ...strongD, ...allA(0) }), three).meets).toBe(true)
  })
})
