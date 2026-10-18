import { describe, expect, it } from 'vitest'
import { emptyRecord, emptyBusiness } from '@shared/business/records'
import { demandTotal } from '@shared/business/scoring'
import type { Approval, BusinessData, Hypothesis } from '@shared/business/model'
import {
  BACK_STEPS,
  compactProvision,
  compactTotal,
  contentKeys,
  dateTimeText,
  defaultBackStep,
  errorText,
  isChangeAxis,
  issuesFor,
  lastLoopText,
  linesToList,
  nextStage,
  numberText,
  parseNumberInput,
  provisionText,
  recordsOf,
  sameRecord,
  scoreText,
  sortApprovals
} from '../../src/renderer/business/view'

const NOW = '2026-10-17T10:00:00.000+09:00'

function hyp(d: Array<0 | 1 | 2 | 'U'>, p: Array<'はい' | 'いいえ' | 'U'> = ['U', 'U', 'U', 'U']): Hypothesis {
  const h = emptyRecord('hypothesis', 'H01', NOW)
  ;(['D1', 'D2', 'D3', 'D4', 'D5'] as const).forEach((k, i) => { h.demand[k].score = d[i]! })
  ;(['P1', 'P2', 'P3', 'P4'] as const).forEach((k, i) => { h.provision[k].value = p[i]! })
  return h
}

describe('numberText（未計測を 0 と書かない）', () => {
  it('null は未計測', () => expect(numberText(null)).toBe('未計測'))
  it('null は単位があっても未計測', () => expect(numberText(null, '円')).toBe('未計測'))
  it('0 は 0 と書く（計測した 0）', () => expect(numberText(0)).toBe('0'))
  it('桁区切りと単位', () => expect(numberText(1234567, '円')).toBe('1,234,567 円'))
  it('時間', () => expect(numberText(2.5, '時間')).toBe('2.5 時間'))
})

describe('parseNumberInput', () => {
  it('空は未計測（null）', () => expect(parseNumberInput('')).toEqual({ ok: true, value: null }))
  it('空白だけも null', () => expect(parseNumberInput('   ')).toEqual({ ok: true, value: null }))
  it('0 は 0', () => expect(parseNumberInput('0')).toEqual({ ok: true, value: 0 }))
  it('カンマと円を外す', () => expect(parseNumberInput('12,000円')).toEqual({ ok: true, value: 12000 }))
  it('全角の数字', () => expect(parseNumberInput('１２３')).toEqual({ ok: true, value: 123 }))
  it('小数', () => expect(parseNumberInput('1.5')).toEqual({ ok: true, value: 1.5 }))
  it('負の数は断る', () => expect(parseNumberInput('-1').ok).toBe(false))
  it('文字は断る', () => expect(parseNumberInput('abc').ok).toBe(false))
  it('U は断る（U は数の欄に入れない）', () => expect(parseNumberInput('U').ok).toBe(false))
  it('指数表記は断る', () => expect(parseNumberInput('1e3').ok).toBe(false))
  it('大きすぎる値は断る', () => expect(parseNumberInput('9999999999999').ok).toBe(false))
  it('上限ちょうどは受ける', () => expect(parseNumberInput('1000000000000')).toEqual({ ok: true, value: 1e12 }))
  it('ドットだけは断る', () => expect(parseNumberInput('.').ok).toBe(false))
})

describe('compactTotal / provision（U を 0 と足さない）', () => {
  it('U があれば未完了と U の数', () => expect(compactTotal(demandTotal(hyp([2, 2, 'U', 'U', 1])))).toBe('未完了 U2'))
  it('すべて U でも 0/10 と出さない', () => {
    const text = compactTotal(demandTotal(hyp(['U', 'U', 'U', 'U', 'U'])))
    expect(text).toBe('未完了 U5')
    expect(text).not.toContain('0/')
  })
  it('全部埋まれば合計', () => expect(compactTotal(demandTotal(hyp([2, 2, 2, 2, 1])))).toBe('9/10'))
  it('全部 0 は 0/10（確認した 0）', () => expect(compactTotal(demandTotal(hyp([0, 0, 0, 0, 0])))).toBe('0/10'))
  it('P の要約', () => {
    const h = hyp([0, 0, 0, 0, 0], ['はい', 'いいえ', 'U', 'U'])
    expect(provisionText(h)).toBe('はい 1・いいえ 1・U 2')
    expect(compactProvision(h)).toBe('はい1 いいえ1 U2')
  })
  it('scoreText', () => {
    expect(scoreText('U')).toBe('U')
    expect(scoreText(0)).toBe('0')
  })
})

describe('issuesFor', () => {
  const issues = [
    { severity: 'error' as const, ref: 'X01', field: 'actual.contacts', message: 'a' },
    { severity: 'warning' as const, ref: 'X01', field: 'actual', message: 'b' },
    { severity: 'warning' as const, ref: 'X01', field: 'actualish', message: 'c' },
    { severity: 'warning' as const, ref: 'X02', field: 'actual', message: 'd' }
  ]
  it('子の欄も含む', () => expect(issuesFor(issues, 'X01', 'actual').map((i) => i.message)).toEqual(['a', 'b']))
  it('前方一致でも別の名前の欄は含まない', () => expect(issuesFor(issues, 'X01', 'actual').some((i) => i.message === 'c')).toBe(false))
  it('記録が違えば含まない', () => expect(issuesFor(issues, 'X02').map((i) => i.message)).toEqual(['d']))
  it('欄を省けばその記録の全部', () => expect(issuesFor(issues, 'X01')).toHaveLength(3))
  it('無い記録は空', () => expect(issuesFor(issues, 'H01')).toEqual([]))
})

