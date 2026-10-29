import { afterEach, describe, expect, it, vi } from 'vitest'
import { errorKind, flow, isAbortError, isIpcRelay, reportAnomaly, reportHandled, setReporter, type Reporter } from '../../src/shared/report'
import { UserFacingError } from '../../src/shared/errors'
import {
  ANOMALY_COOLDOWN_MS,
  createAnomalyGate,
  createEventLimiter,
  durationBucket,
  scrubBreadcrumb,
  scrubEvent,
  telemetryProfile
} from '../../src/shared/telemetry'

/**
 * 黙って失敗していた箇所を送る入口（src/shared/report.ts）と、送る量の抑え、パンくずと extra の除去。
 * Sentry へは送らない（送り先を差し替える）。
 */

function fakeReporter() {
  return {
    handled: vi.fn<Reporter['handled']>(),
    message: vi.fn<Reporter['message']>(),
    breadcrumb: vi.fn<Reporter['breadcrumb']>()
  } satisfies Reporter
}

afterEach(() => setReporter(null))

describe('reportHandled', () => {
  it('送り先が無い起動（設定 OFF・E2E・単体テスト）では何もしない', () => {
    expect(() => reportHandled(new Error('x'), { area: 'files', op: 'read' })).not.toThrow()
  })
  it('kind: handled と area / op のタグ、既定は warning で送る', () => {
    const r = fakeReporter()
    setReporter(r)
    const err = new Error('boom')
    reportHandled(err, { area: 'settings', op: 'save settings' })
    expect(r.handled).toHaveBeenCalledWith(err, { kind: 'handled', area: 'settings', op: 'save settings' }, 'warning')
    reportHandled(new Error('worse'), { area: 'recording', op: 'stop' }, 'error')
    expect(r.handled).toHaveBeenLastCalledWith(expect.any(Error), { kind: 'handled', area: 'recording', op: 'stop' }, 'error')
  })
  it('利用者に見せる想定内のエラーと、renderer に届いた IPC の失敗（main が送り済み）は送らない', () => {
    const r = fakeReporter()
    setReporter(r)
    reportHandled(new UserFacingError('Project not found.'), { area: 'ui', op: 'run action' })
    const relayed = new Error("Error invoking remote method 'fs:read': Error: boom")
    expect(isIpcRelay(relayed)).toBe(true)
    reportHandled(relayed, { area: 'ui', op: 'run action' })
    expect(r.handled).not.toHaveBeenCalled()
  })
  it('中断・時間切れは送らない（errorKind を通したものも。FERRET-23）', () => {
    const r = fakeReporter()
    setReporter(r)
    const abort = new DOMException('This operation was aborted', 'AbortError')
    const timeout = new DOMException('The operation timed out.', 'TimeoutError')
    const nodeAbort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })
    for (const err of [abort, timeout, nodeAbort, errorKind(nodeAbort)]) {
      expect(isAbortError(err)).toBe(true)
      reportHandled(err, { area: 'usage', op: 'parse codex usage' })
    }
    expect(r.handled).not.toHaveBeenCalled()
  })
  it('中断・時間切れに似た名前のものや、名前の無い値は送る', () => {
    const r = fakeReporter()
    setReporter(r)
    for (const err of [new Error('AbortError'), new TypeError('terminated'), Object.assign(new Error('x'), { name: 'Aborted' }), 'AbortError', null]) {
      expect(isAbortError(err)).toBe(false)
    }
    reportHandled(new TypeError('terminated'), { area: 'usage', op: 'x' })
    expect(r.handled).toHaveBeenCalledTimes(1)
  })
  it('同じ例外は1度だけ（catch で送ったあと上で投げ直されても数えない）', () => {
    const r = fakeReporter()
    setReporter(r)
    const err = new Error('once')
    reportHandled(err, { area: 'files', op: 'a' })
    reportHandled(err, { area: 'files', op: 'b' })
    expect(r.handled).toHaveBeenCalledTimes(1)
  })
  it('errorKind は種類と code だけを残す（設定ファイルの中身を含むメッセージを送らない）', () => {
    const parse = new SyntaxError('Unexpected token s in JSON: {"apiKey":"sk-live-123"}')
    expect(errorKind(parse).message).toBe('SyntaxError')
    expect(errorKind(parse).name).toBe('SyntaxError')
    const fsErr = Object.assign(new Error("EACCES: permission denied, open '/Users/taro/.claude.json'"), { code: 'EACCES' })
    expect(errorKind(fsErr).message).toBe('Error EACCES')
    expect(errorKind('x').message).toBe('string')
  })
})

