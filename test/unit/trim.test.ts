import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findIdleCuts, keptSpans, sanitizeCuts, toOriginalTime, toTrimmedTime, trimmedDuration } from '../../src/shared/trim'
import { activitySpans, planTrim, readTrim, START_GRACE_MS, TRIMMED_FILE, videoDuration, withTrim } from '../../src/main/sessions/trim'
import { appendTake, listTakes, TAKE_GAP_MS } from '../../src/main/sessions/takes'
import { buildDraftDocument } from '../../src/main/pipeline/decompose'
import type { SessionRecord } from '../../src/main/sessions/store'
import { playbackAt, type ReviewTake } from '../../src/shared/review'
import { events, frames, material, meta, transcript } from './fixtures'

// 削った版を作る処理（非表示ウィンドウ）は単体テストでは動かせない。成功・失敗を差し替える
const render = vi.hoisted(() => ({ impl: async (_src: string, _out: string, _kept: unknown): Promise<void> => {} }))
vi.mock('../../src/main/trimVideo', () => ({ renderTrimmedVideo: (src: string, out: string, kept: unknown) => render.impl(src, out, kept) }))
vi.mock('electron', () => ({
  app: { getPath: () => join(tmpdir(), 'ferret-trim-unit'), getLocale: () => 'en' },
  clipboard: {}, shell: {}, nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }
}))

const opts = { minIdleMs: 3000, padMs: 500 }

describe('何も起きていない区間の見つけ方', () => {
  it('頭・途中・終わりの長い空白を、前後に余白を残して削る', () => {
    // 4s〜6s と 15s〜16s に何かが起きた 20s の録画
    expect(findIdleCuts([[4000, 6000], [15000, 16000]], 20_000, opts)).toEqual([
      { start: 0, end: 3500 },        // 頭: 録画の始まりから、最初の出来事の 0.5s 手前まで
      { start: 6500, end: 14500 },    // 途中: 前後 0.5s を残す
      { start: 16500, end: 20_000 }   // 終わり: 最後の出来事の 0.5s 後から録画の最後まで
    ])
  })

  it('しきい値より短い空白は残す', () => {
    expect(findIdleCuts([[0, 1000], [3500, 5000], [7900, 8000]], 8000, opts)).toEqual([])
  })

  it('重なる・接する出来事はまとめて1つの区間として扱う', () => {
    expect(findIdleCuts([[1000, 3000], [2000, 4000], [4000, 4000], [9000, 9000]], 9000, opts)).toEqual([{ start: 4500, end: 8500 }])
  })

  it('何も起きていない録画・長さの無い録画は削らない', () => {
    expect(findIdleCuts([], 30_000, opts)).toEqual([])
    expect(findIdleCuts([[0, 10]], 0, opts)).toEqual([])
  })

  it('壊れた区間（数でない・録画の外）は無視する', () => {
    expect(findIdleCuts([[Number.NaN, 5], [500, 600], [-100, -50]], 10_000, opts)).toEqual([{ start: 1100, end: 10_000 }])
  })
})

describe('元の録画と削った版の時間の対応', () => {
  const cuts = [{ start: 0, end: 3500 }, { start: 6500, end: 14500 }]

  it('削った区間ぶん前へ詰める。削った区間の中は、削った版の同じ位置へ寄せる', () => {
    expect(toTrimmedTime(cuts, 4000)).toBe(500)
    expect(toTrimmedTime(cuts, 6500)).toBe(3000)
    expect(toTrimmedTime(cuts, 10_000)).toBe(3000)
    expect(toTrimmedTime(cuts, 15_000)).toBe(3500)
    expect(toTrimmedTime(cuts, 1000)).toBe(0)
    expect(toTrimmedTime(undefined, 1234)).toBe(1234)
  })

  it('削った版の時刻から元の時刻へ戻せる（削った区間の外は往復で一致）', () => {
    for (const t of [3500, 4000, 6000, 14_500, 18_000]) expect(toOriginalTime(cuts, toTrimmedTime(cuts, t))).toBe(t)
  })

  it('残す区間と、削ったあとの長さ', () => {
    expect(keptSpans(20_000, cuts)).toEqual([{ start: 3500, end: 6500 }, { start: 14_500, end: 20_000 }])
    expect(trimmedDuration(20_000, cuts)).toBe(8500)
  })

  it('session.json の壊れた区間は捨て、重なるものは除く', () => {
    expect(sanitizeCuts([{ start: 5, end: 1 }, null, { start: 0, end: 10 }, { start: 5, end: 20 }, { start: 30, end: 40 }, 'x'])).toEqual([{ start: 0, end: 10 }, { start: 30, end: 40 }])
    expect(sanitizeCuts('broken')).toEqual([])
  })
})

