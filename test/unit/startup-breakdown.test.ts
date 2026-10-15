import { describe, expect, it } from 'vitest'
import { MAX_STARTUP_MARKS, slowStartupReport, startupBreakdown, type StartupTiming } from '../../src/shared/startupBreakdown'
import { perfAnomalyEvent, scrubEvent } from '../../src/shared/telemetry'

/**
 * 起動の遅さを、JS より前（プロセスの生成からモジュールの読み込みまで）と後に分ける（FERRET-K）。
 * 0.3.0 の本番の例：生成 13:10:43.477 → 報告 44.916 のうち JS は約1.4秒、全体は 5〜10 秒
 */
const ORIGIN = 1_790_000_000_000
const timing = (over: Partial<StartupTiming> = {}): StartupTiming => ({
  totalMs: 7000, origin: ORIGIN, moduleLoadedAt: ORIGIN + 5600, originSource: 'process', marks: { 'app-ready': 5900, 'window-created': 6300, interactive: 7000 }, ...over
})

describe('startupBreakdown', () => {
  it('JS より前が大部分なら pre-js（内訳は名前と時間だけ）', () => {
    const b = startupBreakdown(timing())
    expect(b.preJsMs).toBe(5600)
    expect(b.jsMs).toBe(1400)
    expect(b.phase).toBe('pre-js')
    expect(b.tags).toEqual({ 'startup.phase': 'pre-js', 'startup.origin': 'process' })
    expect(b.context).toEqual({ total: '7000ms', pre_js: '5600ms', js: '1400ms', marks: 'app-ready=5900ms window-created=6300ms interactive=7000ms' })
  })

  it('境界：JS より前がちょうど半分なら js、半分を超えたら pre-js', () => {
    expect(startupBreakdown(timing({ totalMs: 6000, moduleLoadedAt: ORIGIN + 3000 })).phase).toBe('js')
    expect(startupBreakdown(timing({ totalMs: 6000, moduleLoadedAt: ORIGIN + 3001 })).phase).toBe('pre-js')
  })

  it('getCreationTime が無い（基準がモジュールの読み込み）ときは、JS より前は分からないとし全体を JS とみなす', () => {
    const b = startupBreakdown(timing({ originSource: 'module', origin: ORIGIN + 5600 }))
    expect(b.preJsMs).toBeNull()
    expect(b.jsMs).toBe(7000)
    expect(b.phase).toBe('unknown')
    expect(b.tags).toEqual({ 'startup.phase': 'unknown', 'startup.origin': 'module' })
    expect(b.context.pre_js).toBe('unknown')
  })

  it('時計のずれで負や全体超えになっても 0〜全体に収める', () => {
    expect(startupBreakdown(timing({ moduleLoadedAt: ORIGIN - 50 })).preJsMs).toBe(0)
    const over = startupBreakdown(timing({ moduleLoadedAt: ORIGIN + 9000 }))
    expect(over.preJsMs).toBe(7000)
    expect(over.jsMs).toBe(0)
  })

  it('節目は決まった形の名前だけを、時間の順に上限まで載せる', () => {
    const marks: Record<string, number> = { 'open /Users/someone/acme-shop': 10, 'https://example.com': 20, bad: Number.NaN, b: 30, a: 5 }
    for (let i = 0; i < MAX_STARTUP_MARKS + 5; i++) marks[`m${i}`] = 100 + i
    const b = startupBreakdown(timing({ marks }))
    const names = b.context.marks!.split(' ').map((x) => x.split('=')[0])
    expect(names.slice(0, 2)).toEqual(['a', 'b'])
    expect(names).toHaveLength(MAX_STARTUP_MARKS)
    expect(b.context.marks).not.toMatch(/Users|example|NaN/)
    expect(startupBreakdown(timing({ marks: {} })).context.marks).toBe('none')
  })

  it('伏せ字を通しても contexts.startup とタグが残る', () => {
    const b = startupBreakdown(timing())
    const out = scrubEvent({ tags: b.tags, contexts: { startup: b.context } }) as { tags: Record<string, string>; contexts: Record<string, unknown> }
    expect(out.tags['startup.phase']).toBe('pre-js')
    expect(out.contexts.startup).toEqual(b.context)
  })
})

