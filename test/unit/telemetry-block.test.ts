import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearSlowOps, noteSlowOp, recentSlowOps, reportPerf, setReporter, timedSync, type Reporter } from '../../src/shared/report'
import {
  createBreadcrumbFilter,
  createInflightTracker,
  DEV_EVENT_LOOP_BLOCK_MS,
  EVENT_LOOP_BLOCK_MS,
  eventLoopBlockContext,
  cpuLimitBucket,
  eventLoopBlockThreshold,
  gcKindName,
  memoryBucket,
  RESUME_GRACE_MS,
  QUIT_GRACE_MS,
  scrubEvent,
  shouldReportEventLoopBlock
} from '../../src/shared/telemetry'

/**
 * main の停止（Main event loop blocked）の手がかりと、パンくずの間引き。
 */

afterEach(() => {
  setReporter(null)
  clearSlowOps()
})

describe('止まったときの手がかり', () => {
  it('処理中の IPC は長い順の上位3つ。終わったものは外れる', () => {
    let now = 0
    const t = createInflightTracker(() => now)
    const endA = t.begin('review:list')
    now = 100
    t.begin('capture:availability')
    now = 300
    const endC = t.begin('fs:read')
    t.begin('terminal:cwd')
    now = 1300
    expect(endC()).toBe(1000)
    expect(t.snapshot()).toEqual([
      { name: 'review:list', ms: 1300 }, { name: 'capture:availability', ms: 1200 }, { name: 'terminal:cwd', ms: 1000 }
    ])
    endA()
    expect(t.snapshot()[0]!.name).toBe('capture:availability')
  })

  it('重い同期の処理（100ms 以上）だけを控え、パンくずにも名前と時間だけを残す', () => {
    const breadcrumb = vi.fn<Reporter['breadcrumb']>()
    setReporter({ handled: vi.fn(), message: vi.fn(), breadcrumb })
    noteSlowOp('which:whisper-cli', 40, 1000)
    noteSlowOp('ps', 450, 1000)
    noteSlowOp('settings:save', 120, 1000)
    expect(recentSlowOps(2000)).toEqual([{ op: 'ps', ms: 450 }, { op: 'settings:save', ms: 120 }])
    expect(breadcrumb).toHaveBeenCalledWith('slow op', { op: 'ps', ms: 450 })
    // 10秒より前のものは手がかりにしない
    expect(recentSlowOps(20_000)).toEqual([])
  })

  it('timedSync は値を返し、例外でも時間を控える', () => {
    expect(timedSync('quick', () => 42)).toBe(42)
    expect(() => timedSync('boom', () => { throw new Error('x') })).toThrow('x')
  })

  it('止まったイベントにはタグと contexts.block で手がかりを付け、送る前の除去で消えない', () => {
    const ctx = eventLoopBlockContext([{ name: 'review:list', ms: 2100 }, { name: 'fs:read', ms: 300 }], [{ op: 'which:whisper-cli', ms: 1800 }])
    expect(ctx.tags).toEqual({ 'block.ipc': 'review:list', 'block.slowop': 'which:whisper-cli' })
    expect(ctx.context).toEqual({ inflight_ipc: 'review:list 2100ms, fs:read 300ms', recent_slow_ops: 'which:whisper-cli 1800ms' })
    expect(eventLoopBlockContext([], []).tags).toEqual({ 'block.ipc': 'none', 'block.slowop': 'none' })
    const out = scrubEvent({ contexts: { block: ctx.context } }) as { contexts: Record<string, unknown> }
    expect(out.contexts.block).toEqual(ctx.context)
  })

  it('reportPerf は手がかりをタグと contexts で送り、まとめ方（fingerprint）は種類のまま', () => {
    const message = vi.fn<Reporter['message']>()
    setReporter({ handled: vi.fn(), breadcrumb: vi.fn(), message })
    const ctx = eventLoopBlockContext([{ name: 'review:list', ms: 2100 }], [])
    reportPerf('event-loop-block', 2000, ctx)
    expect(message).toHaveBeenCalledWith('Main event loop blocked (2.0s)',
      { kind: 'perf', perf: 'event-loop-block', duration: '2-5s', 'block.ipc': 'review:list', 'block.slowop': 'none' },
      'warning', ['anomaly', 'event-loop-block'], { block: ctx.context })
  })

  it('閾値：配布版は1秒のまま、開発版は3秒', () => {
    expect(eventLoopBlockThreshold(true)).toBe(EVENT_LOOP_BLOCK_MS)
    expect(EVENT_LOOP_BLOCK_MS).toBe(1000)
    expect(eventLoopBlockThreshold(false)).toBe(DEV_EVENT_LOOP_BLOCK_MS)
    expect(DEV_EVENT_LOOP_BLOCK_MS).toBe(3000)
  })
})