describe('録画からの計画', () => {
  const base = { durationMs: 20_000, transcript: [], events: [], frames: [], speechKnown: true }

  it('声・書き込み・クリック・スクロール・遷移・画面の変化を「起きていたこと」に数える', () => {
    const spans = activitySpans({
      transcript: [{ t0: 2000, t1: 3000, speaker: 'self', text: '見出し', source: 'mic' }, { t0: 9000, t1: 9500, speaker: 'self', text: '  ' }],
      events: [{ t: 4000, type: 'click', x: 1, y: 1 }, { t: 5000, type: 'scroll', y: 10 }, { t: 6000, type: 'pen', id: 'p', t_end: 7000, bbox: [0, 0, 1, 1] },
        { t: 8000, type: 'nav', url: 'http://x/', title: '' }, { t: 0, type: 'nav', url: 'http://x/', title: '' }],
      frames: [{ t: 0, path: 'a' }, { t: 12_000, path: 'b' }]
    })
    // 空の発話・録画を始めた瞬間の遷移と静止画は数えない
    expect(spans).toEqual([[2000, 3000], [4000, 4000], [5000, 5000], [6000, 7000], [8000, 8000], [12_000, 12_000]])
    expect(START_GRACE_MS).toBeGreaterThan(0)
  })

  it('文字起こしが動かなかった（声の有無が分からない）録画は削らない', () => {
    expect(planTrim({ ...base, events: [{ t: 10_000, type: 'click', x: 0, y: 0 }], speechKnown: false })).toBeNull()
  })

  it('削る量が少なければ削った版は作らない', () => {
    // 1.6s の空白をしきい値 1.5s で削ると、余白を除いて 0.6s しか削れない
    expect(planTrim({ ...base, durationMs: 1600, events: [{ t: 0, type: 'click', x: 0, y: 0 }, { t: 1600, type: 'click', x: 0, y: 0 }] }, { minIdleMs: 1500 })).toBeNull()
  })

  it('しきい値の秒数は設定で変えられる', () => {
    const input = { ...base, durationMs: 10_000, events: [{ t: 1000, type: 'click' as const, x: 0, y: 0 }, { t: 6000, type: 'click' as const, x: 0, y: 0 }, { t: 10_000, type: 'click' as const, x: 0, y: 0 }] }
    expect(planTrim(input, { minIdleMs: 3000 })).toEqual([{ start: 1500, end: 5500 }, { start: 6500, end: 9500 }])
    expect(planTrim(input, { minIdleMs: 6000 })).toBeNull()
  })
})

function baseRecord(): SessionRecord {
  const stage = buildDraftDocument(material)
  return { version: 1, meta, transcript, removedDuplicates: [], frames, draft: stage.draft.items, originalDocument: stage.document, document: stage.document, edits: [], captureGaps: [] }
}

