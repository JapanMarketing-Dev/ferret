/**
 * 記録の空の形と、手で書かれた値を型へ寄せる処理（壊れた値でも落とさず、直したことを返す）
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_LIST,
  MAX_TEXT,
  coerceBusiness,
  coerceRecord,
  coerceSearch,
  emptyBusiness,
  emptyNumbers,
  emptyProvision,
  emptyRecord,
  emptyScore
} from '@shared/business/records'
import { ACQUISITION_KEYS, DEMAND_KEYS, PROVISION_KEYS, RECORD_KIND_LIST, UNKNOWN } from '@shared/business/model'

const NOW = '2026-10-17T09:00:00.000Z'

afterEach(() => {
  // どの入力でも Object.prototype を汚していないこと
  expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  expect(({} as Record<string, unknown>).demand).toBeUndefined()
  expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false)
})

const fields = (fixes: Array<{ field: string }>) => fixes.map((f) => f.field)

describe('空の形', () => {
  it('点数・提供条件は U、根拠は空', () => {
    expect(emptyScore()).toEqual({ score: 'U', evidence: [], reason: '' })
    expect(emptyProvision()).toEqual({ value: 'U', evidence: [], reason: '' })
  })

  it('実験の数はすべて未計測（null。0 にしない）', () => {
    const n = emptyNumbers()
    expect(Object.keys(n)).toHaveLength(19)
    expect(Object.values(n).every((v) => v === null)).toBe(true)
  })

  it('空の数は毎回別のオブジェクト（共有して書き換わらない）', () => {
    const a = emptyNumbers()
    a.paid = 1
    expect(emptyNumbers().paid).toBeNull()
  })

  it('ビジネスの空の形', () => {
    expect(emptyBusiness('名前', NOW)).toEqual({ name: '名前', target: '', step: 'S1', loop: 1, currentHypothesis: null, limits: { hours: null, yen: null }, loops: [], createdAt: NOW })
  })

  it('仮説は D・A・P がすべて U、段階は探索メモ、確認日は今日', () => {
    const h = emptyRecord('hypothesis', 'H01', NOW)
    expect(h.id).toBe('H01')
    expect(h.stage).toBe('探索メモ')
    expect(h.checkedAt).toBe('2026-10-17')
    expect(h.verdict).toBeNull()
    for (const k of DEMAND_KEYS) expect(h.demand[k].score).toBe(UNKNOWN)
    for (const k of ACQUISITION_KEYS) expect(h.acquisition[k].score).toBe(UNKNOWN)
    for (const k of PROVISION_KEYS) expect(h.provision[k].value).toBe(UNKNOWN)
    h.demand.D1.evidence.push('E01')
    expect(h.demand.D2.evidence).toEqual([])
  })

  it('証拠は dupGroup・sourceKind が U、発見のみ（数えない状態から始める）', () => {
    const e = emptyRecord('evidence', 'E01', NOW)
    expect(e.dupGroup).toBe('U')
    expect(e.sourceKind).toBe('U')
    expect(e.readStatus).toBe('発見のみ')
  })

  it('聞き取りは同意なし、実験は計画のみで計画・実測とも未計測', () => {
    expect(emptyRecord('interview', 'I01', NOW).consent).toBe(false)
    const x = emptyRecord('experiment', 'X01', NOW)
    expect(x.status).toBe('計画のみ')
    expect(x.plan).toEqual(emptyNumbers())
    expect(x.actual).toEqual(emptyNumbers())
    expect(x.plan).not.toBe(x.actual)
    expect(x.page).toBeNull()
  })

  it('承認は待ち', () => {
    expect(emptyRecord('approval', 'R01', NOW).status).toBe('待ち')
  })

  it.each(RECORD_KIND_LIST)('%s の空の形は、そのまま寄せても直しが出ない', (kind) => {
    const empty = emptyRecord(kind, 'X01', NOW)
    const r = coerceRecord(kind, JSON.parse(JSON.stringify(empty)), 'X01', NOW)
    expect(r.fixes).toEqual([])
    expect(r.value).toEqual(empty)
  })
})

describe('ビジネス（business.yaml）を寄せる', () => {
  it('正しい値はそのまま', () => {
    const raw = { name: '経理代行', target: '月末に明細を統合したい経理担当', step: 'S5', loop: 3, currentHypothesis: 'H02', limits: { hours: 40, yen: 50000 }, loops: [{ loop: 1, changed: '価格', backTo: 'S6', note: 'メモ', at: '2026-10-01' }], createdAt: '2026-09-01' }
    const r = coerceBusiness(raw, '既定', NOW)
    expect(r.fixes).toEqual([])
    expect(r.value).toEqual(raw)
  })

  it('null・数・文字・一覧など、まとまりでないものは空として既定へ寄せる', () => {
    for (const raw of [null, undefined, 42, 'text', [1, 2], true]) {
      const r = coerceBusiness(raw, '既定', NOW)
      expect(r.value).toEqual(emptyBusiness('既定', NOW))
    }
    expect(coerceBusiness([1], '既定', NOW).fixes).toEqual([{ field: 'business', message: '項目のまとまりではないので空にしました' }])
    expect(coerceBusiness(null, '既定', NOW).fixes).toEqual([])
  })

  it('名前が空・空白なら既定の名前', () => {
    expect(coerceBusiness({ name: '  ' }, '既定', NOW).value.name).toBe('既定')
    expect(coerceBusiness({ name: 123 }, '既定', NOW).value.name).toBe('123')
  })

  it('S1〜S10 でないステップは S1 にして知らせる', () => {
    for (const step of ['S11', 's1', 1, 'S0', {}, null]) {
      const r = coerceBusiness({ step }, 'n', NOW)
      expect(r.value.step).toBe('S1')
      expect(fields(r.fixes)).toContain('step')
    }
    expect(coerceBusiness({}, 'n', NOW).fixes).toEqual([])
    expect(coerceBusiness({ step: 'S10' }, 'n', NOW).value.step).toBe('S10')
  })

  it('周回は 1 以上の整数（0・負・小数・文字）', () => {
    expect(coerceBusiness({ loop: 0 }, 'n', NOW).value.loop).toBe(1)
    expect(coerceBusiness({ loop: 2.9 }, 'n', NOW).value.loop).toBe(2)
    expect(coerceBusiness({ loop: '4' }, 'n', NOW).value.loop).toBe(4)
    const neg = coerceBusiness({ loop: -3 }, 'n', NOW)
    expect(neg.value.loop).toBe(1)
    expect(fields(neg.fixes)).toEqual(['loop'])
    expect(coerceBusiness({ loop: 'abc' }, 'n', NOW).value.loop).toBe(1)
  })

  it('今の仮説は H01 の形だけ', () => {
    expect(coerceBusiness({ currentHypothesis: 'H1' }, 'n', NOW).value.currentHypothesis).toBeNull()
    expect(coerceBusiness({ currentHypothesis: 'E01' }, 'n', NOW).value.currentHypothesis).toBeNull()
    expect(coerceBusiness({ currentHypothesis: 1 }, 'n', NOW).value.currentHypothesis).toBeNull()
    expect(coerceBusiness({ currentHypothesis: 'H0123' }, 'n', NOW).value.currentHypothesis).toBe('H0123')
  })

  it('上限の負の数・文字は未計測（null）にして知らせ、0 にしない', () => {
    const r = coerceBusiness({ limits: { hours: -1, yen: 'たくさん' } }, 'n', NOW)
    expect(r.value.limits).toEqual({ hours: null, yen: null })
    expect(fields(r.fixes)).toEqual(['limits.hours', 'limits.yen'])
  })

  it('上限は「1,000円」のような書き方も読む', () => {
    expect(coerceBusiness({ limits: { yen: '50,000円' } }, 'n', NOW).value.limits.yen).toBe(50000)
  })

  it('上限が一覧なら空にして知らせる', () => {
    const r = coerceBusiness({ limits: [1, 2] }, 'n', NOW)
    expect(r.value.limits).toEqual({ hours: null, yen: null })
    expect(fields(r.fixes)).toEqual(['limits'])
  })

  it('周回の記録: 変えたものの値が違えば知らせ、壊れた行は既定へ', () => {
    const r = coerceBusiness({ loops: [{ changed: '色' }, null, 'x', { loop: 5, changed: null, backTo: 'S99' }] }, 'n', NOW)
    expect(r.value.loops).toEqual([
      { loop: 1, changed: '対象', backTo: null, note: '', at: '' },
      { loop: 2, changed: null, backTo: null, note: '', at: '' },
      { loop: 3, changed: null, backTo: null, note: '', at: '' },
      { loop: 5, changed: null, backTo: null, note: '', at: '' }
    ])
    expect(fields(r.fixes)).toEqual(['loops[0].changed', 'loops[2]'])
  })

  it('周回の記録が一覧でなければ空', () => {
    expect(coerceBusiness({ loops: { a: 1 } }, 'n', NOW).value.loops).toEqual([])
  })

  it('周回の記録は 500 件まで', () => {
    expect(coerceBusiness({ loops: Array.from({ length: 600 }, () => ({})) }, 'n', NOW).value.loops).toHaveLength(500)
  })

  it('Date は日付の文字にする（時刻が 0 時なら日付だけ）', () => {
    const r = coerceBusiness({ createdAt: new Date('2026-10-17T00:00:00Z') }, 'n', NOW)
    expect(r.value.createdAt).toBe('2026-10-17')
    expect(coerceBusiness({ createdAt: new Date('2026-10-17T10:20:30Z') }, 'n', NOW).value.createdAt).toBe('2026-10-17T10:20:30')
    expect(coerceBusiness({ createdAt: new Date('invalid') }, 'n', NOW).value.createdAt).toBe(NOW)
  })

  it('__proto__・constructor のキーがあっても Object.prototype を汚さない', () => {
    const raw = JSON.parse('{"__proto__": {"polluted": 1, "name": "乗っ取り"}, "constructor": {"prototype": {"polluted": 1}}, "limits": {"__proto__": {"yen": 5}}}')
    const r = coerceBusiness(raw, '既定', NOW)
    expect(r.value.name).toBe('既定')
    expect(r.value.limits.yen).toBeNull()
  })
})

describe('点数（D・A）を寄せる', () => {
  const hyp = (demand: unknown, acquisition: unknown = undefined) => coerceRecord('hypothesis', { demand, acquisition }, 'H01', NOW)

  it('値だけ（D1: 2）でも、まとまり（score・evidence・reason）でも読む', () => {
    const r = hyp({ D1: 2, D2: { score: 1, evidence: ['E01', 'E02'], reason: '理由' } })
    expect(r.value.demand.D1).toEqual({ score: 2, evidence: [], reason: '' })
    expect(r.value.demand.D2).toEqual({ score: 1, evidence: ['E01', 'E02'], reason: '理由' })
    expect(r.fixes).toEqual([])
  })

  it("'0'・'1'・'2' の文字は数として読む", () => {
    const r = hyp({ D1: '0', D2: '1', D3: { score: '2' } })
    expect([r.value.demand.D1.score, r.value.demand.D2.score, r.value.demand.D3.score]).toEqual([0, 1, 2])
  })

  it('U・u・空・null・未記入は U（直しは出さない）', () => {
    const r = hyp({ D1: 'U', D2: 'u', D3: '', D4: null })
    for (const k of DEMAND_KEYS) expect(r.value.demand[k].score).toBe('U')
    expect(r.fixes).toEqual([])
  })

  it.each([[3], [-1], [1.5], ['2点'], [' 2'], [true], [Number.NaN], [Infinity], ['high']])('使えない点数 %s は U にして直しを返す（0 にしない）', (bad) => {
    const r = hyp({ D1: bad })
    expect(r.value.demand.D1.score).toBe('U')
    expect(r.fixes).toHaveLength(1)
    expect(r.fixes[0]!.field).toBe('demand.D1.score')
    expect(r.fixes[0]!.message).toContain('U にしました')
  })

  it('点数が一覧なら U', () => {
    const r = hyp({ D1: [2] })
    expect(r.value.demand.D1.score).toBe('U')
    expect(fields(r.fixes)).toEqual(['demand.D1.score'])
  })

  it('根拠の証拠 ID: 形の違うものは外して知らせ、重複はまとめる', () => {
    const r = hyp({ D1: { score: 2, evidence: ['E01', 'E1', 'H01', 'E01', ' E02 ', 'e03', 'E12345', 7, null] } })
    expect(r.value.demand.D1.evidence).toEqual(['E01', 'E02'])
    expect(r.fixes.map((f) => f.message)).toEqual([
      '「E1」は使えない値なので外しました',
      '「H01」は使えない値なので外しました',
      '「e03」は使えない値なので外しました',
      '「E12345」は使えない値なので外しました',
      '「7」は使えない値なので外しました'
    ])
  })

  it('根拠の証拠 ID は「E01, E02」「E01、E02」の文字でも読む', () => {
    expect(hyp({ D1: { score: 1, evidence: 'E01, E02' } }).value.demand.D1.evidence).toEqual(['E01', 'E02'])
    expect(hyp({ D1: { score: 1, evidence: 'E01、E03 E04' } }).value.demand.D1.evidence).toEqual(['E01', 'E03', 'E04'])
  })

  it('根拠がまとまり（オブジェクト）なら空にして知らせる', () => {
    const r = hyp({ D1: { score: 1, evidence: { a: 'E01' } } })
    expect(r.value.demand.D1.evidence).toEqual([])
    expect(fields(r.fixes)).toEqual(['demand.D1.evidence'])
  })

  it(`根拠は ${MAX_LIST} 件まで`, () => {
    const many = Array.from({ length: MAX_LIST + 50 }, (_, i) => `E${String(i + 1).padStart(3, '0')}`)
    const r = hyp({ D1: { score: 2, evidence: many } })
    expect(r.value.demand.D1.evidence).toHaveLength(MAX_LIST)
    expect(r.fixes.map((f) => f.message)).toEqual([`${MAX_LIST} 件を超えた分を外しました`])
  })

  it('demand が一覧・文字なら全部 U にして知らせる', () => {
    const r = hyp(['D1', 2])
    for (const k of DEMAND_KEYS) expect(r.value.demand[k].score).toBe('U')
    expect(fields(r.fixes)).toEqual(['demand'])
    expect(fields(hyp('D1: 2').fixes)).toEqual(['demand'])
  })

  it('A も同じ読み方', () => {
    const r = hyp(undefined, { A1: 2, A4: { score: '1', evidence: ['E09'] }, A2: 9 })
    expect(r.value.acquisition.A1.score).toBe(2)
    expect(r.value.acquisition.A4).toEqual({ score: 1, evidence: ['E09'], reason: '' })
    expect(r.value.acquisition.A2.score).toBe('U')
    expect(fields(r.fixes)).toEqual(['acquisition.A2.score'])
  })

  it('知らないキー（D6・A5）は無視する', () => {
    const r = hyp({ D6: 2 }, { A5: 2 })
    expect('D6' in r.value.demand).toBe(false)
    expect('A5' in r.value.acquisition).toBe(false)
  })
})

describe('提供条件（P）を寄せる', () => {
  const prov = (provision: unknown) => coerceRecord('hypothesis', { provision }, 'H01', NOW)
  it('はい・いいえ・U、true・false も読む', () => {
    const r = prov({ P1: 'はい', P2: { value: 'いいえ', evidence: ['E01'] }, P3: true, P4: false })
    expect(PROVISION_KEYS.map((k) => r.value.provision[k].value)).toEqual(['はい', 'いいえ', 'はい', 'いいえ'])
    expect(r.value.provision.P2.evidence).toEqual(['E01'])
    expect(r.fixes).toEqual([])
  })
  it('yes・2 などは U にして知らせる', () => {
    const r = prov({ P1: 'yes', P2: 2 })
    expect(r.value.provision.P1.value).toBe('U')
    expect(r.value.provision.P2.value).toBe('U')
    expect(fields(r.fixes)).toEqual(['provision.P1.value', 'provision.P2.value'])
  })
})

describe('仮説の他の欄', () => {
  it('段階・判定の値が違えば既定にして知らせる', () => {
    const r = coerceRecord('hypothesis', { stage: '大成功', verdict: 'GO' }, 'H01', NOW)
    expect(r.value.stage).toBe('探索メモ')
    expect(r.value.verdict).toBe('追加調査')
    expect(fields(r.fixes)).toEqual(['stage', 'verdict'])
  })

  it('判定が空・null なら未判定（null）', () => {
    expect(coerceRecord('hypothesis', { verdict: '' }, 'H01', NOW).value.verdict).toBeNull()
    expect(coerceRecord('hypothesis', { verdict: null }, 'H01', NOW).value.verdict).toBeNull()
    expect(coerceRecord('hypothesis', { verdict: ' 棄却 ' }, 'H01', NOW).value.verdict).toBe('棄却')
  })

  it('文字の欄に数・真偽値があれば文字にする。まとまり・一覧なら空にして知らせる', () => {
    const r = coerceRecord('hypothesis', { name: 42, problem: true, next: { a: 1 }, offer: ['x'] }, 'H01', NOW)
    expect(r.value.name).toBe('42')
    expect(r.value.problem).toBe('true')
    expect(r.value.next).toBe('')
    expect(r.value.offer).toBe('')
    expect(fields(r.fixes)).toEqual(['offer', 'next'])
  })

  it(`長すぎる文字は ${MAX_TEXT} 文字で切る`, () => {
    const r = coerceRecord('hypothesis', { problem: 'あ'.repeat(MAX_TEXT + 1000) }, 'H01', NOW)
    expect(r.value.problem).toHaveLength(MAX_TEXT)
    expect(r.fixes).toEqual([{ field: 'problem', message: `長すぎるので ${MAX_TEXT} 文字で切りました` }])
  })

  it(`ちょうど ${MAX_TEXT} 文字は切らない`, () => {
    const r = coerceRecord('hypothesis', { problem: 'a'.repeat(MAX_TEXT) }, 'H01', NOW)
    expect(r.value.problem).toHaveLength(MAX_TEXT)
    expect(r.fixes).toEqual([])
  })

  it('id は引数のもの（ファイルの中の id は使わない）', () => {
    expect(coerceRecord('hypothesis', { id: 'H99' }, 'H01', NOW).value.id).toBe('H01')
  })

  it('段階の履歴: 壊れた行は既定、100 件まで', () => {
    const r = coerceRecord('hypothesis', { stageHistory: [{ from: '探索メモ', to: 'ネット上の有望仮説', at: '2026-10-01', note: 'n' }, 'x', { from: 'X' }] }, 'H01', NOW)
    expect(r.value.stageHistory[0]).toEqual({ from: '探索メモ', to: 'ネット上の有望仮説', at: '2026-10-01', note: 'n' })
    expect(r.value.stageHistory[1]).toEqual({ from: '探索メモ', to: '探索メモ', at: '', note: '' })
    expect(fields(r.fixes)).toEqual(['stageHistory[1]', 'stageHistory[2].from'])
    expect(coerceRecord('hypothesis', { stageHistory: Array.from({ length: 150 }, () => ({})) }, 'H01', NOW).value.stageHistory).toHaveLength(100)
    expect(coerceRecord('hypothesis', { stageHistory: 'x' }, 'H01', NOW).value.stageHistory).toEqual([])
  })

  it('入れ子の null（demand: { D1: null }、provision: null）でも落ちない', () => {
    const r = coerceRecord('hypothesis', { demand: { D1: null, D2: { score: null, evidence: null, reason: null } }, acquisition: null, provision: null }, 'H01', NOW)
    expect(r.value.demand.D1).toEqual({ score: 'U', evidence: [], reason: '' })
    expect(r.value.demand.D2).toEqual({ score: 'U', evidence: [], reason: '' })
    expect(r.fixes).toEqual([])
  })

  it('__proto__ で点数を差し込めない', () => {
    const raw = JSON.parse('{"__proto__": {"polluted": 1}, "demand": {"__proto__": {"D1": 2, "polluted": 1}}, "constructor": {"prototype": {"polluted": 1}}}')
    const r = coerceRecord('hypothesis', raw, 'H01', NOW)
    expect(r.value.demand.D1.score).toBe('U')
    expect('__proto__' in r.value.demand && Object.hasOwn(r.value.demand, '__proto__')).toBe(false)
  })
})

describe('証拠を寄せる', () => {
  it('正しい証拠', () => {
    const raw = {
      hypotheses: ['H01', 'H02'], party: '経理担当', partyBasis: '投稿者', dupGroup: 'A社', sourceKind: '発注', medium: '発注サイト', url: ' https://example.com/a ',
      publishedAt: '2026-09-01', checkedAt: '2026-10-01', readStatus: '読了', facts: '事実', quote: '原文', interpretation: '解釈', supports: ['D1', 'A2'], counter: '',
      details: { scene: '月末', loss: '残業' }
    }
    const r = coerceRecord('evidence', raw, 'E01', NOW)
    expect(r.fixes).toEqual([])
    expect(r.value.url).toBe('https://example.com/a')
    expect(r.value.supports).toEqual(['D1', 'A2'])
    expect(r.value.details.scene).toBe('月末')
    expect(r.value.details.payer).toBe('')
  })

  it('仮説 ID の形が違うものは外す', () => {
    const r = coerceRecord('evidence', { hypotheses: ['H01', 'h02', 'E01', 'H'] }, 'E01', NOW)
    expect(r.value.hypotheses).toEqual(['H01'])
    expect(r.fixes).toHaveLength(3)
  })

  it('supports は D1〜D5・A1〜A4 だけ（P は採点項目でない）', () => {
    const r = coerceRecord('evidence', { supports: ['D1', 'P1', 'D6', 'A4'] }, 'E01', NOW)
    expect(r.value.supports).toEqual(['D1', 'A4'])
  })

  it('dupGroup が空・空白なら U、数なら文字', () => {
    expect(coerceRecord('evidence', { dupGroup: '  ' }, 'E01', NOW).value.dupGroup).toBe('U')
    expect(coerceRecord('evidence', { dupGroup: null }, 'E01', NOW).value.dupGroup).toBe('U')
    expect(coerceRecord('evidence', { dupGroup: 7 }, 'E01', NOW).value.dupGroup).toBe('7')
  })

  it('読めた状態・根拠の性質の値が違えば、数えない側の既定（発見のみ・U）へ', () => {
    const r = coerceRecord('evidence', { readStatus: 'read', sourceKind: '口コミ' }, 'E01', NOW)
    expect(r.value.readStatus).toBe('発見のみ')
    expect(r.value.sourceKind).toBe('U')
    expect(fields(r.fixes)).toEqual(['sourceKind', 'readStatus'])
  })

  it('details が一覧なら空にして知らせ、中の型違いは details.○○ として知らせる', () => {
    expect(fields(coerceRecord('evidence', { details: ['a'] }, 'E01', NOW).fixes)).toEqual(['details'])
    expect(fields(coerceRecord('evidence', { details: { loss: { a: 1 } } }, 'E01', NOW).fixes)).toEqual(['details.loss'])
  })
})

describe('聞き取りを寄せる', () => {
  it('同意が無ければ原文を読み込まず、知らせる', () => {
    const r = coerceRecord('interview', { consent: false, transcript: '原文です', summary: '要約' }, 'I01', NOW)
    expect(r.value.transcript).toBe('')
    expect(r.value.summary).toBe('要約')
    expect(r.fixes).toEqual([{ field: 'transcript', message: '同意が無いので原文は読み込みませんでした' }])
  })

  it('同意の欄が無い・値が違うときも同意なし扱い', () => {
    expect(coerceRecord('interview', { transcript: 'x' }, 'I01', NOW).value.transcript).toBe('')
    const r = coerceRecord('interview', { consent: 'たぶん', transcript: 'x' }, 'I01', NOW)
    expect(r.value.consent).toBe(false)
    expect(r.value.transcript).toBe('')
    expect(fields(r.fixes)).toEqual(['consent', 'transcript'])
  })

  it.each([[true], ['はい'], ['true'], ['yes']])('同意 %s なら原文を読む', (consent) => {
    const r = coerceRecord('interview', { consent, transcript: '原文' }, 'I01', NOW)
    expect(r.value.consent).toBe(true)
    expect(r.value.transcript).toBe('原文')
  })

  it.each([[false], ['いいえ'], ['false'], ['no']])('同意 %s は同意なし', (consent) => {
    expect(coerceRecord('interview', { consent }, 'I01', NOW).value.consent).toBe(false)
  })

  it('同意に 1 などの数は既定（なし）にして知らせる', () => {
    const r = coerceRecord('interview', { consent: 1 }, 'I01', NOW)
    expect(r.value.consent).toBe(false)
    expect(fields(r.fixes)).toEqual(['consent'])
  })
})

describe('実験を寄せる', () => {
  it('数: 負・NaN・文字・巨大な数は未計測（null）にして知らせる。0 にしない', () => {
    const r = coerceRecord('experiment', { actual: { contacts: -1, replies: 'たくさん', qualified: Number.NaN, priced: 1e13, paid: Infinity, payments: true, accepted: [1], repurchased: { a: 1 } } }, 'X01', NOW)
    for (const k of ['contacts', 'replies', 'qualified', 'priced', 'paid', 'payments', 'accepted', 'repurchased'] as const) expect(r.value.actual[k]).toBeNull()
    expect(fields(r.fixes)).toEqual(['actual.contacts', 'actual.replies', 'actual.qualified', 'actual.priced', 'actual.paid', 'actual.payments', 'actual.accepted', 'actual.repurchased'])
    expect(r.fixes.every((f) => f.message === '0 以上の数ではないので未計測にしました')).toBe(true)
  })

  it('数: 0・小数・"1,200"・"3000円"・U・空を読み分ける', () => {
    const r = coerceRecord('experiment', { actual: { contacts: 0, salesHours: 1.5, revenue: '1,200', adCost: '3000円', paid: 'U', replies: '', priced: null } }, 'X01', NOW)
    expect(r.value.actual).toMatchObject({ contacts: 0, salesHours: 1.5, revenue: 1200, adCost: 3000, paid: null, replies: null, priced: null })
    expect(r.fixes).toEqual([])
  })

  it('全角カンマも読む', () => {
    expect(coerceRecord('experiment', { plan: { revenue: '10，000' } }, 'X01', NOW).value.plan.revenue).toBe(10000)
  })

  it('1e12 ちょうどは読む（上限の境界）', () => {
    expect(coerceRecord('experiment', { plan: { revenue: 1e12 } }, 'X01', NOW).value.plan.revenue).toBe(1e12)
  })

  it('plan・actual が一覧ならすべて未計測', () => {
    const r = coerceRecord('experiment', { plan: [1, 2, 3], actual: 'x' }, 'X01', NOW)
    expect(r.value.plan).toEqual(emptyNumbers())
    expect(r.value.actual).toEqual(emptyNumbers())
    expect(fields(r.fixes)).toEqual(['plan', 'actual'])
  })

  it('条件: 正しいものだけ残し、使えないものは位置つきで知らせる', () => {
    const r = coerceRecord('experiment', {
      pass: [
        { metric: 'paid', op: '>=', value: 3 },
        { metric: 'unknown', op: '>=', value: 1 },
        { metric: 'paid', op: '>', value: 1 },
        { metric: 'paid', op: '>=', value: '3' },
        { metric: 'paid', op: '>=', value: -1 },
        { metric: 'cac', op: '<=', value: Number.NaN },
        null,
        'paid >= 3',
        { metric: 'cac', op: '<=', value: 0 }
      ]
    }, 'X01', NOW)
    expect(r.value.pass).toEqual([{ metric: 'paid', op: '>=', value: 3 }, { metric: 'cac', op: '<=', value: 0 }])
    expect(fields(r.fixes)).toEqual(['pass[1]', 'pass[2]', 'pass[3]', 'pass[4]', 'pass[5]', 'pass[6]', 'pass[7]'])
  })

  it('条件が一覧でなければ空にして知らせる。20 件まで', () => {
    const r = coerceRecord('experiment', { stop: { metric: 'paid', op: '>=', value: 1 } }, 'X01', NOW)
    expect(r.value.stop).toEqual([])
    expect(fields(r.fixes)).toEqual(['stop'])
    const many = Array.from({ length: 30 }, () => ({ metric: 'paid', op: '>=', value: 1 }))
    expect(coerceRecord('experiment', { pass: many }, 'X01', NOW).value.pass).toHaveLength(20)
  })

  it('条件の metric に constructor・__proto__ は使えない', () => {
    const r = coerceRecord('experiment', { pass: [{ metric: 'constructor', op: '>=', value: 1 }, { metric: '__proto__', op: '>=', value: 1 }, { metric: 'toString', op: '<=', value: 1 }] }, 'X01', NOW)
    expect(r.value.pass).toEqual([])
  })

  it('実験ページ: 名前（英小文字・数字・-、3〜48 文字）だけ読む', () => {
    const ok = (slug: string) => coerceRecord('experiment', { page: { slug, status: '公開中' } }, 'X01', NOW).value.page
    expect(ok('abc')).toEqual({ slug: 'abc', status: '公開中' })
    expect(ok('a'.repeat(48))).not.toBeNull()
    expect(ok('a-1-b')).not.toBeNull()
    for (const bad of ['ab', 'a'.repeat(49), 'ABC', 'abc_def', 'あいう', '../etc', 'abc/def', 'abc def', 'abc\n']) expect(ok(bad)).toBeNull()
  })

  it('実験ページの名前が使えなければ外して知らせる', () => {
    const r = coerceRecord('experiment', { page: { slug: '../x' } }, 'X01', NOW)
    expect(r.value.page).toBeNull()
    expect(fields(r.fixes)).toEqual(['page'])
  })

  it('実験ページの状態が違えば下書き。page が文字なら外す', () => {
    expect(coerceRecord('experiment', { page: { slug: 'abc', status: 'live' } }, 'X01', NOW).value.page).toEqual({ slug: 'abc', status: '下書き' })
    expect(coerceRecord('experiment', { page: { slug: 'abc' } }, 'X01', NOW).value.page).toEqual({ slug: 'abc', status: '下書き' })
    expect(coerceRecord('experiment', { page: 'abc' }, 'X01', NOW).value.page).toBeNull()
    expect(coerceRecord('experiment', { page: null }, 'X01', NOW).value.page).toBeNull()
  })

  it('状態の値が違えば計画のみ（実測を入れられない側）へ', () => {
    const r = coerceRecord('experiment', { status: 'running' }, 'X01', NOW)
    expect(r.value.status).toBe('計画のみ')
  })

  it('期間の Date は日付の文字にする', () => {
    const r = coerceRecord('experiment', { period: { start: new Date('2026-10-01T00:00:00Z'), end: '2026-10-31' } }, 'X01', NOW)
    expect(r.value.period).toEqual({ start: '2026-10-01', end: '2026-10-31' })
  })

  it('上限の負の数は null', () => {
    expect(coerceRecord('experiment', { limits: { yen: -100, hours: '10' } }, 'X01', NOW).value.limits).toEqual({ yen: null, hours: 10 })
  })
})

describe('結論・承認・代替を寄せる', () => {
  it('結論の学びは 1 件 500 文字まで', () => {
    const r = coerceRecord('decision', { learnings: ['あ'.repeat(800), '短い'] }, 'C01', NOW)
    expect(r.value.learnings[0]).toHaveLength(500)
    expect(r.value.learnings[1]).toBe('短い')
  })

  it('結論の学びが文字なら区切りで分ける', () => {
    expect(coerceRecord('decision', { learnings: '価格を下げた、経路を変えた' }, 'C01', NOW).value.learnings).toEqual(['価格を下げた', '経路を変えた'])
  })

  it('結論の worked・verdict の値が違えば既定', () => {
    const r = coerceRecord('decision', { worked: 'はい', verdict: 'GO', stage: 1 }, 'C01', NOW)
    expect(r.value.worked).toBe('不明')
    expect(r.value.verdict).toBe('追加調査')
    expect(r.value.stage).toBe('探索メモ')
    expect(fields(r.fixes)).toEqual(['verdict', 'stage', 'worked'])
  })

  it('承認の選択肢は 4 個まで・300 文字まで。refs は記録 ID だけ', () => {
    const r = coerceRecord('approval', { options: ['a', 'b', 'c', 'd', 'e', 'x'.repeat(400)], refs: ['H01', 'X02', 'ALT01', 'R01', 'Z01', 'H1'] }, 'R01', NOW)
    expect(r.value.options).toEqual(['a', 'b', 'c', 'd'])
    expect(r.value.refs).toEqual(['H01', 'X02', 'ALT01', 'R01'])
    expect(coerceRecord('approval', { options: ['x'.repeat(400)] }, 'R01', NOW).value.options[0]).toHaveLength(300)
  })

  it('承認の種類・状態の値が違えば既定（外部へ送る・待ち）', () => {
    const r = coerceRecord('approval', { kind: '何か', status: '承認済み' }, 'R01', NOW)
    expect(r.value.kind).toBe('外部へ送る')
    expect(r.value.status).toBe('待ち')
  })

  it('代替の URL は前後の空白を落とす', () => {
    expect(coerceRecord('alternative', { url: '  https://a.example ' }, 'ALT01', NOW).value.url).toBe('https://a.example')
  })

  it.each(RECORD_KIND_LIST)('%s: どんな入力でも落ちない（null・数・一覧・入れ子の一覧）', (kind) => {
    for (const raw of [null, undefined, 0, 'x', [], [[1]], { a: [{ b: null }] }, new Date(), Object.create(null)]) {
      expect(() => coerceRecord(kind, raw, 'X01', NOW)).not.toThrow()
    }
  })
})

describe('検索履歴の1行を寄せる', () => {
  it('検索語が無い行は捨てる', () => {
    expect(coerceSearch({ at: '2026-10-01' })).toBeNull()
    expect(coerceSearch({ query: '   ' })).toBeNull()
    expect(coerceSearch(null)).toBeNull()
    expect(coerceSearch(['q'])).toBeNull()
    expect(coerceSearch('q')).toBeNull()
  })

  it('読めた・採用は真偽値に寄せる', () => {
    expect(coerceSearch({ query: ' 経理 外注 ', readable: 'はい', adopted: 'no', medium: 'X' })).toEqual({ at: '', query: '経理 外注', medium: 'X', period: '', readable: true, adopted: false, note: '' })
    expect(coerceSearch({ query: 'q', readable: 'maybe' })!.readable).toBe(false)
  })

  it('検索語は 500 文字まで', () => {
    expect(coerceSearch({ query: 'a'.repeat(900) })!.query).toHaveLength(500)
  })
})