describe('パンくずの間引き', () => {
  it('補助技術の切り替えの通知は捨て、同じものの連続は1つにする', () => {
    const keep = createBreadcrumbFilter()
    const a11y = { category: 'electron', message: 'app.accessibility-support-changed' }
    expect(keep(a11y)).toBe(false)
    expect(keep({ category: 'electron', message: 'app.browser-window-focus' })).toBe(true)
    expect(keep({ category: 'electron', message: 'app.browser-window-focus' })).toBe(false)
    expect(keep(a11y)).toBe(false)
    expect(keep({ category: 'flow', message: 'settings save' })).toBe(true)
    expect(keep({ category: 'electron', message: 'app.browser-window-focus' })).toBe(true)
  })
})

describe('止まったときの main の様子（FERRET-M: スタックもパンくずも無い止まりの手がかり）', () => {
  it('メモリの量・補助技術の状態をタグと contexts.block に付ける（値は大きさと時間だけ）', () => {
    const ctx = eventLoopBlockContext([], [{ op: 'gc:major', ms: 1900 }], { heapUsedMb: 1170.4, rssMb: 1530.6, axEnabled: true, axChangedMsAgo: 1250 })
    expect(ctx.tags).toEqual({ 'block.ipc': 'none', 'block.slowop': 'gc:major', 'block.heap': '1-2GB', 'block.ax': 'on' })
    expect(ctx.context).toMatchObject({ heap_used: '1170MB', rss: '1531MB', ax_changed: '1250ms ago', recent_slow_ops: 'gc:major 1900ms' })
    expect(eventLoopBlockContext([], [], { heapUsedMb: 80, rssMb: 200, axEnabled: false, axChangedMsAgo: null }).context.ax_changed).toBe('never')
  })

  it('伏せ字を通しても手がかりが残る', () => {
    const ctx = eventLoopBlockContext([], [{ op: 'gc:major', ms: 1900 }], { heapUsedMb: 1170, rssMb: 1530, axEnabled: true, axChangedMsAgo: 1250 })
    const out = scrubEvent({ tags: ctx.tags, contexts: { block: ctx.context } }) as { tags: Record<string, string>; contexts: { block: Record<string, string> } }
    expect(out.tags['block.heap']).toBe('1-2GB')
    expect(out.contexts.block.ax_changed).toBe('1250ms ago')
  })

  it('OS が CPU を絞っていたら、その上限をタグと contexts.block に付ける（FERRET-M 0.6.30 の Windows）', () => {
    const env = { heapUsedMb: 39, rssMb: 216, axEnabled: false, axChangedMsAgo: null }
    const limited = eventLoopBlockContext([], [], { ...env, cpuSpeedLimit: 42.4 })
    expect(limited.tags['block.cpulimit']).toBe('<50%')
    expect(limited.context.cpu_speed_limit).toBe('42%')
    const out = scrubEvent({ tags: limited.tags, contexts: { block: limited.context } }) as { tags: Record<string, string>; contexts: { block: Record<string, string> } }
    expect(out.tags['block.cpulimit']).toBe('<50%')
    expect(out.contexts.block.cpu_speed_limit).toBe('42%')
    expect(eventLoopBlockContext([], [], { ...env, cpuSpeedLimit: null }).context.cpu_speed_limit).toBe('unknown')
    // 渡さなければ付けない（今までの形のまま）
    expect(eventLoopBlockContext([], [], env).tags).not.toHaveProperty('block.cpulimit')
  })

  it('CPU の速度の上限の区分（境界と異常な値）', () => {
    expect([100, 120, 99, 75, 74, 50, 49, 0, -5].map(cpuLimitBucket)).toEqual(['none', 'none', '75-99%', '75-99%', '50-74%', '50-74%', '<50%', '<50%', '<50%'])
    expect([null, undefined, Number.NaN, Number.POSITIVE_INFINITY].map(cpuLimitBucket)).toEqual(['unknown', 'unknown', 'unknown', 'unknown'])
  })

  it('メモリの区分と GC の種類の名前', () => {
    expect([100, 300, 700, 1500, 4096].map(memoryBucket)).toEqual(['<256MB', '256-512MB', '512MB-1GB', '1-2GB', '2GB+'])
    expect([1, 4, 8, 16, 99, undefined].map(gcKindName)).toEqual(['minor', 'major', 'incremental', 'weakcb', 'other', 'other'])
  })
})

