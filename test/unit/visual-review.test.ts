import { describe, expect, it } from 'vitest'
import {
  LIMITS,
  applyResponse,
  canRespond,
  clampBox,
  imageMime,
  isSafePlanImage,
  isValidPlanId,
  isVisualReviewPath,
  newlyProposed,
  nextStatus,
  normalizePlanImage,
  parseVisualPlan,
  pendingCount,
  planIdFromFile,
  planMarks,
  responseMessage,
  sanitizeReply,
  shouldAutoOpenVisualReview,
  sortPlans,
  type VisualPlan
} from '../../src/shared/visualReview'

const validRaw = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'p1',
  title: '設定にダークモード',
  request: 'ダークモードを足して',
  revision: 1,
  createdAt: '2026-11-13T10:00:00.000Z',
  status: 'proposed',
  terminalId: 't3',
  screens: [{
    image: '.ferret/visual-review/p1/screen-1.jpg',
    url: 'http://localhost:3000/settings',
    caption: '設定',
    annotations: [
      { x: 0.1, y: 0.2, w: 0.3, h: 0.1, kind: 'add', label: '切り替え', after: '右上にトグル' },
      { x: 0.5, y: 0.5, w: 0.2, h: 0.2, kind: 'change', label: '保存', before: '灰色', after: '青' }
    ]
  }],
  behaviour: [{ before: '再読み込みで反映', after: 'すぐ反映' }],
  outOfScope: ['ほかのページ'],
  questions: ['OS の設定に合わせる？'],
  ...over
})

const parse = (raw: unknown, id = 'p1'): VisualPlan => {
  const result = parseVisualPlan(raw, id)
  if (!result.ok) throw new Error(result.reason)
  return result.plan
}

const reason = (raw: unknown, id = 'p1'): string => {
  const result = parseVisualPlan(raw, id)
  if (result.ok) throw new Error('expected failure')
  return result.reason
}

describe('計画の id とファイル名', () => {
  it('英数字と . _ - の 80 文字まで。先頭は英数字、.. は不可', () => {
    expect(isValidPlanId('20261113-dark.mode_v2')).toBe(true)
    expect(isValidPlanId('a'.repeat(80))).toBe(true)
    expect(isValidPlanId('a'.repeat(81))).toBe(false)
    expect(isValidPlanId('')).toBe(false)
    expect(isValidPlanId('.hidden')).toBe(false)
    expect(isValidPlanId('-x')).toBe(false)
    expect(isValidPlanId('a..b')).toBe(false)
    expect(isValidPlanId('a/b')).toBe(false)
    expect(isValidPlanId('日本語')).toBe(false)
    expect(isValidPlanId(3)).toBe(false)
  })

  it('<id>.json だけを計画のファイルとして拾う', () => {
    expect(planIdFromFile('p1.json')).toBe('p1')
    expect(planIdFromFile('p1.json.tmp')).toBeNull()
    expect(planIdFromFile('.json')).toBeNull()
    expect(planIdFromFile('../x.json')).toBeNull()
    expect(planIdFromFile('p1.txt')).toBeNull()
  })

  it('変更の通知は .ferret/visual-review/ の下だけ（区切りは \\ でも）', () => {
    expect(isVisualReviewPath('.ferret/visual-review/p1.json')).toBe(true)
    expect(isVisualReviewPath('.ferret\\visual-review\\p1\\a.png')).toBe(true)
    expect(isVisualReviewPath('.ferret/visual-review')).toBe(false)
    expect(isVisualReviewPath('.ferret/reviews/x/progress.json')).toBe(false)
    expect(isVisualReviewPath('src/visual-review/a.json')).toBe(false)
  })
})

