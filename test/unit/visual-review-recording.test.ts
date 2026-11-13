/**
 * ビジュアルレビューの「声と書き込みでフィードバック」（src/shared/visualReviewRecording.ts と、visualReview.ts の録画の返事）。
 * 録画・パイプライン・ネットワークは使わない（純粋な関数と、一時フォルダへの計画の書き足しだけ）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LIMITS,
  applyResponse,
  parseRecordedReview,
  parseVisualPlan,
  responseMessage,
  sanitizeRecordingNote,
  sanitizeReply,
  type RecordedReviewRef,
  type VisualPlan
} from '../../src/shared/visualReview'
import {
  beginRecordingFeedback,
  canAttachTo,
  linkFinishedReview,
  recordedReviewRef,
  updateRecordingNote,
  type PendingRecordingFeedback,
  type RecordedReviewDigest
} from '../../src/shared/visualReviewRecording'
import { readVisualPlan, writeVisualPlanResponse } from '../../src/main/visualReview'

const plan = (over: Partial<VisualPlan> = {}): Pick<VisualPlan, 'id' | 'status' | 'revision'> => ({ id: 'p1', status: 'proposed', revision: 2, ...over })

const pending = (over: Partial<PendingRecordingFeedback> = {}): PendingRecordingFeedback => ({
  kind: 'visual-review', planId: 'p1', folderPath: '/work/app', revision: 2, phase: 'recording', note: {}, ...over
})

const digest = (over: Partial<RecordedReviewDigest> = {}): RecordedReviewDigest => ({
  id: '20261113-101500',
  relativeDir: '.ferret/reviews/20261113-101500',
  items: [
    { title: 'ボタンの色', request: '保存ボタンを青にしてほしい', images: ['./01.png', './02.png'], include: true },
    { title: '見出し', request: '見出し', images: ['./03.png'], include: true },
    { title: '外した指摘', request: '送らない', images: ['./09.png'], include: false }
  ],
  transcript: [{ text: '  ここの 保存ボタンは\n青に ' }, { text: '' }, { text: '見出しはもっと大きく' }],
  ...over
})

const ref = (over: Partial<RecordedReviewRef> = {}): RecordedReviewRef => ({
  id: '20261113-101500',
  dir: '.ferret/reviews/20261113-101500',
  findings: ['ボタンの色 — 保存ボタンを青にしてほしい'],
  screenshots: ['.ferret/reviews/20261113-101500/01.png'],
  transcript: '保存ボタンは青に',
  ...over
})

describe('声と書き込みのフィードバックを始める', () => {
  it('返事を待っている計画なら、版とフォルダと打った文を控えて始める', () => {
    const result = beginRecordingFeedback({ current: null, plan: plan(), folderPath: '/work/app', recording: false, note: { text: '  左に寄せて ', boxes: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, screen: 0 }] } })
    expect(result).toEqual({ ok: true, pending: { kind: 'visual-review', planId: 'p1', folderPath: '/work/app', revision: 2, phase: 'recording', note: { text: '左に寄せて', boxes: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, screen: 0 }] } } })
  })

  it('録画中・ほかの計画をまとめている途中は始めない', () => {
    expect(beginRecordingFeedback({ current: null, plan: plan(), folderPath: '/w', recording: true })).toEqual({ ok: false, reason: 'busy' })
    expect(beginRecordingFeedback({ current: pending({ phase: 'processing', planId: 'other' }), plan: plan(), folderPath: '/w', recording: false })).toEqual({ ok: false, reason: 'busy' })
  })

  it('フォルダが無ければ始めない。計画の状態にかかわらず始められる（フィードバックはいつでも）', () => {
    expect(beginRecordingFeedback({ current: null, plan: plan(), folderPath: null, recording: false })).toEqual({ ok: false, reason: 'no-folder' })
    for (const status of ['approved', 'changes-requested', 'done'] as const) {
      expect(beginRecordingFeedback({ current: null, plan: plan({ status }), folderPath: '/w', recording: false }).ok).toBe(true)
    }
  })

  it('おかしな文・囲みは捨てて空で始める', () => {
    const result = beginRecordingFeedback({ current: null, plan: plan(), folderPath: '/w', recording: false, note: { text: 42, boxes: [{ x: 'a' }, { x: 0, y: 0, w: 0.5, h: 0.5, screen: 99 }] } })
    expect(result.ok && result.pending.note).toEqual({ text: '42' })
    expect(beginRecordingFeedback({ current: null, plan: plan(), folderPath: '/w', recording: false, note: 'text' }).ok && true).toBe(true)
  })
})

describe('録画中に打った文・囲みを控える', () => {
  it('録画中の同じ計画なら差し替える', () => {
    const next = updateRecordingNote(pending(), 'p1', { text: 'もっと大きく' })
    expect(next?.note).toEqual({ text: 'もっと大きく' })
  })

  it('ほかの計画・まとめている途中・何も無いときは変えない', () => {
    const current = pending()
    expect(updateRecordingNote(current, 'p2', { text: 'x' })).toBe(current)
    const processing = pending({ phase: 'processing', note: { text: '前' } })
    expect(updateRecordingNote(processing, 'p1', { text: '後' })).toBe(processing)
    expect(updateRecordingNote(null, 'p1', { text: 'x' })).toBeNull()
  })
})

describe('止めてできたレビューを、待っている計画に結びつける', () => {
  it('声と書き込みの録画で、同じプロジェクトなら添える', () => {
    expect(linkFinishedReview(pending(), { reviewId: '20261113-101500', folderPath: '/work/app' })).toBe('attach')
  })

  it('待っていない・もうまとめている途中なら、ふつうのレビューとして扱う', () => {
    expect(linkFinishedReview(null, { reviewId: '20261113-101500', folderPath: '/work/app' })).toBe('ignore')
    expect(linkFinishedReview(pending({ phase: 'processing' }), { reviewId: '20261113-101500', folderPath: '/work/app' })).toBe('ignore')
  })

  it('録画中にプロジェクトを替えた・フォルダが無いなら添えない', () => {
    expect(linkFinishedReview(pending(), { reviewId: '20261113-101500', folderPath: '/work/other' })).toBe('other-project')
    expect(linkFinishedReview(pending(), { reviewId: '20261113-101500', folderPath: null })).toBe('other-project')
  })

  it('レビューの id がおかしければ添えない', () => {
    for (const reviewId of ['', '../x', 'a/b', '.hidden', 'x'.repeat(81)]) {
      expect(linkFinishedReview(pending(), { reviewId, folderPath: '/work/app' })).toBe('invalid')
    }
  })

  it('計画がまだ同じ版のときだけ添える（状態は問わない）', () => {
    expect(canAttachTo(pending(), plan())).toBe(true)
    expect(canAttachTo(pending(), plan({ revision: 3 }))).toBe(false) // 録っている間に Agent が書き直した
    expect(canAttachTo(pending(), plan({ status: 'changes-requested' }))).toBe(true) // 文で先に返していても、録画も添える
    expect(canAttachTo(pending(), plan({ id: 'p2' }))).toBe(false)
    expect(canAttachTo(pending(), null)).toBe(false)
    expect(canAttachTo(pending(), undefined)).toBe(false)
  })
})

describe('録画のレビューから計画に書くもの', () => {
  it('送る指摘・画像・発言の抜粋を、プロジェクトの根からのパスで作る', () => {
    expect(recordedReviewRef(digest())).toEqual({
      id: '20261113-101500',
      dir: '.ferret/reviews/20261113-101500',
      findings: ['ボタンの色 — 保存ボタンを青にしてほしい', '見出し'],
      screenshots: ['.ferret/reviews/20261113-101500/01.png', '.ferret/reviews/20261113-101500/02.png', '.ferret/reviews/20261113-101500/03.png'],
      transcript: 'ここの 保存ボタンは 青に 見出しはもっと大きく'
    })
  })

  it('外した指摘の画像・おかしな画像の名前は入れない。同じ画像は1回', () => {
    const out = recordedReviewRef(digest({ items: [
      { title: 'a', request: 'b', images: ['./01.png', './01.png', '../x.png', '/etc/passwd', './a.png', 'https://x/1.png'], include: true },
      { title: 'c', request: 'd', images: ['./05.png'], include: false }
    ] }))
    expect(out?.screenshots).toEqual(['.ferret/reviews/20261113-101500/01.png'])
  })

  it('発言だけでも添える（指摘が無い・全部外した）', () => {
    const out = recordedReviewRef(digest({ items: [{ title: 'x', request: 'y', images: [], include: false }] }))
    expect(out?.findings).toEqual([])
    expect(out?.screenshots).toEqual([])
    expect(out?.transcript).toContain('保存ボタン')
  })

  it('指摘だけでも添える（文字起こしが無い）', () => {
    const out = recordedReviewRef(digest({ transcript: [] }))
    expect(out?.findings).toHaveLength(2)
    expect(out?.transcript).toBeUndefined()
  })

  it('何も取れなければ null（計画には送らず、レビューとして残す）', () => {
    expect(recordedReviewRef(digest({ items: [], transcript: [] }))).toBeNull()
    expect(recordedReviewRef(digest({ items: [{ title: '  ', request: '', images: ['./01.png'], include: true }], transcript: [{ text: ' \n ' }] }))).toBeNull()
  })

  it('長い発言・多すぎる指摘と画像は上限で切る', () => {
    const out = recordedReviewRef(digest({
      items: Array.from({ length: 50 }, (_, i) => ({ title: `t${i}`, request: `r${i}`, images: [`./${String(i).padStart(2, '0')}.png`], include: true })),
      transcript: Array.from({ length: 500 }, () => ({ text: 'あいうえおかきくけこ' }))
    }))
    expect(out?.findings).toHaveLength(LIMITS.findings)
    expect(out?.screenshots).toHaveLength(LIMITS.screenshots)
    expect(out!.transcript!.length).toBeLessThanOrEqual(LIMITS.transcript)
    expect(out!.transcript!.endsWith('…')).toBe(true)
  })

  it('.ferret/ の外のフォルダ（古い .ade-movie など）は添えない', () => {
    expect(recordedReviewRef(digest({ relativeDir: '.ade-movie/reviews/20261113-101500' }))).toBeNull()
  })
})

describe('計画に書かれた録画のレビューを読む', () => {
  it('正しいものは読める', () => {
    expect(parseRecordedReview(ref())).toEqual(ref())
  })

  it('id・フォルダがおかしければ読まない', () => {
    expect(parseRecordedReview(null)).toBeNull()
    expect(parseRecordedReview(ref({ id: '../x' }))).toBeNull()
    expect(parseRecordedReview(ref({ dir: '/tmp/reviews/20261113-101500' }))).toBeNull()
    expect(parseRecordedReview(ref({ dir: '.ferret/reviews/other' }))).toBeNull()
    expect(parseRecordedReview(ref({ dir: '.ferret/../reviews/20261113-101500' }))).toBeNull()
    expect(parseRecordedReview(ref({ dir: 'src/20261113-101500' }))).toBeNull()
  })

  it('フォルダの外を指す画像・文字でない指摘は外す', () => {
    const out = parseRecordedReview({ ...ref(), findings: ['ok', 3, null, ''], screenshots: ['.ferret/reviews/20261113-101500/02.png', '.ferret/visual-review/p1/screen.jpg', '../../etc/x.png', 5] })
    expect(out?.findings).toEqual(['ok', '3'])
    expect(out?.screenshots).toEqual(['.ferret/reviews/20261113-101500/02.png'])
  })

  it('計画の JSON の返事に書かれた録画を読み直せる（承認には付けない）', () => {
    const parsed = parseVisualPlan({
      title: 't', screens: [{ image: '.ferret/visual-review/p1/s.png', caption: '', annotations: [] }],
      responses: [
        { at: '2026-11-13T10:00:00Z', action: 'feedback', revision: 1, kind: 'recording', review: ref(), text: 'あわせて' },
        { at: '2026-11-13T10:00:00Z', action: 'approve', revision: 2, kind: 'recording', review: ref() },
        { at: '2026-11-13T10:00:00Z', action: 'feedback', revision: 1, kind: 'recording', review: { id: '../x' }, text: 'こわれた' }
      ]
    }, 'p1')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.plan.responses[0]).toEqual({ at: '2026-11-13T10:00:00Z', action: 'feedback', revision: 1, kind: 'recording', review: ref(), text: 'あわせて' })
    expect(parsed.plan.responses[1]).toEqual({ at: '2026-11-13T10:00:00Z', action: 'approve', revision: 2 })
    expect(parsed.plan.responses[2]).toEqual({ at: '2026-11-13T10:00:00Z', action: 'feedback', revision: 1, text: 'こわれた' })
  })
})

describe('録画のフィードバックで計画の状態が変わる', () => {
  const full = (status: VisualPlan['status']): VisualPlan => {
    const parsed = parseVisualPlan({ title: 't', status, revision: 2, behaviour: [{ before: '', after: 'x' }] }, 'p1')
    if (!parsed.ok) throw new Error(parsed.reason)
    return parsed.plan
  }

  it('返事を待っている計画は「直し中」になり、返事に録画が残る', () => {
    const next = applyResponse({ title: 't', status: 'proposed' }, full('proposed'), { at: 'now', action: 'feedback', kind: 'recording', review: ref(), text: '文も' })
    expect(next?.status).toBe('changes-requested')
    expect(next?.responses).toEqual([{ at: 'now', action: 'feedback', kind: 'recording', review: ref(), text: '文も', revision: 2 }])
  })

  it('返事を待っていなくても書く（フィードバックはいつでも）', () => {
    expect(applyResponse({}, full('changes-requested'), { at: 'now', action: 'feedback', kind: 'recording', review: ref() })?.status).toBe('changes-requested')
    expect(applyResponse({}, full('done'), { at: 'now', action: 'feedback', kind: 'recording', review: ref() })?.status).toBe('changes-requested')
  })
})

describe('Agent へ送る文（録画のフィードバック）', () => {
  const p = { id: 'p1', title: '設定にダークモード', revision: 2 }

  it('レビューのフォルダ・読むファイル・指摘・画像・発言を書く（日本語）', () => {
    const ja = responseMessage(p, { action: 'feedback', text: '文でも', review: ref() }, 'ja')
    expect(ja).toContain('まだ実装しないでください')
    expect(ja).toContain('フィードバック: 文でも')
    expect(ja).toContain('.ferret/reviews/20261113-101500/feedback.md')
    expect(ja).toContain('.ferret/reviews/20261113-101500/transcript.jsonl')
    expect(ja).toContain('  1. ボタンの色 — 保存ボタンを青にしてほしい')
    expect(ja).toContain('画像: .ferret/reviews/20261113-101500/01.png')
    expect(ja).toContain('発言（抜粋）: 保存ボタンは青に')
  })

  it('英語でも同じことを書く', () => {
    const en = responseMessage(p, { action: 'feedback', review: ref() }, 'en')
    expect(en).toContain('Do not implement yet')
    expect(en).toContain('.ferret/reviews/20261113-101500/feedback.md')
    expect(en).toContain('Findings:')
    expect(en).toContain('Screenshots: .ferret/reviews/20261113-101500/01.png')
    expect(en).not.toContain('Feedback:')
  })

  it('指摘・画像が多ければ数を絞り、残りの数を書く', () => {
    const many = ref({
      findings: Array.from({ length: 20 }, (_, i) => `指摘${i + 1}`),
      screenshots: Array.from({ length: 12 }, (_, i) => `.ferret/reviews/20261113-101500/${String(i).padStart(2, '0')}.png`)
    })
    const ja = responseMessage(p, { action: 'feedback', review: many }, 'ja')
    expect(ja).toContain('  15. 指摘15')
    expect(ja).not.toContain('指摘16')
    expect(ja).toContain('ほか 5 件')
    expect(ja).toContain('ほか 4 枚')
  })

  it('指摘も画像も無ければ、その行は出さない', () => {
    const en = responseMessage(p, { action: 'feedback', review: ref({ findings: [], screenshots: [], transcript: undefined }) }, 'en')
    expect(en).not.toContain('Findings:')
    expect(en).not.toContain('Screenshots:')
    expect(en).not.toContain('excerpt')
    expect(en).toContain('feedback.md')
  })

  it('とても長くても上限で切る', () => {
    const message = responseMessage(p, { action: 'feedback', text: 'x'.repeat(4000), review: ref({ transcript: 'y'.repeat(1200), findings: Array.from({ length: 30 }, () => 'z'.repeat(2000)) }) }, 'ja')
    expect(message.length).toBeLessThanOrEqual(7500)
  })
})

describe('画面から来た、録画に添える文と囲み', () => {
  it('文と囲みを確かめる。どちらも無くてよい', () => {
    expect(sanitizeRecordingNote({})).toEqual({})
    expect(sanitizeRecordingNote(null)).toEqual({})
    expect(sanitizeRecordingNote({ text: ' a ', boxes: [{ x: 0.1, y: 0.1, w: 0.1, h: 0.1, screen: 1, note: ' n ' }] })).toEqual({ text: 'a', boxes: [{ x: 0.1, y: 0.1, w: 0.1, h: 0.1, screen: 1, note: 'n' }] })
  })

  it('画面からの返事に録画（kind・review）を混ぜても受けない（録画は main が読んで添える）', () => {
    const reply = sanitizeReply({ action: 'feedback', text: 'x', kind: 'recording', review: ref() })
    expect(reply).toEqual({ action: 'feedback', text: 'x' })
  })
})

describe('計画のファイルに録画の返事を書き足す（一時フォルダ）', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ferret-vr-rec-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('書いたあとに読み直すと、直し中で録画の返事が残っている。知らない項目も残る', async () => {
    await mkdir(join(root, '.ferret', 'visual-review'), { recursive: true })
    await writeFile(join(root, '.ferret', 'visual-review', 'p1.json'), JSON.stringify({ title: 't', revision: 2, status: 'proposed', behaviour: [{ after: 'x' }], extra: 1 }))
    const written = await writeVisualPlanResponse(root, 'p1', { at: '2026-11-13T10:00:00Z', action: 'feedback', kind: 'recording', review: ref(), text: '文' })
    expect(written?.status).toBe('changes-requested')
    expect(written?.responses.at(-1)).toEqual({ at: '2026-11-13T10:00:00Z', action: 'feedback', revision: 2, kind: 'recording', review: ref(), text: '文' })
    const raw = JSON.parse(await readFile(join(root, '.ferret', 'visual-review', 'p1.json'), 'utf8')) as Record<string, unknown>
    expect(raw.extra).toBe(1)
    expect((await readVisualPlan(root, 'p1'))?.plan.responses).toHaveLength(1)
    // 2回目（もう待っていない）も、フィードバックなら書き足す
    expect((await writeVisualPlanResponse(root, 'p1', { at: 'x', action: 'feedback', kind: 'recording', review: ref() }))?.responses).toHaveLength(2)
  })
})
