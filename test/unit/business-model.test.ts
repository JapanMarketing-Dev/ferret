/**
 * 型と定数（ID の形、次の ID、ステップの定義）
 */
import { describe, expect, it } from 'vitest'
import {
  ACQUISITION_KEYS,
  CONDITION_METRICS,
  DEMAND_KEYS,
  FUNNEL_KEYS,
  FUNNEL_LABELS,
  PHASE_GOALS,
  PROVISION_KEYS,
  RECORD_KINDS,
  RECORD_KIND_LIST,
  SCORE_LABELS,
  STAGES,
  STAGE_EXIT,
  STEPS,
  STEP_IDS,
  UNKNOWN,
  idPattern,
  isRecordId,
  isStepId,
  nextId,
  stepById
} from '@shared/business/model'

describe('次の ID', () => {
  it('記録が無ければ 01', () => {
    expect(nextId('hypothesis', [])).toBe('H01')
    expect(nextId('alternative', [])).toBe('ALT01')
    expect(nextId('approval', [])).toBe('R01')
  })

  it('最大 + 1。隙間は埋めない（使い回さない）', () => {
    expect(nextId('evidence', ['E01', 'E05', 'E02'])).toBe('E06')
  })

  it('99 の次は 100、999 の次は 1000', () => {
    expect(nextId('evidence', ['E99'])).toBe('E100')
    expect(nextId('evidence', ['E999'])).toBe('E1000')
    expect(nextId('evidence', ['E0099'])).toBe('E100')
  })

  it('形の違う ID は無視する', () => {
    expect(nextId('evidence', ['E1', 'E12345', 'e09', 'H50', 'E', 'E0x', ' E07', 'E07 ', 'ALT09'])).toBe('E01')
  })

  it('別の種類の頭文字の ID を数えない（ALT と A、E と X）', () => {
    expect(nextId('alternative', ['ALT02', 'A99'])).toBe('ALT03')
    expect(nextId('experiment', ['X01', 'E50'])).toBe('X02')
  })

  it('9999 を超えるなら止める', () => {
    expect(nextId('evidence', ['E9998'])).toBe('E9999')
    expect(() => nextId('evidence', ['E9999'])).toThrow(/上限（E9999）/)
  })
})

describe('ID の形', () => {
  it.each(RECORD_KIND_LIST)('%s: 頭文字 + 2〜4 桁', (kind) => {
    const p = RECORD_KINDS[kind].prefix
    expect(isRecordId(kind, `${p}01`)).toBe(true)
    expect(isRecordId(kind, `${p}9999`)).toBe(true)
    expect(isRecordId(kind, `${p}1`)).toBe(false)
    expect(isRecordId(kind, `${p}12345`)).toBe(false)
    expect(isRecordId(kind, `${p.toLowerCase()}01`)).toBe(false)
    expect(isRecordId(kind, `${p}01\n`)).toBe(false)
    expect(isRecordId(kind, `../${p}01`)).toBe(false)
    expect(isRecordId(kind, 1)).toBe(false)
    expect(isRecordId(kind, null)).toBe(false)
    expect(idPattern(kind).test(`x${p}01`)).toBe(false)
  })
})

describe('ステップ', () => {
  it('S1〜S10 の 10 個で、定義と ID の並びが同じ', () => {
    expect(STEP_IDS).toHaveLength(10)
    expect(STEPS.map((s) => s.id)).toEqual([...STEP_IDS])
  })

  it('どのステップにも「何をする」の説明があり、記録する画面は承認以外の記録の種類か null', () => {
    for (const s of STEPS) {
      expect(s.does.trim().length, s.id).toBeGreaterThan(20)
      expect(s.exit.trim(), s.id).not.toBe('')
      if (s.view !== null) {
        expect(RECORD_KIND_LIST, s.id).toContain(s.view)
        expect(s.view, s.id).not.toBe('approval')
      }
    }
  })

  it('段階の狙いが 3 つの段階すべてにある', () => {
    for (const phase of new Set(STEPS.map((s) => s.phase))) expect(PHASE_GOALS[phase].trim(), phase).not.toBe('')
    expect(Object.keys(PHASE_GOALS).sort()).toEqual(['アクション', 'チェック', '発見'].sort())
  })

  it('isStepId', () => {
    expect(isStepId('S1')).toBe(true)
    expect(isStepId('S10')).toBe(true)
    for (const v of ['S0', 'S11', 's1', ' S1', 1, null, undefined, {}]) expect(isStepId(v)).toBe(false)
  })

  it('stepById は知らない ID なら S1', () => {
    expect(stepById('S9').name).toBe('チェック')
    expect(stepById('S99' as never).id).toBe('S1')
  })
})

describe('定数', () => {
  it('D は 5 項目（10 点満点）、A は 4 項目（8 点満点）、P は 4 項目', () => {
    expect(DEMAND_KEYS).toHaveLength(5)
    expect(ACQUISITION_KEYS).toHaveLength(4)
    expect(PROVISION_KEYS).toHaveLength(4)
    for (const k of [...DEMAND_KEYS, ...ACQUISITION_KEYS, ...PROVISION_KEYS]) expect(SCORE_LABELS[k]).toBeTruthy()
  })

  it('未確認は U', () => {
    expect(UNKNOWN).toBe('U')
  })

  it('段階は 5 つで、すべてに次へ進む条件がある', () => {
    expect(STAGES).toHaveLength(5)
    for (const s of STAGES) expect(STAGE_EXIT[s]).toBeTruthy()
  })

  it('経路の段の表示名がそろっている。条件の指標は経路の段・関心表明・見積依頼・入金額・CAC', () => {
    for (const k of FUNNEL_KEYS) expect(FUNNEL_LABELS[k]).toBeTruthy()
    expect(CONDITION_METRICS).toEqual([...FUNNEL_KEYS, 'interest', 'quoteRequests', 'revenue', 'cac'])
  })

  it('記録の種類の頭文字は重複しない', () => {
    const prefixes = RECORD_KIND_LIST.map((k) => RECORD_KINDS[k].prefix)
    expect(new Set(prefixes).size).toBe(prefixes.length)
  })
})