describe('画像のパス（.ferret/ の下の画像だけ）', () => {
  it('.ferret/ の下の画像はそのまま、.ferret/ を省いた書き方は補う', () => {
    expect(normalizePlanImage('.ferret/screens/latest.jpg')).toBe('.ferret/screens/latest.jpg')
    expect(normalizePlanImage('screens/latest.jpg')).toBe('.ferret/screens/latest.jpg')
    expect(normalizePlanImage('./.ferret/visual-review/p1/a.PNG')).toBe('.ferret/visual-review/p1/a.PNG')
    expect(normalizePlanImage('.ferret\\screens\\pages\\x.webp')).toBe('.ferret/screens/pages/x.webp')
    expect(normalizePlanImage('  .ferret/a.svg  ')).toBe('.ferret/a.svg')
  })

  it('外を指す・絶対パス・URL・画像でない・空の区切りは断る', () => {
    for (const bad of ['/etc/passwd.png', 'C:/x.png', 'file:///x.png', 'https://e.com/a.png', 'data:image/png;base64,AA',
      '.ferret/../src/a.png', '../a.png', '.ferret/screens/../../a.png', '.ferret//a.png', '.ferret/screens/latest.html',
      '.ferret/a.json', '', '   ', 'a\0.png', 'x'.repeat(401) + '.png']) {
      expect(normalizePlanImage(bad), bad).toBeNull()
    }
    expect(normalizePlanImage(42)).toBeNull()
    expect(normalizePlanImage(null)).toBeNull()
  })

  it('安全な形か（直したものと同じときだけ）・MIME', () => {
    expect(isSafePlanImage('.ferret/screens/latest.jpg')).toBe(true)
    expect(isSafePlanImage('screens/latest.jpg')).toBe(false)
    expect(imageMime('a.jpg')).toBe('image/jpeg')
    expect(imageMime('a.JPEG')).toBe('image/jpeg')
    expect(imageMime('a.png')).toBe('image/png')
    expect(imageMime('a.svg')).toBe('image/svg+xml')
    expect(imageMime('a.webp')).toBe('image/webp')
  })
})

describe('枠を画像の中に収める', () => {
  it('中にある枠はそのまま', () => {
    expect(clampBox({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 })).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 })
  })

  it('はみ出しは切る（右下・左上）', () => {
    expect(clampBox({ x: 0.8, y: 0.9, w: 0.5, h: 0.5 })).toEqual({ x: 0.8, y: 0.9, w: 0.2, h: 0.1 })
    expect(clampBox({ x: -0.2, y: -0.1, w: 0.5, h: 0.3 })).toEqual({ x: 0, y: 0, w: 0.3, h: 0.2 })
  })

  it('負の幅・高さは向きを直す', () => {
    expect(clampBox({ x: 0.5, y: 0.5, w: -0.2, h: -0.1 })).toEqual({ x: 0.3, y: 0.4, w: 0.2, h: 0.1 })
  })

  it('画素らしい値は画像の大きさで割る。大きさが無ければ捨てる', () => {
    expect(clampBox({ x: 100, y: 50, w: 200, h: 100 }, { width: 1000, height: 500 })).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 })
    expect(clampBox({ x: 100, y: 50, w: 200, h: 100 })).toBeNull()
    expect(clampBox({ x: 100, y: 50, w: 200, h: 100 }, { width: 0, height: 0 })).toBeNull()
  })

  it('境目：x+w がちょうど 1・1.5 までは割合として扱う', () => {
    expect(clampBox({ x: 0, y: 0, w: 1, h: 1 })).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expect(clampBox({ x: 0.5, y: 0, w: 1, h: 0.5 })).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 })
  })

  it('数でない値は捨てる', () => {
    expect(clampBox({ x: '0.1', y: 0, w: 0.1, h: 0.1 })).toBeNull()
    expect(clampBox({ x: Number.NaN, y: 0, w: 0.1, h: 0.1 })).toBeNull()
    expect(clampBox({ x: Number.POSITIVE_INFINITY, y: 0, w: 0.1, h: 0.1 })).toBeNull()
    expect(clampBox({ y: 0, w: 0.1, h: 0.1 })).toBeNull()
  })

  it('小さすぎる枠・外に出た枠は、見える最小の大きさにして中へ寄せる', () => {
    expect(clampBox({ x: 0.5, y: 0.5, w: 0, h: 0 })).toEqual({ x: 0.5, y: 0.5, w: 0.01, h: 0.01 })
    expect(clampBox({ x: 1.2, y: 1.2, w: 0.1, h: 0.1 })).toEqual({ x: 0.99, y: 0.99, w: 0.01, h: 0.01 })
  })
})