describe('段階と周', () => {
  it('次の段階', () => expect(nextStage('探索メモ')).toBe('ネット上の有望仮説'))
  it('最後の段階は null', () => expect(nextStage('継続提供の見込みあり')).toBeNull())
  it('戻るステップの初期値', () => {
    expect(defaultBackStep('対象')).toBe('S1')
    expect(defaultBackStep('価格')).toBe('S6')
    expect(defaultBackStep('経路')).toBe('S8')
  })
  it('戻れるのは S1〜S8 だけ', () => {
    expect(BACK_STEPS).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'])
    expect(BACK_STEPS).not.toContain('S9')
  })
  it('変えるものの判定', () => {
    expect(isChangeAxis('価格')).toBe(true)
    expect(isChangeAxis('品質')).toBe(false)
    expect(isChangeAxis(null)).toBe(false)
  })
  it('前の周の変更（無ければ null）', () => {
    const b = emptyBusiness('x', NOW)
    expect(lastLoopText(b)).toBeNull()
    b.loops.push({ loop: 1, changed: null, backTo: null, note: '', at: NOW })
    expect(lastLoopText(b)).toBeNull()
    b.loops.push({ loop: 2, changed: '経路', backTo: 'S8', note: '', at: NOW })
    expect(lastLoopText(b)).toBe('2周目で経路を変更・S8 へ戻した')
  })
})

describe('sortApprovals', () => {
  const a = (id: string, status: Approval['status'], requestedAt: string, decidedAt = ''): Approval => ({ ...emptyRecord('approval', id, NOW), status, requestedAt, decidedAt })
  it('待ちは古い順、決めたものは新しい順', () => {
    const { pending, decided } = sortApprovals([
      a('R01', '承認', '2026-10-01', '2026-10-02'),
      a('R02', '待ち', '2026-10-05'),
      a('R03', '待ち', '2026-10-03'),
      a('R04', '却下', '2026-10-01', '2026-10-09')
    ])
    expect(pending.map((x) => x.id)).toEqual(['R03', 'R02'])
    expect(decided.map((x) => x.id)).toEqual(['R04', 'R01'])
  })
  it('空', () => expect(sortApprovals([])).toEqual({ pending: [], decided: [] }))
})

describe('recordsOf / sameRecord / linesToList', () => {
  const data: BusinessData = {
    root: '/x', business: emptyBusiness('x', NOW), hypotheses: [emptyRecord('hypothesis', 'H01', NOW)], evidence: [], alternatives: [], interviews: [],
    experiments: [emptyRecord('experiment', 'X01', NOW)], decisions: [], approvals: [], searches: [], problems: []
  }
  it('種類ごとの一覧', () => {
    expect(recordsOf(data, 'hypothesis').map((r) => r.id)).toEqual(['H01'])
    expect(recordsOf(data, 'experiment').map((r) => r.id)).toEqual(['X01'])
    expect(recordsOf(data, 'approval')).toEqual([])
  })
  it('同じ記録', () => {
    const h = emptyRecord('hypothesis', 'H01', NOW)
    expect(sameRecord(h, structuredClone(h))).toBe(true)
    expect(sameRecord(h, { ...h, name: 'x' })).toBe(false)
  })
  it('1行1件（空行と前後の空白を外す）', () => expect(linesToList(' a \n\n b\r\nc ')).toEqual(['a', 'b', 'c']))
})

describe('errorText（生の英語・パスを出さない）', () => {
  it('Electron の包みを外す', () => expect(errorText(new Error("Error invoking remote method 'business:send': Error: 送れません"))).toBe('送れません'))
  it('英語だけは日本語の既定へ', () => expect(errorText(new Error('ENOENT: no such file'))).toBe('処理できませんでした'))
  it('既定を変えられる', () => expect(errorText(new Error('boom'), '読めません')).toBe('読めません'))
  it('Error でないもの', () => expect(errorText(undefined)).toBe('処理できませんでした'))
  it('文字列の日本語はそのまま', () => expect(errorText('保存できません')).toBe('保存できません'))
  it('パスを隠す', () => {
    const text = errorText(new Error('読めません /Users/me/biz/evidence/E01.md'))
    expect(text).not.toContain('/Users')
    expect(text).toContain('読めません')
  })
  it('Windows のパスも隠す', () => expect(errorText(new Error('読めません C:\\Users\\me\\a.md'))).not.toContain('Users'))
  it('長すぎる文は切る', () => expect(errorText(new Error('あ'.repeat(500))).length).toBeLessThanOrEqual(200))
})


describe('dateTimeText', () => {
  it('空は空', () => expect(dateTimeText('')).toBe(''))
  it('読めない値は先頭だけ', () => expect(dateTimeText('2026-10-17 あとで')).toBe('2026-10-17 あとで'.slice(0, 16)))
  it('日時（東京）', () => expect(dateTimeText('2026-10-17T01:05:00.000Z')).toBe('2026-10-17 10:05'))
})

describe('contentKeys', () => {
  it('空の一覧は空', () => expect(contentKeys([], String)).toEqual([]))
  it('中身から作り、並びを変えても同じ行は同じ key', () => {
    expect(contentKeys(['a', 'b'], (x) => x)).toEqual(['a', 'b'])
    expect(contentKeys(['b', 'a'], (x) => x)).toEqual(['b', 'a'])
  })
  it('同じ中身が続いても key は重ならない', () => {
    const keys = contentKeys(['a', 'a', 'b', 'a', 'a#2'], (x) => x)
    expect(keys).toEqual(['a', 'a#2', 'b', 'a#3', 'a#2#2'])
    expect(new Set(keys).size).toBe(keys.length)
  })
})