describe('追記した録画（takes）との組み合わせ', () => {
  const take2 = { n: 2, startedAt: '2026-10-02T11:00:00Z', addedAt: '2026-10-02T11:01:00Z', durationMs: 20_000,
    transcript: [{ t0: 9000, t1: 10_000, speaker: 'self' as const, text: 'ロゴ', source: 'mic' as const }], removedDuplicates: [], events: [], frames: [], warnings: [] }

  it('録画ごとに削った区間を持ち、▷ は録画の中の時刻を削った版の時刻へ読み替える', () => {
    let record = appendTake(baseRecord(), events, take2).record
    record = withTrim(record, 1, [{ start: 45_000, end: 60_000 }], meta.durationMs)
    record = withTrim(record, 2, [{ start: 0, end: 8500 }, { start: 10_500, end: 20_000 }], 20_000)
    expect(record.trim?.durationMs).toBe(45_000)
    expect(record.takes?.[0]?.trim?.durationMs).toBe(2000)
    // 指摘の時刻・静止画は元の時間のまま（時間軸は変えない）
    expect(record.meta.durationMs).toBe(meta.durationMs + TAKE_GAP_MS + 20_000)

    const takes: ReviewTake[] = listTakes(record).map(({ trim, ...take }) => ({ ...take, videoUrl: `v${take.n}`, ...(trim ? { cuts: trim.cuts } : {}) }))
    const offset = meta.durationMs + TAKE_GAP_MS
    // 2本目の 9.2s（話し始めの少し後）→ 削った版では 0.7s
    expect(playbackAt(takes, undefined, offset + 9200)).toEqual({ url: 'v2', t: 700, label: 9200, take: 2 })
    // 1本目は削った区間より前なのでそのまま
    expect(playbackAt(takes, undefined, 12_400)).toEqual({ url: 'v1', t: 12_400, label: 12_400, take: 1 })
    // 録画が1本で削っていない古いレビューは、元の動画のその時刻
    expect(playbackAt(undefined, 'orig', 5000)).toEqual({ url: 'orig', t: 5000, label: 5000, take: null })
  })

  it('feedback.md の長さは、削ったあとの合計（すき間は数えない）と元の合計', () => {
    let record = appendTake(baseRecord(), events, take2).record
    expect(videoDuration(record, meta.durationMs)).toEqual({ originalMs: 80_000, trimmedMs: 80_000 })
    record = withTrim(record, 2, [{ start: 0, end: 8500 }, { start: 10_500, end: 20_000 }], 20_000)
    expect(videoDuration(record, meta.durationMs)).toEqual({ originalMs: 80_000, trimmedMs: 62_000 })
  })

  it('壊れた控えは無いものとして元の動画を使う', () => {
    expect(readTrim({ file: TRIMMED_FILE, cuts: 'x', sourceDurationMs: 1000 })).toBeNull()
    expect(readTrim({ file: '../../etc', cuts: [{ start: 0, end: 10 }], sourceDurationMs: 1000 })).toBeNull()
    expect(listTakes({ ...baseRecord(), trim: { broken: true } as never })[0]!.trim).toBeNull()
  })
})