describe('計画の JSON を読む', () => {
  it('正しい計画を読む（ファイル名の id を使う）', () => {
    const plan = parse(validRaw({ id: 'other' }), 'p1')
    expect(plan.id).toBe('p1')
    expect(plan.title).toBe('設定にダークモード')
    expect(plan.screens[0]!.annotations).toHaveLength(2)
    expect(plan.screens[0]!.annotations[1]).toMatchObject({ kind: 'change', before: '灰色', after: '青' })
    expect(plan.screens[0]!.annotations[0]!.before).toBeUndefined()
    expect(plan.behaviour).toEqual([{ before: '再読み込みで反映', after: 'すぐ反映' }])
    expect(plan.terminalId).toBe('t3')
    expect(plan.responses).toEqual([])
  })

  it('壊れたもの・必須の欠けは理由を返す', () => {
    expect(reason(null)).toMatch(/object/)
    expect(reason([])).toMatch(/object/)
    expect(reason('x')).toMatch(/object/)
    expect(reason(validRaw({ title: '' }))).toMatch(/title/)
    expect(reason(validRaw({ title: undefined }))).toMatch(/title/)
    expect(reason(validRaw({ title: { a: 1 } }))).toMatch(/title/)
    expect(reason(validRaw(), '../x')).toMatch(/file name/)
    expect(reason(validRaw({ screens: [], behaviour: [] }))).toMatch(/screens/)
    expect(reason(validRaw({ screens: [{ image: '/etc/passwd' }], behaviour: [] }))).toMatch(/image/)
  })

  it('画面だけ・動きだけの計画も読む。英語の behavior も受ける', () => {
    expect(parse(validRaw({ behaviour: undefined })).behaviour).toEqual([])
    const onlyBehaviour = parse(validRaw({ screens: undefined, behaviour: undefined, behavior: [{ after: 'x' }] }))
    expect(onlyBehaviour.screens).toEqual([])
    expect(onlyBehaviour.behaviour).toEqual([{ before: '', after: 'x' }])
  })

  it('おかしな値は直して使う（状態・版・時刻・種類・ターミナル）', () => {
    const plan = parse(validRaw({ status: 'weird', revision: -3.7, createdAt: 'yesterday', terminalId: 't 1; rm -rf' }))
    expect(plan.status).toBe('proposed')
    expect(plan.revision).toBe(1)
    expect(plan.createdAt).toBe('')
    expect(plan.terminalId).toBeUndefined()
    expect(parse(validRaw({ status: 'APPROVED', revision: 2.9 }))).toMatchObject({ status: 'approved', revision: 2 })
    const kinds = parse(validRaw({ screens: [{ image: 'screens/a.jpg', annotations: [{ x: 0, y: 0, w: 0.1, h: 0.1, kind: 'explode', after: 'x' }] }] }))
    expect(kinds.screens[0]!.annotations[0]!.kind).toBe('change')
    expect(kinds.screens[0]!.annotations[0]!.label).toBe('x')
  })

  it('使えない枠・画面・項目は外す（ほかは残す）', () => {
    const plan = parse(validRaw({
      screens: [
        { image: '../x.png', annotations: [] },
        { image: 'screens/a.jpg', annotations: [{ x: 'a' }, { x: 0, y: 0, w: 0.1, h: 0.1 }, null, { x: 0, y: 0, w: 0.1, h: 0.1, label: 'ok', after: 'y' }] }
      ],
      outOfScope: ['a', 3, '', null, '  '],
      questions: 'not a list'
    }))
    expect(plan.screens).toHaveLength(1)
    expect(plan.screens[0]!.annotations).toHaveLength(1)
    expect(plan.outOfScope).toEqual(['a', '3'])
    expect(plan.questions).toEqual([])
  })

  it('画素で書いた枠は、画面の大きさ（width・height）があれば割合にする', () => {
    const plan = parse(validRaw({ screens: [{ image: 'screens/a.jpg', width: 1000, height: 500, annotations: [{ x: 500, y: 250, w: 100, h: 50, after: 'x' }] }] }))
    expect(plan.screens[0]!.annotations[0]).toMatchObject({ x: 0.5, y: 0.5, w: 0.1, h: 0.1 })
  })

  it('長さ・数の上限で切る', () => {
    const plan = parse(validRaw({
      title: 'あ'.repeat(LIMITS.title + 50),
      screens: Array.from({ length: LIMITS.screens + 5 }, () => ({
        image: 'screens/a.jpg',
        annotations: Array.from({ length: LIMITS.annotations + 5 }, () => ({ x: 0, y: 0, w: 0.1, h: 0.1, after: 'x' }))
      })),
      questions: Array.from({ length: LIMITS.listItems + 3 }, (_, i) => `q${i}`)
    }))
    expect(plan.title).toHaveLength(LIMITS.title)
    expect(plan.title.endsWith('…')).toBe(true)
    expect(plan.screens).toHaveLength(LIMITS.screens)
    expect(plan.screens[0]!.annotations).toHaveLength(LIMITS.annotations)
    expect(plan.questions).toHaveLength(LIMITS.listItems)
  })

  it('人の返事の記録を読む（壊れたものは外す）', () => {
    const plan = parse(validRaw({ responses: [
      { at: '2026-11-13T11:00:00Z', action: 'feedback', revision: 1, text: '色が違う', boxes: [{ x: 0, y: 0, w: 0.2, h: 0.2, screen: 0, note: 'ここ' }, { x: 'bad' }] },
      { action: 'delete' },
      'x'
    ] }))
    expect(plan.responses).toHaveLength(1)
    expect(plan.responses[0]!.boxes).toEqual([{ x: 0, y: 0, w: 0.2, h: 0.2, screen: 0, note: 'ここ' }])
  })
})

