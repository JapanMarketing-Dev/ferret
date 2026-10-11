/**
 * オーケストラのフィードバックの記録（@shared/feedbackLog）の純粋な処理：
 * 文の切り詰め・時刻・枠の拾い方・出来事の読み書き・指摘ごとの段階（送った → 直した → 人が反応した）・log.md の形・記録先の決め方
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_FEEDBACK_ENTRY_BYTES,
  TRUNCATED_MARKER,
  afterImageName,
  answersFeedbackText,
  cleanText,
  feedbackTarget,
  fileSafe,
  findingImageName,
  findingKey,
  findingOutcome,
  findingSentEvent,
  foldFeedback,
  formatFeedbackTime,
  messageEvent,
  oneLine,
  parseFeedbackEvent,
  parseFeedbackEvents,
  penFrames,
  playbookTemplate,
  progressChanges,
  renderFeedbackLog,
  requestsFeedbackText,
  truncateUtf8,
  type FeedbackEvent,
  type FindingSentEvent,
  type PendingFix
} from '../../src/shared/feedbackLog'
import type { ProgressMap } from '../../src/shared/findingProgress'
import type { Project } from '../../src/shared/types'

const bytes = (s: string) => new TextEncoder().encode(s).length

describe('truncateUtf8', () => {
  it('上限ちょうどまでは切らない', () => {
    const text = 'a'.repeat(MAX_FEEDBACK_ENTRY_BYTES)
    expect(truncateUtf8(text)).toEqual({ text, truncated: false })
  })
  it('1バイト超えたら切って印を付け、印も含めて上限に収める', () => {
    const r = truncateUtf8('a'.repeat(MAX_FEEDBACK_ENTRY_BYTES + 1))
    expect(r.truncated).toBe(true)
    expect(r.text.endsWith(TRUNCATED_MARKER)).toBe(true)
    expect(bytes(r.text)).toBeLessThanOrEqual(MAX_FEEDBACK_ENTRY_BYTES)
  })
  it('日本語（3バイト）・絵文字（サロゲートペア）を途中で切らない', () => {
    const r = truncateUtf8('あ'.repeat(10) + '😀'.repeat(10), 40)
    expect(r.truncated).toBe(true)
    expect(bytes(r.text)).toBeLessThanOrEqual(40)
    expect(r.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(r.text.replace(`\n${TRUNCATED_MARKER}`, '')).toMatch(/^あ+$/)
  })
  it('上限が印より小さい・0・負なら印だけ', () => {
    expect(truncateUtf8('long text here', 3)).toEqual({ text: TRUNCATED_MARKER, truncated: true })
    expect(truncateUtf8('x', 0).text).toBe(TRUNCATED_MARKER)
    expect(truncateUtf8('x', -5).text).toBe(TRUNCATED_MARKER)
  })
  it('空文字は空のまま', () => {
    expect(truncateUtf8('')).toEqual({ text: '', truncated: false })
  })
})

describe('cleanText・oneLine・fileSafe', () => {
  it('改行をそろえ前後の空白を落とす', () => {
    expect(cleanText('  \r\nline1\r\nline2\r  ')).toBe('line1\nline2')
  })
  it('oneLine は改行・制御文字を空白にし、長いものは … で切る', () => {
    expect(oneLine('a\nb\tc\u0007d')).toBe('a b c d')
    expect(oneLine('x'.repeat(10), 5)).toBe('xxxx…')
    expect(oneLine(undefined as unknown as string)).toBe('')
  })
  it('fileSafe は英数字・_・- だけにし、空なら x', () => {
    expect(fileSafe('../../etc/passwd')).toBe('etc-passwd')
    expect(fileSafe('日本語')).toBe('x')
    expect(fileSafe('a'.repeat(100), 8)).toBe('aaaaaaaa')
  })
})

describe('formatFeedbackTime', () => {
  const at = new Date('2026-10-11T05:03:09Z')
  it('時差を付けて地域の時刻で書く', () => {
    expect(formatFeedbackTime(at, 540)).toBe('2026-10-11 14:03 +09:00')
    expect(formatFeedbackTime(at, 0)).toBe('2026-10-11 05:03 +00:00')
    expect(formatFeedbackTime(at, -330)).toBe('2026-10-10 23:33 -05:30')
  })
  it('ISO の文字列も読む。読めない時刻は unknown time', () => {
    expect(formatFeedbackTime('2026-10-11T05:03:09Z', 540)).toBe('2026-10-11 14:03 +09:00')
    expect(formatFeedbackTime('nope')).toBe('unknown time')
    expect(formatFeedbackTime(new Date(NaN))).toBe('unknown time')
  })
  it('時差を渡さなければその環境の時差（テストは Asia/Tokyo）', () => {
    expect(formatFeedbackTime(at)).toBe('2026-10-11 14:03 +09:00')
  })
})

describe('画像の名前', () => {
  it('feedback/images の下の安全な名前にする', () => {
    expect(findingImageName('3f9a1c22-xxxx', '20261011-140300', 'i1', 1)).toBe('images/3f9a1c22-20261011-140300-i1-1.png')
    expect(afterImageName('p', '20261011-140300', '../i2', 2, 'JPG')).toBe('images/p-20261011-140300-i2-after-2.jpg')
    expect(afterImageName('p', 'r', 'i', 1, 'exe')).toBe('images/p-r-i-after-1.png')
  })
})

describe('penFrames（人が描いた枠の位置と形）', () => {
  const events = [
    { t: 1, type: 'nav', url: 'x' },
    { t: 2, type: 'pen', id: 'p1', t_end: 3, bbox: [10.4, 20.6, 100, 40], shape: 'rect', view: { w: 1280, h: 800 } },
    { t: 3, type: 'pen', id: 'p2', t_end: 4, bbox: [1, 2, 3, 4] },
    { t: 4, type: 'pen', id: 'p3', t_end: 5, bbox: [1, 2, 3] },
    { t: 5, type: 'pen', id: 'p4', t_end: 6, bbox: [1, 2, 3, Number.NaN] },
    null, 'junk'
  ]
  it('指摘の annotationIds の枠だけを、丸めた座標と形で拾う', () => {
    expect(penFrames(events, ['p1', 'p2'])).toEqual([
      { bbox: [10, 21, 100, 40], shape: 'rect', view: { w: 1280, h: 800 } },
      { bbox: [1, 2, 3, 4], shape: 'pen' }
    ])
  })
  it('壊れた bbox・知らない id・枠の無い指摘は空', () => {
    expect(penFrames(events, ['p3', 'p4', 'zzz'])).toEqual([])
    expect(penFrames(events, [])).toEqual([])
    expect(penFrames([], ['p1'])).toEqual([])
  })
  it('20 個を超える枠は捨てる', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ type: 'pen', id: `p${i}`, bbox: [i, i, 1, 1] }))
    expect(penFrames(many, many.map((e) => e.id))).toHaveLength(20)
  })
})

const AT = '2026-10-11T05:00:00.000Z'
const iso = (min: number) => new Date(Date.parse(AT) + min * 60_000).toISOString()

function sent(findingId = 'i1', over: Partial<Parameters<typeof findingSentEvent>[0]> = {}): FindingSentEvent {
  return findingSentEvent({
    at: AT, projectId: 'proj', product: 'Shop', reviewId: '20261011-140000', reviewDir: '/w/shop/.ferret/reviews/20261011-140000',
    item: { id: findingId, index: 1, title: 'Header button', request: 'Make the Sign up button match the benchmark', quotes: [{ speaker: 'self', text: 'this is too small' }], context: { url: 'http://localhost:3000/' } },
    images: ['images/proj-20261011-140000-i1-1.png'], missingImages: 0, frames: [{ bbox: [1, 2, 3, 4], shape: 'rect' }],
    ...over
  })
}

describe('findingSentEvent・messageEvent', () => {
  it('指摘1件を key 付きの出来事にする', () => {
    const e = sent()
    expect(e.key).toBe(findingKey('proj', '20261011-140000', 'i1'))
    expect(e.key).toBe('proj:20261011-140000/i1')
    expect(e.quotes).toEqual([{ speaker: 'self', text: 'this is too small' }])
    expect(e.url).toBe('http://localhost:3000/')
    expect(e.missingImages).toBeUndefined()
  })
  it('長すぎる要望は切る。空の発話は捨て、話者の名前があればそれを使う', () => {
    const e = sent('i1', { item: { id: 'i1', index: 2, title: 't', request: 'x'.repeat(20_000), quotes: [{ speaker: 'other', name: 'Ken', text: 'hi' }, { speaker: 'self', text: '   ' }], context: {} } })
    expect(bytes(e.request)).toBeLessThanOrEqual(MAX_FEEDBACK_ENTRY_BYTES)
    expect(e.request.endsWith(TRUNCATED_MARKER)).toBe(true)
    expect(e.quotes).toEqual([{ speaker: 'Ken', text: 'hi' }])
    expect(e.url).toBeUndefined()
  })
  it('写せなかった画像の数を残す。画像は4枚まで', () => {
    const e = sent('i1', { images: ['a', 'b', 'c', 'd', 'e'].map((x) => `images/${x}.png`), missingImages: 2 })
    expect(e.images).toHaveLength(4)
    expect(e.missingImages).toBe(2)
  })
  it('空の文は記録しない。知らない経路は text にする', () => {
    expect(messageEvent({ at: AT, product: 'Shop', channel: 'text', text: '  \n ' })).toBeNull()
    expect(messageEvent({ at: AT, product: 'Shop', channel: 'bogus' as 'text', text: 'hi' })!.channel).toBe('text')
  })
  it('8 KB を超える文は切って印を付ける', () => {
    const e = messageEvent({ at: AT, product: 'Shop', channel: 'answers', text: 'あ'.repeat(5000) })!
    expect(bytes(e.text)).toBeLessThanOrEqual(MAX_FEEDBACK_ENTRY_BYTES)
    expect(e.text.endsWith(TRUNCATED_MARKER)).toBe(true)
  })
})

describe('parseFeedbackEvents（log.jsonl を読む）', () => {
  it('書いた出来事をそのまま読み戻す', () => {
    const events: FeedbackEvent[] = [
      sent(),
      { v: 1, type: 'fix', at: iso(1), key: sent().key, status: 'human_review', note: 'made it bigger', after: 'images/p-r-i1-after-1.png' },
      { v: 1, type: 'reaction', at: iso(2), key: sent().key, verdict: 'ng', text: 'still smaller than the benchmark' },
      messageEvent({ at: iso(3), product: 'Shop', channel: 'text', text: 'hello' })!
    ]
    const text = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
    expect(parseFeedbackEvents(text)).toEqual(events)
  })
  it('壊れた行・書きかけの行・知らない種類・版の違う行は飛ばす', () => {
    const good = JSON.stringify(messageEvent({ at: AT, product: 'S', channel: 'text', text: 'ok' }))
    const text = ['{"v":1,"type":"message"', 'not json', JSON.stringify({ v: 2, type: 'message', at: AT, channel: 'text', text: 'x' }), JSON.stringify({ v: 1, type: 'other', at: AT }), '', good].join('\n')
    expect(parseFeedbackEvents(text)).toHaveLength(1)
  })
  it('危ない画像のパス（上へ出る・絶対パス）は落とす', () => {
    const e = parseFeedbackEvent({ ...sent(), images: ['../../etc/passwd', '/abs.png', 'images/ok.png', 'images/a/b.png'] }) as FindingSentEvent
    expect(e.images).toEqual(['images/ok.png'])
    expect(parseFeedbackEvent({ v: 1, type: 'fix', at: AT, key: 'k', status: 'human_review', after: '../x.png' })).toEqual({ v: 1, type: 'fix', at: AT, key: 'k', status: 'human_review' })
  })
  it('時刻の無い・読めない出来事、知らない判断・状態は null', () => {
    expect(parseFeedbackEvent({ v: 1, type: 'reaction', at: 'x', key: 'k', verdict: 'ok' })).toBeNull()
    expect(parseFeedbackEvent({ v: 1, type: 'reaction', at: AT, key: 'k', verdict: 'maybe' })).toBeNull()
    expect(parseFeedbackEvent({ v: 1, type: 'fix', at: AT, key: 'k', status: 'todo' })).toBeNull()
    expect(parseFeedbackEvent(null)).toBeNull()
    expect(parseFeedbackEvent([])).toBeNull()
  })
  it('壊れた枠は捨て、正しい枠の形（rect）は残す', () => {
    const e = parseFeedbackEvent({ ...sent(), frames: [{ bbox: [1, 2, 3, 4], shape: 'rect' }, { bbox: 'x' }, null] }) as FindingSentEvent
    expect(e.frames).toEqual([{ bbox: [1, 2, 3, 4], shape: 'rect' }])
  })
})

/** 段階を進めるための小さな道具：progressChanges の結果を記録に足した形にする */
function apply(events: FeedbackEvent[], projectId: string, reviewId: string, progress: ProgressMap, at: string): FeedbackEvent[] {
  const steps = progressChanges(foldFeedback(events), projectId, reviewId, progress)
  return [...events, ...steps.map((s): FeedbackEvent => (s.type === 'pendingFix'
    ? { v: 1, type: 'fix', at, key: s.key, status: s.status, ...(s.note ? { note: s.note } : {}), ...(s.afterSource ? { after: `images/after-${s.n}.png` } : {}) }
    : s))]
}

