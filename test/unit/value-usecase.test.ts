/**
 * 価値ユースケース（src/shared/valueUseCase.ts）の純粋な関数。読み方（境界・壊れた値）・並び・数・状態・送る文・画面からの返事
 */
import { describe, expect, it } from 'vitest'
import {
  VALUE_LIMITS,
  VALUE_USECASE_DIR,
  applyValueResponse,
  flatStepIndex,
  isComplete,
  isValueUseCasePath,
  orderFlow,
  parseValueUseCase,
  sanitizeValueReply,
  sortValueDocs,
  stepAt,
  summarizeValues,
  toValueBoxes,
  valueResponseMessage,
  type ValueUseCaseDoc
} from '../../src/shared/valueUseCase'
import { LIMITS, newlyProposed, pendingCount, planMarks } from '../../src/shared/visualReview'

const step = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ screen: 'Home', action: 'Press New', expected: 'Editor opens', ...over })
const value = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'send', name: 'Send an invoice', who: 'Freelancer', why: 'Get paid', success: 'Client gets it', flow: [step()], ...over })
const raw = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'app', title: 'Invoice app', revision: 1, createdAt: '2026-11-13T10:00:00Z', status: 'proposed', purpose: 'Get paid on time.', values: [value()], ...over
})

function parse(over: Record<string, unknown> = {}, id = 'app'): ValueUseCaseDoc {
  const result = parseValueUseCase(raw(over), id)
  if (!result.ok) throw new Error(result.reason)
  return result.doc
}