describe('送る止まりと送らない遅れ（FERRET-M: 0.4.1・0.4.4 の macOS）', () => {
  const base = { lagMs: 2000, thresholdMs: EVENT_LOOP_BLOCK_MS, quitting: false, appActive: true, msSinceResume: null }

  it('前面で閾値を超えて止まったら送る。閾値以下は送らない', () => {
    expect(shouldReportEventLoopBlock(base)).toBe(true)
    expect(shouldReportEventLoopBlock({ ...base, lagMs: EVENT_LOOP_BLOCK_MS })).toBe(false)
  })

  it('更新の入れ替え（quitAndInstall）で終了する途中の止まりは送らない（5.2s・ipc:update:install）', () => {
    expect(shouldReportEventLoopBlock({ ...base, lagMs: 5200, quitting: true })).toBe(false)
    // ウィンドウを閉じた後（前面のウィンドウが無い）も同じ
    expect(shouldReportEventLoopBlock({ ...base, lagMs: 5200, appActive: false })).toBe(false)
  })

  it('閉じる操作（before-quit）から will-quit までの片付けの止まりは送らない（1.1s・ipc:update:install、0.4.15 の Windows）。取り消されて時間が経てば送る', () => {
    expect(shouldReportEventLoopBlock({ ...base, lagMs: 1100, msSinceQuitRequest: 0 })).toBe(false)
    expect(shouldReportEventLoopBlock({ ...base, lagMs: 1100, msSinceQuitRequest: QUIT_GRACE_MS })).toBe(false)
    expect(shouldReportEventLoopBlock({ ...base, lagMs: 1100, msSinceQuitRequest: QUIT_GRACE_MS + 1100 + 1 })).toBe(true)
    expect(shouldReportEventLoopBlock({ ...base, lagMs: 1100, msSinceQuitRequest: null })).toBe(true)
  })

  it('裏に回っている間のタイマーの遅れ（App Nap）は送らない（2.0s・4.0s、どちらも数分前から裏）', () => {
    expect(shouldReportEventLoopBlock({ ...base, lagMs: 2000, appActive: false })).toBe(false)
    expect(shouldReportEventLoopBlock({ ...base, lagMs: 4000, appActive: false })).toBe(false)
  })

  it('遅れの間にスリープに入ったなら、resume が届かなくても送らない（0.7.6 の Windows の 1839.6s）', () => {
    expect(shouldReportEventLoopBlock({ ...base, lagMs: 1_839_600, msSinceSuspend: 1_839_600 + 2000, msSinceResume: null })).toBe(false)
    // スリープがずっと前なら、今の遅れは止まり
    expect(shouldReportEventLoopBlock({ ...base, lagMs: 5000, msSinceSuspend: 3_600_000, msSinceResume: null })).toBe(true)
  })

  it('スリープから戻った直後の遅れは送らない。しばらく経てば送る', () => {
    expect(shouldReportEventLoopBlock({ ...base, msSinceResume: 0 })).toBe(false)
    expect(shouldReportEventLoopBlock({ ...base, msSinceResume: RESUME_GRACE_MS })).toBe(false)
    expect(shouldReportEventLoopBlock({ ...base, msSinceResume: RESUME_GRACE_MS + base.lagMs + 1 })).toBe(true)
  })
})