describe('progressChanges（送った → 直した → 人が反応した）', () => {
  const P = 'proj'
  const R = '20261011-140000'
  const key = findingKey(P, R, 'i1')

  it('送っていない指摘・他のレビューの指摘は何も足さない', () => {
    const state = foldFeedback([sent()])
    expect(progressChanges(state, P, R, { i9: { status: 'human_review' } })).toEqual([])
    expect(progressChanges(state, P, 'other', { i1: { status: 'human_review' } })).toEqual([])
    expect(progressChanges(state, 'other', R, { i1: { status: 'human_review' } })).toEqual([])
  })

  it('対応中（in_progress）はまだ直していないので足さない', () => {
    expect(progressChanges(foldFeedback([sent()]), P, R, { i1: { status: 'in_progress' } })).toEqual([])
  })

  it('Agent が直した（human_review）ら、ひとことと AFTER の元の場所付きで1回だけ足す', () => {
    const progress: ProgressMap = { i1: { status: 'human_review', note: 'assumed the header button', after: 'after/i1.png' } }
    const steps = progressChanges(foldFeedback([sent()]), P, R, progress)
    expect(steps).toEqual([{ type: 'pendingFix', key, findingId: 'i1', status: 'human_review', note: 'assumed the header button', afterSource: 'after/i1.png', n: 1 }])
    // 同じ値をもう一度見ても重ねない
    const events = apply([sent()], P, R, progress, iso(1))
    expect(progressChanges(foldFeedback(events), P, R, progress)).toEqual([])
  })

  it('AFTER の無い直しも記録する（画像が無いことが分かるように）', () => {
    const steps = progressChanges(foldFeedback([sent()]), P, R, { i1: { status: 'human_review', note: 'no screenshot: needs login' } }) as PendingFix[]
    expect(steps[0]!.afterSource).toBeUndefined()
    expect(steps[0]!.note).toBe('no screenshot: needs login')
  })

  it('同じ回でひとことを書き直したら、新しい直しとして足す', () => {
    let events = apply([sent()], P, R, { i1: { status: 'human_review', note: 'v1', after: 'after/i1.png' } }, iso(1))
    events = apply(events, P, R, { i1: { status: 'human_review', note: 'v2', after: 'after/i1.png' } }, iso(2))
    const fixes = foldFeedback(events).findings.get(key)!.timeline.filter((s) => s.kind === 'fix')
    expect(fixes.map((f) => f.kind === 'fix' && f.note)).toEqual(['v1', 'v2'])
  })

  it('人の反応は history から、記録した最後の反応より新しいものだけを足す', () => {
    let events = apply([sent()], P, R, { i1: { status: 'human_review', after: 'after/i1.png' } }, iso(1))
    const history = [{ at: iso(2), verdict: 'comment' as const, text: 'looks closer' }]
    events = apply(events, P, R, { i1: { status: 'human_review', after: 'after/i1.png', history } }, iso(2))
    // コメントだけでは直しを重ねない
    expect(foldFeedback(events).findings.get(key)!.timeline.map((s) => s.kind)).toEqual(['fix', 'reaction'])
    // 同じ history をもう一度見ても重ねない
    expect(progressChanges(foldFeedback(events), P, R, { i1: { status: 'human_review', after: 'after/i1.png', history } })).toEqual([])
  })

  it('直しの前の値と OK の後の値を続けて見ると、直した → OK の順に1つずつ', () => {
    let events = apply([sent()], P, R, { i1: { status: 'human_review', note: 'fixed', after: 'after/i1.png' } }, iso(1))
    events = apply(events, P, R, { i1: { status: 'done', after: 'after/i1.png', history: [{ at: iso(2), verdict: 'ok' }] } }, iso(2))
    const record = foldFeedback(events).findings.get(key)!
    expect(record.timeline.map((s) => (s.kind === 'reaction' ? s.verdict : s.kind))).toEqual(['fix', 'ok'])
    expect(findingOutcome(record)).toBe('accepted on the first fix')
  })

  it('見ないうちに直して OK された（done だけ見た）ときは、直したことを OK の前に1つ足す', () => {
    const steps = progressChanges(foldFeedback([sent()]), P, R, { i1: { status: 'done', after: 'after/i1.png', history: [{ at: iso(5), verdict: 'ok' }] } })
    expect(steps.map((s) => s.type)).toEqual(['pendingFix', 'reaction'])
    expect((steps[0] as PendingFix).status).toBe('done')
  })

  it('NG → 直し直し → OK：同じ AFTER のパスでも新しい直しとして数え、画像の番号が増える', () => {
    let events = apply([sent()], P, R, { i1: { status: 'human_review', note: 'bigger', after: 'after/i1.png' } }, iso(1))
    events = apply(events, P, R, { i1: { status: 'in_progress', after: 'after/i1.png', queued: true, history: [{ at: iso(2), verdict: 'ng', text: 'still not like the benchmark' }] } }, iso(2))
    const again = progressChanges(foldFeedback(events), P, R, { i1: { status: 'human_review', note: 'bigger', after: 'after/i1.png', history: [{ at: iso(2), verdict: 'ng', text: 'still not like the benchmark' }] } })
    expect(again).toEqual([{ type: 'pendingFix', key, findingId: 'i1', status: 'human_review', note: 'bigger', afterSource: 'after/i1.png', n: 2 }])
    events = apply(events, P, R, { i1: { status: 'human_review', note: 'bigger', after: 'after/i1.png', history: [{ at: iso(2), verdict: 'ng', text: 'still not like the benchmark' }] } }, iso(3))
    events = apply(events, P, R, { i1: { status: 'done', after: 'after/i1.png', history: [{ at: iso(2), verdict: 'ng', text: 'still not like the benchmark' }, { at: iso(4), verdict: 'ok' }] } }, iso(4))
    const record = foldFeedback(events).findings.get(key)!
    expect(record.timeline.map((s) => (s.kind === 'reaction' ? s.verdict : s.kind))).toEqual(['fix', 'ng', 'fix', 'ok'])
    expect(findingOutcome(record)).toBe('accepted after 1 rejection')
  })

  it('NG と直し直しを一度に見たら（見ないうちに両方起きた）、NG の後ろに直しを置く', () => {
    const events = apply([sent()], P, R, { i1: { status: 'human_review', note: 'first', after: 'after/i1.png' } }, iso(1))
    const steps = progressChanges(foldFeedback(events), P, R, { i1: { status: 'human_review', note: 'first', after: 'after/i1.png', history: [{ at: iso(2), verdict: 'ng', text: 'no' }] } })
    expect(steps.map((s) => (s.type === 'reaction' ? s.verdict : s.type))).toEqual(['ng', 'pendingFix'])
  })

  it('OK の後に NG（やり直し）：やり直しとして残り、結果は reopened', () => {
    let events = apply([sent()], P, R, { i1: { status: 'human_review', after: 'after/i1.png' } }, iso(1))
    events = apply(events, P, R, { i1: { status: 'done', after: 'after/i1.png', history: [{ at: iso(2), verdict: 'ok' }] } }, iso(2))
    events = apply(events, P, R, { i1: { status: 'in_progress', after: 'after/i1.png', queued: true, history: [{ at: iso(2), verdict: 'ok' }, { at: iso(3), verdict: 'ng', text: 'broke on mobile' }] } }, iso(3))
    const record = foldFeedback(events).findings.get(key)!
    expect(record.timeline.map((s) => (s.kind === 'reaction' ? s.verdict : s.kind))).toEqual(['fix', 'ok', 'ng'])
    expect(findingOutcome(record)).toBe('rejected 1 time (reopened after OK); waiting for the agent to fix again')
  })

  it('人の反応がまだ無い・直しもまだ無い指摘の結果', () => {
    expect(findingOutcome(foldFeedback([sent()]).findings.get(key)!)).toBe('sent, agent working')
    const events = apply([sent()], P, R, { i1: { status: 'human_review' } }, iso(1))
    expect(findingOutcome(foldFeedback(events).findings.get(key)!)).toBe('agent fixed, waiting for the human')
  })
})