describe('価値ユースケースの JSON を読む', () => {
  it('ふつうの文書を読む（ファイル名の id を使う）', () => {
    const doc = parse({ id: 'other' })
    expect(doc.id).toBe('app')
    expect(doc.title).toBe('Invoice app')
    expect(doc.purpose).toBe('Get paid on time.')
    expect(doc.values).toHaveLength(1)
    expect(doc.values[0]).toMatchObject({ id: 'send', name: 'Send an invoice', who: 'Freelancer', why: 'Get paid', success: 'Client gets it' })
    expect(doc.values[0]!.status).toBeUndefined()
    expect(doc.values[0]!.flow).toEqual([{ step: 1, screen: 'Home', action: 'Press New', expected: 'Editor opens' }])
    expect(doc.responses).toEqual([])
  })

  it('読めないもの（理由付き）', () => {
    expect(parseValueUseCase(raw(), '../x')).toMatchObject({ ok: false, reason: expect.stringMatching(/file name/) })
    expect(parseValueUseCase([], 'app')).toMatchObject({ ok: false, reason: 'not a JSON object' })
    expect(parseValueUseCase(null, 'app')).toMatchObject({ ok: false })
    expect(parseValueUseCase(raw({ title: '  ' }), 'app')).toMatchObject({ ok: false, reason: '"title" is missing' })
    expect(parseValueUseCase(raw({ values: [] }), 'app')).toMatchObject({ ok: false, reason: expect.stringMatching(/at least one/) })
    expect(parseValueUseCase(raw({ values: 'x' }), 'app')).toMatchObject({ ok: false, reason: expect.stringMatching(/at least one/) })
    expect(parseValueUseCase(raw({ values: [{ who: 'x' }, 3, null] }), 'app')).toMatchObject({ ok: false, reason: expect.stringMatching(/"name"/) })
  })

  it('おかしな値は直して使う（状態・版・時刻・ターミナル）', () => {
    const doc = parse({ status: 'weird', revision: -3.5, createdAt: 'not a date', updatedAt: '2026-11-13T12:00:00Z', terminalId: 'bad id!' })
    expect(doc.status).toBe('proposed')
    expect(doc.revision).toBe(1)
    expect(doc.createdAt).toBe('')
    expect(doc.updatedAt).toBe('2026-11-13T12:00:00Z')
    expect(doc.terminalId).toBeUndefined()
    expect(parse({ terminalId: 't-12', status: 'APPROVED', revision: 4.9 })).toMatchObject({ terminalId: 't-12', status: 'approved', revision: 4 })
  })

  it('価値の今の作りは決まった値だけ（言い換えも受ける）', () => {
    const doc = parse({ values: [
      value({ id: 'a', status: 'works' }), value({ id: 'b', status: 'Working' }), value({ id: 'c', status: 'not built' }),
      value({ id: 'd', status: 'partial' }), value({ id: 'e', status: 'BROKEN' }), value({ id: 'f', status: 'maybe' }), value({ id: 'g', status: 3 })
    ] })
    expect(doc.values.map((v) => v.status)).toEqual(['works', 'works', 'not-built', 'partial', 'broken', undefined, undefined])
  })

  it('価値の id が無い・おかしい・重なるときは振り直す', () => {
    const doc = parse({ values: [value({ id: undefined }), value({ id: 'x' }), value({ id: 'x' }), value({ id: '../bad' }), value({ id: 'x' })] })
    expect(doc.values.map((v) => v.id)).toEqual(['v1', 'x', 'x-2', 'v4', 'x-3'])
  })

  it('名前の無い価値は外し、数は上限まで', () => {
    expect(parse({ values: [value({ name: '' }), value()] }).values).toHaveLength(1)
    const many = Array.from({ length: VALUE_LIMITS.values + 5 }, (_, i) => value({ id: `v${i}` }))
    expect(parse({ values: many }).values).toHaveLength(VALUE_LIMITS.values)
  })

  it('長すぎる文は切る', () => {
    const doc = parse({ title: 'x'.repeat(1000), purpose: 'p'.repeat(LIMITS.text + 100) })
    expect(doc.title.length).toBe(LIMITS.title)
    expect(doc.title.endsWith('…')).toBe(true)
    expect(doc.purpose.length).toBe(LIMITS.text)
  })

  it('手順の画像は .ferret/ の下だけ。押す場所は画像があるときだけで、画像の中に収める', () => {
    const doc = parse({ values: [value({ flow: [
      step({ image: '.ferret/screens/latest.jpg', target: { x: 0.9, y: 0.9, w: 0.5, h: 0.5 } }),
      step({ image: 'screens/pages/a.jpg' }),
      step({ image: '../secret.png', target: { x: 0, y: 0, w: 0.1, h: 0.1 } }),
      step({ image: 'https://example.com/a.png' }),
      step({ image: '/etc/passwd' }),
      step({ image: '.ferret/value-usecases/app/a.png', width: 1000, height: 500, target: { x: 100, y: 50, w: 200, h: 100 } }),
      step({ image: '.ferret/a.png', target: 'nope' })
    ] })] })
    const flow = doc.values[0]!.flow
    expect(flow[0]).toMatchObject({ image: '.ferret/screens/latest.jpg', target: { x: 0.9, y: 0.9, w: 0.1, h: 0.1 } })
    expect(flow[1]!.image).toBe('.ferret/screens/pages/a.jpg')
    expect(flow[2]!.image).toBeUndefined()
    expect(flow[2]!.target).toBeUndefined()
    expect(flow[3]!.image).toBeUndefined()
    expect(flow[4]!.image).toBeUndefined()
    expect(flow[5]!.target).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 })
    expect(flow[6]!.target).toBeUndefined()
  })

  it('操作も結果も無い手順は外す', () => {
    const doc = parse({ values: [value({ flow: [step({ action: '', expected: '' }), 'x', null, step({ action: '', expected: 'Shown' })] })] })
    expect(doc.values[0]!.flow).toEqual([{ step: 1, screen: 'Home', action: '', expected: 'Shown' }])
  })

  it('返事の履歴を読む（録画のレビュー・囲みの価値と手順）', () => {
    const doc = parse({ responses: [
      { at: '2026-11-13T11:00:00Z', action: 'feedback', revision: 1, text: 'more', boxes: [{ x: 0, y: 0, w: 0.5, h: 0.5, value: 1, step: 2, note: 'here' }, { x: 'a' }] },
      { at: 'x', action: 'feedback', kind: 'recording', review: { id: 'r1', dir: '.ferret/reviews/r1', findings: ['a'], screenshots: ['.ferret/reviews/r1/01.png', '.ferret/other.png'] } },
      { action: 'nope' }
    ] })
    expect(doc.responses).toHaveLength(2)
    expect(doc.responses[0]!.boxes).toEqual([{ x: 0, y: 0, w: 0.5, h: 0.5, value: 1, step: 2, note: 'here' }])
    expect(doc.responses[1]).toMatchObject({ kind: 'recording', review: { id: 'r1', screenshots: ['.ferret/reviews/r1/01.png'] } })
  })
})

