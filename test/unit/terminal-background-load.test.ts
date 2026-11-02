/**
 * 多くのターミナルを並べたときの負荷を抑える、純粋な決まり。
 * - ペインの PTY を作る順（src/renderer/terminal/spawnQueue.ts）
 * - Agent の状態を調べるペイン（src/renderer/terminal/pollSchedule.ts）
 * - git の色分けを読み直すまでの待ち（src/renderer/lib/useGitDecorations.ts）
 */
import { describe, expect, it } from 'vitest'
import { SPAWN_CONCURRENCY, SPAWN_GAP_MS, SpawnQueue, partitionSpawns, type SpawnQueueClock } from '../../src/renderer/terminal/spawnQueue'
import { HIDDEN_PROJECT_POLL_MS, panesDueForPoll } from '../../src/renderer/terminal/pollSchedule'
import { GIT_REFRESH_DEBOUNCE_MS, GIT_REFRESH_MIN_GAP_MS, gitRefreshDelay } from '../../src/renderer/lib/useGitDecorations'

/** 手で進める時計 */
function fakeClock(): SpawnQueueClock & { advance: (ms: number) => void } {
  let now = 0
  let timers: Array<{ at: number; fn: () => void; id: number }> = []
  let seq = 0
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.push({ at: now + ms, fn, id }); return id },
    clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id) },
    advance(ms) {
      const end = now + ms
      for (;;) {
        const next = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        timers = timers.filter((t) => t !== next)
        now = next.at
        next.fn()
      }
      now = end
    }
  }
}