describe('並び・数・状態の移り変わり', () => {
  const plan = (id: string, createdAt: string, revision = 1, status: VisualPlan['status'] = 'proposed'): VisualPlan => ({
    ...parse(validRaw({ createdAt, revision, status }), id)
  })

  it('新しい順。同じ時刻なら版の大きい順、その次は id', () => {
    const sorted = sortPlans([
      { plan: plan('a', '2026-11-13T09:00:00Z') },
      { plan: plan('b', '2026-11-13T12:00:00Z') },
      { plan: plan('c', '2026-11-13T10:00:00Z', 1) },
      { plan: plan('d', '2026-11-13T10:00:00Z', 3) },
      { plan: plan('e', '2026-11-13T10:00:00Z', 1) }
    ])
    expect(sorted.map((p) => p.id)).toEqual(['b', 'd', 'c', 'e', 'a'])
  })

  it('時刻の無い計画はファイルの更新時刻で並べる', () => {
    const sorted = sortPlans([
      { plan: plan('old', 'x'), mtime: Date.parse('2026-01-01T00:00:00Z') },
      { plan: plan('new', 'x'), mtime: Date.parse('2026-12-01T00:00:00Z') },
      { plan: plan('mid', '2026-06-01T00:00:00Z') }
    ])
    expect(sorted.map((p) => p.id)).toEqual(['new', 'mid', 'old'])
  })

  it('タブに出す数の上限', () => {
    const many = Array.from({ length: LIMITS.plans + 10 }, (_, i) => ({ plan: plan(`p${i}`, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()) }))
    expect(sortPlans(many)).toHaveLength(LIMITS.plans)
  })

  it('返事を待っている数', () => {
    expect(pendingCount([plan('a', 'x'), plan('b', 'x', 1, 'approved'), plan('c', 'x', 1, 'done'), plan('d', 'x', 2)])).toBe(2)
    expect(pendingCount([])).toBe(0)
  })

  it('フィードバックはいつでも（→ changes-requested）。承認は proposed だけ（→ approved）', () => {
    expect(canRespond({ status: 'proposed' })).toBe(true)
    expect(canRespond({ status: 'proposed' }, 'approve')).toBe(true)
    for (const status of ['approved', 'changes-requested', 'done'] as const) {
      expect(canRespond({ status })).toBe(true)
      expect(canRespond({ status }, 'feedback')).toBe(true)
      expect(canRespond({ status }, 'approve')).toBe(false)
      expect(nextStatus(status, 'approve')).toBeNull()
      expect(nextStatus(status, 'feedback')).toBe('changes-requested')
    }
    expect(nextStatus('proposed', 'approve')).toBe('approved')
    expect(nextStatus('proposed', 'feedback')).toBe('changes-requested')
  })

  it('返事を書き足す。Agent の知らない項目は残し、版を付ける', () => {
    const raw = { ...validRaw({ revision: 2 }), custom: { keep: true } }
    const parsed = parse(raw)
    const next = applyResponse(raw, parsed, { at: 'now', action: 'feedback', text: '違う' })!
    expect(next.status).toBe('changes-requested')
    expect(next.custom).toEqual({ keep: true })
    expect(next.responses).toEqual([{ at: 'now', action: 'feedback', text: '違う', revision: 2 }])
    // 返事済み（もう待っていない）なら書かない
    expect(applyResponse(next, parse(next), { at: 'later', action: 'approve' })).toBeNull()
  })

  it('返事の記録は上限まで（古いものから落とす）', () => {
    const responses = Array.from({ length: LIMITS.responses + 5 }, (_, i) => ({ at: String(i), action: 'feedback', revision: 1 }))
    const raw = validRaw({ responses })
    const next = applyResponse(raw, parse(raw), { at: 'new', action: 'approve' })!
    const list = next.responses as Array<{ at: string }>
    expect(list).toHaveLength(LIMITS.responses)
    expect(list.at(-1)!.at).toBe('new')
  })

  it('新しく返事を待つ計画だけを拾う（同じ版のまま待っているものは拾わない・直した版は拾う）', () => {
    const before = [plan('a', 'x'), plan('b', 'x', 1, 'changes-requested')]
    const marks = planMarks(before)
    expect(newlyProposed(marks, before)).toEqual([])
    const after = [plan('a', 'x'), plan('b', 'x', 2), plan('c', 'x'), plan('d', 'x', 1, 'approved')]
    expect(newlyProposed(marks, after).map((p) => p.id)).toEqual(['b', 'c'])
  })

  it('下書き（drafting）が出た時点で拾う。同じ版の下書き → 返事待ちでは、もう一度は拾わない', () => {
    const marks = planMarks([])
    const draft = [plan('a', 'x', 1, 'drafting')]
    expect(newlyProposed(marks, draft).map((p) => p.id)).toEqual(['a'])
    const afterDraft = planMarks(draft)
    expect(newlyProposed(afterDraft, draft)).toEqual([])
    expect(newlyProposed(afterDraft, [plan('a', 'x', 1, 'proposed')])).toEqual([])
    // 次の版の下書きは、また拾う
    expect(newlyProposed(planMarks([plan('a', 'x', 1, 'changes-requested')]), [plan('a', 'x', 2, 'drafting')]).map((p) => p.id)).toEqual(['a'])
    // 下書きは返事待ちの数に入れない
    expect(pendingCount([plan('a', 'x', 1, 'drafting'), plan('b', 'x')])).toBe(1)
  })

  it('下書きは承認できない（フィードバックは送れる）', () => {
    const draft = parse(validRaw({ status: 'drafting' }))
    expect(draft.status).toBe('drafting')
    expect(canRespond(draft, 'approve')).toBe(false)
    expect(canRespond(draft, 'feedback')).toBe(true)
    expect(nextStatus('drafting', 'approve')).toBeNull()
    expect(applyResponse(validRaw({ status: 'drafting' }), draft, { at: 'now', action: 'approve' })).toBeNull()
  })

  it('下書きは画面も動きも無くてよい（タイトルだけで先に出せる）。下書きでなければ要る', () => {
    const bare = { title: '下書き', request: 'ボタンを足して', status: 'drafting' }
    const drafted = parseVisualPlan(bare, 'd1')
    expect(drafted.ok && drafted.plan.screens.length === 0 && drafted.plan.status === 'drafting').toBe(true)
    expect(parseVisualPlan({ ...bare, status: 'proposed' }, 'd1').ok).toBe(false)
    expect(parseVisualPlan({ ...bare, status: undefined }, 'd1').ok).toBe(false)
    expect(parseVisualPlan({ ...bare, status: ' Drafting ' }, 'd1').ok).toBe(true)
    // 下書きでもタイトルは要る
    expect(parseVisualPlan({ status: 'drafting' }, 'd1').ok).toBe(false)
  })
})