describe('foldFeedback', () => {
  it('送り直した指摘は1組のまま、中身を新しくして経過に「送り直した」を足す', () => {
    const state = foldFeedback([sent(), sent('i1', { at: iso(9), item: { id: 'i1', index: 3, title: 'New title', request: 'r', quotes: [], context: {} } })])
    expect(state.records).toHaveLength(1)
    const record = state.findings.get(findingKey('proj', '20261011-140000', 'i1'))!
    expect(record.finding.title).toBe('New title')
    expect(record.timeline).toEqual([{ kind: 'sent', at: iso(9) }])
  })
  it('送っていない指摘への直し・反応は捨てる。文は出た順に残す', () => {
    const state = foldFeedback([
      { v: 1, type: 'fix', at: AT, key: 'nobody', status: 'human_review' },
      messageEvent({ at: AT, product: 'S', channel: 'text', text: 'a' })!,
      sent(),
      messageEvent({ at: AT, product: 'S', channel: 'answers', text: 'b' })!
    ])
    expect(state.records.map((r) => r.kind)).toEqual(['message', 'finding', 'message'])
  })
})

describe('renderFeedbackLog（log.md）', () => {
  it('記録が無ければ頭と「まだ無い」だけ', () => {
    const md = renderFeedbackLog(foldFeedback([]), 'My orchestra')
    expect(md).toContain('# Feedback log — My orchestra')
    expect(md).toContain('(No feedback recorded yet.)')
  })
  it('指摘は1組（画像・枠・話したこと・直し・反応）で、新しいものが上', () => {
    const key = findingKey('proj', '20261011-140000', 'i1')
    const md = renderFeedbackLog(foldFeedback([
      sent(),
      { v: 1, type: 'fix', at: iso(1), key, status: 'human_review', note: 'made it 20% bigger', after: 'images/proj-r-i1-after-1.png' },
      { v: 1, type: 'reaction', at: iso(2), key, verdict: 'ng', text: 'the benchmark uses a pill shape' },
      messageEvent({ at: iso(3), product: 'Blog', channel: 'text', text: 'later message' })!
    ]), 'O', 540)
    expect(md.indexOf('later message')).toBeLessThan(md.indexOf('finding #1'))
    expect(md).toContain('## 2026-10-11 14:00 +09:00 · Shop · finding #1: Header button')
    expect(md).toContain('![finding 1 image 1')
    expect(md).toContain('(images/proj-20261011-140000-i1-1.png)')
    expect(md).toContain('- box at x=1, y=2, 3×4')
    expect(md).toContain('Request: Make the Sign up button match the benchmark')
    expect(md).toContain('self: this is too small')
    expect(md).toContain('agent fixed (human_review): made it 20% bigger')
    expect(md).toContain('![after fix](images/proj-r-i1-after-1.png)')
    expect(md).toContain('human NG (rejected the fix): “the benchmark uses a pill shape”')
    expect(md).toContain('outcome: **rejected 1 time; waiting for the agent to fix again**')
    expect(md).toContain('· Blog · text')
  })
  it('画像が無い・写せなかった・AFTER が無いことを書く', () => {
    const key = findingKey('proj', '20261011-140000', 'i1')
    const md = renderFeedbackLog(foldFeedback([sent('i1', { images: [], missingImages: 2, frames: [] }), { v: 1, type: 'fix', at: iso(1), key, status: 'human_review' }]), 'O')
    expect(md).toContain('images not kept: 2')
    expect(md).toContain('no after screenshot')
    expect(md).toContain('(no reaction from the human yet)')
    const none = renderFeedbackLog(foldFeedback([sent('i1', { images: [], frames: [] })]), 'O')
    expect(none).toContain('- no image')
  })
  it('本文のバッククォートや見出しが記録の形を壊さない（フェンスを長くする）', () => {
    const md = renderFeedbackLog(foldFeedback([messageEvent({ at: AT, product: 'S', channel: 'text', text: '```\n## not a heading\n````' })!]), 'O')
    expect(md).toContain('`````text')
  })
})