describe('slowStartupReport', () => {
  const T = 5000
  it('JS より後が閾値を超えたときだけ slow-startup（時間は JS より後の分）', () => {
    expect(slowStartupReport(startupBreakdown(timing({ totalMs: 8000, moduleLoadedAt: ORIGIN + 2000 })), T)).toEqual({ perf: 'slow-startup', ms: 6000 })
  })

  it('JS より前の遅れだけで閾値を超えたときは slow-pre-js に分ける（時間は JS より前の分）', () => {
    expect(slowStartupReport(startupBreakdown(timing()), T)).toEqual({ perf: 'slow-pre-js', ms: 5600 })
  })

  it('その版の初めての起動（入れた・更新した直後）は、JS より前の遅れを数えない。JS より後の遅れは数える', () => {
    expect(slowStartupReport(startupBreakdown(timing()), T, { firstLaunchOfVersion: true })).toBeNull()
    expect(slowStartupReport(startupBreakdown(timing({ totalMs: 8000, moduleLoadedAt: ORIGIN + 2000 })), T, { firstLaunchOfVersion: true })).toEqual({ perf: 'slow-startup', ms: 6000 })
  })

  it('境界：ちょうど閾値は報告しない', () => {
    expect(slowStartupReport(startupBreakdown(timing({ totalMs: 5000, moduleLoadedAt: ORIGIN })), T)).toBeNull()
    expect(slowStartupReport(startupBreakdown(timing({ totalMs: 5001, moduleLoadedAt: ORIGIN })), T)).toEqual({ perf: 'slow-startup', ms: 5001 })
    // 前も後も閾値以内なら、足して超えても数えない
    expect(slowStartupReport(startupBreakdown(timing({ totalMs: 5001, moduleLoadedAt: ORIGIN + 1 })), T)).toBeNull()
    expect(slowStartupReport(startupBreakdown(timing({ totalMs: 10_001, moduleLoadedAt: ORIGIN + 5000 })), T)).toEqual({ perf: 'slow-startup', ms: 5001 })
    expect(slowStartupReport(startupBreakdown(timing({ totalMs: 6000, moduleLoadedAt: ORIGIN + 5000 })), T)).toBeNull()
    expect(slowStartupReport(startupBreakdown(timing({ totalMs: 6000, moduleLoadedAt: ORIGIN + 5001 })), T)).toEqual({ perf: 'slow-pre-js', ms: 5001 })
  })

  it('getCreationTime が無いときは全体を JS とみなして slow-startup', () => {
    expect(slowStartupReport(startupBreakdown(timing({ originSource: 'module' })), T)).toEqual({ perf: 'slow-startup', ms: 7000 })
  })

  it('slow-pre-js は slow-startup と別の issue（題名と fingerprint）になる', () => {
    expect(perfAnomalyEvent('slow-pre-js', 7000)).toMatchObject({ message: 'Slow launch before JS (7.0s)', fingerprint: ['anomaly', 'slow-pre-js'] })
  })
})

/** 本番の内訳（contexts.startup）をそのまま写した起動 */
const fromSentry = (preJsMs: number, totalMs: number, marks: Record<string, number>): StartupTiming => ({
  totalMs, origin: ORIGIN, moduleLoadedAt: ORIGIN + preJsMs, originSource: 'process', marks
})

describe('本番の遅い起動の再発防止（FERRET-1C / FERRET-K）', () => {
  const T = 5000
  // FERRET-1C: 0.6.12 Windows。JS より前 3571ms ＋ 後 1881ms ＝ 5452ms（どちらも目標内）
  const win = fromSentry(3571, 5452, { 'main:loaded': 3692, 'app:ready': 3836, 'browser:attached': 4053, 'renderer:loaded': 4402, interactive: 5452 })
  // FERRET-K: 0.6.22 macOS。JS より前 10986ms、モジュールの読み込みから app:ready まで 7 秒、アプリ自身は 1299ms
  const mac = fromSentry(10_986, 19_440, { 'main:loaded': 14_912, 'app:ready': 18_141, 'browser:attached': 18_957, 'renderer:loaded': 19_205, interactive: 19_440 })

  it('FERRET-1C の形（前も後も目標内で、足すと超えるだけ）は数えない', () => {
    expect(slowStartupReport(startupBreakdown(win), T)).toBeNull()
  })

  it('アプリ自身の時間（app:ready から操作可能まで）を内訳に持つ。節目が無い・壊れていれば null', () => {
    expect(startupBreakdown(mac).appMs).toBe(1299)
    expect(startupBreakdown(timing()).appMs).toBeNull()
    expect(startupBreakdown(timing({ marks: { 'app:ready': Number.NaN } })).appMs).toBeNull()
    // 時計のずれで操作可能より後になっても 0
    expect(startupBreakdown(timing({ marks: { 'app:ready': 9000 } })).appMs).toBe(0)
  })

  it('FERRET-K の形：更新直後の初回なら、app:ready までの遅れは数えずアプリ自身の 1.3 秒で判断する', () => {
    expect(slowStartupReport(startupBreakdown(mac), T, { firstLaunchOfVersion: true })).toBeNull()
    // 初回でなければ今までどおり数える（本当に遅いかもしれない）
    expect(slowStartupReport(startupBreakdown(mac), T)).toEqual({ perf: 'slow-startup', ms: 8454 })
  })

  it('OS を起動した直後（5分未満）も同じ扱い。境界：ちょうど5分からは数える', () => {
    expect(slowStartupReport(startupBreakdown(mac), T, { systemUptimeMs: 30_000 })).toBeNull()
    expect(slowStartupReport(startupBreakdown(mac), T, { systemUptimeMs: 5 * 60_000 - 1 })).toBeNull()
    expect(slowStartupReport(startupBreakdown(mac), T, { systemUptimeMs: 5 * 60_000 })).toEqual({ perf: 'slow-startup', ms: 8454 })
  })

  it('OS の起動からの時間が分からない・おかしい値なら、起動直後とはみなさない', () => {
    for (const systemUptimeMs of [null, undefined, Number.NaN, -1]) {
      expect(slowStartupReport(startupBreakdown(mac), T, { systemUptimeMs })).toEqual({ perf: 'slow-startup', ms: 8454 })
    }
  })

  it('初回・起動直後でも、アプリ自身が閾値を超えて遅ければ数える（境界：ちょうど閾値は数えない）', () => {
    const slowApp = (appMs: number) => fromSentry(10_000, 12_000 + appMs, { 'app:ready': 12_000, interactive: 12_000 + appMs })
    expect(slowStartupReport(startupBreakdown(slowApp(5000)), T, { firstLaunchOfVersion: true })).toBeNull()
    expect(slowStartupReport(startupBreakdown(slowApp(5001)), T, { firstLaunchOfVersion: true })).toEqual({ perf: 'slow-startup', ms: 5001 })
    expect(slowStartupReport(startupBreakdown(slowApp(5001)), T, { systemUptimeMs: 1000 })).toEqual({ perf: 'slow-startup', ms: 5001 })
  })
})