describe('Agent へ送る文', () => {
  const plan = { id: 'p1', title: 'ダークモード', revision: 2 }

  it('承認: 計画のとおりに作る・終わったら done', () => {
    const ja = responseMessage(plan, { action: 'approve' }, 'ja')
    expect(ja).toContain('[Ferret ビジュアルレビュー]')
    expect(ja).toContain('.ferret/visual-review/p1.json')
    expect(ja).toContain('第2版')
    expect(ja).toContain('"done"')
    const en = responseMessage(plan, { action: 'approve' }, 'en')
    expect(en).toMatch(/^\[Ferret visual review\].*approved/)
    expect(en).toContain('revision 2')
  })

  it('フィードバック: まだ作らない・版を上げて待つ・囲んだ場所を割合で書く', () => {
    const ja = responseMessage(plan, { action: 'feedback', text: 'ボタンは左', boxes: [{ x: 0.1, y: 0.2, w: 0.305, h: 0.1, screen: 1, note: 'ここ' }] }, 'ja')
    expect(ja).toContain('まだ実装しないでください')
    expect(ja).toContain('フィードバック: ボタンは左')
    expect(ja).toContain('1. screen 2: x=10% y=20% w=31% h=10% — ここ')
    const en = responseMessage(plan, { action: 'feedback', text: 'move it' }, 'en')
    expect(en).toContain('Do not implement yet')
    expect(en).toContain('Feedback: move it')
    expect(en).not.toContain('Areas')
  })

  it('長すぎる文は切る', () => {
    const message = responseMessage(plan, { action: 'feedback', text: 'x'.repeat(20000) }, 'en')
    expect(message.length).toBeLessThanOrEqual(7500)
    expect(message.endsWith('…')).toBe(true)
  })
})