describe('手順の並び', () => {
  it('書かれた番号の順にし、1 から振り直す（同じ番号・番号なしは書いた順）', () => {
    const flow = orderFlow([
      step({ step: 3, action: 'c' }), step({ step: 1, action: 'a' }), step({ step: '2', action: 'b' }), step({ step: 1, action: 'a2' }), step({ action: 'none' })
    ])
    expect(flow.map((s) => [s.step, s.action])).toEqual([[1, 'a'], [2, 'a2'], [3, 'b'], [4, 'c'], [5, 'none']])
  })

  it('番号が飛んでいても通しにする。配列でなければ空。数は上限まで', () => {
    expect(orderFlow([step({ step: 10 }), step({ step: 20 })]).map((s) => s.step)).toEqual([1, 2])
    expect(orderFlow('x')).toEqual([])
    expect(orderFlow(Array.from({ length: VALUE_LIMITS.steps + 10 }, () => step()))).toHaveLength(VALUE_LIMITS.steps)
  })

  it('番号が数でない・無限は書いた位置で並べる', () => {
    const flow = orderFlow([step({ step: 'abc', action: 'first' }), step({ step: Infinity, action: 'second' }), step({ step: 0, action: 'zero' })])
    expect(flow.map((s) => s.action)).toEqual(['zero', 'first', 'second'])
  })
})

describe('数（N 個の価値 / M 個が動く）と完成', () => {
  it('今の作りごとに数える。書かれていないものは不明', () => {
    const doc = parse({ values: [
      value({ id: 'a', status: 'works', flow: [step(), step()] }), value({ id: 'b', status: 'works' }), value({ id: 'c', status: 'partial' }),
      value({ id: 'd', status: 'broken' }), value({ id: 'e', status: 'not-built', flow: [] }), value({ id: 'f' })
    ] })
    expect(summarizeValues(doc)).toEqual({ values: 6, works: 2, partial: 1, broken: 1, notBuilt: 1, unknown: 1, steps: 6 })
    expect(isComplete(doc)).toBe(false)
  })

  it('すべて動けば完成。価値が無ければ完成ではない', () => {
    expect(isComplete(parse({ values: [value({ id: 'a', status: 'works' }), value({ id: 'b', status: 'works' })] }))).toBe(true)
    expect(isComplete({ values: [] })).toBe(false)
    expect(summarizeValues({ values: [] })).toEqual({ values: 0, works: 0, partial: 0, broken: 0, notBuilt: 0, unknown: 0, steps: 0 })
  })
})

