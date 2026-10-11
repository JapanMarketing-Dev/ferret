import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PUBLISH_LIMITS } from '../../src/shared/publish'
import { UserFacingError } from '../../src/shared/errors'
import type { LlmRunner } from '../../src/main/pipeline/organize/runner'
import { CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, PublishBackground, type PublishBackgroundDeps } from '../../src/main/publish/background'
import type { GeneratedDraft, ProjectMaterial, TextMaterial } from '../../src/main/publish/generate'
import { PublishStore } from '../../src/main/publish/store'

/**
 * 「発信」の裏の生成（src/main/publish/background.ts）。時計・タイマー・git の材料・AI は偽物に差し替える。
 */

const HEAD1 = '1'.repeat(40)
const HEAD2 = '2'.repeat(40)
const PROJECT = { id: 'proj', dir: '/projects/proj' }
const HOUR = 60 * 60 * 1000

let userData: string
let clock: number
let store: PublishStore

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'ferret-publish-bg-'))
  clock = Date.parse('2026-10-01T00:00:00.000Z')
  store = new PublishStore(userData, () => clock)
})
afterEach(async () => {
  await rm(userData, { recursive: true, force: true })
})

const runner: LlmRunner = { id: 'codex', available: async () => true, run: async () => ({ raw: '', elapsedMs: 0, commandLine: '' }) }

function materialFor(head: string | null, commits = 1): ProjectMaterial {
  return {
    head,
    commits: Array.from({ length: commits }, (_, i) => ({ hash: head ?? '0'.repeat(40), subject: `c${i}`, body: '', date: '2026-10-01', files: [] })),
    mediaCandidates: ['shot.png']
  }
}

interface Harness {
  bg: PublishBackground
  collects: Array<{ dir: string; sinceHead?: string }>
  generates: Array<{ material: ProjectMaterial | TextMaterial; count: number; timeoutMs: number; cwd: string; intent?: string; existingTitles: readonly string[] }>
  folders: Array<{ dir: string; intent: string }>
  changed: string[]
  timers: Array<{ fn: () => void; ms: number; cleared: boolean }>
  /** 生成を止めておく（single-flight を確かめる） */
  hold: () => () => void
  state: { head: string | null; commits: number; runner: LlmRunner | null; fail: Error | null; project: typeof PROJECT | null }
}

function harness(overrides: Partial<PublishBackgroundDeps> = {}): Harness {
  const h = {
    collects: [], generates: [], changed: [], timers: [], folders: [],
    state: { head: HEAD1, commits: 1, runner, fail: null, project: PROJECT }
  } as unknown as Harness
  let gate: Promise<void> | null = null
  h.hold = () => {
    let release!: () => void
    gate = new Promise((r) => { release = r })
    return () => { gate = null; release() }
  }
  h.bg = new PublishBackground({
    now: () => clock,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; h.timers.push(t); return t },
    clearTimer: (t) => { (t as { cleared: boolean }).cleared = true },
    project: () => h.state.project,
    store,
    makeRunner: async () => h.state.runner,
    workDir: () => '/tmp/work',
    collect: async (dir, options) => {
      h.collects.push({ dir, ...options })
      if (options.sinceHead && options.sinceHead === h.state.head) return { ...materialFor(h.state.head, 0) }
      return materialFor(h.state.head, h.state.commits)
    },
    generate: async (_runner, material, options): Promise<GeneratedDraft[]> => {
      h.generates.push({ material, count: options.count, timeoutMs: options.timeoutMs, cwd: options.cwd, intent: options.intent, existingTitles: options.existingTitles })
      if (gate) await gate
      if (h.state.fail) throw h.state.fail
      return Array.from({ length: options.count }, (_, i) => ({ title: `t${h.generates.length}-${i}`, text: `本文${h.generates.length}-${i}`, media: i === 0 ? ['shot.png'] : [], article: { title: `記事${i}`, body: `記事の本文${i}` } }))
    },
    collectFolder: async (dir, intent) => { h.folders.push({ dir, intent }); return ['folder/pic.png'] },
    resolveMedia: async (dir, rels) => rels.map((r) => ({ path: `${dir}/${r}`, bytes: 10, ref: r })),
    onChanged: (id) => h.changed.push(id),
    ...overrides
  })
  return h
}

