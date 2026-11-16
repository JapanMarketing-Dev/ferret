import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * FERRET-M（0.8.9 の macOS）：起動直後の 2.2s の止まりに `block.slowop: ipc:terminal:continueWork`（3812ms）が付いていた。
 * terminal:continueWork は戻したタブの Agent が入力を待つまで await で待つだけの IPC で main を止めない。しかも止まりの 7 秒前に終わっていた。
 * 待つのが仕事の IPC と、止まりより前に終わった重い処理は、止まりの手がかりにしないことを確かめる。
 */

const clock = vi.hoisted(() => ({ now: 0 }))
const app = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: E } = require('node:events') as typeof import('node:events')
  return Object.assign(new E(), {
    isReady: () => true,
    whenReady: () => new Promise<void>(() => undefined),
    getPath: () => '/tmp/ferret-unit',
    getAppPath: () => '/tmp/ferret-unit',
    isPackaged: false,
    accessibilitySupportEnabled: true
  })
})

vi.mock('electron', () => ({
  app,
  BrowserWindow: { getFocusedWindow: () => ({}) },
  powerMonitor: new EventEmitter(),
  crashReporter: { start: vi.fn() },
  dialog: {},
  session: {}
}))
vi.mock('@sentry/electron/main', () => ({}))
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:os')>()), loadavg: () => [0, 0, 0] }))
vi.mock('node:perf_hooks', () => ({
  performance: { now: () => clock.now },
  PerformanceObserver: class { observe(): void { throw new Error('no gc in tests') } }
}))
vi.mock('../../src/main/settings', () => ({ configDir: () => '/tmp/ferret-unit', currentSettings: () => ({}), onSettingsChanged: () => () => undefined }))
vi.mock('../../src/main/telemetrySourceMaps', () => ({ attachDebugIds: vi.fn(), remapDevFrames: vi.fn() }))

import { clearSlowOps, noteSlowOp, recentSlowOps, setReporter, type Reporter } from '../../src/shared/report'
import { EVENT_LOOP_WATCH_MS, trackIpc, watchEventLoop } from '../../src/main/telemetry'
import { axChangeBucket, blockSlowOpWindowMs, eventLoopBlockContext, isWaitingIpc, SLEEP_AFTER_BLOCK_MS } from '../../src/shared/telemetry'

describe('待つのが仕事の IPC（FERRET-M 0.8.9）', () => {
  it('terminal:continueWork は待つ IPC。ほかの IPC はそうではない', () => {
    expect(isWaitingIpc('terminal:continueWork')).toBe(true)
    for (const channel of ['terminal:create', 'resources:snapshot', 'github:repoStatus', 'project:switch', '', 'terminal:continueWorkX']) {
      expect(isWaitingIpc(channel)).toBe(false)
    }
  })
})

describe('止まりの手がかりにする重い処理の範囲（blockSlowOpWindowMs）', () => {
  it('遅れ・止まりが終わってから集めるまで・測りの間隔を足した長さ', () => {
    expect(blockSlowOpWindowMs({ lagMs: 2200, msSinceBlockEnd: 2000, intervalMs: 1000 })).toBe(5200)
    expect(blockSlowOpWindowMs({ lagMs: 0, msSinceBlockEnd: 0, intervalMs: 1000 })).toBe(1000)
  })
  it('負の値・NaN・Infinity は 0 として扱う（時計が戻っても範囲が広がらない）', () => {
    expect(blockSlowOpWindowMs({ lagMs: Number.NaN, msSinceBlockEnd: -50, intervalMs: 1000 })).toBe(1000)
    expect(blockSlowOpWindowMs({ lagMs: Number.POSITIVE_INFINITY, msSinceBlockEnd: 2000, intervalMs: 1000 })).toBe(3000)
  })
  it('0.8.9 の並び：止まりの 7 秒前に終わった処理は入らず、止まりの間に終わった処理は入る', () => {
    clearSlowOps()
    // 止まりの終わり = 10_000。遅れ 2200ms、集めるのは 2000ms 後
    noteSlowOp('ipc:terminal:continueWork', 3812, 3000)
    noteSlowOp('settings:save', 2100, 9_900)
    const now = 12_000
    const windowMs = blockSlowOpWindowMs({ lagMs: 2200, msSinceBlockEnd: 2000, intervalMs: 1000 })
    expect(recentSlowOps(now, windowMs)).toEqual([{ op: 'settings:save', ms: 2100 }])
    // 以前の決まった 10 秒の範囲では、関係の無い処理まで手がかりに出ていた
    expect(recentSlowOps(now).map((x) => x.op)).toEqual(['ipc:terminal:continueWork', 'settings:save'])
    clearSlowOps()
  })
})