/** 手で終わらせる起動 */
function controllable() {
  const started: string[] = []
  const finishers = new Map<string, () => void>()
  const start = (key: string) => () => new Promise<void>((resolve) => { started.push(key); finishers.set(key, resolve) })
  return { started, start, finish: async (key: string) => { finishers.get(key)?.(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() } }
}

describe('partitionSpawns（すぐ作るペインと順に作るペイン）', () => {
  it('表示中のプロジェクトのペインはすぐ、ほかは順に。並びは元のまま', () => {
    const result = partitionSpawns([
      { key: 'a1', projectId: 'A' },
      { key: 'b1', projectId: 'B' },
      { key: 'a2', projectId: 'A' },
      { key: 'h1', projectId: null },
      { key: 'b2', projectId: 'B' }
    ], 'A')
    expect(result).toEqual({ now: ['a1', 'a2'], queued: ['b1', 'h1', 'b2'], deferred: [] })
  })

  it('プロジェクトを開いていない（ホーム）ときは、プロジェクトの無いペインがすぐ', () => {
    expect(partitionSpawns([{ key: 'h1', projectId: null }, { key: 'a1', projectId: 'A' }], null)).toEqual({ now: ['h1'], queued: ['a1'], deferred: [] })
  })
})

describe('partitionSpawns（戻したタブ・休ませたタブ）', () => {
  it('裏のプロジェクトの dormant は作らずに置く。表示中のプロジェクトなら dormant でもすぐ作る', () => {
    expect(partitionSpawns([
      { key: 'a1', projectId: 'A', dormant: true },
      { key: 'b1', projectId: 'B', dormant: true },
      { key: 'b2', projectId: 'B', dormant: false },
      { key: 'h1', projectId: null, dormant: true }
    ], 'A')).toEqual({ now: ['a1'], queued: ['b2'], deferred: ['b1', 'h1'] })
  })

  it('全部が裏の dormant なら何も作らない', () => {
    expect(partitionSpawns([{ key: 'b1', projectId: 'B', dormant: true }, { key: 'c1', projectId: 'C', dormant: true }], 'A'))
      .toEqual({ now: [], queued: [], deferred: ['b1', 'c1'] })
  })

  it('空の一覧', () => {
    expect(partitionSpawns([], null)).toEqual({ now: [], queued: [], deferred: [] })
  })
})

describe('SpawnQueue（裏のプロジェクトのペインを順に作る）', () => {
  it('同時に作るのは上限まで、作り始めの間を空ける', async () => {
    const clock = fakeClock()
    const queue = new SpawnQueue(SPAWN_CONCURRENCY, SPAWN_GAP_MS, clock)
    const c = controllable()
    for (const key of ['p1', 'p2', 'p3', 'p4']) queue.enqueue(key, c.start(key))
    expect(c.started).toEqual(['p1'])
    clock.advance(SPAWN_GAP_MS - 1)
    expect(c.started).toEqual(['p1'])
    clock.advance(1)
    expect(c.started).toEqual(['p1', 'p2'])
    // 2 つ作っている間は、間隔がたっても始めない
    clock.advance(SPAWN_GAP_MS * 3)
    expect(c.started).toEqual(['p1', 'p2'])
    await c.finish('p1')
    expect(c.started).toEqual(['p1', 'p2', 'p3'])
    await c.finish('p2')
    // p3 から間隔を空ける
    expect(c.started).toEqual(['p1', 'p2', 'p3'])
    clock.advance(SPAWN_GAP_MS)
    expect(c.started).toEqual(['p1', 'p2', 'p3', 'p4'])
  })

  it('同じペインは2回入れない。作る前に閉じたペインは外せる', () => {
    const clock = fakeClock()
    const queue = new SpawnQueue(1, SPAWN_GAP_MS, clock)
    const c = controllable()
    queue.enqueue('p1', c.start('p1'))
    queue.enqueue('p2', c.start('p2'))
    queue.enqueue('p2', c.start('p2'))
    expect(queue.size).toBe(1)
    queue.remove('p2')
    expect(queue.has('p2')).toBe(false)
  })

  it('待っているペインのプロジェクトを表示したら、上限・間隔を待たずにすぐ作る', () => {
    const clock = fakeClock()
    const queue = new SpawnQueue(1, SPAWN_GAP_MS, clock)
    const c = controllable()
    for (const key of ['p1', 'p2', 'p3']) queue.enqueue(key, c.start(key))
    expect(queue.promote('p3')).toBe(true)
    expect(c.started).toEqual(['p1', 'p3'])
    expect(queue.promote('p3')).toBe(false)
    expect(queue.has('p2')).toBe(true)
  })

  it('起動の失敗でも次へ進む', async () => {
    const clock = fakeClock()
    const queue = new SpawnQueue(1, 0, clock)
    const started: string[] = []
    queue.enqueue('bad', () => { started.push('bad'); return Promise.reject(new Error('x')) })
    queue.enqueue('ok', () => { started.push('ok'); return Promise.resolve() })
    for (let i = 0; i < 5; i++) await Promise.resolve()
    clock.advance(0)
    expect(started).toEqual(['bad', 'ok'])
  })
})

describe('panesDueForPoll（Agent の状態を調べるペイン）', () => {
  it('表示中のプロジェクトのペインは毎回、裏のペインは間を空けて', () => {
    const fg = new Set(['a'])
    const last = new Map<string, number>([['a', 9000], ['b', 9000]])
    expect(panesDueForPoll(['a', 'b'], fg, last, 10_000)).toEqual(['a'])
    expect(panesDueForPoll(['a', 'b'], fg, last, 9000 + HIDDEN_PROJECT_POLL_MS)).toEqual(['a', 'b'])
  })

  it('まだ調べていない裏のペインはすぐ調べる。タイマーのずれは少し許す', () => {
    const fg = new Set<string>()
    expect(panesDueForPoll(['b'], fg, new Map(), 0)).toEqual(['b'])
    expect(panesDueForPoll(['b'], fg, new Map([['b', 0]]), HIDDEN_PROJECT_POLL_MS - 100)).toEqual(['b'])
    expect(panesDueForPoll(['b'], fg, new Map([['b', 0]]), HIDDEN_PROJECT_POLL_MS - 1000)).toEqual([])
  })
})

describe('gitRefreshDelay（git の色分けを読み直すまでの待ち）', () => {
  it('まだ走らせていなければ、まとめる待ちだけ', () => {
    expect(gitRefreshDelay(1000, null)).toBe(GIT_REFRESH_DEBOUNCE_MS)
  })

  it('前回の開始から最小の間を空ける', () => {
    expect(gitRefreshDelay(1000, 0)).toBe(GIT_REFRESH_MIN_GAP_MS - 1000)
    expect(gitRefreshDelay(GIT_REFRESH_MIN_GAP_MS * 3, 0)).toBe(GIT_REFRESH_DEBOUNCE_MS)
    expect(GIT_REFRESH_MIN_GAP_MS).toBeGreaterThan(GIT_REFRESH_DEBOUNCE_MS)
  })
})