describe('playbookTemplate', () => {
  it('人の枠・ベンチマーク・教訓（Agent の間違いと人の望み）の見出しを持つ', () => {
    const md = playbookTemplate('Shop group')
    for (const word of ['# Playbook — Shop group', '## Frame set by the human', '## Benchmarks', '## Lessons', 'Agent got wrong', 'never overwrites']) expect(md).toContain(word)
  })
})

describe('feedbackTarget（どのオーケストラに記録するか）', () => {
  const p = (over: Partial<Project> & { id: string }): Project => ({ name: over.id, folderPath: `/w/${over.id}`, urls: [], ...over })
  const orchestra = p({ id: 'o1', name: 'Orchestra', editorWorkspace: true, orchestrator: true })
  const projects = [orchestra, p({ id: 'shop', orchestraId: 'o1' }), p({ id: 'out', orchestraId: 'o1', orchestraExcluded: true }), p({ id: 'remote', orchestraId: 'o1', source: 'ssh' })]

  it('オーケストラに属するプロダクトはその所属に、プロダクトの名前で', () => {
    expect(feedbackTarget(projects, 'shop')).toEqual({ orchestra, product: 'shop' })
  })
  it('オーケストラ自身はそのまま（名前はオーケストラ）', () => {
    expect(feedbackTarget(projects, 'o1')).toEqual({ orchestra, product: 'Orchestra' })
  })
  it('外したもの・SSH・知らない id・null は記録しない', () => {
    expect(feedbackTarget(projects, 'out')).toBeNull()
    expect(feedbackTarget(projects, 'remote')).toBeNull()
    expect(feedbackTarget(projects, 'nope')).toBeNull()
    expect(feedbackTarget(projects, null)).toBeNull()
    expect(feedbackTarget(projects, undefined)).toBeNull()
  })
  it('オーケストラが1つも無ければ記録しない', () => {
    expect(feedbackTarget([p({ id: 'solo' })], 'solo')).toBeNull()
  })
})

describe('経路ごとの文', () => {
  it('human.md の答えは答えた項目だけ', () => {
    const text = answersFeedbackText([
      { key: 'D1', label: 'Shop', note: 'Pick the pricing layout', answer: '1. Three tiers — like Stripe' },
      { key: 'D2', label: 'Blog', note: 'unanswered' },
      { key: 'D3', label: '', note: '', answer: '  ' }
    ])
    expect(text).toBe('- D1 [Shop] Pick the pricing layout → 1. Three tiers — like Stripe')
  })
  it('依頼は組み込みのままなら名前だけ、変えた・自作なら文面も', () => {
    const text = requestsFeedbackText([
      { title: 'Security check', text: 'long built-in text', custom: false, edited: false },
      { title: 'Match benchmark', text: 'Compare with Linear', custom: true, edited: false },
      { title: '', text: 'edited', custom: false, edited: true }
    ])
    expect(text).toBe('### Security check (built-in request)\n\n### Match benchmark\nCompare with Linear\n\n### (untitled)\nedited')
  })
})