describe('削った版を裏で作る（review.ts の trimReviewTake）', () => {
  let projectDir = ''
  beforeEach(async () => { projectDir = await mkdtemp(join(tmpdir(), 'ferret-trim-')) })
  afterEach(async () => { await rm(projectDir, { recursive: true, force: true }) })

  async function setup() {
    const { sessionPaths, saveSession } = await import('../../src/main/sessions')
    const paths = sessionPaths(projectDir, '20261002-104012', '.ferret')
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.recording, 'original')
    await saveSession(paths, baseRecord())
    return paths
  }

  it('失敗したら削った版も途中のファイルも残さず、元の動画のまま使う。削らなかったことは session.json に残し、画面へ印を渡す', async () => {
    const paths = await setup()
    render.impl = async (_src, out) => { await writeFile(out, 'half'); throw new Error('trim page (record): Error: recorder stopped unexpectedly') }
    const { trimReviewTake, loadReviewAt } = await import('../../src/main/review')
    expect(await trimReviewTake(paths, 1, [{ start: 0, end: 5000 }], meta.durationMs)).toBe(false)
    expect(existsSync(paths.trimmedRecording)).toBe(false)
    expect((await readdir(paths.dir)).filter((name) => name.endsWith('.part'))).toEqual([])
    expect(await readFile(paths.recording, 'utf8')).toBe('original')
    const saved = JSON.parse(await readFile(paths.sessionJson, 'utf8')) as SessionRecord
    expect(saved.trim).toBeUndefined()
    expect(saved.trimFailures).toEqual([{ n: 1, reason: 'trim page (record): Error: recorder stopped unexpectedly', at: expect.any(String) }])
    // 指摘・編集はそのまま
    expect(saved.document.items.map((it) => it.id)).toEqual(baseRecord().document.items.map((it) => it.id))
    // ▷ は元の動画の元の位置（削った区間で読み替えない）。画面には「削れなかった」の印
    const review = await loadReviewAt(paths)
    expect(review.trimSkipped).toBe(true)
    expect(review.videoUrl).toBe('ade-media://review/20261002-104012/recording.webm')
    expect(playbackAt(review.takes, review.videoUrl, 12_400)).toMatchObject({ url: 'ade-media://review/20261002-104012/recording.webm', t: 12_400 })
  })

  it('あとで作り直せたら「削れなかった」の印は消える', async () => {
    const paths = await setup()
    render.impl = async () => { throw new Error('x') }
    const { trimReviewTake, loadReviewAt } = await import('../../src/main/review')
    await trimReviewTake(paths, 1, [{ start: 0, end: 5000 }], meta.durationMs)
    render.impl = async (_src, out) => { await writeFile(out, 'trimmed') }
    expect(await trimReviewTake(paths, 1, [{ start: 0, end: 5000 }], meta.durationMs)).toBe(true)
    expect((await loadReviewAt(paths)).trimSkipped).toBeUndefined()
  })

  it('できたら削った区間を session.json に書き、feedback.md の長さを削ったあとにする。元の動画は残す', async () => {
    const paths = await setup()
    let kept: unknown = null
    let source: unknown = null
    let srcUrl = ''
    render.impl = async (src, out, spans) => {
      kept = spans
      srcUrl = src
      // 元の動画は、いま開いているプロジェクトでなく、このレビューのフォルダに固定した口から読む（FERRET-2D）
      expect(src).toMatch(/^ade-media:\/\/review\/pinned\/[0-9a-f]{32}$/)
      source = pinnedMediaFor(new URL(src).pathname)
      await writeFile(out, 'trimmed')
    }
    const { trimReviewTake } = await import('../../src/main/review')
    const { pinnedMediaFor } = await import('../../src/main/pinnedMedia')
    expect(await trimReviewTake(paths, 1, [{ start: 0, end: 1500 }, { start: 45_000, end: 60_000 }], meta.durationMs)).toBe(true)
    expect(kept).toEqual([{ start: 1500, end: 45_000 }])
    expect(source).toEqual({ dir: paths.dir, file: paths.recording, contentType: 'video/webm' })
    // 作り終えたら口は閉じる
    expect(pinnedMediaFor(new URL(srcUrl).pathname)).toBeNull()
    expect(await readFile(paths.trimmedRecording, 'utf8')).toBe('trimmed')
    expect(await readFile(paths.recording, 'utf8')).toBe('original')
    const saved = JSON.parse(await readFile(paths.sessionJson, 'utf8')) as SessionRecord
    expect(saved.trim).toEqual({ file: TRIMMED_FILE, cuts: [{ start: 0, end: 1500 }, { start: 45_000, end: 60_000 }], durationMs: 43_500, sourceDurationMs: 60_000 })
    // 指摘はそのまま（時刻も変えない）
    expect(saved.document.items.map((it) => it.t)).toEqual(baseRecord().document.items.map((it) => it.t))
    expect(await readFile(paths.feedbackMd, 'utf8')).toContain('/ 44s (idle parts trimmed from 1m 0s)')
  })
})

describe('設定（capture.trimIdle / trimIdleSeconds）', () => {
  it('秒数は整数に丸めて 1〜60 に収め、未設定・壊れた値は書かない（既定は削る・3秒）', async () => {
    const { sanitize } = await import('../../src/main/settings')
    const capture = (raw: Record<string, unknown>) => sanitize({ capture: raw }).capture
    expect(capture({ trimIdle: false, trimIdleSeconds: 2.6 })).toMatchObject({ trimIdle: false, trimIdleSeconds: 3 })
    expect(capture({ trimIdleSeconds: 999 })?.trimIdleSeconds).toBe(60)
    expect(capture({ trimIdleSeconds: 0 })?.trimIdleSeconds).toBe(1)
    const unset = capture({ trimIdle: 'yes', trimIdleSeconds: 'x' })
    expect(unset && 'trimIdle' in unset).toBe(false)
    expect(unset && 'trimIdleSeconds' in unset).toBe(false)
  })
})
