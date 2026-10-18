/**
 * 成立条件の表（knowledge.md 第2部 8章）: 支持・反証・独立数・警告
 */
import { describe, expect, it } from 'vitest'
import { CONDITION_KEYS, type ConditionRow, type ResearchData } from '@shared/research/model'
import { CONDITION_PRINCIPLES, conditionSignal, conditionTable, emptyConditionRow, hasCriticalCounter } from '@shared/research/conditions'
import { conditionRow, conditions, emptyData, fullCandidate, fullData, fullEvidence, reading } from './research-fixtures'

const ev = (id: string, host: string, patch: Parameters<typeof fullEvidence>[1] = {}) => fullEvidence(id, { url: `https://${host}/${id}`, ...patch })
const data = (list: ReturnType<typeof fullEvidence>[]): ResearchData => emptyData({ evidence: list })

describe('conditionSignal', () => {
  it('空の行: 0 件・unverified・警告なし', () => {
    expect(conditionSignal(emptyConditionRow(), fullData())).toEqual({ support: 0, counter: 0, supportIndependent: 0, counterIndependent: 0, status: 'unverified', alarm: false })
  })

  it('支持・反証の数と独立した出どころの数', () => {
    const d = data([ev('E001', 'a.com'), ev('E002', 'a.com'), ev('E003', 'b.com'), ev('E004', 'c.com')])
    const s = conditionSignal(conditionRow({ support: ['E001', 'E002', 'E003'], counter: ['E004'], status: 'mixed' }), d)
    expect(s).toEqual({ support: 3, counter: 1, supportIndependent: 2, counterIndependent: 1, status: 'mixed', alarm: true })
  })

  it('同じ dupGroup（転載）は別のホストでも1つ', () => {
    const d = data([ev('E001', 'a.com', { dupGroup: 'press-1' }), ev('E002', 'b.com', { dupGroup: ' PRESS-1 ' }), ev('E003', 'c.com')])
    expect(conditionSignal(conditionRow({ support: ['E001', 'E002', 'E003'] }), d).supportIndependent).toBe(2)
  })

  it('知らない ID・AI の推測・URL 無し・対象違い・古い事例は数えない', () => {
    const d = data([
      ev('E001', 'a.com', { grade: 'aiInference' }),
      ev('E002', 'b.com', { url: '' }),
      ev('E003', 'c.com', { reading: reading('ok', { match: 'ng' }) }),
      ev('E004', 'd.com', { reading: reading('ok', { timing: 'ng' }) })
    ])
    const s = conditionSignal(conditionRow({ support: ['E001', 'E002', 'E999'], counter: ['E003', 'E004'] }), d)
    expect(s.support).toBe(0)
    expect(s.counter).toBe(0)
    expect(s.alarm).toBe(false)
  })

  it('ID の重複は1件', () => {
    const d = data([ev('E001', 'a.com')])
    expect(conditionSignal(conditionRow({ support: ['E001', 'E001'], counter: ['E001', 'E001'] }), d)).toMatchObject({ support: 1, counter: 1 })
  })

  it('同じ証拠を支持と反証の両方に置けば両方に数え、警告を出す', () => {
    const s = conditionSignal(conditionRow({ support: ['E001'], counter: ['E001'], status: 'supported' }), data([ev('E001', 'a.com')]))
    expect(s).toMatchObject({ support: 1, counter: 1, alarm: true })
  })

  it('人が refuted とすれば証拠が無くても警告', () => {
    expect(conditionSignal(conditionRow({ status: 'refuted' }), emptyData()).alarm).toBe(true)
  })

  it('supported でも反証の証拠があれば警告は消えない', () => {
    expect(conditionSignal(conditionRow({ counter: ['E001'], status: 'supported' }), data([ev('E001', 'a.com')])).alarm).toBe(true)
  })

  it('壊れた判定は unverified、壊れた並びは空として扱う', () => {
    expect(conditionSignal(conditionRow({ status: 'yes' as never }), emptyData()).status).toBe('unverified')
    const broken = { support: 'E001', counter: [null, 3, 'E001'], status: null } as unknown as ConditionRow
    expect(conditionSignal(broken, data([ev('E001', 'a.com')]))).toMatchObject({ support: 0, counter: 1, status: 'unverified' })
    expect(conditionSignal(null as never, emptyData())).toMatchObject({ support: 0, counter: 0, alarm: false })
    expect(conditionSignal(conditionRow({ support: ['E001'] }), { evidence: null } as never).support).toBe(0)
  })

  it('大量の証拠でも独立数がそろう', () => {
    const list = Array.from({ length: 2000 }, (_, i) => ev(`E${i}`, `h${i % 9}.example.com`))
    expect(conditionSignal(conditionRow({ support: list.map((e) => e.id) }), data(list))).toMatchObject({ support: 2000, supportIndependent: 9 })
  })
})

describe('conditionTable・hasCriticalCounter', () => {
  it('5条件が CONDITION_KEYS の順に並ぶ', () => {
    const t = conditionTable(fullCandidate('C001'), fullData())
    expect(t.map((r) => r.key)).toEqual([...CONDITION_KEYS])
    expect(t.every((r) => r.signal.status === 'supported' && r.signal.support === 2 && !r.signal.alarm)).toBe(true)
  })

  it('欠けた行は空の行で埋める', () => {
    const c = fullCandidate('C001', { conditions: { problemStrong: conditionRow({ status: 'supported' }) } as never })
    const t = conditionTable(c, fullData())
    expect(t[1].row).toEqual(emptyConditionRow())
    expect(conditionTable({ id: 'C001' } as never, emptyData())).toHaveLength(5)
  })

  it('反証のある条件・refuted の条件を返す（順は CONDITION_KEYS）', () => {
    const c = fullCandidate('C001', { conditions: conditions({}, { revenue: { counter: ['E002'] }, targetAndScene: { status: 'refuted' } }) })
    expect(hasCriticalCounter(c, fullData())).toEqual(['targetAndScene', 'revenue'])
  })

  it('反証が無ければ空', () => {
    expect(hasCriticalCounter(fullCandidate('C001'), fullData())).toEqual([])
    expect(hasCriticalCounter(fullCandidate('C001', { conditions: conditions({ status: 'mixed' }) }), fullData())).toEqual([])
  })

  it('条件ごとの原則の対応はすべての条件にある', () => {
    for (const k of CONDITION_KEYS) expect(CONDITION_PRINCIPLES[k]).toMatch(/^(who|what|where|why|how)$/)
  })
})