describe('PublishBackground.tick', () => {
  it('初回（lastHead 無し）は作って足し、lastHead・lastRunAt を残して知らせる', async () => {
    const h = harness()
    expect(await h.bg.tick()).toBe(PUBLISH_LIMITS.backgroundBatch)
    const snap = await store.snapshot(PROJECT.id)
    expect(snap.drafts).toHaveLength(PUBLISH_LIMITS.backgroundBatch)
    expect(snap.drafts.every((d) => d.source === 'ai-background')).toBe(true)
    expect(snap.drafts[0].media.map((m) => m.name)).toEqual(['shot.png'])
    expect(await store.background(PROJECT.id)).toEqual({ enabled: true, lastHead: HEAD1, lastRunAt: new Date(clock).toISOString() })
    expect(h.collects[0]).toEqual({ dir: PROJECT.dir })
    expect(h.generates[0]).toMatchObject({ count: PUBLISH_LIMITS.backgroundBatch, timeoutMs: 300_000, cwd: '/tmp/work' })
    expect(h.changed).toEqual([PROJECT.id])
  })

  it('API の runner は CLI と別の待ち時間（記事も書くので長め）', async () => {
    const h = harness()
    h.state.runner = { ...runner, id: 'api:openai' }
    await h.bg.tick()
    expect(h.generates[0].timeoutMs).toBe(240_000)
  })

  it('間隔が空くまでは作らない（境界: ちょうど間隔で作る）', async () => {
    const h = harness()
    await h.bg.tick()
    h.state.head = HEAD2
    clock += PUBLISH_LIMITS.backgroundIntervalMs - 1
    expect(await h.bg.tick()).toBe(0)
    expect(h.generates).toHaveLength(1)
    clock += 1
    expect(await h.bg.tick()).toBe(PUBLISH_LIMITS.backgroundBatch)
    expect(h.collects[1]).toEqual({ dir: PROJECT.dir, sinceHead: HEAD1 })
    expect((await store.background(PROJECT.id)).lastHead).toBe(HEAD2)
  })

  it('新しいコミットが無ければ作らず、何も残さず知らせない', async () => {
    const h = harness()
    await h.bg.tick()
    clock += 3 * HOUR
    const before = await store.background(PROJECT.id)
    expect(await h.bg.tick()).toBe(0)
    expect(h.generates).toHaveLength(1)
    expect(await store.background(PROJECT.id)).toEqual(before)
    expect(h.changed).toEqual([PROJECT.id])
  })

  it('git でない（コミットが無い）プロジェクトでは作らない', async () => {
    const h = harness()
    h.state.head = null
    h.state.commits = 0
    expect(await h.bg.tick()).toBe(0)
    expect(h.generates).toHaveLength(0)
  })

  it('切っていれば作らない', async () => {
    const h = harness()
    await store.setBackground(PROJECT.id, { enabled: false })
    expect(await h.bg.tick()).toBe(0)
    expect(h.collects).toHaveLength(0)
  })

  it('開いているプロジェクトが無ければ何もしない', async () => {
    const h = harness()
    h.state.project = null
    expect(await h.bg.tick()).toBe(0)
    expect(h.collects).toHaveLength(0)
  })

  it('未使用の下書きが上限まであれば作らない（1つ少なければ作る）', async () => {
    const h = harness()
    const max = PUBLISH_LIMITS.backgroundMaxPending
    await store.add(PROJECT.id, Array.from({ length: max }, (_, i) => ({ source: 'manual' as const, title: '', text: `m${i}` })))
    expect(await h.bg.tick()).toBe(0)
    expect(h.collects).toHaveLength(0)
    const [first] = (await store.snapshot(PROJECT.id)).drafts
    await store.update(PROJECT.id, first.id, { status: 'dismissed' })
    expect(await h.bg.tick()).toBe(PUBLISH_LIMITS.backgroundBatch)
  })

  it('失敗したら理由と時刻を残し、間隔が空くまで試さない。成功したら理由を消す', async () => {
    const h = harness()
    h.state.fail = new Error('spawn ENOENT /secret/path')
    expect(await h.bg.tick()).toBe(0)
    const failed = await store.background(PROJECT.id)
    expect(failed.lastError).toBeTruthy()
    expect(failed.lastError).not.toContain('/secret/path')
    expect(failed.lastRunAt).toBe(new Date(clock).toISOString())
    expect(failed.lastHead).toBeUndefined()
    expect(h.changed).toEqual([PROJECT.id])
    clock += HOUR
    await h.bg.tick()
    expect(h.generates).toHaveLength(1)
    h.state.fail = null
    clock += HOUR
    expect(await h.bg.tick()).toBe(PUBLISH_LIMITS.backgroundBatch)
    expect((await store.background(PROJECT.id)).lastError).toBeUndefined()
  })

  it('利用者向けのエラーは文をそのまま残す', async () => {
    const h = harness()
    h.state.fail = new UserFacingError('AIの応答がありませんでした')
    await h.bg.tick()
    expect((await store.background(PROJECT.id)).lastError).toBe('AIの応答がありませんでした')
  })

  it('AI が使えなければ失敗として残す', async () => {
    const h = harness()
    h.state.runner = null
    expect(await h.bg.tick()).toBe(0)
    expect((await store.background(PROJECT.id)).lastError).toBeTruthy()
    expect(h.generates).toHaveLength(0)
  })

  it('同時に2つ走らせない（走っているあいだの tick は何もしない）', async () => {
    const h = harness()
    const release = h.hold()
    const first = h.bg.tick()
    await vi.waitFor(() => expect(h.bg.isRunning(PROJECT.id)).toBe(true))
    expect(await h.bg.tick()).toBe(0)
    release()
    expect(await first).toBe(PUBLISH_LIMITS.backgroundBatch)
    expect(h.generates).toHaveLength(1)
    expect(h.bg.isRunning(PROJECT.id)).toBe(false)
  })

  it('同じ瞬間の2つの tick でも1つだけ走る', async () => {
    const h = harness()
    const results = await Promise.all([h.bg.tick(), h.bg.tick()])
    expect(results.sort()).toEqual([0, PUBLISH_LIMITS.backgroundBatch])
    expect(h.generates).toHaveLength(1)
  })
})

