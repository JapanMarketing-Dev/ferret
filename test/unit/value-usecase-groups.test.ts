import { describe, expect, it } from 'vitest'
import { AUTO_GROUPS_MAX, GROUP_FROM_VALUES, VALUE_LIMITS, groupValues, parseValueUseCase, type ValueUseCaseDoc } from '../../src/shared/valueUseCase'
import { valueGroupRef } from '../../src/shared/reviewRefs'
import { renderValueUseCaseSkill } from '../../src/shared/valueUseCaseSkill'

const VALUE_USECASE_SKILL_BODY = renderValueUseCaseSkill('0.0.0')

/** 価値ユースケースのグループ（数百の価値を 10〜30 のグループでざっくりレビューする） */

const value = (i: number, extra: Record<string, unknown> = {}) => ({ id: `v${i}`, name: `価値 ${i}`, who: '利用者', ...extra })

function parse(raw: Record<string, unknown>): ValueUseCaseDoc {
  const parsed = parseValueUseCase({ title: 'App', status: 'proposed', ...raw }, 'app')
  if (!parsed.ok) throw new Error(parsed.reason)
  return parsed.doc
}

describe('groups を読む', () => {
  it('グループと価値の group を読み、id でも名前でも（大文字・小文字を問わず）つなぐ', () => {
    const doc = parse({
      groups: [{ id: 'billing', name: 'Billing', summary: '請求' }, { name: '設定' }],
      values: [value(1, { group: 'billing' }), value(2, { group: 'BILLING' }), value(3, { group: '設定' }), value(4, { group: 'nope' }), value(5)]
    })
    expect(doc.groups).toEqual([{ id: 'billing', name: 'Billing', summary: '請求' }, { id: 'g2', name: '設定', summary: '' }])
    expect(doc.values.map((v) => v.group)).toEqual(['billing', 'billing', 'g2', undefined, undefined])
  })

  it('名前の無いグループ・おかしな値は外し、重なった id には番号を付ける', () => {
    const doc = parse({ groups: [{ id: 'a', name: 'A' }, { id: 'a', name: 'A2' }, { id: 'x' }, 'str', null, { id: '../bad', name: 'B' }], values: [value(1, { group: 'a-2' })] })
    expect(doc.groups.map((g) => g.id)).toEqual(['a', 'a-2', 'g6'])
    expect(doc.values[0]!.group).toBe('a-2')
  })

  it('groups が無い・配列でなければ空。価値の group も消す', () => {
    expect(parse({ values: [value(1, { group: 'a' })] }).values[0]!.group).toBeUndefined()
    expect(parse({ groups: 'x', values: [value(1)] }).groups).toEqual([])
  })

  it('グループは上限まで', () => {
    const groups = Array.from({ length: VALUE_LIMITS.groups + 10 }, (_, i) => ({ id: `g${i}`, name: `G${i}` }))
    expect(parse({ groups, values: [value(1)] }).groups).toHaveLength(VALUE_LIMITS.groups)
  })
})

describe('groupValues', () => {
  it('文書のグループを書いた順に。空のグループは外し、入らない価値は最後の「その他」', () => {
    const doc = parse({
      groups: [{ id: 'a', name: 'A' }, { id: 'empty', name: 'E' }, { id: 'b', name: 'B' }],
      values: [value(1, { group: 'b', status: 'works' }), value(2, { group: 'a' }), value(3), value(4, { group: 'b', status: 'broken' })]
    })
    const views = groupValues(doc)!
    expect(views.map((v) => [v.key, v.source, v.indices])).toEqual([['doc:a', 'doc', [1]], ['doc:b', 'doc', [0, 3]], ['other', 'other', [2]]])
    expect(views[1]!.groupIndex).toBe(2)
    expect(views[1]!.stats).toMatchObject({ values: 2, works: 1, broken: 1 })
  })

  it('文書のグループがあれば、価値が少なくても分ける', () => {
    expect(groupValues(parse({ groups: [{ id: 'a', name: 'A' }], values: [value(1, { group: 'a' })] }))).toHaveLength(1)
  })

  it('グループが無く価値が少なければ分けない（境目）', () => {
    const few = parse({ values: Array.from({ length: GROUP_FROM_VALUES - 1 }, (_, i) => value(i, { who: `役${i % 3}` })) })
    expect(groupValues(few)).toBeNull()
    const enough = parse({ values: Array.from({ length: GROUP_FROM_VALUES }, (_, i) => value(i, { who: `役${i % 3}` })) })
    expect(groupValues(enough)!.map((v) => v.source)).toEqual(['who', 'who', 'who'])
  })

  it('自動: 誰が（who）が 2〜30 種類ならそれで分ける', () => {
    const doc = parse({ values: Array.from({ length: 300 }, (_, i) => value(i, { who: `役${i % AUTO_GROUPS_MAX}` })) })
    const views = groupValues(doc)!
    expect(views).toHaveLength(AUTO_GROUPS_MAX)
    expect(views[0]).toMatchObject({ key: 'who:役0', name: '役0', source: 'who' })
    expect(views.reduce((n, v) => n + v.indices.length, 0)).toBe(300)
  })

  it('自動: who が1種類・31種類以上・空があれば、書いた順に 30 以下に区切る（1つは 10 以上）', () => {
    const one = groupValues(parse({ values: Array.from({ length: 400 }, (_, i) => value(i)) }))!
    expect(one.every((v) => v.source === 'range')).toBe(true)
    expect(one.length).toBeLessThanOrEqual(AUTO_GROUPS_MAX)
    expect(one[0]!.indices).toHaveLength(14)
    expect(one.flatMap((v) => v.indices)).toEqual(Array.from({ length: 400 }, (_, i) => i))

    const many = groupValues(parse({ values: Array.from({ length: 40 }, (_, i) => value(i, { who: `役${i}` })) }))!
    expect(many.map((v) => v.indices.length)).toEqual([10, 10, 10, 10])

    const blank = groupValues(parse({ values: Array.from({ length: 20 }, (_, i) => value(i, { who: i % 2 ? '役' : '' })) }))!
    expect(blank.map((v) => v.source)).toEqual(['range', 'range'])

    const thousand = groupValues(parse({ values: Array.from({ length: 1000 }, (_, i) => value(i)) }))!
    expect(thousand.length).toBeLessThanOrEqual(AUTO_GROUPS_MAX)
  })
})

describe('グループの場所のコピー', () => {
  it('文書のグループ・who・区切り・その他', () => {
    const doc = '/p/.ferret/value-usecases/app.json'
    expect(valueGroupRef(doc, { source: 'doc', groupIndex: 2, indices: [0], key: 'doc:b' }, 'Billing', 'b')).toBe(`${doc} → groups[2] (id: b) "Billing"`)
    expect(valueGroupRef(doc, { source: 'who', indices: [0, 4], key: 'who:x' }, '管理者')).toBe(`${doc} → values[who="管理者"] (2)`)
    expect(valueGroupRef(doc, { source: 'range', indices: [14, 15, 27], key: 'range:14' }, '')).toBe(`${doc} → values[14..27]`)
    expect(valueGroupRef(doc, { source: 'other', indices: [1, 2, 3], key: 'other' }, '')).toBe(`${doc} → values without a group (3)`)
  })
})

describe('skill', () => {
  it('グループを必ず書くよう伝える（10〜30・価値の group）', () => {
    expect(VALUE_USECASE_SKILL_BODY).toContain('10–30')
    expect(VALUE_USECASE_SKILL_BODY).toContain('"group": "billing"')
    expect(VALUE_USECASE_SKILL_BODY).toContain('add them')
  })
})