describe('画面から来た返事を確かめる', () => {
  it('承認はそのまま、フィードバックは文か囲みが要る', () => {
    expect(sanitizeReply({ action: 'approve' })).toEqual({ action: 'approve' })
    expect(sanitizeReply({ action: 'feedback', text: '  違う ' })).toEqual({ action: 'feedback', text: '違う' })
    expect(sanitizeReply({ action: 'feedback', text: '   ' })).toBeNull()
    expect(sanitizeReply({ action: 'feedback', boxes: [{ x: 0, y: 0, w: 0.1, h: 0.1, screen: 0 }] })).toEqual({ action: 'feedback', boxes: [{ x: 0, y: 0, w: 0.1, h: 0.1, screen: 0 }] })
  })

  it('おかしな形・知らない操作・範囲外の画面の番号は断る・外す', () => {
    expect(sanitizeReply(null)).toBeNull()
    expect(sanitizeReply({ action: 'delete' })).toBeNull()
    expect(sanitizeReply('approve')).toBeNull()
    const reply = sanitizeReply({ action: 'feedback', text: 'x', boxes: [
      { x: 0, y: 0, w: 0.1, h: 0.1, screen: -1 },
      { x: 0, y: 0, w: 0.1, h: 0.1, screen: LIMITS.screens },
      { x: 0, y: 0, w: 0.1, h: 0.1, screen: 1.5 },
      { x: 1.2, y: 0, w: 0.2, h: 0.1, screen: 0, note: 'n' },
      { x: 200, y: 0, w: 50, h: 10, screen: 0 }
    ] })
    expect(reply?.boxes).toEqual([{ x: 0.99, y: 0, w: 0.01, h: 0.1, screen: 0, note: 'n' }])
  })
})

describe('新しい計画が出たときにタブを開くか', () => {
  it('ブラウザ・指摘を見ているだけなら開く', () => {
    expect(shouldAutoOpenVisualReview({ tab: 'browser', recording: false, typing: false })).toBe(true)
    expect(shouldAutoOpenVisualReview({ tab: 'findings', recording: false, typing: false })).toBe(true)
  })

  it('ファイル・設定・ダッシュボード・録画中・入力中は開かない', () => {
    expect(shouldAutoOpenVisualReview({ tab: 'file:/p/a.ts', recording: false, typing: false })).toBe(false)
    expect(shouldAutoOpenVisualReview({ tab: 'settings', recording: false, typing: false })).toBe(false)
    expect(shouldAutoOpenVisualReview({ tab: 'dashboard', recording: false, typing: false })).toBe(false)
    expect(shouldAutoOpenVisualReview({ tab: 'browser', recording: true, typing: false })).toBe(false)
    expect(shouldAutoOpenVisualReview({ tab: 'browser', recording: false, typing: true })).toBe(false)
  })
})

describe('プロジェクトを開き直したときに戻す中央のタブ', async () => {
  const { decodeCenterTab, encodeCenterTab } = await import('../../src/shared/projectSession')
  it('ビジュアルレビューのタブも覚えて戻す', () => {
    expect(encodeCenterTab('visual-review', '/p')).toBe('visual-review')
    expect(decodeCenterTab('visual-review', '/p')).toBe('visual-review')
  })
})