describe('flow と reportAnomaly', () => {
  it('送り先へそのまま渡す。送り先が無ければ何もしない', () => {
    flow('recording start')
    reportAnomaly('slow startup', { kind: 'perf' })
    const r = fakeReporter()
    setReporter(r)
    flow('terminal exit', { exitCode: 1, kind: 'claude' })
    reportAnomaly('main event loop blocked', { kind: 'perf', duration: '1-2s' })
    expect(r.breadcrumb).toHaveBeenCalledWith('terminal exit', { exitCode: 1, kind: 'claude' })
    // 種類（文）ごとにまとめる fingerprint を付ける
    expect(r.message).toHaveBeenCalledWith('main event loop blocked', { kind: 'perf', duration: '1-2s' }, 'warning', ['anomaly', 'main event loop blocked'])
  })
})

describe('パンくずと extra の除去', () => {
  const ctx = { homeDir: '/Users/taro', projectPaths: ['/Users/taro/work/app'] }
  it('flow のパンくずは操作名と短い識別子・数だけを残す（パス・URL・文は落とす）', () => {
    const out = scrubBreadcrumb({
      category: 'flow',
      message: 'settings save',
      data: { section: 'layout', exitCode: 1, path: '/Users/taro/work/app/a.ts', url: 'https://example.com/x', text: 'hello world' }
    }, ctx)
    expect(out).toEqual({ category: 'flow', message: 'settings save', data: { section: 'layout', exitCode: 1 } })
  })
  it('flow の操作名に紛れたパスも伏せる', () => {
    expect(scrubBreadcrumb({ category: 'flow', message: 'open /Users/taro/work/app/x' }, ctx)).toEqual({ category: 'flow', message: 'open <project>/x' })
  })
  it('イベントの extra は丸ごと持たない。パンくずの中身も同じ規則で落とす', () => {
    const event = {
      extra: { transcript: '社外秘', terminal: 'ls ~/secret' },
      breadcrumbs: [
        { category: 'flow', message: 'stt failed', data: { errors: 2, detail: 'sk-live-abcdefghijklmnop' } },
        { category: 'console', message: 'terminal output' }
      ]
    }
    const out = scrubEvent(event, ctx) as Record<string, unknown>
    expect(out.extra).toBeUndefined()
    // 識別子の形をしたキーも、送る前の除去で伏せ字になる
    expect(out.breadcrumbs).toEqual([{ category: 'flow', message: 'stt failed', data: { errors: 2, detail: '<secret>' } }])
  })
})

describe('送る量の抑え', () => {
  it('warning（握りつぶしていた失敗・性能の異常）は別の枠で数える', () => {
    expect(telemetryProfile(true).maxWarningsPerRun).toBe(5)
    expect(telemetryProfile(false).maxWarningsPerRun).toBe(30)
    const allow = createEventLimiter(telemetryProfile(true).maxWarningsPerRun)
    const ev = (v: string) => ({ exception: { values: [{ type: 'Error', value: v }] } })
    expect(Array.from({ length: 8 }, (_, i) => allow(ev(`w${i}`))).filter(Boolean)).toHaveLength(5)
  })
  it('性能の異常は種類ごとに一定時間に1度だけ', () => {
    let now = 0
    const gate = createAnomalyGate(ANOMALY_COOLDOWN_MS, () => now)
    expect(gate('event-loop')).toBe(true)
    now = 1000
    expect(gate('event-loop')).toBe(false)
    expect(gate('slow-startup')).toBe(true)
    now = ANOMALY_COOLDOWN_MS + 1
    expect(gate('event-loop')).toBe(true)
  })
  it('停止の長さは粗い区分にする', () => {
    expect(durationBucket(1500)).toBe('1-2s')
    expect(durationBucket(3000)).toBe('2-5s')
    expect(durationBucket(7000)).toBe('5-10s')
    expect(durationBucket(60000)).toBe('10s+')
  })
})