describe('補助技術の切り替えからの時間（タグ block.axchange）', () => {
  it('区分', () => {
    expect(axChangeBucket(null)).toBe('never')
    expect(axChangeBucket(undefined)).toBe('never')
    expect(axChangeBucket(Number.NaN)).toBe('never')
    expect(axChangeBucket(-1)).toBe('never')
    expect(axChangeBucket(0)).toBe('<5s')
    expect(axChangeBucket(3387)).toBe('<5s')
    expect(axChangeBucket(4999)).toBe('<5s')
    expect(axChangeBucket(5000)).toBe('5-30s')
    expect(axChangeBucket(29_999)).toBe('5-30s')
    expect(axChangeBucket(30_000)).toBe('30s+')
  })
  it('止まりのタグに付く', () => {
    expect(eventLoopBlockContext([], [], { heapUsedMb: 48, rssMb: 308, axEnabled: true, axChangedMsAgo: 3387 }).tags['block.axchange']).toBe('<5s')
    expect(eventLoopBlockContext([], [], { heapUsedMb: 48, rssMb: 308, axEnabled: false, axChangedMsAgo: null }).tags['block.axchange']).toBe('never')
  })
})

describe('本物の watchEventLoop で（FERRET-M 0.8.9）', () => {
  const events: Array<{ message: string; tags: Record<string, string>; contexts?: Record<string, Record<string, string>> }> = []
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout', 'Date'] })
    vi.setSystemTime(1_000_000)
    clearSlowOps()
    events.length = 0
    setReporter({
      handled: vi.fn(),
      message: (message: string, tags: Record<string, string>, _level: unknown, _fp: unknown, contexts?: Record<string, Record<string, string>>) => { events.push({ message, tags, contexts }) },
      breadcrumb: vi.fn()
    } as unknown as Reporter)
  })
  afterEach(() => {
    setReporter(null)
    clearSlowOps()
    vi.useRealTimers()
  })

  /** 見張りのタイマーを1回進め、その間に main が blockMs 止まったことにする */
  const tick = (blockMs = 0): void => {
    clock.now += EVENT_LOOP_WATCH_MS + blockMs
    vi.advanceTimersByTime(EVENT_LOOP_WATCH_MS + blockMs)
  }

  it('待つ IPC（terminal:continueWork）と止まりの前に終わった重い処理は手がかりに出ない。止まりの直前の処理は出る', () => {
    watchEventLoop(1000)
    tick()
    // 起動直後に戻したタブの続きを頼む：3.8 秒待って終わる（await の待ちで main は止めない）
    const endContinue = trackIpc('terminal:continueWork')
    for (let i = 0; i < 4; i++) tick()
    endContinue()
    // 止まりの前に終わった、関係の無い遅い IPC
    const endEarly = trackIpc('github:repoStatus')
    tick()
    tick()
    endEarly()
    for (let i = 0; i < 5; i++) tick()
    expect(events).toEqual([])
    // 別のタブの続きを頼む IPC が止まりの間も待ち続けていても、処理中の IPC（block.ipc）には出ない
    const endWaiting = trackIpc('terminal:continueWork')
    // 止まりの間に同期で動いた処理
    noteSlowOp('pty:load', 2100, Date.now() + 2100)
    tick(2200)
    vi.advanceTimersByTime(SLEEP_AFTER_BLOCK_MS)
    endWaiting()
    expect(events).toHaveLength(1)
    expect(events[0].message).toBe('Main event loop blocked (2.2s)')
    expect(events[0].tags['block.slowop']).toBe('pty:load')
    expect(events[0].tags['block.ipc']).toBe('none')
    expect(events[0].contexts?.block.recent_slow_ops).toBe('pty:load 2100ms')
    expect(events[0].contexts?.block.inflight_ipc).toBe('none')
    expect(events[0].tags['block.axchange']).toBe('never')
  })

})