describe('PublishBackground.runNow', () => {
  it('間隔・新しいコミットの有無を見ずに最近の変更から作る（sinceHead を渡さない）', async () => {
    const h = harness()
    await h.bg.tick()
    expect(await h.bg.runNow(PROJECT.id, { intent: '告知' })).toBe(1)
    expect(h.collects[1]).toEqual({ dir: PROJECT.dir })
    expect(h.generates[1].intent).toBe('告知')
    expect(h.generates[1].count).toBe(1)
    // 主題があればフォルダの候補を先に並べる
    expect(h.folders).toEqual([{ dir: PROJECT.dir, intent: '告知' }])
    expect((h.generates[1].material as { mediaCandidates: string[] }).mediaCandidates[0]).toBe('folder/pic.png')
    expect(h.generates[1].existingTitles.length).toBeGreaterThan(0)
  })

  it('文章からの生成は ai-text で、git の状態を変えない', async () => {
    const h = harness()
    expect(await h.bg.runNow(PROJECT.id, { text: 'メモの本文', textLabel: 'memo.md' })).toBe(PUBLISH_LIMITS.backgroundBatch)
    expect(h.collects).toHaveLength(0)
    expect(h.generates[0].material).toEqual({ text: 'メモの本文', textLabel: 'memo.md', mediaCandidates: ['folder/pic.png'] })
    const snap = await store.snapshot(PROJECT.id)
    expect(snap.drafts.every((d) => d.source === 'ai-text')).toBe(true)
    expect(await store.background(PROJECT.id)).toEqual({ enabled: true })
  })

  it('空の文章・材料の無いプロジェクトは断る', async () => {
    const h = harness()
    await expect(h.bg.runNow(PROJECT.id, { text: '  ' })).rejects.toMatchObject({ userFacing: true })
    h.state.head = null
    h.state.commits = 0
    await expect(h.bg.runNow(PROJECT.id)).rejects.toMatchObject({ userFacing: true })
    expect(h.generates).toHaveLength(0)
  })

  it('開いていないプロジェクトは断る', async () => {
    const h = harness()
    await expect(h.bg.runNow('other')).rejects.toMatchObject({ userFacing: true })
  })

  it('失敗は呼び出し側へ返し、終わったら知らせる', async () => {
    const h = harness()
    h.state.fail = new UserFacingError('だめでした')
    await expect(h.bg.runNow(PROJECT.id)).rejects.toThrow('だめでした')
    expect(h.changed).toEqual([PROJECT.id])
    expect(h.bg.isRunning(PROJECT.id)).toBe(false)
  })

  it('走っている同じプロジェクトの生成には相乗りし、二重に走らせない。別のプロジェクトは断る', async () => {
    const h = harness()
    const release = h.hold()
    const bgRun = h.bg.tick()
    await vi.waitFor(() => expect(h.bg.isRunning(PROJECT.id)).toBe(true))
    const joined = h.bg.runNow(PROJECT.id)
    await expect(h.bg.runNow('other')).rejects.toMatchObject({ userFacing: true })
    release()
    expect(await joined).toBe(await bgRun)
    expect(h.generates).toHaveLength(1)
  })

  it('切っていても押した生成はできる', async () => {
    const h = harness()
    await store.setBackground(PROJECT.id, { enabled: false })
    expect(await h.bg.runNow(PROJECT.id)).toBe(PUBLISH_LIMITS.backgroundBatch)
  })
})

describe('PublishBackground のタイマー', () => {
  it('起動の1分後に1回、その後は15分ごと。stop で止まる', async () => {
    const h = harness()
    h.bg.start()
    h.bg.start()
    expect(h.timers.map((t) => t.ms)).toEqual([FIRST_CHECK_DELAY_MS])
    h.timers[0].fn()
    await vi.waitFor(() => expect(h.timers.map((t) => t.ms)).toEqual([FIRST_CHECK_DELAY_MS, CHECK_INTERVAL_MS]))
    expect(h.generates).toHaveLength(1)
    h.bg.stop()
    expect(h.timers[1].cleared).toBe(true)
  })

  it('止めたあとに終わった確認は次を予約しない', async () => {
    const h = harness()
    const release = h.hold()
    h.bg.start()
    h.timers[0].fn()
    await vi.waitFor(() => expect(h.bg.isRunning(PROJECT.id)).toBe(true))
    h.bg.stop()
    release()
    await vi.waitFor(() => expect(h.bg.isRunning(PROJECT.id)).toBe(false))
    await new Promise((r) => setTimeout(r, 10))
    expect(h.timers).toHaveLength(1)
  })
})