describe('手順の通しの番号（フィードバックの囲み）', () => {
  const doc = parse({ values: [
    value({ id: 'a', flow: [step({ image: '.ferret/a.png' }), step()] }),
    value({ id: 'b', flow: [] }),
    value({ id: 'c', flow: [step({ image: '.ferret/c1.png' }), step({ image: '.ferret/c2.png' }), step()] })
  ] })

  it('価値と手順 ↔ 通しの番号', () => {
    expect(flatStepIndex(doc, 0, 0)).toBe(0)
    expect(flatStepIndex(doc, 0, 1)).toBe(1)
    expect(flatStepIndex(doc, 2, 0)).toBe(2)
    expect(flatStepIndex(doc, 2, 2)).toBe(4)
    expect(stepAt(doc, 0)).toEqual({ value: 0, step: 0 })
    expect(stepAt(doc, 2)).toEqual({ value: 2, step: 0 })
    expect(stepAt(doc, 4)).toEqual({ value: 2, step: 2 })
    expect(stepAt(doc, 5)).toBeNull()
    expect(stepAt(doc, -1)).toBeNull()
    expect(stepAt(doc, 1.5)).toBeNull()
    for (let flat = 0; flat < 5; flat++) {
      const at = stepAt(doc, flat)!
      expect(flatStepIndex(doc, at.value, at.step)).toBe(flat)
    }
  })

  it('囲みを価値と手順の番号に直す。画像の無い手順・範囲の外は落とす', () => {
    const box = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }
    expect(toValueBoxes(doc, [{ ...box, screen: 0, note: 'n' }, { ...box, screen: 1 }, { ...box, screen: 3 }, { ...box, screen: 9 }])).toEqual([
      { ...box, value: 0, step: 0, note: 'n' },
      { ...box, value: 2, step: 1 }
    ])
    expect(toValueBoxes(doc, undefined)).toEqual([])
  })
})

describe('並び・待っている数・状態の移り変わり', () => {
  it('新しい順（直した時刻 → 作った時刻 → ファイルの時刻）', () => {
    const a = parse({ createdAt: '2026-11-13T09:00:00Z' }, 'a')
    const b = parse({ createdAt: '2026-11-13T08:00:00Z', updatedAt: '2026-11-13T12:00:00Z' }, 'b')
    const c = parse({ createdAt: '' }, 'c')
    expect(sortValueDocs([{ plan: a }, { plan: b }, { plan: c, mtime: Date.parse('2026-11-13T10:00:00Z') }]).map((d) => d.id)).toEqual(['b', 'c', 'a'])
  })

  it('待っている数と、新しく出たもの', () => {
    const a = parse({}, 'a')
    const b = parse({ status: 'approved' }, 'b')
    expect(pendingCount([a, b])).toBe(1)
    const marks = planMarks([a, b])
    expect(newlyProposed(marks, [a, b])).toEqual([])
    const a2 = parse({ revision: 2 }, 'a')
    expect(newlyProposed(marks, [a2, b]).map((d) => d.id)).toEqual(['a'])
    const b2 = parse({ status: 'proposed', revision: 1 }, 'b')
    expect(newlyProposed(marks, [a, b2]).map((d) => d.id)).toEqual(['b'])
  })

  it('返事は待っているものにだけ。承認で approved、フィードバックで changes-requested。知らない項目は残す', () => {
    const doc = parse()
    const next = applyValueResponse({ ...raw(), extra: 'keep' }, doc, { at: 't', action: 'approve' })!
    expect(next).toMatchObject({ status: 'approved', extra: 'keep', responses: [{ at: 't', action: 'approve', revision: 1 }] })
    expect(applyValueResponse(raw(), doc, { at: 't', action: 'feedback', text: 'x' })).toMatchObject({ status: 'changes-requested' })
    for (const status of ['approved', 'changes-requested', 'done'] as const) {
      expect(applyValueResponse(raw(), { ...doc, status }, { at: 't', action: 'approve' })).toBeNull()
    }
  })

  it('返事の履歴は上限まで（古いものから捨てる）', () => {
    const responses = Array.from({ length: LIMITS.responses + 5 }, (_, i) => ({ at: `${i}`, action: 'feedback', revision: 1 }))
    const next = applyValueResponse(raw({ responses }), parse(), { at: 'new', action: 'approve' })!
    const list = next.responses as Array<{ at: string }>
    expect(list).toHaveLength(LIMITS.responses)
    expect(list.at(-1)!.at).toBe('new')
  })
})

