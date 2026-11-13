/**
 * 価値ユースケースの main 側（src/main/valueUseCase.ts・valueUseCaseSkill.ts）と、ビジュアルレビューと共用にした部分
 * （声と書き込みの録画の結びつけ・見張り）を、一時フォルダで確かめる結合テスト。Electron・ネットワークは使わない
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listValueUseCases, readValueUseCase, writeValueUseCaseResponse } from '../../src/main/valueUseCase'
import { listVisualPlans } from '../../src/main/visualReview'
import { syncValueUseCaseSkill } from '../../src/main/valueUseCaseSkill'
import { syncVisualReviewSkill } from '../../src/main/visualReviewSkill'
import { shouldWatchDir } from '../../src/main/linuxTreeWatch'
import { ProjectWatcher } from '../../src/main/files'
import { VALUE_LIMITS } from '../../src/shared/valueUseCase'
import { VALUE_USECASE_SKILL_MARKER, VALUE_USECASE_SKILL_NAME, isValueUseCaseSkill, renderValueUseCaseSkill } from '../../src/shared/valueUseCaseSkill'
import { VISUAL_REVIEW_SKILL_NAME, renderVisualReviewSkill } from '../../src/shared/visualReviewSkill'
import { beginRecordingFeedback, canAttachTo, linkFinishedReview, noteScreens, updateRecordingNote } from '../../src/shared/visualReviewRecording'
import { LIMITS, type ReviewDocKind } from '../../src/shared/visualReview'

let root: string
let outside: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ferret-vuc-'))
  outside = await mkdtemp(join(tmpdir(), 'ferret-vuc-out-'))
})
afterEach(async () => {
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

const docJson = (id: string, over: Record<string, unknown> = {}): string => JSON.stringify({
  id, title: `system ${id}`, revision: 1, createdAt: '2026-11-13T10:00:00Z', status: 'proposed', purpose: 'p',
  values: [{ id: 'a', name: 'value a', flow: [{ screen: 'Home', action: 'press', expected: 'ok', image: `.ferret/value-usecases/${id}/1.png` }] }],
  extra: 'keep', ...over
})

async function writeDoc(id: string, text: string): Promise<void> {
  await mkdir(join(root, '.ferret', 'value-usecases'), { recursive: true })
  await writeFile(join(root, '.ferret', 'value-usecases', `${id}.json`), text)
}

describe('価値ユースケースの一覧', () => {
  it('無ければ空', async () => {
    expect(await listValueUseCases(root)).toEqual({ docs: [], invalid: [] })
  })

  it('新しい順に読み、読めないものは理由付きで別に返す。ビジュアルレビューの一覧には混ざらない', async () => {
    await writeDoc('a', docJson('a', { createdAt: '2026-11-13T09:00:00Z' }))
    await writeDoc('b', docJson('b', { createdAt: '2026-11-13T11:00:00Z' }))
    await writeDoc('broken', '{')
    await writeDoc('novalues', docJson('novalues', { values: [] }))
    await writeFile(join(root, '.ferret', 'value-usecases', 'bad name!.json'), docJson('x'))
    await mkdir(join(root, '.ferret', 'value-usecases', 'a'), { recursive: true })
    const listing = await listValueUseCases(root)
    expect(listing.docs.map((d) => d.id)).toEqual(['b', 'a'])
    expect(listing.invalid.map((i) => i.file)).toEqual(['bad name!.json', 'broken.json', 'novalues.json'])
    expect(await listVisualPlans(root)).toEqual({ plans: [], invalid: [] })
  })

  it('リンクの文書・大きすぎる文書は読まない。フォルダが外へのリンクなら何も読まない', async () => {
    await writeFile(join(outside, 'secret.json'), docJson('secret'))
    await mkdir(join(root, '.ferret', 'value-usecases'), { recursive: true })
    await symlink(join(outside, 'secret.json'), join(root, '.ferret', 'value-usecases', 'linked.json'))
    await writeDoc('big', docJson('big', { purpose: 'x'.repeat(VALUE_LIMITS.docBytes) }))
    const listing = await listValueUseCases(root)
    expect(listing.docs).toEqual([])
    // リンクは普通のファイルでないので数えない（一覧にも出さない）。大きすぎるものは理由付き
    expect(listing.invalid.map((i) => i.file)).toEqual(['big.json'])

    const other = await mkdtemp(join(tmpdir(), 'ferret-vuc-link-'))
    try {
      await mkdir(join(other, '.ferret'), { recursive: true })
      await writeFile(join(outside, 'x.json'), docJson('x'))
      await symlink(outside, join(other, '.ferret', 'value-usecases'))
      expect(await listValueUseCases(other)).toEqual({ docs: [], invalid: [] })
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })
})

describe('価値ユースケースに返事を書き足す', () => {
  it('承認で approved にし、知らない項目は残す。2回目は書かない', async () => {
    await writeDoc('app', docJson('app'))
    const doc = await writeValueUseCaseResponse(root, 'app', { at: '2026-11-13T12:00:00Z', action: 'approve' })
    expect(doc?.status).toBe('approved')
    const saved = JSON.parse(await readFile(join(root, '.ferret', 'value-usecases', 'app.json'), 'utf8')) as Record<string, unknown>
    expect(saved).toMatchObject({ status: 'approved', extra: 'keep', responses: [{ action: 'approve', revision: 1 }] })
    expect(await writeValueUseCaseResponse(root, 'app', { at: 'x', action: 'approve' })).toBeNull()
  })

  it('フィードバックで changes-requested にし、囲み（価値と手順）と録画のレビューを残す', async () => {
    await writeDoc('app', docJson('app'))
    const doc = await writeValueUseCaseResponse(root, 'app', {
      at: 't', action: 'feedback', kind: 'recording', text: 'more',
      boxes: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, value: 0, step: 0, note: 'n' }],
      review: { id: 'r1', dir: '.ferret/reviews/r1', findings: ['f'], screenshots: [] }
    })
    expect(doc?.status).toBe('changes-requested')
    expect(doc?.responses[0]).toMatchObject({ kind: 'recording', text: 'more', boxes: [{ value: 0, step: 0, note: 'n' }], review: { id: 'r1' } })
  })

  it('無い・読めない・おかしな id は null。リンクの文書は書き換えない', async () => {
    expect(await readValueUseCase(root, 'none')).toBeNull()
    expect(await readValueUseCase(root, '../x')).toBeNull()
    await writeDoc('bad', '{')
    expect(await writeValueUseCaseResponse(root, 'bad', { at: 't', action: 'approve' })).toBeNull()
    const target = join(outside, 'doc.json')
    await writeFile(target, docJson('linked'))
    await symlink(target, join(root, '.ferret', 'value-usecases', 'linked.json'))
    expect(await writeValueUseCaseResponse(root, 'linked', { at: 't', action: 'approve' })).toBeNull()
    expect(JSON.parse(await readFile(target, 'utf8'))).toMatchObject({ status: 'proposed' })
  })
})

describe('skill「ferret-value-usecases」', () => {
  it('印・名前・書き方（価値・最初の画面からの流れ・スクリーンショット・承認待ち）を含む', () => {
    const text = renderValueUseCaseSkill('1.2.3')
    expect(text.startsWith(`---\nname: ${VALUE_USECASE_SKILL_NAME}\n`)).toBe(true)
    expect(isValueUseCaseSkill(text)).toBe(true)
    expect(text).toContain(VALUE_USECASE_SKILL_MARKER)
    expect(text).toContain('<!-- Ferret 1.2.3 -->')
    for (const word of ['価値', 'ユースケース', '存在意義', '.ferret/value-usecases/<id>.json', '.ferret/screens/', 'very first screen', '$FERRET_TERMINAL_ID', 'Stop and wait', '"works"', '.ferret/reviews/<id>/', '"status": "drafting"', 'Keep it current']) {
      expect(text).toContain(word)
    }
    // 例の JSON はそのまま読める
    const example = /```json\n([\s\S]*?)\n```/.exec(text)![1]!.replace(/<[^>]+>/g, 'x')
    expect(() => JSON.parse(example)).not.toThrow()
  })

  it('ビジュアルレビューの skill は、承認済みの価値ユースケースに合わせるよう1行で触れる', () => {
    expect(renderVisualReviewSkill('1.0.0')).toContain('.ferret/value-usecases/')
  })

  it('設定のフォルダがある Agent にだけ入れ、同じ中身なら書き直さない。Ferret のものでない skill・リンクは触らない', async () => {
    const home = root
    await mkdir(join(home, '.claude'), { recursive: true })
    expect(await syncValueUseCaseSkill('1.0.0', home, {})).toBe(1)
    const path = join(home, '.claude', 'skills', VALUE_USECASE_SKILL_NAME, 'SKILL.md')
    expect(isValueUseCaseSkill(await readFile(path, 'utf8'))).toBe(true)
    await expect(lstat(join(home, '.codex'))).rejects.toThrow()
    expect(await syncValueUseCaseSkill('1.0.0', home, {})).toBe(0)
    expect(await syncValueUseCaseSkill('1.0.1', home, {})).toBe(1)
    // ビジュアルレビューの skill とは別のフォルダ
    expect(await syncVisualReviewSkill('1.0.1', home, {})).toBe(1)
    expect((await readdir(join(home, '.claude', 'skills'))).sort()).toEqual([VALUE_USECASE_SKILL_NAME, VISUAL_REVIEW_SKILL_NAME].sort())

    await writeFile(path, 'mine')
    expect(await syncValueUseCaseSkill('1.0.2', home, {})).toBe(0)
    expect(await readFile(path, 'utf8')).toBe('mine')
    await mkdir(join(home, '.codex', 'skills'), { recursive: true })
    await mkdir(join(outside, 'target'), { recursive: true })
    await symlink(join(outside, 'target'), join(home, '.codex', 'skills', VALUE_USECASE_SKILL_NAME))
    expect(await syncValueUseCaseSkill('1.0.2', home, {})).toBe(0)
    expect(await readdir(join(outside, 'target'))).toEqual([])
  })
})

describe('声と書き込みのフィードバック（ビジュアルレビューと価値ユースケースで共用）', () => {
  const doc = { id: 'app', status: 'proposed' as const, revision: 3 }
  const box = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }

  it('種類を控え、囲みの番号の上限は種類ごと（価値ユースケースは手順の通しの数）', () => {
    expect(noteScreens('visual-review')).toBe(LIMITS.screens)
    expect(noteScreens('value-usecases')).toBe(VALUE_LIMITS.totalSteps)
    const note = { boxes: [{ ...box, screen: 40 }, { ...box, screen: 2 }] }
    const vuc = beginRecordingFeedback({ current: null, plan: doc, folderPath: '/w', recording: false, note, kind: 'value-usecases' })
    expect(vuc).toEqual({ ok: true, pending: { kind: 'value-usecases', planId: 'app', folderPath: '/w', revision: 3, phase: 'recording', note: { boxes: [{ ...box, screen: 40 }, { ...box, screen: 2 }] } } })
    const vr = beginRecordingFeedback({ current: null, plan: doc, folderPath: '/w', recording: false, note })
    expect(vr.ok && vr.pending).toMatchObject({ kind: 'visual-review', note: { boxes: [{ ...box, screen: 2 }] } })
  })

  it('ほかの種類で返している途中は始めない', () => {
    const vuc = beginRecordingFeedback({ current: null, plan: doc, folderPath: '/w', recording: false, kind: 'value-usecases' })
    if (!vuc.ok) throw new Error('not started')
    expect(beginRecordingFeedback({ current: vuc.pending, plan: { ...doc, id: 'plan' }, folderPath: '/w', recording: false, kind: 'visual-review' })).toEqual({ ok: false, reason: 'busy' })
  })

  it('打った文・囲みは同じ種類・同じ id のときだけ控える', () => {
    const started = beginRecordingFeedback({ current: null, plan: doc, folderPath: '/w', recording: false, kind: 'value-usecases' })
    if (!started.ok) throw new Error('not started')
    const pending = started.pending
    expect(updateRecordingNote(pending, 'app', { text: 'x' }, 'visual-review')).toBe(pending)
    expect(updateRecordingNote(pending, 'other', { text: 'x' }, 'value-usecases')).toBe(pending)
    expect(updateRecordingNote(pending, 'app', { text: 'x', boxes: [{ ...box, screen: 100 }] }, 'value-usecases')?.note).toEqual({ text: 'x', boxes: [{ ...box, screen: 100 }] })
  })

  it('止めてできたレビューの結びつけと、添えてよいかは種類を見る', () => {
    const started = beginRecordingFeedback({ current: null, plan: doc, folderPath: '/w', recording: false, kind: 'value-usecases' })
    if (!started.ok) throw new Error('not started')
    expect(linkFinishedReview(started.pending, { reviewId: '20261113-1', folderPath: '/w' })).toBe('attach')
    expect(linkFinishedReview(started.pending, { reviewId: '20261113-1', folderPath: '/other' })).toBe('other-project')
    expect(canAttachTo(started.pending, doc, 'value-usecases')).toBe(true)
    expect(canAttachTo(started.pending, doc, 'visual-review')).toBe(false)
    expect(canAttachTo(started.pending, { ...doc, revision: 4 }, 'value-usecases')).toBe(false)
  })
})

describe('見張り', () => {
  it('Linux では価値ユースケースのフォルダとその下の画像のフォルダまで降りる', () => {
    expect(shouldWatchDir('.ferret/value-usecases')).toBe(true)
    expect(shouldWatchDir('.ferret/value-usecases/app')).toBe(true)
    expect(shouldWatchDir('.ferret/value-usecases/app/deeper')).toBe(false)
    expect(shouldWatchDir('.ferret/visual-review')).toBe(true)
  })

  it('変わったフォルダの種類ごとに1回ずつ知らせる', () => {
    vi.useFakeTimers()
    const kinds: ReviewDocKind[] = []
    const watcher = new ProjectWatcher(() => {}, undefined, (kind) => kinds.push(kind))
    const emit = (watcher as unknown as { onFsEvent: (event: string, filename: string) => void }).onFsEvent
    emit('change', join('.ferret', 'value-usecases', 'app.json'))
    emit('change', join('.ferret', 'value-usecases', 'app', '1.png'))
    emit('change', join('.ferret', 'visual-review', 'p.json'))
    emit('change', join('.ferret', 'reviews', 'x', 'session.json'))
    vi.advanceTimersByTime(5000)
    expect(kinds.sort()).toEqual(['value-usecases', 'visual-review'])
    kinds.length = 0
    emit('change', join('.ferret', 'value-usecases', 'b.json'))
    vi.advanceTimersByTime(5000)
    expect(kinds).toEqual(['value-usecases'])
    watcher.close()
  })
})