describe('Agent へ送る文', () => {
  const doc = parse({ values: [value({ name: 'Send an invoice' }), value({ id: 'b', name: 'See who paid' })] })

  it('承認: ファイル・版・価値の数と、作り方（works・done）を書く', () => {
    const ja = valueResponseMessage(doc, { action: 'approve' }, 'ja')
    expect(ja).toContain('[Ferret 価値ユースケース]')
    expect(ja).toContain(`${VALUE_USECASE_DIR}/app.json`)
    expect(ja).toContain('第1版')
    expect(ja).toContain('価値 2 個')
    expect(ja).toContain('"works"')
    expect(ja).toContain('"done"')
    const en = valueResponseMessage(doc, { action: 'approve' }, 'en')
    expect(en).toContain('[Ferret value use cases]')
    expect(en).toContain('2 values')
  })

  it('フィードバック: まだ作らない。文・囲み（価値と手順は 1 から、名前付き）・録画のレビュー', () => {
    const message = valueResponseMessage(doc, {
      action: 'feedback',
      text: '請求書を消す価値が無い',
      boxes: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4, value: 1, step: 0, note: 'ここ' }],
      review: { id: 'r1', dir: '.ferret/reviews/r1', findings: ['ボタン — 大きく'], screenshots: ['.ferret/reviews/r1/01.png'] }
    }, 'ja')
    expect(message).toContain('まだ作らないでください')
    expect(message).toContain('フィードバック: 請求書を消す価値が無い')
    expect(message).toContain('価値 2 (See who paid) 手順 1: x=10% y=20% w=30% h=40% — ここ')
    expect(message).toContain('.ferret/reviews/r1/feedback.md')
    expect(message).toContain('ボタン — 大きく')
    const en = valueResponseMessage(doc, { action: 'feedback', boxes: [{ x: 0, y: 0, w: 1, h: 1, value: 7, step: 2 }] }, 'en')
    expect(en).toContain('Do not build yet')
    expect(en).toContain('value 8 step 3: x=0% y=0% w=100% h=100%')
  })

  it('長すぎる文は切る', () => {
    const message = valueResponseMessage(doc, { action: 'feedback', text: 'x'.repeat(20000) }, 'en')
    expect(message.length).toBeLessThanOrEqual(7500)
    expect(message.endsWith('…')).toBe(true)
  })
})

describe('画面から来た返事を確かめる', () => {
  it('承認・フィードバック以外・形の違うものは null', () => {
    expect(sanitizeValueReply(null)).toBeNull()
    expect(sanitizeValueReply({ action: 'delete' })).toBeNull()
    expect(sanitizeValueReply({ action: 'feedback' })).toBeNull()
    expect(sanitizeValueReply({ action: 'feedback', text: '   ' })).toBeNull()
  })

  it('囲みは通しの番号で、手順の数の上限まで受ける（ビジュアルレビューの画面の数より多くてよい）', () => {
    const box = { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }
    const reply = sanitizeValueReply({ action: 'feedback', boxes: [{ ...box, screen: 40 }, { ...box, screen: VALUE_LIMITS.totalSteps }, { ...box, screen: -1 }, { ...box, screen: 1.5 }] })
    expect(reply).toEqual({ action: 'feedback', boxes: [{ ...box, screen: 40 }] })
    expect(sanitizeValueReply({ action: 'approve', text: ' ok ' })).toEqual({ action: 'approve', text: 'ok' })
  })
})

describe('見張るパス', () => {
  it('価値ユースケースのフォルダの下だけ', () => {
    expect(isValueUseCasePath('.ferret/value-usecases/app.json')).toBe(true)
    expect(isValueUseCasePath('.ferret\\value-usecases\\app\\a.png')).toBe(true)
    expect(isValueUseCasePath('.ferret/value-usecases')).toBe(false)
    expect(isValueUseCasePath('.ferret/visual-review/a.json')).toBe(false)
    expect(isValueUseCasePath('src/value-usecases/a.json')).toBe(false)
  })
})
